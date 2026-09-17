import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
const root = resolve(import.meta.dir, "..");
const cli = join(root, "bin/synthesis-console");
function fixture() { return mkdtempSync(join(realpathSync(tmpdir()), "console-distribution-")); }
function run(args: string[], home: string) {
  return spawnSync(cli, args, { cwd: home, env: { ...process.env, HOME: home, SYNTHESIS_HOME: home }, encoding: "utf8" });
}
test("CLI help and version are inert from an unrelated directory", () => {
  const home=fixture();
  try {
    for (const arg of ["--help", "--version"]) {
      const r=run([arg],home); expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain(arg === "--help" ? "autostart" : JSON.parse(readFileSync(join(root,"package.json"),"utf8")).version);
      expect(readdirSync(home)).toEqual([]);
    }
    expect(run(["unknown"],home).status).not.toBe(0);
  } finally { rmSync(home,{recursive:true,force:true}); }
});
test("source checkout setup fails closed until a verified core is bundled", () => {
  const home=fixture();
  try {
    const r=run(["setup"],home); expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("core"); expect(readdirSync(home)).toEqual([]);
  } finally { rmSync(home,{recursive:true,force:true}); }
});
test("the announced URL follows actual listener creation", async () => {
  const home = fixture();
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    const observer = join(home, "listen-observer.js");
    writeFileSync(observer, `
const originalServe = Bun.serve.bind(Bun);
let listening = false;
Bun.serve = (...args) => {
  const server = originalServe(...args);
  listening = true;
  return server;
};
const originalLog = console.log.bind(console);
console.log = (...args) => {
  if (args.some(value => String(value).includes("http://localhost:")) && !listening)
    throw new Error("URL announced before listener was created");
  originalLog(...args);
};
`);
    // Observe the actual server constructor without substituting a fake server
    // or delaying the fetch; the URL is a readiness promise to real consumers.
    proc = Bun.spawn([process.execPath, "--preload", observer, join(root, "src/index.ts"), "--demo"], {
      cwd: root, env: { ...process.env, HOME: home, PORT: "19820" }, stdout: "pipe", stderr: "pipe",
    });
    const reader = proc.stdout.getReader();
    let output = "";
    timeout = setTimeout(() => proc?.kill(), 10000);
    while (!output.includes("http://localhost:")) {
      const part = await reader.read();
      if (part.done) break;
      output += new TextDecoder().decode(part.value);
    }
    clearTimeout(timeout);
    reader.releaseLock();
    const port = output.match(/http:\/\/localhost:(\d+)/)?.[1];
    if (!port) throw new Error(output + await new Response(proc.stderr).text());
    const page = await fetch(`http://127.0.0.1:${port}/projects`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Demo");
  } finally {
    clearTimeout(timeout);
    proc?.kill();
    if (proc) await proc.exited;
    rmSync(home, { recursive: true, force: true });
  }
}, 15000);
test("actual demo server serves bundled assets and binds only to loopback", async () => {
  const home=fixture(); let proc: ReturnType<typeof Bun.spawn>|undefined;
  try {
    proc=Bun.spawn([cli,"demo"],{cwd:home,env:{...process.env,HOME:home,PORT:"19780"},stdout:"pipe",stderr:"pipe"});
    const reader=proc.stdout.getReader(); let output="";
    const timeout=setTimeout(()=>proc?.kill(),10000);
    while (!output.includes("http://localhost:")) { const part=await reader.read(); if(part.done) break; output+=new TextDecoder().decode(part.value); }
    clearTimeout(timeout); reader.releaseLock();
    const port=output.match(/http:\/\/localhost:(\d+)/)?.[1]; expect(port,output).toBeDefined();
    const page=await fetch(`http://127.0.0.1:${port}/projects`); expect(page.status).toBe(200);
    expect(await page.text()).toContain("Demo");
    const css=await fetch(`http://127.0.0.1:${port}/style.css`); expect(css.status).toBe(200); expect((await css.text()).length).toBeGreaterThan(100);
    const listener=spawnSync("lsof",["-nP","-iTCP:"+port,"-sTCP:LISTEN"],{encoding:"utf8"});
    if (!listener.error) { expect(listener.stdout).toContain("127.0.0.1:"); expect(listener.stdout).not.toContain("*:"); }
    expect(existsSync(join(home,".synthesis"))).toBe(false);
  } finally { proc?.kill(); if(proc) await proc.exited; rmSync(home,{recursive:true,force:true}); }
},15000);
test("service ownership refuses foreign or edited units", () => {
 const home=fixture(); const target=join(home,"service");
 const helper=join(root,"scripts/service-ownership.ts");
 const operation=(op:string)=>spawnSync(process.execPath,[helper,op,target],{env:{HOME:home,PATH:process.env.PATH},encoding:"utf8"});
 try {
  writeFileSync(target,"foreign"); expect(operation("check").status).not.toBe(0);
  expect(operation("record").status).toBe(0); expect(operation("check").status).toBe(0);
  writeFileSync(target,"edited"); expect(operation("check").status).not.toBe(0);
  expect(readFileSync(target,"utf8")).toBe("edited");
 } finally {rmSync(home,{recursive:true,force:true});}
});
