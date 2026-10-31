import type { Source } from "../config.js";
import type { InitiativeWithSource, ProjectWithSource } from "../parsers/yaml.js";
import { escapeHtml, escapeAttr } from "../utils.js";
import { icon } from "./icons.js";
import { PROJECT_STATUS_ORDER, PROJECT_STATUS_TONE, badge, emptyState, pageHeader, statusBadge, type Tone } from "./ui.js";

export type InitiativeHealth = "critical" | "warning" | "healthy" | "unknown";

export const HEALTH_TONE: Record<InitiativeHealth, Tone> = {
  critical: "bad",
  warning: "warn",
  healthy: "ok",
  unknown: "neutral",
};

export const HEALTH_LABEL: Record<InitiativeHealth, string> = {
  critical: "Needs attention",
  warning: "Watch",
  healthy: "Healthy",
  unknown: "No health signal",
};

/** A thin bar of member projects by status, with an accessible summary. */
export function statusRollup(members: ProjectWithSource[]): string {
  if (members.length === 0) return "";
  const counts: Record<string, number> = {};
  for (const p of members) counts[p.status] = (counts[p.status] || 0) + 1;
  const segs = PROJECT_STATUS_ORDER.filter((s) => counts[s])
    .map((s) => `<span class="seg-${PROJECT_STATUS_TONE[s]}" style="flex:${counts[s]}" title="${counts[s]} ${s}"></span>`)
    .join("");
  const summary = PROJECT_STATUS_ORDER.filter((s) => counts[s]).map((s) => `${counts[s]} ${s}`).join(", ");
  return `<div class="stackbar" role="img" aria-label="Member projects: ${escapeAttr(summary)}">${segs}</div>`;
}

export function initiativeListView(opts: {
  initiatives: InitiativeWithSource[];
  projects: ProjectWithSource[];
  sources: Source[];
  /** Health per `${source}:${id}` from the portfolio parser. */
  health?: Map<string, { health: InitiativeHealth; signals: string[] }>;
}): string {
  const { initiatives, projects, sources } = opts;

  // Group initiatives by source; within each source, sort by status (active first) then by name.
  const showSourceHeader = sources.length > 1;

  const bySource = new Map<string, InitiativeWithSource[]>();
  for (const i of initiatives) {
    if (!bySource.has(i._source)) bySource.set(i._source, []);
    bySource.get(i._source)!.push(i);
  }

  for (const [, list] of bySource) {
    list.sort((a, b) => {
      const statusRank = (s: string) => (s === "active" ? 0 : s === "ongoing" ? 1 : s === "paused" ? 2 : s === "new" ? 3 : 4);
      const d = statusRank(a.status) - statusRank(b.status);
      return d !== 0 ? d : a.name.localeCompare(b.name);
    });
  }

  // Member projects and ungrouped projects per source.
  const members = new Map<string, ProjectWithSource[]>();
  const ungroupedBySource = new Map<string, number>();
  for (const p of projects) {
    if (p.initiative) {
      const key = `${p._source}:${p.initiative}`;
      if (!members.has(key)) members.set(key, []);
      members.get(key)!.push(p);
    } else {
      ungroupedBySource.set(p._source, (ungroupedBySource.get(p._source) || 0) + 1);
    }
  }

  const totalInitiatives = initiatives.length;

  if (totalInitiatives === 0) {
    const ungroupedTotal = [...ungroupedBySource.values()].reduce((a, b) => a + b, 0);
    return `
      ${pageHeader({ title: "Initiatives", lead: "Portfolio-level groups of related projects." })}
      ${emptyState({
        icon: "target",
        title: "No initiatives declared",
        bodyHtml: `Add an <code>initiatives:</code> section to a source's <code>projects/index.yaml</code> to group projects into portfolio-level units. See <a href="https://github.com/synthesisengineering/synthesis-console/blob/main/docs/initiatives.md">docs/initiatives.md</a>.${
          ungroupedTotal > 0 ? ` ${ungroupedTotal} project${ungroupedTotal === 1 ? " is" : "s are"} currently ungrouped.` : ""
        }`,
      })}
    `;
  }

  const healthCounts: Record<InitiativeHealth, number> = { critical: 0, warning: 0, healthy: 0, unknown: 0 };
  for (const i of initiatives) {
    const h = opts.health?.get(`${i._source}:${i.id}`)?.health ?? "unknown";
    healthCounts[h]++;
  }
  const metaHtml = (["critical", "warning", "healthy"] as InitiativeHealth[])
    .filter((h) => healthCounts[h])
    .map((h) => `<span><span class="dot dot-${HEALTH_TONE[h]}" aria-hidden="true"></span>${healthCounts[h]} ${escapeHtml(HEALTH_LABEL[h].toLowerCase())}</span>`)
    .join("");

  const sections: string[] = [];

  for (const src of sources) {
    const list = bySource.get(src.name);
    if (!list || list.length === 0) continue;

    const sourceLabel = src.display_name || src.name;
    const ungrouped = ungroupedBySource.get(src.name) || 0;

    const header = showSourceHeader
      ? `<h2 class="source-block-title">${icon("layers", "icon-sm")}${escapeHtml(sourceLabel)}</h2>`
      : "";

    const cards = list
      .map((i) => renderCard(i, members.get(`${i._source}:${i.id}`) || [], opts.health?.get(`${i._source}:${i.id}`)))
      .join("\n");

    const ungroupedCard =
      ungrouped > 0
        ? `<article class="initiative-card initiative-card-ungrouped">
            <div class="initiative-card-head">
              <h3><a href="/projects?source=${encodeURIComponent(src.name)}&amp;initiative=_ungrouped">Not in an initiative</a></h3>
              ${badge(`${ungrouped} project${ungrouped === 1 ? "" : "s"}`, "neutral", { plain: true })}
            </div>
            <p class="initiative-desc">Projects in this source that are not yet assigned to an initiative.</p>
          </article>`
        : "";

    sections.push(`
      <section class="initiative-source-section" aria-label="${escapeAttr(sourceLabel)}">
        ${header}
        <div class="initiative-grid">
          ${cards}
          ${ungroupedCard}
        </div>
      </section>
    `);
  }

  return `
    ${pageHeader({
      title: "Initiatives",
      count: totalInitiatives,
      lead: "Portfolio-level view across the selected sources. Each initiative groups related projects; health comes from their records.",
      metaHtml,
    })}
    ${sections.join("\n")}
  `;
}

