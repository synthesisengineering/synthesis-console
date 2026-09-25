import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, chmodSync, symlinkSync, realpathSync, linkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Supervisor as ProductionSupervisor, type Generation, type LaunchRequest } from "./autopilot-supervisor.js";

// Synthetic custody seam solely for exercising queue/helper mechanics. This
// does not qualify native containment or enable the production adapter.
class Supervisor extends ProductionSupervisor { protected override requireCustody():void {} }

test("production refuses unsupported complete-tree custody before any private write or process",async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),"console-custody-unavailable-")));
  let resolved=false;const production=new ProductionSupervisor({root:join(root,"private"),resolveGeneration:async()=>{resolved=true;throw new Error("must not resolve or launch");}});
  await expect(production.enroll()).rejects.toThrow("process-tree custody");
  expect(existsSync(join(root,"private"))).toBe(false);expect(resolved).toBe(false);
  expect(production.status().automatic_continuation).toBe("UNAVAILABLE");
  expect(production.status().operational_ready).toBe(false);
});

function fixture(program = "import sys,json\nr=json.load(sys.stdin)\nprint(json.dumps({'status':'native_terminal','task_accepted':False}))\n") {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "console-supervisor-")));
  const helper = join(root, "consumer.py"); writeFileSync(helper, program);
  const python = Bun.spawnSync(["which", "python3"]).stdout.toString().trim();
  let generation: Generation = {python, helper, helper_sha256: createHash("sha256").update(readFileSync(helper)).digest("hex"), release_root:root, release_digest:"a".repeat(64), console_version:"fixture"};
  const adapter = new Supervisor({root:join(root,"private"), resolveGeneration:async()=>generation, pollMs:10, timeoutMs:1000});
  const request: LaunchRequest = {project:join(root,"project"),run_id:"01990000-0000-7000-8000-000000000011",permit_id:"permit1",token:"private-token-"+"x".repeat(40),runtime_root:null};
  return {root,helper,adapter,request,change:()=>{generation={...generation,release_digest:"b".repeat(64)};}};
}

test("default disabled and explicit enrollment", async()=>{
  const f=fixture();expect(f.adapter.status().lifecycle).toBe("disabled");
  await expect(f.adapter.submit(f.request)).rejects.toThrow();
  await f.adapter.enroll();await f.adapter.submit(f.request);await f.adapter.tick();
  expect(f.adapter.status().counts.delivered).toBe(1);
  expect(f.adapter.status().authority_granted).toBe(false);
});
test("generation change prevents delivery and requires explicit refresh",async()=>{
  const f=fixture();await f.adapter.enroll();await f.adapter.submit(f.request);f.change();await f.adapter.tick();
  expect(f.adapter.status().counts.ready).toBe(1);expect(f.adapter.status().healthy).toBe(false);
});
test("actual subprocess receives stdin secret but never argv or diagnostic",async()=>{
  const f=fixture("import sys,json\nr=json.load(sys.stdin)\nassert len(sys.argv)==1\nassert r['token'].startswith('private-token-')\nprint(json.dumps({'status':'native_terminal','task_accepted':False,'sensitive':r['token']}))\n");
  await f.adapter.enroll();await f.adapter.submit(f.request);await f.adapter.tick();
  expect(JSON.stringify(f.adapter.status())).not.toContain(f.request.token);
  for(const name of readdirSync(join(f.root,"private"))) if(name.endsWith(".json")) expect(readFileSync(join(f.root,"private",name),"utf8")).not.toContain(f.request.token);
});
test("two actual consumers claim one ready inode at most once",async()=>{
  const f=fixture();await f.adapter.enroll();await f.adapter.submit(f.request);
  const g=new Supervisor({root:join(f.root,"private"),resolveGeneration:(f.adapter as any).options.resolveGeneration,timeoutMs:1000});
  await Promise.all([f.adapter.tick(),g.tick()]);expect(f.adapter.status().counts.delivered).toBe(1);
});
test("uncertain child output is retained and never replayed after restart",async()=>{
  const f=fixture("import sys\nsys.stdin.read()\nprint('not-json')\n");await f.adapter.enroll();await f.adapter.submit(f.request);await f.adapter.tick();
  expect(f.adapter.status().counts.uncertain).toBe(1);await f.adapter.tick();expect(f.adapter.status().counts.uncertain).toBe(1);
});
for(const fault of ["symlink","hardlink","mode","directory"] as const) test("refuse unsafe credential file: "+fault,async()=>{
  const f=fixture();await f.adapter.enroll();const id=await f.adapter.submit(f.request);const file=join(f.root,"private",id+".ready");
  if(fault==="mode")chmodSync(file,0o644);
  if(fault==="hardlink")linkSync(file,join(f.root,"linked"));
  if(fault==="symlink"||fault==="directory") {const fs=await import("node:fs");fs.renameSync(file,file+".retained");if(fault==="symlink")symlinkSync(file+".retained",file);else mkdirSync(file);}
  await f.adapter.tick();expect(f.adapter.status().counts.delivered).toBe(0);expect(f.adapter.status().healthy).toBe(false);
});
for(const fault of ["actor","shell","prompt","executable"] as const) test("closed request forbids "+fault,async()=>{
  const f=fixture();await f.adapter.enroll();await expect(f.adapter.submit({...f.request,[fault]:"untrusted"})).rejects.toThrow();
});
test("queue capacity, duplicate permit and demo admission are finite",async()=>{
  const f=fixture();await f.adapter.enroll();await f.adapter.submit(f.request);await expect(f.adapter.submit(f.request)).rejects.toThrow();
  const demo=new Supervisor({root:join(f.root,"demo"),demo:true});await expect(demo.enroll()).rejects.toThrow();
});
test("stop and uninstall preserve unresolved pointers and disable admission",async()=>{
  const f=fixture();await f.adapter.enroll();await f.adapter.submit(f.request);await f.adapter.stop();
  expect(f.adapter.status().lifecycle).toBe("stopped");expect(f.adapter.status().counts.ready).toBe(1);
  await f.adapter.uninstall();expect(f.adapter.status().lifecycle).toBe("uninstalled");await expect(f.adapter.submit(f.request)).rejects.toThrow();
});
test("timeout and output flood end bounded with unknown task outcome",async()=>{
  for(const code of ["import time\ntime.sleep(30)\n","print('x'*2000000)\n"]){
    const f=fixture(code);await f.adapter.enroll();await f.adapter.submit(f.request);const before=Date.now();await f.adapter.tick();
    expect(Date.now()-before).toBeLessThan(5000);expect(f.adapter.status().counts.uncertain).toBe(1);
  }
});
test("actual cleanup finally runs when the existing Console stops",async()=>{
  const f=fixture();const marker=join(f.root,"cleaned");writeFileSync(f.helper,`import time,sys\ntry:\n sys.stdin.read()\n time.sleep(30)\nfinally:\n open(${JSON.stringify(marker)},'w').write('owned cleanup')\n`);
  const generation=await (f.adapter as any).options.resolveGeneration();generation.helper_sha256=createHash("sha256").update(readFileSync(f.helper)).digest("hex");
  await f.adapter.enroll();await f.adapter.submit(f.request);const task=f.adapter.tick();await Bun.sleep(150);await f.adapter.shutdown();await task;
  expect(readFileSync(marker,"utf8")).toBe("owned cleanup");expect(f.adapter.status().counts.uncertain).toBe(1);
});

