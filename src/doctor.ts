/**
 * `synthesis doctor --json`: is every part of synthesis v5 installed, current
 * and wired into each harness? The Console runs the doctor on demand and keeps
 * the result for a minute, so the page and the nav chip share one run.
 *
 * Contract (synthesis/doctor.py): stdout is
 *   {"healthy": bool, "ms": number, "checks": [{"status", "name", "detail"}]}
 * where status is ok, warn, fail or info (info never affects health), and the
 * exit status is 0 when healthy and 1 otherwise.
 */
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { finiteCommand } from "./finite-command.js";
import { CachedRun } from "./cached-run.js";
import { describeFailure, synthesisHome } from "./v5.js";

export const DOCTOR_TIMEOUT_MS = 30_000;
export const DOCTOR_TTL_MS = 60_000;
const MAX_OUTPUT_BYTES = 1024 * 1024;

export interface DoctorCheck {
  status: string;
  name: string;
  detail: string;
}

export interface DoctorReport {
  healthy: boolean;
  ms: number;
  checks: DoctorCheck[];
}

export interface DoctorRun {
  /** The v5 command the Console ran. */
  launcher: string;
  /** False when no v5 command exists at `launcher`. */
  installed: boolean;
  report: DoctorReport | null;
  /** Why there is no report, or why it cannot be trusted. */
  error: string | null;
  /** Wall-clock time of the run, including process start. */
  elapsedMs: number | null;
}

export interface DoctorStatus extends DoctorRun {
  /** When the run finished, ISO 8601. */
  checkedAt: string | null;
  ageSeconds: number | null;
}

/** Parse and validate the doctor's JSON. Throws with a plain reason. */
export function parseDoctorReport(text: string): DoctorReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("synthesis doctor did not print JSON.");
  }
  const data = value as Partial<DoctorReport> | null;
  if (
    !data ||
    typeof data !== "object" ||
    typeof data.healthy !== "boolean" ||
    typeof data.ms !== "number" ||
    !Number.isFinite(data.ms) ||
    !Array.isArray(data.checks)
  ) {
    throw new Error("synthesis doctor printed JSON without healthy, ms and checks.");
  }
  const checks = data.checks.map((check) => {
    if (
      !check ||
      typeof check.status !== "string" ||
      typeof check.name !== "string" ||
      typeof check.detail !== "string"
    ) {
      throw new Error("synthesis doctor printed a check without status, name and detail.");
    }
    return { status: check.status, name: check.name, detail: check.detail };
  });
  return { healthy: data.healthy, ms: data.ms, checks };
}

export function doctorLauncher(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  return join(synthesisHome(env, home), "bin", "synthesis");
}

export interface DoctorOptions {
  launcher?: string;
  env?: NodeJS.ProcessEnv;
  /** The doctor reports the instruction chain for its working folder. */
  cwd?: string;
  timeoutMs?: number;
}

/** Run the doctor once. Resolves with a report or the reason there is none. */
export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorRun> {
  const env = options.env ?? process.env;
  const launcher = options.launcher ?? doctorLauncher(env);
  const timeoutMs = options.timeoutMs ?? DOCTOR_TIMEOUT_MS;
  if (!existsSync(launcher)) {
    return {
      launcher,
      installed: false,
      report: null,
      error: null,
      elapsedMs: null,
    };
  }
  const started = performance.now();
  const result = await finiteCommand(launcher, ["doctor", "--json"], {
    env,
    cwd: options.cwd ?? homedir(),
    timeoutMs,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  const elapsedMs = Math.round(performance.now() - started);
  const run = (report: DoctorReport | null, error: string | null): DoctorRun => ({
    launcher,
    installed: true,
    report,
    error,
    elapsedMs,
  });
  // The doctor's own exit: 0 healthy, 1 not healthy. A run that exited this
  // way but left a process behind still printed its whole report.
  const code = result.kind === "success" ? 0 : result.code;
  const exited =
    (result.kind === "success" || result.kind === "exit" || result.kind === "descendants") &&
    (code === 0 || code === 1);
  if (!exited) return run(null, describeFailure(result, "synthesis doctor", timeoutMs));
  let report: DoctorReport;
  try {
    report = parseDoctorReport(result.stdout);
  } catch (error) {
    const stderr = result.stderr.trim().slice(0, 600);
    return run(null, (error as Error).message + (stderr ? ` ${stderr}` : ""));
  }
  if (report.healthy !== (code === 0)) {
    return run(
      report,
      `synthesis doctor exited with status ${code} but reported healthy=${report.healthy}, so the result is inconsistent.`
    );
  }
  if (result.kind === "descendants") {
    return run(report, "synthesis doctor exited but left processes running; the Console stopped them.");
  }
  return run(report, null);
}

export function summarizeChecks(checks: DoctorCheck[]): Record<string, number> {
  const counts: Record<string, number> = { fail: 0, warn: 0, info: 0, ok: 0 };
  for (const check of checks) counts[check.status] = (counts[check.status] ?? 0) + 1;
  return counts;
}

/** Severity order for display: the same order `synthesis doctor` prints. */
export function sortChecks(checks: DoctorCheck[]): DoctorCheck[] {
  const order = ["fail", "warn", "info", "ok"];
  const rank = (status: string) => {
    const index = order.indexOf(status);
    return index < 0 ? -1 : index; // an unknown status sorts first, to be seen
  };
  return [...checks].sort((a, b) => rank(a.status) - rank(b.status));
}

export function doctorStatus(cached: { result: DoctorRun; at: number }, now = Date.now()): DoctorStatus {
  return {
    ...cached.result,
    checkedAt: new Date(cached.at).toISOString(),
    ageSeconds: Math.max(0, Math.floor((now - cached.at) / 1000)),
  };
}

let shared: CachedRun<DoctorRun> | null = null;

/** The kept doctor result, or a new run when it is older than a minute. */
export async function getDoctorStatus(force = false): Promise<DoctorStatus> {
  shared ??= new CachedRun(() => runDoctor(), DOCTOR_TTL_MS);
  return doctorStatus(await shared.get(force));
}
