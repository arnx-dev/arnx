// The Python adapter: pytest, JUnit XML (xunit1), test_*.py files.
import { posix } from "node:path";
import { endOnce, pyRepr, shQuote } from "../util";
import { parseJunit } from "./junit";
import type { Adapter, Listing } from "./types";

const DEF = /^(\s*)(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/;
const IMPORT_PYTEST = /^import\s+(?:[\w.]+\s*,\s*)*pytest\s*(?:,|#|$)/;
const FUTURE = /^from\s+__future__\s+import\b/;

/** For each line, whether it starts inside a triple-quoted string. */
function stringLines(lines: string[]): boolean[] {
  const inside: boolean[] = [];
  let open: string | null = null;
  for (const line of lines) {
    inside.push(open !== null);
    for (let i = 0; i < line.length;) {
      if (open) {
        if (line[i] === "\\") i += 2;
        else if (line.startsWith(open, i)) {
          i += 3;
          open = null;
        } else i += 1;
        continue;
      }
      const c = line[i]!;
      if (c === "#") break;
      if (line.startsWith('"""', i) || line.startsWith("'''", i)) {
        open = line.slice(i, i + 3);
        i += 3;
      } else if (c === '"' || c === "'") {
        for (i += 1; i < line.length && line[i] !== c; i += line[i] === "\\" ? 2 : 1);
        i += 1;
      } else i += 1;
    }
  }
  return inside;
}

/** The index of the line after the last top-level `from __future__ import`, or 0. */
function afterFutureImports(lines: string[], inString: boolean[]): number {
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    if (inString[i] || !FUTURE.test(lines[i]!)) continue;
    let end = i;
    if (lines[i]!.includes("(") && !lines[i]!.includes(")")) {
      while (end + 1 < lines.length && !lines[end]!.includes(")")) end += 1;
    }
    at = end + 1;
  }
  return at;
}

/** The first line of a test's decorator stack (comments among it included), from its def at line `i`. */
function blockStart(lines: string[], inString: boolean[], i: number, indent: string): number {
  let first = i;
  for (let k = i - 1; k >= 0; k--) {
    const t = lines[k]!, body = t.trim();
    if (body === "" || inString[k]) break;
    const ind = t.length - t.trimStart().length;
    if (ind === indent.length && body.startsWith("@")) first = k;
    else if (ind === indent.length && body.startsWith("#")) continue;
    else if (ind > indent.length || (ind === indent.length && /^[)\]}]/.test(body))) continue;
    else break;
  }
  return first;
}

/** Each named test's def: its line, its indent and the first line of its decorators. */
function defsOf(lines: string[], inString: boolean[], names: Set<string> | null) {
  const out: { at: number; first: number; indent: string; name: string }[] = [];
  lines.forEach((line, i) => {
    const m = inString[i] ? null : DEF.exec(line);
    if (!m || (names && !names.has(m[2]!))) return;
    out.push({ at: i, first: blockStart(lines, inString, i, m[1]!), indent: m[1]!, name: m[2]! });
  });
  return out;
}

/** A marker (from the test's decorators) above each named test's decorators, and `import pytest` after any `__future__` imports when the module
 * does not import it; `left`: the names no test has. */
function pythonMark(source: string, names: Set<string>, marker: (decorators: string) => string)
  : { text: string; left: Set<string> } {
  if (names.size === 0) return { text: source, left: new Set() };
  const lines = source.split(/(?<=\n)/);
  const inString = stringLines(lines);
  const defs = defsOf(lines, inString, names);
  const inserts: [number, string][] = defs.map((d) =>
    [d.first, `${d.indent}${marker(lines.slice(d.first, d.at).join(""))}\n`]);
  const left = new Set([...names].filter((n) => !defs.some((d) => d.name === n)));
  if (inserts.length === 0) return { text: source, left };
  if (!lines.some((l, i) => !inString[i] && IMPORT_PYTEST.test(l.trimEnd()))) {
    inserts.push([afterFutureImports(lines, inString), "import pytest\n"]);
  }
  for (const [at, text] of inserts.sort((a, b) => b[0] - a[0])) lines.splice(at, 0, text);
  return { text: lines.join(""), left };
}

/** Python's ast-based marker, done on text: `@pytest.mark.skip(reason=...)` goes above each named test's
 * decorators, and `import pytest` is added after any `__future__` imports when the module does not import it. */
export function pythonSkip(source: string, names: Set<string>, reason: string): string {
  return pythonMark(source, names, () => `@pytest.mark.skip(reason=${pyRepr(reason)})`).text;
}

