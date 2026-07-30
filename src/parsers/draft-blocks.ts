/**
 * Draft block parser for daily plans.
 *
 * Operates on raw markdown source — independent of the rendered HTML — so the
 * results survive any rendering changes downstream. A "draft" is the body
 * region of a heading-bounded section that contains a `**Send to:**` (or
 * `**Channel:**`) paragraph.
 *
 * Body region (v0.8.5+)
 * ---------------------
 * The body region spans from the line AFTER the `**Send to:**` paragraph (and
 * any optional `**Subject:**` paragraph) through the line BEFORE any of these
 * end-of-body markers, in priority order:
 *
 *   - The next heading (h1–h6) — boundary inherited from sectionEndLine
 *   - A `**Sent:**` paragraph — marks an already-sent draft
 *   - A `**Grounding:**` paragraph — marks the start of metadata about the draft
 *   - End of file
 *
 * The region may be a single fenced code block, a single blockquote, OR a
 * heterogeneous sequence of fences + blockquotes + paragraphs + lists. The
 * parser detects an "outer wrapper" only when the entire region is exactly one
 * fence or exactly one blockquote.
 *
 * Field semantics
 * ---------------
 * Two parallel ranges are tracked, both inclusive:
 *
 *   regionStartLine, regionEndLine — the FULL body region, including any
 *     outer fence/blockquote markers. Used by augmentDraftBlocks to attach
 *     the action bar at the end of the body and by markDraftAsSent to insert
 *     the **Sent:** marker at the right place.
 *
 *   bodyStartLine, bodyEndLine — the EDITABLE inner content. For "fenced"
 *     drafts, this excludes the open/close fence lines; for "blockquote",
 *     this is the same as the region but bodyText has `>` prefixes stripped;
 *     for "multi-segment", this equals the region.
 *
 *   bodyText — what the user edits in the Edit textarea, and the
 *     compare-and-swap fingerprint. Per kind: inside-fence content; `>`-
 *     stripped blockquote content; verbatim region for multi-segment.
 *
 * For multi-segment bodies (Postel's Law for the structural axis): the
 * Copy/Send paths emit bodyText verbatim — any internal triple-backtick
 * fences pass through to Slack, which renders them as Slack code blocks.
 *
 * The contract with synthesis-daily-rituals (the producer skill) lives in
 *   - synthesis-console/docs/cockpit-design.md (vocabulary + body shapes)
 *   - synthesis-skills/synthesis-daily-rituals/SKILL.md (canonical fence forms)
 * Drift between them is the bug source — they must change together.
 */
import MarkdownIt from "markdown-it";

export type DraftKind = "fenced" | "blockquote" | "multi-segment";

export interface DraftBlock {
  /** 0-based position in document order. */
  index: number;
  /**
   * Editable inner content. For "fenced": inside the fence. For "blockquote":
   * `>`-stripped content. For "multi-segment": same as the full region. The
   * compare-and-swap fingerprint and the Edit textarea source.
   */
  bodyText: string;
  kind: DraftKind;
  /**
   * Inclusive line range of the editable inner content (matches bodyText).
   * For "fenced": between the open and close fence (exclusive). For
   * "blockquote": full blockquote range (inclusive). For "multi-segment":
   * full region range.
   */
  bodyStartLine: number;
  bodyEndLine: number;
  /**
   * Inclusive line range of the FULL body region, including any outer
   * fence/blockquote markers. Used by augmentDraftBlocks (action bar
   * attachment), markDraftAsSent (marker insertion), and the rendered HTML
   * wrapper.
   */
  regionStartLine: number;
  regionEndLine: number;
  /** Line of the opening fence — only set for kind="fenced". */
  fenceLine?: number;
  /** Markup of the outer fence (e.g. "```" or "````") — only set for kind="fenced". */
  fenceMarkup?: string;
  /** Raw text after `**Send to:**` (or `**Channel:**`) in the markdown source. */
  sendToText?: string;
  /** Raw text after `**Subject:**` if present. */
  subjectText?: string;
  /**
   * 0-based line of the section's heading (h1-h6 immediately preceding this draft).
   * Used by the send endpoint to append a `**Sent:**` marker after the body.
   */
  sectionHeadingLine?: number;
  /** 0-based line one past the end of the section (heading exclusive of next). */
  sectionEndLine?: number;
  /** True if a `**Sent:**` marker is already present in this section. */
  alreadySent: boolean;
  /** Parsed `**Sent:**` ISO timestamp, if any. */
  sentAt?: string;
  /** Parsed Slack permalink from a `**Sent:**` marker, if any. */
  sentPermalink?: string;
  /** Parsed Slack message TS from a `**Sent:**` marker, if any. */
  sentTs?: string;
  /** True if a `**Skipped:**` marker is present (v0.10 NEEDS YOU write-back). */
  alreadySkipped: boolean;
  /** Timestamp label from the `**Skipped:**` marker, if any. */
  skippedAt?: string;
}

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

