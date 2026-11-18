#!/usr/bin/env python3
"""Release synthesis-console from GitHub's main: preflight, tag, build, publish the GitHub release and the Homebrew
formula, and read each back. npm is a separate step this tool prints and never runs.

    python3 scripts/release.py --output <a new directory> --dry-run   # the checks and the plan; changes nothing
    python3 scripts/release.py --output <a new directory>             # the release

Run it from a clean checkout of the merged main (--repo-root names another checkout). The checkout only says what is
released. Preflight refuses, before anything is published, unless:
  - the checkout is the root of a git checkout and its tree is clean;
  - package.json names an exact version, and CHANGELOG.md, if the repository keeps one, names it as its newest entry;
  - HEAD is the tip of main on GitHub, read with git's own config left out, and CI passed for HEAD there;
  - GitHub has no tag v<version>, no higher version tag and no release for it, a draft included;
  - the output folder does not exist yet.

Then everything comes from a fresh clone of the repository from GitHub at that commit, in a temporary folder:
  1. tag v<version> in the clone and build it with that commit's scripts/build_distribution.py, which builds only an
     exactly tagged clean checkout: the archive, its installer, release.json, the Homebrew formula and the npm package;
  2. create the GitHub release as a draft with the archive, the installer and release.json, then download each file
     back from GitHub and compare it with the build byte for byte;
  3. publish the draft as latest, which puts the tag on GitHub at that commit, and read the tag and the release back;
  4. open the Homebrew tap's pull request that sets Formula/synthesis-console.rb to the built formula, set to merge
     itself when the tap's checks pass, wait for it to merge and read the formula back from the tap's main.
Nothing is public before step 3, and a run that stops before then deletes its own draft, so a run again starts clean.
A GitHub server error runs its stage again, up to three times; each stage reads what GitHub has before it acts.

npm is a separate step: publishing to npm is a public act the owner approves each time, so this tool prints the
command for the built package and never runs it. A release is complete only when this exits 0.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
REPOSITORY = "synthesisengineering/synthesis-console"
REMOTE = f"https://github.com/{REPOSITORY}.git"
TITLE = "Console"  # the release's title, "Console <version>"
VERSION_FILE = "package.json"  # the version the build reads
NPM_PACKAGE = "@synthesiswork/console"
FORMULA = "synthesis-console"  # the formula's name: its file in the build, and the tap branch's prefix
TAP = "synthesisengineering/homebrew-tap"
TAP_FORMULA = f"Formula/{FORMULA}.rb"
TAG_BEFORE_BUILD = True  # build_distribution.py builds only a checkout whose HEAD is exactly tagged v<version>
# What git reads and runs for a release is the repository's own objects and nothing its config adds.
GIT = ("git", "--no-replace-objects", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false")
EXACT = re.compile(r"\d+\.\d+\.\d+")
FAILED = {"FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"}
# GitHub's own server errors, which the same request usually gets past a moment later.
TRANSIENT = re.compile(r"HTTP 5\d\d|Bad Gateway|Service Unavailable|Gateway Time-?out|unexpected end of JSON input|"
                       r"connection reset|i/o timeout|TLS handshake timeout", re.I)
MISSING = re.compile(r"release not found|HTTP 404|Not Found", re.I)


class ReleaseError(Exception):
    """A stage could not finish; its message says what GitHub has and what it does not."""


def run_command(argv, timeout=600, cwd=None, env=None) -> subprocess.CompletedProcess:
    argv = [str(item) for item in argv]
    try:
        return subprocess.run(argv, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout,
                              stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return subprocess.CompletedProcess(argv, 124, "", f"{argv[0]} timed out after {timeout:g} s")
    except OSError as exc:
        return subprocess.CompletedProcess(argv, 127, "", f"cannot run {argv[0]}: {exc}")


def tail(proc, lines: int = 3) -> str:
    text = (proc.stderr or "").strip() or (proc.stdout or "").strip()
    return " | ".join(text.splitlines()[-lines:]) or f"exit {proc.returncode}"


def parse_json(text):
    try:
        return json.loads(text)
    except (TypeError, ValueError):
        return None


def clean_env() -> dict:
    """git's environment for what it reads from GitHub: no global or system config, so nothing rewrites where it
    connects or what it runs."""
    return {**os.environ, "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull, "GIT_TERMINAL_PROMPT": "0"}


def git(run, where, *args, timeout: float = 120, clean: bool = False):
    return run([*GIT, "-C", str(where), *args], timeout, env=clean_env() if clean else None)


def digest(path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def version_tuple(version: str) -> tuple:
    return tuple(int(part) for part in version.split("."))


def retrying(stage, *args, attempts: int = 3, wait: float = 20, sleep=time.sleep):
    """Run a stage again after a GitHub server error. Every stage reads what GitHub already has before it acts, so a
    second run finishes the first one's work."""
    for attempt in range(1, attempts + 1):
        try:
            return stage(*args)
        except ReleaseError as exc:
            if attempt == attempts or not TRANSIENT.search(str(exc)):
                raise
            print(f"GitHub server error, trying again in {wait * attempt:g} s: {exc}", flush=True)
            sleep(wait * attempt)


