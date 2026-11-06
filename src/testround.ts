// One round: snapshot, clear the generated-tests directory, the brain's agent round over tools that run here, then
// run what it wrote `runs` times in the sandbox and classify; for a review, tests that failed in every run (and, for
// the fix proof, some that passed in every run) then run on the code before the change. Used by review and by
// answered questions.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { type AgentResult, Workspace } from "./agent";
import { adapterFor, getAdapter } from "./adapters";
import { DEFAULT_ACCEPTED_DIR } from "./adapters/types";
import { absentFromSnapshot, bakedError, bakedIn, imageFiles, bakedKey, type BakedCopy, copyOnly, type CopyOnly, CopyDiffers, copyStopText, rebuildText }
  from "./baked";
import { asFallbackBefore, asFallbackFix, BEFORE_STATUSES, beforeStartText, beforeText, type BeforeCheck, type BeforeRun, FIX_STATUSES, type FixCheck,
  fakedFix, fakedName, fixText, judgeBefore, judgeFix, namesAdded, newNames, notChecked, sharedInGroups, SKIP_REASONS, textBefore, textFix,
  vacuousBefore, vacuousPass } from "./before";
import type { AnswerInput, Brain, ReviewInput, RoundBase, RoundHunt, RoundTools } from "./brain";
import { type Boundary, maskedCopy, type Swap } from "./boundary";
import { holdsIn, staleLine, staleRewrites, standInsLine, writeStandIns } from "./standins";
import { fallbackImage } from "./envprune";
import { filesAt, snapshot, takeSnapshot, type Withheld, withSandboxFiles } from "./change";
import { type ReviewConfig, sandboxOnlyOf, secretPinsOf } from "./config";
import { EnvFailed } from "./errors";
import { markUnproven } from "./diagnose";
import { clip, emit, testMessage } from "./events";
import { baseName, type Classified, classify, describeRun, funcOf, ownerFile, runBounded, runTests, serialFlag, type TestResult } from "./outcomes";
import { buildContextOf, DEFAULT_LIMITS, dockerSteps, ensureEnv, envKey, REPORT_DIR, requireDocker, type Runner, type RunResult, Session,
  type SessionFactory } from "./sandbox";
import type { Say } from "./progress";
import { describeTypecheck, recordTypecheck, runTypecheck, type TscError, type TypeCheck, type TypeCheckBefore, type TypeCheckRun,
  typeCheckOf, workspaceNames } from "./typecheck";
import { databaseEnv, dbUntested, untestedFiles } from "./untested";
import { clearReach, countable, type Reach, readReach, reachedSince } from "./reached";
import { projectSource, shallowKind } from "./shallow";
import { evidencePacks, snapshotTree } from "./evidence";
import { parseReports } from "./report";

export const TOOL_TIMEOUT = 300;
export const RUN_TIMEOUT = 600;
/** One repeat of a round's files: together within today's run limit, and only after that times out apart (outcomes.ts runBounded). */
export const RUN_BOUNDS = { together: RUN_TIMEOUT, file: 180, total: 600 };

export interface Round {
  /** Something in it was masked (boundary.ts). */
  standInsShown?: boolean;
  agent: AgentResult;
  files: Record<string, string>;
  classified: Classified;
  removed: string[];
  /** Those files, with what they hold and where. */
  leftOut?: Withheld[];
  /** Files the snapshot holds with a fake for their private key. */
  fakedKeys?: string[];
  /** Test files that did not finish alone within their time (each is one error, never a finding). */
  hungFiles?: string[];
  /** Test files the time ran out before (each is one error; the review is incomplete). */
  notRunFiles?: string[];
  /** True when a run_tests call showed the agent results from its own files (or it wrote no tests). */
  sawResults: boolean;
  /** Changed files with SQL that no generated test ran against the project's database (absent without one). */
  dbUntested?: string[];
  /** Changed files (of the round's coverage) the final runs executed, by the runner's own notes (reached.ts), less what
   * arnx's one-line test's run showed. Absent when the runs left no notes: no data, not "none reached". */
  reached?: string[];
  /** The before/after check of the tests that failed in every run (absent when it is off or none failed). */
  before?: BeforeCheck;
  /** The fix proof: passing tests on the code before the change (absent when it is off or no test passed). */
  fixProof?: FixCheck;
  /** The project's type check (absent when it has none, and in answer rounds). */
  typecheck?: TypeCheck;
  /** The evidence pack of each test that failed in every run, by test id (evidence.ts): built from the snapshot, for the
   * second opinion. */
  evidence?: Record<string, string>;
  /** This commit's own environment could not be had: `failed` (the round is empty and made no model call) or `fallback`
   * (the tests ran on the image built for another commit). `log` is a file in the round's folder. */
  env?: EnvState;
}

export interface EnvState { state: "failed" | "fallback"; kind: "build" | "probe"; log: string;
  /** The failing commit is not the checked-out one (a range or an older commit): setup would prove another tree. */
  old?: true }

/** What a model's text means in the snapshot `snap`, `ours` (and the runners' reports) not being real text. */
export const swapIn = (b: Boundary, snap: string, ours: (rel: string) => boolean = () => false): Swap =>
  b.swapFor(snap, (rel) => rel === REPORT_DIR || ours(rel));

/** The files `rels` of a snapshot, as they mean there: tests kept with their stand-ins, now in place to run. */
export function swapFiles(snap: string, rels: readonly string[], swap: Swap): void {
  for (const rel of rels) {
    const was = readFileSync(join(snap, rel), "utf8");
    const now = swap.text(was);
    if (now !== was) writeFileSync(join(snap, rel), now);
  }
}

// `swap` reaches the session only when runs read the mounted code: a baked copy comes from the build context, so it holds
// each guess's stand-in, and a test, an env or a command holding that stand-in agrees with it as it is. `Runner.copies` tells
// whoever places a test. A test there that reads a project file by path and compares with a stand-in fails: /src holds the value.
export const dockerSession: SessionFactory = async (cfg, snap, buildLog, body, envFrom, key, swap) => {
  requireDocker();
  // Another snapshot's image was built for that snapshot's session. That snapshot now holds a model's tests, with real values
  // when there is no build context to copy instead, and a build has network: it is never built from now.
  let image = await ensureEnv(cfg, envFrom ?? snap, buildLog, key, { built: !!envFrom });
  // An image holding an older copy of the code (baked.ts) is built again for the code in the snapshot, once per version
  // of that code (keyed on it: later sessions and reviews of the same code reuse it). The before/after check copies its
  // code in once the session is up: a copy that differs from it then refuses the first run.
  let guard: ((s: Runner) => Runner) | null = null;
  let copies: BakedCopy[] = [];
  if (existsSync(snap) && readdirSync(snap).length) {
    const baked = bakedIn(cfg, image, snap);
    copies = baked?.copies ?? [];
    if (baked?.differ.length) {
      dockerSteps.say?.(rebuildText(cfg, baked));
      const own = bakedKey(image.slice(image.indexOf(":") + 1), cfg, baked.copies, snap);
      image = await ensureEnv(cfg, snap, buildLog, own, { mark: true });
    }
  } else {
    guard = (s) => {
      let checked = false;
      return { run: async (command, timeout) => {
        if (!checked) {
          checked = true;
          const baked = bakedIn(cfg, image, snap);
          if (baked?.differ.length) throw bakedError(cfg, baked);
        }
        return s.run(command, timeout);
      } };
    };
  }
  const session = await new Session(image, cfg, snap, DEFAULT_LIMITS, copies.length ? undefined : swap).start();
  // Files the tests need that no model may read are in the snapshot only while a test runs.
  const placed = withSandboxFiles(session, snap);
  const runner = guard ? guard(placed) : placed;
  try {
    return await body(copies.length ? { run: (command, timeout) => runner.run(command, timeout),
      copies: (output) => copyOnly(cfg, image, copies, snap, output) } : runner);
  } finally {
    session.close();
  }
};

