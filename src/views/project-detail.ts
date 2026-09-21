import type { ProjectWithSource, Initiative } from "../parsers/yaml.js";
import { escapeHtml, escapeAttr } from "../utils.js";
import { relativeLabel, resumePrompt } from "../parsers/recency.js";

const STATUS_COLORS: Record<string, string> = {
  active: "blue",
  new: "purple",
  paused: "yellow",
  ongoing: "teal",
  completed: "green",
  archived: "gray",
  superseded: "red",
};

export function projectDetailView(opts: {
  project: ProjectWithSource;
  contextHtml: string | null;
  referenceHtml: string | null;
  sessions: { name: string; period: string }[];
  sourceName: string;
  initiative?: Initiative;
  relatedResolutions?: Map<string, { source: string }>;
  resumeSkillInstalled?: boolean;
  lastActiveMs?: number;
}): string {
  const { project: p, contextHtml, referenceHtml, sessions, sourceName, initiative, relatedResolutions, resumeSkillInstalled, lastActiveMs } = opts;

  const statusColor = STATUS_COLORS[p.status] || "gray";

  const tags = (p.tags || [])
    .map(
      (t) =>
        `<a href="/projects?tag=${encodeURIComponent(t)}" class="tag">${escapeHtml(t)}</a>`
    )
    .join(" ");

  const relatedLinks = (p.related || [])
    .map((r) => {
      // If we know which source contains this related project, link there.
      const resolution = relatedResolutions?.get(r);
      if (resolution) {
        return `<a href="/projects/${encodeURIComponent(resolution.source)}/${encodeURIComponent(r)}">${escapeHtml(r)}</a>`;
      }
      // Unresolved: render as plain text so we don't produce broken links.
      return `<span class="related-unresolved" title="Not in currently active sources">${escapeHtml(r)}</span>`;
    })
    .join(", ");

  const dates = buildDatesTable(p);
  const sessionsList = renderSessionsList(p.id, sessions, sourceName);
  const prompt = resumePrompt(p, resumeSkillInstalled ?? false);
  const newestPeriod = sessions.length > 0 ? sessions[0].period : null;

  return `
    <nav aria-label="breadcrumb">
      <ul>
        <li><a href="/projects">Projects</a></li>
        <li><span class="source-badge" title="Source: ${escapeAttr(sourceName)}">${escapeHtml(sourceName)}</span></li>
        <li>${escapeHtml(p.name)}</li>
      </ul>
    </nav>

    <hgroup>
      <h1>${escapeHtml(p.name)}</h1>
      <p><span class="badge badge-${statusColor}">${escapeHtml(p.status)}</span>
      <span class="recency" title="Newest session activity">${escapeHtml(relativeLabel(lastActiveMs))}</span>
      ${newestPeriod ? `<span class="tag">session ${escapeHtml(newestPeriod)}</span>` : ""}</p>
    </hgroup>

    <section class="resume-block">
      <h3>Resume in any coding agent</h3>
      <p class="resume-explainer">Copy the prompt below and paste it into Claude Code, Codex, Muse, or any other coding agent — the resume skill picks up this project there.</p>
      <pre id="resume-prompt-detail">${escapeHtml(prompt)}</pre>
      <button class="resume-copy" data-resume-for="resume-prompt-detail">Copy resume prompt</button>
    </section>
    <script>
      (function() {
        const btn = document.querySelector('.resume-block .resume-copy');
        if (!btn) return;
        btn.addEventListener('click', async () => {
          const target = document.getElementById(btn.dataset.resumeFor);
          const text = target ? target.textContent : '';
          if (!text) return;
          const copied = await copyText(text);
          const label = btn.textContent;
          btn.textContent = copied ? 'Copied' : 'Copy failed';
          setTimeout(() => { btn.textContent = label; }, copied ? 1500 : 4000);
          showToast(
            copied
              ? 'Resume prompt copied to clipboard — paste it into your coding agent.'
              : 'Copy failed — select the prompt text above and copy it manually.',
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
      })();
    </script>

    <div class="project-detail-layout">
      <aside class="project-sidebar">
        <section>
          <h3>Metadata</h3>
          <div class="sidebar-section"><strong>Source</strong><div>${escapeHtml(sourceName)}</div></div>
          ${initiative ? `<div class="sidebar-section"><strong>Initiative</strong><div><a href="/initiatives/${escapeAttr(sourceName)}/${escapeAttr(initiative.id)}">${escapeHtml(initiative.name)}</a></div></div>` : ""}
          ${dates}
          ${tags ? `<div class="sidebar-section"><strong>Tags</strong><div>${tags}</div></div>` : ""}
          ${p.client ? `<div class="sidebar-section"><strong>Client</strong><div>${escapeHtml(p.client)}</div></div>` : ""}
          ${relatedLinks ? `<div class="sidebar-section"><strong>Related</strong><div>${relatedLinks}</div></div>` : ""}
          ${p.outcome ? `<div class="sidebar-section"><strong>Outcome</strong><div>${escapeHtml(p.outcome)}</div></div>` : ""}
          ${p.superseded_by ? `<div class="sidebar-section"><strong>Superseded by</strong><div><a href="/projects/${encodeURIComponent(sourceName)}/${encodeURIComponent(p.superseded_by)}">${escapeHtml(p.superseded_by)}</a></div></div>` : ""}
        </section>
        ${p.key_result ? `<section><h3>Key Result</h3><p>${escapeHtml(p.key_result)}</p></section>` : ""}
        ${sessionsList}
      </aside>

      <div class="project-content">
        ${p.description ? `<section class="project-description"><p>${escapeHtml(p.description.replace(/\n/g, " "))}</p></section>` : ""}

        ${contextHtml ? `
          <section>
            <h2>Context (Working Memory)</h2>
            <div class="rendered-markdown">${contextHtml}</div>
          </section>
        ` : `<section><p><em>No CONTEXT.md file found for this project.</em></p></section>`}

        ${referenceHtml ? `
          <details open>
            <summary><h2 style="display:inline">Reference (Stable Facts)</h2></summary>
            <div class="rendered-markdown">${referenceHtml}</div>
          </details>
        ` : ""}
      </div>
    </div>
  `;
}

function buildDatesTable(p: ProjectWithSource): string {
  const rows: string[] = [];
  if (p.started_date) rows.push(`<tr><td>Started</td><td>${escapeHtml(p.started_date)}</td></tr>`);
  if (p.completed_date) rows.push(`<tr><td>Completed</td><td>${escapeHtml(p.completed_date)}</td></tr>`);
  if (p.archived_date) rows.push(`<tr><td>Archived</td><td>${escapeHtml(p.archived_date)}</td></tr>`);
  if (p.last_session) rows.push(`<tr><td>Last session</td><td>${escapeHtml(p.last_session)}</td></tr>`);

  if (rows.length === 0) return "";
  return `<table class="dates-table"><tbody>${rows.join("")}</tbody></table>`;
}

function renderSessionsList(
  projectId: string,
  sessions: { name: string; period: string }[],
  sourceName: string
): string {
  if (sessions.length === 0) return "";

  const items = sessions
    .map(
      (s) =>
        `<li><a href="/projects/${encodeURIComponent(sourceName)}/${encodeURIComponent(projectId)}/sessions/${encodeURIComponent(s.period)}">${escapeHtml(s.name)}</a></li>`
    )
    .join("\n");

  return `
    <section>
      <h3>Sessions</h3>
      <ul>${items}</ul>
    </section>
  `;
}
