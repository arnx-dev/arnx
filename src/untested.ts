// Which changed source files no arnx test refers to. A review that found nothing says little about a file its tests
// never name, so the report lists those files instead of calling the review complete. "Refers to" is by name (the
// module or file a test imports; for an index file, also a relative import that resolves to it), not measured
// coverage: a file listed here was certainly not targeted.
import { posix } from "node:path";
import type { Adapter } from "./adapters/types";
import type { Classified } from "./outcomes";
import { ownerFile } from "./outcomes";
import { codeText } from "./codetext";
import { isTestPath } from "./detect";
import { isGenerated } from "./ignore";

/** Source files: the ones setup must place in a project, and the ones a review must cover. */
export const SOURCE = /\.(py|[cm]?[jt]sx?|rs|cs|go|java|kt|rb|php|swift|c|h|cpp|hpp)$/;

const INDEX = ["index", "__init__", "mod"];

/** The name a test would import a file by: its stem, or its directory for index/__init__/mod files. */
export function moduleName(path: string): string {
  const stem = posix.basename(path).replace(/\.[^.]+$/, "");
  return INDEX.includes(stem) ? posix.basename(posix.dirname(path)) : stem;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const JS_EXT = /\.[cm]?[jt]sx?$/;
/** Relative paths a test loads: `from "./x"`, `require("../x")`, `import("./x")`, `jest.mock("./x")`, `#[path = "x"]`. */
const REL_LOAD = /(?:\bfrom|\brequire|\bimport|\bmock|#\[path\s*=)\s*\(?\s*(['"`])(\.\.?(?:\/[^'"`\n]*)?)\1/g;
/** Python relative imports: `from . import x`, `from ..pkg import x`. */
const PY_REL = /^\s*from\s+(\.+)([\w.]*)\s+import\b/gm;

/** Whether a test at `testPath` loads the index-type file `path` by a relative path: the file itself (any JS/TS
 * extension, or none) or its directory. Text only, resolved against the test's own directory, as node, Python and
 * rustc would; no resolver config (paths, aliases) is read. */
function loadsRelatively(path: string, testPath: string, body: string): boolean {
  const dir = posix.dirname(path), from = posix.dirname(testPath);
  const hits = (target: string) => {
    const t = posix.normalize(target).replace(/(.)\/$/, "$1");
    return t === dir || t === path || (JS_EXT.test(path) && t.replace(JS_EXT, "") === path.replace(JS_EXT, ""));
  };
  for (const m of body.matchAll(REL_LOAD)) if (hits(posix.join(from, m[2]!))) return true;
  if (!path.endsWith(".py")) return false;
  for (const m of body.matchAll(PY_REL)) {
    const up = Array(m[1]!.length - 1).fill("..");
    if (hits(posix.join(from, ...up, ...m[2]!.split(".").filter(Boolean)))) return true;
  }
  return false;
}

/** Whether any of `tests` refers to `path`: names its module (an index-type file at the root has no such name), or,
 * for an index-type file, loads it by a relative path that resolves to it. */
function referredTo(path: string, tests: Record<string, string>): boolean {
  const name = moduleName(path);
  const text = Object.values(tests).join("\n");
  if (name !== "." && new RegExp(`\\b${escape(name)}\\b`).test(text)) return true;
  const stem = posix.basename(path).replace(/\.[^.]+$/, "");
  return INDEX.includes(stem) && Object.entries(tests).some(([t, body]) => loadsRelatively(path, t, body));
}

/** Whether a path is a source file a review must cover: not a test or a test folder's file. */
export const isSourcePath = (p: string) => SOURCE.test(p) && !isTestPath(p) && !TEST_DIR.test(p);

/** Changed source files owned by the project, without its own tests and test helpers. */
export function changedSources(owned: string[], adapter: Adapter): string[] {
  return owned.filter((p) => isSourcePath(p) &&
    !adapter.isTestFile(posix.basename(p)) && !adapter.isSupportFile(posix.basename(p)));
}

const TEST_DIR = /(^|\/)tests?\//;
/** A line that loads something by a path or module name held in a string. */
const LOADS = /\b(?:from|import|require|mock|importActual|import_module|__import__|spec_from_file_location|exec_module|runpy)\b|#\[path/;
/** A test with one of these runs files by path: every string in it may be such a path. */
const FILE_LOADER = /\b(?:spec_from_file_location|exec_module|runpy)\b/;
const EMPTY_LITERAL = /(['"`])\1/g;

/** `body` as code: comments and string literals blanked, except the strings of a line that loads something (`from`,
 * `import`, `require`, `mock`, `importActual`, `import_module`, `__import__`, `#[path`), which a test names a file by.
 * A name in a comment or in text a test reads is not a reference. `path` gives the language. */
export function codeOf(body: string, path: string): string {
  const strings: string[] = [];
  const code = codeText(body, path, (t) => strings.push(t));
  const lines = code.split("\n");
  const loads = (l: string) => LOADS.test(l) || fileLoader;
  const fileLoader = FILE_LOADER.test(code);
  const total = lines.reduce((n, l) => n + (l.match(EMPTY_LITERAL)?.length ?? 0), 0);
  if (total !== strings.length) {
    // Quotes did not pair up with the strings read (an odd literal form): keep the loading lines whole.
    const original = body.split("\n");
    return lines.map((l, i) => loads(l) ? original[i] ?? l : l).join("\n");
  }
  let at = 0;
  return lines.map((l) => {
    const n = l.match(EMPTY_LITERAL)?.length ?? 0;
    const mine = strings.slice(at, at + n);
    at += n;
    if (!loads(l)) return l;
    let k = 0;
    return l.replace(EMPTY_LITERAL, (q) => `${q[0]}${mine[k++] ?? ""}${q[0]}`);
  }).join("\n");
}

const NAME = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/;

/** The strings of `body` that are bare names (identifiers, dotted): no `/`, no extension-like tail, no spaces. A test
 * that loads modules by name from a list holds them so. */
function stringNames(body: string, path: string): string[] {
  const out: string[] = [];
  codeText(body, path, (t) => { if (NAME.test(t)) out.push(t); });
  return out;
}

/** Whether one of `names` is the file's module name or its dotted module path (or the end of it). */
function namedByString(path: string, names: Set<string>): boolean {
  if (!names.size) return false;
  const stem = posix.basename(path).replace(/\.[^.]+$/, "");
  const mod = INDEX.includes(stem) ? posix.dirname(path) : path.replace(/\.[^.]+$/, "");
  const dotted = mod.split("/").filter((x) => x && x !== ".").join(".");
  const name = moduleName(path);
  if (name !== "." && names.has(name)) return true;
  return [...names].some((n) => n.includes(".") && (dotted === n || dotted.endsWith("." + n)));
}

/** Files named as `path.ext:line` in a message (a stack frame in a test runner's output). Directories under
 * `node_modules` or `site-packages` are other people's code and are left out. */
export function framesIn(message: string): string[] {
  const out = new Set<string>();
  for (const m of message.matchAll(/((?:[\w@.+~-]*\/)*[\w@.+-]+\.[A-Za-z]{1,5}):\d+/g)) {
    const f = m[1]!.replace(/^(?:file:)?\/{2,}/, "/");
    if (!/(^|\/)(node_modules|site-packages)\//.test(f)) out.add(f);
  }
  return [...out];
}

/** Whether a frame names `path`: the same path, or one that ends where the other does (the frame is from inside a
 * container, or the path is from the repository root). */
const frameIs = (frame: string, path: string) => {
  const f = posix.normalize(frame).replace(/^(\.\/)+/, "");
  return f === path || path.endsWith("/" + f.replace(/^\//, "")) || f.endsWith("/" + path);
};

/** The sources a stack frame goes through. A frame that fits more than one changed file (a bare `utils.py:9`) hides none. */
export function framed(sources: string[], frames: string[]): string[] {
  const hit = new Set<string>();
  for (const f of frames) {
    const fits = sources.filter((p) => frameIs(f, p));
    if (fits.length === 1) hit.add(fits[0]!);
  }
  return sources.filter((p) => hit.has(p));
}

/** Changed source files with no sign a test reached them: no test of `tests` (those that loaded) names them in code
 * (not in a comment or a string it only reads), no stack frame of a failing test goes through them, and none of `ran`
 * (files a run reported) is them. */
export function notReached(owned: string[], ev: { tests: Record<string, string>; frames: string[]; ran?: string[] },
                           adapter: Adapter): string[] {
  const tests = Object.fromEntries(Object.entries(ev.tests).map(([k, v]) => [k, codeOf(v, k)]));
  const text = Object.values(tests).join("\n");
  const names = new Set(Object.entries(ev.tests).flatMap(([k, v]) => stringNames(v, k)));
  const sources = changedSources(owned, adapter);
  const hit = new Set([...framed(sources, ev.frames), ...(ev.ran ?? []).filter((r) => sources.includes(r))]);
  return sources.filter((p) => !hit.has(p) && (posix.basename(p) === "lib.rs" ? !text.trim() : !referredTo(p, tests) && !namedByString(p, names)));
}

/** The generated files whose tests loaded: a test file with a passed, failed or flaky test (one that only has errors,
 * or is in `not`, did not load), and the support files beside them when any test file did. */
export function loadedTests(files: Record<string, string>, c: Classified, not: string[] = []): Record<string, string> {
  const paths = Object.keys(files);
  const of = (xs: { fileAttr: string }[]) => new Set(xs.map((t) => ownerFile(t.fileAttr, paths)).filter((x) => x !== null));
  const loaded = of([...c.passed, ...c.findings, ...c.flaky]);
  const named = of([...c.errors]);
  for (const f of not) loaded.delete(f);
  const isTest = (f: string) => loaded.has(f) || named.has(f) || not.includes(f);
  const keep = (f: string) => loaded.has(f) || (loaded.size > 0 && !isTest(f));
  return Object.fromEntries(Object.entries(files).filter(([f]) => keep(f)));
}

/** Changed source files that no generated test names. A Rust crate root (lib.rs) is reached by every integration
 * test, which names the crate rather than the file, so any test counts for it. */
export function untestedFiles(owned: string[], tests: Record<string, string>, adapter: Adapter): string[] {
  const text = Object.values(tests).join("\n");
  return changedSources(owned, adapter).filter((p) => posix.basename(p) === "lib.rs" ? !text.trim()
    : !referredTo(p, tests));
}

/** SQL a file sends to a database: a statement keyword in capitals followed by its usual partner. */
const SQL = /\b(?:SELECT\b[\s\S]{1,400}?\bFROM|INSERT\s+INTO|UPDATE\s+[\w."]+\s+SET|DELETE\s+FROM|CREATE\s+(?:TABLE|VIEW|INDEX))\b/;

const SQL_IMAGE = /postgres|postgis|timescale|mysql|mariadb|cockroach|clickhouse|mssql|sqlserver/i;

/** The env variables that reach one of the project's SQL database services (a URL or host naming it). */
export function databaseEnv(env: Record<string, string>, services: { name: string; image: string }[]): string[] {
  const names = services.filter((s) => SQL_IMAGE.test(s.image)).map((s) => s.name);
  if (!names.length) return [];
  const rx = new RegExp(`(?:^|[/@:])(?:${names.map(escape).join("|")})(?:[:/]|$)`);
  return Object.entries(env).filter(([, v]) => rx.test(v)).map(([k]) => k);
}

/** Changed source files holding SQL that no generated test both connects for and names: a test counts when it names
 * the file's module and one of `envNames`. This is text, not execution: it shows the reviewer was not pointed at
 * the database, never that the changed SQL ran. Empty when no variable reaches a database service. */
export function dbUntested(owned: string[], read: (path: string) => string | null, tests: Record<string, string>,
                           adapter: Adapter, envNames: string[]): string[] {
  if (!envNames.length) return [];
  const withEnv = Object.fromEntries(Object.entries(tests).filter(([, t]) => envNames.some((n) => t.includes(n))));
  return changedSources(owned, adapter).filter((p) => {
    const body = read(p);
    if (body === null || !SQL.test(body)) return false;
    return !referredTo(p, withEnv);
  });
}

/** Names of test files by convention: `*_test.*`, `*.test.*`, `*.spec.*`, `*Spec.*`, `*Test.*`, `*Tests.*`, `test_*`. */
const TEST_NAMED = /^test_|(?:[_.]test|[_.]spec|Spec|Tests?)\.[^./]+$/;
const COMMENT_LINE = /^(?:#|\/\/|\/\*|\*(?:\s|\/|$)|--(?:\s|$))/;
const IMPORT_LINE = /^(?:import\b|from\s+\S+\s+import\b|use\s|using\s|#include\b|package\b|(?:const|let|var)\b[^=]*=\s*require\()/;

/** Lines the diff adds to each file: not blank, not a comment, not an import. */
function addedLines(diff: string): Map<string, number> {
  const out = new Map<string, number>();
  let file: string | null = null, inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = null;
      inHunk = false;
    } else if (line.startsWith("@@")) {
      inHunk = true;
    } else if (!inHunk && line.startsWith("+++ ")) {
      const m = /^\+\+\+ b\/(.+)$/.exec(line);
      file = m ? m[1]!.replace(/\t.*$/, "") : null;
    } else if (file !== null && line.startsWith("+")) {
      const code = line.slice(1).trim();
      if (code && !COMMENT_LINE.test(code) && !IMPORT_LINE.test(code)) out.set(file, (out.get(file) ?? 0) + 1);
    }
  }
  return out;
}

/** The changed files worth one follow-up request for a test: of `missing` (changed sources no generated test names),
 * those with at least `minLines` added code lines in `diff` (blank lines, comments and imports are not counted),
 * largest first, at most `max`. Test-named files and generated files are never asked about. */
export function filesToAsk(missing: string[], diff: string, adapter: Adapter, o: { minLines: number; max: number }): string[] {
  const lines = addedLines(diff);
  return missing
    .filter((p) => !TEST_NAMED.test(posix.basename(p)) && !isGenerated(p) && !isTestPath(p) &&
      !adapter.isTestFile(posix.basename(p)) && (lines.get(p) ?? 0) >= o.minLines)
    .sort((a, b) => lines.get(b)! - lines.get(a)! || (a < b ? -1 : a > b ? 1 : 0))
    .slice(0, o.max);
}
