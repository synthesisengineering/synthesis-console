/**
 * Compare-and-swap mutators for the daily plan cockpit view.
 *
 * Modeled on draft-blocks.ts's `replaceDraftBody` and `markDraftAsSent`:
 *   - Read raw markdown, locate the target by stable index,
 *   - Verify the surrounding text matches what the caller saw (the
 *     compare-and-swap fingerprint),
 *   - Apply the surgical edit,
 *   - Return the new full markdown so the caller can write it atomically.
 *
 * Two mutation kinds:
 *   1. recordDecision — inserts a `**Decided:** Option X — <ISO>` line right
 *      after the decision's H3 heading.
 *   2. markTaskDone / unmarkTaskDone — rewrites a task list-item line in
 *      place, adding strike-through + ✅ DONE marker (or removing them).
 */
import { findPlanSections, collectAllDecisions, collectAllTasks } from "./plan-sections.js";

export type MutationResult =
  | { ok: true; newRaw: string }
  | { ok: false; reason: MutationFailure; message?: string };

export type MutationFailure =
  | "not-found"
  | "conflict"
  | "already-decided"
  | "not-decided"
  | "already-done"
  | "not-done"
  | "invalid-option"
  | "invalid-input";

/* -------------------------------------------------------------------------- */
/* Decisions                                                                  */
/* -------------------------------------------------------------------------- */

export function recordDecision(
  raw: string,
  decisionIndex: number,
  option: string,
  decidedAtIso: string
): MutationResult {
  if (!/^[A-Z]$/.test(option)) {
    return { ok: false, reason: "invalid-option", message: "Option must be a single capital letter." };
  }
  const sections = findPlanSections(raw);
  const decisions = collectAllDecisions(sections);
  const decision = decisions.find((d) => d.index === decisionIndex);
  if (!decision) return { ok: false, reason: "not-found" };
  if (decision.decided) return { ok: false, reason: "already-decided" };

  // Verify the option exists in the parsed list.
  const optionExists = decision.options.some((o) => o.letter === option);
  if (!optionExists) {
    return { ok: false, reason: "invalid-option", message: `Option ${option} is not present in this decision.` };
  }

  const lines = raw.split("\n");
  const decidedLine = `**Decided:** Option ${option} — ${decidedAtIso}`;

  // Target shape:  H3 \n (blank) \n Decided \n (blank) \n existing-body
  // Strategy: skip past any existing blank line(s) right after the H3, then
  // splice in [Decided, blank] at that point. This keeps the H3 → blank →
  // Decided → blank → existing-body shape clean regardless of whether the
  // file has zero, one, or many blanks after the H3.
  let cursor = decision.headingLine + 1;
  let leadingBlanks = 0;
  while (cursor < lines.length && (lines[cursor] ?? "").trim() === "") {
    cursor++;
    leadingBlanks++;
  }

  // Build the insertion. If the file had zero blanks after the H3, we add
  // a leading blank ourselves; otherwise the existing blank is fine.
  const insertion = leadingBlanks === 0
    ? ["", decidedLine, ""]
    : [decidedLine, ""];

  const before = lines.slice(0, cursor);
  const after = lines.slice(cursor);
  const newLines = [...before, ...insertion, ...after];
  return { ok: true, newRaw: newLines.join("\n") };
}

const DECIDED_LINE_RE = /^\s*\*\*\s*Decided\s*:?\s*\*\*\s*Option\s+([A-Z])\b/i;

/**
 * Reopen a recorded decision: remove its `**Decided:**` line (and the blank
 * line recordDecision wrote after it) so the options become choosable
 * again. Decisions get superseded in the meeting they concern; changing one
 * is a real workflow, not an edge case. `expectedOption` is the
 * compare-and-swap fingerprint: the option the page showed as decided.
 */
