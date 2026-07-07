import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";
import yaml from "js-yaml";

export interface SlackConfig {
  /** Workspace subdomain, e.g. "rajivpant.slack.com". Used to build https permalinks. */
  workspace_url?: string;
  /** Team / workspace ID, e.g. "T123456". Used to scope slack:// deeplinks. */
  team_id?: string;
  /**
   * Name of an environment variable holding a Slack user OAuth token (xoxp-...).
   * The token itself is NEVER stored in the YAML — only the env-var name. When
   * the env var is unset, send-via-API is disabled and the UI gracefully degrades
   * to copy + paste-into-Slack.
   */
  user_token_env?: string;
  /** Path (relative to source.root) to a YAML file mapping display name → user ID. */
  users_file?: string;
  /** Path (relative to source.root) to a YAML file mapping channel name → channel ID. */
  channels_file?: string;
  /**
   * Cockpit Mode Tier-A auto-send (v0.10+). When true, one-tap approval on
   * a Tier-A draft in NEEDS YOU sends directly without a confirm modal.
   * When false (default), all sends — including one-tap approvals — go
   * through the same confirm-modal flow as the standard drafts region.
   * Requires the standing authority-matrix approval (working-system-v3 §4)
   * before flipping to true; when the matrix isn't approved, keep this
   * false and Tier-A drafts route through the Tier-B queue.
   */
  tier_a_send_enabled?: boolean;
}

export interface Source {
  name: string;
  display_name?: string;
  root: string;
  projects_dir?: string;
  lessons_dir?: string;
  plans_dir?: string;
  notes_dir?: string;
  /** Relative path to meeting-prep packs dir (v0.13+) — contributes /prep/:source/:slug pages. */
  preps_dir?: string;
  default_active?: boolean;
  demo?: boolean;
  slack?: SlackConfig;
}

export interface ConsoleConfig {
  sources: Source[];
  port: number;
  demoMode: boolean;
}

const CONFIG_PATH = join(homedir(), ".synthesis", "console.yaml");
const DEFAULT_PORT = 5555;
const BUILTIN_DEMO_NAME = "demo";

