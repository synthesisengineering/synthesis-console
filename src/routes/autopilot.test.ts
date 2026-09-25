import { expect, test } from "bun:test";
import { autopilotRoutes } from "./autopilot.js";
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
