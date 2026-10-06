import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginRoots, resolveSkillScript, searchedLocations, skillDirs, skillSearch } from "./skill-resolution.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function temporary(): string {
  const root = mkdtempSync(join(tmpdir(), "synthesis-console-skills-"));
  roots.push(root);
  return root;
}

/** A plugin root; `v5` writes the runtime marker synthesis doctor also checks. */
function pluginRoot(path: string, v5 = true, skill?: string): string {
  mkdirSync(join(path, "skills"), { recursive: true });
  if (v5) {
    mkdirSync(join(path, "synthesis"), { recursive: true });
    writeFileSync(join(path, "synthesis", "hook.py"), "");
  }
  if (skill) {
    mkdirSync(join(path, "skills", skill, "scripts"), { recursive: true });
    writeFileSync(join(path, "skills", skill, "scripts", "tool.py"), "");
  }
  return path;
}

describe("v5 skill resolution", () => {
  test("defaults: SYNTHESIS_HOME (else ~/.synthesis/v5) and the three harness caches", () => {
    expect(skillSearch({}, "/home/u")).toEqual({
      runtime: "/home/u/.synthesis/v5",
      caches: [
        "/home/u/.claude/plugins/cache",
        "/home/u/.codex/plugins/cache",
        "/home/u/.local/share/muse/plugins/cache",
      ],
    });
    expect(skillSearch({ SYNTHESIS_HOME: "/v5" }, "/home/u").runtime).toBe("/v5");
  });

  test("orders v5 plugin versions newest first across Claude Code and Codex caches", () => {
    const root = temporary();
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    const older = pluginRoot(join(claude, "market", "synthesis-skills", "5.0.0"));
    const newer = pluginRoot(join(codex, "market", "synthesis-skills", "5.0.1"));
    expect(pluginRoots([claude, codex])).toEqual([newer, older]);
  });

  test("ignores plugin versions without the v5 runtime package", () => {
    const root = temporary();
    const claude = join(root, "claude");
    pluginRoot(join(claude, "market", "synthesis-skills", "4.154.12"), false);
    const v5 = pluginRoot(join(claude, "market", "synthesis-skills", "5.0.1"));
    expect(pluginRoots([claude])).toEqual([v5]);
  });

  test("finds the Muse package-nested layout and sorts content hashes below versions", () => {
    const root = temporary();
    const claude = join(root, "claude");
    const muse = join(root, "muse");
    const versioned = pluginRoot(join(claude, "market", "synthesis-skills", "5.0.1"));
    // Leading digits must not read as version 536: a hash is not a release.
    const hashed = pluginRoot(join(muse, "local", "synthesis-skills", "536d4eec39826a1d", "package"));
    expect(pluginRoots([claude, muse])).toEqual([versioned, hashed]);
  });

  test("the v5 runtime comes first, then the caches; a script resolves from the first holder", () => {
    const root = temporary();
    const runtime = join(root, "v5");
    pluginRoot(join(runtime, "current"), true);
    const cache = join(root, "claude");
    const plugin = pluginRoot(join(cache, "market", "synthesis-skills", "5.0.1"), true, "synthesis-repo-guard");
    const search = { runtime, caches: [cache] };
    expect(skillDirs("synthesis-repo-guard", search)).toEqual([
      join(runtime, "current", "skills", "synthesis-repo-guard"),
      join(plugin, "skills", "synthesis-repo-guard"),
    ]);
    expect(resolveSkillScript("synthesis-repo-guard", "tool.py", search)).toBe(
      join(plugin, "skills", "synthesis-repo-guard", "scripts", "tool.py")
    );
    pluginRoot(join(runtime, "current"), true, "synthesis-repo-guard");
    expect(resolveSkillScript("synthesis-repo-guard", "tool.py", search)).toBe(
      join(runtime, "current", "skills", "synthesis-repo-guard", "scripts", "tool.py")
    );
    expect(resolveSkillScript("synthesis-absent", "tool.py", search)).toBeNull();
    expect(searchedLocations(search)).toEqual([join(runtime, "current", "skills"), cache]);
  });
});
