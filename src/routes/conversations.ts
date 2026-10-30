import { Hono } from "hono";
import type { ConsoleConfig } from "../config.js";
import { activeSources } from "../active-sources.js";
import { listSessions, searchConversations, showSession, validName } from "../conversations.js";
import { layout } from "../views/layout.js";
import { conversationView, conversationsView } from "../views/conversations.js";

export interface ConversationReaders {
  list: typeof listSessions;
  search: typeof searchConversations;
  show: typeof showSession;
}

const READERS: ConversationReaders = { list: listSessions, search: searchConversations, show: showSession };

/** Agent conversations from `synthesis sessions`, read-only (synthesis R10.8). */
export function conversationRoutes(config: ConsoleConfig, read: ConversationReaders = READERS) {
  const app = new Hono();

  app.get("/conversations", async (c) => {
    const active = activeSources(c, config);
    const query = (c.req.query("q") ?? "").slice(0, 200);
    const workspace = validName(c.req.query("workspace"));
    const project = validName(c.req.query("project"));
    const filter = { workspace, project, limit: 200 };
    const [sessions, matches] = await Promise.all([
      read.list(filter),
      query.trim() ? read.search(query, { ...filter, limit: 100 }) : Promise.resolve(null),
    ]);
    return c.html(
      layout({
        title: "Conversations",
        content: conversationsView({ query, workspace, project, sessions, matches }),
        sources: config.sources,
        activeSourceNames: active.map((source) => source.name),
        currentPath: "/conversations",
        demoMode: config.demoMode,
        wide: true,
      })
    );
  });

  app.get("/conversations/:session", async (c) => {
    const active = activeSources(c, config);
    const id = validName(c.req.param("session"));
    if (!id) return c.text("Not a session id.", 400);
    const full = c.req.query("full") === "1";
    return c.html(
      layout({
        title: `Session ${id.slice(0, 8)}`,
        content: conversationView(id, full, await read.show(id, full)),
        sources: config.sources,
        activeSourceNames: active.map((source) => source.name),
        currentPath: "/conversations",
        demoMode: config.demoMode,
        wide: true,
      })
    );
  });

  app.get("/api/conversations", async (c) => {
    const filter = { workspace: validName(c.req.query("workspace")), project: validName(c.req.query("project")),
      limit: Number(c.req.query("limit") ?? 50) };
    const query = c.req.query("q") ?? "";
    const result = query.trim() ? await read.search(query, filter) : await read.list(filter);
    return c.json({ ok: result.error === null, installed: result.installed, error: result.error, items: result.items });
  });

  return app;
}
