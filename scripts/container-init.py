#!/usr/bin/env python3
"""Fixed Linux namespace PID1 for a bounded, framed Muse stdio transport.

This owns process custody only. It never authenticates a PM actor, approves a
tool, interprets model success, or certifies a task outcome.
"""
import base64
import hashlib
import json
import os
import re
import selectors
import signal
import stat
import subprocess
import time

NATIVE = "/opt/synthesis/muse"
SELF = "/opt/synthesis/container-init.py"
FRAME_MAX = 100_000
QUEUE_MAX = 1_048_576
HASH = re.compile(r"^[a-f0-9]{64}$")


def integer(value, low, high):
    return type(value) is int and low <= value <= high


def validate_config(value):
    expected = {
        "type",
        "schema_version",
        "nonce",
        "workspace",
        "native_sha256",
        "init_sha256",
        "wall_ms",
        "heartbeat_ms",
        "max_io_bytes",
    }
    if (
        type(value) is not dict
        or set(value) != expected
        or value["type"] != "configure"
        or type(value["schema_version"]) is not int
        or value["schema_version"] != 1
    ):
        raise ValueError("closed_configuration")
    if not isinstance(value["nonce"], str) or not re.fullmatch(
        "[a-f0-9]{32}", value["nonce"]
    ):
        raise ValueError("nonce")
    for key in ["native_sha256", "init_sha256"]:
        if not isinstance(value[key], str) or not HASH.fullmatch(value[key]):
            raise ValueError("artifact_identity")
    p = value["workspace"]
    if (
        not isinstance(p, str)
        or len(p) > 4096
        or not p.startswith("/")
        or p == "/"
        or "\x00" in p
        or os.path.normpath(p) != p
    ):
        raise ValueError("workspace")
    for key, lo, hi in [
        ("wall_ms", 500, 600_000),
        ("heartbeat_ms", 100, 10_000),
        ("max_io_bytes", 4096, 67_108_864),
    ]:
        if not integer(value[key], lo, hi):
            raise ValueError("resource_bound")
    if value["heartbeat_ms"] >= value["wall_ms"]:
        raise ValueError("heartbeat_bound")
    return value


