import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { synthesisPythonBin } from "./python-runtime.js";
import { resolveSkillScript } from "./skill-resolution.js";

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

let resolvedScript: string | null = null;

export function doctorScript(): string | null {
  if (resolvedScript && existsSync(resolvedScript)) return resolvedScript;
  resolvedScript = resolveSkillScript(
    SKILL_NAME,
    SCRIPT_NAME,
    process.env.SYNTHESIS_CONTEXT_LIFECYCLE_DIR
  );
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
      synthesisPythonBin(),
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
