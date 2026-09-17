import sys
import unittest
import tempfile
"""Physical npm/Bun/direct consumers; fixture core never claims publication."""
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tarfile
import hashlib

import pytest
ROOT=Path(__file__).resolve().parents[1]

def module(path):
    spec=importlib.util.spec_from_file_location('builder_'+str(abs(hash(str(path)))),path)
    m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m

@pytest.fixture(scope='module')
def distribution(tmp_path_factory):
    temporary=tmp_path_factory.mktemp('console-packages')
    configured=os.environ.get('SYNTHESIS_CORE_SOURCE')
    core=Path(configured) if configured else ROOT.parent/'synthesis-skills-unified-installation'
    if not (core/'packages/build.py').exists():
        raise RuntimeError('Set SYNTHESIS_CORE_SOURCE to the verified core source checkout')
    # Acquisition is not exercised here. A nongit source fixture avoids inventing
    # a commit in the developer checkout while testing the real packaged launcher.
    fixture_source=temporary/'core-source';fixture_source.mkdir()
    for relative in ['.claude-plugin/plugin.json','.codex-plugin/plugin.json','onboard.sh','LICENSE-APACHE']:
        target=fixture_source/relative;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copyfile(core/relative,target)
    core_pkg=module(core/'packages/build.py').build_package(fixture_source,temporary/'core',commit='1'*40)
    builder=module(ROOT/'scripts/build_distribution.py')
    first=temporary/'first'; second=temporary/'second'
    console_source=temporary/'console-source';console_source.mkdir()
    # Explicit nongit candidate bytes; no commit/tag is asserted for this fixture.
    paths=subprocess.check_output(['git','-C',str(ROOT),'ls-files','--cached','--others','--exclude-standard'],text=True).splitlines()
    for relative in sorted(set(paths)):
        source=ROOT/relative
        if not source.exists(): continue
        assert not source.is_symlink()
        target=console_source/relative;target.parent.mkdir(parents=True,exist_ok=True)
        shutil.copy2(source,target)
    record=builder.build_fixture(first,core_pkg,source=console_source)
    record2=builder.build_fixture(second,core_pkg,source=console_source)
    assert record['archive']['sha256']==record2['archive']['sha256']
    return first,record

def environment(home):
    home.mkdir()
    env=dict(os.environ,HOME=str(home),SYNTHESIS_HOME=str(home),XDG_STATE_HOME=str(home/'.local/state'),XDG_DATA_HOME=str(home/'.local/share'),XDG_CACHE_HOME=str(home/'.cache'))
    env.update(npm_config_cache=str(home/'npm-cache'),npm_config_userconfig=str(home/'.npmrc'),BUN_INSTALL=str(home/'bun'),BUN_INSTALL_CACHE_DIR=str(home/'bun-cache'))
    return env

def test_package_is_inert_with_bundled_dependencies(distribution):
    root,record=distribution;metadata=json.loads((root/'npm/package.json').read_text())
    assert metadata['name']=='@synthesiswork/console'
    assert not metadata.get('scripts') and not metadata.get('dependencies')
    assert (root/'npm/app/index.js').is_file()
    assert record['archive']['sha256'] in (root/'synthesis-console.rb').read_text()
    assert record['archive']['sha256'] in (root/'install.sh').read_text()

@pytest.mark.parametrize('manager',['npm','bun','archive'])
def test_actual_consumers_help_setup_optout_and_integrity(distribution,tmp_path,manager):
    root,record=distribution; home=tmp_path/'home';env=environment(home)
    if manager=='archive':
        destination=tmp_path/'extracted';destination.mkdir()
        with tarfile.open(root/record['archive']['file']) as tar: tar.extractall(destination,filter='data')
        package=destination/('synthesis-console-'+record['version']);binary=package/'bin/synthesis-console'
    else:
        subprocess.run(['npm','pack','--ignore-scripts','--pack-destination',str(tmp_path)],cwd=root/'npm',env=env,capture_output=True,check=True)
        archive=next(tmp_path.glob('*.tgz'));prefix=home/'bun' if manager=='bun' else home/'npm'
        command=['bun','add','-g','--ignore-scripts',str(archive)] if manager=='bun' else ['npm','install','-g','--prefix',str(prefix),'--ignore-scripts','--no-audit','--no-fund',str(archive)]
        subprocess.run(command,env=env,capture_output=True,check=True)
        binary=prefix/'bin/synthesis-console';package=binary.resolve().parent.parent
    for args in [['--version'],['--help'],['synthesis','--help'],['setup','--no-dormant-core']]:
        r=subprocess.run([str(binary),*args],cwd=home,env=env,capture_output=True,text=True)
        assert r.returncode==0,r.stdout+r.stderr
    status=subprocess.run([str(binary),'synthesis','status','--json'],cwd=home,env=env,capture_output=True,text=True)
    assert status.returncode==2,status.stdout+status.stderr
    assert 'not configured' in (status.stdout+status.stderr).lower()
    for path in ['.synthesis','.claude','.agents','.local/state/synthesis','Library/LaunchAgents','.config/systemd']:
        assert not (home/path).exists()
    bootstrap=package/'synthesis-core/lib/onboard.sh';bootstrap.write_text('corrupted')
    r=subprocess.run([str(binary),'setup','--no-dormant-core'],cwd=home,env=env,capture_output=True,text=True)
    assert r.returncode!=0 and 'integrity' in r.stderr


