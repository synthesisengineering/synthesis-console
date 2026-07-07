/**
 * Card primitives for the v0.9 cockpit.
 *
 * Pure renderers (no side effects) for the typed UI elements the cockpit
 * composes: decision cards, task rows, draft cards, sidebar list items,
 * project list rows, progress bar.
 *
 * Extracted from `plan-cockpit.ts` in v0.9.0 so the new three-column shell
 * (`shell.ts`) and column views (`main-column.ts`, `sidebar-left.ts`,
 * `sidebar-right.ts`) can compose cards without duplicating their HTML
 * shape.
 *
 * Behavioral parity with v0.8.x: the existing `.cockpit-decision`,
 * `.cockpit-task`, `.cockpit-bucket`, `.draft-actions`, `.cockpit-region-*`
 * classes are preserved so all existing CSS and JS handlers (decision pick,
 * task checkbox, filter chips, find, mtime auto-refresh, etc.) keep working
 * unchanged. v0.9 adds compact variants (`.cockpit-task-compact`,
 * `.cockpit-decision-compact`) and new sidebar primitives — additive only.
 */
import MarkdownIt from "markdown-it";
import type {
  Decision,
  TaskBucket,
  PlanTask,
  TaskSemantic,
} from "../../parsers/plan-sections.js";
import type { DraftBlock } from "../../parsers/draft-blocks.js";
import { parseTickerBody } from "../../parsers/ticker.js";
import type { TickerItem } from "../../parsers/ticker.js";
import { escapeHtml, escapeAttr } from "../../utils.js";

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

/* -------------------------------------------------------------------------- */
/* Day-of-week + relative-age helpers (used by glance bar, sidebars, cards)   */
/* -------------------------------------------------------------------------- */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function getDayOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  return DAYS[new Date(y, m - 1, d).getDay()];
}

