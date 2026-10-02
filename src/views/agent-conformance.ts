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
  if (checks.length === 0) return `<h2>${escapeHtml(plane)} (0)</h2><p>UNKNOWN: this plane was not measured by this audit.</p>`;
  const rows = checks
    .map((check) => `<tr>
<td><strong>${escapeHtml(check.status)}</strong></td>
<td><code>${escapeHtml(check.name)}</code></td>
<td>${escapeHtml(check.detail)}</td>
</tr>`)
    .join("\n");
  return `<h2>${escapeHtml(plane)} (${checks.length})</h2>
<div style="overflow-x:auto" tabindex="0" role="region" aria-label="${escapeHtml(plane)} evidence"><table>
<caption>${escapeHtml(plane)} audit evidence</caption>
<thead><tr><th scope="col">Result</th><th scope="col">Check</th><th scope="col">Evidence</th></tr></thead>
<tbody>${rows}</tbody></table></div>`;
}

export function agentConformanceView(status: AgentConformanceStatus): string {
  if (!status.conformanceAvailable && !status.report) {
    if (status.auditError) {
      return `<h1>Agent Conformance</h1>
<p role="alert"><mark>Audit error:</mark> ${escapeHtml(status.auditError)}</p>
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
    ? `<p><strong>${escapeHtml(report.status)}</strong> for ${escapeHtml(report.command)} audit ·
${[...counts.entries()].map(([key, value]) => `${value} ${escapeHtml(key)}`).join(" · ")}</p>
<p>Evidence: ${escapeHtml(report.checked_at)} (${duration(status.ageSeconds)})${status.stale ? " · <mark>STALE</mark>" : ""}</p>`
    : `<p>No conformance evidence has been recorded.</p>`;
  const audit = status.auditing
    ? `<p role="status" aria-live="polite"><em>Audit running. Reload to read the atomic result.</em></p>`
    : status.conformanceAvailable
      ? `<button id="conformance-audit-btn" type="button" aria-describedby="conformance-boundary">Audit now</button><p id="audit-progress" role="status" aria-live="polite"></p>`
      : `<p><em>Showing cached evidence; the conformance program is unavailable.</em></p>`;
  const auditError = status.auditError
    ? `<p role="alert"><mark>Audit error:</mark> ${escapeHtml(status.auditError)}</p>`
    : "";
  const planes = ["source", "installed", "native", "continuity", "capability"];
  const contextAge = status.contextGeneratedAt
    ? `${escapeHtml(status.contextGeneratedAt)} (${duration(status.contextAgeSeconds)})`
    : "unavailable";
  return `<h1>Agent Conformance</h1>
${summary}
${audit}
${auditError}
<p>Context-doctor cache: ${contextAge}</p>
${planes.map((plane) => renderChecks(plane, (report?.checks ?? []).filter((check) => check.plane === plane))).join("\n")}
<section id="conformance-boundary" aria-label="What this audit means">
<h2>What this audit means</h2>
<p>Source means the checked software files. Installed means files and settings on this machine.
Native means observed behavior in an agent session. Continuity means the project can be recovered.
Capability means an operation was measured or is explicitly unsupported.</p>
<p>PASS means the required checks passed within the named audit. UNKNOWN means we could not verify a result.
FAIL means a required check found a problem. UNSUPPORTED means this operation has no supported implementation.</p>
<p>Source, installed, native, continuity, and capability planes remain separate; stale evidence never becomes a current PASS.
Installing files does not prove that an open agent has loaded them. This audit does not approve a hook, grant permission, or activate a service.</p></section>
<script>
(function () {
  var btn = document.getElementById("conformance-audit-btn");
  if (!btn) return;
  btn.addEventListener("click", function () {
    if(btn.getAttribute("aria-disabled") === "true") return;
    btn.setAttribute("aria-disabled", "true");
    var progress = document.getElementById("audit-progress");
    progress.textContent = "Audit started. This may take several minutes.";
    fetch("/api/conformance/audit", { method: "POST" })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        progress.textContent = body.ok ? "Audit running. Reload for results." : "Audit could not start. Your settings were not changed.";
        if (!body.ok) btn.removeAttribute("aria-disabled");
      })
      .catch(function () {
        btn.removeAttribute("aria-disabled");
        progress.textContent = "Audit request failed. You can try again.";
      });
  });
})();
</script>`;
}
