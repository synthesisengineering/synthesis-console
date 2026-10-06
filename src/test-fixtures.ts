/** Test helpers: a fake v5 runtime with chosen skill scripts. Never imported by the app. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SkillSearch } from "./skill-resolution.js";

/** A temporary folder laid out as `$SYNTHESIS_HOME` with `current/` holding the v5 marker. */
export function fakeRuntime(roots: string[]): { home: string; search: SkillSearch } {
  const base = mkdtempSync(join(tmpdir(), "console-v5-"));
  roots.push(base);
  const home = join(base, "synthesis-home");
  mkdirSync(join(home, "current", "synthesis"), { recursive: true });
  writeFileSync(join(home, "current", "synthesis", "hook.py"), "# v5 runtime marker\n");
  return { home, search: { runtime: home, caches: [join(base, "no-caches")] } };
}

/** Write `<runtime>/current/skills/<skill>/scripts/<name>` and return its path. */
export function fakeSkillScript(home: string, skill: string, name: string, body: string): string {
  const dir = join(home, "current", "skills", skill, "scripts");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, body);
  return path;
}