def package_version(repo: Path) -> tuple:
    """(version, problem) from the package metadata the build reads."""
    try:
        version = json.loads((repo / VERSION_FILE).read_text(encoding="utf-8")).get("version")
    except (OSError, ValueError, AttributeError) as exc:
        return None, f"cannot read {VERSION_FILE}: {exc}"
    if not isinstance(version, str) or not EXACT.fullmatch(version):
        return None, f"{VERSION_FILE} names {version!r}, not an exact version such as 3.0.2"
    return version, ""


def changelog(repo: Path, version: str) -> tuple:
    """(kept, newest version, the version's entry) for CHANGELOG.md; kept is False when the repository keeps none."""
    path = repo / "CHANGELOG.md"
    if not path.is_file():
        return False, "", ""
    text = path.read_text(encoding="utf-8")
    newest = re.search(r"^## \[?(\d+\.\d+\.\d+)\]?", text, re.M)
    entry = re.search(rf"^## \[?{re.escape(version)}\]?[^\n]*\n(.*?)(?=^## |\Z)", text, re.M | re.S)
    return True, newest.group(1) if newest else "", entry.group(1).strip() if entry else ""


def notes_options(repo: Path, version: str, notes_file: str) -> tuple:
    """(gh options, where the notes come from): the CHANGELOG entry where the repository keeps one, else the notes
    file, else the notes GitHub writes from the pull requests merged since the last release."""
    kept, _, entry = changelog(repo, version)
    if kept:
        return ["--notes", entry], "its CHANGELOG.md entry"
    if notes_file:
        return ["--notes-file", str(Path(notes_file).resolve())], str(Path(notes_file).resolve())
    return ["--generate-notes"], "the pull requests merged since the last release, as GitHub writes them"


def github_refs(run) -> dict:
    """{"main": commit, "tags": {version: commit}} as GitHub serves them, read with git's own config left out;
    {} when they cannot be read."""
    listed = run([*GIT, "ls-remote", REMOTE, "refs/heads/main", "refs/tags/v*"], 120, env=clean_env())
    if listed.returncode:
        return {}
    refs = {}
    for line in listed.stdout.splitlines():
        sha, _, name = line.partition("\t")
        if name.strip():
            refs[name.strip()] = sha.strip()
    tags = {}
    for name, sha in refs.items():
        match = re.fullmatch(r"refs/tags/v(\d+\.\d+\.\d+)", name)
        if match:
            tags[match.group(1)] = refs.get(name + "^{}", sha)  # an annotated tag names its commit peeled
    return {"main": refs.get("refs/heads/main", ""), "tags": tags}


