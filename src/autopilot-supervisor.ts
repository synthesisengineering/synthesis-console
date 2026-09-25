/** Optional delivery inside the existing Console process. The run journal owns authority. */
import { constants as F, openSync, closeSync, fstatSync, lstatSync, readSync, writeFileSync, mkdirSync, renameSync, unlinkSync, readdirSync, readFileSync, realpathSync, existsSync } from "node:fs";
import { join, dirname, resolve, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { randomUUID, createHash } from "node:crypto";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { resolveSkillScript } from "./skill-resolution.js";
import { synthesisPythonEnv } from "./python-runtime.js";
import pkg from "../package.json";

export type LaunchRequest = {project:string;run_id:string;permit_id:string;token:string;runtime_root:string|null};
export type Generation = {python:string;helper:string;helper_sha256:string;release_root:string;release_digest:string;console_version:string};
type Enrollment = {schema_version:1;lifecycle:"enrolled"|"stopped"|"uninstalled";generation:Generation;enrolled_at:string};
type Options = {root?:string;demo?:boolean;resolveGeneration?:()=>Promise<Generation>;pollMs?:number;timeoutMs?:number;killGraceMs?:number;readPermit?:(generation:Generation,receipt:any)=>Promise<any>};
const MAX_FILES=64, MAX_REQUEST=65536, MAX_OUTPUT=1024*1024;
const BOOTSTRAP=`import os,sys,fcntl,stat,json,runpy,hashlib,io
from pathlib import Path
p=Path(sys.argv[1]);fd=os.open(sys.argv[2],os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
s=os.fstat(fd)
assert stat.S_ISREG(s.st_mode) and s.st_uid==os.getuid() and s.st_nlink==1 and stat.S_IMODE(s.st_mode)==0o600
try:fcntl.flock(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)
except BlockingIOError:
 print('{"synthesis_console_delivery":"busy"}',flush=True);sys.exit(75)
print('{"synthesis_console_delivery":"ready"}',flush=True)
raw=sys.stdin.buffer.read(65537)
assert 0<len(raw)<=65536
assert hashlib.sha256(p.read_bytes()).hexdigest()==sys.argv[3]
sys.stdin=io.TextIOWrapper(io.BytesIO(raw));sys.path.insert(0,str(p.parent));sys.argv=[str(p)]
runpy.run_path(str(p),run_name='__main__')
`;

const ID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HASH=/^[0-9a-f]{64}$/;
type ProcessRow={pid:number;parent:number;group:number;uid:number;birth:string};
function processes():Map<number,ProcessRow>{
  const raw=execFileSync("ps",["-axo","pid=,ppid=,pgid=,uid=,lstart="],{encoding:"utf8",timeout:500,maxBuffer:2*1024*1024});
  const rows=new Map<number,ProcessRow>();
  for(const line of raw.split("\n")){const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);if(m)rows.set(+m[1],{pid:+m[1],parent:+m[2],group:+m[3],uid:+m[4],birth:m[5]});}
  return rows;
}
function sha(raw:Buffer|string){return createHash("sha256").update(raw).digest("hex");}
function fields(value:any,names:string[]) { return value && typeof value==="object" && !Array.isArray(value) && Object.keys(value).sort().join("|")===names.sort().join("|"); }
function pathValue(value:any){return typeof value==="string" && value.length<=4096 && isAbsolute(value) && !value.includes("\0") && resolve(value)===value;}
function validateRequest(value:any):LaunchRequest {
  if(!fields(value,["project","run_id","permit_id","token","runtime_root"]) || !pathValue(value.project) || typeof value.run_id!=="string" || !ID.test(value.run_id) ||
      typeof value.permit_id!=="string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value.permit_id) ||
      typeof value.token!=="string" || value.token.length<32 || value.token.length>256 || value.token.includes("\0") ||
      !(value.runtime_root===null || pathValue(value.runtime_root)) || Buffer.byteLength(JSON.stringify(value))>MAX_REQUEST) throw new Error("Invalid closed native-launch request.");
  return value;
}
function ancestors(path:string) {
  let at=path;
  for(;;){if(existsSync(at) && lstatSync(at).isSymbolicLink())throw new Error("Private delivery path crosses a symbolic link.");const next=dirname(at);if(next===at)break;at=next;}
}
function privateDirectory(path:string,create=false) {
  ancestors(path);if(create)mkdirSync(path,{recursive:true,mode:0o700});
  const s=lstatSync(path);if(!s.isDirectory() || s.uid!==process.getuid?.() || (s.mode&0o777)!==0o700)throw new Error("Private delivery directory must be owned and mode0700.");
}
function privateRead(path:string,limit=MAX_REQUEST):Buffer {
  ancestors(path);const fd=openSync(path,F.O_RDONLY|F.O_NOFOLLOW|F.O_NONBLOCK);
  try {const a=fstatSync(fd);if(!a.isFile() || a.nlink!==1 || a.uid!==process.getuid?.() || (a.mode&0o777)!==0o600 || a.size>limit)throw new Error("Private delivery file custody is invalid.");
    const data=Buffer.alloc(a.size+1);const count=readSync(fd,data,0,data.length,0);const b=fstatSync(fd),c=lstatSync(path);
    if(count!==a.size || a.ino!==b.ino || a.dev!==b.dev || a.size!==b.size || a.mtimeMs!==b.mtimeMs || a.ctimeMs!==b.ctimeMs || c.ino!==a.ino || c.dev!==a.dev || c.isSymbolicLink())throw new Error("Private delivery file changed while reading.");
    return data.subarray(0,count);
  } finally{closeSync(fd);}
}
function atomic(path:string,value:any) {
  privateDirectory(dirname(path));if(existsSync(path))privateRead(path);
  const temporary=path+"."+randomUUID()+".tmp";writeFileSync(temporary,JSON.stringify(value)+"\n",{flag:"wx",mode:0o600});renameSync(temporary,path);
}
function cleanEnv(){const env=synthesisPythonEnv();for(const key of ["CODEX_THREAD_ID","CLAUDE_CODE_SESSION_ID","CLAUDE_CODE_HOST_SESSION_ID","CLAUDE_PID","CLAUDECODE","MUSE_SESSION_ID","SYNTHESIS_CLIENT_SESSION_REF","SYNTHESIS_COORDINATION_SESSION"])delete env[key];return env;}
async function capture(argv:string[],timeout=10000):Promise<string>{
  return new Promise((done,reject)=>{const child=spawn(argv[0],argv.slice(1),{env:cleanEnv(),stdio:["pipe","pipe","pipe"],shell:false});let result="",size=0,failed=false;
    const timer=setTimeout(()=>{failed=true;child.kill("SIGKILL");},timeout);child.stdin.end();
    for(const stream of [child.stdout,child.stderr])stream.on("data",(data:Buffer)=>{size+=data.length;if(size>MAX_OUTPUT){failed=true;child.kill("SIGKILL");}else if(stream===child.stdout)result+=data.toString();});
    child.on("error",()=>{failed=true;});child.on("close",code=>{clearTimeout(timer);if(failed||code!==0)reject(new Error("Installed release/runtime verification failed or exceeded its bound."));else done(result);});
  });
}
async function installedGeneration():Promise<Generation>{
  const python=(await capture(["bash",resolve(import.meta.dir,"../scripts/python-runtime.sh"),"resolve"])).trim();
  if(!pathValue(python) || (process.env.SYNTHESIS_PYTHON_BIN?.trim() && process.env.SYNTHESIS_PYTHON_BIN.trim()!==python))throw new Error("Verified Console interpreter selection changed.");
  const verifier=resolveSkillScript("synthesis-onboarding","release_runtime.py");if(!verifier)throw new Error("Installed release verification owner is unavailable.");
  // The existing owner checks activation custody, full source identity and launcher.
  // A complete digest is explicitly requested; a single helper hash is insufficient.
  const code="import sys,json;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import release_runtime as r;a=r.verified_release(require_current_interpreter=False);d=r.full_digest_report(Path(a['release_root']));assert d['tree_digest']==a['content_digest'];print(json.dumps({'root':a['release_root'],'digest':d['tree_digest']}))";
  const data=JSON.parse(await capture([python,"-I","-B","-c",code,dirname(verifier)]));
  if(!pathValue(data.root)||!HASH.test(data.digest))throw new Error("Invalid verified release identity.");
  const helper=join(data.root,"skills/synthesis-autopilot/scripts/prepared_native_launch.py");
  ancestors(helper);if(!lstatSync(helper).isFile())throw new Error("Prepared native consumer is unavailable in this release.");
  return {python,helper,helper_sha256:sha(readFileSync(helper)),release_root:data.root,release_digest:data.digest,console_version:pkg.version};
}

