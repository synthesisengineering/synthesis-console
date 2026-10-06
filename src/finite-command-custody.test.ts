import { expect, test } from 'bun:test';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FiniteCommandOwner, finiteCommand, type FiniteKind } from './finite-command.js';
const roots:string[]=[];
function alive(pid:number){try{process.kill(pid,0);return true;}catch(e:any){if(e.code==='ESRCH')return false;throw e;}}
function fixture(mode:string){
 const root=mkdtempSync(join(tmpdir(),'console-custody-'));roots.push(root);const record=join(root,'child.json');const script=join(root,'helper.py');
 writeFileSync(script,`import subprocess,sys,os,time,json,signal\np=subprocess.Popen([sys.executable,'-c','import time;time.sleep(8)'])\nopen(sys.argv[1],'w').write(json.dumps({'pid':p.pid,'group':os.getpgid(p.pid),'helper':os.getpid()}))\nmode=sys.argv[2]\nif mode=='early':sys.exit(0)\nif mode=='nonzero':sys.exit(7)\nif mode=='signal':os.kill(os.getpid(),signal.SIGTERM)\nif mode in ('stdout','stderr'):\n stream=sys.stdout if mode=='stdout' else sys.stderr\n stream.write('x'*3000000);stream.flush()\ntime.sleep(8)\n`);
 return {record,script,mode};
}
function cleanup(f:ReturnType<typeof fixture>){if(existsSync(f.record)){const row=JSON.parse(readFileSync(f.record,'utf8'));for(const pid of [row.pid,row.helper])try{process.kill(pid,'SIGKILL');}catch{}}}
/** One helper run under the shared owner, as the doctor, context and repo-guard runners use it. */
async function bounded(args:string[],timeoutMs:number){return finiteCommand('python3',args,{timeoutMs,maxOutputBytes:1024*1024});}
const expectedKind:Record<string,FiniteKind>={timeout:'timeout',stdout:'output',stderr:'output',early:'descendants',nonzero:'exit',signal:'signal'};
for(const mode of ['timeout','stdout','stderr','early','nonzero','signal'])test(`actual helper custody: ${mode}`,async()=>{
 const f=fixture(mode);const start=performance.now();
 try{
  const result=await bounded(['-B',f.script,f.record,mode],mode==='timeout'?500:3000);
  expect(existsSync(f.record)).toBe(true);const row=JSON.parse(readFileSync(f.record,'utf8'));
  expect(alive(row.pid)).toBe(false);expect(performance.now()-start).toBeLessThan(4800);
  expect(result.kind).toBe(expectedKind[mode]);expect(result.cleanupComplete).toBe(true);
  if(mode==='nonzero')expect(result.code).toBe(7);
  if(mode==='signal')expect(result.signal).toBe('SIGTERM');
 }finally{cleanup(f);}
},6000);
test('two concurrent helper groups cannot signal a foreign group',async()=>{
 const foreign=spawn('python3',['-c','import time;time.sleep(8)'],{detached:true,stdio:'ignore'});const a=fixture('timeout'),b=fixture('timeout');
 try{await Promise.all([a,b].map(f=>bounded(['-B',f.script,f.record,f.mode],600)));
  for(const f of[a,b])expect(alive(JSON.parse(readFileSync(f.record,'utf8')).pid)).toBe(false);
  expect(alive(foreign.pid!)).toBe(true);
 }finally{cleanup(a);cleanup(b);foreign.kill('SIGKILL');await new Promise<void>(done=>{if(foreign.exitCode!==null||foreign.signalCode!==null)done();else foreign.once('exit',()=>done());});}
},6000);
test('finite command keeps argument boundaries and output',async()=>{
 const arg='$(touch /not-a-command); with spaces';
 const result=await bounded(['-c','import sys;print(sys.argv[1],end="")',arg],1000);
 expect(result.kind).toBe('success');expect(result.stdout).toBe(arg);
});
test('a launch failure is reported, never thrown',async()=>{
 const result=await finiteCommand('/nonexistent/finite-command-fixture',[],{timeoutMs:1000,maxOutputBytes:1024});
 expect(result.kind).toBe('launch');expect(result.cleanupComplete).toBe(true);
});

test('cleanup inventory failure latches admission and still attempts exact owned kill',async()=>{
 let launched=0;const signalled:number[]=[];
 const owner=new FiniteCommandOwner({live(){throw Object.assign(new Error('fixture inventory denied'),{code:'EPERM'});},signal(pid){signalled.push(pid);try{process.kill(-pid,'SIGKILL');}catch(e:any){if(e.code!=='ESRCH')throw e;}}});
 const f=fixture('timeout');
 try{const result=await owner.run('python3',['-B',f.script,f.record,f.mode],{timeoutMs:500,maxOutputBytes:1024});
  expect(result.kind).toBe('cleanup');expect(result.cleanupComplete).toBe(false);expect(owner.unresolvedCount).toBe(1);expect(signalled.length).toBeGreaterThan(0);
  const refused=await owner.run('/nonexistent/refused-before-launch',[],{timeoutMs:100,maxOutputBytes:1024});expect(refused.kind).toBe('cleanup');expect(refused.detail).toContain('Previous helper');
 }finally{cleanup(f);}
});
test('signal failure reports unresolved custody, never a completed timeout',async()=>{
 const owner=new FiniteCommandOwner({live(){return true;},signal(){throw Object.assign(new Error('fixture signal denied'),{code:'EPERM'});}});const f=fixture('timeout');
 try{const result=await owner.run('python3',['-B',f.script,f.record,f.mode],{timeoutMs:500,maxOutputBytes:1024});expect(result.kind).toBe('cleanup');expect(result.cleanupComplete).toBe(false);expect(owner.unresolvedCount).toBe(1);}
 finally{cleanup(f);}
});
test('cancellation cleans actual descendants before returning',async()=>{
 const f=fixture('timeout');const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),500);
 try{const result=await finiteCommand('python3',['-B',f.script,f.record,f.mode],{timeoutMs:3000,maxOutputBytes:1024,signal:controller.signal});expect(result.kind).toBe('aborted');expect(result.cleanupComplete).toBe(true);expect(alive(JSON.parse(readFileSync(f.record,'utf8')).pid)).toBe(false);}
 finally{clearTimeout(timer);cleanup(f);}
});
test('complete output is drained at normal leader exit, including UTF-8 boundaries',async()=>{
 const text='λ🦀'.repeat(90000);const result=await finiteCommand('python3',['-c','import sys;sys.stdout.write("λ🦀"*90000)'],{timeoutMs:3000,maxOutputBytes:1024*1024});expect(result.kind).toBe('success');expect(result.stdout).toBe(text);expect(result.cleanupComplete).toBe(true);
});
