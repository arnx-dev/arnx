// Where arnx writes a project's tests, worked out from its runner's own configuration before setup's first try: the
// adapter's default folder may lie outside what vitest's include, jest's roots and testMatch or pytest's testpaths
// collect. Configuration written in JavaScript is code: only literal values are read, and anything else leaves the
// default to try_project's one-line test, as before.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { getAdapter } from "./adapters";
import type { ReviewConfig } from "./config";

/** A folder for arnx's tests (relative to the project's root) and what in the configuration says it is collected. */
export interface TestsDirChoice { dir: string; why: string }

/** The folder arnx creates inside a folder the runner collects. */
const GENERATED = "arnx_generated";
/** The repository's path in the sandbox. */
const MOUNT = "/src";

/** tests_dir from the runner's configuration in the snapshot `snap`, when the folder the project has now
 * (cfg.testsDir) is not collected and a new folder inside one that is would be; null when the folder it has is
 * collected, or the configuration cannot be read for sure. */
export function testsDirFor(snap: string, cfg: Pick<ReviewConfig, "language" | "runner" | "workdir" | "testCommand"
  | "testsDir">): TestsDirChoice | null {
  const reader = cfg.language === "python" ? pytestReader : cfg.runner === "vitest" ? vitestReader
    : cfg.runner === "jest" ? jestReader : null;
  const r = reader?.(snap, cfg.workdir, cfg.testCommand);
  if (!r) return null;
  const names = getAdapter(cfg.language).probes(cfg.runner).map((p) => p.file);
  const workdir = posix.normalize(cfg.workdir);
  const collected = (dir: string) => names.some((n) => r.covers(posix.join(dir, n)));
  if (collected(posix.join(workdir, cfg.testsDir))) return null;
  const writable = getAdapter(cfg.language).writable;
  // The project's own tests the runner collects: their folders are candidates too (a testRegex names no folder).
  const own = filesUnder(snap, workdir).filter(r.covers);
  const folders = [...new Set(own.map((f) => posix.dirname(f)))]
    .sort((a, b) => a.split("/").length - b.split("/").length || (a < b ? -1 : 1));
  const tried = [...r.candidates, ...folders.map((d) => posix.join(d, GENERATED))].map((c) => posix.normalize(c));
  const fit = [...new Set(tried)].filter((dir) => {
    const rel = posix.relative(workdir, dir);
    return rel && !rel.startsWith("..") && !posix.isAbsolute(rel) && !holdsWritable(join(snap, dir), writable) &&
      collected(dir);
  });
  if (!fit.length) return null;
  // Beside the project's own tests: the folder holding most of them.
  const count = (dir: string) => {
    const parent = posix.dirname(dir);
    return own.filter((f) => parent === "." || f.startsWith(`${parent}/`)).length;
  };
  const counts = new Map(fit.map((d) => [d, count(d)]));
  const best = [...fit].sort((a, b) => counts.get(b)! - counts.get(a)!)[0]!;
  return { dir: posix.relative(workdir, best), why: r.why };
}

/** Most files filesUnder lists. */
const FILES_MAX = 5000;

/** Files under `dir` (relative to the repository), node_modules and hidden folders left out; at most FILES_MAX. */
function filesUnder(snap: string, dir: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    const abs = join(snap, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs).sort()) {
      if (out.length >= FILES_MAX) return;
      const r = rel === "." ? name : `${rel}/${name}`;
      const st = lstatSync(join(abs, name));
      if (st.isDirectory()) {
        if (name !== "node_modules" && !name.startsWith(".")) visit(r);
      } else if (st.isFile()) out.push(r);
    }
  };
  visit(dir);
  return out;
}

/** What a runner's configuration collects: whether it runs a file (relative to the repository), the folders worth
 * trying (relative to the repository), and the configuration's words for it. */
interface Reader { covers: (file: string) => boolean; candidates: string[]; why: string }

function holdsWritable(abs: string, writable: RegExp): boolean {
  if (!existsSync(abs)) return false;
  return readdirSync(abs, { recursive: true }).some((n) => writable.test(posix.basename(String(n))));
}

// ---- vitest -------------------------------------------------------------------------------------------------------