function expandTilde(p: string): string {
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function isDirectory(p: string): boolean {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function hasProjectsIndex(p: string): boolean {
  return existsSync(join(p, "index.yaml"));
}

function detectContentDirs(root: string): Pick<Source, "projects_dir" | "lessons_dir" | "plans_dir" | "notes_dir" | "preps_dir"> {
  const out: Pick<Source, "projects_dir" | "lessons_dir" | "plans_dir" | "notes_dir" | "preps_dir"> = {};

  // New layout (preferred): top-level lessons/, daily-plans/
  if (isDirectory(join(root, "projects")) && hasProjectsIndex(join(root, "projects"))) {
    out.projects_dir = "projects";
  }
  if (isDirectory(join(root, "lessons"))) out.lessons_dir = "lessons";
  if (isDirectory(join(root, "daily-plans"))) out.plans_dir = "daily-plans";
  if (isDirectory(join(root, "notes"))) out.notes_dir = "notes";
  if (isDirectory(join(root, "meeting-preps"))) out.preps_dir = "meeting-preps";

  // Legacy layout fallback: projects/_lessons, projects/_daily-plans
  if (!out.lessons_dir && isDirectory(join(root, "projects", "_lessons"))) {
    out.lessons_dir = "projects/_lessons";
  }
  if (!out.plans_dir && isDirectory(join(root, "projects", "_daily-plans"))) {
    out.plans_dir = "projects/_daily-plans";
  }

  return out;
}

function autoDetectSources(): Source[] {
  const workspacesDir = join(homedir(), "workspaces");
  if (!existsSync(workspacesDir)) return [];

  const found: Source[] = [];
  const entries = readdirSync(workspacesDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const wsRoot = join(workspacesDir, entry.name);
    let wsEntries: ReturnType<typeof readdirSync>;
    try {
      wsEntries = readdirSync(wsRoot, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const wsEntry of wsEntries) {
      if (!wsEntry.isDirectory() || !wsEntry.name.startsWith("ai-knowledge-")) continue;

      const root = join(wsRoot, wsEntry.name);
      const dirs = detectContentDirs(root);
      if (!dirs.projects_dir && !dirs.lessons_dir && !dirs.plans_dir && !dirs.notes_dir) continue;

      const suffix = wsEntry.name.slice("ai-knowledge-".length);
      const name = suffix || entry.name;

      found.push({
        name,
        display_name: name.charAt(0).toUpperCase() + name.slice(1),
        root,
        ...dirs,
        default_active: entry.name === "rajiv",
      });
    }
  }

  return found;
}

function getBuiltInDemoSource(): Source {
  const projectRoot = dirname(import.meta.dir);
  return {
    name: BUILTIN_DEMO_NAME,
    display_name: "Demo",
    root: join(projectRoot, "demo", "ai-knowledge-demo"),
    projects_dir: "projects",
    lessons_dir: "lessons",
    plans_dir: "daily-plans",
    preps_dir: "meeting-preps",
    demo: true,
    default_active: false,
    slack: {
      // Demo workspace metadata (fictional). No `user_token_env` — demo
      // doesn't authenticate, so the Send-to-Slack button never appears
      // and no API call is ever attempted from demo data. The directory
      // files are bundled with the repo so mention pills + reliable Open
      // -in-Slack URLs render correctly in `bun run demo`.
      workspace_url: "demo.slack.com",
      team_id: "T0DEMO0000",
      users_file: "source/contexts/slack-users.yaml",
      channels_file: "source/contexts/slack-channels.yaml",
    },
  };
}

function normalizeSource(raw: Record<string, unknown>): Source {
  if (!raw.name || typeof raw.name !== "string") {
    throw new Error("Source is missing required field 'name'");
  }
  if (!raw.root || typeof raw.root !== "string") {
    throw new Error(`Source '${raw.name}' is missing required field 'root'`);
  }

  let slack: SlackConfig | undefined;
  if (raw.slack && typeof raw.slack === "object") {
    const s = raw.slack as Record<string, unknown>;
    slack = {
      workspace_url: typeof s.workspace_url === "string" ? s.workspace_url : undefined,
      team_id: typeof s.team_id === "string" ? s.team_id : undefined,
      user_token_env: typeof s.user_token_env === "string" ? s.user_token_env : undefined,
      users_file: typeof s.users_file === "string" ? s.users_file : undefined,
      channels_file: typeof s.channels_file === "string" ? s.channels_file : undefined,
    };
  }

  return {
    name: raw.name,
    display_name: typeof raw.display_name === "string" ? raw.display_name : undefined,
    root: expandTilde(raw.root),
    projects_dir: typeof raw.projects_dir === "string" ? raw.projects_dir : undefined,
    lessons_dir: typeof raw.lessons_dir === "string" ? raw.lessons_dir : undefined,
    plans_dir: typeof raw.plans_dir === "string" ? raw.plans_dir : undefined,
    notes_dir: typeof raw.notes_dir === "string" ? raw.notes_dir : undefined,
    default_active: raw.default_active === true,
    demo: raw.demo === true,
    slack,
  };
}

/**
 * Resolve the Slack user token for a source by reading the env var named in
 * source.slack.user_token_env. Returns undefined if Slack is not configured or
 * the env var is unset. Tokens are intentionally read at request time (not
 * cached) so rotating the env var takes effect on the next request.
 */
export function getSlackToken(src: Source): string | undefined {
  const envName = src.slack?.user_token_env;
  if (!envName) return undefined;
  const value = process.env[envName];
  return value && value.length > 0 ? value : undefined;
}

export function getSlackUsersPath(src: Source): string | null {
  return resolveSlackFilePath(src, src.slack?.users_file);
}

export function getSlackChannelsPath(src: Source): string | null {
  return resolveSlackFilePath(src, src.slack?.channels_file);
}

/**
 * Resolve a Slack directory file path with three accepted forms:
 *   - "/abs/path/file.yaml"     — absolute, used as-is
 *   - "~/relative/file.yaml"    — homedir-relative, expanded
 *   - "relative/file.yaml"      — source-root-relative (legacy default)
 *
 * Absolute and ~/ forms allow placing the directory files outside the
 * source's root — useful for machine-local storage (~/.synthesis/...) or
 * for relocating workspace-specific data into a sibling workspace-private
 * repo without making the source's root span both.
 */
function resolveSlackFilePath(src: Source, p: string | undefined): string | null {
  if (!p) return null;
  if (p.startsWith("/")) return p;
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return join(src.root, p);
}

export function loadConfig(options?: { demo?: boolean }): ConsoleConfig {
  const demoSource = getBuiltInDemoSource();

  if (options?.demo) {
    return { sources: [demoSource], port: DEFAULT_PORT, demoMode: true };
  }

  if (existsSync(CONFIG_PATH)) {
    try {
      const raw = readFileSync(CONFIG_PATH, "utf-8");
      const parsed = yaml.load(raw) as Record<string, unknown>;

      if (parsed && "workspaces" in parsed && !("sources" in parsed)) {
        throw new Error(
          `Your ${CONFIG_PATH} uses the v0.1 'workspaces:' schema, which synthesis-console v0.2 no longer supports.\n\n` +
          `Migration:\n` +
          `  1. Rename 'workspaces:' to 'sources:'.\n` +
          `  2. For each entry, replace 'knowledge: <name>' with:\n` +
          `       root: <root>/<name>     (combine root + knowledge into one absolute path)\n` +
          `       projects_dir: projects\n` +
          `       lessons_dir: lessons      (if your layout has top-level lessons/)\n` +
          `       plans_dir: daily-plans    (if your layout has top-level daily-plans/)\n` +
          `  3. Mark one source with 'default_active: true' for first-run selection.\n\n` +
          `See console.yaml.example in the repo for the canonical shape, and docs/layouts.md\n` +
          `for alternative layouts.`
        );
      }

      const sources: Source[] = [];
      if (Array.isArray(parsed.sources)) {
        for (const raw of parsed.sources) {
          sources.push(normalizeSource(raw as Record<string, unknown>));
        }
      }

      if (sources.length === 0) {
        console.error("  No sources defined in config. Falling back to auto-detection.\n");
      }

      const names = new Set<string>();
      for (const s of sources) {
        if (names.has(s.name)) {
          throw new Error(`Duplicate source name '${s.name}' in ${CONFIG_PATH}`);
        }
        names.add(s.name);
      }

      if (!names.has(BUILTIN_DEMO_NAME)) sources.push(demoSource);

      return {
        sources,
        port: typeof parsed.port === "number" ? parsed.port : DEFAULT_PORT,
        demoMode: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  Failed to load ${CONFIG_PATH}:\n\n${msg}\n`);
      process.exit(1);
    }
  }

  const detected = autoDetectSources();
  if (detected.length > 0) {
    detected.push(demoSource);
    return { sources: detected, port: DEFAULT_PORT, demoMode: false };
  }

  console.log("  No config file and no auto-detected sources. Starting with demo source only.");
  console.log("  Create ~/.synthesis/console.yaml to add your own content.\n");
  return { sources: [demoSource], port: DEFAULT_PORT, demoMode: true };
}

export function isDemoSource(src: Source): boolean {
  return src.demo === true;
}

export function getProjectsPath(src: Source): string | null {
  return src.projects_dir ? join(src.root, src.projects_dir) : null;
}

export function getProjectPath(src: Source, projectId: string): string | null {
  const projectsDir = getProjectsPath(src);
  return projectsDir ? join(projectsDir, projectId) : null;
}

export function getLessonsPath(src: Source): string | null {
  return src.lessons_dir ? join(src.root, src.lessons_dir) : null;
}

export function getPlansPath(src: Source): string | null {
  return src.plans_dir ? join(src.root, src.plans_dir) : null;
}

export function getNotesPath(src: Source): string | null {
  return src.notes_dir ? join(src.root, src.notes_dir) : null;
}

export function getPrepsPath(src: Source): string | null {
  return src.preps_dir ? join(src.root, src.preps_dir) : null;
}

export function findSource(sources: Source[], name: string): Source | undefined {
  return sources.find((s) => s.name === name);
}

export function displayName(src: Source): string {
  return src.display_name || src.name;
}
