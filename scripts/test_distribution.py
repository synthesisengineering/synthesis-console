"""Physical npm/Bun/direct consumers of the built Console package."""
import sys
import unittest
import tempfile

import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import hashlib

import pytest

ROOT = Path(__file__).resolve().parents[1]


def module(path):
    spec = importlib.util.spec_from_file_location(
        "builder_" + str(abs(hash(str(path)))), path
    )
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


@pytest.fixture(scope="module")
def distribution(tmp_path_factory):
    temporary = tmp_path_factory.mktemp("console-packages")
    builder = module(ROOT / "scripts/build_distribution.py")
    first = temporary / "first"
    second = temporary / "second"
    console_source = temporary / "console-source"
    console_source.mkdir()
    # Explicit nongit candidate bytes; no commit/tag is asserted for this fixture.
    paths = subprocess.check_output(
        [
            "git",
            "-C",
            str(ROOT),
            "ls-files",
            "--cached",
            "--others",
            "--exclude-standard",
        ],
        text=True,
    ).splitlines()
    for relative in sorted(set(paths)):
        source = ROOT / relative
        if not source.exists():
            continue
        assert not source.is_symlink()
        target = console_source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source, target)
    # A nongit source fixture avoids inventing a commit in the developer checkout.
    record = builder.build_fixture(first, source=console_source)
    record2 = builder.build_fixture(second, source=console_source)
    assert record["archive"]["sha256"] == record2["archive"]["sha256"]
    return first, record


def environment(home):
    home.mkdir()
    env = dict(
        os.environ,
        HOME=str(home),
        SYNTHESIS_HOME=str(home),
        XDG_CONFIG_HOME=str(home / ".config"),
        XDG_STATE_HOME=str(home / ".local/state"),
        XDG_DATA_HOME=str(home / ".local/share"),
        XDG_CACHE_HOME=str(home / ".cache"),
    )
    env.update(
        npm_config_cache=str(home / "npm-cache"),
        npm_config_userconfig=str(home / ".npmrc"),
        BUN_INSTALL=str(home / "bun"),
        BUN_INSTALL_CACHE_DIR=str(home / "bun-cache"),
    )
    return env


def test_consumer_environment_owns_each_xdg_root(tmp_path, monkeypatch):
    foreign = tmp_path / "foreign"
    foreign.mkdir()
    sentinel = foreign / "retained"
    sentinel.write_text("outside the fixture home")
    roots = {
        "XDG_CONFIG_HOME": ".config",
        "XDG_STATE_HOME": ".local/state",
        "XDG_DATA_HOME": ".local/share",
        "XDG_CACHE_HOME": ".cache",
    }
    for variable in roots:
        monkeypatch.setenv(variable, str(foreign))
    home = tmp_path / "home"
    env = environment(home)
    for variable, relative in roots.items():
        assert env[variable] == str(home / relative), (
            variable + " leaked into the consumer"
        )
    assert sentinel.read_text() == "outside the fixture home"


def test_package_is_inert_with_bundled_dependencies(distribution):
    root, record = distribution
    metadata = json.loads((root / "npm/package.json").read_text())
    assert metadata["name"] == "@synthesiswork/console"
    assert not metadata.get("scripts") and not metadata.get("dependencies")
    assert (root / "npm/app/index.js").is_file()
    # The package carries no synthesis runtime of its own: v5 is installed by
    # the synthesis-skills plugin in each harness.
    for absent in ("synthesis-core", "core-files.json", "packages/python", "app/autopilot-supervisor.js"):
        assert not (root / "npm" / absent).exists(), absent
    assert "core_release" not in record and "python_dependency" not in record
    assert record["archive"]["sha256"] in (root / "synthesis-console.rb").read_text()
    assert record["archive"]["sha256"] in (root / "install.sh").read_text()


