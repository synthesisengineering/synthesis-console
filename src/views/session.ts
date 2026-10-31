import { escapeHtml } from "../utils.js";
import { icon } from "./icons.js";
import { pageHeader, sourceBadge } from "./ui.js";
import { periodLabel } from "./project-detail.js";

export function sessionDetailView(opts: {
  projectId: string;
  projectName: string;
  period: string;
  contentHtml: string;
  sourceName: string;
  sourceLabel?: string;
}): string {
  const projectHref = `/projects/${encodeURIComponent(opts.sourceName)}/${encodeURIComponent(opts.projectId)}`;
  return `
    ${pageHeader({
      title: `Session log · ${periodLabel(opts.period)}`,
      eyebrowHtml: `${sourceBadge(opts.sourceLabel ?? opts.sourceName, opts.sourceName)}<a href="${projectHref}">${icon("folder", "icon-sm")} ${escapeHtml(opts.projectName)}</a>`,
      actionsHtml: `<a class="btn" href="${projectHref}">${icon("arrowLeft")}Back to project</a>`,
    })}
    <section class="card doc-card" aria-label="Session log">
      <h2 class="doc-card-title"><span>Sessions</span><span class="file-name">sessions/${escapeHtml(opts.period)}.md</span></h2>
      <div class="rendered-markdown">
        ${opts.contentHtml}
      </div>
    </section>
  `;
}
