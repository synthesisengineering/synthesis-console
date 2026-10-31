/**
 * Today (`/`): the home page. Reads the active sources' plans, projects,
 * initiatives and ledgers, and the machine's autopilot records outside demo
 * mode. Program-backed health (sync, context, conformance) and recent
 * conversations load in the page from their existing read-only endpoints,
 * so the page paints without waiting on them.
 */
import { Hono } from "hono";
import { join } from "path";
import type { ConsoleConfig } from "../config.js";
import { displayName, findSource, getPlansPath } from "../config.js";
import { activeSources } from "../active-sources.js";
import { loadProjectsFromSources } from "../parsers/yaml.js";
import { annotateRecency, sortProjects } from "../parsers/recency.js";
import { computePortfolioLanes } from "../parsers/portfolio.js";
import { listLedgers, readLedger } from "../parsers/ledger.js";
import { loadPlansFromSource } from "../parsers/entries.js";
import { readAndRenderPlanForCockpit } from "../parsers/markdown.js";
import { autopilotOverview, autopilotStateDir } from "../autopilot.js";
import { autopilotReadRefusal } from "./autopilot.js";
import { summarizePlan } from "../views/cockpit/summary.js";
import { todayView, type TodayPlan } from "../views/today.js";
import { todayIso } from "../views/ui.js";
import { layout } from "../views/layout.js";

const LIVE = new Set(["active", "new", "ongoing"]);

export function todayRoutes(config: ConsoleConfig, stateDir = autopilotStateDir()) {
  const app = new Hono();

  app.get("/", (c) => {
    const active = activeSources(c, config);
    const now = new Date();
    const today = todayIso(now);

    // Today's plan: the first active source that keeps plans and has one for today.
    const planSources = active.filter((s) => !!getPlansPath(s));
    let todayPlan: TodayPlan | null = null;
    let latestPlan: { href: string; date: string; sourceLabel: string } | null = null;
    for (const src of planSources) {
      const plans = loadPlansFromSource(src);
      const hit = plans.find((p) => p.date === today);
      if (hit && !todayPlan) {
        const bundle = readAndRenderPlanForCockpit(join(getPlansPath(src)!, hit.filename), { editable: false });
        todayPlan = {
          source: src.name,
          sourceLabel: displayName(src),
          date: hit.date,
          href: `/plans/${encodeURIComponent(src.name)}/${hit.date}`,
          mtimeMs: bundle?.mtimeMs ?? now.getTime(),
          summary: bundle ? summarizePlan(bundle.sections, bundle.drafts, bundle.draftsHtml) : null,
        };
      }
      const newest = plans[0];
      if (newest && (!latestPlan || newest.date > latestPlan.date)) {
        latestPlan = { href: `/plans/${encodeURIComponent(src.name)}/${newest.date}`, date: newest.date, sourceLabel: displayName(src) };
      }
    }

    const projects = loadProjectsFromSources(active);
    annotateRecency(projects, config.sources);
    const live = projects.filter((p) => LIVE.has(p.status));
    sortProjects(live, "recent");

    const laneSources = active;
    const lanes = computePortfolioLanes(laneSources).map((lane) => ({
      name: lane.initiative.name,
      href: `/initiatives/${encodeURIComponent(lane.initiative._source)}/${encodeURIComponent(lane.initiative.id)}`,
      health: lane.health,
      memberCount: lane.memberCount,
      tooltip: lane.healthSignals.join("\n"),
    }));
    const order = { critical: 0, warning: 1, healthy: 2, unknown: 3 } as const;
    lanes.sort((a, b) => order[a.health] - order[b.health]);

    const ledgers = active.flatMap((s) => listLedgers(s)).sort((a, b) => b.date.localeCompare(a.date));
    const newest = ledgers[0];
    const ledgerSrc = newest ? findSource(config.sources, newest.sourceName) : undefined;
    const doc = newest && ledgerSrc ? readLedger(ledgerSrc, newest.date) : null;

    // Run records are machine state: never in demo mode, and only under the
    // autopilot routes' own loopback check.
    const runs = config.demoMode || autopilotReadRefusal(c) ? null : autopilotOverview(stateDir, config.sources, active).runs;
    const demoActive = config.demoMode || active.some((s) => s.demo === true);

    const content = todayView({
      now,
      demoMode: config.demoMode,
      demoActive,
      sources: config.sources,
      activeCount: active.length,
      hasPlanSource: planSources.length > 0,
      todayPlan,
      latestPlan,
      projects: live.slice(0, 6),
      projectCounts: {
        live: live.length,
        paused: projects.filter((p) => p.status === "paused").length,
        total: projects.length,
      },
      lanes,
      runs,
      ledger: doc
        ? {
            href: `/ledger/${encodeURIComponent(doc.sourceName)}/${encodeURIComponent(doc.date)}`,
            date: doc.date,
            open: doc.openCounts.actionable + doc.openCounts.decaying + doc.openCounts.delegated,
            decaying: doc.openCounts.decaying,
          }
        : null,
    });

    return c.html(
      layout({
        title: "Today",
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/",
        demoMode: config.demoMode,
      })
    );
  });

  return app;
}
