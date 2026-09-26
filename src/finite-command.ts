/** Finite trusted-helper custody on the supported POSIX Console hosts.
 * A process group contains ordinary descendants, not hostile setsid/double-fork
 * escape. Native execution confinement remains with its separate owner.
 */
import { spawn, execFileSync } from 'node:child_process';
export type FiniteKind = 'success'|'exit'|'signal'|'launch'|'timeout'|'output'|'descendants'|'aborted'|'cleanup';
export type FiniteResult = {kind:FiniteKind;code:number|null;signal:string|null;stdout:string;stderr:string;detail:string;cleanupComplete:boolean};
export type FiniteOptions = {env?:NodeJS.ProcessEnv;cwd?:string;timeoutMs:number;maxOutputBytes:number;combinedOutput?:boolean;signal?:AbortSignal};
type Custody = {signal:(pid:number)=>void;live:(pid:number)=>boolean};
const CLEANUP_MS=1500;
function liveGroup(pid:number):boolean {
 try{process.kill(-pid,0);}catch(e:any){if(e.code==='ESRCH')return false;if(e.code!=='EPERM')throw e;}
 // Killed orphans can remain as zombies until the OS's reaper collects them.
 // They perform no work and cannot hold pipes. Do not equate kill(0) with life.
 const raw=execFileSync('/bin/ps',['-axo','pid=,pgid=,stat='],{encoding:'utf8',timeout:250,maxBuffer:2*1024*1024});
 let ownProcessObserved=false,live=false;
 for(const line of raw.split('\n')){
  if(!line.trim())continue;
  const m=line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/);if(!m)throw new Error('Process-group inventory is unreadable.');
  if(+m[1]===process.pid)ownProcessObserved=true;
  if(+m[2]===pid && !m[3].startsWith('Z'))live=true;
 }
 if(!ownProcessObserved)throw new Error('Process-group inventory omitted its positive control.');
 return live;
}
const custody:Custody={signal(pid){try{process.kill(-pid,'SIGKILL');}catch(e:any){if(e.code!=='ESRCH' && !(e.code==='EPERM'&&!liveGroup(pid)))throw e;}},live:liveGroup};
/** One owner retains unresolved slots, refusing new work after failed cleanup.
 * The dependency seam permits error-path tests; production uses OS primitives.
 */
