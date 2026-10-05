import type { Source } from "../config.js";
import { displayName } from "../config.js";
import type { OperatorResult, OperatorRun, OperatorObservation } from "../autopilot.js";
import { escapeHtml as h, escapeAttr as a } from "../utils.js";

const json = (value: unknown) => h(JSON.stringify(value ?? null, null, 2));
export function firstTask(project = "the selected project") {
  return `<section class="ap-first"><h2>Delegate your first task</h2>
  <p>Describe the result you want. Your agent handles the plan, profile and acceptance checks.</p>
  <form class="ap-delegate" data-project="${a(project)}">
    <label for="ap-outcome">What should be finished?</label><textarea id="ap-outcome" name="outcome" required maxlength="4000" placeholder="Make the onboarding flow work, test it, and show me the result."></textarea>
    <label for="ap-constraints">Limits or decisions already made</label><textarea id="ap-constraints" name="constraints" maxlength="2000" placeholder="Optional: budget, deadline, access limits or required approval."></textarea>
    <button type="submit">Prepare delegation</button>
  </form><p>Open your preferred agent in the project, then copy the prepared request into that task. Nothing is submitted by this page.</p></section>`;
}
function preparedArea() {
  return `<section class="ap-prepared" hidden><h2>Prepared for your agent</h2><p class="ap-prepared-state" role="status" aria-live="polite">Prepared locally · not submitted · not performed</p>
  <textarea class="ap-request" readonly rows="9" aria-label="Prepared request"></textarea><button type="button" class="ap-copy">Copy request</button>
  <button type="button" class="ap-discard secondary">Discard prepared request</button>
  <p>Paste this into the native task that owns the run. The owner must check current identity, revision and authority. Refresh this page to see what was recorded.</p></section>`;
}
export function operatorGuidance() {
  const rows = [
    ["Doctor", "Doctor synthesis for this project. Check current installation, native identity, claims, run journal, capabilities and pending effects. Separate recorded state from live acceptance."],
    ["Repair", "Diagnose and repair the named synthesis failure through its existing owner. Preserve the journal, artifacts and uncertain effects; recheck before retrying. Do not recreate authority or reset the run."],
    ["Update / reload", "Check and update synthesis through skills manager within my existing authorization. Verify installed bytes separately from this session's loaded skills. If upgraded but not loaded, checkpoint and recover in a freshly loaded native task; do not claim reload without evidence."],
    ["Cold recovery", "Recover this project from its registry, controlling plan and run journal. Verify the current native owner or perform the existing handoff protocol. Reconcile effects and children before work. A capsule is a pointer, not authority or proof of survival."],
    ["Pause safely", "Pause admitting new work in this run through the existing owner. Checkpoint unfinished work and reconcile in-flight effects and children; report the actual waiting or cancellation state. Do not claim a separate pause command exists."],
  ];
  return `<section class="ap-guidance"><h2>Maintenance and recovery</h2><p>Choose a request to take to the existing owner. These controls do not install, repair, reload, approve or wake an agent.</p>
    <div class="ap-actions">${rows.map(([label, text]) => `<button type="button" class="secondary ap-guidance-request" data-request="${a(text)}">${h(label)}</button>`).join("")}</div>
    <p><strong>Upgraded but not loaded:</strong> the reader below is the code used by this Console request. A running native task may still have older skills loaded. Its loaded version and wake capability remain unknown until the native owner verifies them.</p></section>`;
}
export function operatorLanding(groups: {source: Source; projects: {id: string; name: string}[]; diagnostic: string | null}[]) {
  return `<h1>Autopilot</h1><p class="ap-lead">Your work, durable questions, and a path back to the owner.</p>
    <p>Only active sources appear here. A new read verifies the run journal. Reopening an observation shows that same read and its original timestamp; this page does not certify that an agent is currently running.</p>
    <section><h2>Projects</h2>${groups.map(group => `<article><span class="source-badge">${h(displayName(group.source))}</span>
      ${group.diagnostic ? `<p role="status">${h(group.diagnostic)}</p>` : `<ul>${group.projects.map(p => `<li><a href="/autopilot/${encodeURIComponent(group.source.name)}/${encodeURIComponent(p.id)}">${h(p.name)}</a></li>`).join("")}</ul>`}</article>`).join("")}</section>
    ${firstTask()}${preparedArea()}${operatorGuidance()}${operatorScript()}`;
}
function runCard(run: OperatorRun, path: string, questionsOnly: boolean) {
  const exact = run.currentness === "JOURNAL_VERIFIED_RECORDED_STATE";
  if (!exact) return `<article class="ap-run ap-unhealthy"><header><strong>Unhealthy · unverifiable</strong></header>
    <p>Journal could not be verified. Recorded contents, questions and progress are unknown.</p>
    ${run.diagnostics.map(value=>`<p role="status" class="ap-warning">${h(value)}</p>`).join("")}
    <p>Run ${h(run.run_id)} · no recorded revision or controls are available.</p></article>`;
  const terminal = ["completed", "cancelled", "incomplete"].includes(run.recorded_status);
  const tasks = run.tasks || [];
  const done = tasks.filter(x => x.status === "done").length;
  const active = tasks.filter(x => x.status === "running").map(x => x.id);
  const remaining = tasks.filter(x => !["done", "cancelled"].includes(x.status)).length;
  return `<article class="ap-run ap-${a(run.status)}" data-run="${a(JSON.stringify({run_id: run.run_id, project_id: run.project_id, revision: run.revision, journal_head: run.journal_head}))}">
    <header><strong>${h(run.status.charAt(0).toUpperCase() + run.status.slice(1))}${exact ? " · recorded" : " · unverifiable"}</strong>
    <small>${run.revision ? `Revision ${run.revision}` : "Journal could not be verified"}</small></header>
    ${run.scope?.length ? `<p>${run.scope.map(x => h(x)).join(" · ")}</p>` : ""}
    <p>${h(run.recorded_status)} · journal updated ${h(run.updated_at || "unknown")}</p>
    ${run.diagnostics.map(x => `<p role="status" class="ap-warning">${h(x)}</p>`).join("")}
    ${run.recorded_status === "cancelled" ? "<p>Cancellation is recorded. Unfinished questions, effects and children are retained; this does not certify their termination.</p>" : ""}
    ${tasks.length ? `<p>${done} task(s) recorded done · ${remaining} remaining${active.length ? ` · current: ${active.map(x => h(x)).join(", ")}` : ""}.</p>` : ""}
    ${run.questions.length ? `<h3>${terminal ? "Unfinished input retained" : "Waiting for input"}</h3>${run.questions.map(q => `<section class="ap-question"><p><strong>${h(q.kind === "user" ? "Your input" : "External dependency")}</strong> · ${h(q.id)}</p><p>${h(q.reason)}${q.reason_truncated ? " [Preview truncated; ask the owner for the full question.]" : ""}</p>
      ${exact && !terminal && q.kind === "user" ? `<form class="ap-answer" data-question="${a(q.id)}"><label>Your answer<textarea name="answer" required maxlength="4000"></textarea></label><button type="submit">Prepare answer for owner</button></form>` : ""}</section>`).join("")}` : `<p>No pending questions in this recorded revision.</p>`}
    ${!questionsOnly ? `<dl class="ap-facts"><dt>Native process / wake</dt><dd>Unknown · no fresh native actor supplied</dd><dt>Current outcome acceptance</dt><dd>Unknown · recorded completion needs current owner readback</dd><dt>Last useful progress</dt><dd>${run.last_useful_progress ? `<pre>${json(run.last_useful_progress)}</pre>` : "No measured progress recorded"}</dd><dt>Last note</dt><dd>${h(run.last_note?.summary || "None")} <small>(unmeasured)</small></dd></dl>
      <details><summary>Tasks, effects, children and resources</summary><pre>${json({tasks: run.tasks, effects: run.effects, children: run.children, resources: run.resources, billing: "UNKNOWN", resource_scope: "Owner ledger, not a provider invoice", checkpoint: run.checkpoint, continuation: run.continuation})}</pre></details>
      <details><summary>Supervision requests and leases</summary><p>Recorded requests, leases and backoff are not proven wakes. Automatic launch is unavailable from this Console.</p><pre>${json(run.supervision)}</pre></details>` : ""}
    ${exact && !terminal ? `<div class="ap-actions"><button type="button" class="ap-control" data-action="resume">Prepare resume / recovery</button><button type="button" class="ap-control secondary" data-action="cancel">Prepare cancellation</button></div>
    <p class="ap-controls-note">Prepared requests retain this revision. If the run changes, the owner refuses stale execution.</p>` : ""}
    <details><summary>Run identity and recorded head</summary><p>Run ${h(run.run_id)} · revision ${h(String(run.revision ?? "unknown"))}</p><p>${h(run.journal_head || "Unverified")}</p>${exact ? `<a href="${path}/runs/${encodeURIComponent(run.run_id)}">Open exact run</a>` : ""}</details>
    </article>`;
}
export interface ObservationLinks {newUrl:string;observeUrl:string;pollUrl:string}
export function operatorObservationPanel(source: Source, project: string, result: OperatorResult, questionsOnly=false, links?:ObservationLinks) {
  const path = `/autopilot/${encodeURIComponent(source.name)}/${encodeURIComponent(project)}`;
  const report=result.report;
  const observation=(result as Partial<OperatorObservation>).observation;
  const pending=observation?.state==="PENDING_RUNTIME" || observation?.state==="PENDING_READER";
  return `<section class="ap-observation" data-observation="${a(observation?.id || "")}" data-pending="${pending ? "true":"false"}" ${pending && links ? `data-poll="${a(links.pollUrl)}"`:""}>
    ${pending ? `<article role="status" aria-live="polite"><h2>Checking project status</h2><p>${observation?.state==="PENDING_RUNTIME" ? "Preparing the status read.":"Reading project status."} Results will appear when this check finishes.</p></article>`:""}
    ${result.diagnostic ? `<article class="ap-unhealthy"><h2>Unhealthy / unavailable</h2><p>${h(result.diagnostic)}</p><p>Retain the existing run and ask its owner to doctor the named boundary.</p></article>` : ""}
    ${observation ? `<details><summary>Observation details</summary><p>Observation ${h(observation.id || "unavailable")} · started ${h(observation.started_at || "unknown")}. Redisplaying this result does not verify current state.</p></details>`:""}
    ${report ? `<p>Read ${h(report.observed_at)} · ${report.runs.length} recorded run(s)${report.pagination ? ` on this page of ${report.pagination.total} retained run(s)` : ""}</p>
      ${report.resolution ? `<p>Project selection: ${h(report.resolution.status)} · ${h(report.project || "No path selected")}. Local causal evidence only; no fetch, refresh or authority granted.</p>` : ""}
      ${report.pagination ? `<p>Recent filesystem changes guide discovery; timestamps do not prove progress. Questions below cover this page only.</p><nav class="ap-actions"><a href="${path}${questionsOnly ? "/questions" : ""}?sources=${encodeURIComponent(source.name)}&amp;limit=${report.pagination.limit}">Newest runs / refresh inventory</a>${report.pagination.next_cursor ? `<a rel="next" href="${path}${questionsOnly ? "/questions" : ""}?sources=${encodeURIComponent(source.name)}&amp;limit=${report.pagination.limit}&amp;cursor=${encodeURIComponent(report.pagination.next_cursor)}">Older runs and questions</a>` : ""}</nav>` : ""}
      ${report.runs.length ? report.runs.filter(r => !questionsOnly || r.currentness !== "JOURNAL_VERIFIED_RECORDED_STATE" || r.questions.length || r.status === "unhealthy").map(r => runCard(r, path, questionsOnly)).join("") || "<p>No pending questions on this page. Other pages, delivery and native UI health are not covered by this statement.</p>" : report.project ? "<p>No run journals exist for this project. Delegate the first task below; the agent establishes its durable home.</p>" : "<p>No run state was selected. Resolve the reported project conflict through its owner.</p>"}
      <details><summary>Reader provenance</summary><p>CLI reader: ${h(report.helper.path)}</p><p>SHA-256: ${h(report.helper.sha256)}</p><p>Installed vs source selection follows Console's configured skill resolver. Loaded in the native session: UNKNOWN.</p></details>` : ""}
    ${links ? `<p><a class="ap-observe-link" href="${a(links.observeUrl)}">View this same observation</a> · <a href="${a(links.newUrl)}">Start a new read</a></p>`:""}
    <p class="ap-poll-state" role="status"></p></section>`;
}
export function operatorDetail(source: Source, project: string, result: OperatorResult, questionsOnly = false, links?:ObservationLinks) {
  const path = `/autopilot/${encodeURIComponent(source.name)}/${encodeURIComponent(project)}`;
  return `<h1>${questionsOnly ? "Durable questions" : "Autopilot status"}</h1><span class="source-badge">${h(displayName(source))}</span> <span>${h(project)}</span>
    <nav class="ap-actions"><a href="/autopilot">All active projects</a><a href="${path}">Run status</a><a href="${path}/questions">Question fallback</a><a href="${a(links?.observeUrl || path)}">Refresh this observation</a></nav>
    <p class="ap-limit">Recorded state only. Fresh ownership, native liveness, delivered notifications and loaded skills are unknown. Reading or copying a question never resolves it or grants approval.</p>
    ${operatorObservationPanel(source,project,result,questionsOnly,links)}
    ${!questionsOnly ? firstTask(project) : ""}${preparedArea()}${operatorGuidance()}${operatorScript()}${links ? observationScript():""}`;
}
export function observationScript() {
  return `<script>
  (()=>{
    // Reload and restored-tab navigation observe this attempt, never start another.
    const initial=document.querySelector('.ap-observation');
    const same=initial?.querySelector('.ap-observe-link')?.getAttribute('href');
    if(initial?.dataset.observation && same){
      try{const url=new URL(same,location.href);if(url.origin===location.origin)history.replaceState(null,'',url.pathname+url.search);}catch{}
    }
    let polls=0;
    async function poll(){
      const panel=document.querySelector('.ap-observation[data-pending="true"]');
      if(!panel || !panel.dataset.poll)return;
      const state=panel.querySelector('.ap-poll-state');
      if(polls++>=24){state.textContent='Automatic observation checks have stopped. View this same observation to check its result; no new read has started.';return;}
      const controller=new AbortController();
      const timer=setTimeout(()=>controller.abort(),3000);
      try {
        const response=await fetch(panel.dataset.poll,{cache:'no-store',credentials:'same-origin',signal:controller.signal});
        const documentResult=new DOMParser().parseFromString(await response.text(),'text/html');
        const next=documentResult.body.firstElementChild;
        if(!next || !next.matches('.ap-observation') || next.dataset.observation!==panel.dataset.observation)throw new Error('Observation response is unavailable.');
        panel.replaceWith(next);
        if(next.dataset.pending==='true')setTimeout(poll,1000);
      } catch {state.textContent='The observation check did not complete. View this same observation to check its result; no new read has started.';}
      finally {clearTimeout(timer);}
    }
    if(document.querySelector('.ap-observation[data-pending="true"]'))setTimeout(poll,1000);
  })();
  </script>`;
}
export function operatorScript() {
  return `<script>
  (() => {
    const area = document.querySelector('.ap-prepared');
    if (!area) return;
    const box = area.querySelector('.ap-request');
    const state = area.querySelector('.ap-prepared-state');
    function prepare(text) { box.value = text; area.hidden = false; state.textContent = 'Prepared locally · not submitted · not performed'; area.scrollIntoView({block:'nearest'}); box.focus(); }
    function identity(node) { return JSON.parse(node.closest('.ap-run').dataset.run); }
    function ownerText(run) { return 'For the existing authenticated owner of project ' + run.project_id + ', run ' + run.run_id + ', observed revision ' + run.revision + '. Recheck current identity, journal and authority. This page grants no approval. '; }
    document.addEventListener('submit', event => {
      const form = event.target;
      if (form.matches('.ap-delegate')) {
        event.preventDefault(); const data = new FormData(form);
        prepare('Autopilot this task in ' + form.dataset.project + ': ' + data.get('outcome') + '\\nConstraints and existing decisions: ' + (data.get('constraints') || 'Use my current instructions; do not infer new approvals.') + '\\nTake this end to end through the existing project/controller owners. Prepare the plan, task profile and acceptance criteria. Explain any unavailable continuation capability; do not promise an unverified wake.');
      } else if (form.matches('.ap-answer')) {
        event.preventDefault(); const run = identity(form); const data = new FormData(form);
        prepare(ownerText(run) + '\\nQuestion ' + form.dataset.question + '. My answer: ' + data.get('answer') + '\\nRecord this through the existing wait-resolution owner only after matching the current pending question. This prepared answer has not been submitted or accepted. Request reference: ' + crypto.randomUUID());
      }
    });
    document.addEventListener('click', async event => {
      const target = event.target.closest('button'); if (!target) return;
      if (target.matches('.ap-control')) {
        const run = identity(target); const action = target.dataset.action;
        const request = {schema_version:1,request_id:crypto.randomUUID(),operation:action === 'cancel' ? 'cancel':'recover',project_id:run.project_id,run_id:run.run_id,expected_revision:run.revision,input:action === 'cancel' ? {reason:'User requested cancellation from the Console handoff.',target:'run'}:{reconcile_sources:true}};
        prepare(ownerText(run) + '\\nI request ' + (action === 'cancel' ? 'cancellation. Preserve unfinished effects and children; report their actual state.':'recovery and resumption of already authorized work. Reconcile before continuing; do not replay uncertain effects.') + '\\nSubmit this exact controller request through your existing admission. If the revision changed, report the conflict before preparing a current request:\\n' + JSON.stringify(request,null,2));
      } else if (target.matches('.ap-guidance-request')) prepare(target.dataset.request);
      else if (target.matches('.ap-discard')) { box.value = ''; area.hidden = true; }
      else if (target.matches('.ap-copy')) {
        try { await navigator.clipboard.writeText(box.value); state.textContent = 'Copied · paste into the owning native task · not submitted or performed'; }
        catch { box.focus(); box.select(); state.textContent = 'Clipboard unavailable. The request is selected for manual copy; nothing was submitted.'; }
      }
    });
  })();
  </script>`;
}
