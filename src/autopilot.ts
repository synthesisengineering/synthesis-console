import { finiteCommand } from "./finite-command.js";
import { lstatSync, realpathSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { Source } from "./config.js";
import { loadProjectIndex } from "./parsers/yaml.js";
import { resolveSkillScript } from "./skill-resolution.js";
import { synthesisPythonEnv } from "./python-runtime.js";

export const READ_TIMEOUT_MS = 8000;
export const MAX_OUTPUT_BYTES = 1024 * 1024;
export const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export interface OperatorRun {
  run_id: string; project_id?: string; revision?: number; journal_head?: string;
  status: "working" | "waiting" | "unhealthy" | "completed" | "cancelled";
  recorded_status: string; currentness: string; authority_granted: false;
  updated_at?: string; owner?: {session_uuid: string; native_ref: string}; scope?: string[];
  questions: {id: string; kind: string; reason: string; reason_truncated?: boolean; at?: string}[];
  diagnostics: string[]; current_acceptance: "UNKNOWN";
  last_note?: {summary: string | null; at: string | null; measured: false};
  last_useful_progress?: unknown; resources?: Record<string, unknown>; checkpoint?: unknown;
  tasks?: {id: string; status: string}[]; effects?: {id: string; status: string}[];
  children?: {id: string; status: string}[]; supervision?: Record<string, unknown>;
  continuation?: unknown; completion?: unknown;
}
export interface OperatorReport {
  schema_version: 1; project: string | null; scope: "READ_ONLY_OPERATOR_VIEW"; observed_at: string;
  authority_granted: false; runs: OperatorRun[];
  helper: {path: string; sha256: string; loaded_in_native_session: "UNKNOWN"};
  registry?: {path: string; sha256: string; project_id: string};
  resolution?: {status: string; selected_path: string | null; selected_head: string | null; selected_tree: string | null; issues: string[]; fetch: false; refresh_coordination: false; authority_granted: false};
  pagination?: {total: number; offset: number; limit: number; next_cursor: string | null; order: "FILESYSTEM_RECENCY_HINT"; questions_scope: "THIS_PAGE_ONLY"; inventory_sha256: string};
}
export interface OperatorResult { available: boolean; report: OperatorReport | null; diagnostic: string | null; cleanupComplete?: boolean }

export function safeSegment(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/.test(value) && value !== "." && value !== "..";
}
function containedReal(path: string, root: string, directory: boolean): string {
  const rel = relative(root, path);
  if (rel.startsWith(".." + sep) || rel === ".." || isAbsolute(rel)) throw new Error("Path escaped the selected source.");
  let at = root;
  for (const part of rel.split(sep).filter(Boolean)) {
    at = join(at, part);
    if (lstatSync(at).isSymbolicLink()) throw new Error("Source detail crosses a symbolic link.");
  }
  const info = lstatSync(path);
  if (directory ? !info.isDirectory() : !info.isFile()) throw new Error("Unsupported source file type.");
  return realpathSync(path);
}
export function operatorProjects(source: Source): {id: string; name: string}[] {
  if (!source.projects_dir) return [];
  const root = realpathSync(source.root);
  const directory = containedReal(resolve(root, source.projects_dir), root, true);
  const index = containedReal(join(directory, "index.yaml"), root, false);
  if (lstatSync(index).size > 1024 * 1024) throw new Error("Project registry exceeds the read bound.");
  const rows = loadProjectIndex({...source, root});
  if (rows.length > 512) throw new Error("Project registry exceeds the project bound.");
  return rows.filter(row => safeSegment(row.id)).map(row => ({id: row.id, name: row.name || row.id}));
}
export function operatorProject(source: Source, id: string): string {
  // Canonical registry anchor only. Run reads use the PM resolver below.
  if (!safeSegment(id) || !operatorProjects(source).some(row => row.id === id)) throw new Error("Selected project is not registered.");
  const root = realpathSync(source.root);
  return containedReal(resolve(root, source.projects_dir!, id), root, true);
}
export function operatorIndex(source: Source, id: string): string {
  if (!safeSegment(id) || !operatorProjects(source).some(row => row.id === id)) throw new Error("Selected project is not registered.");
  const root = realpathSync(source.root);
  return containedReal(resolve(root, source.projects_dir!, "index.yaml"), root, false);
}

export function operatorScript(): string {
  const override = process.env.SYNTHESIS_AUTOPILOT_DIR;
  const selected = override ? join(override, "scripts/operator_status.py") : resolveSkillScript("synthesis-autopilot", "operator_status.py");
  if (!selected) throw new Error("The operator reader is unavailable. Ask your agent to doctor or update synthesis.");
  const skill = realpathSync(resolve(selected, "../.."));
  for (const name of ["operator_status.py", "run_state.py", "autopilot.py"]) {
    containedReal(join(skill, "scripts", name), skill, false);
  }
  return containedReal(join(skill, "scripts/operator_status.py"), skill, false);
}
export class HelperCustodyError extends Error { constructor(message:string,readonly cleanupComplete:boolean){super(message);} }
export async function boundedCommand(executable: string, args: string[], timeout = READ_TIMEOUT_MS, phase = "Operator reader"): Promise<string> {
  const result=await finiteCommand(executable,args,{env:{...synthesisPythonEnv(),GIT_OPTIONAL_LOCKS:"0",GIT_TERMINAL_PROMPT:"0",GIT_NO_LAZY_FETCH:"1"},timeoutMs:timeout,maxOutputBytes:MAX_OUTPUT_BYTES});
  if(result.kind==='success')return result.stdout;
  const detail=(result.stderr||result.stdout).trim().slice(0,2048);
  let reason:string;
  if(result.kind==='timeout')reason=`exceeded its ${timeout} ms time bound`;
  else if(result.kind==='output')reason='exceeded its output bound';
  else if(result.kind==='signal')reason=`terminated by signal ${result.signal}`;
  else if(result.kind==='exit')reason=`exited with code ${result.code}`;
  else if(result.kind==='launch')reason=`could not start (${result.detail})`;
  else reason=result.detail;
  throw new HelperCustodyError(`${phase} ${reason}${detail?": "+detail:"."}`,result.cleanupComplete);
}
export function validateReport(value: unknown, project: string, script: string, runId?: string, registry?: {path: string; id: string}): OperatorReport {
  const data = value as OperatorReport;
  if (!data || data.schema_version !== 1 || data.scope !== "READ_ONLY_OPERATOR_VIEW" || data.authority_granted !== false ||
      (!registry && data.project !== project) || !Array.isArray(data.runs) || data.runs.length > 32 ||
      !data.helper || data.helper.path !== script || data.helper.loaded_in_native_session !== "UNKNOWN" ||
      data.helper.sha256 !== createHash("sha256").update(readFileSync(script)).digest("hex") ||
      typeof data.observed_at !== "string" || !Number.isFinite(Date.parse(data.observed_at))) throw new Error("Operator reader returned an unbound report.");
  if (registry) {
    const selected = data.resolution;
    if (!data.registry || data.registry.path !== registry.path || data.registry.project_id !== registry.id ||
        data.registry.sha256 !== createHash("sha256").update(readFileSync(registry.path)).digest("hex") ||
        !selected || !["PASS", "LOCAL_RECOVERABLE", "CONFLICT", "UNKNOWN"].includes(selected.status) ||
        selected.fetch !== false || selected.refresh_coordination !== false || selected.authority_granted !== false ||
        !Array.isArray(selected.issues) || selected.issues.length > 32 || selected.issues.some(x => typeof x !== "string")) throw new Error("Operator resolution is not bound to the selected registry.");
    if (["PASS", "LOCAL_RECOVERABLE"].includes(selected.status)) {
      if (!data.project || data.project !== selected.selected_path || !isAbsolute(data.project) || realpathSync(data.project) !== data.project) throw new Error("Resolved project path is invalid.");
    } else if (data.project !== null || data.runs.length) throw new Error("Conflicted project cannot expose a selected run.");
  }
  const page = data.pagination;
  if (page && (!Number.isSafeInteger(page.total) || !Number.isSafeInteger(page.offset) || !Number.isSafeInteger(page.limit) ||
      page.total < 0 || page.offset < 0 || page.offset > page.total || page.limit < 1 || page.limit > 32 ||
      data.runs.length > page.limit || page.order !== "FILESYSTEM_RECENCY_HINT" || page.questions_scope !== "THIS_PAGE_ONLY" ||
      !/^[a-f0-9]{64}$/.test(page.inventory_sha256) ||
      (page.next_cursor !== null && (typeof page.next_cursor !== "string" || !/^[A-Za-z0-9_=-]{1,512}$/.test(page.next_cursor))))) throw new Error("Operator pagination is invalid.");
  for (const row of data.runs) {
    if (!row || typeof row.run_id !== "string" || (runId && row.run_id !== runId) ||
        !["working", "waiting", "unhealthy", "completed", "cancelled"].includes(row.status) ||
        row.authority_granted !== false || row.current_acceptance !== "UNKNOWN" ||
        !Array.isArray(row.questions) || row.questions.length > 64 || !Array.isArray(row.diagnostics) ||
        row.diagnostics.some(x => typeof x !== "string") ||
        row.questions.some(q => !q || typeof q.id !== "string" || typeof q.reason !== "string" || typeof q.kind !== "string")) throw new Error("Operator reader returned invalid run data.");
    if (row.currentness === "JOURNAL_VERIFIED_RECORDED_STATE" && (!RUN_ID.test(row.run_id) ||
        !Number.isSafeInteger(row.revision) || row.revision! < 1 || !/^[a-f0-9]{64}$/.test(row.journal_head || ""))) throw new Error("Operator run has no valid journal binding.");
  }
  return data;
}
export type OperatorPage = {limit?: number; cursor?: string};
export type OperatorPendingPhase = "PENDING_RUNTIME" | "PENDING_READER";
export type OperatorObservationState = OperatorPendingPhase | "COMPLETE" | "REFUSED" | "FAILED" | "CLEANUP_UNRESOLVED" | "BUSY" | "UNAVAILABLE";
export type OperatorReader = (source: Source, id: string, runId?: string, page?: OperatorPage, phase?: (value: OperatorPendingPhase) => void) => Promise<OperatorResult>;
export type OperatorObservationBinding = (source: Source, id: string, runId?: string, page?: OperatorPage) => string;
export interface OperatorObservation extends OperatorResult {
  authority_granted: false;
  observation: {id: string | null; state: OperatorObservationState; started_at: string | null};
}
function selectionKey(source: Source, id: string, runId: string | undefined, page: OperatorPage): string {
  if (!safeSegment(source.name) || !safeSegment(id) || (runId !== undefined && !RUN_ID.test(runId))) throw new Error("Invalid operator selection.");
  const limit = page.limit ?? 8;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 ||
      (page.cursor !== undefined && (runId || !/^[A-Za-z0-9_=-]{1,512}$/.test(page.cursor)))) throw new Error("Invalid operator page selection.");
  return JSON.stringify([source.name, source.root, source.projects_dir, id, runId ?? null, limit, page.cursor ?? null]);
}
/** Cheap invalidation only. Equal bindings never certify unchanged project content. */
export function operatorObservationBinding(source: Source, id: string, runId?: string, page: OperatorPage = {}): string {
  selectionKey(source, id, runId, page);
  const index = operatorIndex(source, id);
  const script = operatorScript();
  return JSON.stringify([index, createHash("sha256").update(readFileSync(index)).digest("hex"),
    script, createHash("sha256").update(readFileSync(script)).digest("hex")]);
}
interface ObservationSlot {
  id: string; key: string; binding: string; startedAt: string; running: boolean;
  state: OperatorObservationState; result: OperatorResult; pinned: boolean;
}
/** Two bounded delivery slots for the existing finite reader. Polls never start work. */
export class OperatorObservations {
  private slots: ObservationSlot[] = [];
  constructor(private readonly reader: OperatorReader = readOperator,
    private readonly binding: OperatorObservationBinding = operatorObservationBinding) {}
  private empty(state: OperatorObservationState, diagnostic: string, slot?: ObservationSlot): OperatorObservation {
    return {available:false, report:null, diagnostic, authority_granted:false,
      observation:{id:slot?.id ?? null,state,started_at:slot?.startedAt ?? null}};
  }
  private snapshot(slot: ObservationSlot): OperatorObservation {
    return {...structuredClone(slot.result), authority_granted:false,
      observation:{id:slot.id,state:slot.state,started_at:slot.startedAt}};
  }
  observe(observationId: string, source: Source, id: string, runId?: string, page: OperatorPage = {}): OperatorObservation {
    try {
      const key=selectionKey(source,id,runId,page);
      const slot=this.slots.find(item=>item.id===observationId && item.key===key);
      if (!RUN_ID.test(observationId) || !slot) return this.empty("UNAVAILABLE","This observation is unavailable. Start a new read explicitly.");
      if (this.binding(source,id,runId,page)!==slot.binding) return this.empty("REFUSED","The source registry or reader changed. This observation cannot be displayed.",slot);
      return this.snapshot(slot);
    } catch { return this.empty("REFUSED","The selected source is no longer safe or available."); }
  }
  start(source: Source, id: string, runId?: string, page: OperatorPage = {}): OperatorObservation {
    let key: string, binding: string;
    try { key=selectionKey(source,id,runId,page); binding=this.binding(source,id,runId,page); }
    catch { return this.empty("REFUSED","The selected source is unsafe or unavailable."); }
    const existing=this.slots.find(item=>item.key===key && (item.running || item.pinned));
    if (existing) return this.observe(existing.id,source,id,runId,page);
    if (this.slots.length===2) {
      const retired=this.slots.findIndex(item=>!item.running && !item.pinned);
      if (retired<0) return this.empty("BUSY","Two bounded reads still hold their slots. Observe them or wait for owner cleanup.");
      this.slots.splice(retired,1);
    }
    const slot:ObservationSlot={id:randomUUID(),key,binding,startedAt:new Date().toISOString(),running:true,
      state:"PENDING_RUNTIME",result:{available:false,report:null,diagnostic:null},pinned:false};
    this.slots.push(slot);
    // Attach both continuations before returning. Client disconnect or polling cannot
    // abandon custody, relaunch, or reset either existing helper deadline.
    let pending: Promise<OperatorResult>;
    try { pending=this.reader(source,id,runId,{...page},phase=>{ if(slot.running)slot.state=phase; }); }
    catch(error) { pending=Promise.reject(error); }
    void pending.then(result=>{
      slot.pinned=result.cleanupComplete===false;
      if (Buffer.byteLength(JSON.stringify(result),"utf8")>MAX_OUTPUT_BYTES) throw new Error("Observation report exceeds its output bound.");
      slot.result=structuredClone(result);
      slot.state=slot.pinned?"CLEANUP_UNRESOLVED":result.available?"COMPLETE":result.report?"REFUSED":"FAILED";
    }).catch(error=>{
      if(error instanceof HelperCustodyError && !error.cleanupComplete)slot.pinned=true;
      slot.result={available:false,report:null,diagnostic:error instanceof HelperCustodyError?error.message.slice(0,2048):"Operator observation failed.",cleanupComplete:!slot.pinned};
      slot.state=slot.pinned?"CLEANUP_UNRESOLVED":"FAILED";
    }).finally(()=>{slot.running=false;});
    return this.snapshot(slot);
  }
}

