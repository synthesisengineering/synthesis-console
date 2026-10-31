/**
 * Capture Console screenshots with a local headless Chrome.
 *
 *   bun run scripts/capture-screenshots.ts --base http://localhost:5555 --out screenshots \
 *     [--modes light,dark,phone] [--full] [--only name,name] [--readme]
 *
 * Chrome comes from SYNTHESIS_TEST_CHROMIUM (the same variable the browser
 * accessibility test reads). Run it against `bun run demo` for README images.
 * `--readme` writes the README set (light, 1440 wide) under the names
 * screenshots/REGENERATE.md lists; otherwise every view is written as
 * <name>-<mode>.png. A development tool only: nothing at runtime uses it.
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

interface View {
  name: string;
  path: string;
  /** README file name, when the view is part of the README set. */
  readme?: string;
}

const VIEWS: View[] = [
  { name: "today", path: "/", readme: "today.png" },
  { name: "projects", path: "/projects", readme: "dashboard.png" },
  { name: "projects-active", path: "/projects?status=active&group=status", readme: "filtered.png" },
  { name: "project-detail", path: "/projects/demo/synthesis-console", readme: "project-detail.png" },
  { name: "initiatives", path: "/initiatives", readme: "initiatives.png" },
  { name: "initiative-detail", path: "/initiatives/demo/developer-experience" },
  { name: "lessons", path: "/lessons", readme: "lessons.png" },
  { name: "lesson-detail", path: "/lessons/demo/2026-04-12-demo-mode-as-standard-practice" },
  { name: "plans", path: "/plans", readme: "plans-calendar.png" },
  { name: "plan-cockpit", path: "/plans/demo/2026-07-06", readme: "plan-detail.png" },
  { name: "plan-legacy", path: "/plans/demo/2026-04-29" },
  { name: "rollover", path: "/plans/demo/rollover?days=1" },
  { name: "people", path: "/people", readme: "people.png" },
  { name: "prep", path: "/prep/demo/2026-07-06-1500-jessica-payne-1-1" },
  { name: "ledger", path: "/ledger", readme: "ledger.png" },
  { name: "autopilot", path: "/autopilot" },
  { name: "not-found", path: "/no-such-page" },
];

/** Views that only exist outside demo mode; captured with --live. */
const LIVE_VIEWS: View[] = [
  { name: "conformance", path: "/conformance" },
  { name: "context", path: "/context" },
  { name: "sync", path: "/sync" },
  { name: "conversations", path: "/conversations" },
];

type Mode = "light" | "dark" | "phone";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

const base = (arg("base") ?? "http://localhost:5555").replace(/\/$/, "");
const out = resolve(arg("out") ?? "screenshots");
const readme = flag("readme");
const full = flag("full");
const modes = (readme ? ["light"] : (arg("modes") ?? "light,dark,phone").split(",")) as Mode[];
const only = arg("only")?.split(",");
const views = (flag("live") ? [...VIEWS.filter((v) => v.name === "today"), ...LIVE_VIEWS] : VIEWS)
  .filter((v) => (readme ? !!v.readme : true))
  .filter((v) => !only || only.includes(v.name));

const chrome = process.env.SYNTHESIS_TEST_CHROMIUM;
if (!chrome) {
  console.error("Set SYNTHESIS_TEST_CHROMIUM to a Chrome or Chromium binary.");
  process.exit(2);
}
mkdirSync(out, { recursive: true });

const profile = mkdtempSync(join(tmpdir(), "console-capture-"));
const child = spawn(
  chrome,
  ["--headless", "--remote-debugging-pipe", "--disable-background-networking", "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--hide-scrollbars", `--user-data-dir=${join(profile, "p")}`],
  { stdio: ["ignore", "ignore", "pipe", "pipe", "pipe"] },
);

const pending = new Map<number, { resolve: (x: any) => void; reject: (e: Error) => void }>();
let nextId = 1;
let raw = "";
(child.stdio[4] as any).on("data", (b: Buffer) => {
  raw += b.toString();
  for (;;) {
    const end = raw.indexOf("\0");
    if (end < 0) break;
    const row = JSON.parse(raw.slice(0, end));
    raw = raw.slice(end + 1);
    if (!row.id) continue;
    const waiter = pending.get(row.id);
    pending.delete(row.id);
    row.error ? waiter?.reject(Error(JSON.stringify(row.error))) : waiter?.resolve(row.result);
  }
});

function call(method: string, params: any = {}, sessionId?: string): Promise<any> {
  return new Promise((resolvePromise, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolvePromise, reject });
    (child.stdio[3] as any).write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + "\0");
  });
}

async function capture(view: View, mode: Mode): Promise<string> {
  const { targetId } = await call("Target.createTarget", { url: "about:blank" });
  const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
  const width = mode === "phone" ? 390 : 1440;
  const height = mode === "phone" ? 844 : 900;
  await call("Page.enable", {}, sessionId);
  await call("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: mode === "phone" ? 2 : 1, mobile: mode === "phone" }, sessionId);
  await call("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: mode === "dark" ? "dark" : "light" }, { name: "prefers-reduced-motion", value: "reduce" }] }, sessionId);
  await call("Page.navigate", { url: base + view.path }, sessionId);
  for (let i = 0; i < 200; i++) {
    const r = await call("Runtime.evaluate", { expression: 'document.readyState === "complete"', returnByValue: true }, sessionId);
    if (r.result.value) break;
    await Bun.sleep(25);
  }
  // Let the page's own fetches (status dots, recent conversations) settle.
  await Bun.sleep(view.name === "today" || LIVE_VIEWS.includes(view) ? 2500 : 400);
  let clip: any;
  if (full && !readme) {
    const metrics = await call("Page.getLayoutMetrics", {}, sessionId);
    const contentHeight = Math.ceil(metrics.cssContentSize?.height ?? height);
    await call("Emulation.setDeviceMetricsOverride", { width, height: Math.min(contentHeight, 12000), deviceScaleFactor: mode === "phone" ? 2 : 1, mobile: mode === "phone" }, sessionId);
    await Bun.sleep(150);
    clip = { x: 0, y: 0, width, height: Math.min(contentHeight, 12000), scale: 1 };
  }
  const shot = await call("Page.captureScreenshot", { format: "png", captureBeyondViewport: !!clip, ...(clip ? { clip } : {}) }, sessionId);
  const file = join(out, readme && view.readme ? view.readme : `${view.name}-${mode}.png`);
  writeFileSync(file, Buffer.from(shot.data, "base64"));
  await call("Target.closeTarget", { targetId });
  return file;
}

try {
  for (const view of views) {
    for (const mode of modes) {
      const file = await capture(view, mode);
      console.log(file);
    }
  }
} finally {
  child.kill("SIGKILL");
  rmSync(profile, { recursive: true, force: true });
}
