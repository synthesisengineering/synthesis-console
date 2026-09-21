import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectWithSource } from "./yaml.js";
import {
  annotateRecency,
  newestSessionMs,
  relativeLabel,
  resumePrompt,
  sortProjects,
} from "./recency.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true });
});

function makeProject(overrides: Partial<ProjectWithSource> = {}): ProjectWithSource {
  return {
    id: "demo",
    name: "Demo",
    status: "active",
    description: "",
    tags: [],
    _source: "test",
    ...overrides,
  };
}

describe("newestSessionMs", () => {
  test("returns null without a sessions dir", () => {
    const root = mkdtempSync(join(tmpdir(), "recency-"));
    roots.push(root);
    expect(newestSessionMs(join(root, "proj"))).toBeNull();
  });

  test("picks the newest markdown session", () => {
    const root = mkdtempSync(join(tmpdir(), "recency-"));
    roots.push(root);
    const sessions = join(root, "proj", "sessions");
    mkdirSync(sessions, { recursive: true });
    const oldFile = join(sessions, "2026-08.md");
    const newFile = join(sessions, "2026-09.md");
    writeFileSync(oldFile, "# old\n");
    writeFileSync(newFile, "# new\n");
    writeFileSync(join(sessions, "notes.txt"), "ignored\n");
    const old = new Date("2026-08-31T12:00:00Z");
    const fresh = new Date("2026-09-19T12:00:00Z");
    utimesSync(oldFile, old, old);
    utimesSync(newFile, fresh, fresh);
    expect(newestSessionMs(join(root, "proj"))).toBe(fresh.getTime());
  });

  test("ignores the generated INDEX.md", () => {
    const root = mkdtempSync(join(tmpdir(), "recency-"));
    roots.push(root);
    const sessions = join(root, "proj", "sessions");
    mkdirSync(sessions, { recursive: true });
    const sessionFile = join(sessions, "2026-09.md");
    const indexFile = join(sessions, "INDEX.md");
    writeFileSync(sessionFile, "# s\n");
    writeFileSync(indexFile, "# index\n");
    const old = new Date("2026-09-19T12:00:00Z");
    const fresh = new Date("2026-09-20T12:00:00Z");
    utimesSync(sessionFile, old, old);
    utimesSync(indexFile, fresh, fresh);
    expect(newestSessionMs(join(root, "proj"))).toBe(old.getTime());
  });
});

describe("relativeLabel", () => {
  const now = new Date("2026-09-20T12:00:00Z").getTime();
  test("labels minute, hour, day, and empty scales", () => {
    expect(relativeLabel(now - 30 * 1000, now)).toBe("just now");
    expect(relativeLabel(now - 5 * 60000, now)).toBe("5m ago");
    expect(relativeLabel(now - 3 * 3600000, now)).toBe("3h ago");
    expect(relativeLabel(now - 2 * 86400000, now)).toBe("2d ago");
    expect(relativeLabel(undefined, now)).toBe("no activity");
  });
});

describe("sortProjects", () => {
  test("recent puts newest first and unknowns last", () => {
    const list = [
      makeProject({ id: "old", _lastActiveMs: 100 }),
      makeProject({ id: "none" }),
      makeProject({ id: "new", _lastActiveMs: 200 }),
    ];
    sortProjects(list, "recent");
    expect(list.map((p) => p.id)).toEqual(["new", "old", "none"]);
  });

  test("unknown mode falls back to recent", () => {
    const list = [
      makeProject({ id: "old", _lastActiveMs: 100 }),
      makeProject({ id: "new", _lastActiveMs: 200 }),
    ];
    sortProjects(list, "bogus");
    expect(list.map((p) => p.id)).toEqual(["new", "old"]);
  });

  test("name sorts alphabetically", () => {
    const list = [makeProject({ name: "Zulu" }), makeProject({ name: "Alpha" })];
    sortProjects(list, "name");
    expect(list.map((p) => p.name)).toEqual(["Alpha", "Zulu"]);
  });

  test("status ranks active first", () => {
    const list = [
      makeProject({ id: "a", status: "paused", _lastActiveMs: 300 }),
      makeProject({ id: "b", status: "active", _lastActiveMs: 100 }),
    ];
    sortProjects(list, "status");
    expect(list.map((p) => p.id)).toEqual(["b", "a"]);
  });
});

describe("annotateRecency", () => {
  test("falls back to index date fields without a sessions dir", () => {
    const root = mkdtempSync(join(tmpdir(), "recency-"));
    roots.push(root);
    const projects = [makeProject({ id: "p", last_session: "2026-09-19" })];
    annotateRecency(projects, [{ name: "test", root, projects_dir: "." }]);
    expect(projects[0]._lastActiveMs).toBe(Date.parse("2026-09-19"));
  });
});

describe("resumePrompt", () => {
  test("renders the R1 prompt as one sentence, never a path", () => {
    const prompt = resumePrompt(
      { id: "demo", _source: "kb", _workspace: "rajiv" },
      true
    );
    expect(prompt).toBe(
      "Use the skill synthesis-project-resume to resume the synthesis " +
        "project with id demo in the synthesis project management workspace rajiv."
    );
  });

  test("warns instead of naming a path when the skill is missing", () => {
    const prompt = resumePrompt(
      { id: "demo", _source: "kb", _workspace: "rajiv" },
      false
    );
    expect(prompt).toContain("Use the skill synthesis-project-resume");
    expect(prompt).toContain("not installed");
    expect(prompt).not.toContain("/");
  });

  test("falls back to the source key when no workspace was annotated", () => {
    const prompt = resumePrompt({ id: "demo", _source: "kb" }, true);
    expect(prompt).toContain("workspace kb.");
  });
});
