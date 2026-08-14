import { execFile } from "node:child_process";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
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

let auditInflight = false;
let lastAuditError: string | null = null;

export function conformanceScript(): string | null {
  return resolveSkillScript(
    "synthesis-agent-conformance",
    "conformance.py",
    process.env.SYNTHESIS_AGENT_CONFORMANCE_DIR
  );
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

export interface ConformanceEvidencePaths {
  activeProject: string;
  publicCodexReceipt: string;
  publicClaudeReceipt: string;
  privateCodexReceipt: string;
  capabilityEvidence: string;
  coordinationBoard: string;
}

export function conformanceEvidencePaths(
  synthesisHome = SYNTHESIS_HOME
): ConformanceEvidencePaths {
  return {
    activeProject: join(synthesisHome, "active-project.json"),
    publicCodexReceipt: join(
      synthesisHome,
      "agent-conformance",
      "live",
      "public-sessionstart-codex.json"
    ),
    publicClaudeReceipt: join(
      synthesisHome,
      "agent-conformance",
      "live",
      "public-sessionstart-claude.json"
    ),
    privateCodexReceipt: join(
      synthesisHome,
      "agent-control",
      "live",
      "codex-sessionstart.json"
    ),
    capabilityEvidence: join(
      synthesisHome,
      "agent-conformance",
      "capabilities.json"
    ),
    coordinationBoard: join(
      synthesisHome,
      "coordination",
      "active-sessions.md"
    ),
  };
}

interface ActiveProjectPointer {
  project: string;
  worktree: string;
}

export function conformanceArgs(
  script: string,
  pointer: ActiveProjectPointer,
  reportPath: string,
  evidence = conformanceEvidencePaths(),
  sourceRoot = process.env.SYNTHESIS_CONFORMANCE_SOURCE_ROOT
): string[] {
  const args = [
    script,
    "all",
    "--json",
    "--report-file",
    reportPath,
    "--project",
    pointer.project,
    "--repo-root",
    pointer.worktree,
    "--active-project-file",
    evidence.activeProject,
    "--public-codex-sessionstart-receipt",
    evidence.publicCodexReceipt,
    "--public-claude-sessionstart-receipt",
    evidence.publicClaudeReceipt,
    "--private-codex-sessionstart-receipt",
    evidence.privateCodexReceipt,
    "--capability-evidence",
    evidence.capabilityEvidence,
    "--coordination-board",
    evidence.coordinationBoard,
  ];
  if (sourceRoot) args.push("--source-root", sourceRoot);
  return args;
}

export function freshConformanceReport(
  value: unknown,
  previousCheckedAt: string | undefined,
  startedAt: number
): ConformanceReport | null {
  const report = validateConformanceReport(value);
  if (!report || report.checked_at === previousCheckedAt) return null;
  const checkedAt = Date.parse(report.checked_at);
  if (Number.isNaN(checkedAt) || checkedAt < startedAt - 5_000) return null;
  return report;
}

function removeReport(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
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
  const startedAt = Date.now();
  let auditReportPath: string | null = null;
  try {
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    auditReportPath = join(
      dirname(REPORT_PATH),
      `.last-report.${process.pid}.${startedAt}.json`
    );
    const pendingReportPath = auditReportPath;
    removeReport(pendingReportPath);
    const args = conformanceArgs(
      script,
      pointer as ActiveProjectPointer,
      pendingReportPath
    );
    const child = execFile(
      "python3",
      args,
      { cwd: pointer.worktree, timeout: 15 * 60 * 1000 },
      (error, _stdout, stderr) => {
        try {
          const report = freshConformanceReport(
            parseJson(pendingReportPath),
            previousCheckedAt,
            startedAt
          );
          if (!report) {
            lastAuditError =
              stderr.trim() ||
              error?.message ||
              "The conformance process did not produce a fresh valid report.";
            removeReport(pendingReportPath);
            return;
          }
          renameSync(pendingReportPath, REPORT_PATH);
          lastAuditError = null;
        } catch (callbackError) {
          lastAuditError =
            callbackError instanceof Error
              ? callbackError.message
              : "The conformance report could not be promoted.";
          try {
            removeReport(pendingReportPath);
          } catch {
            // The primary error above remains the user-visible evidence.
          }
        } finally {
          auditInflight = false;
        }
      }
    );
    child.unref?.();
    return true;
  } catch {
    auditInflight = false;
    if (auditReportPath) {
      try {
        removeReport(auditReportPath);
      } catch {
        // The process-start failure remains the user-visible evidence.
      }
    }
    lastAuditError = "The conformance process could not be started.";
    return false;
  }
}