test("different envelopes cannot run together across Console consumers",async()=>{
  const f=fixture("import sys,json,time\nr=json.load(sys.stdin)\ntime.sleep(.25)\nprint(json.dumps({'status':'native_terminal','task_accepted':False}))\n");
  await f.adapter.enroll();await f.adapter.submit(f.request);await f.adapter.submit({...f.request,permit_id:"permit2"});
  const g=new Supervisor({root:join(f.root,"private"),resolveGeneration:(f.adapter as any).options.resolveGeneration,timeoutMs:1000});
  await Promise.all([f.adapter.tick(),g.tick()]);expect(f.adapter.status().counts.delivered).toBe(1);expect(f.adapter.status().counts.ready).toBe(1);
  await g.tick();expect(f.adapter.status().counts.delivered).toBe(2);
});
test("simultaneous submit permanently claims one delivery identity",async()=>{
  const f=fixture();await f.adapter.enroll();const g=new Supervisor({root:join(f.root,"private"),resolveGeneration:(f.adapter as any).options.resolveGeneration});
  const results=await Promise.allSettled([f.adapter.submit(f.request),g.submit(f.request)]);
  expect(results.filter(x=>x.status==="fulfilled").length).toBe(1);expect(f.adapter.status().counts.ready).toBe(1);
});
test("helper edit after enrollment refuses before secret delivery",async()=>{
  const f=fixture();await f.adapter.enroll();await f.adapter.submit(f.request);writeFileSync(f.helper,"raise AssertionError('must not execute')\n");
  await f.adapter.tick();expect(f.adapter.status().counts.ready).toBe(1);expect(f.adapter.status().healthy).toBe(false);
});
test("Python injection and ancestor identity hints never reach the consumer",async()=>{
  const names=["PYTHONPATH","PYTHONHOME","CODEX_THREAD_ID","MUSE_SESSION_ID","SYNTHESIS_CLIENT_SESSION_REF"];
  const old=Object.fromEntries(names.map(n=>[n,process.env[n]]));try{
    for(const n of names)process.env[n]="foreign-identity";
    const f=fixture(`import os,json,sys\njson.load(sys.stdin)\nassert all(k not in os.environ for k in ${JSON.stringify(names)})\nprint(json.dumps({'status':'native_terminal','task_accepted':False}))\n`);
    await f.adapter.enroll();await f.adapter.submit(f.request);await f.adapter.tick();expect(f.adapter.status().counts.delivered).toBe(1);
  }finally{for(const n of names)if(old[n]===undefined)delete process.env[n];else process.env[n]=old[n];}
});
test("ignored SIGINT cannot retain owned process-group descendants",async()=>{
  const f=fixture();const pidfile=join(f.root,"child.pid");
  writeFileSync(f.helper,`import signal,subprocess,sys,time\nsignal.signal(signal.SIGINT,signal.SIG_IGN)\nsys.stdin.read()\np=subprocess.Popen([sys.executable,'-c','import signal,time;signal.signal(signal.SIGINT,signal.SIG_IGN);time.sleep(30)'])\nopen(${JSON.stringify(pidfile)},'w').write(str(p.pid))\ntime.sleep(30)\n`);
  const generation=await (f.adapter as any).options.resolveGeneration();generation.helper_sha256=createHash("sha256").update(readFileSync(f.helper)).digest("hex");
  const g=new Supervisor({root:join(f.root,"private"),resolveGeneration:async()=>generation,timeoutMs:1000,killGraceMs:150});
  await g.enroll();await g.submit(f.request);const active=g.tick();for(let i=0;i<100&&!existsSync(pidfile);i++)await Bun.sleep(10);
  expect(existsSync(pidfile)).toBe(true);const before=Date.now();await g.shutdown();await active;expect(Date.now()-before).toBeLessThan(2000);
  const pid=Number(readFileSync(pidfile,"utf8"));await Bun.sleep(100);
  const status=Bun.spawnSync(["ps","-p",String(pid),"-o","stat="]).stdout.toString().trim();expect(status===""||status.startsWith("Z")).toBe(true);
  expect(g.status().counts.uncertain).toBe(1);
});

