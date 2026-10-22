// Which changed source files no arnx test refers to. A review that found nothing says little about a file its tests
// never name, so the report lists those files instead of calling the review complete. "Refers to" is by name (the
// module or file a test imports; for an index file, also a relative import that resolves to it), not measured
// coverage: a file listed here was certainly not targeted.
import { posix } from "node:path";
import type { Adapter } from "./adapters/types";

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

/** Changed source files owned by the project, without its own tests and test helpers. */
export function changedSources(owned: string[], adapter: Adapter): string[] {
  return owned.filter((p) => SOURCE.test(p) && !adapter.isTestFile(posix.basename(p)) &&
    !adapter.isSupportFile(posix.basename(p)));
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
