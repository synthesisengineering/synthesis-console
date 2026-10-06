#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { resolve, join } from "node:path";
const root=resolve(import.meta.dir,"..");
const pkg=JSON.parse(readFileSync(join(root,"package.json"),"utf8"));
const [command="--help",...args]=process.argv.slice(2);
function fail(message: string): never { console.error(message); process.exit(2); }
const runtime=process.versions.bun.split(".").map(Number);
if (runtime[0]<1 || (runtime[0]===1 && (runtime[1]<3 || (runtime[1]===3 && runtime[2]<13)))) fail("Bun 1.3.13 or later is required.");
const help=`Synthesis Console ${pkg.version}
Usage: synthesis-console COMMAND
  --help | --version                  Read package information
  start [--demo]                      Run on loopback in the foreground
  demo                                Run with bundled sample data only
  autostart status | install | uninstall        Explicit login service registration/removal

Bun 1.3.13+ is required. The Conformance, Context, Autopilot and Sync views read
synthesis v5 (installed by the synthesis-skills plugin) and run its Python 3
scripts with python3, or SYNTHESIS_PYTHON_BIN when set.
Package installation never starts services or changes agent settings.
Config: ~/.synthesis/console.yaml. No telemetry.
`;
if(command==="--help"||command==="-h") { console.log(help); process.exit(0); }
if(command==="--version") { console.log(`synthesis-console ${pkg.version}`); process.exit(0); }
if(command==="autostart" && args.length===1 && args[0]==="status") {
 const entry=existsSync(join(root,"app/platform-ownership.js"))?join(root,"app/platform-ownership.js"):join(root,"src/platform-ownership.ts");
 const {platformOwnership}=await import(entry);
 console.log(JSON.stringify(platformOwnership(),null,2));process.exit(0);
}
let target: string[];
if(command==="start"||command==="demo") {
 if(args.some(x=>x!=="--demo")||args.length>1) fail("start accepts only --demo");
 const entry=existsSync(join(root,"app/index.js"))?join(root,"app/index.js"):join(root,"src/index.ts");
 target=[process.execPath,"run",entry,...(command==="demo"?["--demo"]:args)];
} else if(command==="autostart") {
 if(args.length!==1||!["install","uninstall"].includes(args[0])) fail("autostart requires install or uninstall");
 const platform=process.platform==="darwin"?"macos":process.platform==="linux"?"linux":fail("Autostart supports macOS and Linux only.");
 target=["bash",join(root,`scripts/${args[0]}-autostart-${platform}.sh`)];
} else fail("Unknown command. Run synthesis-console --help.");
const child=Bun.spawn(target,{cwd:root,env:process.env,stdin:"inherit",stdout:"inherit",stderr:"inherit"});
let cancelled: NodeJS.Signals | null = null;
const forward = new Map((["SIGTERM","SIGINT","SIGHUP"] as const).map(signal => [signal, () => { cancelled ??= signal; child.kill(signal); }]));
for(const [signal,handler] of forward) process.on(signal,handler);
const exitCode=await child.exited;
for(const [signal,handler] of forward) process.off(signal,handler);
if(cancelled || child.signalCode) {
 process.kill(process.pid,cancelled || child.signalCode!);
 await new Promise<never>(() => {});
}
process.exit(exitCode);
