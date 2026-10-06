import { Hono } from "hono";
import type { ConsoleConfig } from "../config.js";
import { layout } from "../views/layout.js";
import { syncView } from "../views/sync.js";
import { activeSources } from "../active-sources.js";
import { RepoGuard } from "../sync.js";

/**
 * Repo-sync routes over the v5 repo guard. Reads render the scan's report;
 * the scan itself only reads repositories, so a stale report refreshes on
 * request. The one setting the console changes is the quiet-audio flag, by
 * explicit click.
 */
export function syncRoutes(config: ConsoleConfig, guard = new RepoGuard()) {
  const app = new Hono();

  app.get("/sync", (c) => {
    const active = activeSources(c, config);
    return c.html(
      layout({
        title: "Repo Sync",
        content: syncView(guard.status()),
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/sync",
        demoMode: config.demoMode,
      })
    );
  });

  // Chip and page data. Starts a background scan when the report is stale.
  app.get("/api/sync-status", (c) => {
    const s = guard.status();
    return c.json({
      ok: true,
      installed: s.installed,
      quietAudio: s.quietAudio,
      dirtyCount: s.dirtyCount,
      totalRepos: s.report?.total_repos ?? null,
      generatedAt: s.generatedAt,
      refreshing: s.refreshing,
      error: s.error,
    });
  });

  app.post("/api/sync/refresh", async (c) => c.json({ ok: await guard.refresh() }));

  app.get("/api/quiet-audio", (c) => c.json({ ok: true, quiet: guard.isQuietAudio() }));

  app.post("/api/quiet-audio", (c) => {
    const ok = guard.setQuietAudio(c.req.query("on") === "1");
    return c.json({ ok, quiet: guard.isQuietAudio() });
  });

  return app;
}
