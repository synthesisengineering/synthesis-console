import { finiteCommand, FiniteCommandError } from "./finite-command.js";
import { resolve } from "node:path";

/** Keep interpreter dependencies isolated from inherited Python import settings. */
export function synthesisPythonEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: "1" };
  delete env.PYTHONPATH;
  delete env.PYTHONHOME;
  return env;
}

/** Async production resolution has the same finite helper custody as its consumer. */
export async function synthesisPythonBin(configured=process.env.SYNTHESIS_PYTHON_BIN):Promise<string>{
 const result=await finiteCommand('bash',[resolve(import.meta.dir,'../scripts/python-runtime.sh'),'resolve'],{env:synthesisPythonEnv(),timeoutMs:8000,maxOutputBytes:1024*1024});
 if(result.kind!=='success')throw new FiniteCommandError(result);
 const interpreter=result.stdout.trim();
 if(!interpreter||interpreter.includes('\n'))throw new Error('Console Python runtime could not be resolved.');
 if(configured?.trim()&&configured.trim()!==interpreter)throw new Error('SYNTHESIS_PYTHON_BIN differs from the verified Console runtime. Run synthesis-console setup and refresh the service.');
 return interpreter;
}
