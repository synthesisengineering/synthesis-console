import { escapeHtml } from "../utils.js";
import type { RepoIssue, SyncStatus } from "../sync.js";
import { icon } from "./icons.js";
import { callout, pageHeader } from "./ui.js";

function issueHtml(issue: RepoIssue): string {
  const files = issue.files?.length
    ? `<span class="file-list">${issue.files.map((f) => escapeHtml(f)).join("<br>")}${
        (issue.total ?? 0) > issue.files.length ? `<br>… and ${(issue.total ?? 0) - issue.files.length} more` : ""
      }</span>`
    : "";
  return `<div><span class="sync-issue sync-issue-${escapeHtml(issue.type)}">${escapeHtml(issue.detail)}</span>${files}</div>`;
}

const LEAD = "Every repository the repo guard watches on this machine: what is uncommitted, unpushed or behind.";

/**
 * /sync: the full repo-guard report. This is a private surface the principal
 * opens deliberately: repository names and file lists are appropriate here,
 * unlike spoken alerts and banners, which carry counts only.
 */
export function syncView(status: SyncStatus): string {
  if (!status.installed && !status.report) {
    const searched = status.searched.map((d) => `<li><code>${escapeHtml(d)}</code></li>`).join("\n");
    return `${pageHeader({ title: "Repo sync", lead: LEAD })}
${callout(
  "warn",
  `The repo guard (<code>synthesis-repo-guard</code>) was not found in the synthesis v5 runtime or any harness plugin cache, so the scan and its report are unavailable. Install the synthesis-skills plugin. Searched:<ul>${searched}</ul>`,
  { title: "Repo guard not installed", role: "alert" }
)}`;
  }

  const rep = status.report;
  const repos = rep?.repos ?? [];
  const attention = repos.filter((r) => !r.clean);
  const noted = repos.filter((r) => r.clean && r.issues.length);
  const rows =
    attention.length === 0
      ? `<tr><td colspan="2">${rep ? `${icon("checkCircle", "icon-sm")} All ${repos.length} repositories are clean and synced.` : "No report yet."}</td></tr>`
      : attention
          .map(
            (r) => `<tr><td><span class="cell-strong"><code>${escapeHtml(r.name)}</code></span><span class="cell-sub">${escapeHtml(r.path)}</span></td><td>${r.issues
              .map(issueHtml)
              .join("")}</td></tr>`
          )
          .join("\n");
  const notedList = noted.length
    ? `<section class="section" aria-labelledby="noted-title">
<h2 class="section-title" id="noted-title">Noted (${noted.length})</h2>
<p class="section-note">Clean detached checkouts strand nothing, so they do not count as needing attention.</p>
<ul class="list" style="margin-top:var(--sp-3)">${noted
        .map((r) => `<li class="list-row"><span class="list-row-main"><span class="list-row-title"><code>${escapeHtml(r.name)}</code></span><span class="list-row-sub">${r.issues.map((i) => escapeHtml(i.detail)).join("; ")}</span></span></li>`)
        .join("")}</ul>
</section>`
    : "";
  const quietLabel = status.quietAudio ? `${icon("volumeOff")}Audio muted · unmute` : `${icon("volume")}Audio on · mute`;
  const report = rep
    ? `Report ${escapeHtml(rep.generated_at)} on ${escapeHtml(rep.host || "unknown host")} · ${rep.total_repos} repositories scanned`
    : "No report yet";

  const clean = rep && attention.length === 0;
  const verdict = `<section class="card verdict ${!rep ? "" : clean ? "verdict-ok" : "verdict-warn"}" aria-label="Verdict">
  <div class="verdict-main">
    <span class="verdict-icon">${icon(!rep ? "info" : clean ? "checkCircle" : "alert")}</span>
    <div>
      <p class="verdict-title">${!rep ? "No report yet" : clean ? "All repositories synced" : `${attention.length} repositor${attention.length === 1 ? "y needs" : "ies need"} attention`}</p>
      <p class="verdict-sub">${report}${status.refreshing ? " · scanning now" : ""}</p>
    </div>
  </div>
</section>`;

  return `${pageHeader({
    title: "Repo sync",
    lead: LEAD,
    actionsHtml: `<div class="sync-controls">
  ${status.installed ? `<button id="sync-refresh" type="button">${icon("refresh")}Scan now</button>` : ""}
  <button id="sync-quiet" type="button" data-quiet="${status.quietAudio ? "true" : "false"}" aria-pressed="${status.quietAudio ? "true" : "false"}">${quietLabel}</button>
  <span id="sync-controls-status" role="status" aria-live="polite"></span>
</div>`,
  })}
${verdict}
${status.error ? callout("bad", `<mark>Problem:</mark> ${escapeHtml(status.error)}`, { role: "alert" }) : ""}
<section aria-labelledby="attention-title">
<div class="section-header"><h2 class="section-title" id="attention-title">Needs attention (${attention.length})</h2></div>
<div class="table-wrap"><table>
  <thead><tr><th scope="col">Repository</th><th scope="col">State</th></tr></thead>
  <tbody>${rows}</tbody>
</table></div>
</section>
${notedList}
<p class="footnote">The scan only reads: it never commits, fetches or pushes. A session commits the files it
changed, inside its own claims, with <code>synthesis handoff</code>; anything else here belongs to the
session or person that owns it. Spoken alerts and banners stay generic (a count and a pointer, never a
repository name); this page and <code>~/.synthesis/repo-guard/last-report.json</code> carry the detail.</p>
<script>
(function () {
  function el(id) { return document.getElementById(id); }
  function setStatus(msg) { var s = el('sync-controls-status'); if (s) s.textContent = msg || ''; }
  function post(url) {
    setStatus('Working…');
    fetch(url, { method: 'POST' }).then(function (r) { return r.json(); }).then(function (b) {
      if (b && b.ok === false) { setStatus('That did not work. Nothing was changed.'); return; }
      location.reload();
    }).catch(function () { setStatus('Request failed.'); });
  }
  var refresh = el('sync-refresh');
  if (refresh) refresh.addEventListener('click', function () { post('/api/sync/refresh'); });
  var quiet = el('sync-quiet');
  if (quiet) quiet.addEventListener('click', function () {
    var turnOn = quiet.dataset.quiet !== 'true';
    post('/api/quiet-audio?on=' + (turnOn ? '1' : '0'));
  });
})();
</script>`;
}
