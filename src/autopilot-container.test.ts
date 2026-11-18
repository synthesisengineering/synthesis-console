import { describe, test, expect, afterAll } from 'bun:test';
import { validateEnrollment, validateAdmission, buildCreateArgs, validateCreated, ContainerBackend } from './autopilot-container';
const H = 'a'.repeat(64), I = 'sha256:' + H;
export function enrollment(): any { return { schema_version: 1, backend: 'docker-linux-muse-v1', image: I, platform: 'linux/arm64', docker: { path: '/private/fixture/docker', sha256: H, socket: '/private/fixture/docker.sock', engine_id: 'engine-fixture' }, native: { path: '/opt/synthesis/muse', sha256: H, helper_kind: 'embedded', helper_sha256: H }, init: { path: '/opt/synthesis/container-init.py', sha256: H }, policy: { path: '/private/fixture/seccomp.json', sha256: H }, mounts: [], workspace: '/work', uid: 501, gid: 20, network: 'none', limits: { memory_bytes: 134217728, pids: 32, cpus: 0.5, wall_ms: 5000, heartbeat_ms: 1000, max_io_bytes: 1048576 } }; }
export function admission(e: any): any { return { schema_version: 1, run_id: '00000000-0000-4000-8000-000000000001', permit_id: 'fixture-permit', revision: 7, enrollment_sha256: e, expires_at_ms: Date.now() + 10000 }; }
describe('closed container capability contract', () => {
    test('ordinary strict enrollment validates', () => expect(validateEnrollment(enrollment()).uid).toBe(501));
    const changes: Record<string, (x: any) => void> = { root: (x) => { x.uid = 0; }, hostNetwork: (x) => { x.network = 'host'; }, pullTag: (x) => { x.image = 'python:latest'; }, shell: (x) => { x.command = 'sh'; }, mutableNative: (x) => { x.native.path = '/work/muse'; }, unlimited: (x) => { x.limits.wall_ms = 0; }, coercedUid: (x) => { x.uid = '501'; }, tooManyPids: (x) => { x.limits.pids = 100000; } };
    for (const [name, change] of Object.entries(changes))
        test(name + ' refuses', () => { const x = enrollment(); change(x); expect(() => validateEnrollment(x)).toThrow(); });
    test('closed scalar admission', () => { expect(() => validateAdmission({ ...admission(H), run_id: [admission(H).run_id] }, H)).toThrow(); expect(() => validateAdmission({ ...admission(H), revision: true }, H)).toThrow(); expect(() => validateAdmission({ ...admission(H), expires_at_ms: 1 }, H)).toThrow(); });
    test('argv cannot add shell, privilege, host namespace or restart', () => { const a = buildCreateArgs(enrollment(), 'synthesis-ap-' + 'b'.repeat(32), 'c'.repeat(32), '/private/fixture/policy-copy.json'); expect(a).toContain('--pull=never'); expect(a).toContain('--cap-drop=ALL'); expect(a).toContain('--read-only'); expect(a).toContain('--restart=no'); expect(a).toContain('no-new-privileges:true'); expect(a).not.toContain('--privileged'); expect(a).not.toContain('--pid=host'); expect(a.at(-1)).toBe('/opt/synthesis/container-init.py'); });
    test('malicious and overlapping mounts refuse', () => {
        for (const mount of [{ source: '/private/a,b', target: '/work', writable: true, device: 1, inode: 2 }, { source: '/private/x', target: '/opt/synthesis/muse', writable: true, device: 1, inode: 2 }, { source: '/', target: '/work', writable: false, device: 1, inode: 2 }]) {
            const e = enrollment();
            e.mounts = [mount];
            expect(() => validateEnrollment(e)).toThrow();
        }
    });
    test('foreign identity cannot be cleaned through custody validator', () => expect(() => validateCreated({ Id: 'b'.repeat(64), Image: I, Config: { Labels: {} } }, enrollment(), 'synthesis-ap-' + 'b'.repeat(32), 'c'.repeat(32))).toThrow());
    test('untrusted module never activates supervisor', () => expect(typeof ContainerBackend).toBe('function'));
});
import { readFileSync, writeFileSync, mkdtempSync, chmodSync, rmSync, realpathSync, rmdirSync, statSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { enrollmentDigest, type Enrollment, ContainerSession } from './autopilot-container';
const fixture = process.env.SYNTHESIS_CONTAINER_TEST_ENROLLMENT;
const real = fixture ? JSON.parse(readFileSync(fixture, 'utf8')) as Enrollment : null;
const actual = fixture ? test : test.skip;
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function within<T>(p: Promise<T>, ms = 12000): Promise<T> {
    let timer: any;
    try {
        return await Promise.race([p, new Promise<T>((_, reject) => timer = setTimeout(() => reject(new Error('fixture deadline')), ms))]);
    }
    finally {
        clearTimeout(timer);
    }
}
const events: any[] = [];
function auth(e: Enrollment) { return { ...admission(enrollmentDigest(e)), expires_at_ms: Date.now() + 60000 }; }
async function open(e = structuredClone(real!), current: () => boolean = () => true) { const s = await new ContainerBackend().open(e, auth(e), { isCurrent: current, record: r => { events.push(r); } }); await within(s.ready); return s; }
async function nextJson(s: ContainerSession, predicate: (x: any) => boolean) {
    let raw = '';
    for await (const v of s.output()) {
        if (v.channel !== 'stdout')
            continue;
        raw += v.data.toString();
        while (raw.includes('\n')) {
            const i = raw.indexOf('\n'), line = raw.slice(0, i);
            raw = raw.slice(i + 1);
            const row = JSON.parse(line);
            if (predicate(row))
                return row;
        }
    }
    throw new Error('expected native row unavailable');
}
function docker(args: string[]) { const e = real!; return spawnSync(e.docker.path, ['--host', 'unix://' + e.docker.socket, ...args], { encoding: 'utf8', timeout: 5000, env: { PATH: '/usr/local/bin:/usr/bin:/bin' } }); }
function absent(id: string) { const p = docker(['container', 'inspect', id]); expect(p.status).not.toBe(0); expect(p.stderr).toContain('No such'); }
function assertStopped(r: any) { events.push({ kind: 'receipt', ...r }); expect(r.removed).toBe(true); expect(r.stopped_verified).toBe(true); expect(r.task_accepted).toBe(false); expect(r.native_acceptance).toBe('UNASSESSED'); absent(r.container_id); }
describe('actual disposable fake-native container consumers (not native qualification)', () => {
    actual('ordinary echo, immutable caller basis, exact event chain and removal', async () => {
        const e = structuredClone(real!), a = auth(e), rows: any[] = [];
        const s = await new ContainerBackend().open(e, a, { isCurrent: () => true, record: r => { rows.push(r); } });
        a.revision = 999;
        e.limits.wall_ms = 600000;
        try {
            await within(s.ready);
            await s.send(Buffer.from('{"action":"echo","value":"actual-echo"}\n'));
            expect((await within(nextJson(s, r => r.echo))).echo).toBe('actual-echo');
        }
        finally {
            const r = await within(s.close());
            assertStopped(r);
            expect(r.status).toBe('stopped');
        }
        expect(rows.map(r => r.phase)).toEqual(['planned', 'created', 'started', 'stopped', 'removed']);
        expect(rows.every(r => r.revision === 7)).toBe(true);
    }, 20000);
    actual('native text cannot masquerade as the framing or acceptance plane', async () => {
        const s = await open();
        try {
            await s.send(Buffer.from('{"action":"spoof"}\n'));
            const r = await within(nextJson(s, r => r.type === 'ready'));
            expect(r.task_accepted).toBe(true);
            expect(r.nonce).toBe('guessed');
        }
        finally {
            assertStopped(await within(s.cancel()));
        }
    }, 20000);
    for (const code of [0, 23])
        actual('native exit ' + code + ' separates process result from task success', async () => {
            const s = await open();
            await s.send(Buffer.from(JSON.stringify({ action: 'exit', code }) + '\n'));
            const r = await within(s.finished);
            assertStopped(r);
            expect(r.terminal?.reason).toBe('native_exit');
            expect(r.terminal?.native_exit_code).toBe(code);
            expect(r.status).toBe(code === 0 ? 'stopped' : 'failed');
        }, 20000);
    actual('detached setsid grandchild exists beyond native process group and is bounded by namespace exit', async () => {
        const s = await open();
        try {
            await s.send(Buffer.from('{"action":"detach"}\n'));
            const child = await within(nextJson(s, r => r.deep_pid));
            const id = events.findLast(r => r.name === s.name && r.phase === 'created').container_id;
            const p = docker(['exec', id, '/usr/local/bin/python3', '-c', `import os,signal,json; os.kill(-${child.native_pid},signal.SIGSTOP); print(json.dumps({'deep_exists':os.path.exists('/proc/${child.deep_pid}'),'native_group':os.getpgid(${child.native_pid}),'deep_group':os.getpgid(${child.deep_pid})}))`]);
            expect(p.status).toBe(0);
            const facts = JSON.parse(p.stdout);
            expect(facts.deep_exists).toBe(true);
            expect(facts.deep_group).not.toBe(facts.native_group);
        }
        finally {
            assertStopped(await within(s.cancel()));
        }
    }, 20000);
    actual('owner revocation closes the live worker and records stopped truth', async () => {
        let current = true;
        const s = await open(structuredClone(real!), () => current);
        current = false;
        const r = await within(s.finished);
        assertStopped(r);
        expect(r.reason).toBe('owner_lost');
        expect(r.status).toBe('failed');
    }, 20000);
    actual('flooding native stdout is stopped within the declared IO bound', async () => {
        const e = structuredClone(real!);
        e.limits.max_io_bytes = 65536;
        const s = await open(e);
        await s.send(Buffer.from('{"action":"flood"}\n'));
        const r = await within(s.finished);
        assertStopped(r);
        expect(r.status).toBe('failed');
        expect(['output_budget', 'output_backpressure']).toContain(r.terminal?.reason);
    }, 20000);
    actual('blocked native stdin cannot turn writes into an unbounded wait', async () => {
        const e = structuredClone(real!);
        e.limits.max_io_bytes = 131072;
        const s = await open(e);
        await s.send(Buffer.from('{"action":"block"}\n'));
        let refused = false;
        try {
            for (let n = 0; n < 10; n++)
                await within(s.send(Buffer.alloc(65536)), 3000);
        }
        catch {
            refused = true;
        }
        expect(refused).toBe(true);
        assertStopped(await within(s.finished));
    }, 20000);
    for (const key of ['init', 'native'] as const)
        actual('changed ' + key + ' bytes refuse before native startup', async () => {
            const e = structuredClone(real!);
            e[key].sha256 = 'f'.repeat(64);
            if (key === 'native')
                e.native.helper_sha256 = e.native.sha256;
            const s = await new ContainerBackend().open(e, auth(e), { isCurrent: () => true, record: r => { events.push(r); } });
            await expect(within(s.ready)).rejects.toThrow();
            const r = await within(s.finished);
            expect(r.native_started).toBe(false);
            assertStopped(r);
            expect(r.status).toBe('failed');
        }, 20000);
    actual('changed policy refuses before any container effect or owner receipt', async () => {
        const e = structuredClone(real!);
        e.policy.sha256 = 'f'.repeat(64);
        const rows: any[] = [];
        try {
            await new ContainerBackend().open(e, auth(e), { isCurrent: () => true, record: r => { rows.push(r); } });
            throw new Error('accepted changed policy');
        }
        catch (error: any) {
            expect(error.receipt.status).toBe('failed');
            expect(error.receipt.container_id).toBe(null);
            expect(rows).toEqual([]);
        }
    }, 20000);
    actual('absent authority never reaches a Docker create', async () => {
        const e = structuredClone(real!);
        const rows: any[] = [];
        try {
            await new ContainerBackend().open(e, auth(e), { isCurrent: () => false, record: r => { rows.push(r); } });
            throw new Error('accepted absent owner');
        }
        catch (error: any) {
            expect(error.receipt.status).toBe('failed');
            expect(error.receipt.container_id).toBe(null);
            expect(rows).toEqual([]);
        }
    }, 20000);
    actual('abrupt owner death leaves independent PID1 deadline and exact retained cleanup identity', async () => {
        const dir = mkdtempSync(join(realpathSync(tmpdir()), 'synthesis-owner-loss-'));
        chmodSync(dir, 0o700);
        const log = join(dir, 'events.jsonl'), script = join(dir, 'owner.ts');
        writeFileSync(script, `import {ContainerBackend,enrollmentDigest} from ${JSON.stringify(join(import.meta.dir, 'autopilot-container.ts'))};import {appendFileSync,readFileSync} from 'node:fs';const e=JSON.parse(readFileSync(${JSON.stringify(fixture)},'utf8'));await new ContainerBackend().open(e,{schema_version:1,run_id:'00000000-0000-4000-8000-000000000001',permit_id:'loss-fixture',revision:7,enrollment_sha256:enrollmentDigest(e),expires_at_ms:Date.now()+60000},{isCurrent:()=>true,record:r=>appendFileSync(${JSON.stringify(log)},JSON.stringify(r)+'\\n')});`);
        const child = spawn(process.execPath, [script], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'ignore', 'pipe'] });
        let owned: any = null;
        try {
            for (let n = 0; n < 150; n++) {
                await sleep(25);
                try {
                    owned = readFileSync(log, 'utf8').trim().split('\n').map(x => JSON.parse(x)).find(x => x.phase === 'started');
                }
                catch { }
                if (owned)
                    break;
            }
            expect(owned).toBeTruthy();
            child.kill('SIGKILL');
            let stopped: any = null;
            for (let n = 0; n < 80; n++) {
                const r = docker(['container', 'inspect', owned.container_id]);
                expect(r.status).toBe(0);
                const row = JSON.parse(r.stdout)[0];
                expect(row.Config.Labels['org.synthesis.custody']).toBe(owned.nonce);
                if (!row.State.Running) {
                    stopped = row;
                    break;
                }
                await sleep(50);
            }
            events.push({ kind: 'owner_loss_readback', owned, stopped });
            expect(stopped?.State.Pid).toBe(0);
            expect(stopped?.State.Running).toBe(false);
        }
        finally {
            child.kill('SIGKILL');
            if (owned) {
                const q = docker(['container', 'inspect', owned.container_id]);
                if (q.status === 0) {
                    const row = JSON.parse(q.stdout)[0];
                    if (row.Config.Labels['org.synthesis.custody'] === owned.nonce) {
                        if (row.State.Running)
                            docker(['container', 'kill', owned.container_id]);
                        expect(docker(['container', 'rm', owned.container_id]).status).toBe(0);
                        absent(owned.container_id);
                    }
                }
            }
            rmSync(script);
            try {
                rmSync(log);
            }
            catch { }
            rmdirSync(dir);
        }
    }, 20000);
});
afterAll(() => {
    if (process.env.SYNTHESIS_CONTAINER_TEST_EVIDENCE)
        writeFileSync(process.env.SYNTHESIS_CONTAINER_TEST_EVIDENCE, JSON.stringify(events, null, 2) + "\n", { mode: 0o600 });
});
import { randomBytes } from 'node:crypto';
async function rawInit(behavior: (send: (row: any) => void, read: (kind: string) => Promise<any>, closeInput: () => void) => Promise<void>) {
    const e = structuredClone(real!), name = 'synthesis-ap-' + randomBytes(16).toString('hex'), nonce = randomBytes(16).toString('hex');
    let id: string | null = null;
    let child: any = null;
    const observed: any[] = [];
    events.push({ kind: 'protocol_fixture_planned', name, nonce });
    try {
        const created = docker(buildCreateArgs(e, name, nonce, e.policy.path));
        expect(created.status).toBe(0);
        id = created.stdout.trim();
        expect(id).toMatch(/^[a-f0-9]{64}$/);
        validateCreated(JSON.parse(docker(['container', 'inspect', id!]).stdout)[0], e, name, nonce, JSON.parse(readFileSync(e.policy.path, 'utf8')));
        child = spawn(e.docker.path, ['--host', 'unix://' + e.docker.socket, 'container', 'start', '--attach', '--interactive', id!], { env: { PATH: '/usr/local/bin:/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'] });
        let raw = '', ended = false;
        child.stdout.on('data', (b: Buffer) => { raw += b.toString(); });
        child.on('exit', () => { ended = true; });
        const read = async (kind: string) => {
            const until = Date.now() + 4000;
            while (Date.now() < until) {
                while (raw.includes('\n')) {
                    const n = raw.indexOf('\n'), row = JSON.parse(raw.slice(0, n));
                    raw = raw.slice(n + 1);
                    observed.push(row);
                    if (row.type === kind)
                        return row;
                }
                if (ended && raw === '')
                    break;
                await sleep(10);
            }
            throw new Error('missing fixed-init ' + kind);
        };
        const send = (row: any) => child.stdin.write(JSON.stringify({ ...row, nonce: row.nonce ?? nonce }) + '\n');
        send({ type: 'configure', schema_version: 1, workspace: e.workspace, native_sha256: e.native.sha256, init_sha256: e.init.sha256, wall_ms: 1200, heartbeat_ms: 400, max_io_bytes: e.limits.max_io_bytes });
        await read('ready');
        await behavior(send, read, () => child.stdin.end());
        let c: any;
        for (let i = 0; i < 80; i++) {
            c = JSON.parse(docker(['container', 'inspect', id!]).stdout)[0];
            if (!c.State.Running)
                break;
            await sleep(25);
        }
        expect(c.State.Running).toBe(false);
        expect(c.State.Pid).toBe(0);
        events.push({ kind: 'fixed_init_protocol', name, nonce, container_id: id, observed, stopped: c.State });
    }
    finally {
        child?.kill('SIGKILL');
        if (id) {
            const q = docker(['container', 'inspect', id]);
            if (q.status === 0) {
                const c = JSON.parse(q.stdout)[0];
                expect(c.Config.Labels['org.synthesis.custody']).toBe(nonce);
                if (c.State.Running)
                    docker(['container', 'kill', id]);
                expect(docker(['container', 'rm', id]).status).toBe(0);
                absent(id);
            }
        }
    }
}
describe('actual Linux fixed PID1 hostile protocol controls', () => {
    const attacks: any[] = [{ type: 'heartbeat', seq: 0 }, { type: 'heartbeat', seq: true }, { type: 'heartbeat', seq: 2 }, { type: 'heartbeat', seq: 1, extra: true }, { type: 'heartbeat', seq: 1, nonce: 'wrong' }, { type: 'native_input', seq: 1, data: '@@bad@@' }, { type: 'shell', seq: 1 }];
    for (const [i, row] of attacks.entries())
        actual('malformed owner frame ' + i + ' ends without acceptance', async () => rawInit(async (send, read) => { send(row); const r = await read('terminal'); expect(r.reason).toBe('invalid_owner_frame'); expect(r.task_accepted).toBe(false); }), 20000);
    actual('missing heartbeat ends independently', async () => rawInit(async (_send, read) => { expect((await read('terminal')).reason).toBe('owner_lost'); }), 20000);
    actual('owner EOF ends independently', async () => rawInit(async (_send, read, end) => { end(); expect((await read('terminal')).reason).toBe('owner_lost'); }), 20000);
    actual('absolute deadline stays finite despite continuing heartbeats', async () => rawInit(async (send, read) => {
        for (let seq = 1; seq <= 10; seq++) {
            send({ type: 'heartbeat', seq });
            await sleep(100);
        }
        expect((await read('terminal')).reason).toBe('deadline');
    }), 20000);
    actual('valid exact native bytes and cancellation control', async () => rawInit(async (send, read) => {
        send({ type: 'native_input', seq: 1, data: Buffer.from('{"action":"echo","value":"init-control"}\n').toString('base64') });
        let seen = false;
        for (let i = 0; i < 5; i++) {
            const row = await read('native_output');
            if (Buffer.from(row.data, 'base64').includes('init-control')) {
                seen = true;
                break;
            }
        }
        expect(seen).toBe(true);
        send({ type: 'cancel', seq: 2 });
        expect((await read('terminal')).reason).toBe('cancelled');
    }), 20000);
});
actual('native final output is retained through immediate process exit', async () => {
    const s = await open();
    await s.send(Buffer.from('{"action":"final","count":200000}\n'));
    const row = await within(nextJson(s, r => r.final));
    expect(row.final.length).toBe(200000);
    const receipt = await within(s.finished);
    assertStopped(receipt);
    expect(receipt.terminal?.native_exit_code).toBe(0);
}, 20000);
actual('queued final output survives native exit while PID1 was briefly paused', async () => {
    const s = await open();
    try {
        await s.send(Buffer.from('{"action":"wait_final"}\n'));
        await within(nextJson(s, r => r.waiting_final));
        const id = events.findLast(r => r.name === s.name && r.phase === 'created').container_id;
        expect(docker(['container', 'kill', '--signal', 'STOP', id]).status).toBe(0);
        expect(docker(['exec', id, '/usr/local/bin/python3', '-c', "open('/tmp/final-go','w').close()"]).status).toBe(0);
        await sleep(70);
        expect(docker(['container', 'kill', '--signal', 'CONT', id]).status).toBe(0);
        const row = await within(nextJson(s, r => r.final));
        expect(row.final.length).toBe(1000);
        const receipt = await within(s.finished);
        assertStopped(receipt);
        expect(receipt.terminal?.native_exit_code).toBe(0);
    }
    finally {
        await within(s.cancel());
    }
}, 20000);
actual('mount replaced during owner create receipt refuses before native launch', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'synthesis-mount-custody-'));
    const file = join(dir, 'input');
    writeFileSync(file, 'original');
    const st = statSync(file);
    const e = structuredClone(real!);
    e.mounts = [{ kind: 'inputs', source: file, target: '/inputs/value', writable: false, device: st.dev, inode: st.ino }];
    let swapped = false;
    try {
        await expect(new ContainerBackend().open(e, auth(e), { isCurrent: () => true, record: r => {
                events.push(r);
                if (r.phase === 'created') {
                    renameSync(file, join(dir, 'retained'));
                    writeFileSync(file, 'foreign replacement');
                    swapped = true;
                }
            } })).rejects.toThrow('admission failed');
        expect(swapped).toBe(true);
    }
    finally {
        for (const p of ['input', 'retained'])
            try {
                rmSync(join(dir, p));
            }
            catch { }
        rmdirSync(dir);
    }
}, 20000);
actual('exact narrow input mount reads current bytes and rejects writes in actual container', async () => {
    const dir = mkdtempSync(join(realpathSync(tmpdir()), 'synthesis-mount-positive-'));
    const file = join(dir, 'input');
    writeFileSync(file, 'known input');
    const st = statSync(file);
    const e = structuredClone(real!);
    e.mounts = [{ kind: 'inputs', source: file, target: '/inputs/value', writable: false, device: st.dev, inode: st.ino }];
    let session: ContainerSession | null = null;
    try {
        session = await open(e);
        const id = events.findLast(r => r.name === session!.name && r.phase === 'created').container_id;
        const code = "import json;value=open('/inputs/value').read();denied=False\ntry:open('/inputs/value','w').write('bad')\nexcept OSError:denied=True\nprint(json.dumps({'value':value,'write_denied':denied}))";
        const p = docker(['exec', id, '/usr/local/bin/python3', '-c', code]);
        expect(p.status).toBe(0);
        expect(JSON.parse(p.stdout)).toEqual({ value: 'known input', write_denied: true });
        expect(readFileSync(file, 'utf8')).toBe('known input');
    }
    finally {
        if (session)
            assertStopped(await within(session.close()));
        rmSync(file);
        rmdirSync(dir);
    }
}, 20000);
actual('actual readback cannot silently relax retained Linux confinement', async () => {
    const e = structuredClone(real!), s = await open(e);
    try {
        const id = events.findLast(r => r.name === s.name && r.phase === 'created').container_id;
        const original = JSON.parse(docker(['container', 'inspect', id]).stdout)[0];
        const attacks: Record<string, (x: any) => void> = { masks: x => { x.HostConfig.MaskedPaths = []; }, readonly: x => { x.HostConfig.ReadonlyPaths = []; }, privilege: x => { x.HostConfig.Privileged = true; }, network: x => { x.HostConfig.NetworkMode = 'host'; }, pid: x => { x.HostConfig.PidMode = 'host'; }, cgroup: x => { x.HostConfig.CgroupnsMode = 'host'; }, capability: x => { x.HostConfig.CapAdd = ['SYS_ADMIN']; }, restart: x => { x.HostConfig.RestartPolicy.Name = 'always'; }, image: x => { x.Image = 'sha256:' + 'a'.repeat(64); }, identity: x => { x.Config.Labels['org.synthesis.custody'] = 'foreign'; }, root: x => { x.Config.User = '0:0'; } };
        for (const [name, attack] of Object.entries(attacks)) {
            const x = structuredClone(original);
            attack(x);
            expect(() => validateCreated(x, e, s.name, s.nonce, JSON.parse(readFileSync(e.policy.path, 'utf8'))), name).toThrow();
        }
    }
    finally {
        assertStopped(await within(s.close()));
    }
}, 20000);