def test_homebrew_uses_the_official_bun_formula_and_runtime(distribution):
    root, record = distribution
    formula = (root / "synthesis-console.rb").read_text()
    # Inspect actual generated artifact bytes, not a hand-written sample.
    # Qualified dependency identity avoids short-name lookup in a fresh brew.
    assert 'depends_on "oven-sh/bun/bun"' in formula
    assert 'depends_on "bun"' not in formula and 'Formula["bun"]' not in formula
    # The installed launcher must resolve the same dependency even when a
    # different bun precedes Homebrew on the user's incoming PATH.
    assert 'PATH: "#{Formula["oven-sh/bun/bun"].opt_bin}:$PATH"' in formula
    assert (
        'SYNTHESIS_BOOTSTRAP_PYTHON: Formula["python@3.12"].opt_bin/"python3.12"'
        in formula
    )
    assert record["archive"]["sha256"] in formula
    ruby = shutil.which("ruby")
    if ruby:
        parsed = subprocess.run(
            [ruby, "-c", str(root / "synthesis-console.rb")],
            capture_output=True,
            text=True,
        )
        assert parsed.returncode == 0, parsed.stdout + parsed.stderr


@pytest.mark.parametrize("manager", ["npm", "bun", "archive"])
def test_actual_consumers_help_status_and_retired_commands(
    distribution, tmp_path, manager
):
    root, record = distribution
    home = tmp_path / "home"
    env = environment(home)
    if manager == "archive":
        destination = tmp_path / "extracted"
        destination.mkdir()
        with tarfile.open(root / record["archive"]["file"]) as tar:
            tar.extractall(destination, filter="data")
        package = destination / ("synthesis-console-" + record["version"])
        binary = package / "bin/synthesis-console"
    else:
        subprocess.run(
            ["npm", "pack", "--ignore-scripts", "--pack-destination", str(tmp_path)],
            cwd=root / "npm",
            env=env,
            capture_output=True,
            check=True,
        )
        archive = next(tmp_path.glob("*.tgz"))
        prefix = home / "bun" if manager == "bun" else home / "npm"
        command = (
            ["bun", "add", "-g", "--ignore-scripts", str(archive)]
            if manager == "bun"
            else [
                "npm",
                "install",
                "-g",
                "--prefix",
                str(prefix),
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
                str(archive),
            ]
        )
        subprocess.run(command, env=env, capture_output=True, check=True)
        binary = prefix / "bin/synthesis-console"
        package = binary.resolve().parent.parent
    for args in [["--version"], ["--help"], ["autostart", "status"]]:
        r = subprocess.run(
            [str(binary), *args], cwd=home, env=env, capture_output=True, text=True
        )
        assert r.returncode == 0, r.stdout + r.stderr
    for args in [["setup"], ["synthesis", "status"], ["supervision", "status"]]:
        r = subprocess.run(
            [str(binary), *args], cwd=home, env=env, capture_output=True, text=True
        )
        assert r.returncode == 2 and "Unknown command" in r.stderr, r.stderr
    for path in [
        ".synthesis",
        ".claude",
        ".agents",
        ".local/state/synthesis",
        ".local/share/synthesis-console",
        "Library/LaunchAgents",
        ".config/systemd",
    ]:
        assert not (home / path).exists()
    assert (package / "scripts/console-cli.ts").is_file()


def test_curl_installer_preserves_edited_files_and_permission_drift(
    distribution, tmp_path
):
    root, record = distribution
    home = tmp_path / "home"
    env = environment(home)
    fake = tmp_path / "fake"
    fake.mkdir()
    # Actual archive install; only the network transport is replaced by a local exact artifact.
    curl = fake / "curl"
    curl.write_text(
        '#!/bin/sh\nprintf "%s\n" "$@" > "$CONSOLE_TEST_CURL_ARGS"\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$CONSOLE_TEST_ARCHIVE" "$2"\n'
    )
    curl.chmod(0o755)
    env.update(
        PATH=str(fake) + os.pathsep + env["PATH"],
        CONSOLE_TEST_ARCHIVE=str(root / record["archive"]["file"]),
        CONSOLE_TEST_CURL_ARGS=str(tmp_path / "curl-args"),
    )
    prefix = tmp_path / "prefix"
    command = [
        "sh",
        str(root / "install.sh"),
        "--prefix",
        str(prefix),
    ]
    first = subprocess.run(command, env=env, capture_output=True, text=True)
    assert first.returncode == 0, first.stdout + first.stderr
    assert record["archive"]["url"] in (tmp_path / "curl-args").read_text().splitlines()
    assert subprocess.run(command, env=env, capture_output=True).returncode == 0
    target = prefix / "synthesis-console"
    original = target.read_bytes()
    target.write_text("foreign edited executable")
    refused = subprocess.run(command, env=env, capture_output=True)
    assert refused.returncode != 0
    assert target.read_text() == "foreign edited executable"
    target.write_bytes(original)
    entry = (
        prefix / (".synthesis-console-" + record["version"]) / "bin/synthesis-console"
    )
    entry.chmod(0o644)
    refused = subprocess.run(command, env=env, capture_output=True)
    assert refused.returncode != 0


