"""Init parser/source controls; actual namespace controls live in the backend consumer."""

import importlib.util
from pathlib import Path
import pytest

PATH = Path(__file__).with_name("container-init.py")


def module():
    spec = importlib.util.spec_from_file_location("container_init", PATH)
    m = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(m)
    return m


def config():
    return {
        "type": "configure",
        "schema_version": 1,
        "nonce": "a" * 32,
        "workspace": "/work",
        "native_sha256": "b" * 64,
        "init_sha256": "c" * 64,
        "wall_ms": 5000,
        "heartbeat_ms": 500,
        "max_io_bytes": 1048576,
    }


def test_closed_configuration():
    m = module()
    assert m.validate_config(config())["wall_ms"] == 5000


@pytest.mark.parametrize(
    "key,value",
    [
        ("wall_ms", True),
        ("heartbeat_ms", 0),
        ("workspace", "/"),
        ("native_sha256", "wrong"),
        ("command", ["sh"]),
        ("extra", False),
    ],
)
def test_invalid_configuration(key, value):
    x = config()
    x[key] = value
    with pytest.raises(ValueError):
        module().validate_config(x)


def test_main_requires_namespace_pid1(monkeypatch):
    m = module()
    monkeypatch.setattr(m.os, "getpid", lambda: 12)
    with pytest.raises(RuntimeError, match="PID1"):
        m.main()


import base64
import hashlib
import json
import os
import selectors
import signal
import subprocess
import sys
import time


def test_main_keeps_nonroot_and_nnp_requirements(monkeypatch):
    m = module()
    monkeypatch.setattr(m.os, "getpid", lambda: 1)
    monkeypatch.setattr(m.os, "getuid", lambda: 0)
    with pytest.raises(RuntimeError, match="nonroot"):
        m.main()


def test_artifact_symlink_is_not_followed(tmp_path):
    target = tmp_path / "target"
    target.write_text("data")
    link = tmp_path / "link"
    link.symlink_to(target)
    with pytest.raises(OSError):
        module().digest_file(str(link))