export function reopenDecision(raw: string, decisionIndex: number, expectedOption: string): MutationResult {
  const sections = findPlanSections(raw);
  const decision = collectAllDecisions(sections).find((d) => d.index === decisionIndex);
  if (!decision) return { ok: false, reason: "not-found" };
  if (!decision.decided) return { ok: false, reason: "not-decided" };
  if (expectedOption && decision.decidedOption !== expectedOption.trim().toUpperCase()) {
    return { ok: false, reason: "conflict" };
  }

  const lines = raw.split("\n");
  const keep: string[] = [];
  let removed = 0;
  for (let i = 0; i < lines.length; i++) {
    const inDecision = i > decision.headingLine && i <= decision.endLine;
    if (inDecision && DECIDED_LINE_RE.test(lines[i] ?? "")) {
      removed++;
      // Drop the blank line recordDecision wrote after the marker.
      if ((lines[i + 1] ?? "").trim() === "" && i + 1 <= decision.endLine) i++;
      continue;
    }
    keep.push(lines[i]);
  }
  if (removed === 0) return { ok: false, reason: "conflict", message: "The decided marker isn't in the cockpit's format; edit the file by hand to reopen it." };
  return { ok: true, newRaw: keep.join("\n") };
}

/* -------------------------------------------------------------------------- */
/* Tasks                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The first-line pattern for tasks the cockpit knows how to mark done in
 * place. Captures: prefix (numbered or checkbox), inner content.
 *
 * Numbered:  `1. **Title** — rest`     →  `1. ~~**Title**~~ ✅ **DONE HH:MM TZ** — rest`
 * Checkbox:  `- [ ] Title — rest`      →  `- [x] ~~Title~~ ✅ **DONE HH:MM TZ** — rest`
 */
const NUMBERED_FIRST_LINE_RE = /^(\s*\d+\.\s+)(.*)$/;
const CHECKBOX_FIRST_LINE_RE = /^(\s*[-*+]\s+)\[([ xX])\](\s+)(.*)$/;

/**
 * Build the canonical "done" form of a task's first line.
 *
 * If the line starts with `**Title**`, strike just the bold title and append
 * the DONE marker before the descriptive text. Otherwise wrap the whole
 * content in strike-through and append the marker.
 */
function buildDoneFirstLine(line: string, doneAtLocal: string): string {
  const numbered = line.match(NUMBERED_FIRST_LINE_RE);
  if (numbered) {
    const prefix = numbered[1];
    const content = numbered[2];
    const doneTail = ` ✅ **DONE ${doneAtLocal}**`;
    const boldHead = content.match(/^(\*\*[^*]+\*\*)(.*)$/);
    if (boldHead) {
      return `${prefix}~~${boldHead[1]}~~${doneTail}${boldHead[2]}`;
    }
    return `${prefix}~~${content}~~${doneTail}`;
  }

  const checkbox = line.match(CHECKBOX_FIRST_LINE_RE);
  if (checkbox) {
    const prefix = checkbox[1];
    const ws = checkbox[3];
    const content = checkbox[4];
    const doneTail = ` ✅ **DONE ${doneAtLocal}**`;
    const boldHead = content.match(/^(\*\*[^*]+\*\*)(.*)$/);
    if (boldHead) {
      return `${prefix}[x]${ws}~~${boldHead[1]}~~${doneTail}${boldHead[2]}`;
    }
    return `${prefix}[x]${ws}~~${content}~~${doneTail}`;
  }

  // Unrecognized shape — append the marker without strike-through.
  return `${line} ✅ **DONE ${doneAtLocal}**`;
}

/**
 * Reverse the canonical done form. Returns null if the line doesn't match
 * the format we wrote.
 */
