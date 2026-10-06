import { Hono } from "hono";
import type { ConsoleConfig } from "../config.js";
import { activeSources } from "../active-sources.js";
import { getDoctorStatus, summarizeChecks, type DoctorStatus } from "../doctor.js";
import { layout } from "../views/layout.js";
import { conformanceView } from "../views/conformance.js";

export type DoctorReader = (force?: boolean) => Promise<DoctorStatus>;

/** The page and API over `synthesis doctor --json`. */
export function conformanceRoutes(config: ConsoleConfig, read: DoctorReader = getDoctorStatus) {
  const app = new Hono();

  app.get("/conformance", async (c) => {
    const active = activeSources(c, config);
    return c.html(
      layout({
        title: "Conformance",
        content: conformanceView(await read()),
        sources: config.sources,
        activeSourceNames: active.map((source) => source.name),
        currentPath: "/conformance",
        demoMode: config.demoMode,
        wide: true,
      })
    );
  });

  app.get("/api/conformance-status", async (c) => {
    const status = await read();
    const counts = summarizeChecks(status.report?.checks ?? []);
    return c.json({
      ok: true,
      installed: status.installed,
      healthy: status.report?.healthy ?? null,
      failures: counts.fail,
      warnings: counts.warn,
      counts,
      doctorMs: status.report?.ms ?? null,
      elapsedMs: status.elapsedMs,
      checkedAt: status.checkedAt,
      error: status.error,
      checks: status.report?.checks ?? [],
    });
  });

  /** Start a new doctor run now instead of using the kept result. */
  app.post("/api/conformance/refresh", async (c) => {
    const status = await read(true);
    return c.json({ ok: status.installed && status.report !== null, error: status.error });
  });

  return app;
}