@pytest.mark.parametrize("failure", ["mode", "transport", "payload"])
def test_curl_preserves_modes_and_pending_recovery_evidence(
    distribution, tmp_path, failure
):
    root, record = distribution
    home = tmp_path / "home"
    env = environment(home)
    fake = tmp_path / "fake"
    fake.mkdir()
    curl = fake / "curl"
    curl.write_text(
        '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$CONSOLE_TEST_ARCHIVE" "$2"\n'
    )
    curl.chmod(0o755)
    env.update(
        PATH=str(fake) + os.pathsep + env["PATH"],
        CONSOLE_TEST_ARCHIVE=str(root / record["archive"]["file"]),
    )
    prefix = tmp_path / "prefix"
    command = [
        "sh",
        str(root / "install.sh"),
        "--prefix",
        str(prefix),
    ]
    first = subprocess.run(command, env=env, capture_output=True, text=True)
    assert first.returncode == 0, first.stderr
    target = prefix / "synthesis-console"
    receipt = prefix / ".synthesis-console-install.json"
    pending = prefix / ".synthesis-console-install.pending.json"
    before = receipt.read_bytes()
    if failure == "mode":
        target.chmod(0o644)
    else:
        pending.write_bytes(before)
        receipt.unlink()
        if failure == "transport":
            curl.write_text("#!/bin/sh\nexit 17\n")
        else:
            payload = (
                prefix
                / (".synthesis-console-" + record["version"])
                / "scripts/console-cli.ts"
            )
            payload.write_text(payload.read_text() + "\n// preserved edit\n")
    failed = subprocess.run(command, env=env, capture_output=True, text=True)
    assert failed.returncode != 0
    if failure == "mode":
        assert target.stat().st_mode & 0o777 == 0o644 and receipt.read_bytes() == before
    else:
        assert (
            pending.exists() and pending.read_bytes() == before and not receipt.exists()
        )