test("uncertain delivery closes subsequent work until explicit journal readback",async()=>{
  const f=fixture("import sys\nsys.stdin.read()\nprint('malformed')\n");await f.adapter.enroll();await f.adapter.submit(f.request);await f.adapter.submit({...f.request,permit_id:"permit2"});
  await f.adapter.tick();await f.adapter.tick();expect(f.adapter.status().counts.ready).toBe(1);expect(f.adapter.status().counts.uncertain).toBe(1);expect(f.adapter.status().healthy).toBe(false);
  await expect(f.adapter.submit({...f.request,permit_id:"permit3"})).rejects.toThrow();
  // Synthetic judgment over a real private custody fixture; no native qualification.
  let status="unknown";const g=new Supervisor({root:join(f.root,"private"),resolveGeneration:(f.adapter as any).options.resolveGeneration,readPermit:async()=>({status,token_sha256:createHash("sha256").update(f.request.token).digest("hex"),revision:4,journal_head:"a".repeat(64)})});
  await expect(g.reconcile()).rejects.toThrow();status="cancelled";await g.reconcile();expect(g.status().counts.uncertain).toBe(0);
  expect(g.status().authority_granted).toBe(false);expect(g.status().counts.ready).toBe(0);
});
test("generation is rechecked after the global lease before private stdin",async()=>{
  const f=fixture();let calls=0;const resolver=(f.adapter as any).options.resolveGeneration;
  const g=new Supervisor({root:join(f.root,"private"),resolveGeneration:async()=>{calls++;const value=await resolver();return calls===4?{...value,release_digest:"c".repeat(64)}:value;}});
  await g.enroll();await g.submit(f.request);await g.tick();expect(g.status().counts.ready).toBe(1);expect(g.status().counts.delivered).toBe(0);expect(g.status().healthy).toBe(false);
});
test("interrupted staging and retained claimed envelopes cannot be replayed",async()=>{
  const f=fixture();await f.adapter.enroll();const id=await f.adapter.submit(f.request);
  const fs=await import("node:fs");fs.renameSync(join(f.root,"private",id+".ready"),join(f.root,"private",id+".claimed"));
  await f.adapter.tick();expect(f.adapter.status().counts.claimed).toBe(1);await expect(f.adapter.enroll()).rejects.toThrow();
  await expect(f.adapter.submit({...f.request,permit_id:"new-permit"})).rejects.toThrow();
});
test("finite retention limit refuses without deleting existing requests",async()=>{
  const f=fixture();await f.adapter.enroll();for(let i=0;i<64;i++)await f.adapter.submit({...f.request,permit_id:"permit-"+i});
  await expect(f.adapter.submit({...f.request,permit_id:"overflow"})).rejects.toThrow();expect(f.adapter.status().counts.ready).toBe(64);
});

for(const run_id of [["01990000-0000-7000-8000-000000000011"],null,true,1,{}])test("run identity rejects JSON coercion: "+JSON.stringify(run_id),async()=>{
  const f=fixture();await f.adapter.enroll();await expect(f.adapter.submit({...f.request,run_id} as any)).rejects.toThrow("Invalid closed");expect(f.adapter.status().counts.ready).toBe(0);
});