function buildUndoneFirstLine(line: string): string | null {
  // Numbered: `1. ~~**Title**~~ ✅ **DONE HH:MM TZ**rest`
  const numberedDone = line.match(
    /^(\s*\d+\.\s+)~~(\*\*[^*]+\*\*)~~\s*✅\s*\*\*DONE\s+[^*]+\*\*(.*)$/
  );
  if (numberedDone) {
    return `${numberedDone[1]}${numberedDone[2]}${numberedDone[3]}`;
  }
  // Numbered without bold: `1. ~~content~~ ✅ **DONE HH:MM TZ**rest`
  const numberedDonePlain = line.match(
    /^(\s*\d+\.\s+)~~([^~]+)~~\s*✅\s*\*\*DONE\s+[^*]+\*\*(.*)$/
  );
  if (numberedDonePlain) {
    return `${numberedDonePlain[1]}${numberedDonePlain[2]}${numberedDonePlain[3]}`;
  }
  // Checkbox: `- [x] ~~**Title**~~ ✅ **DONE HH:MM TZ**rest`
  const checkboxDone = line.match(
    /^(\s*[-*+]\s+)\[x\](\s+)~~(\*\*[^*]+\*\*)~~\s*✅\s*\*\*DONE\s+[^*]+\*\*(.*)$/
  );
  if (checkboxDone) {
    return `${checkboxDone[1]}[ ]${checkboxDone[2]}${checkboxDone[3]}${checkboxDone[4]}`;
  }
  const checkboxDonePlain = line.match(
    /^(\s*[-*+]\s+)\[x\](\s+)~~([^~]+)~~\s*✅\s*\*\*DONE\s+[^*]+\*\*(.*)$/
  );
  if (checkboxDonePlain) {
    return `${checkboxDonePlain[1]}[ ]${checkboxDonePlain[2]}${checkboxDonePlain[3]}${checkboxDonePlain[4]}`;
  }
  return null;
}

function canonicalize(s: string): string {
  return s.replace(/\r\n/g, "\n").replace(/\s+$/g, "").replace(/[ \t]+\n/g, "\n");
}

export function markTaskDone(
  raw: string,
  taskIndex: number,
  originalRawText: string,
  doneAtLocal: string
): MutationResult {
  if (!doneAtLocal || doneAtLocal.length > 60) {
    return { ok: false, reason: "invalid-input", message: "doneAtLocal must be a short label." };
  }
  const sections = findPlanSections(raw);
  const tasks = collectAllTasks(sections);
  const task = tasks.find((t) => t.index === taskIndex);
  if (!task) return { ok: false, reason: "not-found" };

  if (canonicalize(task.rawText) !== canonicalize(originalRawText)) {
    return { ok: false, reason: "conflict" };
  }
  if (task.done) return { ok: false, reason: "already-done" };

  const lines = raw.split("\n");
  const firstLine = lines[task.startLine] ?? "";
  const newFirstLine = buildDoneFirstLine(firstLine, doneAtLocal);
  const before = lines.slice(0, task.startLine);
  const after = lines.slice(task.startLine + 1);
  const newLines = [...before, newFirstLine, ...after];
  return { ok: true, newRaw: newLines.join("\n") };
}

export function unmarkTaskDone(
  raw: string,
  taskIndex: number,
  originalRawText: string
): MutationResult {
  const sections = findPlanSections(raw);
  const tasks = collectAllTasks(sections);
  const task = tasks.find((t) => t.index === taskIndex);
  if (!task) return { ok: false, reason: "not-found" };

  if (canonicalize(task.rawText) !== canonicalize(originalRawText)) {
    return { ok: false, reason: "conflict" };
  }
  if (!task.done) return { ok: false, reason: "not-done" };

  const lines = raw.split("\n");
  const firstLine = lines[task.startLine] ?? "";
  const newFirstLine = buildUndoneFirstLine(firstLine);
  if (newFirstLine === null) {
    return {
      ok: false,
      reason: "conflict",
      message:
        "Task done-marker doesn't match the cockpit's canonical format; edit the file by hand to revoke.",
    };
  }
  const before = lines.slice(0, task.startLine);
  const after = lines.slice(task.startLine + 1);
  const newLines = [...before, newFirstLine, ...after];
  return { ok: true, newRaw: newLines.join("\n") };
}
