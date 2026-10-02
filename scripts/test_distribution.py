"""Physical npm/Bun/direct consumers; fixture core never claims publication."""
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
    configured = os.environ.get("SYNTHESIS_CORE_SOURCE")
    core = (
        Path(configured)
        if configured
        else ROOT.parent / "synthesis-skills-unified-installation"
    )
    if not (core / "packages/build.py").exists():
        raise RuntimeError(
            "Set SYNTHESIS_CORE_SOURCE to the verified core source checkout"
        )
    # Acquisition is not exercised here. A nongit source fixture avoids inventing
    # a commit in the developer checkout while testing the real packaged launcher.
    fixture_source = temporary / "core-source"
    fixture_source.mkdir()
    for relative in [
        ".claude-plugin/plugin.json",
        ".codex-plugin/plugin.json",
        "onboard.sh",
        "LICENSE-APACHE",
    ]:
        target = fixture_source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(core / relative, target)
    core_pkg = module(core / "packages/build.py").build_package(
        fixture_source, temporary / "core", commit="1" * 40
    )
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
    record = builder.build_fixture(first, core_pkg, source=console_source)
    record2 = builder.build_fixture(second, core_pkg, source=console_source)
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
    assert (root / "npm/app/autopilot-supervisor.js").is_file()
    assert record["archive"]["sha256"] in (root / "synthesis-console.rb").read_text()
    assert record["archive"]["sha256"] in (root / "install.sh").read_text()


