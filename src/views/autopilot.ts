import type { Source } from "../config.js";
import { displayName, findSource } from "../config.js";
import { renderMarkdown } from "../parsers/markdown.js";
import { runGroup, type AutopilotOverview, type AutopilotRun, type PlanItem } from "../autopilot.js";
import { escapeAttr as a, escapeHtml as h } from "../utils.js";
import { icon } from "./icons.js";
import { badge, callout, emptyState, pageHeader, progressBar, statTile, type Tone } from "./ui.js";

const STATUS_TONE: Record<string, Tone> = {
  running: "info",
  waiting: "warn",
  blocked: "bad",
  paused: "neutral",
  done: "ok",
  incomplete: "warn",
  cancelled: "neutral",
};

const FIELD_LABELS: Record<string, string> = {
  harness: "Harness",
  engaged: "Engaged",
  horizon: "Horizon",
  continuation: "Continuation",
  "first wake": "First wake",
  backstop: "Backstop",
  "waiting on": "Waiting on",
  "silent after": "Silent after (minutes)",
};

function age(iso: string | null, now: number): string {
  if (!iso) return "unknown";
  const seconds = Math.max(0, Math.floor((now - Date.parse(iso)) / 1000));
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} days ago`;
}

function statusBadge(run: AutopilotRun): string {
  return badge(run.status || "no status", STATUS_TONE[run.status] ?? "neutral");
}

function where(run: AutopilotRun, sources: Source[]): string {
  if (!run.attribution) return "";
  const source = findSource(sources, run.attribution.source);
  const label = source ? displayName(source) : run.attribution.source;
  return `<span class="source-badge">${h(label)}</span>
<a href="/projects/${encodeURIComponent(run.attribution.source)}/${encodeURIComponent(run.attribution.project)}">${h(run.attribution.project)}</a>`;
}

function progress(run: AutopilotRun): string {
  const open = run.checklist.filter((item) => !item.done).length;
  return `${open} of ${run.checklist.length} checklist item(s) open`;
}

function detailHref(run: AutopilotRun): string {
  return `/autopilot/run/${encodeURIComponent(run.session)}`;
}

function runCard(run: AutopilotRun, sources: Source[], now: number): string {
  if (run.error) {
    return `<article class="card ap-run ap-unhealthy">
<div class="ap-run-head"><h3 class="ap-run-title">Session <code>${h(run.session)}</code></h3>${badge("Unreadable", "bad")}</div>
<p role="status">${h(run.error)}</p>
${run.planPath ? `<p class="section-note"><code>${h(run.planPath)}</code></p>` : ""}
</article>`;
  }
  const done = run.checklist.filter((item) => item.done).length;
  const facts = [
    run.status === "waiting" && run.fields["waiting on"] ? `<li><strong>Waiting on:</strong> ${h(run.fields["waiting on"])}</li>` : "",
    run.nextItem ? `<li><strong>Next:</strong> ${h(run.nextItem)}</li>` : "",
    `<li>${progress(run)} · plan edited ${h(age(run.planModifiedAt, now))}</li>`,
    run.owner ? `<li>Owner session: <code>${h(run.owner)}</code>${run.fields.harness ? ` (${h(run.fields.harness)})` : ""}</li>` : "",
    run.longHorizon && run.fields.continuation ? `<li>Continuation: ${h(run.fields.continuation)}</li>` : "",
  ].filter(Boolean);
  const blockers = run.openBlockers.length
    ? `<div class="ap-blockers"><p>Blockers</p><ul>${run.openBlockers.map((text) => `<li>${h(text)}</li>`).join("")}</ul></div>`
    : "";
  const questions = run.questions.length
    ? `<section class="ap-question"><p>Questions for you</p><ul>${run.questions.map((text) => `<li>${h(text)}</li>`).join("")}</ul></section>`
    : "";
  return `<article class="card ap-run ap-${a(run.status || "none")}">
<div class="ap-run-head">
  <h3 class="ap-run-title"><a href="${a(detailHref(run))}">${h(run.title ?? run.session)}</a></h3>
  ${statusBadge(run)}${run.statusReason ? `<span class="muted">${h(run.statusReason)}</span>` : ""}