const VITEST_INCLUDE = ["**/*.{test,spec}.?(c|m)[jt]s?(x)"];
const VITEST_EXCLUDE = ["**/node_modules/**", "**/dist/**"];
const CONFIG_EXTS = ["ts", "mts", "cts", "js", "mjs", "cjs"];

/** A vitest project: its root (relative to the repository) and its include and exclude globs. */
interface Collects { root: string; include: string[]; exclude: string[] }

function vitestReader(snap: string, workdir: string, command: string): Reader | null {
  const run = runnerArgs(command, /(?:^|\/)vitest(?:\.m?js)?$/, workdir);
  if (!run) return null;
  const at = (flags: string[]) => optionOf(run.args, flags);
  const rootArg = at(["--root", "-r"]);
  let root = rootArg === undefined ? run.cwd : inRepo(run.cwd, rootArg);
  if (root === null) return null;
  const configArg = at(["--config", "-c"]);
  const file = configArg === undefined ? firstFile(snap, root, ["vitest.config", "vite.config"]) : inRepo(run.cwd, configArg);
  if (file === null) return null;
  const config = file === undefined ? {} : configIn(snap, file);
  if (!isObj(config)) return null;
  const test = config.test ?? (SPREAD in config ? UNKNOWN : {});
  if (!isObj(test)) return null;
  for (const r of [config.root, test.root]) {
    if (r === undefined) continue;
    if (typeof r !== "string") return null;
    root = inRepo(run.cwd, r);
    if (root === null) return null;
  }
  const dirArg = at(["--dir"]);
  const base = dirArg !== undefined ? inRepo(run.cwd, dirArg) : typeof test.dir === "string" ? inRepo(root, test.dir)
    : test.dir === undefined ? root : null;
  if (base === null) return null;
  const listed = test.projects ?? test.workspace ?? workspaceFile(snap, root);
  let projects: Collects[];
  if (listed === undefined) {
    const one = collects(base, test, undefined);
    if (!one) return null;
    projects = [one];
  } else {
    if (!Array.isArray(listed)) return null;
    const wanted = optionsOf(run.args, "--project");
    projects = listed.flatMap((p) => vitestProject(snap, root!, p, test, wanted));
  }
  if (!projects.length) return null;
  return {
    covers: (f) => projects.some((p) => collectedBy(p, f)),
    candidates: projects.flatMap((p) => p.include.map((g) => posix.join(p.root, staticPrefix(g), GENERATED))),
    why: "vitest include",
  };
}

/** A project's include and exclude; null when they are not literal. `parent`: the root configuration's test options,
 * which a project inherits with `extends: true`. */
function collects(root: string, test: Obj, parent: Obj | undefined): Collects | null {
  const include = test.include ?? parent?.include ?? (SPREAD in test ? UNKNOWN : VITEST_INCLUDE);
  const exclude = test.exclude ?? parent?.exclude ?? VITEST_EXCLUDE;
  if (!isStrings(include) || !isStrings(exclude)) return null;
  return { root, include, exclude };
}

/** One entry of vitest's projects (or workspace): an inline project, or a path to a project's folder or configuration;
 * none when it cannot be read or `wanted` (--project) leaves it out. */
