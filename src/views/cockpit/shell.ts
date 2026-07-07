/**
 * Three-column shell for the v0.9 cockpit.
 *
 * Composes:
 *   - cockpit-shell-aside-left  (calendar + projects)
 *   - cockpit-main-column       (existing region order with MUST DO / DO THIS WEEK split)
 *   - cockpit-shell-aside-right (wins + waiting on)
 *
 * Wraps the whole thing in a `<div class="cockpit-view cockpit-shell">` so:
 *   - existing JS handlers (find, filter, decision pick, task check, mtime
 *     poll) keep working — they look up `.cockpit-view` and read
 *     data-source / data-date / data-editable / data-mtime-ms unchanged.
 *   - new layout primitives apply via the `.cockpit-shell` modifier.
 *
 * Below 1024px viewport, CSS collapses the grid to single column and the
 * `<details>` wrappers in each sidebar become user-collapsible. Above
 * 1024px the same `<details>` are forced open via CSS.
 */
import { escapeAttr, escapeHtml } from "../../utils.js";
import { renderMainColumn } from "./main-column.js";
import { renderSidebarLeft } from "./sidebar-left.js";
import { renderSidebarRight } from "./sidebar-right.js";
import { getDayOfWeek } from "./cards.js";
import type { PlanSection } from "../../parsers/plan-sections.js";
import type { DraftBlock } from "../../parsers/draft-blocks.js";
import type { PlanEntry } from "../plan.js";
import type { ProjectWithSource } from "../../parsers/yaml.js";

export interface PlanCockpitShellOpts {
  date: string;
  sourceName: string;
  sourceDisplayName?: string;
  sections: PlanSection[];
  draftsHtml: string;
  fullMarkdownHtml: string;
  directoryIslandHtml: string;
  prevDate?: string;
  nextDate?: string;
  fileMtimeMs: number;
  editable: boolean;
  /** Active source's projects for the left sidebar. Empty when source has no projects index. */
  projects?: ProjectWithSource[];
  /** Plans within ±60 days of `date` for the mini calendar. */
  plansForCalendar?: PlanEntry[];
  /** All drafts parsed from raw (v0.10+) — powers NEEDS YOU one-tap rendering. */
  drafts?: DraftBlock[];
  /** Whether the source has a Slack token configured (env var present). */
  slackConfigured?: boolean;
  /** Whether Tier-A auto-send is enabled for this source (v0.10+). */
  tierASendEnabled?: boolean;
  /** Portfolio lanes across all active sources (v0.12+). */
  portfolioLanes?: import("./cards.js").PortfolioLaneView[];
  /** Parsed Budget line from the plan header (v0.12+). */
  budget?: import("./cards.js").BudgetBarData | null;
  /** Prep packs for this plan's date (v0.13+). */
  prepPacks?: import("../../parsers/prep-pack.js").PrepPackEntry[];
  /** Latest ledger digest for the left sidebar (v0.14+). */
  latestLedger?: { date: string; openTotal: number; decaying: number };
}

export function planCockpitShellView(opts: PlanCockpitShellOpts): string {
  const dayOfWeek = getDayOfWeek(opts.date);
  const projects = opts.projects ?? [];
  const plansForCalendar = opts.plansForCalendar ?? [];

  const breadcrumbHtml = `
    <nav aria-label="breadcrumb" class="cockpit-breadcrumb">
      <ul>
        <li><a href="/plans">Daily Plans</a></li>
        <li><span class="source-badge">${escapeHtml(opts.sourceName)}</span></li>
        <li>${escapeHtml(dayOfWeek)}, ${escapeHtml(opts.date)}</li>
      </ul>
    </nav>
  `;

  const leftSidebarHtml = renderSidebarLeft({
    sourceName: opts.sourceName,
    sourceDisplayName: opts.sourceDisplayName,
    projects,
    plansForCalendar,
    currentDate: opts.date,
    latestLedger: opts.latestLedger,
  });

  const mainColumnHtml = renderMainColumn({
    date: opts.date,
    sourceName: opts.sourceName,
    sections: opts.sections,
    draftsHtml: opts.draftsHtml,
    fullMarkdownHtml: opts.fullMarkdownHtml,
    prevDate: opts.prevDate,
    nextDate: opts.nextDate,
    fileMtimeMs: opts.fileMtimeMs,
    editable: opts.editable,
    drafts: opts.drafts,
    slackConfigured: opts.slackConfigured,
    tierASendEnabled: opts.tierASendEnabled,
    portfolioLanes: opts.portfolioLanes,
    budget: opts.budget,
    prepPacks: opts.prepPacks,
  });

  const rightSidebarHtml = renderSidebarRight({
    sections: opts.sections,
  });

  return `
    <div class="cockpit-view cockpit-shell" data-source="${escapeAttr(opts.sourceName)}" data-date="${escapeAttr(opts.date)}" data-editable="${opts.editable ? "true" : "false"}" data-mtime-ms="${opts.fileMtimeMs}">
      ${breadcrumbHtml}
      <div class="cockpit-shell-grid">
        ${leftSidebarHtml}
        ${mainColumnHtml}
        ${rightSidebarHtml}
      </div>
      ${opts.directoryIslandHtml || ""}
    </div>
  `;
}
