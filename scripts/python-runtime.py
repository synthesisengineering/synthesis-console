#!/usr/bin/env python3
"""Provision or resolve Console's owned, offline, isolated Python runtime."""
import fcntl
import hashlib
import json
import os
from pathlib import Path
import signal
import stat
import subprocess
import sys
import uuid

PAYLOAD_SHA256 = '2a165696e79bb9c0251cd5ad63f425163a964c1563c0462b5db96dd203d62cf0'
OWNER = {'schema_version': 1, 'owner': 'synthesis-console-python-runtime'}
SOURCE = Path(__file__).resolve().parents[1]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def clean_env():
    result = {key: value for key, value in os.environ.items() if key not in {'PYTHONPATH', 'PYTHONHOME'}}
    result['PYTHONDONTWRITEBYTECODE'] = '1'
    return result


def execute(arguments):
    child = subprocess.Popen(arguments, env=clean_env(), stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    previous = {}
    received = []
    def forward(number, frame):
        received.append(number)
        try:
            child.send_signal(number)
        except ProcessLookupError:
            pass
    for number in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP):
        previous[number] = signal.signal(number, forward)
    try:
        stdout, stderr = child.communicate()
    finally:
        for number, handler in previous.items():
            signal.signal(number, handler)
    if received or child.returncode < 0:
        number = received[0] if received else -child.returncode
        signal.signal(number, signal.SIG_DFL)
        os.kill(os.getpid(), number)
    if child.returncode:
        print(stderr.strip() or 'Python runtime command failed', file=sys.stderr)
        raise SystemExit(child.returncode)
    return stdout.strip()


def safe_ancestors(path):
    for ancestor in [path, *path.parents]:
        if ancestor.is_symlink() and ancestor not in {Path('/tmp'), Path('/var')}:
            raise ValueError('Python runtime path crosses a symbolic link: ' + str(ancestor))


def inventory(root, exclude=()):
    found = {}
    for path in sorted(root.rglob('*')):
        name = path.relative_to(root).as_posix()
        if name in exclude:
            continue
        mode = path.lstat().st_mode
        if stat.S_ISLNK(mode):
            if not path.resolve().is_relative_to(root.resolve()):
                raise ValueError('Python runtime symlink escapes its generation')
            found[name] = {'link': os.readlink(path)}
        elif stat.S_ISREG(mode):
            found[name] = {'sha256': digest(path), 'mode': stat.S_IMODE(mode)}
        elif stat.S_ISDIR(mode):
            found[name] = {'directory': True, 'mode': stat.S_IMODE(mode)}
        else:
            raise ValueError('Unsupported Python runtime object')
    return found


def payload():
    root = SOURCE / 'packages/python'
    manifest = root / 'manifest.json'
    safe_ancestors(root)
    if manifest.is_symlink() or digest(manifest) != PAYLOAD_SHA256:
        raise ValueError('Bundled Python dependency manifest changed')
    data = json.loads(manifest.read_text())
    expected = data['files']
    found = {}
    for path in root.rglob('*'):
        if path.is_symlink():
            raise ValueError('Bundled Python dependency contains a symbolic link')
        if path.is_dir() or path == manifest:
            continue
        if not path.is_file():
            raise ValueError('Unsupported bundled Python dependency object')
        found[path.relative_to(root).as_posix()] = {'sha256': digest(path), 'mode': path.stat().st_mode & 0o777}
    if found != expected:
        raise ValueError('Bundled Python dependency inventory changed')
    return root, data


def read_json(path):
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o777 != 0o600:
        raise ValueError('Missing or foreign Python runtime receipt: ' + str(path))
    return json.loads(path.read_text())


def atomic_json(path, data):
    temporary = path.with_name('.' + path.name + '-' + uuid.uuid4().hex)
    with temporary.open('x') as stream:
        json.dump(data, stream, sort_keys=True, indent=2)
        stream.write('\n'); stream.flush(); os.fsync(stream.fileno())
    temporary.chmod(0o600)
    os.replace(temporary, path)


def validate(root, pointer, *, selected_base=True):
    generation_name = pointer.get('generation', '')
    if len(generation_name) != 64 or any(ch not in '0123456789abcdef' for ch in generation_name):
        raise ValueError('Invalid Python runtime generation')
    generation = root / generation_name
    safe_ancestors(generation)
    receipt = read_json(generation / 'receipt.json')
    if receipt.get('identity') != pointer.get('identity') or receipt.get('payload_sha256') != PAYLOAD_SHA256:
        raise ValueError('Python runtime identity changed')
    identity = receipt['identity']
    if hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest() != generation_name:
        raise ValueError('Python runtime generation identity changed')
    if selected_base and identity != current_identity():
        raise ValueError('Python runtime does not match the selected base interpreter')
    if selected_base and digest(Path(identity['base_python'])) != identity['base_sha256']:
        raise ValueError('Python runtime base interpreter changed')
    if inventory(generation, {'receipt.json'}) != receipt.get('files'):
        raise ValueError('Owned Python runtime changed; retained without overwriting')
    configuration = {}
    for line in (generation / 'pyvenv.cfg').read_text().splitlines():
        key, separator, value = line.partition(' = ')
        if not separator or key in configuration:
            raise ValueError('Owned Python configuration changed')
        configuration[key] = value
    expected_home = identity['base_home']
    if (configuration.get('home') != expected_home or configuration.get('include-system-site-packages') != 'false'
            or configuration.get('version') != '.'.join(map(str, identity['base_version']))
            or set(configuration) - {'home', 'include-system-site-packages', 'version', 'executable', 'command'}):
        raise ValueError('Owned Python configuration differs from selected isolated base')
    if 'executable' in configuration and configuration['executable'] != identity['runtime_executable']:
        raise ValueError('Owned Python configuration interpreter changed')
    bundle, metadata = payload()
    sites = list(generation.glob('lib/python*/site-packages'))
    if len(sites) != 1:
        raise ValueError('Python runtime site-packages layout changed')
    for relative, expected in metadata['files'].items():
        target = sites[0] / relative if relative.startswith('yaml/') else generation / relative
        if target.is_symlink() or not target.is_file() or digest(target) != expected['sha256'] or target.stat().st_mode & 0o777 != expected['mode']:
            raise ValueError('Owned Python dependency differs from verified release bytes')
    for path in sites[0].rglob('*'):
        if path.is_file() and path.relative_to(sites[0]).as_posix() not in metadata['files']:
            raise ValueError('Unlisted Python dependency in owned runtime')
    interpreter = generation / 'bin/python3'
    if digest(interpreter) != identity['runtime_sha256']:
        raise ValueError('Owned Python interpreter differs from selected base')
    if not interpreter.is_file() or not os.access(interpreter, os.X_OK):
        raise ValueError('Owned Python runtime interpreter is absent')
    return interpreter