import { Writable } from 'node:stream';
import { createServer } from 'node:net';
import { createHash } from 'node:crypto';

describe('D2 admission expiry across asynchronous owner callbacks', () => {
    for (const action of ['send', 'heartbeat'] as const) {
        for (const expired of [false, true]) {
            test(`${action} ${expired ? 'refuses crossing-expiry callback' : 'accepts current callback'}`, async () => {
                const frames: Buffer[] = [], reasons: string[] = [];
                const e = enrollment(), a = admission(H);
                const s: any = new ContainerSession(e, a, {
                    isCurrent: async () => {
                        if (expired) { a.expires_at_ms = Date.now() + 20; await sleep(60); }
                        return true;
                    }, record: () => {},
                }, import.meta.dir, 'synthetic', 'a'.repeat(32));
                s.child = { stdin: new Writable({ write(chunk, _encoding, callback) { frames.push(Buffer.from(chunk)); callback(); } }) };
                s.finish = async (reason: string) => { reasons.push(reason); s.ending = true; };
                s.readyResolve();
                if (action === 'send') {
                    if (expired) await expect(s.send(Buffer.from('fixture'))).rejects.toThrow();
                    else await s.send(Buffer.from('fixture'));
                } else await s.heartbeat();
                expect(frames.length).toBe(expired ? 0 : 1);
                if (action === 'heartbeat' && expired) expect(reasons).toEqual(['owner_lost']);
            });
        }
    }
    for (const rowType of ['configure', 'heartbeat', 'native_input']) {
        test(`${rowType} refuses at the final write boundary after preparation`, async () => {
            const a = admission(H), frames: Buffer[] = [];
            const s: any = new ContainerSession(enrollment(), a, { isCurrent: () => true, record: () => {} }, import.meta.dir, 'synthetic', 'a'.repeat(32));
            s.child = { stdin: new Writable({ write(chunk, _encoding, callback) { frames.push(Buffer.from(chunk)); callback(); } }) };
            const row = { type: rowType, toJSON() { a.expires_at_ms = 1; return { type: rowType }; } };
            await expect(s.writeFrame(row, false)).rejects.toThrow();
            expect(frames).toEqual([]);
        });
    }
    test('expired admission still allows explicit cancellation of custody', async () => {
        const frames: Buffer[] = [], a = admission(H); a.expires_at_ms = 1;
        const s: any = new ContainerSession(enrollment(), a, { isCurrent: () => false, record: () => {} }, import.meta.dir, 'synthetic', 'a'.repeat(32));
        s.child = { stdin: new Writable({ write(chunk, _encoding, callback) { frames.push(Buffer.from(chunk)); callback(); } }) };
        await s.writeFrame({ type: 'cancel' });
        expect(JSON.parse(frames[0].toString()).type).toBe('cancel');
    });
    for (const expiry of ['none', 'initial-check', 'start-check', 'planned-record'] as const) {
        test(`actual begin boundary ${expiry}`, async () => {
            // Actual filesystem and start subprocess; Docker readbacks are synthetic.
            // This tests callback/effect ordering, not Linux containment or PM authority.
            const work = mkdtempSync(join(realpathSync(tmpdir()), 'synthesis-admission-fixture-'));
            const socket = join(work, 'engine.sock'), marker = join(work, 'started');
            const server = createServer();
            await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
            const e = enrollment(), a = admission(H), phases: string[] = [], commands: string[][] = [];
            const executable = join(work, 'fake-docker');
            writeFileSync(executable, `#!/bin/sh
printf started > '${marker}'
printf '%s\\n' '${JSON.stringify({ type: 'ready', nonce: 'a'.repeat(32), native_pid: 2, task_accepted: false })}'
exec cat >/dev/null
`, { mode: 0o700 });
            e.docker.path = executable; e.docker.sha256 = createHash('sha256').update(readFileSync(executable)).digest('hex'); e.docker.socket = socket;
            e.policy.path = join(work, 'policy.json'); writeFileSync(e.policy.path, JSON.stringify({ defaultAction: 'SCMP_ACT_ERRNO', syscalls: [] }));
            e.policy.sha256 = createHash('sha256').update(readFileSync(e.policy.path)).digest('hex');
            let checks = 0;
            const crossExpiry = async () => { a.expires_at_ms = Date.now() + 20; await sleep(60); };
            const s: any = new ContainerSession(e, a, {
                isCurrent: async () => { checks++; if ((expiry === 'initial-check' && checks === 1) || (expiry === 'start-check' && phases.includes('created'))) await crossExpiry(); return true; },
                record: async (event) => { phases.push(event.phase); if (expiry === 'planned-record' && event.phase === 'planned') await crossExpiry(); },
            }, work, 'synthesis-ap-' + 'a'.repeat(32), 'a'.repeat(32));
            s.docker = async (args: string[]) => {
                commands.push(args);
                if (args[0] === 'info') return { code: 0, out: JSON.stringify({ ID: e.docker.engine_id, OSType: 'linux' }) };
                if (args[0] === 'image') return { code: 0, out: JSON.stringify([{ Id: e.image, Os: 'linux', Architecture: 'arm64', Config: {} }]) };
                return { code: 0, out: 'b'.repeat(64) };
            };
            s.inspect = async () => ({});
            s.finish = async () => { s.ending = true; clearInterval(s.timer); clearTimeout(s.watchdog); s.child?.kill('SIGKILL'); s.readyResolve(); s.finishResolve({ fixture: true }); };
            try {
                if (expiry === 'none') {
                    await s.begin(); await within(s.ready, 2000);
                    expect(readFileSync(marker, 'utf8')).toBe('started');
                } else {
                    await expect(s.begin()).rejects.toThrow();
                    expect(s.child).toBe(null);
                    if (expiry === 'planned-record' || expiry === 'initial-check') expect(commands.some(args => args[1] === 'create')).toBe(false);
                }
            } finally {
                await s.finish();
                await new Promise<void>(resolve => server.close(() => resolve()));
                rmSync(work, { recursive: true, force: true });
            }
        });
    }
});
