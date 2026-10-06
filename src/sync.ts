/**
 * Repo sync: the v5 repo guard (synthesis-repo-guard) on this machine.
 *
 * `scripts/repo_sync_check.py` scans every repository under ~/workspaces and
 * writes `~/.synthesis/repo-guard/last-report.json`:
 *   {"generated_at", "host", "total_repos", "dirty_count",
 *    "repos": [{"name", "path", "clean", "issues": [{"type", "detail", "files"?, "total"?, "count"?}]}]}
 * It reads only. The console renders that report, refreshes it by running the
 * scan with --quiet when the report is older than five minutes (a read, so
 * safe to trigger from a page load), and toggles the `~/.synthesis/quiet-audio`
 * mute flag the scan's alerts honor.
 *
 * Committing is not the console's job in v5: `synthesis handoff` commits the
 * files inside a session's own claims. The console shows what is stranded and
 * leaves it to the session that owns it.
 */
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveSkillScript, searchedLocations, skillSearch, type SkillSearch } from "./skill-resolution.js";
import { describeFailure, runPythonScript, synthesisDir } from "./v5.js";

const SKILL = "synthesis-repo-guard";
const SCRIPT = "repo_sync_check.py";
export const SCAN_TIMEOUT_MS = 60_000;
export const REFRESH_STALE_MS = 5 * 60 * 1000;

export interface RepoIssue {
  type: string;
  detail: string;
  files?: string[];
  total?: number;
  count?: number;
}

export interface RepoState {
  name: string;
  path: string;
  clean: boolean;
  issues: RepoIssue[];
}

export interface RepoReport {
  generated_at: string;
  host: string;
  total_repos: number;
  dirty_count: number;
  repos: RepoState[];
}

export interface SyncStatus {
  installed: boolean;
  script: string | null;
  searched: string[];
  quietAudio: boolean;
  report: RepoReport | null;
  /** Why the report file could not be used, or why the last scan failed. */
  error: string | null;
  dirtyCount: number;
  generatedAt: string | null;
  refreshing: boolean;
}

export interface SyncPaths {
  report: string;
  quietFlag: string;
}

export function syncPaths(home = homedir()): SyncPaths {
  const dir = synthesisDir(home);
  return { report: join(dir, "repo-guard", "last-report.json"), quietFlag: join(dir, "quiet-audio") };
}

/** Validate the scan's report. Throws with a plain reason. */
export function parseRepoReport(text: string): RepoReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("The repo-guard report is not complete JSON; the next scan rewrites it.");
  }
  const data = value as Partial<RepoReport> | null;
  if (
    !data ||
    typeof data.generated_at !== "string" ||
    typeof data.dirty_count !== "number" ||
    typeof data.total_repos !== "number" ||
    !Array.isArray(data.repos)
  ) {
    throw new Error("The repo-guard report lacks generated_at, total_repos, dirty_count or repos.");
  }
  const repos = data.repos.map((repo) => {
    if (!repo || typeof repo.name !== "string" || typeof repo.path !== "string" || typeof repo.clean !== "boolean" || !Array.isArray(repo.issues)) {
      throw new Error("The repo-guard report has a repository without name, path, clean and issues.");
    }
    const issues = repo.issues.map((issue) => {
      if (!issue || typeof issue.type !== "string" || typeof issue.detail !== "string") {
        throw new Error("The repo-guard report has an issue without type and detail.");
      }
      return {
        type: issue.type,
        detail: issue.detail,
        ...(Array.isArray(issue.files) ? { files: issue.files.map(String) } : {}),
        ...(typeof issue.total === "number" ? { total: issue.total } : {}),
        ...(typeof issue.count === "number" ? { count: issue.count } : {}),
      };
    });
    return { name: repo.name, path: repo.path, clean: repo.clean, issues };
  });
  return {
    generated_at: data.generated_at,
    host: typeof data.host === "string" ? data.host : "",
    total_repos: data.total_repos,
    dirty_count: data.dirty_count,
    repos,
  };
}

/** The repo guard: report reads, the read-only scan, and the mute flag. */
export class RepoGuard {
  private refreshInflight: Promise<boolean> | null = null;
  private lastRefreshStartedAt = 0;
  private lastScanError: string | null = null;

  constructor(
    private readonly paths: SyncPaths = syncPaths(),
    private readonly search: () => SkillSearch = () => skillSearch(),
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly now: () => number = Date.now
  ) {}

  script(): string | null {
    return resolveSkillScript(SKILL, SCRIPT, this.search());
  }

  isQuietAudio(): boolean {
    return existsSync(this.paths.quietFlag);
  }

  setQuietAudio(on: boolean): boolean {
    try {
      if (on) writeFileSync(this.paths.quietFlag, `muted via synthesis-console ${new Date(this.now()).toISOString()}\n`, "utf-8");
      else if (existsSync(this.paths.quietFlag)) unlinkSync(this.paths.quietFlag);
      return true;
    } catch {
      return false;
    }
  }

  get refreshing(): boolean {
    return this.refreshInflight !== null;
  }

  /** Run the read-only scan now; it rewrites the report. Concurrent callers share one scan. */
  refresh(): Promise<boolean> {
    const script = this.script();
    if (!script) return Promise.resolve(false);
    if (this.refreshInflight) return this.refreshInflight;
    this.lastRefreshStartedAt = this.now();
    this.refreshInflight = runPythonScript(script, ["--quiet"], {
      timeoutMs: SCAN_TIMEOUT_MS,
      maxOutputBytes: 1024 * 1024,
      env: this.env,
    })
      .then((result) => {
        // Exit 0: all clean; 1: something needs attention. Both wrote a report.
        const ok = result.kind === "success" || (result.kind === "exit" && result.code === 1);
        this.lastScanError = ok ? null : describeFailure(result, "The repo-guard scan", SCAN_TIMEOUT_MS);
        return ok;
      })
      .finally(() => {
        this.refreshInflight = null;
      });
    return this.refreshInflight;
  }

  /** The report as it is now; starts a background scan when it is older than five minutes. */
  status(): SyncStatus {
    const search = this.search();
    const script = resolveSkillScript(SKILL, SCRIPT, search);
    let report: RepoReport | null = null;
    let error: string | null = this.lastScanError;
    if (existsSync(this.paths.report)) {
      try {
        report = parseRepoReport(readFileSync(this.paths.report, "utf-8"));
      } catch (problem) {
        error = (problem as Error).message;
      }
    }
    const generated = report ? Date.parse(report.generated_at) : NaN;
    const age = Number.isNaN(generated) ? Infinity : this.now() - generated;
    if (script && !this.refreshInflight && age > REFRESH_STALE_MS && this.now() - this.lastRefreshStartedAt > REFRESH_STALE_MS) {
      void this.refresh();
    }
    return {
      installed: script !== null,
      script,
      searched: searchedLocations(search),
      quietAudio: this.isQuietAudio(),
      report,
      error,
      dirtyCount: report?.dirty_count ?? 0,
      generatedAt: report?.generated_at ?? null,
      refreshing: this.refreshing,
    };
  }
}
