# synthesis-console

Local dashboard for synthesis engineering. Renders markdown and YAML project management files as browsable, searchable pages in a web browser.

## Tech Stack

- **Runtime:** Bun
- **Framework:** Hono (server-side rendering)
- **Dependencies:** hono, js-yaml, markdown-it (three packages total)
- **Styling:** one design system in `public/style.css` (3.0): a single token set for light and dark via `light-dark()`, a classless baseline, then components and views. No CSS framework.

## Architecture

- Server-side rendered HTML via template literal functions in `src/views/`
- Routes in `src/routes/` read files from disk on every request (no caching). The exception is program-backed synthesis v5 views (`synthesis doctor`, the context doctor): each run is time- and output-bounded and its result is kept for one minute (`src/cached-run.ts`) so a page load and the nav chip's poll share one run
- Config loaded from `~/.synthesis/console.yaml` with auto-detection fallback
- No client-side framework. `public/app.js` is the one client script (plain JavaScript, event delegation): theme, drawer, source picker, command palette, live status dots, drafts, one-tap queue and the plan page's decisions, tasks, find and refresh. Views add small inline scripts only for page-local behavior.
- Shared utilities (escapeHtml, escapeAttr, sanitizePathSegment) in `src/utils.ts`
- Version imported from package.json — no hardcoded version strings

### Source composition model (v0.2+)

Config declares a list of **sources**. Each source is self-describing: a name, a root directory, and one optional sub-path field per content type (`projects_dir`, `lessons_dir`, `plans_dir`, `notes_dir`, `preps_dir`, `ledgers_dir`). A source contributes to a view iff its corresponding sub-path is declared. Composition is a union of any active subset of sources; selection persists in the `sc_sources` cookie. As of v1.0.1 the active-source selection also GATES source-scoped detail routes — a URL naming a deselected source renders a 404 "Source not active" page (with a request-scoped `?sources=` escape hatch), so picker state is a real view boundary, not just a list filter.

Full rationale: `~/workspaces/rajiv/ai-knowledge-rajiv/projects/synthesis-console-build/adr-001-symmetric-sources.md`.

Abstract pattern (mechanism-vs-policy, capabilities-via-presence, source attribution): `~/workspaces/rajiv/ai-knowledge-rajiv/lessons/2026-04-22-symmetric-composable-sources.md`.

### Initiatives (v0.3+)

Inside each source's `projects/index.yaml`, an optional `initiatives:` section declares portfolio-level containers. Projects claim membership via an optional `initiative: <id>` field. The Initiatives nav item, `/initiatives/:source/:id` detail pages, and the grouped projects view all consume this data. Target ≤5 initiatives per source; the convention is curation-not-clustering. Projects without membership render in an "Ungrouped" section.

Full rationale: `~/workspaces/rajiv/ai-knowledge-rajiv/projects/synthesis-console-build/adr-002-initiatives.md`.

## Running

```bash
bun run dev    # dev mode with file watching
bun run start  # production mode
bun run demo   # demo mode with bundled sample data
```

## Project Structure

```
src/
  index.ts         — Entry point, Hono app setup, port auto-detection
  config.ts        — Config loader, source schema, auto-detect, path helpers
  active-sources.ts — Cookie/query/default resolution of active sources per request
  utils.ts         — Shared escapeHtml, escapeAttr, sanitizePathSegment
  v5.ts            — synthesis v5 locations (SYNTHESIS_HOME, default ~/.synthesis/v5) and the bounded Python script runner
  skill-resolution.ts — v5 skill folders: the runtime's current/skills, then harness plugin caches (v5 roots only)
  doctor.ts        — `synthesis doctor --json` runner and validation (/conformance)
  conversations.ts — `synthesis sessions list|search|show --json` runner and validation (/conversations)
  context-integrity.ts — v5 context doctor per active source (/context)
  autopilot.ts     — v5 autopilot run records and the plan-file reader (/autopilot)
  sync.ts          — v5 repo-guard report, read-only scan and quiet-audio flag (/sync)
  finite-command.ts — process-group custody for every program the Console runs
  routes/          — Route handlers (today, palette, projects, initiatives, lessons, plans, people + prep, ledger, v5 views). Each unions across active sources.
  parsers/         — YAML (projects + initiatives), markdown, plan sections, drafts, dated entries (plans, lessons)
  views/           — HTML template functions. layout.ts is the app shell (sidebar, top bar, picker); ui.ts holds the shared components (page header, badges, stat tiles, callouts, empty states); icons.ts the inline SVG icons; cockpit/ the plan page (shell, main column, rail, cards, summary)
public/
  style.css        — The design system: tokens, base, shell, components, views, responsive
  app.js           — The client script (see Architecture)
demo/
  ai-knowledge-demo/ — Bundled sample data for demo mode (new layout: top-level lessons/, daily-plans/)
docs/
  layouts.md       — Alternative layout recipes for adopters
  migration-v0.2.md — v0.1 → v0.2 config migration guide
console.yaml.example — Shipped config template (sanitized; mirrors author's personal + clients layout)
screenshots/       — README screenshots (taken from demo mode)
```

