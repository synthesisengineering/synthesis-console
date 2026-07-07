/**
 * Main column for the v0.9 cockpit. Center column of the three-column shell.
 *
 * Region order (top → bottom):
 *   1. Date header (day-of-week, date, mtime "Updated N min ago")
 *   2. Progress bar (X / Y tasks done)
 *   3. Tools strip — counts + filter chips + Rollover + prev/next nav
 *   4. Optional plan header (pre-first-H2 markdown — status line, morning ritual)
 *   5. MUST DO TODAY — open decisions + P0 task buckets
 *   6. DO THIS WEEK — P1 / P2 / watch / stale / other task buckets
 *   7. DRAFTS — active + sent draft cards (passthrough of augmentDraftBlocks output)
 *   8. MORE — briefing / standup / waiting / completed / sent-messages /
 *      pr-queue / sync-state / other collapsibles
 *   9. Full markdown collapsible (escape hatch)
 *
 * Backward-compatibility: every section keeps its existing class names so
 * the v0.8 CSS, JS handlers (decision pick, task checkbox, filter chips,
 * find, mtime poller), and write-back endpoints continue to work unchanged.
 * MUST DO TODAY and DO THIS WEEK are added as siblings of the legacy
 * `.cockpit-region-today` class — they ARE typed cockpit regions, just with
 * a sharper semantic split.
 */
import MarkdownIt from "markdown-it";
import type {
  PlanSection,
  Decision,
  TaskBucket,
  SectionKind,
} from "../../parsers/plan-sections.js";
import { collectAllDecisions, collectAllTasks } from "../../parsers/plan-sections.js";
import type { DraftBlock } from "../../parsers/draft-blocks.js";
import { escapeHtml, escapeAttr } from "../../utils.js";
import {
  fmtAge,
  getDayOfWeek,
  renderCount,
  renderProgressBar,
  renderDecisionCard,
  renderTaskBucket,
  renderDraftsRegion,
  renderNeedsYouRegion,
  renderTickerRegion,
  renderBriefRegion,
  renderPortfolioStrip,
  renderTodayRegion,
  extractSlotWindow,
  windowsOverlap,
  countDrafts,
  countSentToday,
} from "./cards.js";
import type { PortfolioLaneView, TodaySlotView, BudgetBarData } from "./cards.js";
import { parseCalendarBody } from "../../parsers/calendar.js";
import type { CalendarEvent } from "../../parsers/calendar.js";
import type { PrepPackEntry } from "../../parsers/prep-pack.js";

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

export interface MainColumnOpts {
  date: string;
  sourceName: string;
  sections: PlanSection[];
  draftsHtml: string;
  fullMarkdownHtml: string;
  prevDate?: string;
  nextDate?: string;
  fileMtimeMs: number;
  editable: boolean;
  /**
   * All draft blocks parsed from the raw plan (v0.10+). Used to render one-tap
   * drafts inside NEEDS YOU. Standard drafts region still uses draftsHtml.
   */
  drafts?: DraftBlock[];
  /** Whether the source has a Slack token configured (env var present). */
  slackConfigured?: boolean;
  /** Whether Tier-A auto-send is enabled for this source (v0.10+). */
  tierASendEnabled?: boolean;
  /** Portfolio lanes across all active sources (v0.12+). */
  portfolioLanes?: PortfolioLaneView[];
  /** Parsed Budget line from the plan header (v0.12+). Null when absent. */
  budget?: BudgetBarData | null;
  /** Prep packs for this plan's date (v0.13+), from the source's preps_dir. */
  prepPacks?: PrepPackEntry[];
}

