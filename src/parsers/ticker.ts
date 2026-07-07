/**
 * TICKER ("On your behalf") item parsing (v0.10+, extracted to the parser
 * layer in v0.13 when the people view — a parser — needed it too).
 *
 * Contract from synthesis-daily-rituals v2.10.0+:
 *   Each item is a list line of shape
 *     `- HH:MM · target · action · [permalink](url)` (canonical), OR
 *     `- HH:MM · target · action` (no permalink yet), OR
 *     any list line the parser doesn't recognize — falls back to raw
 *   markdown rendering per the "never lose data" principle.
 */
export interface TickerItem {
  time?: string;
  target?: string;
  action?: string;
  permalink?: string;
  rawLine: string;
}

const TICKER_LINE_RE = /^\s*[-*+]\s+(?:\*\*)?(\d{1,2}:\d{2}(?:\s*[A-Z]{2,4})?)(?:\*\*)?\s*[·|]\s*(.+?)\s*[·|]\s*(.+?)(?:\s*[·|]\s*\[([^\]]+)\]\((https?:\/\/[^)]+)\)\s*)?$/;

export function parseTickerBody(rawBody: string): TickerItem[] {
  const items: TickerItem[] = [];
  for (const line of rawBody.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    if (!/^[-*+]\s/.test(trimmed)) continue;
    const m = trimmed.match(TICKER_LINE_RE);
    if (m) {
      items.push({
        time: m[1],
        target: m[2],
        action: m[3],
        permalink: m[5],
        rawLine: trimmed,
      });
    } else {
      items.push({ rawLine: trimmed });
    }
  }
  return items;
}
