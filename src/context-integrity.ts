/**
 * Context integrity: the v5 context doctor (synthesis-context-lifecycle's
 * `context_doctor.py`) run against each configured source, so the page shows
 * whether every project's records are small, current and durable enough for a
 * cold resume.
 *
 * The doctor runs on demand and writes no report file. It audits a knowledge
 * root's `projects/` folder, so a source qualifies when its `projects_dir`
 * is a folder named `projects`; the knowledge root is that folder's parent.
 * Each source's result is kept for a minute, so the page and the nav chip's
 * poll share one run, and changing the source selection reruns only the
 * sources that are not already kept.
 *
 * Contract (context_doctor.py --root R --json): exit 0 healthy, 1 defects
 * found, 2 the doctor could not tell. Exits 0 and 1 print
 *   {"ok", "exit", "active", "projects_audited", "defects", "warnings",
 *    "coverage": {check: {"examined", "skipped", "why"}},
 *    "findings": [{"project", "check", "severity", "message", "remedy"}]}
 * and exit 2 prints {"ok": false, "exit": 2, "error"}.
 */
import { basename, dirname, resolve } from "node:path";
import { homedir } from "node:os";
import type { Source } from "./config.js";
import { displayName, isDemoSource } from "./config.js";
import { CachedRun } from "./cached-run.js";
import { resolveSkillScript, searchedLocations, skillSearch, type SkillSearch } from "./skill-resolution.js";
import { describeFailure, runPythonScript } from "./v5.js";

export const CONTEXT_TIMEOUT_MS = 60_000;
export const CONTEXT_TTL_MS = 60_000;
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const SKILL = "synthesis-context-lifecycle";
const SCRIPT = "context_doctor.py";

export interface ContextFinding {
  project: string;
  check: string;
  severity: string;
  message: string;
  remedy: string;
}

export interface ContextCoverage {
  examined: number;
  skipped: number;
  why: string[];
}

export interface ContextReport {
  ok: boolean;
  exit: number;
  projects_audited: number;
  defects: number;
  warnings: number;
  coverage: Record<string, ContextCoverage>;
  findings: ContextFinding[];
}

export interface SourceAudit {
  source: string;
  displayName: string;
  /** The folder passed as --root, or null when the source cannot be audited. */
  knowledgeRoot: string | null;
  report: ContextReport | null;
  /** The doctor's "cannot tell" reason, a failed run, or an unsupported layout. */
  error: string | null;
  checkedAt: string | null;
  elapsedMs: number | null;
}

export interface ContextIntegrityStatus {
  doctorAvailable: boolean;
  script: string | null;
  searched: string[];
  audits: SourceAudit[];
  /** Active sources with no projects to audit: sample data or no projects_dir. */
  skipped: { source: string; displayName: string; reason: string }[];
  totals: { projects: number; defects: number; warnings: number; failedSources: number };
}

/** The knowledge root for a source, or the reason the doctor cannot audit it. */
export function knowledgeRoot(source: Source, home = homedir()): { root: string } | { error: string } {
  const expanded = source.root.startsWith("~/") ? resolve(home, source.root.slice(2)) : resolve(source.root);
  const projects = resolve(expanded, source.projects_dir ?? "");
  if (basename(projects) !== "projects") {
    return {
      error: `The context doctor audits a knowledge root's projects/ folder; this source keeps its projects in ${source.projects_dir}.`,
    };
  }
  return { root: dirname(projects) };
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/** Validate the doctor's JSON for exits 0 and 1. Throws with a plain reason. */
export function parseContextReport(value: unknown): ContextReport {
  const data = value as Partial<ContextReport> | null;
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.ok !== "boolean" ||
    !isCount(data.exit) ||
    !isCount(data.projects_audited) ||
    !isCount(data.defects) ||
    !isCount(data.warnings) ||
    !Array.isArray(data.findings) ||
    (data.coverage !== undefined && (typeof data.coverage !== "object" || data.coverage === null))
  ) {
    throw new Error("The context doctor printed JSON without its counts and findings.");
  }
  const findings = data.findings.map((finding) => {
    for (const key of ["project", "check", "severity", "message", "remedy"] as const) {
      if (!finding || typeof finding[key] !== "string") {
        throw new Error("The context doctor printed a finding without project, check, severity, message and remedy.");
      }
    }
    return {
      project: finding.project,
      check: finding.check,
      severity: finding.severity,
      message: finding.message,
      remedy: finding.remedy,
    };
  });
  const coverage: Record<string, ContextCoverage> = {};
  for (const [check, entry] of Object.entries(data.coverage ?? {})) {
    const row = entry as Partial<ContextCoverage> | null;
    if (!row || !isCount(row.examined) || !isCount(row.skipped) || !Array.isArray(row.why)) {
      throw new Error("The context doctor printed coverage without examined, skipped and why.");
    }
    coverage[check] = { examined: row.examined, skipped: row.skipped, why: row.why.map(String) };
  }
  const count = (severity: string) => findings.filter((finding) => finding.severity === severity).length;
  if (count("defect") !== data.defects || count("warning") !== data.warnings) {
    throw new Error("The context doctor's counts do not match its findings.");
  }
  return {
    ok: data.ok,
    exit: data.exit,
    projects_audited: data.projects_audited,
    defects: data.defects,
    warnings: data.warnings,
    coverage,
    findings,
  };
}

