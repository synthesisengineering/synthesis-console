import type { Initiative, ProjectStatus, ProjectWithSource } from "../parsers/yaml.js";
import { escapeHtml, escapeAttr } from "../utils.js";
import { relativeLabel } from "../parsers/recency.js";
import { icon } from "./icons.js";
import { PROJECT_STATUS_ORDER, badge, emptyState, pageHeader, sourceBadge, statusBadge } from "./ui.js";
import { HEALTH_LABEL, HEALTH_TONE, statusRollup, type InitiativeHealth } from "./initiative-list.js";
import { periodLabel } from "./project-detail.js";

/** "Jul 2026" for a YYYY-MM session period. */
function shortPeriod(period: string): string {
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return periodLabel(period);
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

const STATUS_ORDER = PROJECT_STATUS_ORDER as readonly ProjectStatus[];

export function initiativeDetailView(opts: {
  initiative: Initiative;
  memberProjects: ProjectWithSource[];
  recentSessions: { projectId: string; projectName: string; period: string; sourceName: string }[];
  sourceName: string;
  sourceLabel?: string;
  health?: { health: InitiativeHealth; signals: string[] };
}): string {
  const { initiative: i, memberProjects, recentSessions, sourceName } = opts;
  const sourceLabel = opts.sourceLabel ?? sourceName;
  const h = opts.health?.health ?? "unknown";

  const tags = (i.tags || [])
    .map((t) => `<a href="/projects?tag=${encodeURIComponent(t)}" class="tag">${escapeHtml(t)}</a>`)
    .join(" ");

  const relatedLinks = (i.related || [])
    .map((r) => `<a href="/initiatives/${encodeURIComponent(sourceName)}/${encodeURIComponent(r)}">${escapeHtml(r)}</a>`)
    .join(", ");

  const metaRows: [string, string][] = [];
  metaRows.push(["Status", statusBadge(i.status)]);
  metaRows.push(["Health", badge(HEALTH_LABEL[h], HEALTH_TONE[h], { title: opts.health?.signals.join("\n") })]);
  metaRows.push(["Source", sourceBadge(sourceLabel, sourceName)]);
  if (i.lead) metaRows.push(["Lead", escapeHtml(i.lead)]);
  if (i.stakeholder) metaRows.push(["Stakeholder", escapeHtml(i.stakeholder)]);
  if (i.started_date) metaRows.push(["Started", `<time>${escapeHtml(i.started_date)}</time>`]);
  if (i.target_date) metaRows.push(["Target", `<time>${escapeHtml(i.target_date)}</time>`]);
  if (i.completed_date) metaRows.push(["Completed", `<time>${escapeHtml(i.completed_date)}</time>`]);
  if (tags) metaRows.push(["Tags", `<div class="tags">${tags}</div>`]);
  if (relatedLinks) metaRows.push(["Related", relatedLinks]);

  const externalLinks = i.links
    ? Object.entries(i.links)
        .map(([k, v]) => `<li><a class="external" href="${escapeAttr(v)}" target="_blank" rel="noopener">${escapeHtml(k)}</a></li>`)
        .join("")
    : "";

  const signals = opts.health?.signals.length
    ? `<section class="card rail-card" aria-labelledby="signals-title"><h2 class="rail-title" id="signals-title">Health signals</h2><ul class="cockpit-aside-list">${opts.health.signals
        .map((s) => `<li class="cockpit-aside-row"><span class="cockpit-aside-dot cockpit-aside-dot-${h === "critical" ? "critical" : h === "warning" ? "waiting" : h === "healthy" ? "done" : "context"}" aria-hidden="true"></span><span class="cockpit-aside-text" title="${escapeAttr(s)}">${escapeHtml(s)}</span></li>`)
        .join("")}</ul></section>`
    : "";

  return `
    ${pageHeader({
      title: i.name,
      eyebrowHtml: `${sourceBadge(sourceLabel, sourceName)}<span>${icon("target", "icon-sm")} Initiative</span>`,
      lead: i.description,
      metaHtml: `${statusBadge(i.status)}${badge(HEALTH_LABEL[h], HEALTH_TONE[h])}<span>${icon("folder", "icon-sm")}${memberProjects.length} project${memberProjects.length === 1 ? "" : "s"}</span>`,
      actionsHtml: `<a class="btn" href="/projects?source=${encodeURIComponent(sourceName)}&amp;initiative=${encodeURIComponent(i.id)}">${icon("folder")}Open in Projects</a>`,
    })}

    <div class="detail-layout">
      <div class="stack">
        <section aria-labelledby="members-title">
          <div class="section-header">
            <h2 class="section-title" id="members-title">${icon("folder")}Member projects</h2>
          </div>
          ${memberProjects.length ? `<div class="card card-pad stack-sm" style="margin-bottom:var(--sp-4)">${statusRollup(memberProjects)}<div class="rollup-legend">${STATUS_ORDER.filter((s) => memberProjects.some((p) => p.status === s)).map((s) => `<span>${memberProjects.filter((p) => p.status === s).length} ${escapeHtml(s)}</span>`).join("")}</div></div>` : ""}
          ${memberProjects.length === 0
            ? emptyState({ icon: "folder", title: "No member projects yet", bodyHtml: `Add <code>initiative: ${escapeHtml(i.id)}</code> to a project entry in <code>projects/index.yaml</code>.`, compact: true })
            : renderProjectGroups(memberProjects)}
        </section>

        ${renderRecentSessions(recentSessions)}
      </div>

      <aside class="rail rail-sticky" aria-label="Initiative details">
        <section class="card rail-card" aria-labelledby="details-title">
          <h2 class="rail-title" id="details-title">Details</h2>
          <dl class="meta-list">${metaRows.map(([k, v]) => `<div class="meta-row"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
        </section>
        ${signals}
        ${externalLinks ? `<section class="card rail-card" aria-labelledby="links-title"><h2 class="rail-title" id="links-title">Links</h2><ul class="session-links">${externalLinks}</ul></section>` : ""}
      </aside>
    </div>
  `;
}

function renderProjectGroups(projects: ProjectWithSource[]): string {
  const grouped = new Map<ProjectStatus, ProjectWithSource[]>();
  for (const p of projects) {
    const status = p.status as ProjectStatus;
    if (!grouped.has(status)) grouped.set(status, []);
    grouped.get(status)!.push(p);
  }
  for (const [, list] of grouped) {
    list.sort((a, b) => (b._lastActiveMs ?? -1) - (a._lastActiveMs ?? -1) || (b.last_session || b.started_date || "").localeCompare(a.last_session || a.started_date || ""));
  }
  const rows: string[] = [];
  for (const status of STATUS_ORDER) {
    const list = grouped.get(status);
    if (!list || list.length === 0) continue;
    for (const p of list) {
      rows.push(`<li><a class="list-row" href="/projects/${encodeURIComponent(p._source)}/${encodeURIComponent(p.id)}">
        <span class="list-row-main"><span class="list-row-title">${escapeHtml(p.name)}</span>${p.description ? `<span class="list-row-sub">${escapeHtml(p.description.replace(/\n/g, " "))}</span>` : ""}</span>
        <span class="list-row-meta"><span class="nowrap">${escapeHtml(relativeLabel(p._lastActiveMs))}</span>${statusBadge(p.status)}</span>
      </a></li>`);
    }
  }
  return `<ul class="list">${rows.join("")}</ul>`;
}

function renderRecentSessions(
  sessions: { projectId: string; projectName: string; period: string; sourceName: string }[]
): string {
  if (sessions.length === 0) return "";
  const items = sessions
    .map(
      (s) => `<li class="timeline-item"><span class="timeline-when">${escapeHtml(shortPeriod(s.period))}</span><a href="/projects/${encodeURIComponent(s.sourceName)}/${encodeURIComponent(s.projectId)}/sessions/${encodeURIComponent(s.period)}">${escapeHtml(s.projectName)}</a></li>`
    )
    .join("");
  return `
    <section class="section" aria-labelledby="activity-title">
      <div class="section-header"><h2 class="section-title" id="activity-title">${icon("activity")}Recent session logs</h2></div>
      <div class="card card-pad"><ol class="timeline">${items}</ol></div>
    </section>
  `;
}
