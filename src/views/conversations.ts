import { escapeAttr, escapeHtml } from "../utils.js";
import type { Outcome, SessionMeta, SessionRecord } from "../conversations.js";
import { icon } from "./icons.js";
import { callout, emptyState, pageHeader } from "./ui.js";

const KIND_LABELS: Record<string, string> = {
  user: "You",
  brief: "Agent brief",
  assistant: "Reply",
  reasoning: "Reasoning",
  compaction: "Compaction summary",
  tool_call: "Tool call",
};

const MEANING = `<p class="conv-meta">Read-only. These come from <code>synthesis sessions</code>: every Claude Code, Codex
and Muse session on this machine, and those other machines synced into each workspace's sessions repo. Only your own
words are labeled <em>You</em>; a prompt one agent wrote for another is an <em>Agent brief</em>. Tool output and images
stay in each machine's local archive (<code>synthesis sessions show &lt;session&gt; --whole</code>).</p>`;

function notInstalled(): string {
  return callout(
    "warn",
    "synthesis v5.3.1 or later is not installed for this account, so there are no conversations to show. Install the synthesis-skills plugin in a harness and start a session there.",
    { title: "Conversations unavailable", role: "alert" }
  );
}

function problem(error: string | null): string {
  return error ? callout("bad", `<mark>Problem:</mark> ${escapeHtml(error)}`, { role: "alert" }) : "";
}

function when(at?: string): string {
  return at ? escapeHtml(at.slice(0, 16).replace("T", " ")) : "";
}

/** The first 8 characters a citation uses; a Claude Code sub-agent's id adds its agent name to its parent's. */
function shortLabel(id: string): string {
  const agent = id.match(/^(.{8}).*-(agent-[A-Za-z0-9]{1,8})/);
  return agent ? `${agent[1]} › ${agent[2]}` : id.slice(0, 8);
}

function short(id: string): string {
  return escapeHtml(shortLabel(id));
}

function body(record: SessionRecord, limit = 0): string {
  let text = record.text ?? "";
  if (record.kind === "tool_call") {
    const input = typeof record.input === "string" ? record.input : JSON.stringify(record.input ?? "");
    text = `${record.tool ?? "tool"} ${input}`;
  }
  const cut = limit && text.length > limit ? `${text.slice(0, limit)} …` : text;
  const more = record.text_chars && record.text_chars > (record.text ?? "").length
    ? `\n[${record.text_chars.toLocaleString()} characters in all; the rest is in the local archive]` : "";
  return `<pre class="conv-text">${escapeHtml(cut + more)}</pre>`;
}

function recordBlock(record: SessionRecord, link = "", limit = 0): string {
  const label = KIND_LABELS[record.kind] ?? record.kind;
  const model = record.model ? `<span>${escapeHtml(record.model)}</span>` : "";
  const where = record.session
    ? `<a href="${escapeAttr(`/conversations/${record.session}#r${record.seq}`)}">${escapeHtml(record.harness ?? "")} ${short(record.session)}</a>`
    : "";
  return `<article class="conv-record kind-${escapeAttr(record.kind)}" id="r${record.seq}">
<header><strong>${escapeHtml(label)}</strong>${model}<span>#${record.seq}</span><span>${when(record.at)}</span>${where}${link}</header>
${body(record, limit)}
</article>`;
}

export interface ListPage {
  query: string;
  workspace: string;
  project: string;
  sessions: Outcome<SessionMeta>;
  matches: Outcome<SessionRecord> | null;
}

function form(page: ListPage): string {
  return `<form method="get" action="/conversations" role="search" class="conv-filters">
<div class="search-field">${icon("search")}<input type="search" name="q" value="${escapeAttr(page.query)}" placeholder="Search your prompts and the replies" aria-label="Search conversations"></div>
<input type="text" name="workspace" value="${escapeAttr(page.workspace)}" placeholder="Workspace" aria-label="Workspace">
<input type="text" name="project" value="${escapeAttr(page.project)}" placeholder="Project" aria-label="Project">
<button type="submit" class="btn-primary">Show</button>
</form>`;
}

const LEAD = "Every agent session on this machine and those synced from your other machines: what you asked and what came back.";

export function conversationsView(page: ListPage): string {
  const head = `${pageHeader({ title: "Conversations", lead: LEAD })}${form(page)}`;
  if (!page.sessions.installed) return head + notInstalled() + MEANING;
  if (page.matches) {
    const found = page.matches.items;
    return `${head}${problem(page.matches.error)}
<div class="section-header"><h2 class="section-title">${icon("search")}${found.length.toLocaleString()} match${found.length === 1 ? "" : "es"} for <strong>${escapeHtml(page.query)}</strong></h2><a class="section-link" href="/conversations">Clear search</a></div>
${found.length ? found.map((record) => recordBlock(record, "", 1200)).join("\n") : emptyState({ icon: "search", title: "No matches", body: "Try other words, or widen the workspace and project filters." })}
${MEANING}`;
  }
  const rows = page.sessions.items.map((meta) => {
    const projects = (meta.projects ?? []).map(escapeHtml).join(", ") || `<span class="muted">—</span>`;
    const models = (meta.models ?? []).map(escapeHtml).join(", ");
    const role = meta.role ? `<span class="cell-sub">${escapeHtml(meta.role)}</span>` : "";
    const from = meta.synced ? `<span class="cell-sub">synced from another machine</span>` : "";
    return `<tr>
<td class="nowrap">${when(meta.last)}</td>
<td>${escapeHtml(meta.harness)}${role}</td>
<td><a class="conv-session-link" href="${escapeAttr(`/conversations/${meta.session}`)}">${short(meta.session)}</a>${from}</td>
<td>${projects}</td>
<td class="muted">${models}</td>
<td class="num">${(meta.records ?? 0).toLocaleString()}</td>
</tr>`;
  });
  return `${head}${problem(page.sessions.error)}
<div class="table-wrap"><table class="conv-list">
<thead><tr><th scope="col">Last</th><th scope="col">Harness</th><th scope="col">Session</th><th scope="col">Projects</th><th scope="col">Models</th><th scope="col" class="num">Records</th></tr></thead>
<tbody>${rows.join("\n") || `<tr><td colspan="6">No sessions match.</td></tr>`}</tbody>
</table></div>
${MEANING}`;
}

export function conversationView(id: string, full: boolean, records: Outcome<SessionRecord>): string {
  const toggle = full
    ? `<a class="btn" href="${escapeAttr(`/conversations/${id}`)}">${icon("chat")}Conversation only</a>`
    : `<a class="btn" href="${escapeAttr(`/conversations/${id}?full=1`)}">${icon("terminal")}Show reasoning and tool calls</a>`;
  const head = `${pageHeader({
    title: `Session ${shortLabel(id)}`,
    eyebrowHtml: `<a href="/conversations">${icon("arrowLeft", "icon-sm")} All conversations</a>`,
    metaHtml: `<span><code>${escapeHtml(id)}</code></span><span>Cite a record as <code>&lt;harness&gt; ${short(id)} #&lt;seq&gt;</code></span>`,
    actionsHtml: toggle,
  })}`;
  if (!records.installed) return head + notInstalled();
  return `${head}${problem(records.error)}
${records.items.map((record) => recordBlock(record)).join("\n") || (records.error ? "" : emptyState({ icon: "chat", title: "No records of these kinds", compact: true }))}`;
}
