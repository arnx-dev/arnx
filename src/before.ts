// The before/after check: a test that failed in every run on the change runs again, as many times, on the code before
// it (the change's base) in the same image, and its outcome there says whether the change caused the failure. The fix
// proof does the same for tests that passed in every run: one that fails there shows the change fixes what it checks.
// No model is called. The stage itself is `beforeStage` in testround.ts; this module only compares outcomes.
import { posix } from "node:path";
import { asError, ownerFile, type TestResult } from "./outcomes";
import { codeText, inTestFolder } from "./codetext";
import { testBody } from "./shallow";
import { SOURCE } from "./untested";
import { DIFF_SECTION, splitLines } from "./util";

/** regression: passes before the change. pre-existing: fails the same way before it. new-code: what it tests does not
 * exist before it. changed: fails before it, differently. unknown: anything that settles nothing (flaky, an error, a
 * timeout, skipped, an undefined value where it is unclear whether code is missing, or not checked). */
export const BEFORE_STATUSES = ["regression", "pre-existing", "new-code", "changed", "unknown"] as const;
export type BeforeStatus = typeof BEFORE_STATUSES[number];

/** What a finding's test did on the code before the change. `runs`: its outcome in each run there ("missing": the run
 * gave no report, "timeout": it timed out, "absent": the report left the test out). `message`: its failure there.
 * `asText`: it would be a regression, but the test reads the code as text (`textBefore`). */
export interface Before {
  status: BeforeStatus; detail: string; runs: string[]; message?: string; asText?: true;
  /** A pass that would be a regression, but proves none (`vacuousPass`): the test uses a name the change adds, or the
   * code before it died in a background thread on code that is missing. */
  vacuous?: "new-name" | "background-error";
}

/** One round's check: the result per test id, why it did not run (no base, out of time), and how long it took. */
export interface BeforeCheck {
  tests: Record<string, Before>;
  skipped?: string;
  secs: number;
  snapshotMs: number;
  runsMs: number;
}

/** One run on the code before the change: the parsed report (null: none) and the runner's console. */
export interface BeforeRun { results: TestResult[] | null; output: string; timedOut: boolean }

/** Signs that the code a test uses does not exist yet: an import or a name that fails, a symbol the compiler cannot
 * find, a file of the repository (/src) the test opens by path. Seen at the base only (and not at the change), they
 * make a test `new-code`. */
const MISSING = new RegExp([
  "ModuleNotFoundError", "ImportError", "cannot import name", "has no attribute", "NameError", "is not defined",
  "is not a function", "is not a constructor", "does not provide an export named", "Cannot find module",
  "Failed to (?:load|resolve) (?:url|import)", "cannot find (?:function|value|struct|type|macro|trait|module)",
  "unresolved import", "no (?:function|method|associated item|field) named", "object has no field", "error\\[E0(?:412|425|432|433|599|609)\\]",
  "ENOENT: no such file or directory, \\w+ '/src/", "No such file or directory: '/src/",
  // vitest clips an import failure to the module's alias and the name: `__vite_ssr_import_2__.assertNever`
  "__vite_ssr_import_\\d+__\\.", "__vi_import_\\d+__", "unexpected keyword argument",
].join("|"));

/** Signs that a test hit an undefined value (JS undefined or null, Python None): V8, JSC and CPython wording. On the
 * code before the change this is what a test sees when an export it loads is not there yet, but also when a function
 * there returned nothing, so alone it is no difference in behaviour. */
const UNDEFINED = new RegExp([
  "Cannot (?:read|set) propert(?:y|ies) of (?:undefined|null)", "Cannot destructure",
  "(?:undefined|null) is not an object", "Right side of assignment cannot be destructured",
  "'NoneType' object (?:has no attribute|is not (?:callable|subscriptable|iterable))", "non-iterable NoneType",
].join("|"));

const head = (m: string) => (splitLines(m.trim())[0] ?? "").trim();
/** A failure's signature: its first line, with memory addresses and runs of spaces evened out. Two failures are the
 * same only when these match exactly; anything else is `changed`, which keeps the finding. */