/** The stop of a round whose environment could not be had, and what the agent of that round is: nothing, no model asked. */
export const ENV_FAILED = "env_failed: ";
const envFailedAgent = (kind: "build" | "probe"): AgentResult => ({ finalText: "", costUsd: 0, turns: 0,
  stop: `${ENV_FAILED}${kind}`, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, calls: 0 });

/** The key of the image built for another commit that this commit's tests may run on, or null. Null when its image holds
 * a copy of the code that runs reach and that differs from this code: those runs would test the other commit's code. */
export function usableFallback(cfg: ReviewConfig, snap: string): string | null {
  const image = fallbackImage(cfg);
  if (!image) return null;
  const baked = existsSync(snap) && readdirSync(snap).length ? bakedIn(cfg, image.tag, snap) : null;
  if (baked?.differ.length) return null;
  // A copy holding files this commit removed would run (or leak) what is gone.
  if (baked && absentFromSnapshot(cfg, baked.copies, imageFiles(image.tag), snap).length) return null;
  return image.tag.slice(image.tag.indexOf(":") + 1);
}

/** A round and what its hunt left (not saved with the round). */
export interface Tested extends Round { hunt?: RoundHunt }

/** What a round asks the brain for, built on the snapshot (the hunt reads it); the round adds its budget, its
 * directory and its progress. */
export type RoundAsk = { kind: "review"; input: Omit<ReviewInput, keyof RoundBase> }
  | { kind: "answer"; input: Omit<AnswerInput, keyof RoundBase> };

export function writeDirOf(cfg: ReviewConfig, sub = ""): string {
  return posix.normalize(posix.join(cfg.workdir, cfg.testsDir, sub)).replace(/\/$/, "");
}

/** The folder `arnx accept` keeps a project's tests in (relative to its root): `acceptedTestsDir`, the configured one.
 * While that is the default, a TypeScript project whose tests_dir is not the default one (its runner's roots or
 * testRegex lead arnx's tests elsewhere) keeps them beside it, in a folder named arnx next to arnx_generated, where
 * the runner `arnx check` starts collects them too. */
export function acceptedDirFor(cfg: ReviewConfig, acceptedTestsDir = DEFAULT_ACCEPTED_DIR): string {
  const parent = posix.dirname(posix.normalize(cfg.testsDir));
  if (cfg.language !== "typescript" || acceptedTestsDir !== DEFAULT_ACCEPTED_DIR ||
    cfg.testsDir === adapterFor(cfg).defaultTestsDir || parent === ".") return acceptedTestsDir;
  return posix.join(parent, "arnx");
}

/** The folders `arnx accept` keeps tests in, relative to the repository: the configured one and the defaults. */
export function acceptedRoots(cfg: ReviewConfig, acceptedTestsDir = DEFAULT_ACCEPTED_DIR): string[] {
  const rel = (d: string) => posix.normalize(posix.join(cfg.workdir, d)).replace(/\/$/, "");
  return [...new Set([acceptedDirFor(cfg, acceptedTestsDir), "__tests__/arnx", "tests/arnx"].map(rel))];
}

/** Whether `path` (relative to the repository) is a file `arnx accept` kept for this project. */
export function isKeptPath(cfg: ReviewConfig, path: string, acceptedTestsDir?: string): boolean {
  const under = (d: string) => d === "." || path.startsWith(`${d}/`);
  if (acceptedRoots(cfg, acceptedTestsDir).some(under)) return true;
  const kept = adapterFor(cfg).kept;
  return !!kept && kept.name.test(posix.basename(path)) &&
    kept.dirs.some((d) => posix.dirname(path) === posix.normalize(posix.join(cfg.workdir, d)).replace(/\/$/, ""));
}

/** Where `arnx accept` keeps tests: each at the path it runs from (`api/tests/arnx/r…/test_x.py`) under this
 * folder, which test runners leave out (setup proves it), so the project's own test run never imports, collects or runs
 * one. Only `arnx check` puts them in place, in its throwaway copy of the repository. */
export const DOME = ".arnx/tests";

/** The path a kept file runs from (repository-relative): its path under DOME. */
export const runPath = (p: string): string => p.startsWith(`${DOME}/`) ? p.slice(DOME.length + 1) : p;

/** The test files `arnx accept` kept for this project that exist, relative to the repository (under DOME). */
export function keptTestFiles(repo: string, cfg: ReviewConfig, acceptedTestsDir?: string,
                              projects: readonly ReviewConfig[] = [cfg]): string[] {
  return keptIn(join(repo, DOME), cfg, acceptedTestsDir, false, projects).map((p) => `${DOME}/${p}`);
}

/** The project among `projects` whose folder holds `path` (repository-relative), the deepest one. */
export function deepestHolder<T extends ReviewConfig>(projects: readonly T[], path: string): T | undefined {
  const holds = (c: ReviewConfig) => posix.normalize(c.workdir) === "." || path.startsWith(`${posix.normalize(c.workdir)}/`);
  return [...projects].sort((a, b) => posix.normalize(a.workdir).length - posix.normalize(b.workdir).length)
    .filter(holds).at(-1);
}

/** Files an arnx before the DOME kept inside the project, where its own test run collects them: every file in its
 * accepted folders (support files too), and Rust's kept files. */
export function legacyKeptFiles(repo: string, cfg: ReviewConfig, acceptedTestsDir?: string): string[] {
  return keptIn(repo, cfg, acceptedTestsDir, true);
}

/** Kept files are collected under either name rule: the project's test_files names, or the adapter's usual ones (a
 * file kept before test_files was set, or under another ending, is never dropped by a change of names), and from any
 * accepted folder they sit in: the configured and default ones, and every `arnx/r<review>` folder under the project
 * (where an earlier tests_dir had them kept). */
function keptIn(root: string, cfg: ReviewConfig, acceptedTestsDir?: string, all = false,
                projects: readonly ReviewConfig[] = [cfg]): string[] {
  const adapter = adapterFor(cfg);
  const base = getAdapter(cfg.language);
  const writable = (n: string) => adapter.writable.test(n) || base.writable.test(n);
  const isTest = (n: string) => adapter.isTestFile(n) || base.isTestFile(n);
  const inRoots = acceptedRoots(cfg, acceptedTestsDir).filter((d) => existsSync(join(root, d)))
    .flatMap((d) => collect(root, d, /./).filter((p) => all || writable(posix.basename(p))))
    .filter((p) => all || isTest(posix.basename(p)));
  const sat = !all && existsSync(join(root, cfg.workdir))
    ? collect(root, cfg.workdir === "." ? "" : cfg.workdir, /./).filter((p) => KEPT_FOLDER.test(p) && deepestHolder(projects, p)?.name === cfg.name &&
      (all || writable(posix.basename(p))) && (all || isTest(posix.basename(p)))) : [];
  const own = (adapter.kept?.dirs ?? []).map((d) => posix.normalize(posix.join(cfg.workdir, d)).replace(/\/$/, ""))
    .filter((d) => existsSync(join(root, d)))
    .flatMap((d) => readdirSync(join(root, d)).filter((n) => adapter.kept!.name.test(n) &&
      lstatSync(join(root, d, n)).isFile()).map((n) => posix.join(d, n)));
  return [...new Set([...inRoots, ...sat, ...own])].sort();
}

/** A kept file's folder: `<anywhere>/arnx/r<review id>/`, as accept lays them out. */
const KEPT_FOLDER = /(?:^|\/)arnx\/r\d+_[0-9a-f]+\//;