function vitestProject(snap: string, root: string, p: Lit, parent: Obj, wanted: string[]): Collects[] {
  const pick = (name: Lit | undefined) => !wanted.length || (typeof name === "string" && wanted.some((w) => globRegex(w).test(name)));
  if (isObj(p)) {
    const test = p.test ?? {};
    if (!isObj(test) || !pick(test.name ?? p.name)) return [];
    const at = test.root ?? p.root;
    const r = at === undefined ? root : typeof at === "string" ? inRepo(root, at) : null;
    const c = r === null ? null : collects(r, test, p.extends === true ? parent : undefined);
    return c ? [c] : [];
  }
  if (typeof p !== "string" || /[*?{[]/.test(p.replace(/\/\*$/, ""))) return [];
  const at = inRepo(root, p.replace(/\/\*$/, ""));
  if (at === null) return [];
  const dirs = p.endsWith("/*") ? subdirs(snap, at) : [at];
  return dirs.flatMap((d) => {
    const full = join(snap, d);
    if (!existsSync(full)) return [];
    const file = lstatSync(full).isFile() ? d : firstFile(snap, d, ["vitest.config", "vite.config"]);
    if (!file) return [];
    const config = configIn(snap, file);
    const test = isObj(config) ? config.test ?? {} : UNKNOWN;
    if (!isObj(test) || !pick(test.name)) return [];
    const c = collects(posix.dirname(file), test, undefined);
    return c ? [c] : [];
  });
}

/** A vitest.workspace (or vitest.projects) file's list in `root`; undefined with none. */
function workspaceFile(snap: string, root: string): Lit | undefined {
  for (const name of ["vitest.workspace", "vitest.projects"]) {
    const json = posix.join(root, `${name}.json`);
    if (existsSync(join(snap, json))) return jsonIn(snap, json);
    const file = firstFile(snap, root, [name]);
    if (file) return configIn(snap, file);
  }
  return undefined;
}

function collectedBy(p: Collects, file: string): boolean {
  const rel = posix.relative(p.root, file);
  if (rel.startsWith("..")) return false;
  return p.include.some((g) => globRegex(g).test(rel)) && !p.exclude.some((g) => globRegex(g).test(rel));
}

// ---- jest ---------------------------------------------------------------------------------------------------------

const JEST_MATCH = ["**/__tests__/**/*.?([mc])[jt]s?(x)", "**/?(*.)+(spec|test).?([mc])[jt]s?(x)"];

function jestReader(snap: string, workdir: string, command: string): Reader | null {
  const run = runnerArgs(command, /(?:^|\/)jest(?:\.js)?$/, workdir);
  if (!run) return null;
  const arg = optionOf(run.args, ["--config", "-c"]);
  let config: Lit;
  let dir: string;
  if (arg !== undefined && arg.trim().startsWith("{")) {
    config = parseJson(arg);
    dir = run.cwd;
  } else {
    const file = arg !== undefined ? inRepo(run.cwd, arg) : jestConfigFile(snap, run.cwd);
    if (!file) return null;
    config = posix.basename(file) === "package.json" ? (asObj(jsonIn(snap, file))?.jest ?? {})
      : file.endsWith(".json") ? jsonIn(snap, file) : configIn(snap, file);
    dir = posix.dirname(file);
  }
  if (!isObj(config)) return null;
  const rootDir = config.rootDir === undefined ? dir : typeof config.rootDir === "string" ? inRepo(dir, config.rootDir)
    : null;
  if (rootDir === null) return null;
  const projects = config.projects === undefined ? [jestProject(config, rootDir)]
    : Array.isArray(config.projects) ? config.projects.map((p) => isObj(p) ? jestProject(p, rootDir) : null) : [null];
  const known = projects.filter((p): p is JestProject => p !== null);
  if (!known.length) return null;
  return {
    covers: (f) => known.some((p) => p.covers(f)),
    candidates: known.flatMap((p) => p.candidates),
    why: "jest roots and testMatch",
  };
}

type JestProject = { covers: (file: string) => boolean; candidates: string[] };

/** One jest configuration (or project) whose <rootDir> is `rootDir`; null when what decides the files is not literal. */
function jestProject(c: Obj, rootDir: string): JestProject | null {
  const unsure = SPREAD in c;
  const abs = (p: string) => p.replaceAll("<rootDir>", posix.join(MOUNT, rootDir));
  const rel = (p: string) => inRepo(rootDir, p.replaceAll("<rootDir>", posix.join(MOUNT, rootDir)));
  const rootsLit = c.roots ?? (unsure ? UNKNOWN : ["<rootDir>"]);
  if (!isStrings(rootsLit)) return null;
  const roots = rootsLit.map(rel);
  if (roots.some((r) => r === null)) return null;
  const regexLit = typeof c.testRegex === "string" ? [c.testRegex] : c.testRegex;
  const matchLit = c.testMatch ?? (regexLit !== undefined ? [] : unsure ? UNKNOWN : JEST_MATCH);
  const ignoreLit = c.testPathIgnorePatterns ?? ["/node_modules/"];
  if (!isStrings(matchLit) || (regexLit !== undefined && !isStrings(regexLit)) || !isStrings(ignoreLit)) return null;
  const regexes = (regexLit ?? []).map(regexOf);
  const ignores = ignoreLit.map((p) => regexOf(abs(p)));
  if ([...regexes, ...ignores].some((r) => r === null)) return null;
  const globs = matchLit.map((g) => globRegex(abs(g)));
  const covers = (file: string) => {
    const path = posix.join(MOUNT, file);
    return roots.some((r) => r === "." || file.startsWith(`${r}/`)) && !ignores.some((r) => r!.test(path)) &&
      (regexLit !== undefined ? regexes.some((r) => r!.test(path)) : globs.some((g) => g.test(path)));
  };
  const prefixed = matchLit.map(abs).filter((g) => g.startsWith(`${MOUNT}/`))
    .map((g) => inRepo(".", staticPrefix(g))).filter((p): p is string => p !== null);
  const candidates = [...(roots as string[]).flatMap((r) => [posix.join(r, GENERATED), posix.join(r, "__tests__", GENERATED)]),
    ...prefixed.map((p) => posix.join(p, GENERATED))];
  return { covers, candidates };
}

/** The configuration jest finds from `cwd`: a jest.config file or a package.json, in `cwd` or the nearest folder
 * above it that has one; null with none in the repository. */
function jestConfigFile(snap: string, cwd: string): string | null {
  for (let d = cwd; ; d = posix.dirname(d)) {
    const file = firstFile(snap, d, ["jest.config"], [...CONFIG_EXTS, "json"]);
    if (file) return file;
    if (existsSync(join(snap, d, "package.json"))) return posix.join(d, "package.json");
    if (d === "." || d === "/") return null;
  }
}

// ---- pytest -------------------------------------------------------------------------------------------------------

/** pytest's testpaths: where it collects when given no paths. arnx gives the files it runs, so a folder outside them
 * still runs; one inside them gets the conftest.py files and the place the project's own tests have. */
function pytestReader(snap: string, workdir: string, command: string): Reader | null {
  const run = runnerArgs(command, /(?:^|\/)(?:pytest|py\.test)$/, workdir, true);
  if (!run) return null;
  const arg = optionOf(run.args, ["-c", "--config-file"]);
  const found = arg !== undefined ? pytestIni(snap, inRepo(run.cwd, arg)) : nearestIni(snap, run.cwd);
  if (!found) return null;
  const paths = found.testpaths;
  if (!paths?.length) return null;
  const dirs = paths.map((p) => inRepo(found.dir, p)).filter((p): p is string => p !== null);
  return {
    covers: (f) => dirs.some((d) => d === "." || f.startsWith(`${d}/`) || globRegex(`${d}/**`).test(f)),
    candidates: dirs.filter((d) => !/[*?[]/.test(d) && existsSync(join(snap, d)) && lstatSync(join(snap, d)).isDirectory())
      .map((d) => posix.join(d, GENERATED)),
    why: "pytest testpaths",
  };
}

/** The pytest configuration nearest `cwd` (pytest.ini, pyproject.toml, tox.ini, setup.cfg, in pytest's order). */
function nearestIni(snap: string, cwd: string): { dir: string; testpaths?: string[] } | null {
  for (let d = cwd; ; d = posix.dirname(d)) {
    for (const name of ["pytest.ini", ".pytest.ini", "pyproject.toml", "tox.ini", "setup.cfg"]) {
      const found = pytestIni(snap, posix.join(d, name));
      if (found) return found;
    }
    if (d === "." || d === "/") return null;
  }
}

/** A file's pytest configuration: null when it holds none (pytest.ini always counts). */
function pytestIni(snap: string, file: string | null): { dir: string; testpaths?: string[] } | null {
  if (!file || !existsSync(join(snap, file))) return null;
  const text = readFileSync(join(snap, file), "utf8");
  const name = posix.basename(file);
  const dir = posix.dirname(file);
  if (name === "pyproject.toml") {
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(text) as Record<string, unknown>;
    } catch {
      return null;
    }
    const tool = (doc.tool as Record<string, Record<string, unknown>> | undefined)?.pytest;
    const opts = (tool?.ini_options ?? tool) as Record<string, unknown> | undefined;
    if (!opts) return null;
    const tp = opts.testpaths;
    return { dir, testpaths: typeof tp === "string" ? tp.split(/\s+/).filter(Boolean)
      : Array.isArray(tp) ? tp.map(String) : undefined };
  }
  const section = name === "setup.cfg" ? "tool:pytest" : "pytest";
  const values = iniSection(text, section);
  if (!values) return name.endsWith("pytest.ini") ? { dir } : null;
  return { dir, testpaths: values.testpaths?.split(/\s+/).filter(Boolean) };
}

/** One section of an ini file: its keys, continuation lines joined; null when it has no such section. */
function iniSection(text: string, section: string): Record<string, string> | null {
  let inside = false;
  let found = false;
  let key = "";
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const head = /^\s*\[([^\]]+)\]/.exec(line);
    if (head) {
      inside = head[1]!.trim() === section;
      found ||= inside;
      key = "";
      continue;
    }
    if (!inside || /^\s*[#;]/.test(line)) continue;
    const kv = /^([\w.-]+)\s*[=:]\s*(.*)$/.exec(line);
    if (kv) {
      key = kv[1]!;
      out[key] = kv[2]!.trim();
    } else if (key && /^\s+\S/.test(line)) out[key] += ` ${line.trim()}`;
  }
  return found ? out : null;
}

// ---- test_command -------------------------------------------------------------------------------------------------

/** The runner's arguments in `command` and the folder it runs in (relative to the repository; the command starts in
 * `workdir` and may cd); null when the runner is not found or the folder is not known. `module`: `python -m pytest`
 * counts. */
export function runnerArgs(command: string, runner: RegExp, workdir: string, module = false)
  : { cwd: string; args: string[] } | null {
  let cwd: string | null = posix.normalize(workdir);
  for (const words of commandsOf(command)) {
    if (words[0] === "cd") {
      const to = words[1];
      cwd = to === undefined || (cwd === null && !to.startsWith("/")) ? null : inRepo(cwd ?? ".", to);
      continue;
    }
    const at = words.findIndex((w, i) => runner.test(w) || (module && w === "-m" && runner.test(words[i + 1] ?? "")));
    if (at < 0) continue;
    if (cwd === null) return null;
    return { cwd, args: words.slice(words[at] === "-m" ? at + 2 : at + 1) };
  }
  return null;
}

/** The simple commands of a shell line, as words: quotes removed, operators (&&, ||, ;, |, parentheses) between. */
function commandsOf(line: string): string[][] {
  const out: string[][] = [];
  let words: string[] = [];
  let word: string | null = null;
  const end = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === "'" || c === '"') {
      const close = line.indexOf(c, i + 1);
      word = (word ?? "") + line.slice(i + 1, close < 0 ? line.length : close);
      i = close < 0 ? line.length : close;
    } else if (c === "\\" && i + 1 < line.length) {
      word = (word ?? "") + line[++i];
    } else if (/\s/.test(c) && c !== "\n") {
      end();
    } else if ("&|;()\n".includes(c)) {
      end();
      if (words.length) out.push(words);
      words = [];
    } else word = (word ?? "") + c;
  }
  end();
  if (words.length) out.push(words);
  return out;
}

