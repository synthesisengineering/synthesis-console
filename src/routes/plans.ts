import { Hono } from "hono";
import { existsSync, readdirSync, readFileSync, writeFileSync, renameSync, statSync } from "fs";
import { join } from "path";
import type { ConsoleConfig, Source } from "../config.js";
import { getPlansPath, findSource, getSlackToken } from "../config.js";
import { readAndRenderPlanMarkdown, readAndRenderPlanForCockpit } from "../parsers/markdown.js";
import { replaceDraftBody, findDraftBlocks, markDraftAsSent, markDraftAsSkipped, unmarkDraftAsSkipped } from "../parsers/draft-blocks.js";
import { recordDecision, markTaskDone, unmarkTaskDone } from "../parsers/plan-mutations.js";
import { loadProjectsFromSources } from "../parsers/yaml.js";
import { loadSlackDirectory } from "../parsers/slack-directory.js";
import { resolveMentions, listResolvedMentions } from "../parsers/slack-mentions.js";
import { postSlackMessage } from "../integrations/slack-send.js";
import { layout } from "../views/layout.js";
import { planListView, planDetailView } from "../views/plan.js";
import { planCockpitView } from "../views/plan-cockpit.js";
import { planRolloverView } from "../views/plan-rollover.js";
import { findCarryoverTasks, countCarryoverTasks } from "../parsers/plan-rollover.js";
import type { PlanEntry } from "../views/plan.js";
import { escapeHtml, sanitizePathSegment } from "../utils.js";
import { activeSources } from "../active-sources.js";

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function parsePlanFilename(filename: string, sourceName: string): PlanEntry | null {
  const match = filename.match(/^(\d{4}-\d{2}-\d{2})\.md$/);
  if (!match) return null;
  const date = match[1];
  const [y, m, d] = date.split("-").map(Number);
  const dayOfWeek = DAYS[new Date(y, m - 1, d).getDay()];
  return { date, filename, dayOfWeek, source: sourceName };
}

/**
 * Whether a plan's date is within `n` days of the reference date (inclusive).
 * Used to filter the calendar window for the v0.9 left sidebar — keep the
 * mini calendar's plan list bounded to roughly prev/current/next month around
 * the date being viewed, not the entire archive.
 */
function withinDays(planDate: string, refDate: string, n: number): boolean {
  const a = Date.parse(planDate + "T00:00:00Z");
  const b = Date.parse(refDate + "T00:00:00Z");
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const diffMs = Math.abs(a - b);
  const oneDay = 86_400_000;
  return diffMs / oneDay <= n;
}

function loadPlansFromSource(src: Source): PlanEntry[] {
  const plansDir = getPlansPath(src);
  if (!plansDir || !existsSync(plansDir)) return [];

  const files = readdirSync(plansDir)
    .filter((f) => f.endsWith(".md"))
    .sort()
    .reverse();

  const out: PlanEntry[] = [];
  for (const f of files) {
    const entry = parsePlanFilename(f, src.name);
    if (entry) out.push(entry);
  }
  return out;
}

