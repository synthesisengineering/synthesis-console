import type { Source } from "../config.js";
import { displayName, findSource } from "../config.js";
import { renderMarkdown } from "../parsers/markdown.js";
import { runGroup, type AutopilotOverview, type AutopilotRun, type PlanItem } from "../autopilot.js";
import { escapeAttr as a, escapeHtml as h } from "../utils.js";

const STATUS_BADGE: Record<string, string> = {
  running: "badge-blue",
  waiting: "badge-yellow",
  blocked: "badge-red",
  paused: "badge-gray",
  done: "badge-green",
  incomplete: "badge-purple",
  cancelled: "badge-gray",
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
  const status = run.status || "no status";
  return `<span class="badge ${STATUS_BADGE[run.status] ?? "badge-outline"}">${h(status)}</span>`;
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
    return `<article class="ap-run ap-unhealthy">
<header><strong>Session ${h(run.session)}</strong></header>
<p role="status">${h(run.error)}</p>
${run.planPath ? `<p><small><code>${h(run.planPath)}</code></small></p>` : ""}
</article>`;
  }
  const facts = [
    run.status === "waiting" && run.fields["waiting on"] ? `<li>Waiting on: ${h(run.fields["waiting on"])}</li>` : "",
    run.nextItem ? `<li>Next: ${h(run.nextItem)}</li>` : "",
    `<li>${progress(run)} · plan edited ${h(age(run.planModifiedAt, now))}</li>`,
    run.owner ? `<li>Owner session: <code>${h(run.owner)}</code>${run.fields.harness ? ` (${h(run.fields.harness)})` : ""}</li>` : "",
    run.longHorizon && run.fields.continuation ? `<li>Continuation: ${h(run.fields.continuation)}</li>` : "",
  ].filter(Boolean);
  const blockers = run.openBlockers.length
    ? `<p><strong>Blockers</strong></p><ul>${run.openBlockers.map((text) => `<li>${h(text)}</li>`).join("")}</ul>`
    : "";
  const questions = run.questions.length
    ? `<section class="ap-question"><p><strong>Questions for you</strong></p><ul>${run.questions.map((text) => `<li>${h(text)}</li>`).join("")}</ul></section>`
    : "";
  return `<article class="ap-run ap-${a(run.status || "none")}">
<header><strong><a href="${a(detailHref(run))}">${h(run.title ?? run.session)}</a></strong>
<span>${statusBadge(run)}${run.statusReason ? ` ${h(run.statusReason)}` : ""}</span>
<small>${where(run, sources)}</small></header>
<ul>${facts.join("")}</ul>
${blockers}
${questions}
</article>`;
}

function section(title: string, runs: AutopilotRun[], sources: Source[], now: number): string {
  if (!runs.length) return "";
  return `<section aria-label="${a(title)}"><h2>${h(title)} (${runs.length})</h2>
${runs.map((run) => runCard(run, sources, now)).join("\n")}</section>`;
}

/** /autopilot: every v5 run the request may see, open runs first. */
export function autopilotLanding(
  overview: AutopilotOverview | null,
  sources: Source[],
  now = Date.now()
): string {
  const head = `<h1>Autopilot</h1>
<p class="ap-lead">Delegated runs on this machine, read from their plan files.</p>`;
  if (!overview) {
    return `${head}
<p>Demo mode reads no machine state, so no runs are shown.</p>`;
  }
  const hidden = overview.hiddenRuns
    ? `<p><small>${overview.hiddenRuns} run(s) belong to sources that are not selected.</small></p>`
    : "";
  if (!overview.runs.length) {
    return `${head}
<section aria-label="No runs"><h2>No runs</h2>
<p>No autopilot run ${overview.hiddenRuns ? "in the selected sources" : "is recorded on this machine"}.
A run appears here when an agent engages a plan file with the synthesis-autopilot skill
(<code>autopilot_cli.py engage --plan &lt;plan&gt;</code>).</p>
<p><small>Records: <code>${h(overview.stateDir)}</code>${overview.stateExists ? "" : " (not created yet; v5 creates it on the first engage)"}</small></p>
</section>
${hidden}`;
  }
  const groups = { open: [] as AutopilotRun[], closed: [] as AutopilotRun[], other: [] as AutopilotRun[], unreadable: [] as AutopilotRun[] };
  for (const run of overview.runs) groups[runGroup(run)].push(run);
  const questions = groups.open.reduce((count, run) => count + run.questions.length, 0);
  const blocked = groups.open.filter((run) => run.status === "blocked").length;
  const summary = `<p>${groups.open.length} open · ${groups.closed.length} closed${
    questions ? ` · <strong>${questions} question(s) for you</strong>` : ""
  }${blocked ? ` · ${blocked} blocked` : ""}</p>`;
  return `${head}
${summary}
${hidden}
${section("Open", groups.open, sources, now)}
${section("Without a status", groups.other, sources, now)}
${section("Closed", groups.closed, sources, now)}
${section("Unreadable records", groups.unreadable, sources, now)}
<p><small>Records: <code>${h(overview.stateDir)}</code>. This page only reads; an agent changes a run
through the synthesis-autopilot skill.</small></p>`;
}

function itemList(title: string, items: PlanItem[]): string {
  if (!items.length) return "";
  return `<h3>${h(title)} (${items.filter((item) => item.done).length} of ${items.length} done)</h3>
<ul class="ap-items">${items
    .map((item) => `<li><label><input type="checkbox" disabled${item.done ? " checked" : ""}> ${h(item.text)}</label></li>`)
    .join("")}</ul>`;
}

/** /autopilot/run/:session: one run's header lines, checklists and the plan itself. */
export function autopilotDetail(run: AutopilotRun, sources: Source[], now = Date.now()): string {
  const back = `<p><a href="/autopilot">← Autopilot</a></p>`;
  if (run.error) {
    return `${back}<h1>Session ${h(run.session)}</h1>
<p role="alert">${h(run.error)}</p>
${run.planPath ? `<p><code>${h(run.planPath)}</code></p>` : ""}`;
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
    ? `<h2>Open blockers (${run.openBlockers.length})</h2><ul>${run.openBlockers.map((text) => `<li>${h(text)}</li>`).join("")}</ul>`
    : "";
  const ledger = run.cycleLedger.length
    ? `<h3>Cycle ledger (last ${Math.min(10, run.cycleLedger.length)} of ${run.cycleLedger.length})</h3><ul>${run.cycleLedger
        .slice(-10)
        .map((line) => `<li>${h(line.replace(/^[-*+]\s+/, ""))}</li>`)
        .join("")}</ul>`
    : "";
  return `${back}
<h1>${h(run.title ?? run.session)}</h1>
<dl class="ap-facts">${facts.map(([term, value]) => `<dt>${h(term)}</dt><dd>${value}</dd>`).join("")}</dl>
${questions}
${blockers}
<h2>Progress</h2>
${run.nextItem ? `<p><strong>Next:</strong> ${h(run.nextItem)}</p>` : ""}
${itemList("Checklist", run.checklist)}
${itemList("Completion criteria", run.criteria)}
${itemList("Standing checklist", run.standing)}
${ledger}
<details><summary>The plan file</summary>
<div class="rendered-markdown">${renderMarkdown(run.text ?? "")}</div>
</details>`;
}
