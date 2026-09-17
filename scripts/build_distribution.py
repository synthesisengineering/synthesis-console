#!/usr/bin/env python3
"""Build inert Console packages and checksum-bound release installers; never publish."""
import argparse
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import subprocess
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "https://github.com/synthesisengineering/synthesis-console"

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()

def dependency_licenses(source, package, metadata):
    """Retain notices for the actual bundled runtime dependency closure."""
    pending = list(metadata["dependencies"])
    seen = set()
    notices = []
    while pending:
        name = pending.pop()
        if name in seen:
            continue
        seen.add(name)
        root = source / "node_modules" / name
        dependency = json.loads((root / "package.json").read_text())
        pending.extend(dependency.get("dependencies", {}))
        destination = package / "third-party-licenses" / name.replace("/", "_")
        destination.mkdir(parents=True)
        files = [p for p in root.iterdir() if p.is_file() and p.name.lower().startswith(("license", "copying", "notice"))]
        if not files:
            raise ValueError("runtime dependency has no license notice: " + name)
        for path in files:
            shutil.copyfile(path, destination / path.name)
        notices.append("- %s %s (%s)" % (name, dependency["version"], dependency.get("license", "see notice")))
    (package / "THIRD-PARTY-NOTICES.md").write_text("# Bundled runtime dependencies\n\n" + "\n".join(sorted(notices)) + "\n\nPico CSS 2.1.1 notices are in public/vendor.\nPyYAML 6.0.3 (MIT) source and license are in packages/python.\n")

def _build(source, output, core, provenance, environment):
    output, core = Path(output), Path(core)
    if output.exists() or output.is_symlink():
        raise ValueError("output must be a new directory")
    metadata = json.loads((source / "package.json").read_text())
    version = metadata["version"]
    if not re.fullmatch(r"\d+\.\d+\.\d+", version):
        raise ValueError("version must be an exact release")
    core_meta = json.loads((core / "lib/release.json").read_text())
    if not re.fullmatch(r"[0-9a-f]{40}", core_meta.get("commit", "")) or not re.fullmatch(r"\d+\.\d+\.\d+", core_meta.get("version", "")):
        raise ValueError("core package must identify an exact released source commit")
    if digest(core / "lib/onboard.sh") != core_meta.get("bootstrap_sha256"):
        raise ValueError("core bootstrap checksum mismatch")
    if not (core / "bin/synthesis").is_file():
        raise ValueError("core launcher is missing")
    for p in core.rglob("*"):
        if p.is_symlink() or not (p.is_file() or p.is_dir()):
            raise ValueError("unsupported core filesystem object")
    package = output / "npm"
    package.mkdir(parents=True)
    for directory in ("bin", "public", "demo"):
        shutil.copytree(source / directory, package / directory)
    (package / "scripts").mkdir()
    for filename in ("console-cli.ts", "launch.sh", "python-runtime.sh", "python-runtime.py", "service-ownership.ts", "install-autostart-macos.sh", "install-autostart-linux.sh", "uninstall-autostart-macos.sh", "uninstall-autostart-linux.sh"):
        shutil.copy2(source / "scripts" / filename, package / "scripts" / filename)
    for name in ("LICENSE", "README.md", "console.yaml.example"):
        shutil.copy2(source / name, package / name)
    import importlib.util
    specification = importlib.util.spec_from_file_location('console_python_payload', source / 'scripts/python-runtime.py')
    helper = importlib.util.module_from_spec(specification); specification.loader.exec_module(helper)
    payload_root, python_dependency = helper.payload()
    shutil.copytree(payload_root, package / 'packages/python')
    dependency_licenses(source, package, metadata)
    shutil.copytree(core, package / "synthesis-core")
    inventory = {p.relative_to(core).as_posix(): {"sha256": digest(p), "mode": 0o755 if p.stat().st_mode & 0o111 else 0o644} for p in sorted(core.rglob("*")) if p.is_file()}
    (package / "core-files.json").write_text(json.dumps(inventory, sort_keys=True, indent=2) + "\n")
    published = {k: metadata[k] for k in ("version", "description", "license", "repository", "homepage", "author", "keywords")}
    published.update(name="@synthesiswork/console", type="module", bin={"synthesis-console":"bin/synthesis-console"},
                     files=["bin", "scripts", "packages/python", "app", "public", "demo", "synthesis-core", "core-files.json", "console.yaml.example", "README.md", "LICENSE", "THIRD-PARTY-NOTICES.md", "third-party-licenses"],
                     os=["darwin", "linux"], engines={"bun": ">=1.3.13"}, publishConfig={"access":"public"})
    (package / "package.json").write_text(json.dumps(published, indent=2) + "\n")
    subprocess.run(["bun", "build", "src/index.ts", "--target=bun", "--outfile", str(package / "app/index.js")], cwd=source, env=environment, check=True)
    archive = output / ("synthesis-console-" + version + ".tar.gz")
    with archive.open("xb") as stream, gzip.GzipFile(filename="",mode="wb",fileobj=stream,mtime=0) as gz:
        with tarfile.open(fileobj=gz,mode="w") as tar:
            for p in sorted(package.rglob("*")):
                if p.is_symlink(): raise ValueError("package contains symlink")
                if not p.is_file(): continue
                data=p.read_bytes(); item=tarfile.TarInfo("synthesis-console-"+version+"/"+p.relative_to(package).as_posix())
                item.size=len(data); item.mode=0o755 if p.stat().st_mode & 0o111 else 0o644; item.mtime=0
                tar.addfile(item,io.BytesIO(data))
    checksum=digest(archive); url=REPOSITORY+"/releases/download/v"+version+"/"+archive.name
    installer=(source/"packages/install.sh").read_text().replace("@VERSION@",version).replace("@ARCHIVE_SHA256@",checksum)
    (output/"install.sh").write_text(installer); (output/"install.sh").chmod(0o755)
    formula='''class SynthesisConsole < Formula
  desc "Local project console for the Synthesis ecosystem"
  homepage "https://synthesiswork.org/download/"
  url "%s"
  sha256 "%s"
  license "Apache-2.0"
  depends_on "oven-sh/bun/bun"
  depends_on "git"
  depends_on "python@3.12"
  def install
    libexec.install Dir["*"]
    (bin/"synthesis-console").write_env_script libexec/"bin/synthesis-console",
      PATH: "#{Formula["oven-sh/bun/bun"].opt_bin}:$PATH",
      SYNTHESIS_BOOTSTRAP_PYTHON: Formula["python@3.12"].opt_bin/"python3.12"
  end
  test do
    assert_match "%s", shell_output("#{bin}/synthesis-console --version")
    assert_match "autostart", shell_output("#{bin}/synthesis-console --help")
  end
end
''' % (url,checksum,version)
    (output/"synthesis-console.rb").write_text(formula)
    record={"schema_version":1,"version":version,"npm_package":"@synthesiswork/console","core_release":core_meta,
            "archive":{"file":archive.name,"url":url,"sha256":checksum},"installer_sha256":digest(output/"install.sh"),
            "python_dependency": {"name": python_dependency["name"], "version": python_dependency["version"],
                "source_url": python_dependency["source_url"], "source_sha256": python_dependency["source_sha256"],
                "manifest_sha256": helper.PAYLOAD_SHA256, "acquisition": "bundled-pure-python-offline-owned-venv"},
            "bun_version":subprocess.check_output(["bun","--version"],env=environment,text=True).strip(),
            "source": provenance, "dependencies": {"lockfile": "bun.lock", "lockfile_sha256": digest(source / "bun.lock"),
                "acquisition": "fresh-frozen-lockfile-production-ignore-scripts", "registry": "https://registry.npmjs.org"}}
    (output/"release.json").write_text(json.dumps(record,indent=2)+"\n")
    return record

