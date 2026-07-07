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
import { findSource } from "../config.js";
import { computePeople } from "../parsers/people.js";
import { readPrepPack } from "../parsers/prep-pack.js";
import { renderMarkdown } from "../parsers/markdown.js";
import { layout } from "../views/layout.js";
import { peopleView } from "../views/people.js";
import { prepView } from "../views/prep.js";
import { sanitizePathSegment } from "../utils.js";
import { activeSources } from "../active-sources.js";

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
          title: "Not Found",
          content: `<h1>404</h1><p>Invalid prep pack path.</p>`,
          sources: config.sources,
          activeSourceNames: active.map((s) => s.name),
          demoMode: config.demoMode,
        }),
        404
      );
    }
    const src = findSource(config.sources, sourceName);
    const pack = src ? readPrepPack(src, slug) : null;
    if (!pack) {
      return c.html(
        layout({
          title: "Not Found",
          content: `<h1>404</h1><p>Prep pack not found.</p><p><a href="/people">Back to People</a></p>`,
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
        content: prepView({ entry: pack.entry, contentHtml: renderMarkdown(pack.raw) }),
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: `/prep/${sourceName}/${slug}`,
        demoMode: config.demoMode,
      })
    );
  });

  return app;
}