const SEND_TO_INLINE_RE = /^\s*\*\*\s*(?:Send to|Channel)\s*:?\s*\*\*/i;
const SUBJECT_INLINE_RE = /^\s*\*\*\s*Subject\s*:?\s*\*\*/i;
const SENT_INLINE_RE = /^\s*\*\*\s*Sent(?:\s*at)?\s*:?\s*\*\*/i;
// v0.10 (Cockpit Mode): NEEDS YOU one-tap queue records dismissed drafts
// with a `**Skipped:**` paragraph parallel to `**Sent:**`. Format:
//   `**Skipped:** HH:MM TZ` (short form written by the /skip endpoint).
// Presence of a Skipped marker gates the same "don't re-surface" behavior
// Sent gets, and dims the card without deleting body text.
const SKIPPED_INLINE_RE = /^\s*\*\*\s*Skipped(?:\s*at)?\s*:?\s*\*\*/i;
const GROUNDING_INLINE_RE = /^\s*\*\*\s*Grounding\s*:?\s*\*\*/i;

interface ParagraphMeta {
  startLine: number;
  endLineExclusive: number;
  text: string;
}

export function findDraftBlocks(raw: string): DraftBlock[] {
  const tokens = md.parse(raw, {});
  const lines = raw.split("\n");
  const drafts: DraftBlock[] = [];

  // Pre-compute heading line ranges so each section knows its end line.
  const headingLines: number[] = [];
  for (const t of tokens) {
    if (t.type === "heading_open" && t.map) headingLines.push(t.map[0]);
  }

  function endLineOfSectionStartingAt(headingLine: number): number {
    const idx = headingLines.indexOf(headingLine);
    if (idx >= 0 && idx + 1 < headingLines.length) {
      return headingLines[idx + 1] - 1;
    }
    return lines.length - 1;
  }

  // Pre-compute paragraphs (start/end + inline text) so we can recognize the
  // **Send to:** / **Subject:** / **Sent:** / **Grounding:** markers and
  // their line spans.
  const paragraphs: ParagraphMeta[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "paragraph_open" && t.map && tokens[i + 1]?.type === "inline") {
      paragraphs.push({
        startLine: t.map[0],
        endLineExclusive: t.map[1],
        text: tokens[i + 1].content,
      });
    }
  }

  let currentSectionHeading: number | undefined;
  let currentSectionEnd: number | undefined;
  let pendingSendToInSection: ParagraphMeta | undefined;
  let pendingSubjectInSection: ParagraphMeta | undefined;

  function emitForCurrentSendTo(): void {
    if (!pendingSendToInSection || currentSectionHeading === undefined) return;
    const sendTo = pendingSendToInSection;
    const subject = pendingSubjectInSection;
    const sectionEnd = currentSectionEnd ?? lines.length - 1;

    // Body region: starts after Send-to (and Subject if Subject follows
    // Send-to and lives before the body).
    let regionStart = sendTo.endLineExclusive;
    if (
      subject &&
      subject.startLine >= sendTo.endLineExclusive &&
      subject.endLineExclusive <= sectionEnd + 1
    ) {
      regionStart = Math.max(regionStart, subject.endLineExclusive);
    }

    // Skip leading blank lines — they're separators, not content.
    while (regionStart <= sectionEnd && (lines[regionStart] ?? "").trim() === "") {
      regionStart++;
    }

    // Body ends BEFORE the first end-marker paragraph (Sent or Grounding) in
    // the section, or at sectionEnd if none.
    //
    // Grounding has TWO valid forms (producer-consumer contract has been
    // updated to ship native HTML5 collapsibles in v3.3.0+ of the
    // synthesis-slack-sync template):
    //   1. Legacy paragraph: `**Grounding:** ...` — caught by the
    //      paragraphs loop below via GROUNDING_INLINE_RE.
    //   2. v3.3.0+ native: `<details><summary>Grounding (...)</summary>`
    //      starts an HTML block, NOT a markdown paragraph. markdown-it
    //      tokenizes it as `html_block`, not `paragraph_open`, so the
    //      paragraphs loop never sees it. We scan the raw lines directly
    //      to find the opening `<details>` line and clamp regionEnd
    //      accordingly. Without this, the body region for "multi-segment"
    //      drafts engulfs the entire Grounding block and bodyText (the
    //      data carried by Copy / Send) includes the verification trail
    //      AND any `<hr>` separators before the next H3.
    let regionEnd = sectionEnd;
    let sentMarkerParagraph: ParagraphMeta | undefined;
    let skippedMarkerParagraph: ParagraphMeta | undefined;
    for (const p of paragraphs) {
      if (p.startLine < regionStart || p.startLine > sectionEnd) continue;
      if (SENT_INLINE_RE.test(p.text)) {
        regionEnd = Math.min(regionEnd, p.startLine - 1);
        sentMarkerParagraph = p;
        break;
      }
      if (SKIPPED_INLINE_RE.test(p.text)) {
        regionEnd = Math.min(regionEnd, p.startLine - 1);
        skippedMarkerParagraph = p;
        break;
      }
      if (GROUNDING_INLINE_RE.test(p.text)) {
        regionEnd = Math.min(regionEnd, p.startLine - 1);
        break;
      }
    }
    // Form 2 (v3.3.0+): scan raw lines for `<details><summary>Grounding...`
    // or `<details>` followed within a few lines by `<summary>Grounding`.
    // Use whichever opening comes first as the body-end boundary.
    const groundingDetailsRe = /<details(?:\s[^>]*)?>\s*<summary[^>]*>\s*Grounding\b/i;
    for (let k = regionStart; k <= sectionEnd; k++) {
      const ln = lines[k] ?? "";
      if (groundingDetailsRe.test(ln)) {
        regionEnd = Math.min(regionEnd, k - 1);
        break;
      }
      // Also handle the multi-line variant where <details> is on one line
      // and <summary>Grounding... is on the next (markdown-friendly form):
      //   <details>
      //   <summary>Grounding (5 facts verified)</summary>
      if (/^\s*<details(?:\s[^>]*)?>\s*$/i.test(ln)) {
        const next = (lines[k + 1] ?? "").trim();
        if (/^<summary[^>]*>\s*Grounding\b/i.test(next)) {
          regionEnd = Math.min(regionEnd, k - 1);
          break;
        }
      }
    }

    // Trim trailing blank lines.
    while (regionEnd >= regionStart && (lines[regionEnd] ?? "").trim() === "") {
      regionEnd--;
    }

    // Detect outer wrapper: exactly one fenced block or exactly one blockquote
    // spanning the whole region.
    const wrapper = detectOuterWrapper(tokens, regionStart, regionEnd);

    let bodyText = "";
    let bodyStartLine = regionStart;
    let bodyEndLine = regionEnd;
    let kind: DraftKind = "multi-segment";

    if (regionEnd >= regionStart) {
      if (wrapper.kind === "fenced") {
        // bodyText excludes the open and close fence lines.
        kind = "fenced";
        bodyStartLine = regionStart + 1;
        bodyEndLine = regionEnd - 1;
        if (bodyEndLine >= bodyStartLine) {
          bodyText = lines.slice(bodyStartLine, bodyEndLine + 1).join("\n");
        }
      } else if (wrapper.kind === "blockquote") {
        // bodyText has the leading `>` (and one optional space) stripped.
        kind = "blockquote";
        const bodyLines: string[] = [];
        for (let k = regionStart; k <= regionEnd; k++) {
          const ln = lines[k] ?? "";
          const m = ln.match(/^(\s*)>\s?(.*)$/);
          bodyLines.push(m ? m[2] : ln);
        }
        bodyText = bodyLines.join("\n");
      } else {
        // Multi-segment: bodyText is the verbatim region.
        kind = "multi-segment";
        bodyText = lines.slice(regionStart, regionEnd + 1).join("\n");
      }
    }

    const draftIndex = drafts.length;
    const draft: DraftBlock = {
      index: draftIndex,
      bodyText,
      kind,
      bodyStartLine,
      bodyEndLine,
      regionStartLine: regionStart,
      regionEndLine: regionEnd,
      fenceLine: kind === "fenced" ? regionStart : undefined,
      fenceMarkup: kind === "fenced" ? wrapper.fenceMarkup : undefined,
      sendToText: sendTo.text.replace(SEND_TO_INLINE_RE, "").trim(),
      subjectText: subject ? subject.text.replace(SUBJECT_INLINE_RE, "").trim() : undefined,
      sectionHeadingLine: currentSectionHeading,
      sectionEndLine: currentSectionEnd,
      alreadySent: false,
      alreadySkipped: false,
    };

    if (skippedMarkerParagraph) {
      const tail = skippedMarkerParagraph.text.replace(SKIPPED_INLINE_RE, "").trim();
      draft.alreadySkipped = true;
      draft.skippedAt = tail || undefined;
    }

    if (sentMarkerParagraph) {
      // Canonical form (synthesis-slack-sync v3.2.0+, synthesis-console
      // markDraftAsSent): a `**Sent:**` paragraph below the body.
      const tail = sentMarkerParagraph.text.replace(SENT_INLINE_RE, "").trim();
      draft.alreadySent = true;
      draft.sentAt = parseSentTimestamp(tail);
      draft.sentTs = parseSentTs(tail);
      draft.sentPermalink = parseSentPermalink(tail);
    } else if (currentSectionHeading !== undefined) {
      // Legacy form (pre-v3.2.0 synthesis-slack-sync): the SENT marker is
      // baked into the H3 heading text. Examples seen in real plans:
      //   ### ~~Draft N: title~~ ✅ SENT by Rajiv at Thu Apr 2 6:16 PM EDT in #channel
      //   ### Draft N: title (sent)
      //   ### ~~Draft N: title~~
      // Treat any of these signals as sent — false positives are unlikely
      // because uppercase SENT and full-title strikethrough are unusual in
      // active draft headings.
      const h3Line = lines[currentSectionHeading] ?? "";
      const h3IndicatesSent = /\bSENT\b/.test(h3Line) || /~~[^\n]+~~/.test(h3Line);
      if (h3IndicatesSent) {
        draft.alreadySent = true;
        // Best-effort metadata extraction from the H3 tail. Human-readable
        // dates ("Thu Apr 2 6:16 PM EDT") won't match the ISO regex; that's
        // OK — the sent badge will render as just "Sent" without a time.
        draft.sentAt = parseSentTimestamp(h3Line);
        draft.sentTs = parseSentTs(h3Line);
        draft.sentPermalink = parseSentPermalink(h3Line);
      }
    }

    drafts.push(draft);

    pendingSendToInSection = undefined;
    pendingSubjectInSection = undefined;
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_open" && t.map) {
      // Closing the previous section: emit the pending Send-to (if any).
      emitForCurrentSendTo();
      currentSectionHeading = t.map[0];
      currentSectionEnd = endLineOfSectionStartingAt(currentSectionHeading);
      pendingSendToInSection = undefined;
      pendingSubjectInSection = undefined;
      continue;
    }

    if (t.type === "paragraph_open" && t.map && tokens[i + 1]?.type === "inline") {
      const inline = tokens[i + 1].content;
      const meta: ParagraphMeta = {
        startLine: t.map[0],
        endLineExclusive: t.map[1],
        text: inline,
      };
      if (SEND_TO_INLINE_RE.test(inline)) {
        // One Send-to per section (per existing convention). If a second one
        // appears, emit the pending one first and start fresh.
        if (pendingSendToInSection) emitForCurrentSendTo();
        pendingSendToInSection = meta;
      } else if (SUBJECT_INLINE_RE.test(inline)) {
        pendingSubjectInSection = meta;
      }
    }
  }

  // Flush any remaining pending Send-to at end-of-document.
  emitForCurrentSendTo();

  return drafts;
}