/** The project's own files among `paths` (relative to the repository) that a round would clear from its tests
 * directory as its own: the adapter's writable names, outside the folders `arnx accept` keeps tests in. Rust's
 * writable names are arnx's (arnx_generated_*.rs), so a crate's own tests in tests/ never count. */
export function ownTestsInWriteDir(cfg: ReviewConfig, paths: string[], acceptedTestsDir?: string): string[] {
  const adapter = adapterFor(cfg);
  const dir = writeDirOf(cfg);
  const under = (p: string, d: string) => d === "." || p.startsWith(`${d}/`);
  const accepted = acceptedRoots(cfg, acceptedTestsDir);
  return paths.filter((p) => under(p, dir) && adapter.writable.test(posix.basename(p)) &&
    !accepted.some((d) => under(p, d))).sort();
}

/** Why a tests_dir holding the project's own files (`own`, from ownTestsInWriteDir) cannot be used. */
export function ownTestsProblem(cfg: ReviewConfig, own: string[]): string {
  const adapter = adapterFor(cfg);
  const dir = writeDirOf(cfg);
  const sub = posix.relative(cfg.workdir, posix.join(dir, "arnx_generated"));
  const def = adapter.defaultTestsDir;
  const such = def === sub || def === posix.relative(cfg.workdir, dir) ? sub : `${def} (the default) or ${sub}`;
  return `${dir}/ already holds the project's own tests (${own.slice(0, 3).join(", ")}${own.length > 3 ? ", …" : ""}): ` +
    `a review clears every ${adapter.words(cfg.runner).writableFiles} file there as its own, which would leave them ` +
    `out of the review and could overwrite them; set tests_dir to a new, empty folder, such as ${such}`;
}

/** Files under `dir` (relative to `root`; "" for root itself) whose names match `rx`, as sorted POSIX paths relative
 * to `root`. */
export function collect(root: string, dir: string, rx: RegExp): string[] {
  const out: string[] = [];
  const visit = (abs: string, rel: string) => {
    for (const name of readdirSync(abs)) {
      const p = join(abs, name);
      const r = rel ? `${rel}/${name}` : name;
      const st = lstatSync(p);
      if (st.isDirectory()) visit(p, r);
      else if (st.isFile() && rx.test(name)) out.push(r);
    }
  };
  visit(join(root, dir), dir);
  return out.sort();
}

/** A review keeps its tests under .arnx/reviews/<id>/, each name ending in COPY_SUFFIX: inside the repository, a test
 * runner's own discovery (Jest's and Vitest's defaults) would run them otherwise, and their relative imports point
 * nowhere from there. Reviews written before it hold the names as they are; both read. */
export const COPY_SUFFIX = ".arnx-copy";
/** An old-named copy found beside its suffixed one: kept under this name, which no runner and no reader picks up. */
const OLD_COPY = ".arnx-old";

/** A review's kept test files under `root`, by their own (repository-relative) path; `writable` picks them by name. */
export function readCopies(root: string, writable: RegExp): Record<string, string> {
  if (!existsSync(root)) return {};
  return Object.fromEntries(collect(root, "", /./).map((p) => [p.endsWith(COPY_SUFFIX) ? p.slice(0, -COPY_SUFFIX.length)
    : p, p] as const).filter(([name]) => writable.test(posix.basename(name)))
    .map(([name, p]) => [name, readFileSync(join(root, p), "utf8")]));
}

/** Every review's kept tests renamed with COPY_SUFFIX (reviews written before it), so the repository's test runner
 * stops finding them; how many were renamed. */
export function suffixReviewCopies(repo: string): number {
  const reviews = join(repo, ".arnx", "reviews");
  if (!existsSync(reviews)) return 0;
  const isDir = (p: string) => existsSync(p) && lstatSync(p).isDirectory();
  let n = 0;
  // Only folders are reviews and projects: a stray file (.DS_Store, a file named `projects`) is passed over.
  for (const id of readdirSync(reviews).filter((d) => isDir(join(reviews, d)))) {
    const rdir = join(reviews, id);
    const projects = join(rdir, "projects");
    const roots = [join(rdir, "tests"), ...(isDir(projects)
      ? readdirSync(projects).map((p) => join(projects, p, "tests")) : [])];
    for (const root of roots.filter(isDir)) {
      for (const p of collect(root, "", /./).filter((x) => !x.endsWith(COPY_SUFFIX) && !x.endsWith(OLD_COPY))) {
        // A suffixed copy already there is the newer one (readCopies reads it): the old-named file is kept beside it
        // under another name, out of the test runner's sight, never written over it.
        const to = join(root, p + COPY_SUFFIX);
        renameSync(join(root, p), existsSync(to) ? join(root, p + OLD_COPY) : to);
        n++;
      }
    }
  }
  return n;
}

/** Runs the adapter's one-line probe tests placed in `dir` (relative to the repository), then removes them. `seen`:
 * one was reported passing. Setup proves tests_dir with it; a round first proves the environment runs a test at all. */
export async function probeRun(session: Runner, snap: string, cfg: ReviewConfig, dir: string, report: string, timeout: number,
                               o: { serial?: boolean } = {})
  : Promise<{ seen: boolean; result: RunResult; results: TestResult[] | null; files: string[] }> {
  const files = adapterFor(cfg).probes(cfg.runner).map((p) => ({ ...p, rel: posix.join(dir, p.file) }));
  try {
    for (const p of files) {
      mkdirSync(join(snap, dir), { recursive: true });
      writeFileSync(join(snap, p.rel), p.source);
    }
    const [result, results] = await runTests(session, snap, cfg, files.map((p) => posix.relative(cfg.workdir, p.rel)),
      report, timeout, o);
    const seen = (results ?? []).some((t) => t.outcome === "passed" &&
      ownerFile(t.fileAttr, files.map((p) => p.rel)) !== null);
    return { seen, result, results, files: files.map((p) => p.rel) };
  } finally {
    for (const p of files) rmSync(join(snap, p.rel), { force: true });
  }
}

/** Why a round stops before its brain writes a test: the environment runs no test at this commit (a member's
 * manifest that builds differently from the image, a build script that downloads). Every test would go without a
 * report, and the review would read as one that found nothing. */
export function probeFailure(cfg: ReviewConfig, result: RunResult, log: string, copies?: CopyOnly): EnvFailed {
  const why = result.timedOut ? "timed out" : `exited ${result.exitCode ?? "?"} without a report`;
  const tail = result.output.trim().split("\n").slice(-6).map((l) => `  ${l}`).join("\n");
  return new EnvFailed(`${cfg.name}: the test environment runs no test at this commit: arnx's one-line test ` +
    `${why}. The review stopped before writing tests (output: ${log})${tail ? `\n${tail}` : ""}` +
    (copies ? `\n${copyStopText(cfg, copies)}` : ""), "probe", basename(log));
}

