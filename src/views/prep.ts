/**
 * Meeting-prep pack detail view (v0.13+).
 *
 * Renders one ritual-generated prep pack as a readable one-pager. The
 * breadcrumb links back to the plan for the pack's date so the between-
 * meetings loop (plan → prep → meeting → plan) stays one click deep.
 */
import { escapeHtml } from "../utils.js";
import type { PrepPackEntry } from "../parsers/prep-pack.js";

export interface PrepViewOpts {
  entry: PrepPackEntry;
  contentHtml: string;
}

export function prepView(opts: PrepViewOpts): string {
  const { entry } = opts;
  const meta: string[] = [];
  if (entry.when) meta.push(`<strong>When:</strong> ${escapeHtml(entry.when)}`);
  else if (entry.startTime) meta.push(`<strong>When:</strong> ${escapeHtml(entry.date)} ${escapeHtml(entry.startTime)}`);
  if (entry.who) meta.push(`<strong>Who:</strong> ${escapeHtml(entry.who)}`);

  return `
    <nav aria-label="breadcrumb" class="prep-breadcrumb">
      <ul>
        <li><a href="/plans/${encodeURIComponent(entry.sourceName)}/${encodeURIComponent(entry.date)}">Plan ${escapeHtml(entry.date)}</a></li>
        <li><span class="source-badge">${escapeHtml(entry.sourceName)}</span></li>
        <li>Prep pack</li>
      </ul>
    </nav>
    <article class="prep-pack">
      ${meta.length > 0 ? `<p class="prep-meta">${meta.join(" &nbsp;·&nbsp; ")}</p>` : ""}
      <div class="rendered-markdown prep-body">${opts.contentHtml}</div>
    </article>
  `;
}
