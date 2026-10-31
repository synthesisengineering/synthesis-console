/**
 * Rollover view — tasks carried across multiple daily plans.
 *
 * Lists priority tasks that have appeared in several plans without being
 * marked done, from `findCarryoverTasks()` in the plan-rollover parser:
 * threshold chips (7 / 14 / 30 days, query-param links, no JS state), then
 * one card per task with its days carried, first and last open dates and
 * every plan it appeared in.
 *
 * An empty list is a healthy one: nothing has been carried past the
 * threshold, so tasks are shipping or being deliberately dropped.
 */
import type { RolloverTask } from "../parsers/plan-rollover.js";
import { escapeHtml, escapeAttr } from "../utils.js";
import { icon } from "./icons.js";
import { badge, emptyState, longDate, pageHeader, sourceBadge, statTile } from "./ui.js";

export interface RolloverViewOpts {
  sourceName: string;
  sourceDisplayName?: string;
  asOfDate: string;
  minDays: number;
  windowDays: number;
  tasks: RolloverTask[];
  /** Other available threshold options; current threshold is highlighted. */
  thresholdOptions: number[];
}

export function planRolloverView(opts: RolloverViewOpts): string {
  const display = opts.sourceDisplayName || opts.sourceName;
  const planLink = (date: string) =>
    `/plans/${encodeURIComponent(opts.sourceName)}/${encodeURIComponent(date)}`;

  const chips = opts.thresholdOptions
    .map((n) => {
      const active = n === opts.minDays;
      return `<a class="${active ? "active" : ""}" href="${escapeAttr(`?days=${n}`)}" rel="nofollow"${active ? ' aria-current="page"' : ""}>${n}+ days</a>`;
    })
    .join("\n");

  const totalOpen = opts.tasks.filter((t) => t.currentlyOpen).length;
  const totalClosed = opts.tasks.length - totalOpen;
  const longest = opts.tasks.reduce((n, t) => Math.max(n, t.daysCarried), 0);
  const days = (n: number) => `${n} day${n === 1 ? "" : "s"}`;

  const cards = opts.tasks.length === 0
    ? emptyState({
        icon: "checkCircle",
        title: `Nothing carried ${days(opts.minDays)} or more`,
        body: `No task has stayed open for ${days(opts.minDays)} or more within the last ${opts.windowDays} days. Tasks are shipping or being deliberately dropped; a shorter threshold shows newer carries.`,
      })
    : opts.tasks.map((t) => renderCard(t, planLink)).join("\n");

  return `
    <div class="cockpit-view cockpit-rollover" data-source="${escapeAttr(opts.sourceName)}">
      ${pageHeader({
        title: "Carried tasks",
        eyebrowHtml: `${sourceBadge(display, opts.sourceName)}<span>As of ${escapeHtml(longDate(opts.asOfDate, true))}</span>`,
        lead: `Priority tasks that stayed open across daily plans for ${days(opts.minDays)} or more, within the last ${opts.windowDays} days.`,
        actionsHtml: `<div class="segmented" role="group" aria-label="Threshold">${chips}</div>`,
      })}
      <div class="stats">
        ${statTile({ label: "Still open", value: totalOpen, tone: totalOpen ? "bad" : "ok", iconName: "repeat" })}
        ${statTile({ label: "Closed since", value: totalClosed, iconName: "checkCircle" })}
        ${statTile({ label: "Longest carry", value: longest ? days(longest) : "—", iconName: "clock" })}
      </div>
      <section class="cockpit-region cockpit-region-today" aria-label="Carryover tasks">
        ${totalClosed && opts.tasks.length ? `<p class="section-note" style="margin-bottom:var(--sp-3)">${totalClosed} of these closed before today and stay listed for context.</p>` : ""}
        <div class="stack-sm">${cards}</div>
      </section>
    </div>
  `;
}

function renderCard(t: RolloverTask, planLink: (date: string) => string): string {
  const occurrenceList = t.occurrences
    .map((o) => {
      const cls = o.done ? "cockpit-rollover-occurrence cockpit-rollover-done" : "cockpit-rollover-occurrence";
      const title = o.done
        ? `Marked done${o.doneTimestamp ? " at " + o.doneTimestamp : ""}`
        : "Open on this day";
      return `<a class="${cls}" href="${escapeAttr(planLink(o.date))}" title="${escapeAttr(title)}">${escapeHtml(o.date.slice(5))}</a>`;
    })
    .join(" ");

  return `
    <article class="cockpit-card" data-days-carried="${t.daysCarried}">
      <div class="cockpit-rollover-meta">
        <span class="rollover-days">${t.daysCarried}<small>day${t.daysCarried === 1 ? "" : "s"} carried</small></span>
        ${t.currentlyOpen ? badge("Open today", "bad") : badge("Closed", "ok")}
      </div>
      <h3 class="cockpit-decision-question" style="margin:8px 0 6px">${escapeHtml(t.exemplarText)}</h3>
      <div class="cockpit-rollover-trail">
        <div class="cockpit-rollover-trail-label">
          ${icon("calendar", "icon-sm")} First seen <a href="${escapeAttr(planLink(t.firstSeenDate))}">${escapeHtml(longDate(t.firstSeenDate))}</a>
          · in ${t.occurrenceCount} plan${t.occurrenceCount === 1 ? "" : "s"}
          · last open <a href="${escapeAttr(planLink(t.lastOpenDate))}">${escapeHtml(longDate(t.lastOpenDate))}</a>
        </div>
        <div class="cockpit-rollover-occurrences" aria-label="Plans this task appeared in">${occurrenceList}</div>
      </div>
    </article>
  `;
}
