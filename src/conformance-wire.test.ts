/** Exact actual producer wire bounds across Python and Console. Synthetic only. */
import { test, expect } from 'bun:test';
import {mkdtempSync,writeFileSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {finiteCommand} from './finite-command.js';
import {producerReportBytes,validateReport,parseUniqueJSON,hash} from './conformance-contract.js';
import fixture from './contracts/report-fixture.json';

const examples: [string,string,number,boolean][] = [
 ['quoted-controls','"\\\n\t\b\f\r\x00\x7f/é漢😀\ud800',1,true],
 ['ascii-under','x'.repeat(16000),250,true],
 ['ascii-over','x'.repeat(16000),263,false],
 ['accent-over','é'.repeat(16000),50,false],
 ['astral-under','😀'.repeat(8000),40,true],
 ['astral-over','😀'.repeat(8000),44,false],
];
for(const [name,detail,count,allowed] of examples)test('exact emitted byte contract '+name,async()=>{
 const source=process.env.SYNTHESIS_CORE_SOURCE;expect(source).toBeTruthy();
 const root=mkdtempSync(join(tmpdir(),'wire-bound-'));const input=join(root,'input.json'),output=join(root,'emitted.json');
 const report:any=structuredClone(fixture);report.checks=Array.from({length:count},(_,i)=>({...report.checks[0],name:'source.case-'+i,detail}));report.planes.capability='UNKNOWN';
 writeFileSync(input,JSON.stringify(report));
 const program=`import sys,json,hashlib\nfrom pathlib import Path\nsys.path.insert(0,sys.argv[1]+'/skills/synthesis-agent-conformance/scripts')\nimport report_contract as r,conformance\nv=json.loads(Path(sys.argv[2]).read_text())\nwire=(json.dumps(v,indent=2)+'\\n').encode()\ntry:r.validate(v);valid=True\nexcept r.ReportError:valid=False\nif valid:conformance.atomic_json_write(Path(sys.argv[3]),v)\nprint(json.dumps({'bytes':len(wire),'sha256':hashlib.sha256(wire).hexdigest(),'valid':valid}))`;
 const result=await finiteCommand(process.env.SYNTHESIS_BOOTSTRAP_PYTHON||'python3',['-B','-c',program,source!,input,output],{timeoutMs:10000,maxOutputBytes:65536});
 expect(result.kind,result.stderr).toBe('success');expect(result.cleanupComplete).toBeTrue();const actual=JSON.parse(result.stdout);const emitted=producerReportBytes(report);
 expect(emitted.length).toBe(actual.bytes);expect(hash(emitted)).toBe(actual.sha256);expect(actual.valid).toBe(allowed);expect(validateReport(report)!==null).toBe(allowed);
 if(allowed){const saved=readFileSync(output);expect(hash(saved)).toBe(hash(emitted));expect(validateReport(parseUniqueJSON(saved))!==null).toBeTrue();}
},15000);
