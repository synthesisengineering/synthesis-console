/** Descriptor-verified bounded local regular-file reads shared by evidence owners. */
import {
  constants,
  lstatSync,
  openSync,
  fstatSync,
  readSync,
  closeSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { dirname } from "node:path";
function sig(s: Stats) {
  return `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.nlink}`;
}
export function readBoundedSnapshot(
  path: string,
  maxBytes = 4 * 1024 * 1024,
): { data: Buffer; stat: Stats } {
  const parents: [string, string][] = [];
  let parent = dirname(path);
  for (;;) {
    const s = lstatSync(parent);
    if (!s.isDirectory() || s.isSymbolicLink())
      throw Error("Unsafe report ancestor");
    parents.push([parent, `${s.dev}:${s.ino}:${s.mode}`]);
    const next = dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  const before = lstatSync(path);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.nlink !== 1 ||
    before.size > maxBytes
  )
    throw Error("Unsafe or oversized report member");
  // no-follow avoids an attacker replacing the lstat-checked file with a link.
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (sig(fstatSync(fd)) !== sig(before))
      throw Error("Report changed before read");
    const data = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1));
    let n = 0;
    for (;;) {
      const count = readSync(fd, data, n, data.length - n, null);
      if (!count) break;
      n += count;
      if (n > before.size) throw Error("Report grew while read");
    }
    if (
      sig(fstatSync(fd)) !== sig(before) ||
      sig(lstatSync(path)) !== sig(before)
    )
      throw Error("Report changed while read");
    for (const [p, initial] of parents) {
      const s = lstatSync(p);
      if (`${s.dev}:${s.ino}:${s.mode}` !== initial)
        throw Error("Report ancestor changed");
    }
    return { data: data.subarray(0, n), stat: before };
  } finally {
    closeSync(fd);
  }
}

export function readBoundedFile(
  path: string,
  maxBytes = 4 * 1024 * 1024,
): Buffer {
  return readBoundedSnapshot(path, maxBytes).data;
}
