/**
 * People + prep-pack routes (v0.13+).
 *
 *   GET /people              — commitments view derived across active sources
 *   GET /prep/:source/:slug  — one meeting-prep pack, rendered
 *
 * Both are read-only. People has no write-back by design: every fact it
 * shows lives in a plan, draft, calendar section, or prep file — edit
 * those (or let the rituals do it) and the view follows.
 */
import { Hono } from "hono";
import type { ConsoleConfig } from "../config.js";
import { findSource, displayName } from "../config.js";
import { computePeople } from "../parsers/people.js";
import { readPrepPack } from "../parsers/prep-pack.js";
import { renderMarkdown } from "../parsers/markdown.js";
import { layout } from "../views/layout.js";
import { sourceGateView, notFoundView } from "../views/source-gate.js";
import { peopleView } from "../views/people.js";
import { prepView } from "../views/prep.js";
import { sanitizePathSegment } from "../utils.js";
import { activeSources, isSourceActive } from "../active-sources.js";

const PEOPLE_WINDOW_DAYS = 30;

export function peopleRoutes(config: ConsoleConfig): Hono {
  const app = new Hono();

  app.get("/people", (c) => {
    const active = activeSources(c, config);
    const people = computePeople(active, PEOPLE_WINDOW_DAYS);
    return c.html(
      layout({
        title: "People",
        content: peopleView({ people, windowDays: PEOPLE_WINDOW_DAYS }),
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/people",
        demoMode: config.demoMode,
      })
    );
  });

  app.get("/prep/:source/:slug", (c) => {
    const active = activeSources(c, config);
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const slug = sanitizePathSegment(c.req.param("slug"));
    if (!sourceName || !slug) {
      return c.html(
        layout({
          title: "Not found",
          content: notFoundView({ message: "That is not a prep pack address.", backHref: "/people", backLabel: "Back to People" }),
          sources: config.sources,
          activeSourceNames: active.map((s) => s.name),
          demoMode: config.demoMode,
        }),
        404
      );
    }
    const src = findSource(config.sources, sourceName);
    if (src && !isSourceActive(c, config, src.name)) {
      return c.html(
        layout({
          title: "Source not active",
          content: sourceGateView({ sourceName: src.name, currentPath: c.req.path, activeNames: active.map((s) => s.name) }),
          sources: config.sources,
          activeSourceNames: active.map((s) => s.name),
          demoMode: config.demoMode,
        }),
        404
      );
    }
    const pack = src ? readPrepPack(src, slug) : null;
    if (!pack) {
      return c.html(
        layout({
          title: "Not found",
          content: notFoundView({ message: "No prep pack with that name in this source.", backHref: "/people", backLabel: "Back to People" }),
          sources: config.sources,
          activeSourceNames: active.map((s) => s.name),
          demoMode: config.demoMode,
        }),
        404
      );
    }
    return c.html(
      layout({
        title: `Prep — ${pack.entry.title}`,
        content: prepView({ entry: pack.entry, contentHtml: renderMarkdown(pack.raw), sourceLabel: src ? displayName(src) : sourceName }),
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: `/prep/${sourceName}/${slug}`,
        demoMode: config.demoMode,
        crumbs: [
          { label: "People", href: "/people" },
          { label: `Plan ${pack.entry.date}`, href: `/plans/${encodeURIComponent(pack.entry.sourceName)}/${encodeURIComponent(pack.entry.date)}` },
          { label: pack.entry.title },
        ],
      })
    );
  });

  return app;
}
