import { escapeHtml } from "../utils.js";
import type {
  ContextFinding,
  ContextIntegrityStatus,
  SourceAudit,
} from "../context-integrity.js";
import { icon } from "./icons.js";
import { badge, callout, emptyState, pageHeader } from "./ui.js";

const LEAD = "The context doctor checks that every project's records (CONTEXT.md, REFERENCE.md, the session log and its entry in projects/index.yaml) are small, current and committed, so another session or machine can resume the work cold.";

/**
 * /context: the v5 context doctor's findings for each active source. Like
 * /sync, this is a private surface the principal opens deliberately, so source
 * and project names are appropriate here.
 */
export function contextIntegrityView(status: ContextIntegrityStatus): string {
  if (!status.doctorAvailable) {
    const searched = status.searched.map((dir) => `<li><code>${escapeHtml(dir)}</code></li>`).join("\n");
    return `${pageHeader({ title: "Context integrity", lead: LEAD })}
${callout(
  "warn",
  `The context doctor (<code>synthesis-context-lifecycle</code>) was not found in the synthesis v5 runtime or any harness plugin cache. Install the synthesis-skills plugin. Searched:<ul>${searched}</ul>`,
  { title: "Context doctor not installed", role: "alert" }
)}`;
  }

  const { totals } = status;
  const audited = status.audits.filter((audit) => audit.report);
  const controls = status.audits.length
    ? `<div class="sync-controls">
<button id="ctx-run-btn" type="button">${icon("refresh")}Run again</button>
<span id="ctx-progress" role="status" aria-live="polite"></span>
</div>`
    : "";

  const healthy = !totals.defects && !totals.failedSources;
  const verdict = status.audits.length
    ? `<section class="card verdict ${healthy ? "verdict-ok" : totals.defects ? "verdict-warn" : "verdict-warn"}" aria-label="Verdict">
  <div class="verdict-main">
    <span class="verdict-icon">${icon(healthy ? "checkCircle" : "alert")}</span>
    <div>
      <p class="verdict-title">${healthy ? "Healthy" : totals.defects ? `${totals.defects} defect(s)` : "Not every source was audited"}</p>
      <p class="verdict-sub"><strong>${totals.defects} defect(s)</strong> · ${totals.warnings} warning(s) · ${totals.projects} project(s) audited across ${audited.length} source(s)${
        totals.failedSources ? ` · <mark>${totals.failedSources} source(s) could not be audited</mark>` : ""
      }</p>
    </div>
  </div>
  <div class="verdict-tally">${badge(`${totals.defects} defects`, totals.defects ? "warn" : "ok")}${badge(`${totals.warnings} warnings`, totals.warnings ? "info" : "neutral")}</div>
</section>`
    : emptyState({ icon: "fileCheck", title: "Nothing to audit", body: "No active source has projects to audit. Select a source with projects in the source picker." });

  const skipped = status.skipped.length
    ? `<p class="section-note">Not audited: ${status.skipped
        .map((row) => `${escapeHtml(row.displayName)} (${escapeHtml(row.reason)})`)
        .join(", ")}.</p>`
    : "";

  return `${pageHeader({ title: "Context integrity", lead: LEAD, actionsHtml: controls })}
${verdict}
${skipped}
${status.audits.map(renderSource).join("\n")}
<p class="footnote">Results come from <code>${escapeHtml(status.script ?? "")}</code>, run on demand with
<code>--root</code> for each active source and kept for a minute. Change the source selection to
audit other sources.</p>
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
  const where = audit.knowledgeRoot
    ? `<span class="muted"><code>${escapeHtml(audit.knowledgeRoot)}</code>${
        audit.checkedAt ? ` · checked ${escapeHtml(audit.checkedAt)}` : ""
      }${audit.elapsedMs !== null ? ` in ${audit.elapsedMs} ms` : ""}</span>`
    : "";
  const error = audit.error ? callout("bad", `<mark>Problem:</mark> ${escapeHtml(audit.error)}`, { role: "alert" }) : "";
  const report = audit.report;
  const head = `<div class="source-audit-head"><h2>${escapeHtml(audit.displayName)}</h2>${
    report ? badge(report.ok ? "Healthy" : `${report.defects} defect(s)`, report.ok ? "ok" : report.defects ? "warn" : "info") : ""
  }${where}</div>`;
  if (!report) return `<section class="source-audit section" aria-label="${escapeHtml(audit.displayName)}">${head}${error}</section>`;
  const verdict = `<p class="section-note"><strong>${report.defects} defect(s)</strong> · ${report.warnings} warning(s) · ${report.projects_audited} project(s) audited${report.ok ? " — healthy" : ""}</p>`;
  const coverage = Object.entries(report.coverage)
    .filter(([, row]) => row.skipped > 0)
    .map(
      ([check, row]) =>
        `${escapeHtml(check)}: examined ${row.examined}, skipped ${row.skipped} (${row.why.map(escapeHtml).join(", ")})`
    );
  const coverageLine = coverage.length ? `<p class="section-note">Coverage — ${coverage.join(" · ")}</p>` : "";
  const bySeverity = (severity: string) => report.findings.filter((finding) => finding.severity === severity);
  const defects = bySeverity("defect");
  const warnings = bySeverity("warning");
  return `<section class="source-audit section" aria-label="${escapeHtml(audit.displayName)}">
${head}
${error}
${verdict}
${coverageLine}
${renderFindings(audit.displayName, "Defects", defects)}
${renderFindings(audit.displayName, "Warnings", warnings)}
${!defects.length && !warnings.length ? `<div class="empty-inline card">${icon("checkCircle", "icon-sm")} No findings in this source.</div>` : ""}
</section>`;
}

function renderFindings(source: string, title: string, findings: ContextFinding[]): string {
  if (findings.length === 0) return "";
  const rows = findings
    .map(
      (f) => `<tr>
<td class="cell-strong">${escapeHtml(f.project)}</td>
<td><code>${escapeHtml(f.check)}</code></td>
<td>${escapeHtml(f.message)}<span class="cell-sub">→ ${escapeHtml(f.remedy)}</span></td>
</tr>`
    )
    .join("\n");
  return `<h3 class="findings-title"><span class="dot dot-${title === "Defects" ? "warn" : "info"}" aria-hidden="true"></span>${escapeHtml(title)} (${findings.length})</h3>
<div class="table-wrap" tabindex="0" role="region" aria-label="${escapeHtml(`${source} ${title.toLowerCase()}`)}"><table>
<thead><tr><th scope="col">Project</th><th scope="col">Check</th><th scope="col">Finding</th></tr></thead>
<tbody>${rows}</tbody>
</table></div>`;
}
