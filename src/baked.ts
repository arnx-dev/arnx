// Copies of the project's code baked into an environment image. Each run mounts the code under test at /src, but an
// install step can copy the project somewhere else first (`cp -r . /opt/web && next build`): tests that run there
// test that copy, as it was when the image was built, not the change. The image key holds only the manifests, so the
// copy is never refreshed. arnx finds such copies by path and content, keeps those the tests reach (a path the commands
// name, or a symlink under one); when they differ from the code under test it builds the image again from that code,
// or, when that code is not there yet (the before/after check), refuses. A copy made only to install from
// (`cp -r packages /opt/deps && bun install`, its links pointing back to /src) is left alone. A Python project's own
// package installed into the image (`pip install .` into site-packages, or an editable install of a copy outside
// /src) is a copy too when the project's Python imports it from there, as a probe run in the session asks.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getAdapter, LANGUAGES } from "./adapters";
import type { ReviewConfig } from "./config";
import { ArnxError } from "./errors";
import { DEFAULT_LIMITS, docker, dockerSteps, REPORT_DIR, runArgv } from "./sandbox";
import { globRegex } from "./secrets";
import { randomHex, shQuote } from "./util";

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

/** The absolute paths the project's test command, type check and environment name, outside /src (the code under
 * test is mounted there): where its runs can reach into the image. deps_dir counts by its node_modules, which runs
 * link (depsLink in sandbox.ts). */