export async function testRound(repo: string, head: string | null, cfg: ReviewConfig, o: {
  brain: Brain; ask: (snap: string) => RoundAsk | Promise<RoundAsk>; writeDir: string; budgetUsd: number;
  runs: number; outDir: string; sessionFactory?: SessionFactory; progress?: Say;
  /** Changed files the round should cover: after each final reply the brain is told which of them no test names
   * yet, and which hold SQL that no test connecting to the database names. */
  coverage?: string[];
  /** Run the tests that failed in every run on the code before the change: `base` is that commit (null: the change
   * has none); `diff`: the change, to tell a fix from a test that fakes what only the change uses; `deadline`
   * (performance.now() ms) is when the review is out of time; `fixProofMax`: also run up to
   * this many tests that passed in every run, the first by test id (0 or absent: none). */
  before?: { base: string | null; diff?: string; deadline?: number; fixProofMax?: number };
  /** Run the project's type check (`cfg.typecheck`) once after the final runs, without the generated tests:
   * `changed` are the change's files (repository paths); with errors, `base` (null: the change has none; absent: no
   * comparison) is the code before the change to compare them with. */
  typecheck?: { changed: string[]; base?: string | null; skipped?: TypeCheck };
  /** A working-tree round (head null) copies untracked files too (opted in, or no commits yet); default: tracked
   * files only, since the agent reads the snapshot and the tests' output goes to the model. */
  untracked?: boolean;
  /** A commit whose environment cannot be had ends in an empty round saying so (a review; else the error is thrown). */
  recordEnvFailure?: boolean;
  /** Build each failing test's evidence pack from the snapshot: `diff` is the project's part of the change, `message`
   * its commit message. */
  evidence?: { diff: string; message: string } }): Promise<Tested> {
  const say = (m: string) => o.progress?.(`${cfg.name}: ${m}`);
  const adapter = adapterFor(cfg);
  mkdirSync(o.outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "arnx-"));
  let agent: AgentResult, files: Record<string, string>, results: (TestResult[] | null)[], removed: string[];
  let leftOut: Withheld[] = [], fakedKeys: string[] = [];
  let saw = false, dbLeft: string[] | undefined, before: BeforeCheck | undefined, headKey = "";
  let hunt: RoundHunt | undefined;
  let env: EnvState | undefined;
  // Once a round's files have run apart, every later run goes file by file; a file that did not finish alone is not
  // run again.
  let apart = false;
  // Whether this session's runs ask the runner for one process (decided at the probe).
  let serial = false;
  const hungLimits: Record<string, number> = {}, notRunSet = new Set<string>();
  let fixProof: FixCheck | undefined;
  let baked = false;
  let checked: TypeCheckRun | undefined, typecheck: TypeCheck | undefined;
  let reached: string[] | undefined;
  let evidence: Record<string, string> | undefined;
  const dbNames = databaseEnv(cfg.env, cfg.services);
  try {
    const snap = join(tmp, "repo");
    const taken = takeSnapshot(repo, head, snap, secretPinsOf(cfg.raw), { sandbox: sandboxOnlyOf(cfg.raw),
      untracked: !!o.untracked });
    removed = taken.withheld.map((w) => w.path);
    leftOut = taken.withheld;
    ({ fakedKeys } = taken);
    // What the snapshot replaced, for the developer: file, line and rule, never a value; and a rewrite of text that is gone.
    const listed = writeStandIns(o.outDir, taken.standInList);
    if (listed) say(standInsLine(taken.standIns.length ? taken.standIns : [...new Set(taken.standInList.map((r) => r.path))], listed));
    const stale = staleRewrites(cfg.install, holdsIn(buildContextOf(snap)));
    if (stale.length) say(staleLine(cfg.name, stale));
    // Before the brain hears anything from this snapshot.
    const filter = o.brain.boundary;
    filter?.addScrubbed(taken);
    // What the tests directory holds from here on is a model's or arnx's.
    const swap = filter && swapIn(filter, snap, (rel) => rel === o.writeDir || rel.startsWith(`${o.writeDir}/`));
    // Clear earlier generated files only: for some languages the tests directory also holds the project's own tests.
    mkdirSync(join(snap, o.writeDir), { recursive: true });
    for (const rel of collect(snap, o.writeDir, adapter.writable)) rmSync(join(snap, rel), { force: true });
    // The image's key before any run: runs may write a manifest into the snapshot (cargo's Cargo.lock).
    headKey = envKey(cfg, snap);
    // With `context = "precise"` the hunt's context waits for the project's code index (built in its environment).
    const asked = await o.ask(snap);
    // A round is told what its code lacks, whether the change touches it or not.
    const ask: RoundAsk = asked.kind === "review" && leftOut.length ? { ...asked, input: { ...asked.input,
      scope: { ...asked.input.scope, leftOut: [...new Map([...asked.input.scope.leftOut ?? [], ...leftOut].map((w) => [w.path, w])).values()] } } }
      : asked;
    const base = { budgetUsd: o.budgetUsd, outDir: o.outDir, ...(o.progress ? { progress: o.progress } : {}) };
    const read = (p: string) => {
      try {
        return readFileSync(join(snap, p), "utf8");
      } catch {
        return null;
      }
    };
    const generatedNow = () => Object.fromEntries(collect(snap, o.writeDir, adapter.writable)
      .map((rel) => [rel, readFileSync(join(snap, rel), "utf8")]));
    const body = async (session: Runner) => {
        say("checking that the environment runs a test");
        // The runs of a few generated files use one process when the project configured workers; a runner that does not
        // report the probe with that flag runs as configured, for the whole session.
        serial = serialFlag(cfg, snap) !== null;
        let probe = await probeRun(session, snap, cfg, o.writeDir, "probe.xml", RUN_TIMEOUT, { serial });
        if (!probe.seen && serial && !probe.result.timedOut) {
          serial = false;
          say("the runner refused the single-process flag; running as configured");
          probe = await probeRun(session, snap, cfg, o.writeDir, "probe.xml", RUN_TIMEOUT);
        }
        if (!probe.seen) {
          const log = join(o.outDir, "probe.log");
          const said = { ...probe.result, output: filter ? filter.mask(probe.result.output) : probe.result.output };
          writeFileSync(log, said.output);
          throw probeFailure(cfg, said, log, session.copies?.(probe.result.output));
        }
        // What any test of the folder loads (conftest and its imports) is no test's reach.
        const probeReach: Reach = readReach(snap);
        clearReach(snap);
        let counter = 0;
        // Runs name the generated test files, never the tests directory: for some languages (Rust) that directory
        // also holds the project's own tests, which are not part of the review.
        const generated = () => collect(snap, o.writeDir, adapter.writable)
          .filter((p) => adapter.isTestFile(posix.basename(p)));
        const expand = (targets: string[]) =>
          targets.flatMap((t) => (posix.normalize(t) === posix.normalize(o.writeDir) ? generated() : [t]))
            .map((t) => posix.relative(cfg.workdir, t) || ".");
        const run = async (targets: string[]) => {
          const rel = expand(targets);
          if (!rel.length) return `no test files under ${o.writeDir}/ yet`;
          const [result, results] = await runTests(session, snap, cfg, rel, `agent-${++counter}.xml`, TOOL_TIMEOUT, { serial });
          const own = generated();
          if (results?.some((t) => ownerFile(t.fileAttr, own) !== null)) saw = true;
          return describeRun(result, results, own);
        };
        // A copy holding the stand-ins is what tests run on, while the tools read the files here.
        baked = !!session.copies;
        const ws = new Workspace(snap, { writeDir: o.writeDir, runTests: run, adapter, runner: cfg.runner, reads: swap,
          ...(baked ? {} : { writes: swap }) });
        // The facts the brain decides its follow-ups on: what the generated tests name, computed here.
        const coverage = o.coverage ?? [];
        const tools: RoundTools = { tools: () => ws.tools(), call: (name, args) => ws.call(name, args),
          facts: () => {
            const now = generatedNow();
            return { untestedFiles: untestedFiles(coverage, now, adapter),
              dbUntested: dbUntested(coverage, read, now, adapter, dbNames), generatedFiles: Object.keys(now) };
          } };
        // The brain starts only now, the hunt too: a review the probe stops has made no model call.
        const done = await (ask.kind === "review"
          ? o.brain.agentRound("review", { ...ask.input, ...base }, Promise.resolve(tools))
          : o.brain.agentRound("answer", { ...ask.input, ...base }, Promise.resolve(tools)));
        hunt = done.hunt;
        const a = done.agent;
        const f = generatedNow();
        emit("test.files", { project: cfg.name, files: Object.keys(f).sort() });
        if (o.coverage?.length && dbNames.length) dbLeft = dbUntested(o.coverage, read, f, adapter, dbNames);
        const target = expand([o.writeDir]);
        const hasTests = target.length > 0;
        // Only the generated tests count: a command that ignores {targets} can also run the project's own suite.
        // A run in which no generated test appears counts as a run without a report.
        const ours = (results: TestResult[] | null) => {
          const kept = results?.filter((x) => ownerFile(x.fileAttr, Object.keys(f)) !== null) ?? [];
          return kept.length ? kept : null;
        };
        // Everything runs once; only files with a failing test run again, because a finding must fail in every run
        // and a flaky test is one that fails only sometimes. A file that passed is carried into the later runs as it
        // was. A run without a report repeats everything.
        const r: (TestResult[] | null)[] = [];
        // The agent's runs are not the final ones. Each final run's notes are read after it, with what it reported.
        clearReach(snap);
        const reach: Reach = new Map();
        let noted = false;
        const ran = (repeat: number, res: TestResult[], carried: boolean, secs?: number) => res.forEach((t) =>
          emit("test.run", { project: cfg.name, repeat, test_id: t.testId, func: funcOf(t), file: t.fileAttr,
            outcome: t.outcome, message: testMessage(t.message), carried,
            ...(secs === undefined ? {} : { run_seconds: secs }) }));
        for (let i = 0; hasTests && i < o.runs; i++) {
          const first = r.find((x) => x !== null) ?? null;
          const failing = first ? [...new Set(first.filter((t) => t.outcome === "failed" || t.outcome === "error")
            .map((t) => ownerFile(t.fileAttr, Object.keys(f))).filter((x): x is string => !!x))] : null;
          if (failing && !failing.length) {
            r.push(first);
            ran(i + 1, first!, true);
            continue;
          }
          const files = failing ? target.filter((t) => failing.some((p) => p.endsWith(t) || t.endsWith(posix.basename(p))))
            : target;
          say(failing ? `final run ${i + 1}/${o.runs} (${files.length} file${files.length === 1 ? "" : "s"} to run again)`
            : `final run ${i + 1}/${o.runs}`);
          const bounded = await runBounded(session, snap, cfg, files.length ? files : target, `final-${i + 1}.xml`,
            { ...RUN_BOUNDS, apart, hung: hungLimits, serial });
          const [run, parsed] = [bounded.run, bounded.results];
          apart = bounded.apart;
          Object.assign(hungLimits, bounded.hung);
          // Files that ran this time are no longer unrun.
          for (const t of files.length ? files : target) notRunSet.delete(t);
          bounded.notRun.forEach((t) => notRunSet.add(t));
          const nh = Object.keys(bounded.hung).length;
          if (nh) say(`${nh === 1 ? "a test file" : `${nh} test files`} did not finish`);
          if (bounded.notRun.length) say(`${bounded.notRun.length === 1 ? "a test file" : `${bounded.notRun.length} test files`} not run: out of time`);
          // Masked before it is saved, as the probe's log is.
          if (run.output) writeFileSync(join(o.outDir, `final-${i + 1}.log`), filter ? filter.mask(run.output) : run.output);
          const got = ours(parsed), secs = Math.round(run.seconds * 10) / 10;
          const notes = readReach(snap);
          clearReach(snap);
          noted ||= notes.size > 0;
          const broken = !got || got.some((t) => t.outcome === "error") || nh > 0 || bounded.notRun.length > 0;
          for (const [p, kind] of countable(notes, broken)) if (kind === "ran" || !reach.has(p)) reach.set(p, kind);
          if (!got || !failing || !first) {
            r.push(got);
            if (got) ran(i + 1, got, false, secs);
            else emit("test.run_missing", { project: cfg.name, repeat: i + 1, timed_out: run.timedOut,
              exit_code: run.exitCode, seconds: secs });
          } else {
            const rerun = new Set(got.map((t) => ownerFile(t.fileAttr, Object.keys(f))));
            const kept = first.filter((t) => !rerun.has(ownerFile(t.fileAttr, Object.keys(f))));
            r.push([...kept, ...got]);
            ran(i + 1, kept, true);
            ran(i + 1, got, false, secs);
          }
        }
        // Read run by run above, before the type check clears the report folder.
        if (o.coverage && noted) {
          const own = new Set(o.coverage);
          reached = reachedSince(reach, probeReach).filter((p) => own.has(p));
        }
        if (o.typecheck && cfg.typecheck && !o.typecheck.skipped) checked = await typecheckHere(session, snap, cfg, o.writeDir, say);
        return [a, f, r] as const;
    };
    const factory = o.sessionFactory ?? dockerSession;
    const attempt = (key?: string) => factory(cfg, snap, join(o.outDir, "env-build.log"), body, key ? snap : undefined, key,
      swap);
    let got: Awaited<ReturnType<typeof attempt>> | null = null;
    try {
      got = await attempt();
    } catch (e) {
      // Only a review records a commit whose environment cannot be had; a connection that failed says nothing about it.
      if (!(e instanceof EnvFailed) || e.network || !o.recordEnvFailure) throw e;
      const fallback = usableFallback(cfg, snap);
      say(fallback ? "this commit's own install does not build; trying the image built for another commit"
        : "this commit's own install does not build");
      if (fallback) {
        try {
          got = await attempt(fallback);
          [headKey, env] = [fallback, { state: "fallback", kind: e.kind, log: e.log }];
        } catch (e2) {
          if (!(e2 instanceof EnvFailed)) throw e2;
        }
      }
      if (!got) {
        // Nothing was asked of a model: the round is empty and says why.
        got = [envFailedAgent(e.kind), {}, []];
        env = { state: "failed", kind: e.kind, log: e.log };
      }
    }
    [agent, files, results] = got;
    // A test failing for a file the snapshot left out, or a key it holds a fake of, says nothing about the project.
    const tree = removed.length || fakedKeys.length ? filesAt(repo, head, !!o.untracked) : [];
    results = results.map((run) => run && markUnproven(run, { leftOut: removed, fakedKeys, all: tree }));
    const classes = o.before ? classify(results) : null;
    const failing = classes?.findings ?? [];
    // Chosen by test id, so the same tests are checked whatever order the runner reported them in.
    const proofs = o.before?.fixProofMax ? [...classes!.passed]
      .sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0)).slice(0, o.before.fixProofMax) : [];
    if (o.before && (failing.length || proofs.length)) {
      ({ before, fixProof } = await beforeStage(repo, cfg, { ...o.before, findings: failing, proofs, passed: [...(classes?.passed ?? [])].map((x) => x.testId), files,
        writeDir: o.writeDir, runs: o.runs, apart, serial, headSnap: snap, headKey, tmp, outDir: o.outDir, fallback: env?.state === "fallback",
        sessionFactory: o.sessionFactory ?? dockerSession, say, ...(baked ? {} : { swap }),
        ...(o.brain.boundary ? { boundary: o.brain.boundary } : {}) }));
    }
    // While the snapshot is here: what the second opinion is told about each failing test's code.
    if (o.evidence) {
      evidence = roundEvidence(snap, results, files, hunt, agent, o.writeDir, o.evidence, before, o.brain.boundary, say);
    }
    if (o.typecheck?.skipped) {
      typecheck = o.typecheck.skipped;
      say(`type check: ${describeTypecheck(typecheck)}`);
    } else if (checked) {
      typecheck = await typecheckDone(repo, cfg, checked, { ...o.typecheck!, headSnap: snap, headKey, tmp,
        outDir: o.outDir, sessionFactory: o.sessionFactory ?? dockerSession, say, ...(baked ? {} : { swap }) });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const b = o.brain.boundary;
  for (const [rel, source] of Object.entries(files)) {
    const dest = join(o.outDir, "tests", rel + COPY_SUFFIX);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, b ? b.maskValues(source) : source);
  }
  const hasTests = Object.keys(files).some((rel) => adapter.isTestFile(posix.basename(rel)));
  const classified = classify(results);
  const classes = { finding: classified.findings, flaky: classified.flaky, error: classified.errors,
    passed: classified.passed };
  for (const [kind, tests] of Object.entries(classes)) {
    for (const t of tests) {
      emit("test.classified", { project: cfg.name, test_id: t.testId, func: funcOf(t), class: kind,
        message: testMessage(t.message) });
    }
  }
  const hungFiles = Object.keys(hungLimits).sort(), notRunFiles = [...notRunSet].sort();
  const round: Round = { agent, files, classified, removed, ...(leftOut.length ? { leftOut } : {}),
    ...(fakedKeys.length ? { fakedKeys } : {}), ...(hungFiles.length ? { hungFiles } : {}), ...(notRunFiles.length ? { notRunFiles } : {}), sawResults: saw || !hasTests,
    ...(dbLeft ? { dbUntested: dbLeft } : {}), ...(reached ? { reached } : {}), ...(before ? { before } : {}), ...(fixProof ? { fixProof } : {}),
    ...(typecheck ? { typecheck } : {}), ...(env ? { env } : {}), ...(evidence ? { evidence } : {}) };
  // All a round says from here on is saved and read by people and coding agents, none of it through a model's filter.
  const masked = b ? maskedCopy(b, round) : { value: round, shown: false };
  return { ...masked.value, ...(masked.shown ? { standInsShown: true } : {}), ...(hunt ? { hunt } : {}) };
}

