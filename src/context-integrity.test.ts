import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  auditRoot,
  contextReader,
  knowledgeRoot,
  parseContextReport,
  type ContextIntegrityStatus,
} from "./context-integrity.js";
import { contextIntegrityRoutes } from "./routes/context-integrity.js";
import { contextIntegrityView } from "./views/context-integrity.js";
import type { ConsoleConfig, Source } from "./config.js";
import { fakeRuntime, fakeSkillScript } from "./test-fixtures.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/**
 * A stand-in for context_doctor.py: answers by the --root's folder name, and
 * appends each root it audits to a log beside itself so tests can count runs.
 */
const FAKE_DOCTOR = String.raw`
import json, os, sys, time
args = sys.argv[1:]
assert args[0] == "--root" and args[2] == "--json", args
root = args[1]
with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "calls.log"), "a") as log:
    log.write(root + "\n")
name = os.path.basename(root)
def finding(project, check, severity):
    return {"project": project, "check": check, "severity": severity,
            "message": check + " message for " + project, "remedy": "fix " + project}
if name == "healthy":
    findings = [finding("alpha", "item-currency", "warning")]
    print(json.dumps({"ok": True, "exit": 0, "active": "", "projects_audited": 3, "defects": 0, "warnings": 1,
                      "coverage": {"freshness": {"examined": 2, "skipped": 1, "why": ["dormant"]}}, "findings": findings}))
    sys.exit(0)
if name == "defects":
    findings = [finding("beta", "context-budget", "defect"), finding("(defects)", "unpushed-context", "defect"),
                finding("gamma", "freshness-unverifiable", "warning")]
    print(json.dumps({"ok": False, "exit": 1, "active": "", "projects_audited": 5, "defects": 2, "warnings": 1,
                      "coverage": {}, "findings": findings}))
    sys.exit(1)
if name == "notgit":
    print(json.dumps({"ok": False, "exit": 2, "error": root + " is not inside a git repository"}))
    sys.exit(2)
if name == "garbled":
    print("not json")
    sys.exit(0)
if name == "slow":
    time.sleep(5)
sys.exit(3)
`;

function setup() {
  const { home, search } = fakeRuntime(roots);
  const script = fakeSkillScript(home, "synthesis-context-lifecycle", "context_doctor.py", FAKE_DOCTOR);
  const calls = () => {
    const log = join(script, "..", "calls.log");
    return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean) : [];
  };
  const source = (name: string, extra: Partial<Source> = {}): Source => {
    const root = join(home, "..", "workspaces", name);
    mkdirSync(join(root, "projects"), { recursive: true });
    return { name, root, projects_dir: "projects", ...extra };
  };
  return { home, search, script, calls, source };
}

describe("knowledge roots", () => {
  test("the doctor's root is the parent of a projects/ folder", () => {
    expect(knowledgeRoot({ name: "a", root: "/k/a", projects_dir: "projects" })).toEqual({ root: "/k/a" });
    expect(knowledgeRoot({ name: "a", root: "/k/a", projects_dir: "work/projects" })).toEqual({ root: "/k/a/work" });
    expect(knowledgeRoot({ name: "a", root: "~/k", projects_dir: "projects" }, "/home/x")).toEqual({ root: "/home/x/k" });
    expect("error" in knowledgeRoot({ name: "a", root: "/k/a", projects_dir: "notes" })).toBe(true);
  });
});

describe("report validation", () => {
  test("counts must match the findings", () => {
    const base = { ok: false, exit: 1, projects_audited: 1, defects: 1, warnings: 0, coverage: {},
      findings: [{ project: "p", check: "c", severity: "defect", message: "m", remedy: "r" }] };
    expect(parseContextReport(base).defects).toBe(1);
    expect(() => parseContextReport({ ...base, defects: 2 })).toThrow("do not match");
    expect(() => parseContextReport({ ...base, findings: [{ project: "p" }] })).toThrow();
    expect(() => parseContextReport({ ...base, coverage: { x: { examined: 1 } } })).toThrow();
    expect(() => parseContextReport(null)).toThrow();
  });
});

