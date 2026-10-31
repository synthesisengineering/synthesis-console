/**
 * Dated entries a source contributes: daily plans (`YYYY-MM-DD.md` under
 * `plans_dir`) and lessons (`YYYY-MM-DD-slug.md` under `lessons_dir`).
 * Shared by the list routes, the Today page and the command palette.
 */
import { existsSync, readdirSync } from "fs";
import type { Source } from "../config.js";
import { getLessonsPath, getPlansPath } from "../config.js";
import type { PlanEntry } from "../views/plan.js";
import type { LessonEntry } from "../views/lesson.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export function parsePlanFilename(filename: string, sourceName: string): PlanEntry | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!match) return null;
  const date = match[1];
  const [y, m, d] = date.split("-").map(Number);
  const dayOfWeek = DAYS[new Date(y, m - 1, d).getDay()];
  return { date, filename, dayOfWeek, source: sourceName };
}

/** A source's plans, newest first. */
export function loadPlansFromSource(src: Source): PlanEntry[] {
  const plansDir = getPlansPath(src);
  if (!plansDir || !existsSync(plansDir)) return [];
  const out: PlanEntry[] = [];
  for (const f of readdirSync(plansDir).filter((f) => f.endsWith(".md")).sort().reverse()) {
    const entry = parsePlanFilename(f, src.name);
    if (entry) out.push(entry);
  }
  return out;
}

export function parseLessonFilename(filename: string): Omit<LessonEntry, "source"> | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})-(.+)\.md$/);
  if (!match) return null;
  const date = match[1];
  const title = match[2]
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  return { slug: filename.replace(".md", ""), filename, date, title };
}

/** A source's lessons, newest first. */
export function loadLessonsFromSource(src: Source): LessonEntry[] {
  const dir = getLessonsPath(src);
  if (!dir || !existsSync(dir)) return [];
  const out: LessonEntry[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".md")).sort().reverse()) {
    const entry = parseLessonFilename(f);
    if (entry) out.push({ ...entry, source: src.name });
  }
  return out;
}