/**
 * Detect whether a body region is wrapped by exactly one fenced code block or
 * exactly one blockquote. Returns the kind + fence markup, or { kind:
 * undefined } when the region has multiple top-level blocks (multi-segment).
 */
function detectOuterWrapper(
  tokens: ReturnType<typeof md.parse>,
  regionStart: number,
  regionEnd: number
): { kind?: "fenced" | "blockquote"; fenceMarkup?: string } {
  if (regionEnd < regionStart) return {};

  interface TopBlock {
    type: string;
    startLine: number;
    endLineExclusive: number;
    markup?: string;
  }
  const topBlocks: TopBlock[] = [];

  let depth = 0;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (
      t.type === "blockquote_open" ||
      t.type === "bullet_list_open" ||
      t.type === "ordered_list_open"
    ) {
      if (depth === 0 && t.map) {
        let closeIdx = -1;
        let inner = depth + 1;
        const closeType =
          t.type === "blockquote_open"
            ? "blockquote_close"
            : t.type === "bullet_list_open"
              ? "bullet_list_close"
              : "ordered_list_close";
        for (let j = i + 1; j < tokens.length; j++) {
          if (tokens[j].type === t.type) inner++;
          if (tokens[j].type === closeType) {
            inner--;
            if (inner === 0) {
              closeIdx = j;
              break;
            }
          }
        }
        const endExclusive =
          closeIdx >= 0 && tokens[closeIdx].map ? tokens[closeIdx].map![1] : t.map[1];
        topBlocks.push({
          type: t.type === "blockquote_open" ? "blockquote" : "list",
          startLine: t.map[0],
          endLineExclusive: endExclusive,
        });
      }
      depth++;
      continue;
    }
    if (
      t.type === "blockquote_close" ||
      t.type === "bullet_list_close" ||
      t.type === "ordered_list_close"
    ) {
      depth--;
      continue;
    }
    if (depth > 0) continue;
    if (!t.map) continue;
    if (t.type === "fence") {
      topBlocks.push({
        type: "fence",
        startLine: t.map[0],
        endLineExclusive: t.map[1],
        markup: t.markup,
      });
    } else if (
      t.type === "paragraph_open" ||
      t.type === "heading_open" ||
      t.type === "code_block" ||
      t.type === "html_block" ||
      t.type === "table_open" ||
      t.type === "hr"
    ) {
      let endExclusive = t.map[1];
      const closeMap: Record<string, string> = {
        paragraph_open: "paragraph_close",
        heading_open: "heading_close",
        table_open: "table_close",
      };
      const closeType = closeMap[t.type];
      if (closeType) {
        for (let j = i + 1; j < tokens.length; j++) {
          const closeToken = tokens[j];
          if (closeToken.type === closeType && closeToken.map) {
            endExclusive = closeToken.map[1];
            break;
          }
        }
      }
      topBlocks.push({
        type: t.type.replace(/_open$/, ""),
        startLine: t.map[0],
        endLineExclusive: endExclusive,
      });
    }
  }

  const regionEndExclusive = regionEnd + 1;
  const inside = topBlocks.filter(
    (b) => b.startLine >= regionStart && b.endLineExclusive <= regionEndExclusive
  );

  if (inside.length !== 1) return {};
  const single = inside[0];
  if (single.startLine !== regionStart || single.endLineExclusive !== regionEndExclusive) {
    return {};
  }
  if (single.type === "fence") return { kind: "fenced", fenceMarkup: single.markup };
  if (single.type === "blockquote") return { kind: "blockquote" };
  return {};
}

