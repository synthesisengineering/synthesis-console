import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  doctorLauncher,
  doctorStatus,
  parseDoctorReport,
  runDoctor,
  sortChecks,
  summarizeChecks,
  type DoctorStatus,
} from "./doctor.js";
import { CachedRun } from "./cached-run.js";
import { conformanceRoutes } from "./routes/conformance.js";
import { conformanceView } from "./views/conformance.js";
import type { ConsoleConfig } from "./config.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const REPORT = {
  healthy: true,
  ms: 2216,
  checks: [
    { status: "ok", name: "runtime", detail: "current -> release (abc)" },
    { status: "warn", name: "hook self-test", detail: "denied in 54 ms, over the 50 ms budget" },
    { status: "info", name: "latest", detail: "not checked" },
  ],
};

/** A fake `synthesis` command: prints `stdout`, then exits with `code`. */
function fakeLauncher(stdout: string, code: number, extra = ""): string {
  const root = mkdtempSync(join(tmpdir(), "console-doctor-"));
  roots.push(root);
  const launcher = join(root, "synthesis");
  const payload = join(root, "stdout.txt");
  writeFileSync(payload, stdout);
  writeFileSync(
    launcher,
    `#!/bin/sh\n[ "$1 $2" = "doctor --json" ] || { echo "unexpected arguments: $*" >&2; exit 9; }\n${extra}cat '${payload}'\nexit ${code}\n`
  );
  chmodSync(launcher, 0o755);
  return launcher;
}

