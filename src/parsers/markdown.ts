import { readFileSync, existsSync, statSync } from "fs";
import MarkdownIt from "markdown-it";
import { escapeAttr, escapeHtml } from "../utils.js";
import { findDraftBlocks } from "./draft-blocks.js";
import type { DraftBlock } from "./draft-blocks.js";
import { findPlanSections } from "./plan-sections.js";
import type { PlanSection } from "./plan-sections.js";
import { renderMentionPills, resolveMentions, listResolvedMentions } from "./slack-mentions.js";
import type { SlackDirectory } from "./slack-directory.js";
import { emptyDirectory } from "./slack-directory.js";
import { buildChannelUrl, buildUserDmUrl } from "../integrations/slack-urls.js";
import type { SlackWorkspaceConfig } from "../integrations/slack-urls.js";

// Markdown is rendered without HTML sanitization. This is deliberate:
// synthesis-console is a local-only tool that reads the user's own files.
// Sanitizing would break legitimate HTML in markdown (tables, embeds, etc).
// If adapting this code for multi-tenant use, add DOMPurify or similar.
const md = new MarkdownIt({
  html: true,
  linkify: true,
  typographer: true,
});

// Enable task list checkboxes (- [x] and - [ ])
md.use(taskListPlugin);

// External links: open in new tab so the daily plan never gets clobbered.
// Inline markdown links to Slack (timestamped permalinks like
// `[1:24 PM EDT](https://...slack.com/.../p17774...)`), GitHub, Jira, and
// other off-app URLs all need this treatment. The cockpit-emitted slack
// pills already set target="_blank" explicitly; this rule covers the
// markdown-source-authored anchors that markdown-it would otherwise emit
// as plain `<a href="...">label</a>`.
//
// External = anything starting with `http://` or `https://`. Internal
// links (anchors, relative paths) are unchanged so in-page navigation
// still works.
const defaultLinkOpen = md.renderer.rules.link_open || function (tokens, idx, options, _env, self) {
  return self.renderToken(tokens, idx, options);
};
md.renderer.rules.link_open = function (tokens, idx, options, env, self) {
  const token = tokens[idx];
  const href = token.attrGet("href") || "";
  if (/^https?:\/\//i.test(href)) {
    // Don't clobber if a producer already set target.
    if (token.attrIndex("target") < 0) token.attrSet("target", "_blank");
    if (token.attrIndex("rel") < 0) token.attrSet("rel", "noopener");
  }
  return defaultLinkOpen(tokens, idx, options, env, self);
};

function taskListPlugin(md: MarkdownIt) {
  md.core.ruler.after("inline", "task-lists", (state) => {
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type !== "inline") continue;
      const content = tokens[i].content;
      if (!content) continue;

      // Check if this inline token starts with [ ] or [x]
      if (content.startsWith("[x] ") || content.startsWith("[X] ")) {
        tokens[i].content = content.slice(4);
        // Find the parent list item and mark it
        for (let j = i - 1; j >= 0; j--) {
          if (tokens[j].type === "list_item_open") {
            tokens[j].attrSet("class", "task-list-item");
            break;
          }
        }
        // Prepend checked checkbox
        const checkToken = new state.Token("html_inline", "", 0);
        checkToken.content = '<input type="checkbox" checked disabled> ';
        tokens[i].children = tokens[i].children || [];
        tokens[i].children.unshift(checkToken);
      } else if (content.startsWith("[ ] ")) {
        tokens[i].content = content.slice(4);
        for (let j = i - 1; j >= 0; j--) {
          if (tokens[j].type === "list_item_open") {
            tokens[j].attrSet("class", "task-list-item");
            break;
          }
        }
        const checkToken = new state.Token("html_inline", "", 0);
        checkToken.content = '<input type="checkbox" disabled> ';
        tokens[i].children = tokens[i].children || [];
        tokens[i].children.unshift(checkToken);
      }
    }
  });
}

export function renderMarkdown(content: string): string {
  return md.render(content);
}

export function readAndRenderMarkdown(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  return renderMarkdown(raw);
}

export function readMarkdownRaw(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  return readFileSync(filePath, "utf-8");
}

/**
 * Pre-process daily plan markdown to fix patterns that break standard parsers:
 * - Strikethrough around code fences (~~```...```) from sent draft messages
 * - Other daily-plan-specific formatting
 */
function preprocessPlanMarkdown(raw: string): string {
  // Fix strikethrough wrapping code fences: ~~```\n...\n```
  // This happens when a drafted message is struck through after sending.
  // Strip the ~~ from fence markers so the fence renders properly,
  // and wrap the whole block in strikethrough via HTML.
  let result = raw;

  // Pattern: ~~``` at line start (opening fence with strikethrough)
  // Replace with a blockquote (since it's a "sent" message) and remove the broken fence
  result = result.replace(
    /^~~```\s*$/gm,
    "```"
  );

  return result;
}