/**
 * Compare-and-swap replacement of a draft's editable inner content. Returns
 * the new full markdown if the original body matches what's currently on disk
 * for the given draft index, otherwise returns a reason. Caller writes the
 * result to disk.
 *
 * Kind-aware behavior:
 *   - "fenced"        — replaces lines between the open and close fences.
 *                       The user edits inner content; the fence markers stay.
 *   - "blockquote"    — re-prefixes newBody lines with `> ` to keep the
 *                       blockquote shape.
 *   - "multi-segment" — replaces the entire region verbatim. The user edits
 *                       the raw markdown of the body region as-is.
 */
export function replaceDraftBody(
  raw: string,
  draftIndex: number,
  originalBody: string,
  newBody: string
):
  | { ok: true; newRaw: string }
  | { ok: false; reason: "not-found" | "conflict" | "empty" } {
  if (newBody.trim().length === 0) {
    return { ok: false, reason: "empty" };
  }

  const drafts = findDraftBlocks(raw);
  const draft = drafts[draftIndex];
  if (!draft) return { ok: false, reason: "not-found" };

  if (canonicalize(draft.bodyText) !== canonicalize(originalBody)) {
    return { ok: false, reason: "conflict" };
  }

  const lines = raw.split("\n");

  let newBodyLines: string[];
  if (draft.kind === "blockquote") {
    newBodyLines = newBody.split("\n").map((l) => (l.length === 0 ? ">" : "> " + l));
  } else {
    newBodyLines = newBody.split("\n");
  }

  const before = lines.slice(0, draft.bodyStartLine);
  // bodyEndLine can be < bodyStartLine for empty bodies; slice handles that gracefully.
  const after = lines.slice(Math.max(draft.bodyEndLine + 1, draft.bodyStartLine));
  const newLines = [...before, ...newBodyLines, ...after];

  return { ok: true, newRaw: newLines.join("\n") };
}