@pytest.mark.parametrize("mode", ["demo", "start"])
def test_bundled_demo_serves_from_unrelated_directory(distribution, tmp_path, mode):
    import selectors
    import time
    import signal

    root, record = distribution
    home = tmp_path / "home"
    env = environment(home)
    env["PORT"] = "19810"
    if mode == "start":
        # A genuinely configured ordinary server is the positive control;
        # an empty home deliberately falls back to strict demonstration mode.
        sample = home / "sample-source"
        sample.mkdir()
        settings = home / ".synthesis/console.yaml"
        settings.parent.mkdir()
        settings.write_text(
            json.dumps(
                {
                    "sources": [
                        {
                            "name": "sample",
                            "root": str(sample),
                            "projects_dir": "projects",
                        }
                    ]
                }
            )
        )
    # A real v5 run record (SYNTHESIS_HOME is the fixture home) must stay
    # invisible to the demo and visible to an ordinary configured server.
    plan = home / "elsewhere/resources/artifacts/2026-10-06-fixture-autopilot-plan.md"
    plan.parent.mkdir(parents=True)
    plan.write_text("# Autopilot plan: Fixture machine run\n\nStatus: running\n\n## Checklist\n- [ ] 1. Next\n")
    pointer = home / "state/autopilot/fixture-session.json"
    pointer.parent.mkdir(parents=True)
    pointer.write_text(json.dumps({"plan": str(plan), "streak": 0, "digest": "", "at": 1}))
    process = subprocess.Popen(
        [str(root / "npm/bin/synthesis-console"), mode],
        cwd=home,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        output = ""
        deadline = time.monotonic() + 10
        import re
        import urllib.request

        while time.monotonic() < deadline:
            if selector.select(timeout=0.2):
                output += os.read(process.stdout.fileno(), 65536).decode()
            match = re.search(r"http://localhost:(\d+)", output)
            if match:
                break
        assert match, output
        for relative in [
            "/projects",
            "/style.css",
            "/favicon.svg",
            "/vendor/pico-2.1.1.min.css",
        ]:
            with urllib.request.urlopen(
                "http://127.0.0.1:" + match[1] + relative, timeout=5
            ) as response:
                assert response.status == 200 and len(response.read()) > 20
        # The demonstration is a closed sample-data surface. It must not expose
        # machine health or run records, or reach global refresh/audio routes.
        base = "http://127.0.0.1:" + match[1]
        with urllib.request.urlopen(base + "/autopilot", timeout=5) as response:
            assert (
                response.headers["Cache-Control"]
                == "no-store, no-cache, must-revalidate, max-age=0"
            )
            html = response.read().decode()
        assert ("Fixture machine run" in html) == (mode == "start")
        for chip in ("sync-chip", "context-chip", "conformance-chip"):
            assert (f'id="{chip}"' in html) == (mode == "start")
        for relative in (
            "/sync",
            "/context",
            "/conformance",
            "/api/sync-status",
            "/api/context-status",
            "/api/conformance-status",
            "/api/quiet-audio",
        ):
            try:
                with urllib.request.urlopen(base + relative, timeout=5) as response:
                    code = response.status
            except urllib.error.HTTPError as error:
                code = error.code
            assert code == (404 if mode == "demo" else 200), (mode, relative, code)
        if mode == "demo":
            before = {
                str(p.relative_to(home)): p.read_bytes()
                for p in home.rglob("*")
                if p.is_file()
            }
            for relative in (
                "/api/sync/refresh",
                "/api/context/refresh",
                "/api/conformance/refresh",
                "/api/quiet-audio",
            ):
                request = urllib.request.Request(
                    base + relative,
                    data=b"{}",
                    headers={"Content-Type": "application/json"},
                    method="POST",
                )
                try:
                    with urllib.request.urlopen(request, timeout=5) as response:
                        code = response.status
                except urllib.error.HTTPError as error:
                    code = error.code
                assert code == 404, relative
            assert before == {
                str(p.relative_to(home)): p.read_bytes()
                for p in home.rglob("*")
                if p.is_file()
            }
        check = (
            subprocess.run(
                ["lsof", "-nP", "-iTCP:" + match[1], "-sTCP:LISTEN"],
                capture_output=True,
                text=True,
            )
            if shutil.which("lsof")
            else None
        )
        if check:
            assert "127.0.0.1:" in check.stdout and "*:" not in check.stdout
    finally:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)


