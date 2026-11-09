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
}

const MAX_MESSAGE = 4000;
const cap = (s: string) => (s.length > MAX_MESSAGE ? `${s.slice(0, MAX_MESSAGE)}\n...` : s);
// The runner's own bookkeeping lines, never the test's.
const NOISE = /^\s*(=== |--- )/;
// Where a failure's own text starts: its file:line or a panic. Anything the test logged before (a timestamp from
// the log package, say) differs run to run and would make the same failure look changed.
const START = /\.go:\d+(:\d+)?: |^\s*panic:/;
const fromFailure = (lines: string[]) => {
  const i = lines.findIndex((l) => START.test(l));
  return i > 0 ? lines.slice(i) : lines;
};

export function parseGoReport(text: string): TestResult[] | null {
  let modulePath = "";
  const files = new Map<string, Set<string>>(); // dir -> files declaring a test function
  const declared = new Map<string, string>(); // `${dir}\0${name}` -> file
  const events: GoEvent[] = [];
  for (const line of text.split("\n")) {
    const mod = /^#arnx-module (\S+)/.exec(line);
    if (mod) { modulePath = mod[1]!; continue; }
    const decl = /^#arnx-test (.+?\.go):func (Test\w*)\(/.exec(line);
    if (decl) {
      const file = posix.normalize(decl[1]!), dir = posix.dirname(file);
      if (!files.has(dir)) files.set(dir, new Set());
      files.get(dir)!.add(file);
      if (decl[2] !== "TestMain") declared.set(`${dir}\0${decl[2]}`, file);
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
    sawTest.add(dir);
    const top = ev.Test.split("/")[0]!;
    const key = `${dir}\0${top}`;
    if (!declared.has(key)) continue; // forged or unknown
    let c = cases.get(key);
    if (!c) {
      c = { dir, name: top, terminals: new Set(), out: [] };
      cases.set(key, c);
    }
    if (ev.Action === "output") c.out.push(ev.Output ?? "");
    else if (!ev.Test.includes("/") && (ev.Action === "pass" || ev.Action === "fail" || ev.Action === "skip")) c.terminals.add(ev.Action);
    // a failing subtest is reported through its parent, whose own terminal event fails with it
  }

  for (const [key, c] of cases) {
    const file = declared.get(key)!;
    const kept = c.out.join("").split("\n").filter((l) => !NOISE.test(l));
    const message = cap(c.terminals.has("fail") ? fromFailure(kept).join("\n").trim() : kept.join("\n").trim());
    const t = c.terminals;
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
  const hasDeclared = (dir: string) => [...declared.keys()].some((k) => k.startsWith(`${dir}\0`));
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
