/**
 * Shared view components for the 3.0 design system. Pure functions that
 * return HTML strings; every caller-supplied value is escaped here unless the
 * parameter name ends in `Html`, which marks markup the caller built safely.
 */
import { escapeAttr, escapeHtml } from "../utils.js";
import { icon, type IconName } from "./icons.js";

/** The five status tones. Each means one thing everywhere. */
export type Tone = "ok" | "warn" | "bad" | "info" | "neutral";

export const PROJECT_STATUS_ORDER = [
  "active",
  "new",
  "paused",
  "ongoing",
  "completed",
  "archived",
  "superseded",
] as const;

/**
 * Project and initiative lifecycle as tones: in motion is info, parked
 * (paused) asks for attention, finished is ok, retired is neutral.
 */
export const PROJECT_STATUS_TONE: Record<string, Tone> = {
  active: "info",
  new: "info",
  ongoing: "info",
  paused: "warn",
  completed: "ok",
  archived: "neutral",
  superseded: "neutral",
};

export function capitalize(s: string): string {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

export function badge(label: string, tone: Tone = "neutral", opts: { plain?: boolean; title?: string } = {}): string {
  const title = opts.title ? ` title="${escapeAttr(opts.title)}"` : "";
  return `<span class="badge badge-${tone}${opts.plain ? " badge-plain" : ""}"${title}>${escapeHtml(label)}</span>`;
}

export function statusBadge(status: string): string {
  return badge(capitalize(status), PROJECT_STATUS_TONE[status] ?? "neutral");
}

export function sourceBadge(label: string, name?: string): string {
  return `<span class="source-badge" title="Source: ${escapeAttr(name ?? label)}">${escapeHtml(label)}</span>`;
}

export interface PageHeaderOpts {
  title: string;
  /** Count shown after the title, e.g. the number of items listed. */
  count?: number | string;
  lead?: string;
  leadHtml?: string;
  eyebrowHtml?: string;
  metaHtml?: string;
  actionsHtml?: string;
  className?: string;
}

/** Page header: the one question the page answers, its key numbers and actions. */
export function pageHeader(o: PageHeaderOpts): string {
  const count = o.count !== undefined && o.count !== "" ? ` <span class="page-count">${escapeHtml(String(o.count))}</span>` : "";
  const lead = o.leadHtml ?? (o.lead ? escapeHtml(o.lead) : "");
  return `<header class="page-header${o.className ? ` ${o.className}` : ""}">
  <div class="page-heading">
    ${o.eyebrowHtml ? `<div class="page-eyebrow">${o.eyebrowHtml}</div>` : ""}
    <h1 class="page-title">${escapeHtml(o.title)}${count}</h1>
    ${lead ? `<p class="page-lead">${lead}</p>` : ""}
    ${o.metaHtml ? `<div class="page-meta">${o.metaHtml}</div>` : ""}
  </div>
  ${o.actionsHtml ? `<div class="page-actions">${o.actionsHtml}</div>` : ""}
</header>`;
}

export interface EmptyStateOpts {
  icon?: IconName;
  title: string;
  body?: string;
  bodyHtml?: string;
  actionsHtml?: string;
  compact?: boolean;
}

export function emptyState(o: EmptyStateOpts): string {
  const body = o.bodyHtml ?? (o.body ? escapeHtml(o.body) : "");
  return `<div class="empty${o.compact ? " empty-compact" : ""}">
  <div class="empty-icon">${icon(o.icon ?? "inbox")}</div>
  <p class="empty-title">${escapeHtml(o.title)}</p>
  ${body ? `<p class="empty-body">${body}</p>` : ""}
  ${o.actionsHtml ? `<div class="empty-actions">${o.actionsHtml}</div>` : ""}
</div>`;
}

const CALLOUT_ICON: Record<Tone, IconName> = {
  ok: "checkCircle",
  warn: "alert",
  bad: "alertCircle",
  info: "info",
  neutral: "info",
};

/** A callout box. `bodyHtml` is trusted markup; `role` lets alerts announce. */
export function callout(tone: Tone, bodyHtml: string, opts: { title?: string; role?: "alert" | "status" | "note" } = {}): string {
  const role = opts.role ? ` role="${opts.role}"` : "";
  const title = opts.title ? `<strong class="callout-title">${escapeHtml(opts.title)}</strong>` : "";
  return `<div class="callout callout-${tone}"${role}>${icon(CALLOUT_ICON[tone])}<div>${title}${bodyHtml}</div></div>`;
}

export interface StatOpts {
  label: string;
  value: string | number;
  /** Optional "of N" suffix rendered small after the value. */
  of?: string | number;
  sub?: string;
  tone?: Tone;
  href?: string;
  iconName?: IconName;
  /** 0–100; renders a progress bar under the value. */
  progress?: number;
}

export function statTile(o: StatOpts): string {
  const tag = o.href ? "a" : "div";
  const href = o.href ? ` href="${escapeAttr(o.href)}"` : "";
  const of = o.of !== undefined ? ` <small>/ ${escapeHtml(String(o.of))}</small>` : "";
  const progress = o.progress !== undefined ? progressBar(o.progress, o.progress >= 100 ? "ok" : undefined) : "";
  return `<${tag} class="stat${o.tone ? ` stat-${o.tone}` : ""}"${href}>
  <span class="stat-label">${o.iconName ? icon(o.iconName, "icon-sm") : ""}${escapeHtml(o.label)}</span>
  <span class="stat-value">${escapeHtml(String(o.value))}${of}</span>
  ${o.sub ? `<span class="stat-sub">${escapeHtml(o.sub)}</span>` : ""}
  ${progress}
</${tag}>`;
}

export function progressBar(pct: number, tone?: "ok" | "warn"): string {
  const clamped = Math.max(0, Math.min(100, Math.round(pct)));
  return `<div class="progress${tone ? ` progress-${tone}` : ""}" aria-hidden="true"><div class="progress-bar" style="--pct:${clamped}"></div></div>`;
}

/** The banner every page shows while demo data is in view. */
export function demoBanner(): string {
  return `<div class="demo-banner" role="status">${icon("info")}<div><strong class="callout-title">You're viewing demo data</strong>Sample projects, plans and lessons that illustrate the conventions the Console renders. <a href="https://github.com/synthesisengineering/synthesis-console">Learn more</a></div></div>`;
}

/** Two-letter initials for an avatar. */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** "Thursday, October 30" from a YYYY-MM-DD date, in local time. */
export function longDate(date: string, withYear = false): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", {
    weekday: "long",
    month: "long",
    day: "numeric",
    ...(withYear ? { year: "numeric" } : {}),
  });
}

/** "Oct 30" from a YYYY-MM-DD date. */
export function shortDate(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return date;
  return new Date(y, m - 1, d).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** Today's date as YYYY-MM-DD in the server's (the principal's) local time. */
export function todayIso(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/**
 * Rendered markdown without its leading H1 (and, when asked, the field
 * paragraph right after it), for pages whose header already shows them.
 */
export function withoutLeadingTitle(html: string, opts: { fields?: RegExp } = {}): string {
  let out = html.replace(/^\s*<h1[^>]*>[\s\S]*?<\/h1>\s*/, "");
  if (opts.fields) {
    const m = out.match(/^\s*<p>([\s\S]*?)<\/p>\s*/);
    if (m && opts.fields.test(m[1])) out = out.slice(m[0].length);
  }
  return out;
}
