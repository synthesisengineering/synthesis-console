import { expect, test } from "bun:test";
import {
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

function installFixture(platform: "Darwin" | "Linux", privateMode: boolean): string {
  const home = mkdtempSync(
    join(realpathSync(tmpdir()), 'synthesis-console-& "%\\$-autostart-'),
  );
  const fakeBin = join(home, "bin");
  mkdirSync(fakeBin);
  executable(join(fakeBin, "bun"), "#!/bin/sh\nexit 0\n");
  executable(join(fakeBin, "python3"), "#!/bin/sh\nprintf '%s\\n' \"$0\"\n");
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
  expect(content).toContain("SYNTHESIS_PYTHON_BIN");
  const pythonPath = join(fakeBin, "python3");
  expect(content).toContain(
    platform === "Darwin"
      ? pythonPath.replaceAll("&", "&amp;")
      : pythonPath
          .replaceAll("\\", "\\\\")
          .replaceAll('"', '\\"')
          .replaceAll("%", "%%"),
  );
  if (platform === "Linux") {
    const bunPath = join(fakeBin, "bun")
      .replaceAll("\\", "\\\\")
      .replaceAll('"', '\\"')
      .replaceAll("%", "%%")
      .replaceAll("$", () => "$$");
    expect(content).toContain(`ExecStart="${bunPath}" run src/index.ts`);
    const verify = spawnSync("systemd-analyze", ["verify", installed], {
      env: { ...process.env, SYSTEMD_LOG_LEVEL: "warning" },
      encoding: "utf-8",
    });
    if (!verify.error) {
      expect(verify.status, `${verify.stdout}\n${verify.stderr}`).toBe(0);
    }
  }
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

test("Python selection fails closed for an incompatible explicit interpreter", () => {
  const root = mkdtempSync(join(tmpdir(), "synthesis-console-python-"));
  const incompatible = join(root, "python3");
  executable(incompatible, "#!/bin/sh\nexit 1\n");
  const helper = join(repoRoot, "scripts", "python-runtime.sh");
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; find_synthesis_python', "synthesis-console-test", helper],
    {
      env: {
        HOME: root,
        PATH: "/usr/bin:/bin",
        SYNTHESIS_PYTHON_BIN: incompatible,
      },
      encoding: "utf-8",
    },
  );
  rmSync(root, { recursive: true, force: true });
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("does not name an executable Python 3 with PyYAML");
});

test("Python selection persists an absolute path", () => {
  const root = mkdtempSync(join(tmpdir(), "synthesis-console-python-"));
  const relativeDirectory = join(root, "venv", "bin");
  mkdirSync(relativeDirectory, { recursive: true });
  const interpreter = join(relativeDirectory, "python3");
  executable(interpreter, "#!/bin/sh\nprintf '%s\\n' \"$0\"\n");
  const helper = join(repoRoot, "scripts", "python-runtime.sh");
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; find_synthesis_python', "synthesis-console-test", helper],
    {
      cwd: root,
      env: {
        HOME: root,
        PATH: "/usr/bin:/bin",
        SYNTHESIS_PYTHON_BIN: "venv/bin/python3",
      },
      encoding: "utf-8",
    },
  );
  const expected = realpathSync(interpreter);
  rmSync(root, { recursive: true, force: true });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(expected);
});

test("Python selection probe executes successfully in a real Python runtime", () => {
  const root = mkdtempSync(join(tmpdir(), "synthesis-console-real-python-"));
  writeFileSync(join(root, "yaml.py"), "# Hermetic import stub for the runtime probe.\n");
  const hermeticPath = "/usr/bin:/bin";
  const located = spawnSync(
    "python3",
    ["-c", "import os, sys; print(os.path.abspath(sys.executable))"],
    {
      env: process.env,
      encoding: "utf-8",
    },
  );
  expect(located.status, located.stderr).toBe(0);
  const candidate = located.stdout.trim();
  const helper = join(repoRoot, "scripts", "python-runtime.sh");
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; find_synthesis_python', "synthesis-console-test", helper],
    {
      env: {
        HOME: root,
        PATH: hermeticPath,
        PYTHONPATH: root,
        SYNTHESIS_PYTHON_BIN: candidate,
      },
      encoding: "utf-8",
    },
  );
  const expected = spawnSync(
    candidate,
    ["-c", "import os, sys; print(os.path.abspath(sys.executable))"],
    { encoding: "utf-8" },
  ).stdout.trim();
  rmSync(root, { recursive: true, force: true });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(expected);
});

test("Python selection resolves a pyenv shim to its service-safe interpreter", () => {
  const root = mkdtempSync(join(tmpdir(), "synthesis-console-pyenv-"));
  const pyenvBin = join(root, ".pyenv", "bin");
  const shimDirectory = join(root, ".pyenv", "shims");
  const versionDirectory = join(root, ".pyenv", "versions", "3.12", "bin");
  mkdirSync(pyenvBin, { recursive: true });
  mkdirSync(shimDirectory, { recursive: true });
  mkdirSync(versionDirectory, { recursive: true });
  executable(join(pyenvBin, "pyenv"), "#!/bin/sh\nexit 0\n");
  const interpreter = join(versionDirectory, "python3");
  executable(interpreter, "#!/bin/sh\nprintf '%s\\n' \"$0\"\n");
  const shim = join(shimDirectory, "python3");
  executable(
    shim,
    "#!/bin/sh\n" +
      "command -v pyenv >/dev/null 2>&1 || exit 99\n" +
      `exec '${interpreter}' \"$@\"\n`,
  );
  const helper = join(repoRoot, "scripts", "python-runtime.sh");
  const result = spawnSync(
    "bash",
    ["-c", 'source "$1"; find_synthesis_python', "synthesis-console-test", helper],
    {
      env: {
        HOME: root,
        PATH: `${shimDirectory}:${pyenvBin}:/usr/bin:/bin`,
        SYNTHESIS_PYTHON_BIN: shim,
      },
      encoding: "utf-8",
    },
  );
  const expected = realpathSync(interpreter);
  rmSync(root, { recursive: true, force: true });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(expected);
});
