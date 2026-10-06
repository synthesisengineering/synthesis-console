import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRepoReport, RepoGuard, syncPaths, REFRESH_STALE_MS } from "./sync.js";
import { syncRoutes } from "./routes/sync.js";
import { syncView } from "./views/sync.js";
import type { ConsoleConfig } from "./config.js";
import { fakeRuntime, fakeSkillScript } from "./test-fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REPORT = {
  generated_at: "2026-10-06T12:00:00-0400",
  host: "fixture-host",
  total_repos: 3,
  dirty_count: 1,
  repos: [
    { name: "site", path: "/w/site", clean: false, issues: [
      { type: "uncommitted", detail: "12 uncommitted file(s)", files: Array.from({ length: 10 }, (_, i) => ` M f${i}.md`), total: 12 },
      { type: "unpushed", detail: "1 unpushed commit(s) on main", count: 1 },
    ] },
    { name: "tools", path: "/w/tools", clean: true, issues: [{ type: "detached", detail: "detached HEAD or no branch" }] },
    { name: "notes", path: "/w/notes", clean: true, issues: [] },
  ],
};

/** A stand-in for repo_sync_check.py: records its arguments and writes the report it is told to. */
const FAKE_SCAN = String.raw`
import json, os, sys
here = os.path.dirname(os.path.abspath(__file__))
with open(os.path.join(here, "calls.log"), "a") as log:
    log.write(" ".join(sys.argv[1:]) + "\n")
mode = open(os.path.join(here, "mode")).read().strip() if os.path.exists(os.path.join(here, "mode")) else "dirty"
if mode == "fail":
    sys.stderr.write("workspace not found\n")
    sys.exit(2)
report = json.load(open(os.path.join(here, "report.json")))
target = os.environ["FAKE_REPORT_PATH"]
os.makedirs(os.path.dirname(target), exist_ok=True)
json.dump(report, open(target, "w"))
sys.exit(1 if report["dirty_count"] else 0)
`;

function setup(installed = true) {
  const { home, search } = fakeRuntime(roots);
  const user = join(home, "..", "user-home");
  const paths = syncPaths(user);
  let script = "";
  if (installed) {
    script = fakeSkillScript(home, "synthesis-repo-guard", "repo_sync_check.py", FAKE_SCAN);
    writeFileSync(join(script, "..", "report.json"), JSON.stringify(REPORT));
  }
  let now = Date.parse("2026-10-06T16:01:00Z");
  const guard = new RepoGuard(paths, () => search, { ...process.env, FAKE_REPORT_PATH: paths.report }, () => now);
  const calls = () => {
    const log = join(script, "..", "calls.log");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  };
  return { guard, paths, script, calls, advance: (ms: number) => (now += ms) };
}

describe("repo guard", () => {
  test("paths are the v5 skill's fixed locations under ~/.synthesis", () => {
    expect(syncPaths("/home/u")).toEqual({
      report: "/home/u/.synthesis/repo-guard/last-report.json",
      quietFlag: "/home/u/.synthesis/quiet-audio",
    });
  });

  test("the report is validated", () => {
    expect(parseRepoReport(JSON.stringify(REPORT)).repos[0].issues[0].total).toBe(12);
    expect(() => parseRepoReport('{"generated_at": "x", "dirty')).toThrow("not complete JSON");
    expect(() => parseRepoReport(JSON.stringify({ ...REPORT, repos: [{ name: "x" }] }))).toThrow();
  });

  test("a missing report starts one read-only scan and the next read shows it", async () => {
    const { guard, calls, paths } = setup();
    const first = guard.status();
    expect(first.installed).toBe(true);
    expect(first.report).toBeNull();
    expect(first.refreshing).toBe(true);
    expect(guard.status().refreshing).toBe(true); // no second scan while one runs
    expect(await guard.refresh()).toBe(true); // joins the running scan
    expect(calls()).toEqual(["--quiet"]);
    const second = guard.status();
    expect(existsSync(paths.report)).toBe(true);
    expect(second.report?.host).toBe("fixture-host");
    expect(second.dirtyCount).toBe(1);
    expect(second.error).toBeNull();
  });

  test("a fresh report is not rescanned; a stale one is", async () => {
    const { guard, calls, advance } = setup();
    await guard.refresh();
    guard.status();
    expect(calls()).toHaveLength(1);
    advance(REFRESH_STALE_MS + 1000);
    expect(guard.status().refreshing).toBe(true);
    await guard.refresh();
    expect(calls()).toHaveLength(2);
  });

  test("a failed scan is shown with its reason", async () => {
    const { guard, script } = setup();
    writeFileSync(join(script, "..", "mode"), "fail");
    expect(await guard.refresh()).toBe(false);
    expect(guard.status().error).toContain("exited with status 2: workspace not found");
  });

  test("a half-written report reads as a problem, not a crash", () => {
    const { guard, paths } = setup();
    mkdirSync(join(paths.report, ".."), { recursive: true });
    writeFileSync(paths.report, '{"generated_at": "2026');
    expect(guard.status().error).toContain("not complete JSON");
  });

  test("the mute flag is a file the scan's alerts honor", () => {
    const { guard, paths } = setup();
    mkdirSync(join(paths.quietFlag, ".."), { recursive: true });
    expect(guard.setQuietAudio(true)).toBe(true);
    expect(readFileSync(paths.quietFlag, "utf8")).toContain("muted via synthesis-console");
    expect(guard.isQuietAudio()).toBe(true);
    expect(guard.setQuietAudio(false)).toBe(true);
    expect(guard.isQuietAudio()).toBe(false);
  });

  test("without the skill the page names every place searched", () => {
    const { guard } = setup(false);
    const status = guard.status();
    expect(status.installed).toBe(false);
    const html = syncView(status);
    expect(html).toContain("was not found");
    expect(html).toContain(status.searched[0]);
  });
});

describe("sync page and API", () => {
  test("show repositories needing attention, noted ones apart, and no commit control", async () => {
    const { guard } = setup();
    await guard.refresh();
    const config: ConsoleConfig = { sources: [{ name: "one", root: "/synthetic/one", projects_dir: "projects" }], port: 0, demoMode: false };
    const app = syncRoutes(config, guard);
    const html = await (await app.request("/sync")).text();
    expect(html).toContain("Needs attention (1)");
    expect(html).toContain("12 uncommitted file(s)");
    expect(html).toContain("… and 2 more");
    expect(html).toContain("Noted (1)");
    expect(html).toContain('id="sync-refresh"');
    expect(html).not.toContain("sync-now");
    expect(html).toContain("synthesis handoff");
    const api = await (await app.request("/api/sync-status")).json();
    expect(api).toMatchObject({ ok: true, installed: true, dirtyCount: 1, totalRepos: 3, error: null });
    expect((await app.request("/api/sync/checkpoint", { method: "POST" })).status).toBe(404);
    expect(await (await app.request("/api/sync/refresh", { method: "POST" })).json()).toEqual({ ok: true });
  });
});
