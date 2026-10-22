// The Python adapter: pytest, JUnit XML (xunit1), test_*.py files.
import { posix } from "node:path";
import { pyRepr, shQuote } from "../util";
import { parseJunit } from "./junit";
import type { Adapter } from "./types";

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

/** Python's ast-based marker, done on text: `@pytest.mark.skip(reason=...)` goes above each named test's
 * decorators, and `import pytest` is added after any `__future__` imports when the module does not import it. */
export function pythonSkip(source: string, names: Set<string>, reason: string): string {
  if (names.size === 0) return source;
  const lines = source.split(/(?<=\n)/);
  const inString = stringLines(lines);
  const inserts: [number, string][] = [];
  lines.forEach((line, i) => {
    const m = inString[i] ? null : DEF.exec(line);
    if (!m || !names.has(m[2]!)) return;
    const indent = m[1]!;
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
    inserts.push([first, `${indent}@pytest.mark.skip(reason=${pyRepr(reason)})\n`]);
  });
  if (inserts.length === 0) return source;
  if (!lines.some((l, i) => !inString[i] && IMPORT_PYTEST.test(l.trimEnd()))) {
    inserts.push([afterFutureImports(lines, inString), "import pytest\n"]);
  }
  for (const [at, text] of inserts.sort((a, b) => b[0] - a[0])) lines.splice(at, 0, text);
  return lines.join("");
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
  command: (testCommand, targets, reportPath) =>
    testCommand.replaceAll("{targets}", targets.map(shQuote).join(" ")) +
    " -p no:cacheprovider --continue-on-collection-errors -o junit_family=xunit1" +
    ` --junitxml=${shQuote(reportPath)}`,
  parseReport: (text) => parseJunit(text, (f) => f.endsWith(".py") ? f.slice(0, -3).replaceAll("/", ".") : ""),
  skip: pythonSkip,
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