function renderCard(
  initiative: InitiativeWithSource,
  members: ProjectWithSource[],
  health?: { health: InitiativeHealth; signals: string[] }
): string {
  const h = health?.health ?? "unknown";
  const description = initiative.description
    ? `<p class="initiative-desc">${escapeHtml(initiative.description)}</p>`
    : "";

  const foot: string[] = [];
  foot.push(`<span>${icon("folder")}${members.length} project${members.length === 1 ? "" : "s"}</span>`);
  if (initiative.lead) foot.push(`<span>${icon("user")}${escapeHtml(initiative.lead)}</span>`);
  if (initiative.target_date) foot.push(`<span>${icon("calendar")}Target ${escapeHtml(initiative.target_date)}</span>`);
  else if (initiative.started_date) foot.push(`<span>${icon("calendar")}Since ${escapeHtml(initiative.started_date)}</span>`);

  const healthTitle = health?.signals.length ? health.signals.join("\n") : HEALTH_LABEL[h];

  return `
    <article class="initiative-card">
      <div class="initiative-card-head">
        <h3><a href="/initiatives/${encodeURIComponent(initiative._source)}/${encodeURIComponent(initiative.id)}">${escapeHtml(initiative.name)}</a></h3>
        ${statusBadge(initiative.status)}
      </div>
      ${description}
      <div class="stack-sm">
        ${statusRollup(members)}
        <div class="rollup-legend"><span title="${escapeAttr(healthTitle)}"><span class="dot dot-${HEALTH_TONE[h]}" aria-hidden="true"></span>${escapeHtml(HEALTH_LABEL[h])}</span>${
          members.length ? PROJECT_STATUS_ORDER.filter((s) => members.some((p) => p.status === s)).map((s) => `<span>${members.filter((p) => p.status === s).length} ${escapeHtml(s)}</span>`).join("") : ""
        }</div>
      </div>
      <div class="initiative-foot">${foot.join("")}</div>
    </article>
  `;
}

