import { escapeHtml } from "../utils.js";
import type { RepoIssue, SyncStatus } from "../sync.js";

function issueHtml(issue: RepoIssue): string {
  const files = issue.files?.length
    ? `<br><small><code>${issue.files.map((f) => escapeHtml(f)).join("<br>")}</code>${
        (issue.total ?? 0) > issue.files.length ? `<br>… and ${(issue.total ?? 0) - issue.files.length} more` : ""
      }</small>`
    : "";
  return `<span class="sync-issue sync-issue-${escapeHtml(issue.type)}">${escapeHtml(issue.detail)}</span>${files}`;
}

/**
 * /sync: the full repo-guard report. This is a private surface the principal
 * opens deliberately: repository names and file lists are appropriate here,
 * unlike spoken alerts and banners, which carry counts only.
 */
export function syncView(status: SyncStatus): string {
  if (!status.installed && !status.report) {
    const searched = status.searched.map((d) => `<li><code>${escapeHtml(d)}</code></li>`).join("\n");
    return `<h1>Repo Sync</h1>
<p role="alert">The repo guard (<code>synthesis-repo-guard</code>) was not found in the synthesis v5
runtime or any harness plugin cache, so the scan and its report are unavailable. Install the
synthesis-skills plugin. Searched:</p>
<ul>
${searched}
</ul>`;
  }

  const rep = status.report;
  const repos = rep?.repos ?? [];
  const attention = repos.filter((r) => !r.clean);
  const noted = repos.filter((r) => r.clean && r.issues.length);
  const rows =
    attention.length === 0
      ? `<tr><td colspan="2">${rep ? `All ${repos.length} repositories are clean and synced.` : "No report yet."}</td></tr>`
      : attention
          .map(
            (r) => `<tr><td><code>${escapeHtml(r.name)}</code><br><small>${escapeHtml(r.path)}</small></td><td>${r.issues
              .map(issueHtml)
              .join("<br>")}</td></tr>`
          )
          .join("\n");
  const notedList = noted.length
    ? `<h2>Noted (${noted.length})</h2>
<p><small>Clean detached checkouts strand nothing, so they do not count as needing attention.</small></p>
<ul>${noted
        .map((r) => `<li><code>${escapeHtml(r.name)}</code> — ${r.issues.map((i) => escapeHtml(i.detail)).join("; ")}</li>`)
        .join("")}</ul>`
    : "";
  const quietLabel = status.quietAudio ? "🔇 Audio muted — click to unmute" : "🔊 Audio on — click to mute";
  const report = rep
    ? `Report ${escapeHtml(rep.generated_at)} on ${escapeHtml(rep.host || "unknown host")} · ${rep.total_repos} repositories scanned`
    : "No report yet";

  return `<h1>Repo Sync</h1>
<p><small>${report}${status.refreshing ? " · scanning now" : ""}</small></p>
${status.error ? `<p role="alert"><mark>Problem:</mark> ${escapeHtml(status.error)}</p>` : ""}
<div class="sync-controls">
  ${status.installed ? `<button id="sync-refresh" type="button">Scan now</button>` : ""}
  <button id="sync-quiet" type="button" data-quiet="${status.quietAudio ? "true" : "false"}">${quietLabel}</button>
  <span id="sync-controls-status" role="status" aria-live="polite"></span>
</div>
<h2>Needs attention (${attention.length})</h2>
<figure><table>
  <thead><tr><th scope="col">Repository</th><th scope="col">State</th></tr></thead>
  <tbody>${rows}</tbody>
</table></figure>
${notedList}
<p><small>The scan only reads: it never commits, fetches or pushes. A session commits the files it
changed, inside its own claims, with <code>synthesis handoff</code>; anything else here belongs to the
session or person that owns it. Spoken alerts and banners stay generic (a count and a pointer, never a
repository name); this page and <code>~/.synthesis/repo-guard/last-report.json</code> carry the detail.</small></p>
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
