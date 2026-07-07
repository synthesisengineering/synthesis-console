/**
 * Catch-up ledger parsing (v0.14+).
 *
 * Ledgers are produced by the synthesis-catchup-ledger skill at
 * `<ledgers_dir>/YYYY-MM-DD.md` — one dated document reconciling a
 * look-back window into the six-state taxonomy:
 *
 *   OPEN-ACTIONABLE · OPEN-DECAYING · DELEGATED-UNVERIFIED ·
 *   DONE-LATE · EXPIRED→LESSON · OBSOLETE (released)
 *
 * The document is organized as H2 sections whose headings identify the
 * state group ("Do now", "Verify before re-adding", "Done late",
 * "Expired — learning extracted", "Released"), each usually carrying a
 * markdown table. The console classifies sections by heading keywords,
 * parses table rows where present, and passes everything else through
 * as rendered markdown — Postel's Law, nothing dropped.
 *
 * A row's per-item state comes from a `State` column when the table has
 * one (Do-now tables mix ACTIONABLE and DECAYING); otherwise the row
 * inherits its section's state.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";
import type { Source } from "../config.js";
import { getLedgersPath } from "../config.js";

export type LedgerState =
  | "actionable"
  | "decaying"
  | "delegated"
  | "done-late"
  | "expired"
  | "released"
  | "other";

export interface LedgerRow {
  state: LedgerState;
  /** Cell values in table-column order (markdown, unrendered). */
  cells: string[];
}

export interface LedgerSection {
  state: LedgerState;
  rawHeading: string;
  /** Column headers when the section body is a table. */
  columns: string[];
  rows: LedgerRow[];
  /** Non-table body content (markdown) — rendered verbatim by the view. */
  proseMarkdown: string;
}

export interface LedgerDoc {
  date: string;
  sourceName: string;
  /** Pre-first-H2 header block (window, trigger, ratchet…). */
  headerMarkdown: string;
  sections: LedgerSection[];
  mtimeMs: number;
  /** Open-load summary: actionable + decaying + delegated row counts. */
  openCounts: { actionable: number; decaying: number; delegated: number };
}

export interface LedgerEntry {
  date: string;
  sourceName: string;
  mtimeMs: number;
}

function classifyLedgerH2(text: string): LedgerState {
  const t = text.toLowerCase();
  if (/do\s+now|actionable/.test(t)) return "actionable";
  if (/decaying/.test(t) && !/actionable/.test(t)) return "decaying";
  if (/verify\s+before|delegated/.test(t)) return "delegated";
  if (/done\s+late|credit/.test(t)) return "done-late";
  if (/expired/.test(t)) return "expired";
  if (/released|obsolete/.test(t)) return "released";
  return "other";
}

function rowStateFromCells(sectionState: LedgerState, columns: string[], cells: string[]): LedgerState {
  const stateIdx = columns.findIndex((c) => /^state$/i.test(c.trim()));
  if (stateIdx >= 0 && cells[stateIdx]) {
    const v = cells[stateIdx].toUpperCase();
    if (/DECAYING/.test(v)) return "decaying";
    if (/ACTIONABLE/.test(v)) return "actionable";
    if (/DELEGATED/.test(v)) return "delegated";
    if (/DONE/.test(v)) return "done-late";
    if (/EXPIRED/.test(v)) return "expired";
    if (/OBSOLETE|RELEASED/.test(v)) return "released";
  }
  return sectionState;
}

function splitTableLine(line: string): string[] {
  // Strip leading/trailing pipes then split. Escaped pipes are rare in
  // this corpus; cells keep their inline markdown for the view to render.
  return line
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .split("|")
    .map((c) => c.trim());
}

const TABLE_DIVIDER_RE = /^\s*\|?\s*:?-{2,}/;

function parseSectionBody(state: LedgerState, bodyLines: string[]): Pick<LedgerSection, "columns" | "rows" | "proseMarkdown"> {
  const columns: string[] = [];
  const rows: LedgerRow[] = [];
  const prose: string[] = [];
  let inTable = false;

  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    const isTableLine = /^\s*\|.*\|\s*$/.test(line);
    if (isTableLine && !inTable) {
      const next = bodyLines[i + 1] ?? "";
      if (TABLE_DIVIDER_RE.test(next)) {
        columns.push(...splitTableLine(line));
        inTable = true;
        i++; // skip divider
        continue;
      }
      prose.push(line);
      continue;
    }
    if (isTableLine && inTable) {
      const cells = splitTableLine(line);
      rows.push({ state: rowStateFromCells(state, columns, cells), cells });
      continue;
    }
    if (inTable && !isTableLine) inTable = false;
    prose.push(line);
  }

  return { columns, rows, proseMarkdown: prose.join("\n").trim() };
}

export function parseLedger(raw: string, date: string, sourceName: string, mtimeMs: number): LedgerDoc {
  const lines = raw.split("\n");
  const h2Indices: { line: number; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m) h2Indices.push({ line: i, text: m[1].trim() });
  }

  const headerEnd = h2Indices.length > 0 ? h2Indices[0].line : lines.length;
  // Drop the H1 title from the header block — the view renders its own.
  const headerMarkdown = lines
    .slice(0, headerEnd)
    .filter((l) => !/^#\s+/.test(l))
    .join("\n")
    .trim();

  const sections: LedgerSection[] = [];
  for (let i = 0; i < h2Indices.length; i++) {
    const { line, text } = h2Indices[i];
    const end = i + 1 < h2Indices.length ? h2Indices[i + 1].line : lines.length;
    const state = classifyLedgerH2(text);
    const body = parseSectionBody(state, lines.slice(line + 1, end));
    sections.push({ state, rawHeading: text, ...body });
  }

  const openCounts = { actionable: 0, decaying: 0, delegated: 0 };
  for (const s of sections) {
    for (const r of s.rows) {
      if (r.state === "actionable") openCounts.actionable++;
      else if (r.state === "decaying") openCounts.decaying++;
      else if (r.state === "delegated") openCounts.delegated++;
    }
  }

  return { date, sourceName, headerMarkdown, sections, mtimeMs, openCounts };
}

/** List ledger files for a source, newest first. */
export function listLedgers(src: Source): LedgerEntry[] {
  const dir = getLedgersPath(src);
  if (!dir || !existsSync(dir)) return [];
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch {
    return [];
  }
  const out: LedgerEntry[] = [];
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
    if (!m) continue;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(dir, f)).mtimeMs;
    } catch {
      continue;
    }
    out.push({ date: m[1], sourceName: src.name, mtimeMs });
  }
  out.sort((a, b) => b.date.localeCompare(a.date));
  return out;
}

/** Read + parse one ledger by date. Null when missing. */
export function readLedger(src: Source, date: string): LedgerDoc | null {
  const dir = getLedgersPath(src);
  if (!dir) return null;
  const path = join(dir, `${date}.md`);
  if (!existsSync(path)) return null;
  try {
    const raw = readFileSync(path, "utf-8");
    const mtimeMs = statSync(path).mtimeMs;
    return parseLedger(raw, date, src.name, mtimeMs);
  } catch {
    return null;
  }
}
