// The before/after check: a test that failed in every run on the change runs again, as many times, on the code before
// it (the change's base) in the same image, and its outcome there says whether the change caused the failure. The fix
// proof does the same for tests that passed in every run: one that fails there shows the change fixes what it checks.
// No model is called. The stage itself is `beforeStage` in testround.ts; this module only compares outcomes.
import { asError, ownerFile, type TestResult } from "./outcomes";
import { splitLines } from "./util";

/** regression: passes before the change. pre-existing: fails the same way before it. new-code: what it tests does not
 * exist before it. changed: fails before it, differently. unknown: anything that settles nothing (flaky, an error, a
 * timeout, skipped, an undefined value where it is unclear whether code is missing, or not checked). */
export const BEFORE_STATUSES = ["regression", "pre-existing", "new-code", "changed", "unknown"] as const;
export type BeforeStatus = typeof BEFORE_STATUSES[number];

/** What a finding's test did on the code before the change. `runs`: its outcome in each run there ("missing": the run
 * gave no report, "timeout": it timed out, "absent": the report left the test out). `message`: its failure there. */
export interface Before { status: BeforeStatus; detail: string; runs: string[]; message?: string }

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
 * find. Seen at the base only (and not at the change), they make a test `new-code`. */
const MISSING = new RegExp([
  "ModuleNotFoundError", "ImportError", "cannot import name", "has no attribute", "NameError", "is not defined",
  "is not a function", "is not a constructor", "does not provide an export named", "Cannot find module",
  "Failed to (?:load|resolve) (?:url|import)", "cannot find (?:function|value|struct|type|macro|trait|module)",
  "unresolved import", "no (?:function|method|associated item|field) named", "error\\[E0(?:412|425|432|433|599|609)\\]",
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
function outcomeIn(run: BeforeRun, t: TestResult, file: string | null): { outcome: string; message: string } {
  if (run.results === null) return { outcome: run.timedOut ? "timeout" : "missing", message: run.output };
  const results = run.results.map(asError);
  const own = results.find((x) => x.testId === t.testId);
  if (own) return { outcome: own.outcome, message: own.message };
  const load = file ? results.find((x) => x.outcome === "error" && ownerFile(x.fileAttr, [file]) !== null) : undefined;
  return load ? { outcome: "error", message: load.message } : { outcome: "absent", message: "" };
}

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
export function judgeBefore(t: TestResult, file: string | null, runs: BeforeRun[], envChanged = false): Before {
  const seen = runs.map((r) => outcomeIn(r, t, file));
  const outcomes = seen.map((s) => s.outcome);
  const n = runs.length;
  const all = (o: string) => n > 0 && outcomes.every((x) => x === o);
  const failure = seen.find((s) => s.outcome === "failed" || s.outcome === "error")?.message ?? "";
  const withMessage = (b: Before): Before => failure && b.status !== "regression" ? { ...b, message: failure } : b;
  if (!n) return { status: "unknown", detail: "not run on the code before the change", runs: outcomes };
  if (all("passed")) {
    return { status: "regression", detail: `passes on the code before the change (${plural(n, "run")}): the change ` +
      "broke it", runs: outcomes };
  }
  const silent = silentRuns(seen);
  if (silent) return { ...silent, runs: outcomes };
  if (all("error")) {
    return withMessage(MISSING.test(failure)
      ? { status: "new-code", detail: `cannot load on the code before the change: what it tests is new ` +
        `(${quoted(failure)})`, runs: outcomes }
      : { status: "unknown", detail: `could not run on the code before the change (${quoted(failure)})`, runs: outcomes });
  }
  if (all("failed")) {
    const same = seen.every((s) => signature(s.message) === signature(t.message));
    if (same && envChanged) {
      return withMessage({ status: "unknown", detail: "fails the same way on the code before the change, but the " +
        "change also changes the dependencies the image is built from, so that code ran with the change's",
      runs: outcomes });
    }
    if (same) {
      return withMessage({ status: "pre-existing", detail: `fails the same way on the code before the change ` +
        `(${plural(n, "run")}): the change did not cause it`, runs: outcomes });
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

/** A passing test on the code before the change: as `Before`, with a fix status. */
export interface Fix { status: FixStatus; detail: string; runs: string[]; message?: string }

/** One round's fix proof: the result per passing test id, why it did not run, and how long its own runs took. */
export interface FixCheck { tests: Record<string, Fix>; skipped?: string; secs: number; runsMs: number }

/** Compare a passing test with its runs on the code before the change, by judgeBefore's rules for missing code and
 * undefined values. `envChanged`: the change also changes what keys the image, so the base ran with its dependencies. */
export function judgeFix(t: TestResult, file: string | null, runs: BeforeRun[], envChanged = false): Fix {
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
      `passes after: the change fixes this (${quoted(failure)})`, runs: outcomes });
  }
  if (all("skipped")) return { status: "unknown", detail: "skipped on the code before the change", runs: outcomes };
  if (all("absent")) return { status: "unknown", detail: "did not run on the code before the change", runs: outcomes };
  const passed = outcomes.filter((o) => o === "passed").length;
  return withMessage({ status: "unknown", detail: passed
    ? `flaky on the code before the change (passed in ${passed} of ${plural(n, "run")})`
    : `mixed outcomes on the code before the change (${outcomes.join(", ")})`, runs: outcomes });
}

/** The stage's first progress line: which tests run on the code before the change. */
export function beforeStartText(failing: number, passing: number): string {
  const kinds = [failing ? `${failing} failing` : "", passing ? `${passing} passing` : ""].filter(Boolean)
    .join(" and ");
  return `running ${kinds} test${failing + passing === 1 ? "" : "s"} on the code before the change`;
}

// Each status in words, [several, one]; the statuses themselves stay as they are in data and events.
const BEFORE_WORDS: Record<BeforeStatus, [string, string]> = {
  regression: ["pass there: the change broke them", "passes there: the change broke it"],
  "pre-existing": ["fail the same way there: not caused by the change",
    "fails the same way there: not caused by the change"],
  "new-code": ["cannot run there (what they test is new)", "cannot run there (what it tests is new)"],
  changed: ["fail differently there", "fails differently there"],
  unknown: ["unclear", "unclear"],
};
const FIX_WORDS: Record<FixStatus, [string, string]> = {
  fixed: ["fail there and pass now: the change fixes them", "fails there and passes now: the change fixes it"],
  "new-code": ["cannot run there (what they test is new), so they show no fix",
    "cannot run there (what it tests is new), so it shows no fix"],
  unchanged: ["pass there too", "passes there too"],
  unknown: ["unclear", "unclear"],
};
/** Why a test is unclear, in a word or two, from its detail (none when no short one fits). */
const SHORT_REASONS: [RegExp, string][] = [[/timed out/, "timed out"], [/gave no report/, "no report"],
  [/^flaky/, "flaky"], [/^mixed outcomes/, "mixed outcomes"], [/^skipped/, "skipped"],
  [/^(did )?not run/, "did not run"], [/^could not run/, "could not run"],
  [/returned nothing there/, "undefined value"], [/dependencies the image/, "new dependencies"]];

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