def test_curl_installer_preserves_edited_files_and_permission_drift(distribution,tmp_path):
    root,record=distribution;home=tmp_path/'home';env=environment(home);fake=tmp_path/'fake';fake.mkdir()
    # Actual archive install; only the network transport is replaced by a local exact artifact.
    curl=fake/'curl';curl.write_text('#!/bin/sh\nprintf "%s\n" "$@" > "$CONSOLE_TEST_CURL_ARGS"\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$CONSOLE_TEST_ARCHIVE" "$2"\n');curl.chmod(0o755)
    env.update(PATH=str(fake)+os.pathsep+env['PATH'],CONSOLE_TEST_ARCHIVE=str(root/record['archive']['file']),CONSOLE_TEST_CURL_ARGS=str(tmp_path/'curl-args'))
    prefix=tmp_path/'prefix'; command=['sh',str(root/'install.sh'),'--prefix',str(prefix),'--no-dormant-core']
    first=subprocess.run(command,env=env,capture_output=True,text=True); assert first.returncode==0,first.stdout+first.stderr
    assert record['archive']['url'] in (tmp_path/'curl-args').read_text().splitlines()
    assert subprocess.run(command,env=env,capture_output=True).returncode==0
    target=prefix/'synthesis-console';original=target.read_bytes();target.write_text('foreign edited executable')
    refused=subprocess.run(command,env=env,capture_output=True);assert refused.returncode!=0;assert target.read_text()=='foreign edited executable'
    target.write_bytes(original)
    entry=prefix/('.synthesis-console-'+record['version'])/'bin/synthesis-console';entry.chmod(0o644)
    refused=subprocess.run(command,env=env,capture_output=True);assert refused.returncode!=0

@pytest.mark.parametrize('failure',['mode','transport','payload'])
def test_curl_preserves_modes_and_pending_recovery_evidence(distribution,tmp_path,failure):
    root,record=distribution;home=tmp_path/'home';env=environment(home);fake=tmp_path/'fake';fake.mkdir()
    curl=fake/'curl';curl.write_text('#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$CONSOLE_TEST_ARCHIVE" "$2"\n');curl.chmod(0o755)
    env.update(PATH=str(fake)+os.pathsep+env['PATH'],CONSOLE_TEST_ARCHIVE=str(root/record['archive']['file']))
    prefix=tmp_path/'prefix';command=['sh',str(root/'install.sh'),'--prefix',str(prefix),'--no-dormant-core']
    first=subprocess.run(command,env=env,capture_output=True,text=True);assert first.returncode==0,first.stderr
    target=prefix/'synthesis-console';receipt=prefix/'.synthesis-console-install.json';pending=prefix/'.synthesis-console-install.pending.json'
    before=receipt.read_bytes()
    if failure=='mode': target.chmod(0o644)
    else:
        pending.write_bytes(before);receipt.unlink()
        if failure=='transport':curl.write_text('#!/bin/sh\nexit 17\n')
        else:
            payload=prefix/('.synthesis-console-'+record['version'])/'scripts/console-cli.ts'
            payload.write_text(payload.read_text()+'\n// preserved edit\n')
    failed=subprocess.run(command,env=env,capture_output=True,text=True);assert failed.returncode!=0
    if failure=='mode':
        assert target.stat().st_mode&0o777==0o644 and receipt.read_bytes()==before
    else:assert pending.exists() and pending.read_bytes()==before and not receipt.exists()

