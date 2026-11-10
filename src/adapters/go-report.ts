// Reads `go test -json` output. The adapter's command appends `#arnx-module <path>` and one `#arnx-test <file>:<func
// line>` per declared test function, which give the parser file attribution; results are keyed on `Package`, never
// on `FailedBuild` (it can name a dependency).
import { posix } from "node:path";
import type { TestResult } from "./types";

interface GoEvent {
  Action?: string;
  Package?: string;
  Test?: string;
  Output?: string;
  ImportPath?: string;
  FailedBuild?: string;
}

interface Case {
  dir: string;
  name: string;
  terminals: Set<string>;
  out: string[];
  /** Each (sub)test's own output, by its full name, and the (sub)tests that failed. */
  own: Map<string, string[]>;
  failed: Set<string>;
}

const MAX_MESSAGE = 4000;
const cap = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}\n...` : s);
// The runner's own bookkeeping lines, never the test's (an indented `--- expected` of a diff is the test's).
const NOISE = /^\s*(?:=== (?:RUN|PAUSE|CONT|NAME) |--- (?:FAIL|PASS|SKIP): )/;
// Where a failure's own text starts: its file:line or a panic. Anything the test logged before (a timestamp from
// the log package, say) differs run to run and would make the same failure look changed.
const START = /\.go:\d+(:\d+)?: |^\s*panic:/;
const fromFailure = (lines: string[]) => {
  const i = lines.findIndex((l) => START.test(l));
  return i > 0 ? lines.slice(i) : lines;
};

// A failure's first line is what before.ts compares and the baseline keeps, so it must say what failed. `go test
// -json` prints t.Log and t.Error alike (`    file.go:N: text`, more lines indented under it), so the rule is:
// a panic is the failure; else, per failing (sub)test, its testify blocks (`Error Trace:` marks an assertion, never
// a log), or the entry nearest its end (a log comes before the check that fails, which t.Fatal and require end on).
// A parent whose subtests gave a failure adds only its own testify blocks. Each entry carries the lines under it.
const ENTRY = /^(\s*)([\w.+-]+\.go:\d+):(?: (.*))?$/;
const FIELD = /^\s*(Error Trace|Error|Test|Messages):\s*\t(.*)$/;
const DIFF_HEAD = /^\s*(?:---|\+\+\+) /; // a diff's `--- expected` / `+++ actual`: nothing about this failure
const ENTRY_MAX = 240;
const FIRST_MAX = 500;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const join1 = (parts: string[]) => parts.map((p) => p.trim()).filter(Boolean).join(" ");

/** What differs run to run in the same failure, evened out: colour codes, addresses (as before.ts does), timings,
 * temporary directories and local ports. */
