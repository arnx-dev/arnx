// Setup: an agent reads the repository and proposes `.arnx/review.yaml` as a list of projects, proving each one by
// building its environment and running its existing suite. Nobody is asked: the proof runs the suites once more and
// stamps the file.
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { isMap as isYamlMap, isScalar, parseDocument } from "yaml";
import { StopRound, Workspace } from "./agent";
import { type Baseline, BASELINE_FILE, type BaselineTest, baselineDigest, describeBaselineChanges, entryOf, keysOf,
  readBaseline, testKey, writeBaseline } from "./baseline";
import type { Brain } from "./brain";
import { clip, emit, EVENTS_FILE, EventLog, withEvents, withRole } from "./events";
import { getAdapter, LANGUAGES } from "./adapters";
import type { AdapterId, TestResult } from "./adapters/types";
import { type Blanked, describeBlanked, filesAt, hasCommits, snapshot, takeSnapshot, type Withheld, workingTreeFiles }
  from "./change";
import {
  loadReviewFile, parseReviewFile, projectDigest, readSecretPins, type ReviewConfig, reviewConfigPath, type ReviewFile,
  secretPinsOf, secretPinsYaml, stamp, stampedBaseline, stampFile,
} from "./config";
import { type Detection, describeDetection, detect, isTestPath, TYPECHECK_EXAMPLE, typeCheckable } from "./detect";
import { classify, describeHints, diagnose, firstErrors, firstLine, type Hint, missingLeftOut, npxDownload, npxText,
  loadFailure, passingApart, unexplainedFiles } from "./diagnose";
import type { FailureModel } from "./jev";
import { ArnxError } from "./errors";
import { loadIgnore, matcher } from "./ignore";
import { projectIndex } from "./indexer";
import { isSecretPath, type SecretPin } from "./secrets";
import { type AgentModel, allPrices, type Tool } from "./llm";
import { ownerFile, runTests } from "./outcomes";
import { precheck as lookFirst } from "./precheck";
import { LocalBrain } from "./localbrain";
import { promptsFor } from "./userprompts";
import type { Say } from "./progress";
import { copyManifests, dockerSteps, envKey, type Runner, type SessionFactory } from "./sandbox";
import type { ScipIndex } from "./scip";
import { loadSettings, refString, type Settings, settingsPath } from "./settings";
import { runTypecheck, TYPECHECK_TIMEOUT } from "./typecheck";
import { SOURCE } from "./untested";
import { otherLanguageOf } from "./languages";
import { fileReferences, mapHints, type UsesHint, usesHints } from "./usescheck";
import { agentUse, logUsage } from "./usage";
import { randomHex } from "./util";
import { VERSION } from "./version";
import { acceptedPins, type AcceptedPins } from "./check";
import { collect, DOME, dockerSession, isKeptPath, ownTestsInWriteDir, ownTestsProblem, probeRun, writeDirOf }
  from "./testround";

export const SUITE_TIMEOUT = 1800;
export const OUTPUT_TAIL = 6000;

/** What a suite's failures were: tests kept by `arnx accept` that fail as pinned, failures that block, failures the
 * baseline holds, the baseline's tests that no longer fail (`left`, ids), tests that failed and then passed when run
 * again (`flaky`, ids), and every failure (accepted ones aside), for setup to record. */
export interface SuiteCounts { acceptedFailing: number; unexpected: string[]; baselineFailing: number; left: string[];
  flaky: string[]; failed: TestResult[]; passed: number;
  /** Every test the run reported. */
  all: TestResult[];
  /** What the failures point to (diagnose, the run apart, JEV), when the suite's failures were looked at. */
  hints?: Hint[] }

const noCounts = (): SuiteCounts => ({ acceptedFailing: 0, unexpected: [], baselineFailing: 0, left: [], flaky: [],
  failed: [], passed: 0, all: [] });

/** The accepted files of this project (`accepted`, acceptedPins) that match their pin, and those changed since. */
function acceptedOf(cfg: ReviewConfig, accepted: AcceptedPins, dir?: string): AcceptedPins {
  const under = (p: string) => isKeptPath(cfg, p, dir);
  return { pinned: accepted.pinned.filter(under), changed: accepted.changed.filter((c) => under(c.path)) };
}

const failedTest = (t: TestResult) => t.outcome === "failed" || t.outcome === "error";

/** `accepted`: the repository's accepted tests (acceptedPins); a pinned one may fail, a changed one blocks.
 * `acceptedTestsDir`: settings' folder for them. `baseline`: the project's tests that fail today, which may fail;
 * "record" while setup records them: every failure may fail, and the summary says they are recorded. */
export function suiteOk(results: TestResult[] | null, cfg: ReviewConfig, accepted?: AcceptedPins,
                        acceptedTestsDir?: string, baseline: BaselineTest[] | "record" = []): [boolean, string, SuiteCounts] {
  const none = noCounts();
  if (results === null) return [false, "the suite produced no report (timed out, or the runner could not start)", none];
  if (!results.length) return [false, "the suite ran no tests", none];
  const mine = accepted ? acceptedOf(cfg, accepted, acceptedTestsDir) : { pinned: [], changed: [] };
  const record = baseline === "record";
  const known = record ? new Set<string>() : keysOf(baseline);
  const counts = new Map<string, number>();
  const unexpected: string[] = [];
  const failed: TestResult[] = [];
  const failing = new Set<string>();
  let acceptedFailing = 0;
  let baselineFailing = 0;
  for (const t of results) {
    counts.set(t.outcome, (counts.get(t.outcome) ?? 0) + 1);
    if (!failedTest(t) || cfg.knownFailing.some((k) => t.fileAttr.startsWith(k))) continue;
    if (ownerFile(t.fileAttr, mine.pinned) !== null) {
      // Not the suite's failure: counted apart, so a ✓ line never reads "4 failed".
      acceptedFailing++;
      counts.set(t.outcome, counts.get(t.outcome)! - 1);
      continue;
    }
    failed.push(t);
    failing.add(testKey(t.testId));
    if (record || known.has(testKey(t.testId))) baselineFailing++;
    else unexpected.push(t.testId);
  }
  // A baseline test leaves once it no longer fails, a flaky one too: should it fail again, the rerun tells.
  const left = record ? [] : baseline.filter((b) => !failing.has(testKey(b.id))).map((b) => b.id);
  const summary = [...counts.keys()].sort().filter((o) => counts.get(o)).map((o) => `${counts.get(o)} ${o}`).join(", ") +
    (acceptedFailing ? ` (${acceptedFailing} accepted test${acceptedFailing === 1 ? "" : "s"} still fail` +
      `${acceptedFailing === 1 ? "s" : ""})` : "") +
    (baselineFailing && !record ? ` (${baselineFailing} in the baseline)` : "");
  const c: SuiteCounts = { acceptedFailing, unexpected, baselineFailing, left, flaky: [], failed,
    passed: counts.get("passed") ?? 0, all: results };
  if (mine.changed.length) {
    return [false, `${summary}; accepted test changed since \`arnx accept\`: ${mine.changed.map((x) =>
      `${x.change} ${x.path}`).join(", ")} (see \`arnx check\`)`, c];
  }
  if (unexpected.length) {
    return [false, `${summary}; failing outside the baseline: ${unexpected.slice(0, 10).join(", ")}`, c];
  }
  if (!counts.get("passed")) return [false, `${summary}; no test passed, so the suite does not run yet`, c];
  return [true, summary, c];
}

/** The line approve and setup print when accepted tests still fail. */
export function stillRed(n: number): string {
  return `${n} accepted test${n === 1 ? " still fails" : "s still fail"} (bugs not fixed yet): arnx check`;
}

/** The results without the failures of pinned accepted tests (acceptedPins): what diagnosis and retries look at. */
function withoutAccepted(results: TestResult[] | null, cfg: ReviewConfig, accepted?: AcceptedPins,
                         acceptedTestsDir?: string): TestResult[] | null {
  if (!results || !accepted) return results;
  const { pinned } = acceptedOf(cfg, accepted, acceptedTestsDir);
  return results.filter((t) => !failedTest(t) || ownerFile(t.fileAttr, pinned) === null);
}

/** Why tests were skipped, grouped: `"TEST_DATABASE_URL not set" (8)`. A skip that asks for a service or a
 * variable means the environment lacks it, which a passing suite hides. Skips the report gives no reason for (a
 * conditional skip) name their files, so they are not taken for known_failing files. */
export function skipReasons(results: TestResult[] | null, max = 5): string[] {
  const counts = new Map<string, number>();
  const silent = new Set<string>();
  for (const t of results ?? []) {
    if (t.outcome !== "skipped") continue;
    const first = t.message.split("\n").map((l) => l.trim()).find(Boolean) ?? "";
    const reason = first.replace(/^\S+:\d+: /, "").replace(/^Skipped: /, "").slice(0, 160);
    if (!reason && t.fileAttr) silent.add(t.fileAttr);
    counts.set(reason, (counts.get(reason) ?? 0) + 1);
  }
  const files = [...silent].sort();
  const where = files.length ? `, in ${files.slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""}` : "";
  const sorted = [...counts].sort((a, b) => b[1] - a[1]);
  const shown = sorted.slice(0, max).map(([r, n]) => r ? `"${r}" (${n})` : `no reason given (${n}${where})`);
  if (sorted.length > max) shown.push(`${sorted.length - max} more reasons`);
  return shown;
}

/** Test files with a failure outside known_failing: what a retry with the same environment needs to run again. */
export function failingFiles(results: TestResult[] | null, cfg: ReviewConfig): string[] {
  return [...new Set((results ?? []).filter((t) => (t.outcome === "failed" || t.outcome === "error") && t.fileAttr &&
    !cfg.knownFailing.some((k) => t.fileAttr.startsWith(k))).map((t) => t.fileAttr))].sort();
}

/** The project's own files in its tests_dir in the snapshot `snap`, which a review would clear (ownTestsInWriteDir). */
function ownTestsIn(cfg: ReviewConfig, snap: string, acceptedTestsDir?: string): string[] {
  const dir = writeDirOf(cfg);
  return existsSync(join(snap, dir))
    ? ownTestsInWriteDir(cfg, collect(snap, dir, getAdapter(cfg.language).writable), acceptedTestsDir) : [];
}

/** Folders that hold other people's code, never the project's own tests (build output is rarely committed, and a
 * test there is still a test). */
const NOT_OWN = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".arnx-run"]);
/** Runner configuration that names its own test files (pytest python_files, jest testMatch/testRegex, a vitest
 * test.include): file names alone cannot tell such a project has no tests. */
