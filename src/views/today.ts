/**
 * Today (`/`): what needs the principal now. Today's plan and its queue,
 * the system's health, the projects in motion, autopilot runs in flight and
 * the latest conversations, on one screen.
 */
import MarkdownIt from "markdown-it";
import type { Source } from "../config.js";
import type { ProjectWithSource } from "../parsers/yaml.js";
import type { AutopilotRun } from "../autopilot.js";
import type { PlanSummary } from "./cockpit/summary.js";
import { escapeAttr, escapeHtml } from "../utils.js";
import { relativeLabel } from "../parsers/recency.js";
import { icon, type IconName } from "./icons.js";
import { badge, demoBanner, emptyState, longDate, pageHeader, progressBar, sourceBadge, statusBadge, type Tone } from "./ui.js";

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

export interface TodayPlan {
  source: string;
  sourceLabel: string;
  date: string;
  href: string;
  mtimeMs: number;
  summary: PlanSummary | null;
}

export interface TodayLane {
  name: string;
  href: string;
  health: "critical" | "warning" | "healthy" | "unknown";
  memberCount: number;
  tooltip: string;
}

export interface TodayOpts {
  now: Date;
  demoMode: boolean;
  demoActive: boolean;
  sources: Source[];
  activeCount: number;
  hasPlanSource: boolean;
  todayPlan: TodayPlan | null;
  latestPlan: { href: string; date: string; sourceLabel: string } | null;
  projects: ProjectWithSource[];
  projectCounts: { live: number; paused: number; total: number };
  lanes: TodayLane[];
  /** Null in demo mode: no machine state is read. */
  runs: AutopilotRun[] | null;
  ledger: { href: string; date: string; open: number; decaying: number } | null;
}

