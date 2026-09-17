"""Exercise the real Bun CLI against a harmless, integrity-bound lifecycle fixture."""
import hashlib
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys
import time

import pytest
ROOT = Path(__file__).resolve().parents[1]

@pytest.fixture
def bridge(tmp_path):
    home=tmp_path/'home';home.mkdir()
    package=tmp_path/'package';(package/'scripts').mkdir(parents=True)
    shutil.copyfile(ROOT/'scripts/console-cli.ts',package/'scripts/console-cli.ts')
    shutil.copyfile(ROOT/'package.json',package/'package.json')
    core=package/'synthesis-core';(core/'bin').mkdir(parents=True)
    launcher=core/'bin/synthesis'
    launcher.write_text('#!'+sys.executable+'\nimport json,os,signal,sys,time\nfrom pathlib import Path\n'
                        'Path(os.environ["HOME"],"called").write_text(json.dumps(sys.argv[1:]))\n'
                        'if os.environ.get("BRIDGE_SIGNAL"): os.kill(os.getpid(),signal.SIGTERM)\n'
                        'if os.environ.get("BRIDGE_WAIT"):\n'
                        ' Path(os.environ["HOME"],"ready").write_text(str(os.getpid()))\n'
                        ' time.sleep(15)\n'
                        'sys.exit(int(os.environ.get("BRIDGE_EXIT","0")))\n')
    launcher.chmod(0o755)
    inventory=package/'core-files.json';inventory.write_text(json.dumps({'bin/synthesis':{'sha256':hashlib.sha256(launcher.read_bytes()).hexdigest(),'mode':0o755}}))
    def run(args,**environment):
        return subprocess.run(['bun',str(package/'scripts/console-cli.ts'),*args],cwd=home,
                              env=dict(os.environ,HOME=str(home),**environment),capture_output=True,text=True)
    return home,package,run

def test_help_and_rejected_operations_are_inert(bridge):
    home,package,run=bridge;(package/'core-files.json').unlink()
    for args in [['--help'],['synthesis','--help']]:
        r=run(args);assert r.returncode==0,r.stderr;assert 'activate' in r.stdout
    for command in [[],['setup'],['stage-core'],['enroll'],['exec-public']]:
        assert run(['synthesis',*command]).returncode==2
    assert not list(home.iterdir())

def test_allowed_operations_preserve_arguments_failure_and_signal(bridge):
    home,package,run=bridge
    for operation in ['activate','deactivate','status','doctor','repair','update']:
        args=[operation,'--path','folder with spaces',';literal','']
        r=run(['synthesis',*args]);assert r.returncode==0,r.stderr
        assert json.loads((home/'called').read_text())==args
    assert run(['synthesis','repair'],BRIDGE_EXIT='23').returncode==23
    assert run(['synthesis','status'],BRIDGE_SIGNAL='1').returncode==-signal.SIGTERM

def test_lifecycle_reuses_bundle_integrity_checks(bridge):
    home,package,run=bridge;core=package/'synthesis-core'
    (core/'extra').write_text('foreign')
    r=run(['synthesis','activate','--profile','full']);assert r.returncode==2 and 'integrity' in r.stderr
    assert not list(home.iterdir())

def test_incoming_termination_reaches_core_without_orphan(bridge):
    home,package,run=bridge
    process=subprocess.Popen(['bun',str(package/'scripts/console-cli.ts'),'synthesis','status'],cwd=home,
                             env=dict(os.environ,HOME=str(home),BRIDGE_WAIT='1'),stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    child_pid=None
    try:
        deadline=time.monotonic()+5
        while not (home/'ready').exists() and time.monotonic()<deadline and process.poll() is None:
            time.sleep(0.02)
        assert (home/'ready').exists()
        child_pid=int((home/'ready').read_text())
        process.send_signal(signal.SIGTERM);process.communicate(timeout=5)
        assert process.returncode==-signal.SIGTERM
        with pytest.raises(ProcessLookupError): os.kill(child_pid,0)
    finally:
        if process.poll() is None: process.kill();process.communicate(timeout=5)
        if child_pid:
            try: os.kill(child_pid,signal.SIGTERM)
            except ProcessLookupError: pass

@pytest.mark.parametrize('change',['missing','symlink','mode','inventory-symlink'])
def test_invalid_core_files_never_execute(bridge,change):
    home,package,run=bridge;launcher=package/'synthesis-core/bin/synthesis'
    if change=='missing': launcher.unlink()
    elif change=='mode': launcher.chmod(0o644)
    elif change=='symlink':
        outside=package/'external';launcher.rename(outside);launcher.symlink_to(outside)
    else:
        inventory=package/'core-files.json';outside=package/'external-inventory'
        inventory.rename(outside);inventory.symlink_to(outside)
    r=run(['synthesis','doctor']);assert r.returncode==2
    assert not list(home.iterdir())
