import { Hono } from "hono";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { ConsoleConfig } from "../config.js";
import { getProjectPath, findSource } from "../config.js";
import {
  loadProjectsFromSources,
  loadInitiativesFromSources,
  getProjectById,
  getAllTags,
  filterProjects,
} from "../parsers/yaml.js";
import type { ProjectWithSource, InitiativeWithSource } from "../parsers/yaml.js";
import { readAndRenderMarkdown } from "../parsers/markdown.js";
import { layout } from "../views/layout.js";
import { sourceGateView } from "../views/source-gate.js";
import { projectListView } from "../views/project-list.js";
import { projectDetailView } from "../views/project-detail.js";
import { sessionDetailView } from "../views/session.js";
import { escapeHtml, sanitizePathSegment } from "../utils.js";
import { activeSources, isSourceActive } from "../active-sources.js";

export function projectRoutes(config: ConsoleConfig) {
  const app = new Hono();

  // Multi-source project list
  app.get("/projects", (c) => {
    const active = activeSources(c, config);
    const projects: ProjectWithSource[] = loadProjectsFromSources(active);
    const initiatives: InitiativeWithSource[] = loadInitiativesFromSources(active);
    const allTags = getAllTags(projects);

    const filters = {
      status: c.req.query("status"),
      tag: c.req.query("tag"),
      client: c.req.query("client"),
      q: c.req.query("q"),
      source: c.req.query("source"),
      initiative: c.req.query("initiative"),
    };

    const hasFilters = Object.values(filters).some((v) => v);
    const displayed = hasFilters ? filterProjects(projects, filters) : projects;

    // Default to grouped-by-initiative if any initiatives exist and no explicit preference.
    const groupParam = c.req.query("group");
    const groupByInitiative =
      groupParam === "initiative" ||
      (groupParam !== "status" && initiatives.length > 0);

    const content = projectListView({
      projects: displayed,
      allTags,
      currentFilters: filters,
      sources: config.sources,
      activeSourceNames: active.map((s) => s.name),
      demoMode: config.demoMode,
      initiatives,
      groupByInitiative,
    });

    return c.html(
      layout({
        title: "Projects",
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/projects",
        demoMode: config.demoMode,
      })
    );
  });

  // Project detail (source-scoped)
  app.get("/projects/:source/:id", (c) => {
    const active = activeSources(c, config);
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const projectId = sanitizePathSegment(c.req.param("id"));

    if (!sourceName || !projectId) {
      return notFound(c, config, active, "Not found");
    }

    const src = findSource(config.sources, sourceName);
    if (!src) {
      return notFound(c, config, active, `Source "${escapeHtml(sourceName)}" not found.`);
    }

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

    const projects = loadProjectsFromSources([src]);
    const project = getProjectById(projects, projectId);

    if (!project) {
      return notFound(
        c,
        config,
        active,
        `No project with ID "${escapeHtml(projectId)}" exists in source "${escapeHtml(sourceName)}".`
      );
    }

    const initiatives = loadInitiativesFromSources([src]);
    const initiative = project.initiative
      ? initiatives.find((i) => i.id === project.initiative)
      : undefined;

    // Resolve related[] project IDs to their source across all active sources,
    // so cross-workspace related-links work and unknown refs render as plain text.
    const relatedResolutions = new Map<string, { source: string }>();
    if (project.related && project.related.length > 0) {
      const allActive = loadProjectsFromSources(active);
      for (const ref of project.related) {
        // Prefer same-source match first, then any active source.
        const sameSourceHit = allActive.find((p) => p.id === ref && p._source === src.name);
        const anyHit = sameSourceHit || allActive.find((p) => p.id === ref);
        if (anyHit) {
          relatedResolutions.set(ref, { source: anyHit._source });
        }
      }
    }

    const projectDir = getProjectPath(src, projectId)!;
    const contextHtml = readAndRenderMarkdown(join(projectDir, "CONTEXT.md"));
    const referenceHtml = readAndRenderMarkdown(join(projectDir, "REFERENCE.md"));

    const sessionsDir = join(projectDir, "sessions");
    const sessions: { name: string; period: string }[] = [];
    if (existsSync(sessionsDir)) {
      const files = readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse();
      for (const f of files) {
        const period = f.replace(".md", "");
        sessions.push({ name: period, period });
      }
    }

    const content = projectDetailView({
      project,
      contextHtml,
      referenceHtml,
      sessions,
      sourceName: src.name,
      initiative,
      relatedResolutions,
    });

    return c.html(
      layout({
        title: project.name,
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: `/projects/${src.name}/${projectId}`,
        demoMode: config.demoMode,
      })
    );
  });

  // Session detail
  app.get("/projects/:source/:id/sessions/:period", (c) => {
    const active = activeSources(c, config);
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const projectId = sanitizePathSegment(c.req.param("id"));
    const period = sanitizePathSegment(c.req.param("period"));

    if (!sourceName || !projectId || !period) {
      return notFound(c, config, active, "Not found");
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

    const projects = loadProjectsFromSources([src]);
    const project = getProjectById(projects, projectId);
    if (!project) return notFound(c, config, active, "Project not found.");

    const projectDir = getProjectPath(src, projectId)!;
    const sessionFile = join(projectDir, "sessions", `${period}.md`);
    const contentHtml = readAndRenderMarkdown(sessionFile);

    if (!contentHtml) {
      return notFound(c, config, active, `No session file for period "${escapeHtml(period)}".`);
    }

    const content = sessionDetailView({
      projectId,
      projectName: project.name,
      period,
      contentHtml,
      sourceName: src.name,
    });

    return c.html(
      layout({
        title: `${project.name} — Session ${period}`,
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: `/projects/${src.name}/${projectId}/sessions`,
        demoMode: config.demoMode,
      })
    );
  });

  return app;
}

function notFound(
  c: import("hono").Context,
  config: ConsoleConfig,
  active: import("../config.js").Source[],
  message: string
) {
  return c.html(
    layout({
      title: "Not Found",
      content: `<h1>Not found</h1><p>${message}</p><p><a href="/projects">Back to projects</a></p>`,
      sources: config.sources,
      activeSourceNames: active.map((s) => s.name),
      currentPath: "/projects",
      demoMode: config.demoMode,
    }),
    404
  );
}
