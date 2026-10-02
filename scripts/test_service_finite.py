"""Actual service-owner descendant custody, always with synthetic managers."""

from pathlib import Path
import os
import signal
import subprocess
import time
import pytest
import test_autostart_uninstall as original

service = original.service


@pytest.mark.parametrize("mode", ["orphan"])
def test_manager_descendant_cannot_escape_successful_retirement(service, mode):
    s = service
    for name in ("launchctl", "systemctl"):
        path = Path(s["env"]["PATH"].split(os.pathsep)[0]) / name
        text = path.read_text()
        needle = "loaded=home/'loaded';"
        text = text.replace(
            needle,
            """if mode=='orphan' and not (home/'orphan.pid').exists():
    import subprocess
    child=subprocess.Popen([sys.executable,'-c','import time; time.sleep(30)'],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
    (home/'orphan.pid').write_text(str(child.pid))
"""
            + needle,
        )
        path.write_text(text)
    started = time.monotonic()
    result = s["run"](mode)
    pid = int((s["home"] / "orphan.pid").read_text())
    try:
        assert result.returncode != 0, (
            "owner accepted a manager which left a live descendant"
        )
        assert time.monotonic() - started < 10
        assert s["target"].read_text() == "owned service\n"
        assert s["receipt"].read_bytes() == s["before"]
        state = subprocess.run(
            ["/bin/ps", "-p", str(pid), "-o", "stat="],
            text=True,
            capture_output=True,
            timeout=2,
        ).stdout.strip()
        assert not state or state.startswith("Z"), state
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
