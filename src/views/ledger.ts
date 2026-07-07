/**
 * Catch-up ledger view (v0.14+).
 *
 * Renders one LedgerDoc as the live version of the accounting close the
 * synthesis-catchup-ledger skill produces: open load first (actionable /
 * decaying / delegated), then the closed groups (done-late, expired,
 * released) as collapsed disclosures — credit and lessons are one click
 * away, not competing with the live work.
 *
 * Rows whose item text reads as recognition (kudos / thanks / congrats)
 * get a tag chip so the consolidated-send pattern (working-system-v3
 * §2.2 decay rule) is visible at a glance. The tag is presentation only —
 * sending still happens through drafts in the daily plan, which already
 * have the send machinery; duplicating a send path here would create a
 * second place for send-state to drift.
 */
import MarkdownIt from "markdown-it";
import { escapeHtml } from "../utils.js";
import type { LedgerDoc, LedgerEntry, LedgerSection, LedgerState } from "../parsers/ledger.js";

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

const STATE_LABEL: Record<LedgerState, string> = {
  actionable: "Actionable",
  decaying: "Decaying",
  delegated: "Delegated — verify",
  "done-late": "Done late",
  expired: "Expired → lesson",
  released: "Released",
  other: "",
};

const KUDOS_RE = /kudos|thank|recognition|congrats|appreciation/i;

function renderStateChip(state: LedgerState): string {
  if (state === "other") return "";
  return `<span class="ledger-chip ledger-chip-${state}">${escapeHtml(STATE_LABEL[state])}</span>`;
}

function renderSectionTable(s: LedgerSection): string {
  if (s.rows.length === 0) return "";
  const header = s.columns.length > 0
    ? `<thead><tr>${s.columns.map((c) => `<th>${md.renderInline(c)}</th>`).join("")}<th></th></tr></thead>`
    : "";
  const body = s.rows
    .map((r) => {
      const isKudos = r.cells.some((c) => KUDOS_RE.test(c));
      const kudosTag = isKudos ? `<span class="ledger-chip ledger-chip-kudos">recognition</span>` : "";
      const cells = r.cells.map((c) => `<td>${md.renderInline(c)}</td>`).join("");
      return `<tr class="ledger-row ledger-row-${r.state}">${cells}<td class="ledger-row-chips">${renderStateChip(r.state)}${kudosTag}</td></tr>`;
    })
    .join("\n");
  return `<div class="ledger-table-wrap"><table class="ledger-table">${header}<tbody>${body}</tbody></table></div>`;
}

function renderSection(s: LedgerSection, openByDefault: boolean): string {
  const table = renderSectionTable(s);
  const prose = s.proseMarkdown ? `<div class="ledger-prose rendered-markdown">${md.render(s.proseMarkdown)}</div>` : "";
  const count = s.rows.length > 0 ? ` <span class="ledger-section-count">${s.rows.length}</span>` : "";
  const openAttr = openByDefault ? " open" : "";
  return `
    <details class="ledger-section ledger-section-${s.state}"${openAttr}>
      <summary class="ledger-section-summary">${escapeHtml(s.rawHeading)}${count}</summary>
      <div class="ledger-section-body">
        ${table}
        ${prose}
      </div>
    </details>
  `;
}

const OPEN_STATES: LedgerState[] = ["actionable", "decaying", "delegated"];

export function ledgerView(opts: { doc: LedgerDoc; allLedgers: LedgerEntry[] }): string {
  const { doc } = opts;
  const openTotal = doc.openCounts.actionable + doc.openCounts.decaying + doc.openCounts.delegated;

  const otherLedgers = opts.allLedgers.filter(
    (l) => !(l.date === doc.date && l.sourceName === doc.sourceName)
  );
  const historyLinks = otherLedgers.length > 0
    ? `<p class="ledger-history">Other sweeps: ${otherLedgers
        .map(
          (l) =>
            `<a href="/ledger/${encodeURIComponent(l.sourceName)}/${encodeURIComponent(l.date)}">${escapeHtml(l.date)}</a> <span class="source-badge">${escapeHtml(l.sourceName)}</span>`
        )
        .join(" · ")}</p>`
    : "";

  const openSections = doc.sections.filter((s) => OPEN_STATES.includes(s.state));
  const closedSections = doc.sections.filter((s) => !OPEN_STATES.includes(s.state));

  return `
    <hgroup>
      <h1>Ledger — ${escapeHtml(doc.date)} <span class="source-badge">${escapeHtml(doc.sourceName)}</span></h1>
      <p>${openTotal} open item${openTotal === 1 ? "" : "s"} (${doc.openCounts.actionable} actionable · ${doc.openCounts.decaying} decaying · ${doc.openCounts.delegated} delegated-unverified). Produced by the catch-up sweep; the console renders — the ledger file is the record.</p>
    </hgroup>
    ${doc.headerMarkdown ? `<div class="ledger-header rendered-markdown">${md.render(doc.headerMarkdown)}</div>` : ""}
    ${openSections.map((s) => renderSection(s, true)).join("\n")}
    ${closedSections.map((s) => renderSection(s, false)).join("\n")}
    ${historyLinks}
  `;
}

export function ledgerEmptyView(): string {
  return `
    <hgroup>
      <h1>Ledger</h1>
      <p>No catch-up ledgers found in the active sources. Ledgers are produced by the synthesis-catchup-ledger skill after a gap in the daily-ritual cadence and live in a source's <code>catchup-ledgers/</code> directory.</p>
    </hgroup>
  `;
}