def test_bundled_demo_serves_from_unrelated_directory(distribution,tmp_path):
    import selectors,time,signal
    root,record=distribution;home=tmp_path/'home';env=environment(home);env['PORT']='19810'
    process=subprocess.Popen([str(root/'npm/bin/synthesis-console'),'demo'],cwd=home,env=env,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,start_new_session=True)
    try:
        selector=selectors.DefaultSelector();selector.register(process.stdout,selectors.EVENT_READ)
        output='';deadline=time.monotonic()+10
        import re,urllib.request
        while time.monotonic()<deadline:
            if selector.select(timeout=0.2): output+=os.read(process.stdout.fileno(),65536).decode()
            match=re.search(r'http://localhost:(\d+)',output)
            if match: break
        assert match,output
        for relative in ['/projects','/style.css','/favicon.svg','/vendor/pico-2.1.1.min.css']:
            with urllib.request.urlopen('http://127.0.0.1:'+match[1]+relative,timeout=5) as response:
                assert response.status==200 and len(response.read())>20
        check=subprocess.run(['lsof','-nP','-iTCP:'+match[1],'-sTCP:LISTEN'],capture_output=True,text=True) if shutil.which('lsof') else None
        if check:
            assert '127.0.0.1:' in check.stdout and '*:' not in check.stdout
    finally:
        os.killpg(process.pid,signal.SIGTERM);process.wait(timeout=5)

def test_packaged_autostart_requires_owned_unit_before_manager_calls(distribution,tmp_path):
    import sys
    root,record=distribution;home=tmp_path/'home';env=environment(home);fake=tmp_path/'fake';fake.mkdir()
    log=home/'manager.log'
    def executable(name,body):
        path=fake/name;path.write_text('#!/bin/sh\n'+body);path.chmod(0o755)
    executable('python3','printf "%s\\n" "$0"\n') # Isolates service dispatch from Python dependency provisioning.
    if sys.platform=='darwin':
        target=home/'Library/LaunchAgents/org.synthesisengineering.console.plist'
        executable('launchctl','echo "$*" >> "$HOME/manager.log"\ncase "$1" in\nmanageruid) id -u;;\nmanagername) echo Aqua;;\nlist) printf "PID\\tStatus\\tLabel\\n"; test ! -f "$HOME/loaded" || printf "4321\\t0\\torg.synthesisengineering.console\\n";;\nprint) test -f "$HOME/loaded" && { echo " state = running"; exit 0; }; exit 1;;\nbootstrap) touch "$HOME/loaded";;\nbootout) rm -f "$HOME/loaded";;\nesac\nexit 0\n')
    else:
        target=home/'.config/systemd/user/synthesis-console.service'
        executable('systemctl','echo "$*" >> "$HOME/manager.log"\ncase "$*" in\n*show*) echo LoadState=loaded; if test -f "$HOME/loaded"; then printf "ActiveState=active\\nUnitFileState=enabled\\nMainPID=4321\\nControlPID=0\\n"; else printf "ActiveState=inactive\\nUnitFileState=disabled\\nMainPID=0\\nControlPID=0\\n"; fi;;\n*enable*) touch "$HOME/loaded";;\n*disable*) rm -f "$HOME/loaded";;\nesac\nexit 0\n')
    env.update(PATH=str(fake)+os.pathsep+env['PATH'],SYNTHESIS_PYTHON_BIN=str(fake/'python3'))
    binary=root/'npm/bin/synthesis-console'
    def command(action):return subprocess.run([str(binary),'autostart',action],cwd=home,env=env,capture_output=True,text=True)
    target.parent.mkdir(parents=True);target.write_text('foreign unit')
    refused=command('install');assert refused.returncode!=0,refused.stdout+refused.stderr
    assert target.read_text()=='foreign unit' and not log.exists()
    target.unlink()
    installed=command('install');assert installed.returncode==0,installed.stdout+installed.stderr
    owned=target.read_bytes();manager_actions=log.read_bytes()
    target.write_text('edited unit')
    assert command('uninstall').returncode!=0
    assert target.read_text()=='edited unit' and log.read_bytes()==manager_actions
    target.write_bytes(owned)
    removed=command('uninstall');assert removed.returncode==0,removed.stdout+removed.stderr
    assert not target.exists()


