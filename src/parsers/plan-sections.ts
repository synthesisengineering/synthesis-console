/**
 * Plan section detector for the daily plan cockpit view.
 *
 * Walks markdown-it tokens from a daily plan file and produces a typed
 * structure describing the eight section kinds the cockpit recognizes:
 *   header / decisions / priority-tasks / drafts / briefing / standup /
 *   sent-messages / waiting / pr-queue / sync-state / completed / other
 *
 * Operates on raw markdown source — independent of rendered HTML — so the
 * results survive any rendering changes downstream and so the line numbers
 * stay valid for compare-and-swap mutation. This mirrors the discipline of
 * draft-blocks.ts.
 *
 * Heading detection is substring + case-insensitive against a known
 * vocabulary. The first match wins. Anything not matched falls into `other`
 * and renders as plain markdown — the cockpit never refuses to display a
 * section just because the heading vocabulary is novel.
 */
import MarkdownIt from "markdown-it";

export type SectionKind =
  | "header"
  | "decisions"
  | "decision-needed"      // v0.10 (Cockpit Mode) — a priority-1 decision surfaced above regular decisions
  | "one-tap-batch"        // v0.10 (Cockpit Mode) — the Tier-B queue: drafts + light decisions for batch review
  | "ticker"               // v0.10 (Cockpit Mode) — "## On your behalf" digest of Tier-A actions
  | "priority-tasks"
  | "drafts"
  | "briefing"
  | "brief"                // v0.11 (Cockpit Mode) — "## Brief" ≤90-second morning narrative
  | "standup"
  | "sent-messages"
  | "waiting"
  | "pr-queue"
  | "sync-state"
  | "completed"
  | "today"                // v0.12 (Cockpit Mode) — "## Today — N deep items" Tier-C slots
  | "calendar"             // v0.12 (Cockpit Mode) — "## Calendar" — ritual-fetched events
  | "prep-packs"           // v0.13 (Cockpit Mode) — "## Prep packs" — index of today's meeting-prep files
  | "other";

export type TaskSemantic = "p0" | "p1" | "p2" | "watch" | "stale" | "other";

export interface PlanSection {
  kind: SectionKind;
  /** 0-based line of the H2 heading (or -1 for the synthetic "header" pre-section). */
  headingLine: number;
  /** 0-based exclusive end line. */
  endLine: number;
  /** Original H2 text (e.g. "🚨 Decisions needed from Rajiv"). */
  rawHeading: string;
  /** Raw markdown body between heading line + 1 and endLine. */
  rawBody: string;
  /** For decisions sections. */
  decisions?: Decision[];
  /** For priority-tasks sections. */
  taskBuckets?: TaskBucket[];
}

export interface DecisionOption {
  /** Letter "A" / "B" / "C" extracted from `**Option A:**` etc. */
  letter: string;
  /** Inline text after the option marker. */
  body: string;
}

export interface Decision {
  /** Document-order index across all decisions in the file. Stable handle. */
  index: number;
  /** 0-based line of the H3 question heading (or the H2 line for synthetic asks). */
  headingLine: number;
  /** Inclusive end line of this decision's content (next H3 or section end). */
  endLine: number;
  /** H3 text (e.g. "1. Force-push origin/develop?") or H2 text for synthetic. */
  question: string;
  /** True when this decision was synthesized from an H2 ask with no H3 children
   *  (e.g. "## Open ask for Rajiv" with prose body). For these, options is
   *  empty and the renderer shows bodyMarkdown verbatim. */
  synthetic: boolean;
  options: DecisionOption[];
  /** Free-form prose body — for synthetic decisions OR for decisions whose
   *  H3 has additional context beyond the options. */
  bodyMarkdown: string;
  /** Recommendation letter if a `Recommendation: **A**` line is present. */
  recommendationLetter?: string;
  /** Inline body of the recommendation (without the bold letter marker). */
  recommendationBody?: string;
  /** Has a `**Decided:**` line already been written? */
  decided: boolean;
  decidedOption?: string;
  decidedAt?: string;
}

export interface PlanTask {
  /** 0-based document-order index across the whole file. Stable handle. */
  index: number;
  /** 0-based line of the start of the list item. */
  startLine: number;
  /** 0-based line of the last line of the list item (inclusive). */
  endLine: number;
  /** Exact original text of the list-item lines. The compare-and-swap fingerprint. */
  rawText: string;
  /** Rendered HTML of the list item's body. */
  rendered: string;
  /** Has the task been marked done already? */
  done: boolean;
  /** "11:14 EDT" style timestamp parsed from the done marker, if any. */
  doneTimestamp?: string;
}

