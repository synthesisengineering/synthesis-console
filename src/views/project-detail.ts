import type { ProjectWithSource, Initiative } from "../parsers/yaml.js";
import { escapeHtml, escapeAttr } from "../utils.js";
import { relativeLabel, resumePrompt } from "../parsers/recency.js";
import { icon } from "./icons.js";
import { emptyState, pageHeader, sourceBadge, statusBadge } from "./ui.js";

/** "July 2026" for a YYYY-MM session period; other names pass through. */
export function periodLabel(period: string): string {
  const m = period.match(/^(\d{4})-(\d{2})$/);
  if (!m) return period;
  return new Date(Number(m[1]), Number(m[2]) - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

export function projectDetailView(opts: {
  project: ProjectWithSource;
  contextHtml: string | null;
  referenceHtml: string | null;
  sessions: { name: string; period: string }[];
  sourceName: string;
  sourceLabel?: string;
  initiative?: Initiative;
  relatedResolutions?: Map<string, { source: string }>;
  resumeSkillInstalled?: boolean;
  lastActiveMs?: number;
}): string {
  const { project: p, contextHtml, referenceHtml, sessions, sourceName, initiative, relatedResolutions, resumeSkillInstalled, lastActiveMs } = opts;
  const sourceLabel = opts.sourceLabel ?? sourceName;

  const tags = (p.tags || [])
    .map((t) => `<a href="/projects?tag=${encodeURIComponent(t)}" class="tag">${escapeHtml(t)}</a>`)
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

  const prompt = resumePrompt(p, resumeSkillInstalled ?? false);
  const newestPeriod = sessions.length > 0 ? sessions[0].period : null;

  const metaRows: [string, string][] = [];
  metaRows.push(["Status", statusBadge(p.status)]);
  metaRows.push(["Source", sourceBadge(sourceLabel, sourceName)]);
  if (initiative) metaRows.push(["Initiative", `<a href="/initiatives/${encodeURIComponent(sourceName)}/${encodeURIComponent(initiative.id)}">${escapeHtml(initiative.name)}</a>`]);
  if (p.client) metaRows.push(["Client", `<span class="tag tag-client">${escapeHtml(p.client)}</span>`]);
  if (p.started_date) metaRows.push(["Started", `<time>${escapeHtml(p.started_date)}</time>`]);
  if (p.last_session) metaRows.push(["Last session", `<time>${escapeHtml(p.last_session)}</time>`]);
  if (p.completed_date) metaRows.push(["Completed", `<time>${escapeHtml(p.completed_date)}</time>`]);
  if (p.archived_date) metaRows.push(["Archived", `<time>${escapeHtml(p.archived_date)}</time>`]);
  if (tags) metaRows.push(["Tags", `<div class="tags">${tags}</div>`]);
  if (relatedLinks) metaRows.push(["Related", relatedLinks]);
  if (p.technologies && p.technologies.length) metaRows.push(["Technologies", escapeHtml(p.technologies.join(", "))]);
  if (p.superseded_by) metaRows.push(["Superseded by", `<a href="/projects/${encodeURIComponent(sourceName)}/${encodeURIComponent(p.superseded_by)}">${escapeHtml(p.superseded_by)}</a>`]);

  const outcomeCard = p.outcome || p.key_result
    ? `<section class="card rail-card" aria-label="Outcome">
        ${p.key_result ? `<h2 class="rail-title">Key result</h2><p>${escapeHtml(p.key_result)}</p>` : ""}
        ${p.outcome ? `<h2 class="rail-title">Outcome</h2><p>${escapeHtml(p.outcome)}</p>` : ""}
      </section>`
    : "";

  const sessionsCard = sessions.length
    ? `<section class="card rail-card" aria-labelledby="sessions-title">
        <h2 class="rail-title" id="sessions-title">Session log <span class="muted">${sessions.length}</span></h2>
        <ul class="session-links">${sessions
          .map(
            (s) =>
              `<li><a href="/projects/${encodeURIComponent(sourceName)}/${encodeURIComponent(p.id)}/sessions/${encodeURIComponent(s.period)}"><span>${escapeHtml(periodLabel(s.name))}</span>${icon("chevronRight", "icon-sm")}</a></li>`
          )
          .join("")}</ul>
      </section>`
    : "";

  return `
    ${pageHeader({
      title: p.name,
      eyebrowHtml: `${sourceBadge(sourceLabel, sourceName)}${initiative ? `<a href="/initiatives/${encodeURIComponent(sourceName)}/${encodeURIComponent(initiative.id)}">${icon("target", "icon-sm")} ${escapeHtml(initiative.name)}</a>` : ""}`,
      metaHtml: `${statusBadge(p.status)}<span class="recency" title="Newest session activity">${icon("clock", "icon-sm")}Active ${escapeHtml(relativeLabel(lastActiveMs))}</span>${
        newestPeriod ? `<span>${icon("book", "icon-sm")}Latest session log: ${escapeHtml(periodLabel(newestPeriod))}</span>` : ""
      }`,
    })}

    <div class="detail-layout">
      <div class="stack">
        ${p.description ? `<p class="project-lead">${escapeHtml(p.description.replace(/\n/g, " "))}</p>` : ""}

        ${contextHtml ? `
          <section class="card doc-card" aria-labelledby="context-title">
            <h2 class="doc-card-title" id="context-title"><span>Working memory</span><span class="file-name">CONTEXT.md</span></h2>
            <div class="rendered-markdown">${contextHtml}</div>
          </section>
        ` : emptyState({ icon: "fileCheck", title: "No CONTEXT.md yet", body: "This project has no working-memory file. A session writes CONTEXT.md when it starts recording the project's state." })}

        ${referenceHtml ? `
          <details class="card doc-card">
            <summary>Stable reference <span class="file-name">REFERENCE.md</span></summary>
            <div class="rendered-markdown">${referenceHtml}</div>
          </details>
        ` : ""}
      </div>

      <aside class="rail rail-sticky" aria-label="Project details">
        <section class="card rail-card resume-block" aria-labelledby="resume-title">
          <h2 class="rail-title" id="resume-title">Resume in any coding agent</h2>
          <p class="resume-explainer">Copy the prompt below and paste it into Claude Code, Codex, Muse, or any other coding agent — the resume skill picks up this project there.</p>
          <pre id="resume-prompt-detail">${escapeHtml(prompt)}</pre>
          <button type="button" class="resume-copy btn-primary" data-resume-for="resume-prompt-detail">Copy resume prompt</button>
        </section>

        <section class="card rail-card" aria-labelledby="details-title">
          <h2 class="rail-title" id="details-title">Details</h2>
          <dl class="meta-list">${metaRows.map(([k, v]) => `<div class="meta-row"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`).join("")}</dl>
        </section>

        ${outcomeCard}
        ${sessionsCard}
      </aside>
    </div>
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
  `;
}