export function planRoutes(config: ConsoleConfig) {
  const app = new Hono();

  app.get("/plans", (c) => {
    const active = activeSources(c, config);
    const plans: PlanEntry[] = [];
    for (const src of active) {
      plans.push(...loadPlansFromSource(src));
    }
    plans.sort((a, b) => b.date.localeCompare(a.date));

    const content = planListView({ plans, sources: active });

    return c.html(
      layout({
        title: "Daily Plans",
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: "/plans",
        demoMode: config.demoMode,
      })
    );
  });

  // Cross-day rollover view: tasks carrying across multiple plans.
  // `?days=N` overrides the default 7-day threshold (also accepts 14, 30 etc.).
  app.get("/plans/:source/rollover", (c) => {
    const active = activeSources(c, config);
    const sourceName = sanitizePathSegment(c.req.param("source"));
    if (!sourceName) return notFound(c, config, active, "Not found.");

    const src = findSource(config.sources, sourceName);
    if (!src) return notFound(c, config, active, `Source "${escapeHtml(sourceName)}" not found.`);

    const plansDir = getPlansPath(src);
    if (!plansDir) {
      return notFound(c, config, active, `Source "${escapeHtml(sourceName)}" does not provide daily plans.`);
    }

    const daysParam = c.req.query("days");
    const minDays = parseThreshold(daysParam, 7);
    const tasks = findCarryoverTasks(plansDir, { minDays, windowDays: 60, openOnly: true });

    const today = new Date();
    const asOfDate = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

    const content = planRolloverView({
      sourceName: src.name,
      sourceDisplayName: src.display_name,
      asOfDate,
      minDays,
      windowDays: 60,
      tasks,
      thresholdOptions: [7, 14, 30],
    });

    return c.html(
      layout({
        title: `Rollover — ${src.name}`,
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: `/plans/${src.name}/rollover`,
        demoMode: config.demoMode,
      })
    );
  });

  app.get("/plans/:source/:date", (c) => {
    const active = activeSources(c, config);
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const date = sanitizePathSegment(c.req.param("date"));

    if (!sourceName || !date) {
      return notFound(c, config, active, "Not found.");
    }

    const src = findSource(config.sources, sourceName);
    if (!src) return notFound(c, config, active, `Source "${escapeHtml(sourceName)}" not found.`);

    const plansDir = getPlansPath(src);
    if (!plansDir) {
      return notFound(c, config, active, `Source "${escapeHtml(sourceName)}" does not provide daily plans.`);
    }

    const filePath = join(plansDir, `${date}.md`);
    const directory = loadSlackDirectory(src);
    const slackEnabled = !src.demo && !!getSlackToken(src);
    const slackCfg = src.slack
      ? { workspace_url: src.slack.workspace_url, team_id: src.slack.team_id }
      : undefined;
    const cockpitBundle = readAndRenderPlanForCockpit(filePath, {
      editable: !src.demo,
      slackEnabled,
      directory,
      slack: slackCfg,
    });
    if (!cockpitBundle) {
      return notFound(c, config, active, `No plan for ${escapeHtml(date)} in ${escapeHtml(sourceName)}.`);
    }

    const allPlans = loadPlansFromSource(src);
    const sortedAsc = [...allPlans].sort((a, b) => a.date.localeCompare(b.date));
    const currentIdx = sortedAsc.findIndex((p) => p.date === date);
    const prevDate = currentIdx > 0 ? sortedAsc[currentIdx - 1].date : undefined;
    const nextDate = currentIdx < sortedAsc.length - 1 ? sortedAsc[currentIdx + 1].date : undefined;

    // If the parser detected NO recognized sections (only header + others),
    // fall back to the legacy plain-markdown view so unrecognized formats
    // still render.
    const hasRecognized = cockpitBundle.sections.some(
      (s) => s.kind !== "header" && s.kind !== "other"
    );

    // v0.9.0: load source's projects + ±60-day calendar window for sidebars.
    // `loadProjectsFromSources([src])` returns [] when the source has no
    // `projects_dir` or no `index.yaml` — sidebar handles that empty case.
    const projects = loadProjectsFromSources([src]);
    const calendarPlans = allPlans.filter((p) => withinDays(p.date, date, 60));

    const content = hasRecognized
      ? planCockpitView({
          date,
          sourceName: src.name,
          sourceDisplayName: src.display_name,
          sections: cockpitBundle.sections,
          draftsHtml: cockpitBundle.draftsHtml,
          fullMarkdownHtml: cockpitBundle.fullHtml,
          directoryIslandHtml: cockpitBundle.directoryIslandHtml,
          prevDate,
          nextDate,
          fileMtimeMs: cockpitBundle.mtimeMs,
          editable: !src.demo,
          projects,
          plansForCalendar: calendarPlans,
          drafts: cockpitBundle.drafts,
          slackConfigured: slackEnabled,
          tierASendEnabled: !!src.slack?.tier_a_send_enabled,
        })
      : planDetailView({
          date,
          contentHtml: cockpitBundle.fullHtml + (cockpitBundle.directoryIslandHtml || ""),
          sourceName: src.name,
          prevDate,
          nextDate,
        });

    return c.html(
      layout({
        title: `Plan — ${date}`,
        content,
        sources: config.sources,
        activeSourceNames: active.map((s) => s.name),
        currentPath: `/plans/${src.name}/${date}`,
        demoMode: config.demoMode,
        // The cockpit shell uses the wider container so the three columns
        // have room. The legacy planDetailView fallback stays at standard
        // width — its single-column markdown render doesn't need extra
        // horizontal space.
        wide: hasRecognized,
      })
    );
  });

  // Lightweight endpoint that returns just the file mtime in milliseconds.
  // The cockpit polls this every 30 seconds to detect external writes
  // (daily-rituals skill, manual edit in another editor, slack-sync writes,
  // etc.) and soft-reloads when the file has changed since page load.
  // Returns 404 if the source / file doesn't exist; 200 otherwise.
  app.get("/plans/:source/:date/mtime", (c) => {
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const date = sanitizePathSegment(c.req.param("date"));
    if (!sourceName || !date) return c.json({ ok: false, error: "Invalid path." }, 400);

    const src = findSource(config.sources, sourceName);
    if (!src) return c.json({ ok: false, error: "Source not found." }, 404);

    const plansDir = getPlansPath(src);
    if (!plansDir) return c.json({ ok: false, error: "No plans dir." }, 404);
    const filePath = join(plansDir, `${date}.md`);
    if (!existsSync(filePath)) {
      return c.json({ ok: false, error: "Plan file not found." }, 404);
    }

    let mtimeMs: number;
    try {
      mtimeMs = statSync(filePath).mtimeMs;
    } catch {
      return c.json({ ok: false, error: "Could not stat plan file." }, 500);
    }

    return c.json({ ok: true, mtimeMs });
  });

  // Save an edited draft body. Compare-and-swap on the original body text:
  // a 409 response means the file changed externally and the client should
  // reload to get a fresh baseline before retrying.
  app.put("/plans/:source/:date/draft/:index", async (c) => {
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const date = sanitizePathSegment(c.req.param("date"));
    const indexStr = sanitizePathSegment(c.req.param("index"));

    if (!sourceName || !date || !indexStr) {
      return c.json({ ok: false, error: "Invalid request path." }, 400);
    }

    const draftIndex = Number(indexStr);
    if (!Number.isInteger(draftIndex) || draftIndex < 0 || draftIndex > 999) {
      return c.json({ ok: false, error: "Invalid draft index." }, 400);
    }

    const src = findSource(config.sources, sourceName);
    if (!src) return c.json({ ok: false, error: "Source not found." }, 404);
    if (src.demo) {
      return c.json({ ok: false, error: "Demo data is read-only." }, 403);
    }

    const plansDir = getPlansPath(src);
    if (!plansDir) {
      return c.json({ ok: false, error: "Source has no plans directory." }, 404);
    }

    const filePath = join(plansDir, `${date}.md`);
    if (!existsSync(filePath)) {
      return c.json({ ok: false, error: "Plan file not found." }, 404);
    }

    let body: { originalText?: unknown; newText?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body." }, 400);
    }

    const originalText = typeof body.originalText === "string" ? body.originalText : "";
    const newText = typeof body.newText === "string" ? body.newText : "";
    if (!originalText && !body.originalText) {
      return c.json({ ok: false, error: "originalText is required." }, 400);
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return c.json({ ok: false, error: "Could not read plan file." }, 500);
    }

    const result = replaceDraftBody(raw, draftIndex, originalText, newText);
    if (!result.ok) {
      const status = result.reason === "conflict" ? 409 : result.reason === "empty" ? 400 : 404;
      const message =
        result.reason === "conflict"
          ? "The file changed since this draft was loaded. Reload the page and try again."
          : result.reason === "empty"
            ? "Draft body cannot be empty."
            : "Draft not found.";
      return c.json({ ok: false, error: message }, status);
    }

    // Atomic-ish replace: write to a sibling temp file, then rename over the original.
    // Same-filesystem rename is atomic on POSIX; same-volume on macOS for plain HFS+/APFS.
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tempPath, result.newRaw, "utf-8");
      renameSync(tempPath, filePath);
    } catch (err) {
      return c.json({ ok: false, error: "Could not write plan file." }, 500);
    }

    return c.json({ ok: true });
  });

  // Preflight a Slack send: returns the resolved-mention text and the list of
  // pending mentions so the confirmation modal can show "this will mention 3
  // people in #channel" before the user clicks Send.
  app.get("/plans/:source/:date/draft/:index/preflight", (c) => {
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const date = sanitizePathSegment(c.req.param("date"));
    const indexStr = sanitizePathSegment(c.req.param("index"));
    if (!sourceName || !date || !indexStr) return c.json({ ok: false, error: "Invalid path." }, 400);
    const idx = Number(indexStr);
    if (!Number.isInteger(idx) || idx < 0 || idx > 999) {
      return c.json({ ok: false, error: "Invalid draft index." }, 400);
    }
    const src = findSource(config.sources, sourceName);
    if (!src) return c.json({ ok: false, error: "Source not found." }, 404);
    if (src.demo) return c.json({ ok: false, error: "Demo data is read-only." }, 403);

    const plansDir = getPlansPath(src);
    if (!plansDir) return c.json({ ok: false, error: "No plans dir." }, 404);
    const filePath = join(plansDir, `${date}.md`);
    if (!existsSync(filePath)) return c.json({ ok: false, error: "Plan file not found." }, 404);

    const raw = readFileSync(filePath, "utf-8");
    const drafts = findDraftBlocks(raw);
    const draft = drafts[idx];
    if (!draft) return c.json({ ok: false, error: "Draft not found." }, 404);
    if (draft.alreadySent) return c.json({ ok: false, error: "Draft already sent." }, 409);

    const directory = loadSlackDirectory(src);
    const resolvedText = resolveMentions(draft.bodyText, directory);
    const mentions = listResolvedMentions(draft.bodyText, directory);

    return c.json({
      ok: true,
      bodyOriginal: draft.bodyText,
      bodyResolved: resolvedText,
      mentions,
      sendToText: draft.sendToText || null,
      tokenConfigured: !!getSlackToken(src),
    });
  });

  // Direct Slack send via Web API. Uses the user OAuth token from the env var
  // declared in source.slack.user_token_env. On success: records a `**Sent:**`
  // marker after the draft body so the page reload shows the sent state.
  app.post("/plans/:source/:date/draft/:index/send", async (c) => {
    const sourceName = sanitizePathSegment(c.req.param("source"));
    const date = sanitizePathSegment(c.req.param("date"));
    const indexStr = sanitizePathSegment(c.req.param("index"));
    if (!sourceName || !date || !indexStr) return c.json({ ok: false, error: "Invalid path." }, 400);
    const idx = Number(indexStr);
    if (!Number.isInteger(idx) || idx < 0 || idx > 999) {
      return c.json({ ok: false, error: "Invalid draft index." }, 400);
    }

    const src = findSource(config.sources, sourceName);
    if (!src) return c.json({ ok: false, error: "Source not found." }, 404);
    if (src.demo) return c.json({ ok: false, error: "Demo data is read-only." }, 403);

    const token = getSlackToken(src);
    if (!token) {
      return c.json(
        {
          ok: false,
          error:
            "Slack send is not configured for this source. Set the env var named in source.slack.user_token_env to a user OAuth token (xoxp-...) and reload.",
        },
        403
      );
    }

    const plansDir = getPlansPath(src);
    if (!plansDir) return c.json({ ok: false, error: "No plans dir." }, 404);
    const filePath = join(plansDir, `${date}.md`);
    if (!existsSync(filePath)) return c.json({ ok: false, error: "Plan file not found." }, 404);

    let body: { confirmed?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body." }, 400);
    }
    if (body.confirmed !== true) {
      return c.json({ ok: false, error: "Send must be explicitly confirmed." }, 400);
    }

    const raw = readFileSync(filePath, "utf-8");
    const drafts = findDraftBlocks(raw);
    const draft = drafts[idx];
    if (!draft) return c.json({ ok: false, error: "Draft not found." }, 404);
    if (draft.alreadySent) return c.json({ ok: false, error: "Draft already sent." }, 409);

    const directory = loadSlackDirectory(src);
    const text = resolveMentions(draft.bodyText, directory);
    if (text.trim().length === 0) {
      return c.json({ ok: false, error: "Cannot send empty body." }, 400);
    }

    // Determine target from sendToText.
    const target = parseSendToFromRaw(draft.sendToText || "", directory);
    if (!target) {
      return c.json(
        {
          ok: false,
          error:
            "Could not determine Slack target from this draft's Send-to line. Add a channel ID, DM channel ID, or user ID to make it sendable.",
        },
        400
      );
    }

    const sendResult = await postSlackMessage(token, target, text);
    if (!sendResult.ok) {
      return c.json({ ok: false, error: `Slack: ${sendResult.error}` }, 502);
    }

    // Append `**Sent:**` marker to the file. On marker write failure, the
    // message HAS gone out — surface the partial-success state.
    const sentAtIso = new Date().toISOString();
    const markResult = markDraftAsSent(raw, idx, {
      ts: sendResult.ts!,
      permalink: sendResult.permalink,
      sentAtIso,
    });

    if (!markResult.ok) {
      return c.json(
        {
          ok: true,
          warning:
            "Message sent successfully, but the daily plan file could not be annotated. Add a **Sent:** marker manually if desired.",
          ts: sendResult.ts,
          permalink: sendResult.permalink,
        }
      );
    }

    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      writeFileSync(tempPath, markResult.newRaw, "utf-8");
      renameSync(tempPath, filePath);
    } catch {
      return c.json(
        {
          ok: true,
          warning:
            "Message sent successfully, but the daily plan file could not be written. Add a **Sent:** marker manually if desired.",
          ts: sendResult.ts,
          permalink: sendResult.permalink,
        }
      );
    }

    return c.json({
      ok: true,
      ts: sendResult.ts,
      channel: sendResult.channel,
      permalink: sendResult.permalink,
    });
  });

  // ---- Cockpit write-back: decisions and tasks ----
  // Both routes follow the same discipline as the draft PUT/POST routes:
  //   - demo source → 403
  //   - bad index / source / file → 400 / 404
  //   - compare-and-swap mismatch → 409 with "reload and retry"
  //   - atomic-ish write via temp file + rename

  app.post("/plans/:source/:date/decision/:index", async (c) => {
    const { src, filePath, error } = resolveWriteTarget(c, config);
    if (error) return error;
    const idx = parseIndexParam(c.req.param("index"));
    if (idx === null) return c.json({ ok: false, error: "Invalid decision index." }, 400);

    let body: { option?: unknown; decidedAtIso?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body." }, 400);
    }
    const option = typeof body.option === "string" ? body.option.trim().toUpperCase() : "";
    const decidedAtIso =
      typeof body.decidedAtIso === "string" && body.decidedAtIso
        ? body.decidedAtIso
        : new Date().toISOString();
    if (!option) {
      return c.json({ ok: false, error: "option is required." }, 400);
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return c.json({ ok: false, error: "Could not read plan file." }, 500);
    }

    const result = recordDecision(raw, idx, option, decidedAtIso);
    if (!result.ok) {
      const status =
        result.reason === "already-decided"
          ? 409
          : result.reason === "not-found"
            ? 404
            : 400;
      const message = mutationFailureMessage(result.reason, result.message);
      return c.json({ ok: false, error: message }, status);
    }

    if (!writeAtomic(filePath, result.newRaw)) {
      return c.json({ ok: false, error: "Could not write plan file." }, 500);
    }

    return c.json({ ok: true, decidedAtIso });
  });

  app.post("/plans/:source/:date/task/:index/done", async (c) => {
    const { src, filePath, error } = resolveWriteTarget(c, config);
    if (error) return error;
    const idx = parseIndexParam(c.req.param("index"));
    if (idx === null) return c.json({ ok: false, error: "Invalid task index." }, 400);

    let body: { originalText?: unknown; doneAtLocal?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body." }, 400);
    }
    const originalText = typeof body.originalText === "string" ? body.originalText : "";
    const doneAtLocal =
      typeof body.doneAtLocal === "string" && body.doneAtLocal
        ? body.doneAtLocal
        : formatLocalTime(new Date());
    if (!originalText) {
      return c.json({ ok: false, error: "originalText is required." }, 400);
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return c.json({ ok: false, error: "Could not read plan file." }, 500);
    }

    const result = markTaskDone(raw, idx, originalText, doneAtLocal);
    if (!result.ok) {
      const status =
        result.reason === "conflict"
          ? 409
          : result.reason === "already-done"
            ? 409
            : result.reason === "not-found"
              ? 404
              : 400;
      const message = mutationFailureMessage(result.reason, result.message);
      return c.json({ ok: false, error: message }, status);
    }

    if (!writeAtomic(filePath, result.newRaw)) {
      return c.json({ ok: false, error: "Could not write plan file." }, 500);
    }

    return c.json({ ok: true, doneAtLocal });
  });

  app.post("/plans/:source/:date/task/:index/undone", async (c) => {
    const { src, filePath, error } = resolveWriteTarget(c, config);
    if (error) return error;
    const idx = parseIndexParam(c.req.param("index"));
    if (idx === null) return c.json({ ok: false, error: "Invalid task index." }, 400);

    let body: { originalText?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body." }, 400);
    }
    const originalText = typeof body.originalText === "string" ? body.originalText : "";
    if (!originalText) {
      return c.json({ ok: false, error: "originalText is required." }, 400);
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return c.json({ ok: false, error: "Could not read plan file." }, 500);
    }

    const result = unmarkTaskDone(raw, idx, originalText);
    if (!result.ok) {
      const status =
        result.reason === "conflict"
          ? 409
          : result.reason === "not-done"
            ? 409
            : result.reason === "not-found"
              ? 404
              : 400;
      const message = mutationFailureMessage(result.reason, result.message);
      return c.json({ ok: false, error: message }, status);
    }

    if (!writeAtomic(filePath, result.newRaw)) {
      return c.json({ ok: false, error: "Could not write plan file." }, 500);
    }

    return c.json({ ok: true });
  });

  // ---- Wave 1 (v0.10) — NEEDS YOU one-tap: skip a draft ----
  // Records a `**Skipped:** HH:MM TZ` marker after the body. No Slack call.
  // Fails when the draft is already sent (Sent + Skipped are exclusive) or
  // already skipped (idempotent). Follows the same demo=403 / bad-request /
  // atomic-write shape as the send + decision + task endpoints.
  app.post("/plans/:source/:date/draft/:index/skip", async (c) => {
    const { src, filePath, error } = resolveWriteTarget(c, config);
    if (error) return error;
    void src;
    const idx = parseIndexParam(c.req.param("index"));
    if (idx === null) return c.json({ ok: false, error: "Invalid draft index." }, 400);

    let body: { skippedAt?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ ok: false, error: "Invalid JSON body." }, 400);
    }
    const skippedAt =
      typeof body.skippedAt === "string" && body.skippedAt.trim().length > 0
        ? body.skippedAt.trim()
        : localTimeLabel();
    if (skippedAt.length > 60) {
      return c.json({ ok: false, error: "skippedAt label too long." }, 400);
    }

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return c.json({ ok: false, error: "Could not read plan file." }, 500);
    }

    const result = markDraftAsSkipped(raw, idx, skippedAt);
    if (!result.ok) {
      const status =
        result.reason === "already-sent"
          ? 409
          : result.reason === "already-skipped"
            ? 409
            : result.reason === "not-found"
              ? 404
              : 400;
      const message =
        result.reason === "already-sent"
          ? "This draft has already been sent — unsend before skipping."
          : result.reason === "already-skipped"
            ? "This draft was already skipped."
            : result.reason === "not-found"
              ? "Draft not found."
              : "Invalid skip input.";
      return c.json({ ok: false, error: message }, status);
    }

    if (!writeAtomic(filePath, result.newRaw)) {
      return c.json({ ok: false, error: "Could not write plan file." }, 500);
    }

    return c.json({ ok: true, skippedAt });
  });

  // Undo skip — removes the `**Skipped:**` marker. Symmetric to unmarkTaskDone.
  app.post("/plans/:source/:date/draft/:index/unskip", async (c) => {
    const { src, filePath, error } = resolveWriteTarget(c, config);
    if (error) return error;
    void src;
    const idx = parseIndexParam(c.req.param("index"));
    if (idx === null) return c.json({ ok: false, error: "Invalid draft index." }, 400);

    let raw: string;
    try {
      raw = readFileSync(filePath, "utf-8");
    } catch {
      return c.json({ ok: false, error: "Could not read plan file." }, 500);
    }

    const result = unmarkDraftAsSkipped(raw, idx);
    if (!result.ok) {
      const status = result.reason === "not-skipped" ? 409 : 404;
      const message = result.reason === "not-skipped" ? "This draft was not marked skipped." : "Draft not found.";
      return c.json({ ok: false, error: message }, status);
    }

    if (!writeAtomic(filePath, result.newRaw)) {
      return c.json({ ok: false, error: "Could not write plan file." }, 500);
    }

    return c.json({ ok: true });
  });

  return app;
}