def ci_state(run, sha: str, sleep) -> tuple:
    """(passed, detail) for the commit's CI on GitHub. Unknown is not passed."""
    for attempt in range(1, 4):
        proc = run(["gh", "run", "list", "-R", f"github.com/{REPOSITORY}", "--commit", sha, "--json",
                    "status,conclusion,workflowName", "--limit", "50"], 60)
        if proc.returncode == 0 or attempt == 3 or not TRANSIENT.search(tail(proc)):
            break
        sleep(10 * attempt)
    runs = parse_json(proc.stdout) if proc.returncode == 0 else None
    if not isinstance(runs, list):
        return False, f"cannot read CI for {sha[:12]} (is gh installed and signed in?): {tail(proc)}"
    if not runs:
        return False, f"no CI run for {sha[:12]} yet; wait for CI on main"
    pending = [r.get("workflowName", "?") for r in runs if r.get("status") != "completed"]
    failed = [r.get("workflowName", "?") for r in runs if r.get("status") == "completed"
              and r.get("conclusion") not in ("success", "skipped", "neutral")]
    if pending or failed:
        return False, f"CI for {sha[:12]}: running {', '.join(pending) or 'none'}, failed {', '.join(failed) or 'none'}"
    return True, f"CI passed for {sha[:12]} ({len(runs)} run(s))"


def release_info(run, tag: str) -> tuple:
    """(release, problem): GitHub's release for the tag, a draft included, or None when it has none."""
    seen = run(["gh", "release", "view", tag, "-R", REPOSITORY, "--json", "tagName,isDraft,url,assets"], 120)
    if seen.returncode == 0:
        found = parse_json(seen.stdout)
        return (found, "") if isinstance(found, dict) else (None, f"cannot read GitHub's release {tag}: {tail(seen)}")
    if MISSING.search(tail(seen)):
        return None, ""
    return None, f"cannot read GitHub's release {tag} (is gh installed and signed in?): {tail(seen)}"


def known_release(run, tag: str):
    found, problem = release_info(run, tag)
    if problem:
        raise ReleaseError(problem)
    return found


def preflight(repo: Path, output: Path, notes_file: str, run, sleep) -> tuple:
    """(version, commit, problems) for a release of the checkout `repo`. The commit is the one preflight read, and the
    one the release clones; nothing is published unless problems is empty."""
    top = git(run, repo, "rev-parse", "--show-toplevel")
    if top.returncode or Path(top.stdout.strip() or "/").resolve() != repo.resolve():
        return None, "", [f"{repo} is not the root of a git checkout"]
    problems = []
    status = git(run, repo, "status", "--porcelain")
    if status.returncode:
        problems.append(f"cannot read the tree's state: {tail(status)}")
    elif status.stdout.strip():
        paths = [line.strip() for line in status.stdout.strip().splitlines()]
        problems.append(f"the tree has uncommitted changes: {', '.join(paths[:3])}{', ...' * (len(paths) > 3)}")
    version, problem = package_version(repo)
    if version is None:
        return None, "", problems + [problem]
    tag = f"v{version}"
    kept, newest, entry = changelog(repo, version)
    if kept and newest != version:
        problems.append(f"CHANGELOG.md's newest entry is {newest or 'missing'}, {VERSION_FILE} says {version}")
    elif kept and not entry:
        problems.append(f"CHANGELOG.md's entry for {version} is empty")
    if notes_file and kept:
        problems.append("--notes-file is for a repository without CHANGELOG.md; this one keeps one, and its entry is "
                        "the release notes")
    elif notes_file and not (Path(notes_file).is_file() and Path(notes_file).read_text(encoding="utf-8").strip()):
        problems.append(f"the notes file {notes_file} is missing or empty")
    if output.exists() or output.is_symlink():
        problems.append(f"{output} exists; the output must be a new directory")
    head = git(run, repo, "rev-parse", "HEAD").stdout.strip()
    served = github_refs(run)
    if not served:
        problems.append(f"cannot read {REPOSITORY} on GitHub")
    else:
        if served["main"] != head:
            problems.append(f"HEAD {head[:12] or 'unread'} is not the tip of {REPOSITORY} main "
                            f"({served['main'][:12] or 'unread'}): release only what is merged there; pull, or merge "
                            "its pull request first")
        if version in served["tags"]:
            problems.append(f"{REPOSITORY} already has {tag} (at {served['tags'][version][:12]}); bump the version")
        higher = sorted((v for v in served["tags"] if version_tuple(v) > version_tuple(version)), key=version_tuple)
        if higher:
            problems.append(f"{REPOSITORY} already has v{higher[-1]}, higher than {version}; bump the version above it")
    existing, problem = release_info(run, tag)
    if problem:
        problems.append(problem)
    elif existing is not None and existing.get("isDraft"):
        problems.append(f"{REPOSITORY} already has a draft release for {tag} ({existing.get('url', '')}); a draft this "
                        "tool did not make is the owner's to keep or delete")
    elif existing is not None and version not in served.get("tags", {}):
        problems.append(f"{REPOSITORY} already has a release for {tag} ({existing.get('url', '')}); bump the version")
    if head:
        passed, detail = ci_state(run, head, sleep)
        if not passed:
            problems.append(detail)
    else:
        problems.append("cannot read HEAD")
    return version, head, problems


