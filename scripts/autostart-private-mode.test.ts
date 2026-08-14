import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "..");

function executable(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
}

function installFixture(platform: "Darwin" | "Linux", privateMode: boolean): string {
  const home = mkdtempSync(join(tmpdir(), "synthesis-console-autostart-"));
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  executable(join(fakeBin, "bun"), "#!/bin/sh\nexit 0\n");
  executable(join(fakeBin, "uname"), `#!/bin/sh\nprintf '%s\\n' '${platform}'\n`);
  executable(
    join(fakeBin, "launchctl"),
    "#!/bin/sh\n" +
      "state=\"$HOME/.synthesis-console-loaded\"\n" +
      "case \"$1\" in\n" +
      "  print) [ -f \"$state\" ] && { echo ' state = running'; exit 0; }; exit 1 ;;\n" +
      "  bootstrap) : > \"$state\"; exit 0 ;;\n" +
      "  *) exit 0 ;;\n" +
      "esac\n",
  );
  executable(join(fakeBin, "systemctl"), "#!/bin/sh\nexit 0\n");

  const script = join(
    repoRoot,
    "scripts",
    platform === "Darwin" ? "install-autostart-macos.sh" : "install-autostart-linux.sh",
  );
  const env: Record<string, string> = {
    HOME: home,
    PATH: `${fakeBin}:/usr/bin:/bin`,
  };
  if (privateMode) env.SYNTHESIS_PRIVATE_CONTROL_PLANE = "1";
  const result = spawnSync("bash", [script], { cwd: repoRoot, env, encoding: "utf-8" });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

  const installed =
    platform === "Darwin"
      ? join(home, "Library", "LaunchAgents", "org.synthesisengineering.console.plist")
      : join(home, ".config", "systemd", "user", "synthesis-console.service");
  const content = readFileSync(installed, "utf-8");
  rmSync(home, { recursive: true, force: true });
  return content;
}

test("autostart installers persist private conformance mode only when opted in", () => {
  for (const platform of ["Darwin", "Linux"] as const) {
    expect(installFixture(platform, true)).toContain("SYNTHESIS_PRIVATE_CONTROL_PLANE");
    expect(installFixture(platform, false)).not.toContain(
      "SYNTHESIS_PRIVATE_CONTROL_PLANE",
    );
  }
});
