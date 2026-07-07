/**
 * Left sidebar for the v0.9 cockpit.
 *
 * Two widgets stacked vertically:
 *   1. Mini calendar — month view with the current date highlighted, dates
 *      that have a plan rendered as links. Reuses `buildCalendarGrid` from
 *      `plan.ts` for behavioral parity with `/plans` calendar list view.
 *   2. Active projects — list of the source's projects filtered to active
 *      statuses (active / ongoing / new / paused), each as a row with a
 *      status dot + name (truncated) linking to the project detail page.
 *
 * Wraps both widgets in a `<details class="cockpit-aside-collapsible">` so
 * mobile breakpoint can collapse them; CSS forces them open at desktop.
 */
import { buildCalendarGrid } from "../plan.js";
import type { PlanEntry } from "../plan.js";
import type { ProjectWithSource } from "../../parsers/yaml.js";
import { renderProjectListItem, renderAsideEmpty } from "./cards.js";
import { escapeHtml } from "../../utils.js";

export interface SidebarLeftOpts {
  /** Source name (used for filtering projects + calendar links). */
  sourceName: string;
  /** Source display name (for the sidebar header). */
  sourceDisplayName?: string;
  /** Active source's projects (passed through from route layer). */
  projects: ProjectWithSource[];
  /** Plans within ±60 days of currentDate for calendar rendering. */
  plansForCalendar: PlanEntry[];
  /** YYYY-MM-DD of the page being viewed (highlighted in calendar). */
  currentDate: string;
  /**
   * Latest catch-up ledger for this source (v0.14+). Renders a compact
   * digest row linking to /ledger. Omitted when the source has no ledgers.
   */
  latestLedger?: {
    date: string;
    openTotal: number;
    decaying: number;
  };
}

const ACTIVE_STATUSES = new Set(["active", "ongoing", "new", "paused"]);

export function renderSidebarLeft(opts: SidebarLeftOpts): string {
  const display = opts.sourceDisplayName || opts.sourceName;

  // Mini calendar — pick the month containing currentDate. The calendar
  // filters its plan list to that month inline.
  const [year, month] = opts.currentDate.split("-").map(Number);
  const monthName = new Date(year, month - 1, 1).toLocaleDateString("en-US", {
    month: "long",
    year: "numeric",
  });
  const monthPlans = opts.plansForCalendar.filter((p) => p.date.startsWith(`${year}-${String(month).padStart(2, "0")}`));
  const calendarHtml = buildCalendarGrid(year, month, monthPlans, opts.currentDate);

  // Project list — filter to active statuses.
  const activeProjects = opts.projects.filter((p) => ACTIVE_STATUSES.has(p.status));
  const projectListHtml =
    activeProjects.length === 0
      ? renderAsideEmpty(
          opts.projects.length === 0
            ? `No projects in ${display}.`
            : "No active projects."
        )
      : `<ul class="cockpit-aside-list cockpit-project-list">${activeProjects
          .map((p) =>
            renderProjectListItem({
              id: p.id,
              source: p.source,
              name: p.name,
              status: p.status,
            })
          )
          .join("\n")}</ul>`;

  // Ledger digest — compact one-row widget; the decaying count is the
  // urgency signal (do-by dates are burning), so it gets its own callout.
  const ledgerDigestHtml = opts.latestLedger
    ? `
          <section class="cockpit-aside-section cockpit-aside-section-ledger" aria-label="Catch-up ledger">
            <h3 class="cockpit-aside-heading">Ledger</h3>
            <a class="cockpit-ledger-digest" href="/ledger/${encodeURIComponent(opts.sourceName)}/${encodeURIComponent(opts.latestLedger.date)}">
              <span class="cockpit-ledger-date">${escapeHtml(opts.latestLedger.date)}</span>
              <span class="cockpit-ledger-open">${opts.latestLedger.openTotal} open</span>
              ${opts.latestLedger.decaying > 0 ? `<span class="cockpit-ledger-decaying">${opts.latestLedger.decaying} decaying</span>` : ""}
            </a>
          </section>
    `
    : "";

  return `
    <aside class="cockpit-shell-aside-left" aria-label="Calendar and projects">
      <details class="cockpit-aside-collapsible cockpit-aside-left-collapsible" open>
        <summary class="cockpit-aside-summary">
          <span>Calendar &amp; Projects</span>
          <button type="button" class="cockpit-aside-hide-btn" data-side="left" aria-label="Hide left sidebar" title="Hide sidebar (click to bring back via main column)">×</button>
        </summary>
        <div class="cockpit-aside-content">

          <section class="cockpit-aside-section cockpit-aside-section-calendar" aria-label="Calendar">
            <h3 class="cockpit-aside-heading">${escapeHtml(monthName)}</h3>
            <div class="cockpit-mini-cal">${calendarHtml}</div>
          </section>

          <section class="cockpit-aside-section cockpit-aside-section-projects" aria-label="Active projects">
            <h3 class="cockpit-aside-heading">Active projects</h3>
            ${projectListHtml}
          </section>

          ${ledgerDigestHtml}

        </div>
      </details>
    </aside>
  `;
}