class CurlCancellationTests(unittest.TestCase):
    """Run actual installer bytes with disposable transport and setup workers."""
    def fixture(self, root, phase, mode='wait'):
        import io, shlex, tarfile
        home=root/'home';home.mkdir();fake=root/'fake';fake.mkdir()
        prefix=root/'prefix';archive=root/'payload.tar.gz';installer=root/'install.sh'
        worker=root/'worker.py'
        python_code=('import os,signal,time\nfrom pathlib import Path\n'
            'mode=os.environ.get("CURL_CHILD_MODE","wait")\n'
            'if mode=="exit":raise SystemExit(23)\n'
            'if mode=="signal":signal.signal(signal.SIGTERM,signal.SIG_DFL);os.kill(os.getpid(),signal.SIGTERM)\n'
            'def stop(sig,frame):\n Path(os.environ["CURL_STOPPED"]).write_text(str(sig))\n raise SystemExit(0)\n'
            'for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):signal.signal(sig,stop)\n'
            'Path(os.environ["CURL_READY"]).write_text(str(os.getpid()))\ntime.sleep(30)\n')
        worker.write_text(python_code)
        setup_code = "const fs=require('fs'); const mode=process.env.CURL_CHILD_MODE; if(mode==='exit')process.exit(23); if(mode==='signal')process.kill(process.pid,'SIGTERM'); else {for(const [name,number] of [['SIGINT',2],['SIGTERM',15],['SIGHUP',1]])process.on(name,()=>{fs.writeFileSync(process.env.CURL_STOPPED,String(number));process.exit(0)});fs.writeFileSync(process.env.CURL_READY,String(process.pid));setTimeout(()=>{},30000);}\n"
        with tarfile.open(archive,'w:gz') as output:
            for name,data in [('scripts/console-cli.ts',setup_code.encode()),('synthesis-core/bin/synthesis',b'fixture only\n')]:
                member=tarfile.TarInfo('synthesis-console-9.8.7/'+name);member.size=len(data);member.mode=0o755
                output.addfile(member,io.BytesIO(data))
        source=(ROOT/'packages/install.sh').read_text()
        installer.write_text(source.replace('@VERSION@','9.8.7').replace('@ARCHIVE_SHA256@',hashlib.sha256(archive.read_bytes()).hexdigest()))
        curl=fake/'curl'
        if phase=='transport':curl.write_text('#!/bin/sh\nexec '+shlex.quote(sys.executable)+' '+shlex.quote(str(worker))+'\n')
        else:curl.write_text('#!/bin/sh\nwhile [ "$1" != "-o" ]; do shift; done\ncp "$CURL_ARCHIVE" "$2"\n')
        curl.chmod(0o755)
        env=dict(os.environ,HOME=str(home),PATH=str(fake)+os.pathsep+os.environ['PATH'],
                 CURL_READY=str(root/'ready'),CURL_STOPPED=str(root/'stopped'),CURL_ARCHIVE=str(archive),CURL_CHILD_MODE=mode)
        return ['sh',str(installer),'--prefix',str(prefix),'--no-dormant-core'],env,prefix

    def test_installer_forwards_and_reaps_each_incoming_signal(self):
        import signal,time
        for phase in ('transport','setup'):
            for sig in (signal.SIGINT,signal.SIGTERM,signal.SIGHUP):
                with self.subTest(phase=phase,signal=sig),tempfile.TemporaryDirectory(prefix='synthesis-console-cancel-') as tmp:
                    root=Path(tmp).resolve();command,env,prefix=self.fixture(root,phase)
                    child=None
                    parent=subprocess.Popen(command,env=env,start_new_session=True,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
                    try:
                        deadline=time.monotonic()+5
                        while not (root/'ready').exists() and time.monotonic()<deadline:
                            if parent.poll() is not None:self.fail('worker did not start: '+parent.stderr.read().decode())
                            time.sleep(.01)
                        self.assertTrue((root/'ready').exists(),'worker readiness timeout')
                        child=int((root/'ready').read_text());parent.send_signal(sig)
                        self.assertEqual(parent.wait(timeout=5),-sig)
                        self.assertEqual((root/'stopped').read_text(),str(sig))
                        with self.assertRaises(ProcessLookupError):os.kill(child,0)
                        self.assertFalse(list(prefix.glob('.synthesis-console-download-*')))
                        self.assertEqual((prefix/'.synthesis-console-install.json').exists(),phase=='setup')
                    finally:
                        if child:
                            try:os.kill(child,signal.SIGTERM)
                            except ProcessLookupError:pass
                        try:os.killpg(parent.pid,signal.SIGTERM)
                        except ProcessLookupError:pass
                        parent.wait(timeout=5);parent.stderr.close()

    def test_installer_preserves_child_exit_and_signal(self):
        import signal
        for phase in ('transport','setup'):
            for mode,expected in [('exit',23),('signal',-signal.SIGTERM)]:
                with self.subTest(phase=phase,mode=mode),tempfile.TemporaryDirectory(prefix='synthesis-console-status-') as tmp:
                    command,env,prefix=self.fixture(Path(tmp).resolve(),phase,mode)
                    result=subprocess.run(command,env=env,capture_output=True,timeout=5)
                    self.assertEqual(result.returncode,expected,result.stderr.decode())
                    self.assertFalse(list(prefix.glob('.synthesis-console-download-*')))
