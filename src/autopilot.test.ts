import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Plan,
  attribute,
  autopilotOverview,
  autopilotStateDir,
  onePerPlan,
  readRun,
  readRuns,
  runGroup,
  visibleLines,
} from "./autopilot.js";
import { autopilotRoutes } from "./routes/autopilot.js";
import type { ConsoleConfig, Source } from "./config.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const PLAN = `# Autopilot plan: Ship the importer

**Status:** waiting — CI on the release branch
Owner session: session-a
Harness: claude-code
Engaged: 2026-10-06T09:00-04:00
Horizon: overnight until 2026-10-07 09:00
Continuation: scheduled wake job 42
First wake: <not yet>
Backstop: none (fixture)
Waiting on: CI run, due 10:30
<!-- Status: done  (a comment never counts) -->

## Mission
Ship it.

## Checklist (in order)
- [x] 1. Write the parser — tests pass
- [ ] 2. Wire the route
* [ ] 3. Document it
\`\`\`markdown
- [ ] an example inside a fence never counts
\`\`\`

## Completion criteria
- [ ] Importer handles the sample file

## Standing checklist
- [x] end-to-end: Complete the work end to end — evidence
- [ ] lessons-filed: Durable lessons filed as work proceeds

## Blockers
- [ ] Needs a token only the principal has — probe: env -> missing — alerted 09:30 (no reply)
- [x] Disk full — cleared

## Questions for the principal
- [ ] Which date format should the export use?
- [x] Ship on Friday? — yes, 2026-10-05
- A plain list item is also a question

## Cycle ledger
- 2026-10-06T09:00 engaged
- 2026-10-06T09:40 waiting on CI
`;

describe("plan reader", () => {
  test("reads header lines, sections and items as synthesis/autopilot.py does", () => {
    const plan = new Plan("/k/projects/p/resources/artifacts/2026-10-06-importer-autopilot-plan.md", PLAN);
    expect(plan.title).toBe("Ship the importer");
    expect(plan.status).toBe("waiting");
    expect(plan.statusReason).toBe("CI on the release branch");
    expect(plan.field("owner session")).toBe("session-a");
    expect(plan.field("first wake")).toBe("");
    expect(plan.field("waiting on")).toBe("CI run, due 10:30");
    expect(plan.longHorizon).toBe(true);
    expect(Object.keys(plan.sections)).toEqual([
      "mission", "checklist", "completion criteria", "standing checklist", "blockers",
      "questions for the principal", "cycle ledger",
    ]);
    expect(plan.items("checklist")).toEqual([
      { done: true, text: "1. Write the parser — tests pass" },
      { done: false, text: "2. Wire the route" },
      { done: false, text: "3. Document it" },
    ]);
    expect(plan.openItems("blockers")).toEqual([
      "Needs a token only the principal has — probe: env -> missing — alerted 09:30 (no reply)",
    ]);
    // Python's splitlines(): the file's final line break adds no empty line.
    expect(plan.sections["cycle ledger"]).toEqual(["- 2026-10-06T09:00 engaged", "- 2026-10-06T09:40 waiting on CI"]);
    expect(plan.sections.mission).toEqual(["Ship it.", ""]);
    expect(plan.questions()).toEqual([
      "Which date format should the export use?",
      "A plain list item is also a question",
    ]);
  });

  test("normalizes canceled, keeps the first value of a repeated line, treats placeholders as empty", () => {
    const plan = new Plan("/x/plan.md", "# Untitled\nStatus: Canceled: scope moved\nStatus: running\nOwner session: <filled by engage>\nHorizon: sitting\n");
    expect(plan.status).toBe("cancelled");
    expect(plan.statusReason).toBe("scope moved");
    expect(plan.field("owner session")).toBe("");
    expect(plan.longHorizon).toBe(false);
    expect(new Plan("/x/my-plan.md", "no heading\n").title).toBe("my-plan");
  });

  test("comments and fences are invisible, including multi-line comments", () => {
    expect(visibleLines("a\n<!--\nStatus: done\n-->\nb\n~~~\nc\n~~~\nd")).toEqual(["a", "", "b", "d"]);
  });
});

interface Fixture {
  base: string;
  stateDir: string;
  sources: Source[];
  plan(source: string, project: string, name: string, text: string): string;
  pointer(session: string, value: unknown): void;
}

