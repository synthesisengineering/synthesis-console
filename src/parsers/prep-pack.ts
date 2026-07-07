/**
 * Meeting-prep pack listing + parsing (v0.13+).
 *
 * Prep packs are ritual-generated files at `<preps_dir>/YYYY-MM-DD-HHMM-slug.md`
 * (synthesis-daily-rituals v2.12.0). Each pack is the chief-of-staff one-pager
 * for a single meeting: calendar context × relevant transcripts × project
 * CONTEXT hot items × open commitments with the attendees. The console
 * renders them; it never assembles them — assembly is the ritual's job
 * (calendar access and transcript search live agent-side).
 *
 * Filename contract: `YYYY-MM-DD-HHMM-slug.md`
 *   - date + 24h start time make packs sort chronologically in a directory
 *     listing and make "today's packs" a prefix scan.
 *   - slug is the meeting identity (e.g. `jessica-payne-1-1`).
 *
 * In-file contract (all optional, tolerated if absent):
 *   - H1 = meeting title.
 *   - A `**When:**` line and a `**Who:**` line near the top.
 *   - Body sections are free-form H2s (Context, Open commitments, Since
 *     last time, Suggested agenda…) — rendered as markdown, not typed.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { Source } from "../config.js";
import { getPrepsPath } from "../config.js";

export interface PrepPackEntry {
  /** Filename without .md — the URL slug. */
  slug: string;
  /** "YYYY-MM-DD" from the filename. */
  date: string;
  /** "HH:MM" from the filename's HHMM segment, if present. */
  startTime?: string;
  /** H1 title from the file, or a de-slugged fallback. */
  title: string;
  /** `**Who:**` line content, if present. */
  who?: string;
  /** `**When:**` line content, if present. */
  when?: string;
  sourceName: string;
  mtimeMs: number;
}

const PREP_FILENAME_RE = /^(\d{4}-\d{2}-\d{2})-(\d{4})-(.+)\.md$/;
const PREP_FILENAME_NO_TIME_RE = /^(\d{4}-\d{2}-\d{2})-(.+)\.md$/;
const WHO_RE = /^\s*\*\*\s*Who\s*:?\s*\*\*\s*(.+)$/im;
const WHEN_RE = /^\s*\*\*\s*When\s*:?\s*\*\*\s*(.+)$/im;

function deslug(slug: string): string {
  return slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function parseHeader(raw: string): { title?: string; who?: string; when?: string } {
  const head = raw.split("\n").slice(0, 30).join("\n");
  const h1 = head.match(/^#\s+(.+)$/m);
  const who = head.match(WHO_RE);
  const when = head.match(WHEN_RE);
  return {
    title: h1 ? h1[1].trim() : undefined,
    who: who ? who[1].trim() : undefined,
    when: when ? when[1].trim() : undefined,
  };
}

/**
 * List prep packs for a source, optionally filtered to one date.
 * Sorted chronologically (date, then start time).
 */
export function listPrepPacks(src: Source, date?: string): PrepPackEntry[] {
  const prepsDir = getPrepsPath(src);
  if (!prepsDir || !existsSync(prepsDir)) return [];
  const out: PrepPackEntry[] = [];
  let files: string[];
  try {
    files = readdirSync(prepsDir);
  } catch {
    return [];
  }
  for (const filename of files) {
    if (!filename.endsWith(".md")) continue;
    let fileDate: string;
    let startTime: string | undefined;
    let slugTail: string;
    const withTime = filename.match(PREP_FILENAME_RE);
    if (withTime) {
      fileDate = withTime[1];
      startTime = `${withTime[2].slice(0, 2)}:${withTime[2].slice(2)}`;
      slugTail = withTime[3];
    } else {
      const noTime = filename.match(PREP_FILENAME_NO_TIME_RE);
      if (!noTime) continue;
      fileDate = noTime[1];
      slugTail = noTime[2];
    }
    if (date && fileDate !== date) continue;

    const fullPath = join(prepsDir, filename);
    let raw = "";
    let mtimeMs = 0;
    try {
      raw = readFileSync(fullPath, "utf-8");
      mtimeMs = statSync(fullPath).mtimeMs;
    } catch {
      continue;
    }
    const header = parseHeader(raw);
    out.push({
      slug: filename.replace(/\.md$/, ""),
      date: fileDate,
      startTime,
      title: header.title || deslug(slugTail),
      who: header.who,
      when: header.when,
      sourceName: src.name,
      mtimeMs,
    });
  }
  out.sort((a, b) =>
    a.date === b.date
      ? (a.startTime || "").localeCompare(b.startTime || "")
      : a.date.localeCompare(b.date)
  );
  return out;
}

/**
 * Read one prep pack by slug. Returns null when missing. The slug is
 * sanitized by the route (sanitizePathSegment) before reaching here.
 */
export function readPrepPack(
  src: Source,
  slug: string
): { entry: PrepPackEntry; raw: string } | null {
  const prepsDir = getPrepsPath(src);
  if (!prepsDir) return null;
  const fullPath = join(prepsDir, `${slug}.md`);
  if (!existsSync(fullPath)) return null;
  let raw: string;
  let mtimeMs = 0;
  try {
    raw = readFileSync(fullPath, "utf-8");
    mtimeMs = statSync(fullPath).mtimeMs;
  } catch {
    return null;
  }
  const withTime = slug.match(/^(\d{4}-\d{2}-\d{2})-(\d{4})-(.+)$/);
  const noTime = slug.match(/^(\d{4}-\d{2}-\d{2})-(.+)$/);
  const date = withTime ? withTime[1] : noTime ? noTime[1] : "";
  const startTime = withTime ? `${withTime[2].slice(0, 2)}:${withTime[2].slice(2)}` : undefined;
  const slugTail = withTime ? withTime[3] : noTime ? noTime[2] : slug;
  const header = parseHeader(raw);
  return {
    entry: {
      slug,
      date,
      startTime,
      title: header.title || deslug(slugTail),
      who: header.who,
      when: header.when,
      sourceName: src.name,
      mtimeMs,
    },
    raw,
  };
}