/**
 * Render markdown for daily plans with:
 * - Pre-processing for daily-plan-specific patterns
 * - #channel-name → Slack deep link
 * - Slack mention pills for `<@U...>` and `<#C...|name>` canonical syntax
 * - Draft action bars with copy / edit / open-in-Slack / send-via-Slack
 *
 * `editable` controls whether the draft action bar surfaces an Edit button.
 * `slackEnabled` controls whether the Send-to-Slack button is rendered.
 * Demo sources pass `editable: false` and `slackEnabled: false`.
 *
 * `directory` provides the user/channel mapping consumed by mention rendering
 * and (later) by Smart Copy on the client.
 */
export function readAndRenderPlanMarkdown(
  filePath: string,
  opts: {
    editable?: boolean;
    slackEnabled?: boolean;
    directory?: SlackDirectory;
    slack?: SlackWorkspaceConfig;
  } = {}
): string | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const drafts = findDraftBlocks(raw);
  const directory = opts.directory ?? emptyDirectory();
  const slackCfg: SlackWorkspaceConfig = opts.slack ?? {};
  const preprocessed = preprocessPlanMarkdown(raw);
  let html = md.render(preprocessed);

  // Render canonical Slack mention syntax (<@U...>, <#C...|name>) as pills.
  html = renderMentionPills(html, directory);

  // Convert bare #channel-name references to Slack deep links. Look up the
  // channel ID via the directory; build a workspace-aware URL when possible
  // (https permalink with workspace_url, slack:// with team_id, falling back
  // to the bare-name form).
  html = html.replace(
    /(?<![<\w/&])#([a-zA-Z][\w-]{1,79})(?![^<]*>)/g,
    (_match, name: string) => {
      const ch = directory.channelByName.get(name.toLowerCase());
      const id = ch?.id;
      const url = buildChannelUrl(slackCfg, id, undefined, name);
      const titleId = id ? ` (${id})` : "";
      return `<a class="slack-channel-link" href="${escapeAttr(url)}" target="_blank" rel="noopener" title="Open #${escapeAttr(name)}${escapeAttr(titleId)} in Slack (new tab)">#${escapeHtml(name)}</a>`;
    }
  );

  // Insert a notice before draft message sections reminding users to review
  const draftNotice = `<div class="draft-notice" role="note">
    <strong>Review before sending.</strong> These drafts are grounded in real data &mdash;
    code commits, test results, deployment logs, Slack threads, and project context &mdash;
    but they are starting points, not final messages.
    Read each one, edit it in your own voice, and add the personal touch only you can.
    Human-to-human communication deserves human effort.
  </div>`;

  // Insert before headings that contain draft/unsent language
  html = html.replace(
    /(<h2[^>]*>(?:[^<]*(?:Draft|Unsent|Ready to Send)[^<]*)<\/h2>)/i,
    draftNotice + "\n$1"
  );

  // Augment draft message blocks with action buttons (copy / edit / open in Slack / send / compose email)
  html = augmentDraftBlocks(html, drafts, {
    editable: opts.editable !== false,
    slackEnabled: opts.slackEnabled === true,
    directory,
    slack: slackCfg,
  });

  // Append a JSON island with the directory so client-side Smart Copy can do
  // mention substitution before writing to the clipboard.
  const island = renderDirectoryIsland(directory);
  if (island) html = html + "\n" + island;

  return html;
}

/**
 * Cockpit-aware entry point. Reads the plan file once and produces the full
 * bundle the cockpit view needs:
 *   - sections: typed structural decomposition for the cockpit's region rendering
 *   - draftsHtml: HTML of just the drafts H2 section, with action bars
 *     (the existing augmentDraftBlocks output, sliced to the drafts section)
 *   - fullHtml: the full augmented HTML (for the "Full markdown" collapsible)
 *   - directoryIslandHtml: the JSON island for Smart Copy on the client
 *   - raw: the file contents for compare-and-swap fingerprinting
 *   - mtimeMs: file modification time in ms
 */
