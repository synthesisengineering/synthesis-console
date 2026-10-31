import { Hono } from "hono";
import { serveStatic } from "hono/bun";
import { createServer } from "net";
import { loadConfig, displayName } from "./config.js";
import { projectRoutes } from "./routes/projects.js";
import { initiativeRoutes } from "./routes/initiatives.js";
import { lessonRoutes } from "./routes/lessons.js";
import { planRoutes } from "./routes/plans.js";
import { peopleRoutes } from "./routes/people.js";
import { ledgerRoutes } from "./routes/ledger.js";
import { syncRoutes } from "./routes/sync.js";
import { contextIntegrityRoutes } from "./routes/context-integrity.js";
import { conformanceRoutes } from "./routes/conformance.js";
import { conversationRoutes } from "./routes/conversations.js";
import { autopilotRoutes } from "./routes/autopilot.js";
import { todayRoutes } from "./routes/today.js";
import { paletteRoutes } from "./routes/palette.js";
import { layout } from "./views/layout.js";
import { notFoundView } from "./views/source-gate.js";
import { activeSources } from "./active-sources.js";
import pkg from "../package.json";

const args = process.argv.slice(2);
const isDemoFlag = args.includes("--demo");

const config = loadConfig({ demo: isDemoFlag });

if (config.sources.length === 0) {
  console.error(
    "No sources configured and demo data not available. Create ~/.synthesis/console.yaml."
  );
  process.exit(1);
}

const app = new Hono();

// Disable browser caching for all dynamic responses.
//
// The console reads files from disk on every request — by design, this is a
// local tool whose only job is to reflect the current state of source files.
// Any browser cache is by definition stale. Plans, projects, and lessons all
// change throughout the day (manual edits, daily-rituals, slack-sync, etc.);
// even a few seconds of cached HTML can cause the user to act on obsolete
// information. Force-reload should not be required to see fresh data.
//
// Static assets (the stylesheet, the client script and the favicon) ship
// from disk via serveStatic. They change only with an upgrade; the page
// requests them with ?v=<version>, and "no-cache" makes the browser
// revalidate, so an upgraded Console never paints with a stale stylesheet.
const STATIC_ASSETS = new Set(["/style.css", "/app.js", "/favicon.svg"]);
app.use("*", async (c, next) => {
  await next();
  if (STATIC_ASSETS.has(c.req.path)) {
    c.res.headers.set("Cache-Control", "no-cache");
    return;
  }
  c.res.headers.set("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  c.res.headers.set("Pragma", "no-cache");
  c.res.headers.set("Expires", "0");
});

for (const asset of STATIC_ASSETS) app.use(asset, serveStatic({ root: "./public" }));

app.route("/", todayRoutes(config));
app.route("/", paletteRoutes(config));
app.route("/", projectRoutes(config));
app.route("/", autopilotRoutes(config));
app.route("/", initiativeRoutes(config));
app.route("/", lessonRoutes(config));
app.route("/", planRoutes(config));
app.route("/", peopleRoutes(config));
app.route("/", ledgerRoutes(config));
// A sample-data process must not expose or mutate the host's machine-wide
// diagnostics, repository state or quiet-audio preference through direct URLs.
if (!config.demoMode) {
  app.route("/", syncRoutes(config));
  app.route("/", contextIntegrityRoutes(config));
  app.route("/", conformanceRoutes(config));
  app.route("/", conversationRoutes(config));
}

app.notFound((c) => {
  const active = activeSources(c, config);
  return c.html(
    layout({
      title: "Not found",
      content: notFoundView({ message: "There is no page at this address." }),
      sources: config.sources,
      activeSourceNames: active.map((s) => s.name),
      demoMode: config.demoMode,
    }),
    404
  );
});

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function findAvailablePort(preferred: number): Promise<number> {
  for (let port = preferred; port < preferred + 20; port++) {
    if (await isPortAvailable(port)) return port;
  }
  return 0;
}

const envPort = process.env.PORT ? parseInt(process.env.PORT, 10) : undefined;
const preferredPort = envPort && Number.isFinite(envPort) ? envPort : config.port;
const port = await findAvailablePort(preferredPort);
if (!port) throw new Error("No available loopback port in the configured range.");

// Bind before announcing readiness. Bun's automatic default-export listener
// starts after module evaluation, which let consumers reach the URL too early.
const server = Bun.serve({
  hostname: "127.0.0.1",
  port,
  fetch: app.fetch,
});
let stopping = false;
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143], ["SIGHUP", 129]] as const) {
  process.on(signal, () => {
    if (stopping) return;
    stopping = true;
    server.stop(true);
    process.exit(code);
  });
}

if (port !== preferredPort) {
  console.log(`  Port ${preferredPort} is in use, using ${port} instead.\n`);
}

const modeLabel = config.demoMode ? " [DEMO ONLY]" : "";
const defaultActiveNames = config.sources
  .filter((s) => s.default_active)
  .map((s) => displayName(s))
  .join(", ") || "none (first source used)";

console.log(`  Synthesis Console v${pkg.version}${modeLabel}
  ========================
  http://localhost:${server.port}
  Sources:          ${config.sources.map((s) => displayName(s)).join(", ")}
  Default-active:   ${defaultActiveNames}
`);
