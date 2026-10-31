import type { Source } from "../config.js";
import { escapeHtml, escapeAttr } from "../utils.js";
import { SOURCES_COOKIE } from "../active-sources.js";
import { brandMark, icon, type IconName } from "./icons.js";
import pkg from "../../package.json";

/** One step of the top bar's breadcrumb; the last step is the current page. */
export interface Crumb {
  label: string;
  href?: string;
}

interface NavItem {
  href: string;
  label: string;
  icon: IconName;
  /** Path prefixes that make this item current. */
  match: string[];
  /** Live status: the element id the client script updates. */
  chip?: string;
  chipTitle?: string;
  /** Routes that are not registered in demo mode. */
  hideInDemo?: boolean;
}

interface NavGroup {
  label: string | null;
  items: NavItem[];
}

const NAV: NavGroup[] = [
  {
    label: null,
    items: [{ href: "/", label: "Today", icon: "sun", match: [] }],
  },
  {
    label: "Plan",
    items: [
      { href: "/plans", label: "Daily plans", icon: "calendar", match: ["/plans"] },
      { href: "/people", label: "People", icon: "users", match: ["/people", "/prep"] },
      { href: "/ledger", label: "Ledger", icon: "ledger", match: ["/ledger"] },
    ],
  },
  {
    label: "Work",
    items: [
      { href: "/projects", label: "Projects", icon: "folder", match: ["/projects"] },
      { href: "/initiatives", label: "Initiatives", icon: "target", match: ["/initiatives"] },
      { href: "/lessons", label: "Lessons", icon: "bulb", match: ["/lessons"] },
      { href: "/conversations", label: "Conversations", icon: "chat", match: ["/conversations"], hideInDemo: true },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/autopilot", label: "Autopilot", icon: "compass", match: ["/autopilot"], chip: "autopilot-chip", chipTitle: "Autopilot runs" },
      { href: "/context", label: "Context", icon: "fileCheck", match: ["/context"], chip: "context-chip", chipTitle: "Context integrity", hideInDemo: true },
      { href: "/conformance", label: "Conformance", icon: "shield", match: ["/conformance"], chip: "conformance-chip", chipTitle: "Conformance (synthesis doctor)", hideInDemo: true },
      { href: "/sync", label: "Sync", icon: "sync", match: ["/sync"], chip: "sync-chip", chipTitle: "Repo sync status", hideInDemo: true },
    ],
  },
];

/** The section label for a path, used as the default breadcrumb. */
export function sectionFor(path: string): { label: string; href: string } | null {
  for (const group of NAV) {
    for (const item of group.items) {
      if (item.href === "/" ? path === "/" : item.match.some((m) => path === m || path.startsWith(m + "/"))) {
        return { label: item.label, href: item.href };
      }
    }
  }
  return null;
}