export function fmtAge(mtimeMs: number): string {
  const now = Date.now();
  const diffMs = now - mtimeMs;
  if (diffMs < 0) return "just now";
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hr ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/* -------------------------------------------------------------------------- */
/* Glance counts                                                              */
/* -------------------------------------------------------------------------- */

export function renderCount(label: string, openCount: number, total: number, tone: string): string {
  const display = total === 0 ? "0" : openCount === total ? `${total}` : `${openCount} / ${total}`;
  return `
    <span class="cockpit-count cockpit-count-${tone}" data-tone="${tone}">
      <span class="cockpit-count-num">${escapeHtml(display)}</span>
      <span class="cockpit-count-label">${escapeHtml(label)}</span>
    </span>
  `;
}

/**
 * Progress bar for the main column. CSS uses `--pct` to render the filled
 * portion in `--cockpit-done`. 0% (no tasks) renders as an empty track; 100%
 * renders fully filled. The percentage is also surfaced as text for screen
 * readers and as a small badge on the right.
 */
export function renderProgressBar(done: number, total: number): string {
  if (total === 0) {
    return `<div class="cockpit-progress" aria-hidden="true"><div class="cockpit-progress-bar" style="--pct:0"></div><div class="cockpit-progress-label muted">No tasks listed</div></div>`;
  }
  const pct = Math.round((done / total) * 100);
  return `
    <div class="cockpit-progress" role="progressbar" aria-valuenow="${done}" aria-valuemin="0" aria-valuemax="${total}" aria-label="Tasks done">
      <div class="cockpit-progress-bar" style="--pct:${pct}"></div>
      <div class="cockpit-progress-label">${done} of ${total} tasks done${pct === 100 ? " — all clear" : ""}</div>
    </div>
  `;
}

/* -------------------------------------------------------------------------- */
/* Decision card                                                              */
/* -------------------------------------------------------------------------- */

export interface DecisionCardOpts {
  editable: boolean;
}

export function renderDecisionCard(d: Decision, opts: DecisionCardOpts): string {
  const decidedNote = d.decided
    ? `<p class="cockpit-decision-decided-note">Decided: <strong>Option ${escapeHtml(d.decidedOption || "")}</strong>${d.decidedAt ? ` — ${escapeHtml(d.decidedAt)}` : ""}</p>`
    : "";

  // Synthetic / no-options case: show the question + body prose verbatim,
  // no option buttons. Used for "Open ask"-style asks where the producer
  // emitted a single H2 with prose instead of A/B/C structure.
  if (d.options.length === 0) {
    const body = d.bodyMarkdown ? md.render(d.bodyMarkdown) : "";
    return `
      <article class="cockpit-card cockpit-decision cockpit-decision-ask" data-decision-index="${d.index}" data-decided="${d.decided ? "true" : "false"}">
        <h3 class="cockpit-decision-question">${escapeHtml(d.question)}</h3>
        ${decidedNote}
        <div class="cockpit-decision-ask-body rendered-markdown">${body}</div>
      </article>
    `;
  }

  const optionButtons = d.options
    .map((o) => {
      const isChosen = d.decided && d.decidedOption === o.letter;
      const isUnchosen = d.decided && d.decidedOption !== o.letter;
      const cls = isChosen
        ? "cockpit-decision-option cockpit-decision-chosen"
        : isUnchosen
          ? "cockpit-decision-option cockpit-decision-unchosen"
          : "cockpit-decision-option";
      const isRecommended = !d.decided && d.recommendationLetter === o.letter;
      const recBadge = isRecommended
        ? '<span class="cockpit-decision-rec-badge">Recommended</span>'
        : "";
      const disabled = d.decided || !opts.editable ? " disabled" : "";
      return `
        <button type="button" class="${cls}" data-decision-index="${d.index}" data-option="${escapeAttr(o.letter)}"${disabled}>
          <span class="cockpit-decision-letter">${escapeHtml(o.letter)}</span>
          <span class="cockpit-decision-body">${md.renderInline(o.body)}</span>
          ${recBadge}
        </button>
      `;
    })
    .join("\n");

  const recommendation =
    !d.decided && d.recommendationLetter
      ? `<p class="cockpit-decision-rec"><strong>Recommendation:</strong> Option ${escapeHtml(d.recommendationLetter)}${d.recommendationBody ? ` — ${md.renderInline(d.recommendationBody)}` : ""}</p>`
      : "";

  // Inline body context (paragraphs that aren't options or recommendation).
  const contextBody = d.bodyMarkdown && d.bodyMarkdown.length > 0
    ? `<div class="cockpit-decision-context rendered-markdown">${md.render(d.bodyMarkdown)}</div>`
    : "";

  return `
    <article class="cockpit-card cockpit-decision" data-decision-index="${d.index}" data-decided="${d.decided ? "true" : "false"}">
      <h3 class="cockpit-decision-question">${escapeHtml(d.question)}</h3>
      ${decidedNote}
      ${contextBody}
      <div class="cockpit-decision-options" role="group" aria-label="Decision options">
        ${optionButtons}
      </div>
      ${recommendation}
      <div class="cockpit-decision-status" role="status" aria-live="polite"></div>
    </article>
  `;
}

/* -------------------------------------------------------------------------- */
/* Task buckets and tasks                                                     */
/* -------------------------------------------------------------------------- */

export function semanticToTone(s: TaskSemantic): string {
  if (s === "p0") return "critical";
  if (s === "p1") return "action";
  if (s === "p2") return "context";
  if (s === "watch") return "waiting";
  if (s === "stale") return "waiting";
  return "context";
}

export interface TaskBucketOpts {
  defaultOpen: boolean;
  editable: boolean;
}

export function renderTaskBucket(b: TaskBucket, opts: TaskBucketOpts): string {
  const tone = semanticToTone(b.semantic);
  const doneCount = b.tasks.filter((t) => t.done).length;
  const totalCount = b.tasks.length;
  const label = b.label || "Tasks";
  const openAttr = opts.defaultOpen ? " open" : "";
  const tasksHtml = b.tasks.map((t) => renderTask(t, { editable: opts.editable })).join("\n");

  return `
    <details class="cockpit-bucket cockpit-bucket-${tone}" data-bucket-semantic="${b.semantic}" data-bucket-index="${b.index}"${openAttr}>
      <summary class="cockpit-bucket-summary">
        <span class="cockpit-bucket-label">${escapeHtml(label)}</span>
        <span class="cockpit-bucket-count">${doneCount} / ${totalCount}</span>
      </summary>
      <ol class="cockpit-task-list">
        ${tasksHtml}
      </ol>
    </details>
  `;
}

export interface TaskRowOpts {
  editable: boolean;
}

export function renderTask(t: PlanTask, opts: TaskRowOpts): string {
  const checked = t.done ? " checked" : "";
  // Strip the leading list marker from the rendered HTML body for cleaner inline rendering.
  const inlineBody = stripListWrapper(t.rendered);
  const doneBadge = t.done && t.doneTimestamp
    ? `<span class="cockpit-task-done-badge">${escapeHtml(t.doneTimestamp)}</span>`
    : "";
  const editableAttr = opts.editable ? "" : " data-readonly=\"true\"";
  return `
    <li class="cockpit-task${t.done ? " cockpit-task-done" : ""}" data-task-index="${t.index}" data-original-text="${escapeAttr(t.rawText)}"${editableAttr}>
      <label class="cockpit-task-label">
        <input type="checkbox" class="cockpit-task-check"${checked}${opts.editable ? "" : " disabled"} aria-label="Mark task ${t.index + 1} ${t.done ? "not done" : "done"}">
        <span class="cockpit-task-body">${inlineBody}</span>
        ${doneBadge}
      </label>
      <span class="cockpit-task-status" role="status" aria-live="polite"></span>
    </li>
  `;
}

/**
 * Compact task row for the MUST DO TODAY region — flat row, no bucket
 * surround, tighter spacing. Used when a P0 task gets promoted alongside
 * a decision card. Same data-original-text + checkbox semantics as the
 * full row, so all existing JS handlers work unchanged.
 */
export function renderTaskCompact(t: PlanTask, opts: TaskRowOpts): string {
  const checked = t.done ? " checked" : "";
  const inlineBody = stripListWrapper(t.rendered);
  const doneBadge = t.done && t.doneTimestamp
    ? `<span class="cockpit-task-done-badge">${escapeHtml(t.doneTimestamp)}</span>`
    : "";
  const editableAttr = opts.editable ? "" : " data-readonly=\"true\"";
  return `
    <li class="cockpit-task cockpit-task-compact${t.done ? " cockpit-task-done" : ""}" data-task-index="${t.index}" data-original-text="${escapeAttr(t.rawText)}"${editableAttr}>
      <label class="cockpit-task-label">
        <input type="checkbox" class="cockpit-task-check"${checked}${opts.editable ? "" : " disabled"} aria-label="Mark task ${t.index + 1} ${t.done ? "not done" : "done"}">
        <span class="cockpit-task-body">${inlineBody}</span>
        ${doneBadge}
      </label>
      <span class="cockpit-task-status" role="status" aria-live="polite"></span>
    </li>
  `;
}

export function stripListWrapper(html: string): string {
  // markdown-it wraps single-paragraph items in <p>...</p>; drop it.
  const trimmed = html.trim();
  const m = trimmed.match(/^<p>([\s\S]*?)<\/p>\s*$/);
  if (m) return m[1];
  // Numbered list might wrap the whole thing in <ol><li>...</li></ol>; unwrap.
  const ol = trimmed.match(/^<ol[^>]*>\s*<li[^>]*>([\s\S]*)<\/li>\s*<\/ol>\s*$/);
  if (ol) {
    const inner = ol[1].trim();
    const innerP = inner.match(/^<p>([\s\S]*?)<\/p>\s*$/);
    return innerP ? innerP[1] : inner;
  }
  return trimmed;
}

/* -------------------------------------------------------------------------- */
/* v0.10 — NEEDS YOU one-tap draft card                                       */
/* -------------------------------------------------------------------------- */

/**
 * Compact draft card for the NEEDS YOU one-tap batch review.
 *
 * Layout:
 *   - Header: recipient + first-line preview + character count.
 *   - Body:   `<details>` disclosure with the full rendered body inside.
 *   - Actions: SKIP · EDIT · APPROVE (three buttons, keyboard-navigable).
 *
 * The card uses the same `data-draft-index` attribute as the standard draft
 * region, so the existing edit-in-place JS handlers continue to work when
 * EDIT toggles inline. APPROVE routes to the send flow (with confirm modal
 * unless the source's `tier_a_send_enabled` is true AND the draft carries
 * a Tier-A marker, per D2 in the execution plan). SKIP posts to
 * `/plans/:source/:date/draft/:index/skip`.
 *
 * Sent drafts render dimmed with an inline "Sent HH:MM" badge and no
 * action buttons — matches the sent-state treatment in the standard region.
 * Skipped drafts render dimmed with a "Skipped HH:MM" badge and an "Undo"
 * button (POST-based; server rejects to prevent Sent→Skipped→Sent races).
 */
export interface OneTapDraftOpts {
  editable: boolean;
  sourceName: string;
  planDate: string;
  slackConfigured: boolean;
  tierASendEnabled: boolean;
}

export function renderOneTapDraft(d: DraftBlock, opts: OneTapDraftOpts): string {
  const recipient = d.sendToText ? escapeHtml(d.sendToText) : "(no recipient)";
  const rawBody = d.bodyText ?? "";
  const preview = extractFirstLine(rawBody);
  const chars = rawBody.length;
  const bodyHtml = md.render(rawBody);
  const bodyTextAttr = escapeAttr(rawBody);

  const cardState = d.alreadySent ? "sent" : d.alreadySkipped ? "skipped" : "open";
  const badge =
    d.alreadySent && d.sentAt
      ? `<span class="cockpit-onetap-badge cockpit-onetap-badge-sent">Sent · ${escapeHtml(d.sentAt)}</span>`
      : d.alreadySent
        ? `<span class="cockpit-onetap-badge cockpit-onetap-badge-sent">Sent</span>`
        : d.alreadySkipped && d.skippedAt
          ? `<span class="cockpit-onetap-badge cockpit-onetap-badge-skipped">Skipped · ${escapeHtml(d.skippedAt)}</span>`
          : d.alreadySkipped
            ? `<span class="cockpit-onetap-badge cockpit-onetap-badge-skipped">Skipped</span>`
            : "";

  const permalinkBtn =
    d.alreadySent && d.sentPermalink
      ? `<a class="cockpit-onetap-btn cockpit-onetap-btn-permalink" href="${escapeAttr(d.sentPermalink)}" target="_blank" rel="noopener">View in Slack</a>`
      : "";

  const canAct = opts.editable && cardState === "open";
  const canUndoSkip = opts.editable && cardState === "skipped";

  const actions = canAct
    ? `
      <div class="cockpit-onetap-actions" role="group" aria-label="One-tap actions">
        <button type="button" class="cockpit-onetap-btn cockpit-onetap-btn-skip" data-onetap-action="skip" data-draft-index="${d.index}">Skip</button>
        <button type="button" class="cockpit-onetap-btn cockpit-onetap-btn-edit" data-onetap-action="edit" data-draft-index="${d.index}">Edit</button>
        <button type="button" class="cockpit-onetap-btn cockpit-onetap-btn-approve" data-onetap-action="approve" data-draft-index="${d.index}" data-slack-configured="${opts.slackConfigured ? "true" : "false"}" data-tier-a-enabled="${opts.tierASendEnabled ? "true" : "false"}"${opts.slackConfigured ? "" : ' title="Slack not configured — Approve will copy the body and open Slack"'}>Approve</button>
      </div>
    `
    : canUndoSkip
      ? `
      <div class="cockpit-onetap-actions" role="group" aria-label="Undo skip">
        <button type="button" class="cockpit-onetap-btn cockpit-onetap-btn-undo-skip" data-onetap-action="undo-skip" data-draft-index="${d.index}">Undo skip</button>
      </div>
    `
      : "";

  return `
    <article class="cockpit-onetap-draft cockpit-onetap-state-${cardState}" data-draft-index="${d.index}" data-body-text="${bodyTextAttr}" data-source="${escapeAttr(opts.sourceName)}" data-date="${escapeAttr(opts.planDate)}">
      <header class="cockpit-onetap-header">
        <span class="cockpit-onetap-recipient" title="Send to">${recipient}</span>
        <span class="cockpit-onetap-preview" title="Body preview">${escapeHtml(preview)}</span>
        <span class="cockpit-onetap-meta">${chars} chars${badge ? ` · ${badge}` : ""}</span>
      </header>
      <details class="cockpit-onetap-body">
        <summary class="cockpit-onetap-body-summary">Show full body</summary>
        <div class="cockpit-onetap-body-content rendered-markdown">${bodyHtml}</div>
      </details>
      <div class="cockpit-onetap-status" role="status" aria-live="polite"></div>
      ${permalinkBtn}
      ${actions}
    </article>
  `;
}

/**
 * NEEDS YOU region wrapper. Composes: priority decisions + one-tap batch
 * drafts + light decisions (from `## ⚡ Decision needed` and
 * `## ☑️ One-tap batch` H2s). Renders empty-state when both are absent.
 *
 * openCount = un-decided decisions + un-actioned drafts.
 */
export interface NeedsYouOpts {
  editable: boolean;
  sourceName: string;
  planDate: string;
  slackConfigured: boolean;
  tierASendEnabled: boolean;
}

export function renderNeedsYouRegion(
  priorityDecisions: Decision[],
  batchDecisions: Decision[],
  batchDrafts: DraftBlock[],
  opts: NeedsYouOpts
): string {
  const hasContent = priorityDecisions.length + batchDecisions.length + batchDrafts.length > 0;
  if (!hasContent) {
    return "";
  }

  const openCount =
    priorityDecisions.filter((d) => !d.decided).length +
    batchDecisions.filter((d) => !d.decided).length +
    batchDrafts.filter((d) => !d.alreadySent && !d.alreadySkipped).length;

  const priorityHtml = priorityDecisions
    .map((d) => renderDecisionCard(d, { editable: opts.editable }))
    .join("\n");
  const batchDecisionsHtml = batchDecisions
    .map((d) => renderDecisionCard(d, { editable: opts.editable }))
    .join("\n");
  const batchDraftsHtml = batchDrafts
    .map((draft) => renderOneTapDraft(draft, {
      editable: opts.editable,
      sourceName: opts.sourceName,
      planDate: opts.planDate,
      slackConfigured: opts.slackConfigured,
      tierASendEnabled: opts.tierASendEnabled,
    }))
    .join("\n");

  const priorityWrap = priorityHtml
    ? `<div class="cockpit-needs-priority">${priorityHtml}</div>`
    : "";
  const batchWrap = batchDecisionsHtml || batchDraftsHtml
    ? `<div class="cockpit-needs-batch">${batchDecisionsHtml}${batchDraftsHtml}</div>`
    : "";

  return `
    <section class="cockpit-region cockpit-region-needs-you" data-region="needs-you" aria-label="Needs you now">
      <h2 class="cockpit-region-title">NEEDS YOU
        <span class="cockpit-region-count">${openCount} open</span>
      </h2>
      ${priorityWrap}
      ${batchWrap}
    </section>
  `;
}

/* -------------------------------------------------------------------------- */
/* v0.10 — TICKER region ("On your behalf")                                   */
/* -------------------------------------------------------------------------- */

export function renderTickerItem(item: TickerItem): string {
  if (item.time || item.target || item.action) {
    const timeCell = item.time
      ? `<span class="cockpit-ticker-time">${escapeHtml(item.time)}</span>`
      : "";
    const targetCell = item.target
      ? `<span class="cockpit-ticker-target">${escapeHtml(item.target)}</span>`
      : "";
    const actionCell = item.action
      ? `<span class="cockpit-ticker-action">${md.renderInline(item.action)}</span>`
      : "";
    const permalinkCell = item.permalink
      ? `<a class="cockpit-ticker-permalink" href="${escapeAttr(item.permalink)}" target="_blank" rel="noopener">View</a>`
      : "";
    return `
      <li class="cockpit-ticker-item">
        ${timeCell}
        ${targetCell}
        ${actionCell}
        ${permalinkCell}
      </li>
    `;
  }
  // Fallback for lines the parser didn't recognize — render as raw markdown
  // list item so no data is lost.
  return `<li class="cockpit-ticker-item cockpit-ticker-item-raw">${md.renderInline(item.rawLine.replace(/^\s*[-*+]\s+/, ""))}</li>`;
}

export function renderTickerRegion(rawBody: string, openByDefault = false): string {
  const items = parseTickerBody(rawBody);
  const itemsHtml = items.map(renderTickerItem).join("\n");
  const summary = items.length === 1
    ? "On your behalf — 1 action"
    : `On your behalf — ${items.length} action${items.length === 1 ? "" : "s"}`;
  const openAttr = openByDefault ? " open" : "";
  const bodyHtml = items.length > 0
    ? `<ul class="cockpit-ticker-list">${itemsHtml}</ul>`
    : `<p class="cockpit-ticker-empty">Nothing acted on yet.</p>`;

  return `
    <section class="cockpit-region cockpit-region-ticker" data-region="ticker" aria-label="On your behalf">
      <details class="cockpit-ticker-details"${openAttr}>
        <summary class="cockpit-ticker-summary">${escapeHtml(summary)}</summary>
        <div class="cockpit-ticker-body">${bodyHtml}</div>
      </details>
    </section>
  `;
}

/* -------------------------------------------------------------------------- */
/* v0.12 — Portfolio lane strip                                               */
/* -------------------------------------------------------------------------- */

/**
 * Horizontal strip of initiative lanes at the very top of the main column.
 * One chip per active initiative across ALL active sources — this is the
 * CPTO-era "one cockpit, many lanes" surface. Each chip: health dot +
 * initiative name + member count, linking to the initiative detail page.
 *
 * Health is file-derived (CONTEXT.md markers with staleness fallback —
 * see parsers/portfolio.ts). There is deliberately no way to set health
 * from this UI: hand-curated lanes rot; ritual-generated lanes stay true.
 */
export interface PortfolioLaneView {
  sourceName: string;
  initiativeId: string;
  initiativeName: string;
  health: "critical" | "warning" | "healthy" | "unknown";
  memberCount: number;
  tooltip: string;
}

export function renderPortfolioStrip(lanes: PortfolioLaneView[]): string {
  if (lanes.length === 0) return "";
  // Worst lanes first so 🔴 is never below the fold of the strip.
  const order = { critical: 0, warning: 1, healthy: 2, unknown: 3 } as const;
  const sorted = [...lanes].sort((a, b) => order[a.health] - order[b.health]);
  const chips = sorted
    .map((lane) => {
      const href = `/initiatives/${encodeURIComponent(lane.sourceName)}/${encodeURIComponent(lane.initiativeId)}`;
      const title = lane.tooltip ? ` title="${escapeAttr(lane.tooltip)}"` : "";
      return `
        <a class="cockpit-lane cockpit-lane-${lane.health}" href="${escapeAttr(href)}"${title}>
          <span class="cockpit-lane-dot" aria-hidden="true"></span>
          <span class="cockpit-lane-name">${escapeHtml(lane.initiativeName)}</span>
          <span class="cockpit-lane-count">${lane.memberCount}</span>
        </a>
      `;
    })
    .join("\n");
  return `
    <nav class="cockpit-region cockpit-region-portfolio" data-region="portfolio" aria-label="Portfolio lanes">
      <div class="cockpit-lane-strip">${chips}</div>
    </nav>
  `;
}

/* -------------------------------------------------------------------------- */
/* v0.12 — TODAY region (budget bar + Tier-C slots + calendar)                */
/* -------------------------------------------------------------------------- */

/**
 * Budget bar: one horizontal track showing committed vs buffer minutes
 * within the day's discretionary total. The arithmetic line renders the
 * exact numbers so the bar is a glance aid, not the only source.
 */
export interface BudgetBarData {
  totalMinutes: number;
  committedMinutes: number;
  bufferMinutes: number;
  committedPercent: number;
}

export function renderBudgetBar(b: BudgetBarData): string {
  if (b.totalMinutes <= 0) return "";
  const committedPct = Math.min(100, Math.round((b.committedMinutes / b.totalMinutes) * 100));
  const overCommitted = b.committedPercent > 70;
  return `
    <div class="cockpit-budget" role="img" aria-label="Time budget: ${b.committedMinutes} of ${b.totalMinutes} minutes committed, ${b.bufferMinutes} minutes buffer">
      <div class="cockpit-budget-track">
        <div class="cockpit-budget-committed${overCommitted ? " cockpit-budget-over" : ""}" style="--pct:${committedPct}"></div>
      </div>
      <div class="cockpit-budget-label">
        <span><strong>${b.committedMinutes}</strong> min committed (${b.committedPercent}%)</span>
        <span class="cockpit-budget-buffer"><strong>${b.bufferMinutes}</strong> min buffer</span>
        <span class="cockpit-budget-total">${b.totalMinutes} min total</span>
      </div>
      ${overCommitted ? `<p class="cockpit-budget-warning">Committed above the 70% guideline — preemption will cost a slot.</p>` : ""}
    </div>
  `;
}

/**
 * One calendar event row inside the TODAY region.
 */
export interface CalendarEventView {
  start?: string;
  end?: string;
  title?: string;
  attendees?: string;
  rawLine: string;
}

export function renderCalendarEvent(ev: CalendarEventView): string {
  if (ev.start && ev.end) {
    const attendees = ev.attendees
      ? `<span class="cockpit-cal-attendees">${escapeHtml(ev.attendees)}</span>`
      : "";
    return `
      <li class="cockpit-cal-event">
        <span class="cockpit-cal-time">${escapeHtml(ev.start)}–${escapeHtml(ev.end)}</span>
        <span class="cockpit-cal-title">${escapeHtml(ev.title || "")}</span>
        ${attendees}
      </li>
    `;
  }
  return `<li class="cockpit-cal-event cockpit-cal-event-raw">${md.renderInline(ev.rawLine.replace(/^\s*[-*+]\s+/, ""))}</li>`;
}

/**
 * A Tier-C slot card. The slot's window binding is parsed from the H3
 * label (e.g. "Deep 1 — CPTO board memo (window 09:30–11:00)"). When a
 * calendar event overlaps the window, the card gets a preemption badge —
 * visualized, not mourned, per working-system-v3 §2.2.
 */
export interface TodaySlotView {
  bucket: TaskBucket;
  window?: { start: string; end: string };
  overlapTitle?: string;
}

const SLOT_WINDOW_RE = /(\d{1,2}:\d{2})\s*[–\-—]\s*(\d{1,2}:\d{2})/;

export function extractSlotWindow(label: string): { start: string; end: string } | undefined {
  const m = label.match(SLOT_WINDOW_RE);
  return m ? { start: m[1], end: m[2] } : undefined;
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function windowsOverlap(
  a: { start: string; end: string },
  b: { start: string; end: string }
): boolean {
  return toMinutes(a.start) < toMinutes(b.end) && toMinutes(b.start) < toMinutes(a.end);
}

export function renderTodaySlot(slot: TodaySlotView, opts: TaskBucketOpts): string {
  const windowChip = slot.window
    ? `<span class="cockpit-slot-window">${escapeHtml(slot.window.start)}–${escapeHtml(slot.window.end)}</span>`
    : "";
  const preemption = slot.overlapTitle
    ? `<span class="cockpit-slot-preempted" title="A calendar event overlaps this window">⚡ ${escapeHtml(slot.overlapTitle)}</span>`
    : "";
  const tasksHtml = slot.bucket.tasks.map((t) => renderTask(t, { editable: opts.editable })).join("\n");
  const doneCount = slot.bucket.tasks.filter((t) => t.done).length;
  return `
    <article class="cockpit-slot${slot.overlapTitle ? " cockpit-slot-has-overlap" : ""}" data-bucket-index="${slot.bucket.index}">
      <header class="cockpit-slot-header">
        <span class="cockpit-slot-label">${escapeHtml(slot.bucket.label || "Deep work")}</span>
        ${windowChip}
        ${preemption}
        <span class="cockpit-slot-count">${doneCount} / ${slot.bucket.tasks.length}</span>
      </header>
      <ol class="cockpit-task-list">${tasksHtml}</ol>
    </article>
  `;
}

/**
 * TODAY region wrapper: budget bar + Tier-C slot cards + compact calendar.
 * Renders nothing when the plan has neither a `today` section, a Budget
 * line, nor a `calendar` section (legacy plans unchanged).
 */
export function renderTodayRegion(opts: {
  budget: BudgetBarData | null;
  slots: TodaySlotView[];
  events: CalendarEventView[];
  editable: boolean;
}): string {
  const hasContent = !!opts.budget || opts.slots.length > 0 || opts.events.length > 0;
  if (!hasContent) return "";

  const slotsHtml = opts.slots
    .map((s) => renderTodaySlot(s, { defaultOpen: true, editable: opts.editable }))
    .join("\n");
  const calendarHtml = opts.events.length > 0
    ? `
      <details class="cockpit-cal-details">
        <summary class="cockpit-cal-summary">Calendar — ${opts.events.length} event${opts.events.length === 1 ? "" : "s"}</summary>
        <ul class="cockpit-cal-list">${opts.events.map(renderCalendarEvent).join("\n")}</ul>
      </details>
    `
    : "";

  return `
    <section class="cockpit-region cockpit-region-today-slots" data-region="today" aria-label="Today's deep work">
      <h2 class="cockpit-region-title">TODAY
        <span class="cockpit-region-subtitle">${opts.slots.length > 0 ? `${opts.slots.length} deep slot${opts.slots.length === 1 ? "" : "s"}` : "budget"}</span>
      </h2>
      ${opts.budget ? renderBudgetBar(opts.budget) : ""}
      ${calendarHtml}
      ${slotsHtml}
    </section>
  `;
}

/* -------------------------------------------------------------------------- */
/* v0.11 — BRIEF region ("Brief")                                             */
/* -------------------------------------------------------------------------- */

/**
 * The ≤90-second morning narrative. Rendered right below the day header at
 * the top of the main column so it's the first substantive thing Rajiv
 * reads at day-start. Not collapsed by default (unlike TICKER); the content
 * IS the point of the region.
 *
 * The body is rendered markdown as-is. Producer contract (v2.10.0+ Cockpit
 * Mode): keep it a short paragraph (or a few sentences) — the "≤90 second"
 * bound is enforced by editorial discipline in the skill, not the parser.
 */
export function renderBriefRegion(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) {
    return "";
  }
  const bodyHtml = md.render(trimmed);
  return `
    <section class="cockpit-region cockpit-region-brief" data-region="brief" aria-label="Morning brief">
      <h2 class="cockpit-region-title">
        BRIEF
        <span class="cockpit-region-subtitle">≤90 seconds</span>
      </h2>
      <div class="cockpit-brief-body rendered-markdown">${bodyHtml}</div>
    </section>
  `;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * First non-blank content line, truncated to ~120 chars, with markdown link
 * text kept but URLs stripped. Used as the preview line in one-tap cards.
 */
function extractFirstLine(rawBody: string): string {
  for (const line of rawBody.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (trimmed.startsWith(">")) continue;
    if (trimmed.startsWith("```")) continue;
    // Strip markdown-link `[label](url)` → `label`.
    const cleaned = trimmed.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    return cleaned.length > 120 ? cleaned.slice(0, 117) + "…" : cleaned;
  }
  return "(empty body)";
}

/* -------------------------------------------------------------------------- */
/* Drafts region passthrough                                                  */
/* -------------------------------------------------------------------------- */

export function renderDraftsRegion(draftsHtml: string): string {
  if (!draftsHtml || draftsHtml.trim() === "") {
    return `
      <section class="cockpit-region cockpit-region-drafts cockpit-region-empty" data-region="drafts" aria-label="Drafts">
        <h2 class="cockpit-region-title">DRAFTS</h2>
        <p class="cockpit-region-empty-msg">No drafts in this plan.</p>
      </section>
    `;
  }
  return `
    <section class="cockpit-region cockpit-region-drafts" data-region="drafts" aria-label="Drafts">
      <h2 class="cockpit-region-title">DRAFTS</h2>
      <div class="cockpit-drafts-body rendered-markdown">${draftsHtml}</div>
    </section>
  `;
}

export function countDrafts(draftsHtml: string): number {
  if (!draftsHtml) return 0;
  const matches = draftsHtml.match(/class="draft-actions"/g);
  return matches ? matches.length : 0;
}

export function countSentToday(draftsHtml: string): number {
  if (!draftsHtml) return 0;
  const matches = draftsHtml.match(/class="draft-actions draft-actions-sent"/g);
  return matches ? matches.length : 0;
}

/* -------------------------------------------------------------------------- */
/* Sidebar primitives (v0.9+)                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Generic sidebar list row: small status dot + text (truncated to one line)
 * + optional time/age suffix. Used by both sidebars for consistent rhythm.
 */
export function renderSidebarItem(opts: {
  tone: string;            // "critical" | "action" | "done" | "context" | "waiting"
  text: string;            // already-rendered inline HTML safe for inclusion
  suffix?: string;         // e.g. "11:14 EDT"
  href?: string;           // optional link
  title?: string;          // optional title attribute
}): string {
  const dot = `<span class="cockpit-aside-dot cockpit-aside-dot-${opts.tone}" aria-hidden="true"></span>`;
  const suffix = opts.suffix ? `<span class="cockpit-aside-suffix">${escapeHtml(opts.suffix)}</span>` : "";
  const titleAttr = opts.title ? ` title="${escapeAttr(opts.title)}"` : "";
  const inner = `${dot}<span class="cockpit-aside-text">${opts.text}</span>${suffix}`;
  if (opts.href) {
    return `<li class="cockpit-aside-row"><a href="${escapeAttr(opts.href)}"${titleAttr} class="cockpit-aside-link">${inner}</a></li>`;
  }
  return `<li class="cockpit-aside-row"${titleAttr}>${inner}</li>`;
}

/**
 * Project list row for the left sidebar. Status drives the dot color via the
 * existing `--cockpit-*` palette. Long names truncate with ellipsis at 28px
 * row height.
 */
export interface ProjectListRow {
  id: string;
  source: string;
  name: string;
  status: string;          // "active" | "paused" | "completed" | "archived" | "ongoing" | "new" | "superseded"
}

export function renderProjectListItem(p: ProjectListRow): string {
  const tone = projectStatusToTone(p.status);
  const href = `/projects/${encodeURIComponent(p.source)}/${encodeURIComponent(p.id)}`;
  return renderSidebarItem({
    tone,
    text: escapeHtml(p.name),
    href,
    title: `${p.name} — ${p.status}`,
  });
}

function projectStatusToTone(status: string): string {
  switch (status) {
    case "active":
    case "ongoing":
      return "action";
    case "paused":
      return "waiting";
    case "new":
      return "critical";
    case "completed":
      return "done";
    case "archived":
    case "superseded":
      return "context";
    default:
      return "context";
  }
}

/**
 * Empty-state for any sidebar widget. Italic muted text.
 */
export function renderAsideEmpty(message: string): string {
  return `<p class="cockpit-aside-empty">${escapeHtml(message)}</p>`;
}