/**
 * Append a `**Sent:** ...` marker after the draft body. Idempotent.
 *
 * The marker is inserted at regionEndLine + 1 — i.e. directly after the last
 * line of the body region (which is the close fence for "fenced", the last
 * `>` line for "blockquote", or the last content line for "multi-segment").
 * A leading blank line is inserted unless one is already present.
 */
export function markDraftAsSent(
  raw: string,
  draftIndex: number,
  meta: { ts: string; permalink?: string; sentAtIso: string }
):
  | { ok: true; newRaw: string }
  | { ok: false; reason: "not-found" | "already-sent" } {
  const drafts = findDraftBlocks(raw);
  const draft = drafts[draftIndex];
  if (!draft) return { ok: false, reason: "not-found" };
  if (draft.alreadySent) return { ok: false, reason: "already-sent" };

  const lines = raw.split("\n");
  const insertAt = draft.regionEndLine + 1;

  const permalinkPart = meta.permalink ? ` ${meta.permalink}` : "";
  const sentLine = `**Sent:** ${meta.sentAtIso} (TS=${meta.ts})${permalinkPart}`;

  const needsLeadingBlank = (lines[insertAt - 1] ?? "").trim() !== "";
  const block = needsLeadingBlank ? ["", sentLine] : [sentLine];

  const newLines = [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)];
  return { ok: true, newRaw: newLines.join("\n") };
}