/** The evidence pack of each test that failed in every run, read from the round's snapshot (evidence.ts), all under
 * one time bound. A test the reviewer tied to a suspect gets the suspect's file as its own. */
function roundEvidence(snap: string, results: (TestResult[] | null)[], files: Record<string, string>,
  hunt: RoundHunt | undefined, agent: AgentResult, writeDir: string, o: { diff: string; message: string },
  before: BeforeCheck | undefined, boundary: Boundary | undefined, say: Say): Record<string, string> | undefined {
  const failing = classify(results).findings;
  // A pack is built only through the outgoing filter.
  if (!failing.length || !boundary) return undefined;
  const report = parseReports([...agent.earlierTexts ?? [], agent.finalText]);
  const suspectOf = new Map<string, string>();
  for (const t of report.tests) {
    if (typeof t !== "object" || t === null || Array.isArray(t)) continue;
    const { test, suspect } = t as Record<string, unknown>;
    if (typeof test === "string" && typeof suspect === "string") suspectOf.set(funcOfId(test), suspect.trim());
  }
  const t0 = performance.now();
  const items = failing.map((t) => {
    const file = ownerFile(t.fileAttr, Object.keys(files));
    const source = file ? files[file] ?? "" : "";
    const func = funcOf(t);
    const suspect = hunt?.suspects?.find((s) => s.id === suspectOf.get(func))?.file;
    const was = before?.tests[t.testId];
    const shallow = shallowKind(source || undefined, func);
    return { testSource: source, func, ...(file ? { testFile: file } : {}), ...(suspect ? { suspectFile: suspect } : {}),
      ...(was ? { before: was } : {}), ...(shallow ? { shallow } : {}) };
  });
  const packs = evidencePacks({ tree: snapshotTree(snap), diff: o.diff, commitMessage: o.message, writeDir,
    generated: Object.keys(files), boundary }, items);
  const secs = (performance.now() - t0) / 1000;
  if (secs >= 5) say(`evidence for the second opinion took ${Math.round(secs)}s`);
  return Object.fromEntries(failing.map((t, i) => [t.testId, packs[i]!]));
}

