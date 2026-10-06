/**
 * Autopilot runs, read from synthesis v5's own records.
 *
 * A v5 autopilot run is one markdown plan file in a project. When a session
 * engages a plan, v5 writes a small pointer at
 * `$SYNTHESIS_HOME/state/autopilot/<session>.json` holding
 * {"plan": <absolute plan path>, "streak", "digest", "at"}; the folder first
 * appears on the first engage. `autopilot_cli.py status --all` reads every
 * pointer and its plan; this module reads the same records the same way and
 * never writes either.
 *
 * The plan reader mirrors synthesis/autopilot.py (`Plan`): header lines
 * (`Name: value`, bold allowed, `<placeholder>` counts as empty) before the
 * first `## ` heading, sections keyed by lower-cased heading text without a
 * parenthetical, checklist items `- [ ]` / `- [x]`, and HTML comments and
 * fenced blocks ignored everywhere.
 */
import { closeSync, existsSync, fstatSync, openSync, readSync, readdirSync, realpathSync } from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Source } from "./config.js";
import { isDemoSource } from "./config.js";
import { synthesisHome } from "./v5.js";

export const OPEN_STATUSES = ["running", "waiting", "blocked", "paused"] as const;
export const CLOSED_STATUSES = ["done", "incomplete", "cancelled"] as const;
const SHORT_HORIZONS = ["turn", "sitting", "session"];
const MAX_PLAN_BYTES = 4 << 20;
const MAX_POINTER_BYTES = 64 * 1024;
const MAX_POINTERS = 512;
/** v5 names a pointer after the session id with every other character replaced by `_`. */
export const SESSION_FILE = /^[A-Za-z0-9._-]{1,200}$/;

const FIELD = /^\**([A-Za-z][A-Za-z ]{1,30}?)\**\s*:\**\s*(.*?)\s*$/;
const ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.*?)\s*$/;
const LIST = /^\s*[-*+]\s+(?:\[([ xX])\]\s+)?(.*?)\s*$/;
// Python's str.splitlines() boundaries.
const LINE_BREAK = /\r\n|[\n\v\f\r\x1c\x1d\x1e\x85\u2028\u2029]/;

export interface PlanItem {
  done: boolean;
  text: string;
}

/** A plan file read the way synthesis/autopilot.py reads it. */
export class Plan {
  readonly fields: Record<string, string> = {};
  readonly sections: Record<string, string[]> = {};