def test_packaged_autostart_requires_owned_unit_before_manager_calls(
    distribution, tmp_path
):
    import sys

    root, record = distribution
    home = tmp_path / "home"
    env = environment(home)
    fake = tmp_path / "fake"
    fake.mkdir()
    log = home / "manager.log"

    def executable(name, body):
        path = fake / name
        path.write_text("#!/bin/sh\n" + body)
        path.chmod(0o755)

    if sys.platform == "darwin":
        target = home / "Library/LaunchAgents/org.synthesisengineering.console.plist"
        executable(
            "launchctl",
            'echo "$*" >> "$HOME/manager.log"\ncase "$1" in\nmanageruid) id -u;;\nmanagername) echo Aqua;;\nlist) printf "PID\\tStatus\\tLabel\\n"; test ! -f "$HOME/loaded" || printf "4321\\t0\\torg.synthesisengineering.console\\n";;\nprint) test -f "$HOME/loaded" && { echo " state = running"; exit 0; }; exit 1;;\nbootstrap) touch "$HOME/loaded";;\nbootout) rm -f "$HOME/loaded";;\nesac\nexit 0\n',
        )
    else:
        target = home / ".config/systemd/user/synthesis-console.service"
        executable(
            "systemctl",
            'echo "$*" >> "$HOME/manager.log"\ncase "$*" in\n*show*) echo LoadState=loaded; if test -f "$HOME/loaded"; then printf "ActiveState=active\\nUnitFileState=enabled\\nMainPID=4321\\nControlPID=0\\n"; else printf "ActiveState=inactive\\nUnitFileState=disabled\\nMainPID=0\\nControlPID=0\\n"; fi;;\n*enable*) touch "$HOME/loaded";;\n*disable*) rm -f "$HOME/loaded";;\nesac\nexit 0\n',
        )
    env.update(PATH=str(fake) + os.pathsep + env["PATH"])
    env.pop("SYNTHESIS_PYTHON_BIN", None)
    binary = root / "npm/bin/synthesis-console"

    def command(action):
        return subprocess.run(
            [str(binary), "autostart", action],
            cwd=home,
            env=env,
            capture_output=True,
            text=True,
        )

    target.parent.mkdir(parents=True)
    target.write_text("foreign unit")
    refused = command("install")
    assert refused.returncode != 0, refused.stdout + refused.stderr
    assert target.read_text() == "foreign unit" and not log.exists()
    target.unlink()
    installed = command("install")
    assert installed.returncode == 0, installed.stdout + installed.stderr
    owned = target.read_bytes()
    manager_actions = log.read_bytes()
    # SYNTHESIS_HOME was set by the fixture environment, so the service keeps it.
    assert b"SYNTHESIS_HOME" in owned and b"SYNTHESIS_PYTHON_BIN" not in owned
    target.write_text("edited unit")
    assert command("uninstall").returncode != 0
    assert target.read_text() == "edited unit" and log.read_bytes() == manager_actions
    target.write_bytes(owned)
    removed = command("uninstall")
    assert removed.returncode == 0, removed.stdout + removed.stderr
    assert not target.exists()