/** The value of the last of `flags` among `args` (`--config x` or `--config=x`). */
function optionOf(args: string[], flags: string[]): string | undefined {
  let value: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf("=");
    if (flags.includes(a) && i + 1 < args.length) value = args[++i];
    else if (eq > 0 && flags.includes(a.slice(0, eq))) value = a.slice(eq + 1);
  }
  return value;
}

/** Every value of `flag` among `args`. */
function optionsOf(args: string[], flag: string): string[] {
  return args.flatMap((a, i) => a === flag && i + 1 < args.length ? [args[i + 1]!]
    : a.startsWith(`${flag}=`) ? [a.slice(flag.length + 1)] : []);
}

/** `p` (relative to `cwd`, or absolute in the sandbox) relative to the repository; null outside it, or when it holds a
 * variable. */
export function inRepo(cwd: string, p: string): string | null {
  if (/[$`~]/.test(p) || /\{targets\}/.test(p)) return null;
  const n = posix.normalize(p.startsWith("/") ? p : posix.join(MOUNT, cwd, p));
  if (n === MOUNT || n === `${MOUNT}/`) return ".";
  return n.startsWith(`${MOUNT}/`) ? n.slice(MOUNT.length + 1).replace(/\/$/, "") : null;
}

function firstFile(snap: string, dir: string, names: string[], exts = CONFIG_EXTS): string | undefined {
  for (const n of names) {
    for (const e of exts) {
      const p = posix.join(dir, `${n}.${e}`);
      if (existsSync(join(snap, p))) return p;
    }
  }
  return undefined;
}

function subdirs(snap: string, dir: string): string[] {
  const abs = join(snap, dir);
  if (!existsSync(abs)) return [];
  return readdirSync(abs).filter((n) => lstatSync(join(abs, n)).isDirectory()).sort().map((n) => posix.join(dir, n));
}

// ---- globs and literals -------------------------------------------------------------------------------------------

/** The folders of a glob before its first wildcard ("src/**\/*.test.ts" → "src"). */
export function staticPrefix(glob: string): string {
  const parts = glob.replace(/^\.\//, "").split("/");
  const fixed: string[] = [];
  for (const p of parts.slice(0, -1)) {
    if (/[*?{}[\]()!+@]/.test(p)) break;
    fixed.push(p);
  }
  return fixed.join("/") || ".";
}

/** A glob as vitest and jest read it (picomatch): ** across folders, * and ? within one, {a,b}, [abc], (a|b), and
 * ?(…) *(…) +(…) @(…). A pattern it cannot read matches nothing. */
export function globRegex(glob: string): RegExp {
  let out = "";
  const groups: string[] = [];
  const g = glob.replace(/^\.\//, "");
  for (let i = 0; i < g.length; i++) {
    const c = g[i]!;
    const next = g[i + 1];
    if (c === "*" && next === "*") {
      const slash = g[i + 2] === "/";
      const start = i === 0 || g[i - 1] === "/";
      out += slash && start ? "(?:[^/]*/)*" : ".*";
      i += slash && start ? 2 : 1;
    } else if ("?*+@!".includes(c) && next === "(") {
      if (c === "!") return /$^/;
      groups.push(c === "@" ? ")" : `)${c}`);
      out += "(?:";
      i++;
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "(") {
      groups.push(")");
      out += "(?:";
    } else if (c === "{") {
      groups.push("}");
      out += "(?:";
    } else if (c === ")" && groups.length && groups.at(-1) !== "}") out += groups.pop();
    else if (c === "}" && groups.at(-1) === "}") {
      groups.pop();
      out += ")";
    } else if (c === "|" && groups.length) out += "|";
    else if (c === "," && groups.at(-1) === "}") out += "|";
    else if (c === "[") {
      const close = g.indexOf("]", i + 2);
      if (close < 0) return /$^/;
      out += `[${g.slice(i + 1, close).replace(/^!/, "^")}]`;
      i = close;
    } else out += c.replace(/[.+^$|\\/()[\]{}]/g, "\\$&");
  }
  if (groups.length) return /$^/;
  try {
    return new RegExp(`^${out}$`);
  } catch {
    return /$^/;
  }
}

function regexOf(source: string): RegExp | null {
  try {
    return new RegExp(source);
  } catch {
    return null;
  }
}

/** A value the configuration computes (a call, a variable): not read. */
export const UNKNOWN = Symbol("unknown");
/** The key an object literal with a spread (`...base`) holds: keys it does not name may come from there. */
export const SPREAD = "\0spread";
export type Lit = string | number | boolean | null | typeof UNKNOWN | Lit[] | Obj;
export interface Obj { [key: string]: Lit }

const isObj = (v: Lit | undefined): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const asObj = (v: Lit): Obj | null => isObj(v) ? v : null;
const isStrings = (v: Lit | undefined): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

function parseJson(text: string): Lit {
  try {
    return JSON.parse(text) as Lit;
  } catch {
    return UNKNOWN;
  }
}

const jsonIn = (snap: string, file: string): Lit => parseJson(readFileSync(join(snap, file), "utf8"));

function configIn(snap: string, file: string): Lit {
  if (!existsSync(join(snap, file))) return UNKNOWN;
  return file.endsWith(".json") ? jsonIn(snap, file) : exportedConfig(readFileSync(join(snap, file), "utf8"));
}

/** Calls whose argument is the configuration itself. */
const DEFINE = /^(?:[\w$]+\.)?(?:defineConfig|defineProject|defineWorkspace)$/;

/** The literal value a JavaScript or TypeScript configuration file exports (`export default`, `module.exports =`),
 * through defineConfig(…), an arrow function returning an object, or a variable declared in the file. */
export function exportedConfig(source: string): Lit {
  const code = withoutComments(source);
  const m = /\bexport\s+default\s+|\bmodule\.exports\s*=\s*/.exec(code);
  return m ? expressionAt(code, m.index + m[0].length, 0) : UNKNOWN;
}

function expressionAt(code: string, at: number, depth: number): Lit {
  if (depth > 3) return UNKNOWN;
  const s = new Scanner(code, at);
  const start = s.ws();
  const name = s.dotted();
  if (name && DEFINE.test(name)) {
    if (!s.eat("(")) return UNKNOWN;
    return arrowBody(code, s.ws());
  }
  if (name && /^[\w$]+$/.test(name) && /^\s*(?:[,;)]|$|(?:as|satisfies)\b)/.test(code.slice(s.i))) {
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${name.replace(/\$/g, "\\$")}\\s*(?::[^=]+)?=\\s*`).exec(code);
    return decl ? expressionAt(code, decl.index + decl[0].length, depth + 1) : UNKNOWN;
  }
  return arrowBody(code, start);
}