const funcOfId = (test: string) => baseName(test.split("::").at(-1) ?? "").trim();

/** Clears what arnx wrote into a snapshot: the generated files and the runners' reports. A type check then sees the
 * project's own files only. */
function clearArnxFiles(snap: string, cfg: ReviewConfig, writeDir: string): void {
  if (existsSync(join(snap, writeDir))) {
    for (const rel of collect(snap, writeDir, adapterFor(cfg).writable)) rmSync(join(snap, rel), { force: true });
  }
  rmSync(join(snap, REPORT_DIR), { recursive: true, force: true });
}

/** The type check alone, for a project routing gave no agent round (its changed files are reviewed by their owners):
 * the change's snapshot, the project's image without services, the type check, compared with the code before the
 * change as a round's is. Null when the project has no type check. A failure here is the type check's, never the
 * review's. */
export async function typecheckRound(repo: string, head: string | null, cfg: ReviewConfig, o: { changed: string[];
  base?: string | null; outDir: string; sessionFactory?: SessionFactory; progress?: Say; untracked?: boolean;
  boundary?: Boundary; skipped?: TypeCheck }): Promise<TypeCheck | null> {
  if (!cfg.typecheck) return null;
  if (o.skipped) {
    o.progress?.(`${cfg.name}: type check: ${describeTypecheck(o.skipped)}`);
    return o.skipped;
  }
  const say = (m: string) => o.progress?.(`${cfg.name}: ${m}`);
  const sessionFactory = o.sessionFactory ?? dockerSession;
  mkdirSync(o.outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "arnx-"));
  try {
    const snap = join(tmp, "repo");
    o.boundary?.addScrubbed(takeSnapshot(repo, head, snap, secretPinsOf(cfg.raw), { sandbox: sandboxOnlyOf(cfg.raw),
      untracked: !!o.untracked }));
    const swap = o.boundary && swapIn(o.boundary, snap);
    const headKey = envKey(cfg, snap);
    let baked = false;
    const run = await sessionFactory({ ...cfg, services: [] }, snap, join(o.outDir, "env-build.log"), async (session) => {
      baked = !!session.copies;
      return await typecheckHere(session, snap, cfg, writeDirOf(cfg), say);
    }, undefined, undefined, swap);
    return await typecheckDone(repo, cfg, run, { changed: o.changed, ...(o.base !== undefined ? { base: o.base } : {}),
      headSnap: snap, headKey, tmp, outDir: o.outDir, sessionFactory, say, ...(baked ? {} : { swap }) });
  } catch (e) {
    const run: TypeCheckRun = { status: "failed", errors: [], output: e instanceof Error ? e.message : String(e),
      exitCode: null, timedOut: false, seconds: 0 };
    return typeCheckOf(cfg, run, o.changed, 0);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** The type check on the change, in the round's session after its final runs (nothing else runs in that snapshot
 * after it). arnx's generated tests are taken out of the snapshot first rather than excluded through a tsconfig of
 * arnx's: that works for any tsconfig (extends, files, project references) and any checker. */
async function typecheckHere(session: Runner, snap: string, cfg: ReviewConfig, writeDir: string, say: (m: string) => void)
  : Promise<TypeCheckRun> {
  say("type check");
  let run: TypeCheckRun;
  try {
    clearArnxFiles(snap, cfg, writeDir);
    run = await runTypecheck(session, cfg);
  } catch (e) {
    // Whatever goes wrong here is the type check's, never the round's.
    run = { status: "failed", errors: [], output: e instanceof Error ? e.message : String(e), exitCode: null,
      timedOut: false, seconds: 0 };
  }
  emit("typecheck.run", { project: cfg.name, on: "change", status: run.status, errors: run.errors.length,
    exit_code: run.exitCode, timed_out: run.timedOut, duration_ms: Math.round(run.seconds * 1000) });
  return run;
}

