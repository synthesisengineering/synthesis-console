"""Release provenance and isolated dependency acquisition using physical fixtures."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile

import pytest

ROOT = Path(__file__).resolve().parents[1]


def module():
    spec = importlib.util.spec_from_file_location('console_provenance_builder', ROOT / 'scripts/build_distribution.py')
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


def git(source, *args):
    env = {key: value for key, value in os.environ.items() if not key.startswith('GIT_')}
    env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM='1', GIT_AUTHOR_NAME='Fixture', GIT_AUTHOR_EMAIL='fixture@example.invalid', GIT_COMMITTER_NAME='Fixture', GIT_COMMITTER_EMAIL='fixture@example.invalid')
    return subprocess.check_output(['git', *args], cwd=source, env=env, text=True).strip()


def candidate(source):
    source.mkdir()
    for relative in set(git(ROOT, 'ls-files', '--cached', '--others', '--exclude-standard').splitlines()):
        path = ROOT / relative
        if not path.exists():
            continue
        assert not path.is_symlink()
        target = source / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(path, target)
    return source


def tagged(source):
    git(source, 'init', '-q')
    git(source, 'add', '.')
    git(source, 'commit', '-qm', 'Fixture source')
    version = json.loads((source / 'package.json').read_text())['version']
    git(source, 'tag', 'v' + version)


@pytest.fixture(scope='module')
def core(tmp_path_factory):
    base = tmp_path_factory.mktemp('console-provenance-core')
    configured = os.environ.get('SYNTHESIS_CORE_SOURCE')
    source = Path(configured) if configured else ROOT.parent / 'synthesis-skills-unified-installation'
    spec = importlib.util.spec_from_file_location('console_core_builder', source / 'packages/build.py')
    helper = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(helper)
    fixture = base / 'nongit'; fixture.mkdir()
    for relative in ('.claude-plugin/plugin.json', '.codex-plugin/plugin.json', 'onboard.sh', 'LICENSE-APACHE'):
        target = fixture / relative; target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source / relative, target)
    return helper.build_package(fixture, base / 'core', commit='1' * 40)


def test_release_archive_uses_tracked_tree_and_locked_dependencies(tmp_path, core):
    source = candidate(tmp_path / 'source'); tagged(source)
    (source / 'public/ignored-release-note.log').write_text('ignored source marker')
    shutil.copytree(ROOT / 'node_modules', source / 'node_modules', symlinks=True)
    # Both dirty dependency bytes and ignored source bytes are invisible to Git.
    (source / 'node_modules/hono/LICENSE').write_text('developer dependency marker')
    git(source, 'config', 'core.filemode', 'false')
    (source / 'bin/synthesis-console').chmod(0o644)
    assert git(source, 'status', '--porcelain') == ''
    builder = module(); builder.ROOT = source
    output = tmp_path / 'output'
    result = builder.build(output, core)
    with tarfile.open(output / result['archive']['file']) as archive:
        names = archive.getnames()
        assert not any('ignored-release-note' in name for name in names)
        launcher = archive.getmember('synthesis-console-' + result['version'] + '/bin/synthesis-console')
        assert launcher.mode == 0o755
    assert 'developer dependency marker' not in (output / 'npm/third-party-licenses/hono/LICENSE').read_text()
    assert result['source']['kind'] == 'release'
    assert result['source']['commit'] == git(source, 'rev-parse', 'HEAD')
    assert result['dependencies']['lockfile_sha256'] == builder.digest(source / 'bun.lock')


def test_real_release_refuses_dirty_and_untagged_sources(tmp_path, core):
    source = candidate(tmp_path / 'source'); tagged(source)
    builder = module(); builder.ROOT = source
    (source / 'public/style.css').write_text('changed tracked source')
    with pytest.raises(ValueError, match='clean'):
        builder.build(tmp_path / 'dirty', core)
    git(source, 'checkout', '--', 'public/style.css')
    git(source, 'tag', '-d', 'v' + json.loads((source / 'package.json').read_text())['version'])
    with pytest.raises(ValueError, match='exact.*tag'):
        builder.build(tmp_path / 'untagged', core)


def test_fixture_entry_is_explicit_and_cannot_claim_release(tmp_path, core):
    source = candidate(tmp_path / 'source')
    builder = module()
    result = builder.build_fixture(tmp_path / 'output', core, source=source)
    again = builder.build_fixture(tmp_path / 'repeat', core, source=source)
    assert result['archive']['sha256'] == again['archive']['sha256']
    assert result['source']['kind'] == 'fixture'
    assert 'commit' not in result['source'] and 'tag' not in result['source']
    tagged(source)
    with pytest.raises(ValueError, match='nongit'):
        builder.build_fixture(tmp_path / 'refused', core, source=source)


def test_changed_dependency_manifest_cannot_bypass_frozen_lock(tmp_path, core):
    source = candidate(tmp_path / 'source')
    metadata = json.loads((source / 'package.json').read_text())
    metadata['dependencies']['hono'] = '4.0.0'
    (source / 'package.json').write_text(json.dumps(metadata))
    with pytest.raises(subprocess.CalledProcessError):
        module().build_fixture(tmp_path / 'output', core, source=source)
    assert not (tmp_path / 'output').exists()


def test_tracked_symbolic_link_has_no_release_authority(tmp_path, core):
    source = candidate(tmp_path / 'source')
    (source / 'public/linked.css').symlink_to('style.css')
    tagged(source)
    with pytest.raises(ValueError, match='unsupported tracked object'):
        module().build(tmp_path / 'output', core, source=source)
    assert not (tmp_path / 'output').exists()


def test_real_release_cli_and_packaged_demo(tmp_path, core):
    import sys
    source = candidate(tmp_path / 'source'); tagged(source)
    output = tmp_path / 'release'
    command = [sys.executable, '-B', str(ROOT / 'scripts/build_distribution.py'), '--repo-root', str(source),
               '--output', str(output), '--core-package', str(core)]
    completed = subprocess.run(command, capture_output=True, text=True)
    assert completed.returncode == 0, completed.stdout + completed.stderr
    record = json.loads((output / 'release.json').read_text())
    assert record['source']['commit'] == git(source, 'rev-parse', 'HEAD')
    package = output / 'npm'
    native = subprocess.run([str(package / 'bin/synthesis-console'), '--version'], capture_output=True, text=True)
    assert native.returncode == 0 and record['version'] in native.stdout
    # Reuse the established physical demo consumer rather than a substitute server.
    spec = importlib.util.spec_from_file_location('console_existing_consumer', ROOT / 'scripts/test_distribution.py')
    consumer = importlib.util.module_from_spec(spec); spec.loader.exec_module(consumer)
    demo = tmp_path / 'demo-home'; demo.mkdir()
    consumer.test_bundled_demo_serves_from_unrelated_directory((output, record), demo)