  constructor(readonly path: string, readonly text: string) {
    let current: string | null = null;
    for (const line of visibleLines(text)) {
      if (line.startsWith("## ")) {
        current = line.slice(3).replace(/\s*\(.*$/, "").trim().toLowerCase();
        this.sections[current] ??= [];
      } else if (current !== null) {
        this.sections[current].push(line);
      } else if (!line.startsWith("#")) {
        const match = FIELD.exec(line.trim());
        if (match) {
          const name = match[1].trim().toLowerCase();
          if (!(name in this.fields)) this.fields[name] = match[2].trim();
        }
      }
    }
  }

  field(name: string): string {
    const value = this.fields[name] ?? "";
    return !value || (value.startsWith("<") && value.endsWith(">")) ? "" : value;
  }

  /** The first word of Status, lower case; `canceled` reads as `cancelled`. */
  get status(): string {
    const word = /^[a-z]+/.exec(this.field("status").toLowerCase());
    if (!word) return "";
    return word[0] === "canceled" ? "cancelled" : word[0];
  }

  /** What follows the status word: the reason of an incomplete or cancelled close. */
  get statusReason(): string {
    return this.field("status").replace(/^[A-Za-z]+[\s:—–-]*/, "").trim();
  }

  get title(): string {
    const heading = splitLines(this.text).find((line) => line.startsWith("# ")) ?? "";
    return heading.replace(/^#\s*(Autopilot plan:\s*)?/, "").trim() || basename(this.path).replace(/\.[^.]*$/, "");
  }

  items(section: string): PlanItem[] {
    const found: PlanItem[] = [];
    for (const line of this.sections[section] ?? []) {
      const match = ITEM.exec(line);
      if (match) found.push({ done: match[1] !== " ", text: match[2] });
    }
    return found;
  }

  openItems(section = "checklist"): string[] {
    return this.items(section).filter((item) => !item.done).map((item) => item.text);
  }

  /** Open questions only the principal can answer: unchecked or plain list items. */
  questions(): string[] {
    const found: string[] = [];
    for (const line of this.sections["questions for the principal"] ?? []) {
      const match = LIST.exec(line);
      if (match && match[2] && (match[1] === undefined || match[1] === " ")) found.push(match[2]);
    }
    return found;
  }

  get longHorizon(): boolean {
    const word = /^[a-z-]+/.exec(this.field("horizon").toLowerCase());
    return word !== null && !SHORT_HORIZONS.includes(word[0]);
  }
}

/** Python's str.splitlines(): no empty element after a final line break. */
export function splitLines(text: string): string[] {
  const lines = text.split(LINE_BREAK);
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Lines outside HTML comments and fenced blocks: examples there never count. */
export function visibleLines(text: string): string[] {
  const lines: string[] = [];
  let fence = "";
  for (const line of splitLines(text.replace(/<!--[\s\S]*?-->/g, ""))) {
    const marker = line.trimStart().slice(0, 3);
    if (marker === "```" || marker === "~~~") {
      fence = fence === marker ? "" : fence || marker;
      continue;
    }
    if (!fence) lines.push(line);
  }
  return lines;
}

function readBounded(path: string, limit: number): { text: string; mtimeMs: number } {
  const fd = openSync(path, "r");
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error("not a regular file");
    const buffer = Buffer.alloc(Math.min(stat.size, limit));
    let read = 0;
    while (read < buffer.length) {
      const count = readSync(fd, buffer, read, buffer.length - read, read);
      if (!count) break;
      read += count;
    }
    return { text: new TextDecoder("utf-8").decode(buffer.subarray(0, read)), mtimeMs: stat.mtimeMs };
  } finally {
    closeSync(fd);
  }
}

export function loadPlan(path: string): { plan: Plan; mtimeMs: number } {
  const { text, mtimeMs } = readBounded(path, MAX_PLAN_BYTES);
  return { plan: new Plan(path, text), mtimeMs };
}

export interface RunAttribution {
  source: string;
  project: string;
}

export interface AutopilotRun {
  /** The pointer file's name without `.json`: the engaging session's id. */
  session: string;
  planPath: string | null;
  /** When v5 last wrote the pointer (ISO 8601), from its `at`. */
  pointerAt: string | null;
  /** Turn-end continuation requests in a row for this plan. */
  streak: number;
  title: string | null;
  status: string;
  statusText: string;
  statusReason: string;
  owner: string;
  /** True when the plan's Owner session is the session that wrote this pointer. */
  ownedByPointer: boolean;
  /** Earlier sessions whose pointers still name this plan (after a takeover). */
  otherSessions: string[];
  fields: Record<string, string>;
  checklist: PlanItem[];
  criteria: PlanItem[];
  standing: PlanItem[];
  nextItem: string | null;
  openBlockers: string[];
  questions: string[];
  cycleLedger: string[];
  planModifiedAt: string | null;
  longHorizon: boolean;
  /** Why the plan could not be read; the other plan fields are then empty. */
  error: string | null;
  attribution: RunAttribution | null;
  /** The plan's text, for the detail page. */
  text: string | null;
}

export function autopilotStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(synthesisHome(env), "state", "autopilot");
}

const HEADER_FIELDS = [
  "harness", "engaged", "horizon", "continuation", "first wake", "backstop", "waiting on", "silent after",
];

function emptyRun(session: string): AutopilotRun {
  return {
    session, planPath: null, pointerAt: null, streak: 0, title: null, status: "", statusText: "",
    statusReason: "", owner: "", ownedByPointer: false, otherSessions: [], fields: {}, checklist: [], criteria: [], standing: [],
    nextItem: null, openBlockers: [], questions: [], cycleLedger: [], planModifiedAt: null, longHorizon: false,
    error: null, attribution: null, text: null,
  };
}

/** Read one pointer and its plan. Never throws: a broken record is a run with an error. */
export function readRun(stateDir: string, session: string): AutopilotRun {
  const run = emptyRun(session);
  let pointer: { plan?: unknown; streak?: unknown; at?: unknown };
  try {
    pointer = JSON.parse(readBounded(join(stateDir, session + ".json"), MAX_POINTER_BYTES).text);
  } catch (error) {
    run.error = `The run record could not be read (${(error as Error).message}).`;
    return run;
  }
  if (!pointer || typeof pointer !== "object" || typeof pointer.plan !== "string" || !pointer.plan) {
    run.error = "The run record names no plan file.";
    return run;
  }
  run.planPath = pointer.plan;
  run.streak = Number.isSafeInteger(pointer.streak) ? (pointer.streak as number) : 0;
  if (typeof pointer.at === "number" && Number.isFinite(pointer.at)) {
    run.pointerAt = new Date(pointer.at * 1000).toISOString();
  }
  if (!isAbsolute(pointer.plan)) {
    run.error = "The run record's plan path is not absolute.";
    return run;
  }
  let loaded: ReturnType<typeof loadPlan>;
  try {
    loaded = loadPlan(pointer.plan);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    run.error = code === "ENOENT"
      ? "The plan file no longer exists."
      : `The plan file could not be read (${code ?? (error as Error).message}).`;
    return run;
  }
  const { plan, mtimeMs } = loaded;
  const checklist = plan.items("checklist");
  return {
    ...run,
    title: plan.title,
    status: plan.status,
    statusText: plan.field("status"),
    statusReason: plan.statusReason,
    owner: plan.field("owner session"),
    ownedByPointer: plan.field("owner session").replace(/[^A-Za-z0-9._-]/g, "_") === session,
    fields: Object.fromEntries(HEADER_FIELDS.map((name) => [name, plan.field(name)]).filter(([, value]) => value)),
    checklist,
    criteria: plan.items("completion criteria"),
    standing: plan.items("standing checklist"),
    nextItem: checklist.find((item) => !item.done)?.text ?? null,
    openBlockers: plan.openItems("blockers"),
    questions: plan.questions(),
    cycleLedger: (plan.sections["cycle ledger"] ?? []).map((line) => line.trim()).filter(Boolean),
    planModifiedAt: new Date(mtimeMs).toISOString(),
    longHorizon: plan.longHorizon,
    text: plan.text,
  };
}

/** Every pointer in the state folder, newest pointer first. Empty when the folder does not exist yet. */
export function readRuns(stateDir: string): AutopilotRun[] {
  let names: string[];
  try {
    names = readdirSync(stateDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name.slice(0, -5))
      .filter((name) => SESSION_FILE.test(name) && name !== "." && name !== "..");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .sort()
    .slice(0, MAX_POINTERS)
    .map((name) => readRun(stateDir, name))
    .sort((a, b) => (b.pointerAt ?? "").localeCompare(a.pointerAt ?? ""));
}

function inside(path: string, root: string): string | null {
  const rel = relative(root, path);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) return null;
  return rel;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The configured source and project a plan lives in, by its path. */
export function attribute(planPath: string, sources: Source[]): RunAttribution | null {
  const plan = real(planPath);
  for (const source of sources) {
    if (!source.projects_dir) continue;
    const rel = inside(plan, real(resolve(source.root, source.projects_dir)));
    if (rel && rel.includes(sep)) return { source: source.name, project: rel.split(sep)[0] };
  }
  return null;
}

export type RunGroup = "open" | "closed" | "other" | "unreadable";

export function runGroup(run: AutopilotRun): RunGroup {
  if (run.error) return "unreadable";
  if ((OPEN_STATUSES as readonly string[]).includes(run.status)) return "open";
  if ((CLOSED_STATUSES as readonly string[]).includes(run.status)) return "closed";
  return "other";
}

export interface AutopilotOverview {
  stateDir: string;
  /** False when v5 has not created the state folder yet. */
  stateExists: boolean;
  runs: AutopilotRun[];
  /** Runs in configured sources that are not selected, counted but not shown. */
  hiddenRuns: number;
}

/** One entry per plan: a takeover leaves the earlier session's pointer naming the same plan. */
export function onePerPlan(runs: AutopilotRun[]): AutopilotRun[] {
  const byPlan = new Map<string, AutopilotRun>();
  const result: AutopilotRun[] = [];
  for (const run of runs) {
    if (!run.planPath) {
      result.push(run);
      continue;
    }
    const key = real(run.planPath);
    const kept = byPlan.get(key);
    if (!kept) {
      byPlan.set(key, run);
      result.push(run);
      continue;
    }
    if (run.ownedByPointer && !kept.ownedByPointer) {
      run.otherSessions.push(kept.session, ...kept.otherSessions);
      byPlan.set(key, run);
      result[result.indexOf(kept)] = run;
    } else {
      kept.otherSessions.push(run.session, ...run.otherSessions);
    }
  }
  return result;
}

/**
 * The runs the request may see. The source picker is a view boundary: a run
 * in an inactive source is counted, never shown. A run outside every
 * configured source is shown only while a non-sample source is active.
 */
export function autopilotOverview(stateDir: string, configured: Source[], active: Source[]): AutopilotOverview {
  const activeNames = new Set(active.map((source) => source.name));
  const realActive = active.some((source) => !isDemoSource(source));
  const runs: AutopilotRun[] = [];
  let hiddenRuns = 0;
  for (const run of onePerPlan(readRuns(stateDir))) {
    run.attribution = run.planPath ? attribute(run.planPath, configured) : null;
    const visible = run.attribution ? activeNames.has(run.attribution.source) : realActive;
    if (visible) runs.push(run);
    else hiddenRuns++;
  }
  return { stateDir, stateExists: existsSync(stateDir), runs, hiddenRuns };
}

/** Whether the request may see this run: the same boundary as the overview. */
export function runVisible(run: AutopilotRun, configured: Source[], active: Source[]): boolean {
  run.attribution = run.planPath ? attribute(run.planPath, configured) : null;
  if (run.attribution) return active.some((source) => source.name === run.attribution!.source);
  return active.some((source) => !isDemoSource(source));
}
