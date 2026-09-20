import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pluginSkillDirs } from "./skill-resolution.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

describe("plugin skill resolution", () => {
  test("orders versions globally across Claude and Codex caches", () => {
    const root = mkdtempSync(join(tmpdir(), "synthesis-console-skills-"));
    roots.push(root);
    const claude = join(root, "claude");
    const codex = join(root, "codex");
    const skill = "synthesis-agent-conformance";
    const oldSkill = join(claude, "market", "plugin", "4.22.0", "skills", skill);
    const newSkill = join(codex, "market", "plugin", "4.24.0", "skills", skill);
    mkdirSync(oldSkill, { recursive: true });
    mkdirSync(newSkill, { recursive: true });

    expect(pluginSkillDirs([claude, codex], skill)).toEqual([newSkill, oldSkill]);
  });

  test("finds the Muse package-nested layout", () => {
    const root = mkdtempSync(join(tmpdir(), "synthesis-console-skills-"));
    roots.push(root);
    const muse = join(root, "muse");
    const skill = "synthesis-project-resume";
    const nested = join(muse, "local", "plugin", "abc123", "package", "skills", skill);
    mkdirSync(nested, { recursive: true });

    expect(pluginSkillDirs([muse], skill)).toEqual([nested]);
  });
});
