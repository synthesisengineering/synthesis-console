/** Shared versioned conformance schema; local report validation is not signing. */
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir, hostname } from "node:os";
import schema from "./contracts/conformance-report-v1.schema.json";
export const SCHEMA_SHA256 = hash(JSON.stringify(schema, null, 2) + "\n");
export const PLANES = [
  "source",
  "installed",
  "native",
  "continuity",
  "capability",
] as const;
export const TTL_MS = 4 * 3600 * 1000;
export type Plane = (typeof PLANES)[number];
export type CheckStatus = "PASS" | "FAIL" | "WARN" | "UNKNOWN" | "UNSUPPORTED";
export interface ConformanceCheck {
  name: string;
  ok: boolean | null;
  detail: string;
  required: boolean;
  plane: Plane;
  outcome: CheckStatus | null;
  status: CheckStatus;
}
export interface ReportIdentity {
  machine_sha256: string;
  source_root: string;
  source_binding_sha256: string;
  producer_sha256: string;
  project: string | null;
  repo_root: string | null;
  profile: "public" | "private";
}
export interface ConformanceReport {
  schema_id: string;
  schema_version: 1;
  schema_sha256: string;
  checked_at: string;
  expires_at: string;
  command: string;
  identity: ReportIdentity;
  ok: boolean;
  status: "PASS" | "FAIL" | "UNKNOWN";
  planes: Record<Plane, CheckStatus>;
  checks: ConformanceCheck[];
}
export function hash(value: string | Buffer) {
  return createHash("sha256").update(value).digest("hex");
}
export { readBoundedFile } from "./bounded-file.js";
import { readBoundedFile } from "./bounded-file.js";
/** Reject duplicate object keys before JSON.parse can hide them. */
export function parseUniqueJSON(input: string | Uint8Array): unknown {
  // Decode evidence bytes strictly; replacement characters would alter observations.
  const raw = typeof input === "string" ? input : new TextDecoder("utf-8", { fatal: true }).decode(input);
  if (Buffer.byteLength(raw) > 4 * 1024 * 1024)
    throw Error("Report exceeds byte bound");
  let at = 0,
    nodes = 0;
  const ws = () => {
    while (/\s/.test(raw[at] ?? "") && at < raw.length) at++;
  };
  function str() {
    const start = at++;
    while (at < raw.length) {
      if (raw[at] === "\\") {
        at += 2;
        continue;
      }
      if (raw[at++] === '"') return JSON.parse(raw.slice(start, at)) as string;
    }
    throw Error("Unclosed JSON string");
  }
  function val(depth: number) {
    if (depth > 32 || ++nodes > 100000)
      throw Error("Report JSON nesting or node bound");
    ws();
    const c = raw[at];
    if (c === '"') {
      str();
      return;
    }
    if (c === "{" || c === "[") {
      at++;
      ws();
      const keys = new Set<string>();
      const end = c === "{" ? "}" : "]";
      if (raw[at] === end) {
        at++;
        return;
      }
      for (;;) {
        if (c === "{") {
          ws();
          if (raw[at] !== '"') throw Error("Invalid JSON key");
          const key = str();
          if (keys.has(key)) throw Error("Duplicate report JSON property");
          keys.add(key);
          ws();
          if (raw[at++] !== ":") throw Error("Invalid JSON colon");
        }
        val(depth + 1);
        ws();
        if (raw[at] === end) {
          at++;
          return;
        }
        if (raw[at++] !== ",") throw Error("Invalid JSON separator");
      }
    }
    const m = raw
      .slice(at)
      .match(
        /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/,
      );
    if (!m) throw Error("Invalid JSON token");
    if (/^[0-9-]/.test(m[0]) && !/^-?(?:0|[1-9]\d*)$/.test(m[0]))
      throw Error("Report uses noninteger JSON number");
    at += m[0].length;
  }
  val(0);
  ws();
  if (at !== raw.length) throw Error("Trailing JSON");
  return JSON.parse(raw);
}
function timestamp(value: unknown): bigint {
  if (typeof value !== "string" ||
      !/^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(?:\.[0-9]{1,6})?(?:Z|\+00:00)$/.test(value) ||
      value.slice(0, 4) === "0000")
    throw Error("UTC ISO timestamp required");
  const seconds = value.slice(0, 19);
  const ms = Date.parse(seconds + "Z");
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 19) !== seconds)
    throw Error("Invalid UTC date");
  const fraction = value.match(/\.([0-9]{1,6})/)?.[1] ?? "";
  return BigInt(ms) * 1000n + BigInt(fraction.padEnd(6, "0"));
}

