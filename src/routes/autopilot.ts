import { Hono, type MiddlewareHandler } from "hono";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ConsoleConfig } from "../config.js";
import { activeSources } from "../active-sources.js";
import {
  autopilotOverview,
  autopilotStateDir,
  readRun,
  runVisible,
  SESSION_FILE,
  type AutopilotRun,
} from "../autopilot.js";
import { autopilotDetail, autopilotLanding } from "../views/autopilot.js";
import { layout } from "../views/layout.js";

/** The plan text is served by the detail endpoint only. */
function summary(run: AutopilotRun) {
  const { text: _text, ...rest } = run;
  return rest;
}

function validSession(value: string): boolean {
  return SESSION_FILE.test(value) && value !== "." && value !== "..";
}

/**
 * Autopilot routes over v5's run records. Reads only. In demo mode no machine
 * state is read at all.
 */
export function autopilotRoutes(config: ConsoleConfig, stateDir = autopilotStateDir()) {
  const app = new Hono();
  // Loopback only: a rebinding page on another origin must not read run records.
  const localRead: MiddlewareHandler = async (c, next) => {
    const url = new URL(c.req.url);
    const host = c.req.header("host");
    let hostname: string;
    try {
      hostname = host ? new URL("http://" + host).hostname : url.hostname;
    } catch {
      return c.json({ error: "Invalid host." }, 421);
    }
    if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) {
      return c.json({ error: "Autopilot reads require a loopback host." }, 421);
    }
    const origin = c.req.header("origin");
    if (origin && origin !== url.origin) return c.json({ error: "Cross-origin autopilot reads are refused." }, 403);
    await next();
    c.header("Cache-Control", "no-store");
  };
  for (const path of ["/autopilot", "/autopilot/*", "/api/autopilot", "/api/autopilot/*"]) app.use(path, localRead);

  const overview = (c: Parameters<MiddlewareHandler>[0]) =>
    config.demoMode ? null : autopilotOverview(stateDir, config.sources, activeSources(c, config));

  app.get("/autopilot", (c) => {
    const active = activeSources(c, config);
    return c.html(
      layout({
        title: "Autopilot",
        content: autopilotLanding(overview(c), config.sources),
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/autopilot",
        demoMode: config.demoMode,
      })
    );
  });

  app.get("/api/autopilot", (c) => {
    const view = overview(c);
    if (!view) return c.json({ ok: true, demo: true, runs: [], hiddenRuns: 0 });
    return c.json({
      ok: true,
      stateDir: view.stateDir,
      stateExists: view.stateExists,
      hiddenRuns: view.hiddenRuns,
      runs: view.runs.map(summary),
    });
  });

  /** One run the request may see, or null for a 404. */
  const visibleRun = (c: Parameters<MiddlewareHandler>[0], session: string): AutopilotRun | null => {
    if (config.demoMode || !validSession(session)) return null;
    if (!existsSync(join(stateDir, session + ".json"))) return null;
    const run = readRun(stateDir, session);
    return runVisible(run, config.sources, activeSources(c, config)) ? run : null;
  };

  app.get("/autopilot/run/:session", (c) => {
    const active = activeSources(c, config);
    const run = visibleRun(c, c.req.param("session"));
    const page = (title: string, content: string, status: 200 | 404) =>
      c.html(
        layout({
          title,
          content,
          sources: config.sources,
          activeSourceNames: active.map((s) => s.name),
          currentPath: "/autopilot",
          demoMode: config.demoMode,
        }),
        status
      );
    if (!run) {
      return page(
        "Run not found",
        `<h1>Run not found</h1><p>No autopilot run with that session is recorded for the selected sources.</p><p><a href="/autopilot">← Autopilot</a></p>`,
        404
      );
    }
    return page(run.title ?? "Autopilot run", autopilotDetail(run, config.sources), 200);
  });

  app.get("/api/autopilot/run/:session", (c) => {
    const run = visibleRun(c, c.req.param("session"));
    if (!run) return c.json({ ok: false, error: "No such run for the selected sources." }, 404);
    return c.json({ ok: true, run });
  });

  return app;
}