const signature = (m: string) => head(m).replace(/0x[0-9a-f]+/gi, "0x…").replace(/\s+/g, " ");
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
const quoted = (m: string) => head(m).slice(0, 200) || "no message";

/** The test's outcome in one run: its own result, else the load error of its file (none of its tests ran). */
function outcomeIn(run: BeforeRun, t: TestResult, file: string | null)
  : { outcome: string; message: string; load?: true } {
  if (run.results === null) return { outcome: run.timedOut ? "timeout" : "missing", message: run.output };
  const results = run.results.map(asError);
  const own = results.find((x) => x.testId === t.testId);
  if (own) return { outcome: own.outcome, message: own.message };
  const load = file ? results.find((x) => x.outcome === "error" && ownerFile(x.fileAttr, [file]) !== null) : undefined;
  return load ? { outcome: "error", message: load.message, load: true } : { outcome: "absent", message: "" };
}

/** The name a message says is missing (`cannot import name 'X'`, `has no attribute 'X'`, `X is not defined`, an
 * unknown keyword), null when it names none. A whole module that is missing is no name: what a file imports from it,
 * its tests use. */
export function missingName(message: string): string | null {
  const m = /cannot import name ['"`]([^'"`]+)['"`]/.exec(message)
    ?? /(?:has no attribute|unexpected keyword argument|does not provide an export named|no (?:function|method|field) named) ['"`]([^'"`]+)['"`]/.exec(message)
    ?? /name ['"`]([^'"`]+)['"`] is not defined/.exec(message)
    ?? /__(?:vite_ssr_import|vi_import)_\d+__\.([A-Za-z_$][\w$]*)/.exec(message)
    ?? /(?<![\w$.])([A-Za-z_$][\w$]*) is not (?:defined|a function|a constructor)/.exec(message);
  return m?.[1] ?? null;
}

/** A file that cannot load for a name its test does not use settles nothing about that test: every test of the file
 * fails there alike. Null when the failure is not a load error, names nothing, or the test (`body`) uses the name. */
function foreignLoad(seen: { load?: true; message: string }[], body?: { source: string; func: string })
  : { name: string } | null {
  const first = seen.find((s) => s.load);
  if (!body || !first || !seen.every((s) => s.load)) return null;
  const name = missingName(first.message);
  if (!name || !MISSING.test(first.message)) return null;
  const used = usesNew(body.source, body.func, new Set([name]));
  // A test that cannot be found in its file may use it: nothing is claimed.
  return used === null && testBody(body.source, body.func) !== null ? { name } : null;
}

const unloaded = (name: string) => `its file cannot load there because \`${name}\` is missing, which this test does not use`;

/** Runs that gave no report (none: null): new code when the console says the test does not build there and no run
 * timed out, else unknown. */
function silentRuns(seen: { outcome: string; message: string }[]): { status: "new-code" | "unknown"; detail: string }
  | null {
  const silent = seen.filter((s) => s.outcome === "missing" || s.outcome === "timeout");
  if (!silent.length) return null;
  const built = silent.find((s) => MISSING.test(s.message));
  if (built && !silent.some((s) => s.outcome === "timeout")) {
    return { status: "new-code", detail: "does not build on the code before the change: what it tests is new " +
      `(${quoted(built.message.split("\n").find((l) => MISSING.test(l)) ?? "")})` };
  }
  const timedOut = silent.filter((s) => s.outcome === "timeout").length;
  return { status: "unknown", detail: `${silent.length} of ${plural(seen.length, "run")} on the code before the ` +
    `change gave no report${timedOut ? ` (${timedOut} timed out)` : ""}` };
}

/** Every test of its file hit an undefined value there: what they all load (the app, an export) is missing. A single
 * test, or one beside tests that got further, may as well have met a function that returned nothing. */
function undefinedSetup(runs: BeforeRun[], file: string | null): boolean {
  const inFile = runs.map((r) => (r.results ?? [])
    .filter((x) => file !== null && ownerFile(x.fileAttr, [file]) !== null));
  return inFile.every((xs) => xs.length > 1 && xs.every((x) =>
    (x.outcome === "failed" || x.outcome === "error") && UNDEFINED.test(head(x.message))));
}

/** Compare a finding's failure on the change (`t`, failed in every run) with its runs on the code before it.
 * `envChanged`: the change also changes what keys the image (its dependencies), so the base ran with the change's. */
export function judgeBefore(t: TestResult, file: string | null, runs: BeforeRun[], envChanged = false,
  body?: { source: string; func: string }): Before {
  const seen = runs.map((r) => outcomeIn(r, t, file));
  const outcomes = seen.map((s) => s.outcome);
  const n = runs.length;
  const all = (o: string) => n > 0 && outcomes.every((x) => x === o);
  const failure = seen.find((s) => s.outcome === "failed" || s.outcome === "error")?.message ?? "";
  const withMessage = (b: Before): Before => failure && b.status !== "regression" ? { ...b, message: failure } : b;
  if (!n) return { status: "unknown", detail: "not run on the code before the change", runs: outcomes };
  if (all("passed")) {
    return { status: "regression", detail: `passes on the code before the change (${plural(n, "run")}), fails with it`,
      runs: outcomes };
  }
  const silent = silentRuns(seen);
  if (silent) return { ...silent, runs: outcomes };
  if (all("error")) {
    const foreign = foreignLoad(seen, body);
    if (foreign) return withMessage({ status: "unknown", detail: unloaded(foreign.name), runs: outcomes });
    return withMessage(MISSING.test(failure)
      ? { status: "new-code", detail: `cannot load on the code before the change: what it tests is new ` +
        `(${quoted(failure)})`, runs: outcomes }
      : { status: "unknown", detail: `could not run on the code before the change (${quoted(failure)})`, runs: outcomes });
  }
  if (all("failed")) {
    const same = seen.every((s) => signature(s.message) === signature(t.message));
    if (same && envChanged) {
      return withMessage({ status: "unknown", detail: "fails with the same message on the code before the change, but the " +
        "change also changes the dependencies the image is built from, so that code ran with the change's",
      runs: outcomes });
    }
    if (same) {
      return withMessage({ status: "pre-existing", detail: `fails with the same message on the code before the ` +
        `change (${plural(n, "run")})`, runs: outcomes });
    }
    const blank = (m: string) => UNDEFINED.test(head(m)) || MISSING.test(head(m));
    if (UNDEFINED.test(head(failure)) && !blank(t.message)) {
      return withMessage(undefinedSetup(runs, file)
        ? { status: "new-code", detail: "what it tests does not exist on the code before the change: every test in " +
          `its file hit an undefined value there (${quoted(failure)})`, runs: outcomes }
        : { status: "unknown", detail: "could not compare: the test could not load the code before the change, or " +
          `what it called returned nothing there (${quoted(failure)})`, runs: outcomes });
    }
    if (MISSING.test(head(failure)) && !MISSING.test(head(t.message))) {
      return withMessage({ status: "new-code", detail: "what it tests does not exist on the code before the change " +
        `(${quoted(failure)})`, runs: outcomes });
    }
    return withMessage({ status: "changed", detail: `fails on the code before the change too, but differently ` +
      `(${quoted(failure)})`, runs: outcomes });
  }
  if (all("skipped")) return { status: "unknown", detail: "skipped on the code before the change", runs: outcomes };
  if (all("absent")) return { status: "unknown", detail: "did not run on the code before the change", runs: outcomes };
  const passed = outcomes.filter((o) => o === "passed").length;
  return withMessage({ status: "unknown", detail: passed
    ? `flaky on the code before the change (passed in ${passed} of ${plural(n, "run")})`
    : `mixed outcomes on the code before the change (${outcomes.join(", ")})`, runs: outcomes });
}

/** What a passing test (passed in every run on the change) did on the code before it. fixed: fails there in every
 * run, a real failure (not a load error, not missing code): the change fixes what it checks. new-code: what it tests
 * does not exist there (new behaviour, not a fix). unchanged: passes there too. unknown: anything that settles
 * nothing (flaky, an error, a timeout, skipped, an undefined value where it is unclear whether code is missing). */
export const FIX_STATUSES = ["fixed", "new-code", "unchanged", "unknown"] as const;
export type FixStatus = typeof FIX_STATUSES[number];

/** A passing test on the code before the change: as `Before`, with a fix status; `asText`: it would be fixed, but the
 * test reads the code as text (`textFix`). */
export interface Fix { status: FixStatus; detail: string; runs: string[]; message?: string; asText?: true }

/** One round's fix proof: the result per passing test id, why it did not run, and how long its own runs took. */
export interface FixCheck { tests: Record<string, Fix>; skipped?: string; secs: number; runsMs: number }

/** Compare a passing test with its runs on the code before the change, by judgeBefore's rules for missing code and
 * undefined values. `envChanged`: the change also changes what keys the image, so the base ran with its dependencies. */
export function judgeFix(t: TestResult, file: string | null, runs: BeforeRun[], envChanged = false,
  body?: { source: string; func: string }): Fix {
  const seen = runs.map((r) => outcomeIn(r, t, file));
  const outcomes = seen.map((s) => s.outcome);
  const n = runs.length;
  const all = (o: string) => n > 0 && outcomes.every((x) => x === o);
  const failure = seen.find((s) => s.outcome === "failed" || s.outcome === "error")?.message ?? "";
  const withMessage = (f: Fix): Fix => failure ? { ...f, message: failure } : f;
  if (!n) return { status: "unknown", detail: "not run on the code before the change", runs: outcomes };
  if (all("passed")) {
    return { status: "unchanged", detail: `passes on the code before the change too (${plural(n, "run")})`,
      runs: outcomes };
  }
  const silent = silentRuns(seen);
  if (silent) return { ...silent, runs: outcomes };
  if (all("error")) {
    const foreign = foreignLoad(seen, body);
    if (foreign) return withMessage({ status: "unknown", detail: unloaded(foreign.name), runs: outcomes });
    return withMessage(MISSING.test(failure)
      ? { status: "new-code", detail: `cannot load on the code before the change: what it tests is new ` +
        `(${quoted(failure)})`, runs: outcomes }
      : { status: "unknown", detail: `could not run on the code before the change (${quoted(failure)})`, runs: outcomes });
  }
  if (all("failed")) {
    if (MISSING.test(head(failure))) {
      return withMessage({ status: "new-code", detail: "what it tests does not exist on the code before the change " +
        `(${quoted(failure)})`, runs: outcomes });
    }
    if (UNDEFINED.test(head(failure))) {
      return withMessage(undefinedSetup(runs, file)
        ? { status: "new-code", detail: "what it tests does not exist on the code before the change: every test in " +
          `its file hit an undefined value there (${quoted(failure)})`, runs: outcomes }
        : { status: "unknown", detail: "could not tell: the test could not load the code before the change, or " +
          `what it called returned nothing there (${quoted(failure)})`, runs: outcomes });
    }
    if (envChanged) {
      return withMessage({ status: "unknown", detail: "fails on the code before the change, but the change also " +
        "changes the dependencies the image is built from, so that code ran with the change's", runs: outcomes });
    }
    return withMessage({ status: "fixed", detail: `fails on the code before the change (${plural(n, "run")}) and ` +
      `passes after (${quoted(failure)})`, runs: outcomes });
  }
  if (all("skipped")) return { status: "unknown", detail: "skipped on the code before the change", runs: outcomes };
  if (all("absent")) return { status: "unknown", detail: "did not run on the code before the change", runs: outcomes };
  const passed = outcomes.filter((o) => o === "passed").length;
  return withMessage({ status: "unknown", detail: passed
    ? `flaky on the code before the change (passed in ${passed} of ${plural(n, "run")})`
    : `mixed outcomes on the code before the change (${outcomes.join(", ")})`, runs: outcomes });
}

/** A test that reads the code under test as text and matches it (shallow.ts "source-text"): passing on one side of
 * the change and failing on the other shows the text changed, not the behaviour. Its regression is no proof: unknown,
 * saying why. Other outcomes stand. */
export function textBefore(b: Before): Before {
  return b.status !== "regression" ? b : { ...b, status: "unknown", asText: true, detail: "passes on the code before " +
    `the change (${plural(b.runs.length, "run")}), but it reads the code as text: no proof of a regression` };
}

/** As `textBefore`, for the fix proof: a fix shown by a test that reads the code as text is no proof. */
export function textFix(f: Fix): Fix {
  return f.status !== "fixed" ? f : { ...f, status: "unknown", asText: true, detail: "fails on the code before " +
    `the change (${plural(f.runs.length, "run")}), but it reads the code as text: no proof of a fix` };
}

const WORDS = /[A-Za-z_$][\w$]*/g;

/** Whether a piece of code closes what it never opened: a triple quote count that is odd, or a `*/` before any `/*`. Read
 * alone, such a piece would take its code for text; it is read as code instead (names may be spurious, none is lost). */
function opensBlind(text: string): boolean {
  const triples = (text.match(/"""|'''/g) ?? []).length;
  const close = text.indexOf("*/"), open = text.indexOf("/*");
  return triples % 2 === 1 || (close >= 0 && (open < 0 || close < open));
}

/** The names a change starts using: in the code (not the comments or strings) of the added lines of its source files,
 * not of their removed ones. Only source files count: a test, a file in a test folder, a document or a data file
 * brings no name. `read(path, side)`: the file's whole text after ("new") or before ("old") the change, null when it
 * cannot be read: the code is then told from the whole file, so a comment or string that opens above a hunk is known.
 * Without it, each hunk is read on its own. */
export function namesAdded(diff: string, isTest: (name: string) => boolean,
  read?: (path: string, side: "new" | "old") => string | null): Set<string> {
  const added = new Set<string>(), gone = new Set<string>();
  for (const section of diff.split(DIFF_SECTION)) {
    const path = /^\+\+\+ b\/(.*)$/m.exec(section)?.[1] ?? /^--- a\/(.*)$/m.exec(section)?.[1] ?? "";
    if (!path || !SOURCE.test(path) || isTest(posix.basename(path)) || inTestFolder(path)) continue;
    const oldPath = /^--- a\/(.*)$/m.exec(section)?.[1] ?? path;
    const whole = new Map<string, { raw: string[]; code: string[] } | null>();
    const lines = (side: "new" | "old") => {
      if (!whole.has(side)) {
        const text = read?.(side === "new" ? path : oldPath, side) ?? null;
        whole.set(side, text === null ? null : { raw: text.split("\n"), code: codeText(text, path).split("\n") });
      }
      return whole.get(side)!;
    };
    for (const hunk of section.split(/^(?=@@ )/m).slice(1)) {
      const head = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(hunk);
      const rows = hunk.split("\n").slice(1).filter((l) => l.startsWith(" ") || l.startsWith("+") || l.startsWith("-"));
      for (const [mark, other, set, side, first] of [["+", "-", added, "new", head?.[2]], ["-", "+", gone, "old", head?.[1]]] as const) {
        const file = head ? lines(side) : null;
        const mine = rows.filter((l) => !l.startsWith(other));
        const at = Number(first) - 1;
        // The whole file's code for a row, if that line is the row's text; else the hunk read alone.
        const same = (l: string, k: number) => file !== null && file.raw[at + k]?.replace(/\r$/, "") === l.slice(1).replace(/\r$/, "");
        let alone: string[] | null = null;
        const hunkAlone = () => alone ??= opensBlind(mine.map((l) => l.slice(1)).join("\n"))
          ? mine.map((l) => l.slice(1)) : codeText(mine.map((l) => l.slice(1)).join("\n"), path).split("\n");
        mine.forEach((l, k) => {
          if (!l.startsWith(mark)) return;
          for (const w of (same(l, k) ? file!.code[at + k] : hunkAlone()[k])?.match(WORDS) ?? []) set.add(w);
        });
      }
    }
  }
  return new Set([...added].filter((n) => !gone.has(n)));
}

/** The first of `names` a test file fakes: on a line that patches, mocks, spies or stubs, a quoted target
 * (`setattr(x, "name", …)`, `patch("a.b.name")`) or an attribute assigned (`x.name = Mock()`). Null when it fakes none. */
export function fakedName(source: string, names: ReadonlySet<string>): string | null {
  for (const line of source.split("\n")) {
    if (!/setattr|patch|mock|spy|stub|fake/i.test(line)) continue;
    // A dotted or path target names its last part: the folders on the way are not what it fakes.
    const targets = [...line.matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!.split(/[./#:]/).at(-1)!);
    targets.push(...[...line.matchAll(/\.([A-Za-z_$][\w$]*)\s*=(?!=)/g)].map((m) => m[1]!));
    const hit = targets.find((t) => names.has(t));
    if (hit) return hit;
  }
  return null;
}

const LANGUAGE = new Set(["async", "await", "class", "const", "elif", "else", "except", "export", "false", "from", "function",
  "import", "null", "raise", "return", "self", "this", "true", "type", "undefined", "void", "while", "with", "yield"]);

/** The names a change brings in: on its added source lines (namesAdded), and in no old version of the files it changes.
 * `old`: a file's text before the change, null when it is new. */
export function newNames(diff: string, isTest: (name: string) => boolean, old: (path: string) => string | null,
  read?: (path: string, side: "new" | "old") => string | null): Set<string> {
  const before = new Set<string>();
  for (const section of diff.split(DIFF_SECTION)) {
    const path = /^\+\+\+ b\/(.*)$/m.exec(section)?.[1];
    const text = path && SOURCE.test(path) ? old(/^--- a\/(.*)$/m.exec(section)?.[1] ?? path) : null;
    if (text) for (const w of codeText(text, path!).match(WORDS) ?? []) before.add(w);
  }
  return new Set([...namesAdded(diff, isTest, read)].filter((n) => n.length >= 4 && !LANGUAGE.has(n) && !before.has(n)));
}

/** The first of `names` the test `func` uses: a name in its code (comments and strings left out), or in a string that
 * looks like a name (contains `_` or a capital after the first letter, six letters or more: a patch target, a key).
 * Only the test's own body is read; null when it cannot be found. */
export function usesNew(source: string, func: string, names: ReadonlySet<string>, path = "test.py"): string | null {
  const body = testBody(source, func);
  if (body === null) return null;
  const inStrings: string[] = [];
  const code = codeText(body, path, (text) => inStrings.push(text));
  const named = (w: string) => w.length >= 6 && (w.includes("_") || /[a-z0-9][A-Z]/.test(w));
  const words = [...(code.match(WORDS) ?? []), ...inStrings.flatMap((t) => (t.match(WORDS) ?? []).filter(named))];
  return words.find((w) => names.has(w)) ?? null;
}

/** A failure that is the same before the change says nothing when the test uses what the change adds: the code before
 * it cannot pass, whatever it does. Such a finding is judged like any other. `path`: the test file (its language). */
export function vacuousBefore(b: Before, source: string, func: string, names: ReadonlySet<string>, path?: string): Before {
  if (b.status !== "pre-existing") return b;
  const name = usesNew(source, func, names, path);
  return !name ? b : { ...b, status: "unknown", detail: "fails with the same message on the code before the change, but " +
    `the test uses \`${name}\`, which the change adds, so that says nothing about the code before it` };
}

/** Console lines of a background failure: a thread or task that died while the test went on to pass. */
const BACKGROUND = /PytestUnhandledThreadExceptionWarning|PytestUnraisableExceptionWarning|Unhandled Rejection|Uncaught Exception/;

/** A pass on the code before the change proves a regression only if the code it ran was whole. It is not when the test
 * uses a name the change adds (`new-name`: what it checks cannot have been there), or when a background thread or task
 * died there on missing code and the test passed anyway (`background-error`: base console lines, `baseOutput`). Such a
 * pass is `unknown`. `path`: the test file (its language). Only a regression is changed. */
export function vacuousPass(b: Before, o: { source: string; func: string; names: ReadonlySet<string>;
  baseOutput: string[]; path?: string }): Before {
  if (b.status !== "regression") return b;
  const name = usesNew(o.source, o.func, o.names, o.path);
  const lead = `passes on the code before the change (${plural(b.runs.length, "run")}), but `;
  if (name) {
    return { ...b, status: "unknown", vacuous: "new-name", detail: `${lead}the test uses \`${name}\`, which the ` +
      "change adds: no proof of a regression" };
  }
  const lines = o.baseOutput.flatMap((out) => splitLines(out));
  const at = lines.findIndex((l) => BACKGROUND.test(l));
  if (at >= 0 && lines.slice(at).some((l) => MISSING.test(l))) {
    return { ...b, status: "unknown", vacuous: "background-error", detail: `${lead}a background error there names ` +
      "code that is missing: no proof of a regression" };
  }
  return b;
}

/** A same failure says nothing when tests that pass with the change fail the same way there: the message is shared
 * (an `assert False`), not specific to this test. Counted: tests of `passedOnChange` that failed with `signatureOf`'s
 * first line in every run of `baseRuns`, and in no run otherwise. Limit: only tests that ran on the code before the
 * change can count, those in the findings' files and the fix proof's (up to its cap); a passing test in another file, past
 * the cap, never ran there and is not seen. */
export function sharedFailure(b: Before, signatureOf: string, baseRuns: BeforeRun[], passedOnChange: ReadonlySet<string>): Before {
  const each = baseRuns.length;
  if (b.status !== "pre-existing" || !passedOnChange.size || !each) return b;
  const sig = signature(signatureOf);
  const seen = new Map<string, number>(); // test id -> runs it failed with that signature in; -1 once it did not
  for (const r of baseRuns) {
    for (const x of r.results ?? []) {
      if (!passedOnChange.has(x.testId)) continue;
      const before = seen.get(x.testId) ?? 0;
      seen.set(x.testId, before >= 0 && x.outcome === "failed" && signature(x.message) === sig ? before + 1 : -1);
    }
  }
  const n = [...seen.values()].filter((k) => k >= each).length;
  return n ? { ...b, status: "unknown", detail: `fails the same way there, but so ${n === 1 ? "does 1 test that passes" :
    `do ${n} tests that pass`} with the change` } : b;
}

/** `sharedFailure` over groups of runs (the findings' files' runs, the fix proof's own): a test counts in its own group,
 * whatever number of runs that group has. */
export function sharedInGroups(b: Before, signatureOf: string, groups: BeforeRun[][], passedOnChange: ReadonlySet<string>)
  : Before {
  return groups.reduce((acc, g) => sharedFailure(acc, signatureOf, g, passedOnChange), b);
}

/** A failure of the test's own check, not a crash in the code it runs. */
const OWN_CHECK = /^(?:Error:\s*)?expect\(|^(?:E\s+)?assert\b|AssertionError/;

/** As `textFix`, for a test that fakes something only the change uses: when the code before the change crashes, it
 * never reached the fake, so the failure comes from what the fake left out, not from a bug the change fixes. Reaching
 * the test's own check is a fix: the change adds what the test expects. */
export function fakedFix(f: Fix, name: string): Fix {
  return f.status !== "fixed" || OWN_CHECK.test(f.message ?? "") ? f : { ...f, status: "unknown", detail: "fails on the code before the change " +
    `(${plural(f.runs.length, "run")}), but it fakes \`${name}\`, which the change starts using: no proof of a fix` };
}

/** The stage's first progress line: which tests run on the code before the change. */
export function beforeStartText(failing: number, passing: number): string {
  const kinds = [failing ? `${failing} failing` : "", passing ? `${passing} passing` : ""].filter(Boolean)
    .join(" and ");
  return `running ${kinds} test${failing + passing === 1 ? "" : "s"} on the code before the change`;
}

// Each status in words, [several, one]; the statuses themselves stay as they are in data and events.
const BEFORE_WORDS: Record<BeforeStatus, [string, string]> = {
  regression: ["pass there, fail with the change", "passes there, fails with the change"],
  "pre-existing": ["fail with the same message there", "fails with the same message there"],
  "new-code": ["cannot run there (what they test is new)", "cannot run there (what it tests is new)"],
  changed: ["fail differently there", "fails differently there"],
  unknown: ["unclear", "unclear"],
};
const FIX_WORDS: Record<FixStatus, [string, string]> = {
  fixed: ["fail there and pass now", "fails there and passes now"],
  "new-code": ["cannot run there (what they test is new), so they show no fix",
    "cannot run there (what it tests is new), so it shows no fix"],
  unchanged: ["pass there too", "passes there too"],
  unknown: ["unclear", "unclear"],
};
/** Why a test is unclear, in a word or two, from its detail (none when no short one fits). */
const SHORT_REASONS: [RegExp, string][] = [[/timed out/, "timed out"], [/gave no report/, "no report"],
  [/^flaky/, "flaky"], [/^mixed outcomes/, "mixed outcomes"], [/^skipped/, "skipped"],
  [/^(did )?not run/, "did not run"], [/^could not run/, "could not run"],
  [/returned nothing there/, "undefined value"], [/dependencies the image/, "new dependencies"],
  [/reads the code as text/, "reads the code as text"]];

function outcomesText<S extends string>(kind: string, order: readonly S[], words: Record<S, [string, string]>,
  tests: { status: S; detail: string }[], reasons: boolean, either = false): string {
  const groups = order.map((st) => [st, tests.filter((x) => x.status === st)] as const).filter(([, xs]) => xs.length);
  const said = (st: S, xs: { detail: string }[]) => {
    const why = [...new Set(xs.map((x) => SHORT_REASONS.find(([re]) => re.test(x.detail))?.[1]))].filter(Boolean);
    const short = st === "unknown" && reasons && why.length ? ` (${why.join(", ")})` : "";
    return words[st][xs.length === 1 ? 1 : 0] + short;
  };
  if (groups.length === 1) {
    const [st, xs] = groups[0]!;
    const who = xs.length === 1 ? `the ${kind} test` : `the ${xs.length} ${kind} tests`;
    if (either && st === "new-code") {
      return `${who} cannot run there either, so ${xs.length === 1 ? "it shows" : "they show"} no fix`;
    }
    return `${who} ${st === "unknown" ? (xs.length === 1 ? "is " : "are ") : ""}${said(st, xs)}`;
  }
  return groups.map(([st, xs], i) => `${xs.length}${i ? "" : ` ${kind} test${xs.length === 1 ? "" : "s"}`} ` +
    said(st, xs)).join("; ");
}

/** What the failing tests did on the code before the change, in words. */
export const beforeText = (tests: Record<string, Before>) =>
  outcomesText("failing", BEFORE_STATUSES, BEFORE_WORDS, Object.values(tests), true);

/** What the passing tests did there; `either`: the failing tests could not run there either. */
export const fixText = (tests: Record<string, Fix>, either: boolean) =>
  outcomesText("passing", FIX_STATUSES, FIX_WORDS, Object.values(tests), false, either);

/** Every finding of a check that did not run, with the reason. */
export function notChecked(ids: string[], reason: string): Record<string, Before> {
  return Object.fromEntries(ids.map((id) => [id, { status: "unknown" as const, detail: `not checked: ${reason}`,
    runs: [] }]));
}

export const SKIP_REASONS = {
  "no-base": "the change has no earlier commit to compare with",
  time: "the review ran out of time",
} as const;

export const isPreExisting = (f: { before?: Before }) => f.before?.status === "pre-existing";

const ANOTHER = "this ran on the image built for another commit, so the dependencies may differ";

/** On a fallback image, a test that passes before the change says nothing about what the change did. */
export function asFallbackBefore(b: Before): Before {
  return b.status !== "regression" ? b : { ...b, status: "unknown",
    detail: `passes on the code before the change (${plural(b.runs.length, "run")}), but ${ANOTHER}: not shown to be the change's doing` };
}

/** As `asFallbackBefore`, for the fix proof. */
export function asFallbackFix(f: Fix): Fix {
  return f.status !== "fixed" ? f : { ...f, status: "unknown",
    detail: `fails on the code before the change (${plural(f.runs.length, "run")}) and passes after, but ${ANOTHER}: not shown to be a fix` };
}
