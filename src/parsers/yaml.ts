import { readFileSync } from "fs";
import * as yaml from "js-yaml";
import type { Source } from "../config.js";
import { getProjectsPath } from "../config.js";

export type ProjectStatus =
  | "new"
  | "active"
  | "paused"
  | "ongoing"
  | "completed"
  | "archived"
  | "superseded";

export interface Project {
  id: string;
  name: string;
  status: ProjectStatus;
  description: string;
  tags: string[];
  started_date?: string;
  completed_date?: string;
  archived_date?: string;
  last_session?: string;
  related?: string[];
  outcome?: string;
  key_result?: string;
  client?: string;
  superseded_by?: string;
  technologies?: string[];
  initiative?: string;
}

export interface ProjectWithSource extends Project {
  _source: string;
}

export interface Initiative {
  id: string;
  name: string;
  status: ProjectStatus;
  description?: string;
  started_date?: string;
  target_date?: string;
  completed_date?: string;
  lead?: string;
  stakeholder?: string;
  tags?: string[];
  related?: string[];
  links?: Record<string, string>;
}

export interface InitiativeWithSource extends Initiative {
  _source: string;
}

function toStr(val: unknown): string | undefined {
  if (val == null) return undefined;
  if (val instanceof Date) {
    return val.toISOString().slice(0, 10);
  }
  return String(val);
}

function normalizeLinks(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") out[k] = v;
    else if (v != null) out[k] = String(v);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeProject(raw: Record<string, unknown>): Project {
  return {
    id: String(raw.id || ""),
    name: String(raw.name || ""),
    status: String(raw.status || "active") as ProjectStatus,
    description: String(raw.description || ""),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : [],
    started_date: toStr(raw.started_date),
    completed_date: toStr(raw.completed_date),
    archived_date: toStr(raw.archived_date),
    last_session: toStr(raw.last_session),
    related: Array.isArray(raw.related) ? raw.related.map(String) : undefined,
    outcome: toStr(raw.outcome),
    key_result: toStr(raw.key_result),
    client: toStr(raw.client),
    superseded_by: toStr(raw.superseded_by),
    technologies: Array.isArray(raw.technologies)
      ? raw.technologies.map(String)
      : undefined,
    initiative: toStr(raw.initiative),
  };
}

function normalizeInitiative(raw: Record<string, unknown>): Initiative {
  return {
    id: String(raw.id || ""),
    name: String(raw.name || ""),
    status: String(raw.status || "active") as ProjectStatus,
    description: toStr(raw.description),
    started_date: toStr(raw.started_date),
    target_date: toStr(raw.target_date),
    completed_date: toStr(raw.completed_date),
    lead: toStr(raw.lead),
    stakeholder: toStr(raw.stakeholder),
    tags: Array.isArray(raw.tags) ? raw.tags.map(String) : undefined,
    related: Array.isArray(raw.related) ? raw.related.map(String) : undefined,
    links: normalizeLinks(raw.links),
  };
}

export function loadProjectIndex(src: Source): Project[] {
  const projectsDir = getProjectsPath(src);
  if (!projectsDir) return [];

  const indexPath = `${projectsDir}/index.yaml`;
  try {
    const raw = readFileSync(indexPath, "utf-8");
    const parsed = yaml.load(raw, { json: true }) as { projects?: Record<string, unknown>[] };
    if (!parsed?.projects) return [];
    return parsed.projects.map(normalizeProject);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(`Failed to load project index at ${indexPath}: ${err instanceof Error ? err.message : err}`);
    }
    return [];
  }
}

export function loadInitiativeIndex(src: Source): Initiative[] {
  const projectsDir = getProjectsPath(src);
  if (!projectsDir) return [];

  const indexPath = `${projectsDir}/index.yaml`;
  try {
    const raw = readFileSync(indexPath, "utf-8");
    const parsed = yaml.load(raw, { json: true }) as { initiatives?: Record<string, unknown>[] };
    if (!Array.isArray(parsed?.initiatives)) return [];
    return parsed.initiatives.map(normalizeInitiative);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") {
      console.warn(`Failed to load initiatives at ${indexPath}: ${err instanceof Error ? err.message : err}`);
    }
    return [];
  }
}

export function loadProjectsFromSources(sources: Source[]): ProjectWithSource[] {
  const out: ProjectWithSource[] = [];
  for (const src of sources) {
    const projects = loadProjectIndex(src);
    for (const p of projects) {
      out.push({ ...p, _source: src.name });
    }
  }
  return out;
}

export function loadInitiativesFromSources(sources: Source[]): InitiativeWithSource[] {
  const out: InitiativeWithSource[] = [];
  for (const src of sources) {
    const initiatives = loadInitiativeIndex(src);
    for (const i of initiatives) {
      out.push({ ...i, _source: src.name });
    }
  }
  return out;
}

export function getProjectById(
  projects: Project[],
  id: string
): Project | undefined {
  return projects.find((p) => p.id === id);
}

export function getInitiativeById(
  initiatives: Initiative[],
  id: string
): Initiative | undefined {
  return initiatives.find((i) => i.id === id);
}

export function groupByStatus(
  projects: Project[]
): Record<ProjectStatus, Project[]> {
  const groups: Record<ProjectStatus, Project[]> = {
    new: [],
    active: [],
    paused: [],
    ongoing: [],
    completed: [],
    archived: [],
    superseded: [],
  };

  for (const p of projects) {
    const status = p.status as ProjectStatus;
    if (groups[status]) {
      groups[status].push(p);
    }
  }

  return groups;
}

export function getAllTags(projects: Project[]): Map<string, number> {
  const tags = new Map<string, number>();
  for (const p of projects) {
    if (p.tags) {
      for (const tag of p.tags) {
        tags.set(tag, (tags.get(tag) || 0) + 1);
      }
    }
  }
  return new Map([...tags.entries()].sort((a, b) => b[1] - a[1]));
}

export function filterProjects<T extends Project>(
  projects: T[],
  opts: {
    status?: string;
    tag?: string;
    client?: string;
    q?: string;
    source?: string;
    initiative?: string;
  }
): T[] {
  let filtered = projects;

  if (opts.status) {
    const statuses = opts.status.split(",");
    filtered = filtered.filter((p) => statuses.includes(p.status));
  }

  if (opts.tag) {
    const tags = opts.tag.split(",");
    filtered = filtered.filter(
      (p) => p.tags && tags.some((t) => p.tags.includes(t))
    );
  }

  if (opts.client) {
    filtered = filtered.filter((p) => p.client === opts.client);
  }

  if (opts.source) {
    const sources = opts.source.split(",");
    filtered = filtered.filter(
      (p) => "_source" in p && sources.includes((p as unknown as ProjectWithSource)._source)
    );
  }

  if (opts.initiative) {
    if (opts.initiative === "_ungrouped") {
      filtered = filtered.filter((p) => !p.initiative);
    } else {
      const initiatives = opts.initiative.split(",");
      filtered = filtered.filter((p) => p.initiative && initiatives.includes(p.initiative));
    }
  }

  if (opts.q) {
    const query = opts.q.toLowerCase();
    filtered = filtered.filter(
      (p) =>
        p.name.toLowerCase().includes(query) ||
        p.description?.toLowerCase().includes(query) ||
        p.id.toLowerCase().includes(query) ||
        (p.tags && p.tags.some((t) => t.toLowerCase().includes(query)))
    );
  }

  return filtered;
}
