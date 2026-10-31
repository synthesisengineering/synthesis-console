/**
 * Meeting-prep pack detail view (v0.13+).
 *
 * Renders one ritual-generated prep pack as a readable one-pager. The
 * header links back to the plan for the pack's date so the between-meetings
 * loop (plan → prep → meeting → plan) stays one click deep.
 */
import { escapeHtml } from "../utils.js";
import type { PrepPackEntry } from "../parsers/prep-pack.js";
import { icon } from "./icons.js";
import { longDate, pageHeader, sourceBadge } from "./ui.js";

export interface PrepViewOpts {
  entry: PrepPackEntry;
  contentHtml: string;
  sourceLabel?: string;
}

export function prepView(opts: PrepViewOpts): string {
  const { entry } = opts;
  const planHref = `/plans/${encodeURIComponent(entry.sourceName)}/${encodeURIComponent(entry.date)}`;
  const meta: string[] = [];
  if (entry.when) meta.push(`<span>${icon("clock", "icon-sm")}${escapeHtml(entry.when)}</span>`);
  else if (entry.startTime) meta.push(`<span>${icon("clock", "icon-sm")}${escapeHtml(longDate(entry.date))} · ${escapeHtml(entry.startTime)}</span>`);
  if (entry.who) meta.push(`<span>${icon("users", "icon-sm")}${escapeHtml(entry.who)}</span>`);

  return `
    <div class="lesson-reading prep-pack">
      ${pageHeader({
        title: entry.title,
        eyebrowHtml: `${sourceBadge(opts.sourceLabel ?? entry.sourceName, entry.sourceName)}<span>${icon("brief", "icon-sm")} Prep pack</span>`,
        metaHtml: meta.join(""),
        actionsHtml: `<a class="btn" href="${planHref}">${icon("calendar")}Plan for ${escapeHtml(longDate(entry.date))}</a>`,
      })}
      <article class="card doc-card">
        <div class="rendered-markdown prep-body">${opts.contentHtml}</div>
      </article>
    </div>
  `;
}