function greeting(now: Date): string {
  const h = now.getHours();
  if (h < 5) return "Working late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function ago(ms: number, now: Date): string {
  const mins = Math.max(0, Math.floor((now.getTime() - ms) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function planCard(o: TodayOpts): string {
  const p = o.todayPlan;
  if (!p) {
    const body = !o.hasPlanSource
      ? "None of the selected sources keeps daily plans. Declare <code>plans_dir</code> on a source to add them."
      : o.latestPlan
        ? `The day-start ritual writes today's plan. The latest is <a href="${escapeAttr(o.latestPlan.href)}">${escapeHtml(longDate(o.latestPlan.date, true))}</a>.`
        : "The day-start ritual writes each day's plan into the source's daily-plans folder.";
    return `<section class="card" aria-labelledby="today-plan-title">
  <div class="card-header"><h2 class="card-title" id="today-plan-title">${icon("calendar")}Today's plan</h2>${
    o.latestPlan ? `<a class="section-link" href="${escapeAttr(o.latestPlan.href)}">Latest plan ${icon("arrowRight", "icon-sm")}</a>` : ""
  }</div>
  <div class="card-body">${emptyState({ icon: "calendar", title: "No plan for today yet", bodyHtml: body, compact: true })}</div>
</section>`;
  }

  const s = p.summary;
  const stats = s
    ? `<div class="today-plan-stats">
    ${planStat("Needs you", s.needsYouOpen, s.needsYouTotal ? `of ${s.needsYouTotal} in the queue` : "queue empty", s.needsYouOpen > 0 ? "info" : undefined)}
    ${planStat("Decisions", s.decisionsOpen, s.decisionsTotal ? `open of ${s.decisionsTotal}` : "none today", s.decisionsOpen > 0 ? "warn" : undefined)}
    ${planStat("Tasks", s.tasksDone, s.tasksTotal ? `done of ${s.tasksTotal}` : "none listed", undefined, s.tasksTotal ? (s.tasksDone / s.tasksTotal) * 100 : undefined)}
    ${planStat("Drafts", s.draftsPending, s.sentToday ? `${s.sentToday} sent today` : "to review", undefined)}
  </div>`
    : "";
  const brief = s?.brief
    ? `<div class="today-brief"><p class="today-brief-label">Brief</p><div class="rendered-markdown">${md.render(firstParagraphs(s.brief))}</div></div>`
    : "";
  return `<section class="card today-plan" aria-labelledby="today-plan-title">
  <div class="today-plan-head">
    <div>
      <h2 class="today-plan-title" id="today-plan-title">Today's plan</h2>
      <p class="today-plan-sub">${sourceBadge(p.sourceLabel, p.source)} · updated ${escapeHtml(ago(p.mtimeMs, o.now))}</p>
    </div>
    <a class="btn btn-primary" href="${escapeAttr(p.href)}">Open plan ${icon("arrowRight")}</a>
  </div>
  ${stats}
  ${brief}
</section>`;
}

/** At most two paragraphs of the brief; the plan page has the rest. */
function firstParagraphs(text: string): string {
  return text.split(/\n\s*\n/).slice(0, 2).join("\n\n");
}

function planStat(label: string, value: number, sub: string, tone?: Tone, progress?: number): string {
  return `<div class="today-plan-stat${tone ? ` stat-${tone}` : ""}">
  <span class="stat-label">${escapeHtml(label)}</span>
  <span class="stat-value">${value}</span>
  <span class="stat-sub">${escapeHtml(sub)}</span>
  ${progress !== undefined ? progressBar(progress, progress >= 100 ? "ok" : undefined) : ""}
</div>`;
}

function healthTiles(o: TodayOpts): string {
  if (o.demoMode) {
    return `<section aria-labelledby="health-title">
  <div class="section-header"><h2 class="section-title" id="health-title">${icon("activity")}System health</h2></div>
  <div class="callout callout-neutral">${icon("info")}<div>Demo mode reads no machine state, so sync, context and conformance checks are not shown.</div></div>
</section>`;
  }
  const tile = (kind: string, label: string, href: string, iconName: IconName) =>
    `<a class="status-tile sync-checking" href="${href}" data-status-for="${kind}">
  <span class="status-tile-head">${icon(iconName)}${escapeHtml(label)}<span class="nav-dot" aria-hidden="true"></span></span>
  <span class="status-tile-value">Checking…</span>
  <span class="status-tile-sub"></span>
</a>`;
  return `<section aria-labelledby="health-title">
  <div class="section-header"><h2 class="section-title" id="health-title">${icon("activity")}System health</h2></div>
  <div class="status-tiles">
    ${tile("sync", "Repo sync", "/sync", "sync")}
    ${tile("context", "Context", "/context", "fileCheck")}
    ${tile("conformance", "Conformance", "/conformance", "shield")}
    ${tile("autopilot", "Autopilot", "/autopilot", "compass")}
  </div>
</section>`;
}

function projectsSection(o: TodayOpts): string {
  const cards = o.projects
    .map((p) => {
      const src = o.sources.find((s) => s.name === p._source);
      const label = src ? src.display_name || src.name : p._source;
      return `<article class="card card-link mini-project">
  <div class="mini-project-head">
    <a class="mini-project-name stretched" href="/projects/${encodeURIComponent(p._source)}/${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>
    ${statusBadge(p.status)}
  </div>
  ${p.description ? `<p class="mini-project-desc">${escapeHtml(p.description.replace(/\n/g, " "))}</p>` : ""}
  <div class="mini-project-foot">${o.sources.length > 1 ? sourceBadge(label, p._source) : ""}<span class="project-time">${icon("clock")}${escapeHtml(relativeLabel(p._lastActiveMs, o.now.getTime()))}</span></div>
</article>`;
    })
    .join("\n");
  const body = cards
    ? `<div class="grid grid-2">${cards}</div>`
    : emptyState({ icon: "folder", title: "No projects in motion", body: o.activeCount === 0 ? "Choose sources in the sidebar to see their projects." : "Projects marked active, new or ongoing appear here, most recently touched first.", compact: true });
  return `<section class="section" aria-labelledby="projects-title">
  <div class="section-header">
    <h2 class="section-title" id="projects-title">${icon("folder")}Recently active</h2>
    <a class="section-link" href="/projects">All ${o.projectCounts.total} projects ${icon("arrowRight", "icon-sm")}</a>
  </div>
  ${body}
</section>`;
}

function lanesSection(o: TodayOpts): string {
  if (o.lanes.length === 0) return "";
  const rows = o.lanes
    .map(
      (l) => `<li><a class="cockpit-lane cockpit-lane-${l.health}" href="${escapeAttr(l.href)}"${l.tooltip ? ` title="${escapeAttr(l.tooltip)}"` : ""}>
  <span class="cockpit-lane-dot" aria-hidden="true"></span><span class="cockpit-lane-name">${escapeHtml(l.name)}</span><span class="cockpit-lane-health">${escapeHtml(HEALTH_LABEL[l.health])}</span><span class="cockpit-lane-count">${l.memberCount}</span>
</a></li>`
    )
    .join("");
  return `<section class="card rail-card" aria-labelledby="lanes-title">
  <h2 class="rail-title" id="lanes-title">Portfolio <a href="/initiatives">Initiatives</a></h2>
  <ul class="cockpit-aside-list">${rows}</ul>
</section>`;
}

const HEALTH_LABEL: Record<TodayLane["health"], string> = {
  critical: "Needs attention",
  warning: "Watch",
  healthy: "Healthy",
  unknown: "No signal",
};

const RUN_TONE: Record<string, Tone> = {
  running: "info",
  waiting: "warn",
  blocked: "bad",
  paused: "neutral",
};

function runsSection(o: TodayOpts): string {
  if (o.runs === null) return "";
  const open = o.runs.filter((r) => !r.error && RUN_TONE[r.status] !== undefined);
  const rows = open
    .slice(0, 5)
    .map((r) => {
      const q = r.questions.length;
      return `<li><a class="list-row" href="/autopilot/run/${encodeURIComponent(r.session)}">
  <span class="list-row-main"><span class="list-row-title">${escapeHtml(r.title ?? r.session)}</span><span class="list-row-sub">${
    q ? `<span class="run-row-q">${q} question${q === 1 ? "" : "s"} for you</span>` : escapeHtml(r.nextItem ? `Next: ${r.nextItem}` : r.statusReason || "")
  }</span></span>
  ${badge(r.status, RUN_TONE[r.status] ?? "neutral")}
</a></li>`;
    })
    .join("");
  return `<section class="section" aria-labelledby="runs-title">
  <div class="section-header">
    <h2 class="section-title" id="runs-title">${icon("compass")}Autopilot</h2>
    <a class="section-link" href="/autopilot">All runs ${icon("arrowRight", "icon-sm")}</a>
  </div>
  ${rows ? `<ul class="list">${rows}</ul>` : `<div class="empty-inline card">No runs in flight. Delegated runs appear here while they work.</div>`}
</section>`;
}

function ledgerSection(o: TodayOpts): string {
  if (!o.ledger) return "";
  const l = o.ledger;
  return `<section class="card rail-card" aria-labelledby="ledger-title">
  <h2 class="rail-title" id="ledger-title">Catch-up ledger <a href="${escapeAttr(l.href)}">Open</a></h2>
  <a class="cockpit-ledger-digest" href="${escapeAttr(l.href)}"><span class="cockpit-ledger-date">${escapeHtml(longDate(l.date, true))}</span><span class="cockpit-ledger-open">${l.open} open</span>${
    l.decaying ? `<span class="cockpit-ledger-decaying">${l.decaying} decaying</span>` : ""
  }</a>
</section>`;
}

function conversationsSection(o: TodayOpts): string {
  if (o.demoMode) return "";
  return `<section class="section" aria-labelledby="conv-title">
  <div class="section-header">
    <h2 class="section-title" id="conv-title">${icon("chat")}Recent conversations</h2>
    <a class="section-link" href="/conversations">All conversations ${icon("arrowRight", "icon-sm")}</a>
  </div>
  <ul class="list" id="today-conversations" aria-busy="true">
    <li class="list-row"><span class="list-row-main"><span class="skeleton skeleton-w60"></span><span class="skeleton skeleton-w40"></span></span></li>
    <li class="list-row"><span class="list-row-main"><span class="skeleton skeleton-w80"></span><span class="skeleton skeleton-w40"></span></span></li>
    <li class="list-row"><span class="list-row-main"><span class="skeleton skeleton-w60"></span><span class="skeleton skeleton-w40"></span></span></li>
  </ul>
</section>
<script>
(function () {
  var list = document.getElementById('today-conversations');
  if (!list) return;
  function when(at) { return at ? at.slice(0, 16).replace('T', ' ') : ''; }
  function row(meta) {
    var a = document.createElement('a');
    a.className = 'list-row';
    a.href = '/conversations/' + encodeURIComponent(meta.session);
    var main = document.createElement('span');
    main.className = 'list-row-main';
    var title = document.createElement('span');
    title.className = 'list-row-title';
    title.textContent = (meta.projects && meta.projects.length ? meta.projects.join(', ') : 'No project') ;
    var sub = document.createElement('span');
    sub.className = 'list-row-sub';
    sub.textContent = meta.harness + ' · ' + String(meta.session).slice(0, 8) + (meta.records ? ' · ' + meta.records + ' records' : '');
    main.appendChild(title); main.appendChild(sub);
    var right = document.createElement('span');
    right.className = 'list-row-meta';
    right.textContent = when(meta.last);
    a.appendChild(main); a.appendChild(right);
    var li = document.createElement('li');
    li.appendChild(a);
    return li;
  }
  function message(text) {
    list.innerHTML = '';
    var li = document.createElement('li');
    li.className = 'empty-inline';
    li.textContent = text;
    list.appendChild(li);
  }
  fetch('/api/conversations?limit=6', { cache: 'no-store' })
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (body) {
      list.setAttribute('aria-busy', 'false');
      if (!body || body.installed === false) { message('Conversations need synthesis v5.3.1 or later.'); return; }
      if (body.error && !(body.items || []).length) { message(body.error); return; }
      var items = (body.items || []).slice(0, 6);
      if (!items.length) { message('No sessions recorded yet.'); return; }
      list.innerHTML = '';
      items.forEach(function (m) { list.appendChild(row(m)); });
    })
    .catch(function () { list.setAttribute('aria-busy', 'false'); message('Conversations could not be read.'); });
})();
</script>`;
}

export function todayView(o: TodayOpts): string {
  const planHref = o.todayPlan?.href;
  const actions = planHref
    ? `<a class="btn btn-primary" href="${escapeAttr(planHref)}">${icon("calendar")}Today's plan</a>`
    : `<a class="btn" href="/plans">${icon("calendar")}Daily plans</a>`;
  const meta = [
    `<span>${icon("folder", "icon-sm")}${o.projectCounts.live} project${o.projectCounts.live === 1 ? "" : "s"} in motion</span>`,
    o.projectCounts.paused ? `<span>${icon("clock", "icon-sm")}${o.projectCounts.paused} paused</span>` : "",
    `<span>${icon("layers", "icon-sm")}${o.activeCount} source${o.activeCount === 1 ? "" : "s"} selected</span>`,
  ].filter(Boolean).join("");

  return `${pageHeader({
    title: greeting(o.now),
    eyebrowHtml: `<span>${escapeHtml(longDate(isoDate(o.now), true))}</span>`,
    metaHtml: meta,
    actionsHtml: `${actions}<button type="button" class="btn" data-open-palette>${icon("search")}Search <kbd>⌘K</kbd></button>`,
  })}
${o.demoActive ? demoBanner() : ""}
<div class="today-grid">
  <div class="stack">
    ${planCard(o)}
    ${projectsSection(o)}
    ${conversationsSection(o)}
  </div>
  <div class="stack">
    ${healthTiles(o)}
    ${lanesSection(o)}
    ${ledgerSection(o)}
    ${runsSection(o)}
  </div>
</div>`;
}

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