export interface TaskBucket {
  /** 0-based among buckets within one priority-tasks section. */
  index: number;
  /** 0-based line of the H3. */
  headingLine: number;
  /** Exclusive end line. */
  endLine: number;
  /** H3 text (e.g. "Do today — not negotiable"). */
  label: string;
  semantic: TaskSemantic;
  tasks: PlanTask[];
}

const md = new MarkdownIt({ html: true, linkify: true, typographer: true });

/**
 * Heading classifier — substring + case-insensitive. First match wins.
 *
 * The contract with synthesis-daily-rituals (the skill that writes daily
 * plans) is documented in `docs/cockpit-design.md`. Both repos must stay
 * in sync. This classifier is intentionally tolerant: agentic skills may
 * deviate from canonical names (LLMs aren't deterministic), and historic
 * plans (March 2026 onwards) used different vocabulary. Anything not
 * matching falls through to `other` and renders as plain markdown — never
 * lost, just not specially typed.
 *
 * Test corpus: every H2 observed across `daily-plans/` (~260 distinct
 * variants); the patterns below cover the substantive ones, and the
 * `other` fallback handles the long tail without breaking.
 */
function classifyH2(text: string): SectionKind {
  // Strip strikethrough markers and emoji prefixes so headings like
  // "~~CRITICAL: v0.81.0 Staging Regressions~~" still classify.
  const t = text
    .replace(/~~/g, "")
    .replace(/[🚨🔥🚀🟡🟢💡📞🤖🧪🆕✅⚠️⛔🎯📋🔧📌⚡📰☑️📅📆🧞‍♂️📓🗓]/g, "")
    .trim()
    .toLowerCase();
  // Cockpit Mode (v2.10.0+ producer) — order matters, more-specific matches
  // come before the generic "decisions" catchall.
  if (/^decision\s+needed\b/i.test(t)) return "decision-needed";
  if (/^one[-\s]?tap\s+batch\b|^batch\s+review\b/i.test(t)) return "one-tap-batch";
  if (/^on\s+your\s+behalf\b/i.test(t)) return "ticker";
  if (/^brief\b/i.test(t)) return "brief";
  if (/^today\b\s*(?:—|-|\()/i.test(t)) return "today";
  if (/^calendar\b|^schedule\s+today\b|^today'?s?\s+calendar\b/i.test(t)) return "calendar";
  if (/^prep\s+packs?\b|^meeting\s+prep\b/i.test(t)) return "prep-packs";
  // Decisions / open asks — anything Rajiv needs to attend to / decide.
  if (/decisions?\s+(?:needed|to\s+make)|open\s+asks?\b|asks?\s+for\s+rajiv|open\s+items?\b|need(?:s)?\s+(?:your\s+)?attention|open\s+quality\s+concerns?/i.test(t)) return "decisions";
  // Priority tasks.
  if (/^priority\s+tasks?\b|^tasks?(?:\s+for|\s+today|\s+remaining|\b)|^today'?s?\s+(?:tasks?|priorit|suggested)|^still\s+to\s+do|^this\s+week\b|^remaining\s+(?:tasks?|work)|^pending\s+(?:this|from)/i.test(t)) return "priority-tasks";
  // Drafts.
  if (/^drafts?\b|unsent\s*(?:[—-]\s*)?(?:ready|drafts?)|^dm\s+reply\s+drafts?|^draft\s+messages?|^messages\s*$|^next\s+steps?\b|^pending\s+emails?|^scheduled\s+for\s+(?:tomorrow|later)/i.test(t)) return "drafts";
  // Standup.
  if (/standup|newsroom\s+training/i.test(t)) return "standup";
  // Sent message log.
  if (/sent\s+messages?|^messages\s+sent/i.test(t)) return "sent-messages";
  // Waiting on others.
  if (/waiting\s+on|delegated\s+to\s+team/i.test(t)) return "waiting";
  // PR queue.
  if (/(?:open\s+)?pr\s+queue|open\s+prs?|new\s+prs?(?:\s|$)|prs?\s+ready\s+for\s+review|pr\s+reviews?\s+completed/i.test(t)) return "pr-queue";
  // Sync / staging / deployment state.
  if (/sync\s+state|staging\/deployment|(?:deployment|staging|pre-?migration|post-?release|release)\s+status|files\s+(?:created|modified)|test\s+results|^staging\s*[:]/i.test(t)) return "sync-state";
  // Completed-today log.
  if (/^completed\s+(?:today|this)/i.test(t)) return "completed";
  // Briefing — context that's read once.
  if (/what\s+happened|what\s+changed|big\s+things|things\s+(?:to\s+know|rajiv\s+should\s+know)|carried?\s+(?:from|items|forward)|carry\s+forward|mid-?day\s+sync|morning\s+sync|from\s+slack|state\s+catch-?up|day\s+summary|end\s+of\s+day\s+summary|^summary[:]|^bugs\b|qa\s+(?:findings|results)|^critical[:]?|^context\b|what\s+to\s+watch|future\s+work|post-?release\s*[:]?\s*issues?|feature\s+requests?\s+\(carryover\)|release\s+process\s+sync/i.test(t)) return "briefing";
  return "other";
}

function classifyH3(text: string): TaskSemantic {
  const t = text.toLowerCase();
  if (/not\s+negotiable|high\s+priority|critical|immediate|do\s+today\b.*(?:not\s+negotiable|must|critical)?$/i.test(t) && !/can\s+slip|should\s+make/i.test(t)) {
    if (/not\s+negotiable|high\s+priority|critical|immediate/i.test(t)) return "p0";
  }
  if (/not\s+negotiable|^high\s+priority|critical|immediate/i.test(t)) return "p0";
  if (/should\s+make\s+it|medium\s+priority/i.test(t)) return "p1";
  if (/can\s+slip|lower\s+priority|next\s+week|before\s+\w+\s+\d+/i.test(t)) return "p2";
  if (/^stale\b|stale\s+target|stale\s+—|stale\s+\(/i.test(t)) return "stale";
  if (/^watch\b|watch\s*\/|waiting|carried\s+(?:over|forward)/i.test(t)) return "watch";
  return "other";
}

/**
 * Strip surrounding `## ` / `### ` etc. markers and return the inline text
 * for a given heading line in the raw source.
 */
function readHeadingText(lines: string[], lineIdx: number): string {
  const ln = lines[lineIdx] ?? "";
  return ln.replace(/^#+\s*/, "").trim();
}

/**
 * Walk markdown tokens to collect H2-bounded sections.
 */
export function findPlanSections(raw: string): PlanSection[] {
  const tokens = md.parse(raw, {});
  const lines = raw.split("\n");
  const sections: PlanSection[] = [];

  // Find all H2 lines.
  interface H2 {
    line: number;
    text: string;
  }
  const h2s: H2[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.type === "heading_open" && t.tag === "h2" && t.map) {
      const line = t.map[0];
      const text = readHeadingText(lines, line);
      h2s.push({ line, text });
    }
  }

  // Synthetic "header" section for content before the first H2 (status,
  // morning ritual notes, etc.).
  if (h2s.length === 0 || h2s[0].line > 0) {
    const firstH2Line = h2s.length > 0 ? h2s[0].line : lines.length;
    sections.push({
      kind: "header",
      headingLine: -1,
      endLine: firstH2Line,
      rawHeading: "",
      rawBody: lines.slice(0, firstH2Line).join("\n"),
    });
  }

  let decisionIndex = 0;
  let taskIndex = 0;

  for (let i = 0; i < h2s.length; i++) {
    const h2 = h2s[i];
    const endLine = i + 1 < h2s.length ? h2s[i + 1].line : lines.length;
    const kind = classifyH2(h2.text);
    const bodyLines = lines.slice(h2.line + 1, endLine);
    const rawBody = bodyLines.join("\n");

    const section: PlanSection = {
      kind,
      headingLine: h2.line,
      endLine,
      rawHeading: h2.text,
      rawBody,
    };

    if (kind === "decisions" || kind === "decision-needed" || kind === "one-tap-batch") {
      // Cockpit Mode sections use the same H3-with-Options structure as
      // legacy decisions sections. one-tap-batch may hold decisions AND
      // drafts (see draft-blocks.ts for draft detection); the decision
      // extractor only picks up H3s that have Option markers or prose
      // bodies, so drafts (which use `**Send to:**` bodies) pass through
      // untouched.
      const result = extractDecisions(lines, h2.line, endLine, decisionIndex, h2.text);
      section.decisions = result.decisions;
      decisionIndex = result.nextIndex;
    } else if (kind === "priority-tasks" || kind === "today") {
      // `today` H2 (Tier-C slots) uses the same H3-per-slot pattern; each
      // slot is a task with priority context. Reuse the task extractor.
      const result = extractTaskBuckets(lines, h2.line, endLine, taskIndex);
      section.taskBuckets = result.buckets;
      taskIndex = result.nextIndex;
    }

    sections.push(section);
  }

  return sections;
}

/* -------------------------------------------------------------------------- */
/* Decision extraction                                                         */
/* -------------------------------------------------------------------------- */

// Option markers appear either as bare paragraphs (`**Option A:** ...`) or as
// bulleted list items (`- **Option A:** ...`, `* **Option A:** ...`, or
// numbered `1. **Option A:** ...`). The producer-consumer contract allows both
// since agentic writers vary in shape (Postel's Law); the parser tolerates the
// optional list marker and captures the same option letter + body regardless.
const OPTION_INLINE_RE = /^\s*(?:[-*+]\s+|\d+\.\s+)?\*\*\s*Option\s+([A-Z])\s*:?\s*\*\*\s*(.*)$/i;
const RECOMMENDATION_INLINE_RE = /^\s*(?:[-*+]\s+|\d+\.\s+)?Recommendation\s*:\s*\*\*\s*([A-Z])\s*\*\*\s*(.*)$/i;
const DECIDED_INLINE_RE = /^\s*\*\*\s*Decided\s*:?\s*\*\*\s*Option\s+([A-Z])\s*[—-]?\s*(.*)$/i;

function extractDecisions(
  lines: string[],
  h2Line: number,
  h2EndLine: number,
  startIndex: number,
  h2Text: string
): { decisions: Decision[]; nextIndex: number } {
  // Find all H3 lines within this section.
  const h3s: { line: number; text: string }[] = [];
  for (let i = h2Line + 1; i < h2EndLine; i++) {
    const ln = lines[i] ?? "";
    if (/^###\s+/.test(ln)) {
      h3s.push({ line: i, text: readHeadingText(lines, i) });
    }
  }

  // No H3s? Synthesize a single decision card from the H2 prose so an
  // "Open ask for Rajiv" with just a paragraph body still surfaces in
  // NEEDS YOU. The cockpit renders synthetic decisions as a card with the
  // body verbatim, no option buttons.
  if (h3s.length === 0) {
    const bodyLines = lines.slice(h2Line + 1, h2EndLine);
    const bodyMarkdown = bodyLines.join("\n").trim();
    if (bodyMarkdown.length === 0) {
      return { decisions: [], nextIndex: startIndex };
    }
    return {
      decisions: [
        {
          index: startIndex,
          headingLine: h2Line,
          endLine: h2EndLine,
          question: h2Text.replace(/^\d+\.\s*/, "").trim(),
          synthetic: true,
          options: [],
          bodyMarkdown,
          decided: false,
        },
      ],
      nextIndex: startIndex + 1,
    };
  }

  const decisions: Decision[] = [];
  const SEND_TO_H3_BODY_RE = /^\s*\*\*\s*(?:Send to|Channel)\s*:?\s*\*\*/i;
  for (let i = 0; i < h3s.length; i++) {
    const h3 = h3s[i];
    const endLine = i + 1 < h3s.length ? h3s[i + 1].line : h2EndLine;

    // Skip H3s that look like drafts (their first non-blank line is
    // `**Send to:**`). Drafts are surfaced by findDraftBlocks — synthesizing
    // them as decision cards here would double-render them in one-tap-batch
    // regions where drafts and decisions coexist.
    let firstNonBlank = h3.line + 1;
    while (firstNonBlank < endLine && (lines[firstNonBlank] ?? "").trim() === "") firstNonBlank++;
    if (firstNonBlank < endLine && SEND_TO_H3_BODY_RE.test(lines[firstNonBlank] ?? "")) {
      continue;
    }

    // Strip leading "1. " or "2. " numbering from the question text if present.
    const question = h3.text.replace(/^\d+\.\s*/, "").trim();

    const options: DecisionOption[] = [];
    const bodyParts: string[] = [];
    let recommendationLetter: string | undefined;
    let recommendationBody: string | undefined;
    let decided = false;
    let decidedOption: string | undefined;
    let decidedAt: string | undefined;

    for (let j = h3.line + 1; j < endLine; j++) {
      const ln = lines[j] ?? "";

      const optMatch = ln.match(OPTION_INLINE_RE);
      if (optMatch) {
        options.push({ letter: optMatch[1].toUpperCase(), body: optMatch[2].trim() });
        continue;
      }

      const recMatch = ln.match(RECOMMENDATION_INLINE_RE);
      if (recMatch) {
        recommendationLetter = recMatch[1].toUpperCase();
        recommendationBody = recMatch[2].trim();
        continue;
      }

      const decMatch = ln.match(DECIDED_INLINE_RE);
      if (decMatch) {
        decided = true;
        decidedOption = decMatch[1].toUpperCase();
        decidedAt = decMatch[2].trim();
        continue;
      }

      // Anything else is body context.
      bodyParts.push(ln);
    }

    decisions.push({
      index: startIndex + i,
      headingLine: h3.line,
      endLine,
      question,
      synthetic: options.length === 0,
      options,
      bodyMarkdown: bodyParts.join("\n").trim(),
      recommendationLetter,
      recommendationBody,
      decided,
      decidedOption,
      decidedAt,
    });
  }

  return { decisions, nextIndex: startIndex + h3s.length };
}

/* -------------------------------------------------------------------------- */
/* Task bucket + task extraction                                              */
/* -------------------------------------------------------------------------- */

const TASK_DONE_DETECT_RE = /^(?:\s*[-*+]\s+\[x\]|.*?✅|.*?~~|^\s*\d+\.\s*~~|.*?\bDONE\b|.*?\bSENT\b)/;
const TASK_DONE_TIMESTAMP_RE = /(?:✅|~~)\s*\*\*\s*(?:DONE|SENT)\s+([^*]+?)\*\*/i;

function extractTaskBuckets(
  lines: string[],
  h2Line: number,
  h2EndLine: number,
  startIndex: number
): { buckets: TaskBucket[]; nextIndex: number } {
  // Find all H3 lines.
  const h3s: { line: number; text: string }[] = [];
  for (let i = h2Line + 1; i < h2EndLine; i++) {
    const ln = lines[i] ?? "";
    if (/^###\s+/.test(ln)) {
      h3s.push({ line: i, text: readHeadingText(lines, i) });
    }
  }

  // If no H3s exist, treat the whole H2 body as one anonymous bucket.
  if (h3s.length === 0) {
    const tasks = extractTasksInRange(lines, h2Line + 1, h2EndLine, startIndex);
    return {
      buckets: [
        {
          index: 0,
          headingLine: h2Line,
          endLine: h2EndLine,
          label: "",
          semantic: "other",
          tasks,
        },
      ],
      nextIndex: startIndex + tasks.length,
    };
  }

  const buckets: TaskBucket[] = [];
  let cursor = startIndex;

  for (let i = 0; i < h3s.length; i++) {
    const h3 = h3s[i];
    const endLine = i + 1 < h3s.length ? h3s[i + 1].line : h2EndLine;
    const tasks = extractTasksInRange(lines, h3.line + 1, endLine, cursor);
    cursor += tasks.length;
    buckets.push({
      index: i,
      headingLine: h3.line,
      endLine,
      label: h3.text,
      semantic: classifyH3(h3.text),
      tasks,
    });
  }

  return { buckets, nextIndex: cursor };
}

/**
 * Extract task list items from a range of lines.
 *
 * Detects:
 *   - Numbered list items: lines starting with `^\d+\.\s+`
 *   - Checkbox list items: lines starting with `^[-*+]\s+\[[ xX]\]\s+`
 *
 * A task spans from its leading line through any following indented continuation
 * lines (lines whose leading whitespace is greater than the leading whitespace
 * of the task's first line, OR blank lines followed by more indented content).
 *
 * Stops at a less-indented non-blank line, a heading, or the end of the range.
 */
function extractTasksInRange(
  lines: string[],
  start: number,
  end: number,
  startIndex: number
): PlanTask[] {
  const tasks: PlanTask[] = [];
  let i = start;

  while (i < end) {
    const ln = lines[i] ?? "";
    const numbered = ln.match(/^(\s*)(\d+)\.\s+(.*)$/);
    const checkbox = ln.match(/^(\s*)([-*+])\s+\[([ xX])\]\s+(.*)$/);

    if (!numbered && !checkbox) {
      i++;
      continue;
    }

    const baseIndent = (numbered ? numbered[1] : checkbox![1]).length;
    const taskStart = i;
    let taskEnd = i;

    // Walk continuation lines.
    for (let j = i + 1; j < end; j++) {
      const cont = lines[j] ?? "";
      if (cont.trim() === "") {
        // Blank — peek next non-blank.
        let k = j + 1;
        while (k < end && (lines[k] ?? "").trim() === "") k++;
        if (k >= end) {
          // All trailing blanks — stop here.
          break;
        }
        const nextLine = lines[k];
        const nextNumbered = nextLine.match(/^(\s*)\d+\.\s+/);
        const nextCheckbox = nextLine.match(/^(\s*)[-*+]\s+\[[ xX]\]\s+/);
        const nextHeading = /^#+\s+/.test(nextLine);
        if (nextHeading) break;
        if (nextNumbered || nextCheckbox) {
          // Sibling list item starts after the blank — stop.
          const nextIndent = (nextNumbered ? nextNumbered[1] : nextCheckbox![1]).length;
          if (nextIndent <= baseIndent) break;
        }
        const nextIndent = (nextLine.match(/^(\s*)/)?.[1] || "").length;
        if (nextIndent <= baseIndent) break;
        // Otherwise a continuation block separated by blank line — include it.
        taskEnd = k;
        j = k;
        continue;
      }
      // Non-blank continuation.
      const indent = (cont.match(/^(\s*)/)?.[1] || "").length;
      if (/^#+\s+/.test(cont)) break;
      const sibNumbered = cont.match(/^(\s*)\d+\.\s+/);
      const sibCheckbox = cont.match(/^(\s*)[-*+]\s+\[[ xX]\]\s+/);
      if ((sibNumbered || sibCheckbox) && indent <= baseIndent) break;
      if (indent <= baseIndent && !/^[-*+]\s/.test(cont.trimStart())) break;
      taskEnd = j;
    }

    const rawText = lines.slice(taskStart, taskEnd + 1).join("\n");
    const done = detectDone(rawText);
    const doneTimestamp = done ? extractDoneTimestamp(rawText) : undefined;

    tasks.push({
      index: startIndex + tasks.length,
      startLine: taskStart,
      endLine: taskEnd,
      rawText,
      rendered: md.render(rawText.replace(/^(\s*)\d+\.\s+/, "")),
      done,
      doneTimestamp,
    });

    i = taskEnd + 1;
  }

  return tasks;
}

function detectDone(rawText: string): boolean {
  // Look at the first ~120 chars (covers leading bold + done marker).
  const head = rawText.slice(0, 200);
  return TASK_DONE_DETECT_RE.test(head);
}

function extractDoneTimestamp(rawText: string): string | undefined {
  const m = rawText.match(TASK_DONE_TIMESTAMP_RE);
  return m ? m[1].trim() : undefined;
}

/* -------------------------------------------------------------------------- */
/* Index lookups                                                              */
/* -------------------------------------------------------------------------- */

export function findDecisionByIndex(raw: string, idx: number): Decision | null {
  const sections = findPlanSections(raw);
  for (const section of sections) {
    if (section.decisions) {
      for (const d of section.decisions) {
        if (d.index === idx) return d;
      }
    }
  }
  return null;
}

export function findTaskByIndex(raw: string, idx: number): PlanTask | null {
  const sections = findPlanSections(raw);
  for (const section of sections) {
    if (section.taskBuckets) {
      for (const bucket of section.taskBuckets) {
        for (const t of bucket.tasks) {
          if (t.index === idx) return t;
        }
      }
    }
  }
  return null;
}

/** Collect all decisions across the whole plan, in document order. */
export function collectAllDecisions(sections: PlanSection[]): Decision[] {
  const out: Decision[] = [];
  for (const s of sections) {
    if (s.decisions) out.push(...s.decisions);
  }
  return out;
}

/** Collect all tasks across the whole plan, in document order. */
export function collectAllTasks(sections: PlanSection[]): PlanTask[] {
  const out: PlanTask[] = [];
  for (const s of sections) {
    if (s.taskBuckets) {
      for (const b of s.taskBuckets) out.push(...b.tasks);
    }
  }
  return out;
}
