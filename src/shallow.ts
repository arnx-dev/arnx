// Tests that check how the code is written rather than what it does: one that reads a source file and matches its
// text ("app.js mentions timingSafeEqual"), or one whose every assertion is that something exists ("update is a
// function"). They fail on a real defect, but a fix can make them pass without fixing the behaviour, so the report and
// the fix prompt say so. Read from the test's own body (and, for the code's text, a read at the top of its file or
// suite); nothing here changes a verdict or a mark. The before/after check leaves a source-text test's regression or
// fix unproven (before.ts `textBefore`, `textFix`).
import { lstatSync } from "node:fs";
import { join, posix } from "node:path";

export type Shallow = "source-text" | "existence";

const CODE_EXT = String.raw`\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|rb|php|cs)`;
const CODE_FILE = new RegExp(String.raw`['"\`]([^'"\`\n]*${CODE_EXT})['"\`]`);
const CODE_NAME = new RegExp(`${CODE_EXT}$`);
/** A call that reads a file by its path: Node's readFile, Python's open (not Popen, urlopen or a method named open),
 * Rust's include_str!. */
const READ_CALL = /\breadFile(?:Sync)?\s*\(|(?:(?<![\w.])|(?<=\b(?:io|codecs)\.))open\s*\(|\binclude_str!\s*\(/;
/** pathlib's read, after the path: `Path("app.py").read_text()`. */
const READ_AFTER = /\.read_(?:text|bytes)\s*\(/;
const GETSOURCE = /\binspect\.getsource\s*\(/;
/** Text that is run rather than read: a test that runs the code it read checks behaviour. */
const RUNS =
  /\b(?:eval|exec|compile|exec_module)\s*\(|\bnew\s+Function\s*\(|\bvm\.\w+\s*\(|\.runIn\w*Context\s*\(|\bimportlib\b/;
/** A folder that holds a test's data (input, expected output), not the code under test. */
const FIXTURE_DIR = new RegExp(String.raw`(?:^|[/'"\`])(?:__fixtures__|__testfixtures__|fixtures?|testdata|` +
  String.raw`test[-_]?data|samples?|cases|inputs|__snapshots__|snapshots?|golden)(?=[/'"\`]|$)`, "i");
/** An assertion that only something exists: `expect(typeof x.f).toBe("function")`, `toBeDefined()`, `toHaveProperty`
 * with the property alone (with a value too, it checks the value); `assert hasattr(...)`, `assert callable(...)`. */
const EXISTS_JS = /^expect\s*\(\s*typeof\b[^\n]*\)\s*\.toBe\s*\(\s*['"]function['"]\s*\)|^expect\s*\([^\n]*\)\s*\.(?:toBeDefined\s*\(|toHaveProperty\s*\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`|\[[^\]]*\])\s*\))/;
const EXISTS_PY = /^assert\s+(?:hasattr|callable)\s*\(/;
/** A name given a value at the start of a line: `const src = …`, `SOURCE = …`. */
const ASSIGNS = /^\s*(?:export\s+)?(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(?::[^=\n]*)?=(?!=)/;
/** Python's `with open(...) as f:`: the file it names is read through `f.read()`. */
const WITH_OPEN = /\bwith\b[^\n]*\bas\s+([A-Za-z_]\w*)\s*:/;

/** Where the test is: from its name to the next test, or the end of the file. JS names come as "describe > it": the
 * name is looked for after its describe blocks', so two tests of the same name in different suites are told apart. */
/** The text of the test `func` in `source`; the whole file when it cannot be told apart. */
export function testText(source: string, func: string): string {
  const span = testSpan(source, func);
  return span ? source.slice(span.at, span.end) : source;
}

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
  return { at, end: at + name.length + (next ? withoutDecorators(rest, next.index) : rest.length) };
}

/** Where the next test's own lines start: its decorators or attributes (`@x(…)`, `#[x]`, over several lines too) are
 * above its name, but they are not this test's. `end`: the offset in `text` of the line break before the next test. */
function withoutDecorators(text: string, end: number): number {
  const lines = text.slice(0, end).split("\n");
  let cut = lines.length, open = 0;
  const net = (l: string) => (l.match(/[)\]]/g)?.length ?? 0) - (l.match(/[([]/g)?.length ?? 0);
  for (let k = lines.length - 1; k >= 1; k--) {
    const l = lines[k]!.trim();
    const starts = l.startsWith("@") || l.startsWith("#[");
    if (open === 0 && starts && net(l) <= 0) cut = k;
    else if (open === 0 && !starts && net(l) > 0) open = net(l);
    else if (open > 0) {
      open += net(l);
      if (open <= 0) {
        if (!starts) break;
        [cut, open] = [k, 0];
      }
    } else break;
  }
  return lines.slice(0, cut).join("\n").length;
}

/** The test's body: from its name to the next test, or the end of the file. */
export function testBody(source: string, func: string): string | null {
  const span = testSpan(source, func);
  return span ? source.slice(span.at, span.end) : null;
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const indent = (line: string) => /^\s*/.exec(line)![0].length;
const word = (n: string) => new RegExp(String.raw`(?<![\w$])${esc(n)}(?![\w$])`);

/** The path a line reads, from the read call's quoted parts joined up to the code file's name (`join(__dirname, "..",
 * "app.js")` reads "../app.js"); "" for `inspect.getsource`, which reads the code itself; null when it reads no code
 * file. */
function readPath(line: string): string | null {
  if (GETSOURCE.test(line)) return "";
  let from = -1;
  const call = READ_CALL.exec(line);
  if (call && CODE_FILE.test(line.slice(call.index))) from = call.index;
  const after = from < 0 ? READ_AFTER.exec(line) : null;
  if (after && CODE_FILE.test(line.slice(0, after.index))) from = Math.max(0, line.lastIndexOf("Path(", after.index));
  if (from < 0) return null;
  const parts: string[] = [];
  for (const m of line.slice(from).matchAll(/['"`]([^'"`\n]*)['"`]/g)) {
    parts.push(m[1]!);
    if (CODE_NAME.test(m[1]!)) break;
  }
  return posix.join(...parts);
}

/** The code file a line names in its quoted parts, joined (`join(dir, "..", "app.ts")` is "../app.ts"); null if none. */
function codePathIn(line: string): string | null {
  const parts: string[] = [];
  for (const m of line.matchAll(/['"`]([^'"`\n]*)['"`]/g)) {
    parts.push(m[1]!);
    if (CODE_NAME.test(m[1]!)) return posix.join(...parts);
  }
  return null;
}

/** Whether an expression or line reads one of the project's source files: a code file outside a fixtures folder
 * (`isSource`, when given, says whether the path names one of the project's files), or Python's `inspect.getsource`. */
function readsCode(text: string, isSource?: (path: string) => boolean): boolean {
  const path = readPath(text);
  if (path === null) return false;
  return path === "" || (!FIXTURE_DIR.test(text) && (isSource ? isSource(path) : true));
}

/** The arguments of the call whose "(" is at `open`, split at its own commas (to the end of the line when the call
 * goes on), and where it ends. */
function callArgs(line: string, open: number): { args: string[]; end: number } {
  const args: string[] = [];
  let depth = 0, quote = "", start = open + 1, i = open;
  for (; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = "";
    } else if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") {
      if (--depth === 0) break;
    } else if (c === "," && depth === 1) {
      args.push(line.slice(start, i).trim());
      start = i + 1;
    }
  }
  args.push(line.slice(start, i).trim());
  return { args, end: i };
}

/** The expression before a method call's dot: names, dots, and the calls and indexes between them. */
function receiver(line: string, dot: number): string {
  let i = dot - 1;
  while (i >= 0) {
    if (line[i] === ")" || line[i] === "]") {
      for (let depth = 0; i >= 0; i--) {
        if (line[i] === ")" || line[i] === "]") depth++;
        else if ((line[i] === "(" || line[i] === "[") && --depth === 0) break;
      }
      i--;
    } else if (/[\w$.]/.test(line[i]!)) i--;
    else break;
  }
  return line.slice(i + 1, dot).trim();
}

/** What the text checks on a line look at: `expect(S).toMatch(…)` and `.toContain`, `S.includes(…)` and the like,
 * `assert.match(S, …)`, `/re/.test(S)`, Python's `… in S`, `re.search(…, S)`, `assertIn(…, S)`, `assertRegex(S, …)`. */
function checked(line: string): string[] {
  const out: string[] = [];
  const calls = (rx: RegExp, pick: (args: string[], end: number) => string | undefined) => {
    for (const m of line.matchAll(rx)) {
      const { args, end } = callArgs(line, m.index! + m[0].length - 1);
      const s = pick(args, end);
      if (s) out.push(s);
    }
  };
  calls(/\bexpect\s*\(/g, (a, end) =>
    /^\)\s*(?:\.\s*not\s*)?\.\s*(?:toMatch|toContain)\s*\(/.test(line.slice(end)) ? a[0] : undefined);
  calls(/\bassert\s*\.\s*(?:match|doesNotMatch)\s*\(/g, (a) => a[0]);
  calls(/\/[dgimsuyv]*\.test\s*\(/g, (a) => a[0]);
  calls(/\bre\s*\.\s*(?:search|match|fullmatch|findall)\s*\(/g, (a) => a[1]);
  calls(/\.assert(?:Not)?In\s*\(/g, (a) => a[1]);
  calls(/\.assert(?:Not)?Regex\s*\(/g, (a) => a[0]);
  for (const m of line.matchAll(/\.\s*(?:includes|indexOf|match|search|find|count)\s*\(/g)) {
    if (!/\b(?:assert|re)\s*$/.test(line.slice(0, m.index))) out.push(receiver(line, m.index!));
  }
  if (/^\s*assert\b|\bassert(?:True|False)\s*\(/.test(line)) {
    const plain = line.replace(/\bnot\s+in\b/g, "in").replace(/\s+#.*$/, "");
    // Each side of an `or` / `and` is its own check: `"a" in t or "b" in t` looks at `t` twice, not at `t or "b" in t`.
    for (const part of plain.split(/\s+(?:or|and)\s+/)) {
      const m = /\bin\s+/.exec(part);
      if (m) out.push(callArgs(`(${part.slice(m.index + m[0].length)})`, 0).args[0]!);
    }
  }
  return out;
}

/** What a test checks, when it is shallow: the code's text, or only that something exists; null otherwise (and when
 * its body cannot be found). The code's text: a text check looks at text read from a source file, the read itself or
 * a name given it (in the test, or earlier in the file no deeper than the test: its module's or its suite's), and
 * the test does not run that text (eval, vm, exec, importlib: then it checks behaviour). */
export function shallowKind(source: string | undefined, func: string, isSource?: (path: string) => boolean)
  : Shallow | null {
  const span = source ? testSpan(source, func) : null;
  if (!source || !span) return null;
  const lines = source.slice(span.at, span.end).split("\n");
  const before = source.slice(0, span.at).split("\n");
  const depth = indent(before.at(-1)!);
  const scope = [...before.slice(0, -1).filter((l) => indent(l) <= depth), ...lines];
  // Names given the text: assigned from a read, or from `f.read()` of a `with open(...) as f`.
  const names: string[] = [], handles: string[] = [], paths: string[] = [];
  const readOf = (h: string) => new RegExp(String.raw`^${esc(h)}\s*\.\s*read\s*\(\s*\)$`);
  // A read of a path held in a name (`const file = join(dir, "app.ts"); readFileSync(file)`) reads code too.
  const reads = (l: string) => readsCode(l, isSource) ||
    (paths.some((n) => word(n).test(l)) && (READ_CALL.test(l) || READ_AFTER.test(l)));
  // A name given part of a text name (`src.slice(0, 80)`, `src.split("\n")`) is text too.
  const derived = (rhs: string) => names.some((n) => new RegExp(String.raw`^${esc(n)}(?![\w$])(?:\s*\.\s*\w+\s*\([^()]*\))+$`).test(rhs));
  for (const l of scope) {
    const w = WITH_OPEN.exec(l);
    if (w && reads(l)) handles.push(w[1]!);
    const m = ASSIGNS.exec(l);
    const rhs = m ? l.slice(l.indexOf("=") + 1).trim().replace(/;$/, "") : "";
    if (m && (reads(l) || handles.some((h) => readOf(h).test(rhs)) || derived(rhs))) names.push(m[1]!);
    else if (m && !READ_CALL.test(l) && !FIXTURE_DIR.test(l)) {
      const p = codePathIn(l);
      if (p !== null && (isSource ? isSource(p) : true)) paths.push(m[1]!);
    }
  }
  const run = scope.filter((l) => RUNS.test(l));
  const text = names.filter((n) => !run.some((l) => word(n).test(l)));
  const isText = (s: string) => {
    const t = s.trim();
    if (reads(t)) return !RUNS.test(t);
    return handles.some((h) => readOf(h).test(t)) ||
      text.some((n) => new RegExp(String.raw`^${esc(n)}(?![\w$])(?:\s*\.\s*\w+\s*\([^()]*\))*$`).test(t));
  };
  if (lines.some((l) => checked(l).some(isText))) return "source-text";
  const asserts = lines.map((l) => l.trim()).filter((l) => /^(?:expect\s*\(|assert\b)/.test(l));
  if (asserts.length && asserts.every((l) => EXISTS_JS.test(l) || EXISTS_PY.test(l))) return "existence";
  return null;
}

/** Whether a path a test reads, as written there, names one of the project's own source files in `root` (a snapshot
 * of the code): resolved from the test's folder, else from the project's folder or the repository's root (where its
 * runner starts), or the sandbox's /src. A test file, or one in a fixtures folder, is not. */
export function projectSource(root: string, workdir: string, isTestFile: (name: string) => boolean)
  : (testFile: string, path: string) => boolean {
  const isFile = (rel: string) => {
    try {
      return lstatSync(join(root, rel)).isFile();
    } catch {
      return false;
    }
  };
  const ok = (rel: string) => !rel.startsWith("../") && !rel.startsWith("/") && !FIXTURE_DIR.test(rel) &&
    !isTestFile(posix.basename(rel)) && isFile(rel);
  return (testFile, path) => {
    if (path.startsWith("/src/")) return ok(posix.normalize(path.slice("/src/".length)));
    return [posix.join(posix.dirname(testFile), path), posix.join(workdir, path), posix.normalize(path)].some(ok);
  };
}

/** The note the report and the fix prompt give a shallow test. */
export const SHALLOW_NOTE: Record<Shallow, string> = {
  "source-text": "it checks the code's text, not what the code does: a change can pass it without fixing the behaviour",
  existence: "it checks only that something exists, not that it works",
};
