/**
 * People / commitments view — derived at read time (v0.13+).
 *
 * There is deliberately NO roster file. The view is a cross-day scan over
 * artifacts the rituals already write (daily plans, prep packs), in the
 * same spirit as plan-rollover.ts: derived views stay as true as their
 * sources, while a parallel hand-maintained index would rot the moment a
 * ritual missed it. If richer identity ever becomes necessary, an OPTIONAL
 * ritual-written roster can enrich this — but the view must always work
 * without one.
 *
 * Signals per person, scanned over the last `windowDays` of plans:
 *   - THEY OWE ME  — list items in `waiting` sections. Person = leading
 *     bold name (`- **Jessica Payne** — observability review (5 days)`).
 *   - I OWE THEM   — open (un-sent, un-skipped) drafts whose Send-to
 *     targets a person (@handle or bare name; #channels are not people).
 *   - LAST TOUCH   — the most recent of: a sent draft to them, a ticker
 *     line targeting them, or a calendar event with them in attendees.
 *   - NEXT MEETING — earliest calendar event (today or later, relative to
 *     the newest plan) whose attendees include them, plus any prep pack
 *     whose Who line names them.
 *
 * Identity model: normalized name = lowercased, @-stripped, punctuation
 * removed, hyphens/underscores treated as spaces, whitespace collapsed.
 * "@tony-hunter" and "Tony Hunter" merge; "Tony" and "Tony Hunter" do NOT
 * (deliberate: partial-name merging produces false positives — Postel's
 * Law applies to formats, not identities). Display name = longest raw
 * form seen.
 */
import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import type { Source } from "../config.js";
import { getPlansPath } from "../config.js";
import { findPlanSections } from "./plan-sections.js";
import { findDraftBlocks } from "./draft-blocks.js";
import { parseCalendarBody } from "./calendar.js";
import { parseTickerBody } from "./ticker.js";
import { listPrepPacks } from "./prep-pack.js";

export interface PersonCommitment {
  /** Plain-text description of the item. */
  text: string;
  /** Plan date the signal was last seen on. */
  date: string;
  sourceName: string;
}

export interface PersonRecord {
  /** Normalized identity key. */
  key: string;
  /** Longest display form observed. */
  displayName: string;
  /** Open waiting-on items — they owe me. Deduped by normalized text, newest first. */
  theyOweMe: PersonCommitment[];
  /** Open drafts addressed to them — I owe them. Newest first. */
  iOweThem: PersonCommitment[];
  /** Most recent contact signal. */
  lastTouch?: { date: string; kind: "sent-draft" | "ticker" | "meeting"; detail?: string };
  /** Next meeting on or after the newest scanned plan date. */
  nextMeeting?: { date: string; time?: string; title?: string };
  /** Prep packs naming this person, newest first. */
  prepPacks: { slug: string; date: string; title: string; sourceName: string }[];
}

