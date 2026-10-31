/**
 * The plan page's rail: the day's context beside the work.
 *
 *   1. Mini calendar — the month around the plan's date; days with a plan
 *      link to it.
 *   2. Portfolio — initiative lanes across the active sources, worst first,
 *      health named in words.
 *   3. Today's wins — done tasks, sent drafts and explicit `## Completed`
 *      / `## Sent messages` lines, deduplicated.
 *   4. Waiting on — `## Waiting on others` lines.
 *   5. Ledger — the newest catch-up ledger's open and decaying counts.
 *
 * Everything is derived from the plan's own sections (and the source's
 * files); the main column's Full markdown keeps the verbatim text.
 */
import { buildCalendarGrid } from "../plan.js";
import type { PlanEntry } from "../plan.js";
import type { PlanSection } from "../../parsers/plan-sections.js";
import { collectAllTasks } from "../../parsers/plan-sections.js";
import { renderSidebarItem, renderAsideEmpty, renderPortfolioList, type PortfolioLaneView } from "./cards.js";
import { escapeHtml } from "../../utils.js";
import { longDate } from "../ui.js";

export interface PlanRailOpts {
  sourceName: string;
  sections: PlanSection[];
  plansForCalendar: PlanEntry[];
  currentDate: string;
  portfolioLanes?: PortfolioLaneView[];
  latestLedger?: { date: string; openTotal: number; decaying: number };
}

export function renderPlanRail(opts: PlanRailOpts): string {
  const [year, month] = opts.currentDate.split("-").map(Number);
  const monthName = new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
  const monthPlans = opts.plansForCalendar.filter((p) => p.date.startsWith(`${year}-${String(month).padStart(2, "0")}`));

  const wins = collectWins(opts.sections);
  const waiting = collectWaiting(opts.sections);

  const winsHtml =
    wins.length === 0
      ? renderAsideEmpty("Nothing checked off yet today.")
      : `<ul class="cockpit-aside-list cockpit-aside-list-wins">${wins
          .map((w) => renderSidebarItem({ tone: "done", text: escapeHtml(w.text), suffix: w.suffix, title: w.text }))
          .join("\n")}</ul>`;

  const waitingHtml =
    waiting.length === 0
      ? renderAsideEmpty("Nothing waiting on others.")
      : `<ul class="cockpit-aside-list cockpit-aside-list-waiting">${waiting
          .map((w) => renderSidebarItem({ tone: "waiting", text: escapeHtml(w.text), suffix: w.suffix, title: w.text }))
          .join("\n")}</ul>`;

  const portfolio = opts.portfolioLanes && opts.portfolioLanes.length
    ? `<section class="card rail-card" aria-labelledby="rail-portfolio">
        <h2 class="rail-title" id="rail-portfolio">Portfolio <a href="/initiatives">All</a></h2>
        ${renderPortfolioList(opts.portfolioLanes)}
      </section>`
    : "";

  const ledger = opts.latestLedger
    ? `<section class="card rail-card cockpit-aside-section-ledger" aria-labelledby="rail-ledger">
        <h2 class="rail-title" id="rail-ledger">Catch-up ledger</h2>
        <a class="cockpit-ledger-digest" href="/ledger/${encodeURIComponent(opts.sourceName)}/${encodeURIComponent(opts.latestLedger.date)}">
          <span class="cockpit-ledger-date">${escapeHtml(longDate(opts.latestLedger.date))}</span>
          <span class="cockpit-ledger-open">${opts.latestLedger.openTotal} open</span>
          ${opts.latestLedger.decaying > 0 ? `<span class="cockpit-ledger-decaying">${opts.latestLedger.decaying} decaying</span>` : ""}
        </a>
      </section>`
    : "";

  return `
    <aside class="plan-rail cockpit-shell-aside-right" aria-label="Day context">
      <section class="card rail-card cockpit-aside-section-calendar" aria-labelledby="rail-cal">
        <h2 class="rail-title" id="rail-cal">${escapeHtml(monthName)} <a href="/plans?month=${year}-${String(month).padStart(2, "0")}">Calendar</a></h2>
        <div class="cal-mini cockpit-mini-cal">${buildCalendarGrid(year, month, monthPlans, opts.currentDate)}</div>
      </section>
      ${portfolio}
      <section class="card rail-card cockpit-aside-section-wins" aria-labelledby="rail-wins">
        <h2 class="rail-title" id="rail-wins">Today's wins ${wins.length ? `<span class="muted">${wins.length}</span>` : ""}</h2>
        ${winsHtml}
      </section>
      <section class="card rail-card cockpit-aside-section-waiting" aria-labelledby="rail-waiting">
        <h2 class="rail-title" id="rail-waiting">Waiting on ${waiting.length ? `<span class="muted">${waiting.length}</span>` : ""}</h2>
        ${waitingHtml}
      </section>
      ${ledger}
    </aside>
  `;
}

