/**
 * Main column of the plan page. Regions, top to bottom, in the order the
 * principal works the day:
 *
 *   1. Plan header lines (status, budget and mode lines before the first H2)
 *   2. NEEDS YOU — priority decisions and the one-tap queue
 *   3. BRIEF — the 90-second morning narrative
 *   4. TODAY — time budget, calendar and deep-work slots
 *   5. MUST DO TODAY — open legacy decisions and P0 task buckets
 *   6. THIS WEEK — P1 / P2 / watch / stale / other task buckets
 *   7. DRAFTS — active and sent drafts with their action bars
 *   8. PREP PACKS — meeting one-pagers for the day
 *   9. ON YOUR BEHALF — the Tier-A ticker
 *  10. MORE — briefing / standup / PR queue / sync state / other, and the
 *      full markdown as an escape hatch
 *
 * Every region keeps the class names and data attributes the client script
 * and write-back endpoints rely on (.cockpit-decision, .cockpit-task,
 * .cockpit-bucket, .draft-actions, .cockpit-onetap-draft, .cockpit-region-*).
 */
import MarkdownIt from "markdown-it";
import type {
  PlanSection,
  Decision,
  TaskBucket,
  SectionKind,
} from "../../parsers/plan-sections.js";
import type { DraftBlock } from "../../parsers/draft-blocks.js";
import { escapeHtml, escapeAttr } from "../../utils.js";
import {
  regionTitle,
  renderDecisionCard,
  renderTaskBucket,
  renderDraftsRegion,
  renderNeedsYouRegion,
  renderTickerRegion,
  renderBriefRegion,
  renderTodayRegion,
  extractSlotWindow,
  windowsOverlap,
} from "./cards.js";
import type { TodaySlotView, BudgetBarData } from "./cards.js";
import { needsYouDecisions, needsYouDrafts } from "./summary.js";
import { parseCalendarBody } from "../../parsers/calendar.js";
import type { CalendarEvent } from "../../parsers/calendar.js";
import type { PrepPackEntry } from "../../parsers/prep-pack.js";

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });
// The header block is a run of one-line fields (Status, Budget, Mode); keep
// each on its own line instead of folding them into one paragraph.
const mdLines = new MarkdownIt({ html: true, linkify: true, typographer: true, breaks: true });

export interface MainColumnOpts {
  date: string;
  sourceName: string;
  sections: PlanSection[];
  draftsHtml: string;
  fullMarkdownHtml: string;
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
  /** Parsed Budget line from the plan header (v0.12+). Null when absent. */
  budget?: BudgetBarData | null;
  /** Prep packs for this plan's date (v0.13+), from the source's preps_dir. */
  prepPacks?: PrepPackEntry[];
}