class Protocol:
    """Real stdio child test, explicitly not a PID namespace containment claim."""

    def __init__(self, root, wall=2000, heartbeat=500, native_source=None):
        if not hasattr(os, "waitid"):
            pytest.skip(
                "Linux waitid protocol; the real container consumers exercise this init on Darwin hosts"
            )
        self.root = root
        self.rows = []
        self.raw = b""
        self.pid = None
        native_bytes = ("#!" + sys.executable + (native_source or
            "\nimport sys\nfor line in sys.stdin:\n print(line.strip(),flush=True)\n")).encode()
        # Linux fixtures keep the executable on a read-only mount, preserving
        # the production noexec temporary filesystem without a policy bypass.
        fixture_root = os.environ.get("SYNTHESIS_CONTAINER_PIPE_FIXTURES")
        if fixture_root:
            native = Path(fixture_root) / hashlib.sha256(native_bytes).hexdigest()
            assert native.read_bytes() == native_bytes
        else:
            native = root / "fake-native"
            native.write_bytes(native_bytes)
            native.chmod(0o700)
        c = config()
        c.update(
            workspace=str(root),
            native_sha256=hashlib.sha256(native.read_bytes()).hexdigest(),
            init_sha256=hashlib.sha256(PATH.read_bytes()).hexdigest(),
            wall_ms=wall,
            heartbeat_ms=heartbeat,
        )
        code = f'import importlib.util; s=importlib.util.spec_from_file_location("ci",{str(PATH)!r});m=importlib.util.module_from_spec(s);s.loader.exec_module(m);m.NATIVE={str(native)!r};m.SELF={str(PATH)!r};m.drive({c!r})'
        self.process = subprocess.Popen(
            [sys.executable, "-I", "-B", "-c", code],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True,
        )
        self.selector = selectors.DefaultSelector()
        self.selector.register(self.process.stdout, selectors.EVENT_READ)
        self.read("ready")

    def send(self, row):
        self.process.stdin.write(json.dumps(row).encode() + b"\n")
        self.process.stdin.flush()

    def read(self, kind):
        until = time.monotonic() + 4
        while time.monotonic() < until:
            while b"\n" in self.raw:
                line, self.raw = self.raw.split(b"\n", 1)
                row = json.loads(line)
                self.rows.append(row)
                if row["type"] == "ready":
                    self.pid = row["native_pid"]
                if row["type"] == kind:
                    return row
            if self.selector.select(0.05):
                part = os.read(self.process.stdout.fileno(), 65536)
                if not part:
                    break
                self.raw += part
        raise AssertionError(
            f"missing {kind}; {self.rows}; exit {self.process.poll()}; stderr {self.process.stderr.read().decode() if self.process.poll() is not None else 'running'}"
        )

    def close(self):
        try:
            self.process.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=2)
        if self.pid:
            try:
                os.killpg(self.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        self.selector.close()
        (self.root / "observed.json").write_text(json.dumps(self.rows, indent=2))
        for p in [self.process.stdin, self.process.stdout, self.process.stderr]:
            p.close()


@pytest.mark.parametrize(
    "row",
    [
        {"type": "heartbeat", "nonce": "a" * 32, "seq": 0},
        {"type": "heartbeat", "nonce": "b" * 32, "seq": 1},
        {"type": "heartbeat", "nonce": "a" * 32, "seq": True},
        {"type": "heartbeat", "nonce": "a" * 32, "seq": 2},
        {"type": "heartbeat", "nonce": "a" * 32, "seq": 1, "extra": 1},
        {"type": "native_input", "nonce": "a" * 32, "seq": 1, "data": "@@bad@@"},
        {"type": "shell", "nonce": "a" * 32, "seq": 1},
    ],
)
def test_real_stdio_rejects_malformed_owner_frames(tmp_path, row):
    p = Protocol(tmp_path)
    try:
        p.send(row)
        assert p.read("terminal")["reason"] == "invalid_owner_frame"
    finally:
        p.close()


def test_real_stdio_keeps_exact_native_output_and_explicit_cancel(tmp_path):
    p = Protocol(tmp_path)
    try:
        p.send(
            {
                "type": "native_input",
                "nonce": "a" * 32,
                "seq": 1,
                "data": base64.b64encode(b"private-fixture-value\n").decode(),
            }
        )
        row = p.read("native_output")
        assert base64.b64decode(row["data"]) == b"private-fixture-value\n"
        p.send({"type": "cancel", "nonce": "a" * 32, "seq": 2})
        assert p.read("terminal")["reason"] == "cancelled"
    finally:
        p.close()


def test_no_heartbeat_has_its_own_deadline(tmp_path):
    p = Protocol(tmp_path)
    try:
        assert p.read("terminal")["reason"] == "owner_lost"
    finally:
        p.close()


def test_continued_heartbeats_cannot_extend_absolute_wall(tmp_path):
    p = Protocol(tmp_path, wall=650, heartbeat=400)
    try:
        for seq in range(1, 6):
            p.send({"type": "heartbeat", "nonce": "a" * 32, "seq": seq})
            time.sleep(0.1)
        assert p.read("terminal")["reason"] == "deadline"
    finally:
        p.close()


def test_owner_pipe_eof_is_not_a_clean_native_success(tmp_path):
    p = Protocol(tmp_path)
    try:
        p.process.stdin.close()
        row = p.read("terminal")
        assert row["reason"] == "owner_lost"
        assert row["task_accepted"] is False
    finally:
        p.close()


from types import SimpleNamespace
@pytest.mark.parametrize('malformed,native_exits',[(False,True),(True,False),(True,True)])
def test_protocol_rejection_survives_simultaneous_native_exit(monkeypatch,malformed,native_exits):
    source=PATH
    spec=importlib.util.spec_from_file_location('review_init',source)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
    nonce='a'*32
    config={'type':'configure','schema_version':1,'nonce':nonce,'workspace':str(source.parent),
      'native_sha256':'b'*64,'init_sha256':'b'*64,'wall_ms':5000,'heartbeat_ms':1000,'max_io_bytes':65536}
    output=[]
    class Exit(Exception): pass
    class Child:
        pid=12345; returncode=0
        stdin=SimpleNamespace(fileno=lambda:101)
        stdout=SimpleNamespace(fileno=lambda:102)
        stderr=SimpleNamespace(fileno=lambda:103)
        calls=0
        def poll(self):
            self.calls+=1
            return None if self.calls==1 or not native_exits else 0
    class Selector:
        def register(self,*args): pass
        def unregister(self,*args): pass
        def modify(self,*args): pass
        def select(self,*args):
            return [(SimpleNamespace(fd=102,data='stdout'),1),(SimpleNamespace(fd=103,data='stderr'),1),(SimpleNamespace(fd=0,data='owner'),1)]
    child=Child()
    monkeypatch.setattr(m,'digest_file',lambda p:'b'*64)
    monkeypatch.setattr(m.subprocess,'Popen',lambda *a,**k:child)
    monkeypatch.setattr(m.selectors,'DefaultSelector',Selector)
    monkeypatch.setattr(m.os,'set_blocking',lambda *a:None)
    monkeypatch.setattr(m.os,'waitid',lambda *a:None,raising=False)
    for constant in ('P_ALL','WEXITED','WNOHANG','WNOWAIT'):
        monkeypatch.setattr(m.os,constant,0,raising=False)
    monkeypatch.setattr(m.signal,'signal',lambda *a:None)
    attack=json.dumps({'type':'heartbeat','nonce':nonce,'seq':0 if malformed else 1}).encode()+b'\n'
    monkeypatch.setattr(m.os,'read',lambda fd,n:attack if fd==0 else b'')
    def write(fd,raw): output.append(bytes(raw));return len(raw)
    def exit(code): raise Exit(code)
    monkeypatch.setattr(m.os,'write',write)
    monkeypatch.setattr(m.os,'_exit',exit)
    with pytest.raises(Exit) as exited:m.drive(config)
    rows=[json.loads(line) for line in b''.join(output).splitlines()]
    terminal=rows[-1]
    print(json.dumps({'terminal':terminal,'process_exit':exited.value.args[0]}))
    assert terminal['reason']==('invalid_owner_frame' if malformed else 'native_exit')
    assert (exited.value.args[0]!=0)==malformed


@pytest.mark.parametrize("kind", ["heartbeat", "malformed", "cancel", "finish"])
def test_real_pipes_terminal_precedence_with_already_exited_child(tmp_path, kind):
    """Real Linux pipes plus a stopped init force the reviewed simultaneous event."""
    native = "\nimport os,time\nwhile not os.path.exists('exit-now'): time.sleep(0.005)\n"
    p = Protocol(tmp_path, wall=5000, heartbeat=2000, native_source=native)
    try:
        os.kill(p.process.pid, signal.SIGSTOP)
        (tmp_path / "exit-now").write_text("controlled native exit")
        until = time.monotonic() + 1
        while time.monotonic() < until:
            status = Path(f"/proc/{p.pid}/stat")
            if not status.exists() or status.read_text().split(")", 1)[1].split()[0] == "Z":
                break
            time.sleep(0.005)
        else:
            raise AssertionError("fake native did not exit before owner frame")
        p.send({"type": "heartbeat" if kind == "malformed" else kind,
                "nonce": "a" * 32, "seq": 0 if kind == "malformed" else 1})
        os.kill(p.process.pid, signal.SIGCONT)
        row = p.read("terminal")
        expected = {"heartbeat": "native_exit", "malformed": "invalid_owner_frame",
                    "cancel": "cancelled", "finish": "owner_finished"}[kind]
        assert row["reason"] == expected
        assert row["task_accepted"] is False
        assert (p.process.wait(timeout=2) != 0) == (kind == "malformed")
    finally:
        try:
            os.kill(p.process.pid, signal.SIGCONT)
        except ProcessLookupError:
            pass
        p.close()