/**
 * Append a `**Skipped:** ...` marker after the draft body. Idempotent.
 *
 * Written by POST /plans/:source/:date/draft/:index/skip when the user
 * dismisses a NEEDS YOU one-tap draft. The file records the decision so
 * cross-day rollover skips it, `alreadySkipped` renders the card as dimmed
 * without deleting the body, and any future re-sync sees the intentional
 * dismissal instead of re-queueing.
 *
 * Fails when a `**Sent:**` marker is already present — sent drafts must be
 * explicitly unsent before being skipped, since the two states are exclusive
 * and Skipped-after-Sent would be a data error.
 */
export function markDraftAsSkipped(
  raw: string,
  draftIndex: number,
  skippedAtLocal: string
):
  | { ok: true; newRaw: string }
  | { ok: false; reason: "not-found" | "already-sent" | "already-skipped" | "invalid-input" } {
  if (!skippedAtLocal || skippedAtLocal.length > 60) {
    return { ok: false, reason: "invalid-input" };
  }
  const drafts = findDraftBlocks(raw);
  const draft = drafts[draftIndex];
  if (!draft) return { ok: false, reason: "not-found" };
  if (draft.alreadySent) return { ok: false, reason: "already-sent" };
  if (draft.alreadySkipped) return { ok: false, reason: "already-skipped" };

  const lines = raw.split("\n");
  const insertAt = draft.regionEndLine + 1;
  const skippedLine = `**Skipped:** ${skippedAtLocal}`;
  const needsLeadingBlank = (lines[insertAt - 1] ?? "").trim() !== "";
  const block = needsLeadingBlank ? ["", skippedLine] : [skippedLine];
  const newLines = [...lines.slice(0, insertAt), ...block, ...lines.slice(insertAt)];
  return { ok: true, newRaw: newLines.join("\n") };
}

