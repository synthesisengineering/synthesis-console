import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  unlinkSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { synthesisPythonBin } from "./python-runtime.js";
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
const PRIVATE_CODEX_CHECK = "hook-live.codex-private-sessionstart";

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

function verifiedSourceRoot(candidate: string): string | null {
  try {
    const root = realpathSync(resolve(candidate));
    if (
      !existsSync(join(root, ".git")) ||
      !existsSync(join(root, ".codex-plugin", "plugin.json")) ||
      !existsSync(
        join(
          root,
          "skills",
          "synthesis-agent-conformance",
          "scripts",
          "conformance.py"
        )
      )
    ) return null;
    return root;
  } catch {
    return null;
  }
}

/** Resolve a Git-backed synthesis-skills checkout, never an installed cache. */
export function conformanceSourceRoot(
  configured = process.env.SYNTHESIS_CONFORMANCE_SOURCE_ROOT,
  home = homedir(),
  cwd = process.cwd()
): string | null {
  if (configured !== undefined) return verifiedSourceRoot(configured);

  const candidates = [
    join(dirname(cwd), "synthesis-skills"),
    join(cwd, "synthesis-skills"),
  ];
  const workspaces = join(home, "workspaces");
  try {
    for (const entry of readdirSync(workspaces, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        candidates.push(join(workspaces, entry.name, "synthesis-skills"));
      }
    }
  } catch {
    // The explicit and cwd-adjacent candidates remain available.
  }
  for (const candidate of candidates) {
    const root = verifiedSourceRoot(candidate);
    if (root) return root;
  }
  return null;
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

export function conformanceReportMatchesProfile(
  report: ConformanceReport,
  includePrivateControlPlane: boolean
): boolean {
  return (
    !includePrivateControlPlane ||
    report.checks.some((check) => check.name === PRIVATE_CODEX_CHECK)
  );
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
      "agent-conformance",
      "live",
      "private-sessionstart-codex.json"
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
  sourceRoot = conformanceSourceRoot(),
  includePrivateControlPlane =
    process.env.SYNTHESIS_PRIVATE_CONTROL_PLANE === "1"
): string[] {
  if (!sourceRoot) {
    throw new Error(
      "A Git-backed synthesis-skills source checkout is required for conformance."
    );
  }
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
    "--capability-evidence",
    evidence.capabilityEvidence,
    "--coordination-board",
    evidence.coordinationBoard,
  ];
  if (includePrivateControlPlane) {
    args.push(
      "--private-codex-sessionstart-receipt",
      evidence.privateCodexReceipt
    );
  }
  args.push("--source-root", sourceRoot);
  return args;
}

export function conformanceInvocation(
  script: string,
  pointer: ActiveProjectPointer,
  reportPath: string,
  evidence = conformanceEvidencePaths(),
  sourceRoot = conformanceSourceRoot(),
  includePrivateControlPlane =
    process.env.SYNTHESIS_PRIVATE_CONTROL_PLANE === "1"
): { executable: string; args: string[]; cwd: string } {
  if (!sourceRoot) {
    throw new Error(
      "A Git-backed synthesis-skills source checkout is required for conformance."
    );
  }
  return {
    executable: synthesisPythonBin(),
    args: conformanceArgs(
      script,
      pointer,
      reportPath,
      evidence,
      sourceRoot,
      includePrivateControlPlane
    ),
    // The active-project worktree is evidence under test and can legitimately
    // be stale or missing. The verified source checkout is the stable runtime
    // directory from which the checker can report that defect.
    cwd: sourceRoot,
  };
}

export function freshConformanceReport(
  value: unknown,
  previousCheckedAt: string | undefined,
  startedAt: number,
  includePrivateControlPlane =
    process.env.SYNTHESIS_PRIVATE_CONTROL_PLANE === "1"
): ConformanceReport | null {
  const report = validateConformanceReport(value);
  if (
    !report ||
    !conformanceReportMatchesProfile(report, includePrivateControlPlane) ||
    report.checked_at === previousCheckedAt
  ) return null;
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
  const script = conformanceScript();
  const sourceRoot = conformanceSourceRoot();
  const includePrivateControlPlane =
    process.env.SYNTHESIS_PRIVATE_CONTROL_PLANE === "1";
  const cachedReport = validateConformanceReport(parseJson(REPORT_PATH));
  const profileMismatch = Boolean(
    cachedReport &&
    !conformanceReportMatchesProfile(cachedReport, includePrivateControlPlane)
  );
  const report = profileMismatch ? null : cachedReport;
  const age = ageSecondsAt(report?.checked_at);
  const context = parseJson(CONTEXT_REPORT_PATH) as
    | { generated_at?: string }
    | null;
  const contextGeneratedAt = context?.generated_at ?? null;
  return {
    conformanceAvailable: script !== null && sourceRoot !== null,
    report,
    ageSeconds: age,
    stale: age === null || age > STALE_AFTER_SECONDS,
    auditing: auditInflight,
    auditError:
      lastAuditError ||
      (profileMismatch
        ? "Cached conformance evidence does not include the configured private control plane."
        : script && !sourceRoot
          ? "A Git-backed synthesis-skills source checkout is required to run conformance."
          : null),
    contextGeneratedAt,
    contextAgeSeconds: ageSecondsAt(contextGeneratedAt),
  };
}

/** Run the authoritative conformance program; it atomically writes REPORT_PATH. */
export function runConformanceNow(): boolean {
  const script = conformanceScript();
  const sourceRoot = conformanceSourceRoot();
  if (!script || auditInflight) return false;
  if (!sourceRoot) {
    lastAuditError =
      "A Git-backed synthesis-skills source checkout is required to run conformance.";
    return false;
  }
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
    const invocation = conformanceInvocation(
      script,
      pointer as ActiveProjectPointer,
      pendingReportPath,
      conformanceEvidencePaths(),
      sourceRoot,
      process.env.SYNTHESIS_PRIVATE_CONTROL_PLANE === "1"
    );
    const child = execFile(
      invocation.executable,
      invocation.args,
      { cwd: invocation.cwd, timeout: 15 * 60 * 1000 },
      (error, _stdout, stderr) => {
        try {
          const report = freshConformanceReport(
            parseJson(pendingReportPath),
            previousCheckedAt,
            startedAt,
            process.env.SYNTHESIS_PRIVATE_CONTROL_PLANE === "1"
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
