import { execFile } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Context-integrity integration (synthesis-context-lifecycle's context
 * doctor). The console renders the doctor's corpus report — the health of
 * the durable project layer every session resumes from.
 *
 * Same contract as the repo-sync integration: reads are free (the doctor
 * writes `$SYNTHESIS_HOME/context-doctor/last-report.json` on every full
 * run — day-start refreshes it daily), and the one mutation (Audit now) is
 * an explicit button, never a background timer. A full corpus audit takes
 * minutes, so the page always renders the cache and refreshes in the
 * background on demand.
 */

const SYNTHESIS_HOME =
  process.env.SYNTHESIS_HOME || join(homedir(), ".synthesis");
const REPORT_PATH = join(SYNTHESIS_HOME, "context-doctor", "last-report.json");

const SKILL_NAME = "synthesis-context-lifecycle";
const SCRIPT_NAME = "context_doctor.py";

/** Same multi-location resolution as the repo-guard integration (v1.1.1):
 * env override, synthesis-owned path, both clients' plugin caches newest
 * first, then legacy direct copies. A hardcoded path dies on the next
 * install-route change. */
function candidateSkillDirs(): string[] {
  const home = homedir();
  const dirs: string[] = [];
  const override = process.env.SYNTHESIS_CONTEXT_LIFECYCLE_DIR;
  if (override) dirs.push(override);
  dirs.push(join(SYNTHESIS_HOME, "skills", SKILL_NAME));
  for (const client of [join(home, ".claude"), join(home, ".codex")]) {
    dirs.push(...pluginCacheDirs(join(client, "plugins", "cache")));
  }
  dirs.push(join(home, ".claude", "skills", SKILL_NAME));
  dirs.push(join(home, ".agents", "skills", SKILL_NAME));
  return dirs;
}

function pluginCacheDirs(cacheRoot: string): string[] {
  const found: { version: string; dir: string }[] = [];
  for (const marketplace of safeReaddir(cacheRoot)) {
    const mpDir = join(cacheRoot, marketplace);
    for (const plugin of safeReaddir(mpDir)) {
      const pluginDir = join(mpDir, plugin);
      for (const version of safeReaddir(pluginDir)) {
        const dir = join(pluginDir, version, "skills", SKILL_NAME);
        if (existsSync(dir)) found.push({ version, dir });
      }
    }
  }
  return found
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((f) => f.dir);
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.\-+]/);
  const pb = b.split(/[.\-+]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = Number.parseInt(pa[i] ?? "", 10);
    const nb = Number.parseInt(pb[i] ?? "", 10);
    const aNan = Number.isNaN(na);
    const bNan = Number.isNaN(nb);
    if (aNan && bNan) continue;
    if (aNan) return -1;
    if (bNan) return 1;
    if (na !== nb) return na - nb;
  }
  return 0;
}

let resolvedScript: string | null = null;

export function doctorScript(): string | null {
  if (resolvedScript && existsSync(resolvedScript)) return resolvedScript;
  resolvedScript = null;
  for (const dir of candidateSkillDirs()) {
    const script = join(dir, "scripts", SCRIPT_NAME);
    if (existsSync(script)) {
      resolvedScript = script;
      break;
    }
  }
  return resolvedScript;
}

export interface ContextFinding {
  source: string;
  project: string;
  check: string;
  severity: string;
  message: string;
  remedy: string;
}

export interface ContextIntegrityStatus {
  doctorAvailable: boolean;
  report: {
    ok: boolean;
    doctor_version?: string;
    generated_at?: string;
    sources?: number;
    projects_audited?: number;
    defects?: number;
    warnings?: number;
    findings?: ContextFinding[];
  } | null;
  auditing: boolean;
}

let auditInflight = false;

export function getContextIntegrityStatus(): ContextIntegrityStatus {
  let report: ContextIntegrityStatus["report"] = null;
  try {
    if (existsSync(REPORT_PATH)) {
      report = JSON.parse(readFileSync(REPORT_PATH, "utf-8"));
    }
  } catch {
    report = null;
  }
  return {
    doctorAvailable: doctorScript() !== null,
    report,
    auditing: auditInflight,
  };
}

/** Explicit "Audit now": run the full-corpus doctor in the background. The
 * doctor itself writes the report cache; the page's next load renders it. */
export function runAuditNow(): boolean {
  const script = doctorScript();
  if (!script || auditInflight) return false;
  auditInflight = true;
  try {
    const child = execFile(
      "python3",
      [script, "--quiet"],
      { timeout: 15 * 60 * 1000 },
      () => {
        auditInflight = false;
      }
    );
    child.unref?.();
    return true;
  } catch {
    auditInflight = false;
    return false;
  }
}
