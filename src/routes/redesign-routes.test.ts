import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ConsoleConfig, Source } from "../config.js";
import { todayRoutes } from "./today.js";
import { paletteRoutes } from "./palette.js";
import { planRoutes } from "./plans.js";
import { lessonRoutes } from "./lessons.js";
import { recordDecision } from "../parsers/plan-mutations.js";
import { todayIso } from "../views/ui.js";

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const PLAN = `# Plan

**Status:** Morning sync done.
**Mode:** Cockpit

## 🚨 Decisions needed

### 1. Ship Tuesday or Wednesday?

**Option A:** Tuesday.
**Option B:** Wednesday.

Recommendation: **A** — sooner.

## Tasks

### Do today — not negotiable

1. **Write it** — today.
2. ~~**Review it**~~ ✅ **DONE 09:10 EDT** — done.
`;

function source(base: string, name: string, opts: { demo?: boolean; plans?: Record<string, string>; projects?: string[] } = {}): Source {
  const root = join(base, name);
  mkdirSync(join(root, "projects"), { recursive: true });
  mkdirSync(join(root, "lessons"), { recursive: true });
  mkdirSync(join(root, "daily-plans"), { recursive: true });
  const projects = opts.projects ?? [`${name}-project`];
  writeFileSync(
    join(root, "projects", "index.yaml"),
    `projects:\n${projects.map((id) => `  - id: ${id}\n    name: ${id} name\n    status: active\n    description: about ${id}\n    tags: [alpha]\n`).join("")}`
  );
  writeFileSync(join(root, "lessons", `2026-01-02-${name}-lesson.md`), `# ${name} lesson\n`);
  for (const [date, body] of Object.entries(opts.plans ?? {})) writeFileSync(join(root, "daily-plans", `${date}.md`), body);
  return { name, root, projects_dir: "projects", lessons_dir: "lessons", plans_dir: "daily-plans", demo: opts.demo };
}

function fixture(active: string[] = ["personal"], demoMode = false) {
  const base = mkdtempSync(join(tmpdir(), "console-redesign-"));
  roots.push(base);
  const sources = [
    source(base, "personal", { plans: { [todayIso()]: PLAN, "2026-01-05": PLAN } }),
    source(base, "client", { projects: ["secret-client-work"] }),
    source(base, "demo", { demo: true, plans: { "2026-07-06": PLAN } }),
  ].map((s) => ({ ...s, default_active: active.includes(s.name) }));
  const config: ConsoleConfig = { sources: demoMode ? sources.filter((s) => s.demo) : sources, port: 0, demoMode };
  return { base, config, sources };
}

const local = { headers: { host: "127.0.0.1:5555" } };

describe("Today", () => {
  test("shows today's plan with the counts the plan page uses", async () => {
    const f = fixture();
    const html = await (await todayRoutes(f.config, join(f.base, "no-runs")).request("http://127.0.0.1:5555/", local)).text();
    expect(html).toContain("Today's plan");
    expect(html).toContain(`/plans/personal/${todayIso()}`);
    expect(html).toContain("personal-project name");
    expect(html).not.toContain("secret-client-work");
    expect(html).toContain('data-status-for="sync"');
  });

  test("falls back to the latest plan, labeled, when today's is not written", async () => {
    const f = fixture(["demo"]);
    const html = await (await todayRoutes(f.config, join(f.base, "no-runs")).request("http://127.0.0.1:5555/", local)).text();
    expect(html).toContain("Latest plan");
    expect(html).toContain("today's plan is not written yet");
    expect(html).toContain("/plans/demo/2026-07-06");
  });

  test("demo mode reads no machine state", async () => {
    const f = fixture(["demo"], true);
    const html = await (await todayRoutes(f.config, join(f.base, "no-runs")).request("http://127.0.0.1:5555/", local)).text();
    expect(html).not.toContain("data-status-for");
    expect(html).not.toContain("today-conversations");
    expect(html).toContain("Demo mode reads no machine state");
  });
});

describe("command palette data", () => {
  test("covers only the active sources", async () => {
    const f = fixture();
    const body = await (await paletteRoutes(f.config).request("http://127.0.0.1:5555/api/palette")).json();
    expect(body.ok).toBe(true);
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(["personal-project"]);
    expect(body.lessons.map((l: { title: string }) => l.title)).toEqual(["Personal Lesson"]);
    expect(body.todayPlan.href).toBe(`/plans/personal/${todayIso()}`);
    expect(JSON.stringify(body)).not.toContain("secret-client-work");
  });

  test("refuses a request that did not come to the loopback host", async () => {
    const f = fixture();
    const res = await paletteRoutes(f.config).request("http://127.0.0.1:5555/api/palette", { headers: { host: "attacker.example:5555" } });
    expect(res.status).toBe(421);
    expect(JSON.stringify(await res.json())).not.toContain("personal-project");
  });

  test("follows the request's source selection and the demo boundary", async () => {
    const f = fixture();
    const client = await (await paletteRoutes(f.config).request("http://127.0.0.1:5555/api/palette?sources=client")).json();
    expect(client.projects.map((p: { id: string }) => p.id)).toEqual(["secret-client-work"]);
    const demo = fixture(["demo"], true);
    const body = await (await paletteRoutes(demo.config).request("http://127.0.0.1:5555/api/palette?sources=personal")).json();
    expect(body.projects.map((p: { id: string }) => p.id)).toEqual(["demo-project"]);
  });
});

describe("plan page", () => {
  test("a recorded decision can be reopened, and demo data stays read-only", async () => {
    const f = fixture();
    const file = join(f.base, "personal", "daily-plans", "2026-01-05.md");
    const recorded = recordDecision(readFileSync(file, "utf8"), 0, "B", "2026-01-05 10:00 UTC");
    if (!recorded.ok) throw new Error("record failed");
    writeFileSync(file, recorded.newRaw);
    const app = planRoutes(f.config);
    const page = await (await app.request("http://127.0.0.1:5555/plans/personal/2026-01-05")).text();
    expect(page).toContain('class="cockpit-decision-undo');
    expect(page).toContain("Status:</strong> Morning sync done.<br>");

    const stale = await app.request("http://127.0.0.1:5555/plans/personal/2026-01-05/decision/0/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ option: "A" }),
    });
    expect(stale.status).toBe(409);
    const undo = await app.request("http://127.0.0.1:5555/plans/personal/2026-01-05/decision/0/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ option: "B" }),
    });
    expect(await undo.json()).toEqual({ ok: true });
    expect(readFileSync(file, "utf8")).not.toContain("**Decided:**");

    const demo = await app.request("http://127.0.0.1:5555/plans/demo/2026-07-06/decision/0/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ option: "B" }),
    });
    expect(demo.status).toBe(403);
  });

  test("the calendar opens on a requested month and steps between months with plans", async () => {
    const f = fixture();
    const html = await (await planRoutes(f.config).request("http://127.0.0.1:5555/plans?month=2026-01")).text();
    expect(html).toContain("January 2026");
    expect(html).toContain('href="/plans/personal/2026-01-05"');
  });
});

describe("lessons", () => {
  test("?q= opens the list already filtered", async () => {
    const f = fixture(["personal", "client"]);
    const html = await (await lessonRoutes(f.config).request("http://127.0.0.1:5555/lessons?q=client")).text();
    expect(html).toContain("Client Lesson");
    expect(html).not.toContain("Personal Lesson");
    expect(html).toContain("1 of 2 lessons");
  });
});