export function commandPaths(cfg: Pick<ReviewConfig, "testCommand" | "typecheck" | "env" | "depsDir">): string[] {
  const text = [cfg.testCommand, cfg.typecheck ?? "", cfg.depsDir ? `${cfg.depsDir}/node_modules` : "",
    ...Object.values(cfg.env)].join("\n");
  const paths = [...text.matchAll(/(?<![\w.~$}/-])\/[^\s'"`;&|()<>:,=]*/g)].map((m) => m[0].replace(/\/+$/, ""));
  return [...new Set(paths)].filter((p) => p && p !== "/src" && !p.startsWith("/src/")).sort();
}

const under = (p: string, dir: string) => dir === "/" || p === dir || p.startsWith(`${dir}/`);
/** `p` inside `root` without passing through a dependency folder (a copy's node_modules is not its code). */
const into = (p: string, root: string) =>
  under(p, root) && !p.slice(root.length).split("/").some((s) => PRUNED_NAMES.includes(s));

/** Whether runs reach a copy at `root`: a path the commands name leads into it or holds it, or a symlink under such a
 * path (a workspace link in node_modules) resolves into it. `links` are [symlink, resolved target]. */
export function reached(root: string, paths: string[], links: [string, string][]): boolean {
  return paths.some((p) => into(p, root) || under(root, p)) ||
    links.some(([link, target]) => paths.some((p) => under(link, p)) && into(target, root));
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

/** Where `arnx accept` keeps tests (testround.ts DOME); `arnx check` puts each in place from there. */
const KEPT = ".arnx/tests";

/** What in a scope is not the code under test (relative to the scope): the generated tests' folder (it changes during
 * a round), and in the repository's scope arnx's own folder, the runners' reports and the accepted tests a check put
 * in place. */
function notCode(cfg: ReviewConfig, snap: string, scope: string): string[] {
  const tests = posix.normalize(posix.join(projectOf(cfg), cfg.testsDir));
  const rel = (p: string) => (scope ? posix.relative(scope, p) : p);
  const kept = existsSync(join(snap, KEPT)) ? (readdirSync(join(snap, KEPT), { recursive: true }) as string[])
    .map((p) => p.split("\\").join("/")).filter((p) => statSync(join(snap, KEPT, p)).isFile()) : [];
  return [tests, ".arnx", REPORT_DIR, ...kept].filter((p) => !scope || p.startsWith(`${scope}/`)).map(rel);
}

const projectOf = (cfg: ReviewConfig) => posix.normalize(cfg.workdir).replace(/^\.$/, "").replace(/\/$/, "");

/** The scopes a copy is looked for in: the project's folder (an install that copies `.`) and the repository's. */
function scopesOf(cfg: ReviewConfig, snap: string): { scope: string; files: string[] }[] {
  const project = projectOf(cfg);
  const scopes = [{ scope: project, files: scopeFiles(snap, project, notCode(cfg, snap, project)) }];
  if (project) scopes.push({ scope: "", files: scopeFiles(snap, "", notCode(cfg, snap, "")) });
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

/** The symlinks under `paths` in the image, each with the path it resolves to; none when the image cannot say. */
function imageLinks(image: string, paths: string[]): [string, string][] {
  if (!paths.length) return [];
  try {
    const r = docker(["run", "--rm", "--network", "none", image, "sh", "-c", `for p; do [ -e "$p" ] || [ -L "$p" ] ` +
      `|| continue; find "$p" -type l 2>/dev/null; done | while IFS= read -r l; do ` +
      `printf '%s\\t%s\\n' "$l" "$(readlink -f "$l")"; done; true`, "sh", ...paths], { timeout: 300 });
    return r.stdout.split("\n").map((l) => l.split("\t")).filter((p): p is [string, string] =>
      p.length === 2 && p[0]!.startsWith("/") && p[1]!.startsWith("/"));
  } catch {
    return [];
  }
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

/** The import name of the project's package: pyproject.toml's [project] name, else setup.cfg's [metadata] name, in
 * the project's folder, then the repository's; `-` becomes `_`. Null when neither names one. */
export function packageName(cfg: ReviewConfig, snap: string): string | null {
  for (const dir of [...new Set([projectOf(cfg), ""])]) {
    let name: unknown;
    try {
      name = (parseToml(readFileSync(join(snap, dir, "pyproject.toml"), "utf8")).project as { name?: unknown })?.name;
    } catch {
      name = undefined; // no pyproject.toml, or one that does not read
    }
    if (typeof name !== "string") {
      try {
        const cfgText = readFileSync(join(snap, dir, "setup.cfg"), "utf8");
        const metadata = /^\[metadata\][ \t]*$([\s\S]*?)(?=^\[|(?![\s\S]))/m.exec(cfgText)?.[1] ?? "";
        name = /^name[ \t]*[=:][ \t]*(\S+)[ \t]*$/m.exec(metadata)?.[1];
      } catch {
        name = undefined;
      }
    }
    if (typeof name === "string" && /^[A-Za-z0-9][\w.-]*$/.test(name)) return name.replaceAll("-", "_");
  }
  return null;
}

/** The package `name` in the snapshot, under the project's folder (shallowest first): a folder of that name holding
 * Python files, or a module `<name>.py`. Repository paths; null when there is none. */
function packageInSnapshot(cfg: ReviewConfig, snap: string, name: string): { dir: string } | { module: string } | null {
  const tests = posix.normalize(posix.join(projectOf(cfg), cfg.testsDir));
  let level = [projectOf(cfg)];
  for (let depth = 0; depth < 4 && level.length; depth++) {
    const next: string[] = [];
    for (const dir of level) {
      let names: string[];
      try {
        names = readdirSync(join(snap, dir)).sort();
      } catch {
        continue;
      }
      for (const n of names) {
        const rel = dir ? `${dir}/${n}` : n;
        const st = lstatSync(join(snap, rel));
        if (n === `${name}.py` && st.isFile()) return { module: rel };
        if (!st.isDirectory() || n.startsWith(".") || PRUNED_NAMES.includes(n) || rel === tests) continue;
        if (n === name && readdirSync(join(snap, rel)).some((f) => f.endsWith(".py"))) return { dir: rel };
        next.push(rel);
      }
    }
    level = next;
  }
  return null;
}

// Prints where the package named by argv[1] imports from (its folder for a namespace package), without importing it.
const PROBE = `import importlib.util, sys
try:
    s = importlib.util.find_spec(sys.argv[1])
except Exception:
    s = None
o = s and (s.origin if s.origin not in (None, "namespace") else next(iter(s.submodule_search_locations or []), None))
print("arnx-package:", o or "")`;

/** Where the project's Python imports `name` from, asked as a test run would (the code under test at /src, the
 * project's folder, its env, no network); null when the probe fails or finds no package. */
function packageOrigin(cfg: ReviewConfig, image: string, snap: string, name: string): string | null {
  const command = `p=$(command -v python3 || command -v python) || exit 1; "$p" -c ${shQuote(PROBE)} ${shQuote(name)}`;
  const argv = runArgv({ image, name: `arnx-probe-${randomHex(3)}`, network: "none", snapshot: snap,
    workdir: cfg.workdir, env: cfg.env, command, limits: DEFAULT_LIMITS,
    user: `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`, runEnv: getAdapter(cfg.language).runEnv });
  try {
    const r = docker(argv.slice(1), { timeout: 120 });
    const origin = /^arnx-package: (\/.*)$/m.exec(r.stdout)?.[1]?.trim();
    return r.status === 0 && origin ? origin : null;
  } catch {
    return null;
  }
}

/** The project's package as the image holds it outside /src, when its Python imports it from there: a copy of the
 * package's folder in the snapshot (or of its module alone), with the files the image has and their hashes. Says in
 * docker.jsonl what the probe found. */
function packageCopy(cfg: ReviewConfig, image: string, snap: string)
  : { copy: BakedCopy; hashes: Map<string, string> } | null {
  const name = cfg.language === "python" ? packageName(cfg, snap) : null;
  const local = name && packageInSnapshot(cfg, snap, name);
  if (!name || !local) return null;
  const origin = packageOrigin(cfg, image, snap, name);
  const log = (copy: string | null, more: Record<string, unknown> = {}) => dockerSteps.log?.({
    at: new Date().toISOString(), step: "package", project: cfg.name, package: name, origin, copy, ...more });
  const outside = origin && origin !== "/src" && !origin.startsWith("/src/");
  const root = !outside ? null : "dir" in local
    ? (posix.basename(origin) === "__init__.py" ? posix.dirname(origin) : posix.extname(origin) ? null : origin)
    : posix.basename(origin) === `${name}.py` ? posix.dirname(origin) : null;
  if (!root) {
    log(null);
    return null;
  }
  const scope = "dir" in local ? local.dir : posix.dirname(local.module);
  const wanted = "dir" in local ? scopeFiles(snap, scope, notCode(cfg, snap, scope)) : [`${name}.py`];
  const hashes = imageHashes(image, wanted.map((f) => inRoot(root, f))) ?? new Map<string, string>();
  const files = wanted.filter((f) => hashes.has(inRoot(root, f)));
  if (!files.length) {
    log(null, { unknown: true });
    return null;
  }
  const copy = { root, scope, files };
  log(root, { differ: differing([copy], hashes, snap).length });
  return { copy, hashes };
}

/** What `image` holds of the snapshot's code that runs reach; null when it holds no such copy, or cannot tell. */
export function bakedIn(cfg: ReviewConfig, image: string, snap: string): Baked | null {
  const paths = commandPaths(cfg);
  let links: [string, string][] | undefined;
  const copies = findCopies(imageFiles(image), scopesOf(cfg, snap)).filter((c) =>
    reached(c.root, paths, []) || reached(c.root, paths, links ??= imageLinks(image, paths)));
  const pkg = packageCopy(cfg, image, snap);
  if (!copies.length && !pkg) return null;
  const hashes = new Map(pkg?.hashes);
  if (copies.length) {
    const found = imageHashes(image, copies.flatMap((c) => c.files.map((f) => inRoot(c.root, f))));
    if (!found) {
      dockerSteps.log?.({ at: new Date().toISOString(), step: "baked", project: cfg.name,
        roots: copies.map((c) => c.root), unknown: true });
      return null;
    }
    for (const [p, h] of found) hashes.set(p, h);
  }
  if (pkg && !copies.some((c) => c.root === pkg.copy.root)) copies.push(pkg.copy);
  return { copies, differ: differing(copies, hashes, snap) };
}

/** The image key for the code in the snapshot: the environment's key and a hash of the code in the scopes the copies
 * came from. Tests and reports beside the code do not count, so every session on the same code (a round, its answer
 * rounds, a check) and every later review of it use one image. */
export function bakedKey(key: string, cfg: ReviewConfig, copies: BakedCopy[], snap: string): string {
  const h = createHash("sha256");
  const wanted = new Set(copies.map((c) => c.scope));
  const known = scopesOf(cfg, snap);
  // A package's folder (packageCopy) is a scope of its own, after the project's and the repository's.
  const own = [...wanted].filter((w) => !known.some((s) => s.scope === w)).sort()
    .map((scope) => ({ scope, files: scopeFiles(snap, scope, notCode(cfg, snap, scope)) }));
  for (const { scope, files } of [...known.filter((s) => wanted.has(s.scope)), ...own]) {
    for (const f of files) {
      const rel = inScope(scope, f);
      h.update(`${rel}\0`).update(readFileSync(join(snap, rel))).update("\0");
    }
  }
  return `${key}-src-${h.digest("hex").slice(0, 12)}`;
}

/** Where an image holds copies of the code, and the files (repository paths) only those copies hold. */
export interface CopyOnly { roots: string[]; files: string[] }

/** Files the copies hold that the snapshot does not (repository paths), outside the generated tests' folder `tests`:
 * those the output names first, then those beside the code (their folder is in the snapshot), shallowest first. A
 * whole folder only the copy has (a build's output) counts only when the output names its file. */
export function onlyInCopies(copies: BakedCopy[], imagePaths: string[], snap: string, output: string, tests: string)
  : string[] {
  const named: string[] = [], beside: string[] = [];
  // Every path the output names, and each tail of it (`/src/a/b.db` names `a/b.db` and `b.db`).
  const mentioned = new Set<string>();
  for (const token of output.match(/[\w@+.-][\w@+./-]*/g) ?? []) {
    const parts = token.replace(/\.+$/, "").split("/");
    for (let i = 0; i < parts.length; i++) mentioned.add(parts.slice(i).join("/"));
  }
  for (const c of copies) {
    const prefix = c.root === "/" ? "/" : `${c.root}/`;
    for (const p of imagePaths) {
      if (!p.startsWith(prefix)) continue;
      const rel = inScope(c.scope, p.slice(prefix.length));
      if (rel.startsWith(`${tests}/`) || existsSync(join(snap, rel))) continue;
      if (mentioned.has(rel)) named.push(rel);
      else if (existsSync(join(snap, posix.dirname(rel)))) beside.push(rel);
    }
  }
  const depth = (p: string) => p.split("/").length;
  return [...new Set([...named.sort(),
    ...beside.sort((a, b) => depth(a) - depth(b) || a.localeCompare(b))])];
}

/** The image's copies reached by runs, and the files only they hold (the output's first). */
export function copyOnly(cfg: ReviewConfig, image: string, copies: BakedCopy[], snap: string, output: string)
  : CopyOnly {
  const tests = posix.normalize(posix.join(cfg.workdir, cfg.testsDir));
  return { roots: [...new Set(copies.map((c) => c.root))],
    files: onlyInCopies(copies, imageFiles(image), snap, output, tests) };
}

/** Said when the environment runs no test and the image holds a copy of the code: before 0.1.2 the tests could run
 * on that copy as setup left it, files the install made there included. */
export function copyStopText(cfg: ReviewConfig, c: CopyOnly): string {
  const at = c.roots.join(", ");
  const again = `Set the project up again: arnx setup --project ${cfg.name}`;
  if (!c.files.length) {
    return `${cfg.name}: the image holds a copy of the code (${at}); a setup that relied on it can stop here since ` +
      `arnx 0.1.2. ${again}`;
  }
  const more = c.files.length - 3;
  const list = more > 0 ? `${c.files.slice(0, 3).join(", ")} and ${more} more` : c.files.join(", ");
  return `${cfg.name}: ${list} exist${c.files.length === 1 ? "s" : ""} only in the image's copy of the code (${at}), ` +
    `not in /src. ${again}`;
}

const where = (b: Baked) => [...new Set(b.copies.map((c) => c.root))].join(", ");

/** Said when the image holds an older copy of the code, so an image of this code is used (built if missing). */
export const rebuildText = (cfg: ReviewConfig, b: Baked) =>
  `${cfg.name}: the test image holds an older copy of the code (${where(b)}); using one made from this code`;

/** Why a run on code the image's copy does not match is refused (one short line: the before/after check quotes it in
 * each finding). */
export const bakedError = (cfg: ReviewConfig, b: Baked) => new ArnxError(`${cfg.name}: the tests run the image's own ` +
  `copy of the code at ${where(b)}, which differs from this code in ${b.differ.length} ` +
  `file${b.differ.length === 1 ? "" : "s"}`);