const steady =(s: string) => s
  .replace(/\u001b\[[0-9;]*[A-Za-z]/g, "")
  .replace(/0x[0-9a-f]+/gi, "0x…")
  .replace(/\b(?:\d+h)?(?:\d+m)?\d+\.\d+(?:s|ms|µs|us|ns)\b|\b\d+(?:ms|µs|us|ns)\b/g, "<duration>")
  .replace(/\/tmp\/[^\s/:'"\])]*\d{3,}[^\s/:'"\])]*/g, "/tmp/<tmp>")
  .replace(/\b(127\.0\.0\.1|localhost|0\.0\.0\.0|\[::1?\]):\d{2,5}\b/g, "$1:<port>")
  .replace(/\s+/g, " ").trim();

interface Entry { text: string; testify: boolean }

/** A (sub)test's output as entries: a `file.go:N:` line and the lines indented under it. */
function entries(lines: string[]): Entry[] {
  const out: Entry[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = ENTRY.exec(lines[i]!);
    if (!m) continue;
    const indent = m[1]!.length;
    const under: string[] = [];
    while (i + 1 < lines.length && (!lines[i + 1]!.trim() || /^\s*/.exec(lines[i + 1]!)![0].length > indent)) under.push(lines[++i]!);
    if (under.some((l) => /^\s*Error Trace:/.test(l))) {
      const fields = new Map<string, string[]>();
      let at = "";
      for (const l of under) {
        const f = FIELD.exec(l);
        if (f) fields.set(at = f[1]!, [f[2]!]);
        else fields.get(at)?.push(l);
      }
      const messages = join1(fields.get("Messages") ?? []);
      const error = join1([m[3] ?? "", ...(fields.get("Error") ?? []).filter((l) => !DIFF_HEAD.test(l))]);
      out.push({ text: `${m[2]}: ${error}${messages ? ` (${messages})` : ""}`, testify: true });
    } else {
      out.push({ text: `${m[2]}: ${join1([m[3] ?? "", ...under.filter((l) => !DIFF_HEAD.test(l))])}`, testify: false });
    }
  }
  return out;
}

/** The one line that tells this failure apart, null when the output has none (a bare t.Fail). */
function fingerprint(c: Case): string | null {
  const panic = c.out.join("").split("\n").find((l) => /^panic: /.test(l));
  if (panic) return clip(steady(panic), FIRST_MAX);
  const names = [...c.failed].sort((a, b) => b.split("/").length - a.split("/").length);
  const gave = new Map<string, string[]>();
  for (const n of names) {
    const es = entries((c.own.get(n) ?? []).join("").split("\n").filter((l) => !NOISE.test(l)));
    const below = [...gave.keys()].some((k) => k.startsWith(`${n}/`) && gave.get(k)!.length);
    const testify = es.filter((e) => e.testify);
    const chosen = testify.length ? testify : below || !es.length ? [] : [es.at(-1)!];
    gave.set(n, chosen.map((e) => clip(steady(e.text), ENTRY_MAX)));
  }
  const parts = [...gave.keys()].sort().flatMap((n) => gave.get(n)!);
  return parts.length ? clip(parts.join(" | "), FIRST_MAX) : null;
}

export function parseGoReport(text: string): TestResult[] | null {
  let modulePath = "";
  const files = new Map<string, Set<string>>(); // dir -> files declaring a test function
  const unread = new Set<string>(); // dirs with a listed test line whose name cannot be read
  const declared = new Map<string, string>(); // `${dir}\0${name}` -> file
  const events: GoEvent[] = [];
  for (const line of text.split("\n")) {
    const mod = /^#arnx-module (\S+)/.exec(line);
    if (mod) { modulePath = mod[1]!; continue; }
    const decl = /^#arnx-test (.+?\.go):func (?:(Test[^\s(]*)\()?/.exec(line);
    if (decl) {
      const file = posix.normalize(decl[1]!), dir = posix.dirname(file);
      if (!files.has(dir)) files.set(dir, new Set());
      files.get(dir)!.add(file);
      if (!decl[2]) unread.add(dir);
      else if (decl[2] !== "TestMain") declared.set(`${dir}\0${decl[2]}`, file);
      continue;
    }
    if (!line.startsWith("{")) continue;
    try {
      const ev = JSON.parse(line) as GoEvent;
      if (ev && typeof ev === "object" && typeof ev.Action === "string") events.push(ev);
    } catch { /* not an event */ }
  }
  if (!events.length) return null;

  const dirOf = (pkg: string) => {
    if (pkg === modulePath) return ".";
    if (pkg.startsWith("./")) return posix.normalize(pkg); // a failure Go names by its pattern, not an import path
    return pkg.startsWith(`${modulePath}/`) ? pkg.slice(modulePath.length + 1) : pkg;
  };
  const buildOutput = new Map<string, string[]>(); // ImportPath -> lines
  const cases = new Map<string, Case>();
  const results: TestResult[] = [];
  const sawTest = new Set<string>(); // dirs with any test event
  const packageEnds: GoEvent[] = [];
  const pkgOutput = new Map<string, string[]>();

  for (const ev of events) {
    if (ev.Action === "build-output" && ev.ImportPath) {
      const lines = buildOutput.get(ev.ImportPath) ?? [];
      lines.push(ev.Output ?? "");
      buildOutput.set(ev.ImportPath, lines);
      continue;
    }
    if (!ev.Package) continue;
    const dir = dirOf(ev.Package);
    if (!ev.Test) {
      if (ev.Action === "output") pkgOutput.set(dir, [...(pkgOutput.get(dir) ?? []), ev.Output ?? ""]);
      else if (ev.Action === "pass" || ev.Action === "fail" || ev.Action === "skip") packageEnds.push(ev);
      continue;
    }
    const top = ev.Test.split("/")[0]!;
    const key = `${dir}\0${top}`;
    if (!declared.has(key)) continue; // forged or unknown
    sawTest.add(dir);
    let c = cases.get(key);
    if (!c) {
      c = { dir, name: top, terminals: new Set(), out: [], own: new Map(), failed: new Set() };
      cases.set(key, c);
    }
    if (ev.Action === "fail") c.failed.add(ev.Test);
    if (ev.Action === "output") {
      c.out.push(ev.Output ?? "");
      const own = c.own.get(ev.Test);
      if (own) own.push(ev.Output ?? "");
      else c.own.set(ev.Test, [ev.Output ?? ""]);
    } else if (!ev.Test.includes("/") && (ev.Action === "pass" || ev.Action === "fail" || ev.Action === "skip")) c.terminals.add(ev.Action);
    // a failing subtest is reported through its parent, whose own terminal event fails with it
  }

  for (const [key, c] of cases) {
    const file = declared.get(key)!;
    const kept = c.out.join("").split("\n").filter((l) => !NOISE.test(l));
    let message = cap(c.terminals.has("fail") ? fromFailure(kept).join("\n").trim() : kept.join("\n").trim());
    const t = c.terminals;
    const first = t.has("fail") ? fingerprint(c) : null;
    if (first && message.split("\n")[0] !== first) message = `${first}\n${message}`;
    let outcome: string, msg: string;
    if (t.has("fail")) { outcome = "failed"; msg = message || "test failed"; }
    else if (t.has("pass")) { outcome = "passed"; msg = ""; }
    else if (t.has("skip")) { outcome = "skipped"; msg = message; }
    else { outcome = "error"; msg = "the test did not finish (timeout, os.Exit or a crash)"; }
    results.push({ testId: `${file}::${c.name}`, fileAttr: file, name: c.name, outcome, message: msg });
  }

  const fileLevel = (dir: string, outcome: string, message: string) => {
    for (const f of [...(files.get(dir) ?? [])].sort()) {
      results.push({ testId: `${f}::${f}`, fileAttr: f, name: f, outcome, message });
    }
  };
  const hasDeclared = (dir: string) => unread.has(dir) || [...declared.keys()].some((k) => k.startsWith(`${dir}\0`));
  for (const ev of packageEnds) {
    const dir = dirOf(ev.Package!);
    if (ev.Action === "fail" && (ev.FailedBuild || !sawTest.has(dir))) {
      const lines = ev.FailedBuild ? buildOutput.get(ev.FailedBuild) : undefined;
      let msg = (lines ?? []).join("").split("\n").filter((l) => l && !l.startsWith("# ")).join("\n");
      if (!msg) msg = (pkgOutput.get(dir) ?? []).join("").split("\n").filter((l) => l && !/^(FAIL|ok)\b/.test(l)).join("\n");
      fileLevel(dir, "failed", cap(msg.trim()) || "the package failed before any test ran");
    } else if (ev.Action === "pass" && !sawTest.has(dir) && hasDeclared(dir)) {
      fileLevel(dir, "error", "the package passed without running a test (TestMain may exit early)");
    }
  }
  return results;
}
