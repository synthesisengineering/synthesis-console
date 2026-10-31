import { escapeHtml } from "../utils.js";
import { sortChecks, summarizeChecks, type DoctorStatus } from "../doctor.js";
import { icon } from "./icons.js";
import { badge, callout, pageHeader, type Tone } from "./ui.js";

const LABELS: Record<string, string> = {
  fail: "Fail",
  warn: "Warn",
  info: "Info",
  ok: "OK",
};

const TONES: Record<string, Tone> = {
  fail: "bad",
  warn: "warn",
  info: "info",
  ok: "ok",
};

function age(seconds: number | null): string {
  if (seconds === null) return "";
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  return `${Math.floor(seconds / 3600)}h ago`;
}

function statusLabel(status: string): string {
  return LABELS[status] ?? status;
}

function rerun(): string {
  return `<div class="sync-controls">
<button id="doctor-run-btn" type="button" aria-describedby="doctor-meaning">${icon("refresh")}Run again</button>
<span id="doctor-progress" role="status" aria-live="polite"></span>
</div>`;
}

const MEANING = `<section id="doctor-meaning" class="card meaning" aria-label="What the results mean">
<h2>What the results mean</h2>
<p><strong>Fail</strong> means a part of synthesis is missing, stale or not wired, and the doctor
reports the install as not healthy. <strong>Warn</strong> means it works but something needs a look,
such as a hook over its time budget. <strong>Info</strong> is reported for reference and never affects
health. <strong>OK</strong> means the check passed.</p>
<p>The doctor reads each harness's own listing commands and config files and never changes them.
This page runs it on demand and keeps the result for a minute; <em>Run again</em> starts a new run.
A result here does not approve a hook, grant a permission or change any setting.</p>
</section>`;

const SCRIPT = `<script>
(function () {
  var btn = document.getElementById("doctor-run-btn");
  if (!btn) return;
  btn.addEventListener("click", function () {
    if (btn.getAttribute("aria-disabled") === "true") return;
    btn.setAttribute("aria-disabled", "true");
    var progress = document.getElementById("doctor-progress");
    progress.textContent = "Running synthesis doctor.";
    fetch("/api/conformance/refresh", { method: "POST" })
      .then(function (response) { return response.json(); })
      .then(function (body) {
        if (body && body.ok) { location.reload(); return; }
        btn.removeAttribute("aria-disabled");
        progress.textContent = "The doctor could not run. Nothing was changed.";
      })
      .catch(function () {
        btn.removeAttribute("aria-disabled");
        progress.textContent = "The request failed. You can try again.";
      });
  });
})();
</script>`;

const LEAD = "Results of synthesis doctor: is every part of synthesis installed, current and wired into each harness on this machine?";

/** /conformance: the result of `synthesis doctor --json`. */
export function conformanceView(status: DoctorStatus): string {
  if (!status.installed) {
    return `${pageHeader({ title: "Conformance", lead: LEAD })}
${callout(
  "warn",
  `synthesis v5 is not installed for this account: there is no <code>synthesis</code> command at <code>${escapeHtml(status.launcher)}</code>. Install the synthesis-skills plugin in a harness and start a session there, which installs the runtime. Set <code>SYNTHESIS_HOME</code> if the runtime lives elsewhere.`,
  { title: "Not installed", role: "alert" }
)}
${MEANING}`;
  }

  const when = status.checkedAt
    ? `Checked ${escapeHtml(status.checkedAt)} (${age(status.ageSeconds)})${
        status.report ? ` · the doctor took ${Math.round(status.report.ms)} ms` : ""
      }${status.elapsedMs !== null ? ` · ${status.elapsedMs} ms including start-up` : ""}`
    : "";
  const error = status.error
    ? callout("bad", `<mark>Problem:</mark> ${escapeHtml(status.error)}`, { role: "alert" })
    : "";

  const header = pageHeader({ title: "Conformance", lead: LEAD, actionsHtml: rerun() });

  if (!status.report) {
    return `${header}
${when ? `<p class="section-note">${when}</p>` : ""}
${error}
${MEANING}
${SCRIPT}`;
  }

  const counts = summarizeChecks(status.report.checks);
  const tally = Object.entries(counts)
    .filter(([, count]) => count > 0)
    .map(([name, count]) => badge(`${count} ${statusLabel(name)}`, TONES[name] ?? "neutral"))
    .join("");
  const healthy = status.report.healthy;
  const verdict = `<section class="card verdict ${healthy ? "verdict-ok" : "verdict-bad"}" aria-label="Verdict">
  <div class="verdict-main">
    <span class="verdict-icon">${icon(healthy ? "checkCircle" : "alertCircle")}</span>
    <div>
      <p class="verdict-title">${healthy ? `<strong class="doctor-healthy">Healthy</strong>` : `<strong class="doctor-unhealthy">Not healthy</strong>`}</p>
      ${when ? `<p class="verdict-sub">${when}</p>` : ""}
    </div>
  </div>
  <div class="verdict-tally">${tally}</div>
</section>`;

  const rows = sortChecks(status.report.checks)
    .map(
      (check) => `<tr class="doctor-${escapeHtml(check.status)}">
<td class="result-cell">${badge(statusLabel(check.status), TONES[check.status] ?? "neutral")}</td>
<td class="cell-strong">${escapeHtml(check.name)}</td>
<td>${escapeHtml(check.detail)}</td>
</tr>`
    )
    .join("\n");

  return `${header}
${verdict}
${error}
<div class="table-wrap" tabindex="0" role="region" aria-label="Doctor checks">
<table>
<caption>${status.report.checks.length} checks from synthesis doctor</caption>
<thead><tr><th scope="col">Result</th><th scope="col">Check</th><th scope="col">Detail</th></tr></thead>
<tbody>${rows}</tbody>
</table>
</div>
${MEANING}
${SCRIPT}`;
}
