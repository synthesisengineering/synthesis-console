import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { escapeRegExp, listSessions, parseLines, searchConversations, showSession, validName } from "./conversations.js";
import { conversationsView, conversationView } from "./views/conversations.js";

const roots: string[] = [];
afterAll(() => roots.forEach((root) => rmSync(root, { recursive: true, force: true })));

/** A fake `synthesis` command: records its arguments, prints `stdout`, exits 0. */
function fakeLauncher(stdout: string): { launcher: string; argsFile: string } {
  const root = mkdtempSync(join(tmpdir(), "console-sessions-"));
  roots.push(root);
  const launcher = join(root, "synthesis");
  const payload = join(root, "stdout.txt");
  const argsFile = join(root, "args.txt");
  writeFileSync(payload, stdout);
  writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$@" > '${argsFile}'\ncat '${payload}'\n`);
  chmodSync(launcher, 0o755);
  return { launcher, argsFile };
}

const read = (file: string) => readFileSync(file, "utf8").trim().split("\n");

describe("conversations", () => {
  test("names, patterns and JSON lines are read strictly", () => {
    expect(validName("01a1b2c3-x_y.z")).toBe("01a1b2c3-x_y.z");
    expect(validName("-rf")).toBe("");
    expect(validName("../etc")).toBe("");
    expect(escapeRegExp("a.b (c)")).toBe("a\\.b \\(c\\)");
    expect(parseLines<{ seq: number }>('{"seq": 1}\n\n{"seq": 2}\n').map((r) => r.seq)).toEqual([1, 2]);
    expect(() => parseLines("not json")).toThrow("not JSON");
  });

  test("a listing asks for JSON within bounds and passes only valid filters", async () => {
    const { launcher, argsFile } = fakeLauncher('{"harness":"codex","session":"s1","records":3}\n');
    const out = await listSessions({ workspace: "acme", project: "../x", limit: 9999 }, launcher);
    expect(out.items).toEqual([{ harness: "codex", session: "s1", records: 3 }]);
    expect(read(argsFile)).toEqual(["sessions", "list", "--workspace", "acme", "--limit", "500", "--json"]);
  });

  test("search words are matched literally and can never be read as an option", async () => {
    const { launcher, argsFile } = fakeLauncher("");
    await searchConversations("--whole a.b", {}, launcher);
    expect(read(argsFile)).toEqual(["sessions", "search", "--kinds", "user,brief,assistant,compaction", "--limit", "50",
      "--json", "--", "--whole a\\.b"]);
  });

  test("a session id that is not one is refused without running anything", async () => {
    const out = await showSession("../../etc/passwd", false, "/nonexistent/synthesis");
    expect(out.error).toBe("That is not a session id.");
    const missing = await showSession("s1", false, "/nonexistent/synthesis");
    expect(missing.installed).toBe(false);
  });

  test("the views escape what the records hold and label the principal's words", () => {
    const records = { installed: true, error: null, items: [
      { seq: 4, kind: "user", text: "<script>alert(1)</script>", at: "2026-10-30T10:00:00Z" },
      { seq: 5, kind: "brief", text: "Survey the tests." },
      { seq: 6, kind: "tool_call", tool: "Bash", input: { command: "ls" } },
    ] };
    const page = conversationView("s1-abcdefgh", true, records);
    expect(page).not.toContain("<script>alert(1)</script>");
    expect(page).toContain("&lt;script&gt;");
    expect(page).toContain(">You<");
    expect(page).toContain(">Agent brief<");
    expect(page).toContain('id="r6"');
    expect(page).toContain("Bash {&quot;command&quot;:&quot;ls&quot;}");
    const list = conversationsView({ query: "", workspace: "", project: "", matches: null,
      sessions: { installed: true, error: null, items: [{ harness: "codex", session: "abc12345xyz", projects: ["p1"], synced: "acme" }] } });
    expect(list).toContain('href="/conversations/abc12345xyz"');
    expect(list).toContain("synced from another machine");
  });
});
