import { escapeHtml } from "../utils.js";
import type {
  AgentConformanceStatus,
  ConformanceCheck,
} from "../agent-conformance.js";

function duration(seconds: number | null): string {
  if (seconds === null) return "unknown age";
  if (seconds < 60) return `${seconds}s old`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m old`;
  return `${Math.floor(seconds / 3600)}h old`;
}

function renderChecks(plane: string, checks: ConformanceCheck[]): string {
  if (checks.length === 0) return "";
  const rows = checks
    .map((check) => `<tr>
<td><strong>${escapeHtml(check.status)}</strong></td>
<td><code>${escapeHtml(check.name)}</code></td>
<td>${escapeHtml(check.detail)}</td>
</tr>`)
    .join("\n");
  return `<h2>${escapeHtml(plane)} (${checks.length})</h2>
<div style="overflow-x:auto"><table>
<thead><tr><th>Result</th><th>Check</th><th>Evidence</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

export function agentConformanceView(status: AgentConformanceStatus): string {
  if (!status.conformanceAvailable && !status.report) {
    if (status.auditError) {
      return `<h1>Agent Conformance</h1>
<p><mark>Audit error:</mark> ${escapeHtml(status.auditError)}</p>
<p>Set <code>SYNTHESIS_CONFORMANCE_SOURCE_ROOT</code> to a Git-backed
<code>synthesis-skills</code> source checkout, then run the audit again.</p>`;
    }
    return `<h1>Agent Conformance</h1>
<p>The <code>synthesis-agent-conformance</code> program and its evidence cache
are unavailable. Install the synthesis-skills plugin or set
<code>SYNTHESIS_AGENT_CONFORMANCE_DIR</code>.</p>`;
  }
  const report = status.report;
  const counts = new Map<string, number>();
  for (const check of report?.checks ?? []) {
    counts.set(check.status, (counts.get(check.status) ?? 0) + 1);
  }
  const summary = report
    ? `<p><strong>${escapeHtml(report.status)}</strong> ·
${[...counts.entries()].map(([key, value]) => `${value} ${escapeHtml(key)}`).join(" · ")}</p>
<p>Evidence: ${escapeHtml(report.checked_at)} (${duration(status.ageSeconds)})${status.stale ? " · <mark>STALE</mark>" : ""}</p>`
    : `<p>No conformance evidence has been recorded.</p>`;
  const audit = status.auditing
    ? `<p><em>Audit running. Reload to read the atomic result.</em></p>`
    : status.conformanceAvailable
      ? `<button id="conformance-audit-btn">Audit now</button>`
      : `<p><em>Showing cached evidence; the conformance program is unavailable.</em></p>`;
  const auditError = status.auditError
    ? `<p><mark>Audit error:</mark> ${escapeHtml(status.auditError)}</p>`
    : "";
  const planes = [...new Set((report?.checks ?? []).map((check) => check.plane))];
  const contextAge = status.contextGeneratedAt
    ? `${escapeHtml(status.contextGeneratedAt)} (${duration(status.contextAgeSeconds)})`
    : "unavailable";
  return `<h1>Agent Conformance</h1>
${summary}
${audit}
${auditError}
<p>Context-doctor cache: ${contextAge}</p>
${planes.map((plane) => renderChecks(plane, (report?.checks ?? []).filter((check) => check.plane === plane))).join("\n")}
<p><small>This page renders conformance's structured evidence without
reinterpreting results. Source, installed, live, continuity, and capability planes
remain separate; stale evidence never becomes a current PASS.</small></p>
<script>
(function () {
  var btn = document.getElementById("conformance-audit-btn");
  if (!btn) return;
  btn.addEventListener("click", function () {
    btn.disabled = true;
    btn.textContent = "Audit started…";
    fetch("/api/conformance/audit", { method: "POST" })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        btn.textContent = body.ok ? "Audit running — reload for results" : "Audit could not start";
        if (!body.ok) btn.disabled = false;
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "Audit now";
      });
  });
})();
</script>`;
}