## Demo Mode

Demo mode uses bundled sample data in `demo/`, declared as a source with `demo: true`. The `--demo` flag filters active sources to demo-flagged ones. The built-in demo source is auto-injected even when a user config is present, so the demo is always one pick away in the source picker.

The `demo/` directory also serves as documentation-by-example of synthesis project management conventions, and as test data for future automated tests.

## URL Structure

- `/` — Today: today's plan (or the latest plan, labeled), system health, projects in motion, portfolio, autopilot runs, recent conversations
- `/api/palette` — the command palette's data (projects, initiatives, lessons, recent plans) from the active sources only; loopback Host required
- `/projects` — union across active sources; grouped by initiative by default when initiatives exist
- `/projects/:source/:id` — project detail (source-scoped); shows initiative link when project has one
- `/projects/:source/:id/sessions/:period` — session detail
- `/initiatives` — initiative cards across active sources (v0.3+)
- `/initiatives/:source/:id` — initiative detail: description, metadata, member projects, recent sessions
- `/lessons` — union by month (`?q=` filters by title)
- `/lessons/:source/:slug` — lesson detail (source-scoped)
- `/plans` — month calendar (`?month=YYYY-MM`; defaults to this month when it has plans, else the newest plan's month); the calendar picks the first source per date and the rail lists dates with plans from several sources
- `/plans/:source/:date` — plan detail (source-scoped); write-backs under it: `draft/:index` (PUT), `draft/:index/{send,skip,unskip}`, `decision/:index`, `decision/:index/undo`, `task/:index/{done,undone}` (POST), `mtime` (GET)
- `/people` — commitments view derived from the last 30 days of plans + prep packs across active sources (v0.13+)
- `/prep/:source/:slug` — meeting-prep pack detail; slug = filename without .md from the source's `meeting-preps/` dir (v0.13+)
- `/ledger` — newest catch-up ledger across active sources; `/ledger/:source/:date` for a specific sweep (v0.14+)
- `/autopilot` — synthesis v5 autopilot runs bounded by the active sources; `/autopilot/run/:session` for one run
- `/conformance`, `/context`, `/sync` — synthesis v5 doctor, context doctor and repo-guard views (not registered in demo mode)
- `/conversations`, `/conversations/:session` — agent conversations from `synthesis sessions --json`, read-only (not registered in demo mode)

Query params:
- `?sources=a,b` — override cookie for this session (useful for bookmarking)
- `?source=a,b` — filter within the already-active sources (projects list only)
- `?group=initiative` or `?group=status` — override default grouping in `/projects`
- `?initiative=<id>` — filter projects to one initiative; `_ungrouped` shows unassigned
- `?status=`, `?tag=`, `?client=`, `?q=` — standard filters

## Security

- URL path parameters sanitized via `sanitizePathSegment()` to prevent directory traversal
- HTML output uses centralized `escapeHtml()`/`escapeAttr()` from `src/utils.ts`
- Interactive elements use event delegation (no inline onclick handlers)
- Markdown rendered without sanitization (deliberate: local-only tool, user's own files)
- Cookie is non-HttpOnly / non-Secure by design — local-only tool, no sensitive state

## Conventions

- Views are pure functions: `(data) => string` returning HTML, built from the shared components in `views/ui.ts` so every page uses one vocabulary (page header, badge tones ok/warn/bad/info/neutral, cards, stat tiles, callouts, empty states)
- Color carries one meaning each (ok green, attention amber, problem red, info sky, neutral slate), and every status also carries a word
- Class names and data attributes that `public/app.js` reads are a contract (`.draft-actions`, `.cockpit-decision`, `.cockpit-task`, `.cockpit-onetap-draft`, `.cockpit-view` data-*, the `sync-chip` / `context-chip` / `conformance-chip` ids); change them only together with the script
- Routes read from disk, parse, pass to views, return response
- All paths use `~/` expansion for portability across machines
- No React, no JSX, no build step for content
- `demoMode` boolean threaded from config through routes to views
- Source badges shown on every merged list view; detail pages breadcrumb the source