export function renderMainColumn(opts: MainColumnOpts): string {
  const dayOfWeek = getDayOfWeek(opts.date);
  const headerSection = opts.sections.find((s) => s.kind === "header");
  const headerHtml = headerSection ? md.render(headerSection.rawBody) : "";

  const decisions = collectAllDecisions(opts.sections);
  const tasks = collectAllTasks(opts.sections);
  const decisionsOpen = decisions.filter((d) => !d.decided).length;
  const tasksDone = tasks.filter((t) => t.done).length;
  const tasksTotal = tasks.length;
  const draftCount = countDrafts(opts.draftsHtml);
  const sentToday = countSentToday(opts.draftsHtml);

  // Cockpit Mode decisions (decision-needed / one-tap-batch) render in
  // NEEDS YOU; MUST DO TODAY gets ONLY legacy `decisions`-kind sections —
  // otherwise every cockpit-mode decision renders twice on the page.
  const legacyDecisions: Decision[] = [];
  for (const s of opts.sections) {
    if (s.kind === "decisions") {
      for (const d of s.decisions || []) legacyDecisions.push(d);
    }
  }
  const needsYouHtml = renderNeedsYou(opts);

  const prevLink = opts.prevDate
    ? `<a href="/plans/${encodeURIComponent(opts.sourceName)}/${opts.prevDate}" rel="prev">&larr; ${escapeHtml(opts.prevDate)}</a>`
    : `<span class="muted">&larr;</span>`;
  const nextLink = opts.nextDate
    ? `<a href="/plans/${encodeURIComponent(opts.sourceName)}/${opts.nextDate}" rel="next">${escapeHtml(opts.nextDate)} &rarr;</a>`
    : `<span class="muted">&rarr;</span>`;
  const rolloverLink = `<a class="cockpit-rollover-link" href="/plans/${encodeURIComponent(opts.sourceName)}/rollover" title="Tasks carried for ≥ 7 days across recent plans">Rollover</a>`;

  return `
    <div class="cockpit-main-column">
      <div class="cockpit-show-sidebars-row">
        <button type="button" class="cockpit-show-left-btn" hidden aria-label="Show left sidebar" title="Show calendar &amp; projects sidebar">▸ Calendar &amp; Projects</button>
        <button type="button" class="cockpit-show-right-btn" hidden aria-label="Show right sidebar" title="Show wins &amp; waiting sidebar">Wins &amp; Waiting On ◂</button>
      </div>

      <header class="cockpit-glance" role="region" aria-label="Day at a glance">
        <div class="cockpit-glance-title">
          <strong>${escapeHtml(dayOfWeek)}, ${escapeHtml(opts.date)}</strong>
          <span class="cockpit-glance-age" title="File last modified">Updated ${escapeHtml(fmtAge(opts.fileMtimeMs))}</span>
        </div>
        <div class="cockpit-glance-counts">
          ${renderCount("Decisions", decisionsOpen, decisions.length, "critical")}
          ${renderCount("Tasks", tasksTotal - tasksDone, tasksTotal, tasksDone === tasksTotal && tasksTotal > 0 ? "done" : "action")}
          ${renderCount("Drafts", draftCount, draftCount, "action")}
          ${renderCount("Sent today", sentToday, sentToday, "done")}
        </div>
        ${renderProgressBar(tasksDone, tasksTotal)}
        <div class="cockpit-glance-tools">
          <div class="cockpit-filter-chips" role="group" aria-label="View filters">
            <button type="button" class="cockpit-filter-chip cockpit-filter-active" data-filter="all">All</button>
            <button type="button" class="cockpit-filter-chip" data-filter="focus">Focus</button>
            <button type="button" class="cockpit-filter-chip" data-filter="find">⌘F Find</button>
          </div>
          <div class="cockpit-nav">
            ${prevLink}
            ${nextLink}
            ${rolloverLink}
          </div>
        </div>
        <div class="cockpit-find-bar" hidden>
          <input type="search" class="cockpit-find-input" placeholder="Find in this plan…" aria-label="Find in this plan">
          <span class="cockpit-find-status" role="status" aria-live="polite"></span>
          <button type="button" class="cockpit-find-close" aria-label="Close find">&times;</button>
        </div>
      </header>

      ${opts.portfolioLanes && opts.portfolioLanes.length > 0 ? renderPortfolioStrip(opts.portfolioLanes) : ""}

      ${headerHtml ? `<div class="cockpit-header rendered-markdown">${headerHtml}</div>` : ""}

      ${renderBrief(opts.sections)}
      ${needsYouHtml}
      ${renderToday(opts)}
      ${renderPrepPacks(opts)}
      ${renderTicker(opts.sections)}
      ${renderMustDoToday(legacyDecisions, opts, needsYouHtml !== "")}
      ${renderDoThisWeek(opts.sections, opts)}
      ${renderDraftsRegion(opts.draftsHtml)}
      ${renderMore(opts.sections, opts.fullMarkdownHtml)}
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* NEEDS YOU — Cockpit Mode Tier-B one-tap queue (v0.10+)                     */
/* -------------------------------------------------------------------------- */

/**
 * Renders the top-of-column NEEDS YOU region. Composes:
 *   - priority decisions from `## ⚡ Decision needed` H2 sections
 *   - light decisions and drafts from `## ☑️ One-tap batch` H2 sections
 *
 * Returns empty string when neither H2 is present (legacy plans render
 * unchanged — MUST DO TODAY continues to be the primary decision surface).
 */
function renderNeedsYou(opts: MainColumnOpts): string {
  const priorityDecisions: Decision[] = [];
  const batchDecisions: Decision[] = [];
  for (const s of opts.sections) {
    if (s.kind === "decision-needed") {
      for (const d of s.decisions || []) priorityDecisions.push(d);
    } else if (s.kind === "one-tap-batch") {
      for (const d of s.decisions || []) batchDecisions.push(d);
    }
  }

  // Filter drafts to those whose regionStartLine falls inside a
  // `decision-needed` or `one-tap-batch` section. Drafts in a legacy
  // `## Drafts` H2 or elsewhere continue to appear in the standard
  // DRAFTS region below.
  const drafts = opts.drafts ?? [];
  const batchDrafts: DraftBlock[] = drafts.filter((d) =>
    opts.sections.some(
      (s) =>
        (s.kind === "decision-needed" || s.kind === "one-tap-batch") &&
        d.regionStartLine >= s.headingLine + 1 &&
        d.regionStartLine < s.endLine
    )
  );

  return renderNeedsYouRegion(priorityDecisions, batchDecisions, batchDrafts, {
    editable: opts.editable,
    sourceName: opts.sourceName,
    planDate: opts.date,
    slackConfigured: !!opts.slackConfigured,
    tierASendEnabled: !!opts.tierASendEnabled,
  });
}

/* -------------------------------------------------------------------------- */
/* TICKER — "On your behalf" Tier-A digest (v0.10+)                           */
/* -------------------------------------------------------------------------- */

function renderTicker(sections: PlanSection[]): string {
  const tickerSection = sections.find((s) => s.kind === "ticker");
  if (!tickerSection) return "";
  return renderTickerRegion(tickerSection.rawBody, false);
}

/* -------------------------------------------------------------------------- */
/* TODAY — budget bar + Tier-C slots + calendar (v0.12+)                      */
/* -------------------------------------------------------------------------- */

/**
 * Composes the TODAY region from three independent signals:
 *   - `budget` (parsed from the `**Budget:**` header line, threaded from
 *     the route),
 *   - the `today` section's task buckets (each H3 = one Tier-C slot;
 *     window binding parsed from the H3 label),
 *   - the `calendar` section's events (ritual-written `## 📅 Calendar`).
 *
 * A slot whose window overlaps a calendar event gets a preemption badge.
 * Events that ARE the slot (identical window) don't badge — the common
 * case there is the ritual writing the slot binding from the calendar
 * block itself.
 */
function renderToday(opts: MainColumnOpts): string {
  const todaySection = opts.sections.find((s) => s.kind === "today");
  const calendarSection = opts.sections.find((s) => s.kind === "calendar");
  const events: CalendarEvent[] = calendarSection ? parseCalendarBody(calendarSection.rawBody) : [];

  const slots: TodaySlotView[] = [];
  for (const bucket of todaySection?.taskBuckets || []) {
    const window = extractSlotWindow(bucket.label);
    let overlapTitle: string | undefined;
    if (window) {
      for (const ev of events) {
        if (!ev.start || !ev.end) continue;
        const evWindow = { start: ev.start, end: ev.end };
        const identical = evWindow.start === window.start && evWindow.end === window.end;
        if (!identical && windowsOverlap(window, evWindow)) {
          overlapTitle = ev.title || "calendar event";
          break;
        }
      }
    }
    slots.push({ bucket, window, overlapTitle });
  }

  return renderTodayRegion({
    budget: opts.budget ?? null,
    slots,
    events,
    editable: opts.editable,
  });
}

/* -------------------------------------------------------------------------- */
/* PREP PACKS — meeting one-pagers for today (v0.13+)                         */
/* -------------------------------------------------------------------------- */

/**
 * One card per prep pack for this plan's date, chronological. Cards come
 * from the source's preps_dir (file listing — the ritual writes the files);
 * the optional `## 📋 Prep packs` H2 body renders below the cards as free
 * markdown (the ritual may put notes or links there). When neither exists,
 * the region is omitted.
 */
function renderPrepPacks(opts: MainColumnOpts): string {
  const packs = opts.prepPacks ?? [];
  const prepSection = opts.sections.find((s) => s.kind === "prep-packs");
  if (packs.length === 0 && !prepSection) return "";

  const cards = packs
    .map((p) => {
      const href = `/prep/${encodeURIComponent(p.sourceName)}/${encodeURIComponent(p.slug)}`;
      const who = p.who ? `<span class="cockpit-prep-who">${escapeHtml(p.who)}</span>` : "";
      return `
        <a class="cockpit-prep-card" href="${escapeAttr(href)}">
          ${p.startTime ? `<span class="cockpit-prep-time">${escapeHtml(p.startTime)}</span>` : ""}
          <span class="cockpit-prep-title">${escapeHtml(p.title)}</span>
          ${who}
        </a>
      `;
    })
    .join("\n");

  const sectionBody = prepSection && prepSection.rawBody.trim().length > 0
    ? `<div class="cockpit-prep-notes rendered-markdown">${md.render(prepSection.rawBody)}</div>`
    : "";

  return `
    <section class="cockpit-region cockpit-region-preps" data-region="prep-packs" aria-label="Meeting prep packs">
      <h2 class="cockpit-region-title">PREP PACKS
        <span class="cockpit-region-subtitle">${packs.length > 0 ? `${packs.length} meeting${packs.length === 1 ? "" : "s"}` : "notes"}</span>
      </h2>
      ${cards ? `<div class="cockpit-prep-cards">${cards}</div>` : ""}
      ${sectionBody}
    </section>
  `;
}

/* -------------------------------------------------------------------------- */
/* BRIEF — Cockpit Mode ≤90-second morning narrative (v0.11+)                 */
/* -------------------------------------------------------------------------- */

function renderBrief(sections: PlanSection[]): string {
  const briefSection = sections.find((s) => s.kind === "brief");
  if (!briefSection) return "";
  return renderBriefRegion(briefSection.rawBody);
}

/* -------------------------------------------------------------------------- */
/* MUST DO TODAY — open decisions + P0 task buckets                           */
/* -------------------------------------------------------------------------- */

function renderMustDoToday(decisions: Decision[], opts: MainColumnOpts, needsYouPresent: boolean): string {
  const taskSections = opts.sections.filter((s) => s.kind === "priority-tasks");
  const p0Buckets: TaskBucket[] = [];
  for (const s of taskSections) {
    for (const b of s.taskBuckets || []) {
      if (b.semantic === "p0") p0Buckets.push(b);
    }
  }

  const hasContent = decisions.length > 0 || p0Buckets.length > 0;
  if (!hasContent) {
    // When NEEDS YOU rendered above with open items, an "All caught up"
    // message here would contradict it — suppress the empty state and
    // the region entirely on Cockpit Mode plans.
    if (needsYouPresent) return "";
    return `
      <section class="cockpit-region cockpit-region-needs cockpit-region-empty" data-region="must-do-today" aria-label="Must do today">
        <h2 class="cockpit-region-title">MUST DO TODAY</h2>
        <p class="cockpit-region-empty-msg">All caught up — no must-dos.</p>
      </section>
    `;
  }

  const decisionCards = decisions
    .map((d) => renderDecisionCard(d, { editable: opts.editable }))
    .join("\n");
  const taskBuckets = p0Buckets
    .map((b, i) => renderTaskBucket(b, { defaultOpen: true, editable: opts.editable }))
    .join("\n");

  const openCount = decisions.filter((d) => !d.decided).length +
    p0Buckets.reduce((n, b) => n + b.tasks.filter((t) => !t.done).length, 0);

  return `
    <section class="cockpit-region cockpit-region-needs cockpit-region-must-do" data-region="must-do-today" aria-label="Must do today">
      <h2 class="cockpit-region-title">MUST DO TODAY
        <span class="cockpit-region-count">${openCount} open</span>
      </h2>
      ${decisionCards}
      ${taskBuckets}
    </section>
  `;
}

/* -------------------------------------------------------------------------- */
/* DO THIS WEEK — P1 / P2 / watch / stale / other task buckets                */
/* -------------------------------------------------------------------------- */

function renderDoThisWeek(sections: PlanSection[], opts: MainColumnOpts): string {
  const taskSections = sections.filter((s) => s.kind === "priority-tasks");
  const buckets: TaskBucket[] = [];
  for (const s of taskSections) {
    for (const b of s.taskBuckets || []) {
      if (b.semantic !== "p0") buckets.push(b);
    }
  }

  if (buckets.length === 0) {
    // Don't render an empty section here — MUST DO TODAY's empty state covers
    // the "all caught up" case. Suppressing this section reduces visual noise.
    return "";
  }

  const totalTasks = buckets.reduce((n, b) => n + b.tasks.length, 0);
  const tasksDone = buckets.reduce((n, b) => n + b.tasks.filter((t) => t.done).length, 0);

  const bucketsHtml = buckets
    .map((b, i) => renderTaskBucket(b, { defaultOpen: i === 0, editable: opts.editable }))
    .join("\n");

  return `
    <section class="cockpit-region cockpit-region-today cockpit-region-this-week" data-region="do-this-week" aria-label="Do this week">
      <h2 class="cockpit-region-title">DO THIS WEEK
        <span class="cockpit-region-count">${tasksDone} / ${totalTasks} done</span>
      </h2>
      ${bucketsHtml}
    </section>
  `;
}

/* -------------------------------------------------------------------------- */
/* MORE — collapsibles for context sections                                   */
/* -------------------------------------------------------------------------- */

interface LowerRowGroup {
  kind: SectionKind;
  label: string;
  tone: string;
  sections: PlanSection[];
}

const LOWER_ROW_ORDER: { kind: SectionKind; label: string; tone: string }[] = [
  { kind: "briefing", label: "Briefing", tone: "context" },
  { kind: "standup", label: "Standup", tone: "context" },
  // Note: waiting + completed + sent-messages move to the right sidebar in
  // the v0.9 three-column layout. Keeping them in MORE as fallback when the
  // sidebar is collapsed; sidebar-right derives from the same sections so
  // the data is in two places visually but the source markdown is one tree.
  { kind: "pr-queue", label: "PR queue", tone: "context" },
  { kind: "sync-state", label: "Sync state", tone: "context" },
  { kind: "other", label: "Other", tone: "context" },
];

function renderMore(sections: PlanSection[], fullMarkdownHtml: string): string {
  const groups: LowerRowGroup[] = LOWER_ROW_ORDER.map((g) => ({
    ...g,
    sections: sections.filter((s) => s.kind === g.kind),
  })).filter((g) => g.sections.length > 0);

  if (groups.length === 0 && !fullMarkdownHtml) return "";

  const groupsHtml = groups
    .map((g) => {
      const bodies = g.sections
        .map(
          (s) => `
        <div class="cockpit-collapsible-section rendered-markdown">
          <h3 class="cockpit-collapsible-subheading">${escapeHtml(s.rawHeading)}</h3>
          ${md.render(s.rawBody)}
        </div>
      `
        )
        .join("\n");
      const itemCount = g.sections.length;
      const countSuffix = itemCount > 1 ? ` (${itemCount})` : "";
      return `
        <details class="cockpit-collapsible cockpit-collapsible-${g.tone}" data-collapsible="${g.kind}">
          <summary class="cockpit-collapsible-summary">
            <span class="cockpit-collapsible-label">${escapeHtml(g.label)}${countSuffix}</span>
          </summary>
          <div class="cockpit-collapsible-body">${bodies}</div>
        </details>
      `;
    })
    .join("\n");

  const fullCollapsible = fullMarkdownHtml
    ? `
      <details class="cockpit-collapsible cockpit-collapsible-fullmarkdown" data-collapsible="full-markdown">
        <summary class="cockpit-collapsible-summary">
          <span class="cockpit-collapsible-label">Full markdown</span>
        </summary>
        <div class="cockpit-collapsible-body rendered-markdown">${fullMarkdownHtml}</div>
      </details>
    `
    : "";

  return `
    <section class="cockpit-region cockpit-region-collapsibles cockpit-region-more" aria-label="More — reference and context">
      ${groupsHtml}
      ${fullCollapsible}
    </section>
  `;
}