export function renderMainColumn(opts: MainColumnOpts): string {
  const headerSection = opts.sections.find((s) => s.kind === "header");
  const headerHtml = headerSection && headerSection.rawBody.trim() ? mdLines.render(headerSection.rawBody) : "";

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

  return `
    <div class="cockpit-main-column plan-main">
      ${headerHtml ? `<div class="cockpit-header rendered-markdown">${headerHtml}</div>` : ""}
      ${needsYouHtml}
      ${renderBrief(opts.sections)}
      ${renderToday(opts)}
      ${renderMustDoToday(legacyDecisions, opts, needsYouHtml !== "")}
      ${renderDoThisWeek(opts.sections, opts)}
      ${renderDraftsRegion(opts.draftsHtml)}
      ${renderPrepPacks(opts)}
      ${renderTicker(opts.sections)}
      ${renderMore(opts.sections, opts.fullMarkdownHtml)}
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* NEEDS YOU — Cockpit Mode Tier-B one-tap queue (v0.10+)                     */
/* -------------------------------------------------------------------------- */

/**
 * Priority decisions from `## ⚡ Decision needed`, plus light decisions and
 * drafts from `## ☑️ One-tap batch`. Empty when neither H2 is present
 * (legacy plans render unchanged — MUST DO TODAY is their decision surface).
 */
function renderNeedsYou(opts: MainColumnOpts): string {
  const { priority, batch } = needsYouDecisions(opts.sections);
  const batchDrafts = needsYouDrafts(opts.sections, opts.drafts ?? []);
  return renderNeedsYouRegion(priority, batch, batchDrafts, {
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
 * Composes the TODAY region from three independent signals: the Budget
 * header line, the `today` section's task buckets (each H3 one Tier-C slot,
 * its window parsed from the label) and the ritual-written `## 📅 Calendar`.
 * A slot whose window overlaps a calendar event gets a preemption badge;
 * an event with the slot's exact window is the slot itself and does not.
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
 * One card per prep pack for this plan's date, chronological, from the
 * source's preps_dir; the optional `## 📋 Prep packs` body renders below as
 * free markdown. Omitted when neither exists.
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
      ${regionTitle("users", "Prep packs", { subtitle: packs.length > 0 ? `${packs.length} meeting${packs.length === 1 ? "" : "s"}` : "Notes" })}
      ${cards ? `<div class="cockpit-prep-cards">${cards}</div>` : ""}
      ${sectionBody}
    </section>
  `;
}

/* -------------------------------------------------------------------------- */
/* BRIEF — Cockpit Mode 90-second morning narrative (v0.11+)                  */
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
    // When NEEDS YOU rendered above, an "All caught up" message here would
    // contradict it, so Cockpit Mode plans drop the region entirely.
    if (needsYouPresent) return "";
    return `
      <section class="cockpit-region cockpit-region-needs cockpit-region-empty" data-region="must-do-today" aria-label="Must do today">
        ${regionTitle("zap", "Must do today", { count: "All clear", countClass: "is-clear" })}
        <p class="cockpit-region-empty-msg">All caught up: nothing must happen today.</p>
      </section>
    `;
  }

  const decisionCards = decisions
    .map((d) => renderDecisionCard(d, { editable: opts.editable }))
    .join("\n");
  const taskBuckets = p0Buckets
    .map((b) => renderTaskBucket(b, { defaultOpen: true, editable: opts.editable }))
    .join("\n");

  const openCount = decisions.filter((d) => !d.decided).length +
    p0Buckets.reduce((n, b) => n + b.tasks.filter((t) => !t.done).length, 0);

  return `
    <section class="cockpit-region cockpit-region-needs cockpit-region-must-do" data-region="must-do-today" aria-label="Must do today">
      ${regionTitle("zap", "Must do today", { count: openCount ? `${openCount} open` : "All clear", countClass: openCount ? "" : "is-clear" })}
      ${decisionCards}
      ${taskBuckets}
    </section>
  `;
}

/* -------------------------------------------------------------------------- */
/* THIS WEEK — P1 / P2 / watch / stale / other task buckets                   */
/* -------------------------------------------------------------------------- */

function renderDoThisWeek(sections: PlanSection[], opts: MainColumnOpts): string {
  const buckets: TaskBucket[] = [];
  for (const s of sections.filter((s) => s.kind === "priority-tasks")) {
    for (const b of s.taskBuckets || []) {
      if (b.semantic !== "p0") buckets.push(b);
    }
  }

  // MUST DO TODAY's empty state covers "all caught up"; an empty region here
  // would only add noise.
  if (buckets.length === 0) return "";

  const totalTasks = buckets.reduce((n, b) => n + b.tasks.length, 0);
  const tasksDone = buckets.reduce((n, b) => n + b.tasks.filter((t) => t.done).length, 0);

  const bucketsHtml = buckets
    .map((b, i) => renderTaskBucket(b, { defaultOpen: i === 0, editable: opts.editable }))
    .join("\n");

  return `
    <section class="cockpit-region cockpit-region-today cockpit-region-this-week" data-region="do-this-week" aria-label="Do this week">
      ${regionTitle("listChecks", "This week", { count: `${tasksDone} / ${totalTasks} done` })}
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
  // Waiting, completed and sent-messages sections feed the rail (Wins,
  // Waiting on); the full markdown below keeps their verbatim text.
  { kind: "pr-queue", label: "PR queue", tone: "context" },
  { kind: "sync-state", label: "Sync state", tone: "context" },
  { kind: "other", label: "Other sections", tone: "context" },
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
      return `
        <details class="cockpit-collapsible cockpit-collapsible-${g.tone}" data-collapsible="${g.kind}">
          <summary class="cockpit-collapsible-summary">
            <span class="cockpit-collapsible-label">${escapeHtml(g.label)}</span>
            ${itemCount > 1 ? `<span class="cockpit-region-count">${itemCount}</span>` : ""}
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
          <span class="cockpit-region-subtitle">The plan file as written</span>
        </summary>
        <div class="cockpit-collapsible-body rendered-markdown">${fullMarkdownHtml}</div>
      </details>
    `
    : "";

  return `
    <section class="cockpit-region cockpit-region-collapsibles cockpit-region-more" aria-label="More — reference and context">
      ${regionTitle("layers", "More")}
      ${groupsHtml}
      ${fullCollapsible}
    </section>
  `;
}
