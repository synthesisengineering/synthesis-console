/**
 * Cockpit view for daily plan detail pages: a thin shim over the plan-page
 * shell at `cockpit/shell.ts`, which composes
 *
 *   planCockpitShellView(opts)
 *     → header, day-at-a-glance counts and view tools
 *     → renderMainColumn (needs you / brief / today / must do / this week /
 *                         drafts / prep packs / on your behalf / more)
 *     → renderPlanRail    (calendar / portfolio / wins / waiting on / ledger)
 *
 * Card primitives (decision card, task row, one-tap draft, region title,
 * rail rows) live in `cockpit/cards.ts`; the day's counts in
 * `cockpit/summary.ts`, shared with the Today page.
 *
 * Under 960px the rail stacks below the main column; CSS handles the
 * adaptation from one HTML tree.
 */
import { planCockpitShellView } from "./cockpit/shell.js";
import type { PlanCockpitShellOpts } from "./cockpit/shell.js";

export type PlanCockpitOpts = PlanCockpitShellOpts;

export function planCockpitView(opts: PlanCockpitOpts): string {
  return planCockpitShellView(opts);
}