/**
 * Reverse a `**Skipped:** ...` marker. Symmetric to unmarkTaskDone.
 * Removes the marker paragraph and the immediately preceding blank line,
 * if any. Fails if the draft is not skipped or was never marked with the
 * canonical shape.
 */
export function unmarkDraftAsSkipped(
  raw: string,
  draftIndex: number
):
  | { ok: true; newRaw: string }
  | { ok: false; reason: "not-found" | "not-skipped" } {
  const drafts = findDraftBlocks(raw);
  const draft = drafts[draftIndex];
  if (!draft) return { ok: false, reason: "not-found" };
  if (!draft.alreadySkipped) return { ok: false, reason: "not-skipped" };

  // Locate the `**Skipped:**` line at or right after regionEndLine + 1.
  // The parser already validated its presence; re-scan the source to find
  // the exact line number so we can splice it out.
  const lines = raw.split("\n");
  let markerLine = -1;
  const searchStart = draft.regionEndLine + 1;
  const searchEnd = Math.min(lines.length - 1, (draft.sectionEndLine ?? lines.length - 1));
  for (let i = searchStart; i <= searchEnd; i++) {
    if (SKIPPED_INLINE_RE.test(lines[i] ?? "")) {
      markerLine = i;
      break;
    }
  }
  if (markerLine < 0) return { ok: false, reason: "not-skipped" };

  // Drop the marker line. If the line before it is blank AND the line
  // after it is also blank (or EOF), drop one of the blanks so we don't
  // leave a double-blank hole.
  const dropStart = markerLine > 0 && (lines[markerLine - 1] ?? "").trim() === "" ? markerLine - 1 : markerLine;
  const dropEnd = markerLine; // inclusive
  const before = lines.slice(0, dropStart);
  const after = lines.slice(dropEnd + 1);
  return { ok: true, newRaw: [...before, ...after].join("\n") };
}

function parseSentTimestamp(s: string): string | undefined {
  const isoMatch = s.match(/(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2})?(?:\s*\w{2,5})?)/);
  return isoMatch ? isoMatch[1].trim() : undefined;
}

function parseSentTs(s: string): string | undefined {
  const m = s.match(/TS\s*[=:]\s*([\d.]+)/i);
  return m ? m[1] : undefined;
}

function parseSentPermalink(s: string): string | undefined {
  const m = s.match(/(https?:\/\/[^\s)]+)/);
  return m ? m[1] : undefined;
}

function canonicalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\s+$/g, "").replace(/[ \t]+\n/g, "\n");
}
