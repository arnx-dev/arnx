// Copies of the project's code baked into an environment image. Each run mounts the code under test at /src, but an
// install step can copy the project somewhere else first (`cp -r . /opt/web && next build`): tests that run there
// test that copy, as it was when the image was built, not the change. The image key holds only the manifests, so the
// copy is never refreshed. arnx finds such copies by path and content; when they differ from the code under test it
// builds the image again from that code, or, when that code is not there yet (the before/after check), refuses.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { getAdapter, LANGUAGES } from "./adapters";
import type { ReviewConfig } from "./config";
import { ArnxError } from "./errors";
import { docker, dockerSteps } from "./sandbox";
import { globRegex } from "./secrets";

/** A copy of a snapshot folder (`scope`, relative to the repository; "" for the repository) at `root` in the image:
 * `files` are the paths, relative to scope, found under both. */
export interface BakedCopy { root: string; scope: string; files: string[] }

/** What an image holds against a snapshot: its copies, and the files (relative to the repository) that differ. */
export interface Baked { copies: BakedCopy[]; differ: string[] }

/** Paths no copy of the project is looked for under: the mounted code itself, the system and package stores. */
const PRUNED_PATHS = ["/src", "/proc", "/sys", "/dev", "/etc", "/var", "/run", "/tmp", "/boot", "/bin", "/sbin", "/lib",
  "/lib32", "/lib64", "/libx32", "/usr/bin", "/usr/sbin", "/usr/lib", "/usr/libexec", "/usr/share", "/usr/include",
  "/usr/local/cargo", "/usr/local/rustup"];
const PRUNED_NAMES = ["node_modules", "site-packages", "dist-packages", ".git"];
const FIND = `find / -xdev \\( ${[...PRUNED_PATHS.map((p) => `-path ${p}`), ...PRUNED_NAMES.map((n) => `-name ${n}`)]
  .join(" -o ")} \\) -prune -o -type f -print 2>/dev/null; true`;
/** Fewest files of a folder an image path must hold to count as its copy (a stray index.js is not one). */
const MIN_FILES = 3;

const manifestRx = LANGUAGES.flatMap((l) => {
  try {
    return getAdapter(l).manifests.map(globRegex);
  } catch {
    return []; // a language without an adapter yet
  }
});

/** Files under `dir` of the snapshot (POSIX paths relative to it), without manifests (installs copy those on purpose,
 * and they key the image already), dependency folders, git data and the files below `skip` (relative to `dir`). */
