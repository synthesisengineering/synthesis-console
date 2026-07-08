import { Hono } from "hono";
import type { ConsoleConfig } from "../config.js";
import { layout } from "../views/layout.js";
import { syncView } from "../views/sync.js";
import { activeSources } from "../active-sources.js";
import {
  getSyncStatus,
  refreshDetector,
  runCheckpointNow,
  setQuietAudio,
  isQuietAudio,
} from "../sync.js";

/**
 * Repo-sync routes — the console-as-command-center surface for
 * synthesis-repo-guard v2. Read endpoints render/serve the detector's report
 * files; the two POST mutations (refresh = read-only scan, checkpoint =
 * guarded commit+push) are explicit user actions, consistent with the
 * event-driven-mutation contract.
 */
export function syncRoutes(config: ConsoleConfig) {
  const app = new Hono();

  app.get("/sync", (c) => {
    const status = getSyncStatus();
    const active = activeSources(c, config);
    return c.html(
      layout({
        title: "Repo Sync",
        content: syncView(status),
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/sync",
        demoMode: config.demoMode,
      })
    );
  });

  // Chip + page data. Side effect: kicks a background detector refresh when
  // the report is stale (>5 min) so the chip stays ambient without any timer
  // in this process doing mutation.
  app.get("/api/sync-status", (c) => {
    const s = getSyncStatus();
    return c.json({
      ok: true,
      installed: s.installed,
      quietAudio: s.quietAudio,
      dirtyCount: s.dirtyCount,
      alertCount: s.alertCount,
      generatedAt: s.generatedAt,
      refreshing: s.refreshing,
    });
  });

  app.post("/api/sync/refresh", async (c) => {
    const ok = await refreshDetector();
    return c.json({ ok });
  });

  app.post("/api/sync/checkpoint", async (c) => {
    const r = await runCheckpointNow();
    return c.json(r);
  });

  app.get("/api/quiet-audio", (c) => c.json({ ok: true, quiet: isQuietAudio() }));

  app.post("/api/quiet-audio", (c) => {
    const on = c.req.query("on") === "1";
    const ok = setQuietAudio(on);
    return c.json({ ok, quiet: isQuietAudio() });
  });

  return app;
}
