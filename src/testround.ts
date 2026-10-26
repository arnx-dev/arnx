// One round: snapshot, clear the generated-tests directory, the brain's agent round over tools that run here, then
// run what it wrote `runs` times in the sandbox and classify; for a review, tests that failed in every run (and, for
// the fix proof, some that passed in every run) then run on the code before the change. Used by review and by
// answered questions.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { type AgentResult, Workspace } from "./agent";
import { adapterFor } from "./adapters";
import { bakedError, bakedIn, bakedKey, rebuildText } from "./baked";
import { BEFORE_STATUSES, beforeStartText, beforeText, type BeforeCheck, type BeforeRun, FIX_STATUSES, type FixCheck,
  fixText, judgeBefore, judgeFix, notChecked, SKIP_REASONS } from "./before";
import type { AnswerInput, Brain, ReviewInput, RoundBase, RoundHunt, RoundTools } from "./brain";
import { snapshot } from "./change";
import { type ReviewConfig, secretPinsOf } from "./config";
import { ArnxError } from "./errors";
import { clip, emit, testMessage } from "./events";
import { type Classified, classify, describeRun, funcOf, ownerFile, runTests, type TestResult } from "./outcomes";
import { dockerSteps, ensureEnv, envKey, REPORT_DIR, requireDocker, type Runner, type RunResult, Session,
  type SessionFactory } from "./sandbox";
import type { Say } from "./progress";
import { describeTypecheck, runTypecheck, type TscError, type TypeCheck, type TypeCheckBefore, type TypeCheckRun,
  typeCheckOf } from "./typecheck";
import { databaseEnv, dbUntested, untestedFiles } from "./untested";

export const TOOL_TIMEOUT = 300;
export const RUN_TIMEOUT = 600;

export interface Round {
  agent: AgentResult;
  files: Record<string, string>;
  classified: Classified;
  removed: string[];
  /** True when a run_tests call showed the agent results from its own files (or it wrote no tests). */
  sawResults: boolean;
  /** Changed files with SQL that no generated test ran against the project's database (absent without one). */
  dbUntested?: string[];
  /** The before/after check of the tests that failed in every run (absent when it is off or none failed). */
  before?: BeforeCheck;
  /** The fix proof: passing tests on the code before the change (absent when it is off or no test passed). */
  fixProof?: FixCheck;
  /** The project's type check (absent when it has none, and in answer rounds). */
  typecheck?: TypeCheck;
}

export const dockerSession: SessionFactory = async (cfg, snap, buildLog, body, envFrom, key) => {
  requireDocker();
  let image = await ensureEnv(cfg, envFrom ?? snap, buildLog, key);
  // An image holding an older copy of the code (baked.ts) is built again for the code in the snapshot. The before/after
  // check copies its code in once the session is up: a copy that differs from it then refuses the first run.
  let guard: ((s: Session) => Runner) | null = null;
  if (existsSync(snap) && readdirSync(snap).length) {
    const baked = bakedIn(cfg, image, snap);
    if (baked?.differ.length) {
      dockerSteps.say?.(rebuildText(cfg, baked));
      image = await ensureEnv(cfg, snap, buildLog, bakedKey(image.slice(image.indexOf(":") + 1), baked.copies, snap));
    }
  } else {
    guard = (s) => {
      let checked = false;
      return { run: (command, timeout) => {
        if (!checked) {
          checked = true;
          const baked = bakedIn(cfg, image, snap);
          if (baked?.differ.length) throw bakedError(cfg, baked);
        }
        return s.run(command, timeout);
      } };
    };
  }
  const session = await new Session(image, cfg, snap).start();
  try {
    return await body(guard ? guard(session) : session);
  } finally {
    session.close();
  }
};

/** A round and what its hunt left (not saved with the round). */
export interface Tested extends Round { hunt?: RoundHunt }

/** What a round asks the brain for, built on the snapshot (the hunt reads it); the round adds its budget, its
 * directory and its progress. */
export type RoundAsk = { kind: "review"; input: Omit<ReviewInput, keyof RoundBase> }
  | { kind: "answer"; input: Omit<AnswerInput, keyof RoundBase> };

export function writeDirOf(cfg: ReviewConfig, sub = ""): string {
  return posix.normalize(posix.join(cfg.workdir, cfg.testsDir, sub)).replace(/\/$/, "");
}