export function scopeFiles(snap: string, dir: string, skip: string[] = []): string[] {
  const out: string[] = [];
  const base = join(snap, dir);
  if (!existsSync(base)) return out;
  const visit = (rel: string) => {
    for (const name of readdirSync(join(base, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (skip.includes(r)) continue;
      const st = lstatSync(join(base, r));
      if (st.isDirectory()) {
        if (!PRUNED_NAMES.includes(name)) visit(r);
      } else if (st.isFile() && !manifestRx.some((rx) => rx.test(name))) out.push(r);
    }
  };
  visit("");
  return out.sort();
}

const inRoot = (root: string, f: string) => (root === "/" ? `/${f}` : `${root}/${f}`);

/** Folders of the image that hold a copy of a scope: an image path ending in a scope's file names a candidate root;
 * a root counts when it holds at least MIN_FILES of the scope's files and a fifth of them (or 50). A copy already
 * found from an earlier scope (the project's folder, seen again from the repository's) counts once. */
export function findCopies(imagePaths: string[], scopes: { scope: string; files: string[] }[]): BakedCopy[] {
  const copies: BakedCopy[] = [];
  const seen = new Set<string>();
  for (const { scope, files } of scopes) {
    const byName = new Map<string, string[]>();
    for (const f of files) {
      const name = posix.basename(f);
      byName.set(name, [...byName.get(name) ?? [], f]);
    }
    const roots = new Map<string, Set<string>>();
    for (const p of imagePaths) {
      for (const f of byName.get(posix.basename(p)) ?? []) {
        if (!p.endsWith(`/${f}`)) continue;
        const root = p.slice(0, -f.length - 1) || "/";
        roots.set(root, (roots.get(root) ?? new Set()).add(f));
      }
    }
    for (const [root, found] of roots) {
      const paths = [...found].map((f) => inRoot(root, f));
      if (found.size < MIN_FILES || (found.size < 50 && found.size * 5 < files.length) ||
        paths.every((p) => seen.has(p))) continue;
      for (const p of paths) seen.add(p);
      copies.push({ root, scope, files: [...found].sort() });
    }
  }
  return copies.sort((a, b) => a.root.localeCompare(b.root));
}

const inScope = (scope: string, f: string) => (scope ? `${scope}/${f}` : f);
const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** The snapshot's files (relative to the repository) whose copy in the image has other contents. */
export function differing(copies: BakedCopy[], imageHashes: Map<string, string>, snap: string): string[] {
  const out = new Set<string>();
  for (const c of copies) {
    for (const f of c.files) {
      const rel = inScope(c.scope, f);
      const there = imageHashes.get(inRoot(c.root, f));
      if (there === undefined || there !== sha256(readFileSync(join(snap, rel)))) out.add(rel);
    }
  }
  return [...out].sort();
}

/** The scopes a copy is looked for in: the project's folder (an install that copies `.`) and the repository's. */
function scopesOf(cfg: ReviewConfig, snap: string): { scope: string; files: string[] }[] {
  const project = posix.normalize(cfg.workdir).replace(/^\.$/, "").replace(/\/$/, "");
  // The generated tests' folder changes during a round; whatever the image holds there is not the code under test.
  const tests = posix.normalize(posix.join(project, cfg.testsDir));
  const rel = (s: string) => (s ? posix.relative(s, tests) : tests);
  const scopes = [{ scope: project, files: scopeFiles(snap, project, [rel(project)]) }];
  if (project) scopes.push({ scope: "", files: scopeFiles(snap, "", [tests]) });
  return scopes;
}

const listed = new Map<string, string[]>();

/** The image's files outside the pruned paths, listed once per image (a tag never changes what it holds). */
function imageFiles(image: string): string[] {
  let paths = listed.get(image);
  if (!paths) {
    try {
      const r = docker(["run", "--rm", "--network", "none", image, "sh", "-c", FIND], { timeout: 300 });
      paths = r.stdout.split("\n").filter((l) => l.startsWith("/"));
    } catch {
      paths = []; // an image that cannot list its files is run as before
    }
    listed.set(image, paths);
  }
  return paths;
}

/** sha256 of each path in the image; null when the image cannot say (no sha256sum). */
function imageHashes(image: string, paths: string[]): Map<string, string> | null {
  let stdout: string;
  try {
    stdout = docker(["run", "--rm", "-i", "--network", "none", image, "sh", "-c",
      "tr '\\n' '\\0' | xargs -0 sha256sum"], { timeout: 300, stdin: paths.join("\n") + "\n" }).stdout;
  } catch {
    return null;
  }
  const out = new Map<string, string>();
  for (const line of stdout.split("\n")) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/.exec(line);
    if (m) out.set(m[2]!, m[1]!);
  }
  return out.size ? out : null;
}

/** What `image` holds of the snapshot's code; null when it holds no copy, or the image cannot tell. */
export function bakedIn(cfg: ReviewConfig, image: string, snap: string): Baked | null {
  const copies = findCopies(imageFiles(image), scopesOf(cfg, snap));
  if (!copies.length) return null;
  const hashes = imageHashes(image, copies.flatMap((c) => c.files.map((f) => inRoot(c.root, f))));
  if (!hashes) {
    dockerSteps.log?.({ at: new Date().toISOString(), step: "baked", project: cfg.name,
      roots: copies.map((c) => c.root), unknown: true });
    return null;
  }
  return { copies, differ: differing(copies, hashes, snap) };
}

/** The image key for the code in the snapshot: the environment's key and a hash of the scopes the copies came from. */
export function bakedKey(key: string, copies: BakedCopy[], snap: string): string {
  const h = createHash("sha256");
  for (const scope of [...new Set(copies.map((c) => c.scope))].sort()) {
    for (const f of scopeFiles(snap, scope)) {
      const rel = inScope(scope, f);
      h.update(`${rel}\0`).update(readFileSync(join(snap, rel))).update("\0");
    }
  }
  return `${key}-src-${h.digest("hex").slice(0, 12)}`;
}

const few = (xs: string[]) => xs.slice(0, 3).join(", ") + (xs.length > 3 ? `, and ${xs.length - 3} more` : "");
const where = (b: Baked) => [...new Set(b.copies.map((c) => c.root))].join(", ");

/** Said when the image holds an older copy of the code, so an image of this code is used (built if missing). */
export const rebuildText = (cfg: ReviewConfig, b: Baked) =>
  `${cfg.name}: the test image holds an older copy of the code (${where(b)}); using one made from this code`;

/** Why a run on code the image's copy does not match is refused. */
export const bakedError = (cfg: ReviewConfig, b: Baked) => new ArnxError(`${cfg.name}: the test image holds a copy ` +
  `of the code at ${where(b)} that differs from the code to test in ${b.differ.length} ` +
  `file${b.differ.length === 1 ? "" : "s"} (${few(b.differ)}); tests would run that copy`);