/** Remove each named test: its decorators, its def and body, and the blank lines after it. */
function pythonDrop(source: string, names: Set<string>): { text: string; left: Set<string> } {
  const lines = source.split(/(?<=\n)/);
  const inString = stringLines(lines);
  const defs = defsOf(lines, inString, names);
  const cuts: [number, number][] = defs.map((d) => {
    let end = d.at + 1;
    for (; end < lines.length; end++) {
      const t = lines[end]!, body = t.trim();
      if (inString[end] || body === "") continue;
      const ind = t.length - t.trimStart().length;
      if (ind > d.indent.length || (ind === d.indent.length && /^[)\]}]/.test(body))) continue;
      break;
    }
    return [d.first, end];
  });
  for (const [from, to] of cuts.sort((a, b) => b[0] - a[0])) lines.splice(from, to - from);
  const left = new Set([...names].filter((n) => !defs.some((d) => d.name === n)));
  return { text: cuts.length ? endOnce(dropEmptyClasses(lines)) : source, left };
}

/** Remove the classes a cut left with no body (they would not parse), with their decorators and the blank lines
 * after them; a class emptied that way can empty the one around it. */
function dropEmptyClasses(lines: string[]): string {
  for (let cut = true; cut;) {
    cut = false;
    const inString = stringLines(lines);
    for (let i = 0; i < lines.length && !cut; i++) {
      const m = inString[i] ? null : /^(\s*)class\s+\w[^#]*:\s*(?:#.*)?$/.exec(lines[i]!.trimEnd());
      if (!m) continue;
      let next = i + 1;
      while (next < lines.length && (!lines[next]!.trim() || inString[next])) next += 1;
      const body = next < lines.length ? lines[next]!.length - lines[next]!.trimStart().length : -1;
      if (body > m[1]!.length) continue;
      const first = blockStart(lines, inString, i, m[1]!);
      lines.splice(first, next - first);
      cut = true;
    }
  }
  return lines.join("");
}

/** The expected-fail marker an older arnx wrote: `@pytest.mark.xfail(strict=…, reason='arnx …')`. */
const XFAIL = /^\s*@pytest\.mark\.xfail\(strict=(?:True|False), reason=(['"])arnx\b.*\)\s*$/;

/** Remove arnx's expected-fail marker from the named tests (all, without names). */
function pythonUnmark(source: string, names?: Set<string>): { text: string; names: string[] } {
  const lines = source.split(/(?<=\n)/);
  const inString = stringLines(lines);
  const drop: number[] = [];
  const out: string[] = [];
  for (const d of defsOf(lines, inString, names ?? null)) {
    const at = lines.slice(d.first, d.at).findIndex((l) => XFAIL.test(l));
    if (at < 0) continue;
    drop.push(d.first + at);
    out.push(d.name);
  }
  for (const at of drop.sort((a, b) => b - a)) lines.splice(at, 1);
  return { text: lines.join(""), names: out };
}

/** What `pytest --collect-only -q` shows: node ids (path::name), or with -qq a count per file (path: n), and the
 * files that did not load. Exit 1 is files that did not load, 5 nothing collected; 2 (interrupted), 3 (internal
 * error), 4 (a usage error, a conftest that does not import), 126 and 127 (no such command) stop before listing. */
export function parsePytestList(output: string, exitCode: number | null): Listing | null {
  if (exitCode === null) return null;
  if ([2, 3, 4, 126, 127].includes(exitCode)) return { tests: null, files: [], broken: [], failed: true };
  const files = new Map<string, number>();
  const broken = new Set<string>();
  for (const line of output.split("\n").map((l) => l.trimEnd())) {
    const id = /^([^\s:]+\.py)::\S/.exec(line);
    const count = /^([^\s:]+\.py): (\d+)$/.exec(line);
    if (id) files.set(id[1]!, (files.get(id[1]!) ?? 0) + 1);
    else if (count) files.set(count[1]!, (files.get(count[1]!) ?? 0) + Number(count[2]));
    const error = /^ERROR ([^\s:]+)(?:\s|$)/.exec(line) ?? /^_+ ERROR collecting (\S+) _+$/.exec(line);
    if (error) broken.add(error[1]!);
  }
  const tests = [...files.values()].reduce((a, b) => a + b, 0);
  const listing = { tests, files: [...files.keys()], broken: [...broken].sort(), failed: false };
  if (exitCode === 5) return { ...listing, tests: 0 };
  return (exitCode === 1 && broken.size) || (exitCode === 0 && files.size) ? listing : null;
}

const WORDS = {
  language: "Python",
  runner: "pytest",
  testFiles: "test_*.py",
  writableFiles: "test_*.py, conftest.py or __init__.py",
  propertyLib: "hypothesis",
  imageExample: "python:3.12-slim",
  installExample: "pip install -r requirements.txt pytest",
  commandExample: "python -m pytest -q {targets}",
};

export const python: Adapter = {
  id: "python",
  runners: ["pytest"],
  defaultRunner: "pytest",
  words: () => WORDS,
  defaultTestsDir: "tests/arnx_generated",
  writable: /^(test_.*|conftest|__init__)\.py$/,
  probes: () => [{ file: "test_arnx_probe.py", source: "def test_arnx_probe():\n    pass\n" }],
  isTestFile: (name) => name.startsWith("test_") && name.endsWith(".py"),
  isSupportFile: (name) => name === "conftest.py",
  validateCommand: (command) =>
    typeof command === "string" && command.includes("pytest") && command.includes("{targets}")
      ? [] : ["test_command: must run pytest and contain {targets}"],
  runs: () => /\bpytest\b/,
  reportSaid: (output) => [...output.matchAll(/generated xml file: (\S+)/g)].at(-1)?.[1] ?? null,
  command: (testCommand, targets, reportPath) =>
    testCommand.replaceAll("{targets}", targets.map(shQuote).join(" ")) +
    " -p no:cacheprovider --continue-on-collection-errors -o junit_family=xunit1" +
    ` --junitxml=${shQuote(reportPath)}`,
  parseReport: (text) => parseJunit(text, (f) => f.endsWith(".py") ? f.slice(0, -3).replaceAll("/", ".") : ""),
  listCommand: (testCommand, targets) => testCommand.replaceAll("{targets}", targets.map(shQuote).join(" ")) +
    " -p no:cacheprovider --continue-on-collection-errors --collect-only -q",
  parseList: (output, _listed, exitCode) => parsePytestList(output, exitCode),
  skip: pythonSkip,
  drop: pythonDrop,
  unmark: pythonUnmark,
  acceptedPath: (original, tag, acceptedDir, name) => {
    const own = posix.basename(original);
    const renamed = own.startsWith("test_") ? `test_${name}.py` : own;
    return posix.join(acceptedDir, `r${tag}`, posix.dirname(original), renamed);
  },
  testStem: (fileName) => fileName.replace(/^test_/, "").replace(/\.py$/, ""),
  relocate: relocatePaths,
  setupHints: "- Install pytest (and hypothesis if it installs cleanly) even if the project does not list them.\n" +
    "- Prefer `python -m pytest` so the working directory is importable.",
  manifests: ["requirements*.txt", "pyproject.toml", "setup.py", "setup.cfg", "poetry.lock", "uv.lock", "Pipfile",
    "Pipfile.lock"],
  buildEnv: ["PYTHONDONTWRITEBYTECODE=1", "PIP_DISABLE_PIP_VERSION_CHECK=1", "PIP_ROOT_USER_ACTION=ignore"],
  // uv copies out of its cache when the cache is on another filesystem, as a cache mount is.
  downloadCache: ["PIP_CACHE_DIR=/arnx-cache/pip", "UV_CACHE_DIR=/arnx-cache/uv", "UV_LINK_MODE=copy"],
  noDownloadCache: ["PIP_NO_CACHE_DIR=1"],
  runEnv: ["PYTHONDONTWRITEBYTECODE=1"],
};

/** Path arithmetic anchored on the test file's own location (`Path(__file__).parents[N]`, `.parent` chains,
 * nested `os.path.dirname(__file__)`) adjusted for where accept put the file. Levels inside the moved folder (the
 * file's own folder, and folders it shares with its new place, such as answers/) moved with it and stay; levels
 * above it shift by how much deeper the new place is, so a conftest that found `../../schema.sql` from
 * tests/arnx_generated/ still finds it from tests/arnx/r<id>/. */
export function relocatePaths(source: string, fromDir: string, toDir: string): string {
  const parts = (d: string) => d === "." || d === "" ? [] : posix.normalize(d).split("/");
  const from = parts(fromDir), to = parts(toDir);
  const delta = to.length - from.length;
  if (!delta) return source;
  let inside = 0; // trailing folders the two places share: they moved together with the file
  while (inside < Math.min(from.length, to.length) - 1 && from[from.length - 1 - inside] === to[to.length - 1 - inside]) {
    inside++;
  }
  /** parents[n] after the move: unchanged inside the moved folder, shifted above it. */
  const shift = (n: number) => (n > inside ? Math.max(0, n + delta) : n);
  const anchor = String.raw`(?:pathlib\.)?Path\(__file__\)(?:\.resolve\(\)|\.absolute\(\))?`;
  let out = source.replace(new RegExp(`(${anchor})\\.parents\\[(\\d+)\\]`, "g"),
    (_m, a: string, n: string) => `${a}.parents[${shift(Number(n))}]`);
  out = out.replace(new RegExp(`(${anchor})((?:\\.parent)+)(?!s)`, "g"), (_m, a: string, chain: string) => {
    const k = chain.split(".parent").length - 1; // .parent × k is parents[k - 1]
    return `${a}${".parent".repeat(shift(k - 1) + 1)}`;
  });
  out = out.replace(/((?:os\.path\.dirname\()+)(os\.path\.(?:abspath|realpath)\(__file__\)|__file__)(\)+)/g,
    (m, opens: string, inner: string, closes: string) => {
      const k = opens.split("os.path.dirname(").length - 1; // dirname × k is parents[k - 1]
      if (closes.length < k) return m;
      const n = shift(k - 1) + 1;
      return "os.path.dirname(".repeat(n) + inner + ")".repeat(n) + closes.slice(k);
    });
  return out;
}