function fixture(): Fixture {
  const base = mkdtempSync(join(tmpdir(), "console-autopilot-"));
  roots.push(base);
  const stateDir = join(base, "synthesis-home", "state", "autopilot");
  const sources: Source[] = ["personal", "client"].map((name) => ({
    name, display_name: name === "personal" ? "Personal" : "Client", root: join(base, name), projects_dir: "projects",
  }));
  return {
    base,
    stateDir,
    sources,
    plan(source, project, name, text) {
      const dir = source === "elsewhere" ? join(base, "elsewhere", project) : join(base, source, "projects", project, "resources", "artifacts");
      mkdirSync(dir, { recursive: true });
      const path = join(dir, name);
      writeFileSync(path, text);
      return path;
    },
    pointer(session, value) {
      mkdirSync(stateDir, { recursive: true });
      writeFileSync(join(stateDir, session + ".json"), typeof value === "string" ? value : JSON.stringify(value));
    },
  };
}

describe("run records", () => {
  test("the state folder is $SYNTHESIS_HOME/state/autopilot", () => {
    expect(autopilotStateDir({ SYNTHESIS_HOME: "/v5" })).toBe("/v5/state/autopilot");
  });

  test("no folder yet means no runs", () => {
    expect(readRuns("/nonexistent/state/autopilot")).toEqual([]);
  });

  test("each pointer is read with its plan; broken records carry a reason", () => {
    const f = fixture();
    const plan = f.plan("personal", "importer", "plan.md", PLAN);
    f.pointer("session-a", { plan, streak: 2, digest: "", at: 1_780_000_000 });
    f.pointer("gone", { plan: join(f.base, "missing.md"), streak: 0, at: 1 });
    f.pointer("relative", { plan: "plan.md" });
    f.pointer("garbled", "{not json");
    f.pointer("noplan", { streak: 0 });
    const runs = readRuns(f.stateDir);
    expect(runs).toHaveLength(5);
    const run = runs.find((r) => r.session === "session-a")!;
    expect(run.error).toBeNull();
    expect(run).toMatchObject({
      title: "Ship the importer", status: "waiting", owner: "session-a", ownedByPointer: true, streak: 2,
      nextItem: "2. Wire the route", longHorizon: true,
      openBlockers: ["Needs a token only the principal has — probe: env -> missing — alerted 09:30 (no reply)"],
    });
    expect(run.pointerAt).toBe(new Date(1_780_000_000_000).toISOString());
    expect(run.fields["waiting on"]).toBe("CI run, due 10:30");
    expect(run.fields["first wake"]).toBeUndefined();
    expect(run.criteria).toEqual([{ done: false, text: "Importer handles the sample file" }]);
    expect(run.standing.filter((item) => !item.done)).toHaveLength(1);
    expect(run.cycleLedger).toEqual(["- 2026-10-06T09:00 engaged", "- 2026-10-06T09:40 waiting on CI"]);
    expect(runGroup(run)).toBe("open");
    const errors = Object.fromEntries(runs.filter((r) => r.error).map((r) => [r.session, r.error]));
    expect(errors.gone).toBe("The plan file no longer exists.");
    expect(errors.relative).toContain("not absolute");
    expect(errors.garbled).toContain("could not be read");
    expect(errors.noplan).toContain("names no plan");
  });

  test("a takeover shows one run, owned by the new session", () => {
    const f = fixture();
    const plan = f.plan("personal", "importer", "plan.md", PLAN.replace("Owner session: session-a", "Owner session: session-b"));
    f.pointer("session-a", { plan, at: 100 });
    f.pointer("session-b", { plan, at: 200 });
    const runs = onePerPlan(readRuns(f.stateDir));
    expect(runs).toHaveLength(1);
    expect(runs[0].session).toBe("session-b");
    expect(runs[0].otherSessions).toEqual(["session-a"]);
  });

  test("runs are attributed to the source and project folder that hold the plan", () => {
    const f = fixture();
    const plan = f.plan("client", "migration", "plan.md", PLAN);
    expect(attribute(plan, f.sources)).toEqual({ source: "client", project: "migration" });
    expect(attribute(f.plan("elsewhere", "x", "plan.md", PLAN), f.sources)).toBeNull();
  });

  test("the source picker bounds what is shown; runs outside every source need a real source", () => {
    const f = fixture();
    f.pointer("one", { plan: f.plan("personal", "a", "plan.md", PLAN), at: 3 });
    f.pointer("two", { plan: f.plan("client", "b", "plan.md", PLAN), at: 2 });
    f.pointer("three", { plan: f.plan("elsewhere", "c", "plan.md", PLAN), at: 1 });
    const personal = autopilotOverview(f.stateDir, f.sources, [f.sources[0]]);
    expect(personal.runs.map((r) => r.session)).toEqual(["one", "three"]);
    expect(personal.hiddenRuns).toBe(1);
    const demo: Source = { name: "demo", root: join(f.base, "demo"), projects_dir: "projects", demo: true };
    const demoOnly = autopilotOverview(f.stateDir, [...f.sources, demo], [demo]);
    expect(demoOnly.runs).toEqual([]);
    expect(demoOnly.hiddenRuns).toBe(3);
  });
});