export function layout(opts: {
  title: string;
  content: string;
  sources: Source[];
  activeSourceNames: string[];
  currentPath?: string;
  demoMode: boolean;
  /** Wider page for dense views (the plan page, tables of checks and sessions). */
  wide?: boolean;
  /** Reading width for long-form pages. */
  narrow?: boolean;
  /** Breadcrumb trail; defaults to the current section. */
  crumbs?: Crumb[];
}): string {
  const currentPath = opts.currentPath || "";
  const visibleSources = opts.demoMode
    ? opts.sources.filter((s) => s.demo === true)
    : opts.sources;

  const isDemoActive =
    opts.demoMode ||
    opts.activeSourceNames.some((n) => opts.sources.find((s) => s.name === n)?.demo === true);

  const demoBadge = isDemoActive ? ' <span class="badge-demo">Demo</span>' : "";
  const nav = buildNav(currentPath, opts.demoMode);
  const picker = buildSourcePicker(visibleSources, opts.activeSourceNames, opts.demoMode);
  const crumbs = buildCrumbs(opts.crumbs, currentPath, opts.title);
  const pageClass = opts.wide ? "page page-wide" : opts.narrow ? "page page-narrow" : "page";
  const v = encodeURIComponent(pkg.version);

  return `<!DOCTYPE html>
<html lang="en" data-sources-cookie="${escapeAttr(SOURCES_COOKIE)}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
  <!-- The console reads files fresh on every request. Never cache the HTML —
       any stored copy is by definition stale. HTTP Cache-Control headers
       (no-store, no-cache) are the primary defense; these meta tags are
       belt-and-suspenders in case headers are stripped by an intermediary. -->
  <meta http-equiv="Cache-Control" content="no-store, no-cache, must-revalidate, max-age=0">
  <meta http-equiv="Pragma" content="no-cache">
  <meta http-equiv="Expires" content="0">
  <meta name="color-scheme" content="light dark">
  <meta name="theme-color" media="(prefers-color-scheme: light)" content="#f6f7f9">
  <meta name="theme-color" media="(prefers-color-scheme: dark)" content="#0b111b">
  <title>${escapeHtml(opts.title)} · Synthesis Console</title>
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <script>${preferencesScript()}</script>
  <link rel="stylesheet" href="/style.css?v=${v}">
  <script src="/app.js?v=${v}" defer></script>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <div class="app" data-sidebar="closed">
    <aside class="app-sidebar" id="app-sidebar" aria-label="Sidebar">
      <div class="sidebar-head">
        <a href="/" class="brand">${brandMark()}<span class="brand-name">Synthesis Console</span>${demoBadge}</a>
        <button type="button" class="icon-btn sidebar-close" aria-label="Close menu">${icon("x")}</button>
      </div>
      <div class="sidebar-scroll">
        ${picker}
        <nav class="sidebar-nav" aria-label="Main navigation">
          ${nav}
        </nav>
      </div>
      <div class="sidebar-foot">
        <div class="theme-switch" role="group" aria-label="Color theme">
          <button type="button" class="theme-btn" data-theme-choice="light" aria-pressed="false" aria-label="Light theme" title="Light">${icon("sun")}</button>
          <button type="button" class="theme-btn" data-theme-choice="dark" aria-pressed="false" aria-label="Dark theme" title="Dark">${icon("moon")}</button>
          <button type="button" class="theme-btn" data-theme-choice="system" aria-pressed="true" aria-label="Match system theme" title="Match system">${icon("monitor")}</button>
        </div>
        <a class="sidebar-version" href="https://github.com/synthesisengineering/synthesis-console" title="Synthesis Console v${escapeAttr(pkg.version)}: local-first tooling for synthesis engineering">v${escapeHtml(pkg.version)}</a>
      </div>
    </aside>
    <div class="app-scrim" hidden></div>
    <div class="app-main">
      <header class="topbar">
        <button type="button" class="icon-btn menu-btn" aria-label="Open menu" aria-controls="app-sidebar" aria-expanded="false">${icon("menu")}</button>
        <nav class="breadcrumb" aria-label="Breadcrumb">${crumbs}</nav>
        <button type="button" class="palette-trigger" aria-haspopup="dialog" aria-keyshortcuts="Meta+K Control+K" title="Search and jump (⌘K)">${icon("search")}<span>Search or jump to…</span><kbd>⌘K</kbd></button>
      </header>
      <main id="main-content" tabindex="-1" class="${pageClass}">
        ${opts.content}
      </main>
    </div>
  </div>
</body>
</html>`;
}

function isCurrent(item: NavItem, path: string): boolean {
  if (item.href === "/") return path === "/";
  return item.match.some((m) => path === m || path.startsWith(m + "/"));
}

function buildNav(currentPath: string, demoMode: boolean): string {
  return NAV.map((group) => {
    const items = group.items
      .filter((item) => !(demoMode && item.hideInDemo))
      .map((item) => {
        const current = isCurrent(item, currentPath) ? ' aria-current="page"' : "";
        // In demo mode no machine state is read, so no item carries a live status.
        if (item.chip && !demoMode) {
          return `<li><a href="${item.href}" id="${item.chip}" class="nav-link sync-chip sync-checking" title="${escapeAttr(item.chipTitle ?? item.label)}"${current}>${icon(item.icon, "nav-icon")}<span class="nav-label">${escapeHtml(item.label)}</span><span class="nav-status"><span class="sync-chip-count" aria-hidden="true"></span><span class="nav-dot" aria-hidden="true"></span></span><span class="sr-only nav-status-text"></span></a></li>`;
        }
        return `<li><a href="${item.href}" class="nav-link"${current}>${icon(item.icon, "nav-icon")}<span class="nav-label">${escapeHtml(item.label)}</span></a></li>`;
      })
      .join("");
    if (!items) return "";
    if (!group.label) return `<ul class="nav-list">${items}</ul>`;
    const id = `nav-${group.label.toLowerCase()}`;
    return `<div class="nav-group" role="group" aria-labelledby="${id}"><p class="nav-group-label" id="${id}">${escapeHtml(group.label)}</p><ul class="nav-list">${items}</ul></div>`;
  }).join("\n");
}

