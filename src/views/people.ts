/**
 * People / commitments view (v0.13+).
 *
 * CRM-shaped read over ritual-generated artifacts: who owes me, whom I owe,
 * last touch, next meeting, prep packs. Entirely derived at read time —
 * see parsers/people.ts for the identity model and the no-roster rationale.
 */
import { escapeHtml, escapeAttr } from "../utils.js";
import type { PersonRecord } from "../parsers/people.js";

export interface PeopleViewOpts {
  people: PersonRecord[];
  windowDays: number;
}

function fmtTouch(t: NonNullable<PersonRecord["lastTouch"]>): string {
  const kindLabel =
    t.kind === "sent-draft" ? "message sent" : t.kind === "ticker" ? "agent action" : "meeting";
  const detail = t.detail ? ` — ${escapeHtml(t.detail)}` : "";
  return `${escapeHtml(t.date)} · ${kindLabel}${detail}`;
}

function renderCommitments(items: PersonRecord["theyOweMe"], emptyLabel: string): string {
  if (items.length === 0) return `<span class="people-empty">${escapeHtml(emptyLabel)}</span>`;
  return `<ul class="people-commitments">${items
    .map(
      (c) =>
        `<li><span class="people-commitment-text">${escapeHtml(c.text)}</span> <span class="people-commitment-date">${escapeHtml(c.date)}</span></li>`
    )
    .join("")}</ul>`;
}

export function peopleView(opts: PeopleViewOpts): string {
  const rows = opts.people
    .map((p) => {
      const prepLinks = p.prepPacks
        .slice(0, 3)
        .map(
          (pack) =>
            `<a class="people-prep-link" href="/prep/${encodeURIComponent(pack.sourceName)}/${encodeURIComponent(pack.slug)}" title="${escapeAttr(pack.title)}">${escapeHtml(pack.date)}</a>`
        )
        .join(" ");
      const nextMeeting = p.nextMeeting
        ? `${escapeHtml(p.nextMeeting.date)}${p.nextMeeting.time ? ` ${escapeHtml(p.nextMeeting.time)}` : ""}${p.nextMeeting.title ? ` · ${escapeHtml(p.nextMeeting.title)}` : ""}`
        : `<span class="people-empty">—</span>`;
      return `
        <article class="people-card">
          <header class="people-card-header">
            <h3 class="people-name">${escapeHtml(p.displayName)}</h3>
            <span class="people-touch">${p.lastTouch ? fmtTouch(p.lastTouch) : '<span class="people-empty">no recent touch</span>'}</span>
          </header>
          <div class="people-card-grid">
            <div class="people-cell">
              <h4 class="people-cell-label">They owe me <span class="people-count">${p.theyOweMe.length}</span></h4>
              ${renderCommitments(p.theyOweMe, "nothing tracked")}
            </div>
            <div class="people-cell">
              <h4 class="people-cell-label">I owe them <span class="people-count">${p.iOweThem.length}</span></h4>
              ${renderCommitments(p.iOweThem, "nothing open")}
            </div>
            <div class="people-cell">
              <h4 class="people-cell-label">Next meeting</h4>
              <p class="people-next-meeting">${nextMeeting}</p>
              ${prepLinks ? `<p class="people-preps">Prep: ${prepLinks}</p>` : ""}
            </div>
          </div>
        </article>
      `;
    })
    .join("\n");

  return `
    <hgroup>
      <h1>People</h1>
      <p>Commitments and touchpoints derived from the last ${opts.windowDays} days of plans, drafts, calendar sections, and prep packs. Nothing here is hand-maintained — it reflects what the files say.</p>
    </hgroup>
    ${opts.people.length === 0 ? `<p class="people-empty">No people signals in the scan window. People appear here when plans carry waiting-on items, drafts, calendar attendees, or prep packs.</p>` : `<div class="people-list">${rows}</div>`}
  `;
}