/** The folders `arnx accept` keeps tests in, relative to the repository: the configured one and the defaults. */
export function acceptedRoots(cfg: ReviewConfig, acceptedTestsDir = "tests/arnx"): string[] {
  const rel = (d: string) => posix.normalize(posix.join(cfg.workdir, d)).replace(/\/$/, "");
  return [...new Set([acceptedTestsDir, "__tests__/arnx", "tests/arnx"].map(rel))];
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
export function keptTestFiles(repo: string, cfg: ReviewConfig, acceptedTestsDir?: string): string[] {
  return keptIn(join(repo, DOME), cfg, acceptedTestsDir).map((p) => `${DOME}/${p}`);
}

/** Files an arnx before the DOME kept inside the project, where its own test run collects them: every file in its
 * accepted folders (support files too), and Rust's kept files. */
export function legacyKeptFiles(repo: string, cfg: ReviewConfig, acceptedTestsDir?: string): string[] {
  return keptIn(repo, cfg, acceptedTestsDir, true);
}

function keptIn(root: string, cfg: ReviewConfig, acceptedTestsDir?: string, all = false): string[] {
  const adapter = adapterFor(cfg);
  const inRoots = acceptedRoots(cfg, acceptedTestsDir).filter((d) => existsSync(join(root, d)))
    .flatMap((d) => collect(root, d, all ? /./ : adapter.writable))
    .filter((p) => all || adapter.isTestFile(posix.basename(p)));
  const own = (adapter.kept?.dirs ?? []).map((d) => posix.normalize(posix.join(cfg.workdir, d)).replace(/\/$/, ""))
    .filter((d) => existsSync(join(root, d)))
    .flatMap((d) => readdirSync(join(root, d)).filter((n) => adapter.kept!.name.test(n) &&
      lstatSync(join(root, d, n)).isFile()).map((n) => posix.join(d, n)));
  return [...new Set([...inRoots, ...own])].sort();
}

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
export function probeRun(session: Runner, snap: string, cfg: ReviewConfig, dir: string, report: string, timeout: number)
  : { seen: boolean; result: RunResult; results: TestResult[] | null; files: string[] } {
  const files = adapterFor(cfg).probes(cfg.runner).map((p) => ({ ...p, rel: posix.join(dir, p.file) }));
  try {
    for (const p of files) {
      mkdirSync(join(snap, dir), { recursive: true });
      writeFileSync(join(snap, p.rel), p.source);
    }
    const [result, results] = runTests(session, snap, cfg, files.map((p) => posix.relative(cfg.workdir, p.rel)),
      report, timeout);
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
export function probeFailure(cfg: ReviewConfig, result: RunResult, log: string): ArnxError {
  const why = result.timedOut ? "timed out" : `exited ${result.exitCode ?? "?"} without a report`;
  const tail = result.output.trim().split("\n").slice(-6).map((l) => `  ${l}`).join("\n");
  return new ArnxError(`${cfg.name}: the test environment runs no test at this commit: arnx's one-line test ` +
    `${why}. The review stopped before writing tests (output: ${log})${tail ? `\n${tail}` : ""}`);
}

export async function testRound(repo: string, head: string | null, cfg: ReviewConfig, o: {
  brain: Brain; ask: (snap: string) => RoundAsk | Promise<RoundAsk>; writeDir: string; budgetUsd: number;
  runs: number; outDir: string; sessionFactory?: SessionFactory; progress?: Say;
  /** Changed files the round should cover: after each final reply the brain is told which of them no test names
   * yet, and which hold SQL that no test connecting to the database names. */
  coverage?: string[];
  /** Run the tests that failed in every run on the code before the change: `base` is that commit (null: the change
   * has none); `deadline` (performance.now() ms) is when the review is out of time; `fixProofMax`: also run up to
   * this many tests that passed in every run, the first by test id (0 or absent: none). */
  before?: { base: string | null; deadline?: number; fixProofMax?: number };
  /** Run the project's type check (`cfg.typecheck`) once after the final runs, without the generated tests:
   * `changed` are the change's files (repository paths); with errors, `base` (null: the change has none; absent: no
   * comparison) is the code before the change to compare them with. */
  typecheck?: { changed: string[]; base?: string | null };
  /** A working-tree round (head null) copies untracked files too (opted in, or no commits yet); default: tracked
   * files only, since the agent reads the snapshot and the tests' output goes to the model. */
  untracked?: boolean }): Promise<Tested> {
  const say = (m: string) => o.progress?.(`${cfg.name}: ${m}`);
  const adapter = adapterFor(cfg);
  mkdirSync(o.outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "arnx-"));
  let agent: AgentResult, files: Record<string, string>, results: (TestResult[] | null)[], removed: string[];
  let saw = false, dbLeft: string[] | undefined, before: BeforeCheck | undefined, headKey = "";
  let hunt: RoundHunt | undefined;
  let fixProof: FixCheck | undefined;
  let checked: TypeCheckRun | undefined, typecheck: TypeCheck | undefined;
  const dbNames = databaseEnv(cfg.env, cfg.services);
  try {
    const snap = join(tmp, "repo");
    removed = snapshot(repo, head, snap, secretPinsOf(cfg.raw), { untracked: !!o.untracked }).map((w) => w.path);
    // Clear earlier generated files only: for some languages the tests directory also holds the project's own tests.
    mkdirSync(join(snap, o.writeDir), { recursive: true });
    for (const rel of collect(snap, o.writeDir, adapter.writable)) rmSync(join(snap, rel), { force: true });
    // The image's key before any run: runs may write a manifest into the snapshot (cargo's Cargo.lock).
    headKey = envKey(cfg, snap);
    // The brain starts at once (a hunt needs no sandbox); its tools arrive once the session is up. A session that
    // fails before then fails the brain's round too.
    let open!: (t: RoundTools) => void, fail!: (e: unknown) => void;
    const tools = new Promise<RoundTools>((resolve, reject) => {
      [open, fail] = [resolve, reject];
    });
    tools.catch(() => {});
    // With `context = "precise"` the hunt's context waits for the project's code index (built in its environment).
    const ask = await o.ask(snap);
    const base = { budgetUsd: o.budgetUsd, outDir: o.outDir, ...(o.progress ? { progress: o.progress } : {}) };
    const round = ask.kind === "review" ? o.brain.agentRound("review", { ...ask.input, ...base }, tools)
      : o.brain.agentRound("answer", { ...ask.input, ...base }, tools);
    round.catch(() => {});
    const read = (p: string) => {
      try {
        return readFileSync(join(snap, p), "utf8");
      } catch {
        return null;
      }
    };
    const generatedNow = () => Object.fromEntries(collect(snap, o.writeDir, adapter.writable)
      .map((rel) => [rel, readFileSync(join(snap, rel), "utf8")]));
    [agent, files, results] = await (o.sessionFactory ?? dockerSession)(cfg, snap, join(o.outDir, "env-build.log"),
      async (session) => {
        say("checking that the environment runs a test");
        const probe = probeRun(session, snap, cfg, o.writeDir, "probe.xml", RUN_TIMEOUT);
        if (!probe.seen) {
          const log = join(o.outDir, "probe.log");
          writeFileSync(log, probe.result.output);
          throw probeFailure(cfg, probe.result, log);
        }
        let counter = 0;
        // Runs name the generated test files, never the tests directory: for some languages (Rust) that directory
        // also holds the project's own tests, which are not part of the review.
        const generated = () => collect(snap, o.writeDir, adapter.writable)
          .filter((p) => adapter.isTestFile(posix.basename(p)));
        const expand = (targets: string[]) =>
          targets.flatMap((t) => (posix.normalize(t) === posix.normalize(o.writeDir) ? generated() : [t]))
            .map((t) => posix.relative(cfg.workdir, t) || ".");
        const run = (targets: string[]) => {
          const rel = expand(targets);
          if (!rel.length) return `no test files under ${o.writeDir}/ yet`;
          const [result, results] = runTests(session, snap, cfg, rel, `agent-${++counter}.xml`, TOOL_TIMEOUT);
          const own = generated();
          if (results?.some((t) => ownerFile(t.fileAttr, own) !== null)) saw = true;
          return describeRun(result, results, own);
        };
        const ws = new Workspace(snap, { writeDir: o.writeDir, runTests: run, adapter, runner: cfg.runner });
        // The facts the brain decides its follow-ups on: what the generated tests name, computed here.
        const coverage = o.coverage ?? [];
        open({ tools: () => ws.tools(), call: (name, args) => ws.call(name, args),
          facts: () => {
            const now = generatedNow();
            return { untestedFiles: untestedFiles(coverage, now, adapter),
              dbUntested: dbUntested(coverage, read, now, adapter, dbNames), generatedFiles: Object.keys(now) };
          } });
        const done = await round;
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
          say(failing ? `final run ${i + 1}/${o.runs} (${files.length} file${files.length === 1 ? "" : "s"} with failures)`
            : `final run ${i + 1}/${o.runs}`);
          const [run, parsed] = runTests(session, snap, cfg, files.length ? files : target, `final-${i + 1}.xml`,
            RUN_TIMEOUT);
          const got = ours(parsed), secs = Math.round(run.seconds * 10) / 10;
          if (!got || !failing || !first) {
            r.push(got);
            if (got) ran(i + 1, got, false, secs);
            else emit("test.run_missing", { project: cfg.name, repeat: i + 1, timed_out: run.timedOut,
              exit_code: run.exitCode, seconds: secs });
            continue;
          }
          const rerun = new Set(got.map((t) => ownerFile(t.fileAttr, Object.keys(f))));
          const kept = first.filter((t) => !rerun.has(ownerFile(t.fileAttr, Object.keys(f))));
          r.push([...kept, ...got]);
          ran(i + 1, kept, true);
          ran(i + 1, got, false, secs);
        }
        if (o.typecheck && cfg.typecheck) checked = typecheckHere(session, snap, cfg, o.writeDir, say);
        return [a, f, r] as const;
      }).catch((e: unknown) => {
        fail(e);
        throw e;
      });
    const classes = o.before ? classify(results) : null;
    const failing = classes?.findings ?? [];
    // Chosen by test id, so the same tests are checked whatever order the runner reported them in.
    const proofs = o.before?.fixProofMax ? [...classes!.passed]
      .sort((a, b) => (a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0)).slice(0, o.before.fixProofMax) : [];
    if (o.before && (failing.length || proofs.length)) {
      ({ before, fixProof } = await beforeStage(repo, cfg, { ...o.before, findings: failing, proofs, files,
        writeDir: o.writeDir, runs: o.runs, headSnap: snap, headKey, tmp, outDir: o.outDir,
        sessionFactory: o.sessionFactory ?? dockerSession, say }));
    }
    if (checked) {
      typecheck = await typecheckDone(repo, cfg, checked, { ...o.typecheck!, headSnap: snap, headKey, tmp,
        outDir: o.outDir, sessionFactory: o.sessionFactory ?? dockerSession, say });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  for (const [rel, source] of Object.entries(files)) {
    const dest = join(o.outDir, "tests", rel + COPY_SUFFIX);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, source);
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
  return { agent, files, classified, removed, sawResults: saw || !hasTests,
    ...(dbLeft ? { dbUntested: dbLeft } : {}), ...(before ? { before } : {}), ...(fixProof ? { fixProof } : {}),
    ...(typecheck ? { typecheck } : {}), ...(hunt ? { hunt } : {}) };
}

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
  base?: string | null; outDir: string; sessionFactory?: SessionFactory; progress?: Say; untracked?: boolean })
  : Promise<TypeCheck | null> {
  if (!cfg.typecheck) return null;
  const say = (m: string) => o.progress?.(`${cfg.name}: ${m}`);
  const sessionFactory = o.sessionFactory ?? dockerSession;
  mkdirSync(o.outDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "arnx-"));
  try {
    const snap = join(tmp, "repo");
    snapshot(repo, head, snap, secretPinsOf(cfg.raw), { untracked: !!o.untracked });
    const headKey = envKey(cfg, snap);
    const run = await sessionFactory({ ...cfg, services: [] }, snap, join(o.outDir, "env-build.log"),
      async (session) => typecheckHere(session, snap, cfg, writeDirOf(cfg), say));
    return await typecheckDone(repo, cfg, run, { changed: o.changed, ...(o.base !== undefined ? { base: o.base } : {}),
      headSnap: snap, headKey, tmp, outDir: o.outDir, sessionFactory, say });
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
function typecheckHere(session: Runner, snap: string, cfg: ReviewConfig, writeDir: string, say: (m: string) => void)
  : TypeCheckRun {
  say("type check");
  let run: TypeCheckRun;
  try {
    clearArnxFiles(snap, cfg, writeDir);
    run = runTypecheck(session, cfg);
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
  say: (m: string) => void }): Promise<TypeCheck> {
  let secs = run.seconds;
  let before: { status: TypeCheckBefore; errors?: TscError[] } | undefined, error: string | undefined;
  if (run.status === "errors" && o.base !== undefined) {
    if (o.base === null) before = { status: "no-base" };
    else {
      try {
        const snap = join(o.tmp, "typecheck-before");
        snapshot(repo, o.base, snap, secretPinsOf(cfg.raw));
        clearArnxFiles(snap, cfg, writeDirOf(cfg));
        if (envKey(cfg, snap) !== o.headKey) before = { status: "dependencies-changed" };
        else {
          o.say("type check on the code before the change");
          const there = await o.sessionFactory({ ...cfg, services: [] }, snap, join(o.outDir, "typecheck-env-build.log"),
            async (session) => runTypecheck(session, cfg), o.headSnap, o.headKey);
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
  const t = typeCheckOf(cfg, run, o.changed, secs, before);
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
async function beforeStage(repo: string, cfg: ReviewConfig, o: { base: string | null; deadline?: number;
  findings: TestResult[]; proofs: TestResult[]; files: Record<string, string>; writeDir: string; runs: number;
  headSnap: string; headKey: string; tmp: string;
  outDir: string; sessionFactory: SessionFactory; say: (m: string) => void })
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
    const runs = await o.sessionFactory(cfg, snap, join(o.outDir, "before-env-build.log"), async (session) => {
      // The code before the change is copied only once the image is ready: its files are then newer than any build
      // in the image, so cargo rebuilds them instead of running the change's build as fresh.
      const t0 = performance.now();
      snapshot(repo, o.base!, snap, secretPinsOf(cfg.raw));
      // Generated files the base happens to hold are cleared, as for the round; the round's own go in as they ran.
      mkdirSync(join(snap, o.writeDir), { recursive: true });
      for (const rel of collect(snap, o.writeDir, adapterFor(cfg).writable)) rmSync(join(snap, rel), { force: true });
      for (const [rel, source] of Object.entries(o.files)) {
        mkdirSync(dirname(join(snap, rel)), { recursive: true });
        writeFileSync(join(snap, rel), source);
      }
      // The image is the change's; when the change alters what keys it, a same failure before it proves nothing.
      envChanged = envKey(cfg, snap) !== o.headKey;
      snapshotMs = ms(t0);
      const out: BeforeRun[] = [];
      for (let i = 1; ids.length && i <= o.runs; i++) {
        if (o.deadline !== undefined && performance.now() >= o.deadline) {
          late = true;
          break;
        }
        const t = performance.now();
        const [run, parsed] = runTests(session, snap, cfg, targets, `before-${i}.xml`, RUN_TIMEOUT);
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
        const [run, parsed] = runTests(session, snap, cfg, proofTargets, `fix-proof-${i}.xml`, RUN_TIMEOUT);
        const took = ms(t);
        proofMs += took;
        const ours = parsed?.filter((x) => ownerFile(x.fileAttr, own) !== null) ?? [];
        proofRuns.push({ results: ours.length ? ours : null, output: run.output, timedOut: run.timedOut });
        emit("fix_proof.run", { project: cfg.name, run: i, files: proofTargets.length, duration_ms: took,
          reported: ours.length > 0, timed_out: run.timedOut });
      }
      return out;
    }, o.headSnap, o.headKey);
    if (late) return skip("time");
    return result(() => done(Object.fromEntries(o.findings.map((t) =>
      [t.testId, judgeBefore(t, ownerFile(t.fileAttr, own), runs, envChanged)]))),
    () => proofLate ? proved({}, "time") : proved(Object.fromEntries(o.proofs.map((t) => {
      const file = ownerFile(t.fileAttr, own);
      return [t.testId, judgeFix(t, file, file !== null && owners.includes(file) ? runs : proofRuns, envChanged)];
    }))));
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const why = `the check failed (${message.split("\n")[0]!.slice(0, 200)})`;
    return result(() => done(notChecked(ids, why), "error", message), () => proved({}, "error", message));
  }
}