def test_packaged_supervisor_resolves_real_immutable_owner_dependencies(
    distribution, tmp_path
):
    """Actual packaged CLI/runtime/owner modules; synthetic custody/activation, absent grant.

    This checks local dependency custody and refusal, not a native launch,
    provider account, production installation or machine-survival qualification.
    """
    import uuid
    import time
    import signal

    root, record = distribution
    home = tmp_path / "home"
    env = environment(home)
    env.pop("SYNTHESIS_PUBLIC_SKILLS_SOURCE", None)
    env.pop("SYNTHESIS_ACTIVE_DESCRIPTOR", None)
    env.pop("SYNTHESIS_PYTHON_BIN", None)
    binary = root / "npm/bin/synthesis-console"
    setup = subprocess.run(
        [str(binary), "setup", "--no-dormant-core"],
        cwd=home,
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert setup.returncode == 0, setup.stdout + setup.stderr
    ready = subprocess.check_output(
        ["bash", str(root / "npm/scripts/python-runtime.sh"), "resolve"],
        env=env,
        text=True,
    ).strip()
    core = Path(os.environ["SYNTHESIS_CORE_SOURCE"])
    version = json.loads((core / ".codex-plugin/plugin.json").read_text())["version"]
    generation = (
        home / ".codex/plugins/cache/synthesis-engineering/synthesis-skills" / version
    )
    for directory in ["skills", ".claude-plugin", ".codex-plugin"]:
        shutil.copytree(
            core / directory,
            generation / directory,
            ignore=shutil.ignore_patterns("__pycache__", ".pytest_cache", "*.pyc"),
        )
    # The actual release owner validates the synthetic receipt, whole tree,
    # interpreter and launcher. No verifier or consumer is stubbed.
    provision = r"""
import sys,json,hashlib
from pathlib import Path
sys.path.insert(0,sys.argv[1]+'/skills/synthesis-onboarding/scripts')
import release_runtime as runtime,system_contract
root=Path(sys.argv[1]);pointer=runtime.descriptor_path();pointer.parent.mkdir(parents=True,exist_ok=True)
pointer.with_name(pointer.name+'.lock').touch()
data={'schema_version':1,'version':sys.argv[2],'channel':'stable','ref':'stable','commit':'1'*40,'tree':'2'*40,
 'content_digest':runtime.tree_digest(root),'digest_algorithm':'sha256-tree-v1','tree_policy':'regular-files-and-directories-no-links-v1',
 'source_url':'https://example.test/synthetic-fixture.git','resolved_at':'2026-09-25T00:00:00Z',
 'release_root':str(root),'interpreter':runtime.interpreter_pin(sys.executable)}
launcher=Path.home()/'fixture-bin/synthesis';launcher.parent.mkdir();content=system_contract.launcher_bytes(pointer,data['interpreter'])
launcher.write_bytes(content);launcher.chmod(0o755)
data['launcher']={'path':str(launcher),'runtime_schema':1,'sha256':hashlib.sha256(content).hexdigest()}
pointer.write_text(json.dumps(data));runtime.verified_release()
"""
    fixture_env = dict(env, SYNTHESIS_RUNTIME_POLICY="packaged-python-v1")
    created = subprocess.run(
        [ready, "-I", "-B", "-c", provision, str(generation), version],
        env=fixture_env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert created.returncode == 0, created.stdout + created.stderr

    def production(*args, input=None):
        return subprocess.run(
            [str(binary), "supervision", *args],
            input=input,
            cwd=home,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )

    private = home / ".local/state/synthesis-console/supervision"
    unavailable = production("enroll")
    assert unavailable.returncode != 0 and not private.exists()
    view = json.loads(production("status").stdout)
    assert (
        view["automatic_continuation"] == "UNAVAILABLE"
        and view["operational_ready"] is False
    )
    # The production gate has no CLI/env bypass. This fixture subclasses the
    # bundled module solely to qualify the dependency/refusal chain below a
    # declared synthetic custody seam, never native containment or a service.
    driver = tmp_path / "synthetic-custody.ts"
    driver.write_text(
        "import {Supervisor} from "
        + json.dumps(str(root / "npm/app/autopilot-supervisor.js"))
        + ";\n"
        "class SyntheticCustody extends Supervisor {requireCustody() {}}\n"
        "const s=new SyntheticCustody();const action=process.argv[2];\n"
        'if(action==="enroll")await s.enroll();else if(action==="submit")await s.submit(JSON.parse(await Bun.stdin.text()));\n'
        'else if(action==="tick")await s.tick();console.log(JSON.stringify(s.status()));\n'
    )

    def cli(*args, input=None):
        return subprocess.run(
            ["bun", str(driver), *args],
            input=input,
            cwd=home,
            env=env,
            capture_output=True,
            text=True,
            timeout=15,
        )

    enrolled = cli("enroll")
    assert enrolled.returncode == 0, enrolled.stdout + enrolled.stderr
    receipt = json.loads((private / "enrollment.json").read_text())
    assert receipt["generation"]["python"] == ready
    assert receipt["generation"]["helper"] == str(
        generation / "skills/synthesis-autopilot/scripts/prepared_native_launch.py"
    )
    project = home / "isolated-project"
    project.mkdir()
    request = {
        "project": str(project),
        "run_id": str(uuid.uuid4()),
        "permit_id": "synthetic-absent-grant",
        "token": "a" * 64,
        "runtime_root": str(home / "isolated-runtime"),
    }
    # Before any uncertain delivery exists, sibling drift must independently
    # invalidate the enrolled whole release. Restoring exact bytes re-admits it.
    sibling = generation / "skills/synthesis-autopilot/scripts/run_state.py"
    original = sibling.read_bytes()
    sibling.write_bytes(original + b"\n# fixture drift\n")
    assert cli("submit", input=json.dumps(request)).returncode != 0
    assert not list(private.glob("*.ready")) and not list(private.glob("*.claimed"))
    sibling.write_bytes(original)
    submitted = cli("submit", input=json.dumps(request))
    assert submitted.returncode == 0, submitted.stdout + submitted.stderr
    # The bundled adapter consumes the real owner below synthetic custody.
    # The deliberately absent journal must refuse before any native process.
    process = subprocess.Popen(
        ["bun", str(driver), "tick"],
        cwd=home,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        start_new_session=True,
    )
    try:
        deadline = time.monotonic() + 15
        while time.monotonic() < deadline:
            rows = [
                json.loads(path.read_text())
                for path in private.glob("*.json")
                if path.name != "enrollment.json"
            ]
            if any(row.get("delivery") == "uncertain" for row in rows):
                break
            if process.poll() is not None:
                break
            time.sleep(0.05)
        assert any(row.get("delivery") == "uncertain" for row in rows), rows
        status = cli("status")
        assert status.returncode == 0, status.stderr
        view = json.loads(status.stdout)
        assert not view["healthy"] and view["counts"]["uncertain"] == 1
        assert not list(private.glob("*.ready")) and not list(private.glob("*.claimed"))
        assert request["token"] not in "".join(
            path.read_text() for path in private.glob("*.json")
        )
    finally:
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
        try:
            output, error = process.communicate(timeout=12)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            output, error = process.communicate(timeout=5)
        assert request["token"] not in output + error


def test_packaged_delivery_consumes_real_owner_journal_once(distribution, tmp_path):
    """Actual package/stdin/PM/CAS join, with explicit synthetic native custody.

    The isolated board, native transcript, repo attribution and transport are
    fixture inputs. Neither whole-tree containment nor native qualification is
    asserted. No PM admission, owner reducer, journal or delivery step is mocked.
    """
    root, _ = distribution
    home = tmp_path / "home"
    env = environment(home)
    core = Path(os.environ["SYNTHESIS_CORE_SOURCE"]).resolve()
    facts = tmp_path / "facts.json"
    setup = tmp_path / "prepare.py"
    setup.write_text("""
import sys,json,os
from pathlib import Path
import pytest
core=Path(sys.argv[1]);sys.path.insert(0,str(core/'skills/synthesis-autopilot/scripts'))
from test_controller import world,engine,facade,attribute_recovery_fixture
from test_prepared_native_launch import prepared,TOKEN
mp=pytest.MonkeyPatch();w=world.__wrapped__(Path(sys.argv[2]),mp)
e=engine.__wrapped__(mp);f=facade.__wrapped__(e);state=prepared(f,w)
attribute_recovery_fixture(w)
Path(sys.argv[3]).write_text(json.dumps({'request':{'project':str(w['project']),'run_id':state['run_id'],
 'permit_id':'permit1','token':TOKEN,'runtime_root':str(w['runtime'])},'owner':state['owner'],
 'claude_config':os.environ['CLAUDE_CONFIG_DIR'],'revision':state['revision']}))
""")
    isolated = tmp_path / "actual-owner"
    isolated.mkdir()
    seed = subprocess.run(
        [sys.executable, str(setup), str(core), str(isolated), str(facts)],
        env=env,
        capture_output=True,
        text=True,
        timeout=45,
    )
    assert seed.returncode == 0, seed.stdout + seed.stderr
    info = json.loads(facts.read_text())
    env["CLAUDE_CONFIG_DIR"] = info["claude_config"]
    helper = tmp_path / "synthetic-native-only.py"
    helper.write_text(
        """
import sys
from pathlib import Path
import pytest
sys.path.insert(0,"""
        + repr(str(core / "skills/synthesis-autopilot/scripts"))
        + """)
# Only the native boundary is synthetic. The actual ordinary stdin consumer
# performs admission, one-use CAS, issuer fencing, attribution and observation.
import autopilot
autopilot.engine()
from test_prepared_native_launch import synthetic_transport
synthetic_transport(pytest.MonkeyPatch(),None)
import prepared_native_launch
raise SystemExit(prepared_native_launch.main())
"""
    )
    generation = {
        "python": sys.executable,
        "helper": str(helper),
        "helper_sha256": hashlib.sha256(helper.read_bytes()).hexdigest(),
        "release_root": str(core),
        "release_digest": "a" * 64,
        "console_version": json.loads((root / "npm/package.json").read_text())[
            "version"
        ],
    }
    driver = tmp_path / "actual-owner-join.ts"
    driver.write_text(
        "import {Supervisor} from "
        + json.dumps(str(root / "npm/app/autopilot-supervisor.js"))
        + ";\n"
        "class SyntheticCustody extends Supervisor {requireCustody() {}}\n"
        "const s=new SyntheticCustody({resolveGeneration:async()=>("
        + json.dumps(generation)
        + ")});\n"
        'const action=process.argv[2];if(action==="enroll")await s.enroll();\n'
        'else if(action==="submit")await s.submit(JSON.parse(await Bun.stdin.text()));\n'
        'else if(action==="tick")await s.tick();console.log(JSON.stringify(s.status()));\n'
    )

    def invoke(action, request=None):
        return subprocess.run(
            ["bun", str(driver), action],
            input=json.dumps(request) if request else None,
            cwd=home,
            env=env,
            capture_output=True,
            text=True,
            timeout=45,
        )

    enrollment = invoke("enroll")
    assert enrollment.returncode == 0, enrollment.stdout + enrollment.stderr
    sent = invoke("submit", info["request"])
    assert sent.returncode == 0, sent.stdout + sent.stderr
    consumed = invoke("tick")
    assert consumed.returncode == 0, consumed.stdout + consumed.stderr
    status = json.loads(consumed.stdout)
    assert status["counts"]["delivered"] == 1, status
    replay = invoke("submit", info["request"])
    assert replay.returncode != 0
    private = home / ".local/state/synthesis-console/supervision"
    assert not list(private.glob("*.ready")) and not list(private.glob("*.claimed"))
    assert info["request"]["token"] not in "".join(
        p.read_text() for p in private.glob("*.json")
    )
    verify = """
import sys,json
from pathlib import Path
sys.path.insert(0,sys.argv[1]+'/skills/synthesis-autopilot/scripts')
import autopilot;autopilot.engine()
import run_state
info=json.loads(Path(sys.argv[2]).read_text());r=info['request']
state=run_state.load_run(Path(r['project']),r['run_id'])
events=[row for row in run_state._events(Path(r['project']),r['run_id']) if row['command'] in
 {'native.launch.reserve','native.launch.submit','native.launch.observe'}]
assert len(events)==3
assert all(x['actor']['kind']=='prepared-native-launch' and x['actor']['native_actor_authenticated'] is False for x in events)
assert state['owner']==info['owner'] and state['status']!='completed'
assert state['extensions']['prepared_native_launch']['permits']['permit1']['status']=='observed'
assert state['revision']==info['revision']+3
print(json.dumps({'service_events':len(events),'task_accepted':False,'owner_preserved':True}))
"""
    checked = subprocess.run(
        [sys.executable, "-I", "-B", "-c", verify, str(core), str(facts)],
        env=env,
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert checked.returncode == 0, checked.stdout + checked.stderr
    assert json.loads(checked.stdout)["service_events"] == 3


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
def test_actual_consumers_help_setup_optout_and_integrity(
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
    bare = tmp_path / "bare-python"
    subprocess.run(
        [sys.executable, "-I", "-B", "-m", "venv", "--without-pip", str(bare)],
        check=True,
    )
    interpreter = bare / "bin/python3"
    assert (
        subprocess.run(
            [str(interpreter), "-I", "-B", "-c", "import yaml"], capture_output=True
        ).returncode
        != 0
    )
    env["SYNTHESIS_BOOTSTRAP_PYTHON"] = str(interpreter)
    env.pop("SYNTHESIS_PYTHON_BIN", None)
    for args in [
        ["--version"],
        ["--help"],
        ["synthesis", "--help"],
        ["setup", "--no-dormant-core"],
    ]:
        r = subprocess.run(
            [str(binary), *args], cwd=home, env=env, capture_output=True, text=True
        )
        assert r.returncode == 0, r.stdout + r.stderr
    status = subprocess.run(
        [str(binary), "supervision", "status"],
        cwd=home,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert status.returncode == 0, status.stdout + status.stderr
    assert json.loads(status.stdout)["lifecycle"] == "disabled"
    refused = subprocess.run(
        [str(binary), "supervision", "submit"],
        input=json.dumps({"token": "DO-NOT-PRINT-TOKEN"}),
        cwd=home,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert (
        refused.returncode != 0
        and "DO-NOT-PRINT-TOKEN" not in refused.stdout + refused.stderr
    )
    resolved = subprocess.run(
        ["bash", str(package / "scripts/python-runtime.sh"), "resolve"],
        env=env,
        capture_output=True,
        text=True,
    )
    assert resolved.returncode == 0, resolved.stderr
    ready = Path(resolved.stdout.strip())
    checked = subprocess.run(
        [
            str(ready),
            "-I",
            "-B",
            "-c",
            'import yaml;print(yaml.__version__);print(yaml.safe_load("ready: true")["ready"])',
        ],
        env=env,
        capture_output=True,
        text=True,
    )
    assert checked.returncode == 0 and checked.stdout == "6.0.3\nTrue\n", checked.stderr
    assert record["python_dependency"]["version"] == "6.0.3"
    assert not (bare / "lib/python3.12/site-packages/yaml").exists()
    status = subprocess.run(
        [str(binary), "synthesis", "status", "--json"],
        cwd=home,
        env=env,
        capture_output=True,
        text=True,
    )
    assert status.returncode == 2, status.stdout + status.stderr
    assert "not configured" in (status.stdout + status.stderr).lower()
    for path in [
        ".synthesis",
        ".claude",
        ".agents",
        ".local/state/synthesis",
        "Library/LaunchAgents",
        ".config/systemd",
    ]:
        assert not (home / path).exists()
    bootstrap = package / "synthesis-core/lib/onboard.sh"
    bootstrap.write_text("corrupted")
    r = subprocess.run(
        [str(binary), "setup", "--no-dormant-core"],
        cwd=home,
        env=env,
        capture_output=True,
        text=True,
    )
    assert r.returncode != 0 and "integrity" in r.stderr


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
        "--no-dormant-core",
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
        "--no-dormant-core",
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
    else:
        # A real-looking retained inventory must remain invisible to the demo.
        retained = home / ".local/state/synthesis-console/supervision"
        retained.mkdir(parents=True, mode=0o700)
        entry = retained / "enrollment.json"
        entry.write_text(
            json.dumps({"schema_version": 1, "lifecycle": "enrolled", "generation": {}})
        )
        entry.chmod(0o600)
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
        try:
            response = urllib.request.urlopen(
                "http://127.0.0.1:" + match[1] + "/api/autopilot/supervision-health",
                timeout=5,
            )
        except urllib.error.HTTPError as error:
            response = error
        with response:
            assert response.status == (404 if mode == "demo" else 200)
            assert (
                response.headers["Cache-Control"]
                == "no-store, no-cache, must-revalidate, max-age=0"
            )
            assert (
                response.headers["Pragma"] == "no-cache"
                and response.headers["Expires"] == "0"
            )
            if mode == "start":
                health = json.load(response)
                assert (
                    health["automatic_continuation"] == "UNAVAILABLE"
                    and health["operational_ready"] is False
                )
                assert not (
                    home / ".local/state/synthesis-console/supervision"
                ).exists()
        # The demonstration is a closed sample-data surface. It must not expose
        # machine health or reach global refresh/checkpoint/audio mutation routes.
        base = "http://127.0.0.1:" + match[1]
        with urllib.request.urlopen(base + "/autopilot", timeout=5) as response:
            html = response.read().decode()
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
                "/api/sync/checkpoint",
                "/api/context/audit",
                "/api/conformance/audit",
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

    # Use a real fresh interpreter: package service installation must provision YAML.
    bare = tmp_path / "bare-python"
    subprocess.run(
        [sys.executable, "-I", "-B", "-m", "venv", "--without-pip", str(bare)],
        check=True,
    )
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
    env.update(
        PATH=str(fake) + os.pathsep + env["PATH"],
        SYNTHESIS_BOOTSTRAP_PYTHON=str(bare / "bin/python3"),
    )
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
    assert not (home / ".local/share/synthesis-console/python-runtime").exists()
    target.unlink()
    installed = command("install")
    assert installed.returncode == 0, installed.stdout + installed.stderr
    owned = target.read_bytes()
    manager_actions = log.read_bytes()
    resolved = subprocess.run(
        ["bash", str(root / "npm/scripts/python-runtime.sh"), "resolve"],
        env=env,
        capture_output=True,
        text=True,
    )
    assert resolved.returncode == 0, resolved.stderr
    assert resolved.stdout.strip() in owned.decode()
    probe = subprocess.run(
        [
            resolved.stdout.strip(),
            "-I",
            "-B",
            "-c",
            "import yaml;print(yaml.__version__)",
        ],
        capture_output=True,
        text=True,
    )
    assert probe.returncode == 0 and probe.stdout == "6.0.3\n", probe.stderr
    target.write_text("edited unit")
    assert command("uninstall").returncode != 0
    assert target.read_text() == "edited unit" and log.read_bytes() == manager_actions
    target.write_bytes(owned)
    removed = command("uninstall")
    assert removed.returncode == 0, removed.stdout + removed.stderr
    assert not target.exists()


class CurlCancellationTests(unittest.TestCase):
    """Run actual installer bytes with disposable transport and setup workers."""

    def fixture(self, root, phase, mode="wait"):
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
        setup_code = "const fs=require('fs'); const mode=process.env.CURL_CHILD_MODE; if(mode==='exit')process.exit(23); if(mode==='signal')process.kill(process.pid,'SIGTERM'); else {for(const [name,number] of [['SIGINT',2],['SIGTERM',15],['SIGHUP',1]])process.on(name,()=>{fs.writeFileSync(process.env.CURL_STOPPED,String(number));process.exit(0)});fs.writeFileSync(process.env.CURL_READY,String(process.pid));setTimeout(()=>{},30000);}\n"
        with tarfile.open(archive, "w:gz") as output:
            for name, data in [
                ("scripts/console-cli.ts", setup_code.encode()),
                ("synthesis-core/bin/synthesis", b"fixture only\n"),
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
        if phase == "transport":
            curl.write_text(
                "#!/bin/sh\nexec "
                + shlex.quote(sys.executable)
                + " "
                + shlex.quote(str(worker))
                + "\n"
            )
        else:
            curl.write_text(
                '#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$CURL_ARCHIVE" "$2"\n'
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
        return (
            ["sh", str(installer), "--prefix", str(prefix), "--no-dormant-core"],
            env,
            prefix,
        )

    def test_installer_forwards_and_reaps_each_incoming_signal(self):
        import signal
        import time

        for phase in ("transport", "setup"):
            for sig in (signal.SIGINT, signal.SIGTERM, signal.SIGHUP):
                with (
                    self.subTest(phase=phase, signal=sig),
                    tempfile.TemporaryDirectory(
                        prefix="synthesis-console-cancel-"
                    ) as tmp,
                ):
                    root = Path(tmp).resolve()
                    command, env, prefix = self.fixture(root, phase)
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
                        self.assertEqual(
                            (prefix / ".synthesis-console-install.json").exists(),
                            phase == "setup",
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

        for phase in ("transport", "setup"):
            for mode, expected in [("exit", 23), ("signal", -signal.SIGTERM)]:
                with (
                    self.subTest(phase=phase, mode=mode),
                    tempfile.TemporaryDirectory(
                        prefix="synthesis-console-status-"
                    ) as tmp,
                ):
                    command, env, prefix = self.fixture(
                        Path(tmp).resolve(), phase, mode
                    )
                    result = subprocess.run(
                        command, env=env, capture_output=True, timeout=5
                    )
                    self.assertEqual(
                        result.returncode, expected, result.stderr.decode()
                    )
                    self.assertFalse(list(prefix.glob(".synthesis-console-download-*")))


def test_generated_dashboard_python_action_uses_verified_owned_runtime(
    distribution, tmp_path
):
    """Exercise the built app's real HTTP-to-Python dispatch without live agents."""
    import re
    import selectors
    import signal
    import time
    import urllib.request

    root, record = distribution
    home = tmp_path / "home"
    env = environment(home)
    bare = tmp_path / "bare"
    subprocess.run(
        [sys.executable, "-I", "-B", "-m", "venv", "--without-pip", str(bare)],
        check=True,
    )
    env["SYNTHESIS_BOOTSTRAP_PYTHON"] = str(bare / "bin/python3")
    env.pop("SYNTHESIS_PYTHON_BIN", None)
    env.pop("SYNTHESIS_PRIVATE_CONTROL_PLANE", None)
    binary = root / "npm/bin/synthesis-console"
    setup = subprocess.run(
        [str(binary), "setup", "--no-dormant-core"],
        env=env,
        capture_output=True,
        text=True,
    )
    assert setup.returncode == 0, setup.stderr
    resolved = subprocess.run(
        ["bash", str(root / "npm/scripts/python-runtime.sh"), "resolve"],
        env=env,
        capture_output=True,
        text=True,
    )
    assert resolved.returncode == 0, resolved.stderr
    expected = resolved.stdout.strip()
    source = tmp_path / "source"
    source.mkdir()
    subprocess.run(["git", "init", "-q", str(source)], check=True)
    (source / ".codex-plugin").mkdir()
    (source / ".codex-plugin/plugin.json").write_text("{}")
    skill = source / "skills/synthesis-agent-conformance"
    (skill / "scripts").mkdir(parents=True)
    # The checker is a labelled fixture; this proves dispatch, not ecosystem conformance.
    (skill / "scripts/conformance.py").write_text(
        "import json,os,sys,yaml\nfrom datetime import datetime,timezone\nfrom pathlib import Path\n"
        'Path(os.environ["HOME"],"fixture-dispatch.json").write_text(json.dumps({"python":sys.executable,"yaml":yaml.__version__,"parsed":yaml.safe_load("ready: true")["ready"]}))\n'
        'report={"ok":True,"status":"PASS","checked_at":datetime.now(timezone.utc).isoformat(),"checks":[{"name":"fixture.dispatch","ok":True,"detail":"disposable fixture only","required":True,"plane":"fixture","status":"PASS"}]}\n'
        'Path(sys.argv[sys.argv.index("--report-file")+1]).write_text(json.dumps(report))\n'
    )
    (home / "active-project.json").write_text(
        json.dumps({"project": str(source), "worktree": str(source)})
    )
    foreign = home / "foreign-import"
    foreign.mkdir()
    (foreign / "yaml.py").write_text('raise RuntimeError("wrong dependency")')
    env.update(
        PORT="19812",
        SYNTHESIS_CONFORMANCE_SOURCE_ROOT=str(source),
        SYNTHESIS_AGENT_CONFORMANCE_DIR=str(skill),
        PYTHONPATH=str(foreign),
    )
    # Machine diagnostics are an ordinary configured-server operation;
    # strict demo intentionally cannot reach this Python mutation route.
    settings = home / ".synthesis/console.yaml"
    settings.parent.mkdir(exist_ok=True)
    settings.write_text(
        json.dumps(
            {
                "sources": [
                    {"name": "fixture", "root": str(source), "projects_dir": "projects"}
                ]
            }
        )
    )
    process = subprocess.Popen(
        [str(binary), "start"],
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
        with urllib.request.urlopen(
            urllib.request.Request(address + "/api/conformance/audit", method="POST"),
            timeout=5,
        ) as response:
            assert json.load(response)["ok"] is True
        marker = home / "fixture-dispatch.json"
        deadline = time.monotonic() + 5
        while not marker.exists() and time.monotonic() < deadline:
            time.sleep(0.02)
        assert marker.exists()
        assert json.loads(marker.read_text()) == {
            "python": expected,
            "yaml": "6.0.3",
            "parsed": True,
        }
        unchanged = subprocess.run(
            ["bash", str(root / "npm/scripts/python-runtime.sh"), "resolve"],
            env=env,
            capture_output=True,
            text=True,
        )
        assert unchanged.returncode == 0 and unchanged.stdout == resolved.stdout, (
            unchanged.stderr
        )
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
    assert mapping["native_service_status"] == "UNKNOWN" and mapping[
        "console_python"
    ].endswith("/python-runtime")
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
