import type { Source } from "../config.js";
import { escapeHtml, escapeAttr } from "../utils.js";
import { icon } from "./icons.js";
import { emptyState, longDate, pageHeader, sourceBadge, todayIso } from "./ui.js";

export interface PlanEntry {
  date: string;
  filename: string;
  dayOfWeek: string;
  source: string;
}

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function getDayOfWeek(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  const date = new Date(y, m - 1, d);
  return DAYS[date.getDay()];
}

function monthName(year: number, month: number): string {
  return new Date(year, month - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function planListView(opts: {
  plans: PlanEntry[];
  sources: Source[];
  /** YYYY-MM to show; defaults to this month when it has plans, else the newest plan's month. */
  month?: string;
}): string {
  const { plans, sources } = opts;
  const today = todayIso();
  const multiSource = new Set(plans.map((p) => p.source)).size > 1;
  const labelFor = (name: string) => {
    const s = sources.find((x) => x.name === name);
    return s ? s.display_name || s.name : name;
  };

  if (plans.length === 0) {
    const hasPlanSource = sources.some((s) => s.plans_dir);
    return `${pageHeader({ title: "Daily plans", lead: "One plan per day, written by the day-start ritual and worked from the plan page." })}
${emptyState({
  icon: "calendar",
  title: "No daily plans yet",
  bodyHtml: hasPlanSource
    ? "No daily action plans were found in the selected sources."
    : "None of the selected sources provide daily plans. Declare <code>plans_dir</code> on a source to add them.",
})}`;
  }

  const months = [...new Set(plans.map((p) => p.date.slice(0, 7)))].sort();
  const thisMonth = today.slice(0, 7);
  const requested = opts.month && /^\d{4}-\d{2}$/.test(opts.month) ? opts.month : null;
  const shown = requested ?? (months.includes(thisMonth) ? thisMonth : months[months.length - 1]);
  const [y, m] = shown.split("-").map(Number);
  const monthPlans = plans.filter((p) => p.date.startsWith(shown));
  const prev = [...months].reverse().find((mm) => mm < shown);
  const next = months.find((mm) => mm > shown);

  const todayPlans = plans.filter((p) => p.date === today);
  const primary = todayPlans.length
    ? `<a class="btn btn-primary" href="/plans/${encodeURIComponent(todayPlans[0].source)}/${today}">${icon("calendar")}Today's plan</a>`
    : `<a class="btn" href="/plans/${encodeURIComponent(plans[0].source)}/${plans[0].date}">${icon("calendar")}Latest plan</a>`;
  const rolloverSources = [...new Set(plans.map((p) => p.source))];

  const nav = `<div class="month-nav">
    ${prev ? `<a class="btn btn-sm" href="/plans?month=${prev}" aria-label="Previous month with plans">${icon("chevronLeft")}</a>` : `<span class="btn btn-sm disabled" aria-hidden="true">${icon("chevronLeft")}</span>`}
    ${shown !== thisMonth ? `<a class="btn btn-sm" href="/plans?month=${thisMonth}">This month</a>` : ""}
    ${next ? `<a class="btn btn-sm" href="/plans?month=${next}" aria-label="Next month with plans">${icon("chevronRight")}</a>` : `<span class="btn btn-sm disabled" aria-hidden="true">${icon("chevronRight")}</span>`}
  </div>`;

  const recent = plans.slice(0, 12)
    .map(
      (p) => `<li><a class="cockpit-aside-link" href="/plans/${encodeURIComponent(p.source)}/${p.date}"><span class="cockpit-aside-dot cockpit-aside-dot-${p.date === today ? "action" : "context"}" aria-hidden="true"></span><span class="cockpit-aside-text">${escapeHtml(longDate(p.date))}</span><span class="cockpit-aside-suffix">${multiSource ? escapeHtml(labelFor(p.source)) : p.date.slice(0, 4)}</span></a></li>`
    )
    .join("");

  return `
    ${pageHeader({
      title: "Daily plans",
      count: plans.length,
      lead: "One plan per day, written by the day-start ritual and worked from the plan page.",
      actionsHtml: primary,
    })}
    <div class="plans-layout">
      <section class="card month-card" aria-labelledby="month-title">
        <div class="month-head">
          <h2 class="month-title" id="month-title">${escapeHtml(monthName(y, m))}</h2>
          <span class="muted">${monthPlans.length} plan${monthPlans.length === 1 ? "" : "s"}</span>
          ${nav}
        </div>
        ${buildCalendarGrid(y, m, monthPlans, today)}
      </section>
      <aside class="rail" aria-label="Recent plans">
        <section class="card rail-card" aria-labelledby="recent-plans-title">
          <h2 class="rail-title" id="recent-plans-title">Recent plans</h2>
          <ul class="cockpit-aside-list">${recent}</ul>
        </section>
        <section class="card rail-card" aria-labelledby="rollover-title">
          <h2 class="rail-title" id="rollover-title">Carried tasks</h2>
          <p class="section-note" style="margin:0 0 8px">Tasks that stay open across plans for a week or more.</p>
          <div class="stack-sm">${rolloverSources
            .map((s) => `<a class="btn btn-sm" href="/plans/${encodeURIComponent(s)}/rollover">${icon("repeat")}Rollover${multiSource ? ` · ${escapeHtml(labelFor(s))}` : ""}</a>`)
            .join("")}</div>
        </section>
        ${multiSource ? renderDuplicates(monthPlans, labelFor) : ""}
      </aside>
    </div>
  `;
}

export function buildCalendarGrid(
  year: number,
  month: number,
  plans: PlanEntry[],
  today: string
): string {
  // One plan per date for the calendar link (the first source wins); the
  // plans page lists dates that have plans from several sources.
  const planByDate = new Map<string, PlanEntry>();
  for (const p of plans) {
    if (!planByDate.has(p.date)) planByDate.set(p.date, p);
  }

  const firstDay = new Date(year, month - 1, 1).getDay();
  const daysInMonth = new Date(year, month, 0).getDate();

  let cells = "";
  for (let i = 0; i < firstDay; i++) {
    cells += `<td class="cal-empty"></td>`;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
    const plan = planByDate.get(dateStr);
    const isToday = dateStr === today;

    let classes = "cal-day";
    if (isToday) classes += " cal-today";
    if (plan) classes += " cal-has-plan";

    const current = isToday ? ' aria-current="date"' : "";
    const content = plan
      ? `<a href="/plans/${encodeURIComponent(plan.source)}/${dateStr}" aria-label="Plan for ${escapeAttr(longDate(dateStr))}"${current}>${day}</a>`
      : `<span${current}>${day}</span>`;

    cells += `<td class="${classes}">${content}</td>`;

    if ((firstDay + day) % 7 === 0 && day < daysInMonth) {
      cells += `</tr><tr>`;
    }
  }
  const trailing = (7 - ((firstDay + daysInMonth) % 7)) % 7;
  for (let i = 0; i < trailing; i++) cells += `<td class="cal-empty"></td>`;

  return `
    <table class="calendar-grid">
      <thead>
        <tr><th scope="col" abbr="Sunday">Sun</th><th scope="col" abbr="Monday">Mon</th><th scope="col" abbr="Tuesday">Tue</th><th scope="col" abbr="Wednesday">Wed</th><th scope="col" abbr="Thursday">Thu</th><th scope="col" abbr="Friday">Fri</th><th scope="col" abbr="Saturday">Sat</th></tr>
      </thead>
      <tbody>
        <tr>${cells}</tr>
      </tbody>
    </table>
  `;
}

function renderDuplicates(plans: PlanEntry[], labelFor: (name: string) => string): string {
  const byDate = new Map<string, PlanEntry[]>();
  for (const p of plans) {
    if (!byDate.has(p.date)) byDate.set(p.date, []);
    byDate.get(p.date)!.push(p);
  }

  const duplicates = [...byDate.entries()].filter(([, list]) => list.length > 1);
  if (duplicates.length === 0) return "";

  const rows = duplicates
    .map(
      ([date, list]) =>
        `<li class="cockpit-aside-row"><span class="cockpit-aside-text">${escapeHtml(longDate(date))}</span><span class="cluster">${list
          .map((p) => `<a href="/plans/${encodeURIComponent(p.source)}/${p.date}">${sourceBadge(labelFor(p.source), p.source)}</a>`)
          .join(" ")}</span></li>`
    )
    .join("\n");

  return `
    <section class="card rail-card plan-duplicates" aria-labelledby="dup-title">
      <h2 class="rail-title" id="dup-title">Plans from several sources</h2>
      <ul class="cockpit-aside-list">${rows}</ul>
    </section>
  `;
}

export function planDetailView(opts: {
  date: string;
  contentHtml: string;
  sourceName: string;
  sourceLabel?: string;
  prevDate?: string;
  nextDate?: string;
}): string {
  const { date, contentHtml, sourceName, prevDate, nextDate } = opts;

  const prevLink = prevDate
    ? `<a class="btn" href="/plans/${encodeURIComponent(sourceName)}/${prevDate}" rel="prev" aria-label="Previous plan, ${escapeAttr(longDate(prevDate))}">${icon("chevronLeft")}${escapeHtml(prevDate)}</a>`
    : "";
  const nextLink = nextDate
    ? `<a class="btn" href="/plans/${encodeURIComponent(sourceName)}/${nextDate}" rel="next" aria-label="Next plan, ${escapeAttr(longDate(nextDate))}">${escapeHtml(nextDate)}${icon("chevronRight")}</a>`
    : "";

  return `
    ${pageHeader({
      title: longDate(date),
      eyebrowHtml: `${sourceBadge(opts.sourceLabel ?? sourceName, sourceName)}<span>${escapeHtml(date.slice(0, 4))}</span>`,
      actionsHtml: `<div class="plan-nav">${prevLink}${nextLink}</div>`,
    })}
    <article class="card doc-card plan-content">
      <div class="rendered-markdown">
        ${contentHtml}
      </div>
    </article>
  `;
}
