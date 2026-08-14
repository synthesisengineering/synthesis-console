import { Hono } from "hono";
import type { ConsoleConfig } from "../config.js";
import { activeSources } from "../active-sources.js";
import {
  getAgentConformanceStatus,
  runConformanceNow,
} from "../agent-conformance.js";
import { layout } from "../views/layout.js";
import { agentConformanceView } from "../views/agent-conformance.js";

export function agentConformanceRoutes(config: ConsoleConfig) {
  const app = new Hono();

  app.get("/conformance", (c) => {
    const active = activeSources(c, config);
    return c.html(
      layout({
        title: "Agent Conformance",
        content: agentConformanceView(getAgentConformanceStatus()),
        sources: config.sources,
        activeSourceNames: active.map((source) => source.name),
        currentPath: "/conformance",
        demoMode: config.demoMode,
        wide: true,
      })
    );
  });

  app.get("/api/conformance-status", (c) => {
    const status = getAgentConformanceStatus();
    const requiredFailures = (status.report?.checks ?? []).filter(
      (check) => check.required && check.status !== "PASS"
    ).length;
    return c.json({
      ok: true,
      conformanceAvailable: status.conformanceAvailable,
      status: status.report?.status ?? null,
      requiredFailures,
      checkedAt: status.report?.checked_at ?? null,
      stale: status.stale,
      auditing: status.auditing,
      auditError: status.auditError,
    });
  });

  app.post("/api/conformance/audit", (c) =>
    c.json({ ok: runConformanceNow() })
  );

  return app;
}
