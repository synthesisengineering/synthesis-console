import type { ProjectStatus, ProjectWithSource, InitiativeWithSource } from "../parsers/yaml.js";
import type { Source } from "../config.js";
import { escapeHtml, escapeAttr } from "../utils.js";
import { relativeLabel, resumePrompt, sortProjects } from "../parsers/recency.js";
import { icon } from "./icons.js";
import {
  PROJECT_STATUS_ORDER,
  PROJECT_STATUS_TONE,
  capitalize,
  demoBanner,
  emptyState,
  pageHeader,
  sourceBadge,
  statusBadge,
} from "./ui.js";

const STATUS_ORDER = PROJECT_STATUS_ORDER as readonly ProjectStatus[];

type Filters = { status?: string; tag?: string; client?: string; q?: string; source?: string; initiative?: string };

export function projectListView(opts: {
  projects: ProjectWithSource[];
  allTags: Map<string, number>;
  currentFilters: Filters;
  currentSort?: string;
  sources: Source[];
  activeSourceNames: string[];
  demoMode: boolean;
  initiatives: InitiativeWithSource[];
  groupByInitiative: boolean;
  resumeSkillInstalled: boolean;
  /**
   * Per-status counts over the projects that match every filter except
   * status, so each status chip says how many it would show.
   */
  statusCounts?: Record<string, number>;
  /** Projects in the active sources before any filter. */
  totalProjects?: number;
}): string {
  const {
    projects,
    allTags,
    currentFilters,
    currentSort,
    sources,
    activeSourceNames,
    demoMode,
    initiatives,
    groupByInitiative,
    resumeSkillInstalled,
  } = opts;

  const isDemoActive =
    demoMode ||
    activeSourceNames.some((n) => sources.find((s) => s.name === n)?.demo === true);

  const statusCounts: Record<string, number> = opts.statusCounts ?? {};
  if (!opts.statusCounts) {
    for (const p of projects) statusCounts[p.status] = (statusCounts[p.status] || 0) + 1;
  }
  const total = opts.totalProjects ?? projects.length;
  const activeSources = sources.filter((s) => activeSourceNames.includes(s.name));
  const multiSource = activeSources.length > 1;

  const activeCount = activeSourceNames.length;
  const hasFilters = Object.values(currentFilters).some((v) => v);
  const emptyMessage =
    activeCount === 0
      ? emptyState({ icon: "layers", title: "No sources selected", body: "Choose which sources to view with the picker at the top of the sidebar." })
      : projects.length === 0 && !hasFilters
        ? emptyState({ icon: "folder", title: "No projects yet", body: `No projects found in ${activeCount === 1 ? "the selected source" : "the selected sources"}. Projects come from each source's projects/index.yaml.` })
        : projects.length === 0
          ? emptyState({ icon: "search", title: "No projects match these filters", body: "Try a different search or status, or clear the filters.", actionsHtml: `<a class="btn" href="/projects">Clear filters</a>` })
          : "";

  const live = (statusCounts.active || 0) + (statusCounts.new || 0) + (statusCounts.ongoing || 0);
  const lead = `${live} in motion across ${activeCount} source${activeCount === 1 ? "" : "s"}. Search, filter and open any project's working memory.`;

  const projectsHtml = emptyMessage
    ? ""
    : groupByInitiative
      ? renderProjectsGroupedByInitiative(projects, initiatives, sources, currentSort, resumeSkillInstalled, multiSource)
      : renderProjectGroupsByStatus(projects, sources, currentSort, resumeSkillInstalled, multiSource);

  return `
    ${pageHeader({
      title: "Projects",
      count: total,
      lead,
      actionsHtml: `<div class="segmented view-toggle" role="group" aria-label="Layout">
        <button type="button" data-set-view="cards" aria-pressed="true" title="Cards">${icon("grid")}<span class="sr-only">Cards</span></button>
        <button type="button" data-set-view="table" aria-pressed="false" title="Dense list">${icon("rows")}<span class="sr-only">Dense list</span></button>
      </div>`,
    })}
    ${isDemoActive ? demoBanner() : ""}
    ${renderFilters(currentFilters, currentSort, allTags, sources, activeSourceNames, initiatives, groupByInitiative, statusCounts, total)}
    ${emptyMessage}
    ${projectsHtml}
  `;
}

