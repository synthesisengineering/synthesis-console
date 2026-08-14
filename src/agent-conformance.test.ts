import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ageSecondsAt,
  conformanceArgs,
  conformanceEvidencePaths,
  conformanceScript,
  freshConformanceReport,
  validateConformanceReport,
  type AgentConformanceStatus,
} from "./agent-conformance.js";
import { agentConformanceView } from "./views/agent-conformance.js";

const checkedAt = "2026-08-13T12:00:00.000Z";
const temporaryRoots: string[] = [];

afterEach(() => {
  delete process.env.SYNTHESIS_AGENT_CONFORMANCE_DIR;
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true });
});

function status(): AgentConformanceStatus {
  return {
    conformanceAvailable: true,
    report: {
      ok: true,
      status: "PASS",
      checked_at: checkedAt,
      checks: [
        {
          name: "source.schema",
          ok: true,
          detail: "source tree valid",
          required: true,
          plane: "source",
          status: "PASS",
        },
        {
          name: "surface.codex-ide",
          ok: null,
          detail: "not a supported plugin surface",
          required: false,
          plane: "capability",
          status: "UNSUPPORTED",
        },
      ],
    },
    ageSeconds: 60,
    stale: false,
    auditing: false,
    auditError: null,
    contextGeneratedAt: checkedAt,
    contextAgeSeconds: 60,
  };
}

describe("agent conformance evidence", () => {
  test("validates the complete checker schema", () => {
    const report = status().report;
    expect(validateConformanceReport(report)).toEqual(report);
    expect(validateConformanceReport({ ...report, checks: [{}] })).toBeNull();
    expect(validateConformanceReport({ status: "PASS" })).toBeNull();
    expect(validateConformanceReport({ ...report, ok: false })).toBeNull();
    expect(
      validateConformanceReport({
        ...report,
        checks: [{ ...report!.checks[0], status: "MAYBE" }],
      })
    ).toBeNull();
  });

  test("computes evidence age without treating future clocks as stale", () => {
    const now = Date.parse("2026-08-13T12:01:30.000Z");
    expect(ageSecondsAt(checkedAt, now)).toBe(90);
    expect(ageSecondsAt("2026-08-13T12:02:00.000Z", now)).toBe(0);
    expect(ageSecondsAt("not-a-date", now)).toBeNull();
  });

  test("passes every evidence path from the configured synthesis home", () => {
    const evidence = conformanceEvidencePaths("/tmp/synthesis-test");
    const args = conformanceArgs(
      "/plugin/conformance.py",
      { project: "/project", worktree: "/repo" },
      "/tmp/report.json",
      evidence,
      "/source"
    );
    for (const [flag, value] of [
      ["--active-project-file", evidence.activeProject],
      ["--public-codex-sessionstart-receipt", evidence.publicCodexReceipt],
      ["--public-claude-sessionstart-receipt", evidence.publicClaudeReceipt],
      ["--private-codex-sessionstart-receipt", evidence.privateCodexReceipt],
      ["--capability-evidence", evidence.capabilityEvidence],
      ["--coordination-board", evidence.coordinationBoard],
    ]) {
      const index = args.indexOf(flag);
      expect(index).toBeGreaterThan(-1);
      expect(args[index + 1]).toBe(value);
    }
  });

  test("rejects absent, malformed, unchanged, and stale audit reports", () => {
    const startedAt = Date.parse("2026-08-13T12:05:00.000Z");
    expect(freshConformanceReport(null, checkedAt, startedAt)).toBeNull();
    expect(freshConformanceReport({ status: "PASS" }, checkedAt, startedAt)).toBeNull();
    expect(freshConformanceReport(status().report, checkedAt, startedAt)).toBeNull();
    expect(freshConformanceReport(status().report, undefined, startedAt)).toBeNull();

    const fresh = {
      ...status().report!,
      checked_at: "2026-08-13T12:05:01.000Z",
    };
    expect(freshConformanceReport(fresh, checkedAt, startedAt)).toEqual(fresh);
  });

  test("re-resolves the checker after a plugin path changes", () => {
    const first = mkdtempSync(join(tmpdir(), "synthesis-console-one-"));
    const second = mkdtempSync(join(tmpdir(), "synthesis-console-two-"));
    temporaryRoots.push(first, second);
    for (const root of [first, second]) {
      const scripts = join(root, "scripts");
      mkdirSync(scripts);
      writeFileSync(join(scripts, "conformance.py"), "# test\n");
    }
    process.env.SYNTHESIS_AGENT_CONFORMANCE_DIR = first;
    expect(conformanceScript()).toBe(join(first, "scripts", "conformance.py"));
    process.env.SYNTHESIS_AGENT_CONFORMANCE_DIR = second;
    expect(conformanceScript()).toBe(join(second, "scripts", "conformance.py"));
  });

  test("renders planes and exact statuses without collapsing unsupported", () => {
    const html = agentConformanceView(status());
    expect(html).toContain("source (1)");
    expect(html).toContain("capability (1)");
    expect(html).toContain("UNSUPPORTED");
    expect(html).toContain("Source, installed, live, continuity, and capability planes");
  });

  test("escapes checker evidence", () => {
    const value = status();
    value.report!.checks[0].detail = '<script>alert("x")</script>';
    const html = agentConformanceView(value);
    expect(html).not.toContain('<script>alert("x")</script>');
    expect(html).toContain("&lt;script&gt;");
  });
});