function structural(value: any, s: any): void {
  const allowed = [
    "$schema",
    "$id",
    "type",
    "const",
    "enum",
    "anyOf",
    "additionalProperties",
    "required",
    "properties",
    "minLength",
    "maxLength",
    "pattern",
    "format",
    "minItems",
    "maxItems",
    "items",
  ];
  if (Object.keys(s).some((x) => !allowed.includes(x)))
    throw Error("Unsupported schema keyword");
  if (s.anyOf) {
    for (const choice of s.anyOf) {
      try {
        structural(value, choice);
        return;
      } catch {}
    }
    throw Error("Schema variants refused");
  }
  const types: Record<string, (x: any) => boolean> = {
    object: (x) => x !== null && typeof x === "object" && !Array.isArray(x),
    array: Array.isArray,
    integer: Number.isSafeInteger,
    boolean: (x) => typeof x === "boolean",
    string: (x) => typeof x === "string",
    null: (x) => x === null,
  };
  const wanted = Array.isArray(s.type) ? s.type : s.type ? [s.type] : [];
  if (wanted.length && !wanted.some((t: string) => types[t](value)))
    throw Error("Schema type refused");
  if (
    ("const" in s && value !== s.const) ||
    (s.enum && !s.enum.includes(value))
  )
    throw Error("Schema constant or enum refused");
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const props = s.properties ?? {};
    if (
      s.required?.some((k: string) => !Object.hasOwn(value, k)) ||
      (s.additionalProperties === false &&
        Object.keys(value).some((k) => !Object.hasOwn(props, k)))
    )
      throw Error("Missing or unknown report key");
    for (const k of Object.keys(value)) structural(value[k], props[k]);
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (
      length < (s.minLength ?? 0) ||
      length > (s.maxLength ?? 4194304) ||
      (s.pattern && !new RegExp(s.pattern).test(value))
    )
      throw Error("Invalid report string");
    if (s.format === "date-time") timestamp(value);
  }
  if (Array.isArray(value)) {
    if (value.length < (s.minItems ?? 0) || value.length > (s.maxItems ?? 4096))
      throw Error("Report item bound");
    for (const x of value) structural(x, s.items);
  }
}
export function planeStatus(checks: ConformanceCheck[]): CheckStatus {
  if (!checks.length) return "UNKNOWN";
  const r = checks.filter((c) => c.required);
  if (r.some((c) => c.status === "FAIL")) return "FAIL";
  if (r.some((c) => c.status !== "PASS")) return "UNKNOWN";
  if (r.length) return "PASS";
  if (checks.every((c) => c.status === "UNSUPPORTED")) return "UNSUPPORTED";
  if (checks.some((c) => c.status === "WARN")) return "WARN";
  return "UNKNOWN";
}
export function reportIdentity(
  root: string,
  producer: string,
  project: string | null,
  repo: string | null,
  profile: "public" | "private",
  home = homedir(),
  host = hostname(),
): ReportIdentity {
  const source = realpathSync(root);
  const paths = [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "skills/synthesis-agent-conformance/scripts/conformance.py",
    "skills/synthesis-agent-conformance/scripts/report_contract.py",
    "skills/synthesis-agent-conformance/references/conformance-report-v1.schema.json",
  ];
  const files = paths.map((p) => [p, hash(readBoundedFile(join(source, p)))]);
  return {
    machine_sha256: hash(host + "\0" + realpathSync(home)),
    source_root: source,
    source_binding_sha256: hash(JSON.stringify(files)),
    producer_sha256: hash(readBoundedFile(realpathSync(producer))),
    project,
    repo_root: repo,
    profile,
  };
}
/** Exact Python producer encoding: indent=2, ensure_ascii=True, final newline. */
export function producerReportBytes(value: unknown): Buffer {
  const text = JSON.stringify(value, null, 2);
  if (text === undefined) throw Error("Report cannot be encoded");
  return Buffer.from(text.replace(/[\u007f-\uffff]/g, (character) =>
    "\\u" + character.charCodeAt(0).toString(16).padStart(4, "0")) + "\n", "ascii");
}
export function validateReport(
  value: unknown,
  options: { expected?: ReportIdentity; fresh?: boolean; now?: number } = {},
): ConformanceReport | null {
  try {
    if (producerReportBytes(value).length > 4194304)
      throw Error("Report byte bound");
    structural(value, schema);
    const r = value as ConformanceReport;
    if (r.schema_sha256 !== SCHEMA_SHA256) throw Error("Schema hash mismatch");
    const checked = timestamp(r.checked_at),
      expires = timestamp(r.expires_at);
    if (expires - checked !== BigInt(TTL_MS) * 1000n) throw Error("Report TTL mismatch");
    if (
      options.expected &&
      Object.keys(options.expected).some(
        (k) => (r.identity as any)[k] !== (options.expected as any)[k],
      )
    )
      throw Error("Report identity differs");
    const now = options.now ?? Date.now();
    if (options.fresh && (!Number.isSafeInteger(now) ||
      checked > (BigInt(now) + 5000n) * 1000n || BigInt(now) * 1000n >= expires))
      throw Error("Report is stale or from future");
    const names = new Set<string>();
    for (const c of r.checks) {
      if (names.has(c.name)) throw Error("Duplicate check");
      names.add(c.name);
      if (
        (c.status === "PASS" && c.ok !== true) ||
        (["FAIL", "WARN"].includes(c.status) && c.ok !== false) ||
        (["UNKNOWN", "UNSUPPORTED"].includes(c.status) && c.ok !== null) ||
        (["WARN", "UNSUPPORTED"].includes(c.status) && c.required) ||
        (c.outcome !== null && c.outcome !== c.status)
      )
        throw Error("Contradictory check");
    }
    for (const p of PLANES)
      if (r.planes[p] !== planeStatus(r.checks.filter((c) => c.plane === p)))
        throw Error("Contradictory plane");
    let status = planeStatus(r.checks);
    if (
      !["PASS", "FAIL"].includes(status) ||
      (r.command === "all" &&
        status === "PASS" &&
        PLANES.some((p) => r.planes[p] !== "PASS"))
    )
      status = "UNKNOWN";
    if (r.status !== status || r.ok !== (status === "PASS"))
      throw Error("Contradictory aggregate");
    return r;
  } catch {
    return null;
  }
}