export function normalizePersonKey(raw: string): string {
  return raw
    .replace(/^@/, "")
    .toLowerCase()
    .replace(/[-_]/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Leading bold name in a waiting-on list item. */
const WAITING_PERSON_RE = /^\s*(?:[-*+]\s+|\d+\.\s+)(?:\[[ xX]\]\s*)?\*\*([^*]+)\*\*\s*[—–:-]?\s*(.*)$/;
/** A person target in Send-to / ticker text: @handle or a bare capitalized name before any parenthetical. */
const AT_HANDLE_RE = /@([\p{L}][\p{L}\p{N}._-]+)/u;

function stripInlineMarkdown(s: string): string {
  return s
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1")
    .trim();
}

/**
 * Extract a person identity from a Send-to / ticker target string.
 * Returns null for channels (#...), threads, and emails — those aren't
 * people rows. "@dominic (U0456EFGH)" → "dominic"; "Jessica Payne (DM)"
 * → "Jessica Payne".
 */
export function personFromTarget(target: string): string | null {
  const t = target.trim();
  if (!t || t.startsWith("#")) return null;
  if (/[\w.+-]+@[\w-]+\.[\w-]+/.test(t) && !AT_HANDLE_RE.test(t)) return null;
  const at = t.match(AT_HANDLE_RE);
  if (at) return at[1];
  // Bare name: take the text before any parenthetical / ID annotation.
  const bare = t.replace(/\(.*?\)/g, "").replace(/\b[UD][A-Z0-9]{6,}\b/g, "").trim();
  if (!bare) return null;
  // Reject obvious non-names (single lowercase word that matches a channel-ish token).
  if (/^[a-z0-9-]+$/.test(bare) && !bare.includes(" ") && bare.length < 3) return null;
  return bare;
}

interface PlanFileRef {
  date: string;
  path: string;
  sourceName: string;
}

function listRecentPlans(src: Source, windowDays: number, today: Date): PlanFileRef[] {
  const plansDir = getPlansPath(src);
  if (!plansDir || !existsSync(plansDir)) return [];
  const cutoff = new Date(today.getTime() - windowDays * 24 * 60 * 60 * 1000);
  const cutoffStr = cutoff.toISOString().slice(0, 10);
  let files: string[];
  try {
    files = readdirSync(plansDir);
  } catch {
    return [];
  }
  const out: PlanFileRef[] = [];
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    if (m[1] < cutoffStr) continue;
    out.push({ date: m[1], path: join(plansDir, f), sourceName: src.name });
  }
  out.sort((a, b) => a.date.localeCompare(b.date));
  return out;
}

/**
 * Build the people index across the given sources. `windowDays` bounds the
 * scan (default 30 — matches the ledger's decay horizon; older signals are
 * stale enough that the catchup-ledger owns them, not this view).
 */
export function computePeople(sources: Source[], windowDays = 30, now?: Date): PersonRecord[] {
  const today = now ?? new Date();
  const records = new Map<string, PersonRecord>();

  function personFor(rawName: string): PersonRecord | null {
    const display = stripInlineMarkdown(rawName).trim();
    const key = normalizePersonKey(display);
    if (!key) return null;
    let rec = records.get(key);
    if (!rec) {
      rec = { key, displayName: display, theyOweMe: [], iOweThem: [], prepPacks: [] };
      records.set(key, rec);
    }
    if (display.length > rec.displayName.length) rec.displayName = display;
    return rec;
  }

  function touch(rec: PersonRecord, date: string, kind: "sent-draft" | "ticker" | "meeting", detail?: string): void {
    if (!rec.lastTouch || date >= rec.lastTouch.date) {
      rec.lastTouch = { date, kind, detail };
    }
  }

  for (const src of sources) {
    const plans = listRecentPlans(src, windowDays, today);
    const newestDate = plans.length > 0 ? plans[plans.length - 1].date : undefined;

    // Waiting-on dedup: only the NEWEST occurrence of a normalized item
    // survives; if a newer plan no longer lists it, it has been discharged
    // — so we collect per-person waiting sets from the newest plan that
    // has a waiting section, falling back day by day.
    let waitingCollected = false;

    for (let i = plans.length - 1; i >= 0; i--) {
      const plan = plans[i];
      let raw: string;
      try {
        raw = readFileSync(plan.path, "utf-8");
      } catch {
        continue;
      }
      const sections = findPlanSections(raw);
      const drafts = findDraftBlocks(raw);

      // THEY OWE ME — newest plan with a waiting section wins.
      if (!waitingCollected) {
        const waitingSections = sections.filter((s) => s.kind === "waiting");
        if (waitingSections.length > 0) {
          for (const s of waitingSections) {
            for (const ln of s.rawBody.split("\n")) {
              const m = ln.match(WAITING_PERSON_RE);
              if (!m) continue;
              const rec = personFor(m[1]);
              if (!rec) continue;
              const text = stripInlineMarkdown(m[2]) || "(unspecified)";
              rec.theyOweMe.push({ text, date: plan.date, sourceName: plan.sourceName });
            }
          }
          waitingCollected = true;
        }
      }

      // Drafts: open → I owe them; sent → last touch.
      for (const d of drafts) {
        const person = d.sendToText ? personFromTarget(d.sendToText) : null;
        if (!person) continue;
        const rec = personFor(person);
        if (!rec) continue;
        if (d.alreadySent) {
          touch(rec, plan.date, "sent-draft");
        } else if (!d.alreadySkipped) {
          // Only the newest plan's open drafts count as live debts — an
          // open draft in an old plan that never shipped is ledger
          // territory, and re-listing it here would double-count the
          // rollover. Bound to the newest plan date.
          if (plan.date === newestDate) {
            const preview = d.bodyText.split("\n").find((l) => l.trim().length > 0) || "(draft)";
            rec.iOweThem.push({
              text: stripInlineMarkdown(preview).slice(0, 120),
              date: plan.date,
              sourceName: plan.sourceName,
            });
          }
        }
      }

      // Ticker targets → last touch.
      for (const s of sections) {
        if (s.kind !== "ticker") continue;
        for (const item of parseTickerBody(s.rawBody)) {
          if (!item.target) continue;
          const person = personFromTarget(item.target);
          if (!person) continue;
          const rec = personFor(person);
          if (!rec) continue;
          touch(rec, plan.date, "ticker", item.action);
        }
      }

      // Calendar attendees → last touch (past events) or next meeting
      // (events on the newest plan date, which is "today" from the view's
      // perspective).
      for (const s of sections) {
        if (s.kind !== "calendar") continue;
        for (const ev of parseCalendarBody(s.rawBody)) {
          if (!ev.attendees) continue;
          for (const rawAttendee of ev.attendees.split(",")) {
            const attendee = rawAttendee.trim();
            if (!attendee) continue;
            const rec = personFor(attendee);
            if (!rec) continue;
            touch(rec, plan.date, "meeting", ev.title);
            if (plan.date === newestDate) {
              const candidate = { date: plan.date, time: ev.start, title: ev.title };
              if (
                !rec.nextMeeting ||
                candidate.date < rec.nextMeeting.date ||
                (candidate.date === rec.nextMeeting.date &&
                  (candidate.time || "") < (rec.nextMeeting.time || ""))
              ) {
                rec.nextMeeting = candidate;
              }
            }
          }
        }
      }
    }

    // Prep packs naming a person (Who line, comma-separated).
    for (const pack of listPrepPacks(src)) {
      if (!pack.who) continue;
      for (const rawWho of pack.who.split(",")) {
        const who = rawWho.trim();
        if (!who) continue;
        const rec = personFor(who);
        if (!rec) continue;
        rec.prepPacks.push({
          slug: pack.slug,
          date: pack.date,
          title: pack.title,
          sourceName: pack.sourceName,
        });
      }
    }
  }

  // Sort prep packs newest first; dedupe theyOweMe by normalized text.
  const out = [...records.values()];
  for (const rec of out) {
    rec.prepPacks.sort((a, b) => b.date.localeCompare(a.date));
    const seen = new Set<string>();
    rec.theyOweMe = rec.theyOweMe.filter((c) => {
      const k = c.text.toLowerCase().replace(/\s+/g, " ").slice(0, 120);
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }

  // People with at least one live signal, most-indebted first, then by
  // most recent touch.
  return out
    .filter((r) => r.theyOweMe.length + r.iOweThem.length > 0 || r.lastTouch || r.nextMeeting)
    .sort((a, b) => {
      const debtDiff = b.theyOweMe.length + b.iOweThem.length - (a.theyOweMe.length + a.iOweThem.length);
      if (debtDiff !== 0) return debtDiff;
      return (b.lastTouch?.date || "").localeCompare(a.lastTouch?.date || "");
    });
}
