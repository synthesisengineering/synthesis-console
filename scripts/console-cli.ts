#!/usr/bin/env bun
import { existsSync, readFileSync, lstatSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHash } from "node:crypto";
const root=resolve(import.meta.dir,"..");
const pkg=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
const [command="--help",...args]=process.argv.slice(2);
function fail(message: string): never { console.error(message); process.exit(2); }
const runtime=process.versions.bun.split(".").map(Number);
if (runtime[0]<1 || (runtime[0]===1 && (runtime[1]<3 || (runtime[1]===3 && runtime[2]<13)))) fail("Bun 1.3.13 or later is required.");
const help=`Synthesis Console ${pkg.version}
Usage: synthesis-console COMMAND
  --help | --version                  Read package information
  setup [--no-dormant-core]            Prepare isolated Python and optional inert core
  synthesis <activate|deactivate|status|doctor|repair|update> [args]\n                                      Explicit packaged-core lifecycle access
  start [--demo]                      Run on loopback in the foreground
  demo                                Run with bundled sample data only
  autostart install | uninstall        Explicit login service registration/removal

Bun 1.3.13+ is required. Default core setup needs Python3.12–3.14 and Git.
Opt-out setup needs Python3.9+. Bundled PyYAML needs no pip or compiler.
Package installation never runs setup; setup never enables services or hooks.
Config: ~/.synthesis/console.yaml; setup preserves it. No telemetry.
`;
if(command==="--help"||command==="-h") { console.log(help); process.exit(0); }
if(command==="--version") { console.log(`synthesis-console ${pkg.version}`); process.exit(0); }
const lifecycleCommands = ["activate", "deactivate", "status", "doctor", "repair", "update"];
function verifiedCore(): string {
 try {
 const core=join(root,"synthesis-core/bin/synthesis");
 if(!existsSync(core)) fail("Verified core launcher is absent. Use the built release package for setup.");
 if(lstatSync(join(root,"core-files.json")).isSymbolicLink()) fail("Core inventory is a symbolic link.");
 const inventory=JSON.parse(readFileSync(join(root,"core-files.json"),"utf8"));
 if(!inventory || typeof inventory!=="object" || Array.isArray(inventory) || !inventory["bin/synthesis"]) fail("Core inventory is incomplete.");
 const coreRoot=join(root,"synthesis-core");
 const found: string[]=[];
 function verify(directory:string, prefix="") {
  if(lstatSync(directory).isSymbolicLink()) fail("Core contains a symbolic link.");
  for(const name of readdirSync(directory)) {
   const relative=prefix+name; const path=join(directory,name); const stat=lstatSync(path);
   if(stat.isSymbolicLink()) fail("Core contains a symbolic link.");
   if(stat.isDirectory()) { verify(path,relative+"/"); continue; }
   const expected=inventory[relative];
   if(!stat.isFile()||!expected||expected.sha256!==createHash("sha256").update(readFileSync(path)).digest("hex")||expected.mode!==(stat.mode&0o777)) fail("Core package integrity check failed.");
   found.push(relative);
  }
 }
 verify(coreRoot);
 if(found.length!==Object.keys(inventory).length) fail("Core package is incomplete.");
 return core;
 } catch(error) { fail(`Verified core launcher unavailable: ${error instanceof Error ? error.message : String(error)}`); }
}
let target: string[];
if(command==="setup") {
 if(args.some(x=>x!=="--no-dormant-core")||args.length>1) fail("setup accepts only --no-dormant-core");
 const core=verifiedCore();
 target=[core,"stage-core","--for-tool","console",...args];
} else if(command==="synthesis") {
 if(args.length===1 && ["--help","-h"].includes(args[0])) {
  console.log(`Usage: synthesis-console synthesis <${lifecycleCommands.join("|")}> [args]\nExplicit lifecycle access. Example: synthesis-console synthesis activate --profile full`);
  process.exit(0);
 }
 if(!args.length || !lifecycleCommands.includes(args[0])) fail(`Choose an allowed lifecycle operation: ${lifecycleCommands.join(", ")}`);
 target=[verifiedCore(),...args];
} else if(command==="start"||command==="demo") {
 if(args.some(x=>x!=="--demo")||args.length>1) fail("start accepts only --demo");
 const entry=existsSync(join(root,"app/index.js"))?join(root,"app/index.js"):join(root,"src/index.ts");
 target=[process.execPath,"run",entry,...(command==="demo"?["--demo"]:args)];
} else if(command==="autostart") {
 if(args.length!==1||!["install","uninstall"].includes(args[0])) fail("autostart requires install or uninstall");
 const platform=process.platform==="darwin"?"macos":process.platform==="linux"?"linux":fail("Autostart supports macOS and Linux only.");
 target=["bash",join(root,`scripts/${args[0]}-autostart-${platform}.sh`)];
} else fail("Unknown command. Run synthesis-console --help.");
async function dispatch(target: string[]): Promise<void> {
const child=Bun.spawn(target,{cwd:command==="synthesis"?process.cwd():root,env:process.env,stdin:"inherit",stdout:"inherit",stderr:"inherit"});
let cancelled: NodeJS.Signals | null = null;
const forward = new Map((["SIGTERM","SIGINT","SIGHUP"] as const).map(signal => [signal, () => { cancelled ??= signal; child.kill(signal); }]));
for(const [signal,handler] of forward) process.on(signal,handler);
const exitCode=await child.exited;
for(const [signal,handler] of forward) process.off(signal,handler);
if(cancelled || child.signalCode) {
 process.kill(process.pid,cancelled || child.signalCode!);
 await new Promise<never>(() => {});
}
else if(exitCode) process.exit(exitCode);
}
await dispatch(target);
if(command === "setup") await dispatch(["bash", join(root,"scripts/python-runtime.sh"), "setup"]);
process.exit(0);
