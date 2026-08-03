import { Hono } from "hono";
import type { ConsoleConfig } from "../config.js";
import { layout } from "../views/layout.js";
import { contextIntegrityView } from "../views/context-integrity.js";
import { activeSources } from "../active-sources.js";
import {
  getContextIntegrityStatus,
  runAuditNow,
} from "../context-integrity.js";

/**
 * Context-integrity routes. Reads render the doctor's report cache; the one
 * POST mutation (audit) is an explicit user action per the event-driven
 * mutation contract — never a background timer.
 */
export function contextIntegrityRoutes(config: ConsoleConfig) {
  const app = new Hono();

  app.get("/context", (c) => {
    const status = getContextIntegrityStatus();
    const active = activeSources(c, config);
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

  app.get("/api/context-status", (c) => {
    const s = getContextIntegrityStatus();
    return c.json({
      ok: true,
      doctorAvailable: s.doctorAvailable,
      defects: s.report?.defects ?? null,
      warnings: s.report?.warnings ?? null,
      generatedAt: s.report?.generated_at ?? null,
      auditing: s.auditing,
    });
  });

  app.post("/api/context/audit", (c) => {
    const ok = runAuditNow();
    return c.json({ ok });
  });

  return app;
}