def fresh_clone(run, sha: str, folder: Path) -> Path:
    """A clone of the repository from GitHub, made by this run with git's own config left out and checked out at
    `sha`: what is built and published is what GitHub serves, whatever the checkout holds."""
    where = folder / "clone"
    made = run([*GIT, "clone", "--quiet", "--no-local", "--no-checkout", REMOTE, str(where)], 900, env=clean_env())
    moved = git(run, where, "checkout", "--quiet", "--detach", sha, timeout=300, clean=True) if made.returncode == 0 else made
    if made.returncode or moved.returncode or git(run, where, "rev-parse", "HEAD", clean=True).stdout.strip() != sha:
        raise ReleaseError(f"cannot make a fresh clone of {REPOSITORY} at {sha[:12]}: {tail(moved)}")
    return where


def serves(text: str, url: str, sha256: str) -> bool:
    return f'url "{url}"' in text and f'sha256 "{sha256}"' in text


def built_release(output: Path, version: str) -> dict:
    """The built files, once each agrees with the others: release.json names the archive, its checksum and the
    installer's, the npm package is this version and the formula names the archive and its checksum."""
    archive = output / f"{FORMULA}-{version}.tar.gz"
    installer, record_file, formula_file, package_file = (output / "install.sh", output / "release.json",
                                                          output / f"{FORMULA}.rb", output / "npm" / "package.json")
    missing = [p.relative_to(output).as_posix() for p in (archive, installer, record_file, formula_file, package_file)
               if not p.is_file()]
    if missing:
        raise ReleaseError(f"the build wrote no {', '.join(missing)}, so nothing was published")
    url = f"https://github.com/{REPOSITORY}/releases/download/v{version}/{archive.name}"
    checksum = digest(archive)
    record = parse_json(record_file.read_text(encoding="utf-8")) or {}
    package = parse_json(package_file.read_text(encoding="utf-8")) or {}
    formula = formula_file.read_text(encoding="utf-8")
    wrong = ([f"release.json names version {record.get('version')!r}"] * (record.get("version") != version)
             + ["release.json does not name the built archive and its checksum"]
             * (record.get("archive") != {"file": archive.name, "url": url, "sha256": checksum})
             + ["release.json's installer checksum is not the built installer's"]
             * (record.get("installer_sha256") != digest(installer))
             + [f"the npm package is {package.get('name')}@{package.get('version')}, not {NPM_PACKAGE}@{version}"]
             * ((package.get("name"), package.get("version")) != (NPM_PACKAGE, version))
             + ["the formula does not name the built archive and its checksum"] * (not serves(formula, url, checksum)))
    if wrong:
        raise ReleaseError("the built files disagree, so nothing was published: " + "; ".join(wrong))
    return {"assets": [archive, installer, record_file], "formula": formula, "url": url, "digest": checksum,
            "npm": output / "npm"}