/** The value at `at`, or what an arrow function there returns when it returns an object. */
function arrowBody(code: string, at: number): Lit {
  const s = new Scanner(code, at);
  const c = s.peek();
  if (c === "{" || c === "[") return s.value();
  const arrow = /^(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*(?::[^=]+)?=>\s*([({])/.exec(code.slice(s.i));
  if (!arrow) return UNKNOWN;
  const at2 = s.i + arrow[0].length;
  if (arrow[1] === "(") return new Scanner(code, at2).value();
  // A body in braces: the object its own last `return` gives.
  let found = -1;
  for (let j = at2, depth = 0; j < code.length; j++) {
    const c = code[j]!;
    if (c === "'" || c === '"' || c === "`") j = quotedEnd(code, j) - 1;
    else if (c === "/" && regexStarts(code, j)) j = regexEnd(code, j) - 1;
    else if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) {
      if (!depth--) break;
    } else if (!depth && /^return\s*\(?\s*\{/.test(code.slice(j, j + 40)) && !/[\w$]/.test(code[j - 1] ?? "")) {
      found = j + 6;
    }
  }
  if (found < 0) return UNKNOWN;
  const r = new Scanner(code, found);
  r.eat("(");
  return r.value();
}

/** Whether a / at `i` starts a regular expression, by what comes before it. */
function regexStarts(s: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(s[j]!)) j--;
  if (j < 0) return true;
  if ("(,=:[!&|?{};+-*%<>~^".includes(s[j]!)) return true;
  return /\b(?:return|typeof|case|in|of)$/.test(s.slice(Math.max(0, j - 6), j + 1));
}

/** Where a quoted string or template starting at `i` ends (the index after its closing quote). */
function quotedEnd(s: string, i: number): number {
  const q = s[i]!;
  let depth = 0;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j]!;
    if (c === "\\") j++;
    else if (q === "`" && c === "$" && s[j + 1] === "{") {
      depth++;
      j++;
    } else if (q === "`" && depth && c === "}") depth--;
    else if (c === q && !depth) return j + 1;
  }
  return s.length;
}

/** Where a regular expression literal starting at `i` ends. */
function regexEnd(s: string, i: number): number {
  let cls = false;
  for (let j = i + 1; j < s.length; j++) {
    const c = s[j]!;
    if (c === "\\") j++;
    else if (c === "[") cls = true;
    else if (c === "]") cls = false;
    else if (c === "/" && !cls) {
      let k = j + 1;
      while (/[a-z]/.test(s[k] ?? "")) k++;
      return k;
    } else if (c === "\n") return j;
  }
  return s.length;
}

/** `source` with its comments blanked; strings, templates and regular expressions kept as they are. */
export function withoutComments(source: string): string {
  let out = "";
  for (let i = 0; i < source.length;) {
    const c = source[i]!;
    const next = source[i + 1];
    if (c === "/" && next === "/") {
      const nl = source.indexOf("\n", i);
      i = nl < 0 ? source.length : nl;
    } else if (c === "/" && next === "*") {
      const close = source.indexOf("*/", i + 2);
      i = close < 0 ? source.length : close + 2;
      out += " ";
    } else if (c === "'" || c === '"' || c === "`" || (c === "/" && regexStarts(source, i))) {
      const end = c === "/" ? regexEnd(source, i) : quotedEnd(source, i);
      out += source.slice(i, end);
      i = end;
    } else {
      out += c;
      i++;
    }
  }
  return out;
}

/** Reads literal values from comment-free code: objects, arrays, strings, numbers, true, false and null; anything
 * else is UNKNOWN and skipped to the next , ) ] or } at its depth. */
class Scanner {
  constructor(readonly s: string, public i: number) {}

  ws(): number {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
    return this.i;
  }

  peek(): string {
    this.ws();
    return this.s[this.i] ?? "";
  }

  eat(c: string): boolean {
    if (this.peek() !== c) return false;
    this.i++;
    return true;
  }

  dotted(): string {
    this.ws();
    const m = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*/.exec(this.s.slice(this.i));
    if (!m) return "";
    this.i += m[0].length;
    return m[0];
  }

  /** Skips to the next , ) ] or } at this depth, without taking it. */
  skip(): void {
    let depth = 0;
    while (this.i < this.s.length) {
      const c = this.s[this.i]!;
      if (c === "'" || c === '"' || c === "`") this.i = quotedEnd(this.s, this.i);
      else if (c === "/" && regexStarts(this.s, this.i)) this.i = regexEnd(this.s, this.i);
      else if ("([{".includes(c)) {
        depth++;
        this.i++;
      } else if (")]}".includes(c)) {
        if (!depth) return;
        depth--;
        this.i++;
      } else if (c === "," && !depth) return;
      else this.i++;
    }
  }

  /** After a value: the expression goes on (`a + b`, `x.concat(…)`) unless the next character ends it. A TypeScript
   * `as` or `satisfies` keeps the value. */
  private ends(v: Lit): Lit {
    const c = this.peek();
    if (c === "" || ",)]};".includes(c)) return v;
    if (/^(?:as|satisfies)\b/.test(this.s.slice(this.i))) {
      this.skip();
      return v;
    }
    this.skip();
    return UNKNOWN;
  }

  value(): Lit {
    const c = this.peek();
    if (c === "{") return this.ends(this.object());
    if (c === "[") return this.ends(this.array());
    if (c === "'" || c === '"' || c === "`") {
      const end = quotedEnd(this.s, this.i);
      const body = this.s.slice(this.i + 1, end - 1);
      this.i = end;
      if (c === "`" && body.includes("${")) return this.ends(UNKNOWN);
      return this.ends(body.replace(/\\(.)/g, (_, x: string) => x === "n" ? "\n" : x === "t" ? "\t" : x));
    }
    const num = /^-?\d[\d_]*(?:\.\d+)?/.exec(this.s.slice(this.i));
    if (num) {
      this.i += num[0].length;
      return this.ends(Number(num[0].replaceAll("_", "")));
    }
    const word = /^(?:true|false|null)\b/.exec(this.s.slice(this.i));
    if (word) {
      this.i += word[0].length;
      return this.ends(word[0] === "null" ? null : word[0] === "true");
    }
    this.skip();
    return UNKNOWN;
  }

  private array(): Lit[] {
    const out: Lit[] = [];
    this.i++;
    while (this.i < this.s.length) {
      if (this.eat("]")) return out;
      if (this.s.startsWith("...", this.ws())) {
        this.skip();
        out.push(UNKNOWN);
      } else out.push(this.value());
      if (!this.eat(",") && this.peek() !== "]") this.skip();
    }
    return out;
  }

  private object(): Obj {
    const out: Obj = {};
    this.i++;
    while (this.i < this.s.length) {
      if (this.eat("}")) return out;
      const c = this.peek();
      let key: string | null = null;
      if (this.s.startsWith("...", this.i)) {
        this.i += 3;
        this.skip();
        out[SPREAD] = UNKNOWN;
      } else {
        if (c === "'" || c === '"') {
          const end = quotedEnd(this.s, this.i);
          key = this.s.slice(this.i + 1, end - 1);
          this.i = end;
        } else {
          const m = /^[\w$]+/.exec(this.s.slice(this.i));
          if (m) {
            key = m[0];
            this.i += m[0].length;
          }
        }
        if (key !== null && this.eat(":")) out[key] = this.value();
        else {
          // A computed key, a method or a shorthand property: its value is not literal.
          this.skip();
          if (key !== null) out[key] = UNKNOWN;
        }
      }
      if (!this.eat(",") && this.peek() !== "}") {
        this.skip();
        this.eat(",");
      }
    }
    return out;
  }
}
