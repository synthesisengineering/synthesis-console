import { Hono } from "hono";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { ConsoleConfig, Source } from "../config.js";
import { getLessonsPath, findSource } from "../config.js";
import { readAndRenderMarkdown } from "../parsers/markdown.js";
import { layout } from "../views/layout.js";
import { sourceGateView } from "../views/source-gate.js";
import { lessonListView, lessonDetailView } from "../views/lesson.js";
import type { LessonEntry } from "../views/lesson.js";
import { escapeHtml, sanitizePathSegment } from "../utils.js";
import { activeSources, isSourceActive } from "../active-sources.js";

function parseLessonFilename(filename: string): Omit<LessonEntry, "source"> | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
  if (!match) return null;

  const date = match[1];
  const slug = match[2];
  const title = slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

  return { slug: filename.replace(".md", ""), filename, date, title };
}

function loadLessonsFromSource(src: Source): LessonEntry[] {
  const dir = getLessonsPath(src);
  if (!dir || !existsSync(dir)) return [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();

  const out: LessonEntry[] = [];
  for (const f of files) {
    const entry = parseLessonFilename(f);
    if (entry) out.push({ ...entry, source: src.name });
  }
  return out;
}

export function lessonRoutes(config: ConsoleConfig) {
  const app = new Hono();

  app.get("/lessons", (c) => {
    const active = activeSources(c, config);
    const lessons: LessonEntry[] = [];
    for (const src of active) {
      lessons.push(...loadLessonsFromSource(src));
    }
    lessons.sort((a, b) => b.date.localeCompare(a.date));

    const content = lessonListView({
      lessons,
      sources: active,
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
      ? { ...parsed, source: src.name }
      : { slug, filename: `${slug}.md`, date: "", title: slug, source: src.name };

    const content = lessonDetailView({ lesson, contentHtml });

    return c.html(
      layout({
        title: lesson.title,
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: `/lessons/${src.name}/${slug}`,
        demoMode: config.demoMode,
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
      title: "Not Found",
      content: `<h1>Not found</h1><p>${message}</p><p><a href="/lessons">Back to lessons</a></p>`,
      sources: config.sources,
      activeSourceNames: active.map((s) => s.name),
      currentPath: "/lessons",
      demoMode: config.demoMode,
    }),
    404
  );
}
