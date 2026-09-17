"""Fresh Python, real venv, and exact per-tool dependency/ownership consumers."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys

import pytest
ROOT = Path(__file__).resolve().parents[1]
HELPER = ROOT / 'scripts/python-runtime.py'

@pytest.fixture
def runtime(tmp_path):
    base = tmp_path / 'bare-python'
    subprocess.run([sys.executable, '-I', '-B', '-m', 'venv', '--without-pip', str(base)], check=True)
    python = base / 'bin/python3'
    assert subprocess.run([str(python), '-I', '-B', '-c', 'import yaml'], capture_output=True).returncode != 0
    home = tmp_path / 'home'; home.mkdir()
    env = dict(os.environ, HOME=str(home), XDG_DATA_HOME=str(home / '.local/share'), PYTHONPATH=str(tmp_path/'foreign-python'))
    def run(op='setup'):
        return subprocess.run([str(python), '-I', '-B', str(HELPER), op], env=env, capture_output=True, text=True)
    return home, python, env, run

def test_fresh_python_gets_owned_yaml_without_global_install(runtime):
    home, base, env, run = runtime
    first = run(); assert first.returncode == 0, first.stderr
    interpreter = Path(first.stdout.strip()); assert interpreter.is_relative_to(home)
    probe = subprocess.run([str(interpreter), '-I', '-B', '-c', 'import yaml; print(yaml.__version__); print(yaml.safe_load("ready: true")["ready"])'], capture_output=True, text=True)
    assert probe.returncode == 0 and probe.stdout == '6.0.3\nTrue\n', probe.stderr
    assert run().stdout == first.stdout
    assert run('resolve').stdout == first.stdout
    assert subprocess.run([str(base), '-I', '-B', '-c', 'import yaml'], capture_output=True).returncode != 0
    for name in ['.synthesis','.claude','.agents','.config','Library']:
        assert not (home/name).exists()

@pytest.mark.parametrize('kind',['foreign-root','root-symlink','modified-yaml','missing-receipt','extra-file'])
def test_unknown_or_edited_runtime_is_preserved(runtime,tmp_path,kind):
    home, base, env, run = runtime
    root = home / '.local/share/synthesis-console/python-runtime'
    if kind == 'foreign-root':
        root.mkdir(parents=True); sentinel=root/'foreign';sentinel.write_text('retained')
    elif kind == 'root-symlink':
        root.parent.mkdir(parents=True); foreign=tmp_path/'foreign';foreign.mkdir();root.symlink_to(foreign);sentinel=foreign/'sentinel';sentinel.write_text('retained')
    else:
        result=run();assert result.returncode==0,result.stderr
        generation=Path(result.stdout.strip()).parent.parent
        if kind=='modified-yaml':
            sentinel=next(generation.glob('lib/python*/site-packages/yaml/__init__.py'));sentinel.write_text('retained edit')
        elif kind=='missing-receipt':
            (generation/'receipt.json').unlink();sentinel=generation/'pyvenv.cfg'
        else:
            sentinel=generation/'unexpected';sentinel.write_text('retained')
    before=sentinel.read_bytes()
    rejected=run();assert rejected.returncode!=0,rejected.stdout
    assert sentinel.read_bytes()==before

def test_resolution_never_provisions(runtime):
    home,base,env,run=runtime
    result=run('resolve');assert result.returncode!=0
    assert not (home/'.local').exists()

@pytest.mark.parametrize('kind',['yaml','python','configuration'])
def test_editing_receipt_cannot_reauthorize_modified_runtime(runtime,kind):
    home,base,env,run=runtime
    first=run();assert first.returncode==0,first.stderr
    generation=Path(first.stdout.strip()).parent.parent
    receipt_path=generation/'receipt.json';receipt=json.loads(receipt_path.read_text())
    if kind=='yaml':
        changed=next(generation.glob('lib/python*/site-packages/yaml/__init__.py'))
        changed.write_text('__version__="counterfeit"\n')
    elif kind=='python':
        changed=generation/'bin/python3';changed.write_text('#!/bin/sh\nexit 0\n')
    else:
        changed=generation/'pyvenv.cfg'
        changed.write_text(changed.read_text().replace('include-system-site-packages = false','include-system-site-packages = true'))
    receipt['files'][changed.relative_to(generation).as_posix()]['sha256']=hashlib.sha256(changed.read_bytes()).hexdigest()
    receipt_path.write_text(json.dumps(receipt))
    result=run('resolve');assert result.returncode!=0,result.stdout
    assert 'differs' in result.stderr,result.stderr


def test_completed_generation_recovers_missing_current_pointer(runtime):
    home,base,env,run=runtime
    first=run();assert first.returncode==0,first.stderr
    root=Path(first.stdout.strip()).parent.parent.parent
    (root/'current.json').unlink()
    (root/'.prepare-interrupted').mkdir();(root/'.prepare-interrupted/retained').write_text('incomplete owned stage')
    recovered=run();assert recovered.returncode==0,recovered.stderr
    assert recovered.stdout==first.stdout
    assert (root/'.prepare-interrupted/retained').read_text()=='incomplete owned stage'


def test_foreground_runtime_ignores_pythonpath_and_refuses_unowned_override(runtime,tmp_path):
    home,base,env,run=runtime
    first=run();assert first.returncode==0,first.stderr
    foreign=tmp_path/'foreign';foreign.mkdir();(foreign/'yaml.py').write_text('raise RuntimeError("foreign import")')
    script=tmp_path/'probe.ts'
    script.write_text('import {synthesisPythonBin,synthesisPythonEnv} from '+json.dumps(str(ROOT/'src/python-runtime.ts'))+';\n'
        'import {execFileSync} from "node:child_process"; console.log(synthesisPythonBin()); '
        'console.log(execFileSync(synthesisPythonBin(),["-B","-c","import yaml;print(yaml.__version__)"],{env:synthesisPythonEnv(),encoding:"utf8"}).trim());\n')
    env=dict(env,SYNTHESIS_BOOTSTRAP_PYTHON=str(base),PYTHONPATH=str(foreign))
    env.pop('SYNTHESIS_PYTHON_BIN',None)
    good=subprocess.run(['bun',str(script)],env=env,capture_output=True,text=True)
    assert good.returncode==0,good.stderr
    assert good.stdout==first.stdout+'6.0.3\n'
    rejected=subprocess.run(['bun',str(script)],env=dict(env,SYNTHESIS_PYTHON_BIN=str(base)),capture_output=True,text=True)
    assert rejected.returncode!=0 and 'differs from the verified' in rejected.stderr

@pytest.mark.parametrize('number',[1,2,15])
def test_runtime_child_cancellation_is_forwarded_and_reaped(tmp_path,number):
    import signal,time
    worker=tmp_path/'worker.py';ready=tmp_path/'ready';stopped=tmp_path/'stopped'
    worker.write_text('import os,signal,time\nfrom pathlib import Path\n'
        'def stop(number,frame):\n Path('+repr(str(stopped))+').write_text(str(number))\n raise SystemExit(0)\n'
        'for number in (1,2,15): signal.signal(number,stop)\n'
        'Path('+repr(str(ready))+').write_text(str(os.getpid()))\ntime.sleep(30)\n')
    caller=tmp_path/'caller.py'
    caller.write_text('import importlib.util,sys\nspec=importlib.util.spec_from_file_location("runtime",'+repr(str(HELPER))+')\n'
        'helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)\n'
        'helper.execute([sys.executable,"-I","-B",'+repr(str(worker))+'])\n')
    process=subprocess.Popen([sys.executable,'-I','-B',str(caller)],stdout=subprocess.PIPE,stderr=subprocess.PIPE)
    try:
        deadline=time.monotonic()+5
        while not ready.exists() and time.monotonic()<deadline:time.sleep(.02)
        assert ready.exists()
        child=int(ready.read_text());process.send_signal(number);process.communicate(timeout=5)
        assert process.returncode==-number
        assert stopped.read_text()==str(number)
        with pytest.raises(ProcessLookupError):os.kill(child,0)
    finally:
        if process.poll() is None:process.kill();process.communicate()


def test_runtime_child_failure_keeps_exact_exit_code(tmp_path):
    caller=tmp_path/'caller.py'
    caller.write_text('import importlib.util,sys\nspec=importlib.util.spec_from_file_location("runtime",'+repr(str(HELPER))+')\n'
        'helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)\n'
        'helper.execute([sys.executable,"-I","-B","-c","raise SystemExit(23)"])\n')
    result=subprocess.run([sys.executable,'-I','-B',str(caller)],capture_output=True)
    assert result.returncode==23


def test_package_dependency_drift_refuses_before_home_writes(tmp_path):
    import shutil
    source=tmp_path/'source';(source/'scripts').mkdir(parents=True)
    shutil.copy2(HELPER,source/'scripts/python-runtime.py')
    shutil.copytree(ROOT/'packages/python',source/'packages/python')
    changed=source/'packages/python/yaml/__init__.py';changed.write_text('changed payload')
    home=tmp_path/'home';home.mkdir()
    env=dict(os.environ,HOME=str(home),XDG_DATA_HOME=str(home/'data'))
    result=subprocess.run([sys.executable,'-I','-B',str(source/'scripts/python-runtime.py'),'setup'],env=env,capture_output=True,text=True)
    assert result.returncode!=0 and 'inventory changed' in result.stderr
    assert list(home.iterdir())==[]


def test_explicit_setup_changes_base_and_preserves_prior_generation(runtime,tmp_path):
    home,base,env,run=runtime
    first=run();assert first.returncode==0,first.stderr
    old=Path(first.stdout.strip()).parent.parent
    before={p.relative_to(old).as_posix():(p.read_bytes(),p.stat().st_mode) for p in old.rglob('*') if p.is_file()}
    new=tmp_path/'second-base';subprocess.run([sys.executable,'-I','-B','-m','venv','--without-pip',str(new)],check=True)
    def second(operation):
        return subprocess.run([str(new/'bin/python3'),'-I','-B',str(HELPER),operation],env=env,capture_output=True,text=True)
    assert second('resolve').returncode!=0
    migrated=second('setup');assert migrated.returncode==0,migrated.stderr
    assert migrated.stdout!=first.stdout and second('resolve').stdout==migrated.stdout
    assert {p.relative_to(old).as_posix():(p.read_bytes(),p.stat().st_mode) for p in old.rglob('*') if p.is_file()}==before
    assert run('resolve').returncode!=0
    restored=run();assert restored.returncode==0 and restored.stdout==first.stdout,restored.stderr


def test_base_change_preserves_modified_runtime_and_current_pointer(runtime,tmp_path):
    home,base,env,run=runtime
    first=run();assert first.returncode==0,first.stderr
    old=Path(first.stdout.strip()).parent.parent;current=old.parent/'current.json';before=current.read_bytes()
    changed=next(old.glob('lib/python*/site-packages/yaml/__init__.py'));changed.write_text('retained edit')
    new=tmp_path/'second-base';subprocess.run([sys.executable,'-I','-B','-m','venv','--without-pip',str(new)],check=True)
    failed=subprocess.run([str(new/'bin/python3'),'-I','-B',str(HELPER),'setup'],env=env,capture_output=True,text=True)
    assert failed.returncode!=0 and current.read_bytes()==before and changed.read_text()=='retained edit'


def test_source_change_during_setup_is_refused_before_dependency_execution(tmp_path):
    import shutil
    source=tmp_path/'source';(source/'scripts').mkdir(parents=True)
    shutil.copy2(HELPER,source/'scripts/python-runtime.py')
    shutil.copytree(ROOT/'packages/python',source/'packages/python')
    marker=tmp_path/'unverified-execution';home=tmp_path/'home';home.mkdir()
    caller=tmp_path/'caller.py'
    replacement='from pathlib import Path\nPath('+repr(str(marker))+').write_text("unverified bytes executed")\n__version__="6.0.3"\ndef safe_load(text): return {"ready":True}\n'
    caller.write_text('import importlib.util\nfrom pathlib import Path\n'
        'spec=importlib.util.spec_from_file_location("runtime",'+repr(str(source/'scripts/python-runtime.py'))+')\n'
        'helper=importlib.util.module_from_spec(spec);spec.loader.exec_module(helper)\n'
        'original=helper.execute\ndef changed_after_venv(arguments):\n result=original(arguments)\n'
        ' if "venv" in arguments:Path('+repr(str(source/'packages/python/yaml/__init__.py'))+').write_text('+repr(replacement)+')\n'
        ' return result\nhelper.execute=changed_after_venv\nhelper.runtime("setup")\n')
    env=dict(os.environ,HOME=str(home),XDG_DATA_HOME=str(home/'data'))
    result=subprocess.run([sys.executable,'-I','-B',str(caller)],env=env,capture_output=True,text=True)
    assert result.returncode!=0
    assert not marker.exists(), 'Unverified dependency bytes executed before refusal'
