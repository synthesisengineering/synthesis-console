/** Fixed Docker custody transport. This module grants no PM/native authority. */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { constants as F, openSync, closeSync, fstatSync, readSync, lstatSync, realpathSync, mkdtempSync, mkdirSync, writeFileSync, chmodSync, unlinkSync, rmdirSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
type Mount = {
    kind: 'workspace' | 'native-state' | 'pm-state' | 'inputs';
    source: string;
    target: string;
    writable: boolean;
    device: number;
    inode: number;
};
export type Enrollment = {
    schema_version: 1;
    backend: 'docker-linux-muse-v1';
    image: string;
    platform: 'linux/arm64' | 'linux/amd64';
    docker: {
        path: string;
        sha256: string;
        socket: string;
        engine_id: string;
    };
    native: {
        path: '/opt/synthesis/muse';
        sha256: string;
        helper_kind: 'embedded';
        helper_sha256: string;
    };
    init: {
        path: '/opt/synthesis/container-init.py';
        sha256: string;
    };
    policy: {
        path: string;
        sha256: string;
    };
    mounts: Mount[];
    workspace: string;
    uid: number;
    gid: number;
    network: 'none';
    limits: {
        memory_bytes: number;
        pids: number;
        cpus: number;
        wall_ms: number;
        heartbeat_ms: number;
        max_io_bytes: number;
    };
};
export type Admission = {
    schema_version: 1;
    run_id: string;
    permit_id: string;
    revision: number;
    enrollment_sha256: string;
    expires_at_ms: number;
};
export type CustodyEvent = {
    phase: 'planned' | 'created' | 'started' | 'stopped' | 'removed' | 'uncertain';
    name: string;
    nonce: string;
    container_id: string | null;
    enrollment_sha256: string;
    run_id: string;
    permit_id: string;
    revision: number;
};
export type OwnerHooks = {
    isCurrent: () => boolean | Promise<boolean>;
    record: (event: CustodyEvent) => void | Promise<void>;
};
export type CustodyReceipt = {
    status: 'stopped' | 'failed' | 'uncertain';
    reason: string;
    container_id: string | null;
    name: string;
    removed: boolean;
    stopped_verified: boolean;
    native_started: boolean;
    task_accepted: false;
    native_acceptance: 'UNASSESSED';
    terminal: any | null;
};
const HASH = /^[a-f0-9]{64}$/, ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const CHILD_BUDGET = 1048576, FRAME_MAX = 100000, COMMAND_MS = 5000;
// This backend generation retains the observed Docker 29 Linux path policy.
// A future qualified proc-layout backend must declare a new policy generation;
// an empty/relaxed daemon default cannot silently alter this one.
const MASKED_PATHS = ['/proc/acpi', '/proc/asound', '/proc/interrupts', '/proc/kcore', '/proc/keys', '/proc/latency_stats', '/proc/sched_debug', '/proc/scsi', '/proc/timer_list', '/proc/timer_stats', '/sys/devices/virtual/powercap', '/sys/firmware'];
const READONLY_PATHS = ['/proc/bus', '/proc/fs', '/proc/irq', '/proc/sys', '/proc/sysrq-trigger'];
function closed(x: any, names: string[]) { return x && typeof x === 'object' && !Array.isArray(x) && Object.getPrototypeOf(x) === Object.prototype && Object.keys(x).sort().join('|') === names.sort().join('|'); }
function int(x: any, lo: number, hi: number) { return Number.isSafeInteger(x) && x >= lo && x <= hi; }
function path(x: any) { return typeof x === 'string' && x.length <= 4096 && x.startsWith('/') && posix.normalize(x) === x && !/[\0\r\n,]/.test(x); }
function hash(x: any) { return typeof x === 'string' && HASH.test(x); }
function fail(message: string): never { throw new Error(message); }
function canonical(value: any): string {
    if (Array.isArray(value))
        return '[' + value.map(canonical).join(',') + ']';
    if (value && typeof value === 'object')
        return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
    return JSON.stringify(value);
}
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
export function enrollmentDigest(value: Enrollment) { return sha(canonical(validateEnrollment(value))); }
export function validateEnrollment(x: any): Enrollment {
    if (!closed(x, ['schema_version', 'backend', 'image', 'platform', 'docker', 'native', 'init', 'policy', 'mounts', 'workspace', 'uid', 'gid', 'network', 'limits']) || x.schema_version !== 1 || x.backend !== 'docker-linux-muse-v1')
        fail('Closed enrolled backend required.');
    if (typeof x.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(x.image) || !['linux/arm64', 'linux/amd64'].includes(x.platform) || x.network !== 'none')
        fail('Unqualified image, architecture or network.');
    if (!closed(x.docker, ['path', 'sha256', 'socket', 'engine_id']) || !path(x.docker.path) || !hash(x.docker.sha256) || !path(x.docker.socket) || typeof x.docker.engine_id !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(x.docker.engine_id))
        fail('Exact Docker identity required.');
    if (!closed(x.native, ['path', 'sha256', 'helper_kind', 'helper_sha256']) || x.native.path !== '/opt/synthesis/muse' || !hash(x.native.sha256) || x.native.helper_kind !== 'embedded' || x.native.helper_sha256 !== x.native.sha256)
        fail('Exact embedded native helper required.');
    if (!closed(x.init, ['path', 'sha256']) || x.init.path !== '/opt/synthesis/container-init.py' || !hash(x.init.sha256) || !closed(x.policy, ['path', 'sha256']) || !path(x.policy.path) || !hash(x.policy.sha256))
        fail('Exact init and policy required.');
    if (!path(x.workspace) || x.workspace === '/' || !int(x.uid, 1, 2147483647) || !int(x.gid, 1, 2147483647))
        fail('Nonroot identity and workspace required.');
    const l = x.limits;
    if (!closed(l, ['memory_bytes', 'pids', 'cpus', 'wall_ms', 'heartbeat_ms', 'max_io_bytes']) || !int(l.memory_bytes, 67108864, 4294967296) || !int(l.pids, 16, 256) || typeof l.cpus !== 'number' || !Number.isFinite(l.cpus) || l.cpus < .1 || l.cpus > 4 || !int(l.wall_ms, 500, 600000) || !int(l.heartbeat_ms, 100, 10000) || l.heartbeat_ms >= l.wall_ms || !int(l.max_io_bytes, 4096, 67108864))
        fail('Finite resource envelope required.');
    if (!Array.isArray(x.mounts) || x.mounts.length > 16)
        fail('Bounded explicit mounts required.');
    const forbidden = ['/', '/Users', '/home', '/private', '/private/tmp', '/private/var', '/private/var/folders', '/tmp', '/var', realpathSync(tmpdir()), '/etc', '/opt', '/run', homedir(), dirname(homedir()), join(homedir(), 'workspaces')];
    for (const m of x.mounts) {
        if (!closed(m, ['kind', 'source', 'target', 'writable', 'device', 'inode']) || !['workspace', 'native-state', 'pm-state', 'inputs'].includes(m.kind) || !path(m.source) || !path(m.target) || typeof m.writable !== 'boolean' || !int(m.device, 0, Number.MAX_SAFE_INTEGER) || !int(m.inode, 1, Number.MAX_SAFE_INTEGER) || forbidden.includes(m.source) || m.target === '/' || ['/opt', '/usr', '/bin', '/sbin', '/lib', '/lib64', '/etc', '/proc', '/sys', '/dev', '/tmp'].some(p => m.target === p || m.target.startsWith(p + '/')) || m.source.endsWith('.sock'))
            fail('Unsafe or untyped mount.');
        if (m.kind === 'inputs' && m.writable)
            fail('Input mounts are read-only.');
        if (m.kind === 'workspace' && m.target !== x.workspace)
            fail('Workspace mount differs.');
    }
    for (let i = 0; i < x.mounts.length; i++)
        for (let j = i + 1; j < x.mounts.length; j++) {
            const a = x.mounts[i].target, b = x.mounts[j].target;
            if (a === b || a.startsWith(b + '/') || b.startsWith(a + '/'))
                fail('Overlapping mount targets.');
        }
    return x;
}
export function validateAdmission(x: any, digest: string): Admission {
    if (!closed(x, ['schema_version', 'run_id', 'permit_id', 'revision', 'enrollment_sha256', 'expires_at_ms']) || x.schema_version !== 1 || typeof x.run_id !== 'string' || !ID.test(x.run_id) || typeof x.permit_id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(x.permit_id) || !int(x.revision, 0, Number.MAX_SAFE_INTEGER) || x.enrollment_sha256 !== digest || !int(x.expires_at_ms, Date.now() + 1, Date.now() + 600000))
        fail('Current exact owner admission required.');
    return x;
}
function stableFile(p: string, max: number, capture = true): {
    digest: string;
    bytes: Buffer;
} {
    if (realpathSync(p) !== p)
        fail('Artifact path crosses a symlink.');
    const fd = openSync(p, F.O_RDONLY | F.O_NOFOLLOW | F.O_NONBLOCK);
    try {
        const a = fstatSync(fd);
        if (!a.isFile() || a.nlink !== 1 || a.size > max || (a.mode & 0o022))
            fail('Artifact custody refused.');
        const pieces: Buffer[] = [];
        let count = 0;
        const digest = createHash('sha256');
        for (;;) {
            const b = Buffer.alloc(Math.min(65536, max - count + 1));
            const n = readSync(fd, b, 0, b.length, null);
            if (!n)
                break;
            count += n;
            if (count > max)
                fail('Artifact grew beyond bound.');
            digest.update(b.subarray(0, n));
            if (capture)
                pieces.push(b.subarray(0, n));
        }
        const b = fstatSync(fd), c = lstatSync(p);
        if (a.ino !== b.ino || a.dev !== b.dev || a.size !== b.size || a.mtimeMs !== b.mtimeMs || a.ctimeMs !== b.ctimeMs || a.ino !== c.ino || a.dev !== c.dev || count !== a.size)
            fail('Artifact changed.');
        return { digest: digest.digest('hex'), bytes: Buffer.concat(pieces) };
    }
    finally {
        closeSync(fd);
    }
}
function mountCurrent(m: Mount) {
    if (realpathSync(m.source) !== m.source)
        fail('Mount symlink refused.');
    const s = lstatSync(m.source);
    if ((!s.isDirectory() && !s.isFile()) || s.dev !== m.device || s.ino !== m.inode || s.uid !== process.getuid?.())
        fail('Mount identity changed.');
}
function cleanEnv() { const e: NodeJS.ProcessEnv = { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' }; return e; }
async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> { let timer: ReturnType<typeof setTimeout>; return Promise.race([promise, new Promise<T>((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer!)); }
async function command(binary: string, args: string[], max = CHILD_BUDGET): Promise<{
    code: number | null;
    out: string;
    err: string;
}> {
    return new Promise((done, reject) => {
        const child = spawn(binary, args, { env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'], shell: false });
        let out = '', err = '', size = 0, ended = false;
        const finish = (code: number | null, error?: Error) => {
            if (ended)
                return;
            ended = true;
            clearTimeout(timer);
            child.stdout?.destroy();
            child.stderr?.destroy();
            error ? reject(error) : done({ code, out, err });
        };
        const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null, new Error('Docker command timeout.')); }, COMMAND_MS);
        for (const [stream, isOut] of [[child.stdout, true], [child.stderr, false]] as const)
            stream.on('data', (b: Buffer) => {
                size += b.length;
                if (size > max) {
                    child.kill('SIGKILL');
                    finish(null, new Error('Docker command output bound.'));
                }
                else if (isOut)
                    out += b.toString();
                else
                    err += b.toString();
            });
        child.on('error', () => finish(null, new Error('Docker command unavailable.')));
        child.on('close', code => finish(code));
    });
}
export function buildCreateArgs(e: Enrollment, name: string, nonce: string, policy: string): string[] {
    validateEnrollment(e);
    if (!/^synthesis-ap-[a-f0-9]{32}$/.test(name) || !/^[a-f0-9]{32}$/.test(nonce) || !path(policy))
        fail('Invalid owned launch identity.');
    const args = ['container', 'create', '--pull=never', '--name', name, '--label', 'org.synthesis.custody=' + nonce, '--platform', e.platform, '--network=none', '--ipc=private', '--cgroupns=private', '--cap-drop=ALL', '--security-opt', 'no-new-privileges:true', '--security-opt', 'seccomp=' + policy, '--read-only', '--user', e.uid + ':' + e.gid, '--memory', String(e.limits.memory_bytes), '--memory-swap', String(e.limits.memory_bytes), '--cpus', String(e.limits.cpus), '--pids-limit', String(e.limits.pids), '--restart=no', '--stop-timeout=1', '--no-healthcheck', '--log-driver=local', '--log-opt', 'max-size=1m', '--log-opt', 'max-file=1', '--log-opt', 'compress=false', '--tmpfs', '/tmp:rw,noexec,nosuid,size=16777216,mode=1777', '--interactive', '--workdir', e.workspace, '--entrypoint', '/usr/local/bin/python3'];
    for (const m of e.mounts)
        args.push('--mount', 'type=bind,src=' + m.source + ',dst=' + m.target + ',bind-propagation=rprivate' + (m.writable ? '' : ',readonly'));
    for (const key of ['LD_PRELOAD', 'LD_LIBRARY_PATH', 'PYTHONPATH', 'PYTHONHOME'])
        args.push('--env', key + '=');
    args.push(e.image, '-I', '-B', e.init.path);
    return args;
}
export function validateCreated(c: any, e: Enrollment, name: string, nonce: string, policy?: any) {
    if (!c || typeof c.Id !== 'string' || !HASH.test(c.Id) || c.Name !== '/' + name || c.Image !== e.image || c.Config?.Labels?.['org.synthesis.custody'] !== nonce)
        fail('Foreign or changed container identity.');
    const h = c.HostConfig, config = c.Config;
    if (!Array.isArray(h?.MaskedPaths) || !Array.isArray(h?.ReadonlyPaths) || canonical([...h.MaskedPaths].sort()) !== canonical([...MASKED_PATHS].sort()) || canonical([...h.ReadonlyPaths].sort()) !== canonical([...READONLY_PATHS].sort()))
        fail('Protected system path policy differs.');
    if (!h || h.Privileged !== false || h.ReadonlyRootfs !== true || h.NetworkMode !== 'none' || h.IpcMode !== 'private' || h.CgroupnsMode !== 'private' || h.UTSMode || h.PidMode || h.UsernsMode || h.RestartPolicy?.Name !== 'no' || h.AutoRemove !== false || h.Memory !== e.limits.memory_bytes || h.MemorySwap !== e.limits.memory_bytes || h.PidsLimit !== e.limits.pids || h.NanoCpus !== Math.round(e.limits.cpus * 1e9) || canonical(h.CapDrop) !== '["ALL"]' || (h.CapAdd?.length ?? 0) !== 0 || (h.Devices?.length ?? 0) !== 0 || (h.DeviceRequests?.length ?? 0) !== 0 || (h.Binds?.length ?? 0) !== 0 || config.User !== e.uid + ':' + e.gid || canonical(config.Entrypoint) !== '["/usr/local/bin/python3"]' || canonical(config.Cmd) !== canonical(['-I', '-B', e.init.path]) || config.WorkingDir !== e.workspace || config.Tty !== false || config.OpenStdin !== true)
        fail('Container confinement differs.');
    const security = h.SecurityOpt;
    if (!Array.isArray(security) || security.length !== 2 || !security.some((s: string) => s === 'no-new-privileges:true' || s === 'no-new-privileges'))
        fail('Confinement options differ.');
    if (policy) {
        const sec = security.find((s: string) => s.startsWith('seccomp='));
        if (!sec || canonical(JSON.parse(sec.slice(8))) !== canonical(policy))
            fail('Seccomp profile differs.');
    }
    if (config.Healthcheck?.Test?.[0] !== 'NONE' || h.LogConfig?.Type !== 'local' || h.LogConfig.Config?.['max-file'] !== '1' || h.LogConfig.Config?.['max-size'] !== '1m' || h.LogConfig.Config?.compress !== 'false')
        fail('Runtime side effects or logs differ.');
    if (!h.Tmpfs || Object.keys(h.Tmpfs).length !== 1 || h.Tmpfs['/tmp'] !== 'rw,noexec,nosuid,size=16777216,mode=1777')
        fail('Temporary filesystem differs.');
    if (!Array.isArray(c.Mounts) || c.Mounts.length !== e.mounts.length)
        fail('Unexpected container mount.');
    for (const m of e.mounts) {
        const actual = c.Mounts.find((v: any) => v.Destination === m.target);
        if (!actual || actual.Type !== 'bind' || actual.Source !== m.source || actual.RW !== m.writable || actual.Propagation !== 'rprivate')
            fail('Mount binding differs.');
    }
    return c;
}
/** Instantiation is inert. Only the explicit owner-side open() performs effects. */
export class ContainerBackend {
    async open(raw: Enrollment, auth: Admission, hooks: OwnerHooks): Promise<ContainerSession> {
        const e = JSON.parse(JSON.stringify(validateEnrollment(raw))) as Enrollment, digest = enrollmentDigest(e), a = JSON.parse(JSON.stringify(validateAdmission(auth, digest))) as Admission;
        if (!hooks || typeof hooks.isCurrent !== 'function' || typeof hooks.record !== 'function')
            fail('Existing owner integration required.');
        const work = mkdtempSync(join(realpathSync(tmpdir()), 'synthesis-container-'));
        chmodSync(work, 0o700);
        mkdirSync(join(work, 'docker'), { mode: 0o700 });
        const name = 'synthesis-ap-' + randomBytes(16).toString('hex'), nonce = randomBytes(16).toString('hex');
        const session = new ContainerSession(e, a, hooks, work, name, nonce);
        await session.begin();
        return session;
    }
}
export class ContainerSession {
    readonly ready: Promise<void>;
    readonly finished: Promise<CustodyReceipt>;
    private readyResolve!: () => void;
    private readyReject!: (error: Error) => void;
    private finishResolve!: (result: CustodyReceipt) => void;
    private id: string | null = null;
    private child: ChildProcessWithoutNullStreams | null = null;
    private ending = false;
    private attemptedCreate = false;
    private nativeStarted = false;
    private readySeen = false;
    private seq = 0;
    private total = 0;
    private framesSize = 0;
    private waiters: ((value: IteratorResult<{
        channel: string;
        data: Buffer;
    }>) => void)[] = [];
    private outputQueue: {
        channel: string;
        data: Buffer;
    }[] = [];
    private timer: ReturnType<typeof setInterval> | null = null;
    private watchdog: ReturnType<typeof setTimeout> | null = null;
    private heartbeating = false;
    private terminal: any = null;
    private policy: any = null;
    constructor(private e: Enrollment, private a: Admission, private hooks: OwnerHooks, private work: string, readonly name: string, readonly nonce: string) {
        this.ready = new Promise((resolve, reject) => { this.readyResolve = resolve; this.readyReject = reject; });
        void this.ready.catch(() => { });
        this.finished = new Promise(resolve => { this.finishResolve = resolve; });
    }
    private event(phase: CustodyEvent['phase']): CustodyEvent { return { phase, name: this.name, nonce: this.nonce, container_id: this.id, enrollment_sha256: this.a.enrollment_sha256, run_id: this.a.run_id, permit_id: this.a.permit_id, revision: this.a.revision }; }
    private admissionCurrent() {
        if (Date.now() >= this.a.expires_at_ms)
            fail('Owner admission is no longer current.');
    }
    private async current() {
        this.admissionCurrent();
        const current = await bounded(Promise.resolve(this.hooks.isCurrent()), Math.min(1000, this.e.limits.heartbeat_ms / 2), 'Owner check expired.');
        // Awaiting the actual owner fence can consume the admission lifetime.
        this.admissionCurrent();
        if (!current)
            fail('Owner admission is no longer current.');
    }
    private async record(phase: CustodyEvent['phase']) { await bounded(Promise.resolve(this.hooks.record(this.event(phase))), 2000, 'Owner receipt deadline.'); }
    private async docker(args: string[]) {
        if (stableFile(this.e.docker.path, 536870912, false).digest !== this.e.docker.sha256)
            fail('Docker executable changed.');
        if (args[0] === 'container' && args[1] === 'create')
            this.admissionCurrent();
        return command(this.e.docker.path, ['--host', 'unix://' + this.e.docker.socket, '--config', join(this.work, 'docker'), ...args]);
    }
    private async inspect(target = this.id || this.name) {
        const r = await this.docker(['container', 'inspect', target]);
        if (r.code !== 0)
            throw new Error('Container readback unavailable.');
        const rows = JSON.parse(r.out);
        if (!Array.isArray(rows) || rows.length !== 1)
            fail('Ambiguous container readback.');
        return validateCreated(rows[0], this.e, this.name, this.nonce, this.policy);
    }
    async begin() {
        try {
            await this.current();
            if (stableFile(this.e.docker.path, 536870912, false).digest !== this.e.docker.sha256)
                fail('Docker executable changed.');
            // Bun on Darwin refuses realpath(socket); resolve the parent and lstat the
            // leaf so a socket symlink still cannot substitute the enrolled endpoint.
            if (realpathSync(dirname(this.e.docker.socket)) !== dirname(this.e.docker.socket) || !lstatSync(this.e.docker.socket).isSocket())
                fail('Docker endpoint differs.');
            const checked = stableFile(this.e.policy.path, 1048576), bytes = checked.bytes;
            if (checked.digest !== this.e.policy.sha256)
                fail('Selected seccomp changed.');
            this.policy = JSON.parse(bytes.toString());
            if (this.policy.defaultAction !== 'SCMP_ACT_ERRNO' || !Array.isArray(this.policy.syscalls) || this.policy.syscalls.some((r: any) => r.action === 'SCMP_ACT_NOTIFY' || r.action === 'SCMP_ACT_TRACE' || r.names?.includes('*')))
                fail('Default-deny reviewed seccomp required.');
            for (const m of this.e.mounts)
                mountCurrent(m);
            writeFileSync(join(this.work, 'seccomp.json'), bytes, { mode: 0o600, flag: 'wx' });
            const info = await this.docker(['info', '--format', '{{json .}}']);
            if (info.code !== 0)
                fail('Docker engine unavailable.');
            const facts = JSON.parse(info.out);
            if (facts.ID !== this.e.docker.engine_id || facts.OSType !== 'linux')
                fail('Docker engine identity differs.');
            const image = await this.docker(['image', 'inspect', this.e.image]);
            if (image.code !== 0)
                fail('Pinned image is not local.');
            const images = JSON.parse(image.out), im = images[0];
            if (images.length !== 1 || im.Id !== this.e.image || im.Os !== 'linux' || im.Architecture !== this.e.platform.split('/')[1] || Object.keys(im.Config?.Volumes || {}).length)
                fail('Image identity or implicit volumes differ.');
            await this.current();
            await this.record('planned');
            await this.current();
            this.attemptedCreate = true;
            const created = await this.docker(buildCreateArgs(this.e, this.name, this.nonce, join(this.work, 'seccomp.json')));
            if (created.code !== 0 || !HASH.test(created.out.trim()))
                fail('Create result uncertain.');
            this.id = created.out.trim();
            await this.inspect();
            for (const m of this.e.mounts)
                mountCurrent(m);
            await this.record('created');
            await this.current();
            for (const m of this.e.mounts)
                mountCurrent(m);
            if (stableFile(this.e.docker.path, 536870912, false).digest !== this.e.docker.sha256)
                fail('Docker executable changed.');
            this.admissionCurrent();
            this.child = spawn(this.e.docker.path, ['--host', 'unix://' + this.e.docker.socket, '--config', join(this.work, 'docker'), 'container', 'start', '--attach', '--interactive', this.id], { env: cleanEnv(), stdio: ['pipe', 'pipe', 'pipe'], shell: false });
            let raw = Buffer.alloc(0), diagnosticBytes = 0;
            this.child.stdout.on('data', (b: Buffer) => {
                if (this.ending)
                    return;
                raw = Buffer.concat([raw, b]);
                if (raw.length > CHILD_BUDGET) {
                    void this.finish('transport_output_limit');
                    return;
                }
                for (;;) {
                    const n = raw.indexOf(10);
                    if (n < 0)
                        break;
                    const line = raw.subarray(0, n);
                    raw = raw.subarray(n + 1);
                    if (line.length > FRAME_MAX) {
                        void this.finish('transport_frame_limit');
                        return;
                    }
                    try {
                        this.receive(JSON.parse(line.toString()));
                    }
                    catch {
                        void this.finish('invalid_transport_frame');
                        return;
                    }
                }
            });
            this.child.stderr.on('data', (b: Buffer) => {
                diagnosticBytes += b.length;
                if (diagnosticBytes > CHILD_BUDGET)
                    void this.finish('transport_diagnostic_limit');
            });
            this.child.on('error', () => { void this.finish('transport_error'); });
            this.child.on('exit', () => { setTimeout(() => { void this.finish(this.terminal ? 'terminal' : 'transport_exit_without_terminal'); }, 50); });
            this.watchdog = setTimeout(() => { void this.finish('host_deadline'); }, this.e.limits.wall_ms + 5000);
            this.timer = setInterval(() => { void this.heartbeat(); }, Math.max(25, Math.floor(this.e.limits.heartbeat_ms / 3)));
            await this.writeFrame({ type: 'configure', schema_version: 1, nonce: this.nonce, workspace: this.e.workspace, native_sha256: this.e.native.sha256, init_sha256: this.e.init.sha256, ...{ wall_ms: this.e.limits.wall_ms, heartbeat_ms: this.e.limits.heartbeat_ms, max_io_bytes: this.e.limits.max_io_bytes } }, false);
            void bounded(this.ready, 5000, 'Native init unavailable.').catch(() => this.finish('native_init_timeout'));
        }
        catch (error) {
            await this.finish('admission_or_create_failed');
            throw Object.assign(new Error('Container admission failed; inspect the retained custody receipt.', { cause: error }), { receipt: await this.finished });
        }
    }
    private receive(row: any) {
        if (!row || row.nonce !== this.nonce)
            fail('Wrong transport nonce.');
        if (row.type === 'ready') {
            if (!closed(row, ['type', 'nonce', 'native_pid', 'task_accepted']) || !int(row.native_pid, 2, 2147483647) || row.task_accepted !== false || this.readySeen)
                fail('Invalid ready frame.');
            this.readySeen = true;
            this.nativeStarted = true;
            void this.record('started').then(() => this.readyResolve()).catch(() => this.finish('owner_receipt_failed'));
            return;
        }
        if (row.type === 'native_output') {
            if (!this.readySeen || !closed(row, ['type', 'nonce', 'channel', 'data']) || !['stdout', 'stderr'].includes(row.channel) || typeof row.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(row.data))
                fail('Invalid native output frame.');
            const data = Buffer.from(row.data, 'base64');
            this.total += data.length;
            if (data.length > 32768 || this.total > this.e.limits.max_io_bytes)
                fail('Native output budget.');
            const waiter = this.waiters.shift();
            if (waiter)
                waiter({ value: { channel: row.channel, data }, done: false });
            else {
                this.framesSize += data.length;
                if (this.framesSize > CHILD_BUDGET)
                    fail('Native consumer backpressure.');
                this.outputQueue.push({ channel: row.channel, data });
            }
            return;
        }
        if (row.type === 'terminal') {
            if (!closed(row, ['type', 'nonce', 'reason', 'native_exit_code', 'task_accepted']) || row.task_accepted !== false || !['native_exit', 'cancelled', 'owner_finished', 'deadline', 'owner_lost', 'invalid_owner_frame', 'input_frame_limit', 'input_budget', 'output_budget', 'output_backpressure', 'output_incomplete', 'pipe_lost', 'host_signal'].includes(row.reason) || !(row.native_exit_code === null || int(row.native_exit_code, -255, 255)) || this.terminal)
                fail('Invalid terminal frame.');
            this.terminal = row;
            return;
        }
        fail('Unknown transport frame.');
    }
    private async writeFrame(row: any, sequence = true) {
        if (this.ending || !this.child)
            fail('Transport is closed.');
        if (sequence)
            row = { ...row, nonce: this.nonce, seq: ++this.seq };
        const bytes = Buffer.from(JSON.stringify(row) + '\n');
        if (bytes.length > FRAME_MAX)
            fail('Input frame too large.');
        const stream = this.child.stdin;
        if (stream.destroyed || stream.writableLength + bytes.length > CHILD_BUDGET)
            fail('Input backpressure.');
        // Cancellation and finish remain available after authority expires.
        if (['configure', 'heartbeat', 'native_input'].includes(row.type))
            this.admissionCurrent();
        await bounded(new Promise<void>((resolve, reject) => { stream.write(bytes, error => error ? reject(new Error('Input write failed.')) : resolve()); }), Math.min(1000, this.e.limits.heartbeat_ms), 'Input write deadline.');
    }
    private async heartbeat() {
        if (this.ending || this.heartbeating)
            return;
        this.heartbeating = true;
        try {
            await this.current();
            await this.writeFrame({ type: 'heartbeat' });
        }
        catch {
            void this.finish('owner_lost');
        }
        finally {
            this.heartbeating = false;
        }
    }
    async send(bytes: Buffer) {
        await this.ready;
        await this.current();
        if (!Buffer.isBuffer(bytes) || bytes.length > 65536)
            fail('Bounded native bytes required.');
        this.total += bytes.length;
        if (this.total > this.e.limits.max_io_bytes) {
            void this.finish('input_budget');
            fail('Native IO budget.');
        }
        try {
            await this.writeFrame({ type: 'native_input', data: bytes.toString('base64') });
        }
        catch {
            void this.finish('input_write_uncertain');
            throw new Error('Native input delivery uncertain; never replay automatically.');
        }
    }
    async *output(): AsyncGenerator<{
        channel: string;
        data: Buffer;
    }> {
        for (;;) {
            let next: IteratorResult<{
                channel: string;
                data: Buffer;
            }>;
            if (this.outputQueue.length) {
                const row = this.outputQueue.shift()!;
                this.framesSize -= row.data.length;
                next = { value: row, done: false };
            }
            else if (this.ending)
                return;
            else
                next = await new Promise(resolve => this.waiters.push(resolve));
            if (next.done)
                return;
            yield next.value;
        }
    }
    async close() {
        try {
            await this.writeFrame({ type: 'finish' });
        }
        catch { }
        await this.finish('owner_finished');
        return this.finished;
    }
    async cancel() {
        try {
            await this.writeFrame({ type: 'cancel' });
        }
        catch { }
        await this.finish('cancelled');
        return this.finished;
    }
    private async finish(reason: string) {
        if (this.ending)
            return;
        this.ending = true;
        if (this.timer)
            clearInterval(this.timer);
        if (this.watchdog)
            clearTimeout(this.watchdog);
        this.readyReject(new Error('Native transport ended before readiness.'));
        if (this.child) {
            this.child.stdin.destroy();
            this.child.stdout.destroy();
            this.child.stderr.destroy();
            this.child.kill('SIGKILL');
        }
        for (const waiter of this.waiters.splice(0))
            waiter({ done: true, value: undefined });
        let stopped = false, removed = false, unknown = false;
        try {
            if (!this.attemptedCreate)
                throw new Error('No container effect attempted.');
            // Even an uncertain create is reconciled once by its unique name and label.
            const c = await this.inspect();
            this.id = c.Id;
            if (c.State?.Running) {
                try {
                    await this.docker(['container', 'kill', '--signal', 'KILL', this.id!]);
                }
                catch { /* Exact stopped-state readback below resolves a concurrent natural exit or uncertain signal delivery. */ }
            }
            const ended = await this.inspect();
            if (ended.State?.Running !== false || ended.State?.Pid !== 0 || ended.State?.Paused || ended.State?.Restarting)
                fail('Container did not stop.');
            stopped = true;
            await this.record('stopped');
            const removal = await this.docker(['container', 'rm', this.id!]);
            if (removal.code !== 0 || removal.out.trim() !== this.id)
                fail('Removal uncertain.');
            const absent = await this.docker(['container', 'inspect', this.id!]);
            if (absent.code === 0 || !absent.err.includes('No such'))
                fail('Removal readback unavailable.');
            removed = true;
            await this.record('removed');
        }
        catch {
            unknown = this.attemptedCreate;
            if (unknown)
                try {
                    await this.record('uncertain');
                }
                catch { }
        }
        const ordinary = this.nativeStarted && (reason === 'owner_finished' || reason === 'cancelled' || (reason === 'terminal' && this.terminal?.reason === 'native_exit' && this.terminal.native_exit_code === 0));
        const receipt: CustodyReceipt = { status: unknown ? 'uncertain' : ordinary ? 'stopped' : 'failed', reason, container_id: this.id, name: this.name, removed, stopped_verified: stopped, native_started: this.nativeStarted, task_accepted: false, native_acceptance: 'UNASSESSED', terminal: this.terminal };
        if (!unknown) {
            // Each exact path is independent: a pre-policy refusal must not
            // leave a new empty work directory on every failed admission.
            for (const [target, directory] of [[join(this.work, 'seccomp.json'), false], [join(this.work, 'docker'), true], [this.work, true]] as const) {
                try {
                    directory ? rmdirSync(target) : unlinkSync(target);
                }
                catch { /* unexpected retained bytes remain non-authoritative */ }
            }
        }
        this.finishResolve(receipt);
    }
}