export class FiniteCommandOwner {
 private unresolved=new Set<number>();
 constructor(private readonly os:Custody=custody){}
 get unresolvedCount(){return this.unresolved.size;}
 async run(executable:string,args:string[],options:FiniteOptions):Promise<FiniteResult>{
  const empty=(kind:FiniteKind,detail:string,cleanupComplete=true):FiniteResult=>({kind,detail,cleanupComplete,code:null,signal:null,stdout:'',stderr:''});
  if(this.unresolved.size)return empty('cleanup','Previous helper cleanup is unresolved; new helpers are refused.',false);
  if(process.platform!=='darwin'&&process.platform!=='linux')return empty('launch','Finite helper process-group custody is unavailable on this platform.');
  if(!Number.isSafeInteger(options.timeoutMs)||options.timeoutMs<1||!Number.isSafeInteger(options.maxOutputBytes)||options.maxOutputBytes<1)return empty('launch','Invalid finite helper bounds.');
  if(options.signal?.aborted)return empty('aborted','Command was cancelled before launch.');
  return new Promise(done=>{
   let child:ReturnType<typeof spawn>;
   try{child=spawn(executable,args,{env:options.env,cwd:options.cwd,shell:false,detached:true,stdio:['ignore','pipe','pipe']});}
   catch(e:any){done(empty('launch',e.code||e.message));return;}
   let kind:FiniteKind='success',detail='',code:number|null=null,signal:string|null=null;
   let stdout=Buffer.alloc(0),stderr=Buffer.alloc(0),sizeOut=0,sizeErr=0;
   let exited=false,closed=false,cleaning=false,settled=false;
   let timer:ReturnType<typeof setTimeout>;
   const abort=()=>{if(!cleaning){kind='aborted';detail='Command was cancelled.';void cleanup();}};
   const finish=(complete:boolean)=>{
    if(settled)return;settled=true;clearTimeout(timer);options.signal?.removeEventListener('abort',abort);
    child.stdout?.destroy();child.stderr?.destroy();
    if(!complete){if(child.pid)this.unresolved.add(child.pid);kind='cleanup';}
    done({kind,detail,code,signal,stdout:stdout.toString('utf8'),stderr:stderr.toString('utf8'),cleanupComplete:complete});
   };
   const cleanup=async()=>{
    if(cleaning)return;cleaning=true;clearTimeout(timer);
    if(!child.pid){finish(true);return;}
    const pid=child.pid,deadline=performance.now()+CLEANUP_MS;
    try{
     const survivors=kind==='success'?this.os.live(pid):true;
     if(kind==='success'&&exited&&survivors){kind='descendants';detail='Helper exited with live descendants.';}
     // Signal only the session/group created by this spawn. Never search names.
     if(survivors)this.os.signal(pid);
     for(;;){
      const live=this.os.live(pid);
      if(exited&&closed&&!live){finish(true);return;}
      if(performance.now()>=deadline){detail='Helper cleanup could not establish terminal process-group custody.';finish(false);return;}
      await new Promise(resolve=>setTimeout(resolve,10));
     }
    }catch(e:any){try{this.os.signal(pid);}catch{}detail='Helper cleanup failed: '+(e.code||e.message||String(e));finish(false);}
   };
   const collect=(which:'stdout'|'stderr',data:Buffer)=>{
    if(settled || (cleaning && !['success','exit','signal'].includes(kind)))return;
    const b=Buffer.isBuffer(data)?data:Buffer.from(data);
    if(which==='stdout'){sizeOut+=b.length;stdout=Buffer.concat([stdout,b.subarray(0,Math.max(0,options.maxOutputBytes-stdout.length))]);}
    else{sizeErr+=b.length;stderr=Buffer.concat([stderr,b.subarray(0,Math.max(0,options.maxOutputBytes-stderr.length))]);}
    if((options.combinedOutput?sizeOut+sizeErr:Math.max(sizeOut,sizeErr))>options.maxOutputBytes){kind='output';detail='Command exceeded its output bound.';void cleanup();}
   };
   child.stdout!.on('data',data=>collect('stdout',data));child.stderr!.on('data',data=>collect('stderr',data));
   child.on('error',(e:any)=>{if(!cleaning){kind='launch';detail=e.code||e.message;exited=true;closed=true;void cleanup();}});
   child.on('exit',(c,s)=>{code=c;signal=s;exited=true;if(!cleaning){if(s){kind='signal';detail=s;}else if(c!==0){kind='exit';detail=String(c);}void cleanup();}});
   child.on('close',()=>{closed=true;});
   timer=setTimeout(()=>{if(!cleaning){kind='timeout';detail='Command exceeded its work deadline.';void cleanup();}},options.timeoutMs);
   options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  });
 }
}
const owner=new FiniteCommandOwner();
export function finiteCommand(executable:string,args:string[],options:FiniteOptions){return owner.run(executable,args,options);}
export class FiniteCommandError extends Error {
 constructor(readonly result:FiniteResult){super(result.detail||`Helper ${result.kind}`);}
 get code(){return this.result.kind==='exit'?this.result.code:this.result.kind;}
 get cleanupComplete(){return this.result.cleanupComplete;}
}
/** Callback facade for existing background actions; completion follows custody. */
export function finiteExecFile(executable:string|Promise<string>,args:string[],options:{env?:NodeJS.ProcessEnv;cwd?:string;timeout:number;maxBuffer?:number},callback:(error:FiniteCommandError|null,stdout:string,stderr:string)=>void):void{
 void (async()=>{
  let result:FiniteResult;
  try{result=await finiteCommand(await executable,args,{...options,timeoutMs:options.timeout,maxOutputBytes:options.maxBuffer??1024*1024});}
  catch(e){result=e instanceof FiniteCommandError?{...e.result,kind:e.cleanupComplete?'launch':'cleanup',code:null,stdout:'',detail:'Verified runtime resolution failed: '+e.message}:{kind:'launch',code:null,signal:null,stdout:'',stderr:'',detail:e instanceof Error?e.message:String(e),cleanupComplete:true};}
  callback(result.kind==='success'?null:new FiniteCommandError(result),result.stdout,result.stderr);
 })();
}
