import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSkillScript } from "./skill-resolution.js";

const SYNTHESIS_HOME =
  process.env.SYNTHESIS_HOME || join(homedir(), ".synthesis");
const REPORT_PATH = join(SYNTHESIS_HOME, "agent-conformance", "last-report.json");
const POINTER_PATH = join(SYNTHESIS_HOME, "active-project.json");
const CONTEXT_REPORT_PATH = join(
  SYNTHESIS_HOME,
  "context-doctor",
  "last-report.json"
);
const STALE_AFTER_SECONDS = 4 * 60 * 60;

export interface ConformanceCheck {
  name: string;
  ok: boolean | null;
  detail: string;
  required: boolean;
  plane: string;
  status: string;
}

export interface ConformanceReport {
  ok: boolean;
  status: string;
  checked_at: string;
  checks: ConformanceCheck[];
}

export interface AgentConformanceStatus {
  conformanceAvailable: boolean;
  report: ConformanceReport | null;
  ageSeconds: number | null;
  stale: boolean;
  auditing: boolean;
  auditError: string | null;
  contextGeneratedAt: string | null;
  contextAgeSeconds: number | null;
}

let resolvedScript: string | null = null;
let auditInflight = false;
let lastAuditError: string | null = null;

export function conformanceScript(): string | null {
  if (resolvedScript && existsSync(resolvedScript)) return resolvedScript;
  resolvedScript = resolveSkillScript(
    "synthesis-agent-conformance",
    "conformance.py",
    process.env.SYNTHESIS_AGENT_CONFORMANCE_DIR
  );
  return resolvedScript;
}

function parseJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export function ageSecondsAt(
  value: string | null | undefined,
  now = Date.now()
): number | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, Math.floor((now - timestamp) / 1000));
}

export function validateConformanceReport(value: unknown): ConformanceReport | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ConformanceReport>;
  if (
    typeof candidate.ok !== "boolean" ||
    !["PASS", "FAIL"].includes(candidate.status ?? "") ||
    typeof candidate.checked_at !== "string" ||
    !Array.isArray(candidate.checks) ||
    !candidate.checks.every((check) => {
      if (!check || typeof check !== "object") return false;
      const item = check as Partial<ConformanceCheck>;
      return (
        typeof item.name === "string" &&
        (typeof item.ok === "boolean" || item.ok === null) &&
        typeof item.detail === "string" &&
        typeof item.required === "boolean" &&
        typeof item.plane === "string" && item.plane.length > 0 &&
        ["PASS", "FAIL", "WARN", "UNKNOWN", "UNSUPPORTED"].includes(item.status ?? "")
      );
    })
  ) return null;
  if (candidate.ok !== (candidate.status === "PASS")) return null;
  return candidate as ConformanceReport;
}

export function getAgentConformanceStatus(): AgentConformanceStatus {
  const report = validateConformanceReport(parseJson(REPORT_PATH));
  const age = ageSecondsAt(report?.checked_at);
  const context = parseJson(CONTEXT_REPORT_PATH) as
    | { generated_at?: string }
    | null;
  const contextGeneratedAt = context?.generated_at ?? null;
  return {
    conformanceAvailable: conformanceScript() !== null,
    report,
    ageSeconds: age,
    stale: age === null || age > STALE_AFTER_SECONDS,
    auditing: auditInflight,
    auditError: lastAuditError,
    contextGeneratedAt,
    contextAgeSeconds: ageSecondsAt(contextGeneratedAt),
  };
}

/** Run the authoritative conformance program; it atomically writes REPORT_PATH. */
export function runConformanceNow(): boolean {
  const script = conformanceScript();
  if (!script || auditInflight) return false;
  const pointer = parseJson(POINTER_PATH) as
    | { project?: string; worktree?: string }
    | null;
  if (!pointer?.project || !pointer.worktree) {
    lastAuditError = "A valid active-project pointer is required to run conformance.";
    return false;
  }
  auditInflight = true;
  lastAuditError = null;
  const previousCheckedAt = validateConformanceReport(parseJson(REPORT_PATH))?.checked_at;
  const args = [
    script,
    "all",
    "--json",
    "--report-file",
    REPORT_PATH,
    "--project",
    pointer.project,
    "--repo-root",
    pointer.worktree,
  ];
  const sourceRoot = process.env.SYNTHESIS_CONFORMANCE_SOURCE_ROOT;
  if (sourceRoot) args.push("--source-root", sourceRoot);
  try {
    const child = execFile(
      "python3",
      args,
      { cwd: pointer.worktree, timeout: 15 * 60 * 1000 },
      (error, _stdout, stderr) => {
        auditInflight = false;
        const report = validateConformanceReport(parseJson(REPORT_PATH));
        if (error && (!report || report.checked_at === previousCheckedAt)) {
          lastAuditError = stderr.trim() || error.message;
        }
      }
    );
    child.unref?.();
    return true;
  } catch {
    auditInflight = false;
    lastAuditError = "The conformance process could not be started.";
    return false;
  }
}
