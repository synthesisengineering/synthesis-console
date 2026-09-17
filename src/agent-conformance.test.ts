import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  ageSecondsAt,
  conformanceArgs,
  conformanceEvidencePaths,
  conformanceInvocation,
  conformanceReportMatchesProfile,
  conformanceScript,
  conformanceSourceRoot,
  freshConformanceReport,
  validateConformanceReport,
  type AgentConformanceStatus,
} from "./agent-conformance.js";
import { synthesisPythonBin } from "./python-runtime.js";
import { agentConformanceView } from "./views/agent-conformance.js";

const checkedAt = "2026-08-13T12:00:00.000Z";
const temporaryRoots: string[] = [];
const originalDataHome = process.env.XDG_DATA_HOME;
const originalBootstrapPython = process.env.SYNTHESIS_BOOTSTRAP_PYTHON;
function preparedPython(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-conformance-python-")));
  temporaryRoots.push(root);
  process.env.XDG_DATA_HOME = root;
  delete process.env.SYNTHESIS_PYTHON_BIN;
  process.env.SYNTHESIS_BOOTSTRAP_PYTHON = execFileSync("python3", ["-I", "-B", "-c", "import sys; print(sys.executable)"], {encoding: "utf8"}).trim();
  return execFileSync("bash", [resolve(import.meta.dir, "../scripts/python-runtime.sh"), "setup"], {env: process.env, encoding: "utf8"}).trim();
}

