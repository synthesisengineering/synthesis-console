import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import type { ConsoleConfig, Source } from "./config.js";

const COOKIE_NAME = "sc_sources";

/**
 * Resolve which sources are currently active, in order of precedence:
 *   1. In demo mode, only sources flagged demo:true.
 *   2. Query param ?sources=a,b (for shareable URLs), if any names match.
 *   3. Cookie sc_sources=a,b, if any names match.
 *   4. Sources with default_active: true.
 *   5. Fall back to all non-demo sources (first-run, nothing configured).
 */
export function activeSources(c: Context, config: ConsoleConfig): Source[] {
  if (config.demoMode) {
    return config.sources.filter((s) => s.demo === true);
  }

  const queryValue = c.req.query("sources");
  if (queryValue !== undefined) {
    const names = queryValue.split(",").filter(Boolean);
    const resolved = resolveNames(config.sources, names);
    if (resolved.length > 0) return resolved;
  }

  const cookieValue = getCookie(c, COOKIE_NAME);
  if (cookieValue) {
    const names = cookieValue.split(",").filter(Boolean);
    const resolved = resolveNames(config.sources, names);
    if (resolved.length > 0) return resolved;
  }

  const defaults = config.sources.filter((s) => s.default_active === true);
  if (defaults.length > 0) return defaults;

  const nonDemo = config.sources.filter((s) => !s.demo);
  return nonDemo.length > 0 ? nonDemo : config.sources;
}

function resolveNames(sources: Source[], names: string[]): Source[] {
  const out: Source[] = [];
  for (const name of names) {
    const s = sources.find((x) => x.name === name);
    if (s) out.push(s);
  }
  return out;
}

export function activeSourceNames(c: Context, config: ConsoleConfig): string[] {
  return activeSources(c, config).map((s) => s.name);
}

/**
 * Whether the named source is among the request's ACTIVE sources (v1.0.1).
 *
 * Detail routes (`/plans/:source/:date`, `/projects/:source/:id`, …) must
 * check this before rendering. The source picker is the view scope for the
 * WHOLE app: deselecting a source makes its content unreachable through the
 * UI — including direct URLs, bookmarks, breadcrumbs, and prev/next links —
 * not just absent from the union list views. This is what makes "select
 * only Demo" safe for screen-sharing: real-source pages gate instead of
 * rendering. (`bun run demo` / --demo remains the hard, config-level
 * isolation for fully unattended demos.)
 */
export function isSourceActive(c: Context, config: ConsoleConfig, sourceName: string): boolean {
  return activeSources(c, config).some((s) => s.name === sourceName);
}

export { COOKIE_NAME as SOURCES_COOKIE };