export class Supervisor {
  readonly root:string;
  private child:ChildProcessWithoutNullStreams|null=null;
  private interruptChild:(()=>void)|null=null;
  private running:Promise<void>|null=null;
  private timer:ReturnType<typeof setInterval>|null=null;
  private closed=false;
  private diagnostic:string|null=null;
  constructor(private options:Options={}){this.root=resolve(options.root||join(process.env.XDG_STATE_HOME||join(homedir(),".local/state"),"synthesis-console/supervision"));}
  protected requireCustody():void {
    // Neither process-group signals nor periodic ancestry snapshots contain
    // an immediate setsid/fork escape. No verified native/OS full-tree backend
    // is implemented here. This gate has no CLI, browser or environment bypass.
    throw new Error("Automatic continuation is unavailable: complete native process-tree custody has not been established on this host.");
  }
  private config():Enrollment|null{
    if(!existsSync(this.root))return null;privateDirectory(this.root);
    const file=join(this.root,"enrollment.json");if(!existsSync(file))return null;
    const value=JSON.parse(privateRead(file).toString());
    if(!fields(value,["schema_version","lifecycle","generation","enrolled_at"]) || value.schema_version!==1 || !["enrolled","stopped","uninstalled"].includes(value.lifecycle))throw new Error("Invalid supervision enrollment.");
    return value;
  }
  private files(){privateDirectory(this.root);const names=readdirSync(this.root);if(names.length>MAX_FILES*2+4)throw new Error("Delivery inventory exceeds its bound; reconcile retained requests.");return names.filter(n=>/^[0-9a-f-]{36}\.(ready|claimed|json)$/.test(n));}
  private async current(config:Enrollment){
    const actual=await (this.options.resolveGeneration||installedGeneration)();
    if(JSON.stringify(actual)!==JSON.stringify(config.generation) || sha(readFileSync(actual.helper))!==actual.helper_sha256)throw new Error("Enrolled source/runtime generation changed; refresh explicit enrollment.");
    return actual;
  }
  async enroll(){
    if(this.options.demo)throw new Error("Demo mode cannot enroll supervision.");
    this.requireCustody();
    privateDirectory(this.root,true);const previous=this.config();
    if(this.files().some(n=>n.endsWith(".claimed")) || this.status().counts.uncertain)throw new Error("Reconcile uncertain deliveries before re-enrollment.");
    const generation=await (this.options.resolveGeneration||installedGeneration)();
    if(previous && JSON.stringify(previous.generation)!==JSON.stringify(generation) && (previous.lifecycle==="enrolled" || this.files().some(n=>n.endsWith(".ready"))))throw new Error("Stop and retire pending delivery before changing the enrolled generation.");
    atomic(join(this.root,"enrollment.json"),{schema_version:1,lifecycle:"enrolled",generation,enrolled_at:new Date().toISOString()});this.closed=false;this.diagnostic=null;
  }
  async submit(value:unknown):Promise<string>{
    if(this.options.demo||this.closed)throw new Error("Supervision admission is disabled.");const request=validateRequest(value);this.requireCustody();const config=this.config();if(config?.lifecycle!=="enrolled")throw new Error("Explicit supervision enrollment is required.");
    if(this.status().counts.uncertain || this.status().counts.claimed)throw new Error("Reconcile uncertain delivery before submitting another grant.");
    await this.current(config);if(this.config()?.lifecycle!=="enrolled")throw new Error("Enrollment stopped during submission.");
    const names=this.files();if(names.filter(n=>n.endsWith(".json")).length>=MAX_FILES)throw new Error("Retained delivery capacity reached; reconcile the delivery inventory through its owner.");
    for(const name of names){const data=JSON.parse(privateRead(join(this.root,name)).toString());if(data.project===request.project&&data.run_id===request.run_id&&data.permit_id===request.permit_id)throw new Error("This permit already has a retained delivery; do not replay it.");}
    const digest=sha(JSON.stringify([request.project,request.run_id,request.permit_id]));
    const id=[digest.slice(0,8),digest.slice(8,12),digest.slice(12,16),digest.slice(16,20),digest.slice(20,32)].join("-");
    // Exclusive marker closes concurrent submit races, including interruption
    // between metadata and secret publication. It grants no run authority.
    writeFileSync(join(this.root,id+".json"),JSON.stringify({schema_version:1,project:request.project,run_id:request.run_id,permit_id:request.permit_id,delivery:"staging",task_accepted:false})+"\n",{flag:"wx",mode:0o600});
    writeFileSync(join(this.root,id+".ready"),JSON.stringify(request)+"\n",{flag:"wx",mode:0o600});return id;
  }
  status(){
    const counts={ready:0,claimed:0,delivered:0,uncertain:0};let lifecycle="disabled",error=this.diagnostic;
    try{const config=this.config();lifecycle=config?.lifecycle||"disabled";if(config)for(const name of this.files()){
      if(name.endsWith(".ready"))counts.ready++;else if(name.endsWith(".claimed"))counts.claimed++;else{const row=JSON.parse(privateRead(join(this.root,name)).toString());if(row.delivery==="delivered")counts.delivered++;else if(row.delivery!=="reconciled" && (row.delivery!=="staging" || (!existsSync(join(this.root,name.replace(/\.json$/,".ready")))&&!existsSync(join(this.root,name.replace(/\.json$/,".claimed"))))))counts.uncertain++;}
    }}catch{error="Private delivery inventory is unavailable or unsafe.";}
    return {schema_version:1,lifecycle,counts,active_local_process:!!this.child,enrollment_activity:"UNKNOWN_UNLESS_LOCAL_CHILD_OWNED",healthy:!error&&!counts.claimed&&!counts.uncertain&&lifecycle!=="enrolled",diagnostic:error,authority_granted:false,current_task_acceptance:"UNKNOWN",scope:"LOCAL_DELIVERY_ONLY",survival:"UNKNOWN",
      automatic_continuation:"UNAVAILABLE",process_tree_custody:"UNAVAILABLE",operational_ready:false,
      capability_reason:"No verified full process-tree custody backend; automatic enrollment and delivery are refused. Direct-process cleanup is diagnostic evidence only."};
  }
  async tick(){
    if(this.closed||this.options.demo)return;
    // A concurrent timer must not clear the existing promise in a finally block.
    if(this.running){try{if(this.config()?.lifecycle!=="enrolled")this.interruptChild?.();}catch{this.interruptChild?.();}return;}
    try{const config=this.config();if(config?.lifecycle!=="enrolled")return;
      if(this.status().counts.uncertain||this.status().counts.claimed){this.diagnostic="Retained uncertain delivery closes admission; reconcile through its current journal owner.";return;}
      this.running=this.consume(config);await this.running;
    }catch{this.diagnostic="Supervision admission or delivery failed; inspect the current run and private retained request.";}
    finally{this.running=null;}
  }
  private async consume(config:Enrollment){
    this.requireCustody();
    const generation=await this.current(config);if(this.closed||this.config()?.lifecycle!=="enrolled")return;
    if(!this.files().some(n=>n.endsWith(".ready")))return;
    let claimed:string|null=null,request:LaunchRequest|null=null,data:Buffer|null=null;
    const delivery=await this.launch(generation,async()=>{
      // The child now holds an OS flock shared by every Console process for
      // this enrollment. It has not received a secret or imported the consumer.
      await this.current(config);
      if(this.closed||this.config()?.lifecycle!=="enrolled")throw new Error("Enrollment stopped before delivery.");
      const name=this.files().sort().find(n=>n.endsWith(".ready"));if(!name)throw new Error("No ready request remains.");
      const original=join(this.root,name),raw=privateRead(original);validateRequest(JSON.parse(raw.toString()));
      claimed=original.replace(/\.ready$/,".claimed");renameSync(original,claimed);
      // After this rename no outcome authorizes automatic redelivery.
      data=privateRead(claimed);if(!data.equals(raw))throw new Error("Claimed credential changed.");
      request=validateRequest(JSON.parse(data.toString()));return data;
    });
    if(claimed && request && data){
      const retained=privateRead(claimed);if(!retained.equals(data))throw new Error("Retained credential changed; preserve it for owner inspection.");
      const r=request as LaunchRequest;
      atomic((claimed as string).replace(/\.claimed$/,".json"),{schema_version:1,project:r.project,run_id:r.run_id,permit_id:r.permit_id,delivery:delivery?"delivered":"uncertain",task_accepted:false,at:new Date().toISOString(),source_digest:generation.release_digest});
      unlinkSync(claimed); // Exact validated owned credential, no recursive cleanup.
      if(!delivery)this.diagnostic="Delivery outcome is uncertain; reconcile through the current native owner before new delivery.";
    }
  }
  private launch(generation:Generation,input:()=>Promise<Buffer>):Promise<boolean>{
    return new Promise(resolveResult=>{
      const child=spawn(generation.python,["-I","-B","-c",BOOTSTRAP,generation.helper,join(this.root,"dispatch.lock"),generation.helper_sha256],{env:cleanEnv(),stdio:["pipe","pipe","pipe"],shell:false,detached:true});this.child=child;
      let output="",size=0,failed=false,ended=false,readiness=false;let hard:ReturnType<typeof setTimeout>|null=null;
      const descendants=new Map<number,ProcessRow>();
      const snapshot=()=>{try{const table=processes(),parents=new Set<number>(child.pid?[child.pid]:[]);for(const [pid,row] of descendants){const now=table.get(pid);if(now&&now.uid===row.uid&&now.birth===row.birth)parents.add(pid);}
        let grew=true;while(grew){grew=false;for(const row of table.values())if(row.uid===process.getuid?.()&&parents.has(row.parent)&&!parents.has(row.pid)){if(descendants.size>=64)throw new Error("Owned descendant bound reached.");descendants.set(row.pid,row);parents.add(row.pid);grew=true;}}
      }catch{failed=true;this.diagnostic="Owned process ancestry could not be verified; cancellation outcome remains unknown.";}};
      const signal=(value:NodeJS.Signals)=>{
        snapshot();let table:Map<number,ProcessRow>|null=null;try{table=processes();}catch{failed=true;}
        // Detached native transports escape the helper's group. Signal only
        // descendants observed under this exact child and still birth/UID bound.
        let count=0;for(const [pid,row] of [...descendants].reverse()){const now=table?.get(pid);if(now&&now.uid===row.uid&&now.birth===row.birth)try{process.kill(pid,value);count++;}catch{}}
        if(child.pid)try{process.kill(-child.pid,value);}catch{}
        return count;
      };
      const interrupt=()=>{failed=true;signal("SIGINT");hard??=setTimeout(()=>{signal("SIGKILL");child.stdin.destroy();child.stdout.destroy();child.stderr.destroy();finish(null);},this.options.killGraceMs??8000);};this.interruptChild=interrupt;
      const timeout=setTimeout(interrupt,this.options.timeoutMs??915000);
      const startup=setTimeout(()=>{if(!readiness)interrupt();},5000);
      child.stderr.on("data",(bytes:Buffer)=>{size+=bytes.length;if(size>MAX_OUTPUT)interrupt();});
      child.stdout.on("data",(bytes:Buffer)=>{
        size+=bytes.length;if(size>MAX_OUTPUT){interrupt();return;}output+=bytes.toString();
        if(!readiness&&output.includes("\n")){
          const line=output.slice(0,output.indexOf("\n"));output=output.slice(output.indexOf("\n")+1);readiness=true;clearTimeout(startup);
          let hello:any;try{hello=JSON.parse(line);}catch{interrupt();return;}
          if(hello.synthesis_console_delivery==="busy"){child.stdin.end();return;}
          if(hello.synthesis_console_delivery!=="ready"){interrupt();return;}
          void input().then(raw=>{if(!ended&&!failed)child.stdin.end(raw);}).catch(()=>{this.diagnostic="Private credential or current enrollment failed validation; delivery was refused.";interrupt();});
        }
      });
      const tracking=setInterval(snapshot,500);
      const finish=(code:number|null)=>{if(ended)return;ended=true;clearTimeout(timeout);clearTimeout(startup);clearInterval(tracking);if(hard)clearTimeout(hard);this.child=null;this.interruptChild=null;
        let accepted=false;try{const value=JSON.parse(output);accepted=!failed&&code===0&&value.status==="native_terminal"&&value.task_accepted===false;}catch{}
        // Let the OS reap killed descendants before returning an owned-process
        // cleanup result. Inherited pipes never control this finite deadline.
        if(failed&&descendants.size)setTimeout(()=>resolveResult(false),150);
        else resolveResult(accepted);
      };
      child.on("error",()=>{failed=true;});child.stdin.on("error",()=>{failed=true;});
      child.on("exit",()=>{if(!ended&&descendants.size&&signal("SIGKILL")>0)failed=true;if(!ended)hard??=setTimeout(()=>{child.stdout.destroy();child.stderr.destroy();finish(null);},1000);});
      child.on("close",finish);
    });
  }

