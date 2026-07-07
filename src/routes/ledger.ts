/**
 * Ledger routes (v0.14+).
 *
 *   GET /ledger                 — newest ledger across active sources
 *   GET /ledger/:source/:date   — a specific sweep
 *
 * Read-only: the ledger file is the record; the console renders it. The
 * skill (synthesis-catchup-ledger) owns writes.
 */
import { Hono } from "hono";
import type { ConsoleConfig } from "../config.js";
import { findSource } from "../config.js";
import { listLedgers, readLedger } from "../parsers/ledger.js";
import type { LedgerEntry } from "../parsers/ledger.js";
import { layout } from "../views/layout.js";
import { ledgerView, ledgerEmptyView } from "../views/ledger.js";
import { sourceGateView } from "../views/source-gate.js";
import { sanitizePathSegment } from "../utils.js";
import { activeSources, isSourceActive } from "../active-sources.js";

export function ledgerRoutes(config: ConsoleConfig): Hono {
  const app = new Hono();

  app.get("/ledger", (c) => {
    const active = activeSources(c, config);
    const all: LedgerEntry[] = active.flatMap((s) => listLedgers(s));
    all.sort((a, b) => b.date.localeCompare(a.date));
    const newest = all[0];
    const src = newest ? findSource(config.sources, newest.sourceName) : undefined;
    const doc = newest && src ? readLedger(src, newest.date) : null;
    return c.html(
      layout({
        title: "Ledger",
        content: doc ? ledgerView({ doc, allLedgers: all }) : ledgerEmptyView(),
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/ledger",
        demoMode: config.demoMode,
      })
    );
  });

  app.get("/ledger/:source/:date", (c) => {
    const active = activeSources(c, config);
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const date = sanitizePathSegment(c.req.param("date"));
    const src = sourceName ? findSource(config.sources, sourceName) : undefined;
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
    const doc = src && date ? readLedger(src, date) : null;
    if (!doc) {
      return c.html(
        layout({
          title: "Not Found",
          content: `<h1>404</h1><p>Ledger not found.</p><p><a href="/ledger">Back to Ledger</a></p>`,
          sources: config.sources,
          activeSourceNames: active.map((s) => s.name),
          demoMode: config.demoMode,
        }),
        404
      );
    }
    const all: LedgerEntry[] = active.flatMap((s) => listLedgers(s));
    all.sort((a, b) => b.date.localeCompare(a.date));
    return c.html(
      layout({
        title: `Ledger — ${date}`,
        content: ledgerView({ doc, allLedgers: all }),
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: `/ledger/${sourceName}/${date}`,
        demoMode: config.demoMode,
      })
    );
  });

  return app;
}
