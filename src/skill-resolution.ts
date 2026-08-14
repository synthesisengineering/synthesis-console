import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SYNTHESIS_HOME =
  process.env.SYNTHESIS_HOME || join(homedir(), ".synthesis");

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function compareVersions(a: string, b: string): number {
  const left = a.split(/[.\-+]/);
  const right = b.split(/[.\-+]/);
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const aNumber = Number.parseInt(left[index] ?? "", 10);
    const bNumber = Number.parseInt(right[index] ?? "", 10);
    const aMissing = Number.isNaN(aNumber);
    const bMissing = Number.isNaN(bNumber);
    if (aMissing && bMissing) continue;
    if (aMissing) return -1;
    if (bMissing) return 1;
    if (aNumber !== bNumber) return aNumber - bNumber;
  }
  return 0;
}

interface PluginSkillCandidate {
  version: string;
  dir: string;
}

function pluginSkillCandidates(
  cacheRoot: string,
  skillName: string
): PluginSkillCandidate[] {
  const found: { version: string; dir: string }[] = [];
  for (const marketplace of safeReaddir(cacheRoot)) {
    const marketplaceDir = join(cacheRoot, marketplace);
    for (const plugin of safeReaddir(marketplaceDir)) {
      const pluginDir = join(marketplaceDir, plugin);
      for (const version of safeReaddir(pluginDir)) {
        const dir = join(pluginDir, version, "skills", skillName);
        if (existsSync(dir)) found.push({ version, dir });
      }
    }
  }
  return found;
}

/** Return plugin skill directories newest-first across every client cache. */
export function pluginSkillDirs(
  cacheRoots: string[],
  skillName: string
): string[] {
  return cacheRoots
    .flatMap((cacheRoot) => pluginSkillCandidates(cacheRoot, skillName))
    .sort((a, b) => compareVersions(b.version, a.version))
    .map((entry) => entry.dir);
}

/** Resolve a source-owned skill script across native plugin and user-skill routes. */
export function resolveSkillScript(
  skillName: string,
  scriptName: string,
  override?: string
): string | null {
  const home = homedir();
  const candidates: string[] = [];
  if (override) candidates.push(override);
  candidates.push(join(SYNTHESIS_HOME, "skills", skillName));
  candidates.push(
    ...pluginSkillDirs(
      [join(home, ".claude"), join(home, ".codex")].map((client) =>
        join(client, "plugins", "cache")
      ),
      skillName
    )
  );
  candidates.push(join(home, ".claude", "skills", skillName));
  candidates.push(join(home, ".agents", "skills", skillName));
  for (const directory of candidates) {
    const script = join(directory, "scripts", scriptName);
    if (existsSync(script)) return script;
  }
  return null;
}