export interface AuditOptions {
  script: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

/** Run the context doctor once on one knowledge root. Never rejects. */
export async function auditRoot(
  root: string,
  options: AuditOptions
): Promise<{ report: ContextReport | null; error: string | null; elapsedMs: number }> {
  const timeoutMs = options.timeoutMs ?? CONTEXT_TIMEOUT_MS;
  const started = performance.now();
  const result = await runPythonScript(options.script, ["--root", root, "--json"], {
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
    env: options.env,
  });
  const elapsedMs = Math.round(performance.now() - started);
  const code = result.kind === "success" ? 0 : result.code;
  if (!(result.kind === "success" || result.kind === "exit") || code === null || code > 2) {
    return { report: null, error: describeFailure(result, "The context doctor", timeoutMs), elapsedMs };
  }
  let value: unknown;
  try {
    value = JSON.parse(result.stdout);
  } catch {
    const stderr = result.stderr.trim().slice(0, 600);
    return {
      report: null,
      error: `The context doctor did not print JSON (exit ${code})${stderr ? `: ${stderr}` : "."}`,
      elapsedMs,
    };
  }
  if (code === 2) {
    const reason = (value as { error?: unknown } | null)?.error;
    return {
      report: null,
      error: `The context doctor cannot tell: ${typeof reason === "string" ? reason : "no reason given"}`,
      elapsedMs,
    };
  }
  try {
    const report = parseContextReport(value);
    if (report.exit !== code || report.ok !== (code === 0)) {
      return { report, error: `The context doctor exited with status ${code} but reported exit ${report.exit}.`, elapsedMs };
    }
    return { report, error: null, elapsedMs };
  } catch (error) {
    return { report: null, error: (error as Error).message, elapsedMs };
  }
}

type AuditResult = Awaited<ReturnType<typeof auditRoot>>;

export interface ContextReader {
  status(sources: Source[], force?: boolean): Promise<ContextIntegrityStatus>;
}

/** Per-source kept results over one resolved doctor script. */
export function contextReader(
  options: { search?: SkillSearch; env?: NodeJS.ProcessEnv; ttlMs?: number; timeoutMs?: number; home?: string } = {}
): ContextReader {
  const kept = new Map<string, CachedRun<AuditResult>>();
  return {
    async status(sources, force = false) {
      const search = options.search ?? skillSearch(options.env);
      const script = resolveSkillScript(SKILL, SCRIPT, search);
      const audits: SourceAudit[] = [];
      const skipped: ContextIntegrityStatus["skipped"] = [];
      const pending: Promise<void>[] = [];
      for (const source of sources) {
        if (isDemoSource(source)) {
          skipped.push({ source: source.name, displayName: displayName(source), reason: "sample data is not audited" });
          continue;
        }
        if (!source.projects_dir) {
          skipped.push({ source: source.name, displayName: displayName(source), reason: "no projects_dir is configured" });
          continue;
        }
        const located = knowledgeRoot(source, options.home);
        const audit: SourceAudit = {
          source: source.name,
          displayName: displayName(source),
          knowledgeRoot: "root" in located ? located.root : null,
          report: null,
          error: "error" in located ? located.error : null,
          checkedAt: null,
          elapsedMs: null,
        };
        audits.push(audit);
        if (!("root" in located) || !script) continue;
        // The key holds the script, so a plugin update starts fresh runs.
        const key = JSON.stringify([script, located.root]);
        let entry = kept.get(key);
        if (!entry) {
          entry = new CachedRun(
            () => auditRoot(located.root, { script, env: options.env, timeoutMs: options.timeoutMs }),
            options.ttlMs ?? CONTEXT_TTL_MS
          );
          kept.set(key, entry);
        }
        const run = entry;
        pending.push(
          run.get(force).then(({ result, at }) => {
            audit.report = result.report;
            audit.error = result.error;
            audit.elapsedMs = result.elapsedMs;
            audit.checkedAt = new Date(at).toISOString();
          })
        );
      }
      await Promise.all(pending);
      const totals = { projects: 0, defects: 0, warnings: 0, failedSources: 0 };
      for (const audit of audits) {
        totals.projects += audit.report?.projects_audited ?? 0;
        totals.defects += audit.report?.defects ?? 0;
        totals.warnings += audit.report?.warnings ?? 0;
        if (audit.error) totals.failedSources++;
      }
      return {
        doctorAvailable: script !== null,
        script,
        searched: searchedLocations(search),
        audits,
        skipped,
        totals,
      };
    },
  };
}

let shared: ContextReader | null = null;

export function getContextIntegrityStatus(sources: Source[], force = false): Promise<ContextIntegrityStatus> {
  shared ??= contextReader();
  return shared.status(sources, force);
}