</div>
${where(run, sources) ? `<div class="ap-run-where">${where(run, sources)}</div>` : ""}
${run.checklist.length ? progressBar((done / run.checklist.length) * 100, done === run.checklist.length ? "ok" : undefined) : ""}
<ul class="ap-facts-list">${facts.join("")}</ul>
${blockers}
${questions}
</article>`;
}

function section(title: string, runs: AutopilotRun[], sources: Source[], now: number): string {
  if (!runs.length) return "";
  return `<section class="section" aria-label="${a(title)}"><div class="section-header"><h2 class="section-title">${h(title)} (${runs.length})</h2></div>
${runs.map((run) => runCard(run, sources, now)).join("\n")}</section>`;
}

const LEAD = "Delegated runs on this machine, read from their plan files. This page only reads; an agent changes a run through the synthesis-autopilot skill.";

/** /autopilot: every v5 run the request may see, open runs first. */
export function autopilotLanding(
  overview: AutopilotOverview | null,
  sources: Source[],
  now = Date.now()
): string {
  if (!overview) {
    return `${pageHeader({ title: "Autopilot", lead: LEAD })}
${emptyState({ icon: "compass", title: "No runs in demo mode", body: "Demo mode reads no machine state, so no runs are shown." })}`;
  }
  const hidden = overview.hiddenRuns
    ? `<p class="section-note">${overview.hiddenRuns} run(s) belong to sources that are not selected.</p>`
    : "";
  if (!overview.runs.length) {
    return `${pageHeader({ title: "Autopilot", lead: LEAD })}
<section aria-label="No runs">
${emptyState({
  icon: "compass",
  title: "No runs",
  bodyHtml: `No autopilot run ${overview.hiddenRuns ? "in the selected sources" : "is recorded on this machine"}. A run appears here when an agent engages a plan file with the synthesis-autopilot skill (<code>autopilot_cli.py engage --plan &lt;plan&gt;</code>).<br><br>Records: <code>${h(overview.stateDir)}</code>${overview.stateExists ? "" : " (not created yet; v5 creates it on the first engage)"}`,
})}
</section>
${hidden}`;
  }
  const groups = { open: [] as AutopilotRun[], closed: [] as AutopilotRun[], other: [] as AutopilotRun[], unreadable: [] as AutopilotRun[] };
  for (const run of overview.runs) groups[runGroup(run)].push(run);
  const questions = groups.open.reduce((count, run) => count + run.questions.length, 0);
  const blocked = groups.open.filter((run) => run.status === "blocked").length;
  const summary = `<span>${groups.open.length} open · ${groups.closed.length} closed${
    questions ? ` · <strong>${questions} question(s) for you</strong>` : ""
  }${blocked ? ` · ${blocked} blocked` : ""}</span>`;
  return `${pageHeader({ title: "Autopilot", lead: LEAD, metaHtml: summary })}
<div class="stats">
  ${statTile({ label: "Open runs", value: groups.open.length, iconName: "compass", tone: groups.open.length ? "info" : undefined })}
  ${statTile({ label: "Questions for you", value: questions, iconName: "inbox", tone: questions ? "warn" : undefined })}
  ${statTile({ label: "Blocked", value: blocked, iconName: "alert", tone: blocked ? "bad" : undefined })}
  ${statTile({ label: "Closed", value: groups.closed.length, iconName: "checkCircle" })}
</div>
${hidden}
${section("Open", groups.open, sources, now)}
${section("Without a status", groups.other, sources, now)}
${section("Closed", groups.closed, sources, now)}
${section("Unreadable records", groups.unreadable, sources, now)}
<p class="footnote">Records: <code>${h(overview.stateDir)}</code>.</p>`;
}

function itemList(title: string, items: PlanItem[]): string {
  if (!items.length) return "";
  const done = items.filter((item) => item.done).length;
  return `<section class="card rail-card" aria-label="${a(title)}">
<h3 class="rail-title">${h(title)} <span class="muted">(${done} of ${items.length} done)</span></h3>
${progressBar((done / items.length) * 100, done === items.length ? "ok" : undefined)}
<ul class="ap-items" style="margin-top:8px">${items
    .map((item) => `<li><label><input type="checkbox" disabled${item.done ? " checked" : ""}> <span>${h(item.text)}</span></label></li>`)
    .join("")}</ul>
