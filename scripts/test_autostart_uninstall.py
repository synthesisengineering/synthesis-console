"""Real uninstall entrypoints; launchctl/systemctl are always local simulators."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

import pytest

ROOT = Path(__file__).resolve().parents[1]
BUN = shutil.which('bun')
LABEL = 'org.synthesisengineering.console'
MANAGER = r'''
import json, os, signal, sys
from pathlib import Path
home=Path(os.environ['HOME']); mode=os.environ.get('CASE','success'); args=sys.argv[1:]
with (home/'manager.log').open('a') as out: out.write(json.dumps(args)+'\n')
loaded=home/'loaded'; target=Path(os.environ['UNIT']); state=home/'.local/state/synthesis-console'
if args==['manageruid']: print(os.getuid()); sys.exit(0)
if args==['managername']: print('Background' if mode=='wrong-domain' else 'Aqua'); sys.exit(0)
if args==['list'] or 'show' in args:
    if mode=='query-fails': sys.exit(17)
    if mode=='malformed': print('unrecognized manager response'); sys.exit(0)
    if args==['list']:
        print('PID\tStatus\tLabel')
        print('-\t0\tforeign.example')
        if loaded.exists(): print('123\t0\torg.synthesisengineering.console')
    else:
        active=loaded.exists()
        print('LoadState=loaded\nActiveState='+('active' if active else 'inactive'))
        print('UnitFileState='+('enabled' if active else 'disabled'))
        print('MainPID='+('123' if active else '0')+'\nControlPID=0')
    sys.exit(0)
if args and (args[0]=='bootout' or 'disable' in args):
    if mode=='stop-fails': sys.exit(17)
    if mode!='still-active': loaded.unlink(missing_ok=True)
    if mode=='edit-during-stop': target.write_text('retained edit')
    if mode=='mode-during-stop': target.chmod(0o600)
    sys.exit(0)
if args==['--user','daemon-reload']:
    if mode=='reload-fails': sys.exit(17)
    if mode=='foreign-on-rollback': target.write_text('foreign replacement'); sys.exit(17)
    if mode=='receipt-fails':
        pending=json.loads((state/'autostart-uninstall.json').read_text())
        Path(pending['receipt_archive']).write_text('foreign receipt archive')
    if mode=='crash-after-move' and not (home/'crashed').exists():
        (home/'crashed').touch(); os.kill(os.getppid(),signal.SIGKILL)
    sys.exit(0)
raise SystemExit('Unexpected simulated manager command: '+repr(args))
'''

@pytest.fixture(params=['macos','linux'])
def service(tmp_path, request):
    platform=request.param; home=tmp_path/'home'; home.mkdir(); fake=tmp_path/'fake'; fake.mkdir()
    target=home/('Library/LaunchAgents/'+LABEL+'.plist' if platform=='macos' else '.config/systemd/user/synthesis-console.service')
    target.parent.mkdir(parents=True); target.write_text('owned service\n'); target.chmod(0o644)
    (home/'loaded').touch()
    for name in ['launchctl','systemctl']:
        executable=fake/name; executable.write_text('#!'+sys.executable+'\n'+MANAGER); executable.chmod(0o755)
    (fake/'uname').write_text('#!/bin/sh\necho '+('Darwin' if platform=='macos' else 'Linux')+'\n'); (fake/'uname').chmod(0o755)
    (fake/'bun').symlink_to(BUN)
    env=dict(os.environ,HOME=str(home),XDG_CONFIG_HOME=str(home/'.config'),XDG_STATE_HOME=str(home/'.local/state'),UNIT=str(target),PATH=str(fake)+os.pathsep+os.environ['PATH'])
    helper=ROOT/'scripts/service-ownership.ts'
    record=subprocess.run([BUN,str(helper),'record',str(target)],env=env,text=True,capture_output=True)
    assert record.returncode==0,record.stderr
    receipt=home/'.local/state/synthesis-console/autostart.json'
    before=receipt.read_bytes()
    def run(case='success'):
        return subprocess.run(['bash',str(ROOT/f'scripts/uninstall-autostart-{platform}.sh')],env=dict(env,CASE=case),text=True,capture_output=True,timeout=15)
    return dict(platform=platform,home=home,target=target,receipt=receipt,before=before,run=run,env=env,helper=helper)

@pytest.mark.parametrize('case',['stop-fails','query-fails','malformed','still-active'])
def test_uncertain_manager_preserves_unit_and_receipt(service,case):
    s=service; result=s['run'](case)
    assert result.returncode!=0,result.stdout+result.stderr
    assert s['target'].read_text()=='owned service\n'
    assert s['receipt'].read_bytes()==s['before']
    assert 'will no longer start' not in result.stdout

@pytest.mark.parametrize('case',['success','already-stopped'])
def test_verified_stop_retires_exact_owned_files(service,case):
    s=service
    if case=='already-stopped': (s['home']/'loaded').unlink()
    result=s['run']()
    assert result.returncode==0,result.stdout+result.stderr
    assert not s['target'].exists() and not s['receipt'].exists()
    assert not (s['home']/'loaded').exists()
    assert not (s['receipt'].parent/'autostart-uninstall.json').exists()
    retired=list(s['target'].parent.glob('.synthesis-console-retired-*/*'))
    assert any(p.read_text()=='owned service\n' and p.stat().st_mode&0o777==0o644 for p in retired)
    assert s['run']().returncode==0

@pytest.mark.parametrize('edit',['bytes','mode','symlink'])
def test_local_edits_never_reach_service_manager(service,edit):
    s=service
    if edit=='bytes': s['target'].write_text('retained edit')
    elif edit=='mode': s['target'].chmod(0o600)
    else:
        foreign=s['home']/'foreign'; foreign.write_text('retained edit');s['target'].unlink();s['target'].symlink_to(foreign)
    result=s['run']();assert result.returncode!=0
    assert not (s['home']/'manager.log').exists()
    assert s['receipt'].read_bytes()==s['before']
    if edit=='mode': assert s['target'].stat().st_mode&0o777==0o600
    else: assert s['target'].read_text()=='retained edit'

@pytest.mark.parametrize('case',['edit-during-stop','mode-during-stop'])
def test_edits_during_manager_call_are_preserved(service,case):
    s=service;result=s['run'](case);assert result.returncode!=0
    assert s['receipt'].read_bytes()==s['before']
    if case=='edit-during-stop': assert s['target'].read_text()=='retained edit'
    else: assert s['target'].stat().st_mode&0o777==0o600

def test_wrong_login_context_is_not_absence(service):
    s=service
    if s['platform']!='macos': pytest.skip('macOS context proof')
    (s['home']/'loaded').unlink()
    result=s['run']('wrong-domain');assert result.returncode!=0
    assert s['target'].exists() and s['receipt'].read_bytes()==s['before']

@pytest.mark.parametrize('case',['reload-fails','receipt-fails'])
def test_failure_after_movement_restores_unit_and_receipt(service,case):
    s=service
    if s['platform']!='linux': pytest.skip('systemd reload boundary')
    result=s['run'](case);assert result.returncode!=0,result.stdout+result.stderr
    assert s['target'].read_text()=='owned service\n'
    assert s['target'].stat().st_mode&0o777==0o644
    assert s['receipt'].read_bytes()==s['before']
    if case=='receipt-fails':
        assert any(p.read_text()=='foreign receipt archive' for p in s['receipt'].parent.glob('autostart-retired-*/*'))

def test_rollback_does_not_overwrite_a_foreign_replacement(service):
    s=service
    if s['platform']!='linux': pytest.skip('systemd reload boundary')
    result=s['run']('foreign-on-rollback');assert result.returncode!=0
    assert s['target'].read_text()=='foreign replacement'
    assert s['receipt'].read_bytes()==s['before']
    pending=json.loads((s['receipt'].parent/'autostart-uninstall.json').read_text())
    assert Path(pending['unit_archive']).read_text()=='owned service\n'
    assert s['run']().returncode!=0
    assert s['target'].read_text()=='foreign replacement'

def test_interrupted_movement_is_recoverable_by_the_same_entrypoint(service):
    s=service
    if s['platform']!='linux': pytest.skip('systemd reload boundary')
    result=s['run']('crash-after-move');assert result.returncode!=0
    assert not s['target'].exists() and s['receipt'].read_bytes()==s['before']
    pending=s['receipt'].parent/'autostart-uninstall.json';assert pending.exists()
    recovered=s['run']();assert recovered.returncode==0,recovered.stdout+recovered.stderr
    assert not s['target'].exists() and not s['receipt'].exists() and not pending.exists()

def test_receipt_movement_before_a_crash_can_be_recovered(service):
    s=service
    if s['platform']!='linux': pytest.skip('systemd reload boundary')
    result=s['run']('crash-after-move'); assert result.returncode!=0
    pending=s['receipt'].parent/'autostart-uninstall.json'
    tx=json.loads(pending.read_text())
    # Advance the durable crash fixture to the finalization boundary. The exact
    # source receipt is moved, not reconstructed from expectations.
    s['receipt'].rename(tx['receipt_archive'])
    recovered=s['run']();assert recovered.returncode==0,recovered.stdout+recovered.stderr
    assert not s['target'].exists() and not s['receipt'].exists() and not pending.exists()

def test_a_live_retirement_journal_blocks_recovery_and_installation(service):
    s=service
    if s['platform']!='linux': pytest.skip('systemd reload boundary')
    assert s['run']('crash-after-move').returncode!=0
    pending=s['receipt'].parent/'autostart-uninstall.json';tx=json.loads(pending.read_text());tx['pid']=os.getpid();pending.write_text(json.dumps(tx)+'\n')
    before=(s['home']/'manager.log').read_bytes()
    assert s['run']().returncode!=0
    checked=subprocess.run([BUN,str(s['helper']),'check',str(s['target'])],env=s['env'],capture_output=True)
    assert checked.returncode!=0
    assert (s['home']/'manager.log').read_bytes()==before
    assert Path(tx['unit_archive']).read_text()=='owned service\n'
    assert s['receipt'].read_bytes()==s['before'] and pending.exists()
