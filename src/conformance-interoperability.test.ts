/** The actual paired Python producer must pass the actual Console consumer. */
import { test, expect } from "bun:test";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import { readFileSync } from "node:fs";
import { finiteCommand } from "./finite-command.js";
import {
  validateReport,
  parseUniqueJSON,
  reportIdentity,
} from "./conformance-contract.js";
import schema from "./contracts/conformance-report-v1.schema.json";
import platform from "./contracts/platform-ownership-v1.json";
import { platformOwnership } from "./platform-ownership.js";
test("actual Python report and platform producers share exact source contract bytes", async () => {
  const source = process.env.SYNTHESIS_CORE_SOURCE;
  expect(source, "paired source prerequisite is required").toBeTruthy();
  const script = join(
    source!,
    "skills/synthesis-agent-conformance/scripts/conformance.py",
  );
  const command = `import sys,json\nfrom pathlib import Path\nroot=Path(sys.argv[1]);sys.path.insert(0,str(root/'skills/synthesis-agent-conformance/scripts'))\nimport report_contract as r,conformance\nbinding=r.identity(root,root/'skills/synthesis-agent-conformance/scripts/conformance.py',project='/synthetic/project',repo_root='/synthetic/repository')\nchecks=[conformance.Check(p+'.synthetic',True,'synthetic-only',plane=p).serialized() for p in r.PLANES]\nprint(json.dumps(r.build(checks,binding,'all')))\n`;
  const result = await finiteCommand(
    process.env.SYNTHESIS_BOOTSTRAP_PYTHON || "python3",
    ["-B", "-c", command, source!],
    { timeoutMs: 10000, maxOutputBytes: 524288 },
  );
  expect(result.kind, result.stderr).toBe("success");
  expect(result.cleanupComplete).toBeTrue();
  const report = parseUniqueJSON(result.stdout);
  const expected = reportIdentity(
    source!,
    script,
    "/synthetic/project",
    "/synthetic/repository",
    "public",
    homedir(),
    hostname(),
  );
  expect(validateReport(report, { expected, fresh: true })).not.toBeNull();
  expect(
    readFileSync(
      join(
        source!,
        "skills/synthesis-agent-conformance/references/conformance-report-v1.schema.json",
      ),
      "utf8",
    ),
  ).toBe(JSON.stringify(schema, null, 2) + "\n");
  expect(
    readFileSync(
      join(
        source!,
        "skills/synthesis-onboarding/references/platform-ownership-v1.json",
      ),
      "utf8",
    ),
  ).toBe(JSON.stringify(platform, null, 2) + "\n");
  const code = `import sys,json\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1]+'/skills/synthesis-onboarding/scripts')\nimport runtime_payload\nprint(json.dumps(runtime_payload.platform_ownership(Path('/synthetic'),Path('/synthetic/.local/state/synthesis'),platform='linux',environ={},proc_version='Linux')))\n`;
  const mapped = await finiteCommand(
    process.env.SYNTHESIS_BOOTSTRAP_PYTHON || "python3",
    ["-B", "-c", code, source!],
    { timeoutMs: 10000, maxOutputBytes: 524288 },
  );
  expect(mapped.kind, mapped.stderr).toBe("success");
  expect(JSON.parse(mapped.stdout)).toEqual(
    platformOwnership("/synthetic", {}, "linux", "Linux"),
  );
}, 30000);
