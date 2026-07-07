import { Hono } from "hono";
import { existsSync, readdirSync } from "fs";
import { join } from "path";
import type { ConsoleConfig, Source } from "../config.js";
import { getProjectPath, findSource } from "../config.js";
import {
  loadInitiativesFromSources,
  loadProjectsFromSources,
  getInitiativeById,
} from "../parsers/yaml.js";
import type { InitiativeWithSource, ProjectWithSource } from "../parsers/yaml.js";
import { layout } from "../views/layout.js";
import { sourceGateView } from "../views/source-gate.js";
import { initiativeListView } from "../views/initiative-list.js";
import { initiativeDetailView } from "../views/initiative-detail.js";
import { escapeHtml, sanitizePathSegment } from "../utils.js";
import { activeSources, isSourceActive } from "../active-sources.js";

export function initiativeRoutes(config: ConsoleConfig) {
  const app = new Hono();

  app.get("/initiatives", (c) => {
    const active = activeSources(c, config);
    const initiatives: InitiativeWithSource[] = loadInitiativesFromSources(active);
    const projects: ProjectWithSource[] = loadProjectsFromSources(active);

    const content = initiativeListView({
      initiatives,
      projects,
      sources: active,
    });

    return c.html(
      layout({
        title: "Initiatives",
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/initiatives",
        demoMode: config.demoMode,
      })
    );
  });

  app.get("/initiatives/:source/:id", (c) => {
    const active = activeSources(c, config);
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const initiativeId = sanitizePathSegment(c.req.param("id"));

    if (!sourceName || !initiativeId) {
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

    const initiatives = loadInitiativesFromSources([src]);
    const initiative = getInitiativeById(initiatives, initiativeId);
    if (!initiative) {
      return notFound(
        c,
        config,
        active,
        `No initiative with ID "${escapeHtml(initiativeId)}" in source "${escapeHtml(sourceName)}".`
      );
    }

    const allProjects = loadProjectsFromSources([src]);
    const memberProjects = allProjects.filter((p) => p.initiative === initiativeId);

    // Pull recent session files across all member projects for the activity feed.
    const recentSessions: { projectId: string; projectName: string; period: string; sourceName: string }[] = [];
    for (const p of memberProjects) {
      const projDir = getProjectPath(src, p.id);
      if (!projDir) continue;
      const sessionsDir = join(projDir, "sessions");
      if (!existsSync(sessionsDir)) continue;
      const files = readdirSync(sessionsDir)
        .filter((f) => f.endsWith(".md"))
        .sort()
        .reverse()
        .slice(0, 3);
      for (const f of files) {
        recentSessions.push({
          projectId: p.id,
          projectName: p.name,
          period: f.replace(".md", ""),
          sourceName: src.name,
        });
      }
    }
    recentSessions.sort((a, b) => b.period.localeCompare(a.period));

    const content = initiativeDetailView({
      initiative,
      memberProjects,
      recentSessions: recentSessions.slice(0, 12),
      sourceName: src.name,
    });

    return c.html(
      layout({
        title: initiative.name,
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: `/initiatives/${src.name}/${initiativeId}`,
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
      content: `<h1>Not found</h1><p>${message}</p><p><a href="/initiatives">Back to initiatives</a></p>`,
      sources: config.sources,
      activeSourceNames: active.map((s) => s.name),
      currentPath: "/initiatives",
      demoMode: config.demoMode,
    }),
    404
  );
}
