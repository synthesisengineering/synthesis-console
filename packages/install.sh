#!/bin/sh
# Release builder binds the archive version and checksum before publication.
set -eu
if ! command -v python3 >/dev/null 2>&1; then
  echo 'synthesis-console requires Python 3.9 or later.' >&2
  exit 2
fi
exec python3 - "$@" <<'SYNTHESIS_CONSOLE_INSTALLER'
import argparse
import fcntl
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import shlex
import signal
import shutil
import subprocess
import sys
import tarfile
import tempfile

VERSION = "@VERSION@"
ARCHIVE_SHA256 = "@ARCHIVE_SHA256@"
ARCHIVE_URL = "https://github.com/synthesisengineering/synthesis-console/releases/download/v%s/synthesis-console-%s.tar.gz" % (VERSION, VERSION)

def sha(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def atomic(path, data, mode=0o600):
    fd, temporary = tempfile.mkstemp(prefix=".synthesis-console-", dir=path.parent)
    temporary = Path(temporary)
    try:
        with os.fdopen(fd, "wb") as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        temporary.chmod(mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)

def regular(path):
    if path.is_symlink() or (path.exists() and not path.is_file()):
        raise ValueError("Refusing non-regular installation target: %s" % path)

def directory(path):
    for ancestor in (path, *path.parents):
        if ancestor.is_symlink() or (ancestor.exists() and not ancestor.is_dir()):
            raise ValueError("Refusing non-directory or symlink in install path: %s" % ancestor)

class Cancelled(BaseException):
    def __init__(self, signum):self.signum=signum


class ChildFailure(Exception):
    def __init__(self, code, arguments):
        self.code=code
        super().__init__('Child command failed with exit %s: %s'%(code,arguments[0]))


def run_child(arguments):
    cancelled=[]
    child=None
    def forward(signum,frame):
        cancelled.append(signum)
        if child is not None:
            try:os.killpg(child.pid,signum)
            except ProcessLookupError:pass
    previous={signum:signal.signal(signum,forward) for signum in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP)}
    try:
        child=subprocess.Popen(arguments,start_new_session=True)
        if cancelled:
            try:os.killpg(child.pid,cancelled[0])
            except ProcessLookupError:pass
        code=child.wait()
        if cancelled:raise Cancelled(cancelled[0])
        if code<0:raise Cancelled(-code)
        if code:raise ChildFailure(code,arguments)
    finally:
        for signum,handler in previous.items():signal.signal(signum,handler)


