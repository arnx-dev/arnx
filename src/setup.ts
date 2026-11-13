// Setup: an agent reads the repository and proposes `.arnx/review.yaml` as a list of projects, proving each one by
// building its environment and running its existing suite. Nobody is asked: the proof takes setup's last whole-suite
// run of each project unchanged since (same file, same code), runs the others again, and stamps the file.
import { appendFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync,
  writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { isMap as isYamlMap, isScalar, isSeq, parseDocument, visit } from "yaml";
import { type AgentResult, StopRound, Workspace } from "./agent";
import { type Baseline, BASELINE_FILE, type BaselineTest, baselineDigest, describeBaselineChanges, entryOf, keysOf,
  failKey, readBaseline, testKey, writeBaseline } from "./baseline";
import { Boundary, boundaryOf, type Swap } from "./boundary";
import type { Brain } from "./brain";
import { clip, emit, EVENTS_FILE, EventLog, withEvents, withRole } from "./events";
import { adapterFor, getAdapter, LANGUAGES } from "./adapters";
import type { AdapterId, TestResult } from "./adapters/types";
import { addToSandbox, type Blanked, describeBlanked, describeWithheld, fakedKeysText, filesAt, leftOutBrief, hasCommits, snapshotDigest, someNames,
  takeSnapshot, type Withheld, workingTreeFiles } from "./change";
import { configSuspects,
  loadReviewFile, parseReviewFile, plainReviewYaml, projectDigest, readSecretPins, restDigest, runDigest, type ReviewConfig,
  reviewConfigPath,
  type ReviewFile, sandboxOnlyOf, sandboxYaml, secretPinsOf, secretPinsYaml, stamp, stampedBaseline, stampFile,
} from "./config";
import { type Detection, describeDetection, detect, isTestPath, TYPECHECK_EXAMPLE, typeCheckable } from "./detect";
import { draftYaml, NOT_SET_UP, quickDraft, sourceFirst } from "./draft";
import { NO_TESTS, route, SCRIPTS, usesBlocked } from "./route";
import { MANY_SERVICES, manyServices, manyServicesReason } from "./facts";
import { A_FAKED_FILE, classify, describeHints, diagnose, firstErrors, firstLine, type Hint, markUnproven, missingLeftOut, npxDownload, npxText,
  loadFailure, passingApart, unexplainedFiles } from "./diagnose";
import type { FailureModel } from "./jev";
import { ArnxError } from "./errors";
import { loadIgnore, matcher } from "./ignore";
import { projectIndex } from "./indexer";
import { isSecretPath, maskPrivateKeys, type SecretPin } from "./secrets";
import { namesStandIn, type StandInRow, standInsLine, writeStandIns } from "./standins";
import { type AgentModel, allPrices, type Tool } from "./llm";
import { ownerFile, runTests } from "./outcomes";
import { type KeyReruns, keyReruns, rerunCandidates, rerunWithRealKeys, sweepRealKeyCopies } from "./realkey";
import { look, type Placement } from "./precheck";
import { LocalBrain } from "./localbrain";
import { promptsFor } from "./userprompts";
import type { Say } from "./progress";
import { copyManifests, dockerExec, DiskFull, dockerSteps, envKey, envTag, type ExecFactory, OutOfTime, requireTime,
  type Runner, type RunResult, type SessionFactory, type TimeLimit, timeIsUp, withTimeLimit } from "./sandbox";
import type { ScipIndex } from "./scip";
import { EXEC, SetupExec, type TriedEnv } from "./setupexec";
import { loadSettings, refString, type Settings, settingsPath, setupRef } from "./settings";
import { QUICK_TYPECHECK_TIMEOUT, recordTypecheck, runTypecheck, TYPECHECK_TIMEOUT, gapsLine, type TypeGap, typeGaps, workspaceNames } from "./typecheck";
import { SOURCE } from "./untested";
import { BROWSER_TESTS, UI_RUNS, type BrowserSuite, browserSuites, uiFramework, WEB_UI } from "./browser";
import { otherLanguageOf } from "./languages";
import { fileReferences, mapHints, type UsesHint, usesHints } from "./usescheck";
import { agentUse, logUsage } from "./usage";
import { randomHex } from "./util";
import { VERSION } from "./version";
import { acceptedPins, type AcceptedPins } from "./check";
import { storedName } from "./kept";
import { collect, DOME, dockerSession, isKeptPath, ownTestsInWriteDir, ownTestsProblem, probeRun, swapIn, writeDirOf }
  from "./testround";
import { type TestsDirChoice, testsDirFor } from "./testsdir";

export const SUITE_TIMEOUT = 1800;
/** The one-line test's run after the suite (probe): a handful of seconds in a working environment. */
export const PROBE_TIMEOUT = 300;
export const OUTPUT_TAIL = 6000;

/** What a suite's failures were: tests kept by `arnx accept` that fail as pinned, failures that block, failures the
 * baseline holds, the baseline's tests that no longer fail (`left`, ids), tests that failed and then passed when run
 * again (`flaky`, ids), and every failure (accepted ones aside), for setup to record. */
export interface SuiteCounts { acceptedFailing: number; unexpected: string[]; baselineFailing: number; left: string[];
  flaky: string[]; failed: TestResult[]; passed: number;
  /** Tests that failed for a file left out or a key's fake: no failure of the project, and in no baseline. */
  unproven?: Unproven[];
  /** Every test the run reported. */
  all: TestResult[];
  /** What the failures point to (diagnose, the run apart, JEV), when the suite's failures were looked at. */
  hints?: Hint[];
  /** The type check did not run, timed out or failed without reporting: information, never a failed proof. */
  typecheckProblem?: string;
  /** Modules the type check cannot see (a generated client, an unbuilt package): its errors say nothing about the change. */
  typeGaps?: TypeGap[];
  /** Errors the type check counted (absent: it did not run to a count). */
  typeErrors?: number;
  /** A quick look's run: the test files the runner listed, all of which the whole suite would run. */
  listed?: string[];
  /** The look saw where the runner collects arnx's one-line test, and it is not where review.yaml says: nothing ran. */
  placement?: Placement;
  /** The try stopped before the project's UI tests ran: at the listing or the sample, or on settings ("config": the
   * project's own tests sit in tests_dir, the placement or the .arnx/ folder is wrong, the one-line test did not run). */
  stoppedAt?: "listing" | "sample" | "config" }

/** Whether a failed try spends one of a web UI app's runs: its tests were listed or sampled and failed, or its suite
 * ran and passed nothing. A build failure (no counts), a placement and a passing run never do. */
export function countsAsUiRun(c: SuiteCounts, ok: boolean): boolean {
  if (ok || c.placement || c.stoppedAt === "config") return false;
  return c.stoppedAt === "listing" || c.stoppedAt === "sample" || c.passed === 0;
}

const noCounts = (): SuiteCounts => ({ acceptedFailing: 0, unexpected: [], baselineFailing: 0, left: [], flaky: [],
  failed: [], passed: 0, all: [] });

/** A test that needs a file left out, or a private key (`faked`) the sandbox holds as a fake. */
export interface Unproven { testId: string; needs: string; faked?: true;
  /** With `faked`: not rerun with the real key, so it only may need it. */
  notRerun?: true }

/** The accepted files of this project (`accepted`, acceptedPins) that match their pin, and those changed since. */
function acceptedOf(cfg: ReviewConfig, accepted: AcceptedPins, dir?: string): AcceptedPins {
  const under = (p: string) => isKeptPath(cfg, p, dir);
  return { pinned: accepted.pinned.filter(under), changed: accepted.changed.filter((c) => under(c.path)) };
}

const failedTest = (t: TestResult) => t.outcome === "failed" || t.outcome === "error";

/** Why a run wrote no report, shortly: its exit code or time-out, whether the runner says it wrote one (arnx's
 * report option reached it then) when it is a runner that says, and the last lines of its output. */
export function noReport(result: RunResult, cfg: ReviewConfig): string {
  const adapter = adapterFor(cfg);
  const runner = adapter.words(cfg.runner).runner;
  const said = result.timedOut ? undefined : adapter.reportSaid?.(result.output, cfg.runner);
  const reach = said === undefined ? ""
    : said === null ? `; ${runner} never said it wrote one, so it stopped first or missed arnx's report option`
    : `; ${runner} got arnx's report option but wrote ${said}, which arnx could not read`;
  const last = maskPrivateKeys(result.output).split("\n").map((l) => l.trim()).filter(Boolean).slice(-3).join(" | ");
  return `the suite produced no report (${result.timedOut ? `timed out after ${Math.round(result.seconds)} s`
    : `exit ${result.exitCode}`}${reach})${last ? `; last lines: ${clip(last, 300)}` : ""}`;
}

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
  const known = record ? new Set<string>() : new Set(baseline.map((b) => failKey(b.id, b.file, !!b.load)));
  const counts = new Map<string, number>();
  const unexpected: string[] = [];
  const failed: TestResult[] = [];
  const failing = new Set<string>();
  const unproven: Unproven[] = [];
  let acceptedFailing = 0;
  let baselineFailing = 0;
  for (const t of results) {
    if (t.needs) {
      unproven.push({ testId: t.testId, needs: t.needs, ...(t.fakedKey ? { faked: true as const } : {}), ...(t.notRerun ? { notRerun: true as const } : {}) });
      counts.set("unproven", (counts.get("unproven") ?? 0) + 1);
      continue;
    }
    counts.set(t.outcome, (counts.get(t.outcome) ?? 0) + 1);
    if (!failedTest(t) || cfg.knownFailing.some((k) => t.fileAttr.startsWith(k))) continue;
    if (ownerFile(t.fileAttr, mine.pinned) !== null) {
      // Not the suite's failure: counted apart, so a ✓ line never reads "4 failed".
      acceptedFailing++;
      counts.set(t.outcome, counts.get(t.outcome)! - 1);
      continue;
    }
    failed.push(t);
    const key = failKey(t.testId, t.fileAttr, loadFailure(t));
    failing.add(key);
    if (record || known.has(key)) baselineFailing++;
    else unexpected.push(t.testId);
  }
  // A baseline test leaves once it no longer fails, a flaky one too: should it fail again, the rerun tells.
  const left = record ? [] : baseline.filter((b) => !failing.has(failKey(b.id, b.file, !!b.load))).map((b) => b.id);
  const summary = [...counts.keys()].sort().filter((o) => counts.get(o)).map((o) => `${counts.get(o)} ${o}`).join(", ") +
    (acceptedFailing ? ` (${acceptedFailing} accepted test${acceptedFailing === 1 ? "" : "s"} still fail` +
      `${acceptedFailing === 1 ? "s" : ""})` : "") +
    (baselineFailing && !record ? ` (${baselineFailing} in the baseline)` : "");
  const c: SuiteCounts = { acceptedFailing, unexpected, baselineFailing, left, flaky: [], failed,
    passed: counts.get("passed") ?? 0, all: results, ...(unproven.length ? { unproven } : {}) };
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

/** The note setup gives on accepted tests changed since `arnx accept`. */
export function changedNote(changed: AcceptedPins["changed"]): string {
  return `${plural(changed.length, "accepted test file")} changed since \`arnx accept\` (${few(changed.map((c) =>
    `${c.change} ${c.path}`))}); setup goes on, \`arnx check\` says what to do`;
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
    const reason = clip(first.replace(/^\S+:\d+: /, "").replace(/^Skipped: /, ""), 160);
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
    ? ownTestsInWriteDir(cfg, collect(snap, dir, adapterFor(cfg).writable), acceptedTestsDir) : [];
}

/** Folders that hold other people's code, never the project's own tests (build output is rarely committed, and a
 * test there is still a test); .arnx holds arnx's (accepted tests). */
const NOT_OWN = new Set(["node_modules", ".git", ".venv", "venv", "__pycache__", ".arnx-run", ".arnx"]);
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

/** Said after a suite's counts when its runner also ran a file under .arnx/ (left out of them). */
export const ARNX_COLLECTED = "; note: the runner also ran a file under .arnx/, left out of these counts";

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
 * small files run (precheck.ts); what they show wrong comes back without the whole suite running. `quick` (with
 * `precheck`): a quick setup's run, for a first review: when the few small files run, their run stands for the whole
 * suite, which does not run. */
export async function runSuite(cfg: ReviewConfig, snap: string, buildLog: string,
                               { sessionFactory = dockerSession, targets = [], failureModel, key, acceptedTestsDir,
                                 accepted, outputLog, leftOut, baseline = [], rerun = false, passedBefore = false,
                                 precheck = false, quick = false, tolerate = false, boundary, swap }: {
                                 sessionFactory?: SessionFactory; targets?: string[]; failureModel?: FailureModel;
                                 key?: string; acceptedTestsDir?: string; accepted?: AcceptedPins;
                                 outputLog?: string; leftOut?: LeftOut; baseline?: BaselineTest[] | "record";
                                 rerun?: boolean; passedBefore?: boolean; precheck?: boolean; quick?: boolean; tolerate?: boolean;
                                 boundary?: Boundary; swap?: Swap } = {})
  : Promise<[boolean, string, string, string[], string[], string, SuiteCounts]> {
  const none = noCounts();
  // A review clears and collects every writable file in tests_dir: the project's own tests may not live there.
  const own = ownTestsIn(cfg, snap, acceptedTestsDir);
  if (own.length) return [false, ownTestsProblem(cfg, own), "", [], [], "", { ...none, stoppedAt: "config" }];
  if (outputLog) rmSync(outputLog, { force: true });
  /** The end of `output`, the whole of it kept in outputLog. A run can print the real values it holds. */
  const tailOf = (raw: string): string => {
    const output = boundary ? boundary.mask(raw) : raw;
    if (outputLog) {
      mkdirSync(dirname(outputLog), { recursive: true });
      writeFileSync(outputLog, output);
    }
    return output.slice(-OUTPUT_TAIL);
  };
  const said = (t: string) => boundary ? boundary.mask(t) : t;
  // From a run on, what a test says is the stand-in's, ids too: the baseline is committed, and is compared with these.
  const kept = (results: TestResult[] | null) => boundary ? boundary.maskValue(results) : results;
  const [ok, summary, tail, skips, failing, hints, counts] = await sessionFactory(cfg, snap, buildLog, async (session) => {
    type Out = [boolean, string, string, string[], string[], string, SuiteCounts];
    // A project with no tests of its own has nothing to list: its run below is quick.
    let sample: { files: string[]; run: RunResult; results: TestResult[] } | null = null;
    let listed = "";
    let listedFiles: string[] = [];
    if (precheck && !targets.length && (cfg.language === "rust" || hasOwnTests(cfg, snap))) {
      // A quick look whose runner has no list form takes a few small test files from the project's own.
      const seen = await look(session, snap, cfg, acceptedTestsDir, baseline,
        quick ? { files: () => testFilesUnder(cfg, snap, acceptedTestsDir), tolerate } : {});
      const early = seen.early;
      if (seen.placement) {
        const w = seen.placement;
        return [false, `the runner lists arnx's one-line test in ${w.testsDir}${w.testFiles ? ` as ${w.testFiles}` : ""}, ` +
          "not where review.yaml says", "", [], [], "", { ...none, placement: w }] as Out;
      }
      if (early) return [false, early.summary, tailOf(early.output), [], [], early.hints, { ...none, stoppedAt: early.kind }] as Out;
      if (quick && seen.sample) {
        sample = seen.loadErrors ? { ...seen.sample, results: [...seen.sample.results, ...seen.loadErrors] } : seen.sample;
        listedFiles = seen.listed;
        listed = `quick look: ${seen.found ? `${plural(seen.files, "test file")} found`
          : `${plural(seen.tests, "test")} listed`}, ${plural(sample.files.length, "small file")} ran: `;
      }
    }
    // A whole-suite run carries a canary: one-line tests where arnx keeps accepted tests (.arnx/tests/), stored as
    // accept stores them, which proves the project's own run never collects a kept file.
    const canary = targets.length || sample ? [] : adapterFor(cfg).probes(cfg.runner)
      .map((p) => ({ path: join(snap, DOME, writeDirOf(cfg), storedName(p.file)), source: p.source }));
    for (const c of canary) {
      mkdirSync(dirname(c.path), { recursive: true });
      writeFileSync(c.path, c.source);
    }
    let result, ran;
    try {
      [result, ran] = sample ? [sample.run, sample.results]
        : await runTests(session, snap, cfg, targets, "suite.xml", SUITE_TIMEOUT);
    } finally {
      for (const c of canary) rmSync(c.path, { force: true });
    }
    // A test failing for a file left out, or a key's fake, is no failure of the project.
    const reported = kept(ran);
    // A failure or a skip beside a fake runs once more with the real key, in a copy no one else reads: outcomes only.
    const real = reported && leftOut?.fakedKeys.length && leftOut.repo ? await rerunWithRealKeys(session, snap, cfg, {
      source: { repo: leftOut.repo, head: null }, fakedKeys: leftOut.fakedKeys, tests: rerunCandidates([reported]), all: [reported],
      target: (t) => t.fileAttr || null, budget: leftOut.reruns ?? keyReruns(), timeout: SUITE_TIMEOUT, ...(boundary ? { id: (x: string) => boundary.mask(x) } : {}) })
      : undefined;
    let all = reported && leftOut ? markUnproven(reported, { leftOut: leftOut.secret, fakedKeys: leftOut.fakedKeys, all: leftOut.all,
      ...(real ? { real } : {}) }) : reported;
    // A runner that still picks up a file under .arnx/ (the canary, under its stored name) is noted, never the
    // developer's to change: what it ran there does not count, and arnx keeps working (check runs kept files by name).
    const inArnx = (t: TestResult) => [t.fileAttr, t.testId].some((x) => x && /(?:^|\/)\.arnx\//.test(x));
    const collectsArnx = (all ?? []).some(inArnx);
    if (collectsArnx) all = all!.filter((t) => !inArnx(t));
    // A project with no tests of its own has no suite to run: arnx's one-line test, which reviews depend on anyway,
    // proves the environment instead.
    if (!targets.length && !all?.length && cfg.language !== "rust" && !hasOwnTests(cfg, snap)) {
      return await noOwnTests(session, snap, cfg, all === null, tailOf, quick);
    }
    let [ok, verdict, counts] = suiteOk(all, cfg, accepted, acceptedTestsDir, baseline);
    // Tests failing outside the baseline run once more, by file: one that passes then is flaky, not a new failure.
    // Right after setup (`passedBefore`) the suite passed them moments ago, so one failing again is flaky too; not
    // when most of the suite fails, which is the environment.
    const again = rerun && !ok && baseline !== "record" && counts.unexpected.length
      ? [...new Set((all ?? []).filter((t) => counts.unexpected.includes(t.testId)).map((t) => t.fileAttr))] : [];
    if (again.length && !again.includes("") && again.length <= APART_MAX) {
      const passed = new Set<string>();
      const [, second] = await runTests(session, snap, cfg, again, "again.xml", SUITE_TIMEOUT);
      for (const t of kept(second) ?? []) if (t.outcome === "passed") passed.add(testKey(t.testId));
      const most = counts.unexpected.length > counts.passed;
      const flaky = counts.unexpected.filter((id) => passed.has(testKey(id)) || (passedBefore && !most));
      if (flaky.length) {
        const extra = (all ?? []).filter((t) => flaky.includes(t.testId)).map((t) => ({ ...entryOf(t), flaky: true as const }));
        [ok, verdict, counts] = suiteOk(all, cfg, accepted, acceptedTestsDir, [...baseline as BaselineTest[], ...extra]);
        counts.flaky = flaky;
        counts.left = counts.left.filter((id) => !flaky.includes(id));
      }
    }
    // A quick look ran a few files: baseline tests outside them did not run, so they have not left it.
    if (sample) {
      const ran = new Set((all ?? []).map((t) => testKey(t.testId)));
      counts.left = counts.left.filter((id) => ran.has(testKey(id)));
      counts.listed = listedFiles;
    }
    const fetched = all === null ? npxDownload(result.output) : null;
    const summary = fetched ? `the suite produced no report: ${npxText(fetched)}`
      : all === null ? noReport(result, cfg) : listed + verdict + (collectsArnx ? ARNX_COLLECTED : "");
    // Accepted tests that fail as pinned are not the environment's to fix: diagnosis and retries leave them out.
    const results = withoutAccepted(all, cfg, accepted, acceptedTestsDir);
    let said = "";
    const skips = skipReasons(results);
    const failing = failingFiles(results, cfg);
    // While setup records the baseline, a suite that runs gets the same look at its failures as one that does not:
    // those that look like the environment go back to the agent before they are recorded.
    if (!ok || (baseline === "record" && counts.failed.length)) {
      // A failure that names a file the snapshot left out: nothing in review.yaml brings it back, only the user can. One
      // .arnxignore leaves out goes into the sandbox; for a secret-looking one or a fake, setup stops only when no test can run.
      const needed = leftOut?.paths.length ? missingLeftOut([result.output,
        ...(results ?? []).filter((t) => failedTest(t) || t.needs).map((t) => t.message)], leftOut.paths, leftOut.all) : [];
      const named = (counts.unproven ?? []).map((u) => u.needs).filter((p) => p !== A_FAKED_FILE);
      const guessed = (counts.unproven ?? []).some((u) => u.needs === A_FAKED_FILE) ? leftOut?.fakedKeys ?? [] : [];
      if (needed.some((p) => !leftOut!.secret.includes(p)) || (!counts.passed && (needed.length || named.length || guessed.length))) {
        tailOf(result.output);
        throw new LeftOutNeeded([...new Set([...needed, ...named, ...guessed])]);
      }
      const hints = diagnose(results, cfg, snap);
      // Failing files with no other explanation run once more, together and without the rest of the suite: those
      // that pass then depend on a file left out. Only after a whole-suite run, when other files did run.
      const apart = targets.length || sample ? [] : unexplainedFiles(results, cfg, hints);
      const others = (results ?? []).some((t) => t.fileAttr && !apart.includes(t.fileAttr));
      if (apart.length && apart.length <= APART_MAX && others) {
        const [, again] = await runTests(session, snap, cfg, apart, "apart.xml", SUITE_TIMEOUT);
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
    const [probed, tail, ignored] = await probe(session, snap, cfg);
    if (ignored) return [false, `${summary}; but ${ignored}`, tailOf(tail), skips, failing, "", counts] as Out;
    if (probed && cfg.typecheck) {
      // The type check runs once the suite runs. It is information: whatever it says, the tests ran.
      const t = await typecheckNote(session, cfg, quick, workspaceNames(snap));
      const kept = { ...counts, ...t.problem ? { typecheckProblem: t.problem } : {},
        ...t.gaps.length ? { typeGaps: t.gaps } : {}, ...t.errors === undefined ? {} : { typeErrors: t.errors } };
      return [true, `${summary}${t.note}`, tailOf(t.problem ? t.output : result.output), skips, failing, said, kept] as Out;
    }
    return probed ? [true, summary, tailOf(result.output), skips, failing, said, counts] as Out
      : [false, `${summary}; but a one-line test placed in ${writeDirOf(cfg)}/ was not run: the runner leaves ` +
        "that folder out (jest roots, vitest include, testMatch) or does not collect tests named the usual way (an " +
        "option in test_command). Either set tests_dir to a new folder the runner includes, or fix test_command",
        tailOf(tail), skips, failing, "", counts] as Out;
  }, undefined, key, swap);
  return [ok, said(summary), tail, skips.map(said), failing, said(hints), counts];
}

/** The type check's part of a proof's summary ("; type check: ..."): what it found, or why it gave nothing. It never
 * fails the proof (information, like a review's). `problem`: it did not run, timed out, or failed without reporting
 * a type error; `output`: the end of what it printed. */
export async function typecheckNote(session: Runner, cfg: ReviewConfig, quick = false, workspace: string[] = [])
  : Promise<{ note: string; problem?: string; output: string; gaps: TypeGap[]; errors?: number }> {
  const timeout = quick ? QUICK_TYPECHECK_TIMEOUT : TYPECHECK_TIMEOUT;
  let t;
  try {
    t = await runTypecheck(session, cfg, timeout);
  } catch (e) {
    if (!(e instanceof OutOfTime)) throw e;
    return { note: "; type check: not run, out of time", problem: "not run, out of time", output: "", gaps: [] };
  }
  if (t.status === "failed") {
    const problem = "failed without reporting a type error (it could not start, or its output is not tsc's)";
    return { note: `; type check: ${problem}`, problem, output: t.output, gaps: [] };
  }
  if (t.status === "timed-out") {
    const problem = `timed out after ${timeout} s`;
    return { note: `; type check: ${problem}`, problem, output: t.output, gaps: [] };
  }
  const errors = t.errors.length;
  return { note: `; type check: ${errors ? plural(errors, "type error") : "no type errors"}`, output: "",
    gaps: typeGaps(t.errors, workspace), errors };
}

/** runSuite's answer for a project with no tests of its own: its environment proven by arnx's one-line test (and the
 * type check), or why that test did not run. `silent`: the whole-suite run wrote no report. */
async function noOwnTests(session: Runner, snap: string, cfg: ReviewConfig, silent: boolean, tailOf: (s: string) => string,
                          quick = false)
  : Promise<[boolean, string, string, string[], string[], string, SuiteCounts]> {
  const none = noCounts();
  const [probed, tail, ignored] = await probe(session, snap, cfg);
  if (!probed) {
    return [false, `the project has no tests of its own${silent ? " (the suite wrote no report)" : ""}, and arnx's ` +
      `one-line test placed in ${writeDirOf(cfg)}/ did not run either: install the runner in install (the project may ` +
      "not list it; installing it outside the repository, for example under /opt/deps, keeps the manifests as they " +
      "are) and give a test_command that runs it on {targets}. Do not write tests in test_command: arnx writes them",
      tailOf(tail), [], [], "", { ...none, stoppedAt: "config" }];
  }
  if (ignored) return [false, `${NO_OWN_TESTS}; but ${ignored}`, tailOf(tail), [], [], "", { ...none, stoppedAt: "config" }];
  if (cfg.typecheck) {
    const t = await typecheckNote(session, cfg, quick, workspaceNames(snap));
    return [true, `${NO_OWN_TESTS}${t.note}`, tailOf(t.problem ? t.output : tail), [], [],  "",
      { ...none, ...t.problem ? { typecheckProblem: t.problem } : {}, ...t.gaps.length ? { typeGaps: t.gaps } : {},
        ...t.errors === undefined ? {} : { typeErrors: t.errors } }];
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
export async function probe(session: Pick<Runner, "run">, snap: string, cfg: ReviewConfig): Promise<[boolean, string, string]> {
  const p = await probeRun(session, snap, cfg, writeDirOf(cfg), "probe.xml", PROBE_TIMEOUT);
  return [p.seen, maskPrivateKeys(p.result.output).slice(-OUTPUT_TAIL), p.seen ? ignoredTargets(p.results, p.files, cfg) : ""];
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

/** The code a run sees: the snapshot (snapshotDigest) and the sandbox-only files placed in it for each run. */
const withSandbox = (digest: string, sandbox: Iterable<string>) => [digest, ...[...sandbox].sort()].join("\0");

/** One project's proof: its suite counts, why tests were skipped, and the tests it fails today (recorded as its
 * baseline; absent for a project proved earlier). */
export interface ProjectProof { name: string; summary: string; skips: string[]; failed?: BaselineTest[];
  /** Tests that need a file left out or a real key: in no baseline. */
  unproven?: Unproven[];
  /** Tests its test_command leaves out, kept by the agent (coverageGap). */
  gap?: string;
  /** The type check did not run, timed out or failed without reporting: said at approval, never a failed proof. */
  typecheckProblem?: string;
  /** Modules the type check cannot see: a generated client, an unbuilt package. */
  typeGaps?: TypeGap[];
  typeErrors?: number }

/** The whole-suite run of setup that proved a project, on the file and the code it ran with: `digest`, the project's
 * part of review.yaml, notes left out (runDigest); `env`, what its suite needs (envDigest); `snapshot`, the code (withSandbox)
 * and whether it held untracked files. Approval right after setup takes it as the project's proof while all of these
 * are unchanged (approveFile's `afterSetup`). `after`: what the run's summary says after its counts (the type check). */
export interface SetupRun { name: string; digest: string; env: string; snapshot: string; untracked: boolean;
  summary: string; after: string; skips: string[]; counts: SuiteCounts }

/** The reason under uncovered of a project setup had not proven when it reached its time limit. */
export const TIME_LEFT_OUT = "setup reached its time limit";

/** Why setup stops when its only projects are web UI apps whose runs failed (SetupResult stop WEB_UI_STOP). */
export const ONLY_WEB_UI = "only web UI here, which arnx does not set up";
export const WEB_UI_STOP = "web-ui";
/** Setup stopped because Docker's disk is full: no try or model call can help. */
export const DISK_FULL_STOP = "disk-full";
/** A quick setup's stop when no project arnx can set up owns a changed file. */
export const NOTHING_TO_TEST = "nothing-to-test";

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
  /** Files kept with a stand-in for each key-shaped string (the real values never left this machine). */
  standIns: string[];
  /** Files kept with a fake for their private key. */
  fakedKeys: string[];
  /** Files .arnxignore leaves out that the tests need: in the sandbox only (review.yaml sandbox_only). */
  sandboxed: string[];
  /** The failing tests (outside known_failing) of the last suite that ran with some tests passing: setup got the
   * suite running, the current code fails them. Empty when the last run never got that far. */
  failing: string[];
  /** The project `failing` belongs to (null with none). */
  failingProject: string | null;
  /** Why the last attempt did not go through, in a few words (a refused proposal, a suite that does not run,
   * ONLY_WEB_UI). */
  problem: string;
  /** Files the snapshot left out that the tests need: setup stopped at the run that named them (stop "stopped"). */
  needed?: NeededFile[];
  /** The project setup was on when its time ran out (stop "time"), unless it had been proven. */
  running?: string;
  /** At the time limit with no file accepted, setup accepted the projects proven by then: the others, listed under
   * uncovered (TIME_LEFT_OUT) for `arnx setup --add`. Absent otherwise. */
  setAside?: string[];
  /** A quick setup's projects left for later though they use a file the change edits: not reviewed until set up. */
  waiting?: string[];
  /** The run that proved each project setup proved (kept ones have none), in file order. */
  runs: SetupRun[];
}

/** A file a run's failure needs: `secret`, left out as secret-looking; `faked`, in the sandbox with a fake for its key; otherwise
 * matched by .arnxignore. */
export interface NeededFile { path: string; secret: boolean; faked?: true }

/** The files the snapshot left out (`secret`, those left out as secret-looking), those with a key's fake, and the repository's
 * files (to tell a shared name apart), for runSuite. */
export interface LeftOut { paths: string[]; secret: string[]; fakedKeys: string[]; all: string[];
  /** The working tree the snapshot is of: where a rerun reads a faked file's real key (realkey.ts). */
  repo?: string;
  /** The command's reruns with a real key left: one setup, approve or baseline record shares them. */
  reruns?: KeyReruns }

/** What a later proof's snapshot lacks: what its runs may need and no change to review.yaml brings. */
const lackingOf = (taken: { withheld: Withheld[]; fakedKeys: string[] }, all: string[], repo: string): LeftOut => {
  const secret = taken.withheld.map((w) => w.path);
  return { paths: secret, secret, fakedKeys: taken.fakedKeys, all, repo, reruns: keyReruns() };
};

/** A run's failure names files the snapshot left out (repository paths). */
class LeftOutNeeded extends ArnxError {
  constructor(readonly files: string[]) {
    super(`the tests need ${files.join(", ")}, which the snapshot left out`);
  }
}

/** Why setup stopped, for a person and the agent: which files the tests need, and what left each one out. */
export function neededText(files: NeededFile[]): string {
  const secret = files.filter((f) => f.secret).map((f) => f.path);
  const faked = files.filter((f) => f.faked).map((f) => f.path);
  const ignored = files.filter((f) => !f.secret && !f.faked).map((f) => f.path);
  return "the tests need " + [secret.length ? `${secret.join(", ")}, which arnx left out as secret-looking (not sent, ` +
    "not in the sandbox)" : "", faked.length ? `the real key in ${faked.join(", ")}, a fake in the sandbox` : "",
    ignored.length ? `${ignored.join(", ")}, which .arnxignore leaves out` : ""]
    .filter(Boolean).join(", and ");
}

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
  description: "Submit the whole review.yaml. Accepted when no file is owned by two projects and every project runs: " +
    "propose itself runs each project whose part of the file changed since try_project proved it (a project's part: " +
    "its own entry and the services it uses). Source files outside every project come back once, by folder; then " +
    "arnx lists them under uncovered itself.",
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
  /** The unexplained files by folder (sourceGroups), each with the reason arnx lists it under uncovered with. */
  groups: SourceGroup[];
}

/** arnx's own folder: never part of the coverage map, nor of any setup check that counts files. */
export const isArnxPath = (p: string) => p === ".arnx" || p.startsWith(".arnx/");

/** The files the coverage map counts: the snapshot's (tracked, and with `untracked` untracked ones git does not
 * ignore), minus .arnxignore, secret files and .arnx/; `untracked` holds those not committed. */
export function coverageFiles(repo: string, untracked = false): { files: string[]; untracked: Set<string> } {
  const ignored = loadIgnore(repo);
  const tree = workingTreeFiles(repo, untracked);
  if (!hasCommits(repo)) tree.untracked.clear();
  return { files: tree.files.filter((p) => !ignored(p) && !isSecretPath(p) && !isArnxPath(p)), untracked: tree.untracked };
}

/** Source files outside every project, by folder, with the reason arnx lists them under uncovered with. */
export interface SourceGroup { path: string; reason: string; files: number }

// Reasons arnx states itself for a group of source files no project owns or uses (defined beside routing).
export { NO_TESTS, SCRIPTS };
const SCRIPT_DIRS = new Set(["scripts", "script", "bin", "tools", "tool", "hack", "ci", ".github", ".husky", "devtools"]);

/** Whether tests belong to `path` among `files`: a folder ("/dir/") holds a test file; a file is one, or sits in a
 * folder with one. Groups and agent-written entries are read the same way. */
export function holdsTests(path: string, files: string[]): boolean {
  const rel = path.replace(/^\//, "");
  if (rel.endsWith("/")) return files.some((f) => f.startsWith(rel) && isTestPath(f));
  if (isTestPath(rel)) return true;
  const dir = posix.dirname(rel);
  return files.some((f) => isTestPath(f) && posix.dirname(f) === dir);
}

/** Whether an entry under uncovered holds tests among `files`: holdsTests, or a test file its pattern matches. */
export function entryHoldsTests(path: string, files: string[]): boolean {
  const under = matcher(path);
  return holdsTests(path, files) || files.some((f) => isTestPath(f) && under(f));
}

/** `yaml` with the agent's own "no tests" entries under uncovered corrected the same way: a path that holds test
 * files among `files` is "not set up", never "no tests". */
export function honestReasons(yaml: string, files: string[]): string {
  const doc = parseDocument(yaml);
  const list = doc.errors.length ? null : doc.get("uncovered");
  if (!isSeq(list)) return yaml;
  let changed = false;
  for (const item of list.items) {
    if (!isYamlMap(item)) continue;
    const [path, reason] = [item.get("path"), item.get("reason")];
    if (typeof path !== "string" || typeof reason !== "string" || reason.trim().toLowerCase() !== NO_TESTS) continue;
    if (entryHoldsTests(path, files)) {
      item.set("reason", NOT_SET_UP);
      changed = true;
    }
  }
  return changed ? doc.toString({ flowCollectionPadding: false, lineWidth: 0 }) : yaml;
}

/** `unexplained` grouped by the shallowest folder that holds no file a project owns or uses (`claimed`); a file with
 * no such folder above it is a group of its own. A group that holds test files (among `all`) is not "no tests": the
 * tests exist, nothing runs them yet. */
export function sourceGroups(unexplained: string[], claimed: string[], all: string[] = []): SourceGroup[] {
  const taken = new Set<string>();
  for (const f of claimed) {
    const parts = f.split("/");
    for (let i = 1; i < parts.length; i++) taken.add(parts.slice(0, i).join("/"));
  }
  const groups = new Map<string, SourceGroup>();
  for (const f of unexplained) {
    const parts = f.split("/");
    let path = `/${f}`, top = "";
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join("/");
      if (!taken.has(dir)) {
        path = `/${dir}/`;
        top = parts[i - 1]!;
        break;
      }
    }
    const g = groups.get(path) ?? { path, reason: holdsTests(path, all) ? NOT_SET_UP
      : SCRIPT_DIRS.has(top) ? SCRIPTS : NO_TESTS, files: 0 };
    g.files += 1;
    groups.set(path, g);
  }
  return [...groups.values()];
}


/** What the user reads for a web UI app whose counted runs all stopped at listing. */
function listingStopLine(name: string, runs: number, error: string): string {
  return `${name}: its tests did not list in ${runs} tries: ${error}`;
}

/** Where the web UI app `name`, whose runs failed, goes under uncovered: the folders and files of its source (of
 * any file when it has none) that no other project in `f` owns or uses, each folder the shallowest that holds none of
 * theirs. An app at the repository root next to other projects lists its own paths, never `**`. */
export function webUiPaths(f: ReviewFile, name: string, files: string[]): string[] {
  const app = f.projects.find((p) => p.name === name);
  if (!app) return [];
  const owns = matcher(app.owns.join("\n"));
  const others = f.projects.filter((p) => p.name !== name)
    .map((p) => ({ owns: matcher(p.owns.join("\n")), uses: matcher(p.uses.join("\n")) }));
  const claimed = files.filter((x) => others.some((o) => o.owns(x) || o.uses(x)));
  const taken = new Set(claimed);
  const mine = files.filter((x) => owns(x) && !taken.has(x));
  const source = mine.filter((x) => SOURCE.test(x));
  return sourceGroups(source.length ? source : mine, claimed).map((g) => g.path);
}

/** Which project owns or uses each file a snapshot holds (tracked, and with `untracked` untracked ones git does not
 * ignore; minus .arnxignore and secret files), and what is left out. Only source files must be explained;
 * documentation, configuration and data may stay unmentioned. Untracked files are counted (only when setup and reviews
 * read them) but never refuse a proposal: a scratch file neither appears in unexplained nor in overlaps, so what is
 * accepted depends on committed files alone. With no commits yet every file is the repository's (and the change a
 * review looks at), so none counts as untracked. arnx's own .arnx/ (accepted tests among it) is never counted. */
export function coverageMap(repo: string, file: ReviewFile, untracked = false): Coverage {
  const tree = coverageFiles(repo, untracked);
  const files = tree.files;
  const claimed: string[] = [];
  const projects = file.projects.map((p) => ({ name: p.name, config: p, owns: matcher(p.owns.join("\n")),
    uses: matcher(p.uses.join("\n")), owned: 0, used: 0, untracked: { owned: 0, used: 0 } }));
  const uncovered = file.uncovered.map((u) => ({ ...u, test: matcher(u.path), files: 0, untracked: 0 }));
  const unexplained: string[] = [];
  const overlaps: string[] = [];
  // Files in languages arnx does not review need no explaining: they count as uncovered on their own, per language.
  const others = new Map<string, { files: number; untracked: number }>();
  for (const f of files) {
    const fresh = tree.untracked.has(f);
    const owners = projects.filter((p) => p.owns(f));
    const isListed = uncovered.some((u) => u.test(f));
    const users = projects.filter((p) => !p.owns(f) && !usesBlocked(p.config, f, isListed) && p.uses(f));
    owners.forEach((p) => { p.owned += 1; p.untracked.owned += fresh ? 1 : 0; });
    users.forEach((p) => { p.used += 1; p.untracked.used += fresh ? 1 : 0; });
    if (owners.length || users.length) claimed.push(f);
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
    ({ path, reason, files: n, ...(untracked ? { untracked } : {}) })), unexplained, overlaps,
  groups: sourceGroups(unexplained, claimed, files) };
}

/** What a project's suite needs to run, apart from which files are set aside: a retry that changes none of it can
 * rerun just the files that failed. */
export function envDigest(cfg: ReviewConfig): string {
  return JSON.stringify([cfg.image, cfg.workdir, cfg.install, cfg.testCommand, cfg.services, cfg.env, cfg.testsDir,
    cfg.installRoot, cfg.runner, cfg.typecheck ?? null, cfg.depsDir ?? null, cfg.testFiles ?? null]);
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

/** `text` with tests_dir set on each project that has none, from its runner's configuration in the snapshot `snap`
 * (testsDirFor), the projects in `keep` aside (they must stay as they are); and what was set, by project. */
export function withTestsDirs(text: string, snap: string, keep: ReadonlySet<string> = new Set())
  : [string, (TestsDirChoice & { project: string })[]] {
  let f: ReviewFile;
  try {
    f = parseReviewFile(text);
  } catch (e) {
    if (!(e instanceof ArnxError)) throw e;
    return [text, []];
  }
  const doc = parseDocument(text);
  const set: (TestsDirChoice & { project: string })[] = [];
  for (const cfg of f.projects) {
    const spec = f.legacy ? f.raw : (f.raw.projects as Record<string, Record<string, unknown>> | undefined)?.[cfg.name];
    if (keep.has(cfg.name) || !spec || "tests_dir" in spec) continue;
    const c = testsDirFor(snap, cfg);
    if (!c) continue;
    doc.setIn(f.legacy ? ["tests_dir"] : ["projects", cfg.name, "tests_dir"], c.dir);
    if (c.testFiles) doc.setIn(f.legacy ? ["test_files"] : ["projects", cfg.name, "test_files"], c.testFiles);
    set.push({ project: cfg.name, ...c });
  }
  return set.length ? [doc.toString({ flowCollectionPadding: false, lineWidth: 0 }), set] : [text, []];
}

/** `text` with tests_dir (and test_files) put on each project in `places` that sets no tests_dir; and whether it did. */
export function withPlacements(text: string, places: ReadonlyMap<string, Placement>): [string, boolean] {
  if (!places.size) return [text, false];
  let f: ReviewFile;
  try {
    f = parseReviewFile(text);
  } catch (e) {
    if (!(e instanceof ArnxError)) throw e;
    return [text, false];
  }
  const doc = parseDocument(text);
  let changed = false;
  for (const cfg of f.projects) {
    const place = places.get(cfg.name);
    const spec = f.legacy ? f.raw : (f.raw.projects as Record<string, Record<string, unknown>> | undefined)?.[cfg.name];
    if (!place || !spec || "tests_dir" in spec) continue;
    const at = f.legacy ? [] : ["projects", cfg.name];
    doc.setIn([...at, "tests_dir"], place.testsDir);
    if (place.testFiles) doc.setIn([...at, "test_files"], place.testFiles);
    changed = true;
  }
  return changed ? [doc.toString({ flowCollectionPadding: false, lineWidth: 0 }), true] : [text, false];
}

/** `text` with the projects in `drop` taken out and `add` appended under uncovered (entries whose path is listed
 * already are left out); `text` itself when nothing changes. */
export function withUncovered(text: string, add: { path: string; reason: string }[], drop: string[] = []): string {
  let doc = parseDocument(text);
  if (doc.errors.length) return text;
  // A project taken out may hold the anchor other projects' aliases name (`<<: *base`): the file is written out in
  // full first.
  if (drop.length && hasAlias(doc)) {
    text = plainReviewYaml(text);
    doc = parseDocument(text);
  }
  let changed = false;
  for (const name of drop) {
    if (doc.hasIn(["projects", name])) {
      doc.deleteIn(["projects", name]);
      changed = true;
    }
  }
  const before = (parseDocument(text).toJS() as { uncovered?: unknown } | null)?.uncovered;
  const listed = new Set(Array.isArray(before) ? before.map((u: { path?: unknown } | null) => u?.path) : []);
  const fresh = add.filter((u, i) => !listed.has(u.path) && add.findIndex((x) => x.path === u.path) === i);
  if (fresh.length) {
    if (!doc.has("uncovered") || doc.get("uncovered") === null) doc.set("uncovered", doc.createNode([]));
    for (const u of fresh) doc.addIn(["uncovered"], doc.createNode({ path: u.path, reason: u.reason }));
    changed = true;
  }
  return changed ? doc.toString({ flowCollectionPadding: false, lineWidth: 0 }) : text;
}

/** A project proven in this setup: its settings, the services it lists, and the file's allowed env names. */
export interface ProvenBlock { spec: unknown; services: Record<string, unknown>; allow: string[] }

/** A project's working folder as the file names it: "./" and edge slashes dropped, an omitted root is ".". */
const folder = (root: unknown): string => {
  const p = (typeof root === "string" ? root : ".").replace(/\/+/g, "/").replace(/^(\.\/)+/, "").replace(/^\/+|\/+$/g, "");
  return p === "" ? "." : p;
};
const sameOrNested = (a: string, b: string) => a === "." || b === "." || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);

/** `yaml` with each project in `blocks` that it leaves out put back, with its services, and its `/<root>/` entry
 * under uncovered taken out. A project is not put back (the new file wins; `replaced` names it) when its folder
 * overlaps one of another project in the file, "." being the ancestor of every folder; nor when the file defines a
 * service of that name differently. A project named in `revert` that the file has too gets its block replaced by the
 * proven one, on the same terms (its own old services give way; another project's do not). */
export function restoreProven(yaml: string, blocks: Map<string, ProvenBlock>, o: { revert?: ReadonlySet<string> } = {}):
  { yaml: string; restored: string[]; replaced: string[] } {
  const doc = parseDocument(yaml);
  if (doc.errors.length || !blocks.size) return { yaml, restored: [], replaced: [] };
  const js = doc.toJS() as { projects?: Record<string, { root?: unknown }>; services?: Record<string, unknown>;
    uncovered?: { path?: unknown }[]; allow_env_names?: string[] } | null;
  if (!js || !js.projects || typeof js.projects !== "object") return { yaml, restored: [], replaced: [] };
  const restored: string[] = [];
  const replaced: string[] = [];
  const othersUse = (self: string, k: string) => Object.entries(js.projects!).some(([n, p]) => n !== self &&
    Array.isArray((p as { services?: unknown })?.services) && ((p as { services: unknown[] }).services).includes(k));
  for (const [name, b] of blocks) {
    const reverting = name in js.projects && !!o.revert?.has(name);
    if (name in js.projects && !reverting) continue;
    const root = folder((b.spec as { root?: unknown } | null)?.root);
    const others = Object.entries(js.projects).filter(([n]) => n !== name).map(([, p]) => folder(p?.root));
    if (others.some((r) => sameOrNested(r, root))) {
      replaced.push(name);
      continue;
    }
    const clash = Object.entries(b.services).some(([k, v]) => js.services?.[k] !== undefined &&
      JSON.stringify(js.services[k]) !== JSON.stringify(v) && (!reverting || othersUse(name, k)));
    if (clash) continue;
    if (reverting) {
      for (const k of Object.keys(b.services)) {
        if (js.services?.[k] === undefined) continue;
        doc.deleteIn(["services", k]);
        delete js.services[k];
      }
    }
    doc.setIn(["projects", name], doc.createNode(b.spec));
    js.projects[name] = b.spec as { root?: unknown };
    for (const [k, v] of Object.entries(b.services)) {
      if (js.services?.[k] !== undefined) continue;
      doc.setIn(["services", k], doc.createNode(v));
      (js.services ??= {})[k] = v;
    }
    const names = b.allow.filter((n) => !(js.allow_env_names ?? []).includes(n));
    for (const n of names) {
      if (!doc.has("allow_env_names")) doc.set("allow_env_names", doc.createNode([]));
      doc.addIn(["allow_env_names"], n);
      (js.allow_env_names ??= []).push(n);
    }
    const list = doc.get("uncovered");
    if (isSeq(list)) {
      for (let i = list.items.length - 1; i >= 0; i--) {
        const u = (list.items[i] as { toJSON?: () => unknown }).toJSON?.() as { path?: unknown } | undefined;
        if (typeof u?.path === "string" && folder(u.path) === root && /\/$/.test(u.path)) list.items.splice(i, 1);
      }
    }
    restored.push(name);
  }
  return restored.length ? { yaml: doc.toString({ flowCollectionPadding: false, lineWidth: 0 }), restored, replaced }
    : { yaml, restored, replaced };
}

/** What restoreProven needs to put project `name` back: its settings, its services and the allowed env names. */
function provenBlock(f: ReviewFile, name: string): ProvenBlock {
  const project = f.projects.find((p) => p.name === name)!;
  const services = f.raw.services && typeof f.raw.services === "object"
    ? Object.fromEntries(Object.entries(f.raw.services as Record<string, unknown>)
      .filter(([k]) => project.services.some((s) => s.name === k))) : {};
  const allow = Array.isArray(f.raw.allow_env_names) ? f.raw.allow_env_names.map(String) : [];
  return { spec: structuredClone((f.raw.projects as Record<string, unknown>)[name]), services: structuredClone(services), allow };
}

function hasAlias(doc: ReturnType<typeof parseDocument>): boolean {
  let found = false;
  visit(doc, { Alias: () => { found = true; return visit.BREAK; } });
  return found;
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

/** Most folder groups named to the setup agent at once. */
const GROUPS_SHOWN = 30;

/** What the setup agent is told, once, about source files outside every project. */
export function placesText(groups: SourceGroup[]): string {
  const more = groups.length - GROUPS_SHOWN;
  return "source files outside every project, by folder (with the reason arnx lists them under uncovered with):\n" +
    groups.slice(0, GROUPS_SHOWN).map((g) => `- ${g.path} (${plural(g.files, "file")}): ${g.reason}`).join("\n") +
    (more > 0 ? `\n- and ${more} more` : "") + "\nPut those a project tests under its owns or uses; propose again " +
    "and arnx lists the rest under uncovered itself.";
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
export function setupHintsFor(d: Detection, browser: BrowserSuite[] = []): string {
  const languages = [...new Set(d.candidates.map((c) => c.language))].filter((l) => LANGUAGES.includes(l as AdapterId));
  const advice = (languages.length ? languages : ["python"]).flatMap((l) => {
    try {
      const a = getAdapter(l);
      return [`Advice for ${a.words(a.defaultRunner).language} projects:\n${a.setupHints}`];
    } catch {
      return [];
    }
  });
  const suites = browser.length ? [`Browser tests (not set up; arnx lists them under uncovered itself): ` +
    browser.map((s) => `${s.path} (${s.tool})`).join(", ")] : [];
  return [describeDetection(d), ...suites, ...advice, SHARED_ENV].join("\n\n");
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
  indexer?: typeof projectIndex;
  /** Where the exec tool runs its commands (default: a container on the project's image). */
  execFactory?: ExecFactory;
  /** Setup's time limit, which its proof shares (default: `setup_minutes` from now). */
  timeLimit?: TimeLimit;
  /** A quick setup, for a first review: only the projects that own one of these changed files are set up (the
   * others wait under uncovered, NOT_SET_UP), each proven by a quick look (runSuite `quick`). The draft is proposed
   * as it is first, with no model; only when it does not go through is the agent asked. With `add`, the projects
   * join review.yaml as it is. `attempt`: setup's last unproven attempt, whose projects the draft starts from. */
  quick?: { files: string[]; attempt?: string } };

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

/** A working run kept while its note went back to the agent: the file it ran with, what records its proof, the type
 * check record for later reviews, and its line and event when it stands. */
interface Standing { file: string; prove: () => void; remember: () => void; summary: string; said: string;
  event: Record<string, unknown> }

/** A setup's events go to `<outDir>/<id>/events.jsonl`, the id made like a review's. */
export async function runSetup(repo: string, settings: Settings, agentModel: AgentModel | null, o: SetupOptions)
  : Promise<SetupResult> {
  const id = new Date().toISOString().slice(0, 10).replaceAll("-", "") + "-" + randomHex(3);
  const log = new EventLog(join(o.outDir, id, EVENTS_FILE), id);
  // The run's filter, before any event: the brain's, or the model's; takeSnapshot's values fill it below.
  const boundary = o.brain?.boundary ?? (agentModel && boundaryOf(agentModel)) ?? new Boundary();
  log.filter = boundary;
  const now = () => performance.now();
  const limit = o.timeLimit ?? { at: now() + settings.setupMinutes * 60_000, now, minutes: settings.setupMinutes };
  return withEvents(log, () => withTimeLimit(limit, () => setupBody(repo, settings, agentModel, o, limit, boundary)));
}

async function setupBody(repo: string, settings: Settings, agentModel: AgentModel | null, o: SetupOptions,
                         limit: TimeLimit, boundary: Boundary): Promise<SetupResult> {
  const say = o.progress ?? (() => {});
  mkdirSync(o.outDir, { recursive: true });
  sweepRealKeyCopies();
  const existing = o.project || o.add ? loadReviewFile(repo, { requireApproved: false }) : null;
  if (o.project && !existing!.projects.some((p) => p.name === o.project)) {
    throw new ArnxError(`no project ${o.project} in .arnx/review.yaml`);
  }
  emit("setup.started", { arnx_version: VERSION, model: o.brain?.label ?? refString(setupRef(settings)),
    project: o.project ?? null, add: !!o.add, minutes: limit.minutes });
  const keep = new Map(existing ? existing.projects.filter((p) => p.name !== o.project)
    .map((p) => [p.name, projectDigest(existing, p.name)] as const) : []);
  const state = { accepted: null as string | null, lastTried: null as string | null, summary: "no project tried",
    proven: new Map<string, string>(), provenBlocks: new Map<string, ProvenBlock>(), attempts: 0, tries: new Map<string, number>(), proofs: new Map<string, ProjectProof>(),
    final: null as ReviewFile | null, lastFailing: new Map<string, { env: string; files: string[] }>(),
    failing: [] as string[], failingProject: null as string | null, problem: "", needed: null as NeededFile[] | null,
    usesChecked: false, pathsChecked: false, pathHints: [] as UsesHint[],
    lastFile: null as string | null,
    // The project the last try was on, and whether a tool found too little time left to go on (OutOfTime).
    current: null as string | null, outOfTime: false, diskFull: false,
    // What went back to the agent once (failures that look like the environment, tests left out), per project, with the
    // run it came from: the same environment tried again goes on from that run without running the suite again.
    held: new Map<string, { env: string; files: string; shown: Set<string>; run: { digest: string; summary: string;
      skips: string[]; counts: SuiteCounts } }>(),
    // A run that went back to the agent for a note (tests test_command leaves out, a type check that failed, a type
    // gap), per project, newest last: if the time limit or the agent's budget or turns end setup before the project is
    // proven again, it stands as if tried again unchanged. A later failed try leaves it; a later proof replaces it.
    standing: new Map<string, Standing>(),
    // The whole-suite run that proved each project (SetupRun).
    runs: new Map<string, SetupRun>(),
    // The most tests a whole-suite run of each project reported, and the test_command that ran them.
    mostRan: new Map<string, { tests: number; command: string }>(),
    // The tests_dir arnx set on each project from its runner's configuration (withTestsDirs).
    placed: new Map<string, string>(),
    /** Where the runner's listing showed it collects each project's tests (once each): put into every file the agent
     * sends for a project that does not set its own tests_dir. */
    placements: new Map<string, Placement>(),
    // The environment of each project whose tests were listed before its whole suite ran (precheck.ts): tried again
    // unchanged, it runs the whole suite.
    looked: new Map<string, string>(),
    notice: "",
    // Source files outside every project went back to the agent once (by folder); the rest arnx lists itself.
    placesAsked: false,
    // The runs of each web UI app that counted (countsAsUiRun), and the apps listed as web UI (webUiPaths).
    uiRuns: new Map<string, number>(), webUi: new Set<string>(),
    // Per web UI app: how many counted runs stopped at listing and the last such error; what the user reads when all did.
    uiListingStops: new Map<string, { n: number; error: string }>(),
    // Projects try_project refused for the services they need (MANY_SERVICES).
    tooMany: new Map<string, string[]>(),
    waiting: [] as string[],
    // The environment of each project's last try, which exec runs in.
    lastTry: new Map<string, TriedEnv>() };
  // The stop's problem line when every project is a web UI app: the listing error when each one's counted runs all
  // stopped at listing, else the general line.
  const onlyWebUi = (names: string[]): string => {
    const lines = names.map((n) => {
      const s = state.uiListingStops.get(n);
      return s && s.n === state.uiRuns.get(n) ? listingStopLine(n, s.n, s.error) : null;
    });
    return lines.length && lines.every((l) => l) ? lines.join("; ") : ONLY_WEB_UI;
  };
  const tmp = tempDir("arnx-setup-");
  let exec: SetupExec | null = null;
  // Docker steps of this setup, with their durations.
  dockerSteps.log = (line) => {
    mkdirSync(o.outDir, { recursive: true });
    appendFileSync(join(o.outDir, "docker.jsonl"), JSON.stringify(line) + "\n");
    // The image a project's run uses, for exec.
    const tried = line.step === "image" && line.ok !== false ? state.lastTry.get(String(line.project)) : undefined;
    if (tried && typeof line.tag === "string") state.lastTry.set(String(line.project), { ...tried, image: line.tag });
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
  // The projects whose runs read a baked copy: exec's commands stay among its stand-ins too.
  const baked = new Set<string>();
  const factory: SessionFactory = <T>(cfg: ReviewConfig, snap: string, log: string, body: (r: Runner) => Promise<T>,
    ...rest: [string?, string?, Swap?]) => (o.sessionFactory ?? dockerSession)(cfg, snap, log, (session) => {
      const a = announce;
      announce = null;
      if (a) say(`${a.name}: running its suite (try ${a.n})`);
      if (session.copies) baked.add(cfg.name);
      else baked.delete(cfg.name);
      return body(session);
    }, ...rest);
  try {
    const snap = join(tmp, "repo");
    // Files the user allowed although they look like secrets: the approved file's, or a seed's before the first setup.
    const pins = existing ? secretPinsOf(existing.raw) : seedPins(repo);
    const untracked = !!o.untracked;
    // Files .arnxignore leaves out that the tests need: in the sandbox only. A fresh setup finds them again.
    const sandbox = new Set(existing ? sandboxOnlyOf(existing.raw) : []);
    const sandboxKey = () => [...sandbox].sort().join("\n");
    const { withheld, blanked, standIns, fakedKeys, secrets: replaced, suspects: found, standInList,
      standInValues } = takeSnapshot(repo, null, snap, pins,
      { untracked, sandbox: [...sandbox] });
    boundary.addScrubbed({ suspects: found, secrets: replaced });
    boundary.add(configSuspects(repo));
    // What the agent's file, commands and paths mean here. review.yaml keeps its stand-ins: only a run reads them as values.
    const swap = swapIn(boundary, snap);
    // The code every run of this setup sees, before any run writes into the snapshot (SetupRun).
    const code = snapshotDigest(snap);
    // Image keys come from the manifests as they were before any run wrote into the snapshot.
    copyManifests(snap, join(tmp, "manifests"));
    const keyOf = (cfg: ReviewConfig) => envKey(cfg, join(tmp, "manifests"));
    const accepted = settings.acceptedTestsDir;
    // Tests kept by `arnx accept` fail until their bugs are fixed: as pinned, they do not stop a project. One changed
    // since accept is `arnx check`'s to refuse, not a fault of the environment: said once, it does not stop setup.
    const pinsNow = acceptedPins(repo, o.localPins ?? null);
    const trusted = { ...pinsNow, changed: [] };
    if (pinsNow.changed.length) say(changedNote(pinsNow.changed));
    // What the snapshot left out: secret-looking files, and the files .arnxignore matches. A run that needs one of the
    // latter gets it in the sandbox; one that needs a secret-looking file stops setup (see LeftOutNeeded).
    const files = workingTreeFiles(repo, untracked).files;
    const ignoredFile = loadIgnore(repo);
    const secret = new Set(withheld.map((w) => w.path));
    const leftOut: LeftOut = { paths: [...secret, ...files.filter((p) => ignoredFile(p) && !secret.has(p) &&
      !sandbox.has(p))], secret: [...secret], fakedKeys, all: files, repo, reruns: keyReruns() };
    // Suites that run in a browser are never set up: listed under uncovered as browser tests.
    const readSnap = (rel: string) => {
      try {
        return readFileSync(join(snap, rel), "utf8");
      } catch {
        return "";
      }
    };
    const mapFiles = coverageFiles(repo, untracked).files;
    const browser = browserSuites(mapFiles, readSnap);
    const stopped = () => new StopRound(`stopped: ${state.problem}. Only the user can let ` +
      `${state.needed!.length === 1 ? "it" : "them"} in, so setup ends here; do not work around it.`);
    if (withheld.length) {
      say(`left out as secret-looking: ${leftOutBrief(withheld)}; if one is a test fixture, not a secret, allow ` +
        "it with `arnx allow-secret PATH` and run setup again");
    }
    if (blanked.length) say(`comment lines blanked as secret-looking: ${describeBlanked(blanked)}`);
    // The certain values' stand-ins, which no file of the agent's may name; and where they stand, for the developer.
    const standInNames = new Set(standInValues);
    const standRows: StandInRow[] = [...standInList];
    const listStandIns = (files: string[]) => {
      const at = o.outDir ? writeStandIns(o.outDir, standRows) : null;
      if (files.length) say(at ? standInsLine(files, at) : `stand-ins in ${someNames(files)}, real values kept here`);
    };
    listStandIns(standIns);
    if (fakedKeys.length) say(fakedKeysText(fakedKeys));
    if (withheld.length || blanked.length || standIns.length) {
      emit("setup.withheld", { files: withheld.map((w) => w.path), blanked: blanked.map((b) => b.path),
        stand_ins: standIns });
    }
    // What arnx adds to the agent's file: the user's allow-list and the sandbox-only files.
    const ours = () => (pins.length ? secretPinsYaml(pins) : "") + (sandbox.size ? sandboxYaml([...sandbox]) : "");
    const withOurs = (yaml: string) => ours() ? `${yaml.trimEnd()}\n${ours()}` : yaml;
    const current = existing ? readFileSync(reviewConfigPath(repo), "utf8") : "";
    // The agent's file, with the user's allow-list added: the agent may not write one.
    const parse = (args: Record<string, unknown>): { f: ReviewFile; text: string; yaml: string } | string => {
      if (typeof args.yaml !== "string") return "invalid: yaml must be a string";
      const [kept, dropped] = withoutKnownFailing(args.yaml, new Set(keep.keys()));
      if (dropped) {
        state.notice = "(known_failing is not used: arnx records each failing test itself, so it was taken out of the " +
          "file.)\n";
      }
      // A project without tests_dir gets the folder its runner's configuration collects, said once to the agent.
      let [yaml, placed] = withTestsDirs(kept, snap, new Set(keep.keys()));
      for (const p of placed.filter((x) => state.placed.get(x.project) !== x.dir)) {
        state.placed.set(p.project, p.dir);
        state.notice += `(tests_dir of ${p.project} set to ${p.dir}: the default folder lies outside its ${p.why}.)\n`;
        if (p.testFiles) state.notice += `(test_files of ${p.project} set to ${p.testFiles}: its tests are named that way.)\n`;
      }
      // The place the runner's listing showed for a project, in every file that leaves tests_dir out.
      const [placedYaml, again] = withPlacements(yaml, state.placements);
      if (again) yaml = placedYaml;
      if (dropped || placed.length || again) args = { ...args, yaml };
      // Saved when setup fails: with the user's allow-list, so the file left behind keeps it.
      state.lastTried = withOurs(yaml);
      try {
        const own = parseReviewFile(yaml);
        if (namesStandIn(yaml, standInNames)) {
          return "invalid: the file names a stand-in arnx put in place of key-shaped text; it is not the project's value. " +
            "Leave that text out: the tests run with it already";
        }
        if ("approved" in own.raw) return "invalid: remove the approved key; arnx stamps the file after its proof";
        if ("allow_secret_looking" in own.raw) {
          return "invalid: remove allow_secret_looking; only the user allows secret-looking files, and setup adds " +
            "their list itself";
        }
        if ("sandbox_only" in own.raw) {
          return "invalid: remove sandbox_only; setup adds the files the tests need itself";
        }
        const text = withOurs(yaml);
        state.lastTried = text;
        state.lastFile = yaml;
        return { f: text !== yaml ? parseReviewFile(text) : own, text, yaml };
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
      doc.delete("sandbox_only");
      doc.setIn(["projects", args.project], block.contents);
      return { yaml: String(doc), project: args.project };
    };
    // A quick setup sets up only the projects that own a changed file, and the ones using a changed file no project
    // owns. A project that only uses an owned file waits: it is set up when a change reaches its own files. The
    // approved ones it keeps stay as they are.
    const touched = (f: ReviewFile): Set<string> => {
      const r = route(f, sourceFirst(o.quick!.files), Number.MAX_SAFE_INTEGER);
      const all = [...r.routed, ...r.checkOnly.map((c) => ({ ...c, owned: [] as string[] }))];
      const owned = new Set(all.flatMap((x) => x.owned));
      return new Set(all.filter((x) => x.owned.length || x.used.some((u) => !owned.has(u))).map((x) => x.project.name));
    };
    const untouched = (f: ReviewFile): ReviewConfig[] => o.quick && !f.legacy
      ? f.projects.filter((p) => !keep.has(p.name) && p.workdir !== "." && !touched(f).has(p.name)) : [];
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
      if (untouched(f).includes(cfg)) {
        return `refused: this setup is for a first review, and no file the change touches is in ${name}. Do not try ` +
          `it: set up only ${[...touched(f)].join(", ") || "the projects that own a changed file"}. propose takes ` +
          `${name} out of the file and lists /${cfg.workdir}/ under uncovered as "${NOT_SET_UP}".`;
      }
      // Answers of nothing make tests pass or fail for no reason, and a before/after check then proves nothing.
      if (cfg.install.some((c) => /\bMagicMock\b/.test(c))) {
        return "refused: install replaces code with MagicMock, which answers everything with nothing, so tests pass or " +
          "fail for no reason. Use a stand-in that behaves like the service (a library made for it), or leave those " +
          "tests failing: they are recorded.";
      }
      // A project whose files say its tests need MANY_SERVICES or more is not tried while it lists that many.
      const facts = detection.facts?.projects.find((p) => p.root === cfg.workdir && p.language === cfg.language);
      const many = facts && cfg.services.length >= MANY_SERVICES ? manyServices(facts) : null;
      if (many) {
        if (!state.tooMany.has(name)) say(`${name}: not set up: ${manyServicesReason(many)}`);
        state.tooMany.set(name, many);
        return `refused: ${name} ${manyServicesReason(many)}. Do not try it: keep it under uncovered (path ` +
          `/${cfg.workdir}/, this reason) and go on with the other projects.`;
      }
      // --- web UI rule: a UI app gets UI_RUNS counted runs; then setup lists it under uncovered as web UI. ---
      if (state.webUi.has(name)) {
        return `${name} is listed under uncovered as ${WEB_UI}: do not try it again; go on with the other projects ` +
          "(propose leaves it out of the file).";
      }
      const uiApp = !keep.has(name) && cfg.language === "typescript"
        ? uiFramework(readSnap(join(cfg.workdir, "package.json"))) : null;
      // The answer when this failed try is a counted run: null until the app has had UI_RUNS of them.
      const webUi = (why: string, c: SuiteCounts, listingError: string): string | null => {
        if (!countsAsUiRun(c, false)) return null;
        const runs = (state.uiRuns.get(name) ?? 0) + 1;
        state.uiRuns.set(name, runs);
        const stops = (state.uiListingStops.get(name)?.n ?? 0) + (c.stoppedAt === "listing" ? 1 : 0);
        if (c.stoppedAt === "listing") state.uiListingStops.set(name, { n: stops, error: listingError });
        if (runs < UI_RUNS) return null;
        state.webUi.add(name);
        // Routing is the same; the user reads that the tests never listed when every counted run stopped there.
        if (stops === runs) {
          say(listingStopLine(name, stops, listingError));
          state.problem = listingStopLine(name, stops, listingError);
        } else {
          say(`${name}: a web UI app (${uiApp}); its tests failed ${runs} times, so it is listed as ${WEB_UI}`);
        }
        return `the suite of ${name} does not run: ${why}\n${name} is a web UI app (${uiApp} among its dependencies), ` +
          `which gets two runs of its tests: arnx lists it under uncovered as ${WEB_UI} and propose leaves it out of the ` +
          "file. Do not try it again; go on with the other projects.";
      };
      // --- end of the web UI rule ---
      const t0 = performance.now();
      // On the time limit's clock: a try that took longer than the time left is not sent back for a note.
      const began = limit.now();
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
      state.current = name;
      // exec's container sits idle while the suite runs: it goes now (memory), and the next exec starts it again.
      exec?.close();
      const log = join(o.outDir, `build-${n}-${name}.log`);
      // exec runs in the image this try runs in: its key's, or the one the run's image step names (dockerSteps.log
      // below; an image rebuilt for the code). The same environment keeps the image its last run named.
      const before = state.lastTry.get(name);
      state.lastTry.set(name, { cfg, env: envDigest(cfg),
        image: before?.env === envDigest(cfg) ? before.image : envTag(keyOf(cfg)) });
      // One line as the run starts: the image build, when there is one, is said in the same line.
      // Only a try that runs counts: a refused one above leaves no gap in what the developer sees.
      const tried = (state.tries.get(name) ?? 0) + 1;
      state.tries.set(name, tried);
      announce = { name, n: tried };
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
      // A quick setup's try repeated unchanged: its look runs again, tolerating files that do not load.
      let retriedQuick = false;
      // The project's part of the file the run ran with.
      let ranWith = runDigest(f, name);
      try {
        // Not when files went into the sandbox since: that run did not have them.
        if (held && held.env === env && held.files === sandboxKey()) {
          announce = null;
          say(`${name}: same environment as the last try; its run stands`);
          [ok, summary, tail, skips, failing, hints, counts] = [true, held.run.summary, "", held.run.skips, [], "",
            held.run.counts];
          ranWith = held.run.digest;
        } else if (subset.length) {
          say(`${name}: same environment as the last try; rerunning the ${subset.length} file(s) that failed`);
          [ok, summary, tail, skips, failing, hints, counts] = await runSuite(cfg, snap, log, { sessionFactory: factory,
            targets: subset, failureModel: o.failureModel, key: keyOf(cfg), acceptedTestsDir: accepted,
            accepted: trusted, leftOut, baseline: "record", boundary, swap });
          if (ok) {
            say(`${name}: they run now; running the whole suite to prove the project`);
            [ok, summary, tail, skips, failing, hints, counts] = await runSuite(cfg, snap, log, { sessionFactory: factory,
            failureModel: o.failureModel, key: keyOf(cfg), acceptedTestsDir: accepted,
            accepted: trusted, leftOut, baseline: "record", boundary, swap });
          } else {
            onlySubset = true;
            summary = `rerun of the ${subset.length} file(s) that failed last time: ${summary}`;
          }
        } else {
          const look = state.looked.get(name) !== env;
          retriedQuick = !look && !!o.quick;
          [ok, summary, tail, skips, failing, hints, counts] = await runSuite(cfg, snap, log, { sessionFactory: factory,
            failureModel: o.failureModel, key: keyOf(cfg), acceptedTestsDir: accepted,
            accepted: trusted, leftOut, baseline: "record", precheck: look || !!o.quick, quick: !!o.quick, tolerate: !look, boundary, swap });
          state.looked.set(name, env);
        }
        if (ok) state.lastFailing.delete(name);
        else state.lastFailing.set(name, { env, files: failing.length ? failing : last?.files ?? [] });
      } catch (e) {
        if (!(e instanceof ArnxError)) throw e;
        announce = null;
        if (e instanceof OutOfTime || e instanceof DiskFull) {
          attempt({ ok: false, reused: false, summary: "", failing: 0, skips: 0, hints: "", error: e.message });
          throw e;
        }
        // Files .arnxignore leaves out go into the sandbox (scrubbed as the snapshot is), and the project runs again.
        if (e instanceof LeftOutNeeded && e.files.every((p) => !secret.has(p) && !fakedKeys.includes(p))) {
          const r = addToSandbox(repo, snap, e.files, pins, { known: replaced });
          boundary.addScrubbed(r);
          r.sandboxed.forEach((p) => sandbox.add(p));
          r.withheld.forEach((w) => secret.add(w.path));
          leftOut.paths = leftOut.paths.filter((p) => !sandbox.has(p));
          r.standInValues.forEach((v) => standInNames.add(v));
          standRows.push(...r.standInList);
          if (r.standIns.length) listStandIns(r.standIns);
          if (r.fakedKeys.length) say(fakedKeysText(r.fakedKeys));
          if (r.sandboxed.length && !r.withheld.length) {
            say(`${name}: the tests need ${someNames(r.sandboxed)}, which .arnxignore leaves out: copied into the ` +
              "sandbox, not sent to the model");
            emit("setup.sandbox_only", { project: name, files: r.sandboxed });
            attempt({ ok: false, reused: false, summary: "", failing: 0, skips: 0, hints: "",
              error: clip(`sandbox: ${r.sandboxed.join(", ")}`, 500) });
            // The same try again, with the files.
            return tryProject(input);
          }
        }
        if (e instanceof LeftOutNeeded) {
          state.needed = e.files.map((path) => ({ path, secret: secret.has(path), ...(fakedKeys.includes(path) ? { faked: true as const } : {}) }));
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
      // The runner's own listing showed where it collects arnx's tests: review.yaml says so, and the project runs again.
      if (counts.placement && !state.placements.has(name)) {
        const where = counts.placement;
        state.placements.set(name, where);
        announce = null;
        const doc = parseDocument(parsed.yaml);
        const at = f.legacy ? [] : ["projects", name];
        doc.setIn([...at, "tests_dir"], where.testsDir);
        if (where.testFiles) doc.setIn([...at, "test_files"], where.testFiles);
        state.placed.set(name, where.testsDir);
        state.notice += `(tests_dir of ${name} set to ${where.testsDir}` +
          `${where.testFiles ? ` and test_files to ${where.testFiles}` : ""}: the runner lists arnx's one-line test there.)\n`;
        say(`${name}: tests_dir set to ${where.testsDir}${where.testFiles ? `, test_files to ${where.testFiles}` : ""}`);
        attempt({ ok: false, reused: false, summary: "", failing: 0, skips: 0, hints: "",
          error: clip(`placement: ${where.testsDir}`, 500) });
        return tryProject({ yaml: doc.toString({ flowCollectionPadding: false, lineWidth: 0 }), project: name });
      }
      announce = null;
      state.summary = f.legacy ? summary : `${name}: ${summary}`;
      if (!onlySubset && counts.all.length > (state.mostRan.get(name)?.tests ?? 0)) {
        state.mostRan.set(name, { tests: counts.all.length, command: cfg.testCommand });
      }
      // Each kind of doubt goes back to the agent once; what it keeps, tried again unchanged, goes on from the same run.
      const shown = held && held.env === env ? held.shown : new Set<string>();
      const hold = (key: string) => state.held.set(name, { env, files: sandboxKey(), shown: new Set([...shown, key]),
        run: { digest: ranWith, summary, skips, counts } });
      // Failures that look like the environment go back to the agent once before they are recorded.
      const faults = ok && counts.failed.length && !timeIsUp(limit) ? environmentFaults(counts, cfg) : null;
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
      // A quick look ran a few files: what the whole suite would run is what the runner listed.
      const gap = ok ? coverageGap(cfg, snap, counts.listed ? counts.listed.map((f) => ({ fileAttr: f }) as TestResult)
        : counts.all, counts.listed ? undefined : state.mostRan.get(name), accepted,
        (r) => nested.some((w) => r === w || r.startsWith(`${w}/`)) || uncovered(r)) : null;
      // What proves the project from this run: recorded at once, or kept as it stands while a note goes back to the
      // agent (state.standing).
      const snapshot = withSandbox(code, sandbox);
      const prove = () => {
        state.proven.set(name, projectDigest(f, name));
        if (!f.legacy) state.provenBlocks.set(name, provenBlock(f, name));
        // A run that proves a project ran the whole suite (a rerun of failing files that passes is followed by one).
        const [, counted] = suiteOk(counts.all, cfg, trusted, accepted, "record");
        state.runs.set(name, { name, digest: ranWith, env, snapshot, untracked, summary,
          skips, counts, after: summary.startsWith(counted) ? summary.slice(counted.length) : "" });
        state.proofs.set(name, { name, summary, skips,
          failed: counts.failed.map((t) => entryOf(t, causeOf(t, cfg, snap, counts.hints) ?? undefined)),
          ...(counts.unproven ? { unproven: counts.unproven } : {}),
          ...(gap ? { gap: gap.line } : {}),
          ...(counts.typecheckProblem ? { typecheckProblem: counts.typecheckProblem } : {}),
          ...(counts.typeGaps ? { typeGaps: counts.typeGaps } : {}) });
      };
      // The code as it is now is what later reviews' changes start from: a swamped type check is remembered.
      const remember = () => {
        if (cfg.typecheck && counts.typeErrors !== undefined) recordTypecheck(repo, cfg, counts.typeErrors);
      };
      const stand = (note: string) => {
        state.standing.delete(name);
        state.standing.set(name, { file: parsed.yaml, prove, remember,
          summary: f.legacy ? summary : `${name}: ${summary}`, said: `${name}: ✓ try ${tried} stands: ` +
          `${summary}${note ? ` · ${note}` : ""}`, event: { n, project: name, ok: true, reused: true,
          summary: clip(summary, 500), failing: 0, skips: skips.length, hints: clip(note, 1000) } });
      };
      // A note goes back to the agent once; not with the time up, nor when this try took longer than the time left.
      const ask = (key: string, what: string): boolean => {
        if (shown.has(key) || timeIsUp(limit)) return false;
        if (limit.now() - began <= limit.at - limit.now()) return true;
        say(`${name}: runs, but ${what}; too little time left to ask the agent`);
        return false;
      };
      if (gap && ask("gap", gap.line)) {
        hold("gap");
        stand(gap.line);
        state.problem = `${name}: ${gap.line}`;
        attempt({ ok: false, reused: false, summary: clip(summary, 500), failing: failing.length, skips: skips.length,
          hints: clip(gap.line, 1000) });
        say(`${name}: runs, but ${gap.line}; asking the agent`);
        return `the suite of ${name} runs (${summary}), but ${gap.line}. Tests that test_command leaves out never run, ` +
          "and nothing else would say so. Run them too (a longer suite is fine: reviews run only the tests arnx writes), " +
          "or, if they cannot run in the sandbox, try the project again unchanged: the gap is then shown to the user.";
      }
      // A type check that did not run, or errors about a module it cannot see, go back to the agent once; tried again
      // unchanged, they stand and are said at approval.
      if (ok && counts.typecheckProblem && ask("typecheck", `its type check: ${counts.typecheckProblem}`)) {
        hold("typecheck");
        const line = `the type check of ${name}: ${counts.typecheckProblem}`;
        stand(line);
        state.problem = `${name}: ${line}`;
        attempt({ ok: false, reused: false, summary: clip(summary, 500), failing: failing.length, skips: skips.length,
          hints: clip(line, 1000) });
        say(`${name}: runs, but its type check: ${counts.typecheckProblem}; asking the agent`);
        return `the suite of ${name} runs (${summary}), but ${line}.\n${tail}\nIt is information, not a failed ` +
          "proof. If the command or its heap can be fixed (typecheck in review.yaml), fix it; otherwise try the project " +
          "again unchanged: the problem is then shown to the user.";
      }
      const gaps = ok ? (counts.typeGaps ?? []) : [];
      if (gaps.length && ask("types", gapsLine(gaps))) {
        hold("types");
        const line = gapsLine(gaps);
        stand(line);
        state.problem = `${name}: ${line}`;
        attempt({ ok: false, reused: false, summary: clip(summary, 500), failing: failing.length, skips: skips.length,
          hints: clip(line, 1000) });
        say(`${name}: runs, but ${line}; asking the agent`);
        const fixes = [
          gaps.some((g) => g.kind === "generated") ? "A generated client belongs in install: add its generate step (for " +
            "Prisma, npx prisma generate --schema=PATH; it downloads engines, so it runs in install, never in test_command)." : "",
          gaps.some((g) => g.kind === "sibling") ? "Do not build sibling packages to hide it (a built copy changes the " +
            "image for every code version)." : "",
          gaps.every((g) => g.kind === "missing") ? "Add the dependency to install, or try the project again unchanged: " +
            "the gap is then shown to the user." : "Otherwise try the project again unchanged: the gap is then shown to the user."]
          .filter(Boolean).join(" ");
        return `the suite of ${name} runs (${summary}), but ${line}, so its errors say nothing about a change. ${fixes}`;
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
      if (!ok && retriedQuick && (counts.stoppedAt === "listing" || counts.stoppedAt === "sample")) {
        // A quick setup never runs the whole suite: the same stop again ends the try.
        say(`${name}: ✗ ${gist(summary)}`);
        throw new StopRound(`stopped: ${state.problem}. Setup ends here.`);
      }
      if (!ok) {
        say(`${name}: ✗ does not run yet: ${gist(summary)}`);
        // A UI app's runs are for a suite that will not run in a sandbox: one whose tests pass goes on like any other.
        const ui = uiApp && !onlySubset ? webUi(gist(summary), counts, (tail || summary).replace(/\s+/g, " ").trim().slice(-200)) : null; // web UI rule
        if (ui) return ui;
        return `the suite of ${name} does not run yet: ${summary}${skipped}${hints ? `\n${hints}` : ""}\n${tail}`;
      }
      say(`${name}: ✓ ${summary}${counts.failed.length ? ` · ${counts.failed.length} failing today, recorded` : ""}` +
        `${skips.length ? ` · skipped because ${skips.join("; ")}` : ""}`);
      const red = counts.acceptedFailing ? ` ${plural(counts.acceptedFailing, "failure")} in accepted tests (bugs not ` +
        "fixed yet) do not count; leave those tests as they are." : "";
      if (red) say(stillRed(counts.acceptedFailing));
      prove();
      remember();
      state.standing.delete(name);
      // A TypeScript project that can be type checked and has no typecheck yet: say so while the agent is here.
      const typed = cfg.language === "typescript" && !cfg.typecheck && typeCheckable(readSnap, cfg.workdir)
        ? ` ${name} has a tsconfig.json and typescript among its dependencies: add typecheck (for example ` +
          `${TYPECHECK_EXAMPLE}; deps_dir links node_modules for it too) and try it again.` : "";
      const bare = summary.startsWith(NO_OWN_TESTS) ? ` ${name} has no tests of its own, which is fine: reviews run the ` +
        "tests arnx writes with this test_command. Do not write tests for it." : "";
      const recorded = counts.failed.length ? ` Its ${plural(counts.failed.length, "failing test")} ` +
        `${counts.failed.length === 1 ? "is" : "are"} recorded as failing today.` : "";
      return `the suite of ${name} runs: ${summary}.${recorded}${bare}${red}${skipped}${typed} When every project runs, submit the ` +
        "file with propose.";
    };
    // arnx's own uncovered entries: browser suites, and the paths of the web UI apps in `drop`.
    const derivedOf = (f: ReviewFile, drop: string[]) => [
      ...browser.map((b) => ({ path: b.path, reason: `${BROWSER_TESTS} (${b.tool})` })),
      ...drop.flatMap((name) => webUiPaths(f, name, mapFiles).map((path) => ({ path, reason: WEB_UI })))];
    // A project proven in this setup that the agent's file leaves out is put back (restoreProven), and the agent told.
    const putBack = (text: string, revert?: ReadonlySet<string>): string => {
      const blocks = new Map([...state.provenBlocks].filter(([n]) => !keep.has(n) && !state.webUi.has(n)));
      const r = restoreProven(text, blocks, { revert });
      // A line already told (keepProven puts back twice) is not told again.
      const tell = (line: string) => { if (!state.notice.includes(line)) state.notice += line; };
      const kept = r.replaced.filter((n) => revert?.has(n));
      const absent = r.replaced.filter((n) => !revert?.has(n));
      if (absent.length) {
        tell(`(${absent.join(", ")} ran in this setup, but its folder overlaps a project in this file: ` +
          "the file's project stays.)\n");
      }
      if (kept.length) {
        tell(`(${kept.join(", ")} ran in this setup, but its folder overlaps a project in this file: ` +
          "the file's changed block stays.)\n");
      }
      if (!r.restored.length) return text;
      try {
        parseReviewFile(withOurs(r.yaml));
      } catch (e) {
        if (!(e instanceof ArnxError)) throw e;
        return text;
      }
      tell(`(${r.restored.join(", ")} already ran in this setup and stays in the file as it ran: ` +
        "arnx put it back.)\n");
      return r.yaml;
    };
    // At the time limit with no file accepted: the projects of the last whole file (or `file`) proven as they stand
    // there are kept, the others listed under uncovered (TIME_LEFT_OUT), and that file is accepted. Approved projects
    // must be as approved. Returns the projects set aside; null (nothing accepted) when no project of this setup is
    // proven, the file does not hold together without them, or (`whole`) one would be set aside.
    const keepProven = (file = state.lastFile, whole = false): string[] | null => {
      if (!file) return null;
      let f: ReviewFile;
      let last = file;
      try {
        last = putBack(last);
        f = parseReviewFile(withOurs(last));
        // A later try may have changed a project that passed: its proof is for the block that ran, so that goes back.
        const revert = new Set(f.legacy ? [] : f.projects.map((p) => p.name).filter((n) => !keep.has(n) &&
          state.provenBlocks.has(n) && state.proven.get(n) !== projectDigest(f, n)));
        if (revert.size) {
          const back = putBack(last, revert);
          try {
            f = parseReviewFile(withOurs(back));
            last = back;
          } catch (e) {
            if (!(e instanceof ArnxError)) throw e;
            f = parseReviewFile(withOurs(last));
          }
        }
      } catch (e) {
        if (!(e instanceof ArnxError)) throw e;
        return null;
      }
      if (f.legacy || [...keep].some(([name, d]) => !f.projects.some((p) => p.name === name) ||
        projectDigest(f, name) !== d)) return null;
      const fresh = f.projects.filter((p) => !keep.has(p.name)).map((p) => p.name);
      const proven = fresh.filter((name) => state.proven.get(name) === projectDigest(f, name));
      if (!proven.length) return null;
      const web = fresh.filter((name) => state.webUi.has(name));
      const aside = fresh.filter((name) => !proven.includes(name) && !web.includes(name));
      if (whole && aside.length) return null;
      const reason = (name: string) => state.tooMany.has(name) ? manyServicesReason(state.tooMany.get(name)!)
        : TIME_LEFT_OUT;
      let yaml = withUncovered(last, [...derivedOf(f, web), ...aside.flatMap((name) =>
        webUiPaths(f, name, mapFiles).map((path) => ({ path, reason: reason(name) })))], [...web, ...aside]);
      let map: Coverage;
      try {
        f = parseReviewFile(withOurs(yaml));
        map = coverageMap(repo, f, untracked);
        if (map.groups.length) {
          yaml = withUncovered(yaml, map.groups.map(({ path, reason }) => ({ path, reason })));
          f = parseReviewFile(withOurs(yaml));
          map = coverageMap(repo, f, untracked);
        }
      } catch (e) {
        if (!(e instanceof ArnxError)) throw e;
        return null;
      }
      if (map.overlaps.length || map.unexplained.length) return null;
      state.accepted = withOurs(yaml);
      state.final = f;
      return aside;
    };
    const propose = async (args: Record<string, unknown>): Promise<string> => {
      if (state.needed) throw stopped();
      let parsed = parse(args);
      if (typeof parsed === "string") return parsed;
      const back = putBack(parsed.yaml);
      if (back !== parsed.yaml) {
        state.lastFile = back;
        state.lastTried = withOurs(back);
        parsed = { yaml: back, text: withOurs(back), f: parseReviewFile(withOurs(back)) };
      }
      // arnx's part of the map: browser suites under uncovered, and the web UI apps whose runs failed there instead
      // of in the file. Done on the agent's file; arnx's own keys (withOurs) are added again to check it.
      const drop = [...state.webUi].filter((name) => parsed.f.projects.some((p) => p.name === name));
      if (drop.length && drop.length === parsed.f.projects.length) {
        state.problem = onlyWebUi(drop);
        throw new StopRound(`stopped: ${ONLY_WEB_UI}: ${drop.join(", ")} did not run in ${UI_RUNS} tries, and there ` +
          "is no other project. Setup ends here.");
      }
      // A quick setup leaves for later the projects no changed file reaches.
      const later = untouched(parsed.f).filter((p) => !drop.includes(p.name));
      if (o.quick) {
        const users = route(parsed.f, o.quick.files, Number.MAX_SAFE_INTEGER);
        const using = new Set([...users.routed, ...users.checkOnly].map((x) => x.project.name));
        state.waiting = later.filter((p) => using.has(p.name)).map((p) => p.name);
      }
      let yaml = withUncovered(honestReasons(parsed.yaml, coverageFiles(repo, untracked).files), [...derivedOf(parsed.f, drop),
        ...later.map((p) => ({ path: `/${p.workdir}/`, reason: NOT_SET_UP }))], [...drop, ...later.map((p) => p.name)]);
      let f: ReviewFile;
      try {
        f = yaml === parsed.yaml ? parsed.f : parseReviewFile(withOurs(yaml));
      } catch (e) {
        if (!(e instanceof ArnxError)) throw e;
        return `invalid: ${e.message}`;
      }
      const problems: string[] = [];
      const ownTests: string[] = [];
      const changed = [...keep].filter(([name, d]) => !f.projects.some((p) => p.name === name) ||
        projectDigest(f, name) !== d).map(([name]) => name);
      if (changed.length) problems.push(`must stay as approved: ${changed.join(", ")}`);
      const unproven = f.projects.filter((p) => !keep.has(p.name) && state.proven.get(p.name) !== projectDigest(f, p.name))
        .map((p) => p.name);
      let map = coverageMap(repo, f, untracked);
      if (map.overlaps.length) problems.push(`owned by more than one project: ${list(map.overlaps)}`);
      // Source files outside every project go back to the agent once, by folder; after that arnx lists what is left
      // under uncovered itself, with the reason it can tell.
      const asked = map.groups.length > 0 && !state.placesAsked;
      if (asked) {
        state.placesAsked = true;
        problems.push(placesText(map.groups));
      } else if (map.groups.length) {
        yaml = withUncovered(yaml, map.groups.map(({ path, reason }) => ({ path, reason })));
        f = parseReviewFile(withOurs(yaml));
        map = coverageMap(repo, f, untracked);
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
        state.problem = rejectedReason({ changed, overlaps: map.overlaps, unexplained: asked ? map.unexplained : [],
          ownTests, failed: [] });
        return `refused:\n${problems.join("\n")}`;
      }
      // The map's paths are checked once, before any project runs: uses entries wider than meant go back as hints,
      // and the same file proposed again is accepted. Approved projects must stay as they are, so none is named.
      if (!state.pathsChecked) {
        state.pathsChecked = true;
        state.pathHints = mapHints(f, files.filter((p) => !ignoredFile(p) && !isSecretPath(p) && !isArnxPath(p)))
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
      for (const name of unproven) {
        const r = await tryProject({ yaml: parsed.yaml, project: name });
        if (!r.startsWith(`the suite of ${name} runs:`)) {
          failed.push(r);
        }
      }
      if (failed.length) {
        // The suite's own failure (state.problem, state.failing) stays what a failed setup reports.
        const ran = f.projects.filter((p) => !keep.has(p.name) && state.proven.get(p.name) === projectDigest(f, p.name))
          .map((p) => `${p.name} (${state.proofs.get(p.name)?.summary ?? "ran"})`);
        return `refused: propose ran the projects changed since they were proven, and these do not run:\n` +
          failed.join("\n\n") + (ran.length ? `\nThese already run; keep them: ${ran.join(", ")}.` : "");
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
      // With the sandbox-only files the runs just now found.
      state.accepted = withOurs(yaml);
      state.final = parseReviewFile(state.accepted);
      return `accepted:\n${describeCoverage(map)}\nStop here and summarise.`;
    };
    // A note the agent gets once, with the next tool result (known_failing taken out of its file). With too little
    // time left for a Docker step, a tool stops the round instead: setup ends at its time limit. `runs`: the tool
    // always starts one (propose starts one only for a project changed since its run).
    type Run = (i: Record<string, unknown>) => Promise<string>;
    const noted = (run: Run, runs = true): Run => async (i) => {
      let r: string;
      try {
        if (runs) requireTime();
        r = await run(i);
      } catch (e) {
        if (e instanceof DiskFull) {
          if (!state.diskFull) say(`✗ ${e.message}`);
          state.diskFull = true;
          state.problem = e.message;
          throw new StopRound(`stopped: ${e.message} Setup ends here.`);
        }
        if (!(e instanceof OutOfTime)) throw e;
        if (!state.outOfTime) say(`✗ ${e.message}`);
        state.outOfTime = true;
        throw new StopRound(`stopped: ${e.message}. Setup ends here.`);
      }
      const note = state.notice;
      state.notice = "";
      return note + r;
    };
    // The quick setup's draft, proposed as it is: places and uses entries refused once go through the second time.
    const proposeDraft = async (yaml: string): Promise<string> => {
      let said = "";
      for (let i = 0; i < 3; i++) {
        const asked = state.placesAsked;
        try {
          said = await noted(propose, false)({ yaml });
        } catch (e) {
          if (!(e instanceof StopRound)) throw e;
          return `stopped: ${e.message}`;
        }
        if (!(said.startsWith("refused once") || (!asked && state.placesAsked))) return said;
      }
      return said;
    };
    const shell = exec = new SetupExec({ snap, dir: join(tmp, "exec"), outDir: o.outDir,
      factory: o.execFactory ?? dockerExec, tried: state.lastTry, say, boundary,
      swapOf: (project) => baked.has(project) ? undefined : swap });
    const ws = new Workspace(snap, { reads: swap, extra: { try_project: [TRY_PROJECT, noted(tryProject)],
      propose: [PROPOSE, noted(propose, false)], exec: [EXEC, noted((i) => shell.call(i))] } });
    const detection = detectReadable(repo, untracked);
    const brain: Brain = o.brain ?? new LocalBrain({ agentModel: agentModel!, prices: allPrices(settings),
      prompts: promptsFor(repo), boundary });
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
    // A quick setup proposes its draft as it is first: no model when it goes through.
    let draft = o.project || o.add ? "" : draftYaml(detection);
    let drafted: AgentResult | null = null;
    if (o.quick) {
      const q = quickDraft(detection, o.quick.files, current, o.quick.attempt);
      if (!q) {
        state.problem = "no project arnx can set up owns a file this change touches";
        emit("setup.completed", { ok: false, stop: NOTHING_TO_TEST, cost_usd: 0, attempts: 0, projects: [],
          summary: state.problem });
        return { ok: false, yamlText: null, summary: state.problem, costUsd: 0, stop: NOTHING_TO_TEST, notes: "",
          projects: [], withheld, blanked, standIns, fakedKeys, sandboxed: [], failing: [], failingProject: null,
          problem: state.problem, runs: [] };
      }
      emit("setup.quick", { projects: q.names, files: o.quick.files.length });
      const said = await proposeDraft(q.yaml);
      if (said.startsWith("accepted") || state.outOfTime || state.diskFull || state.needed || said.startsWith("stopped")) {
        drafted = { finalText: "", costUsd: 0, turns: 0, stop: "end_turn", calls: 0,
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      } else {
        // The agent starts from the draft, with what stopped it (comment lines: the file stays the same YAML).
        draft = `${clip(said, 3000).split("\n").map((l) => `# ${l}`).join("\n")}\n${q.yaml}`;
      }
    }
    const { agent: result } = drafted ? { agent: drafted } : await withRole("setup", () => brain.agentRound("setup", {
      hints: setupHintsFor(detection, browser),
      draft,
      withheld: withheld.length ? describeWithheld(withheld) : "",
      ...(standIns.length || fakedKeys.length ? { standIns: [...new Set([...standIns, ...fakedKeys])].sort() } : {}), current, detection, tree: treeOf(repo, untracked),
      withheldFiles: withheld,
      ...(o.project ? { project: o.project } : {}), ...(o.add ? { add: true } : {}),
      budgetUsd: settings.setupBudgetUsd, outDir: o.outDir, deadline: { at: limit.at, now: limit.now } },
    Promise.resolve(tools)));
    logUsage(repo, "setup", [agentUse(brain.label ? `${brain.label}/setup` : refString(setupRef(settings)), result)],
      new Date());
    // A run cut short at the limit, then the agent's last word: out of time all the same.
    const late = !state.diskFull && state.outOfTime || result.stop === "time" || (state.accepted === null && timeIsUp(limit));
    const capped = result.stop === "budget" || result.stop === "max_turns";
    let aside: string[] | null = null;
    // Out of time (or, after a note went back to the agent, out of budget or turns) with no file accepted. A working
    // run whose note went back to the agent stands as if tried again unchanged (a later failed try never replaces
    // it): of the last whole file and the files those runs ran with, the one that keeps the most projects is taken.
    if (state.accepted === null && !state.needed && !state.diskFull && (late || (capped && state.standing.size))) {
      const proven = new Map(state.proven);
      const stood = [...state.standing.values()];
      stood.forEach((x) => x.prove());
      let best: { accepted: string; final: ReviewFile; aside: string[] } | null = null;
      for (const file of [state.lastFile, ...stood.map((x) => x.file).reverse()]) {
        const left = keepProven(file, !late);
        // The most projects kept wins; on a tie, the earlier candidate (the last whole file first).
        if (left && state.accepted !== null && state.final &&
          (!best || state.final.projects.length > best.final.projects.length)) {
          best = { accepted: state.accepted, final: state.final, aside: left };
        }
        [state.accepted, state.final] = [null, null];
      }
      if (best) [state.accepted, state.final, aside] = [best.accepted, best.final, best.aside];
      else state.proven = proven;
      for (const [name, x] of state.standing) {
        if (!state.final?.projects.some((p) => p.name === name)) continue;
        x.remember();
        say(x.said);
        emit("setup.attempt", x.event);
        state.summary = x.summary;
      }
    }
    const projects = (state.final?.projects ?? []).map((p) => state.proofs.get(p.name) ??
      { name: p.name, summary: keep.has(p.name) ? "approved earlier" : "not run", skips: [] });
    // Every project of the last file a web UI app whose runs failed: nothing here arnx sets up.
    let last: string[] = [];
    try {
      last = state.lastFile ? parseReviewFile(state.lastFile).projects.map((p) => p.name) : [];
    } catch (e) {
      if (!(e instanceof ArnxError)) throw e;
    }
    const webOnly = state.accepted === null && !state.needed && !late && last.length > 0 &&
      last.every((n) => state.webUi.has(n));
    if (webOnly) state.problem = onlyWebUi(last);
    const stop = state.diskFull ? DISK_FULL_STOP : state.needed ? "stopped" : late ? "time" : webOnly ? WEB_UI_STOP : result.stop;
    const running = stop === "time" && !state.accepted && state.current && !state.proven.has(state.current)
      ? state.current : null;
    emit("setup.completed", { ok: state.accepted !== null, stop, cost_usd: result.costUsd,
      attempts: state.attempts, projects: projects.map((p) => p.name), summary: clip(state.summary, 500),
      ...(aside ? { uncovered_projects: aside } : {}) });
    return { ok: state.accepted !== null, yamlText: state.accepted ?? state.lastTried, summary: state.summary,
      costUsd: result.costUsd, stop, notes: result.finalText, projects, withheld,
      blanked, standIns, fakedKeys, sandboxed: [...sandbox].sort(),
      failing: state.accepted !== null ? [] : state.failing, failingProject: state.accepted !== null ? null
        : state.failingProject, problem: state.problem, ...(state.needed ? { needed: state.needed } : {}),
      ...(running ? { running } : {}), ...(aside ? { setAside: aside } : {}),
      ...(state.accepted !== null && state.waiting.length ? { waiting: state.waiting } : {}),
      runs: (state.final?.projects ?? []).flatMap((p) => state.runs.get(p.name) ?? []) };
  } finally {
    exec?.close();
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
  unexpected: string[]; log: string; baselineFailing: number; left: string[]; flaky: string[];
  /** Setup's run stood for this proof: the suite did not run again. */
  reused?: true }

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

/** The proof of review.yaml before `arnx setup --project` rewrote it: its `approved` stamp, its baseline, and whether
 * that baseline is the one the stamp proved. */
export interface ProofBefore { approved: unknown; baseline: Baseline; proven: boolean }

/** The proof review.yaml has now (ProofBefore); null when the file or its baseline does not read. */
export function proofBefore(repo: string): ProofBefore | null {
  try {
    const f = loadReviewFile(repo, { requireApproved: false });
    return { approved: f.raw.approved, baseline: readBaseline(repo),
      proven: stampedBaseline(f) === baselineDigest(repo) };
  } catch (e) {
    if (!(e instanceof ArnxError)) throw e;
    return null;
  }
}

/** Run the suites again and stamp the file. With `project`, only that project runs, and only when every other
 * project is unchanged since the last approval. The suites run on what reviews will see: tracked files, and untracked
 * ones only with `untracked` (default: `[review] untracked`). Tests kept by `arnx accept` may fail while they match
 * their pins (`localPins`: this machine's record, localPinsPath). Tests in the baseline may fail; those that no longer
 * do leave it. A test failing outside it runs once more, and passing then it does not count (flaky). `afterSetup`: the
 * runs that proved the projects setup recorded moments ago (SetupRun). A project whose part of the file, environment
 * and code are what its run had is not run again: that run, judged against today's baseline and accepted tests, is its
 * proof. One that runs again on the same code and environment passed moments ago, so a test failing outside the
 * baseline is flaky and joins it as such; otherwise the baseline never grows here. `before`: with `project`, the
 * proof the file had before `arnx setup --project` rewrote it and its baseline (ProofBefore), which the other
 * projects are checked against. [approved, text, each suite] */
export async function approveFile(repo: string, o: { by: string; at: string; project?: string;
  sessionFactory?: SessionFactory; progress?: Say; untracked?: boolean; localPins?: string | null;
  afterSetup?: SetupRun[]; before?: ProofBefore;
  /** The projects a quick look proves (runSuite `quick`); the others run their whole suite. Never read from the file
   * itself: a stamp can be written by hand. */
  quick?: string[];
  /** The last proof: each project's digest, the rest of the file (restDigest) and the baseline it had. A project
   * whose part of the file and baseline entries are what they were then, with the rest of the file unchanged, no
   * accepted test changed, and that setup did not just run, keeps that proof and does not run again. */
  unchanged?: { projects: Record<string, string>; rest: string; baseline: Baseline } })
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
    const prev = ((o.before ? o.before.approved : f.raw.approved) as { projects?: Record<string, string> } |
      undefined)?.projects;
    if (!f.projects.some((p) => p.name === o.project)) return [false, `no project ${o.project} in review.yaml`, []];
    if (!prev) return [false, "no earlier proof with per-project hashes; run `arnx approve` without --project", []];
    const changed = f.projects.filter((p) => p.name !== o.project && prev[p.name] !== projectDigest(f, p.name));
    if (changed.length) {
      return [false, `${changed.map((p) => p.name).join(", ")} changed since its proof; run \`arnx approve\` ` +
        "without --project", []];
    }
    const same = (a: unknown, b: unknown) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
    if (o.before ? !o.before.proven || f.projects.some((p) => p.name !== o.project &&
        !same(base.get(p.name), o.before!.baseline.get(p.name))) : stampedBaseline(f) !== baselineDigest(repo)) {
      return [false, `${BASELINE_FILE} changed since its proof; run \`arnx approve\` without --project`, []];
    }
    run = f.projects.filter((p) => p.name === o.project);
  }
  const summaries: string[] = [];
  const suites: ApprovedSuite[] = [];
  const settings = settingsOf(repo);
  const accepted = settings?.acceptedTestsDir;
  const pins = acceptedPins(repo, o.localPins ?? null);
  // Right after setup, which said so, an accepted test changed since accept does not stop the proof.
  const trusted = o.afterSetup ? { ...pins, changed: [] } : pins;
  const quick = new Set(o.quick ?? []);
  const tmp = tempDir("arnx-approve-");
  try {
    const snap = join(tmp, "repo");
    const untracked = o.untracked ?? settings?.untracked ?? false;
    const taken = takeSnapshot(repo, null, snap, secretPinsOf(f.raw), { sandbox: sandboxOnlyOf(f.raw), untracked });
    const lacking = lackingOf(taken, filesAt(repo, null, untracked), repo);
    // The file may hold a guess's stand-in, which runs read as the value; the logs keep neither.
    const boundary = new Boundary(configSuspects(repo));
    boundary.addScrubbed(taken);
    const swap = swapIn(boundary, snap);
    // The code now, against the code setup's runs saw: only taken right after setup.
    const code = o.afterSetup?.length ? withSandbox(snapshotDigest(snap), sandboxOnlyOf(f.raw)) : null;
    copyManifests(snap, join(tmp, "manifests"));
    const sameTests = (a?: BaselineTest[], b?: BaselineTest[]) => JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
    // Every project runs, so one approve names every project that needs fixing.
    for (const cfg of run) {
      const log = join(repo, ".arnx", "run", f.legacy ? "approve-build.log" : `approve-build-${cfg.name}.log`);
      const output = posix.join(".arnx", "run", f.legacy ? "approve.log" : `approve-${cfg.name}.log`);
      const mine = base.get(cfg.name) ?? [];
      const was = o.unchanged;
      if (was && !f.legacy && was.rest === restDigest(f) && !pins.changed.length &&
          was.projects[cfg.name] === projectDigest(f, cfg.name) &&
          sameTests(mine, was.baseline.get(cfg.name)) && !o.afterSetup?.some((r) => r.name === cfg.name)) {
        say(`${cfg.name}: ✓ unchanged since its proof`);
        suites.push({ name: cfg.name, ok: true, summary: "unchanged since its proof", acceptedFailing: 0,
          unexpected: [], log: output, baselineFailing: mine.length, left: [], flaky: [], reused: true });
        summaries.push(`${cfg.name}: unchanged since its proof`);
        next.set(cfg.name, mine);
        continue;
      }
      const prior = o.afterSetup?.find((r) => r.name === cfg.name && r.snapshot === code && r.untracked === untracked &&
        r.env === envDigest(cfg));
      const stands = prior && prior.digest === runDigest(f, cfg.name)
        ? setupRunStands(prior, cfg, mine, trusted, accepted) : null;
      if (stands) rmSync(join(repo, output), { force: true });
      const [ok, summary, , skips, , , counts] = stands ?? await runSuite(cfg, snap, log, {
        sessionFactory: o.sessionFactory, key: envKey(cfg, join(tmp, "manifests")), acceptedTestsDir: accepted,
        accepted: trusted, outputLog: join(repo, output), baseline: mine, rerun: true, passedBefore: !!prior, leftOut: lacking,
        ...(quick.has(cfg.name) ? { precheck: true, quick: true } : {}), boundary, swap });
      const moved = [counts.left.length ? `${counts.left.length} left the baseline (they pass now)` : "",
        counts.flaky.length ? `${plural(counts.flaky.length, "test")} failed, then passed when run again (flaky): ` +
          few(counts.flaky) : ""].filter(Boolean).map((x) => ` · ${x}`).join("");
      say(`${cfg.name}: ${ok ? "✓" : "✗"} ${stands ? "setup's run stands: " : ""}${gist(summary)}${ok ? moved : ""}` +
        `${skips.length ? ` · skipped because ${skips.join("; ")}` : ""}`);
      suites.push({ name: cfg.name, ok, summary, acceptedFailing: counts.acceptedFailing, unexpected: counts.unexpected,
        log: output, baselineFailing: counts.baselineFailing, left: counts.left, flaky: counts.flaky,
        ...(stands ? { reused: true as const } : {}) });
      if (ok) summaries.push(f.legacy ? summary : `${cfg.name}: ${summary}`);
      const left = new Set(counts.left);
      const joined = prior ? counts.failed.filter((t) => counts.flaky.includes(t.testId))
        .map((t) => ({ ...entryOf(t), flaky: true as const })) : [];
      next.set(cfg.name, [...mine.filter((b) => !left.has(b.id)), ...joined]);
    }
    const failed = suites.filter((s) => !s.ok);
    if (failed.length) return [false, boundary.mask(failed.map((s) => failedSuite(s, f.legacy, repo)).join("\n\n")), suites];
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  writeBaseline(repo, next);
  const hash = baselineDigest(repo);
  writeFileSync(reviewConfigPath(repo), f.legacy ? stamp(f.projects[0]!, o.by, o.at, hash)
    : stampFile(f, o.by, o.at, hash, [...quick]));
  return [true, summaries.join("; "), suites];
}

export const approveConfig = approveFile;

/** Setup's run as a project's proof, judged against today's baseline (`mine`) and accepted tests, in runSuite's terms
 * ([ok, summary, tail, skips, failing files, hints, counts]); null when it does not stand: a test failing outside the
 * baseline, an accepted test changed since accept, or a baseline that no longer matches the run. */
function setupRunStands(run: SetupRun, cfg: ReviewConfig, mine: BaselineTest[], trusted: AcceptedPins,
                        accepted?: string): [boolean, string, string, string[], string[], string, SuiteCounts] | null {
  // A project with no tests of its own ran only arnx's one-line test: there is nothing to judge again.
  if (!run.counts.all.length) return [true, run.summary, "", run.skips, [], "", run.counts];
  const [ok, verdict, counts] = suiteOk(run.counts.all, cfg, trusted, accepted, mine);
  return ok && !counts.left.length ? [true, verdict + run.after, "", run.skips, [], "", counts] : null;
}

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
    const boundary = new Boundary(configSuspects(repo));
    const untracked = o.untracked ?? settings?.untracked ?? false;
    const taken = takeSnapshot(repo, null, snap, secretPinsOf(f.raw), { sandbox: sandboxOnlyOf(f.raw), untracked });
    boundary.addScrubbed(taken);
    const lacking = lackingOf(taken, filesAt(repo, null, untracked), repo);
    const swap = swapIn(boundary, snap);
    copyManifests(snap, join(tmp, "manifests"));
    for (const cfg of f.projects) {
      const log = join(repo, ".arnx", "run", f.legacy ? "baseline-build.log" : `baseline-build-${cfg.name}.log`);
      const output = posix.join(".arnx", "run", f.legacy ? "baseline.log" : `baseline-${cfg.name}.log`);
      const all = { ...cfg, knownFailing: [] };
      let [ok, summary, , , , , counts] = await runSuite(all, snap, log, { sessionFactory: o.sessionFactory,
        key: envKey(cfg, join(tmp, "manifests")), acceptedTestsDir: accepted, accepted: trusted,
        outputLog: join(repo, output), baseline: "record", leftOut: lacking, boundary, swap });
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
