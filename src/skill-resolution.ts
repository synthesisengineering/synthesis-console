/**
 * Find a synthesis v5 skill folder on this machine.
 *
 * v5 skills reach a machine two ways: each harness installs the
 * synthesis-skills plugin into its own plugin cache (Claude Code, Codex,
 * Muse), and v5's install copies a few skills into its runtime at
 * `$SYNTHESIS_HOME/current/skills`. A folder counts only when its plugin
 * root carries the v5 runtime package (`synthesis/hook.py`), the same marker
 * `synthesis doctor` checks, so an older plugin left in a cache never runs.
 *
 * Order: the v5 runtime first (the synthesis-owned location that survives
 * harness plugin churn), then plugin caches newest version first. Resolution
 * runs on every call, so installing or updating the plugin needs no Console
 * restart.
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { synthesisHome } from "./v5.js";

export interface SkillSearch {
  /** The v5 runtime folder (`SYNTHESIS_HOME`). */
  runtime: string;
  /** Harness plugin cache roots, each `<cache>/<marketplace>/<plugin>/<version>`. */
  caches: string[];
}

export function skillSearch(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): SkillSearch {
  return {
    runtime: synthesisHome(env, home),
    caches: [
      join(home, ".claude", "plugins", "cache"),
      join(home, ".codex", "plugins", "cache"),
      join(home, ".local", "share", "muse", "plugins", "cache"),
    ],
  };
}

function directories(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** True when a folder holds the v5 runtime package. */
export function isV5Root(root: string): boolean {
  return existsSync(join(root, "synthesis", "hook.py"));
}

function compareVersions(a: string, b: string): number {
  const left = a.split(/[.\-+]/);
  const right = b.split(/[.\-+]/);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    // A segment is numeric only when entirely digits. Content-hash install
    // folders (Muse's generation ids) can start with digits but are not
    // versions, and sort below every real release.
    const l = left[index] ?? "";
    const r = right[index] ?? "";
    const lNum = /^\d+$/.test(l);
    const rNum = /^\d+$/.test(r);
    if (!lNum && !rNum) continue;
    if (!lNum) return -1;
    if (!rNum) return 1;
    if (Number(l) !== Number(r)) return Number(l) - Number(r);
  }
  return 0;
}

/** v5 plugin roots across the caches, newest version first. */
export function pluginRoots(caches: string[]): string[] {
  const found: { version: string; root: string }[] = [];
  for (const cache of caches) {
    for (const marketplace of directories(cache)) {
      for (const plugin of directories(join(cache, marketplace))) {
        const pluginDir = join(cache, marketplace, plugin);
        for (const version of directories(pluginDir)) {
          // Claude Code and Codex: <version>/. Muse: <generation>/package/.
          for (const root of [join(pluginDir, version), join(pluginDir, version, "package")]) {
            if (isV5Root(root)) found.push({ version, root });
          }
        }
      }
    }
  }
  return found
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((entry) => entry.root);
}

/** Candidate folders for one skill, in resolution order. */
export function skillDirs(skillName: string, search: SkillSearch = skillSearch()): string[] {
  const dirs: string[] = [];
  const current = join(search.runtime, "current");
  if (isV5Root(current)) dirs.push(join(current, "skills", skillName));
  for (const root of pluginRoots(search.caches)) dirs.push(join(root, "skills", skillName));
  return dirs;
}

/** The first existing `<skill>/<relativePath>`, or null. */
export function resolveSkillFile(
  skillName: string,
  relativePath: string,
  search: SkillSearch = skillSearch()
): string | null {
  for (const dir of skillDirs(skillName, search)) {
    const file = join(dir, relativePath);
    if (existsSync(file)) return file;
  }
  return null;
}

/** A skill script under `<skill>/scripts/`, or null. */
export function resolveSkillScript(
  skillName: string,
  scriptName: string,
  search: SkillSearch = skillSearch()
): string | null {
  return resolveSkillFile(skillName, join("scripts", scriptName), search);
}

/** The places searched, for an empty state to name. */
export function searchedLocations(search: SkillSearch = skillSearch()): string[] {
  return [join(search.runtime, "current", "skills"), ...search.caches];
}
