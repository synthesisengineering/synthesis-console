import { escapeHtml } from "../utils.js";
import type {
  ContextFinding,
  ContextIntegrityStatus,
  SourceAudit,
} from "../context-integrity.js";

/**
 * /context: the v5 context doctor's findings for each active source. Like
 * /sync, this is a private surface the principal opens deliberately, so source
 * and project names are appropriate here.
 */
export function contextIntegrityView(status: ContextIntegrityStatus): string {
  const head = `<h1>Context Integrity</h1>
<p>The context doctor checks that every project's records (CONTEXT.md, REFERENCE.md, the
session log and its entry in <code>projects/index.yaml</code>) are small, current and
committed, so another session or machine can resume the work cold.</p>`;

  if (!status.doctorAvailable) {
    const searched = status.searched.map((dir) => `<li><code>${escapeHtml(dir)}</code></li>`).join("\n");
    return `${head}
<p role="alert">The context doctor (<code>synthesis-context-lifecycle</code>) was not found in the
synthesis v5 runtime or any harness plugin cache. Install the synthesis-skills plugin. Searched:</p>
<ul>
${searched}
</ul>`;
  }

  const { totals } = status;
  const audited = status.audits.filter((audit) => audit.report);
  const summary = status.audits.length
    ? `<p><strong>${totals.defects} defect(s)</strong> · ${totals.warnings} warning(s) ·
${totals.projects} project(s) audited across ${audited.length} source(s)${
        totals.failedSources ? ` · <mark>${totals.failedSources} source(s) could not be audited</mark>` : ""
      }${!totals.defects && !totals.failedSources ? " — <mark>HEALTHY</mark>" : ""}</p>`
    : `<p>No active source has projects to audit. Select a source with projects in the source picker.</p>`;
  const skipped = status.skipped.length
    ? `<p><small>Not audited: ${status.skipped
        .map((row) => `${escapeHtml(row.displayName)} (${escapeHtml(row.reason)})`)
        .join(", ")}.</small></p>`
    : "";
  const controls = status.audits.length
    ? `<div class="sync-controls">
<button id="ctx-run-btn" type="button">Run again</button>
<span id="ctx-progress" role="status" aria-live="polite"></span>
</div>`
    : "";

  return `${head}
${summary}
${skipped}
${controls}
${status.audits.map(renderSource).join("\n")}
<p><small>Results come from <code>${escapeHtml(status.script ?? "")}</code>, run on demand with
<code>--root</code> for each active source and kept for a minute. Change the source selection to
audit other sources.</small></p>
<script>
(function () {
  var btn = document.getElementById("ctx-run-btn");
  if (!btn) return;
  btn.addEventListener("click", function () {
    if (btn.getAttribute("aria-disabled") === "true") return;
    btn.setAttribute("aria-disabled", "true");
    var progress = document.getElementById("ctx-progress");
    progress.textContent = "Running the context doctor.";
    fetch("/api/context/refresh", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function () { location.reload(); })
      .catch(function () {
        btn.removeAttribute("aria-disabled");
        progress.textContent = "The request failed. You can try again.";
      });
  });
})();
</script>`;
}

function renderSource(audit: SourceAudit): string {
  const title = `<h2>${escapeHtml(audit.displayName)}</h2>`;
  const where = audit.knowledgeRoot
    ? `<p><small><code>${escapeHtml(audit.knowledgeRoot)}</code>${
        audit.checkedAt ? ` · checked ${escapeHtml(audit.checkedAt)}` : ""
      }${audit.elapsedMs !== null ? ` in ${audit.elapsedMs} ms` : ""}</small></p>`
    : "";
  const error = audit.error ? `<p role="alert"><mark>Problem:</mark> ${escapeHtml(audit.error)}</p>` : "";
  const report = audit.report;
  if (!report) return `<section aria-label="${escapeHtml(audit.displayName)}">${title}${where}${error}</section>`;
  const verdict = `<p><strong>${report.defects} defect(s)</strong> · ${report.warnings} warning(s) ·
${report.projects_audited} project(s) audited${report.ok ? " — healthy" : ""}</p>`;
  const coverage = Object.entries(report.coverage)
    .filter(([, row]) => row.skipped > 0)
    .map(
      ([check, row]) =>
        `${escapeHtml(check)}: examined ${row.examined}, skipped ${row.skipped} (${row.why.map(escapeHtml).join(", ")})`
    );
  const coverageLine = coverage.length ? `<p><small>Coverage — ${coverage.join(" · ")}</small></p>` : "";
  const bySeverity = (severity: string) => report.findings.filter((finding) => finding.severity === severity);
  return `<section aria-label="${escapeHtml(audit.displayName)}">
${title}
${where}
${error}
${verdict}
${coverageLine}
${renderFindings(audit.displayName, "Defects", bySeverity("defect"))}
${renderFindings(audit.displayName, "Warnings", bySeverity("warning"))}
</section>`;
}

function renderFindings(source: string, title: string, findings: ContextFinding[]): string {
  if (findings.length === 0) return "";
  const rows = findings
    .map(
      (f) => `<tr>
<td>${escapeHtml(f.project)}</td>
<td><code>${escapeHtml(f.check)}</code></td>
<td>${escapeHtml(f.message)}<br><small>→ ${escapeHtml(f.remedy)}</small></td>
</tr>`
    )
    .join("\n");
  return `<h3>${escapeHtml(title)} (${findings.length})</h3>
<div style="overflow-x:auto" tabindex="0" role="region" aria-label="${escapeHtml(`${source} ${title.toLowerCase()}`)}"><table>
<thead><tr><th scope="col">Project</th><th scope="col">Check</th><th scope="col">Finding</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}
