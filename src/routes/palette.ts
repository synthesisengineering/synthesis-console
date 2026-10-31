/**
 * `/api/palette`: what the command palette searches. Projects, initiatives,
 * lessons and recent plans from the request's ACTIVE sources only, the same
 * union the list pages show, so the palette never reaches past the source
 * picker (and in demo mode, never past the demo source). Read-only.
 */
import { Hono } from "hono";
import type { ConsoleConfig } from "../config.js";
import { displayName, findSource } from "../config.js";
import { activeSources } from "../active-sources.js";
import { loadInitiativesFromSources, loadProjectsFromSources } from "../parsers/yaml.js";
import { annotateRecency, sortProjects } from "../parsers/recency.js";
import { loadLessonsFromSource, loadPlansFromSource } from "../parsers/entries.js";
import { longDate, todayIso } from "../views/ui.js";

export function paletteRoutes(config: ConsoleConfig) {
  const app = new Hono();

  app.get("/api/palette", (c) => {
    const active = activeSources(c, config);
    const label = (name: string) => {
      const src = findSource(config.sources, name);
      return src ? displayName(src) : name;
    };

    const projects = loadProjectsFromSources(active);
    annotateRecency(projects, config.sources);
    sortProjects(projects, "recent");

    const plans = active
      .flatMap((s) => loadPlansFromSource(s))
      .sort((a, b) => b.date.localeCompare(a.date));
    const today = todayIso();
    const todayPlan = plans.find((p) => p.date === today);
    const toPlan = (p: (typeof plans)[number]) => ({
      date: p.date,
      label: longDate(p.date, true),
      source: p.source,
      sourceLabel: label(p.source),
      href: `/plans/${encodeURIComponent(p.source)}/${p.date}`,
    });

    return c.json({
      ok: true,
      projects: projects.slice(0, 400).map((p) => ({
        id: p.id,
        name: p.name,
        status: p.status,
        tags: p.tags ?? [],
        source: p._source,
        sourceLabel: label(p._source),
        href: `/projects/${encodeURIComponent(p._source)}/${encodeURIComponent(p.id)}`,
      })),
      initiatives: loadInitiativesFromSources(active).map((i) => ({
        name: i.name,
        source: i._source,
        sourceLabel: label(i._source),
        href: `/initiatives/${encodeURIComponent(i._source)}/${encodeURIComponent(i.id)}`,
      })),
      lessons: active
        .flatMap((s) => loadLessonsFromSource(s))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 400)
        .map((l) => ({
          title: l.title,
          date: l.date,
          href: `/lessons/${encodeURIComponent(l.source)}/${encodeURIComponent(l.slug)}`,
        })),
      plans: plans.slice(0, 60).map(toPlan),
      todayPlan: todayPlan ? toPlan(todayPlan) : null,
      latestPlan: plans[0] ? toPlan(plans[0]) : null,
    });
  });

  return app;
}
