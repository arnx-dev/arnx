// File writes and reads in a tree a test may have changed: a run can leave a link, a FIFO or a folder it took the write bit
// from, so nothing here follows a link out of the tree or trusts what it finds there.
import { chmodSync, closeSync, constants, copyFileSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readlinkSync,
  readSync, realpathSync, rmSync, statSync, symlinkSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, sep } from "node:path";

/** Every entry under `root` (relative, "/"-separated, folders too), like a recursive readdir that never goes into a link:
 * a link to a folder is listed, not entered, so a loop (`a/b -> ..`, `x -> x`) ends. A missing root has no entries. */
export function entriesUnder(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(rel ? join(root, rel) : root);
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      out.push(r);
      if (lstatSync(join(root, r), { throwIfNoEntry: false })?.isDirectory()) visit(r);
    }
  };
  visit("");
  return out;
}

/** Whether `p` is a file, or a link that ends at one; a broken or looping link is not. */
export function isFileOrLinkToFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

const inside = (root: string, p: string) => p === root || p.startsWith(root + sep);

/** Whether every folder on the way from `root` to the file `rel` is a real folder (no link, no other file), making the ones
 * missing when `make`, and the file itself is absent or a regular file. */
export function realFolders(root: string, rel: string, make = false): boolean {
  const parts = rel.split("/").filter(Boolean);
  if (!parts.length || parts.some((p) => p === "..")) return false;
  let at = root;
  for (const part of parts.slice(0, -1)) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (!st) {
      if (!make) return false;
      mkdirSync(at);
    } else if (!st.isDirectory()) return false;
  }
  const last = lstatSync(join(root, rel), { throwIfNoEntry: false });
  if (last && !last.isFile()) return false;
  try {
    return inside(realpathSync(root), realpathSync(dirname(join(root, rel))));
  } catch {
    return false;
  }
}

/** `data` as a new file at `path`: never through a link, never over anything already there. */
export function writeNew(path: string, data: string | Buffer, mode = 0o644): void {
  const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, mode);
  try {
    const buf = typeof data === "string" ? Buffer.from(data) : data;
    for (let off = 0; off < buf.length;) off += writeSync(fd, buf, off, buf.length - off);
  } finally {
    closeSync(fd);
  }
}

/** The text of `path` when it is a regular file of at most `max` bytes, read without following a link; else null. */
export function readRegular(path: string, max: number): string | null {
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > max) return null;
    const buf = Buffer.alloc(st.size);
    let got = 0;
    while (got < st.size) {
      const n = readSync(fd, buf, got, st.size - got, got);
      if (!n) break;
      got += n;
    }
    return buf.subarray(0, got).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

/** `src`'s tree at `dest` (which must not exist): folders (owner rwx added), regular files, and links whose target resolves
 * inside `dest` once all is in place. A link leading out of it, or nowhere, and a FIFO, a socket or a device are left out. */
export function copyTreeInside(src: string, dest: string): void {
  const links: string[] = [];
  const walk = (from: string, to: string) => {
    mkdirSync(to, { mode: (lstatSync(from).mode & 0o777) | 0o700 });
    chmodSync(to, (lstatSync(from).mode & 0o777) | 0o700);
    for (const name of readdirSync(from)) {
      const f = join(from, name), t = join(to, name);
      const st = lstatSync(f);
      if (st.isDirectory()) walk(f, t);
      else if (st.isFile()) copyFileSync(f, t, constants.COPYFILE_EXCL);
      else if (st.isSymbolicLink()) {
        const target = readlinkSync(f);
        if (target.startsWith("/")) continue;
        symlinkSync(target, t);
        links.push(t);
      }
    }
  };
  walk(src, dest);
  const root = realpathSync(dest);
  for (const l of links) {
    let ok = false;
    try {
      ok = inside(root, realpathSync(l));
    } catch {
      // nowhere: left out
    }
    if (!ok) unlinkSync(l);
  }
}

/** Owner rwx back on `dir` and every folder below it, no link followed. */
function ownAll(dir: string): void {
  try {
    if (!lstatSync(dir).isDirectory()) return;
    chmodSync(dir, 0o700);
    for (const name of readdirSync(dir)) ownAll(join(dir, name));
  } catch {
    // as much as can be
  }
}

/** Removes `dir`; a folder a run took the owner's bits from gets them back first, no link followed. True when it is gone. */
export function removeTree(dir: string): boolean {
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    ownAll(dir);
  }
  try {
    rmSync(dir, { recursive: true, force: true });
    return true;
  } catch {
    return lstatSync(dir, { throwIfNoEntry: false }) === undefined;
  }
}
