/**
 * Portfolio lane parser + health inference (v0.12+).
 *
 * The portfolio lane strip renders one row per active initiative, aggregated
 * from every configured source. Each initiative's health signal comes from
 * two file-derived sources, in priority order:
 *
 *   1. Explicit markers in the initiative's member projects' CONTEXT.md
 *      files (🔴 critical, ⚠️ warning, ✅ healthy).
 *   2. Staleness inference from index.yaml's `last_session` field on member
 *      projects, when no explicit markers are present.
 *
 * The health rollup is the WORST signal from any member project — one 🔴
 * project rolls the whole initiative to 🔴. This matches an ops mindset:
 * the health of the initiative is bounded by its weakest link, not by the
 * average.
 *
 * The rule "every lane ritual-generated, never hand-curated" applies:
 * initiatives + projects are ritual-produced; CONTEXT.md hot-item markers
 * are updated by the ritual/context-lifecycle skill. The console reads
 * these; it does not let the user edit them here (yet).
 *
 * Perf: CONTEXT.md reads are per-page-load with mtime-based caching in
 * `contextCache` — the same file within a single Bun process is read once
 * unless its mtime changes. For a fleet of 200 projects, a cold read
 * finishes in <50ms on local disk.
 */
import { existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { Source } from "../config.js";
import { getProjectsPath } from "../config.js";
import type { InitiativeWithSource, ProjectWithSource } from "./yaml.js";
import { loadInitiativesFromSources, loadProjectsFromSources } from "./yaml.js";

export type LaneHealth = "critical" | "warning" | "healthy" | "unknown";

export interface PortfolioLane {
  initiative: InitiativeWithSource;
  health: LaneHealth;
  memberCount: number;
  healthSignals: string[];
  detail: string;
}

interface ContextSnapshot {
  raw: string;
  mtimeMs: number;
}

const contextCache = new Map<string, ContextSnapshot>();

function readContext(projectDir: string): string | undefined {
  const p = join(projectDir, "CONTEXT.md");
  if (!existsSync(p)) return undefined;
  try {
    const stat = statSync(p);
    const cached = contextCache.get(p);
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.raw;
    const raw = readFileSync(p, "utf-8");
    contextCache.set(p, { raw, mtimeMs: stat.mtimeMs });
    return raw;
  } catch {
    return undefined;
  }
}

/**
 * Compare two LaneHealth values, worst-wins order:
 *   critical > warning > healthy > unknown
 * Returns the worse of the two.
 */
function worse(a: LaneHealth, b: LaneHealth): LaneHealth {
  const order: LaneHealth[] = ["unknown", "healthy", "warning", "critical"];
  return order.indexOf(a) > order.indexOf(b) ? a : b;
}

/**
 * Extract explicit health markers from a project's CONTEXT.md.
 * Looks in the first 40 lines only — that's where the Phase / Status
 * summary + Current State bullets live per the tiered-context template.
 * Returns the worst signal found + an optional detail string for the tooltip.
 */
function healthFromContext(raw: string): { health: LaneHealth; detail?: string } {
  const head = raw.split("\n").slice(0, 40).join("\n");
  const criticalMatch = head.match(/🔴\s*([^\n]{0,80})/);
  if (criticalMatch) return { health: "critical", detail: criticalMatch[1].trim() };
  // ⚠️ + variation-selector unicode edge — accept either the atomic emoji or
  // the compound form.
  const warnMatch = head.match(/(?:⚠️|⚠️|⚠)\s*([^\n]{0,80})/);
  if (warnMatch) return { health: "warning", detail: warnMatch[1].trim() };
  // ✅ often appears next to "no blockers" or "shipped" — treat as healthy signal.
  const healthyMatch = head.match(/✅\s*([^\n]{0,80})/);
  if (healthyMatch) return { health: "healthy", detail: healthyMatch[1].trim() };
  // No explicit marker.
  return { health: "unknown" };
}

/**
 * Staleness-based inference from a project's last_session field. Days
 * thresholds chosen to match typical synthesis cadence:
 *   ≤7 days → healthy
 *   >7 days → warning ("check in on this"), never critical
 *
 * Staleness deliberately CAPS at warning. It is circumstantial evidence —
 * an active project can be intentionally quiet (waiting on an external
 * party, between phases) without being in trouble. Only an explicit
 * ritual-written 🔴 in CONTEXT.md asserts "needs intervention now" and
 * earns the critical color. Inference prompts a check-in; assertion raises
 * an alarm. Paused / archived / superseded projects are excluded from the
 * lane entirely (see filter in computePortfolioLanes).
 */
function healthFromStaleness(project: ProjectWithSource, today: Date): { health: LaneHealth; detail?: string } {
  if (!project.last_session) return { health: "unknown", detail: "no last_session" };
  const ls = new Date(project.last_session);
  if (isNaN(ls.getTime())) return { health: "unknown", detail: "unparseable last_session" };
  const diffDays = Math.floor((today.getTime() - ls.getTime()) / (1000 * 60 * 60 * 24));
  if (diffDays <= 7) return { health: "healthy", detail: `${diffDays}d` };
  return { health: "warning", detail: `${diffDays}d stale` };
}

/**
 * Compute portfolio lanes across the given sources. Only active/ongoing/new
 * initiatives appear; paused/completed/archived initiatives are omitted
 * (they can be visited via /initiatives).
 *
 * Each lane's health is the worst signal across its member projects.
 * When no member projects have CONTEXT.md, staleness inference kicks in.
 */
export function computePortfolioLanes(sources: Source[]): PortfolioLane[] {
  const today = new Date();
  const initiatives = loadInitiativesFromSources(sources);
  const projects = loadProjectsFromSources(sources);
  const projectsBySourceAndInitiative = new Map<string, ProjectWithSource[]>();
  for (const p of projects) {
    if (!p.initiative) continue;
    if (p.status !== "active" && p.status !== "ongoing" && p.status !== "new") continue;
    const key = `${p._source}::${p.initiative}`;
    const arr = projectsBySourceAndInitiative.get(key) ?? [];
    arr.push(p);
    projectsBySourceAndInitiative.set(key, arr);
  }

  const lanes: PortfolioLane[] = [];
  for (const initiative of initiatives) {
    if (initiative.status !== "active" && initiative.status !== "ongoing" && initiative.status !== "new") continue;
    const source = sources.find((s) => s.name === initiative._source);
    if (!source) continue;
    const projectsDir = getProjectsPath(source);
    if (!projectsDir) continue;
    const key = `${initiative._source}::${initiative.id}`;
    const members = projectsBySourceAndInitiative.get(key) ?? [];

    let rollup: LaneHealth = "unknown";
    const signals: string[] = [];
    let detail = "";
    for (const member of members) {
      const projectDir = join(projectsDir, member.id);
      const contextRaw = readContext(projectDir);
      let memberHealth: { health: LaneHealth; detail?: string } = { health: "unknown" };
      if (contextRaw) {
        memberHealth = healthFromContext(contextRaw);
      }
      if (memberHealth.health === "unknown") {
        memberHealth = healthFromStaleness(member, today);
      }
      if (memberHealth.health !== "unknown") {
        signals.push(`${member.name}: ${memberHealth.health}${memberHealth.detail ? " · " + memberHealth.detail : ""}`);
      }
      const prev = rollup;
      rollup = worse(rollup, memberHealth.health);
      if (rollup !== prev && memberHealth.detail) {
        detail = `${member.name} — ${memberHealth.detail}`;
      }
    }

    lanes.push({
      initiative,
      health: rollup,
      memberCount: members.length,
      healthSignals: signals,
      detail,
    });
  }

  return lanes;
}