class CurlCancellationTests(unittest.TestCase):
    """Run actual installer bytes with a disposable transport worker."""

    def fixture(self, root, mode="wait"):
        import io
        import shlex
        import tarfile

        home = root / "home"
        home.mkdir()
        fake = root / "fake"
        fake.mkdir()
        prefix = root / "prefix"
        archive = root / "payload.tar.gz"
        installer = root / "install.sh"
        worker = root / "worker.py"
        python_code = (
            "import os,signal,time\nfrom pathlib import Path\n"
            'mode=os.environ.get("CURL_CHILD_MODE","wait")\n'
            'if mode=="exit":raise SystemExit(23)\n'
            'if mode=="signal":signal.signal(signal.SIGTERM,signal.SIG_DFL);os.kill(os.getpid(),signal.SIGTERM)\n'
            'def stop(sig,frame):\n Path(os.environ["CURL_STOPPED"]).write_text(str(sig))\n raise SystemExit(0)\n'
            "for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):signal.signal(sig,stop)\n"
            'Path(os.environ["CURL_READY"]).write_text(str(os.getpid()))\ntime.sleep(30)\n'
        )
        worker.write_text(python_code)
        with tarfile.open(archive, "w:gz") as output:
            for name, data in [
                ("scripts/console-cli.ts", b"// fixture only\n"),
                ("app/index.js", b"// fixture only\n"),
            ]:
                member = tarfile.TarInfo("synthesis-console-9.8.7/" + name)
                member.size = len(data)
                member.mode = 0o755
                output.addfile(member, io.BytesIO(data))
        source = (ROOT / "packages/install.sh").read_text()
        installer.write_text(
            source.replace("@VERSION@", "9.8.7").replace(
                "@ARCHIVE_SHA256@", hashlib.sha256(archive.read_bytes()).hexdigest()
            )
        )
        curl = fake / "curl"
        curl.write_text(
            "#!/bin/sh\nexec "
            + shlex.quote(sys.executable)
            + " "
            + shlex.quote(str(worker))
            + "\n"
        )
        curl.chmod(0o755)
        env = dict(
            os.environ,
            HOME=str(home),
            PATH=str(fake) + os.pathsep + os.environ["PATH"],
            CURL_READY=str(root / "ready"),
            CURL_STOPPED=str(root / "stopped"),
            CURL_ARCHIVE=str(archive),
            CURL_CHILD_MODE=mode,
        )
        return (["sh", str(installer), "--prefix", str(prefix)], env, prefix)

    def test_installer_forwards_and_reaps_each_incoming_signal(self):
        import signal
        import time

        for phase in ("transport",):
            for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                with (
                    self.subTest(phase=phase, signal=sig),
                    tempfile.TemporaryDirectory(
                        prefix="synthesis-console-cancel-"
                    ) as tmp,
                ):
                    root = Path(tmp).resolve()
                    command, env, prefix = self.fixture(root)
                    child = None
                    parent = subprocess.Popen(
                        command,
                        env=env,
                        start_new_session=True,
                        stdout=subprocess.DEVNULL,
                        stderr=subprocess.PIPE,
                    )
                    try:
                        deadline = time.monotonic() + 5
                        while (
                            not (root / "ready").exists()
                            and time.monotonic() < deadline
                        ):
                            if parent.poll() is not None:
                                self.fail(
                                    "worker did not start: "
                                    + parent.stderr.read().decode()
                                )
                            time.sleep(0.01)
                        self.assertTrue(
                            (root / "ready").exists(), "worker readiness timeout"
                        )
                        child = int((root / "ready").read_text())
                        parent.send_signal(sig)
                        self.assertEqual(parent.wait(timeout=5), -sig)
                        self.assertEqual((root / "stopped").read_text(), str(sig))
                        with self.assertRaises(ProcessLookupError):
                            os.kill(child, 0)
                        self.assertFalse(
                            list(prefix.glob(".synthesis-console-download-*"))
                        )
                        self.assertFalse(
                            (prefix / ".synthesis-console-install.json").exists()
                        )
                    finally:
                        if child:
                            try:
                                os.kill(child, signal.SIGTERM)
                            except ProcessLookupError:
                                pass
                        try:
                            os.killpg(parent.pid, signal.SIGTERM)
                        except ProcessLookupError:
                            pass
                        parent.wait(timeout=5)
                        parent.stderr.close()

    def test_installer_preserves_child_exit_and_signal(self):
        import signal

        for phase in ("transport",):
            for mode, expected in [("exit", 23), ("signal", -signal.SIGTERM)]:
                with (
                    self.subTest(phase=phase, mode=mode),
                    tempfile.TemporaryDirectory(
                        prefix="synthesis-console-status-"
                    ) as tmp,
                ):
                    command, env, prefix = self.fixture(Path(tmp).resolve(), mode)
                    result = subprocess.run(
                        command, env=env, capture_output=True, timeout=5
                    )
                    self.assertEqual(
                        result.returncode, expected, result.stderr.decode()
                    )
                    self.assertFalse(list(prefix.glob(".synthesis-console-download-*")))


