import { describe, test, expect } from "bun:test";
import {
  validateReport,
  parseUniqueJSON,
  readBoundedFile,
  SCHEMA_SHA256,
  reportIdentity,
  PLANES,
  planeStatus,
} from "./conformance-contract.js";
import fixture from "./contracts/report-fixture.json";
import { realpathSync, mkdtempSync, writeFileSync, symlinkSync, linkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const now = Date.parse(fixture.checked_at);
function report() {
  return structuredClone(fixture);
}
describe("strict shared report contract", () => {
  test("accepts exact supported bytes and fresh identity", () => {
    expect(
      validateReport(fixture, {
        expected: fixture.identity as any,
        fresh: true,
        now,
      }),
    ).not.toBeNull();
    expect(SCHEMA_SHA256).toBe(fixture.schema_sha256);
  });
  for (const key of [
    "machine_sha256",
    "source_root",
    "source_binding_sha256",
    "producer_sha256",
    "project",
    "repo_root",
    "profile",
  ])
    test("rejects identity drift " + key, () => {
      const identity = { ...fixture.identity, [key]: "changed" };
      expect(validateReport(fixture, { expected: identity as any })).toBeNull();
    });
  for (const offset of [-6000, 14400000, 86400000])
    test("refuses stale/future " + offset, () =>
      expect(
        validateReport(fixture, { fresh: true, now: now + offset }),
      ).toBeNull(),
    );
  const mutations: Record<string, (r: any) => void> = {
    unknownPlane: (r) => (r.checks[0].plane = "future"),
    missingPlane: (r) => delete r.planes.native,
    unknownSchema: (r) => (r.schema_version = 2),
    boolSchema: (r) => (r.schema_version = true),
    schemaHash: (r) => (r.schema_sha256 = "f".repeat(64)),
    badStatus: (r) => (r.checks[0].ok = null),
    aggregate: (r) => (r.ok = false),
    duplicate: (r) => r.checks.push({ ...r.checks[0] }),
    empty: (r) => (r.checks = []),
    privatePayload: (r) => (r.checks[0].raw_command = "secret"),
    badDate: (r) => (r.checked_at = "2026-02-30T12:00:00Z"),
    ttl: (r) => (r.expires_at = r.checked_at),
  };
  for (const [name, mutate] of Object.entries(mutations))
    test("refuses " + name, () => {
      const r = report();
      mutate(r);
      expect(validateReport(r)).toBeNull();
    });
  test("duplicate keys cannot be hidden by parsing", () => {
    expect(() => parseUniqueJSON('{"checks":[],"checks":[1]}')).toThrow();
    expect(() => parseUniqueJSON('{"x":{"a":1,"a":2}}')).toThrow();
    expect(() => parseUniqueJSON('{"schema_version":1.0}')).toThrow();
    expect(() => parseUniqueJSON('{"schema_version":1e0}')).toThrow();
    expect(parseUniqueJSON(JSON.stringify(fixture))).toEqual(fixture);
  });
  test("descriptor reader refuses links and size growth", () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "report-")));
    const file = join(dir, "file");
    writeFileSync(file, "synthetic");
    expect(readBoundedFile(file).toString()).toBe("synthetic");
    expect(() => readBoundedFile(file, 2)).toThrow();
    symlinkSync(file, join(dir, "link"));
    expect(() => readBoundedFile(join(dir, "link"))).toThrow();
    linkSync(file, join(dir, "hard"));
    expect(() => readBoundedFile(file)).toThrow();
  });
});

for (const status of ["WARN", "UNSUPPORTED"] as const) {
  test("all requires a passing observation for every plane: " + status, () => {
    const r: any = structuredClone(fixture);
    r.command = "all";
    r.checks = PLANES.map(plane => ({ name: plane + ".fixture", plane,
      ok: true, detail: "synthetic", required: true, status: "PASS", outcome: null }));
    r.checks[2] = { ...r.checks[2], required: false,
      ok: status === "WARN" ? false : null, status };
    r.planes = Object.fromEntries(PLANES.map(p => [p, planeStatus(r.checks.filter((c: any) => c.plane === p))]));
    r.status = "PASS"; r.ok = true;
    expect(validateReport(r) === null).toBeTrue();
    r.status = "UNKNOWN"; r.ok = false;
    expect(validateReport(r) !== null).toBeTrue();
    r.command = "source"; r.status = "PASS"; r.ok = true;
    expect(validateReport(r) !== null).toBeTrue();
  });
}

test("binary JSON decoding preserves valid Unicode and refuses malformed UTF-8", () => {
  expect(parseUniqueJSON(Buffer.from('{"value":"é😀"}'))).toEqual({value: "é😀"});
  expect(() => parseUniqueJSON(Buffer.from([123,34,120,34,58,34,255,34,125]))).toThrow();
});

for (const [checked, expires] of [
  ["2026-08-13T12:00:00.123001Z", "2026-08-13T16:00:00.123002Z"],
  ["0000-08-13T12:00:00Z", "0000-08-13T16:00:00Z"],
]) test("exact timestamp contract refuses " + checked, () => {
  const r = structuredClone(fixture); r.checked_at = checked; r.expires_at = expires;
  expect(validateReport(r) === null).toBeTrue();
});
test("exact microsecond TTL and invalid freshness inputs", () => {
  const r = structuredClone(fixture);
  r.checked_at = "2026-08-13T12:00:00.123001Z";
  r.expires_at = "2026-08-13T16:00:00.123001Z";
  expect(validateReport(r) !== null).toBeTrue();
  expect(validateReport(r, {fresh: true, now: NaN}) === null).toBeTrue();
});