def current_identity():
    base = Path(os.path.abspath(sys.executable))
    return {'base_python': str(base), 'base_sha256': digest(base),
            'base_version': list(sys.version_info[:3]), 'payload_sha256': PAYLOAD_SHA256,
            'runtime_executable': str(Path(sys._base_executable).resolve()),
            'runtime_sha256': digest(Path(sys._base_executable)),
            'base_home': str(Path(sys._base_executable).parent)}


def runtime(operation):
    bundle, metadata = payload()
    data = Path(os.environ.get('XDG_DATA_HOME') or str(Path.home() / '.local/share'))
    if not data.is_absolute():
        raise ValueError('XDG_DATA_HOME must be absolute')
    root = data / 'synthesis-console/python-runtime'
    safe_ancestors(root)
    if root.exists():
        if not root.is_dir() or read_json(root / 'owner.json') != OWNER:
            raise ValueError('Foreign Python runtime directory; preserved')
    elif operation == 'resolve':
        raise ValueError('Console Python runtime is not prepared. Run synthesis-console setup.')
    else:
        root.mkdir(parents=True, mode=0o700)
        # Exclusive creation marks ownership; no existing root contents are adopted.
        with (root / 'owner.json').open('x') as stream:
            json.dump(OWNER, stream)
        (root / 'owner.json').chmod(0o600)
    if operation == 'resolve':
        return validate(root, read_json(root / 'current.json'))
    lock = root / 'lock'
    descriptor = os.open(lock, os.O_CREAT | os.O_RDWR | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'r+') as stream:
        fcntl.flock(stream, fcntl.LOCK_EX)
        pointer_path = root / 'current.json'
        pointer = read_json(pointer_path) if pointer_path.exists() or pointer_path.is_symlink() else None
        if pointer:
            # Validate retained bytes before switching; never execute the prior
            # interpreter when an explicit setup selects another base.
            validate(root, pointer, selected_base=pointer.get('identity') == current_identity())
        base = Path(os.path.abspath(sys.executable))
        identity = current_identity()
        name = hashlib.sha256(json.dumps(identity, sort_keys=True).encode()).hexdigest()
        pointer = {'generation': name, 'identity': identity}
        generation = root / name
        if generation.exists() or generation.is_symlink():
            interpreter = validate(root, pointer)
        else:
            stage = root / ('.prepare-' + uuid.uuid4().hex)
            # Partial stages remain under this owned root after interruption.
            execute([str(base), '-I', '-B', '-m', 'venv', '--without-pip', '--copies', str(stage)])
            interpreter = stage / 'bin/python3'
            purelib = Path(execute([str(interpreter), '-I', '-B', '-c', 'import sysconfig; print(sysconfig.get_path("purelib"))']))
            if not purelib.is_relative_to(stage):
                raise ValueError('Python site-packages escaped prepared runtime')
            for relative, expected in metadata['files'].items():
                original = bundle / relative
                safe_ancestors(original)
                # Read and authenticate one immutable buffer before writing or
                # importing it; an earlier inventory check is not copy authority.
                contents = original.read_bytes()
                if (not original.is_file() or original.is_symlink()
                        or original.stat().st_mode & 0o777 != expected['mode']
                        or hashlib.sha256(contents).hexdigest() != expected['sha256']):
                    raise ValueError('Bundled Python dependency changed before copy')
                target = purelib / relative if relative.startswith('yaml/') else stage / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                with target.open('xb') as output:
                    output.write(contents)
                target.chmod(metadata['files'][relative]['mode'])
            probe = execute([str(interpreter), '-I', '-B', '-c', 'import yaml; print(yaml.__version__); assert yaml.safe_load("ready: true")["ready"] is True'])
            if probe != metadata['version']:
                raise ValueError('Prepared Python dependency version differs')
            atomic_json(stage / 'receipt.json', {'schema_version': 1, 'identity': identity,
                'payload_sha256': PAYLOAD_SHA256, 'files': inventory(stage)})
            os.rename(stage, generation)
            interpreter = validate(root, pointer)
        atomic_json(pointer_path, pointer)
        return interpreter


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2 or sys.argv[1] not in {'setup', 'resolve'}:
            raise ValueError('Expected setup or resolve')
        if sys.version_info < (3, 9):
            raise ValueError('Console Python setup requires Python 3.9 or newer')
        print(runtime(sys.argv[1]))
    except (ValueError, OSError, KeyError, TypeError) as error:
        print('Console Python runtime: ' + str(error), file=sys.stderr)
        sys.exit(2)