def main():
    if sys.version_info < (3, 9):
        raise ValueError("Python 3.9 or later is required.")
    bun = shutil.which("bun")
    if not bun: raise ValueError("Bun 1.3.13 or later is required.")
    if len(ARCHIVE_SHA256) != 64:
        raise ValueError("This is maintainer source, not a built release installer.")
    parser = argparse.ArgumentParser(description="Install the verified Synthesis Console release; preserve unknown or edited files.")
    parser.add_argument("--prefix", default=os.environ.get("SYNTHESIS_CONSOLE_INSTALL_DIR", str(Path.home() / ".local/bin")))
    parser.add_argument("--no-dormant-core", action="store_true")
    args = parser.parse_args()
    prefix = Path(args.prefix).expanduser().absolute()
    directory(prefix)
    prefix.mkdir(parents=True, exist_ok=True)
    target = prefix / "synthesis-console"
    receipt = prefix / ".synthesis-console-install.json"
    journal = prefix / ".synthesis-console-install.pending.json"
    lock = prefix / ".synthesis-console-install.lock"
    release = prefix / (".synthesis-console-" + VERSION)
    directory(release)
    body = ("#!/bin/sh\nexec " + shlex.quote(bun) + " " + shlex.quote(str(release / "scripts/console-cli.ts")) + ' "$@"\n').encode()
    for path in (target, receipt, journal, lock):
        regular(path)
    with lock.open("a") as held:
        fcntl.flock(held, fcntl.LOCK_EX)
        for path in (target, receipt, journal):
            regular(path)
        record = {"schema_version": 1, "target": str(target), "release": str(release), "version": VERSION,
                  "sha256": hashlib.sha256(body).hexdigest(), "mode": 0o755,
                  "source": ARCHIVE_URL, "archive_sha256": ARCHIVE_SHA256}
        receipt_before = receipt.read_bytes() if receipt.exists() else None
        journal_before = journal.read_bytes() if journal.exists() else None
        prior = json.loads(receipt_before) if receipt_before is not None else {}
        pending = json.loads(journal_before) if journal_before is not None else None
        if not isinstance(prior, dict) or (pending is not None and pending != record):
            raise ValueError("Unrecognized interrupted installation; evidence preserved.")
        if target.exists():
            owner = pending if pending is not None and sha(target) == pending["sha256"] else prior
            if (owner.get("target") != str(target) or owner.get("sha256") != sha(target)
                    or owner.get("mode") != (target.stat().st_mode & 0o777)):
                raise ValueError("Existing synthesis-console is unknown or edited; preserved.")
        fd, temporary = tempfile.mkstemp(prefix=".synthesis-console-download-", dir=prefix)
        os.close(fd)
        download = Path(temporary)
        try:
            run_child(["curl", "--proto", "=https", "--proto-redir", "=https", "-fsSL", ARCHIVE_URL, "-o", str(download)])
            if sha(download) != ARCHIVE_SHA256:
                raise ValueError("Release SHA-256 mismatch; no executable installed.")
            files = {}
            with tarfile.open(fileobj=io.BytesIO(download.read_bytes()), mode="r:gz") as archive:
                members = archive.getmembers()
                if len(members) > 1000 or sum(m.size for m in members) > 10000000:
                    raise ValueError("Release exceeds archive limits.")
                for member in members:
                    path = PurePosixPath(member.name)
                    if not member.isfile() or path.is_absolute() or ".." in path.parts or not path.parts or path.parts[0] != "synthesis-console-" + VERSION:
                        raise ValueError("Release has an unsafe archive member.")
                    relative = Path(*path.parts[1:])
                    if relative.as_posix() in files or str(relative) == ".":
                        raise ValueError("Release has a duplicate archive member.")
                    files[relative.as_posix()] = (archive.extractfile(member).read(), member.mode & 0o755)
            if "scripts/console-cli.ts" not in files or "synthesis-core/bin/synthesis" not in files:
                raise ValueError("Release is missing executable components.")
            expected = {name: (hashlib.sha256(data).hexdigest(), mode) for name, (data, mode) in files.items()}
            if release.exists():
                actual = {}
                for item in release.rglob("*"):
                    if item.is_symlink() or not (item.is_file() or item.is_dir()):
                        raise ValueError("Existing release contains unsupported files.")
                    if item.is_file(): actual[item.relative_to(release).as_posix()] = (sha(item), item.stat().st_mode & 0o777)
                if actual != expected:
                    raise ValueError("Existing release was edited or is incomplete; preserved for review.")
            else:
                # TemporaryDirectory only removes the exact directory it created.
                with tempfile.TemporaryDirectory(prefix=".synthesis-console-stage-", dir=prefix) as staging:
                    staged = Path(staging) / "release"
                    staged.mkdir()
                    for name, (data, mode) in files.items():
                        dest = staged / name
                        dest.parent.mkdir(parents=True, exist_ok=True)
                        dest.write_bytes(data)
                        dest.chmod(mode)
                    directory(release)
                    if release.exists(): raise ValueError("Release appeared during installation.")
                    staged.rename(release)
            # Recheck immediately before replacing the launcher; refuse foreign edits.
            regular(target)
            if target.exists():
                owner = pending if pending is not None and sha(target) == pending["sha256"] else prior
                if owner.get("sha256") != sha(target) or owner.get("mode") != (target.stat().st_mode & 0o777):
                    raise ValueError("Launcher changed during installation; preserved.")
            for path, before in ((receipt, receipt_before), (journal, journal_before)):
                regular(path)
                if (path.read_bytes() if path.exists() else None) != before:
                    raise ValueError("Installation ownership changed during download; evidence preserved.")
            encoded = (json.dumps(record, sort_keys=True) + "\n").encode()
            atomic(journal, encoded)
            atomic(target, body, 0o755)
            atomic(receipt, encoded)
            journal.unlink()
        finally:
            download.unlink(missing_ok=True)
    command = [str(target), "setup"]
    if args.no_dormant_core: command.append("--no-dormant-core")
    run_child(command)
    print("Installed Synthesis Console %s. No agent hooks or services were activated." % VERSION)
    if str(prefix) not in os.environ.get("PATH", "").split(os.pathsep):
        print("Add %s to PATH to use the synthesis-console command." % prefix)

try:
    main()
except Cancelled as exc:
    # Reproduce native cancellation only after the child is reaped and all
    # installer finally blocks have preserved or cleaned their owned evidence.
    signal.signal(exc.signum, signal.SIG_DFL)
    os.kill(os.getpid(), exc.signum)
    sys.exit(128 + exc.signum)
except ChildFailure as exc:
    print("synthesis-console install: %s" % exc, file=sys.stderr)
    sys.exit(exc.code)
except (OSError, ValueError, tarfile.TarError, subprocess.SubprocessError) as exc:
    print("synthesis-console install: %s" % exc, file=sys.stderr)
    sys.exit(2)
SYNTHESIS_CONSOLE_INSTALLER