describe("autopilot pages", () => {
  function app(f: Fixture, demoMode = false, active = ["personal"]) {
    const config: ConsoleConfig = {
      sources: f.sources.map((s) => ({ ...s, default_active: active.includes(s.name) })),
      port: 0,
      demoMode,
    };
    return autopilotRoutes(config, f.stateDir);
  }
  const local = { headers: { host: "127.0.0.1:5555" } };

  test("an empty state names where v5 keeps the records", async () => {
    const f = fixture();
    const html = await (await app(f).request("http://127.0.0.1:5555/autopilot", local)).text();
    expect(html).toContain("No runs");
    expect(html).toContain(f.stateDir);
    expect(html).toContain("not created yet");
    const api = await (await app(f).request("http://127.0.0.1:5555/api/autopilot", local)).json();
    expect(api).toMatchObject({ ok: true, stateExists: false, runs: [], hiddenRuns: 0 });
  });

  test("the list leads with open runs and their questions; the detail shows the plan", async () => {
    const f = fixture();
    f.pointer("session-a", { plan: f.plan("personal", "importer", "plan.md", PLAN), streak: 2, at: 2 });
    f.pointer("closed", { plan: f.plan("personal", "old", "plan.md", "# Autopilot plan: Old work\nStatus: done\n## Checklist\n- [x] all\n"), at: 1 });
    const routes = app(f);
    const html = await (await routes.request("http://127.0.0.1:5555/autopilot", local)).text();
    expect(html).toContain("1 open · 1 closed");
    expect(html).toContain("2 question(s) for you");
    expect(html).toContain("Which date format should the export use?");
    expect(html).toContain('href="/autopilot/run/session-a"');
    expect(html).toContain('href="/projects/personal/importer"');
    expect(html.indexOf("Ship the importer")).toBeLessThan(html.indexOf("Old work"));
    const detail = await routes.request("http://127.0.0.1:5555/autopilot/run/session-a", local);
    expect(detail.status).toBe(200);
    const page = await detail.text();
    expect(page).toContain("Wire the route");
    expect(page).toContain("CI run, due 10:30");
    expect(page).toContain("2 continuation request(s) in a row");
    expect(page).toContain("The plan file");
    const api = await (await routes.request("http://127.0.0.1:5555/api/autopilot", local)).json();
    expect(api.runs).toHaveLength(2);
    expect(api.runs[0].text).toBeUndefined();
    const one = await (await routes.request("http://127.0.0.1:5555/api/autopilot/run/session-a", local)).json();
    expect(one.run.text).toContain("# Autopilot plan");
  });

  test("details outside the selection, unknown sessions and unsafe names are not found", async () => {
    const f = fixture();
    f.pointer("client-run", { plan: f.plan("client", "b", "plan.md", PLAN), at: 1 });
    const routes = app(f);
    for (const path of ["/autopilot/run/client-run", "/autopilot/run/nobody", "/autopilot/run/..", "/api/autopilot/run/client-run"]) {
      expect((await routes.request("http://127.0.0.1:5555" + path, local)).status).toBe(404);
    }
    expect((await routes.request("http://127.0.0.1:5555/autopilot/run/client-run?sources=client", local)).status).toBe(200);
  });

  test("demo mode reads no machine state", async () => {
    const f = fixture();
    f.pointer("session-a", { plan: f.plan("personal", "importer", "plan.md", PLAN), at: 1 });
    const routes = app(f, true);
    const html = await (await routes.request("http://127.0.0.1:5555/autopilot", local)).text();
    expect(html).toContain("Demo mode reads no machine state");
    expect(html).not.toContain("Ship the importer");
    expect((await routes.request("http://127.0.0.1:5555/autopilot/run/session-a", local)).status).toBe(404);
  });

  test("reads need a loopback host and a same-origin caller", async () => {
    const f = fixture();
    const routes = app(f);
    expect((await routes.request("http://127.0.0.1:5555/autopilot", { headers: { host: "attacker.example" } })).status).toBe(421);
    expect((await routes.request("http://127.0.0.1:5555/api/autopilot", { headers: { host: "127.0.0.1:5555", origin: "http://attacker.example" } })).status).toBe(403);
    const ok = await routes.request("http://127.0.0.1:5555/api/autopilot", local);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });
});

test("a missing plan record still renders", () => {
  const f = fixture();
  f.pointer("gone", { plan: join(f.base, "missing.md"), at: 1 });
  const run = readRun(f.stateDir, "gone");
  expect(runGroup(run)).toBe("unreadable");
});
