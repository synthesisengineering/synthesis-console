import { escapeHtml } from "../utils.js";
import type {
  ContextFinding,
  ContextIntegrityStatus,
} from "../context-integrity.js";

/**
 * /context — corpus health of the durable project layer, rendered from the
 * context doctor's report cache. Like /sync, this is a PRIVATE surface:
 * source and project names are appropriate here.
 */
export function contextIntegrityView(status: ContextIntegrityStatus): string {
  if (!status.doctorAvailable && !status.report) {
    return `<h1>Context Integrity</h1>
<p>The context doctor (<code>synthesis-context-lifecycle</code>) was not found
in any plugin cache or skills directory, and no report cache exists at
<code>~/.synthesis/context-doctor/last-report.json</code>. Install the
synthesis-skills plugin, or point <code>SYNTHESIS_CONTEXT_LIFECYCLE_DIR</code>
at a checkout.</p>`;
  }

  const rep = status.report;
  const header = rep
    ? `<p>Last full audit: ${escapeHtml(rep.generated_at ?? "unknown")} ·
${rep.projects_audited ?? "?"} projects across ${rep.sources ?? "?"} sources ·
doctor v${escapeHtml(rep.doctor_version ?? "?")}</p>`
    : `<p>No corpus report yet — the day-start ritual writes one daily, or run an audit now.</p>`;

  const counts = rep
    ? `<p><strong>${rep.defects ?? 0} defect(s)</strong> · ${rep.warnings ?? 0} warning(s)
${rep.ok ? " — <mark>HEALTHY</mark>" : ""}</p>`
    : "";

  const audit = status.auditing
    ? `<p><em>Audit running — a full corpus pass takes a few minutes; reload to pick up the fresh report.</em></p>`
    : status.doctorAvailable
      ? `<button id="ctx-audit-btn">Audit now (full corpus)</button>`
      : `<p><em>Doctor script unavailable; showing the cached report only.</em></p>`;

  const findings = rep?.findings ?? [];
  const bySeverity = (sev: string) => findings.filter((f) => f.severity === sev);

  return `<h1>Context Integrity</h1>
${header}
${counts}
${audit}
${renderFindings("Defects", bySeverity("defect"))}
${renderFindings("Warnings", bySeverity("warning"))}
<p><small>The durable context layer (CONTEXT.md / REFERENCE.md / sessions/) is
what lets another agent, machine, or teammate resume every project. Day-start
runs the full audit (report-only); day-end fail-closes on the projects the
session touched. This page renders the same report cache.</small></p>
<script>
(function () {
  var btn = document.getElementById("ctx-audit-btn");
  if (!btn) return;
  btn.addEventListener("click", function () {
    btn.disabled = true;
    btn.textContent = "Audit started…";
    fetch("/api/context/audit", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function () {
        btn.textContent = "Audit running — reload in a few minutes";
      })
      .catch(function () {
        btn.disabled = false;
        btn.textContent = "Audit now (full corpus)";
      });
  });
})();
</script>`;
}

function renderFindings(title: string, findings: ContextFinding[]): string {
  if (findings.length === 0) return "";
  const rows = findings
    .map(
      (f) => `<tr>
<td><code>${escapeHtml(f.source)}</code></td>
<td>${escapeHtml(f.project)}</td>
<td><code>${escapeHtml(f.check)}</code></td>
<td>${escapeHtml(f.message)}<br><small>→ ${escapeHtml(f.remedy)}</small></td>
</tr>`
    )
    .join("\n");
  return `<h2>${escapeHtml(title)} (${findings.length})</h2>
<div style="overflow-x:auto"><table>
<thead><tr><th>Source</th><th>Project</th><th>Check</th><th>Finding</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}