/**
 * Short local-time label used as the default `**Skipped:**` marker suffix.
 * Format: "HH:MM TZ" e.g. "17:32 EDT". Matches the shape of `**DONE HH:MM TZ**`
 * task markers so the two conventions read the same in the file.
 */
function localTimeLabel(): string {
  const d = new Date();
  const time = d.toLocaleTimeString("en-US", { hour12: false, hour: "2-digit", minute: "2-digit" });
  const tz = d.toLocaleTimeString("en-US", { timeZoneName: "short" }).split(" ").pop() || "";
  return tz ? `${time} ${tz}` : time;
}

/* -------------------------------------------------------------------------- */
/* Cockpit-route helpers                                                      */
/* -------------------------------------------------------------------------- */

function resolveWriteTarget(
  c: import("hono").Context,
  config: ConsoleConfig
): { src?: Source; filePath: string; error?: ReturnType<import("hono").Context["json"]> } {
  const sourceName = sanitizePathSegment(c.req.param("source"));
  const date = sanitizePathSegment(c.req.param("date"));
  if (!sourceName || !date) {
    return { filePath: "", error: c.json({ ok: false, error: "Invalid request path." }, 400) };
  }
  const src = findSource(config.sources, sourceName);
  if (!src) {
    return { filePath: "", error: c.json({ ok: false, error: "Source not found." }, 404) };
  }
  if (src.demo) {
    return {
      src,
      filePath: "",
      error: c.json({ ok: false, error: "Demo data is read-only." }, 403),
    };
  }
  const plansDir = getPlansPath(src);
  if (!plansDir) {
    return {
      src,
      filePath: "",
      error: c.json({ ok: false, error: "Source has no plans directory." }, 404),
    };
  }
  const filePath = join(plansDir, `${date}.md`);
  if (!existsSync(filePath)) {
    return {
      src,
      filePath,
      error: c.json({ ok: false, error: "Plan file not found." }, 404),
    };
  }
  return { src, filePath };
}