  start(){if(this.timer||this.options.demo)return;this.timer=setInterval(()=>{void this.tick();},Math.max(10,this.options.pollMs??2000));void this.tick();}
  async shutdown(){this.closed=true;if(this.timer){clearInterval(this.timer);this.timer=null;}this.interruptChild?.();if(this.running)await this.running;}
  async stop(){const config=this.config();if(config)atomic(join(this.root,"enrollment.json"),{...config,lifecycle:"stopped"});await this.shutdown();}
  async reconcile(){
    if(this.child||this.running)throw new Error("Stop local delivery before reconciliation.");
    const config=this.config();if(!config)return;
    const generation=await (this.options.resolveGeneration||installedGeneration)();
    for(const name of this.files().filter(n=>n.endsWith(".json"))){
      const file=join(this.root,name),before=privateRead(file),row=JSON.parse(before.toString());
      if(["delivered","reconciled"].includes(row.delivery))continue;
      if(!pathValue(row.project)||typeof row.run_id!=="string"||!ID.test(row.run_id)||typeof row.permit_id!=="string")throw new Error("Retained delivery pointer is invalid.");
      const read=this.options.readPermit||async function(g:Generation,r:any){
        const code="import sys,json;from pathlib import Path;sys.path.insert(0,sys.argv[1]);import run_state;r=json.loads(sys.argv[2]);p=Path(r['project']);s=run_state.load_run(p,r['run_id']);assert s['owner']['project_root']==str(p.resolve());h=run_state._last_event(p,r['run_id']);g=s.get('extensions',{}).get('prepared_native_launch',{}).get('permits',{}).get(r['permit_id'],{});print(json.dumps({'status':g.get('status'),'token_sha256':g.get('token_sha256'),'revision':s['revision'],'journal_head':h['digest']}))";
        return JSON.parse(await capture([g.python,"-I","-B","-c",code,dirname(g.helper),JSON.stringify({project:r.project,run_id:r.run_id,permit_id:r.permit_id})]));
      };
      const proof=await read(generation,row);
      if(!["observed","cancelled"].includes(proof.status)||!HASH.test(proof.journal_head)||!HASH.test(proof.token_sha256)||!Number.isSafeInteger(proof.revision)||proof.revision<1)throw new Error("Native owner has not reconciled this uncertain permit.");
      if(!privateRead(file).equals(before))throw new Error("Delivery receipt changed during reconciliation.");
      for(const suffix of ["ready","claimed"]){const credential=file.replace(/\.json$/,"."+suffix);if(!existsSync(credential))continue;
        const raw=privateRead(credential),request=validateRequest(JSON.parse(raw.toString()));
        if(request.project!==row.project||request.run_id!==row.run_id||request.permit_id!==row.permit_id||sha(request.token)!==proof.token_sha256)throw new Error("Credential does not match the reconciled journal permit.");
        // A nonblocking process lock probe is still required: active delivery
        // cannot be cleaned by a separate CLI instance. Owner cancellation is
        // necessary but it does not itself prove transport-process exit.
        const lockProbe="import os,fcntl,sys;f=os.open(sys.argv[1],os.O_RDWR|os.O_NOFOLLOW);fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)";
        await capture([generation.python,"-I","-B","-c",lockProbe,join(this.root,"dispatch.lock")]);
        if(!privateRead(credential).equals(raw))throw new Error("Credential changed during reconciliation.");unlinkSync(credential);
      }
      atomic(file,{...row,delivery:"reconciled",task_accepted:false,journal_readback:proof});
    }
    this.diagnostic=null;
  }
  async uninstall(){
    await this.stop();const config=this.config();if(!config)return;
    // Retire only unclaimed private handoffs. A journal permit is not cancelled
    // here; its native owner must reconcile it before issuing another one.
    for(const name of this.files().filter(n=>n.endsWith(".ready"))){const path=join(this.root,name),raw=privateRead(path),r=validateRequest(JSON.parse(raw.toString()));
      atomic(path.replace(/\.ready$/,".json"),{schema_version:1,project:r.project,run_id:r.run_id,permit_id:r.permit_id,delivery:"retired",task_accepted:false});
      if(!privateRead(path).equals(raw))throw new Error("Retirement credential changed.");unlinkSync(path);
    }
    atomic(join(this.root,"enrollment.json"),{...config,lifecycle:"uninstalled"});
  }
}

