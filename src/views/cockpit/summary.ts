/**
 * The day at a glance, computed once from a parsed plan. The plan page's
 * stat row and the Today page's plan card read the same numbers, so the two
 * can never disagree about what needs the principal.
 */
import type { Decision, PlanSection } from "../../parsers/plan-sections.js";
import { collectAllDecisions, collectAllTasks } from "../../parsers/plan-sections.js";
import type { DraftBlock } from "../../parsers/draft-blocks.js";
import { countDrafts, countSentToday } from "./cards.js";

export interface PlanSummary {
  /** Open items in the NEEDS YOU queue: undecided priority and batch decisions plus unactioned batch drafts. */
  needsYouOpen: number;
  needsYouTotal: number;
  decisionsOpen: number;
  decisionsTotal: number;
  tasksDone: number;
  tasksTotal: number;
  /** Drafts still carrying an action bar (unsent). */
  draftsPending: number;
  sentToday: number;
  /** The brief's raw markdown, when the plan has one. */
  brief: string | null;
}

/** Drafts whose body starts inside a NEEDS YOU section (`## ⚡ Decision needed` or `## ☑️ One-tap batch`). */
export function needsYouDrafts(sections: PlanSection[], drafts: DraftBlock[]): DraftBlock[] {
  return drafts.filter((d) =>
    sections.some(
      (s) =>
        (s.kind === "decision-needed" || s.kind === "one-tap-batch") &&
        d.regionStartLine >= s.headingLine + 1 &&
        d.regionStartLine < s.endLine
    )
  );
}

export function needsYouDecisions(sections: PlanSection[]): { priority: Decision[]; batch: Decision[] } {
  const priority: Decision[] = [];
  const batch: Decision[] = [];
  for (const s of sections) {
    if (s.kind === "decision-needed") priority.push(...(s.decisions || []));
    else if (s.kind === "one-tap-batch") batch.push(...(s.decisions || []));
  }
  return { priority, batch };
}

export function summarizePlan(sections: PlanSection[], drafts: DraftBlock[], draftsHtml: string): PlanSummary {
  const decisions = collectAllDecisions(sections);
  const tasks = collectAllTasks(sections);
  const { priority, batch } = needsYouDecisions(sections);
  const queueDrafts = needsYouDrafts(sections, drafts);
  const queueDecisions = [...priority, ...batch];
  const brief = sections.find((s) => s.kind === "brief");
  return {
    needsYouOpen:
      queueDecisions.filter((d) => !d.decided).length +
      queueDrafts.filter((d) => !d.alreadySent && !d.alreadySkipped).length,
    needsYouTotal: queueDecisions.length + queueDrafts.length,
    decisionsOpen: decisions.filter((d) => !d.decided).length,
    decisionsTotal: decisions.length,
    tasksDone: tasks.filter((t) => t.done).length,
    tasksTotal: tasks.length,
    draftsPending: countDrafts(draftsHtml),
    sentToday: countSentToday(draftsHtml),
    brief: brief && brief.rawBody.trim() ? brief.rawBody.trim() : null,
  };
}