def digest_file(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > 536_870_912:
            raise ValueError("artifact_type")
        h = hashlib.sha256()
        while True:
            part = os.read(fd, 65536)
            if not part:
                break
            h.update(part)
        after = os.fstat(fd)
        if (
            before.st_ino,
            before.st_dev,
            before.st_size,
            before.st_mtime_ns,
            before.st_ctime_ns,
        ) != (
            after.st_ino,
            after.st_dev,
            after.st_size,
            after.st_mtime_ns,
            after.st_ctime_ns,
        ):
            raise ValueError("artifact_changed")
        return h.hexdigest()
    finally:
        os.close(fd)


def first_frame(timeout=5):
    os.set_blocking(0, False)
    select = selectors.DefaultSelector()
    select.register(0, selectors.EVENT_READ)
    raw = bytearray()
    until = time.monotonic() + timeout
    try:
        while time.monotonic() < until:
            for _, _ in select.select(max(0, min(0.1, until - time.monotonic()))):
                chunk = os.read(0, 4096)
                if not chunk:
                    raise ValueError("configuration_eof")
                raw.extend(chunk)
                if len(raw) > FRAME_MAX:
                    raise ValueError("configuration_size")
                if b"\n" in raw:
                    line, remaining = raw.split(b"\n", 1)
                    return validate_config(json.loads(line)), bytes(remaining)
        raise ValueError("configuration_timeout")
    finally:
        select.close()


def drive(config, remaining=b""):
    """Called by verified PID1; split for deterministic protocol fixtures."""
    validate_config(config)
    if (
        digest_file(NATIVE) != config["native_sha256"]
        or digest_file(SELF) != config["init_sha256"]
    ):
        raise ValueError("artifact_digest")
    if os.path.realpath(config["workspace"]) != config[
        "workspace"
    ] or not os.path.isdir(config["workspace"]):
        raise ValueError("workspace_identity")
    env = {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": "/home/synthesis",
        "XDG_CONFIG_HOME": "/home/synthesis/.config",
        "XDG_DATA_HOME": "/home/synthesis/.local/share",
        "XDG_STATE_HOME": "/home/synthesis/.local/state",
        "XDG_CACHE_HOME": "/tmp/muse-cache",
        "NO_AUTO_UPDATE": "1",
        "LANG": "C.UTF-8",
    }
    child = subprocess.Popen(
        [
            NATIVE,
            "--approval-mode",
            "on-request",
            "--sandbox-network",
            "restricted",
            "serve",
        ],
        cwd=config["workspace"],
        env=env,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        start_new_session=True,
        bufsize=0,
        close_fds=True,
    )
    assert child.stdin and child.stdout and child.stderr
    for fd in [
        0,
        1,
        child.stdin.fileno(),
        child.stdout.fileno(),
        child.stderr.fileno(),
    ]:
        os.set_blocking(fd, False)
    select = selectors.DefaultSelector()
    select.register(0, selectors.EVENT_READ, "owner")
    select.register(child.stdout.fileno(), selectors.EVENT_READ, "stdout")
    select.register(child.stderr.fileno(), selectors.EVENT_READ, "stderr")
    outgoing = bytearray()
    pending = bytearray()
    incoming = bytearray(remaining)
    reason = None
    last_seq = 0
    total = 0
    started = time.monotonic()
    heartbeat = started
    native_exited_at = None
    open_native_streams = {"stdout", "stderr"}
    interrupted = []
    for sig in [signal.SIGTERM, signal.SIGINT, signal.SIGHUP]:
        signal.signal(sig, lambda s, f: interrupted.append(s))

    def emit(value):
        nonlocal reason
        encoded = json.dumps(value, separators=(",", ":")).encode() + b"\n"
        if len(outgoing) + len(encoded) > QUEUE_MAX:
            if reason is None:
                reason = "output_backpressure"
            return
        outgoing.extend(encoded)

    def messages():
        nonlocal reason, last_seq, total, heartbeat
        while b"\n" in incoming and reason is None:
            raw, rest = incoming.split(b"\n", 1)
            incoming[:] = rest
            if len(raw) > FRAME_MAX:
                reason = "input_frame_limit"
                break
            try:
                row = json.loads(raw)
                if type(row) is not dict:
                    raise ValueError()
                kind = row.get("type")
                keys = {"type", "nonce", "seq"} | (
                    {"data"} if kind == "native_input" else set()
                )
                if set(row) != keys or kind not in {
                    "native_input",
                    "heartbeat",
                    "cancel",
                    "finish",
                }:
                    raise ValueError()
                if (
                    row["nonce"] != config["nonce"]
                    or type(row["seq"]) is not int
                    or row["seq"] != last_seq + 1
                ):
                    raise ValueError()
                last_seq = row["seq"]
                if kind == "heartbeat":
                    heartbeat = time.monotonic()
                elif kind in {"cancel", "finish"}:
                    reason = "cancelled" if kind == "cancel" else "owner_finished"
                else:
                    if not isinstance(row["data"], str):
                        raise ValueError()
                    part = base64.b64decode(row["data"], validate=True)
                    if len(part) > 65536:
                        raise ValueError()
                    total += len(part)
                    if (
                        total > config["max_io_bytes"]
                        or len(pending) + len(part) > QUEUE_MAX
                    ):
                        reason = "input_budget"
                        break
                    pending.extend(part)
            except (ValueError, TypeError, json.JSONDecodeError):
                reason = "invalid_owner_frame"
        if reason is None and len(incoming) > FRAME_MAX:
            reason = "input_frame_limit"

    def reap():
        while True:
            try:
                info = os.waitid(os.P_ALL, 0, os.WEXITED | os.WNOHANG | os.WNOWAIT)
            except ChildProcessError:
                return
            if info is None:
                return
            if info.si_pid == child.pid:
                child.poll()
            else:
                os.waitpid(info.si_pid, os.WNOHANG)

    emit(
        {
            "type": "ready",
            "nonce": config["nonce"],
            "native_pid": child.pid,
            "task_accepted": False,
        }
    )
    while reason is None:
        now = time.monotonic()
        messages()
        # First selected terminal disposition is immutable: a clean native exit
        # or later pipe event cannot erase a protocol failure or cancellation.
        if reason is not None:
            break
        reap()
        if interrupted:
            reason = "host_signal"
        elif (now - started) * 1000 >= config["wall_ms"]:
            reason = "deadline"
        elif (now - heartbeat) * 1000 >= config["heartbeat_ms"]:
            reason = "owner_lost"
        elif child.poll() is not None:
            if native_exited_at is None:
                native_exited_at = now
            if not open_native_streams:
                reason = "native_exit"
            elif now - native_exited_at >= 0.25:
                reason = "output_incomplete"
        if reason:
            break
        for fd, queue, name in [
            (1, outgoing, "output"),
            (child.stdin.fileno(), pending, "native_input"),
        ]:
            try:
                if queue:
                    select.modify(fd, selectors.EVENT_WRITE, name)
                else:
                    select.unregister(fd)
            except KeyError:
                if queue:
                    select.register(fd, selectors.EVENT_WRITE, name)
        for key, _ in select.select(0.025):
            if reason is not None:
                break
            try:
                if key.data in {"output", "native_input"}:
                    queue = outgoing if key.data == "output" else pending
                    count = os.write(key.fd, queue[:65536])
                    del queue[:count]
                else:
                    part = os.read(key.fd, 32768)
                    if not part:
                        select.unregister(key.fd)
                        if key.data == "owner":
                            reason = "owner_lost"
                        elif key.data in open_native_streams:
                            open_native_streams.remove(key.data)
                    elif key.data == "owner":
                        incoming.extend(part)
                    else:
                        total += len(part)
                        if total > config["max_io_bytes"]:
                            reason = "output_budget"
                        else:
                            emit(
                                {
                                    "type": "native_output",
                                    "nonce": config["nonce"],
                                    "channel": key.data,
                                    "data": base64.b64encode(part).decode(),
                                }
                            )
            except BlockingIOError:
                pass
            except (BrokenPipeError, OSError):
                reason = "pipe_lost"
    emit(
        {
            "type": "terminal",
            "nonce": config["nonce"],
            "reason": reason,
            "native_exit_code": child.poll(),
            "task_accepted": False,
        }
    )
    # Never flush buffered Python IO or wait for native descendants here. The
    # kernel ends every remaining namespace task when this PID1 exits.
    until = time.monotonic() + 0.2
    while outgoing and time.monotonic() < until:
        try:
            count = os.write(1, outgoing[:65536])
            del outgoing[:count]
        except BlockingIOError:
            time.sleep(0.005)
        except OSError:
            break
    os._exit(
        0
        if reason in {"owner_finished", "cancelled"}
        or (reason == "native_exit" and child.returncode == 0)
        else 75
    )


def main():
    if os.getpid() != 1:
        raise RuntimeError("namespace PID1 required")
    if os.getuid() == 0:
        raise RuntimeError("nonroot UID required")
    status = dict(
        line.split(":", 1) for line in open("/proc/self/status") if ":" in line
    )
    if (
        status.get("NoNewPrivs", "").strip() != "1"
        or int(status.get("CapEff", "0").strip(), 16) != 0
    ):
        raise RuntimeError("outer confinement required")
    value, rest = first_frame()
    drive(value, rest)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        # Fixed diagnostic only: exception text could include input or secrets.
        try:
            os.set_blocking(2, False)
            os.write(2, b"container_init_refused\n")
        except OSError:
            pass
        os._exit(78)