function renderFilters(
  current: Filters,
  currentSort: string | undefined,
  allTags: Map<string, number>,
  sources: Source[],
  activeSourceNames: string[],
  initiatives: InitiativeWithSource[],
  groupByInitiative: boolean,
  statusCounts: Record<string, number>,
  total: number
): string {
  const selectedStatuses = current.status?.split(",").filter(Boolean) ?? [];
  const allHref = (() => {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(current)) if (v && k !== "status") params.set(k, v);
    if (currentSort && currentSort !== "recent") params.set("sort", currentSort);
    const qs = params.toString();
    return qs ? `/projects?${qs}` : "/projects";
  })();
  const statusChips = STATUS_ORDER.filter((s) => statusCounts[s] || selectedStatuses.includes(s))
    .map((s) => {
      const active = selectedStatuses.includes(s);
      return `<button type="button" class="chip status-toggle${active ? " active" : ""}" data-status="${s}" aria-pressed="${active ? "true" : "false"}"><span class="dot dot-${PROJECT_STATUS_TONE[s]}" aria-hidden="true"></span>${escapeHtml(capitalize(s))} <span class="chip-count">${statusCounts[s] || 0}</span></button>`;
    })
    .join("\n");

  const selectedTags = current.tag?.split(",").filter(Boolean) ?? [];
  const tagButtons = [...allTags.entries()]
    .map(([tag, count]) => {
      const active = selectedTags.includes(tag);
      return `<button type="button" class="chip tag-toggle${active ? " active" : ""}" data-tag="${escapeAttr(tag)}" aria-pressed="${active ? "true" : "false"}">${escapeHtml(tag)} <span class="chip-count">${count}</span></button>`;
    })
    .join("\n");

  const activeSet = new Set(activeSourceNames);
  const sourceFilterCurrent = current.source?.split(",").filter(Boolean) ?? [];
  const sourceButtons = sources
    .filter((s) => activeSet.has(s.name))
    .map((s) => {
      const active = sourceFilterCurrent.includes(s.name);
      return `<button type="button" class="chip source-toggle${active ? " active" : ""}" data-source="${escapeAttr(s.name)}" aria-pressed="${active ? "true" : "false"}">${escapeHtml(s.display_name || s.name)}</button>`;
    })
    .join("\n");

  const sourceFilter =
    activeSet.size > 1
      ? `<details class="popover">
          <summary>${icon("layers")}Source${sourceFilterCurrent.length ? ` <span class="popover-count">${sourceFilterCurrent.length}</span>` : ""}</summary>
          <div class="popover-panel"><p class="popover-title">Filter within the selected sources</p><div class="chips">${sourceButtons}</div></div>
        </details>`
      : "";

  const tagFilter = allTags.size
    ? `<details class="popover">
        <summary>${icon("tag")}Tags${selectedTags.length ? ` <span class="popover-count">${selectedTags.length}</span>` : ""}</summary>
        <div class="popover-panel"><p class="popover-title">${allTags.size} tags · any match</p><div class="chips">${tagButtons}</div></div>
      </details>`
    : "";

  const groupSelect =
    initiatives.length > 0
      ? `<label class="field-inline">Group
          <select id="group-select" aria-label="Group projects by">
            <option value="initiative"${groupByInitiative ? " selected" : ""}>Initiative</option>
            <option value="status"${groupByInitiative ? "" : " selected"}>Status</option>
          </select>
        </label>`
      : "";

  const activeFilterNotes: string[] = [];
  if (current.q) activeFilterNotes.push(`matching “${escapeHtml(current.q)}”`);
  if (current.initiative) activeFilterNotes.push(current.initiative === "_ungrouped" ? "not in an initiative" : `in initiative ${escapeHtml(current.initiative)}`);
  if (current.client) activeFilterNotes.push(`for client ${escapeHtml(current.client)}`);
  if (selectedTags.length) activeFilterNotes.push(`tagged ${selectedTags.map(escapeHtml).join(" or ")}`);
  const filterSummary = activeFilterNotes.length || selectedStatuses.length || sourceFilterCurrent.length
    ? `<p class="section-note" role="status">Showing projects ${activeFilterNotes.join(", ") || "filtered"}. <a href="/projects">Clear all filters</a></p>`
    : "";

  const sort = currentSort === "name" || currentSort === "status" ? currentSort : "recent";
  return `
    <div class="filters">
      <div class="toolbar">
        <div class="search-field">${icon("search")}<input type="search" id="search-input" placeholder="Search projects by name, description or tag" value="${escapeAttr(current.q || "")}" aria-label="Search projects"></div>
        <label class="field-inline">Sort
          <select id="sort-select" aria-label="Sort projects">
            <option value="recent"${sort === "recent" ? " selected" : ""}>Recently active</option>
            <option value="name"${sort === "name" ? " selected" : ""}>Name</option>
            <option value="status"${sort === "status" ? " selected" : ""}>Status</option>
          </select>
        </label>
        ${groupSelect}
        ${sourceFilter}
        ${tagFilter}
      </div>
      <div class="chips status-tabs" role="group" aria-label="Filter by status">
        <a class="chip${selectedStatuses.length === 0 ? " active" : ""}" href="${escapeAttr(allHref)}"${selectedStatuses.length === 0 ? ' aria-current="true"' : ""}>All <span class="chip-count">${total}</span></a>
        ${statusChips}
      </div>
      ${filterSummary}
    </div>
    <script>
      (function() {
        let searchTimeout;
        const searchInput = document.getElementById('search-input');
        if (searchInput) {
          searchInput.addEventListener('input', function(e) {
            clearTimeout(searchTimeout);
            searchTimeout = setTimeout(() => updateFilter('q', e.target.value), 350);
          });
          searchInput.addEventListener('keydown', function(e) {
            if (e.key === 'Enter') { clearTimeout(searchTimeout); updateFilter('q', searchInput.value); }
          });
        }

        function bindToggle(selector, paramName, attrName) {
          document.querySelectorAll(selector).forEach(btn => {
            btn.addEventListener('click', () => {
              const value = btn.dataset[attrName];
              const url = new URL(window.location);
              const curr = url.searchParams.get(paramName);
              const list = curr ? curr.split(',') : [];
              const idx = list.indexOf(value);
              if (idx >= 0) list.splice(idx, 1);
              else list.push(value);
              if (list.length) url.searchParams.set(paramName, list.join(','));
              else url.searchParams.delete(paramName);
              window.location = url.toString();
            });
          });
        }

        bindToggle('.status-toggle', 'status', 'status');
        bindToggle('.tag-toggle', 'tag', 'tag');
        bindToggle('.source-toggle', 'source', 'source');

        const groupSelect = document.getElementById('group-select');
        if (groupSelect) {
          groupSelect.addEventListener('change', () => {
            const url = new URL(window.location);
            url.searchParams.set('group', groupSelect.value);
            window.location = url.toString();
          });
        }

        const sortSelect = document.getElementById('sort-select');
        if (sortSelect) {
          sortSelect.addEventListener('change', () => {
            updateFilter('sort', sortSelect.value === 'recent' ? '' : sortSelect.value);
          });
        }

        // Delegated: this script runs before the project rows exist in
        // the DOM, so querying for buttons here would bind zero
        // listeners and every click would silently do nothing.
        document.addEventListener('click', async (event) => {
          const btn = event.target instanceof Element ? event.target.closest('.resume-copy') : null;
          if (!btn || !btn.dataset.resumeFor) return;
          event.preventDefault();
          const target = document.getElementById(btn.dataset.resumeFor);
          const text = target ? target.textContent : '';
          if (!text) return;
          const copied = await copyText(text);
          if (!copied && target) target.hidden = false;
          const label = btn.textContent;
          btn.textContent = copied ? 'Copied' : 'Copy failed';
          setTimeout(() => { btn.textContent = label; }, copied ? 1500 : 4000);
          showToast(
            copied
              ? 'Resume prompt copied to clipboard — paste it into your coding agent.'
              : 'Copy failed — select the prompt text revealed by the button and copy it manually.',
            !copied
          );
        });

        function showToast(message, isError) {
          let toast = document.getElementById('resume-toast');
          if (!toast) {
            toast = document.createElement('div');
            toast.id = 'resume-toast';
            toast.setAttribute('role', 'status');
            toast.setAttribute('aria-live', 'polite');
            document.body.appendChild(toast);
          }
          toast.textContent = message;
          toast.classList.toggle('toast-error', !!isError);
          // Restart the transition when messages arrive back to back.
          toast.classList.remove('toast-visible');
          void toast.offsetWidth;
          toast.classList.add('toast-visible');
          clearTimeout(showToast._timer);
          showToast._timer = setTimeout(() => toast.classList.remove('toast-visible'), isError ? 5000 : 3000);
        }

        async function copyText(text) {
          try {
            await navigator.clipboard.writeText(text);
            return true;
          } catch {
            // Clipboard API unavailable (permissions, non-secure context).
          }
          try {
            const area = document.createElement('textarea');
            area.value = text;
            area.setAttribute('readonly', '');
            area.style.position = 'absolute';
            area.style.left = '-9999px';
            document.body.appendChild(area);
            area.select();
            const ok = document.execCommand('copy');
            area.remove();
            return ok;
          } catch {
            return false;
          }
        }

        function updateFilter(key, value) {
          const url = new URL(window.location);
          if (value) url.searchParams.set(key, value);
          else url.searchParams.delete(key);
          window.location = url.toString();
        }
      })();
    </script>
  `;
}

