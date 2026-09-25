import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boundedCommand, operatorProject, operatorProjects, safeSegment, prepareControl, type OperatorRun } from "./autopilot.js";

export function fixtureSource() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "a11-console-source-")));
  mkdirSync(join(root, "projects/alpha"), {recursive:true});
  writeFileSync(join(root, "projects/index.yaml"), "projects:\n  - id: alpha\n    name: Visible project\n    status: active\n");
  return {name:"fixture",root,projects_dir:"projects",default_active:true};
}
export function recordedRun(): OperatorRun {
  return {run_id:"01990000-0000-7000-8000-000000000031",project_id:"alpha",revision:3,journal_head:"a".repeat(64),status:"waiting",recorded_status:"waiting_user",currentness:"JOURNAL_VERIFIED_RECORDED_STATE",authority_granted:false,current_acceptance:"UNKNOWN",questions:[{id:"choice",kind:"user",reason:"Choose safely"}],diagnostics:[]};
}
describe("operator boundaries", () => {
  for (const value of ["../private","..","/root","a/b","a\\b","%2froot","", "a\u0000b"]) test(`reject segment ${JSON.stringify(value)}`, () => expect(safeSegment(value)).toBe(false));
  test("only registered contained project paths", () => {
    const source=fixtureSource(); expect(operatorProject(source,"alpha")).toBe(join(source.root,"projects/alpha"));
    expect(() => operatorProject(source,"foreign")).toThrow();
    expect(operatorProjects(source)).toEqual([{id:"alpha",name:"Visible project"}]);
  });
  test("symlink registry is refused before reading", () => {
    const source=fixtureSource(); const link=join(source.root,"linked"); symlinkSync(join(source.root,"projects"),link);
    expect(() => operatorProjects({...source,projects_dir:"linked"})).toThrow();
  });
  test("source escape and oversized registry refused", () => {
    const source=fixtureSource(); expect(() => operatorProjects({...source,projects_dir:"../"})).toThrow();
    writeFileSync(join(source.root,"projects/index.yaml"), "x".repeat(1024*1024+1)); expect(() => operatorProjects(source)).toThrow();
  });
  test("bounded command terminates stall and output flood", async () => {
    await expect(boundedCommand(process.execPath,["-e","setTimeout(()=>{},5000)"],30)).rejects.toThrow();
    await expect(boundedCommand(process.execPath,["-e","process.stdout.write('x'.repeat(2*1024*1024))"])).rejects.toThrow();
  });
  test("argument vector does not execute shell metacharacters", async () => {
    const literal="$(touch /private/tmp/a11-no-shell-marker)";
    const value=await boundedCommand(process.execPath,["-e","process.stdout.write(process.argv[1])",literal]);
    expect(value).toBe(literal);
  });
  test("exact prepared controls have CAS and no actor or authority", () => {
    const run=recordedRun(), id="01990000-0000-7000-8000-000000000041";
    const cancel=prepareControl(run,"cancel","User cancellation",id);
    expect(cancel.operation).toBe("cancel"); expect(cancel.expected_revision).toBe(3);
    expect(Object.keys(cancel)).not.toContain("actor");
    expect(prepareControl(run,"resume","Resume existing work",id).input).toEqual({reconcile_sources:true});
    expect(() => prepareControl({...run,currentness:"UNVERIFIABLE"},"cancel","x",id)).toThrow();
  });
});