describe("one doctor run", () => {
  test("exit 0 and exit 1 are reports; exit 2 is the doctor's own reason", async () => {
    const { script } = setup();
    const healthy = await auditRoot("/k/healthy", { script });
    expect(healthy.error).toBeNull();
    expect(healthy.report).toMatchObject({ ok: true, projects_audited: 3, defects: 0, warnings: 1 });
    expect(healthy.report?.coverage.freshness).toEqual({ examined: 2, skipped: 1, why: ["dormant"] });
    const defects = await auditRoot("/k/defects", { script });
    expect(defects.error).toBeNull();
    expect(defects.report?.findings.map((f) => f.check)).toEqual(["context-budget", "unpushed-context", "freshness-unverifiable"]);
    const cannot = await auditRoot("/k/notgit", { script });
    expect(cannot.report).toBeNull();
    expect(cannot.error).toBe("The context doctor cannot tell: /k/notgit is not inside a git repository");
  });

  test("garbled output, unknown exits and hangs are errors", async () => {
    const { script } = setup();
    expect((await auditRoot("/k/garbled", { script })).error).toContain("did not print JSON");
    expect((await auditRoot("/k/other", { script })).error).toContain("exited with status 3");
    expect((await auditRoot("/k/slow", { script, timeoutMs: 300 })).error).toContain("did not finish within");
  });
});

describe("context reader", () => {
  test("audits each active project source, skips sample data and sources without projects", async () => {
    const { search, calls, source } = setup();
    const reader = contextReader({ search });
    const status = await reader.status([
      source("healthy", { display_name: "Personal" }),
      source("defects"),
      source("notgit"),
      { name: "demo", root: "/synthetic/demo", projects_dir: "projects", demo: true },
      { name: "notes-only", root: "/synthetic/notes", notes_dir: "notes" },
    ]);
    expect(status.doctorAvailable).toBe(true);
    expect(status.audits.map((a) => a.source)).toEqual(["healthy", "defects", "notgit"]);
    expect(status.skipped.map((s) => s.source)).toEqual(["demo", "notes-only"]);
    expect(status.totals).toEqual({ projects: 8, defects: 2, warnings: 2, failedSources: 1 });
    expect(status.audits[2].error).toContain("cannot tell");
    expect(status.audits[0].checkedAt).not.toBeNull();
    expect(calls()).toHaveLength(3);
  });

  test("results are kept per source; a forced read runs again", async () => {
    const { search, calls, source } = setup();
    const reader = contextReader({ search });
    const one = source("healthy");
    const two = source("defects");
    await reader.status([one]);
    await reader.status([one, two]);
    expect(calls()).toHaveLength(2);
    await reader.status([one, two], true);
    expect(calls()).toHaveLength(4);
  });

  test("a missing doctor names every place searched", async () => {
    const { search } = fakeRuntime(roots);
    const status = await contextReader({ search }).status([{ name: "a", root: "/synthetic/a", projects_dir: "projects" }]);
    expect(status.doctorAvailable).toBe(false);
    expect(status.searched[0]).toEndWith("/current/skills");
    const html = contextIntegrityView(status);
    expect(html).toContain("was not found");
    expect(html).toContain(status.searched[0]);
  });
});

describe("context page and API", () => {
  test("render each source's findings and the totals from the same read", async () => {
    const { search, source } = setup();
    const reader = contextReader({ search });
    const sources = [source("healthy", { display_name: "Personal", default_active: true }), source("defects", { default_active: true })];
    const config: ConsoleConfig = { sources, port: 0, demoMode: false };
    const forced: boolean[] = [];
    const app = contextIntegrityRoutes(config, (active, force = false) => {
      forced.push(force);
      return reader.status(active, force);
    });
    const html = await (await app.request("/context")).text();
    expect(html).toContain("Personal");
    expect(html).toContain("context-budget message for beta");
    expect(html).toContain("fix beta");
    expect(html).toContain("freshness: examined 2, skipped 1 (dormant)");
    expect(html).toContain("2 defect(s)");
    const api = await (await app.request("/api/context-status")).json();
    expect(api).toMatchObject({ ok: true, doctorAvailable: true, defects: 2, warnings: 2, projects: 8, failedSources: 0 });
    expect(api.sources.map((s: { source: string }) => s.source)).toEqual(["healthy", "defects"]);
    const only = await (await app.request("/api/context-status?sources=healthy")).json();
    expect(only.defects).toBe(0);
    const refresh = await (await app.request("/api/context/refresh", { method: "POST" })).json();
    expect(refresh.ok).toBe(true);
    expect(forced).toEqual([false, false, false, true]);
  });

  test("an empty selection says there is nothing to audit", () => {
    const status: ContextIntegrityStatus = {
      doctorAvailable: true, script: "/x/context_doctor.py", searched: [], audits: [],
      skipped: [{ source: "demo", displayName: "Demo", reason: "sample data is not audited" }],
      totals: { projects: 0, defects: 0, warnings: 0, failedSources: 0 },
    };
    const html = contextIntegrityView(status);
    expect(html).toContain("No active source has projects to audit");
    expect(html).toContain("Demo (sample data is not audited)");
    expect(html).not.toContain('id="ctx-run-btn"');
  });
});
