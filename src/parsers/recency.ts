import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Source } from "../config.js";
import { getProjectPath } from "../config.js";
import type { ProjectWithSource } from "./yaml.js";

export type ProjectSort = "recent" | "name" | "status";

const STATUS_RANK: Record<string, number> = {
  active: 0,
  new: 1,
  ongoing: 2,
  paused: 3,
  completed: 4,
  archived: 5,
  superseded: 6,
};

/** Newest session-file mtime for a project, or null when none exist. */
export function newestSessionMs(projectDir: string | null): number | null {
  if (!projectDir) return null;
  const sessionsDir = join(projectDir, "sessions");
  if (!existsSync(sessionsDir)) return null;
  let newest: number | null = null;
  for (const file of readdirSync(sessionsDir)) {
    if (!file.endsWith(".md") || file === "INDEX.md") continue;
    try {
      const mtime = statSync(join(sessionsDir, file)).mtimeMs;
      if (newest === null || mtime > newest) newest = mtime;
    } catch {
      continue;
    }
  }
  return newest;
}

function dateFieldMs(value: string | undefined): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Annotate projects with `_lastActiveMs` (newest session mtime, falling
 * back to index date fields) for recency sorting and labels. Mutates in
 * place and returns the input for chaining.
 */
export function annotateRecency(
  projects: ProjectWithSource[],
  sources: Source[]
): ProjectWithSource[] {
  const byName = new Map(sources.map((s) => [s.name, s]));
  for (const project of projects) {
    const src = byName.get(project._source);
    const dir = src ? getProjectPath(src, project.id) : null;
    project._lastActiveMs =
      newestSessionMs(dir) ??
      dateFieldMs(project.last_session) ??
      dateFieldMs(project.completed_date) ??
      dateFieldMs(project.started_date) ??
      undefined;
  }
  return projects;
}

/** Short relative label ("2h ago") for an activity timestamp. */
export function relativeLabel(ms: number | undefined, nowMs?: number): string {
  if (ms === undefined) return "no activity";
  const now = nowMs ?? Date.now();
  const minutes = Math.max(0, Math.floor((now - ms) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** Sort comparators for the project list. Unknown modes fall back to recent. */
export function sortProjects(
  list: ProjectWithSource[],
  mode: string | undefined
): void {
  const normalized: ProjectSort =
    mode === "name" || mode === "status" ? mode : "recent";
  if (normalized === "name") {
    list.sort((a, b) => a.name.localeCompare(b.name));
    return;
  }
  if (normalized === "status") {
    list.sort((a, b) => {
      const rank =
        (STATUS_RANK[a.status] ?? 99) - (STATUS_RANK[b.status] ?? 99);
      if (rank !== 0) return rank;
      return (b._lastActiveMs ?? -1) - (a._lastActiveMs ?? -1);
    });
    return;
  }
  list.sort((a, b) => (b._lastActiveMs ?? -1) - (a._lastActiveMs ?? -1));
}

/** The R1 resume prompt for a project, with a live-resolved skill path. */
export function resumePrompt(
  project: { id: string; _source: string },
  skillPath: string | null
): string {
  const first = `Resume synthesis project ${project.id} (source ${project._source}).`;
  if (!skillPath) {
    return `${first}\nSkill: synthesis-project-resume (not installed on this machine — install synthesis-skills first).`;
  }
  return `${first}\nSkill: ${skillPath}`;
}
