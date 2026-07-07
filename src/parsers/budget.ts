/**
 * Budget line parser for Cockpit Mode plans (v0.12+).
 *
 * The producer contract (synthesis-daily-rituals v2.10.0+) puts a single
 * `**Budget:**` line in the plan header (pre-first-H2 area). Canonical
 * shape:
 *
 *   **Budget:** Windows HH:MM–HH:MM · HH:MM–HH:MM · HH:MM–HH:MM = 210 min.
 *   Committed: 145 min (69%). Buffer: 65 min.
 *
 * The parser tolerates variations — em-dash vs hyphen in ranges, comma vs
 * period separators, "buffer" vs "preemption buffer", missing percentage,
 * etc. Anything it can't parse falls back to `null` and the TODAY region
 * renders without a budget bar (the rest of TODAY still works).
 */
export interface Window {
  start: string; // "09:30"
  end: string;   // "11:00"
  minutes: number;
}

export interface BudgetInfo {
  windows: Window[];
  totalMinutes: number;
  committedMinutes: number;
  bufferMinutes: number;
  committedPercent: number;
  /** Whether the parser got a full parse (all fields present) or a partial one. */
  complete: boolean;
}

const BUDGET_LINE_RE = /\*\*\s*Budget\s*:?\s*\*\*\s*([^\n]+)/i;
const WINDOW_RE = /(\d{1,2}:\d{2})\s*[–\-—]\s*(\d{1,2}:\d{2})/g;
const TOTAL_RE = /=\s*(\d+)\s*min/i;
const COMMITTED_RE = /Committed\s*:?\s*(\d+)\s*min(?:\s*\((\d+)%\))?/i;
const BUFFER_RE = /Buffer\s*:?\s*(\d+)\s*min/i;

/**
 * Minutes between HH:MM and HH:MM in the same day. Handles times that cross
 * hour boundaries; does not handle midnight crossings (not a realistic
 * daily-plan case).
 */
function minutesBetween(start: string, end: string): number {
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  return (eh * 60 + em) - (sh * 60 + sm);
}

/**
 * Extract the Budget info from the raw plan text. Scans the entire file
 * but stops at the first match (canonical placement is header pre-H2).
 * Returns `null` when no Budget line is present.
 */
export function parseBudget(raw: string): BudgetInfo | null {
  const match = raw.match(BUDGET_LINE_RE);
  if (!match) return null;
  const line = match[1];
  const windows: Window[] = [];
  let m: RegExpExecArray | null;
  WINDOW_RE.lastIndex = 0;
  while ((m = WINDOW_RE.exec(line)) !== null) {
    const start = m[1];
    const end = m[2];
    const minutes = minutesBetween(start, end);
    if (minutes > 0) windows.push({ start, end, minutes });
  }
  const totalFromWindows = windows.reduce((n, w) => n + w.minutes, 0);
  const totalMatch = line.match(TOTAL_RE);
  const totalMinutes = totalMatch ? Number(totalMatch[1]) : totalFromWindows;

  const commMatch = line.match(COMMITTED_RE);
  const committedMinutes = commMatch ? Number(commMatch[1]) : 0;
  const bufferMatch = line.match(BUFFER_RE);
  const bufferMinutes = bufferMatch ? Number(bufferMatch[1]) : Math.max(0, totalMinutes - committedMinutes);

  const committedPercent = commMatch && commMatch[2]
    ? Number(commMatch[2])
    : totalMinutes > 0
      ? Math.round((committedMinutes / totalMinutes) * 100)
      : 0;

  const complete = windows.length > 0 && totalMinutes > 0 && committedMinutes > 0 && bufferMinutes >= 0;
  return {
    windows,
    totalMinutes,
    committedMinutes,
    bufferMinutes,
    committedPercent,
    complete,
  };
}