def _git(source, *arguments, binary=False, input_data=None):
    environment = {key: value for key, value in os.environ.items() if not key.startswith("GIT_")}
    environment.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1", GIT_NO_REPLACE_OBJECTS="1", GIT_NO_LAZY_FETCH="1", GIT_OPTIONAL_LOCKS="0")
    return subprocess.check_output(["git", "-c", "core.fsmonitor=false", "-C", str(source), *arguments],
        env=environment, input=input_data, stderr=subprocess.PIPE, text=not binary)


def _inventory(source):
    return {path.relative_to(source).as_posix(): {"sha256": digest(path), "mode": path.stat().st_mode & 0o777}
            for path in sorted(source.rglob("*")) if path.is_file()}


def _snapshot_release(source, destination):
    """Only immutable, tracked Git blobs have release-source authority."""
    try:
        if Path(_git(source, "rev-parse", "--show-toplevel").strip()).resolve() != source:
            raise ValueError("release source must be its checkout root")
        if _git(source, "status", "--porcelain", "--untracked-files=all").strip():
            raise ValueError("Console packaging requires a committed clean release checkout")
        commit = _git(source, "rev-parse", "HEAD^{commit}").strip()
        metadata = json.loads(_git(source, "show", commit + ":package.json"))
        version = metadata["version"]
        if not re.fullmatch(r"\d+\.\d+\.\d+", version):
            raise ValueError("Console requires an exact release version")
        tag = "v" + version
        try:
            tagged = _git(source, "rev-parse", tag + "^{commit}").strip()
        except subprocess.CalledProcessError as error:
            raise ValueError("Console source must equal its exact release tag") from error
        if commit != tagged:
            raise ValueError("Console source must equal its exact release tag")
        entries = _git(source, "ls-tree", "-rz", "--full-tree", commit, binary=True).split(b"\0")
        objects = []
        for entry in entries:
            if not entry:
                continue
            header, raw_name = entry.split(b"\t", 1)
            mode, kind, oid = header.decode("ascii").split()
            name = raw_name.decode("utf-8")
            relative = PurePosixPath(name)
            if mode not in {"100644", "100755"} or kind != "blob" or relative.is_absolute() or ".." in relative.parts:
                raise ValueError("release source contains an unsupported tracked object: " + name)
            if any(part in {"node_modules", ".git"} for part in relative.parts):
                raise ValueError("release source cannot track dependency installations: " + name)
            objects.append((name, mode, oid))
        raw = _git(source, "cat-file", "--batch", binary=True,
            input_data=("\n".join(oid for _, _, oid in objects) + "\n").encode())
        stream = io.BytesIO(raw)
        for name, mode, oid in objects:
            header = stream.readline().decode().split()
            if len(header) != 3 or header[:2] != [oid, "blob"]:
                raise ValueError("Git release blob identity changed")
            size = int(header[2]); data = stream.read(size)
            if len(data) != size or stream.read(1) != b"\n":
                raise ValueError("Git release blob was truncated")
            target = destination / name
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(data); target.chmod(0o755 if mode == "100755" else 0o644)
        if stream.read():
            raise ValueError("unexpected Git release blob output")
        return {"kind": "release", "commit": commit, "tag": tag,
                "tree": _git(source, "rev-parse", commit + "^{tree}").strip()}
    except subprocess.CalledProcessError as error:
        raise ValueError("Console packaging requires a committed clean Git release checkout") from error


