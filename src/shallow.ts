// Tests that check how the code is written rather than what it does: one that reads a source file and matches its
// text ("app.js mentions timingSafeEqual"), or one whose every assertion is that something exists ("update is a
// function"). They fail on a real defect, but a fix can make them pass without fixing the behaviour, so the report and
// the fix prompt say so. Read from the test's own body; nothing here changes a verdict or a mark.

export type Shallow = "source-text" | "existence";

const CODE_FILE = /['"`][^'"`\n]*\.(?:[cm]?[jt]sx?|py|rs|go|java|kt|rb|php|cs)['"`]/;
const READS_SOURCE = new RegExp(String.raw`(?:readFileSync|readFile|read_text|open)\s*\([^\n]*` + CODE_FILE.source +
  String.raw`|inspect\.getsource\s*\(|include_str!\s*\(`);
const TEXT_CHECK = /\.toMatch\s*\(|\.toContain\s*\(|\.includes\s*\(|\.indexOf\s*\(|re\.search\s*\(|\bassert\b[^\n]*\bin\b/;
/** An assertion that only something exists: `expect(typeof x.f).toBe("function")`, `toBeDefined()`, `toHaveProperty`
 * with the property alone (with a value too, it checks the value); `assert hasattr(...)`, `assert callable(...)`. */
const EXISTS_JS = /^expect\s*\(\s*typeof\b[^\n]*\)\s*\.toBe\s*\(\s*['"]function['"]\s*\)|^expect\s*\([^\n]*\)\s*\.(?:toBeDefined\s*\(|toHaveProperty\s*\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`|\[[^\]]*\])\s*\))/;
const EXISTS_PY = /^assert\s+(?:hasattr|callable)\s*\(/;

/** The test's body: from its name to the next test, or the end of the file. JS names come as "describe > it": the
 * name is looked for after its describe blocks', so two tests of the same name in different suites are told apart. */
export function testBody(source: string, func: string): string | null {
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
  return source.slice(at, at + name.length + (next ? next.index : rest.length));
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** What a test checks, when it is shallow: the code's text, or only that something exists; null otherwise (and when
 * its body cannot be found). */
export function shallowKind(source: string | undefined, func: string): Shallow | null {
  const body = source ? testBody(source, func) : null;
  if (!body) return null;
  if (READS_SOURCE.test(body) && TEXT_CHECK.test(body)) return "source-text";
  const asserts = body.split("\n").map((l) => l.trim()).filter((l) => /^(?:expect\s*\(|assert\b)/.test(l));
  if (asserts.length && asserts.every((l) => EXISTS_JS.test(l) || EXISTS_PY.test(l))) return "existence";
  return null;
}

/** The note the report and the fix prompt give a shallow test. */
export const SHALLOW_NOTE: Record<Shallow, string> = {
  "source-text": "it checks the code's text, not what the code does: a change can pass it without fixing the behaviour",
  existence: "it checks only that something exists, not that it works",
};