afterEach(() => {
  delete process.env.SYNTHESIS_AGENT_CONFORMANCE_DIR;
  delete process.env.SYNTHESIS_CONFORMANCE_SOURCE_ROOT;
  delete process.env.SYNTHESIS_PRIVATE_CONTROL_PLANE;
  delete process.env.SYNTHESIS_PYTHON_BIN;
  if (originalDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalDataHome;
  if (originalBootstrapPython === undefined) delete process.env.SYNTHESIS_BOOTSTRAP_PYTHON;
  else process.env.SYNTHESIS_BOOTSTRAP_PYTHON = originalBootstrapPython;
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

function makeSourceRoot(root: string): string {
  mkdirSync(join(root, ".git"), { recursive: true });
  mkdirSync(join(root, ".codex-plugin"), { recursive: true });
  mkdirSync(
    join(root, "skills", "synthesis-agent-conformance", "scripts"),
    { recursive: true }
  );
  writeFileSync(join(root, ".codex-plugin", "plugin.json"), "{}\n");
  writeFileSync(
    join(
      root,
      "skills",
      "synthesis-agent-conformance",
      "scripts",
      "conformance.py"
    ),
    "# test\n"
  );
  return realpathSync(root);
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

  test("passes public evidence paths from the configured synthesis home", () => {
    const evidence = conformanceEvidencePaths("/tmp/synthesis-test");
    const args = conformanceArgs(
      "/plugin/conformance.py",
      { project: "/project", worktree: "/repo" },
      "/tmp/report.json",
      evidence,
      "/source",
      false
    );
    for (const [flag, value] of [
      ["--active-project-file", evidence.activeProject],
      ["--public-codex-sessionstart-receipt", evidence.publicCodexReceipt],
      ["--public-claude-sessionstart-receipt", evidence.publicClaudeReceipt],
      ["--capability-evidence", evidence.capabilityEvidence],
      ["--coordination-board", evidence.coordinationBoard],
    ]) {
      const index = args.indexOf(flag);
      expect(index).toBeGreaterThan(-1);
      expect(args[index + 1]).toBe(value);
    }
    expect(args).not.toContain("--private-codex-sessionstart-receipt");
  });

  test("adds private receipt evidence only when explicitly configured", () => {
    const evidence = conformanceEvidencePaths("/tmp/synthesis-test");
    const args = conformanceArgs(
      "/plugin/conformance.py",
      { project: "/project", worktree: "/repo" },
      "/tmp/report.json",
      evidence,
      "/source",
      true
    );
    const index = args.indexOf("--private-codex-sessionstart-receipt");
    expect(index).toBeGreaterThan(-1);
    expect(args[index + 1]).toBe(evidence.privateCodexReceipt);
  });

  test("runs from source when the pointer worktree is stale", () => {
    const python = preparedPython();
    const invocation = conformanceInvocation(
      "/plugin/conformance.py",
      { project: "/project", worktree: "/deleted-worktree" },
      "/tmp/report.json",
      conformanceEvidencePaths("/tmp/synthesis-test"),
      "/verified-source",
      false
    );
    expect(invocation.cwd).toBe("/verified-source");
    expect(invocation.executable).toBe(python);
    const repoRoot = invocation.args.indexOf("--repo-root");
    expect(invocation.args[repoRoot + 1]).toBe("/deleted-worktree");
  });

  test("conformance uses only the verified owned Python interpreter", () => {
    const python = preparedPython();
    expect(synthesisPythonBin()).toBe(python);
    expect(() => synthesisPythonBin(" /opt/example/python3 ")).toThrow("differs from the verified");
    process.env.SYNTHESIS_PYTHON_BIN = python;
    const invocation = conformanceInvocation(
      "/plugin/conformance.py", { project: "/project", worktree: "/repo" },
      "/tmp/report.json", conformanceEvidencePaths("/tmp/synthesis-test"), "/verified-source", false
    );
    expect(invocation.executable).toBe(python);
  });

  test("requires a Git-backed source root and never treats a plugin cache as source", () => {
    const root = mkdtempSync(join(tmpdir(), "synthesis-console-source-"));
    temporaryRoots.push(root);
    const source = makeSourceRoot(join(root, "synthesis-skills"));
    const cache = join(root, ".codex", "plugins", "cache", "synthesis-skills");
    mkdirSync(
      join(cache, "skills", "synthesis-agent-conformance", "scripts"),
      { recursive: true }
    );
    writeFileSync(join(cache, ".codex-plugin.json"), "{}\n");

    expect(conformanceSourceRoot(source, root, root)).toBe(source);
    expect(conformanceSourceRoot(cache, root, root)).toBeNull();
    expect(() =>
      conformanceArgs(
        "/plugin/conformance.py",
        { project: "/project", worktree: "/repo" },
        "/tmp/report.json",
        conformanceEvidencePaths("/tmp/synthesis-test"),
        null,
        false
      )
    ).toThrow("Git-backed synthesis-skills source checkout");
  });

  test("discovers a source checkout beneath the workspace root", () => {
    const root = mkdtempSync(join(tmpdir(), "synthesis-console-workspace-"));
    temporaryRoots.push(root);
    const source = makeSourceRoot(
      join(root, "home", "workspaces", "example", "synthesis-skills")
    );

    expect(
      conformanceSourceRoot(undefined, join(root, "home"), join(root, "console"))
    ).toBe(source);
  });

  test("rejects public-only reports when the private profile is configured", () => {
    const report = status().report!;
    expect(conformanceReportMatchesProfile(report, false)).toBeTrue();
    expect(conformanceReportMatchesProfile(report, true)).toBeFalse();

    const privateReport = {
      ...report,
      checks: [
        ...report.checks,
        {
          ...report.checks[0],
          name: "hook-live.codex-private-sessionstart",
        },
      ],
    };
    expect(conformanceReportMatchesProfile(privateReport, true)).toBeTrue();
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

  test("renders audit errors before cached PASS state in the nav chip", () => {
    const layoutSource = readFileSync(
      join(import.meta.dir, "views", "layout.ts"),
      "utf-8"
    );
    const errorBranch = layoutSource.indexOf("if (data && data.auditError)");
    const passBranch = layoutSource.indexOf(
      "var failures = data.requiredFailures || 0",
      errorBranch
    );
    expect(errorBranch).toBeGreaterThan(-1);
    expect(passBranch).toBeGreaterThan(errorBranch);
    expect(layoutSource.slice(errorBranch, passBranch)).toContain(
      "chip.classList.add('sync-dirty')"
    );
  });

  test("renders the source-checkout error in the empty state", () => {
    const value = status();
    value.conformanceAvailable = false;
    value.report = null;
    value.auditError =
      "A Git-backed synthesis-skills source checkout is required to run conformance.";
    const html = agentConformanceView(value);
    expect(html).toContain("Git-backed synthesis-skills source checkout");
    expect(html).toContain("SYNTHESIS_CONFORMANCE_SOURCE_ROOT");
    expect(html).not.toContain("SYNTHESIS_AGENT_CONFORMANCE_DIR");
  });
});
