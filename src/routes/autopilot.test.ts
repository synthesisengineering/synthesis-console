import { expect, test } from "bun:test";
import { autopilotRoutes as createAutopilotRoutes } from "./autopilot.js";
import type { ConsoleConfig } from "../config.js";
import { operatorIndex, type OperatorReader } from "../autopilot.js";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
const binding=(source:Parameters<OperatorReader>[0],id:string)=>createHash("sha256").update(readFileSync(operatorIndex(source,id))).digest("hex");
const autopilotRoutes=(config:ConsoleConfig,reader:OperatorReader)=>createAutopilotRoutes(config,reader,binding);
import { fixtureSource, recordedRun } from "../autopilot.test.js";
import type { OperatorResult } from "../autopilot.js";
const result:OperatorResult={available:true,diagnostic:null,report:{schema_version:1,scope:"READ_ONLY_OPERATOR_VIEW",observed_at:"2026-09-25T10:00:00Z",project:"/fixture",authority_granted:false,runs:[recordedRun()],helper:{path:"/fixture/operator_status.py",sha256:"a".repeat(64),loaded_in_native_session:"UNKNOWN"}}};
test("inactive source is denied before any helper call for every surface", async () => {
  const source=fixtureSource(); let calls=0;
  const app=autopilotRoutes({sources:[source,{...source,name:"other",default_active:false}],port:1,demoMode:false},async()=>{calls++;return result;});
  for(const route of ["/autopilot/other/alpha","/autopilot/other/alpha/questions","/autopilot/other/alpha/runs/01990000-0000-7000-8000-000000000031","/api/autopilot/other/alpha"]) {
    expect((await app.request(route+"?sources=fixture")).status).toBe(404);
  }
  expect(calls).toBe(0);
  const active=await app.request("/api/autopilot/fixture/alpha?sources=fixture");expect(active.status).toBe(200);expect(calls).toBe(1);expect(active.headers.get("cache-control")).toBe("no-store");
});
test("fallback reads durable question; mutation routes do not exist", async () => {
  const app=autopilotRoutes({sources:[fixtureSource()],port:1,demoMode:false},async()=>result);
  const response=await app.request("/autopilot/fixture/alpha/questions"); const html=await response.text();
  expect(response.status).toBe(200);expect(html).toContain("Choose safely");expect(html).toContain("not submitted");
  expect((await app.request("/api/autopilot/fixture/alpha",{method:"POST",body:'{"approve":true}'})).status).toBe(404);
});
test("failed owner read is unhealthy and not empty success",async()=>{
  const app=autopilotRoutes({sources:[fixtureSource()],port:1,demoMode:false},async()=>({available:false,report:null,diagnostic:"Runtime unavailable"}));
  expect((await app.request("/api/autopilot/fixture/alpha")).status).toBe(503);
  expect(await (await app.request("/autopilot/fixture/alpha")).text()).toContain("Runtime unavailable");
});
test("foreign host and origin cannot use a private operator reader",async()=>{
  let calls=0;const app=autopilotRoutes({sources:[fixtureSource()],port:1,demoMode:false},async()=>{calls++;return result;});
  expect((await app.request("http://evil.example/api/autopilot/fixture/alpha")).status).toBe(421);
  expect((await app.request("/api/autopilot/fixture/alpha",{headers:{host:"evil.example"}})).status).toBe(421);
  expect((await app.request("/api/autopilot/fixture/alpha",{headers:{origin:"https://evil.example"}})).status).toBe(403);
  expect((await app.request("/api/autopilot/fixture/alpha",{headers:{host:"["}})).status).toBe(421);
  expect(calls).toBe(0);
});
test("pagination is bounded before reading and forwards the exact cursor",async()=>{
  const calls:unknown[]=[];
  const app=autopilotRoutes({sources:[fixtureSource()],port:1,demoMode:false},async(_source,_id,_run,page)=>{calls.push(page);return result;});
  for(const query of ['limit=0','limit=33','limit=NaN','cursor=../escape','cursor='+('x'.repeat(513))]){
    expect((await app.request('/api/autopilot/fixture/alpha?'+query)).status).toBe(400);
  }
  expect(calls.length).toBe(0);
  expect((await app.request('/api/autopilot/fixture/alpha?limit=4&cursor=YWJj')).status).toBe(200);
  expect(calls).toEqual([{limit:4,cursor:'YWJj'}]);
  expect((await app.request('/api/autopilot/fixture/alpha/runs/01990000-0000-7000-8000-000000000031?cursor=YWJj')).status).toBe(400);
});

test("pending HTML and API return before the reader settles and polls share one attempt",async()=>{
  const source=fixtureSource();let calls=0;let complete!:(value:OperatorResult)=>void;
  const waiting=new Promise<OperatorResult>(resolve=>{complete=resolve;});
  const app=autopilotRoutes({sources:[source],port:1,demoMode:false},async()=>{calls++;return waiting;});
  const first=await app.request('/autopilot/fixture/alpha');
  expect(first.status).toBe(202);expect(first.headers.get('cache-control')).toBe('no-store');
  const html=await first.text();expect(html).toContain('Checking project status');expect(html).toContain('Prepare delegation');expect(html).not.toContain('Choose safely');
  const api=await app.request('/api/autopilot/fixture/alpha');const body=await api.json();
  expect(api.status).toBe(202);expect(body.authority_granted).toBe(false);expect(body.report).toBeNull();expect(calls).toBe(1);
  const id=body.observation.id;
  const poll='/api/autopilot/fixture/alpha?observation='+id;
  expect((await app.request(poll)).status).toBe(202);expect(calls).toBe(1);
  complete(result);await Promise.resolve();await Promise.resolve();await Promise.resolve();
  const done=await app.request(poll);expect(done.status).toBe(200);expect((await done.json()).report.observed_at).toBe(result.report!.observed_at);expect(calls).toBe(1);
  const fragment=await app.request('/autopilot/fixture/alpha?observation='+id+'&fragment=1');
  const panel=await fragment.text();expect(panel).toStartWith('<section class="ap-observation"');expect(panel).toContain('Choose safely');expect(panel).not.toContain('<script>');expect(calls).toBe(1);
  expect((await app.request(poll,{headers:{origin:'https://evil.example'}})).status).toBe(403);expect(calls).toBe(1);
});
test("observation IDs cannot cross source, run, page or active-source boundaries",async()=>{
  const source=fixtureSource();let calls=0;
  const app=autopilotRoutes({sources:[source,{...source,name:'other',default_active:false}],port:1,demoMode:false},async()=>{calls++;return result;});
  const start=await app.request('/api/autopilot/fixture/alpha?limit=4');const id=(await start.json()).observation.id;
  expect((await app.request('/api/autopilot/fixture/alpha?limit=8&observation='+id)).status).toBe(410);
  expect((await app.request('/api/autopilot/other/alpha?limit=4&observation='+id)).status).toBe(404);
  expect((await app.request('/api/autopilot/other/alpha?sources=other&limit=4&observation='+id)).status).toBe(410);
  expect((await app.request('/api/autopilot/fixture/alpha?observation=bad')).status).toBe(400);
  expect((await app.request('/autopilot/fixture/alpha?fragment=1')).status).toBe(400);
  expect((await app.request('/api/autopilot/fixture/alpha?observation=01990000-0000-7000-8000-000000000099')).status).toBe(410);
  expect(calls).toBe(1);
});
