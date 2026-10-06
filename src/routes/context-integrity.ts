import { Hono } from "hono";
import type { ConsoleConfig, Source } from "../config.js";
import { layout } from "../views/layout.js";
import { contextIntegrityView } from "../views/context-integrity.js";
import { activeSources } from "../active-sources.js";
import {
  getContextIntegrityStatus,
  type ContextIntegrityStatus,
} from "../context-integrity.js";

export type ContextStatusReader = (sources: Source[], force?: boolean) => Promise<ContextIntegrityStatus>;

/**
 * Context-integrity routes: the v5 context doctor over the request's active
 * sources. The doctor only reads; the POST starts fresh runs instead of using
 * the kept results.
 */
export function contextIntegrityRoutes(config: ConsoleConfig, read: ContextStatusReader = getContextIntegrityStatus) {
  const app = new Hono();

  app.get("/context", async (c) => {
    const active = activeSources(c, config);
    const status = await read(active);
    return c.html(
      layout({
        title: "Context Integrity",
        content: contextIntegrityView(status),
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/context",
        demoMode: config.demoMode,
      })
    );
  });

  app.get("/api/context-status", async (c) => {
    const s = await read(activeSources(c, config));
    const checked = s.audits.map((audit) => audit.checkedAt).filter((at): at is string => at !== null).sort();
    return c.json({
      ok: true,
      doctorAvailable: s.doctorAvailable,
      defects: s.doctorAvailable && s.audits.length ? s.totals.defects : null,
      warnings: s.doctorAvailable && s.audits.length ? s.totals.warnings : null,
      projects: s.totals.projects,
      failedSources: s.totals.failedSources,
      checkedAt: checked[0] ?? null,
      sources: s.audits.map((audit) => ({
        source: audit.source,
        knowledgeRoot: audit.knowledgeRoot,
        projectsAudited: audit.report?.projects_audited ?? null,
        defects: audit.report?.defects ?? null,
        warnings: audit.report?.warnings ?? null,
        error: audit.error,
        checkedAt: audit.checkedAt,
      })),
    });
  });

  app.post("/api/context/refresh", async (c) => {
    const s = await read(activeSources(c, config), true);
    return c.json({ ok: s.doctorAvailable, failedSources: s.totals.failedSources });
  });

  return app;
}