/* -------------------------------------------------------------------------- */
/* Section harvesting                                                          */
/* -------------------------------------------------------------------------- */

interface RailItem {
  text: string;
  suffix?: string;
}

function collectWins(sections: PlanSection[]): RailItem[] {
  const items: RailItem[] = [];

  // Done tasks: the wins the principal actually checked off today, even
  // when the plan has no explicit "## Completed today" section.
  for (const t of collectAllTasks(sections)) {
    if (!t.done) continue;
    const firstLine = (t.rawText.split("\n")[0] || "").trim();
    const text = stripMarkdown(firstLine.replace(/^\s*\d+\.\s+/, "").replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, ""));
    if (text) items.push({ text, suffix: t.doneTimestamp });
  }

  // Sent drafts: an H3 whose block carries a `**Sent:**` paragraph, or the
  // legacy H3-jammed SENT / strikethrough form.
  for (const s of sections) {
    if (s.kind !== "drafts") continue;
    for (const d of extractSentDraftsFromSection(s.rawBody)) items.push(d);
  }

  // Explicit "## Completed today" / "## Sent messages" sections.
  for (const s of sections) {
    if (s.kind !== "completed" && s.kind !== "sent-messages") continue;
    for (const ln of s.rawBody.split("\n")) {
      const bulletMatch = ln.trim().match(/^(?:[-*+]\s+|\d+\.\s+)(?:\[[xX]\]\s*)?(.+)$/);
      if (!bulletMatch) continue;
      const text = stripMarkdown(bulletMatch[1]);
      if (text) items.push({ text, suffix: extractTimestamp(text) || undefined });
    }
  }

  // The same draft sometimes appears in a drafts section and a sent-messages section.
  const seen = new Set<string>();
  const unique: RailItem[] = [];
  for (const it of items) {
    const key = it.text.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(it);
  }
  return unique.slice(0, 12);
}

/** Sent drafts in a drafts section body: one entry per sent H3 with a best-effort time. */
function extractSentDraftsFromSection(rawBody: string): RailItem[] {
  const lines = rawBody.split("\n");
  const out: RailItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const h3Match = lines[i].match(/^###\s+(.+?)\s*$/);
    if (!h3Match) continue;
    const heading = h3Match[1];
    const headingHasSent = /\bSENT\b/.test(heading) || /~~[^\n]+~~/.test(heading);

    let hasSentParagraph = false;
    let sentTime: string | undefined;
    for (let j = i + 1; j < Math.min(lines.length, i + 30); j++) {
      const nl = lines[j];
      if (/^#{1,3}\s/.test(nl)) break;
      const sentMatch = nl.match(/^\s*\*\*\s*Sent\s*:?\s*\*\*\s*(.+?)\s*$/i);
      if (sentMatch) {
        hasSentParagraph = true;
        const timeMatch = sentMatch[1].match(/(\d{1,2}:\d{2}(?:\s+[A-Z]{2,5})?)|(?:\b[A-Z][a-z]{2}\s+\d{1,2}\b)/);
        if (timeMatch) sentTime = timeMatch[0];
        break;
      }
    }
    if (!headingHasSent && !hasSentParagraph) continue;

    const title = stripMarkdown(
      heading
        .replace(/~~([^~]+)~~/, "$1")
        .replace(/✅\s*SENT\s+by[^—]*—?/i, "")
        .replace(/\bSENT\b.*$/i, "")
        .replace(/\s+/g, " ")
        .trim()
    );
    if (!title) continue;
    if (!sentTime) {
      const timeFromHeading = heading.match(/(\d{1,2}:\d{2}(?:\s+[A-Z]{2,5})?)/);
      if (timeFromHeading) sentTime = timeFromHeading[1];
    }
    out.push({ text: title, suffix: sentTime });
  }
  return out;
}

function collectWaiting(sections: PlanSection[]): RailItem[] {
  const items: RailItem[] = [];
  for (const s of sections) {
    if (s.kind !== "waiting") continue;
    for (const ln of s.rawBody.split("\n")) {
      const bulletMatch = ln.trim().match(/^(?:[-*+]\s+|\d+\.\s+)(?:\[[xX]\]\s*)?(.+)$/);
      if (!bulletMatch) continue;
      const text = stripMarkdown(bulletMatch[1]);
      if (text) items.push({ text });
    }
  }
  return items.slice(0, 12);
}

/** Plain text of a markdown line: bold, italic, code, links and strikethrough removed. */
function stripMarkdown(s: string): string {
  return s
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/_([^_]+)_/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .replace(/^\s*✅\s*/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** "HH:MM TZ" or "HH:MM" from a win line, for the row's trailing time. */
function extractTimestamp(text: string): string | null {
  const m = text.match(/\b(\d{1,2}:\d{2}(?:\s+[A-Z]{2,5})?)\b/);
  return m ? m[1] : null;
}