</section>`;
}

/** /autopilot/run/:session: one run's header lines, checklists and the plan itself. */
export function autopilotDetail(run: AutopilotRun, sources: Source[], now = Date.now()): string {
  const back = `<a class="btn" href="/autopilot">${icon("arrowLeft")}All runs</a>`;
  if (run.error) {
    return `${pageHeader({ title: `Session ${run.session}`, actionsHtml: back })}
${callout("bad", h(run.error), { role: "alert" })}
${run.planPath ? `<p class="section-note"><code>${h(run.planPath)}</code></p>` : ""}`;
  }
  const facts: [string, string][] = [
    ["Status", `${statusBadge(run)}${run.statusReason ? ` ${h(run.statusReason)}` : ""}`],
    ["Project", where(run, sources) || "not in a configured source"],
    ["Owner session", run.owner ? `<code>${h(run.owner)}</code>` : "none recorded"],
    ...Object.entries(run.fields).map(([name, value]): [string, string] => [FIELD_LABELS[name] ?? name, h(value)]),
    ["Plan file", `<code>${h(run.planPath ?? "")}</code> · edited ${h(age(run.planModifiedAt, now))}`],
    ["Run record", `session <code>${h(run.session)}</code>${run.pointerAt ? ` · written ${h(age(run.pointerAt, now))}` : ""}${
      run.streak ? ` · ${run.streak} continuation request(s) in a row` : ""
    }`],
  ];
  if (!run.ownedByPointer) {
    facts.push(["Note", "This record was written by a session that no longer owns the plan."]);
  }
  if (run.otherSessions.length) {
    facts.push(["Earlier sessions", run.otherSessions.map((session) => `<code>${h(session)}</code>`).join(", ")]);
  }
  const questions = run.questions.length
    ? `<section class="ap-question"><h2>Questions for you (${run.questions.length})</h2><ul>${run.questions.map((text) => `<li>${h(text)}</li>`).join("")}</ul></section>`
    : "";
  const blockers = run.openBlockers.length
    ? `<div class="ap-blockers"><p>Open blockers (${run.openBlockers.length})</p><ul>${run.openBlockers.map((text) => `<li>${h(text)}</li>`).join("")}</ul></div>`
    : "";
  const ledger = run.cycleLedger.length
    ? `<section class="card rail-card" aria-label="Cycle ledger"><h3 class="rail-title">Cycle ledger (last ${Math.min(10, run.cycleLedger.length)} of ${run.cycleLedger.length})</h3><ol class="timeline">${run.cycleLedger
        .slice(-10)
        .map((line) => `<li class="timeline-item"><span>${h(line.replace(/^[-*+]\s+/, ""))}</span></li>`)
        .join("")}</ol></section>`
    : "";
  return `${pageHeader({
    title: run.title ?? run.session,
    eyebrowHtml: `<span>${icon("compass", "icon-sm")} Autopilot run</span>`,
    metaHtml: `${statusBadge(run)}${run.statusReason ? `<span>${h(run.statusReason)}</span>` : ""}${run.nextItem ? `<span><strong>Next:</strong>&nbsp;${h(run.nextItem)}</span>` : ""}`,
    actionsHtml: back,
  })}
<div class="detail-layout">
  <div class="stack">
    ${questions}
    ${blockers}
    ${itemList("Checklist", run.checklist)}
    ${itemList("Completion criteria", run.criteria)}
    ${itemList("Standing checklist", run.standing)}
    ${ledger}
    <details class="card doc-card"><summary>The plan file</summary>
      <div class="rendered-markdown">${renderMarkdown(run.text ?? "")}</div>
    </details>
  </div>
  <aside class="rail rail-sticky" aria-label="Run details">
    <section class="card rail-card"><h2 class="rail-title">Run</h2>
      <dl class="meta-list">${facts.map(([term, value]) => `<div class="meta-row"><dt>${h(term)}</dt><dd>${value}</dd></div>`).join("")}</dl>
    </section>
  </aside>
</div>`;
}
