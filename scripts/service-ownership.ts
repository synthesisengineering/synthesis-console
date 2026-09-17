/** Exact byte/mode ownership and recoverable login-service retirement. */
import { lstatSync, readFileSync, mkdirSync, writeFileSync, renameSync, unlinkSync, rmdirSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { homedir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

type Fingerprint = { sha256: string; mode: number };
type Ownership = Fingerprint & { schema_version: 2; target: string };
type Retirement = {
  schema_version: 1; id: string; pid: number; target: string; platform: string;
  unit_archive: string; receipt_archive: string; unit: Fingerprint; receipt: Fingerprint;
};
const [operation, targetArg, platform] = process.argv.slice(2);
if (!["check", "record", "uninstall"].includes(operation) || !targetArg) throw new Error("Invalid service ownership operation");
const target = resolve(targetArg);
const state = resolve(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "synthesis-console");
const receipt = join(state, "autostart.json");
const pending = join(state, "autostart-uninstall.json");
const label = "org.synthesisengineering.console";
const unitName = "synthesis-console.service";

function present(path: string): boolean {
  try { lstatSync(path); return true; } catch (error: any) { if (error.code === "ENOENT") return false; throw error; }
}
function guard(path: string, directory = false) {
  let cursor = path;
  while (true) {
    if (present(cursor)) {
      const st = lstatSync(cursor);
      if (st.isSymbolicLink() || (cursor === path ? !(directory ? st.isDirectory() : st.isFile()) : !st.isDirectory())) {
        throw new Error("Unsafe service ownership path; preserved: " + cursor);
      }
    }
    const parent = dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
function fingerprint(path: string): Fingerprint {
  guard(path);
  return { sha256: createHash("sha256").update(readFileSync(path)).digest("hex"), mode: lstatSync(path).mode & 0o7777 };
}
function validFingerprint(value: any): value is Fingerprint {
  return value && /^[a-f0-9]{64}$/.test(value.sha256) && Number.isInteger(value.mode) && value.mode >= 0 && value.mode <= 0o7777;
}
function assertExact(path: string, expected: Fingerprint) {
  const actual = fingerprint(path);
  if (actual.sha256 !== expected.sha256 || actual.mode !== expected.mode) throw new Error("Service bytes or permissions changed; preserved: " + path);
}
function readOwnership(): Ownership {
  guard(receipt);
  const prior = JSON.parse(readFileSync(receipt, "utf8"));
  if (prior.schema_version !== 2 || prior.target !== target || !validFingerprint(prior) || (lstatSync(receipt).mode & 0o7777) !== 0o600) {
    throw new Error("Service ownership evidence is unknown or edited; preserved.");
  }
  return prior as Ownership;
}
function checkOwned(): Ownership | undefined {
  guard(target); guard(receipt);
  if (!present(target)) {
    if (present(receipt)) throw new Error("Owned service file is missing; ownership evidence preserved.");
    return;
  }
  if (!present(receipt)) throw new Error("Existing service is unknown; preserved without service changes.");
  const prior = readOwnership(); assertExact(target, prior); return prior;
}
function command(binary: string, args: string[]): string {
  const result = spawnSync(binary, args, { encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${binary} ${args.join(" ")} failed; service retirement stopped. ${result.error?.message || result.stderr.trim()}`);
  return result.stdout.trim();
}
function macLoaded(): boolean {
  // These legacy interfaces have a documented format; `print` explicitly does not.
  if (command("launchctl", ["manageruid"]) !== String(process.getuid!()) || command("launchctl", ["managername"]) !== "Aqua") {
    throw new Error("Cannot verify the macOS login service outside its Aqua user context; files preserved.");
  }
  const lines = command("launchctl", ["list"]).split(/\r?\n/);
  if (!/^PID\s+Status\s+Label$/.test(lines.shift() || "")) throw new Error("Unrecognized launchctl list response; files preserved.");
  const seen = new Set<string>();
  for (const line of lines) {
    const match = line.match(/^(?:\d+|-)\s+-?\d+\s+(\S+)$/);
    if (!match || seen.has(match[1])) throw new Error("Unrecognized launchctl job row; files preserved.");
    seen.add(match[1]);
  }
  return seen.has(label);
}
function linuxStopped(): boolean {
  const output = command("systemctl", ["--user", "show", unitName, "--property=LoadState", "--property=ActiveState", "--property=UnitFileState", "--property=MainPID", "--property=ControlPID", "--no-pager"]);
  const values: Record<string, string> = {};
  const keys = ["LoadState", "ActiveState", "UnitFileState", "MainPID", "ControlPID"];
  for (const line of output.split(/\r?\n/)) {
    const split = line.indexOf("="); const key = line.slice(0, split);
    if (split < 1 || !keys.includes(key) || key in values) throw new Error("Unrecognized systemctl state; files preserved.");
    values[key] = line.slice(split + 1);
  }
  if (Object.keys(values).length !== keys.length || !/^\d+$/.test(values.MainPID) || !/^\d+$/.test(values.ControlPID) || values.LoadState !== "loaded" || !["active", "inactive", "reloading", "failed", "activating", "deactivating", "maintenance", "refreshing"].includes(values.ActiveState) || !["enabled", "enabled-runtime", "linked", "linked-runtime", "alias", "masked", "masked-runtime", "static", "disabled", "indirect", "generated", "transient", "bad"].includes(values.UnitFileState)) {
    throw new Error("Incomplete or unknown systemctl state; files preserved.");
  }
  return values.ActiveState === "inactive" && values.UnitFileState === "disabled" && values.MainPID === "0" && values.ControlPID === "0";
}
function verifyStop() {
  const stopped = platform === "macos" ? () => !macLoaded() : linuxStopped;
  if (stopped()) return;
  if (platform === "macos") command("launchctl", ["bootout", `gui/${process.getuid!()}/${label}`]);
  else command("systemctl", ["--user", "disable", "--now", unitName]);
  for (let attempt = 0; attempt < 25; attempt++) {
    if (stopped()) return;
    Bun.sleepSync(100);
  }
  throw new Error("Service manager has not verified an inactive service; unit and ownership evidence preserved.");
}
function archivePaths(id: string) {
  return {
    unit_archive: join(dirname(target), ".synthesis-console-retired-" + id, "service"),
    receipt_archive: join(state, "autostart-retired-" + id, "ownership.json"),
  };
}
function validateTransaction(value: any): Retirement {
  if (value.schema_version !== 1 || !/^[a-f0-9-]{36}$/.test(value.id) || value.target !== target || value.platform !== platform || !Number.isInteger(value.pid) || value.pid < 1 || !validFingerprint(value.unit) || !validFingerprint(value.receipt)) {
    throw new Error("Unrecognized service retirement evidence; preserved.");
  }
  const paths = archivePaths(value.id);
  if (value.unit_archive !== paths.unit_archive || value.receipt_archive !== paths.receipt_archive) throw new Error("Unexpected retirement archive; preserved.");
  guard(value.unit_archive); guard(value.receipt_archive);
  return value;
}
function moveExact(from: string, to: string, expected: Fingerprint) {
  assertExact(from, expected); guard(to);
  if (present(to)) throw new Error("Retirement destination already exists; preserved: " + to);
  renameSync(from, to);
  assertExact(to, expected);
}
function removePending(tx: Retirement) {
  guard(pending);
  const current = JSON.parse(readFileSync(pending, "utf8"));
  if (JSON.stringify(current) !== JSON.stringify(tx)) throw new Error("Retirement evidence changed; preserved.");
  unlinkSync(pending);
}
function cleanupEmptyArchives(tx: Retirement) {
  for (const path of [dirname(tx.unit_archive), dirname(tx.receipt_archive)]) {
    try { rmdirSync(path); } catch (error: any) { if (!["ENOTEMPTY", "ENOENT"].includes(error.code)) throw error; }
  }
}
function rollback(tx: Retirement) {
  // Never replace a file created or edited while the manager was running.
  if (present(tx.unit_archive)) moveExact(tx.unit_archive, target, tx.unit);
  else assertExact(target, tx.unit);
  if (present(tx.receipt_archive)) {
    // A foreign archive is not evidence that the owned receipt was moved.
    if (!present(receipt)) moveExact(tx.receipt_archive, receipt, tx.receipt);
    else assertExact(receipt, tx.receipt);
  } else assertExact(receipt, tx.receipt);
  assertExact(target, tx.unit); assertExact(receipt, tx.receipt);
  if (platform === "linux") command("systemctl", ["--user", "daemon-reload"]);
  removePending(tx); cleanupEmptyArchives(tx);
}
function recoverPending() {
  guard(pending);
  if (!present(pending)) return;
  const tx = validateTransaction(JSON.parse(readFileSync(pending, "utf8")));
  try {
    process.kill(tx.pid, 0);
    throw new Error("A service retirement process is still active; evidence preserved.");
  } catch (error: any) {
    if (error.code !== "ESRCH") throw error;
  }
  // Restore the last owned state before retrying manager verification. This also
  // handles a crash after receipt movement but before removing the journal.
  rollback(tx);
}
function uninstall() {
  if (!["macos", "linux"].includes(platform)) throw new Error("Unknown service platform");
  recoverPending();
  const prior = checkOwned();
  if (!prior) { console.log("No owned service file is installed; no service changed."); return; }
  guard(state, true); mkdirSync(state, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const tx: Retirement = { schema_version: 1, id, pid: process.pid, target, platform, ...archivePaths(id), unit: fingerprint(target), receipt: fingerprint(receipt) };
  // Exclusive journal creation also makes installer ownership checks refuse an
  // in-progress retirement. A dead process's journal is recovered on retry.
  writeFileSync(pending, JSON.stringify(tx) + "\n", { flag: "wx", mode: 0o600 });
  try {
    verifyStop();
    assertExact(target, tx.unit); assertExact(receipt, tx.receipt);
    mkdirSync(dirname(tx.unit_archive), { mode: 0o700 });
    mkdirSync(dirname(tx.receipt_archive), { mode: 0o700 });
    moveExact(target, tx.unit_archive, tx.unit);
    if (platform === "linux") command("systemctl", ["--user", "daemon-reload"]);
    assertExact(tx.unit_archive, tx.unit); assertExact(receipt, tx.receipt);
    if (present(target)) throw new Error("A replacement service appeared; preserved.");
    moveExact(receipt, tx.receipt_archive, tx.receipt);
    assertExact(tx.unit_archive, tx.unit); assertExact(tx.receipt_archive, tx.receipt);
    removePending(tx);
  } catch (error) {
    try {
      if (present(tx.unit_archive) || present(tx.receipt_archive)) rollback(tx);
      else { removePending(tx); cleanupEmptyArchives(tx); }
    } catch (recovery: any) {
      throw new Error(`${String(error)} Recovery evidence retained at ${pending}: ${recovery.message}`);
    }
    throw error;
  }
  console.log("The owned login service is verified stopped and removed from automatic startup.");
  console.log("Retired service and ownership evidence: " + dirname(tx.unit_archive) + " and " + dirname(tx.receipt_archive));
  console.log("Console configuration and logs remain unchanged.");
}

guard(receipt); guard(target); guard(pending);
if (operation === "uninstall") uninstall();
else {
  if (present(pending)) throw new Error("Service retirement is incomplete; rerun autostart uninstall to recover its owned files.");
  if (operation === "check") checkOwned();
  else {
    if (present(receipt)) readOwnership();
    guard(state, true); mkdirSync(state, { recursive: true, mode: 0o700 });
    const temporary = receipt + "." + randomUUID();
    const record: Ownership = { schema_version: 2, target, ...fingerprint(target) };
    writeFileSync(temporary, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
    renameSync(temporary, receipt);
  }
}
