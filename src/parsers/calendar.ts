/**
 * Calendar section parser for Cockpit Mode plans (v0.12+).
 *
 * Producer contract (synthesis-daily-rituals v2.10.0+): the ritual writes
 * a `## 📅 Calendar` H2 with one list item per event. Canonical shape:
 *
 *   - HH:MM–HH:MM · title · attendees (comma-separated)
 *
 * The parser tolerates dashes (–, —, -), missing attendees, and lines that
 * don't match the canonical shape (rendered as raw markdown so no data is
 * lost).
 *
 * Calendar reads happen ritual-side because the Bun server can't call MCP
 * (see D3 in the execution plan). The ritual (running in Claude Code)
 * fetches events via Apple Calendar MCP at day-start + mid-day sweeps and
 * writes them here.
 */
export interface CalendarEvent {
  start?: string;      // "09:30"
  end?: string;        // "11:00"
  title?: string;
  attendees?: string;
  rawLine: string;
}

const EVENT_LINE_RE = /^\s*[-*+]\s+(?:\*\*)?(\d{1,2}:\d{2})\s*[–\-—]\s*(\d{1,2}:\d{2})(?:\*\*)?\s*[·|]\s*(.+?)(?:\s*[·|]\s*(.+))?$/;

export function parseCalendarBody(rawBody: string): CalendarEvent[] {
  const events: CalendarEvent[] = [];
  for (const line of rawBody.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!/^[-*+]\s/.test(trimmed)) continue;
    const m = trimmed.match(EVENT_LINE_RE);
    if (m) {
      events.push({
        start: m[1],
        end: m[2],
        title: (m[3] || "").trim(),
        attendees: m[4] ? m[4].trim() : undefined,
        rawLine: trimmed,
      });
    } else {
      events.push({ rawLine: trimmed });
    }
  }
  return events;
}