function parseIndexParam(raw: string | undefined): number | null {
  const seg = sanitizePathSegment(raw || "");
  if (!seg) return null;
  const n = Number(seg);
  if (!Number.isInteger(n) || n < 0 || n > 9999) return null;
  return n;
}

/**
 * Parse the `?days=N` threshold for the rollover view. Clamps to [1, 365] and
 * snaps to a small whitelist of sensible defaults to avoid arbitrary URLs
 * generating expensive queries; unknown values fall back to the default.
 */
function parseThreshold(raw: string | undefined, fallback: number): number {
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 365) return fallback;
  return Math.floor(n);
}

function writeAtomic(filePath: string, content: string): boolean {
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tempPath, content, "utf-8");
    renameSync(tempPath, filePath);
    return true;
  } catch {
    return false;
  }
}

function mutationFailureMessage(reason: string, message?: string): string {
  if (message) return message;
  switch (reason) {
    case "conflict":
      return "The file changed since this page was loaded. Reload the page and try again.";
    case "already-decided":
      return "This decision has already been recorded.";
    case "already-done":
      return "This task is already marked done.";
    case "not-done":
      return "This task isn't currently marked done.";
    case "not-found":
      return "Item not found.";
    case "invalid-option":
      return "Invalid option.";
    default:
      return "Unable to apply the change.";
  }
}