def _snapshot_fixture(source, destination):
    """Test-only nongit bytes never acquire release commit/tag authority."""
    try:
        _git(source, "rev-parse", "--show-toplevel")
    except subprocess.CalledProcessError:
        pass
    else:
        raise ValueError("build_fixture requires an explicit nongit source directory")
    excluded = {"node_modules", "dist", "__pycache__", ".pytest_cache", ".git"}
    for path in sorted(source.rglob("*")):
        relative = path.relative_to(source)
        if any(part in excluded for part in relative.parts):
            continue
        if path.is_symlink() or not (path.is_file() or path.is_dir()):
            raise ValueError("fixture source contains an unsupported object")
        target = destination / relative
        if path.is_dir():
            target.mkdir(parents=True, exist_ok=True)
        else:
            target.parent.mkdir(parents=True, exist_ok=True); shutil.copy2(path, target)
    return {"kind": "fixture", "release_authority": False}


def _execute_build(source, output, core, fixture):
    source, output, core = Path(source).resolve(), Path(output).absolute(), Path(core).resolve()
    if output.exists() or output.is_symlink() or output == source or source in output.parents or output in source.parents:
        raise ValueError("output must be a new directory outside source")
    for ancestor in output.parents:
        if ancestor.is_symlink() and ancestor not in {Path("/tmp"), Path("/var")}:
            raise ValueError("output crosses a symbolic link")
    with tempfile.TemporaryDirectory(prefix="console-release-build-") as temporary:
        root = Path(temporary); snapshot = root / "source"; snapshot.mkdir()
        provenance = (_snapshot_fixture if fixture else _snapshot_release)(source, snapshot)
        inventory = _inventory(snapshot)
        provenance["source_files_sha256"] = hashlib.sha256(json.dumps(inventory, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        home = root / "home"; home.mkdir()
        config = root / "bunfig.toml"; config.write_text("")
        environment = {key: os.environ[key] for key in ("PATH", "TMPDIR", "LANG", "LC_ALL", "TERM") if key in os.environ}
        environment.update(HOME=str(home), XDG_CONFIG_HOME=str(home / ".config"), XDG_CACHE_HOME=str(home / ".cache"),
                           BUN_INSTALL_CACHE_DIR=str(root / "dependency-cache"))
        lock = snapshot / "bun.lock"
        if not lock.is_file():
            raise ValueError("Console packaging requires its tracked bun.lock")
        before = digest(lock)
        subprocess.run(["bun", "install", "--frozen-lockfile", "--production", "--ignore-scripts", "--backend=copyfile",
                        "--cache-dir=" + str(root / "dependency-cache"), "--config=" + str(config),
                        "--registry=https://registry.npmjs.org"], cwd=snapshot, env=environment, check=True)
        if digest(lock) != before or any(not (snapshot / name).is_file() or digest(snapshot / name) != evidence["sha256"]
                                       or (snapshot / name).stat().st_mode & 0o777 != evidence["mode"] for name, evidence in inventory.items()):
            raise ValueError("locked dependency install changed tracked source")
        result = _build(snapshot, output, core, provenance, environment)
        if digest(lock) != before:
            raise ValueError("build changed tracked dependency lock")
        return result


def build(output, core, *, source=None):
    """Release API: clean exact-tag source, isolated frozen dependencies."""
    return _execute_build(ROOT if source is None else source, output, core, fixture=False)


def build_fixture(output, core, *, source):
    """Explicit test API; nongit input and no release provenance claims."""
    return _execute_build(source, output, core, fixture=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo-root", default=ROOT, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--core-package", required=True, type=Path)
    args = parser.parse_args()
    print(json.dumps(build(args.output, args.core_package, source=args.repo_root), indent=2))
if __name__ == "__main__":
    main()
