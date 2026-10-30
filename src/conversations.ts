/**
 * Agent conversations, read through `synthesis sessions` (synthesis v5.3.0 and later): every harness's sessions
 * on this machine, and those other machines synced into each workspace's sessions repo. Read-only: the Console
 * runs the list, search and show commands, bounded in time and output, and never exports, syncs or writes.
 *
 * Contract (synthesis/cli.py, `--json`): one JSON object per line. `list` prints each session's meta
 * (harness, session, started, last, records, projects, models, role, synced); `show` and `search` print records
 * (seq, at, kind, text, model, tool, input; search adds harness and session).
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { finiteCommand } from "./finite-command.js";
import { doctorLauncher } from "./doctor.js";
import { describeFailure } from "./v5.js";

export const SESSIONS_TIMEOUT_MS = 30_000;
const LIST_BYTES = 4 * 1024 * 1024;
const SHOW_BYTES = 16 * 1024 * 1024;
/** What a reader sees by default: the people and agents talking, and what compaction kept. */
export const CONVERSATION_KINDS = "user,brief,assistant,compaction";
/** With the work shown: the models' reasoning and each tool call. */
export const FULL_KINDS = "user,brief,assistant,reasoning,compaction,tool_call";

export interface SessionMeta {
  harness: string;
  session: string;
  started?: string;
  last?: string;
  records?: number;
  projects?: string[];
  models?: string[];
  role?: string;
  parent?: string;
  synced?: string;
  cwd?: string;
}

export interface SessionRecord {
  seq: number;
  at?: string;
  kind: string;
  text?: string;
  text_chars?: number;
  model?: string;
  tool?: string;
  input?: unknown;
  harness?: string;
  session?: string;
}

export interface Outcome<T> {
  /** False when there is no `synthesis` command. */
  installed: boolean;
  items: T[];
  /** Why there are no items, when something went wrong. */
  error: string | null;
}

export interface Filter {
  workspace?: string;
  project?: string;
  limit?: number;
}

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/** A workspace, project or session name as given, or "" when it is not one. */
export function validName(value: string | undefined | null): string {
  return value && NAME.test(value) ? value : "";
}

/** The words as typed, matched literally by the CLI's regular-expression search. */
export function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseLines<T>(stdout: string): T[] {
  const items: T[] = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    try {
      items.push(JSON.parse(line) as T);
    } catch {
      throw new Error("synthesis sessions printed a line that is not JSON.");
    }
  }
  return items;
}

function filters(filter: Filter): string[] {
  const args: string[] = [];
  const workspace = validName(filter.workspace);
  const project = validName(filter.project);
  if (workspace) args.push("--workspace", workspace);
  if (project) args.push("--project", project);
  args.push("--limit", String(Math.min(Math.max(Math.trunc(filter.limit ?? 50), 1), 500)));
  return args;
}

/** Run `synthesis sessions <args> --json`; a positional after `--` can never be read as an option. */
async function run<T>(args: string[], positional: string[], maxOutputBytes: number, launcher = doctorLauncher()):
  Promise<Outcome<T>> {
  if (!existsSync(launcher)) return { installed: false, items: [], error: null };
  const argv = ["sessions", ...args, "--json", ...(positional.length ? ["--", ...positional] : [])];
  const result = await finiteCommand(launcher, argv, { cwd: homedir(), timeoutMs: SESSIONS_TIMEOUT_MS, maxOutputBytes });
  if (result.kind !== "success") {
    return { installed: true, items: [], error: describeFailure(result, "synthesis sessions", SESSIONS_TIMEOUT_MS) };
  }
  try {
    return { installed: true, items: parseLines<T>(result.stdout), error: null };
  } catch (error) {
    return { installed: true, items: [], error: (error as Error).message };
  }
}

export function listSessions(filter: Filter = {}, launcher?: string): Promise<Outcome<SessionMeta>> {
  return run<SessionMeta>(["list", ...filters(filter)], [], LIST_BYTES, launcher);
}

export function searchConversations(query: string, filter: Filter = {}, launcher?: string): Promise<Outcome<SessionRecord>> {
  const words = query.trim().slice(0, 200);
  if (!words) return Promise.resolve({ installed: true, items: [], error: null });
  return run<SessionRecord>(["search", "--kinds", CONVERSATION_KINDS, ...filters(filter)], [escapeRegExp(words)],
    LIST_BYTES, launcher);
}

export function showSession(id: string, full = false, launcher?: string): Promise<Outcome<SessionRecord>> {
  const session = validName(id);
  if (!session) return Promise.resolve({ installed: true, items: [], error: "That is not a session id." });
  return run<SessionRecord>(["show", "--kinds", full ? FULL_KINDS : CONVERSATION_KINDS], [session], SHOW_BYTES, launcher);
}