def build(run, clone: Path, version: str, output: Path) -> dict:
    """Build the clone with its own build script into `output`. Nothing is published yet, so a build that fails
    publishes nothing."""
    if TAG_BEFORE_BUILD:
        tagged = git(run, clone, "tag", f"v{version}", clean=True)
        if tagged.returncode:
            raise ReleaseError(f"cannot tag v{version} in the clone: {tail(tagged)}")
    built = run([sys.executable, str(clone / "scripts" / "build_distribution.py"), "--repo-root", str(clone),
                 "--output", str(output)], 1800, cwd=str(clone))
    if built.returncode:
        raise ReleaseError(f"the build failed, so nothing was published: {tail(built)}")
    return built_release(output, version)


def draft_release(run, version: str, sha: str, assets: list, notes: list) -> list:
    """The GitHub release as a draft, with the built files: not public, and no tag on GitHub yet."""
    tag = f"v{version}"
    found = known_release(run, tag)
    if found is None:
        made = run(["gh", "release", "create", tag, "-R", REPOSITORY, "--draft", "--target", sha, "--title",
                    f"{TITLE} {version}", *notes, *map(str, assets)], 900)
        if made.returncode:
            raise ReleaseError(f"cannot create the draft release {tag}: {tail(made)}")
    elif found.get("isDraft"):  # this run's own: preflight found none, and GitHub made it before answering an error
        sent = run(["gh", "release", "upload", tag, "-R", REPOSITORY, "--clobber", *map(str, assets)], 900)
        if sent.returncode:
            raise ReleaseError(f"cannot upload the files to the draft release {tag}: {tail(sent)}")
    else:
        raise ReleaseError(f"{REPOSITORY} published {tag} while this release ran; this run changed nothing of it")
    return [f"draft release {tag}: {', '.join(p.name for p in assets)}"]


def read_back(run, version: str, assets: list) -> list:
    """Download every file of the draft from GitHub and compare it with the build byte for byte."""
    tag = f"v{version}"
    with tempfile.TemporaryDirectory(prefix=f"{FORMULA}-read-back-") as folder:
        got = run(["gh", "release", "download", tag, "-R", REPOSITORY, "--dir", folder], 900)
        if got.returncode:
            raise ReleaseError(f"cannot download {tag}'s files back from GitHub: {tail(got)}")
        served = {p.name: digest(p) for p in Path(folder).iterdir() if p.is_file()}
    built = {p.name: digest(p) for p in assets}
    if served != built:
        differ = sorted(name for name in set(served) | set(built) if served.get(name) != built.get(name))
        raise ReleaseError(f"GitHub's draft {tag} does not hold the built files byte for byte ({', '.join(differ)})")
    return [f"draft release {tag}: GitHub serves {', '.join(sorted(built))} byte for byte as built"]


def publish(run, version: str) -> list:
    """Publish the draft as latest; GitHub then creates the tag at the draft's target commit."""
    tag = f"v{version}"
    found = known_release(run, tag)
    if found is None:
        raise ReleaseError(f"GitHub has no draft release {tag} to publish")
    if found.get("isDraft"):
        made = run(["gh", "release", "edit", tag, "-R", REPOSITORY, "--draft=false", "--latest"], 300)
        if made.returncode:
            raise ReleaseError(f"cannot publish the draft release {tag}: {tail(made)}")
    return []


def published(run, version: str, sha: str, assets: list, sleep) -> list:
    """Read the published release back: the tag on GitHub names the commit, the release is no draft, holds the built
    files and is the latest."""
    tag = f"v{version}"
    served = {}
    for attempt in range(1, 4):
        served = github_refs(run)
        if served.get("tags", {}).get(version) == sha:
            break
        sleep(5 * attempt)
    else:
        raise ReleaseError(f"GitHub does not serve {tag} at {sha[:12]} after publishing "
                           f"({(served.get('tags', {}).get(version) or 'no tag')[:12]})")
    found = known_release(run, tag) or {}
    held = {a.get("name"): a.get("digest") for a in found.get("assets") or []}
    built = {p.name: "sha256:" + digest(p) for p in assets}
    if found.get("isDraft") is not False or set(held) != set(built) or any(
            held[name] and held[name] != built[name] for name in built):
        raise ReleaseError(f"GitHub's published {tag} is not the verified draft: draft={found.get('isDraft')}, "
                           f"files {', '.join(sorted(held)) or 'none'}")
    listed = run(["gh", "release", "list", "-R", REPOSITORY, "--json", "tagName,isLatest", "--limit", "20"], 120)
    latest = [r.get("tagName") for r in parse_json(listed.stdout) or [] if r.get("isLatest")]
    if latest != [tag]:
        raise ReleaseError(f"GitHub shows {', '.join(latest) or 'no release'} as latest, not {tag}: {tail(listed)}")
    return [f"GitHub release {tag}: published as latest, the tag at {sha[:12]}"]