export function readAndRenderPlanForCockpit(
  filePath: string,
  opts: {
    editable?: boolean;
    slackEnabled?: boolean;
    directory?: SlackDirectory;
    slack?: SlackWorkspaceConfig;
  } = {}
): {
  raw: string;
  mtimeMs: number;
  sections: PlanSection[];
  drafts: DraftBlock[];
  draftsHtml: string;
  fullHtml: string;
  directoryIslandHtml: string;
} | null {
  if (!existsSync(filePath)) return null;
  const raw = readFileSync(filePath, "utf-8");
  const stat = statSync(filePath);
  const mtimeMs = stat.mtimeMs;

  const sections = findPlanSections(raw);
  const directory = opts.directory ?? emptyDirectory();

  // Render the full file via the existing path; this is what the "Full
  // markdown" collapsible shows. We then slice out just the drafts H2 section
  // for the cockpit's DRAFTS region.
  const fullHtmlWithIsland = readAndRenderPlanMarkdown(filePath, opts) || "";

  // Strip the directory island from fullHtml (the cockpit appends it once at
  // the bottom of the page; we don't want it duplicated inside Full markdown).
  const islandRe = /<script id="slack-directory" type="application\/json">[\s\S]*?<\/script>/;
  const islandMatch = fullHtmlWithIsland.match(islandRe);
  const directoryIslandHtml = islandMatch ? islandMatch[0] : "";
  const fullHtml = fullHtmlWithIsland.replace(islandRe, "").trim();

  // The DRAFTS region uses just the extracted draft sections, with sent
  // drafts wrapped in <details> for one-line collapse. The Full Markdown
  // collapsible at the bottom uses the unwrapped fullHtml as an escape
  // hatch — it shows everything verbatim.
  const drafts = findDraftBlocks(raw);
  const draftsHtml = wrapSentDraftSections(collectAllDraftSections(fullHtml), drafts);

  return {
    raw,
    mtimeMs,
    sections,
    drafts,
    draftsHtml,
    fullHtml,
    directoryIslandHtml,
  };
}

/**
 * Collect every draft H3 sub-tree from the rendered HTML, regardless of which
 * H2 it lives under.
 *
 * Plans grow throughout the day. The morning ritual creates a "Drafts — Ready
 * to Send" H2 with the day's first drafts; later, new drafts get inserted in
 * topical H2 sections like "Things to Know" or "Mid-day Sync" alongside the
 * context that prompted them. Slicing only the drafts H2 misses anything
 * added later — that's a correctness bug. The cockpit's DRAFTS region must
 * surface every `**Send to:**` block in the document, in document order.
 *
 * A draft is recognized by either signal (belt-and-suspenders):
 *   - the body contains a draft-actions div (action bar added by the
 *     augmentation step), OR
 *   - the body contains `<strong>Send to:</strong>` or `<strong>Channel:</strong>`
 *
 * We split by H2 AND H3 so each H3's body ends at the next H3 OR H2,
 * preventing over-inclusion of unrelated content from later sections.
 */
function collectAllDraftSections(fullHtml: string): string {
  const parts = fullHtml.split(/(<h[23][^>]*>[\s\S]*?<\/h[23]>)/);
  const collected: string[] = [];
  // Track the most recent H2's text so we can skip H3 drafts that belong
  // to a Cockpit Mode NEEDS-YOU H2 (`## ⚡ Decision needed`, `## ☑️ One-tap
  // batch`). Those drafts are rendered by the NEEDS YOU region above and
  // must NOT double-render in the standard DRAFTS region.
  let currentH2Kind: "cockpit-needs" | "other" | null = null;
  for (let i = 1; i < parts.length; i += 2) {
    const heading = parts[i];
    const body = parts[i + 1] || "";
    if (/^<h2\b/i.test(heading)) {
      currentH2Kind = classifyH2ForDraftFilter(heading);
      continue;
    }
    if (!/^<h3\b/i.test(heading)) continue;
    if (currentH2Kind === "cockpit-needs") continue;
    const hasActionBar = /class="draft-actions/.test(body);
    const hasSendTo = /<strong>\s*(?:Send to|Channel)\s*:?\s*<\/strong>/i.test(body);
    if (!hasActionBar && !hasSendTo) continue;
    collected.push(heading + body);
  }
  return collected.join("\n");
}

/**
 * Extract H2 inner text from a rendered `<h2>...</h2>` string and classify
 * whether it's a Cockpit Mode NEEDS-YOU H2. Kept local to markdown.ts so
 * the drafts-region slicing stays contained.
 */
function classifyH2ForDraftFilter(h2Html: string): "cockpit-needs" | "other" {
  const inner = h2Html.replace(/^<h2\b[^>]*>/i, "").replace(/<\/h2>\s*$/i, "");
  const text = inner
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/~~/g, "")
    .replace(/[⚡☑️📅📰🎯📋]/g, "")
    .trim()
    .toLowerCase();
  if (/^decision\s+needed\b/.test(text)) return "cockpit-needs";
  if (/^one[-\s]?tap\s+batch\b|^batch\s+review\b/.test(text)) return "cockpit-needs";
  return "other";
}

