import { escapeAttr, escapeHtml } from "../utils.js";
import type { Outcome, SessionMeta, SessionRecord } from "../conversations.js";

const KIND_LABELS: Record<string, string> = {
  user: "You",
  brief: "Agent brief",
  assistant: "Reply",
  reasoning: "Reasoning",
  compaction: "Compaction summary",
  tool_call: "Tool call",
};

const STYLE = `<style>
.conv-record { border-left: 4px solid var(--pico-muted-border-color); padding: 0.4rem 0.8rem; margin: 0.6rem 0; }
.conv-record.kind-user { border-left-color: var(--pico-primary); }
.conv-record.kind-brief { border-left-color: #b8860b; }
.conv-record.kind-assistant { border-left-color: #2e8b57; }
.conv-record.kind-reasoning, .conv-record.kind-tool_call { border-left-color: #888; font-size: 0.9em; }
.conv-record header { font-size: 0.85em; color: var(--pico-muted-color); margin-bottom: 0.2rem; }
.conv-text { white-space: pre-wrap; overflow-wrap: anywhere; margin: 0; font-family: inherit; }
.conv-meta { font-size: 0.85em; color: var(--pico-muted-color); }
table.conv-list td { vertical-align: top; }
</style>`;

const MEANING = `<p class="conv-meta">Read-only. These come from <code>synthesis sessions</code>: every Claude Code, Codex
and Muse session on this machine, and those other machines synced into each workspace's sessions repo. Only your own
words are labeled <em>You</em>; a prompt one agent wrote for another is an <em>Agent brief</em>. Tool output and images
stay in each machine's local archive (<code>synthesis sessions show &lt;session&gt; --whole</code>).</p>`;

function notInstalled(): string {
  return `<p role="alert">synthesis v5.3.1 or later is not installed for this account, so there are no
conversations to show. Install the synthesis-skills plugin in a harness and start a session there.</p>`;
}

function problem(error: string | null): string {
  return error ? `<p role="alert"><mark>Problem:</mark> ${escapeHtml(error)}</p>` : "";
}

function when(at?: string): string {
  return at ? escapeHtml(at.slice(0, 16).replace("T", " ")) : "";
}

/** The first 8 characters a citation uses; a Claude Code sub-agent's id adds its agent name to its parent's. */
function short(id: string): string {
  const agent = id.match(/^(.{8}).*-(agent-[A-Za-z0-9]{1,8})/);
  return escapeHtml(agent ? `${agent[1]} › ${agent[2]}` : id.slice(0, 8));
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
  const model = record.model ? ` · ${escapeHtml(record.model)}` : "";
  const where = record.session
    ? ` · <a href="${escapeAttr(`/conversations/${record.session}#r${record.seq}`)}">${escapeHtml(record.harness ?? "")} ${short(record.session)}</a>`
    : "";
  return `<article class="conv-record kind-${escapeAttr(record.kind)}" id="r${record.seq}">
<header><strong>${escapeHtml(label)}</strong>${model} · #${record.seq} · ${when(record.at)}${where}${link}</header>
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
  return `<form method="get" action="/conversations" role="search">
<fieldset role="group">
<input type="search" name="q" value="${escapeAttr(page.query)}" placeholder="Search your prompts and the replies" aria-label="Search conversations">
<input type="text" name="workspace" value="${escapeAttr(page.workspace)}" placeholder="workspace" aria-label="Workspace">
<input type="text" name="project" value="${escapeAttr(page.project)}" placeholder="project" aria-label="Project">
<button type="submit">Show</button>
</fieldset>
</form>`;
}

export function conversationsView(page: ListPage): string {
  const head = `${STYLE}<h1>Conversations</h1>${MEANING}${form(page)}`;
  if (!page.sessions.installed) return head + notInstalled();
  if (page.matches) {
    const found = page.matches.items;
    return `${head}${problem(page.matches.error)}
<p>${found.length.toLocaleString()} match${found.length === 1 ? "" : "es"} for <strong>${escapeHtml(page.query)}</strong>.</p>
${found.map((record) => recordBlock(record, "", 1200)).join("\n")}`;
  }
  const rows = page.sessions.items.map((meta) => {
    const projects = (meta.projects ?? []).map(escapeHtml).join(", ") || "—";
    const models = (meta.models ?? []).map(escapeHtml).join(", ");
    const role = meta.role ? ` <small>(${escapeHtml(meta.role)})</small>` : "";
    const from = meta.synced ? ` <small>synced from another machine</small>` : "";
    return `<tr>
<td>${when(meta.last)}</td>
<td>${escapeHtml(meta.harness)}${role}</td>
<td><a href="${escapeAttr(`/conversations/${meta.session}`)}">${short(meta.session)}</a>${from}</td>
<td>${projects}</td>
<td>${models}</td>
<td>${(meta.records ?? 0).toLocaleString()}</td>
</tr>`;
  });
  return `${head}${problem(page.sessions.error)}
<table class="conv-list">
<thead><tr><th>Last</th><th>Harness</th><th>Session</th><th>Projects</th><th>Models</th><th>Records</th></tr></thead>
<tbody>${rows.join("\n") || `<tr><td colspan="6">No sessions match.</td></tr>`}</tbody>
</table>`;
}

export function conversationView(id: string, full: boolean, records: Outcome<SessionRecord>): string {
  const toggle = full
    ? `<a href="${escapeAttr(`/conversations/${id}`)}">Show the conversation only</a>`
    : `<a href="${escapeAttr(`/conversations/${id}?full=1`)}">Show reasoning and tool calls too</a>`;
  const head = `${STYLE}<p><a href="/conversations">All conversations</a></p>
<h1>Session ${short(id)}</h1>
<p class="conv-meta"><code>${escapeHtml(id)}</code> · ${toggle} · cite a record as
<code>&lt;harness&gt; ${short(id)} #&lt;seq&gt;</code></p>`;
  if (!records.installed) return head + notInstalled();
  return `${head}${problem(records.error)}
${records.items.map((record) => recordBlock(record)).join("\n") || (records.error ? "" : "<p>No records of these kinds.</p>")}`;
}