const CUSTOM_TESTS = /\bpython_files\b|\btestMatch\b|\btestRegex\b|\btest\s*:\s*\{[^}]*\binclude\b/s;
const RUNNER_CONFIG = /^(?:pytest\.ini|pyproject\.toml|setup\.cfg|tox\.ini|package\.json|(?:jest|vitest|vite)\.config\.[cm]?[jt]s)$/;

/** Whether a Python or JavaScript/TypeScript project has test files of its own in the snapshot (the folder arnx writes
 * its tests to left out), or may have: runner configuration naming its own test files counts too. Rust is never
 * asked: its tests sit inside source files. */
export function hasOwnTests(cfg: ReviewConfig, snap: string): boolean {
  const root = join(snap, cfg.workdir);
  if (existsSync(root) && readdirSync(root).some((n) => RUNNER_CONFIG.test(n) &&
    CUSTOM_TESTS.test(readFileSync(join(root, n), "utf8")))) return true;
  const generated = writeDirOf(cfg);
  const visit = (rel: string): boolean => {
    const abs = join(snap, rel);
    for (const name of readdirSync(abs)) {
      const r = rel === "." ? name : `${rel}/${name}`;
      // lstat: a link a run made (node_modules from the image) is not the project's.
      const st = lstatSync(join(abs, name));
      if (r === generated) continue;
      if (st.isDirectory() ? !NOT_OWN.has(name) && visit(r) : st.isFile() && isTestPath(r)) return true;
    }
    return false;
  };
  return existsSync(join(snap, cfg.workdir)) && visit(cfg.workdir);
}

/** The summary of a project with no tests of its own whose environment arnx's one-line test proved. */
export const NO_OWN_TESTS = "no tests of its own; arnx's one-line test runs";

/** Most failing files run apart from the rest of the suite to look for order dependence (one extra run). */
const APART_MAX = 20;

/** [runs, summary, end of the output, why tests were skipped, files with failures, hints about the failures, what
 * failed (SuiteCounts)]. `targets`: only these files (a retry); empty runs the whole suite. `accepted`: the
 * repository's accepted tests (acceptedPins), whose pinned failures do not count. `baseline`: the project's tests that
 * fail today (suiteOk; "record" while setup records them: failures then never stop the suite, and the hints about them
 * come back all the same). `rerun`: tests failing outside the baseline run once more, and those that pass then count
 * as flaky, not as failures. `passedBefore`: the whole suite ran moments ago with every test outside the baseline
 * passing (setup's own run), so a test failing again on the rerun is flaky too, unless most of the suite fails.
 * `outputLog`: where the whole output goes. `precheck`: before the whole suite, the runner lists the tests and a few
 * small files run (precheck.ts); what they show wrong comes back without the whole suite running. */