def discard_draft(run, version: str) -> str:
    """After a stop before publishing, delete this run's draft: GitHub then holds nothing of this release."""
    tag = f"v{version}"
    try:
        found = known_release(run, tag)
    except ReleaseError as exc:
        return f"could not read the draft release {tag} to delete it: {exc}"
    if found is None:
        return f"GitHub holds no release {tag}"
    if not found.get("isDraft"):
        return f"{tag} is published, so it stays as it is"
    gone = run(["gh", "release", "delete", tag, "-R", REPOSITORY, "--yes"], 120)
    if gone.returncode:
        return f"could not delete the draft release {tag} ({tail(gone)}); a run again refuses until it is gone"
    return f"deleted the draft release {tag}, so GitHub holds nothing of this release"


def tap_formula(run, ref: str = "main") -> dict:
    """The formula file on the tap: its text and blob id."""
    read = run(["gh", "api", f"repos/{TAP}/contents/{TAP_FORMULA}?ref={ref}"], 120)
    found = parse_json(read.stdout) or {}
    if read.returncode or "content" not in found:
        raise ReleaseError(f"cannot read {TAP} {TAP_FORMULA}: {tail(read)}")
    return {"text": base64.b64decode(found["content"]).decode("utf-8"), "sha": found["sha"]}


def homebrew_formula(run, version: str, built: dict) -> tuple:
    """Open the tap pull request that sets the formula to the one built for this release, to merge itself when the
    tap's checks pass: ([lines], the pull request to wait for, or None)."""
    url, checksum, branch = built["url"], built["digest"], f"{FORMULA}-{version}"
    current = tap_formula(run)
    if serves(current["text"], url, checksum):
        return [f"{TAP}: Homebrew already serves {FORMULA} {version}"], None
    listed = parse_json(run(["gh", "pr", "list", "-R", TAP, "--head", branch, "--state", "open", "--json", "url"],
                            120).stdout) or []
    pr = listed[0].get("url", "") if listed else ""
    if not pr:  # the branch starts at the tap's main, whatever an earlier attempt left on it
        main = (parse_json(run(["gh", "api", f"repos/{TAP}/git/ref/heads/main"], 120).stdout) or {}).get("object", {})
        made = run(["gh", "api", "-X", "POST", f"repos/{TAP}/git/refs", "-f", f"ref=refs/heads/{branch}",
                    "-f", f"sha={main.get('sha', '')}"], 120)
        if made.returncode:
            made = run(["gh", "api", "-X", "PATCH", f"repos/{TAP}/git/refs/heads/{branch}", "-f",
                        f"sha={main.get('sha', '')}", "-F", "force=true"], 120)
        wrote = run(["gh", "api", "-X", "PUT", f"repos/{TAP}/contents/{TAP_FORMULA}", "-f",
                     f"message={FORMULA} {version}", "-f", f"branch={branch}", "-f", f"sha={current['sha']}",
                     "-f", "content=" + base64.b64encode(built["formula"].encode("utf-8")).decode("ascii")], 120)
        failed = [tail(step) for step in (made, wrote) if step.returncode]
        if failed:
            raise ReleaseError(f"cannot prepare {TAP} {branch}: {failed[0]}")
        opened = run(["gh", "pr", "create", "-R", TAP, "--head", branch, "--base", "main", "--title",
                      f"{FORMULA} {version}", "--body", f"Sets the {FORMULA} formula to the one built for "
                      f"[v{version}](https://github.com/{REPOSITORY}/releases/tag/v{version}). Opened by "
                      f"{REPOSITORY}'s scripts/release.py; it merges when the tap's checks pass."], 120)
        pr = opened.stdout.strip().splitlines()[-1] if opened.returncode == 0 and opened.stdout.strip() else ""
        if not pr:
            raise ReleaseError(f"cannot open the {TAP} pull request: {tail(opened)}")
    armed = run(["gh", "pr", "merge", pr, "-R", TAP, "--auto", "--merge"], 120)
    if armed.returncode:
        raise ReleaseError(f"cannot set {pr} to merge when its checks pass: {tail(armed)}")
    return ([f"{TAP}: {pr} sets the formula to v{version} and merges when its checks pass"],
            {"pr": pr, "url": url, "digest": checksum, "branch": branch, "version": version})


