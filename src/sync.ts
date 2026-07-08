import { execFile } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Repo-sync integration (synthesis-repo-guard v2).
 *
 * The console is the COMMAND CENTER for workspace sync state:
 *   - an always-on nav chip + /sync page render the detector's report files
 *   - a quiet-audio toggle controls the audible-alert mute flag
 *   - "Sync now" runs the checkpoint script on demand
 *   - every plan write the console performs fires a producer checkpoint so
 *     the file it just wrote is committed + pushed moments later
 *
 * Design contract (see synthesis-repo-guard SKILL.md): the console may POLL
 * (read-only) freely — mutation happens only at workflow events (a write we
 * just performed, or an explicit button click). Never on a background timer.
 *
 * All state paths honor SYNTHESIS_HOME (default ~/.synthesis), matching the
 * python scripts. If the skill isn't installed, everything degrades to no-ops
 * and the chip shows "sync n/a".
 */

const SYNTHESIS_HOME =
  process.env.SYNTHESIS_HOME || join(homedir(), ".synthesis");
const REPORT_DIR = join(SYNTHESIS_HOME, "repo-guard");
const QUIET_FLAG = join(SYNTHESIS_HOME, "quiet-audio");

const SKILL_DIR =
  process.env.SYNTHESIS_REPO_GUARD_DIR ||
  join(homedir(), ".claude", "skills", "synthesis-repo-guard");
const CHECK_SCRIPT = join(SKILL_DIR, "repo_sync_check.py");
const CHECKPOINT_SCRIPT = join(SKILL_DIR, "checkpoint_sync.py");

// Refresh the detector at most this often when status is requested (the chip
// polls every 5 min; a fresh report is written by every refresh).
const REFRESH_STALE_MS = 5 * 60 * 1000;

export function guardInstalled(): boolean {
  return existsSync(CHECK_SCRIPT) && existsSync(CHECKPOINT_SCRIPT);
}

export function isQuietAudio(): boolean {
  return existsSync(QUIET_FLAG);
}

export function setQuietAudio(on: boolean): boolean {
  try {
    if (on) {
      writeFileSync(
        QUIET_FLAG,
        `muted via synthesis-console ${new Date().toISOString()}\n`,
        "utf-8"
      );
    } else if (existsSync(QUIET_FLAG)) {
      unlinkSync(QUIET_FLAG);
    }
    return true;
  } catch {
    return false;
  }
}

function readJson(path: string): any | null {
  try {
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

export interface SyncStatus {
  installed: boolean;
  quietAudio: boolean;
  report: any | null; // last-report.json payload (detector)
  checkpoint: any | null; // checkpoint-state.json payload (remediator)
  dirtyCount: number;
  alertCount: number;
  generatedAt: string | null;
  refreshing: boolean;
}

let refreshInflight = false;
let lastRefreshStartedAt = 0;

function runScript(
  script: string,
  args: string[],
  timeoutMs: number
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      "python3",
      [script, ...args],
      { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 },
      (err: any, stdout: any, stderr: any) => {
        resolve({
          code: err ? (typeof err.code === "number" ? err.code : 1) : 0,
          stdout: String(stdout || ""),
          stderr: String(stderr || ""),
        });
      }
    );
  });
}

/** Run the read-only detector now (writes fresh report files). */
export async function refreshDetector(): Promise<boolean> {
  if (!guardInstalled() || refreshInflight) return false;
  refreshInflight = true;
  lastRefreshStartedAt = Date.now();
  try {
    // --quiet: exit code + report files only. No audio flags — the console
    // renders state; it never triggers audible alerts.
    const r = await runScript(CHECK_SCRIPT, ["--quiet"], 60_000);
    return r.code === 0 || r.code === 1;
  } finally {
    refreshInflight = false;
  }
}

/**
 * Current status from the report/state files. If the report is stale (or
 * missing) and the guard is installed, kick a background refresh — the chip's
 * next poll picks up the fresh data. Read-only from the caller's perspective.
 */
export function getSyncStatus(): SyncStatus {
  const report = readJson(join(REPORT_DIR, "last-report.json"));
  const checkpoint = readJson(join(REPORT_DIR, "checkpoint-state.json"));
  const installed = guardInstalled();

  const generatedAt: string | null = report?.generated_at ?? null;
  const ageMs = generatedAt ? Date.now() - Date.parse(generatedAt) : Infinity;
  if (
    installed &&
    !refreshInflight &&
    ageMs > REFRESH_STALE_MS &&
    Date.now() - lastRefreshStartedAt > REFRESH_STALE_MS
  ) {
    void refreshDetector();
  }

  const alerts: any[] = checkpoint?.alerts ?? [];
  return {
    installed,
    quietAudio: isQuietAudio(),
    report,
    checkpoint,
    dirtyCount: report?.dirty_count ?? 0,
    alertCount: alerts.length,
    generatedAt,
    refreshing: refreshInflight,
  };
}

/** Manual "Sync now": checkpoint sweep with throttle bypassed (quiescence kept). */
export async function runCheckpointNow(): Promise<{
  ok: boolean;
  results: any[];
  error?: string;
}> {
  if (!guardInstalled()) {
    return { ok: false, results: [], error: "repo-guard skill not installed" };
  }
  const r = await runScript(
    CHECKPOINT_SCRIPT,
    ["--no-throttle", "--json"],
    180_000
  );
  let results: any[] = [];
  try {
    results = JSON.parse(r.stdout);
  } catch {
    /* state file still has the outcome */
  }
  await refreshDetector();
  return { ok: r.code === 0 || r.code === 1, results };
}

/**
 * Producer checkpoint: the console just wrote `filePath` (a plan marker,
 * draft edit, decision, task toggle). Commit + push exactly that file via the
 * shared checkpoint script. Fire-and-forget — the write path must not block
 * on git/network; outcomes land in checkpoint-state.json for the tile.
 */
export function fireProducerCheckpoint(filePath: string): void {
  if (!guardInstalled()) return;
  try {
    const child = execFile(
      "python3",
      [CHECKPOINT_SCRIPT, "--repo", filePath, "--now", "--quiet"],
      { timeout: 120_000 },
      () => {
        /* outcome recorded in checkpoint-state.json */
      }
    );
    child.unref?.();
  } catch {
    /* never let a checkpoint failure break a save */
  }
}