describe("synthesis doctor runner", () => {
  test("the launcher is $SYNTHESIS_HOME/bin/synthesis, defaulting to ~/.synthesis/v5", () => {
    expect(doctorLauncher({}, "/home/someone")).toBe("/home/someone/.synthesis/v5/bin/synthesis");
    expect(doctorLauncher({ SYNTHESIS_HOME: "/elsewhere" }, "/home/someone")).toBe("/elsewhere/bin/synthesis");
  });

  test("a healthy run returns every check with its status and detail", async () => {
    const run = await runDoctor({ launcher: fakeLauncher(JSON.stringify(REPORT), 0) });
    expect(run.installed).toBe(true);
    expect(run.error).toBeNull();
    expect(run.report).toEqual(REPORT);
    expect(run.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("an unhealthy run (exit 1) is a result, not an error", async () => {
    const report = { ...REPORT, healthy: false, checks: [...REPORT.checks, { status: "fail", name: "codex hooks", detail: "not wired" }] };
    const run = await runDoctor({ launcher: fakeLauncher(JSON.stringify(report), 1) });
    expect(run.error).toBeNull();
    expect(run.report?.healthy).toBe(false);
    expect(summarizeChecks(run.report!.checks)).toEqual({ fail: 1, warn: 1, info: 1, ok: 1 });
  });

  test("a missing launcher reports synthesis v5 as not installed without running anything", async () => {
    const run = await runDoctor({ launcher: "/nonexistent/synthesis-v5/bin/synthesis" });
    expect(run.installed).toBe(false);
    expect(run.report).toBeNull();
  });

  test("output that is not the doctor's JSON is an error", async () => {
    const run = await runDoctor({ launcher: fakeLauncher("synthesis doctor: healthy", 0) });
    expect(run.report).toBeNull();
    expect(run.error).toContain("did not print JSON");
  });

  test("an exit status that disagrees with the report is flagged", async () => {
    const run = await runDoctor({ launcher: fakeLauncher(JSON.stringify(REPORT), 1) });
    expect(run.report).not.toBeNull();
    expect(run.error).toContain("inconsistent");
  });

  test("any other exit status is an error carrying stderr", async () => {
    const run = await runDoctor({ launcher: fakeLauncher("", 2, "echo 'config broken' >&2\n") });
    expect(run.report).toBeNull();
    expect(run.error).toContain("exited with status 2");
    expect(run.error).toContain("config broken");
  });

  test("a doctor that hangs is stopped at the timeout", async () => {
    const run = await runDoctor({ launcher: fakeLauncher("{}", 0, "sleep 5\n"), timeoutMs: 300 });
    expect(run.report).toBeNull();
    expect(run.error).toContain("did not finish within");
  });

  test("the report is validated field by field", () => {
    expect(() => parseDoctorReport(JSON.stringify({ healthy: "yes", ms: 1, checks: [] }))).toThrow();
    expect(() => parseDoctorReport(JSON.stringify({ healthy: true, ms: 1 }))).toThrow();
    expect(() => parseDoctorReport(JSON.stringify({ healthy: true, ms: 1, checks: [{ status: "ok", name: "x" }] }))).toThrow();
    expect(parseDoctorReport(JSON.stringify({ healthy: true, ms: 1, checks: [] }))).toEqual({ healthy: true, ms: 1, checks: [] });
  });

  test("checks sort failures first, as the doctor prints them", () => {
    const sorted = sortChecks([
      { status: "ok", name: "a", detail: "" },
      { status: "fail", name: "b", detail: "" },
      { status: "info", name: "c", detail: "" },
      { status: "warn", name: "d", detail: "" },
    ]);
    expect(sorted.map((check) => check.name)).toEqual(["b", "d", "c", "a"]);
  });
});

describe("kept result", () => {
  test("callers share one run while it lasts, then a new one starts", async () => {
    let now = 1_000;
    let runs = 0;
    let release!: () => void;
    const cache = new CachedRun(
      () => new Promise<number>((resolve) => { runs++; release = () => resolve(runs); }),
      60_000,
      () => now
    );
    const first = cache.get();
    const second = cache.get();
    expect(cache.running).toBe(true);
    release();
    expect((await first).result).toBe(1);
    expect((await second).result).toBe(1);
    now += 59_000;
    expect((await cache.get()).result).toBe(1);
    now += 2_000;
    const third = cache.get();
    release();
    expect((await third).result).toBe(2);
    const forced = cache.get(true);
    release();
    expect((await forced).result).toBe(3);
    expect(runs).toBe(3);
  });
});

function status(overrides: Partial<DoctorStatus> = {}): DoctorStatus {
  return {
    ...doctorStatus({ result: { launcher: "/x/bin/synthesis", installed: true, report: REPORT, error: null, elapsedMs: 2300 }, at: Date.now() - 5_000 }),
    ...overrides,
  };
}

describe("conformance view", () => {
  test("shows the verdict, timing and every check with status and detail", () => {
    const html = conformanceView(status());
    expect(html).toContain("Healthy");
    expect(html).toContain("2216 ms");
    expect(html).toContain("2300 ms including start-up");
    expect(html).toContain("hook self-test");
    expect(html).toContain("over the 50 ms budget");
    expect(html.indexOf("hook self-test")).toBeLessThan(html.indexOf("runtime"));
    expect(html).toContain('id="doctor-run-btn"');
  });

  test("names the missing runtime when v5 is not installed", () => {
    const html = conformanceView(status({ installed: false, report: null }));
    expect(html).toContain("not installed");
    expect(html).toContain("/x/bin/synthesis");
    expect(html).not.toContain("doctor-run-btn");
  });

  test("shows the reason when the doctor produced no report", () => {
    const html = conformanceView(status({ report: null, error: "synthesis doctor did not finish within 30 s and was stopped." }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("did not finish within 30 s");
    expect(html).toContain('id="doctor-run-btn"');
  });

  test("escapes doctor output", () => {
    const html = conformanceView(status({ report: { healthy: false, ms: 1, checks: [{ status: "fail", name: "<b>x</b>", detail: "<script>" }] } }));
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("<script>\n<");
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Not healthy");
  });
});

describe("conformance routes", () => {
  const config: ConsoleConfig = {
    sources: [{ name: "one", root: "/synthetic/one", projects_dir: "projects" }],
    port: 0,
    demoMode: false,
  };

  test("the page and the status API read the same doctor result; refresh forces a run", async () => {
    const calls: boolean[] = [];
    const app = conformanceRoutes(config, async (force = false) => {
      calls.push(force);
      return status({ report: { ...REPORT, healthy: false, checks: [...REPORT.checks, { status: "fail", name: "claude hooks", detail: "not wired" }] } });
    });
    const page = await app.request("/conformance");
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("claude hooks");
    const api = await (await app.request("/api/conformance-status")).json();
    expect(api).toMatchObject({ ok: true, installed: true, healthy: false, failures: 1, warnings: 1, doctorMs: 2216 });
    expect(api.checks).toHaveLength(4);
    const refresh = await (await app.request("/api/conformance/refresh", { method: "POST" })).json();
    expect(refresh.ok).toBe(true);
    expect(calls).toEqual([false, false, true]);
  });
});