def no_runner(workflow_run: dict) -> bool:
    """Every job of a run that did not pass was cancelled before a step ran: GitHub gave it no runner."""
    missed = [job for job in workflow_run.get("jobs") or [] if job.get("name") != "ci"
              and job.get("conclusion") != "success"]
    return bool(missed) and all(job.get("conclusion") == "cancelled" and not job.get("steps") for job in missed)


def homebrew_merged(formula: dict, run, sleep, interval: float = 20, timeout: float = 1800) -> list:
    """Wait for the tap pull request to merge, then read the formula Homebrew serves from the tap's main. A check
    whose job GitHub never gave a runner is run again, up to three times."""
    reruns = 0
    for _ in range(max(1, int(timeout / interval))):
        view = parse_json(run(["gh", "pr", "view", formula["pr"], "-R", TAP, "--json", "state,statusCheckRollup"],
                              120).stdout) or {}
        failing = [check for check in view.get("statusCheckRollup") or []
                   if str(check.get("conclusion") or check.get("state") or "").upper() in FAILED]
        failed = sorted(check.get("name") or check.get("context") or "?" for check in failing)
        if view.get("state") == "MERGED":
            break
        links = [re.search(r"/runs/(\d+)", check.get("detailsUrl") or "") for check in failing]
        ids = sorted({link.group(1) for link in links if link}) if view.get("state") != "CLOSED" else []
        runs = [parse_json(run(["gh", "run", "view", i, "-R", TAP, "--json", "status,jobs"], 120).stdout) or {}
                for i in ids]
        if any(r.get("status") not in (None, "completed") for r in runs):
            failed = []  # running again: the pull request still shows the checks from before the rerun
        elif runs and reruns < 3 and all(map(no_runner, runs)) and all(
                run(["gh", "run", "rerun", i, "-R", TAP, "--failed"], 120).returncode == 0 for i in ids):
            reruns, failed = reruns + 1, []
            print(f"{formula['pr']}: GitHub gave a job no runner; rerun {reruns} of 3", flush=True)
        if view.get("state") == "CLOSED" or failed:
            raise ReleaseError(f"{formula['pr']} did not merge ({', '.join(failed) or 'closed'}); Homebrew still "
                               "serves the previous release")
        sleep(interval)
    else:
        raise ReleaseError(f"{formula['pr']} had not merged after {int(timeout / 60)} minutes; it merges itself when "
                           "the tap's checks pass")
    if not serves(tap_formula(run)["text"], formula["url"], formula["digest"]):
        raise ReleaseError(f"{formula['pr']} merged, but {TAP} main does not serve v{formula['version']}")
    gone = run(["gh", "api", "-X", "DELETE", f"repos/{TAP}/git/refs/heads/{formula['branch']}"], 120)
    said = tail(gone) if gone.returncode else ""
    left = f"; branch {formula['branch']} left: {said}" if said and "Reference does not exist" not in said else ""
    return [f"{TAP}: Homebrew serves {FORMULA} {formula['version']} ({formula['pr']} merged{left})"]


def npm_step(output: Path, version: str) -> list:
    return ["npm is a separate step, which this tool never runs: publishing to npm is a public act the owner "
            "approves each time. With that approval:",
            f"  npm publish --access public {output / 'npm'}",
            f"  npm view {NPM_PACKAGE}@{version} version   # reads it back from the registry"]