function renderProjectGroupsByStatus(
  projects: ProjectWithSource[],
  sources: Source[],
  sortMode: string | undefined,
  resumeSkillInstalled: boolean,
  multiSource: boolean
): string {
  const grouped = new Map<ProjectStatus, ProjectWithSource[]>();
  for (const p of projects) {
    const status = p.status as ProjectStatus;
    if (!grouped.has(status)) grouped.set(status, []);
    grouped.get(status)!.push(p);
  }
  for (const [, list] of grouped) sortProjects(list, sortMode);

  const sourceByName = new Map(sources.map((s) => [s.name, s]));
  const sections: string[] = [];
  const ids = { next: 0 };

  for (const status of STATUS_ORDER) {
    const list = grouped.get(status);
    if (!list || list.length === 0) continue;
    const rows = list.map((p) => renderProjectRow(p, sourceByName, resumeSkillInstalled, ids, multiSource)).join("\n");
    sections.push(`
      <section class="project-group" aria-label="${escapeAttr(capitalize(status))} projects">
        <div class="group-header">
          <h2 class="group-title">${statusBadge(status)} <span class="group-count">${list.length}</span></h2>
        </div>
        <div class="project-table">${rows}</div>
      </section>
    `);
  }

  return sections.length === 0
    ? emptyState({ icon: "search", title: "No projects match these filters" })
    : sections.join("\n");
}