/** The type check's result. With errors, and a base to compare with, the code before the change is type checked
 * too: a snapshot of it in the change's image, without services (a type check needs none). When the change alters
 * what keys the image, its dependencies differ there and errors are not compared. */
async function typecheckDone(repo: string, cfg: ReviewConfig, run: TypeCheckRun, o: { changed: string[];
  base?: string | null; headSnap: string; headKey: string; tmp: string; outDir: string; sessionFactory: SessionFactory;
  say: (m: string) => void; swap?: Swap }): Promise<TypeCheck> {
  let secs = run.seconds;
  let before: { status: TypeCheckBefore; errors?: TscError[] } | undefined, error: string | undefined;
  if (run.status === "errors" && o.base !== undefined) {
    if (o.base === null) before = { status: "no-base" };
    else {
      try {
        const snap = join(o.tmp, "typecheck-before");
        snapshot(repo, o.base, snap, secretPinsOf(cfg.raw), { sandbox: sandboxOnlyOf(cfg.raw) });
        clearArnxFiles(snap, cfg, writeDirOf(cfg));
        if (envKey(cfg, snap) !== o.headKey) before = { status: "dependencies-changed" };
        else {
          o.say("type check on the code before the change");
          const there = await o.sessionFactory({ ...cfg, services: [] }, snap, join(o.outDir, "typecheck-env-build.log"),
            async (session) => runTypecheck(session, cfg), o.headSnap, o.headKey, o.swap);
          secs += there.seconds;
          emit("typecheck.run", { project: cfg.name, on: "before", status: there.status, errors: there.errors.length,
            exit_code: there.exitCode, timed_out: there.timedOut, duration_ms: Math.round(there.seconds * 1000) });
          before = there.status === "errors" || there.status === "clean" ? { status: "compared", errors: there.errors }
            : { status: "failed" };
        }
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        before = { status: "failed" };
      }
    }
  }
  // What the code before the change had decides whether later reviews skip the check, never what the change adds.
  if (before?.status === "compared") recordTypecheck(repo, cfg, before.errors!.length);
  else if (run.status === "clean") recordTypecheck(repo, cfg, 0);
  const t = typeCheckOf(cfg, run, o.changed, secs, before, workspaceNames(o.headSnap));
  emit("typecheck.done", { project: cfg.name, status: t.status, errors: t.errors, in_changed_files: t.inChangedFiles,
    ...(t.new === undefined ? {} : { new: t.new, pre_existing: t.preExisting }), ...(t.before ? { before: t.before } : {}),
    secs: t.secs, ...(error ? { error: clip(error, 500) } : {}) });
  o.say(`type check: ${describeTypecheck(t)}`);
  return t;
}

/** The before/after check (before.ts): a snapshot of the change's base with the round's generated files exactly as
 * they ran (nothing else from the change), the files with findings run `runs` times there in the change's image with
 * the final runs' timeout, then each finding compared. A check that cannot run leaves its findings `unknown` with
 * the reason; it never stops the review.
 *
 * The fix proof shares its session: `proofs` (tests that passed in every run) in those files are judged from the same
 * runs; the files holding the others run `runs` times more, after the findings' runs, so they cannot change them. */