def plan(repo: Path, version: str, sha: str, output: Path, notes_file: str) -> list:
    tag, (_, source) = f"v{version}", notes_options(repo, version, notes_file)
    files = f"{FORMULA}-{version}.tar.gz, install.sh and release.json"
    return [f"preflight: {tag} at {sha[:12]} is ready: the tip of GitHub's main, CI passed, no {tag} on GitHub yet",
            "plan (a dry run: nothing was changed):",
            f"  1. clone {REPOSITORY} from GitHub at {sha[:12]} into a temporary folder"
            + (f", tag it {tag} there" if TAG_BEFORE_BUILD else "")
            + f", and build it with that commit's scripts/build_distribution.py into {output}",
            f"  2. create the draft GitHub release {tag}, \"{TITLE} {version}\", with {files}, its notes from "
            f"{source}, and download each file back to compare it with the build byte for byte",
            f"  3. publish it as latest, which puts {tag} on GitHub at {sha[:12]}, and read the tag and release back",
            f"  4. open the {TAP} pull request that sets {TAP_FORMULA} to the built formula, set to merge when the "
            "tap's checks pass, and read the formula back from the tap's main once it merged",
            *npm_step(output, version)]


def main(argv=None, run=run_command, sleep=time.sleep) -> int:
    parser = argparse.ArgumentParser(prog="release.py", description=__doc__.split("\n\n")[0], allow_abbrev=False)
    parser.add_argument("--repo-root", type=Path, default=ROOT, help="the checkout to release (default: this one)")
    parser.add_argument("--output", type=Path, required=True,
                        help="a new directory for the built files; the npm step publishes from it")
    parser.add_argument("--notes-file", default="", help="the release notes, for a repository that keeps no "
                        "CHANGELOG.md (default: GitHub writes them from the merged pull requests)")
    parser.add_argument("--dry-run", action="store_true", help="check and print the plan; change nothing")
    args = parser.parse_args(argv)
    repo, output = args.repo_root.resolve(), args.output.expanduser().absolute()
    version, sha, problems = preflight(repo, output, args.notes_file, run, sleep)
    if problems:
        print("refused before publishing anything:\n  " + "\n  ".join(problems))
        return 1
    if args.dry_run:
        print("\n".join(plan(repo, version, sha, output, args.notes_file)))
        return 0
    lines, drafted, public = [f"preflight: v{version} at {sha[:12]} is ready"], False, False
    folder = Path(tempfile.mkdtemp(prefix=f"{FORMULA}-release-"))
    try:
        clone = fresh_clone(run, sha, folder)
        if package_version(clone)[0] != version:
            raise ReleaseError(f"GitHub's {sha[:12]} does not hold {version}")
        built = build(run, clone, version, output)
        lines.append(f"built from {sha[:12]} into {output}")
        notes, _ = notes_options(clone, version, args.notes_file)
        drafted = True
        lines += retrying(draft_release, run, version, sha, built["assets"], notes, sleep=sleep)
        lines += retrying(read_back, run, version, built["assets"], sleep=sleep)
        retrying(publish, run, version, sleep=sleep)
        public = True
        lines += retrying(published, run, version, sha, built["assets"], sleep, sleep=sleep)
        opened, formula = retrying(homebrew_formula, run, version, built, sleep=sleep)
        lines += opened
        if formula:
            lines += retrying(homebrew_merged, formula, run, sleep, sleep=sleep)
    except ReleaseError as exc:
        print("\n".join(lines + [f"stopped: {exc}"] + ([discard_draft(run, version)] if drafted and not public else [])))
        return 1
    except BaseException:  # an error this tool did not foresee, or an interrupt: its draft goes too, then it is raised
        if drafted and not public:
            print(discard_draft(run, version), flush=True)
        raise
    finally:
        shutil.rmtree(folder, ignore_errors=True)
    print("\n".join(lines + npm_step(output, version) + [f"release complete: v{version}"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