export async function runSuite(cfg: ReviewConfig, snap: string, buildLog: string,
                               { sessionFactory = dockerSession, targets = [], failureModel, key, acceptedTestsDir,
                                 accepted, outputLog, leftOut, baseline = [], rerun = false, passedBefore = false,
                                 precheck = false }: {
                                 sessionFactory?: SessionFactory; targets?: string[]; failureModel?: FailureModel;
                                 key?: string; acceptedTestsDir?: string; accepted?: AcceptedPins;
                                 outputLog?: string; leftOut?: LeftOut; baseline?: BaselineTest[] | "record";
                                 rerun?: boolean; passedBefore?: boolean; precheck?: boolean } = {})
  : Promise<[boolean, string, string, string[], string[], string, SuiteCounts]> {
  const none = noCounts();
  // A review clears and collects every writable file in tests_dir: the project's own tests may not live there.
  const own = ownTestsIn(cfg, snap, acceptedTestsDir);
  if (own.length) return [false, ownTestsProblem(cfg, own), "", [], [], "", none];
  if (outputLog) rmSync(outputLog, { force: true });
  /** The end of `output`, the whole of it kept in outputLog. */
  const tailOf = (output: string): string => {
    if (outputLog) {
      mkdirSync(dirname(outputLog), { recursive: true });
      writeFileSync(outputLog, output);
    }
    return output.slice(-OUTPUT_TAIL);
  };
  return sessionFactory(cfg, snap, buildLog, async (session) => {
    type Out = [boolean, string, string, string[], string[], string, SuiteCounts];
    // A project with no tests of its own has nothing to list: its run below is quick.
    if (precheck && !targets.length && (cfg.language === "rust" || hasOwnTests(cfg, snap))) {
      const early = lookFirst(session, snap, cfg, acceptedTestsDir);
      if (early) return [false, early.summary, tailOf(early.output), [], [], early.hints, none] as Out;
    }
    // A whole-suite run carries a canary: one-line tests where arnx keeps accepted tests (.arnx/tests/), which the
    // project's own run must never collect.
    const canary = targets.length ? [] : getAdapter(cfg.language).probes(cfg.runner)
      .map((p) => ({ path: join(snap, DOME, writeDirOf(cfg), p.file), source: p.source }));
    for (const c of canary) {
      mkdirSync(dirname(c.path), { recursive: true });
      writeFileSync(c.path, c.source);
    }
    let result, all;
    try {
      [result, all] = runTests(session, snap, cfg, targets, "suite.xml", SUITE_TIMEOUT);
    } finally {
      for (const c of canary) rmSync(c.path, { force: true });
    }
    if ((all ?? []).some((t) => [t.fileAttr, t.testId].some((x) => x && /(?:^|\/)\.arnx\//.test(x)))) {
      return [false, "the project's test run collects files under .arnx/ (a test arnx placed in .arnx/tests/ ran). " +
        "arnx keeps its accepted tests there so your own run never runs them: make the runner leave .arnx/ out " +
        "(pytest: norecursedirs or testpaths; vitest, jest: exclude), then run setup again", tailOf(result.output), [],
        [], "", none] as Out;
    }
    // A project with no tests of its own has no suite to run: arnx's one-line test, which reviews depend on anyway,
    // proves the environment instead (dexdash's setup took 16 tries and wrote a placeholder test into test_command).
    if (!targets.length && !all?.length && cfg.language !== "rust" && !hasOwnTests(cfg, snap)) {
      return noOwnTests(session, snap, cfg, all === null, tailOf);
    }
    let [ok, verdict, counts] = suiteOk(all, cfg, accepted, acceptedTestsDir, baseline);
    // Tests failing outside the baseline run once more, by file: one that passes then is flaky, not a new failure.
    // Right after setup (`passedBefore`) the suite passed them moments ago, so one failing again is flaky too; not
    // when most of the suite fails, which is the environment.
    const again = rerun && !ok && baseline !== "record" && counts.unexpected.length
      ? [...new Set((all ?? []).filter((t) => counts.unexpected.includes(t.testId)).map((t) => t.fileAttr))] : [];
    if (again.length && !again.includes("") && again.length <= APART_MAX) {
      const passed = new Set<string>();
      const [, second] = runTests(session, snap, cfg, again, "again.xml", SUITE_TIMEOUT);
      for (const t of second ?? []) if (t.outcome === "passed") passed.add(testKey(t.testId));
      const most = counts.unexpected.length > counts.passed;
      const flaky = counts.unexpected.filter((id) => passed.has(testKey(id)) || (passedBefore && !most));
      if (flaky.length) {
        const extra = (all ?? []).filter((t) => flaky.includes(t.testId)).map((t) => ({ ...entryOf(t), flaky: true as const }));
        [ok, verdict, counts] = suiteOk(all, cfg, accepted, acceptedTestsDir, [...baseline as BaselineTest[], ...extra]);
        counts.flaky = flaky;
        counts.left = counts.left.filter((id) => !flaky.includes(id));
      }
    }
    const fetched = all === null ? npxDownload(result.output) : null;
    const summary = fetched ? `the suite produced no report: ${npxText(fetched)}` : verdict;
    // Accepted tests that fail as pinned are not the environment's to fix: diagnosis and retries leave them out.
    const results = withoutAccepted(all, cfg, accepted, acceptedTestsDir);
    let said = "";
    const skips = skipReasons(results);
    const failing = failingFiles(results, cfg);
    // While setup records the baseline, a suite that runs gets the same look at its failures as one that does not:
    // those that look like the environment go back to the agent before they are recorded.
    if (!ok || (baseline === "record" && counts.failed.length)) {
      // A failure that names a file the snapshot left out: nothing in review.yaml brings it back, only the user can.
      const needed = leftOut?.paths.length ? missingLeftOut([result.output,
        ...(results ?? []).filter(failedTest).map((t) => t.message)], leftOut.paths, leftOut.all) : [];
      if (needed.length) {
        tailOf(result.output);
        throw new LeftOutNeeded(needed);
      }
      const hints = diagnose(results, cfg, snap);
      // Failing files with no other explanation run once more, together and without the rest of the suite: those
      // that pass then depend on a file left out. Only after a whole-suite run, when other files did run.
      const apart = targets.length ? [] : unexplainedFiles(results, cfg, hints);
      const others = (results ?? []).some((t) => t.fileAttr && !apart.includes(t.fileAttr));
      if (apart.length && apart.length <= APART_MAX && others) {
        const [, again] = runTests(session, snap, cfg, apart, "apart.xml", SUITE_TIMEOUT);
        const alone = passingApart(apart, again);
        if (alone.length) hints.push({ kind: "order-dependent", detail: "", files: alone, evidence: "" });
      }
      // Experimental: what no signature and no run apart explains is asked of JEV, one failure per file. Asked only
      // now, since a test that fails for want of another file's state reads like a genuine failure.
      if (failureModel) hints.push(...await askModel(failureModel, results, cfg, snap, hints));
      counts.hints = hints;
      said = [describeHints(hints, cfg), firstErrors(results, cfg)].filter(Boolean).join("\n");
      if (!ok) return [ok, summary, tailOf(result.output), skips, failing, said, counts] as Out;
    }
    if (targets.length) return [ok, summary, tailOf(result.output), skips, failing, said, counts] as Out;
    const [probed, tail, ignored] = probe(session, snap, cfg);
    if (ignored) return [false, `${summary}; but ${ignored}`, tailOf(tail), skips, failing, "", counts] as Out;
    if (probed && cfg.typecheck) {
      // The type check runs once the suite runs: type errors are information, a command that cannot run is not.
      const t = runTypecheck(session, cfg);
      if (t.status === "failed" || t.status === "timed-out") {
        return [false, `${summary}; but the type check (typecheck) ${t.status === "failed" ? "failed without " +
          "reporting a type error: it could not start, or its output is not tsc's" : `timed out after ` +
          `${TYPECHECK_TIMEOUT} s`}`, tailOf(t.output), skips, failing, "", counts] as Out;
      }
      const errors = t.errors.length;
      return [true, `${summary}; type check: ${errors ? `${errors} type error${errors === 1 ? "" : "s"}`
        : "no type errors"}`, tailOf(result.output), skips, failing, said, counts] as Out;
    }
    return probed ? [true, summary, tailOf(result.output), skips, failing, said, counts] as Out
      : [false, `${summary}; but a one-line test placed in ${writeDirOf(cfg)}/ was not run: the runner leaves ` +
        "that folder out (jest roots, vitest include, testMatch) or does not collect tests named the usual way (an " +
        "option in test_command). Either set tests_dir to a new folder the runner includes, or fix test_command",
        tailOf(tail), skips, failing, "", counts] as Out;
  }, undefined, key);
}

/** runSuite's answer for a project with no tests of its own: its environment proven by arnx's one-line test (and the
 * type check), or why that test did not run. `silent`: the whole-suite run wrote no report. */
function noOwnTests(session: Runner, snap: string, cfg: ReviewConfig, silent: boolean, tailOf: (s: string) => string)
  : [boolean, string, string, string[], string[], string, SuiteCounts] {
  const none = noCounts();
  const [probed, tail, ignored] = probe(session, snap, cfg);
  if (!probed) {
    return [false, `the project has no tests of its own${silent ? " (the suite wrote no report)" : ""}, and arnx's ` +
      `one-line test placed in ${writeDirOf(cfg)}/ did not run either: install the runner in install (the project may ` +
      "not list it; installing it outside the repository, for example under /opt/deps, keeps the manifests as they " +
      "are) and give a test_command that runs it on {targets}. Do not write tests in test_command: arnx writes them",
      tailOf(tail), [], [], "", none];
  }
  if (ignored) return [false, `${NO_OWN_TESTS}; but ${ignored}`, tailOf(tail), [], [], "", none];
  if (cfg.typecheck) {
    const t = runTypecheck(session, cfg);
    if (t.status === "failed" || t.status === "timed-out") {
      return [false, `${NO_OWN_TESTS}; but the type check (typecheck) ${t.status === "failed" ? "failed without " +
        "reporting a type error: it could not start, or its output is not tsc's" : `timed out after ` +
        `${TYPECHECK_TIMEOUT} s`}`, tailOf(t.output), [], [], "", none];
    }
    const errors = t.errors.length;
    return [true, `${NO_OWN_TESTS}; type check: ${errors ? plural(errors, "type error") : "no type errors"}`,
      tailOf(tail), [], [], "", none];
  }
  return [true, NO_OWN_TESTS, tailOf(tail), [], [], "", none];
}

/** Most failing files asked of the experimental failure model per run. */
const MODEL_MAX = 10;

async function askModel(model: FailureModel, results: TestResult[] | null, cfg: ReviewConfig, snap: string,
                        hints: Hint[]): Promise<Hint[]> {
  const explained = new Set(hints.flatMap((h) => h.files));
  const files = unexplainedFiles(results, cfg, hints).filter((f) => !explained.has(f)).slice(0, MODEL_MAX);
  // A link may dangle on the host (test_command links node_modules from the image): listed by name only.
  const top = readdirSync(snap).filter((n) => !n.startsWith(".")).sort()
    .map((n) => statSync(join(snap, n), { throwIfNoEntry: false })?.isDirectory() ? `${n}/` : n);
  const asked = await Promise.all(files.map(async (file) => {
    const t = (results ?? []).find((r) => r.fileAttr === file && (r.outcome === "failed" || r.outcome === "error"))!;
    return { file, t, answer: await model(t.message, cfg, top) };
  }));
  const out = new Map<string, Hint>();
  for (const { file, t, answer } of asked) {
    if (!answer) continue;
    const key = answer.kind;
    const h = out.get(key) ?? { kind: answer.kind, detail: "", files: [], evidence: firstLine(t.message),
      source: `judged by JEV (experimental), confidence ${answer.confidence.toFixed(2)}` };
    h.files.push(file);
    out.set(key, h);
  }
  return [...out.values()];
}

/** Generated tests go to tests_dir: prove the runner picks up a file placed there. Any probe reported passing is
 * enough; the probes are removed afterwards. The probes are the run's only targets, so it also tells whether
 * test_command runs only {targets} (see ignoredTargets). [picked up, end of the output, why it runs more] */
function probe(session: Runner, snap: string, cfg: ReviewConfig): [boolean, string, string] {
  const p = probeRun(session, snap, cfg, writeDirOf(cfg), "probe.xml", SUITE_TIMEOUT);
  return [p.seen, p.result.output.slice(-OUTPUT_TAIL), p.seen ? ignoredTargets(p.results, p.files, cfg) : ""];
}

/** Tests a run reported from files other than its `targets` (paths relative to the repository). Tests reported
 * without a file cannot be placed and never count. */
export function outsideTargets(results: TestResult[] | null, targets: string[]): TestResult[] {
  return (results ?? []).filter((t) => t.fileAttr && ownerFile(t.fileAttr, targets) === null);
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Why a run whose only targets were `targets` shows that test_command does not run only {targets} ("" when it
 * does): `pytest {targets} integ_tests` runs the whole integration suite along with every review's generated tests,
 * so each run takes minutes instead of seconds and a review can hit its time limit. */
export function ignoredTargets(results: TestResult[] | null, targets: string[], cfg: ReviewConfig): string {
  const others = outsideTargets(results, targets);
  if (!others.length) return "";
  const files = [...new Set(others.map((t) => t.fileAttr))].sort();
  return `test_command does not run only {targets}: run with only arnx's one-line test in ${writeDirOf(cfg)}/ as ` +
    `its target, it also ran ${plural(others.length, "test")} from ${plural(files.length, "other file")} ` +
    `(${list(files, 5)}). Every review runs its generated tests with this command, so each run would run those ` +
    "files too: minutes instead of seconds, and a review can hit its time limit. Remove what adds tests besides " +
    "{targets} from test_command (a test directory or file after {targets}, an option that collects more), so it " +
    "runs only the files it is given";
}

/** One project's proof: its suite counts, why tests were skipped, and the tests it fails today (recorded as its
 * baseline; absent for a project proved earlier). */
export interface ProjectProof { name: string; summary: string; skips: string[]; failed?: BaselineTest[];
  /** Tests its test_command leaves out, kept by the agent (coverageGap). */
  gap?: string }

export interface SetupResult {
  ok: boolean;
  yamlText: string | null;
  summary: string;
  costUsd: number;
  stop: string;
  notes: string;
  /** The proof of each project in the accepted file, in file order ("approved earlier" for kept ones). */
  projects: ProjectProof[];
  /** Files left out of the snapshot because they hold key-shaped text the user has not allowed. */
  withheld: Withheld[];
  /** Source files kept with comment lines blanked: their only such text was in comments. */
  blanked: Blanked[];
  /** The failing tests (outside known_failing) of the last suite that ran with some tests passing: setup got the
   * suite running, the current code fails them. Empty when the last run never got that far. */
  failing: string[];
  /** The project `failing` belongs to (null with none). */
  failingProject: string | null;
  /** Why the last attempt did not go through, in a few words (a refused proposal, a suite that does not run). */
  problem: string;
  /** Files the snapshot left out that the tests need: setup stopped at the run that named them (stop "stopped"). */
  needed?: NeededFile[];
}

/** A file left out of the snapshot that a run's failure names: `secret`, left out as secret-looking; otherwise
 * matched by .arnxignore. */
export interface NeededFile { path: string; secret: boolean }

/** The files the snapshot left out, and the repository's files (to tell a shared name apart), for runSuite. */
export interface LeftOut { paths: string[]; all: string[] }

/** A run's failure names files the snapshot left out (repository paths). */
class LeftOutNeeded extends ArnxError {
  constructor(readonly files: string[]) {
    super(`the tests need ${files.join(", ")}, which the snapshot left out`);
  }
}

/** Why setup stopped, for a person and the agent: which files the tests need, and what left each one out. */
export function neededText(files: NeededFile[]): string {
  const secret = files.filter((f) => f.secret).map((f) => f.path);
  const ignored = files.filter((f) => !f.secret).map((f) => f.path);
  return "the tests need " + [secret.length ? `${secret.join(", ")}, which arnx left out as secret-looking (not sent, ` +
    "not in the sandbox)" : "", ignored.length ? `${ignored.join(", ")}, which .arnxignore leaves out` : ""]
    .filter(Boolean).join(", and ");
}

/** Withheld files for a person or an agent: path, what looks like a key, and its line. */
export const describeWithheld = (w: Withheld[]) => w.map((x) => `${x.path} (${x.label}, line ${x.line})`).join(", ");


/** Up to `max` names, then "…". */
const few = (xs: string[], max = 3) => xs.slice(0, max).join(", ") + (xs.length > max ? ", …" : "");

/** What a person is told when propose refuses, in a few words (the agent gets the whole reason). */
export function rejectedReason(p: { changed: string[]; overlaps: string[]; unexplained: string[]; ownTests: string[];
  failed: string[] }): string {
  const out: string[] = [];
  if (p.unexplained.length) {
    out.push(`${plural(p.unexplained.length, "file")} unaccounted for (${few(p.unexplained)})`);
  }
  if (p.overlaps.length) out.push(`${plural(p.overlaps.length, "file")} owned by two projects (${few(p.overlaps)})`);
  if (p.changed.length) out.push(`approved projects changed (${few(p.changed)})`);
  if (p.ownTests.length) out.push(`own tests in tests_dir (${few(p.ownTests)})`);
  if (p.failed.length) out.push(`${plural(p.failed.length, "project")} do${p.failed.length === 1 ? "es" : ""} not run ` +
    `(${few(p.failed)})`);
  return out.join("; ");
}

const yamlSchema = (extra: Record<string, unknown> = {}, required: string[] = ["yaml"]) =>
  ({ type: "object", properties: { yaml: { type: "string" }, ...extra }, required, additionalProperties: false });

export const TRY_PROJECT: Tool = {
  name: "try_project",
  description: "Validate a review.yaml proposal, build one project's environment and run that project's existing test " +
    "suite. Pass the whole file as yaml and the project's name (optional when the file has one project); or, after " +
    "a whole file, the project's name and project_yaml: only that project's settings (what goes under " +
    "projects.<name>), which replace them in the last whole file. Returns whether the suite runs, the counts and the " +
    "end of the output.",
  input_schema: yamlSchema({ project: { type: "string" }, project_yaml: { type: "string" } }, []),
};

export const PROPOSE: Tool = {
  name: "propose",
  description: "Submit the whole review.yaml. Accepted when no file is owned by two projects, every source file is " +
    "owned, used or listed under uncovered, and every project runs: propose itself runs each project whose part of " +
    "the file changed since try_project proved it (a project's part: its own entry and the services it uses).",
  input_schema: yamlSchema(),
};

export interface Coverage {
  /** `untracked`: how many of the counted files are not committed (absent when none). */
  projects: { name: string; owned: number; used: number; untracked?: { owned: number; used: number } }[];
  uncovered: { path: string; reason: string; files: number; untracked?: number }[];
  /** Source files that no project owns or uses and no uncovered entry names. */
  unexplained: string[];
  /** Files owned by more than one project: "path (a, b)". */
  overlaps: string[];
}


/** Which project owns or uses each file a snapshot holds (tracked, and with `untracked` untracked ones git does not
 * ignore; minus .arnxignore and secret files), and what is left out. Only source files must be explained;
 * documentation, configuration and data may stay unmentioned. Untracked files are counted (only when setup and reviews
 * read them) but never refuse a proposal: a scratch file neither appears in unexplained nor in overlaps, so what is
 * accepted depends on committed files alone. With no commits yet every file is the repository's (and the change a
 * review looks at), so none counts as untracked. */
export function coverageMap(repo: string, file: ReviewFile, untracked = false): Coverage {
  const ignored = loadIgnore(repo);
  const tree = workingTreeFiles(repo, untracked);
  if (!hasCommits(repo)) tree.untracked.clear();
  const files = tree.files.filter((p) => !ignored(p) && !isSecretPath(p));
  const projects = file.projects.map((p) => ({ name: p.name, owns: matcher(p.owns.join("\n")),
    uses: matcher(p.uses.join("\n")), owned: 0, used: 0, untracked: { owned: 0, used: 0 } }));
  const uncovered = file.uncovered.map((u) => ({ ...u, test: matcher(u.path), files: 0, untracked: 0 }));
  const unexplained: string[] = [];
  const overlaps: string[] = [];
  // Files in languages arnx does not review need no explaining: they count as uncovered on their own, per language.
  const others = new Map<string, { files: number; untracked: number }>();
  for (const f of files) {
    const fresh = tree.untracked.has(f);
    const owners = projects.filter((p) => p.owns(f));
    const users = projects.filter((p) => !p.owns(f) && p.uses(f));
    owners.forEach((p) => { p.owned += 1; p.untracked.owned += fresh ? 1 : 0; });
    users.forEach((p) => { p.used += 1; p.untracked.used += fresh ? 1 : 0; });
    if (owners.length > 1 && !fresh) overlaps.push(`${f} (${owners.map((p) => p.name).sort().join(", ")})`);
    let listed = false;
    for (const u of uncovered) {
      if (u.test(f)) {
        u.files += 1;
        u.untracked += fresh ? 1 : 0;
        listed = true;
      }
    }
    const other = !owners.length && !users.length && !listed ? otherLanguageOf(f) : null;
    if (other) {
      const o = others.get(other) ?? { files: 0, untracked: 0 };
      o.files += 1;
      o.untracked += fresh ? 1 : 0;
      others.set(other, o);
    } else if (!owners.length && !users.length && !listed && !fresh && SOURCE.test(f)) unexplained.push(f);
  }
  const auto = [...others].sort((a, b) => b[1].files - a[1].files).map(([name, o]) => ({ path: `${name} files`,
    reason: `${name}: arnx does not review it yet`, files: o.files, test: () => false, untracked: o.untracked }));
  uncovered.push(...auto);
  return { projects: projects.map(({ name, owned, used, untracked }) =>
    ({ name, owned, used, ...(untracked.owned || untracked.used ? { untracked } : {}) })),
  uncovered: uncovered.map(({ path, reason, files: n, untracked }) =>
    ({ path, reason, files: n, ...(untracked ? { untracked } : {}) })), unexplained, overlaps };
}

/** What a project's suite needs to run, apart from which files are set aside: a retry that changes none of it can
 * rerun just the files that failed. */
export function envDigest(cfg: ReviewConfig): string {
  return JSON.stringify([cfg.image, cfg.workdir, cfg.install, cfg.testCommand, cfg.services, cfg.env, cfg.testsDir,
    cfg.installRoot, cfg.runner, cfg.typecheck ?? null]);
}

/** known_failing entries that no note explains (by path or file name): each hides a whole test file. */
export function unexplainedFailing(cfg: ReviewConfig): string[] {
  const notes = cfg.notes.join("\n");
  return cfg.knownFailing.filter((k) => !notes.includes(k) && !notes.includes(posix.basename(k.replace(/\/+$/, ""))));
}

/** A failure's cause when it looks like the environment, not the code: its own signature (diagnose), or else a hint
 * its file is named in (`hints`: the run apart, JEV); null when nothing points away from the code. */
export function causeOf(t: TestResult, cfg: ReviewConfig, snap: string, hints: Hint[] = []): string | null {
  const h = classify(t.message, cfg, snap) ?? hints.find((x) => x.kind !== "genuine-failure" && x.files.includes(t.fileAttr));
  // A file that does not load is named by its error, which the entry keeps as its first line.
  return h ? `${h.kind}${h.detail && h.kind !== "does-not-load" ? `: ${h.detail}` : ""}` : null;
}

/** Why a suite's failures go back to the setup agent before they are recorded: some look like the environment, or
 * most of the suite fails. `key` tells one such set from another; null when the failures can be recorded as they are. */
export function environmentFaults(counts: SuiteCounts, cfg: ReviewConfig)
  : { key: string; text: string; count: number } | null {
  const hints = (counts.hints ?? []).filter((h) => h.kind !== "genuine-failure");
  const most = counts.failed.length > counts.passed;
  if (!hints.length && !most) return null;
  const files = new Set(hints.flatMap((h) => h.files));
  const count = counts.failed.filter((t) => files.has(t.fileAttr)).length;
  const unloaded = new Set(counts.failed.filter(loadFailure).map((t) => t.fileAttr)).size;
  const lines = [
    ...hints.length ? [`${plural(count, "failing test")} fail${count === 1 ? "s" : ""} on the environment, not the code.`,
      describeHints(hints, cfg)] : [],
    ...unloaded ? [`${plural(unloaded, "test file")} do${unloaded === 1 ? "es" : ""} not load, so none of ` +
      `${unloaded === 1 ? "its" : "their"} tests run: recorded, a file that does not load counts as one failure and ` +
      "hides every test in it."] : [],
    ...most ? [`Most of the suite fails (${counts.failed.length} failing, ${counts.passed} passing): an environment that ` +
      "runs the code passes most of its tests."] : [],
    "Fix what the environment lacks (install, services, env). Failing tests are recorded as failing today, so do not " +
      "exclude them. If a cause cannot be fixed in the sandbox (the test needs the internet or a real outside " +
      "service), try the project again unchanged: its failing tests are then recorded with these causes.",
  ];
  return { key: [...hints.map((h) => `${h.kind}\0${h.detail}`).sort(), most ? "most" : ""].join("\n"),
    text: lines.join("\n"), count };
}

/** `text` without known_failing (the file's, or any project's but those in `keep`, which must stay as they are), and
 * whether it had one. Setup records failing tests one by one, so a proposal's known_failing is taken out rather than
 * refused (an older prompt may still ask for it). */
export function withoutKnownFailing(text: string, keep: ReadonlySet<string> = new Set()): [string, boolean] {
  const doc = parseDocument(text);
  if (doc.errors.length) return [text, false];
  let dropped = false;
  if (doc.has("known_failing") && !keep.has("main")) {
    doc.delete("known_failing");
    dropped = true;
  }
  const projects = doc.get("projects");
  if (isYamlMap(projects)) {
    for (const item of projects.items) {
      const name = String(isScalar(item.key) ? item.key.value : item.key);
      if (!keep.has(name) && isYamlMap(item.value) && item.value.has("known_failing")) {
        item.value.delete("known_failing");
        dropped = true;
      }
    }
  }
  return dropped ? [doc.toString({ flowCollectionPadding: false, lineWidth: 0 }), true] : [text, false];
}

/** Folders of test data: what sits in them under tests/ is not a test. */
const TEST_DATA = new Set(["fixtures", "__fixtures__", "testdata", "test-data", "__snapshots__", "__mocks__"]);

/** The files under a project that look like tests (isTestPath), relative to the repository: its own tests, not the
 * ones arnx writes or keeps, and none `skip` names (another project's, or listed under uncovered). */
export function testFilesUnder(cfg: ReviewConfig, snap: string, acceptedTestsDir?: string,
                               skip: (path: string) => boolean = () => false): string[] {
  const out: string[] = [];
  const generated = writeDirOf(cfg);
  const visit = (rel: string) => {
    const abs = join(snap, rel);
    for (const name of readdirSync(abs)) {
      const r = rel === "." ? name : `${rel}/${name}`;
      const st = lstatSync(join(abs, name));
      if (r === generated || name === ".arnx" || isKeptPath(cfg, r, acceptedTestsDir) || skip(r)) continue;
      if (st.isDirectory()) {
        if (!NOT_OWN.has(name) && !TEST_DATA.has(name)) visit(r);
      } else if (st.isFile() && isTestPath(r)) out.push(r);
    }
  };
  if (existsSync(join(snap, cfg.workdir))) visit(cfg.workdir);
  return out;
}

/** Most of a project's tests left out by its test_command: files under it that look like tests and that no run
 * reported, and a run reporting fewer tests than an earlier try did (`most`). Null when neither is large: 20 or more
 * files and a fifth of them, or 20 or more tests and a tenth of them. */
export function coverageGap(cfg: ReviewConfig, snap: string, results: TestResult[],
                            most: { tests: number; command: string } | undefined, acceptedTestsDir?: string,
                            skip?: (path: string) => boolean): { line: string } | null {
  const reported = new Set(results.map((t) => t.fileAttr).filter(Boolean));
  // A runner may report a file relative to the project's root, or to its own root further down.
  const ran = (f: string) => {
    for (let s: string = f; ; ) {
      if (reported.has(s)) return true;
      const k = s.indexOf("/");
      if (k < 0) return false;
      s = s.slice(k + 1);
    }
  };
  const files = results.length ? testFilesUnder(cfg, snap, acceptedTestsDir, skip) : [];
  const unrun = files.filter((f) => !ran(f));
  const parts: string[] = [];
  if (unrun.length >= 20 && unrun.length * 5 >= files.length) {
    const dirs = new Map<string, number>();
    for (const f of unrun) {
      const d = posix.dirname(f).split("/").slice(0, 2).join("/");
      dirs.set(d, (dirs.get(d) ?? 0) + 1);
    }
    const top = [...dirs].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d, n]) => `${d} ${n}`);
    parts.push(`${unrun.length} of ${files.length} files that look like tests never ran (${top.join(", ")}` +
      `${dirs.size > 3 ? ", …" : ""})`);
  }
  if (most && most.tests - results.length >= 20 && (most.tests - results.length) * 10 >= most.tests) {
    parts.push(`it runs ${results.length} tests where an earlier try ran ${most.tests} (\`${clip(most.command, 120)}\`)`);
  }
  return parts.length ? { line: parts.join("; ") } : null;
}