let inFlight = 0;
export async function readOperator(source: Source, id: string, runId?: string, page: OperatorPage = {}, phase?: (value: OperatorPendingPhase) => void): Promise<OperatorResult> {
  if (inFlight >= 2) return {available: false, report: null, diagnostic: "Two reads are in progress. Refresh after they finish."};
  inFlight++;
  let cleanupComplete=true;
  try {
    if (runId && !RUN_ID.test(runId)) throw new Error("Invalid run identity.");
    const index = operatorIndex(source, id);
    const limit = page.limit ?? 8;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 ||
        (page.cursor !== undefined && (runId || !/^[A-Za-z0-9_=-]{1,512}$/.test(page.cursor)))) throw new Error("Invalid operator page selection.");
    const script = operatorScript();
    const before = createHash("sha256").update(readFileSync(script)).digest("hex");
    // Use the same owned runtime verifier as every Python-backed Console action,
    // with a finite asynchronous boundary around both resolution and journal read.
    phase?.("PENDING_RUNTIME");
    const python = (await boundedCommand("bash", [resolve(import.meta.dir, "../scripts/python-runtime.sh"), "resolve"], READ_TIMEOUT_MS, "Runtime verification")).trim();
    if (!isAbsolute(python) || python.includes("\n") ||
        (process.env.SYNTHESIS_PYTHON_BIN?.trim() && process.env.SYNTHESIS_PYTHON_BIN.trim() !== python)) throw new Error("Verified Python runtime selection differs. Ask your agent to repair Console setup.");
    phase?.("PENDING_READER");
    const output = await boundedCommand(python, ["-I", "-B", script, "--index", index, "--project-id", id,
      "--limit", String(limit), ...(page.cursor ? ["--cursor", page.cursor] : []), ...(runId ? ["--run-id", runId] : [])]);
    const report = validateReport(JSON.parse(output), "", script, runId, {path: index, id});
    if (before !== report.helper.sha256) throw new Error("Operator reader changed during this read. Refresh after the update completes.");
    if (!["PASS", "LOCAL_RECOVERABLE"].includes(report.resolution!.status) || !report.project) return {available: false, report,
      diagnostic: "Project resolution " + report.resolution!.status + ": " + (report.resolution!.issues.join("; ") || "No current readable project was selected.")};
    return {available: true, report, diagnostic: null};
  } catch (error) {
    if(error instanceof HelperCustodyError)cleanupComplete=error.cleanupComplete;
    return {available: false, report: null, diagnostic: error instanceof Error ? error.message : "Operator read unavailable.", cleanupComplete};
  } finally { if(cleanupComplete)inFlight--; }
}

/** Preparation only: execute through the existing authenticated native owner. */
export function prepareControl(run: OperatorRun, action: "resume" | "cancel", reason: string, requestId: string) {
  if (["completed", "cancelled", "incomplete"].includes(run.recorded_status) || run.currentness !== "JOURNAL_VERIFIED_RECORDED_STATE" || !RUN_ID.test(run.run_id) || !RUN_ID.test(requestId) ||
      !Number.isSafeInteger(run.revision) || !run.project_id || !reason.trim() || reason.length > 2048) throw new Error("A control needs an exact verified recorded run and reason.");
  return {schema_version: 1, request_id: requestId, operation: action === "cancel" ? "cancel" : "recover",
    project_id: run.project_id, run_id: run.run_id, expected_revision: run.revision,
    input: action === "cancel" ? {reason, target: "run"} : {reconcile_sources: true}};
}