function formatLocalTime(d: Date): string {
  // "11:14 EDT" — use short timezone if available, fall back to offset.
  const opts: Intl.DateTimeFormatOptions = {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  };
  // 24-hour with leading zeroes; remove "GMT-04:00" forms in favor of "EDT" if present.
  const formatted = new Intl.DateTimeFormat("en-US", opts).format(d);
  // Returns "13:14 EDT" or "13:14 GMT-4". Normalize "GMT-4" → keep as is.
  return formatted.replace(/^24:/, "00:");
}

import type { SlackDirectory } from "../parsers/slack-directory.js";
import type { SlackSendTarget } from "../integrations/slack-send.js";

/**
 * Parse a Send-to line directly from raw markdown (post-stripping the
 * `**Send to:**` prefix) into a Slack send target. Mirrors the rendering-side
 * parseSendTo but skips HTML decoding since the input is already plain text.
 */
function parseSendToFromRaw(raw: string, dir: SlackDirectory): SlackSendTarget | null {
  if (!raw) return null;
  const text = raw.replace(/`/g, "").replace(/\s+/g, " ").trim();
  if (!text) return null;

  const threadMatch = text.match(/TS\s*[=:]\s*([\d.]+)/i);
  const dmMatch = text.match(/\b(D[A-Z0-9]{6,})\b/);
  const userMatch = text.match(/\b(U[A-Z0-9]{6,})\b/);
  const channelNameMatch = text.match(/#([a-zA-Z][\w-]+)/);
  const channelIdMatch = text.match(/\b(C[A-Z0-9]{6,})\b/);

  // Resolve channel name → ID via directory if a name is present.
  let channelId: string | undefined =
    channelIdMatch?.[1] ||
    (channelNameMatch ? dir.channelByName.get(channelNameMatch[1].toLowerCase())?.id : undefined);

  if (dmMatch) {
    return {
      channel: dmMatch[1],
      thread_ts: threadMatch?.[1],
    };
  }
  if (channelId) {
    return {
      channel: channelId,
      thread_ts: threadMatch?.[1],
    };
  }
  if (userMatch) {
    // Slack opens DM with this user when a U... is supplied as channel.
    return {
      channel: userMatch[1],
      thread_ts: threadMatch?.[1],
    };
  }
  return null;
}

function notFound(
  c: import("hono").Context,
  config: ConsoleConfig,
  active: Source[],
  message: string
) {
  return c.html(
    layout({
      title: "Not Found",
      content: `<h1>Not found</h1><p>${message}</p><p><a href="/plans">Back to plans</a></p>`,
      sources: config.sources,
      activeSourceNames: active.map((s) => s.name),
      currentPath: "/plans",
      demoMode: config.demoMode,
    }),
    404
  );
}
