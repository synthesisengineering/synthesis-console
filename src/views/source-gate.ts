/**
 * Gate page for detail routes whose source is not active (v1.0.1).
 *
 * Shown with a 404 status when a URL names a configured source the user has
 * deselected in the source picker. The page explains why the content isn't
 * rendering and offers two recoveries:
 *   1. A one-request "view anyway" link (adds ?sources=<active + this one>
 *      to the same URL — request-scoped override, nothing persisted).
 *   2. The source picker in the header, which persists.
 *
 * Deliberately minimal: it names only the source slug already visible in
 * the URL bar and says nothing about the content behind it, so an audience
 * watching a screen-share sees no more than the URL they were already
 * looking at.
 */
import { escapeHtml, escapeAttr } from "../utils.js";

export function sourceGateView(opts: {
  sourceName: string;
  currentPath: string;
  activeNames: string[];
}): string {
  const withSource = [...opts.activeNames, opts.sourceName].join(",");
  const viewAnywayHref = `${opts.currentPath}?sources=${encodeURIComponent(withSource)}`;
  return `
    <hgroup>
      <h1>Source not active</h1>
      <p>This page belongs to the <strong>${escapeHtml(opts.sourceName)}</strong> source, which is not selected in your source picker. Content from deselected sources doesn't render — including from direct links and bookmarks.</p>
    </hgroup>
    <p>
      <a href="${escapeAttr(viewAnywayHref)}" role="button" class="secondary">View this page anyway (this request only)</a>
    </p>
    <p><small>To make it stick, re-enable <strong>${escapeHtml(opts.sourceName)}</strong> in the source picker (top right). If you're presenting from the Demo source, leaving this off is the point.</small></p>
  `;
}
