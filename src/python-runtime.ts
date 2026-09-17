import { execFileSync } from "node:child_process";
import { resolve } from "node:path";

/** Every Python-backed action uses the verified setup generation; never provisions. */
export function synthesisPythonBin(configured = process.env.SYNTHESIS_PYTHON_BIN): string {
  const interpreter = execFileSync("bash", [resolve(import.meta.dir, "../scripts/python-runtime.sh"), "resolve"],
    { env: synthesisPythonEnv(), encoding: "utf8" }).trim();
  if (!interpreter || interpreter.includes("\n")) throw new Error("Console Python runtime could not be resolved.");
  if (configured?.trim() && configured.trim() !== interpreter) {
    throw new Error("SYNTHESIS_PYTHON_BIN differs from the verified Console runtime. Run synthesis-console setup and refresh the service.");
  }
  return interpreter;
}

/** Keep interpreter dependencies isolated from inherited Python import settings. */
export function synthesisPythonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  return env;
}