interface SendToTarget {
  kind: "slack-channel" | "slack-dm" | "slack-user" | "slack-thread" | "email" | "unknown";
  channelName?: string;
  channelId?: string;
  userId?: string;
  threadTs?: string;
  email?: string;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function parseSendTo(htmlFragment: string): SendToTarget | null {
  const text = decodeEntities(htmlFragment.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
  if (!text) return null;

  // Email — preferred when present, since email syntax can incidentally include @ symbols
  // that would otherwise get matched as user mentions
  const emailMatch = text.match(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/);
  if (emailMatch && !/@[A-Z0-9]{6,}/.test(text)) {
    return { kind: "email", email: emailMatch[0] };
  }

  const threadMatch = text.match(/TS:\s*([\d.]+)/i);
  const dmIdMatch = text.match(/\b(D[A-Z0-9]{6,})\b/);
  const userIdMatch = text.match(/\b(U[A-Z0-9]{6,})\b/);
  const channelMatch = text.match(/#([a-zA-Z][\w-]+)/);

  if (threadMatch) {
    return {
      kind: "slack-thread",
      threadTs: threadMatch[1],
      channelId: dmIdMatch?.[1],
      userId: userIdMatch?.[1],
      channelName: channelMatch?.[1],
    };
  }

  if (dmIdMatch) {
    return { kind: "slack-dm", channelId: dmIdMatch[1], userId: userIdMatch?.[1] };
  }

  if (userIdMatch) {
    return { kind: "slack-user", userId: userIdMatch[1] };
  }

  if (channelMatch) {
    return { kind: "slack-channel", channelName: channelMatch[1] };
  }

  return null;
}

interface DraftActionOpts {
  draft?: DraftBlock;
  editable: boolean;
  slackEnabled: boolean;
  directory: SlackDirectory;
  slack: SlackWorkspaceConfig;
}

function renderDraftActions(
  target: SendToTarget | null,
  subject: string | undefined,
  opts: DraftActionOpts
): string {
  // Sent state: show a Sent badge + Open-thread link, suppress Copy/Edit/Send.
  if (opts.draft && opts.draft.alreadySent) {
    return renderSentBadge(opts.draft, target, opts.slack);
  }

  const parts: string[] = [];
  parts.push(
    `<button type="button" class="draft-action draft-read draft-copy" data-action="copy" aria-label="Copy draft to clipboard">Copy</button>`
  );

  if (opts.draft && opts.editable) {
    parts.push(
      `<button type="button" class="draft-action draft-read draft-edit" data-action="edit" aria-label="Edit draft">Edit</button>`
    );
  }

  // Send-to-Slack button — only when:
  //   (a) slack send is enabled (token configured),
  //   (b) the source is editable (rules out demo),
  //   (c) the parsed target is sendable via Web API
  //       (channel ref, DM channel ID, user ID, or thread on any of those).
  const sendable = opts.slackEnabled && opts.editable && isSendable(target, opts.directory);
  if (opts.draft && sendable) {
    parts.push(
      `<button type="button" class="draft-action draft-read draft-send" data-action="send" aria-label="Send to Slack">Send to Slack</button>`
    );
  }

  if (target) {
    if (target.kind === "slack-channel" && target.channelName) {
      // target.channelId is populated upstream when the directory has a match.
      const url = buildChannelUrl(opts.slack, target.channelId, undefined, target.channelName);
      parts.push(
        `<a class="draft-action draft-read draft-slack" href="${escapeAttr(url)}" target="_blank" rel="noopener">Open #${escapeAttr(target.channelName)} in Slack</a>`
      );
    } else if (target.kind === "slack-dm" && target.channelId) {
      const url = buildChannelUrl(opts.slack, target.channelId);
      parts.push(
        `<a class="draft-action draft-read draft-slack" href="${escapeAttr(url)}" target="_blank" rel="noopener">Open DM in Slack</a>`
      );
    } else if (target.kind === "slack-user" && target.userId) {
      const url = buildUserDmUrl(opts.slack, target.userId);
      parts.push(
        `<a class="draft-action draft-read draft-slack" href="${escapeAttr(url)}" target="_blank" rel="noopener">Open DM in Slack</a>`
      );
    } else if (target.kind === "slack-thread" && (target.channelId || target.userId)) {
      const idForUrl = target.channelId || target.userId!;
      const url = buildChannelUrl(opts.slack, idForUrl, target.threadTs);
      parts.push(
        `<a class="draft-action draft-read draft-slack" href="${escapeAttr(url)}" target="_blank" rel="noopener">Open thread in Slack</a>`
      );
    } else if (target.kind === "email" && target.email) {
      // Body is filled client-side from the message element; href has subject only as a fallback.
      const fallbackHref =
        `mailto:${encodeURIComponent(target.email)}` +
        (subject ? `?subject=${encodeURIComponent(subject)}` : "");
      parts.push(
        `<a class="draft-action draft-read draft-email" href="${escapeAttr(fallbackHref)}" data-action="email" data-email="${escapeAttr(target.email)}" data-subject="${escapeAttr(subject || "")}">Compose email</a>`
      );
    }
  }

  // Edit-mode buttons (hidden by default; revealed when .draft-actions has the
  // `data-mode="editing"` attribute set by JS on Edit click).
  if (opts.draft && opts.editable) {
    parts.push(
      `<button type="button" class="draft-action draft-edit-only draft-save" data-action="save">Save</button>`,
      `<button type="button" class="draft-action draft-edit-only draft-cancel" data-action="cancel">Cancel</button>`,
      `<span class="draft-edit-only draft-status" role="status" aria-live="polite"></span>`
    );
  }

  // Send-mode status slot (revealed during send). Re-uses the .draft-status
  // styling but lives outside the edit-only group so it persists across mode
  // transitions.
  if (opts.draft && sendable) {
    parts.push(
      `<span class="draft-send-status" role="status" aria-live="polite"></span>`
    );
  }

  const datasetParts: string[] = [];
  if (opts.draft) {
    datasetParts.push(`data-draft-index="${opts.draft.index}"`);
    datasetParts.push(`data-draft-kind="${opts.draft.kind}"`);
    if (opts.editable) datasetParts.push(`data-editable="true"`);
    if (sendable) datasetParts.push(`data-sendable="true"`);
    if (target) {
      datasetParts.push(`data-target-kind="${target.kind}"`);
      if (target.channelName) datasetParts.push(`data-target-channel-name="${escapeAttr(target.channelName)}"`);
      if (target.channelId) datasetParts.push(`data-target-channel-id="${escapeAttr(target.channelId)}"`);
      if (target.userId) datasetParts.push(`data-target-user-id="${escapeAttr(target.userId)}"`);
      if (target.threadTs) datasetParts.push(`data-target-thread-ts="${escapeAttr(target.threadTs)}"`);
    }
    // Original body text for compare-and-swap on save.
    datasetParts.push(`data-original-text="${escapeAttr(opts.draft.bodyText)}"`);
  }
  const dataset = datasetParts.length ? " " + datasetParts.join(" ") : "";

  return `<div class="draft-actions" role="group" aria-label="Draft actions"${dataset}>${parts.join("")}</div>`;
}

function renderSentBadge(
  draft: DraftBlock,
  target: SendToTarget | null,
  slack: SlackWorkspaceConfig
): string {
  const parts: string[] = [];
  const when = draft.sentAt ? ` ${escapeHtml(draft.sentAt)}` : "";
  parts.push(`<span class="draft-action draft-sent-badge" aria-label="Sent">Sent${when}</span>`);

  if (draft.sentPermalink) {
    parts.push(
      `<a class="draft-action draft-sent-link" href="${escapeAttr(draft.sentPermalink)}" target="_blank" rel="noopener">View in Slack</a>`
    );
  } else if (target && draft.sentTs) {
    const idForUrl = target.channelId || target.userId;
    if (idForUrl) {
      const url = buildChannelUrl(slack, idForUrl, draft.sentTs);
      parts.push(
        `<a class="draft-action draft-sent-link" href="${escapeAttr(url)}" target="_blank" rel="noopener">Open in Slack</a>`
      );
    }
  }
  return `<div class="draft-actions draft-actions-sent" role="group" aria-label="Sent draft" data-sent="true">${parts.join("")}</div>`;
}

function isSendable(target: SendToTarget | null, dir: SlackDirectory): boolean {
  if (!target) return false;
  if (target.kind === "slack-channel" && target.channelName) {
    // Sendable via API only if we can resolve the channel name to an ID.
    return dir.channelByName.has(target.channelName.toLowerCase());
  }
  if (target.kind === "slack-dm") return !!target.channelId;
  if (target.kind === "slack-user") return !!target.userId;
  if (target.kind === "slack-thread") return !!(target.channelId || target.userId);
  return false;
}

/**
 * Walk the rendered HTML, find draft sections (heading-bounded sections that
 * contain a `<strong>Send to:</strong>` paragraph), and decorate each with a
 * `<div class="draft-body-region">` wrapper around the entire body plus an
 * action bar appended at the end of the wrapper.
 *
 * v0.8.5+ region semantics
 * ------------------------
 * The body region spans from the end of the `<strong>Send to:</strong>`
 * paragraph to the start of the next heading, the next `<p><strong>Sent:</strong>`
 * paragraph, or the next `<p><strong>Grounding:</strong>` paragraph (whichever
 * comes first inside the section). Everything between is the body — fenced
 * code blocks, blockquotes, paragraphs, lists, all of it.
 *
 * Wrapping the entire region (rather than just the first fenced block) handles
 * three cases under one rule:
 *   - Single-fence drafts (the common case) — the wrapper contains one <pre>.
 *   - Single-blockquote drafts — the wrapper contains one <blockquote>.
 *   - Multi-segment drafts (intro prose + ```code``` + middle prose + ...) —
 *     the wrapper contains heterogeneous children. The action bar still lands
 *     once at the end. Copy/Send capture the entire bodyText for Slack.
 *
 * The pre-scanned `drafts` array (from findDraftBlocks on the same source)
 * is consumed in document order so each augmented section is paired with its
 * DraftBlock metadata for the Edit button. If a section doesn't have a
 * corresponding draft, the action bar still renders Copy + Slack/Email but no
 * Edit button.
 */
function augmentDraftBlocks(
  html: string,
  drafts: DraftBlock[],
  opts: { editable: boolean; slackEnabled: boolean; directory: SlackDirectory; slack: SlackWorkspaceConfig }
): string {
  const sections = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/);
  let draftCursor = 0;

  for (let i = 0; i < sections.length; i++) {
    const section = sections[i];
    if (!section || /^<h[1-6]/.test(section)) continue;

    const sendToRegex = /<p>\s*<strong>(?:Send to|Channel):?<\/strong>([\s\S]*?)<\/p>/i;
    const sendToMatch = section.match(sendToRegex);
    if (!sendToMatch || sendToMatch.index === undefined) continue;

    const target = parseSendTo(sendToMatch[1]);
    if (target && target.kind === "slack-channel" && target.channelName) {
      const ch = opts.directory.channelByName.get(target.channelName.toLowerCase());
      if (ch) target.channelId = ch.id;
    }

    const subjectMatch = section.match(/<p>\s*<strong>Subject:?<\/strong>([\s\S]*?)<\/p>/i);
    const subject = subjectMatch
      ? decodeEntities(subjectMatch[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()
      : undefined;

    const sendToEnd = sendToMatch.index + sendToMatch[0].length;

    // Body region ends BEFORE a Sent or Grounding marker inside this
    // section, or at the section end. We search the slice after Send-to.
    //
    // Grounding can appear in two forms (producer-consumer contract has
    // two valid templates):
    //   1. Legacy: <p><strong>Grounding:</strong></p> + <ul>/<ol>
    //   2. v3.3.0+: <details><summary>Grounding (...)</summary>...</details>
    //
    // The v3.3.0+ template ships native HTML5 collapsibles so the markdown
    // is glanceable as text (collapsed by GitHub etc.) and the cockpit
    // gets the same shape as the legacy form. The body-end detection must
    // match BOTH or the Grounding block ends up engulfed inside the body
    // region wrapper, which puts the action bar AFTER the Grounding —
    // exactly the wrong order, since the user needs the Copy / Edit /
    // Send-to-Slack buttons immediately adjacent to the message text.
    const afterSlice = section.slice(sendToEnd);
    const sentRel = afterSlice.search(/<p>\s*<strong>Sent(?:\s*at)?:?<\/strong>/i);
    const groundingRel = afterSlice.search(
      /<p>\s*<strong>\s*Grounding\b[^<]*<\/strong>|<details(?=\s|>)[^>]*>\s*<summary[^>]*>\s*Grounding\b/i
    );

    let bodyEndRel = afterSlice.length;
    if (sentRel >= 0) bodyEndRel = Math.min(bodyEndRel, sentRel);
    if (groundingRel >= 0) bodyEndRel = Math.min(bodyEndRel, groundingRel);

    const before = section.slice(0, sendToEnd);
    let bodyHtml = afterSlice.slice(0, bodyEndRel);
    const tail = afterSlice.slice(bodyEndRel);

    // v0.9.4: pair the draft FIRST, then optionally skip rendering the
    // wrapper. The cursor must advance for every section that has a
    // Send-to marker so the drafts[] array (built by findDraftBlocks) and
    // the HTML sections stay in lockstep.
    //
    // Why this matters: synthesis-slack-sync occasionally produces drafts
    // where the **Sent:** paragraph sits BETWEEN Send-to and the message
    // fence (instead of after the body). The body-end regex matches
    // **Sent:** first, leaves bodyHtml empty, and the OLD code skipped
    // the section without advancing the cursor — every draft AFTER that
    // section paired with the wrong drafts[] entry. The visible symptom
    // was Copy returning the previous draft's body text.
    const draft = drafts[draftCursor];
    draftCursor++;

    // Skip the case where the body is effectively empty — no message
    // content to wrap. The cursor has already advanced (above), so the
    // pairing for subsequent sections stays correct.
    if (bodyHtml.replace(/\s+/g, "").length === 0) {
      sections[i] = section;
      continue;
    }

    // If a Subject paragraph sits inside the body region, leave it inside —
    // it's metadata adjacent to the message but logically part of the draft
    // header. The wrapper still encloses everything between Send-to and the
    // body-end markers.

    const actionsHtml = renderDraftActions(target, subject, {
      draft,
      editable: opts.editable,
      slackEnabled: opts.slackEnabled,
      directory: opts.directory,
      slack: opts.slack,
    });

    const wrapperClasses = ["draft-body-region", `draft-body-${draft?.kind || "unknown"}`];
    if (draft?.alreadySent) wrapperClasses.push("draft-sent-region");
    const wrapperAttrs = draft
      ? ` data-draft-index="${draft.index}" data-draft-kind="${draft.kind}"`
      : "";

    // v0.9.1: body region rendering is uniform (a plain <div>) for both
    // sent and active drafts. The "what to collapse" decision moves up
    // a level to the whole-section wrapper applied AFTER this loop —
    // see wrapSentDraftSections below.
    const wrappedBody = `<div class="${wrapperClasses.join(" ")}"${wrapperAttrs}>${bodyHtml}</div>${actionsHtml}`;

    // v0.9.3: normalize Grounding styling for BOTH active and sent drafts.
    // For active drafts, the action bar lands above the (collapsed) Grounding
    // — Copy / Edit / Send-to-Slack stay glanceable next to the message
    // text. For sent drafts, the whole section gets wrapped below in
    // wrapSentDraftSections, but inside that wrapper the Grounding still
    // benefits from the cockpit's collapsible chevron + hover treatment.
    // (The legacy form converts <p><strong>Grounding</strong></p>+list into
    // <details>; the v3.3.0+ form is already <details> and just gets the
    // class names added.)
    const finalTail = collapseGroundingInTail(tail);

    sections[i] = before + wrappedBody + finalTail;
  }

  return sections.join("");
}

/**
 * Normalize the Grounding block in the tail (post-body region) to use the
 * cockpit's collapsible styling.
 *
 * Two source forms are accepted:
 *   1. Legacy: `<p><strong>Grounding:</strong></p>` + `<ul>/<ol>` —
 *      we wrap both into a single `<details><summary>...` block.
 *   2. v3.3.0+: native `<details><summary>Grounding (N facts verified)</summary>...</details>`
 *      already produced by the synthesis-slack-sync template — we just
 *      decorate the existing `<details>` and `<summary>` with our class
 *      names so the cockpit's `.cockpit-grounding-collapsible` /
 *      `.cockpit-grounding-summary` styling applies (chevron, padding,
 *      hover, transition).
 *
 * Returns the tail string with the Grounding portion normalized if found,
 * otherwise the tail unchanged.
 */
function collapseGroundingInTail(tail: string): string {
  // Form 2 (v3.3.0+): native <details><summary>Grounding...</summary>...</details>
  // produced by `synthesis-slack-sync/templates/draft-block.md`. Add our
  // class names without otherwise touching the structure.
  const nativeRe = /<details(?![^>]*\bclass\s*=)([^>]*)>\s*<summary([^>]*)>\s*(Grounding\b[^<]*)<\/summary>/i;
  const nativeMatch = tail.match(nativeRe);
  if (nativeMatch) {
    return tail.replace(
      nativeRe,
      `<details$1 class="cockpit-grounding-collapsible"><summary$2 class="cockpit-grounding-summary">$3</summary>`
    );
  }

  // Form 1 (legacy): <p><strong>Grounding:</strong></p> + <ul>/<ol> —
  // build the full <details> wrapper.
  const groundingRe = /(<p>\s*<strong>\s*Grounding\s*:?\s*<\/strong>\s*<\/p>)\s*(<(?:ul|ol)\b[\s\S]*?<\/(?:ul|ol)>)/i;
  const m = tail.match(groundingRe);
  if (!m || m.index === undefined) return tail;
  const before = tail.slice(0, m.index);
  const after = tail.slice(m.index + m[0].length);
  const list = m[2];
  const itemCount = (list.match(/<li\b/gi) || []).length;
  const summaryLabel = itemCount > 0 ? `Grounding (${itemCount} item${itemCount === 1 ? "" : "s"})` : "Grounding";
  const wrapped = `<details class="cockpit-grounding-collapsible"><summary class="cockpit-grounding-summary">${summaryLabel}</summary>${list}</details>`;
  return before + wrapped + after;
}

/**
 * Public entry point for the cockpit view: wrap each sent draft's section
 * (heading + content) in a one-line collapsible `<details>`. Operates on
 * the DRAFTS-region HTML (the output of `collectAllDraftSections`), NOT on
 * the full document. The Full Markdown collapsible at the bottom of the
 * cockpit deliberately gets the unwrapped form as an escape hatch.
 *
 * Second-pass: for each sent draft (identified by the presence of a
 * `.draft-actions-sent` div in a section), wrap the section's heading and
 * the section's content in a single `<details class="cockpit-sent-section">`.
 *
 * The summary is one line: ✓ + clean title (strikethrough + SENT metadata
 * stripped) + sent time/channel suffix (when extractable) + a "View in Slack"
 * permalink when the parsed sent metadata supplied one.
 *
 * Default state is closed — done drafts collapse fully and don't crowd the
 * glance. Click the summary to expand the section's full content (Send-to,
 * body, action bar, Grounding, etc.).
 */
export function wrapSentDraftSections(html: string, drafts: DraftBlock[]): string {
  // Split by H1-H6 — same approach as augmentDraftBlocks, so we can pair
  // each section content with its preceding heading.
  const parts = html.split(/(<h[1-6][^>]*>[\s\S]*?<\/h[1-6]>)/);
  const sentByIndex = new Map<number, DraftBlock>();
  let draftCursor = 0;

  // Build a draft-section iterator so we know which section index in the
  // sections array corresponds to each draft.
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (!part || /^<h[1-6]/.test(part)) continue;
    if (!/<p>\s*<strong>(?:Send to|Channel):?<\/strong>/i.test(part)) continue;
    const draft = drafts[draftCursor];
    draftCursor++;
    if (draft?.alreadySent) sentByIndex.set(i, draft);
  }

  if (sentByIndex.size === 0) return html;

  // Walk again and wrap H3+content for each sent section.
  for (const [contentIdx, draft] of sentByIndex) {
    const headingIdx = contentIdx - 1;
    if (headingIdx < 0 || !parts[headingIdx]) continue;
    const headingHtml = parts[headingIdx];
    const headingMatch = headingHtml.match(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/);
    if (!headingMatch) continue;
    const headingTag = headingMatch[1];
    const rawTitle = headingMatch[2];
    const cleanTitle = stripSentDecorations(rawTitle);

    const sentMeta = buildSentMeta(draft);
    const summary = `
      <summary class="cockpit-sent-summary">
        <span class="cockpit-sent-checkmark" aria-hidden="true">✓</span>
        <span class="cockpit-sent-title">${cleanTitle}</span>
        ${sentMeta.metaText ? `<span class="cockpit-sent-meta">${sentMeta.metaText}</span>` : ""}
        ${sentMeta.permalink ? `<a class="cockpit-sent-link" href="${escapeAttr(sentMeta.permalink)}" target="_blank" rel="noopener" onclick="event.stopPropagation();">View in Slack</a>` : ""}
      </summary>
    `.trim();

    parts[headingIdx] = `<details class="cockpit-sent-section" data-draft-index="${draft.index}">${summary}<div class="cockpit-sent-content"><${headingTag} class="cockpit-sent-original-heading">${rawTitle}</${headingTag}>`;
    parts[contentIdx] = parts[contentIdx] + `</div></details>`;
  }

  return parts.join("");
}

/**
 * Strip strikethrough wrapping and the legacy "✅ SENT by..." metadata from
 * an H3 heading text so the sent-section summary shows a clean title.
 */
function stripSentDecorations(headingHtml: string): string {
  return headingHtml
    .replace(/<del>([\s\S]*?)<\/del>/gi, "$1")    // <del>...</del>
    .replace(/<s>([\s\S]*?)<\/s>/gi, "$1")        // <s>...</s>
    .replace(/✅[\s\S]*?(?:SENT|sent)[\s\S]*$/, "")
    .replace(/\bSENT\b[\s\S]*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build the sent-state metadata string for the summary line: a compact
 * "sent <time> · <channel>" string plus an optional permalink. Extracted
 * from the DraftBlock's parsed sent fields (sentAt, sentTs, sentPermalink)
 * + the sendToText for the channel name.
 */
function buildSentMeta(draft: DraftBlock): { metaText: string; permalink?: string } {
  const parts: string[] = [];
  if (draft.sentAt) parts.push(escapeHtml(`sent ${draft.sentAt}`));
  // Pull a #channel-name from sendToText if present.
  const channelMatch = draft.sendToText?.match(/#([a-zA-Z][\w-]+)/);
  if (channelMatch) parts.push(`#${escapeHtml(channelMatch[1])}`);
  // For DM drafts, surface the recipient name if extractable.
  const dmMatch = draft.sendToText?.match(/(?:DM with|@)\s*([A-Za-z][A-Za-z\s.'-]+?)(?:\s*\(|\s*$|\s*—)/);
  if (!channelMatch && dmMatch) parts.push(`DM ${escapeHtml(dmMatch[1].trim())}`);
  return {
    metaText: parts.join(" · "),
    permalink: draft.sentPermalink,
  };
}

/**
 * Render a JSON island carrying the source's Slack directory so the client-side
 * Smart Copy and Send handlers can resolve display names to canonical mention
 * syntax without a server round-trip per draft.
 *
 * Inside a `<script type="application/json">` tag, the browser does NOT do
 * HTML entity decoding — the content is read as-is by `.textContent`. The only
 * sequences we must guard against are those that could close the surrounding
 * script tag prematurely or be interpreted as HTML comment/CDATA boundaries.
 */
export function renderDirectoryIsland(directory: SlackDirectory): string {
  if (directory.users.length === 0 && directory.channels.length === 0) return "";
  const payload = {
    users: directory.users.map((u) => ({ id: u.id, name: u.name, aliases: u.aliases || [] })),
    channels: directory.channels.map((c) => ({ id: c.id, name: c.name })),
  };
  const json = JSON.stringify(payload)
    .replace(/<\/script/gi, "<\\/script")
    .replace(/<!--/g, "<\\!--");
  return `<script id="slack-directory" type="application/json">${json}</script>`;
}
