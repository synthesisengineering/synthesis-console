import { expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const repoRoot = resolve(import.meta.dir, "..");

function executable(path: string, body: string): void {
  writeFileSync(path, body, { mode: 0o755 });
}

function installFixture(platform: "Darwin" | "Linux", overrides: Record<string, string> = {}): string {
  const home = mkdtempSync(
    join(realpathSync(tmpdir()), 'synthesis-console-& "%\\$-autostart-'),
  );
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
    ...overrides,
  };
  const result = spawnSync("bash", [script], { cwd: repoRoot, env, encoding: "utf-8" });
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);

  const installed =
    platform === "Darwin"
      ? join(home, "Library", "LaunchAgents", "org.synthesisengineering.console.plist")
      : join(home, ".config", "systemd", "user", "synthesis-console.service");
  const content = readFileSync(installed, "utf-8");
  expect(content).toContain("PYTHONDONTWRITEBYTECODE");
  if (platform === "Linux") {
    const bunPath = join(fakeBin, "bun")
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("$", () => "$$");
    expect(content).toContain(`ExecStart=/usr/bin/env "${bunPath}" run scripts/console-cli.ts start`);
    const verify = spawnSync("systemd-analyze", ["verify", installed], {
      env: { ...process.env, SYSTEMD_LOG_LEVEL: "warning" },
      encoding: "utf-8",
    });
    if (process.platform === "linux") expect(verify.error).toBeUndefined();
    if (!verify.error) {
      expect(verify.status, `${verify.stdout}\n${verify.stderr}`).toBe(0);
    }
  }
  rmSync(home, { recursive: true, force: true });
  return content;
}

const escapeFor = (platform: "Darwin" | "Linux", value: string) =>
  platform === "Darwin"
    ? value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    : value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");

test("autostart installers persist the synthesis overrides only when set", () => {
  const overrides = {
    SYNTHESIS_HOME: '/opt/synthesis & "v5" 100%',
    SYNTHESIS_PYTHON_BIN: "/opt/python <3.12>/bin/python3",
  };
  for (const platform of ["Darwin", "Linux"] as const) {
    const set = installFixture(platform, overrides);
    for (const [name, value] of Object.entries(overrides)) {
      expect(set).toContain(name);
      expect(set).toContain(escapeFor(platform, value));
    }
    const unset = installFixture(platform);
    for (const name of ["SYNTHESIS_HOME", "SYNTHESIS_PYTHON_BIN", "SYNTHESIS_BOOTSTRAP_PYTHON", "XDG_DATA_HOME"]) {
      expect(unset).not.toContain(name);
    }
  }
});

function linuxRepositoryFixture(name: string, check: (fixture: {
  root: string;
  unit: string;
  receipt: string;
  calls: string;
  install: () => ReturnType<typeof spawnSync>;
}) => void): void {
  const temporary = mkdtempSync(join(realpathSync(tmpdir()), "console-linux-path-"));
  try {
    const root = join(temporary, name);
    const home = join(temporary, "home");
    const fakeBin = join(temporary, "bin");
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "node_modules"));
    mkdirSync(home);
    mkdirSync(fakeBin);
    copyFileSync(
      join(repoRoot, "scripts", "install-autostart-linux.sh"),
      join(root, "scripts", "install-autostart-linux.sh"),
    );
    executable(join(fakeBin, "uname"), "#!/bin/sh\nprintf 'Linux\\n'\n");
    for (const command of ["bun", "systemctl"]) {
      executable(join(fakeBin, command), "#!/bin/sh\nprintf 'called\\n' >> \"$HOME/calls\"\n");
    }
    check({
      root,
      unit: join(home, ".config/systemd/user/synthesis-console.service"),
      receipt: join(home, ".local/state/synthesis-console/autostart.json"),
      calls: join(home, "calls"),
      install: () => spawnSync("bash", [join(root, "scripts/install-autostart-linux.sh")], {
        cwd: root,
        env: { HOME: home, PATH: `${fakeBin}:/usr/bin:/bin` },
        encoding: "utf-8",
      }),
    });
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

test("Linux WorkingDirectory preserves literal repository path characters", () => {
  for (const name of ['checkout & "\' %n %% $HOME \\segment\tend', "checkout-\\\\"]) {
    linuxRepositoryFixture(name, ({ root, unit, install }) => {
      const result = install();
      expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
      const content = readFileSync(unit, "utf-8");
      expect(content.split("\n").find(line => line.startsWith("WorkingDirectory=")))
        .toBe(`WorkingDirectory=${root.replaceAll("%", "%%")}`);
      const verify = spawnSync("systemd-analyze", ["verify", unit], {
        env: { ...process.env, SYSTEMD_LOG_LEVEL: "warning" },
        encoding: "utf-8",
      });
      if (process.platform === "linux") expect(verify.error).toBeUndefined();
      if (!verify.error) expect(verify.status, `${verify.stdout}\n${verify.stderr}`).toBe(0);
    });
  }
});

for (const [label, name] of [
  ["embedded newline", "checkout\nchild"],
  ["terminal newline", "checkout\n"],
  ["embedded carriage return", "checkout\rchild"],
  ["terminal carriage return", "checkout\r"],
  ["terminal space", "checkout "],
  ["terminal tab", "checkout\t"],
  ["terminal vertical tab", "checkout\v"],
  ["terminal form feed", "checkout\f"],
  ["terminal continuation backslash", "checkout\\"],
]) {
  test(`Linux refuses a repository path with ${label} before changing service state`, () => {
    linuxRepositoryFixture(name!, ({ unit, receipt, calls, install }) => {
      mkdirSync(resolve(unit, ".."), { recursive: true });
      mkdirSync(resolve(receipt, ".."), { recursive: true });
      writeFileSync(unit, "retained unit\n");
      writeFileSync(receipt, "retained ownership receipt\n");
      const result = install();
      expect(result.status).not.toBe(0);
      expect(String(result.stderr)).toContain("cannot be represented exactly in systemd WorkingDirectory");
      expect(readFileSync(unit, "utf-8")).toBe("retained unit\n");
      expect(readFileSync(receipt, "utf-8")).toBe("retained ownership receipt\n");
      expect(existsSync(calls)).toBe(false);
    });
  });
}