function buildCrumbs(crumbs: Crumb[] | undefined, currentPath: string, title: string): string {
  let trail = crumbs;
  if (!trail) {
    const section = sectionFor(currentPath);
    trail = section
      ? currentPath === section.href || section.label === title
        ? [{ label: section.label }]
        : [{ label: section.label, href: section.href }, { label: title }]
      : [{ label: title }];
  }
  const items = trail
    .map((c, i) => {
      const last = i === trail!.length - 1;
      if (last) return `<li><span aria-current="page">${escapeHtml(c.label)}</span></li>`;
      return c.href ? `<li><a href="${escapeAttr(c.href)}">${escapeHtml(c.label)}</a></li>` : `<li><span>${escapeHtml(c.label)}</span></li>`;
    })
    .join("");
  return `<ol>${items}</ol>`;
}

function buildSourcePicker(
  sources: Source[],
  activeNames: string[],
  demoMode: boolean
): string {
  if (sources.length <= 1) {
    const only = sources[0];
    if (!only) return "";
    return `<div class="source-picker"><div class="source-picker-static">${icon("layers", "icon")}<span class="picker-label"><span class="picker-eyebrow">Source</span><span class="picker-value">${escapeHtml(only.display_name || only.name)}</span></span></div></div>`;
  }

  const activeSet = new Set(activeNames);
  const activeCount = sources.filter((s) => activeSet.has(s.name)).length;
  const summary =
    activeCount === sources.length
      ? "All sources"
      : activeCount === 0
        ? "No sources"
        : activeCount === 1
          ? sources.find((s) => activeSet.has(s.name))?.display_name ||
            sources.find((s) => activeSet.has(s.name))?.name ||
            "1 source"
          : `${activeCount} of ${sources.length} sources`;

  const disabled = demoMode ? " disabled" : "";
  const hint = demoMode
    ? `<p class="picker-help">Demo mode is active; source selection is disabled.</p>`
    : "";

  const items = sources
    .map((s) => {
      const checked = activeSet.has(s.name) ? " checked" : "";
      const label = escapeHtml(s.display_name || s.name);
      const demoLabel = s.demo ? ' <span class="badge-demo">Demo</span>' : "";
      return `<li><label class="picker-option"><input type="checkbox" name="source" value="${escapeAttr(s.name)}"${checked}${disabled}> ${label}${demoLabel}</label></li>`;
    })
    .join("\n");

  return `<details class="source-picker">
          <summary title="Choose which sources every page shows">${icon("layers")}<span class="picker-label"><span class="picker-eyebrow">Sources</span><span class="picker-value">${escapeHtml(summary)}</span></span>${icon("chevronDown", "icon picker-chevron")}</summary>
          <div class="picker-panel">
            <fieldset><legend>Active sources</legend><ul class="picker-list">
              ${items}
            </ul></fieldset>
            <p id="source-help" class="picker-help">Choose sources, then apply. Escape closes this menu.</p>
            <button type="button" class="source-apply btn-primary" aria-describedby="source-help"${disabled}>Apply sources</button>
            ${hint}
          </div>
        </details>`;
}

/**
 * Runs in <head> before the stylesheet paints: applies the saved theme and
 * the remembered projects view so neither flashes on load. Storage can throw
 * (private windows, blocked site data); the page renders correctly without it.
 */
function preferencesScript(): string {
  return `(function(){try{var d=document.documentElement;var t=localStorage.getItem('sc_theme');if(t==='light'||t==='dark')d.setAttribute('data-theme',t);var v=localStorage.getItem('sc_projects_view');if(v==='table')d.setAttribute('data-projects-view','table');}catch(_){}})();`;
}
