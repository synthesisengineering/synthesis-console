/**
 * Slack directory parsing — display-name to ID lookup for users and channels.
 *
 * The mapping files are simple YAML maintained by the user (or by an authoring
 * agent on the user's behalf). They live inside the source's repo so they
 * version-control alongside the rest of the project's content.
 *
 * users_file format:
 *   users:
 *     - name: Saner Keles
 *       aliases: [Saner, saner.keles]
 *       id: U0AG66Z95KM
 *     - name: Marcelo Freitas
 *       aliases: [Marcelo]
 *       id: U0AGABCDE
 *
 * channels_file format:
 *   channels:
 *     - name: mmc-product-growth-squad
 *       id: C0123456789
 *     - name: news-csa-feedback
 *       id: C012345ABCD
 */
import { readFileSync, existsSync } from "fs";
import * as yaml from "js-yaml";
import type { Source } from "../config.js";
import { getSlackUsersPath, getSlackChannelsPath } from "../config.js";

export interface SlackUser {
  /** Canonical display name (the form shown in Slack — typically First Last). */
  name: string;
  /** Slack user ID, e.g. "U0AG66Z95KM". */
  id: string;
  /** Optional alternate forms — short names, lowercase, handles, etc. */
  aliases?: string[];
}

export interface SlackChannel {
  /** Channel name (without the leading #). */
  name: string;
  /** Slack channel ID, e.g. "C012345ABCD". */
  id: string;
}

export interface SlackDirectory {
  users: SlackUser[];
  channels: SlackChannel[];
  /** Lookup helpers for fast name → id and id → name resolution. */
  userByLookupKey: Map<string, SlackUser>;
  channelByName: Map<string, SlackChannel>;
  userById: Map<string, SlackUser>;
  channelById: Map<string, SlackChannel>;
}

const EMPTY: SlackDirectory = {
  users: [],
  channels: [],
  userByLookupKey: new Map(),
  channelByName: new Map(),
  userById: new Map(),
  channelById: new Map(),
};

export function emptyDirectory(): SlackDirectory {
  return {
    users: [],
    channels: [],
    userByLookupKey: new Map(),
    channelByName: new Map(),
    userById: new Map(),
    channelById: new Map(),
  };
}

export function loadSlackDirectory(src: Source): SlackDirectory {
  const usersPath = getSlackUsersPath(src);
  const channelsPath = getSlackChannelsPath(src);
  if (!usersPath && !channelsPath) return EMPTY;

  const users: SlackUser[] = [];
  const channels: SlackChannel[] = [];

  if (usersPath && existsSync(usersPath)) {
    try {
      const raw = readFileSync(usersPath, "utf-8");
      const parsed = yaml.load(raw) as { users?: unknown };
      if (parsed && Array.isArray(parsed.users)) {
        for (const entry of parsed.users) {
          const u = entry as Record<string, unknown>;
          if (typeof u.name !== "string" || typeof u.id !== "string") continue;
          if (!/^U[A-Z0-9]{6,}$/i.test(u.id)) continue;
          const aliases = Array.isArray(u.aliases)
            ? u.aliases.filter((a): a is string => typeof a === "string")
            : undefined;
          users.push({ name: u.name, id: u.id, aliases });
        }
      }
    } catch {
      // Malformed users file: log to stderr, treat as empty for this request.
      console.error(`[slack-directory] could not parse ${usersPath}`);
    }
  }

  if (channelsPath && existsSync(channelsPath)) {
    try {
      const raw = readFileSync(channelsPath, "utf-8");
      const parsed = yaml.load(raw) as { channels?: unknown };
      if (parsed && Array.isArray(parsed.channels)) {
        for (const entry of parsed.channels) {
          const c = entry as Record<string, unknown>;
          if (typeof c.name !== "string" || typeof c.id !== "string") continue;
          if (!/^[CG][A-Z0-9]{6,}$/i.test(c.id)) continue;
          channels.push({ name: c.name, id: c.id });
        }
      }
    } catch {
      console.error(`[slack-directory] could not parse ${channelsPath}`);
    }
  }

  return buildDirectory(users, channels);
}

export function buildDirectory(users: SlackUser[], channels: SlackChannel[]): SlackDirectory {
  const userByLookupKey = new Map<string, SlackUser>();
  const userById = new Map<string, SlackUser>();
  for (const u of users) {
    userById.set(u.id, u);
    addLookup(userByLookupKey, u.name, u);
    if (u.aliases) {
      for (const alias of u.aliases) addLookup(userByLookupKey, alias, u);
    }
  }
  const channelByName = new Map<string, SlackChannel>();
  const channelById = new Map<string, SlackChannel>();
  for (const c of channels) {
    channelById.set(c.id, c);
    channelByName.set(c.name.toLowerCase(), c);
  }
  return { users, channels, userByLookupKey, channelByName, userById, channelById };
}

function addLookup(map: Map<string, SlackUser>, key: string, user: SlackUser): void {
  const k = normalizeName(key);
  if (k && !map.has(k)) map.set(k, user);
}

/** Normalize a name for lookup: lowercase, strip surrounding whitespace, collapse spaces. */
export function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}
