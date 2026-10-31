/**
 * The plan page: header, the day at a glance, view tools, then one main
 * column of regions beside a narrow rail of context.
 *
 * Wraps everything in `<div class="cockpit-view cockpit-shell">` with the
 * data attributes the client script reads (data-source, data-date,
 * data-editable, data-mtime-ms) for decisions, tasks, drafts, find, the
 * file-change refresh and the rail toggle.
 */
import { escapeAttr, escapeHtml } from "../../utils.js";
import { renderMainColumn } from "./main-column.js";
import { renderPlanRail } from "./rail.js";
import { fmtAge, renderCount } from "./cards.js";
import { summarizePlan } from "./summary.js";
import { icon } from "../icons.js";
import { longDate, pageHeader, sourceBadge } from "../ui.js";
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
  /** The source's projects (kept for callers; the plan page links to Projects instead of listing them). */
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
  /** Latest ledger digest for the rail (v0.14+). */
  latestLedger?: { date: string; openTotal: number; decaying: number };
}

export function planCockpitShellView(opts: PlanCockpitShellOpts): string {
  const sourceLabel = opts.sourceDisplayName || opts.sourceName;
  const s = summarizePlan(opts.sections, opts.drafts ?? [], opts.draftsHtml);
  const planHref = (date: string) => `/plans/${encodeURIComponent(opts.sourceName)}/${date}`;

  const prev = opts.prevDate
    ? `<a class="btn" href="${planHref(opts.prevDate)}" rel="prev" title="Previous plan: ${escapeAttr(longDate(opts.prevDate, true))}">${icon("chevronLeft")}<span class="sr-only">Previous plan, </span>${escapeHtml(shortLabel(opts.prevDate))}</a>`
    : `<span class="btn disabled" aria-hidden="true" style="opacity:.45">${icon("chevronLeft")}</span>`;
  const next = opts.nextDate
    ? `<a class="btn" href="${planHref(opts.nextDate)}" rel="next" title="Next plan: ${escapeAttr(longDate(opts.nextDate, true))}"><span class="sr-only">Next plan, </span>${escapeHtml(shortLabel(opts.nextDate))}${icon("chevronRight")}</a>`
    : `<span class="btn disabled" aria-hidden="true" style="opacity:.45">${icon("chevronRight")}</span>`;

  const header = pageHeader({
    title: longDate(opts.date),
    className: "plan-header",
    eyebrowHtml: `${sourceBadge(sourceLabel, opts.sourceName)}<span>${escapeHtml(opts.date.slice(0, 4))}</span>${opts.editable ? "" : `<span class="badge badge-neutral badge-plain" title="Demo data is read-only">Read-only</span>`}`,
    metaHtml: `<span class="cockpit-glance-age" title="File last modified">${icon("clock", "icon-sm")}Updated ${escapeHtml(fmtAge(opts.fileMtimeMs))}</span>`,
    actionsHtml: `<div class="plan-nav cockpit-nav">${prev}${next}</div>
      <a class="btn cockpit-rollover-link" href="/plans/${encodeURIComponent(opts.sourceName)}/rollover" title="Tasks carried for 7 days or more across recent plans">${icon("repeat")}Rollover</a>
      <button type="button" class="btn cockpit-rail-toggle" aria-pressed="true" title="Show or hide the context panel">${icon("panelRight")}<span class="rail-toggle-label">Hide panel</span></button>`,
  });

  const glance = `
    <section class="cockpit-glance" aria-label="Day at a glance">
      <div class="cockpit-glance-counts">
        ${renderCount("Needs you", s.needsYouOpen, s.needsYouOpen, "action")}
        ${renderCount("Decisions open", s.decisionsOpen, s.decisionsTotal, "attention")}
        ${renderCount("Tasks done", s.tasksDone, s.tasksTotal, s.tasksTotal > 0 && s.tasksDone === s.tasksTotal ? "done" : "action", s.tasksTotal ? (s.tasksDone / s.tasksTotal) * 100 : undefined)}
        ${renderCount("Drafts to review", s.draftsPending, s.draftsPending, "action")}
        ${renderCount("Sent today", s.sentToday, s.sentToday, "done")}
      </div>
      <div class="cockpit-glance-tools">
        <div class="cockpit-filter-chips" role="group" aria-label="View filters">
          <button type="button" class="cockpit-filter-chip cockpit-filter-active" data-filter="all" aria-pressed="true">Everything</button>
          <button type="button" class="cockpit-filter-chip" data-filter="focus" aria-pressed="false" title="Only what needs action">${icon("focus", "icon-sm")} Focus</button>
          <button type="button" class="cockpit-filter-chip" data-filter="find" aria-pressed="false" title="Find in this plan (⌘F), including collapsed sections">${icon("search", "icon-sm")} Find</button>
        </div>
        <span class="muted" style="font-size:var(--fs-xs)">Focus shows only what needs action · ⌘F finds inside collapsed sections</span>
      </div>
      <div class="cockpit-find-bar" hidden>
        <input type="search" class="cockpit-find-input" placeholder="Find in this plan…" aria-label="Find in this plan">
        <span class="cockpit-find-status" role="status" aria-live="polite"></span>
        <button type="button" class="cockpit-find-close" aria-label="Close find">${icon("x")}</button>
      </div>
    </section>
  `;

  const main = renderMainColumn({
    date: opts.date,
    sourceName: opts.sourceName,
    sections: opts.sections,
    draftsHtml: opts.draftsHtml,
    fullMarkdownHtml: opts.fullMarkdownHtml,
    editable: opts.editable,
    drafts: opts.drafts,
    slackConfigured: opts.slackConfigured,
    tierASendEnabled: opts.tierASendEnabled,
    budget: opts.budget,
    prepPacks: opts.prepPacks,
  });

  const rail = renderPlanRail({
    sourceName: opts.sourceName,
    sections: opts.sections,
    plansForCalendar: opts.plansForCalendar ?? [],
    currentDate: opts.date,
    portfolioLanes: opts.portfolioLanes,
    latestLedger: opts.latestLedger,
  });

  return `
    <div class="cockpit-view cockpit-shell" data-source="${escapeAttr(opts.sourceName)}" data-date="${escapeAttr(opts.date)}" data-editable="${opts.editable ? "true" : "false"}" data-mtime-ms="${opts.fileMtimeMs}">
      ${header}
      ${glance}
      <div class="plan-layout">
        ${main}
        ${rail}
      </div>
      ${opts.directoryIslandHtml || ""}
    </div>
  `;
}

/** "Oct 29" for the prev/next buttons. */
function shortLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}