export async function supervisorCLI(action:string){
  const supervisor=new Supervisor();if(action==="status"){console.log(JSON.stringify(supervisor.status()));return;}
  if(action==="enroll")await supervisor.enroll();else if(action==="stop")await supervisor.stop();else if(action==="uninstall")await supervisor.uninstall();else if(action==="reconcile")await supervisor.reconcile();
  else if(action==="submit"){
    const raw=await new Promise<Buffer>((done,reject)=>{
      const chunks:Buffer[]=[];let size=0;const timer=setTimeout(()=>{process.stdin.destroy();reject(new Error("Private stdin timed out."));},30000);
      process.stdin.on("data",(chunk:Buffer)=>{size+=chunk.length;if(size>MAX_REQUEST){clearTimeout(timer);process.stdin.destroy();reject(new Error("Private request exceeds its input bound."));}else chunks.push(chunk);});
      process.stdin.once("error",()=>{clearTimeout(timer);reject(new Error("Private stdin failed."));});
      process.stdin.once("end",()=>{clearTimeout(timer);done(Buffer.concat(chunks));});
    });
    const id=await supervisor.submit(JSON.parse(raw.toString()));console.log(JSON.stringify({delivery_id:id,authority_granted:false}));return;
  }else throw new Error("Choose supervision enroll, status, stop, uninstall, reconcile or submit.");
  console.log(JSON.stringify(supervisor.status()));
}
