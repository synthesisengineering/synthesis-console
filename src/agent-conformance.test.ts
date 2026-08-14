import { describe, expect, test } from "bun:test";
import {
  ageSecondsAt,
  validateConformanceReport,
  type AgentConformanceStatus,
} from "./agent-conformance.js";
import { agentConformanceView } from "./views/agent-conformance.js";

const checkedAt = "2026-08-13T12:00:00.000Z";

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
