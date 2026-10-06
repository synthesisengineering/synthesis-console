/**
 * Where synthesis v5 keeps its runtime, and how the Console runs v5 programs.
 *
 * v5 owns one runtime folder, `SYNTHESIS_HOME` (default `~/.synthesis/v5`):
 * `bin/synthesis` is its command, `current/` the installed release, `state/`
 * its small state files. A few machine-wide files stay directly under
 * `~/.synthesis` because the skills that write them name that folder:
 * `repo-guard/last-report.json`, the `quiet-audio` mute flag and the
 * Console's own `console.yaml`.
 *
 * v5 skill scripts are Python standard library only, and v5 runs them with the
 * `python3` on PATH. The Console does the same, with `SYNTHESIS_PYTHON_BIN` as
 * an explicit override, in isolated mode and without writing bytecode into a
 * plugin folder (the v5 doctor warns when a `__pycache__` appears there).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { finiteCommand, type FiniteResult } from "./finite-command.js";

/** The v5 runtime folder: the same rule as v5's `paths.home()`. */
export function synthesisHome(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir()
): string {
  return env.SYNTHESIS_HOME || join(home, ".synthesis", "v5");
}

/** The machine-wide folder the repo guard and the mute flag live in. */
export function synthesisDir(home = homedir()): string {
  return join(home, ".synthesis");
}

/** The interpreter for v5 skill scripts. */
export function pythonExecutable(env: NodeJS.ProcessEnv = process.env): string {
  return env.SYNTHESIS_PYTHON_BIN?.trim() || "python3";
}

/** The inherited environment without settings that redirect Python imports. */
export function pythonEnvironment(
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env, PYTHONDONTWRITEBYTECODE: "1" };
  delete result.PYTHONPATH;
  delete result.PYTHONHOME;
  return result;
}

export interface RunOptions {
  timeoutMs: number;
  maxOutputBytes: number;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

/** Run a v5 skill script once, time- and output-bounded, its process group reaped. */
export function runPythonScript(
  script: string,
  args: string[],
  options: RunOptions
): Promise<FiniteResult> {
  const env = options.env ?? process.env;
  return finiteCommand(
    pythonExecutable(env),
    ["-I", "-B", script, ...args],
    {
      env: pythonEnvironment(env),
      cwd: options.cwd,
      timeoutMs: options.timeoutMs,
      maxOutputBytes: options.maxOutputBytes,
    }
  );
}

/** One plain sentence for a run that did not finish normally. */
export function describeFailure(result: FiniteResult, what: string, timeoutMs: number): string {
  const stderr = result.stderr.trim().split("\n").slice(-3).join(" ").slice(0, 600);
  const detail = stderr ? `: ${stderr}` : ".";
  switch (result.kind) {
    case "timeout":
      return `${what} did not finish within ${Math.round(timeoutMs / 1000)} s and was stopped.`;
    case "output":
      return `${what} printed more output than the Console reads, so it was stopped.`;
    case "signal":
      return `${what} was terminated by ${result.signal}${detail}`;
    case "launch":
      return `${what} could not start (${result.detail || "no reason given"}).`;
    case "exit":
      return `${what} exited with status ${result.code}${detail}`;
    case "descendants":
      return `${what} exited but left processes running; they were stopped.`;
    default:
      return `${what} failed: ${result.detail || result.kind}.`;
  }
}
