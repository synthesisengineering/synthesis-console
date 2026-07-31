import { escapeHtml } from "../utils.js";
import { searchedSkillDirs, type SyncStatus } from "../sync.js";

/**
 * /sync — the full-detail repo-sync page. This is a PRIVATE, deliberately
 * opened surface: repo names and file lists are appropriate here (unlike
 * audio/notification banners, which stay generic — see synthesis-repo-guard
 * SKILL.md confidentiality rule).
 */
export function syncView(status: SyncStatus): string {
  if (!status.installed) {
    // Report every location actually searched. An empty state that names only
    // one path sends you looking in the wrong place when the install route
    // changes (a plugin migration moves the skill; the old path is innocent).
    const searched = searchedSkillDirs()
      .map((d) => `<li><code>${escapeHtml(d)}</code></li>`)
      .join("\n");
    return `<h1>Repo Sync</h1>
<p>The <code>synthesis-repo-guard</code> skill was not found, so sync status,
checkpoints, and the quiet-audio toggle are unavailable. Install it from the
synthesis-skills repo — as a plugin or a direct copy — or point
<code>SYNTHESIS_REPO_GUARD_DIR</code> at a checkout.</p>
<p>A directory counts as installed when it contains both
<code>repo_sync_check.py</code> and <code>checkpoint_sync.py</code>. Searched, in order:</p>
<ul>
${searched}
</ul>`;
  }

  const rep = status.report;
  const repos: any[] = rep?.repos ?? [];
  const dirty = repos.filter((r) => !r.clean);
  const stateResults: any[] = status.checkpoint?.results ?? [];
  const alerts: any[] = status.checkpoint?.alerts ?? [];

  const dirtyRows =
    dirty.length === 0
      ? `<tr><td colspan="2">All ${repos.length} repositories clean and synced.</td></tr>`
      : dirty
          .map((r) => {
            const issues = (r.issues || [])
              .map((i: any) => {
                const files =
                  i.files && i.files.length
                    ? `<br><small><code>${i.files.map((f: string) => escapeHtml(f)).join("<br>")}</code>${
                        i.total > i.files.length ? `<br>… and ${i.total - i.files.length} more` : ""
                      }</small>`
                    : "";
                return `<span class="sync-issue sync-issue-${escapeHtml(i.type)}">${escapeHtml(i.detail)}</span>${files}`;
              })
              .join("<br>");
            return `<tr><td><code>${escapeHtml(r.name)}</code><br><small>${escapeHtml(r.path)}</small></td><td>${issues}</td></tr>`;
          })
          .join("\n");

  const checkpointRows =
    stateResults.length === 0
      ? `<tr><td colspan="3">No checkpoint run recorded yet.</td></tr>`
      : stateResults
          .map((r) => {
            const alert = r.alert
              ? `<span class="sync-alert-text">${escapeHtml(r.alert)}</span>`
              : "—";
            return `<tr><td><code>${escapeHtml(r.name)}</code></td><td>${escapeHtml(
              r.action
            )}${r.detail ? `<br><small>${escapeHtml(r.detail)}</small>` : ""}</td><td>${alert}</td></tr>`;
          })
          .join("\n");

  const alertBanner =
    alerts.length > 0
      ? `<article class="sync-alert-banner">⚠ ${alerts.length} item(s) need manual attention — see the checkpoint table below.</article>`
      : "";

  const quietLabel = status.quietAudio ? "🔇 Audio muted — click to unmute" : "🔊 Audio on — click to mute";

  return `<h1>Repo Sync</h1>
<p><small>Detector report: ${status.generatedAt ? escapeHtml(status.generatedAt) : "never"} on ${escapeHtml(
    rep?.host || "unknown host"
  )} · ${repos.length} repos scanned · checkpoint state: ${
    status.checkpoint ? escapeHtml(status.checkpoint.ts || "") + " (" + escapeHtml(status.checkpoint.mode || "") + ")" : "none"
  }</small></p>
${alertBanner}
<div class="sync-controls">
  <button id="sync-refresh">Refresh status</button>
  <button id="sync-now">Sync now (checkpoint)</button>
  <button id="sync-quiet" data-quiet="${status.quietAudio ? "true" : "false"}">${quietLabel}</button>
  <span id="sync-controls-status" role="status"></span>
</div>
<h2>Needs attention (${dirty.length})</h2>
<figure><table>
  <thead><tr><th>Repository</th><th>State</th></tr></thead>
  <tbody>${dirtyRows}</tbody>
</table></figure>
<h2>Last checkpoint run</h2>
<figure><table>
  <thead><tr><th>Repository</th><th>Action</th><th>Alert</th></tr></thead>
  <tbody>${checkpointRows}</tbody>
</table></figure>
<p><small>Audible and banner alerts are always generic (counts only — never repo or client
names); this page and the report files under <code>~/.synthesis/repo-guard/</code> are the
detail channels. Checkpoints run only at workflow events: agent turn ends, console writes,
the buttons above.</small></p>
<script>
(function () {
  function el(id) { return document.getElementById(id); }
  function setStatus(msg) { var s = el('sync-controls-status'); if (s) s.textContent = msg || ''; }
  function post(url, after) {
    setStatus('Working…');
    fetch(url, { method: 'POST' }).then(function (r) { return r.json(); }).then(function (b) {
      if (b && b.ok === false && b.error) { setStatus(b.error); return; }
      after ? after(b) : location.reload();
    }).catch(function () { setStatus('Request failed.'); });
  }
  var refresh = el('sync-refresh');
  if (refresh) refresh.addEventListener('click', function () { post('/api/sync/refresh'); });
  var now = el('sync-now');
  if (now) now.addEventListener('click', function () {
    setStatus('Checkpointing… (quiescence still applies)');
    post('/api/sync/checkpoint');
  });
  var quiet = el('sync-quiet');
  if (quiet) quiet.addEventListener('click', function () {
    var turnOn = quiet.dataset.quiet !== 'true';
    post('/api/quiet-audio?on=' + (turnOn ? '1' : '0'));
  });
})();
</script>`;
}