/** What a tool call does, in a few words, for progress lines. Setup's own tools report themselves. */
export function describeTool(name: string, input: Record<string, unknown>): string | null {
  const arg = (k: string) => (typeof input[k] === "string" ? input[k] as string : "").slice(0, 100);
  switch (name) {
    case "read_file": return `reads ${arg("path")}`;
    case "list_dir": return `lists ${arg("path") || "."}`;
    case "grep": return `searches ${arg("path") || "."} for ${JSON.stringify(arg("pattern"))}`;
    default: return null;
  }
}

/** The first sentence or so of a model reply, on one line. */
export function gist(text: string, max = 140): string {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

export function describeCoverage(c: Coverage): string {
  const fresh = (n = 0) => (n ? ` (${n} untracked)` : "");
  const lines = c.projects.map((p) =>
    `- ${p.name}: owns ${p.owned} files${fresh(p.untracked?.owned)}, uses ${p.used}${fresh(p.untracked?.used)}`);
  for (const u of c.uncovered) {
    lines.push(`- not tested: ${u.path} (${u.files} files${u.untracked ? `, ${u.untracked} untracked` : ""}): ${u.reason}`);
  }
  if (c.unexplained.length) lines.push(`- not explained: ${c.unexplained.length} source files`);
  return lines.join("\n");
}

const tempDir = (prefix: string) => mkdtempSync(join(tmpdir(), prefix));
const list = (xs: string[], max = 20) => xs.slice(0, max).join(", ") + (xs.length > max ? ` (+${xs.length - max} more)` : "");

/** The repository's files as a listing, secret files and .arnxignore matches left out (for a remote brain): the files
 * the setup agent can read, so untracked ones only with `untracked`. */
function treeOf(repo: string, untracked: boolean): string {
  return filesAt(repo, null, untracked).filter((p) => !isSecretPath(p)).join("\n");
}

/** The detector's findings over the files the setup agent can read (untracked ones only with `untracked`). */
function detectReadable(repo: string, untracked: boolean): Detection {
  return detect(repo, filesAt(repo, null, untracked));
}

/** What the setup agent is told about the repository: the detector's findings and each present language's advice
 * (exported for a brain that is sent the detection as data). */
export function setupHintsFor(d: Detection): string {
  const languages = [...new Set(d.candidates.map((c) => c.language))].filter((l) => LANGUAGES.includes(l as AdapterId));
  const advice = (languages.length ? languages : ["python"]).flatMap((l) => {
    try {
      const a = getAdapter(l);
      return [`Advice for ${a.words(a.defaultRunner).language} projects:\n${a.setupHints}`];
    } catch {
      return [];
    }
  });
  return [describeDetection(d), ...advice, SHARED_ENV].join("\n\n");
}

/** Every project gets its own image unless told otherwise: a 14-crate Rust workspace was built 14 times. */
const SHARED_ENV = "Advice for several projects: each project's install runs in its root and builds its own image " +
  "(minutes each). Projects that install the same way (one lockfile at the repository root, a Cargo workspace) can " +
  "share one image: give them the same image and install, and install_root: the directory the install runs in, " +
  "relative to the repository root (usually .). Their tests still run in each project's root.";

/** `untracked`: the agent reads untracked files too (--untracked, or `[review] untracked`), as reviews would; by
 * default it reads tracked files only (every file with no commits yet). */
type SetupOptions = { outDir: string; sessionFactory?: SessionFactory; project?: string; add?: boolean;
  progress?: Say; failureModel?: FailureModel; untracked?: boolean;
  /** The judgement side (default: LocalBrain over `agentModel`). */
  brain?: Brain;
  /** This machine's record of the accepted tests' pins (localPinsPath). */
  localPins?: string | null;
  /** Builds a project's code index for the map check (`context = "precise"`; default: in its Docker environment). */
  indexer?: typeof projectIndex };

/** The allowed files of a review.yaml no setup has approved yet (a seed, or a failed setup's last attempt); none when
 * it does not read as YAML: secret-looking files then stay out. */
function seedPins(repo: string): SecretPin[] {
  try {
    return readSecretPins(repo);
  } catch (e) {
    if (!(e instanceof ArnxError) || !e.message.includes("is not valid YAML")) throw e;
    return [];
  }
}

/** A setup's events go to `<outDir>/<id>/events.jsonl`, the id made like a review's. */
export async function runSetup(repo: string, settings: Settings, agentModel: AgentModel | null, o: SetupOptions)
  : Promise<SetupResult> {
  const id = new Date().toISOString().slice(0, 10).replaceAll("-", "") + "-" + randomHex(3);
  const log = new EventLog(join(o.outDir, id, EVENTS_FILE), id);
  return withEvents(log, () => setupBody(repo, settings, agentModel, o));
}

async function setupBody(repo: string, settings: Settings, agentModel: AgentModel | null, o: SetupOptions)
  : Promise<SetupResult> {
  const say = o.progress ?? (() => {});
  mkdirSync(o.outDir, { recursive: true });
  const existing = o.project || o.add ? loadReviewFile(repo, { requireApproved: false }) : null;
  if (o.project && !existing!.projects.some((p) => p.name === o.project)) {
    throw new ArnxError(`no project ${o.project} in .arnx/review.yaml`);
  }
  emit("setup.started", { arnx_version: VERSION, model: o.brain?.label ?? refString(settings.reviewer),
    project: o.project ?? null, add: !!o.add });
  const keep = new Map(existing ? existing.projects.filter((p) => p.name !== o.project)
    .map((p) => [p.name, projectDigest(existing, p.name)] as const) : []);
  const state = { accepted: null as string | null, lastTried: null as string | null, summary: "no project tried",
    proven: new Map<string, string>(), attempts: 0, proofs: new Map<string, ProjectProof>(),
    final: null as ReviewFile | null, lastFailing: new Map<string, { env: string; files: string[] }>(),
    failing: [] as string[], failingProject: null as string | null, problem: "", needed: null as NeededFile[] | null,
    usesChecked: false, pathsChecked: false, pathHints: [] as UsesHint[],
    lastFile: null as string | null,
    // What went back to the agent once (failures that look like the environment, tests left out), per project, with the
    // run it came from: the same environment tried again goes on from that run without running the suite again.
    held: new Map<string, { env: string; shown: Set<string>; run: { summary: string; skips: string[];
      counts: SuiteCounts } }>(),
    // The most tests a whole-suite run of each project reported, and the test_command that ran them.
    mostRan: new Map<string, { tests: number; command: string }>(),
    // The environment of each project whose tests were listed before its whole suite ran (precheck.ts): tried again
    // unchanged, it runs the whole suite.
    looked: new Map<string, string>(),
    notice: "" };
  const tmp = tempDir("arnx-setup-");
  // Docker steps of this setup, with their durations.
  dockerSteps.log = (line) => {
    mkdirSync(o.outDir, { recursive: true });
    appendFileSync(join(o.outDir, "docker.jsonl"), JSON.stringify(line) + "\n");
  };
  // A try's first line says whether an image is built for it: the build line of the project about to run takes its
  // place; otherwise the line comes as the run starts.
  let announce: { name: string; n: number } | null = null;
  dockerSteps.say = (line) => {
    const a = announce;
    if (a && line.startsWith(`${a.name}: building its test image`)) {
      announce = null;
      return say(`${a.name}: building the test image, running its suite (try ${a.n})`);
    }
    say(line);
  };
  const factory: SessionFactory = <T>(cfg: ReviewConfig, snap: string, log: string, body: (r: Runner) => Promise<T>,
    ...rest: [string?, string?]) => (o.sessionFactory ?? dockerSession)(cfg, snap, log, (session) => {
      const a = announce;
      announce = null;
      if (a) say(`${a.name}: running its suite (try ${a.n})`);
      return body(session);
    }, ...rest);
  try {
    const snap = join(tmp, "repo");
    // Files the user allowed although they look like secrets: the approved file's, or a seed's before the first setup.
    const pins = existing ? secretPinsOf(existing.raw) : seedPins(repo);
    const untracked = !!o.untracked;
    const { withheld, blanked } = takeSnapshot(repo, null, snap, pins, { untracked });
    // Image keys come from the manifests as they were before any run wrote into the snapshot.
    copyManifests(snap, join(tmp, "manifests"));
    const keyOf = (cfg: ReviewConfig) => envKey(cfg, join(tmp, "manifests"));
    const accepted = settings.acceptedTestsDir;
    // Tests kept by `arnx accept` fail until their bugs are fixed: as pinned, they do not stop a project.
    const trusted = acceptedPins(repo, o.localPins ?? null);
    // What the snapshot left out: secret-looking files, and the files .arnxignore matches. A run that needs one stops
    // setup (see LeftOutNeeded).
    const files = workingTreeFiles(repo, untracked).files;
    const ignoredFile = loadIgnore(repo);
    const secret = new Set(withheld.map((w) => w.path));
    const leftOut: LeftOut = { paths: [...secret, ...files.filter((p) => ignoredFile(p) && !secret.has(p))], all: files };
    const stopped = () => new StopRound(`stopped: ${state.problem}. Only the user can let ` +
      `${state.needed!.length === 1 ? "it" : "them"} in, so setup ends here; do not work around it.`);
    if (withheld.length) {
      say(`left out as secret-looking: ${describeWithheld(withheld)}; if one is a test fixture, not a secret, allow ` +
        "it with `arnx allow-secret PATH` and run setup again");
    }
    if (blanked.length) say(`comment lines blanked as secret-looking: ${describeBlanked(blanked)}`);
    if (withheld.length || blanked.length) {
      emit("setup.withheld", { files: withheld.map((w) => w.path), blanked: blanked.map((b) => b.path) });
    }
    const current = existing ? readFileSync(reviewConfigPath(repo), "utf8") : "";
    // The agent's file, with the user's allow-list added: the agent may not write one.
    const parse = (args: Record<string, unknown>): { f: ReviewFile; text: string } | string => {
      if (typeof args.yaml !== "string") return "invalid: yaml must be a string";
      const [yaml, dropped] = withoutKnownFailing(args.yaml, new Set(keep.keys()));
      if (dropped) {
        args = { ...args, yaml };
        state.notice = "(known_failing is not used: arnx records each failing test itself, so it was taken out of the " +
          "file.)\n";
      }
      // Saved when setup fails: with the user's allow-list, so the file left behind keeps it.
      state.lastTried = pins.length ? `${yaml.trimEnd()}\n${secretPinsYaml(pins)}` : yaml;
      try {
        const own = parseReviewFile(yaml);
        if ("approved" in own.raw) return "invalid: remove the approved key; arnx stamps the file after its proof";
        if ("allow_secret_looking" in own.raw) {
          return "invalid: remove allow_secret_looking; only the user allows secret-looking files, and setup adds " +
            "their list itself";
        }
        const text = pins.length ? `${yaml.trimEnd()}\n${secretPinsYaml(pins)}` : yaml;
        state.lastTried = text;
        state.lastFile = yaml;
        return { f: pins.length ? parseReviewFile(text) : own, text };
      } catch (e) {
        if (!(e instanceof ArnxError)) throw e;
        return `invalid: ${e.message}`;
      }
    };
    // One project's settings in place of the whole file: they replace that project's in the last whole file the
    // agent sent (or the current review.yaml, or an empty one).
    const wholeFile = (args: Record<string, unknown>): Record<string, unknown> | string => {
      if (typeof args.project_yaml !== "string") {
        return typeof args.yaml === "string" ? args : "invalid: pass the whole file as yaml, or the project's " +
          "settings as project_yaml with its name";
      }
      if (typeof args.project !== "string" || !args.project) return "invalid: name the project its settings are for";
      const doc = parseDocument(state.lastFile ?? (current || "version: 1\nprojects: {}\n"));
      const block = parseDocument(args.project_yaml);
      if (doc.errors.length || block.errors.length) {
        return `invalid: project_yaml is not valid YAML: ${(block.errors[0] ?? doc.errors[0])!.message}`;
      }
      if (!doc.has("projects")) return "invalid: the last whole file has no projects; pass the whole file as yaml";
      // The current review.yaml's stamp and allow-list are arnx's, never the agent's.
      doc.delete("approved");
      doc.delete("allow_secret_looking");
      doc.setIn(["projects", args.project], block.contents);
      return { yaml: String(doc), project: args.project };
    };
    const tryProject = async (input: Record<string, unknown>): Promise<string> => {
      if (state.needed) throw stopped();
      const n = ++state.attempts;
      const args = wholeFile(input);
      if (typeof args === "string") return args;
      const parsed = parse(args);
      if (typeof parsed === "string") return parsed;
      const { f } = parsed;
      const name = typeof args.project === "string" ? args.project : f.projects.length === 1 ? f.projects[0]!.name : "";
      const cfg = f.projects.find((p) => p.name === name);
      if (!cfg) return `invalid: name the project to try; projects: ${f.projects.map((p) => p.name).join(", ")}`;
      const t0 = performance.now();
      const attempt = (a: { ok: boolean; reused: boolean; summary: string; failing: number; skips: number;
        hints: string; error?: string }) => emit("setup.attempt", { n, project: name, ...a,
        secs: Number(((performance.now() - t0) / 1000).toFixed(1)) });
      // The snapshot does not change during setup, so a project whose part of the file is unchanged since it ran
      // would run the same way again: its proof stands without Docker.
      const proof = state.proofs.get(name);
      if (proof && state.proven.get(name) === projectDigest(f, name)) {
        say(`${name}: ✓ unchanged since it ran: ${proof.summary}`);
        state.summary = f.legacy ? proof.summary : `${name}: ${proof.summary}`;
        attempt({ ok: true, reused: true, summary: clip(proof.summary, 500), failing: 0, skips: proof.skips.length,
          hints: "" });
        return `the suite of ${name} runs: ${proof.summary} (unchanged since it last ran, so not run again). When ` +
          "every project runs, submit the file with propose.";
      }
      const log = join(o.outDir, `build-${n}-${name}.log`);
      // One line as the run starts: the image build, when there is one, is said in the same line.
      announce = { name, n };
      let ok: boolean, summary: string, tail: string, skips: string[], failing: string[], hints: string,
        counts: SuiteCounts;
      // A retry with the same environment runs only the files that failed last time (minus any now set aside);
      // when they pass, the whole suite runs once to prove the project. A changed environment runs everything.
      const env = envDigest(cfg);
      const last = state.lastFailing.get(name);
      const subset = last && last.env === env
        ? last.files.filter((file) => !cfg.knownFailing.some((k) => file.startsWith(k))) : [];
      // A run that went back to the agent, tried again in the same environment: that run stands.
      const held = state.held.get(name);
      let onlySubset = false;
      try {
        if (held && held.env === env) {
          announce = null;
          say(`${name}: same environment as the last try; its run stands`);
          [ok, summary, tail, skips, failing, hints, counts] = [true, held.run.summary, "", held.run.skips, [], "",
            held.run.counts];
        } else if (subset.length) {
          say(`${name}: same environment as the last try; rerunning the ${subset.length} file(s) that failed`);
          [ok, summary, tail, skips, failing, hints, counts] = await runSuite(cfg, snap, log, { sessionFactory: factory,
            targets: subset, failureModel: o.failureModel, key: keyOf(cfg), acceptedTestsDir: accepted,
            accepted: trusted, leftOut, baseline: "record" });
          if (ok) {
            say(`${name}: they run now; running the whole suite to prove the project`);
            [ok, summary, tail, skips, failing, hints, counts] = await runSuite(cfg, snap, log, { sessionFactory: factory,
            failureModel: o.failureModel, key: keyOf(cfg), acceptedTestsDir: accepted,
            accepted: trusted, leftOut, baseline: "record" });
          } else {
            onlySubset = true;
            summary = `rerun of the ${subset.length} file(s) that failed last time: ${summary}`;
          }
        } else {
          const look = state.looked.get(name) !== env;
          [ok, summary, tail, skips, failing, hints, counts] = await runSuite(cfg, snap, log, { sessionFactory: factory,
            failureModel: o.failureModel, key: keyOf(cfg), acceptedTestsDir: accepted,
            accepted: trusted, leftOut, baseline: "record", precheck: look });
          state.looked.set(name, env);
        }
        if (ok) state.lastFailing.delete(name);
        else state.lastFailing.set(name, { env, files: failing.length ? failing : last?.files ?? [] });
      } catch (e) {
        if (!(e instanceof ArnxError)) throw e;
        announce = null;
        if (e instanceof LeftOutNeeded) {
          state.needed = e.files.map((path) => ({ path, secret: secret.has(path) }));
          state.failing = [];
          state.failingProject = null;
          state.problem = `${name}: ${neededText(state.needed)}`;
          say(`${name}: ✗ stopped: ${neededText(state.needed)}`);
          attempt({ ok: false, reused: false, summary: "", failing: 0, skips: 0, hints: "", error: clip(e.message, 500) });
          throw stopped();
        }
        say(`${name}: ✗ ${gist(e.message)}`);
        state.failing = [];
        state.failingProject = null;
        state.problem = `${name}: ${gist(e.message)}`;
        attempt({ ok: false, reused: false, summary: "", failing: 0, skips: 0, hints: "",
          error: clip(e.message, 500) });
        return `failed: ${e.message}\n${existsSync(log) ? readFileSync(log, "utf8").slice(-OUTPUT_TAIL) : ""}`;
      }
      announce = null;
      state.summary = f.legacy ? summary : `${name}: ${summary}`;
      if (!onlySubset && counts.all.length > (state.mostRan.get(name)?.tests ?? 0)) {
        state.mostRan.set(name, { tests: counts.all.length, command: cfg.testCommand });
      }
      // Each kind of doubt goes back to the agent once; what it keeps, tried again unchanged, goes on from the same run.
      const shown = held && held.env === env ? held.shown : new Set<string>();
      const hold = (key: string) => state.held.set(name, { env, shown: new Set([...shown, key]),
        run: { summary, skips, counts } });
      // Failures that look like the environment go back to the agent once before they are recorded.
      const faults = ok && counts.failed.length ? environmentFaults(counts, cfg) : null;
      if (faults && !shown.has(faults.key)) {
        hold(faults.key);
        state.problem = `${name}: ${plural(counts.failed.length, "failing test")} that look like the environment`;
        attempt({ ok: false, reused: false, summary: clip(summary, 500), failing: failing.length, skips: skips.length,
          hints: clip(faults.text, 1000) });
        say(`${name}: runs, but ${faults.count ? `${plural(faults.count, "failing test")} look like the environment`
          : "most of its tests fail"}; asking the agent`);
        return `the suite of ${name} runs (${summary}), but its failures are not recorded yet:\n${faults.text}`;
      }
      // Tests test_command leaves out never run, and nothing else would say so: they go back to the agent once.
      const nested = f.projects.map((p) => p.workdir).filter((w) => w && w !== "." && w !== cfg.workdir);
      const uncovered = matcher(f.uncovered.map((u) => u.path).join("\n"));
      const gap = ok ? coverageGap(cfg, snap, counts.all, state.mostRan.get(name), accepted,
        (r) => nested.some((w) => r === w || r.startsWith(`${w}/`)) || uncovered(r)) : null;
      if (gap && !shown.has("gap")) {
        hold("gap");
        state.problem = `${name}: ${gap.line}`;
        attempt({ ok: false, reused: false, summary: clip(summary, 500), failing: failing.length, skips: skips.length,
          hints: clip(gap.line, 1000) });
        say(`${name}: runs, but ${gap.line}; asking the agent`);
        return `the suite of ${name} runs (${summary}), but ${gap.line}. Tests that test_command leaves out never run, ` +
          "and nothing else would say so. Run them too (a longer suite is fine: reviews run only the tests arnx writes), " +
          "or, if they cannot run in the sandbox, try the project again unchanged: the gap is then shown to the user.";
      }
      // The suite runs (some tests pass) and the current code fails others: a different failure from one that never ran.
      const ran = !ok && counts.unexpected.length > 0 && /\b[1-9]\d* passed\b/.test(summary);
      state.failing = ran ? counts.unexpected : [];
      state.failingProject = ran ? name : null;
      if (!ok) state.problem = `${name}: ${gist(summary)}`;
      attempt({ ok, reused: false, summary: clip(summary, 500), failing: failing.length, skips: skips.length,
        hints: clip(hints, 1000) });
      const skipped = skips.length ? `\nSkipped tests and why: ${skips.join("; ")}. A test skipped because it needs ` +
        "a database, a service or an environment variable is not tested in this environment: provide what it asks " +
        "for (a service and env) unless it needs the internet." : "";
      if (!ok) {
        say(`${name}: ✗ does not run yet: ${gist(summary)}`);
        return `the suite of ${name} does not run yet: ${summary}${skipped}${hints ? `\n${hints}` : ""}\n${tail}`;
      }
      say(`${name}: ✓ ${summary}${counts.failed.length ? ` · ${counts.failed.length} failing today, recorded` : ""}` +
        `${skips.length ? ` · skipped because ${skips.join("; ")}` : ""}`);
      const red = counts.acceptedFailing ? ` ${plural(counts.acceptedFailing, "failure")} in accepted tests (bugs not ` +
        "fixed yet) do not count; leave those tests as they are." : "";
      if (red) say(stillRed(counts.acceptedFailing));
      state.proven.set(name, projectDigest(f, name));
      state.proofs.set(name, { name, summary, skips,
        failed: counts.failed.map((t) => entryOf(t, causeOf(t, cfg, snap, counts.hints) ?? undefined)),
        ...(gap ? { gap: gap.line } : {}) });
      // A TypeScript project that can be type checked and has no typecheck yet: say so while the agent is here.
      const read = (rel: string) => {
        try {
          return readFileSync(join(snap, rel), "utf8");
        } catch {
          return "";
        }
      };
      const typed = cfg.language === "typescript" && !cfg.typecheck && typeCheckable(read, cfg.workdir)
        ? ` ${name} has a tsconfig.json and typescript among its dependencies: add typecheck (for example ` +
          `${TYPECHECK_EXAMPLE}, with the same node_modules link as test_command) and try it again.` : "";
      const bare = summary.startsWith(NO_OWN_TESTS) ? ` ${name} has no tests of its own, which is fine: reviews run the ` +
        "tests arnx writes with this test_command. Do not write tests for it." : "";
      const recorded = counts.failed.length ? ` Its ${plural(counts.failed.length, "failing test")} ` +
        `${counts.failed.length === 1 ? "is" : "are"} recorded as failing today.` : "";
      return `the suite of ${name} runs: ${summary}.${recorded}${bare}${red}${skipped}${typed} When every project runs, submit the ` +
        "file with propose.";
    };
    const propose = async (args: Record<string, unknown>): Promise<string> => {
      if (state.needed) throw stopped();
      const parsed = parse(args);
      if (typeof parsed === "string") return parsed;
      const { f, text } = parsed;
      const problems: string[] = [];
      const ownTests: string[] = [];
      const changed = [...keep].filter(([name, d]) => !f.projects.some((p) => p.name === name) ||
        projectDigest(f, name) !== d).map(([name]) => name);
      if (changed.length) problems.push(`must stay as approved: ${changed.join(", ")}`);
      const unproven = f.projects.filter((p) => !keep.has(p.name) && state.proven.get(p.name) !== projectDigest(f, p.name))
        .map((p) => p.name);
      const map = coverageMap(repo, f, untracked);
      if (map.overlaps.length) problems.push(`owned by more than one project: ${list(map.overlaps)}`);
      if (map.unexplained.length) {
        problems.push(`not explained: ${list(map.unexplained)}; add them to a project's owns or uses, or to uncovered ` +
          "with a reason");
      }
      for (const p of f.projects.filter((x) => !keep.has(x.name))) {
        const own = ownTestsIn(p, snap, accepted);
        if (own.length) {
          problems.push(`${f.legacy ? "" : `${p.name}: `}${ownTestsProblem(p, own)}`);
          ownTests.push(p.name);
        }
      }
      if (problems.length) {
        if (unproven.length) problems.push(`not proven yet: ${unproven.join(", ")} (propose runs them once the rest is right)`);
        state.problem = rejectedReason({ changed, overlaps: map.overlaps, unexplained: map.unexplained, ownTests,
          failed: [] });
        say(`Proposal rejected: ${state.problem}. Retrying...`);
        return `refused:\n${problems.join("\n")}`;
      }
      // The map's paths are checked once, before any project runs: uses entries wider than meant go back as hints,
      // and the same file proposed again is accepted. Approved projects must stay as they are, so none is named.
      if (!state.pathsChecked) {
        state.pathsChecked = true;
        state.pathHints = mapHints(f, files.filter((p) => !ignoredFile(p) && !isSecretPath(p)))
          .filter((h) => !keep.has(h.project));
        const hints = state.pathHints;
        emit("setup.paths_check", { projects: f.projects.length,
          hints: hints.map((h) => ({ project: h.project, kind: h.kind })) });
        if (hints.length) {
          say(`${hints.length} uses entr${hints.length === 1 ? "y" : "ies"} too wide; asking the agent`);
          return "refused once: these uses entries reach further than meant:\n" + hints.map((h) => `- ${h.text}`)
            .join("\n") + "\nFix them, or propose the same file again to keep it as it is.";
        }
      }
      // The rest is right: propose runs each project changed since it was proven, instead of a round trip per project.
      const failed: string[] = [];
      const failedNames: string[] = [];
      for (const name of unproven) {
        const r = await tryProject({ yaml: args.yaml, project: name });
        if (!r.startsWith(`the suite of ${name} runs:`)) {
          failed.push(r);
          failedNames.push(name);
        }
      }
      if (failed.length) {
        const why = rejectedReason({ changed: [], overlaps: [], unexplained: [], ownTests: [], failed: failedNames });
        // The suite's own failure (state.problem, state.failing) stays what a failed setup reports.
        say(`Proposal rejected: ${why}. Retrying...`);
        return `refused: propose ran the projects changed since they were proven, and these do not run:\n` +
          failed.join("\n\n");
      }
      // With a code index (`context = "precise"`), the map is checked once against what each project's code refers
      // to: what it finds goes back as hints, and the same file proposed again is accepted.
      if (settings.context === "precise" && !state.usesChecked) {
        state.usesChecked = true;
        say("checking the map against the code");
        const indexes: ScipIndex[] = [];
        for (const p of f.projects) {
          const r = await (o.indexer ?? projectIndex)(p, snap, join(o.outDir, "index", p.name));
          if (r.index) indexes.push(r.index);
        }
        // An entry the path check already named is not named again.
        const hints = (indexes.length ? usesHints(f, fileReferences(indexes)) : [])
          .filter((h) => !state.pathHints.some((x) => x.project === h.project && x.entry === h.entry));
        emit("setup.uses_check", { indexed: indexes.length, projects: f.projects.length,
          hints: hints.map((h) => ({ project: h.project, kind: h.kind })) });
        if (hints.length) {
          say(`the code does not bear out ${hints.length} map entr${hints.length === 1 ? "y" : "ies"}; asking the agent`);
          return "refused once: the projects' code (from their code indexes) does not match these parts of the map:\n" +
            hints.map((h) => `- ${h.text}`).join("\n") + "\nFix them, or propose the same file again to keep it as it is.";
        }
      }
      state.accepted = text;
      state.final = f;
      return `accepted:\n${describeCoverage(map)}\nStop here and summarise.`;
    };
    // A note the agent gets once, with the next tool result (known_failing taken out of its file).
    const noted = (run: (i: Record<string, unknown>) => Promise<string>) => async (i: Record<string, unknown>) => {
      const r = await run(i);
      const note = state.notice;
      state.notice = "";
      return note + r;
    };
    const ws = new Workspace(snap, { extra: { try_project: [TRY_PROJECT, noted(tryProject)],
      propose: [PROPOSE, noted(propose)] } });
    const detection = detectReadable(repo, untracked);
    const brain: Brain = o.brain ?? new LocalBrain({ agentModel: agentModel!, prices: allPrices(settings),
      prompts: promptsFor(repo) });
    // The agent reading files is one milestone, said once until a project runs or a proposal goes in; which files it
    // read stays in the transcript.
    let reading = false;
    const tools = { tools: () => ws.tools(),
      call: (name: string, args: Record<string, unknown>) => {
        if (name === "try_project" || name === "propose") reading = false;
        return ws.call(name, args);
      },
      onTool: (name: string, input: Record<string, unknown>) => {
        if (reading || !describeTool(name, input)) return;
        reading = true;
        say("reading the repository");
      } };
    const { agent: result } = await withRole("setup", () => brain.agentRound("setup", { hints: setupHintsFor(detection),
      withheld: withheld.length ? describeWithheld(withheld) : "", current, detection, tree: treeOf(repo, untracked),
      withheldFiles: withheld,
      ...(o.project ? { project: o.project } : {}), ...(o.add ? { add: true } : {}),
      budgetUsd: settings.setupBudgetUsd, outDir: o.outDir }, Promise.resolve(tools)));
    logUsage(repo, "setup", [agentUse(brain.label ? `${brain.label}/setup` : refString(settings.reviewer), result)],
      new Date());
    const projects = (state.final?.projects ?? []).map((p) => state.proofs.get(p.name) ??
      { name: p.name, summary: keep.has(p.name) ? "approved earlier" : "not run", skips: [] });
    emit("setup.completed", { ok: state.accepted !== null, stop: result.stop, cost_usd: result.costUsd,
      attempts: state.attempts, projects: projects.map((p) => p.name), summary: clip(state.summary, 500) });
    return { ok: state.accepted !== null, yamlText: state.accepted ?? state.lastTried, summary: state.summary,
      costUsd: result.costUsd, stop: state.needed ? "stopped" : result.stop, notes: result.finalText, projects, withheld, blanked,
      failing: state.accepted !== null ? [] : state.failing, failingProject: state.accepted !== null ? null
        : state.failingProject, problem: state.problem, ...(state.needed ? { needed: state.needed } : {}) };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    dockerSteps.log = null;
    dockerSteps.say = null;
  }
}

/** The configured settings; null when there is no config.toml yet or it cannot be read. */
function settingsOf(repo: string): Settings | null {
  try {
    return existsSync(settingsPath(repo)) ? loadSettings(repo) : null;
  } catch (e) {
    if (e instanceof ArnxError) return null;
    throw e;
  }
}

/** One project's suite in an approval: whether it passed, its counts (or why it failed), its accepted tests that
 * still fail, the failures that block it, and where its whole output is (relative to the repository). */
export interface ApprovedSuite { name: string; ok: boolean; summary: string; acceptedFailing: number;
  unexpected: string[]; log: string; baselineFailing: number; left: string[]; flaky: string[] }

/** Failing tests a failed approval names per project; the rest are counted. */
const SHOWN_FAILURES = 5;

/** A failed suite in approve's text: a ✗ line, a few failing tests, and where the whole output is. */
function failedSuite(s: ApprovedSuite, legacy: boolean, repo: string): string {
  const head = s.unexpected.length ? s.summary.replace(/; failing outside the baseline: .*$/s,
    "; failing outside the baseline:") : s.summary;
  const more = s.unexpected.length - SHOWN_FAILURES;
  return [`✗ ${legacy ? "" : `${s.name}: `}${head}`, ...s.unexpected.slice(0, SHOWN_FAILURES).map((id) => `  ${id}`),
    ...(more > 0 ? [`  and ${more} more`] : []),
    ...(existsSync(join(repo, s.log)) ? [`  Full output: ${s.log}`] : [])].join("\n");
}

/** Run the suites again and stamp the file. With `project`, only that project runs, and only when every other
 * project is unchanged since the last approval. The suites run on what reviews will see: tracked files, and untracked
 * ones only with `untracked` (default: `[review] untracked`). Tests kept by `arnx accept` may fail while they match
 * their pins (`localPins`: this machine's record, localPinsPath). Tests in the baseline may fail; those that no longer
 * do leave it. A test failing outside it runs once more, and passing then it does not count (flaky). `afterSetup`: the
 * projects setup recorded moments ago, where a test failing outside the baseline is flaky and joins it as such;
 * otherwise the baseline never grows here. [approved, text, each suite that ran] */
export async function approveFile(repo: string, o: { by: string; at: string; project?: string;
  sessionFactory?: SessionFactory; progress?: Say; untracked?: boolean; localPins?: string | null;
  afterSetup?: string[] })
  : Promise<[boolean, string, ApprovedSuite[]]> {
  const say = o.progress ?? (() => {});
  const f = loadReviewFile(repo, { requireApproved: false });
  let base: Baseline;
  try {
    base = readBaseline(repo);
  } catch (e) {
    if (!(e instanceof ArnxError)) throw e;
    return [false, e.message, []];
  }
  const next: Baseline = new Map([...base].filter(([name]) => f.projects.some((p) => p.name === name)));
  let run = f.projects;
  if (o.project) {
    const prev = (f.raw.approved as { projects?: Record<string, string> } | undefined)?.projects;
    if (!f.projects.some((p) => p.name === o.project)) return [false, `no project ${o.project} in review.yaml`, []];
    if (!prev) return [false, "no earlier proof with per-project hashes; run `arnx approve` without --project", []];
    const changed = f.projects.filter((p) => p.name !== o.project && prev[p.name] !== projectDigest(f, p.name));
    if (changed.length) {
      return [false, `${changed.map((p) => p.name).join(", ")} changed since its proof; run \`arnx approve\` ` +
        "without --project", []];
    }
    if (stampedBaseline(f) !== baselineDigest(repo)) {
      return [false, `${BASELINE_FILE} changed since its proof; run \`arnx approve\` without --project`, []];
    }
    run = f.projects.filter((p) => p.name === o.project);
  }
  const summaries: string[] = [];
  const suites: ApprovedSuite[] = [];
  const settings = settingsOf(repo);
  const accepted = settings?.acceptedTestsDir;
  const trusted = acceptedPins(repo, o.localPins ?? null);
  const tmp = tempDir("arnx-approve-");
  try {
    const snap = join(tmp, "repo");
    snapshot(repo, null, snap, secretPinsOf(f.raw), { untracked: o.untracked ?? settings?.untracked ?? false });
    copyManifests(snap, join(tmp, "manifests"));
    // Every project runs, so one approve names every project that needs fixing.
    for (const cfg of run) {
      const log = join(repo, ".arnx", "run", f.legacy ? "approve-build.log" : `approve-build-${cfg.name}.log`);
      const output = posix.join(".arnx", "run", f.legacy ? "approve.log" : `approve-${cfg.name}.log`);
      const mine = base.get(cfg.name) ?? [];
      const fresh = !!o.afterSetup?.includes(cfg.name);
      const [ok, summary, , skips, , , counts] = await runSuite(cfg, snap, log, { sessionFactory: o.sessionFactory,
        key: envKey(cfg, join(tmp, "manifests")), acceptedTestsDir: accepted, accepted: trusted,
        outputLog: join(repo, output), baseline: mine, rerun: true, passedBefore: fresh });
      const moved = [counts.left.length ? `${counts.left.length} left the baseline (they pass now)` : "",
        counts.flaky.length ? `${plural(counts.flaky.length, "test")} failed, then passed when run again (flaky): ` +
          few(counts.flaky) : ""].filter(Boolean).map((x) => ` · ${x}`).join("");
      say(`${cfg.name}: ${ok ? "✓" : "✗"} ${gist(summary)}${ok ? moved : ""}` +
        `${skips.length ? ` · skipped because ${skips.join("; ")}` : ""}`);
      suites.push({ name: cfg.name, ok, summary, acceptedFailing: counts.acceptedFailing, unexpected: counts.unexpected,
        log: output, baselineFailing: counts.baselineFailing, left: counts.left, flaky: counts.flaky });
      if (ok) summaries.push(f.legacy ? summary : `${cfg.name}: ${summary}`);
      const left = new Set(counts.left);
      const joined = fresh ? counts.failed.filter((t) => counts.flaky.includes(t.testId))
        .map((t) => ({ ...entryOf(t), flaky: true as const })) : [];
      next.set(cfg.name, [...mine.filter((b) => !left.has(b.id)), ...joined]);
    }
    const failed = suites.filter((s) => !s.ok);
    if (failed.length) return [false, failed.map((s) => failedSuite(s, f.legacy, repo)).join("\n\n"), suites];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeBaseline(repo, next);
  const hash = baselineDigest(repo);
  writeFileSync(reviewConfigPath(repo), f.legacy ? stamp(f.projects[0]!, o.by, o.at, hash)
    : stampFile(f, o.by, o.at, hash));
  return [true, summaries.join("; "), suites];
}

export const approveConfig = approveFile;

/** One project in `arnx setup --baseline`: its suite, how many tests it fails today, and, when it had known_failing,
 * how many tests in those files pass and count again. */
export interface RecordedSuite { name: string; ok: boolean; summary: string; failing: number; guarded: number;
  log: string }

/** `arnx setup --baseline`: every project's suite runs as setup runs it, known_failing left out, and the tests failing
 * now become the baseline; known_failing goes from review.yaml and the file is stamped. No model is asked. A project
 * whose suite does not run leaves everything as it was. [recorded, text, each suite, what changed] */
export async function rerecordBaseline(repo: string, o: { by: string; at: string; sessionFactory?: SessionFactory;
  progress?: Say; untracked?: boolean; localPins?: string | null })
  : Promise<[boolean, string, RecordedSuite[], string[]]> {
  const say = o.progress ?? (() => {});
  const path = reviewConfigPath(repo);
  const f = loadReviewFile(repo, { requireApproved: false });
  let old: Baseline = new Map();
  try {
    old = readBaseline(repo);
  } catch (e) {
    if (!(e instanceof ArnxError)) throw e; // recorded anew
  }
  const settings = settingsOf(repo);
  const accepted = settings?.acceptedTestsDir;
  const trusted = acceptedPins(repo, o.localPins ?? null);
  const next: Baseline = new Map();
  const suites: RecordedSuite[] = [];
  const tmp = tempDir("arnx-baseline-");
  try {
    const snap = join(tmp, "repo");
    snapshot(repo, null, snap, secretPinsOf(f.raw), { untracked: o.untracked ?? settings?.untracked ?? false });
    copyManifests(snap, join(tmp, "manifests"));
    for (const cfg of f.projects) {
      const log = join(repo, ".arnx", "run", f.legacy ? "baseline-build.log" : `baseline-build-${cfg.name}.log`);
      const output = posix.join(".arnx", "run", f.legacy ? "baseline.log" : `baseline-${cfg.name}.log`);
      const all = { ...cfg, knownFailing: [] };
      let [ok, summary, , , , , counts] = await runSuite(all, snap, log, { sessionFactory: o.sessionFactory,
        key: envKey(cfg, join(tmp, "manifests")), acceptedTestsDir: accepted, accepted: trusted,
        outputLog: join(repo, output), baseline: "record" });
      // Most of the suite failing is the environment, not today's code: nothing is recorded from it.
      const most = ok && counts.failed.length > counts.passed;
      if (most) {
        ok = false;
        summary = `${summary}; most of the suite fails (${counts.failed.length} failing, ${counts.passed} passing), ` +
          "which points to the environment, not the code: fix it, then record again";
      }
      const tests = counts.failed.map((t) => entryOf(t, causeOf(t, cfg, snap, counts.hints) ?? undefined));
      const failingIds = new Set(tests.map((t) => t.id));
      const guarded = cfg.knownFailing.length ? counts.all.filter((t) => t.outcome === "passed" && !failingIds.has(t.testId) &&
        cfg.knownFailing.some((k) => t.fileAttr.startsWith(k))).length : 0;
      say(`${cfg.name}: ${ok ? "✓" : "✗"} ${gist(summary)}${ok && tests.length ? ` · ${tests.length} failing today` : ""}`);
      suites.push({ name: cfg.name, ok, summary, failing: tests.length, guarded, log: output });
      next.set(cfg.name, tests);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const failed = suites.filter((x) => !x.ok);
  if (failed.length) {
    return [false, failed.map((x) => `✗ ${f.legacy ? "" : `${x.name}: `}${x.summary}` +
      (existsSync(join(repo, x.log)) ? `\n  Full output: ${x.log}` : "")).join("\n\n"), suites, []];
  }
  const changes = describeBaselineChanges(old, next);
  const known = f.projects.filter((p) => p.knownFailing.length);
  for (const p of known) {
    const g = suites.find((x) => x.name === p.name)!.guarded;
    changes.push(`${f.legacy ? "" : `${p.name}: `}known_failing removed (${plural(p.knownFailing.length, "file")}): ` +
      `${g} of ${p.knownFailing.length === 1 ? "its" : "their"} tests ${g === 1 ? "passes and counts" : "pass and count"} ` +
      "again");
  }
  writeBaseline(repo, next);
  const text = withoutKnownFailing(readFileSync(path, "utf8"))[0];
  const g = parseReviewFile(text);
  const hash = baselineDigest(repo);
  writeFileSync(path, g.legacy ? stamp(g.projects[0]!, o.by, o.at, hash) : stampFile(g, o.by, o.at, hash));
  return [true, suites.map((x) => f.legacy ? x.summary : `${x.name}: ${x.summary}`).join("; "), suites, changes];
}
