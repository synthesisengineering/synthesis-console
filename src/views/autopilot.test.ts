import { expect, test } from "bun:test";
import { operatorDetail, operatorLanding, operatorScript } from "./autopilot.js";
import { fixtureSource, recordedRun } from "../autopilot.test.js";
test("untrusted question, source and diagnostics escape HTML and attributes",()=>{
  const run=recordedRun();run.questions[0].reason='</textarea><script>window.pwned=1</script>';run.diagnostics=['<img src=x onerror="pwned()">'];
  const html=operatorDetail({...fixtureSource(),display_name:'<svg onload="pwned()">'},"alpha",{available:true,diagnostic:null,report:{schema_version:1,scope:"READ_ONLY_OPERATOR_VIEW",authority_granted:false,observed_at:"2026-09-25T10:00:00Z",project:"/fixture",helper:{path:"/fixture",sha256:"a".repeat(64),loaded_in_native_session:"UNKNOWN"},runs:[run]}});
  expect(html).not.toContain('<script>window.pwned');expect(html).not.toContain('<svg onload');expect(html).not.toContain('<img src=x');expect(html).toContain('&lt;script&gt;');
});
test("first task takes plain language and no user-authored contract",()=>{
  const html=operatorLanding([]);expect(html).toContain('name="outcome"');expect(html).toContain("Prepare delegation");expect(html).toContain("not submitted");expect(html).not.toContain('name="actor"');
});
test("copy status remains unsubmitted and all controls use delegated events",()=>{
  const script=operatorScript();expect(script).toContain("not submitted or performed");expect(script).toContain("expected_revision:run.revision");expect(script).not.toContain("fetch(");expect(script).not.toContain("onclick=");
});
test("terminal run preserves unfinished input without offering invalid resume or answer",()=>{
  const run={...recordedRun(),status:"cancelled" as const,recorded_status:"cancelled"};
  const html=operatorDetail(fixtureSource(),"alpha",{available:true,diagnostic:null,report:{schema_version:1,scope:"READ_ONLY_OPERATOR_VIEW",authority_granted:false,observed_at:"2026-09-25T10:00:00Z",project:"/fixture",helper:{path:"/fixture",sha256:"a".repeat(64),loaded_in_native_session:"UNKNOWN"},runs:[run]}});
  expect(html).toContain("Unfinished input retained");expect(html).not.toContain('class="ap-answer"');expect(html).not.toContain('data-action="resume"');expect(html).toContain("does not certify their termination");
});
test("question pages expose coverage, safe continuation and causal project selection",()=>{
  const html=operatorDetail(fixtureSource(),'alpha',{available:true,diagnostic:null,report:{schema_version:1,scope:'READ_ONLY_OPERATOR_VIEW',authority_granted:false,
    observed_at:'2026-09-25T10:00:00Z',project:'/fixture/newer',helper:{path:'/fixture',sha256:'a'.repeat(64),loaded_in_native_session:'UNKNOWN'},runs:[recordedRun()],
    pagination:{total:35,offset:0,limit:8,next_cursor:'YWJj==',order:'FILESYSTEM_RECENCY_HINT',questions_scope:'THIS_PAGE_ONLY',inventory_sha256:'a'.repeat(64)},
    resolution:{status:'LOCAL_RECOVERABLE',selected_path:'/fixture/newer',selected_head:'a'.repeat(40),selected_tree:'b'.repeat(40),issues:[],fetch:false,refresh_coordination:false,authority_granted:false}}},true);
  expect(html).toContain('35 retained run(s)');expect(html).toContain('this page only');expect(html).toContain('Older runs and questions');
  expect(html).toContain('/questions?sources=fixture&amp;limit=8');
  expect(html).toContain('LOCAL_RECOVERABLE');expect(html).toContain('/fixture/newer');
});
test("conflicted selection is not rendered as an empty first-task success",()=>{
  const html=operatorDetail(fixtureSource(),'alpha',{available:false,diagnostic:'Project resolution CONFLICT',report:{schema_version:1,scope:'READ_ONLY_OPERATOR_VIEW',authority_granted:false,
    observed_at:'2026-09-25T10:00:00Z',project:null,helper:{path:'/fixture',sha256:'a'.repeat(64),loaded_in_native_session:'UNKNOWN'},runs:[],
    resolution:{status:'CONFLICT',selected_path:null,selected_head:null,selected_tree:null,issues:['unattributed'],fetch:false,refresh_coordination:false,authority_granted:false}}});
  expect(html).toContain('No run state was selected');expect(html).not.toContain('No run journals exist');expect(html).not.toContain('data-action="resume"');
});
