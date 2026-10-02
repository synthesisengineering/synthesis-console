/** Actual cached-report reader, isolated homes and synthetic observations only. */
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { finiteCommand } from "./finite-command.js";
import { reportIdentity, SCHEMA_SHA256 } from "./conformance-contract.js";
import fixture from "./contracts/report-fixture.json";
const cases = [
  "valid",
  "machine",
  "source",
  "producer",
  "project",
  "repository",
  "profile",
  "expired",
  "malformed",
  "invalid-utf8",
  "duplicate",
  "oversized",
  "symlink",
] as const;
for (const change of cases)
  test(
    "actual cached consumer " + change,
    async () => {
      const source = process.env.SYNTHESIS_CORE_SOURCE;
      expect(source).toBeTruthy();
      const home = mkdtempSync(join(tmpdir(), "conformance-consumer-"));
      const state = join(home, ".synthesis");
      const reports = join(state, "agent-conformance");
      mkdirSync(reports, { recursive: true });
      const project = join(home, "project"),
        repository = join(home, "repository");
      mkdirSync(project);
      mkdirSync(repository);
      writeFileSync(
        join(state, "active-project.json"),
        JSON.stringify({ project, worktree: repository }),
      );
      const report: any = structuredClone(fixture);
      report.checked_at = new Date().toISOString();
      report.expires_at = new Date(
        Date.parse(report.checked_at) + 14400000,
      ).toISOString();
      report.schema_sha256 = SCHEMA_SHA256;
      report.identity = reportIdentity(
        source!,
        join(
          source!,
          "skills/synthesis-agent-conformance/scripts/conformance.py",
        ),
        project,
        repository,
        "public",
        home,
      );
      const names: Record<string, string> = {
        machine: "machine_sha256",
        source: "source_binding_sha256",
        producer: "producer_sha256",
        project: "project",
        repository: "repo_root",
        profile: "profile",
      };
      if (names[change])
        report.identity[names[change]] =
          change === "profile" ? "private" : "different";
      if (change === "expired") {
        report.checked_at = new Date(Date.now() - 15000000).toISOString();
        report.expires_at = new Date(
          Date.parse(report.checked_at) + 14400000,
        ).toISOString();
      }
      const path = join(reports, "last-report.json");
      let raw = JSON.stringify(report);
      if (change === "malformed") raw = "{";
      if (change === "duplicate")
        raw = raw.replace(
          '"schema_version":1',
          '"schema_version":1,"schema_version":1',
        );
      if (change === "oversized") raw = " ".repeat(4194305);
      if (change === "invalid-utf8") {
        report.checks[0].detail = "UTF8_MARKER";
        const body = Buffer.from(JSON.stringify(report));
        const at = body.indexOf("UTF8_MARKER");
        expect(at).toBeGreaterThan(0);
        writeFileSync(path, Buffer.concat([body.subarray(0, at), Buffer.from([0xff]), body.subarray(at + 11)]));
      } else if (change === "symlink") {
        const other = join(home, "retained.json");
        writeFileSync(other, raw);
        symlinkSync(other, path);
      } else writeFileSync(path, raw);
      const command = `import {getAgentConformanceStatus} from ${JSON.stringify(join(import.meta.dir, "agent-conformance.ts"))}; console.log(JSON.stringify(getAgentConformanceStatus()));`;
      const result = await finiteCommand(process.execPath, ["-e", command], {
        timeoutMs: 10000,
        maxOutputBytes: 1048576,
        env: {
          ...process.env,
          HOME: home,
          SYNTHESIS_HOME: state,
          SYNTHESIS_CONFORMANCE_SOURCE_ROOT: source,
          SYNTHESIS_AGENT_CONFORMANCE_DIR: join(
            source!,
            "skills/synthesis-agent-conformance",
          ),
          SYNTHESIS_PRIVATE_CONTROL_PLANE: "0",
          BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
        },
      });
      expect(result.kind, result.stderr).toBe("success");
      const observed = JSON.parse(result.stdout);
      if (change === "valid") {
        expect(observed.report).not.toBeNull();
        expect(observed.report.identity).toEqual(report.identity);
        expect(observed.stale).toBe(false);
      } else {
        expect(observed.report).toBeNull();
        expect(observed.stale).toBe(true);
      }
    },
    15000,
  );