def test_built_app_runs_v5_doctors_from_the_runtime(distribution, tmp_path):
    """The built app's real HTTP-to-program dispatch, against a labelled fake v5 runtime.

    SYNTHESIS_HOME is the fixture home: `bin/synthesis` stands in for the v5
    command and `current/skills/...` for the context doctor. A foreign
    PYTHONPATH proves skill scripts run isolated from inherited imports.
    """
    import re
    import selectors
    import signal
    import time
    import urllib.request

    root, record = distribution
    home = tmp_path / "home"
    env = environment(home)
    env.pop("SYNTHESIS_PYTHON_BIN", None)
    launcher = home / "bin/synthesis"
    launcher.parent.mkdir(parents=True)
    launcher.write_text(
        "#!/bin/sh\n"
        '[ "$1 $2" = "doctor --json" ] || exit 9\n'
        'printf \'%s\\n\' "$PWD" > "$HOME/doctor-cwd"\n'
        'echo \'{"healthy": false, "ms": 7, "checks": [{"status": "fail", "name": "fixture check", "detail": "labelled fixture only"}]}\'\n'
        "exit 1\n"
    )
    launcher.chmod(0o755)
    (home / "current/synthesis").mkdir(parents=True)
    (home / "current/synthesis/hook.py").write_text("# fixture v5 marker\n")
    scripts = home / "current/skills/synthesis-context-lifecycle/scripts"
    scripts.mkdir(parents=True)
    (scripts / "context_doctor.py").write_text(
        "import json,sys\n"
        "try:\n import fixture_foreign\n foreign=True\nexcept ImportError:\n foreign=False\n"
        "finding={'project':'alpha','check':'context-budget','severity':'defect','message':'foreign=%s' % foreign,'remedy':'trim'}\n"
        "print(json.dumps({'ok':False,'exit':1,'active':'','projects_audited':1,'defects':1,'warnings':0,'coverage':{},'findings':[finding]}))\n"
        "sys.exit(1)\n"
    )
    foreign = home / "foreign-import"
    foreign.mkdir()
    (foreign / "fixture_foreign.py").write_text("")
    knowledge = home / "knowledge"
    (knowledge / "projects").mkdir(parents=True)
    settings = home / ".synthesis/console.yaml"
    settings.parent.mkdir(parents=True)
    settings.write_text(
        json.dumps({"sources": [{"name": "fixture", "root": str(knowledge), "projects_dir": "projects"}]})
    )
    env.update(PORT="19812", PYTHONPATH=str(foreign))
    process = subprocess.Popen(
        [str(root / "npm/bin/synthesis-console"), "start"],
        cwd=home,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        selector = selectors.DefaultSelector()
        selector.register(process.stdout, selectors.EVENT_READ)
        output = ""
        match = None
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if selector.select(timeout=0.2):
                output += os.read(process.stdout.fileno(), 65536).decode()
            match = re.search(r"http://localhost:(\d+)", output)
            if match:
                break
        assert match, output
        address = "http://127.0.0.1:" + match[1]
        with urllib.request.urlopen(address + "/api/conformance-status", timeout=15) as response:
            doctor = json.load(response)
        assert doctor["installed"] is True and doctor["healthy"] is False
        assert doctor["failures"] == 1 and doctor["error"] is None
        assert doctor["checks"][0]["detail"] == "labelled fixture only"
        assert (home / "doctor-cwd").read_text().strip() == str(home.resolve())
        with urllib.request.urlopen(address + "/api/context-status", timeout=15) as response:
            context = json.load(response)
        assert context["doctorAvailable"] is True and context["defects"] == 1
        with urllib.request.urlopen(address + "/context", timeout=15) as response:
            page = response.read().decode()
        assert "foreign=False" in page
        assert not list((home / "current").rglob("__pycache__"))
    finally:
        os.killpg(process.pid, signal.SIGTERM)
        process.communicate(timeout=5)


def test_packaged_platform_and_service_dependency_closure(distribution, tmp_path):
    package = distribution[0] / "npm"
    home = tmp_path / "home"
    env = environment(home)
    # Isolate Bun's ordinary transpiler cache, as the existing inert CLI fixtures do.
    # The complete home snapshot still proves no ecosystem settings or owner files changed.
    env["BUN_RUNTIME_TRANSPILER_CACHE_PATH"] = "0"
    before = list(home.rglob("*"))
    result = subprocess.run(
        [str(package / "bin/synthesis-console"), "autostart", "status"],
        env=env,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    mapping = json.loads(result.stdout)
    assert not mapping["mutation_authorized"]
    assert mapping["native_service_status"] == "UNKNOWN"
    assert "console_python" not in mapping
    assert mapping["runtime_paths"]["bin"] == str(home / "bin")
    target = home / "absent-owned-unit"
    checked = subprocess.run(
        ["bun", str(package / "scripts/service-ownership.ts"), "check", str(target)],
        env=env,
        text=True,
        capture_output=True,
        timeout=10,
    )
    assert checked.returncode == 0, checked.stderr
    assert list(home.rglob("*")) == before
    assert not (package / "src").exists() and not (package / "node_modules").exists()
