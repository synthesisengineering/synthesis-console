#!/usr/bin/env bun
/**
 * sync-slack-directory — populate slack-users.yaml and slack-channels.yaml
 * from a Slack workspace using the user OAuth token configured for a source.
 *
 * Usage:
 *   bun run scripts/sync-slack-directory.ts <source-name>
 *   bun run scripts/sync-slack-directory.ts personal
 *   bun run scripts/sync-slack-directory.ts personal --users-only
 *   bun run scripts/sync-slack-directory.ts personal --channels-only
 *   bun run scripts/sync-slack-directory.ts personal --dry-run
 *
 * Prerequisites:
 *   - The source's slack.user_token_env env var is set to a user OAuth token
 *     (xoxp-...) with these scopes:
 *       users:read     — list workspace members
 *       channels:read  — list public channels
 *       groups:read    — list private channels (optional, only if you want them)
 *
 * Behavior:
 *   - Fetches all workspace members + all public/private channels via the
 *     standard Slack Web API (users.list, conversations.list).
 *   - Filters out deactivated users and bot accounts (only real humans).
 *   - Writes the slack-users.yaml + slack-channels.yaml files declared in
 *     source.slack.users_file / channels_file.
 *   - Existing aliases are preserved if the file already exists. Other
 *     hand-edited fields are NOT preserved — the source of truth for IDs is
 *     the Slack API, not the YAML file.
 *
 * Cost: a freshly-cached run is ~3-5 API calls per page of users + channels.
 *       Slack rate-limits at ~20 requests/min for these tier-2 endpoints,
 *       which is plenty for typical workspace sizes.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import * as yaml from "js-yaml";
import { loadConfig } from "../src/config.js";
import {
  getSlackToken,
  getSlackUsersPath,
  getSlackChannelsPath,
  findSource,
} from "../src/config.js";

interface SlackApiUser {
  id: string;
  team_id?: string;
  name?: string;
  real_name?: string;
  deleted?: boolean;
  is_bot?: boolean;
  is_app_user?: boolean;
  profile?: {
    real_name?: string;
    display_name?: string;
    display_name_normalized?: string;
    real_name_normalized?: string;
  };
}

interface SlackApiChannel {
  id: string;
  name: string;
  is_archived?: boolean;
  is_member?: boolean;
  is_private?: boolean;
  is_im?: boolean;
  is_mpim?: boolean;
}

const SLACK_API = "https://slack.com/api";

async function slackPaged<T>(
  token: string,
  method: string,
  arrayKey: "members" | "channels",
  query: Record<string, string> = {}
): Promise<T[]> {
  const out: T[] = [];
  let cursor: string | undefined = undefined;
  // Page size: 100 is conservative for tier-2 endpoints. Larger pages
  // increase the chance of 429 on freshly installed tokens whose rate-limit
  // bucket hasn't warmed up.
  const PAGE_LIMIT = "100";
  while (true) {
    const params = new URLSearchParams({ limit: PAGE_LIMIT, ...query });
    if (cursor) params.set("cursor", cursor);

    let attempt = 0;
    let json:
      | {
          ok: boolean;
          error?: string;
          members?: T[];
          channels?: T[];
          response_metadata?: { next_cursor?: string };
        }
      | undefined;

    while (true) {
      const res = await fetch(`${SLACK_API}/${method}?${params.toString()}`, {
        headers: { Authorization: `Bearer ${token}` },
      });

      if (res.status === 429) {
        // Slack rate limit. Read Retry-After (seconds) and wait.
        const retryAfter = Number(res.headers.get("retry-after") || "5");
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : 5;
        attempt++;
        if (attempt > 6) {
          throw new Error(
            `Slack ${method}: rate-limited 6 times in a row; giving up. ` +
              `Wait a few minutes and rerun.`
          );
        }
        console.log(`  Slack rate limit (429); waiting ${wait}s (attempt ${attempt}/6)...`);
        await sleep(wait * 1000);
        continue; // retry same request
      }

      if (!res.ok) {
        throw new Error(`Slack ${method}: HTTP ${res.status}`);
      }

      json = (await res.json()) as typeof json;
      if (!json) throw new Error(`Slack ${method}: empty response`);

      // Slack also returns ok=false with error="ratelimited" sometimes.
      if (!json.ok && json.error === "ratelimited") {
        attempt++;
        if (attempt > 6) {
          throw new Error(`Slack ${method}: ratelimited (body) 6 times; giving up.`);
        }
        console.log(`  Slack rate limit (body); waiting 5s (attempt ${attempt}/6)...`);
        await sleep(5000);
        continue;
      }

      if (!json.ok) {
        throw new Error(`Slack ${method}: ${json.error}`);
      }
      break;
    }

    const page = (arrayKey === "members" ? json!.members : json!.channels) || [];
    out.push(...(page as T[]));
    cursor = json!.response_metadata?.next_cursor;
    if (!cursor) break;

    // Polite gap between pages on tier-2 endpoints.
    await sleep(1100);
  }
  return out;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function pickDisplayName(u: SlackApiUser): string {
  return (
    u.profile?.real_name?.trim() ||
    u.profile?.display_name?.trim() ||
    u.real_name?.trim() ||
    u.name?.trim() ||
    u.id
  );
}

function existingAliasesByUserId(usersFile: string | null): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!usersFile || !existsSync(usersFile)) return out;
  try {
    const parsed = yaml.load(readFileSync(usersFile, "utf-8")) as { users?: unknown };
    if (parsed && Array.isArray(parsed.users)) {
      for (const e of parsed.users) {
        const u = e as Record<string, unknown>;
        if (typeof u.id !== "string") continue;
        if (Array.isArray(u.aliases)) {
          out.set(
            u.id,
            u.aliases.filter((a): a is string => typeof a === "string")
          );
        }
      }
    }
  } catch {
    // ignore: we'll just write a fresh file
  }
  return out;
}

function writeYamlFile(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(path, content, "utf-8");
}

function formatUsersYaml(users: SlackApiUser[], aliasMap: Map<string, string[]>): string {
  const lines: string[] = [];
  lines.push("# slack-users.yaml — auto-generated by scripts/sync-slack-directory.ts");
  lines.push("# Aliases ARE preserved across sync runs; everything else is overwritten.");
  lines.push("# Edit aliases by hand to add short forms or alternate spellings.");
  lines.push("");
  lines.push("users:");
  const sorted = [...users].sort((a, b) =>
    pickDisplayName(a).localeCompare(pickDisplayName(b))
  );
  for (const u of sorted) {
    const display = pickDisplayName(u);
    lines.push(`  - name: ${yamlScalar(display)}`);
    lines.push(`    id: ${u.id}`);
    const aliases = aliasMap.get(u.id);
    if (aliases && aliases.length > 0) {
      lines.push(`    aliases: [${aliases.map(yamlScalar).join(", ")}]`);
    }
  }
  return lines.join("\n") + "\n";
}

function formatChannelsYaml(channels: SlackApiChannel[]): string {
  const lines: string[] = [];
  lines.push("# slack-channels.yaml — auto-generated by scripts/sync-slack-directory.ts");
  lines.push("# Edit by hand only if you intend to override the auto-discovered set.");
  lines.push("");
  lines.push("channels:");
  const sorted = [...channels].sort((a, b) => a.name.localeCompare(b.name));
  for (const c of sorted) {
    lines.push(`  - name: ${yamlScalar(c.name)}`);
    lines.push(`    id: ${c.id}`);
  }
  return lines.join("\n") + "\n";
}

function yamlScalar(s: string): string {
  // Quote if it contains characters that would break YAML scalar parsing.
  if (/^[\w.@/-]+$/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const sourceName = args[0];
  const flags = new Set(args.slice(1));
  const usersOnly = flags.has("--users-only");
  const channelsOnly = flags.has("--channels-only");
  const dryRun = flags.has("--dry-run");

  if (!sourceName) {
    console.error("Usage: bun run scripts/sync-slack-directory.ts <source-name> [--users-only|--channels-only|--dry-run]");
    process.exit(1);
  }

  const config = loadConfig();
  const src = findSource(config.sources, sourceName);
  if (!src) {
    console.error(`Source "${sourceName}" not found in config.`);
    process.exit(1);
  }
  if (!src.slack) {
    console.error(`Source "${sourceName}" has no slack: block configured.`);
    process.exit(1);
  }

  const token = getSlackToken(src);
  if (!token) {
    console.error(
      `No Slack token. Set the env var named in source.slack.user_token_env (${src.slack.user_token_env || "<unset>"}).`
    );
    process.exit(1);
  }

  const usersPath = getSlackUsersPath(src);
  const channelsPath = getSlackChannelsPath(src);

  if (!channelsOnly) {
    if (!usersPath) {
      console.error(`Source has no slack.users_file declared.`);
      process.exit(1);
    }
    console.log(`Fetching users for "${sourceName}"...`);
    const apiUsers = await slackPaged<SlackApiUser>(token, "users.list", "members");
    const realUsers = apiUsers.filter(
      (u) =>
        !u.deleted &&
        !u.is_bot &&
        !u.is_app_user &&
        u.id !== "USLACKBOT" &&
        !!u.profile
    );
    console.log(`  ${apiUsers.length} total, ${realUsers.length} after filtering bots / deleted.`);
    const aliasMap = existingAliasesByUserId(usersPath);
    const yamlContent = formatUsersYaml(realUsers, aliasMap);
    if (dryRun) {
      console.log(`  Would write ${realUsers.length} users to ${usersPath} (dry-run)`);
    } else {
      writeYamlFile(usersPath, yamlContent);
      console.log(`  Wrote ${realUsers.length} users to ${usersPath}`);
    }
  }

  if (!usersOnly) {
    if (!channelsPath) {
      console.error(`Source has no slack.channels_file declared.`);
      process.exit(1);
    }
    console.log(`Fetching channels for "${sourceName}"...`);
    const apiChannels = await slackPaged<SlackApiChannel>(
      token,
      "conversations.list",
      "channels",
      {
        types: "public_channel,private_channel",
        exclude_archived: "true",
      }
    );
    const channels = apiChannels.filter(
      (c) => !c.is_archived && !c.is_im && !c.is_mpim
    );
    console.log(`  ${apiChannels.length} total, ${channels.length} after filtering archived / DMs.`);
    const yamlContent = formatChannelsYaml(channels);
    if (dryRun) {
      console.log(`  Would write ${channels.length} channels to ${channelsPath} (dry-run)`);
    } else {
      writeYamlFile(channelsPath, yamlContent);
      console.log(`  Wrote ${channels.length} channels to ${channelsPath}`);
    }
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
