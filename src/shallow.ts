// Tests that check how the code is written rather than what it does: one that reads a source file and matches its
// text ("app.js mentions timingSafeEqual"), or one whose every assertion is that something exists ("update is a
// function"). They fail on a real defect, but a fix can make them pass without fixing the behaviour, so the report and
// the fix prompt say so. Read from the test's own body (and, for the code's text, a read at the top of its file or
// suite); nothing here changes a verdict or a mark. The before/after check leaves a source-text test's regression or
// fix unproven (before.ts `textBefore`, `textFix`).
import { lstatSync, readdirSync } from "node:fs";
import { join, posix } from "node:path";

export type Shallow = "source-text" | "existence";

const CODE_FILE = /['"`]([^'"`\n]*\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|rb|php|cs))['"`]/;
const READS_SOURCE = new RegExp(String.raw`(?:readFileSync|readFile|read_text|read_bytes|open)\s*\([^\n]*` +
  CODE_FILE.source + "|" + CODE_FILE.source + String.raw`[^\n]*\.read_(?:text|bytes)\s*\(` +
  String.raw`|inspect\.getsource\s*\(|include_str!\s*\(`);
const TEXT_CHECK = new RegExp([String.raw`\.toMatch\s*\(`, String.raw`\.toContain\s*\(`, String.raw`\.includes\s*\(`,
  String.raw`\.indexOf\s*\(`, String.raw`\.(?:doesNotM|m)atch\s*\(`, String.raw`\/[dgimsuyv]*\.test\s*\(`,
  String.raw`\bre\.(?:search|match|fullmatch|findall)\s*\(`, String.raw`\.assert(?:Not)?(?:In|Regex)\s*\(`,
  String.raw`\bassert\b[^\n]*\bin\b`].join("|"));
/** A folder that holds a test's data (input, expected output), not the code under test. */
const FIXTURE_DIR =
  /(?:^|[/'"`])(?:__fixtures__|fixtures?|testdata|test[-_]?data|samples?|__snapshots__|snapshots?|golden)(?=[/'"`]|$)/i;
/** An assertion that only something exists: `expect(typeof x.f).toBe("function")`, `toBeDefined()`, `toHaveProperty`
 * with the property alone (with a value too, it checks the value); `assert hasattr(...)`, `assert callable(...)`. */
const EXISTS_JS = /^expect\s*\(\s*typeof\b[^\n]*\)\s*\.toBe\s*\(\s*['"]function['"]\s*\)|^expect\s*\([^\n]*\)\s*\.(?:toBeDefined\s*\(|toHaveProperty\s*\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`|\[[^\]]*\])\s*\))/;
const EXISTS_PY = /^assert\s+(?:hasattr|callable)\s*\(/;
/** A name given a value at the start of a line: `const src = …`, `SOURCE = …`. */
const ASSIGNS = /^(\s*)(?:export\s+)?(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=(?!=)/;

/** Where the test is: from its name to the next test, or the end of the file. JS names come as "describe > it": the
 * name is looked for after its describe blocks', so two tests of the same name in different suites are told apart. */
function testSpan(source: string, func: string): { at: number; end: number } | null {
  const path = func.split(" > ");
  const name = path.at(-1)!.split("::").at(-1)!.replace(/\[.*\]$/, "");
  if (!name) return null;
  const quotes = (s: string) => [`'${s}'`, `"${s}"`, `\`${s}\``];
  // Where its suites start, in order; a suite not found leaves the search where it was.
  let from = 0;
  for (const suite of path.slice(0, -1)) {
    const at = quotes(suite).map((q) => source.indexOf(q, from)).filter((i) => i >= 0);
    if (at.length) from = Math.min(...at);
  }
  const quoted = quotes(name).map((q) => source.indexOf(q, from)).filter((i) => i >= 0);
  const defined = [new RegExp(String.raw`\bdef\s+${esc(name)}\s*\(`), new RegExp(String.raw`\bfn\s+${esc(name)}\s*\(`)]
    .map((rx) => rx.exec(source)?.index ?? -1).filter((i) => i >= 0);
  const at = Math.min(...quoted, ...defined);
  if (!Number.isFinite(at)) return null;
  const rest = source.slice(at + name.length);
  const next = /\n\s*(?:it|test)(?:\.\w+)?\s*\(|\n\s*(?:async\s+)?def\s+test|\n\s*#\[test\]|\n\s*(?:class|describe)\b/.exec(rest);
  return { at, end: at + name.length + (next ? next.index : rest.length) };
}

/** The test's body: from its name to the next test, or the end of the file. */
export function testBody(source: string, func: string): string | null {
  const span = testSpan(source, func);
  return span ? source.slice(span.at, span.end) : null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const indent = (line: string) => /^\s*/.exec(line)![0].length;

/** Whether a line reads one of the project's source files: a code file outside a fixtures folder (`isSource`, when
 * given, says whether the path names one of the project's files), or Python's `inspect.getsource`. */
function readsCode(line: string, isSource?: (path: string) => boolean): boolean {
  if (!READS_SOURCE.test(line)) return false;
  if (/inspect\.getsource\s*\(/.test(line)) return true;
  const path = CODE_FILE.exec(line)?.[1];
  return !!path && !FIXTURE_DIR.test(line) && (isSource ? isSource(path) : true);
}

/** What a test checks, when it is shallow: the code's text, or only that something exists; null otherwise (and when
 * its body cannot be found). The code's text: the body matches text it read from a source file, itself or through a
 * name given that text earlier in the file no deeper than the test (its module's or its suite's). */
export function shallowKind(source: string | undefined, func: string, isSource?: (path: string) => boolean)
  : Shallow | null {
  const span = source ? testSpan(source, func) : null;
  if (!source || !span) return null;
  const body = source.slice(span.at, span.end);
  const lines = body.split("\n");
  if (TEXT_CHECK.test(body)) {
    if (lines.some((l) => readsCode(l, isSource))) return "source-text";
    const before = source.slice(0, span.at).split("\n");
    const depth = indent(before.at(-1)!);
    const names = before.slice(0, -1).flatMap((l) => {
      const m = ASSIGNS.exec(l);
      return m && m[1]!.length <= depth && readsCode(l, isSource) ? [m[2]!] : [];
    });
    if (names.some((n) => new RegExp(String.raw`(?<![\w$])${esc(n)}(?![\w$])`).test(body))) return "source-text";
  }
  const asserts = lines.map((l) => l.trim()).filter((l) => /^(?:expect\s*\(|assert\b)/.test(l));
  if (asserts.length && asserts.every((l) => EXISTS_JS.test(l) || EXISTS_PY.test(l))) return "existence";
  return null;
}

/** Whether a path a test reads, as written there, names one of the project's own source files in `root` (a snapshot
 * of the code): tried from the test's folder, the project's folder and the repository's root (and the sandbox's /src),
 * else as the end of a path there (a path built from parts). A test file, or one in a fixtures folder, is not. */
export function projectSource(root: string, workdir: string, isTestFile: (name: string) => boolean)
  : (testFile: string, path: string) => boolean {
  let all: string[] | null = null;
  const isFile = (rel: string) => {
    try {
      return lstatSync(join(root, rel)).isFile();
    } catch {
      return false;
    }
  };
  const ok = (rel: string) => !rel.startsWith("../") && !FIXTURE_DIR.test(rel) && !isTestFile(posix.basename(rel)) &&
    isFile(rel);
  return (testFile, path) => {
    const sandbox = path.startsWith("/src/");
    const p = sandbox ? path.slice("/src/".length) : path;
    const tries = sandbox ? [p] : [posix.join(posix.dirname(testFile), p), posix.join(workdir, p), posix.normalize(p)];
    if (tries.some(ok)) return true;
    const tail = posix.normalize(p).replace(/^(?:\.\.?\/)+/, "");
    all ??= filesUnder(root);
    return all.some((f) => (f === tail || f.endsWith(`/${tail}`)) && ok(f));
  };
}

/** Every file under `root`, as POSIX paths relative to it (dependencies and git's folder left out). */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const visit = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(root, rel));
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(join(root, r));
      if (st.isDirectory() && name !== ".git" && name !== "node_modules") visit(r);
      else if (st.isFile()) out.push(r);
    }
  };
  visit("");
  return out;
}

/** The note the report and the fix prompt give a shallow test. */
export const SHALLOW_NOTE: Record<Shallow, string> = {
  "source-text": "it checks the code's text, not what the code does: a change can pass it without fixing the behaviour",
  existence: "it checks only that something exists, not that it works",
};
