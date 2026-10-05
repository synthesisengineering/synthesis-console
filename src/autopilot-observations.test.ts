import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OperatorObservations, HelperCustodyError, operatorIndex, operatorObservationBinding, type OperatorResult, type OperatorReader } from "./autopilot.js";
import { fixtureSource, recordedRun } from "./autopilot.test.js";
import { autopilotRoutes } from "./routes/autopilot.js";
const binding=(source:Parameters<OperatorReader>[0],id:string)=>createHash("sha256").update(readFileSync(operatorIndex(source,id))).digest("hex");
const result=():OperatorResult=>({available:true,diagnostic:null,report:{schema_version:1,scope:"READ_ONLY_OPERATOR_VIEW",observed_at:"2026-09-25T10:00:00Z",project:"/fixture",authority_granted:false,runs:[recordedRun()],helper:{path:"/fixture/operator_status.py",sha256:"a".repeat(64),loaded_in_native_session:"UNKNOWN"}}});
const flush=async()=>{for(let i=0;i<6;i++)await Promise.resolve();};
function waiting(){let resolve!:(value:OperatorResult)=>void;let reject!:(reason:unknown)=>void;const promise=new Promise<OperatorResult>((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
test("one pending observation retains its phase, identity and timestamp without repeated work",async()=>{
 const source=fixtureSource(),work=waiting();let calls=0;let phase!:(value:"PENDING_RUNTIME"|"PENDING_READER")=>void;
 const owner=new OperatorObservations((_s,_i,_r,_p,update)=>{calls++;phase=update!;return work.promise;},binding);
 const first=owner.start(source,'alpha');expect(first.observation.state).toBe('PENDING_RUNTIME');expect(first.available).toBe(false);expect(first.report).toBeNull();
 const id=first.observation.id!;phase('PENDING_READER');expect(owner.start(source,'alpha').observation.id).toBe(id);expect(calls).toBe(1);
 expect(owner.observe(id,source,'alpha').observation.state).toBe('PENDING_READER');work.resolve(result());await flush();
 const complete=owner.observe(id,source,'alpha');expect(complete.observation.state).toBe('COMPLETE');expect(complete.report!.observed_at).toBe('2026-09-25T10:00:00Z');expect(complete.observation.started_at).toBe(first.observation.started_at);
 complete.report!.runs[0].revision=999;expect(owner.observe(id,source,'alpha').report!.runs[0].revision).toBe(3);expect(calls).toBe(1);
});
test("two slots bound admission and retired observation IDs cannot relaunch",async()=>{
 const source=fixtureSource(),a=waiting(),b=waiting();let calls=0;
 const owner=new OperatorObservations(()=>{calls++;return calls===1?a.promise:b.promise;},binding);
 const first=owner.start(source,'alpha');const second=owner.start(source,'alpha',undefined,{limit:4});
 expect(owner.start(source,'alpha',undefined,{limit:5}).observation.state).toBe('BUSY');expect(calls).toBe(2);
 a.resolve(result());await flush();const third=owner.start(source,'alpha',undefined,{limit:5});expect(calls).toBe(3);
 expect(owner.observe(first.observation.id!,source,'alpha').observation.state).toBe('UNAVAILABLE');expect(calls).toBe(3);
 expect(owner.observe(second.observation.id!,source,'alpha',undefined,{limit:4}).observation.state).toBe('PENDING_RUNTIME');b.resolve(result());await flush();expect(third.observation.id).not.toBe(first.observation.id);
});
for(const rejected of [false,true])test('unresolved cleanup pins its slot including rejected reader promises '+rejected,async()=>{
 const source=fixtureSource();let calls=0;
 const owner=new OperatorObservations(async()=>{calls++;if(rejected)throw new HelperCustodyError('fixture cleanup unresolved',false);return {available:false,report:null,diagnostic:'fixture cleanup unresolved',cleanupComplete:false};},binding);
 const first=owner.start(source,'alpha');await flush();expect(owner.observe(first.observation.id!,source,'alpha').observation.state).toBe('CLEANUP_UNRESOLVED');
 expect(owner.start(source,'alpha').observation.id).toBe(first.observation.id);expect(calls).toBe(1);
 owner.start(source,'alpha',undefined,{limit:4});await flush();expect(owner.start(source,'alpha',undefined,{limit:5}).observation.state).toBe('BUSY');expect(calls).toBe(2);
});
test("registry changes invalidate pending and completed observations without retry",async()=>{
 const source=fixtureSource(),work=waiting();let calls=0;const owner=new OperatorObservations(()=>{calls++;return work.promise;},binding);
 const first=owner.start(source,'alpha');writeFileSync(join(source.root,'projects/index.yaml'),'projects:\n  - id: alpha\n    name: New name\n');
 expect(owner.observe(first.observation.id!,source,'alpha').observation.state).toBe('REFUSED');expect(owner.start(source,'alpha').observation.state).toBe('REFUSED');expect(calls).toBe(1);
 work.resolve(result());await flush();expect(owner.observe(first.observation.id!,source,'alpha').observation.state).toBe('REFUSED');expect(calls).toBe(1);
});
test("retained helper binding invalidates exact source replacement",async()=>{
 const source=fixtureSource(),work=waiting();const dir=mkdtempSync(join(tmpdir(),'console-observation-helper-'));mkdirSync(join(dir,'scripts'));
 for(const name of ['operator_status.py','run_state.py','autopilot.py'])writeFileSync(join(dir,'scripts',name),'# fixture source\n');
 const prior=process.env.SYNTHESIS_AUTOPILOT_DIR;process.env.SYNTHESIS_AUTOPILOT_DIR=dir;
 try{const owner=new OperatorObservations(()=>work.promise,operatorObservationBinding);const first=owner.start(source,'alpha');expect(first.observation.state).toBe('PENDING_RUNTIME');writeFileSync(join(dir,'scripts/operator_status.py'),'# changed fixture source\n');expect(owner.observe(first.observation.id!,source,'alpha').observation.state).toBe('REFUSED');work.resolve(result());await flush();}
 finally{if(prior===undefined)delete process.env.SYNTHESIS_AUTOPILOT_DIR;else process.env.SYNTHESIS_AUTOPILOT_DIR=prior;}
});
test("failed, conflicting and oversized reports never become empty success",async()=>{
 const source=fixtureSource();
 for(const outcome of [()=>Promise.reject(new Error('private internal detail')),()=>Promise.resolve({available:false,report:null,diagnostic:'Timeout'}),()=>Promise.resolve({available:false,diagnostic:'Project resolution CONFLICT',report:{...result().report!,project:null,runs:[]}}),()=>Promise.resolve({...result(),diagnostic:'x'.repeat(1024*1024+1)})]){
  let calls=0;const owner=new OperatorObservations(()=>{calls++;return outcome();},binding);const first=owner.start(source,'alpha');await flush();const final=owner.observe(first.observation.id!,source,'alpha');expect(final.available).toBe(false);expect(['FAILED','REFUSED']).toContain(final.observation.state);expect(final.authority_granted).toBe(false);expect(final.diagnostic).not.toContain('private internal detail');owner.observe(first.observation.id!,source,'alpha');expect(calls).toBe(1);
 }
});
test("invalid page and foreign observation selectors never invoke a reader",()=>{
 const source=fixtureSource();let calls=0;const owner=new OperatorObservations(async()=>{calls++;return result();},binding);
 expect(owner.start(source,'alpha',undefined,{limit:33}).observation.state).toBe('REFUSED');expect(owner.observe('01990000-0000-7000-8000-000000000099',source,'alpha').observation.state).toBe('UNAVAILABLE');expect(calls).toBe(0);
});
test("isolated loopback status response stays usable while its single reader is unresolved",async()=>{
 const source=fixtureSource(),work=waiting();let calls=0;const app=autopilotRoutes({sources:[source],port:0,demoMode:false},()=>{calls++;return work.promise;},binding);
 const server=Bun.serve({hostname:'127.0.0.1',port:0,fetch:request=>app.fetch(request)});
 try{
  const base='http://127.0.0.1:'+server.port;
  const pending=await fetch(base+'/api/autopilot/fixture/alpha',{signal:AbortSignal.timeout(1000)});expect(pending.status).toBe(202);const body=await pending.json();expect(body.report).toBeNull();expect(body.observation.state).toBe('PENDING_RUNTIME');
  const html=await fetch(base+'/autopilot/fixture/alpha?observation='+body.observation.id,{signal:AbortSignal.timeout(1000)});expect(html.status).toBe(202);expect(await html.text()).toContain('Prepare delegation');expect(calls).toBe(1);
  work.resolve(result());await flush();const complete=await fetch(base+'/api/autopilot/fixture/alpha?observation='+body.observation.id,{signal:AbortSignal.timeout(1000)});expect(complete.status).toBe(200);expect((await complete.json()).report.observed_at).toBe('2026-09-25T10:00:00Z');expect(calls).toBe(1);
 }finally{work.resolve(result());server.stop(true);await flush();}
},3000);
