/**
 * People / commitments view (v0.13+).
 *
 * CRM-shaped read over ritual-generated artifacts: who owes me, whom I owe,
 * last touch, next meeting, prep packs. Entirely derived at read time —
 * see parsers/people.ts for the identity model and the no-roster rationale.
 */
import { escapeHtml, escapeAttr } from "../utils.js";
import type { PersonRecord } from "../parsers/people.js";
import { icon } from "./icons.js";
import { emptyState, initials, pageHeader, shortDate, statTile } from "./ui.js";

export interface PeopleViewOpts {
  people: PersonRecord[];
  windowDays: number;
}

function fmtTouch(t: NonNullable<PersonRecord["lastTouch"]>): string {
  const kindLabel =
    t.kind === "sent-draft" ? "message sent" : t.kind === "ticker" ? "agent action" : "meeting";
  const detail = t.detail ? ` · ${escapeHtml(t.detail)}` : "";
  return `Last touch ${escapeHtml(shortDate(t.date))}, ${kindLabel}${detail}`;
}

function renderCommitments(items: PersonRecord["theyOweMe"], emptyLabel: string): string {
  if (items.length === 0) return `<span class="people-empty">${escapeHtml(emptyLabel)}</span>`;
  return `<ul class="people-commitments">${items
    .map(
      (c) =>
        `<li><span class="people-commitment-text">${escapeHtml(c.text)}</span> <span class="people-commitment-date">${escapeHtml(shortDate(c.date))}</span></li>`
    )
    .join("")}</ul>`;
}

export function peopleView(opts: PeopleViewOpts): string {
  const theyOwe = opts.people.reduce((n, p) => n + p.theyOweMe.length, 0);
  const iOwe = opts.people.reduce((n, p) => n + p.iOweThem.length, 0);
  const meetings = opts.people.filter((p) => p.nextMeeting).length;

  const rows = opts.people
    .map((p) => {
      const prepLinks = p.prepPacks
        .slice(0, 3)
        .map(
          (pack) =>
            `<a class="people-prep-link" href="/prep/${encodeURIComponent(pack.sourceName)}/${encodeURIComponent(pack.slug)}" title="${escapeAttr(pack.title)}">${escapeHtml(shortDate(pack.date))}</a>`
        )
        .join(" · ");
      const nextMeeting = p.nextMeeting
        ? `${escapeHtml(shortDate(p.nextMeeting.date))}${p.nextMeeting.time ? ` ${escapeHtml(p.nextMeeting.time)}` : ""}${p.nextMeeting.title ? `<br><span class="muted">${escapeHtml(p.nextMeeting.title)}</span>` : ""}`
        : `<span class="people-empty">None scheduled</span>`;
      return `
        <article class="card people-card">
          <header class="people-card-header">
            <span class="people-avatar" aria-hidden="true">${escapeHtml(initials(p.displayName))}</span>
            <h2 class="people-name">${escapeHtml(p.displayName)}</h2>
            <span class="people-touch">${p.lastTouch ? fmtTouch(p.lastTouch) : '<span class="people-empty">No recent touch</span>'}</span>
          </header>
          <div class="people-card-grid">
            <div class="people-cell">
              <h3 class="people-cell-label">They owe me <span class="people-count">${p.theyOweMe.length}</span></h3>
              ${renderCommitments(p.theyOweMe, "Nothing tracked")}
            </div>
            <div class="people-cell">
              <h3 class="people-cell-label">I owe them <span class="people-count">${p.iOweThem.length}</span></h3>
              ${renderCommitments(p.iOweThem, "Nothing open")}
            </div>
            <div class="people-cell">
              <h3 class="people-cell-label">Next meeting</h3>
              <p class="people-next-meeting">${nextMeeting}</p>
              ${prepLinks ? `<p class="people-preps">${icon("brief", "icon-sm")} Prep: ${prepLinks}</p>` : ""}
            </div>
          </div>
        </article>
      `;
    })
    .join("\n");

  return `
    ${pageHeader({
      title: "People",
      count: opts.people.length || "",
      lead: `Commitments and touchpoints from the last ${opts.windowDays} days of plans, drafts, calendar sections and prep packs. Nothing here is hand-kept: it reflects what the files say.`,
    })}
    ${opts.people.length
      ? `<div class="stats">
          ${statTile({ label: "They owe me", value: theyOwe, iconName: "arrowLeft" })}
          ${statTile({ label: "I owe them", value: iOwe, iconName: "arrowRight", tone: iOwe ? "warn" : undefined })}
          ${statTile({ label: "Upcoming meetings", value: meetings, iconName: "calendar" })}
        </div>
        <div class="people-list">${rows}</div>`
      : emptyState({
          icon: "users",
          title: "No people signals in this window",
          body: "People appear here when plans carry waiting-on items, drafts, calendar attendees or prep packs.",
        })}
  `;
}
