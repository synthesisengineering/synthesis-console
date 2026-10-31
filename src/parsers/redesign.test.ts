import { describe, expect, test } from "bun:test";
import { renderMarkdown } from "./markdown.js";
import { recordDecision, reopenDecision } from "./plan-mutations.js";
import { collectAllDecisions, findPlanSections } from "./plan-sections.js";

describe("field lines", () => {
  test("a bold label that ends in a colon starts its own line", () => {
    const html = renderMarkdown("**Phase:** one\n**Status:** Active\n**Last session**: 2026-04-12");
    expect(html).toContain("one<br>");
    expect(html).toContain("Active<br>");
  });

  test("hard-wrapped prose and mid-line bold keep their soft breaks", () => {
    const html = renderMarkdown("A wrapped line\ncontinues here with **bold text** inside\nand ends.");
    expect(html).not.toContain("<br>");
  });
});

describe("task lists", () => {
  test("a task item shows its checkbox without the [x] marker text", () => {
    const html = renderMarkdown("1. [x] Done item\n2. [ ] Open item\n\n- [x] **Bold** item\n- not a [x] task");
    expect(html).toContain('<input type="checkbox" checked disabled> Done item');
    expect(html).toContain('<input type="checkbox" disabled> Open item');
    expect(html).toContain('<input type="checkbox" checked disabled> <strong>Bold</strong> item');
    expect(html).toContain("not a [x] task");
    expect(html).not.toContain("[x] Done");
  });
});

const PLAN = `# Plan

## 🚨 Decisions needed

### 1. Ship Tuesday or Wednesday?

**Option A:** Tuesday.
**Option B:** Wednesday.

Recommendation: **A** — sooner.

## Tasks

1. **Write it** — today.
`;

describe("reopening a decision", () => {
  test("removes the recorded marker so the options are choosable again", () => {
    const recorded = recordDecision(PLAN, 0, "B", "2026-10-30 18:00 UTC");
    expect(recorded.ok).toBe(true);
    if (!recorded.ok) return;
    expect(collectAllDecisions(findPlanSections(recorded.newRaw))[0].decided).toBe(true);

    const reopened = reopenDecision(recorded.newRaw, 0, "B");
    expect(reopened.ok).toBe(true);
    if (!reopened.ok) return;
    const d = collectAllDecisions(findPlanSections(reopened.newRaw))[0];
    expect(d.decided).toBe(false);
    expect(reopened.newRaw).not.toContain("**Decided:**");
    expect(reopened.newRaw).toContain("**Option B:** Wednesday.");
    expect(reopened.newRaw).toContain("1. **Write it** — today.");
  });

  test("refuses when the file shows another choice or no choice", () => {
    const recorded = recordDecision(PLAN, 0, "A", "2026-10-30 18:00 UTC");
    if (!recorded.ok) throw new Error("record failed");
    expect(reopenDecision(recorded.newRaw, 0, "B")).toEqual({ ok: false, reason: "conflict" });
    expect(reopenDecision(PLAN, 0, "A")).toEqual({ ok: false, reason: "not-decided" });
    expect(reopenDecision(PLAN, 9, "A")).toEqual({ ok: false, reason: "not-found" });
  });
});
