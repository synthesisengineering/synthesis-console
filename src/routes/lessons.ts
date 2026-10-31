import { Hono } from "hono";
import { join } from "path";
import type { ConsoleConfig, Source } from "../config.js";
import { getLessonsPath, findSource, displayName } from "../config.js";
import { readAndRenderMarkdown } from "../parsers/markdown.js";
import { lessonTitle, loadLessonsFromSource, parseLessonFilename } from "../parsers/entries.js";
import { layout } from "../views/layout.js";
import { sourceGateView, notFoundView } from "../views/source-gate.js";
import { lessonListView, lessonDetailView } from "../views/lesson.js";
import type { LessonEntry } from "../views/lesson.js";
import { escapeHtml, sanitizePathSegment } from "../utils.js";
import { activeSources, isSourceActive } from "../active-sources.js";

export function lessonRoutes(config: ConsoleConfig) {
  const app = new Hono();

  app.get("/lessons", (c) => {
    const active = activeSources(c, config);
    const all: LessonEntry[] = [];
    for (const src of active) {
      all.push(...loadLessonsFromSource(src));
    }
    all.sort((a, b) => b.date.localeCompare(a.date));

    // ?q= filters by title on the server too, so a palette deep link or a
    // bookmark opens already filtered; the page then filters as you type.
    const query = (c.req.query("q") ?? "").slice(0, 200);
    const q = query.trim().toLowerCase();
    const lessons = q ? all.filter((l) => l.title.toLowerCase().includes(q)) : all;

    const content = lessonListView({
      lessons,
      sources: active,
      query,
      total: all.length,
    });

    return c.html(
      layout({
        title: "Lessons",
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/lessons",
        demoMode: config.demoMode,
      })
    );
  });

  app.get("/lessons/:source/:slug", (c) => {
    const active = activeSources(c, config);
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const slug = sanitizePathSegment(c.req.param("slug"));

    if (!sourceName || !slug) {
      return notFound(c, config, active, "Not found.");
    }

    const src = findSource(config.sources, sourceName);
    if (!src) return notFound(c, config, active, `Source "${escapeHtml(sourceName)}" not found.`);

    if (!isSourceActive(c, config, src.name)) {
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

    const lessonsDir = getLessonsPath(src);
    if (!lessonsDir) {
      return notFound(c, config, active, `Source "${escapeHtml(sourceName)}" does not provide lessons.`);
    }

    const filePath = join(lessonsDir, `${slug}.md`);
    const contentHtml = readAndRenderMarkdown(filePath);
    if (!contentHtml) {
      return notFound(c, config, active, `Lesson not found.`);
    }

    const parsed = parseLessonFilename(`${slug}.md`);
    const lesson: LessonEntry = parsed
      ? { ...parsed, title: lessonTitle(filePath, parsed.title), source: src.name }
      : { slug, filename: `${slug}.md`, date: "", title: lessonTitle(filePath, slug), source: src.name };

    const content = lessonDetailView({ lesson, contentHtml, sourceLabel: displayName(src) });

    return c.html(
      layout({
        title: lesson.title,
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: `/lessons/${src.name}/${slug}`,
        demoMode: config.demoMode,
        crumbs: [{ label: "Lessons", href: "/lessons" }, { label: lesson.title }],
      })
    );
  });

  return app;
}

function notFound(
  c: import("hono").Context,
  config: ConsoleConfig,
  active: Source[],
  message: string
) {
  return c.html(
    layout({
      title: "Not found",
      content: notFoundView({ messageHtml: message, backHref: "/lessons", backLabel: "Back to lessons" }),
      sources: config.sources,
      activeSourceNames: active.map((s) => s.name),
      currentPath: "/lessons",
      demoMode: config.demoMode,
    }),
    404
  );
}