function renderProjectsGroupedByInitiative(
  projects: ProjectWithSource[],
  initiatives: InitiativeWithSource[],
  sources: Source[],
  sortMode: string | undefined,
  resumeSkillInstalled: boolean,
  multiSource: boolean
): string {
  const sourceByName = new Map(sources.map((s) => [s.name, s]));
  const ids = { next: 0 };

  // Index projects by (source, initiative-or-ungrouped)
  const byKey = new Map<string, ProjectWithSource[]>();
  for (const p of projects) {
    const key = `${p._source}::${p.initiative || "_ungrouped"}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key)!.push(p);
  }
  for (const [, list] of byKey) sortProjects(list, sortMode);

  const sections: string[] = [];

  // Render per-source, iterating in source order so sections are deterministic.
  for (const src of sources) {
    const srcInitiatives = initiatives.filter((i) => i._source === src.name);

    const perInitSections: string[] = [];
    for (const init of srcInitiatives) {
      const list = byKey.get(`${src.name}::${init.id}`) || [];
      if (list.length === 0) continue;
      perInitSections.push(renderInitiativeBlock(init, list, sourceByName, resumeSkillInstalled, ids, multiSource));
    }

    const ungrouped = byKey.get(`${src.name}::_ungrouped`) || [];
    if (ungrouped.length > 0) {
      perInitSections.push(renderUngroupedBlock(src.name, ungrouped, sourceByName, resumeSkillInstalled, ids, multiSource, perInitSections.length > 0));
    }

    if (perInitSections.length === 0) continue;

    sections.push(`
      <section class="source-block" aria-label="${escapeAttr(src.display_name || src.name)}">
        ${multiSource ? `<h2 class="source-block-title">${icon("layers", "icon-sm")}${escapeHtml(src.display_name || src.name)}</h2>` : ""}
        ${perInitSections.join("\n")}
      </section>
    `);
  }

  return sections.length === 0
    ? emptyState({ icon: "search", title: "No projects match these filters" })
    : sections.join("\n");
}

function renderInitiativeBlock(
  init: InitiativeWithSource,
  projects: ProjectWithSource[],
  sourceByName: Map<string, Source>,
  resumeSkillInstalled: boolean,
  ids: { next: number },
  multiSource: boolean
): string {
  const rows = projects.map((p) => renderProjectRow(p, sourceByName, resumeSkillInstalled, ids, multiSource)).join("\n");
  return `
    <section class="project-group initiative-block">
      <div class="group-header">
        <h3 class="group-title">${icon("target", "icon")}<a href="/initiatives/${encodeURIComponent(init._source)}/${encodeURIComponent(init.id)}">${escapeHtml(init.name)}</a> <span class="group-count">${projects.length}</span></h3>
        ${statusBadge(init.status)}
        ${init.description ? `<p class="group-desc">${escapeHtml(init.description)}</p>` : ""}
      </div>
      <div class="project-table">${rows}</div>
    </section>
  `;
}

function renderUngroupedBlock(
  sourceName: string,
  projects: ProjectWithSource[],
  sourceByName: Map<string, Source>,
  resumeSkillInstalled: boolean,
  ids: { next: number },
  multiSource: boolean,
  hasInitiatives: boolean
): string {
  const rows = projects.map((p) => renderProjectRow(p, sourceByName, resumeSkillInstalled, ids, multiSource)).join("\n");
  return `
    <section class="project-group initiative-block initiative-block-ungrouped">
      <div class="group-header">
        <h3 class="group-title"><a href="/projects?source=${encodeURIComponent(sourceName)}&amp;initiative=_ungrouped">${hasInitiatives ? "Not in an initiative" : "Projects"}</a> <span class="group-count">${projects.length}</span></h3>
        ${hasInitiatives ? `<p class="group-desc">Projects not yet assigned to an initiative in this source.</p>` : ""}
      </div>
      <div class="project-table">${rows}</div>
    </section>
  `;
}

function renderProjectRow(
  p: ProjectWithSource,
  sourceByName: Map<string, Source>,
  resumeSkillInstalled: boolean,
  ids: { next: number },
  multiSource: boolean
): string {
  const src = sourceByName.get(p._source);
  const sourceLabel = src ? src.display_name || src.name : p._source;
  const tags = p.tags || [];
  const shownTags = tags
    .slice(0, 3)
    .map((t) => `<a href="/projects?tag=${encodeURIComponent(t)}" class="tag">${escapeHtml(t)}</a>`)
    .join(" ");
  const moreTags = tags.length > 3 ? `<span class="tag-more" title="${escapeAttr(tags.slice(3).join(", "))}">+${tags.length - 3}</span>` : "";

  const date = p.last_session || p.completed_date || p.started_date || "";
  const description = p.description ? truncate(p.description.replace(/\n/g, " "), 220) : "";
  const promptId = `resume-prompt-${ids.next++}`;
  const prompt = resumePrompt(p, resumeSkillInstalled);

  return `
    <article class="project-row">
      <div class="project-header">
        <a class="project-name" href="/projects/${encodeURIComponent(p._source)}/${encodeURIComponent(p.id)}">${escapeHtml(p.name)}</a>
        <span class="project-header-meta">${statusBadge(p.status)}</span>
      </div>
      ${description ? `<p class="project-desc">${escapeHtml(description)}</p>` : ""}
      <div class="project-meta">
        ${multiSource ? sourceBadge(sourceLabel, p._source) : ""}
        <span class="project-time recency" title="Newest session activity${date ? `; index date ${escapeAttr(date)}` : ""}">${icon("clock")}${escapeHtml(relativeLabel(p._lastActiveMs))}</span>
        ${p.client ? `<span class="tag tag-client">${escapeHtml(p.client)}</span>` : ""}
        ${shownTags}${moreTags}
        <span class="resume-wrap">
          <button type="button" class="resume-copy" data-resume-for="${promptId}" title="Copy a prompt you can paste into any coding agent to resume this project">Copy resume prompt</button>
          <pre hidden id="${promptId}">${escapeHtml(prompt)}</pre>
        </span>
      </div>
    </article>
  `;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max).trimEnd() + "…";
}
