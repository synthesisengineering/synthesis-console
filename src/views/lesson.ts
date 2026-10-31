import type { Source } from "../config.js";
import { escapeHtml, escapeAttr } from "../utils.js";
import { icon } from "./icons.js";
import { emptyState, longDate, pageHeader, sourceBadge, withoutLeadingTitle } from "./ui.js";

export interface LessonEntry {
  slug: string;
  filename: string;
  date: string;
  title: string;
  source: string;
}

function monthLabel(date: string): string {
  const [y, m] = date.split("-").map(Number);
  if (!y || !m) return date;
  return new Date(y, m - 1, 1).toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function dayLabel(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function lessonListView(opts: {
  lessons: LessonEntry[];
  sources: Source[];
  query?: string;
  total?: number;
}): string {
  const { lessons, sources } = opts;
  const query = opts.query ?? "";
  const total = opts.total ?? lessons.length;

  const header = pageHeader({
    title: "Lessons",
    count: total,
    lead: "Distilled, cross-project lessons, newest first.",
  });

  if (total === 0) {
    return `${header}${emptyState({ icon: "bulb", title: "No lessons yet", body: "Lessons come from each source's lessons folder, one dated markdown file per lesson." })}`;
  }

  const sourceByName = new Map(sources.map((s) => [s.name, s]));
  const showSource = sources.length > 1;

  const byMonth = new Map<string, LessonEntry[]>();
  for (const l of lessons) {
    const key = l.date.slice(0, 7);
    if (!byMonth.has(key)) byMonth.set(key, []);
    byMonth.get(key)!.push(l);
  }

  const months = [...byMonth.entries()]
    .map(([key, list]) => {
      const rows = list
        .map((l) => {
          const src = sourceByName.get(l.source);
          const label = src ? src.display_name || src.name : l.source;
          return `<li data-lesson-title="${escapeAttr(l.title.toLowerCase())}"><a class="list-row" href="/lessons/${encodeURIComponent(l.source)}/${encodeURIComponent(l.slug)}">
            <time class="lesson-row-date" datetime="${escapeAttr(l.date)}">${escapeHtml(dayLabel(l.date))}</time>
            <span class="list-row-main"><span class="list-row-title">${escapeHtml(l.title)}</span></span>
            ${showSource ? `<span class="list-row-meta">${sourceBadge(label, l.source)}</span>` : ""}
          </a></li>`;
        })
        .join("");
      return `<section class="lesson-month" data-month="${escapeAttr(key)}"><h2 class="lesson-month-label">${escapeHtml(monthLabel(key + "-01"))}</h2><ul class="list">${rows}</ul></section>`;
    })
    .join("\n");

  const noMatch = emptyState({
    icon: "search",
    title: "No lessons match",
    body: "Try another word, or clear the search.",
    actionsHtml: `<a class="btn" href="/lessons">Clear search</a>`,
  });

  return `
    ${header}
    <div class="toolbar">
      <div class="search-field">${icon("search")}<input type="search" id="lesson-search" placeholder="Filter lessons by title" value="${escapeAttr(query)}" aria-label="Filter lessons" aria-controls="lesson-results"></div>
      <span class="muted" id="lesson-count" role="status" aria-live="polite">${lessons.length === total ? `${total} lessons` : `${lessons.length} of ${total} lessons`}</span>
    </div>
    <div id="lesson-results">
      ${lessons.length ? months : noMatch}
      <div id="lesson-nomatch" hidden>${noMatch}</div>
    </div>
    <script>
      (function () {
        var input = document.getElementById('lesson-search');
        var count = document.getElementById('lesson-count');
        var none = document.getElementById('lesson-nomatch');
        if (!input) return;
        var total = ${total};
        function apply() {
          var q = input.value.trim().toLowerCase();
          var shown = 0;
          document.querySelectorAll('[data-lesson-title]').forEach(function (li) {
            var hit = !q || li.getAttribute('data-lesson-title').indexOf(q) !== -1;
            li.hidden = !hit;
            if (hit) shown++;
          });
          document.querySelectorAll('.lesson-month').forEach(function (m) {
            m.hidden = !m.querySelector('[data-lesson-title]:not([hidden])');
          });
          if (none) none.hidden = shown !== 0 || !document.querySelector('[data-lesson-title]');
          count.textContent = shown === total ? total + ' lessons' : shown + ' of ' + total + ' lessons';
          var url = new URL(window.location);
          if (q) url.searchParams.set('q', input.value.trim()); else url.searchParams.delete('q');
          history.replaceState(null, '', url);
        }
        input.addEventListener('input', apply);
      })();
    </script>
  `;
}

export function lessonDetailView(opts: {
  lesson: LessonEntry;
  contentHtml: string;
  sourceLabel?: string;
}): string {
  return `
    <div class="lesson-reading">
      ${pageHeader({
        title: opts.lesson.title,
        eyebrowHtml: `${sourceBadge(opts.sourceLabel ?? opts.lesson.source, opts.lesson.source)}${opts.lesson.date ? `<span>${icon("calendar", "icon-sm")} <time datetime="${escapeAttr(opts.lesson.date)}">${escapeHtml(longDate(opts.lesson.date, true))}</time></span>` : ""}`,
      })}
      <article class="card doc-card">
        <div class="rendered-markdown">
          ${withoutLeadingTitle(opts.contentHtml, { fields: /^\s*<strong>Date:<\/strong>[^<]*$/ })}
        </div>
      </article>
    </div>
  `;
}