async function beforeStage(repo: string, cfg: ReviewConfig, o: { base: string | null; diff?: string; deadline?: number;
  findings: TestResult[]; proofs: TestResult[]; passed: string[]; files: Record<string, string>; writeDir: string; runs: number;
  headSnap: string; headKey: string; tmp: string; fallback?: boolean;
  apart?: boolean; serial?: boolean; outDir: string; sessionFactory: SessionFactory; say: (m: string) => void; boundary?: Boundary; swap?: Swap })
  : Promise<{ before?: BeforeCheck; fixProof?: FixCheck }> {
  const started = performance.now();
  const ms = (from: number) => Math.round(performance.now() - from);
  const ids = o.findings.map((t) => t.testId);
  const own = Object.keys(o.files);
  const ownersOf = (tests: TestResult[]) =>
    [...new Set(tests.map((t) => ownerFile(t.fileAttr, own)).filter((x): x is string => !!x))].sort();
  const owners = ownersOf(o.findings);
  const targets = owners.map((p) => posix.relative(cfg.workdir, p) || p);
  // Passing tests in a file with findings ran with them; only the other files run again.
  const proofTargets = ownersOf(o.proofs).filter((p) => !owners.includes(p))
    .map((p) => posix.relative(cfg.workdir, p) || p);
  if (ids.length) emit("before.started", { project: cfg.name, findings: ids.length, files: targets.length });
  if (o.proofs.length) {
    emit("fix_proof.started", { project: cfg.name, tests: o.proofs.length, files: proofTargets.length,
      shared_files: ownersOf(o.proofs).length - proofTargets.length });
  }
  let snapshotMs = 0, runsMs = 0, proofMs = 0;
  // What the failing tests' line said, for the passing tests' line after it.
  let beforeSkipped = false, beforeNew = false;
  const done = (tests: BeforeCheck["tests"], skipped?: string, error?: string): BeforeCheck => {
    // The fix proof's own runs are not the findings' check.
    const total = ms(started) - proofMs;
    const counts = Object.fromEntries(BEFORE_STATUSES.map((st) =>
      [st, Object.values(tests).filter((b) => b.status === st).length]));
    emit("before.done", { project: cfg.name, duration_ms: total, snapshot_ms: snapshotMs, runs_ms: runsMs, counts,
      ...(skipped ? { skipped_reason: skipped } : {}), ...(error ? { error: clip(error, 500) } : {}) });
    const secs = Math.round(total / 100) / 10;
    [beforeSkipped, beforeNew] = [!!skipped, counts["new-code"] === ids.length];
    o.say(`before the change: ${skipped ? `not checked (${tests[ids[0]!]!.detail.replace(/^not checked: /, "")})`
      : beforeText(tests)} (${secs} s)`);
    return { tests, ...(skipped ? { skipped } : {}), secs, snapshotMs, runsMs };
  };
  const proved = (tests: FixCheck["tests"], skipped?: string, error?: string): FixCheck => {
    // Alone in the stage it is charged the whole stage; beside findings, only its own runs.
    const total = ids.length ? proofMs : ms(started);
    const counts = Object.fromEntries(FIX_STATUSES.map((st) =>
      [st, Object.values(tests).filter((f) => f.status === st).length]));
    emit("fix_proof.done", { project: cfg.name, duration_ms: total, runs_ms: proofMs, counts,
      ...(skipped ? { skipped_reason: skipped } : {}), ...(error ? { error: clip(error, 500) } : {}) });
    const secs = Math.round(total / 100) / 10;
    const why = skipped && skipped in SKIP_REASONS ? SKIP_REASONS[skipped as keyof typeof SKIP_REASONS]
      : "the check failed";
    // Skipped with the failing tests, the reason was said once for both. Beside them, its own runs may take no time.
    if (!(skipped && beforeSkipped)) {
      o.say(`before the change: ${skipped ? `${ids.length ? "passing tests " : ""}not checked (${why})`
        : fixText(tests, ids.length > 0 && beforeNew)}${secs || !ids.length ? ` (${secs} s)` : ""}`);
    }
    return { tests, ...(skipped ? { skipped } : {}), secs, runsMs: proofMs };
  };
  // Each part only when it has tests: a round with no findings has no `before`, as without the fix proof.
  const result = (before: () => BeforeCheck, fix: () => FixCheck) =>
    ({ ...(ids.length ? { before: before() } : {}), ...(o.proofs.length ? { fixProof: fix() } : {}) });
  const skip = (reason: keyof typeof SKIP_REASONS) => result(() => done(notChecked(ids, SKIP_REASONS[reason]), reason),
    () => proved({}, reason));
  if (o.base === null) return skip("no-base");
  if (o.deadline !== undefined && performance.now() >= o.deadline) return skip("time");
  o.say(beforeStartText(ids.length, o.proofs.length));
  try {
    const snap = join(o.tmp, "before");
    let late = false, proofLate = false, envChanged = false;
    const proofRuns: BeforeRun[] = [];
    // Its values may reach a model through a run's output, as the change's do.
    const copyCode = () => o.boundary?.addScrubbed(takeSnapshot(repo, o.base!, snap, secretPinsOf(cfg.raw),
      { sandbox: sandboxOnlyOf(cfg.raw) }));
    // Set when the code is in place before the session, for an image made from it (below).
    let inImage = false;
    const inSession = async (session: Runner) => {
      // The code before the change is copied only once the image is ready: its files are then newer than any build
      // in the image, so cargo rebuilds them instead of running the change's build as fresh.
      const t0 = performance.now();
      if (!inImage) copyCode();
      // Generated files the base happens to hold are cleared, as for the round; the round's own go in as they ran.
      mkdirSync(join(snap, o.writeDir), { recursive: true });
      for (const rel of collect(snap, o.writeDir, adapterFor(cfg).writable)) rmSync(join(snap, rel), { force: true });
      for (const [rel, source] of Object.entries(o.files)) {
        mkdirSync(dirname(join(snap, rel)), { recursive: true });
        writeFileSync(join(snap, rel), source);
      }
      // The image is the change's; when the change alters what keys it, a same failure before it proves nothing.
      envChanged = !inImage && envKey(cfg, snap) !== o.headKey;
      snapshotMs = ms(t0);
      const out: BeforeRun[] = [];
      // Files go one at a time once the round's did; a file that hangs alone is not run again.
      let apartNow = !!o.apart;
      const hungBefore: Record<string, number> = {}, hungProof: Record<string, number> = {};
      for (let i = 1; ids.length && i <= o.runs; i++) {
        if (o.deadline !== undefined && performance.now() >= o.deadline) {
          late = true;
          break;
        }
        const t = performance.now();
        const bounded = await runBounded(session, snap, cfg, targets, `before-${i}.xml`,
          { ...RUN_BOUNDS, apart: apartNow, hung: hungBefore, serial: o.serial });
        const [run, parsed] = [bounded.run, bounded.results];
        apartNow = bounded.apart;
        Object.assign(hungBefore, bounded.hung);
        const took = ms(t);
        runsMs += took;
        // As in the final runs, only the generated tests count.
        const ours = parsed?.filter((x) => ownerFile(x.fileAttr, own) !== null) ?? [];
        out.push({ results: ours.length ? ours : null, output: run.output, timedOut: run.timedOut });
        emit("before.run", { project: cfg.name, run: i, files: targets.length, duration_ms: took,
          reported: ours.length > 0, timed_out: run.timedOut });
      }
      for (let i = 1; !late && proofTargets.length && i <= o.runs; i++) {
        if (o.deadline !== undefined && performance.now() >= o.deadline) {
          proofLate = true;
          break;
        }
        const t = performance.now();
        const bounded = await runBounded(session, snap, cfg, proofTargets, `fix-proof-${i}.xml`,
          { ...RUN_BOUNDS, apart: apartNow, hung: hungProof, serial: o.serial });
        const [run, parsed] = [bounded.run, bounded.results];
        apartNow = bounded.apart;
        Object.assign(hungProof, bounded.hung);
        const took = ms(t);
        proofMs += took;
        const ours = parsed?.filter((x) => ownerFile(x.fileAttr, own) !== null) ?? [];
        proofRuns.push({ results: ours.length ? ours : null, output: run.output, timedOut: run.timedOut });
        emit("fix_proof.run", { project: cfg.name, run: i, files: proofTargets.length, duration_ms: took,
          reported: ours.length > 0, timed_out: run.timedOut });
      }
      return out;
    };
    const buildLog = join(o.outDir, "before-env-build.log");
    let runs: BeforeRun[];
    try {
      runs = await o.sessionFactory(cfg, snap, buildLog, inSession, o.headSnap, o.headKey, o.swap);
    } catch (e) {
      if (!(e instanceof CopyDiffers)) throw e;
      // The tests run the image's copy of the code, which is the change's: the code before it needs an image of its own,
      // made from that code, which is there before the session this time. It has that code's dependencies too.
      if (o.deadline !== undefined && performance.now() >= o.deadline) return skip("time");
      [late, proofLate, inImage, snapshotMs, runsMs, proofMs] = [false, false, true, 0, 0, 0];
      proofRuns.length = 0;
      rmSync(snap, { recursive: true, force: true });
      copyCode();
      runs = await o.sessionFactory(cfg, snap, buildLog, inSession, o.headSnap, o.headKey, o.swap);
    }
    if (late) return skip("time");
    // A test that reads one of the project's source files as text and matches it proves no regression and no fix.
    const source = projectSource(o.headSnap, cfg.workdir, (name) => adapterFor(cfg).isTestFile(name));
    const asText = (t: TestResult, file: string | null) => file !== null &&
      shallowKind(o.files[file], funcOf(t), (p) => source(file, p)) === "source-text";
    // Nor does a test that fakes what only the change uses prove a fix.
    const isTest = (name: string) => adapterFor(cfg).isTestFile(name);
    // The whole files give the code its comments and strings: the change's side is the one under review, the other the base.
    const readSide = (path: string, side: "new" | "old") => {
      const at = join(side === "new" ? o.headSnap : snap, path);
      return existsSync(at) ? readFileSync(at, "utf8") : null;
    };
    const added = namesAdded(o.diff ?? "", isTest, readSide);
    // And failing the same way there says nothing when the test uses what the change adds.
    const brought = newNames(o.diff ?? "", isTest, (path) => {
      const at = join(snap, path);
      return existsSync(at) ? readFileSync(at, "utf8") : null;
    }, readSide);
    const passing = new Set(o.passed);
    return result(() => done(Object.fromEntries(o.findings.map((t) => {
      const file = ownerFile(t.fileAttr, own);
      const b = judgeBefore(t, file, runs, envChanged, file === null ? undefined : { source: o.files[file] ?? "", func: funcOf(t) });
      // Tests that pass with the change and fail there with the same message: that message says nothing about this one.
      // A pass there that used a name the change adds, or ran beside a dead background thread, proves no regression.
      const judged = asText(t, file) ? textBefore(b) : file === null ? b : sharedInGroups(vacuousBefore(
        vacuousPass(b, { source: o.files[file] ?? "", func: funcOf(t), names: brought, path: file,
          baseOutput: runs.map((r) => r.output) }), o.files[file] ?? "", funcOf(t), brought, file),
      t.message, [runs, proofRuns], passing);
      return [t.testId, o.fallback ? asFallbackBefore(judged) : judged];
    }))),
    () => proofLate ? proved({}, "time") : proved(Object.fromEntries(o.proofs.map((t) => {
      const file = ownerFile(t.fileAttr, own);
      const f = judgeFix(t, file, file !== null && owners.includes(file) ? runs : proofRuns, envChanged,
        file === null ? undefined : { source: o.files[file] ?? "", func: funcOf(t) });
      const faked = file === null ? null : fakedName(o.files[file] ?? "", added);
      const judged = asText(t, file) ? textFix(f) : faked ? fakedFix(f, faked) : f;
      return [t.testId, o.fallback ? asFallbackFix(judged) : judged];
    }))));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const why = `the check failed (${message.split("\n")[0]!.slice(0, 200)})`;
    return result(() => done(notChecked(ids, why), "error", message), () => proved({}, "error", message));
  }
}
