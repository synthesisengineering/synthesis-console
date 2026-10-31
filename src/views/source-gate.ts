/**
 * Gate page for detail routes whose source is not active (v1.0.1), and the
 * shared not-found page.
 *
 * The gate is shown with a 404 status when a URL names a configured source
 * the user has deselected in the source picker. It explains why the content
 * isn't rendering and offers two recoveries:
 *   1. A one-request "view anyway" link (adds ?sources=<active + this one>
 *      to the same URL — request-scoped override, nothing persisted).
 *   2. The source picker in the sidebar, which persists.
 *
 * Deliberately minimal: it names only the source slug already visible in
 * the URL bar and says nothing about the content behind it, so an audience
 * watching a screen-share sees no more than the URL they were already
 * looking at.
 */
import { escapeHtml, escapeAttr } from "../utils.js";
import { icon } from "./icons.js";
import { emptyState } from "./ui.js";

export function sourceGateView(opts: {
  sourceName: string;
  currentPath: string;
  activeNames: string[];
}): string {
  const withSource = [...opts.activeNames, opts.sourceName].join(",");
  const viewAnywayHref = `${opts.currentPath}?sources=${encodeURIComponent(withSource)}`;
  return `<div class="state-page">
${emptyState({
  icon: "layers",
  title: "Source not active",
  bodyHtml: `This page belongs to the <strong>${escapeHtml(opts.sourceName)}</strong> source, which is not selected in your source picker. Content from deselected sources doesn't render, including from direct links and bookmarks.`,
  actionsHtml: `<a href="${escapeAttr(viewAnywayHref)}" class="btn">${icon("eye")}View this page anyway (this request only)</a>`,
})}
<p class="footnote">To make it stick, re-enable <strong>${escapeHtml(opts.sourceName)}</strong> in the source picker in the sidebar. If you're presenting from the Demo source, leaving this off is the point.</p>
</div>`;
}

/**
 * Not-found page. `messageHtml` is trusted markup: callers escape any
 * value from the URL before building it.
 */
export function notFoundView(opts: { message?: string; messageHtml?: string; backHref?: string; backLabel?: string }): string {
  const body = opts.messageHtml ?? escapeHtml(opts.message ?? "There is nothing at this address.");
  const back = opts.backHref
    ? `<a class="btn" href="${escapeAttr(opts.backHref)}">${icon("arrowLeft")}${escapeHtml(opts.backLabel ?? "Back")}</a>`
    : `<a class="btn" href="/">${icon("sun")}Go to Today</a>`;
  return `<div class="state-page">${emptyState({ icon: "search", title: "Not found", bodyHtml: body, actionsHtml: back })}</div>`;
}
