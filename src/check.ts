// check: run the accepted tests (kept in .arnx/tests/, under names the project's own tools never pick up) of every
// project in its approved sandbox, on the working tree as it is now, and say which still fail. After `arnx accept` the
// tests behind findings marked real fail; fixing the code turns them green, and this is how to see it without setting up the services by hand.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { adapterFor } from "./adapters";
import { Boundary, maskedCopy, STAND_INS_NOTE } from "./boundary";
import { A_FAKED_FILE, markUnproven, unprovenText } from "./diagnose";
import { filesAt, git, hasCommits, takeSnapshot, type Withheld } from "./change";
import { configSuspects, loadReviewFile, type ReviewConfig, sandboxOnlyOf, secretPinsOf } from "./config";
import { ArnxError } from "./errors";
import { entriesUnder, regularBytes } from "./safefs";
import { placed } from "./fixprompt";
import { baseName, ownerFile, runTests, type TestResult } from "./outcomes";
import { keyReruns, rerunCandidates, rerunWithRealKeys, sweepRealKeyCopies } from "./realkey";
import { load, type Review } from "./report";
import type { Say } from "./progress";
import { sayingDocker, type SessionFactory } from "./sandbox";
import type { Env, Settings } from "./settings";
import { isKeptJunk, runName, storedName } from "./kept";
import { collect, deepestHolder, DOME, dockerSession, keptTestFiles, legacyKeptFiles, placeKept, runPath, swapFiles, swapIn }
  from "./testround";

export const CHECK_TIMEOUT = 900;

/** `accepted`: the ids among passed and failed that are accepted tests (behind findings marked real; absent: all are).
 * `reason` and `log`, with noReport: why there is no report, and the runner's output (repository-relative).
 * `reviews`: a failed test → the review that accepted its file, when known. */
const FIX_WITH_FAKE = "Fix the code; if this test needs a real key: `arnx allow-secret PATH`";

export interface ProjectCheck { /** Something in it was masked. */ standInsShown?: boolean;
  /** Files the snapshot left out as secret-looking; tests that failed for one, which could not run. */
  leftOut?: Withheld[]; fakedKeys?: string[]; couldNotRun?: { testId: string; needs: string; faked?: boolean; notRerun?: boolean }[]; project: string; files: string[];
  passed: string[]; failed: TestResult[];
  skipped: number; noReport: boolean; accepted?: string[]; reason?: string; log?: string | null;
  reviews?: Record<string, string>; workdir?: string;
  /** Kept test files the runner reported nothing for (its configuration leaves that name or folder out). */
  notRun?: string[];
  /** Accepted tests (named in the record) that ended skipped: not passing. */
  skippedAccepted?: string[];
  /** Accepted tests the record names in a kept file that ran, which the runner did not report (the project's own
   * configuration left them out), each as the record names it (the exact variant when it has one): not passing. */
  missingAccepted?: string[] }

/** The accepted tests, as `file::test` (repository-relative, parameters dropped): those accept recorded per file in
 * ACCEPTED_RECORD, else (a record by an older arnx) from each accepted review's marks. `files`: the kept files the
 * record or some review accounts for; in any other file (an older record and its review gone: a fresh clone, CI)
 * every test counts as accepted. */
interface AcceptedIds { ids: Set<string>; files: Set<string>; reviews: Map<string, string> }

const testKey = (file: string, rest: string) => `${posix.normalize(file)}::${baseName(rest)}`;
const splitId = (id: string): [string, string] => {
  const cut = id.indexOf("::");
  return cut < 0 ? [id, ""] : [id.slice(0, cut), id.slice(cut + 2)];
};

/** An accept's accepted tests, where it kept them (`file::test`): the tests of its findings marked real (and not set
 * aside) and of answers and rewrites the code disagrees with. */
export function acceptedTestIds(findings: Review["findings"], marks: Record<string, string | null | undefined>,
  moved: Record<string, string>, disagree: Record<string, string[]>): string[] {
  return [...findings.filter((f) => f.file && marks[f.id] === "real").map((f) => placed(moved, f.file, f.testId)),
    ...Object.values(disagree).flat().map((t) => placed(moved, null, t))];
}

/** The accepted tests of each kept file: the part of its ids after `file::`, as the runner reported it (a pytest
 * variant with its parameters, a JavaScript test's full title, a Rust test's full path). */
export function testsByFile(paths: string[], ids: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(paths.map((p) => [p, []]));
  for (const id of ids) {
    const [file, rest] = splitId(id);
    if (out[file] && !out[file].includes(rest)) out[file].push(rest);
  }
  return out;
}

function acceptedIds(repo: string): AcceptedIds {
  const out: AcceptedIds = { ids: new Set(), files: new Set(), reviews: new Map() };
  // By the path each file runs from (runPath): the runner reports that one.
  for (const [stored, e] of Object.entries(readRecord(repo).files)) {
    const p = runPath(stored);
    if (typeof e.review === "string") out.reviews.set(posix.normalize(p), e.review);
    if (!Array.isArray(e.tests)) continue;
    out.files.add(posix.normalize(p));
    for (const t of e.tests) out.ids.add(testKey(p, t));
  }
  const recorded = new Set(out.files);
  const base = join(repo, ".arnx", "reviews");
  for (const name of existsSync(base) ? readdirSync(base) : []) {
    const rdir = join(base, name);
    if (!existsSync(join(rdir, "accepted.json"))) continue;
    try {
      const done = JSON.parse(readFileSync(join(rdir, "accepted.json"), "utf8")) as { marks?: Record<string, string>;
        moved?: Record<string, string>; disagree?: Record<string, string[]>; set_aside?: Record<string, string> };
      const moved = done.moved ?? {};
      // A finding whose test was set aside (an answer's or a rewrite's test replaces it) has no accepted test.
      const marks = Object.fromEntries(Object.entries(done.marks ?? {}).filter(([id]) => !done.set_aside?.[id]));
      for (const id of acceptedTestIds(load(rdir).findings, marks, moved, done.disagree ?? {})) {
        const [file, rest] = splitId(id);
        if (!recorded.has(posix.normalize(runPath(file)))) out.ids.add(testKey(runPath(file), rest));
      }
      for (const f of Object.values(moved).map(runPath)) {
        out.files.add(posix.normalize(f));
        if (!out.reviews.has(posix.normalize(f))) out.reviews.set(posix.normalize(f), name);
      }
    } catch {
      continue; // a review that does not read accounts for nothing: its files count as accepted throughout
    }
  }
  return out;
}

/** The review that accepted the file of a test the runner reported (its id relative to the project's workdir). */
function reviewOf(known: AcceptedIds, workdir: string, testId: string): string | undefined {
  const [file] = splitId(testId);
  return known.reviews.get(posix.normalize(posix.join(workdir, file))) ?? known.reviews.get(posix.normalize(file));
}

/** Whether a test the runner reported (its id relative to the project's workdir) is one the record or a review names
 * as accepted (not merely in a file nothing accounts for). */
function namedAccepted(known: AcceptedIds, workdir: string, testId: string): boolean {
  const [file, rest] = splitId(testId);
  return known.ids.has(testKey(posix.join(workdir, file), rest)) || known.ids.has(testKey(file, rest));
}

/** Whether a test the runner reported (its id relative to the project's workdir) is an accepted test. */
function isAccepted(known: AcceptedIds, workdir: string, testId: string): boolean {
  const [file, rest] = splitId(testId);
  const inRepo = posix.join(workdir, file);
  if (namedAccepted(known, workdir, testId)) return true;
  return !known.files.has(posix.normalize(inRepo)) && !known.files.has(posix.normalize(file));
}

/** Where check keeps a project's runner output when the tests gave no report. */
export const checkLog = (project: string) => `.arnx/run/check-${project}.log`;

/** Accepted files an arnx before .arnx/tests/ kept inside the projects, where their own test runs collect them, each
 * with its project (the deepest holding it): check runs nothing until `arnx accept --move` moved them. */
export function legacyAccepted(repo: string, settings: Settings): Map<string, ReviewConfig> {
  const file = loadReviewFile(repo, { requireApproved: false });
  const projects = [...file.projects].sort((a, b) => posix.normalize(a.workdir).length - posix.normalize(b.workdir).length);
  const out = new Map<string, ReviewConfig>();
  for (const cfg of projects) for (const p of legacyKeptFiles(repo, cfg, settings.acceptedTestsDir)) out.set(p, cfg);
  for (const p of Object.keys(readRecord(repo).files)) {
    if (p.startsWith(`${DOME}/`) || out.has(p) || isKeptJunk(p) || !existsSync(join(repo, p))) continue;
    const cfg = deepestHolder(projects, p);
    if (cfg) out.set(p, cfg);
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** `arnx accept --move`: move the accepted files an older arnx kept inside the projects (legacyAccepted) to the same
 * path under .arnx/tests/, stored as accept stores them (storedName), out of the projects' own tools, without their
 * expected-fail markers (a red test is red only in check now), and pin them there, each one (`local`: this machine's
 * record, localPinsPath): they came from arnx's own accepted folder. One an older arnx did not pin is pinned as it
 * pinned then (no test list: every test in it counts as accepted), under its folder's review. Python's byte-code cache
 * and OS or editor leftovers (isKeptJunk) are not moved: the project's own runs make them. Folders left empty are
 * removed. Accepted files changed since accept are not moved: they block
 * (ArnxError) until restored or kept. */
export function moveOut(repo: string, settings: Settings, local: string | null = null): Record<string, string> {
  const files = legacyAccepted(repo, settings);
  const changed = changedAccepted(repo, local).filter((c) => files.has(c.path));
  if (changed.length) throw new ArnxError(changedSummary(changed, repo));
  // Written under .arnx/tests/, never through a link.
  const odd = irregularKept(repo);
  if (odd.length) throw new ArnxError(keptAdvice(repo, odd));
  const rec = readRecord(repo);
  const pins: Record<string, Pin | null> = {};
  const review: Record<string, string> = {};
  const moved: Record<string, string> = {};
  for (const [p, cfg] of files) {
    const to = `${DOME}/${storedName(p)}`;
    const text = readFileSync(join(repo, p), "utf8");
    mkdirSync(dirname(join(repo, to)), { recursive: true });
    writeFileSync(join(repo, to), adapterFor(cfg).unmark(text).text);
    rmSync(join(repo, p));
    for (let d = dirname(p); d !== "." && d !== posix.normalize(cfg.workdir); d = dirname(d)) {
      if (readdirSync(join(repo, d)).length) break;
      rmSync(join(repo, d), { recursive: true });
    }
    moved[p] = to;
    const pin = rec.files[p];
    if (pin) {
      delete rec.files[p];
      pins[p] = null;
    }
    const from = pin?.review ?? reviewGroup(p).slice(1).replace("_", "-");
    rec.files[to] = { ...(pin ?? { review: from }), sha256: writtenSha(repo, to) };
    pins[to] = rec.files[to]!;
    review[p] = review[to] = from;
  }
  if (Object.keys(pins).length) {
    writeLocal(local, repo, (p) => review[p]!, pins);
    writeRecord(repo, rec);
  }
  return moved;
}

/** The review a kept file came from: its r<tag>/ folder, or Rust's arnx_<tag>[_name].rs ("" for neither). check runs
 * each review's files in a run of their own, so one review's conftest or setup code cannot reach another's tests. */
export function reviewGroup(path: string): string {
  const rust = /(?:^|\/)arnx_(\d{8}_[0-9a-f]{6})(?:_[^/]*)?\.rs$/.exec(runName(path));
  return /(?:^|\/)(r\d{8}_[0-9a-f]{6})\//.exec(path)?.[1] ?? (rust ? `r${rust[1]}` : "");
}

/** Run each project's accepted tests: each is copied from .arnx/tests/ to the path it runs from, under the name it runs
 * by, in a throwaway copy of the working tree, and run there, each review's files in a run of their own; a confirmed
 * bug's test is red while the bug is open. */
export async function check(repo: string, settings: Settings, o: { sessionFactory?: SessionFactory;
  progress?: Say; what?: string; pins?: string | null } = {}): Promise<ProjectCheck[]> {
  const file = loadReviewFile(repo);
  const out: ProjectCheck[] = [];
  let known: AcceptedIds | undefined;
  sweepRealKeyCopies();
  // The check's reruns with a real key, over all its projects.
  const reruns = keyReruns();
  // Only what accept pinned runs: anything else under .arnx/tests/ is named by changedAccepted, never placed.
  const rec = readRecord(repo).files;
  const pinned = new Set(Object.keys(rec));
  for (const cfg of file.projects) {
    const files = keptTestFiles(repo, cfg, settings.acceptedTestsDir, file.projects).filter((f) => pinned.has(f));
    if (!files.length) continue;
    o.progress?.(`${cfg.name}: running ${o.what ?? "the accepted tests"}`);
    const tmp = mkdtempSync(join(tmpdir(), "arnx-check-"));
    try {
      const snap = join(tmp, "repo");
      // The working tree as it is now, fixes included, untracked files too (accepted tests are untracked until
      // committed): no model sees what a check runs.
      const taken = takeSnapshot(repo, null, snap, secretPinsOf(file.raw), { sandbox: sandboxOnlyOf(file.raw),
        untracked: true });
      // A coding agent reads what a check says, and the code it ran on holds real values.
      const boundary = new Boundary(configSuspects(repo));
      boundary.addScrubbed(taken);
      // The accepted tests and their support files, in place in this copy only, which alone gets the real values.
      const placed = new Set(placeKept(repo, snap, pinned));
      const swap = swapIn(boundary, snap, (rel) => placed.has(rel));
      // Each review's files run apart (reviewGroup); the build log is kept where a failed build's error can point to
      // it (the snapshot is removed below).
      const groups = [...new Set(files.map(reviewGroup))];
      const target = (f: string) => posix.relative(cfg.workdir, runPath(f)) || runPath(f);
      const done = await sayingDocker(o.progress, () => (o.sessionFactory ?? dockerSession)(cfg, snap,
        join(repo, ".arnx", "run", `check-${cfg.name}-build.log`), async (session) => {
          if (!session.copies) swapFiles(snap, [...placed], swap);
          // One after another: they share the session and the snapshot.
          const ran = [];
          for (const [i, g] of groups.entries()) {
            ran.push([g, ...await runTests(session, snap, cfg, files.filter((f) => reviewGroup(f) === g).map(target),
              groups.length > 1 ? `check-${i + 1}.xml` : "check.xml", CHECK_TIMEOUT)] as const);
          }
          // A failure or a skip beside a fake runs once more with the real key, each review's tests apart again: outcomes only.
          const real = new Map<string, string | null>();
          for (const [g, , results] of taken.fakedKeys.length ? ran : []) {
            const mine = files.filter((f) => reviewGroup(f) === g).map(target);
            const got = await rerunWithRealKeys(session, snap, cfg, { source: { repo, head: null }, fakedKeys: taken.fakedKeys,
              tests: rerunCandidates([results]), all: [results], target: (t) => mine.find((f) => ownerFile(t.fileAttr, [f]) !== null) ?? null,
              budget: reruns, timeout: CHECK_TIMEOUT });
            for (const [id, outcome] of got) real.set(id, outcome);
          }
          return [ran, real] as const;
        }, undefined, undefined, swap));
      // A test failing for a file left out, or for a key the sandbox holds a fake of, says nothing about the code.
      const lacking = taken.withheld.map((w) => w.path);
      const [runs, real] = done;
      const results = markUnproven(runs.flatMap(([, , r]) => r ?? []), { leftOut: lacking, fakedKeys: taken.fakedKeys,
        all: lacking.length ? filesAt(repo, null, true) : [], real });
      const missing = runs.filter(([, , r]) => r === null);
      const log = checkLog(cfg.name);
      rmSync(join(repo, log), { force: true });
      let reason: string | undefined;
      if (missing.length) {
        const [g, run] = missing[0]!;
        reason = (run.timedOut ? `the tests timed out after ${CHECK_TIMEOUT} s`
          : run.exitCode === 126 || run.exitCode === 127 ? `the runner could not start (exit ${run.exitCode})`
          : `the runner wrote no report${run.exitCode === null ? "" : ` (exit ${run.exitCode})`}`) +
          (groups.length > 1 && g ? ` (the tests of review ${g.slice(1).replace("_", "-")})` : "");
        mkdirSync(dirname(join(repo, log)), { recursive: true });
        writeFileSync(join(repo, log), boundary.mask(missing.map(([, r]) => r.output).join("\n")));
      }
      // A kept file the runner reported no test for was left out by its configuration: named, never silently dropped.
      const notRun = missing.length ? [] : files.filter((f) => !results.some((t) => ownerFile(t.fileAttr, [target(f)]) !== null));
      // Every test the record names in a kept file must report (passed, failed or skipped) as it is named: one the
      // project's own configuration leaves out (a deselect, a name filter, a collection hook) does not pass. The exact
      // ids (`ids`) must each report; another variant of the same test does not stand in for one. A list without them
      // (an older arnx's, parameters dropped) reports through any variant; a pin without a list is held to its whole
      // file reporting (notRun).
      const missingAccepted = missing.length ? [] : files.flatMap((f) => {
        const { ids, tests } = rec[f] ?? {};
        const exact = Array.isArray(ids);
        const named = exact ? ids : tests;
        if (!Array.isArray(named)) return [];
        const key = (n: string) => exact ? n : baseName(n);
        const got = new Set(results.filter((t) => ownerFile(t.fileAttr, [target(f)]) !== null)
          .map((t) => key(splitId(t.testId)[1])));
        return [...new Set(named.map(String))].filter((n) => !got.has(key(n))).map((n) => `${target(f)}::${n}`);
      });
      known ??= acceptedIds(repo);
      const ran = results.filter((t) => t.outcome !== "skipped");
      const couldNotRun = ran.filter((t) => t.needs).map((t) => ({ testId: t.testId, needs: t.needs!, ...(t.fakedKey ? { faked: true } : {}),
        ...(t.notRerun ? { notRerun: true } : {}) }));
      const failed = ran.filter((t) => !t.needs && (t.outcome === "failed" || t.outcome === "error"));
      const reviews = Object.fromEntries(failed.map((t) => [t.testId, reviewOf(known!, cfg.workdir, t.testId)])
        .filter(([, r]) => r));
      // An accepted test (one the record names) that ends skipped shows nothing: arnx keeps them unskipped, so it does
      // not pass. The other tests in its file that accept skipped (not confirmed, set aside) are only counted.
      const skippedAccepted = results.filter((t) => t.outcome === "skipped" && namedAccepted(known!, cfg.workdir, t.testId))
        .map((t) => t.testId);
      const said = maskedCopy(boundary, { project: cfg.name, workdir: cfg.workdir, files, noReport: missing.length > 0,
        passed: ran.filter((t) => t.outcome === "passed").map((t) => t.testId), failed, reviews,
        skipped: results.filter((t) => t.outcome === "skipped").length - skippedAccepted.length,
        ...(skippedAccepted.length ? { skippedAccepted } : {}),
        ...(missingAccepted.length ? { missingAccepted } : {}),
        accepted: ran.filter((t) => !t.needs && isAccepted(known!, cfg.workdir, t.testId)).map((t) => t.testId),
        ...(taken.withheld.length ? { leftOut: taken.withheld } : {}), ...(taken.fakedKeys.length ? { fakedKeys: taken.fakedKeys } : {}),
        ...(couldNotRun.length ? { couldNotRun } : {}),
        ...(notRun.length ? { notRun } : {}),
        ...(reason ? { reason, log } : { log: null }) } as ProjectCheck);
      out.push(said.shown ? { ...said.value, standInsShown: true } : said.value);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return out;
}

// --- answers that may contradict accepted tests ----------------------------------------------------------------------
// An answer's test can ask for the opposite of an accepted test, so that no code passes both; one run cannot tell. At
// accept, each answer test that fails on the code is recorded with the accepted tests of its project that pass; a
// later check that finds the answer's test passing and one of those failing names the pair. Evidence over two
// versions of the code, not proof (the fix may just be wrong): one line and the JSON, never the exit code.

export const ANSWER_WATCH = ".arnx/answer-watch.json";
/** A recorded test: its id (F3, Q2; else its name), its review ("" unknown) and its key (repository-relative). */
interface Watched { id: string; review: string; test: string }
interface WatchEntry { review: string; answer: string; test: string; passing: Watched[] }
export interface MayContradict { answer: string; accepted: string; review: string; accepted_review: string;
  answer_test: string; accepted_test: string }

/** A test the runner reported (relative to its project's workdir) as `file::name`, repository-relative. */
const runKey = (workdir: string | undefined, testId: string) => {
  const [file, rest] = splitId(testId);
  return testKey(posix.join(workdir ?? ".", file), rest);
};
/** An accepted test id (`.arnx/tests/...::name`, or the path it runs from) as runKey gives it. */
const keptKey = (id: string) => {
  const [file, rest] = splitId(id);
  return testKey(runPath(file), rest);
};

/** Each accepted test's id and review, from the accepted reviews in .arnx/reviews/. */
function acceptedLabels(repo: string): Map<string, { id: string; review: string }> {
  const out = new Map<string, { id: string; review: string }>();
  const base = join(repo, ".arnx", "reviews");
  for (const name of existsSync(base) ? readdirSync(base) : []) {
    const rdir = join(base, name);
    if (!existsSync(join(rdir, "accepted.json"))) continue;
    try {
      const done = JSON.parse(readFileSync(join(rdir, "accepted.json"), "utf8")) as { marks?: Record<string, string>;
        moved?: Record<string, string>; disagree?: Record<string, string[]>; set_aside?: Record<string, string> };
      const review = load(rdir);
      const moved = done.moved ?? {};
      for (const f of review.findings) {
        if (f.file && done.marks?.[f.id] === "real" && !done.set_aside?.[f.id]) {
          out.set(keptKey(placed(moved, f.file, f.testId)), { id: f.id, review: review.id });
        }
      }
      for (const [qid, tests] of Object.entries(done.disagree ?? {})) {
        for (const t of tests) out.set(keptKey(placed(moved, null, t)), { id: qid, review: review.id });
      }
    } catch {
      continue;
    }
  }
  return out;
}

function readWatch(repo: string): WatchEntry[] {
  try {
    const d = JSON.parse(readFileSync(join(repo, ANSWER_WATCH), "utf8")) as { answers?: unknown };
    return Array.isArray(d.answers) ? d.answers.filter((e): e is WatchEntry => !!e && typeof e === "object" &&
      typeof e.answer === "string" && typeof e.test === "string" && Array.isArray(e.passing)) : [];
  } catch {
    return [];
  }
}

/** At accept, after its check: record each answer test of `review` that fails now (`disagree`: the answer rounds'
 * failing tests, `moved`: where accept put them) with the accepted tests of its project that pass, replacing the
 * review's earlier entries. */
export function recordAnswerWatch(repo: string, review: string, disagree: Record<string, string[]>,
  moved: Record<string, string>, results: ProjectCheck[]): void {
  const labels = acceptedLabels(repo);
  const entries: WatchEntry[] = [];
  for (const [answer, tests] of Object.entries(disagree)) {
    for (const t of tests) {
      const test = keptKey(placed(moved, null, t));
      const r = results.find((x) => x.failed.some((f) => runKey(x.workdir, f.testId) === test));
      if (!r) continue;
      const passing = r.passed.filter((id) => !r.accepted || r.accepted.includes(id)).map((id) => runKey(r.workdir, id))
        .filter((k) => k !== test).map((k) => ({ id: labels.get(k)?.id ?? k.split("::").at(-1)!,
          review: labels.get(k)?.review ?? "", test: k }));
      if (passing.length) entries.push({ review, answer, test, passing });
    }
  }
  const answers = [...readWatch(repo).filter((e) => e.review !== review), ...entries];
  const path = join(repo, ANSWER_WATCH);
  if (!answers.length) {
    rmSync(path, { force: true });
    return;
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ schema_version: 1, answers }, null, 2) + "\n");
}

/** Recorded answer tests that pass now while one of the accepted tests that passed with them at accept fails. */
export function mayContradict(repo: string, results: ProjectCheck[]): MayContradict[] {
  const keys = (pick: (r: ProjectCheck) => string[]) =>
    new Set(results.flatMap((r) => pick(r).map((id) => runKey(r.workdir, id))));
  const passed = keys((r) => r.passed);
  const failed = keys((r) => r.failed.map((t) => t.testId));
  const out = new Map<string, MayContradict>();
  for (const e of readWatch(repo)) {
    if (!passed.has(e.test)) continue;
    for (const p of e.passing) {
      if (!failed.has(p.test)) continue;
      out.set(`${e.review} ${e.answer} ${p.review} ${p.id}`, { answer: e.answer, accepted: p.id, review: e.review,
        accepted_review: p.review, answer_test: e.test, accepted_test: p.test });
    }
  }
  return [...out.values()];
}

/** check's line per pair; the accepted test's review is named when it is another review's. */
export const contradictionLines = (pairs: MayContradict[]): string[] => pairs.map((p) =>
  `${p.answer}'s test now passes and ${p.accepted}'s${p.accepted_review && p.accepted_review !== p.review
    ? ` (review ${p.accepted_review})` : ""} fails: they may contradict`);

/** A list of failing tests, as accept and check print it:/** A list of failing tests, as accept and check print it: the test name after the last `::`, then its first message
 * line. One file: the names alone; several: each file once, its tests under it. `multi`: several projects ran, so
 * each file (or name) says its project. `mark` and `why` shape the ✗ and the message (accept colours and cuts it). */
export function failingList(failing: { project: string; t: TestResult }[], multi: boolean,
  o: { mark?: string; why?: (first: string) => string } = {}): string[] {
  const mark = o.mark ?? "✗";
  const why = o.why ?? ((m: string) => `  ${m}`);
  const fileOf = ({ project, t }: (typeof failing)[number]) => `${multi ? `${project}: ` : ""}${t.testId.split("::")[0]}`;
  const files = [...new Set(failing.map(fileOf))];
  const out: string[] = [];
  for (const file of files) {
    if (files.length > 1) out.push(`  ${file}:`);
    for (const x of failing.filter((x) => fileOf(x) === file)) {
      const name = `${files.length === 1 && multi ? `${x.project}: ` : ""}` + x.t.testId.split("::").at(-1)!;
      out.push(`${files.length > 1 ? "    " : "  "}${mark} ${name}${x.t.message ? why(x.t.message.split("\n")[0]!) : ""}`);
    }
  }
  return out;
}

const count = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;

/** What a check prints, and its exit code: 0 all pass, 1 some fail, 2 no report, 3 nothing accepted yet (4, accepted
 * tests changed since accept, is decided before anything runs: see changedAccepted). Accepted tests (behind findings
 * marked real) are told apart from the other tests the review wrote into the same files. */
export function checkSummary(results: ProjectCheck[]): [string, number] {
  const [text, code] = summaryOf(results);
  if (!results.some((r) => r.standInsShown)) return [text, code];
  const lines = text.split("\n");
  lines.splice(lines.at(-1)!.startsWith("Next:") ? lines.length - 1 : lines.length, 0, STAND_INS_NOTE);
  return [lines.join("\n"), code];
}

function summaryOf(results: ProjectCheck[]): [string, number] {
  if (!results.length) return ["No accepted tests yet: arnx accept keeps them after a review.", 3];
  const multi = results.length > 1;
  const lines: string[] = [];
  const missing = results.filter((r) => r.noReport);
  for (const r of missing) {
    lines.push(`✗ ${r.project}: check incomplete: ${r.reason ?? "the tests gave no report"}` +
      `${r.log ? ` (log: ${r.log})` : ""}`);
  }
  const ran = results.filter((r) => !r.noReport);
  const isAcc = (r: ProjectCheck) => (id: string) => !r.accepted || r.accepted.includes(id);
  const failed = ran.flatMap((r) => r.failed.map((t) => ({ project: r.project, t, acc: isAcc(r)(t.testId),
    review: r.reviews?.[t.testId] })));
  const passed = ran.flatMap((r) => r.passed.map((id) => isAcc(r)(id)));
  const accFail = failed.filter((x) => x.acc);
  const othFail = failed.filter((x) => !x.acc);
  const accPass = passed.filter(Boolean).length;
  const othPass = passed.length - accPass;
  const accTotal = accFail.length + accPass;
  const skipped = ran.reduce((n, r) => n + r.skipped, 0);
  // Accepted tests that ended skipped: not passing.
  const skipAcc = ran.flatMap((r) => (r.skippedAccepted ?? []).map((id) => `${multi ? `${r.project}: ` : ""}${splitId(id)[1]}`));
  // Accepted tests the run left out: not passing either. Those of a file that could not load for a file left out as
  // secret-looking (its error is in couldNotRun) are that file's, not the configuration's.
  const missed = ran.flatMap((r) => (r.missingAccepted ?? []).map((id) => {
    const [file, name] = splitId(id);
    return { name: `${multi ? `${r.project}: ` : ""}${name}`,
      blocked: (r.couldNotRun ?? []).some((x) => ownerFile(splitId(x.testId)[0], [file]) !== null) };
  }));
  const missAcc = missed.map((x) => x.name);
  // With no accepted test among them (an answer's tests alone), the rest are not "other".
  const other = accTotal ? "other " : "";
  const where = "in the accepted files";
  if (ran.length) {
    const clean = !failed.length;
    if (accFail.length) {
      lines.push(`✗ ${count(accFail.length, "accepted test")} still fail${accFail.length === 1 ? "s (bug" : " (bugs"} ` +
        "not fixed yet)");
      if (accPass) lines.push(`✓ ${count(accPass, "accepted test")} pass${accPass === 1 ? "es" : ""}`);
    } else if (accTotal && (skipAcc.length || missAcc.length)) {
      lines.push(`✓ ${count(accPass, "accepted test")} pass${accPass === 1 ? "es" : ""}`);
    } else if (accTotal) {
      const too = clean && othPass ? ` (${count(othPass, "other test")} in ${accTotal === 1 ? "its file" : "their files"}` +
        " too)" : "";
      lines.push(`✓ ${accTotal === 1 ? "The accepted test passes" : `All ${accTotal} accepted tests pass`}${too}`);
    }
    if (skipAcc.length) {
      lines.push(`✗ ${count(skipAcc.length, "accepted test")} skipped, so not shown to pass:`,
        ...skipAcc.map((name) => `  ✗ ${name}`));
    }
    if (missAcc.length) {
      lines.push(`✗ ${count(missAcc.length, "accepted test")} did not report, so not shown to pass:`,
        ...missAcc.map((name) => `  ✗ ${name}`));
    }
    if (othPass && !(clean && accTotal)) {
      lines.push(`✓ ${count(othPass, `${other}test`)} ${where} pass${othPass === 1 ? "es" : ""}`);
    }
    if (skipped) lines.push(`· ${count(skipped, `${other}test`)} ${where} skipped (not confirmed)`);
    lines.push(...failingList(accFail, multi));
    if (othFail.length) {
      lines.push(`✗ ${count(othFail.length, `${other}test`)} ${where} fail${othFail.length === 1 ? "s" : ""}`,
        ...failingList(othFail, multi));
    }
  }
  // A file left out or a key faked: what could not run for it says so, and whatever else went wrong may have it for a cause.
  const blocked = results.flatMap((r) => r.couldNotRun ?? []);
  const allowFile = (paths: string[]) => `\`arnx allow-secret ${paths.length === 1 && paths[0] !== A_FAKED_FILE ? paths[0] : "PATH"}\``;
  if (blocked.length) {
    const needs = [...new Set(blocked.map((x) => x.needs))];
    lines.push(`✗ ${count(blocked.length, "test")} ${unprovenText(blocked.length, blocked, (p) => p.slice(0, 5).join(", "))}. ` +
      `If it is a test fixture: ${allowFile(needs)}, then \`arnx check\` again.`);
  }
  const notRun = results.flatMap((r) => r.notRun ?? []);
  if (notRun.length) {
    lines.push(`✗ ${count(notRun.length, "accepted test file")} did not run, the runner leaves ${notRun.length === 1 ? "it" : "them"} ` +
      `out: ${notRun.slice(0, 5).map(runPath).join(", ")}${notRun.length > 5 ? ", …" : ""}`);
  }
  const leftOut = [...new Set(results.flatMap((r) => (r.leftOut ?? []).map((w) => w.path)))];
  if (leftOut.length && !blocked.length && (missing.length || failed.length)) {
    lines.push(`Left out as secret-looking, which these tests may need: ${leftOut.slice(0, 5).join(", ")}${leftOut.length > 5 ? ", …" : ""}. ` +
      `If one is a test fixture: ${allowFile(leftOut)}.`);
  }
  const fakedKeys = [...new Set(results.flatMap((r) => r.fakedKeys ?? []))];
  const skips = results.reduce((n, r) => n + r.skipped, 0);
  if (fakedKeys.length && !blocked.length && (missing.length || failed.length || skips)) {
    lines.push(`A fake private key is in the sandbox: ${fakedKeys.slice(0, 5).join(", ")}${fakedKeys.length > 5 ? ", …" : ""}. ` +
      (failed.length ? FIX_WITH_FAKE : `A test ${skips && !missing.length ? "skipped " : ""}may need the real one: ${allowFile(fakedKeys)}`) + ".");
  }
  if (missing.length) {
    const timeout = missing.every((r) => r.reason?.startsWith("the tests timed out"));
    lines.push(`The accepted tests${multi ? ` of ${missing.map((r) => r.project).join(", ")}` : ""} could not be ` +
      `verified: ${timeout ? "a timeout" : "a run without a report"} is neither a fix nor a bug.`);
    return [lines.join("\n"), 2];
  }
  if (failed.length || skipAcc.length || missAcc.length) {
    // arnx keeps accepted tests unskipped: a skip comes from the run (a conftest, a marker, the environment).
    if (skipAcc.length) lines.push("A skipped accepted test proves nothing: find what skips it, then arnx check.");
    if (missed.some((x) => !x.blocked)) {
      lines.push("An accepted test that does not report proves nothing: find what in your test configuration leaves it " +
        "out (a deselect, a name filter, a collection hook), then arnx check.");
    }
    if (missed.some((x) => x.blocked)) {
      lines.push("An accepted test whose file could not load reports nothing: its file needs the one left out above.");
    }
    // A wrong test of a real bug is marked rewrite; tests that are not findings no mark covers.
    if (accFail.length) {
      const ids = [...new Set(accFail.map((x) => x.review).filter((r): r is string => !!r))].sort();
      // The review is unknown (a record by an older arnx): say where its id is rather than print a placeholder.
      const again = ids.length ? `\`arnx accept --again ${ids[0]}\`` +
        (ids.length > 1 ? ` (and ${ids.slice(1).map((r) => `\`${r}\``).join(", ")})` : "")
        : "accept the review that kept it again (`arnx accept --again` with its id; `ls .arnx/reviews` lists them)";
      lines.push(`${fakedKeys.length ? "Leave the accepted tests as they are" : "Fix the code, not the accepted tests"}. A real bug whose test is wrong: mark it rewrite in review.md ` +
        `with a \`Rewrite:\` line saying why (noise only when there is no bug), then ${again}.`);
    }
    if (othFail.length) {
      const one = othFail.length === 1;
      lines.push(`The ${count(othFail.length, `${other}test`)} that fail${one ? "s is not a finding" : " are not findings"}: ` +
        `marks do not cover ${one ? "it" : "them"}. ${fakedKeys.length ? "Or fix" : "Fix the code, or fix"} or delete ${one ? "it" : "them"} in the file ` +
        "(then `arnx accept --keep-edits`).");
    }
    lines.push("Next: arnx check");
    return [lines.join("\n"), 1];
  }
  if (blocked.length || notRun.length) return [lines.join("\n"), 2];
  lines.push("✓ Accepted tests unchanged since arnx accept");
  lines.push(`Commit the fixes, the accepted tests and ${ACCEPTED_RECORD} together.`);
  return [lines.join("\n"), 0];
}

// --- accepted tests are pinned ----------------------------------------------------------------------------------------
// accept records the sha256 of every file it writes into the repository (tests and their support files), and check
// refuses to run when one was changed or deleted since: a test edited until it passes proves nothing, and a coding agent
// told to make `arnx check` pass must not be able to do it that way. The record is committed with the tests.
//
// The record itself is a file in the working tree, so an agent could edit a test and its sha256 together, or drop the
// entry. A pin is trusted only when it is the committed one (HEAD) or one arnx wrote on this machine: accept and
// --keep-edits also keep every pin they write in the person's config directory, outside the repository (where a
// coding agent's sandbox usually cannot write). A pin that is neither, or an entry removed, exits 4 like an edited test.
// Fresh clones, CI and teammates have no local record: there the committed pins are the trusted ones.
//
// Each entry also lists the file's accepted tests (`tests`: the names after `file::`, parameters dropped), which tells
// check's accepted tests from the other tests in the file without .arnx/reviews/, and the same tests as the runner
// reported them in the review (`ids`: a variant with its parameters), each of which must report. Both are pinned with
// the sha256 (an entry by an older arnx has no `ids`, and its `tests` report through any variant):
// edited, it could turn a red accepted test into an "other" one, so an entry is trusted only when both its sha256 and
// its list (absent included: an older arnx wrote none) are HEAD's or ones arnx wrote here; else it is `repinned`.

export const ACCEPTED_RECORD = ".arnx/accepted-tests.json";
/** check's exit code when an accepted test file was changed or deleted since accept recorded it. */
export const TESTS_CHANGED = 4;

interface Pin { sha256: string; review: string; tests?: string[]; ids?: string[] }
interface AcceptedRecord { schema_version: 1; files: Record<string, Pin> }
/** modified/deleted: the file differs from its pin, or is gone. repinned: the pin itself was changed, and not by arnx
 * on this machine. unpinned: its entry was removed from the record (or the record deleted). */
export const CHANGES = ["modified", "deleted", "repinned", "unpinned", "duplicate", "added", "collides"] as const;
export interface ChangedTest { path: string; review: string; change: typeof CHANGES[number] }

/** What arnx wrote to the record on this machine: per file, every sha256 and accepted-test lists it pinned (a branch
 * switch brings back an older one; null: none, an entry by an older arnx; a bare list: `tests` without `ids`), and
 * whether it removed the entry (accept --again keeping fewer files, --keep-edits of a deleted one). */
interface LocalPins { schema_version: 1; repo: string;
  files: Record<string, { review: string; sha256: string[]; tests?: (Lists | string[] | null)[]; removed?: boolean }> }
/** An entry's accepted-test lists, as pinned. */
interface Lists { tests?: string[]; ids?: string[] }

/** A kept file's sha256, its bytes read without following a link (safefs.ts regularBytes), so hashing, placing and
 * counting kept files agree: "gone" when nothing is there, "other" when it is not a regular file. */
function keptSha(repo: string, rel: string): string {
  const b = regularBytes(repo, rel);
  return typeof b === "string" ? b : createHash("sha256").update(b).digest("hex");
}

/** The sha256 of a file arnx just wrote under .arnx/tests/ (accept, --move); one that is not a regular file stops it. */
function writtenSha(repo: string, rel: string): string {
  const sha = keptSha(repo, rel);
  if (sha === "gone" || sha === "other") throw new ArnxError(`${rel} is not a regular file`);
  return sha;
}
/** An accepted-test list as compared: order and repeats do not count; "" when there is none. */
const testsOf = (tests: unknown) => Array.isArray(tests) ? JSON.stringify([...new Set(tests.map(String))].sort()) : "";
/** The lists of an entry, or of what this machine's record keeps (a bare list is `tests` alone; null: none), absent ones
 * left out. */
const listsIn = (x: unknown): Lists => {
  const e: { tests?: unknown; ids?: unknown } = Array.isArray(x) ? { tests: x } : x && typeof x === "object" ? x : {};
  return { ...(Array.isArray(e.tests) ? { tests: e.tests.map(String) } : {}),
    ...(Array.isArray(e.ids) ? { ids: e.ids.map(String) } : {}) };
};
/** Those lists as compared. */
const listsOf = (x: unknown): string => {
  const e = listsIn(x);
  return e.ids ? JSON.stringify([testsOf(e.tests), testsOf(e.ids)]) : testsOf(e.tests);
};

function parseRecord(text: string): AcceptedRecord {
  const d = JSON.parse(text) as Partial<AcceptedRecord>;
  return { schema_version: 1, files: d.files && typeof d.files === "object" ? d.files : {} };
}

function readRecord(repo: string): AcceptedRecord {
  const path = join(repo, ACCEPTED_RECORD);
  if (!existsSync(path)) return { schema_version: 1, files: {} };
  try {
    return parseRecord(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ArnxError(`cannot read ${ACCEPTED_RECORD}: ${(e as Error).message}; restore it from git`);
  }
}

/** The record as committed at HEAD: empty with no commits, none committed, or one that does not parse. */
function committedRecord(repo: string): AcceptedRecord["files"] {
  if (!hasCommits(repo)) return {};
  try {
    return parseRecord(git(repo, ["show", `HEAD:${ACCEPTED_RECORD}`])).files;
  } catch {
    return {};
  }
}

function writeRecord(repo: string, rec: AcceptedRecord): void {
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  const files = Object.fromEntries(Object.entries(rec.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  writeFileSync(join(repo, ACCEPTED_RECORD), JSON.stringify({ schema_version: 1, files }, null, 2) + "\n");
}

/** `$XDG_CONFIG_HOME/arnx/pins/<repository>.json`, else `~/.config/arnx/pins/<repository>.json`, one per clone
 * (`repo` is its real path); null when the environment names neither (then only the committed pins are trusted). */
export function localPinsPath(env: Env, repo: string): string | null {
  const name = `${createHash("sha256").update(repo).digest("hex").slice(0, 24)}.json`;
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "arnx", "pins", name);
  return env.HOME && isAbsolute(env.HOME) ? join(env.HOME, ".config", "arnx", "pins", name) : null;
}

function readLocal(path: string | null, repo: string): LocalPins {
  const none: LocalPins = { schema_version: 1, repo, files: {} };
  if (!path || !existsSync(path)) return none;
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as Partial<LocalPins>;
    // An entry that is not what writeLocal writes is left out: that file is then checked against HEAD alone.
    const files = Object.entries(d.files && typeof d.files === "object" ? d.files : {})
      .filter(([, e]) => e && typeof e === "object" && Array.isArray(e.sha256) && typeof e.review === "string");
    return { ...none, files: Object.fromEntries(files) };
  } catch {
    return none;
  }
}

/** Add what arnx just wrote to the record: a file → its pin, or null when its entry was removed. Written before the
 * record itself, so a person (or sandbox) that cannot write here leaves the record as it was. */
function writeLocal(path: string | null, repo: string, review: (p: string) => string, pins: Record<string, Pin | null>)
  : void {
  if (!path) return;
  const local = readLocal(path, repo);
  for (const [p, pin] of Object.entries(pins)) {
    const e = local.files[p] ??= { review: review(p), sha256: [] };
    e.review = review(p);
    if (pin === null) e.removed = true;
    else {
      // An entry pinned before arnx recorded tests keeps that pin's list (none) trusted.
      const lists = e.tests ??= e.sha256.length ? [null] : [];
      if (!e.sha256.includes(pin.sha256)) e.sha256.push(pin.sha256);
      if (!lists.some((t) => listsOf(t) === listsOf(pin))) lists.push(pin.ids ? listsIn(pin) : pin.tests ?? null);
      delete e.removed;
    }
  }
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(local, null, 2) + "\n");
  } catch (e) {
    throw new ArnxError(`cannot record the accepted tests in ${path}: ${(e as Error).message}`);
  }
}

/** Record what one accept wrote (repository-relative paths, each with its accepted tests as the runner reported them:
 * testsByFile), replacing that review's earlier entries; `local`: this machine's record (localPinsPath). Each entry
 * names them twice: `tests`, parameters dropped, and `ids`, exactly. */
export function recordAccepted(repo: string, review: string, tests: Record<string, string[]>,
  local: string | null = null): void {
  const rec = readRecord(repo);
  const pins: Record<string, Pin | null> = {};
  for (const [p, e] of Object.entries(rec.files)) {
    if (e.review === review) {
      delete rec.files[p];
      pins[p] = null;
    }
  }
  for (const [p, t] of Object.entries(tests)) {
    rec.files[p] = { sha256: writtenSha(repo, p), review, tests: [...new Set(t.map(baseName))], ids: [...new Set(t)] };
    pins[p] = rec.files[p]!;
  }
  writeLocal(local, repo, () => review, pins);
  writeRecord(repo, rec);
}


/** Accepted test files (under .arnx/tests/) and pins (the record) a change edits or removes: the base's files changed
 * or gone at the head (the working tree when the change has none), and the record when one of the base's entries
 * changed or went. What a change only adds (accept's own output) is not named. check trusts committed pins where
 * arnx wrote none (a fresh clone, CI), so a review of the change is where such an edit shows. */
export function changeEditsAccepted(repo: string, change: { base: string; head: string | null }): string[] {
  const revs = change.head ? [change.base, change.head] : [change.base];
  const status = git(repo, ["diff", "-z", "--name-status", "--no-renames", ...revs, "--", DOME]).split("\0");
  const at = (rev: string) => git(repo, ["show", `${rev}:${ACCEPTED_RECORD}`], [0, 128]);
  const path = join(repo, ACCEPTED_RECORD);
  const records = [at(change.base), change.head ? at(change.head) : existsSync(path) ? readFileSync(path, "utf8") : ""]
    .map((text) => {
      try {
        return text ? parseRecord(text).files : {};
      } catch {
        return null;
      }
    });
  const [before, after] = records;
  // An older kept file arnx stored under its new name (storeOlderKept), its pin moved with it unchanged, is no edit.
  const same = (a: Pin | undefined, b: Pin) => !!a && a.sha256 === b.sha256 && listsOf(a) === listsOf(b);
  const moved = (p: string) => isOlderKept(p) && !!before?.[p] && same(after?.[`${DOME}/${storedName(runPath(p))}`], before[p]!);
  const out: string[] = [];
  for (let i = 0; i + 1 < status.length; i += 2) {
    if (status[i] !== "A" && !(status[i] === "D" && moved(status[i + 1]!))) out.push(status[i + 1]!);
  }
  // A file added beside a pinned one of the same run name (under the other name) that stays pinned: it could run in
  // its place. Untracked too, for a change of the working tree.
  const tree = (rev: string) => new Set(git(repo, ["ls-tree", "-r", "-z", "--name-only", rev, "--", DOME]).split("\0"));
  const [atBase, atHead] = [tree(change.base), change.head ? tree(change.head) : null];
  for (const p of Object.keys(before ?? {}).filter((x) => x.startsWith(`${DOME}/`) && after?.[x])) {
    const other = isOlderKept(p) ? `${DOME}/${storedName(runPath(p))}` : `${DOME}/${runPath(p)}`;
    const there = atHead ? atHead.has(other) : existsSync(join(repo, other));
    if (!out.includes(other) && there && !atBase.has(other)) out.push(other);
  }
  if (before && Object.entries(before).some(([p, pin]) => !moved(p) && !same(after?.[p], pin))) out.push(ACCEPTED_RECORD);
  return out.sort();
}

/** Paths that some commit of `revs` touched. */
function touched(repo: string, revs: string[], paths: string[]): Set<string> {
  if (!paths.length || !hasCommits(repo)) return new Set();
  return new Set(git(repo, ["--literal-pathspecs", "log", ...revs, "-z", "--format=", "--name-only", "--", ...paths])
    .split("\0").map((p) => p.trim()).filter(Boolean));
}

/** `f`'s value, computed on the first call only. */
function once<T>(f: () => T): () => T {
  let done: { value: T } | undefined;
  return () => (done ??= { value: f() }).value;
}

/** The record's entries in every commit that changed it, by any ref (a stash too): those HEAD reaches and the others.
 * `shallow`: the history is cut, so a version no commit seems to hold may still be in one. */
interface RecordHistory { reached: AcceptedRecord["files"][]; elsewhere: AcceptedRecord["files"][]; shallow: boolean }

/** The record's history (RecordHistory); null without commits. Read only when an entry has fewer lists than it might
 * have had (trustedTests): two `git log` and one `git cat-file` for the whole record. */
function recordHistory(repo: string): RecordHistory | null {
  if (!hasCommits(repo)) return null;
  // --full-history: a version on a branch merged since is not hidden behind a merge that kept the other side.
  const log = (revs: string[]) => git(repo, ["log", ...revs, "--full-history", "--format=%H", "--", ACCEPTED_RECORD])
    .split("\n").filter(Boolean);
  const all = log(["--all"]);
  const reached = new Set(log(["HEAD"]));
  const out: RecordHistory = { reached: [], elsewhere: [],
    shallow: git(repo, ["rev-parse", "--is-shallow-repository"]).trim() === "true" };
  if (!all.length) return out;
  const r = spawnSync("git", ["-C", repo, "cat-file", "--batch"], { input: all.map((c) => `${c}:${ACCEPTED_RECORD}\n`).join(""),
    maxBuffer: 256 * 1024 * 1024 });
  if (r.status !== 0) throw new ArnxError(`git cat-file failed: ${String(r.stderr).trim().slice(0, 300)}`);
  const buf = r.stdout;
  let at = 0;
  for (const c of all) {
    const nl = buf.indexOf(10, at);
    const head = buf.subarray(at, nl).toString("utf8").split(" ");
    at = nl + 1;
    if (head[1] !== "blob") continue;
    const size = Number(head[2]);
    const text = buf.subarray(at, at + size).toString("utf8");
    at += size + 1;
    try {
      (reached.has(c) ? out.reached : out.elsewhere).push(parseRecord(text).files);
    } catch {
      continue; // a version that does not parse holds no list
    }
  }
  return out;
}

/** Whether entry `w` of `path` keeps the accepted-test lists arnx pinned: ones arnx wrote here (`l`), else HEAD's (`c`;
 * none: any). An entry without a list (`tests`, `ids`) that arnx pinned for the file, here, at HEAD or in any commit
 * (`history`), is trusted only when that stronger version is in a commit HEAD does not reach (a branch switch back to
 * an older record, a stash) and the entry is HEAD's or one arnx wrote here. In HEAD's history, or in no commit (an
 * accept discarded before it was committed), dropping it is an edit: the exact ids it drops are what keeps a variant
 * that fails on the bug from being left out. Without commits, or in a shallow clone that finds it nowhere, only HEAD's
 * own entry is trusted. `names`: the file's path in the record, and the other name an older kept file had there.
 * "dropped": refused for a list it lacks, which only `accept --again` puts back. */
function trustedTests(w: Pin, c: Pin | undefined, l: LocalPins["files"][string] | undefined, names: string[],
  history: () => RecordHistory | null): "trusted" | "edited" | "dropped" {
  const mine = l ? (Array.isArray(l.tests) ? l.tests : [null]) : [];
  const same = (x: unknown) => listsOf(x) === listsOf(w);
  const known = (ok: boolean) => ok ? "trusted" as const : "edited" as const;
  const has = listsIn(w);
  if (has.tests && has.ids) return known(l ? mine.some(same) : !c || same(c));
  const more = (x: unknown) => {
    const k = listsIn(x);
    return (!!k.tests && !has.tests) || (!!k.ids && !has.ids);
  };
  const h = history();
  const inCommit = (vs: AcceptedRecord["files"][]) => vs.some((v) => names.some((n) => more(v[n])));
  if (!mine.some(more) && !more(c) && !(h && (inCommit(h.reached) || inCommit(h.elsewhere)))) {
    return known(l ? mine.some(same) : !c || same(c));
  }
  const fewer = (ok: boolean) => ok ? "trusted" as const : "dropped" as const;
  if (!h) return fewer(!!c && same(c));
  if (more(c) || inCommit(h.reached)) return "dropped";
  if (inCommit(h.elsewhere)) return fewer((!!c && same(c)) || mine.some(same));
  return fewer(h.shallow && !!c && same(c));
}

/** The `repinned` entries changedAccepted refused for a list they lack ("dropped" above): `--keep-edits` would record
 * them as they are, so only `accept --again` is offered. Kept beside the objects, not in them: they are check's JSON. */
const droppedLists = new WeakSet<ChangedTest>();

/** Accepted files changed or deleted since accept recorded them, and pins changed or removed by anything but arnx on
 * this machine (`local`, localPinsPath). A file under .arnx/tests/ that accept never recorded is `added` (exit 4, not run). */
export function changedAccepted(repo: string, local: string | null = null): ChangedTest[] {
  // arnx reads and writes kept tests only in real folders: a link at .arnx or .arnx/tests is refused before anything else.
  const linked = linkedDome(repo);
  if (linked) return [{ path: linked, review: "", change: "modified" }];
  const now = readRecord(repo).files;
  const head = committedRecord(repo);
  const mine = readLocal(local, repo).files;
  const paths = [...new Set([...Object.keys(now), ...Object.keys(head), ...Object.keys(mine)])].sort();
  // A file arnx pinned here whose file and entry are both gone, and that HEAD never pinned: on another branch (it is in
  // a commit HEAD does not reach), or removed (only in HEAD's history: a commit deleted it; in no commit: never
  // committed, then deleted).
  const gone = paths.filter((p) => !now[p] && !head[p] && mine[p] && !mine[p]!.removed && !existsSync(join(repo, p)));
  const anywhere = touched(repo, ["--all"], gone);
  const history = once(() => recordHistory(repo));
  const onHead = touched(repo, ["HEAD"], gone);
  const out: ChangedTest[] = [];
  for (const path of paths) {
    // An older kept file's pin moved with it to its stored name (storeOlderKept), unchanged, is checked there.
    const movedTo = isOlderKept(path) ? now[`${DOME}/${storedName(runPath(path))}`] : undefined;
    if (!now[path] && movedTo && [head[path]?.sha256, ...mine[path]?.sha256 ?? []].includes(movedTo.sha256)) continue;
    const older = isStoredKept(path) ? `${DOME}/${runPath(path)}` : null;
    const [w, c, l] = [now[path], head[path] ?? (older ? head[older] : undefined),
      mine[path] ?? (older ? mine[older] : undefined)];
    const review = w?.review ?? c?.review ?? l?.review ?? "";
    if (!w) {
      const removed = l ? !l.removed && (!!c || existsSync(join(repo, path)) || !anywhere.has(path) || onHead.has(path))
        : !!c;
      if (removed) out.push({ path, review, change: "unpinned" });
      continue;
    }
    // Pinned here: one of the pins (and test lists) arnx wrote. Not here: the committed pin, or a file HEAD never pinned.
    const lists = trustedTests(w, c, l, older ? [path, older] : [path], history);
    if (lists !== "trusted" || (l ? !l.sha256.includes(w.sha256) : !!c && c.sha256 !== w.sha256)) {
      const repinned: ChangedTest = { path, review, change: "repinned" };
      if (lists === "dropped") droppedLists.add(repinned);
      out.push(repinned);
      continue;
    }
    // A pinned file is a regular file, read without following a link: a link (or a folder) there is an edit.
    const at = keptSha(repo, path);
    if (at === "gone") out.push({ path, review, change: "deleted" });
    else if (at !== w.sha256) out.push({ path, review, change: "modified" });
    // check never places a kept file over one the project has at the path it runs from.
    else if (path.startsWith(`${DOME}/`) && lstatSync(join(repo, runPath(path)), { throwIfNoEntry: false })) {
      out.push({ path, review, change: "collides" });
    }
  }
  // One run name, two entries (stored with .arnx appended and by the older name), one of them pinned: only one runs,
  // and it must be the pinned one. One that is not a regular file is an edit; two files that differ are both named,
  // neither chosen.
  const named = (p: string) => out.some((c) => c.path === p);
  for (const [older, stored] of keptPairs(repo)) {
    const pin = now[older] ?? head[older] ?? now[stored] ?? head[stored];
    const [a, b] = [keptSha(repo, older), keptSha(repo, stored)];
    // Gone meanwhile: a pinned one is named above.
    if (!pin || a === "gone" || b === "gone") continue;
    for (const [p, x] of [[older, a], [stored, b]] as const) {
      if (x === "other" && !named(p)) out.push({ path: p, review: pin.review, change: "modified" });
    }
    if (a === "other" || b === "other" || a === b) continue;
    for (const p of [older, stored]) if (!named(p)) out.push({ path: p, review: pin.review, change: "duplicate" });
  }
  // Anything else under .arnx/tests/ that no pin covers: arnx accept did not write it, and check places pinned files
  // only, so it is named rather than left out unseen. An older copy beside its pinned twin, the same bytes, is not: the
  // next check or accept removes it (storeOlderKept). Nor are OS and editor leftovers (isKeptJunk), or a link in place
  // of a folder whose pinned files are named above (the refusal names the link).
  for (const rel of entriesUnder(join(repo, DOME))) {
    const path = `${DOME}/${rel}`;
    if (now[path] || named(path) || isKeptJunk(rel) ||
      lstatSync(join(repo, path), { throwIfNoEntry: false })?.isDirectory() !== false) continue;
    if (out.some((c) => c.path.startsWith(`${path}/`))) continue;
    const twin = `${DOME}/${storedName(rel)}`;
    const sha = keptSha(repo, path);
    if (runName(rel) === rel && now[twin] && sha === keptSha(repo, twin) && sha !== "other" && sha !== "gone") continue;
    if (sha !== "gone") out.push({ path, review: "", change: "added" });
  }
  return out;
}

/** `.arnx` or `.arnx/tests` when either is there but not a real folder (a link, a file): nothing is read or written
 * through it. */
export function linkedDome(repo: string): string | null {
  for (const p of [".arnx", DOME]) {
    const st = lstatSync(join(repo, p), { throwIfNoEntry: false });
    if (st && !st.isDirectory()) return p;
  }
  return null;
}

/** Entries under .arnx/tests/ (files, links, folders, never entered through a link) that exist both by the older name
 * and by the stored name: [older, stored] paths. */
function keptPairs(repo: string): [string, string][] {
  const all = new Set(entriesUnder(join(repo, DOME)).filter((p) => !isKeptJunk(p)));
  return [...all].filter((p) => runName(p) === p && all.has(storedName(p)))
    .map((p) => [`${DOME}/${p}`, `${DOME}/${storedName(p)}`]);
}

/** What stops arnx at `odd` (irregularKept): links where a folder belongs get linkAdvice; a link or a folder where a
 * kept test belongs is deleted. */
export function keptAdvice(repo: string, odd: string[]): string {
  const pinned = Object.keys(readRecord(repo).files);
  const isFolderLink = (p: string) => p === linkedDome(repo) || pinned.some((f) => f.startsWith(`${p}/`));
  const folders = odd.filter(isFolderLink), rest = odd.filter((p) => !isFolderLink(p));
  const out: string[] = [];
  if (folders.length) out.push(linkAdvice(folders));
  if (rest.length) out.push(`not a regular file (a link or a folder) where arnx keeps tests: ${rest.slice(0, 5).join(", ")}` +
    `${rest.length > 5 ? ", …" : ""}; delete ${rest.length === 1 ? "it" : "them"} (or put the file back), then run the command again`);
  return out.join("\n");
}

/** What under .arnx/tests/ is neither a regular file nor a folder (a link, a FIFO), and the pinned paths that are not
 * regular files: accept writes there, never through a link, and refuses while any is there. */
export function irregularKept(repo: string): string[] {
  const linked = linkedDome(repo);
  if (linked) return [linked];
  const dome = join(repo, DOME);
  const odd = entriesUnder(dome).filter((p) => {
    const st = lstatSync(join(dome, p), { throwIfNoEntry: false });
    return !isKeptJunk(p) && !!st && !st.isFile() && !st.isDirectory();
  }).map((p) => `${DOME}/${p}`);
  // A pinned file behind a link in place of its folder: the link is what to delete.
  const pinned = Object.keys(readRecord(repo).files).filter((p) => keptSha(repo, p) === "other")
    .map((p) => linkOnTheWay(repo, p) ?? p);
  return [...new Set([...odd, ...pinned])].sort();
}

/** The one sentence for a link (or a file) where a folder belongs: `.arnx`, `.arnx/tests` or a folder of kept tests. */
export function linkAdvice(paths: string[]): string {
  return `${paths.join(", ")} ${paths.length === 1 ? "is a link" : "are links"}; replace ${paths.length === 1 ? "it" : "them"} ` +
    "with a real folder, then run the command again";
}

/** The first folder on the way to `rel` (repository-relative) that is a link, else null: deleting a file through it
 * would delete what it leads to. */
function linkOnTheWay(repo: string, rel: string): string | null {
  const parts = rel.split("/");
  for (let i = 1; i < parts.length; i++) {
    const st = lstatSync(join(repo, ...parts.slice(0, i)), { throwIfNoEntry: false });
    if (!st || (!st.isDirectory() && !st.isSymbolicLink())) return null;
    if (st.isSymbolicLink()) return parts.slice(0, i).join("/");
  }
  return null;
}

/** The accepted files that match their trusted pin, which approve and setup let fail (their bugs are not fixed yet),
 * and those changedAccepted reports, which still block. */
export interface AcceptedPins { pinned: string[]; changed: ChangedTest[] }

export function acceptedPins(repo: string, local: string | null = null): AcceptedPins {
  const changed = changedAccepted(repo, local);
  const bad = new Set(changed.map((c) => c.path));
  return { pinned: Object.keys(readRecord(repo).files).filter((p) => !bad.has(p)).sort(), changed };
}

/** What --keep-edits recorded: the files, and those whose edited accepted-test list it replaced by the trusted one. */
export interface KeptEdits { changed: ChangedTest[]; restoredTests: string[] }

/** `arnx accept --keep-edits`: the owner changed accepted tests on purpose; record them as they are now (a deleted one
 * is dropped from the record, a file whose entry was removed is pinned again). An accepted-test list edited in the
 * record is not an edit to keep: it could relabel a red accepted test as another one, so the trusted list (HEAD's,
 * else the last arnx wrote here) is recorded instead. */
export function keepEdits(repo: string, local: string | null = null): KeptEdits {
  const changed = changedAccepted(repo, local);
  const restoredTests: string[] = [];
  if (!changed.length) return { changed, restoredTests };
  // Only edits are kept: of two copies the owner deletes one, a link or a folder would pin what it leads to, and a file
  // accept did not write or one in the project's way is deleted or moved (changedSummary says which).
  const fix = fixable(repo, changed);
  if (fix.length < changed.length) {
    throw new ArnxError(changedSummary(changed.filter((c) => !fix.includes(c)), repo).split("\n").slice(1).join("\n"));
  }
  // Keeping an entry that dropped a list arnx pinned would record it as it is: the review puts the list back.
  const dropped = changed.filter((c) => droppedLists.has(c));
  if (dropped.length) {
    throw new ArnxError(`${dropped.map((c) => c.path).join(", ")}: ${ACCEPTED_RECORD} lost the accepted tests arnx ` +
      `recorded; restore with ${[...new Set(dropped.map((c) => `arnx accept --again ${c.review}`))].join(", ")}`);
  }
  const rec = readRecord(repo);
  const head = committedRecord(repo);
  const mine = readLocal(local, repo).files;
  const history = once(() => recordHistory(repo));
  const pins: Record<string, Pin | null> = {};
  for (const c of changed) {
    // Its accepted tests as recorded when trusted; else (edited, or the entry removed) HEAD's, else the last arnx
    // wrote here.
    const w = rec.files[c.path];
    const trusted = listsIn(head[c.path] ? head[c.path] : mine[c.path]?.tests?.at(-1));
    const ok = w && trustedTests(w, head[c.path], mine[c.path],
      isStoredKept(c.path) ? [c.path, `${DOME}/${runPath(c.path)}`] : [c.path], history) === "trusted";
    if (w && !ok) restoredTests.push(c.path);
    const lists = ok ? listsIn(w) : trusted;
    const sha = keptSha(repo, c.path);
    if (sha !== "gone") rec.files[c.path] = { sha256: sha, review: c.review, ...lists };
    else delete rec.files[c.path];
    pins[c.path] = rec.files[c.path] ?? null;
  }
  writeLocal(local, repo, (p) => changed.find((c) => c.path === p)!.review, pins);
  writeRecord(repo, rec);
  return { changed, restoredTests };
}

/** A file under .arnx/tests/ stored by the name it runs by (by an older arnx), or by its stored name (kept.ts). */
const isOlderKept = (p: string) => p.startsWith(`${DOME}/`) && runName(p) === p;
const isStoredKept = (p: string) => p.startsWith(`${DOME}/`) && runName(p) !== p;

/** What storeOlderKept did: older kept files now under their stored names (or removed beside an identical stored one),
 * and those left as they are beside a stored one that differs. */
export interface StoredOlder { stored: string[]; both: string[] }

/** Kept files an older arnx left under .arnx/tests/ by the names they run by, where a project's runner, type checker or
 * linter can pick them up: each renamed to its stored name, its pin moved with it (the content, and so its sha256, is
 * unchanged; `local`: this machine's record, localPinsPath). One beside a stored file of the same name is removed when
 * the two are identical, else both are left. A file changedAccepted reports is left where it is: its pin is not
 * trusted, and moving it would make it so. Only .arnx/ is touched. */
export function storeOlderKept(repo: string, local: string | null = null): StoredOlder {
  const out: StoredOlder = { stored: [], both: [] };
  if (!existsSync(join(repo, DOME))) return out;
  const older = collect(join(repo, DOME), "", /./).filter((p) => runName(p) === p && !isKeptJunk(p));
  if (!older.length) return out;
  const changed = new Set(changedAccepted(repo, local).map((c) => c.path));
  const rec = readRecord(repo);
  const pins: Record<string, Pin | null> = {};
  const review: Record<string, string> = {};
  for (const rel of older) {
    const from = `${DOME}/${rel}`, to = `${DOME}/${storedName(rel)}`;
    if (changed.has(from) || changed.has(to)) continue;
    let done: "moved" | "differ" | "gone" | "vanished";
    try {
      done = moveOlder(repo, from, to);
    } catch (e) {
      // Moved meanwhile (another check or accept at the same time): already stored.
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      done = "vanished";
    }
    if (done === "vanished") continue;
    if (done === "differ") {
      out.both.push(from);
      continue;
    }
    out.stored.push(from);
    const pin = rec.files[from];
    if (!pin) continue;
    delete rec.files[from];
    pins[from] = null;
    rec.files[to] ??= pin;
    pins[to] = rec.files[to]!;
    review[from] = pin.review;
    review[to] = rec.files[to]!.review;
  }
  if (Object.keys(pins).length) {
    writeLocal(local, repo, (p) => review[p]!, pins);
    writeRecord(repo, rec);
  }
  return out;
}

/** An older kept file at `from` to its stored name `to` (repository-relative), nothing read through a link: renamed when
 * nothing is at `to`; removed only beside a regular file with the same bytes ("gone"); else left ("differ"; a `from`
 * that is not a regular file is left too). "vanished": `from` went meanwhile. */
function moveOlder(repo: string, from: string, to: string): "moved" | "differ" | "gone" | "vanished" {
  const was = regularBytes(repo, from);
  if (was === "gone") return "vanished";
  if (was === "other") return "differ";
  if (!lstatSync(join(repo, to), { throwIfNoEntry: false })) {
    renameSync(join(repo, from), join(repo, to));
    return "moved";
  }
  const there = regularBytes(repo, to);
  if (typeof there === "string" || !there.equals(was)) return "differ";
  rmSync(join(repo, from));
  return "gone";
}

/** The line check and accept print after storeOlderKept (empty when it did nothing). */
export function storedOlderText(r: StoredOlder): string {
  const n = (k: number) => `${k} older kept file${k === 1 ? "" : "s"}`;
  return [r.stored.length ? `Stored ${n(r.stored.length)} out of your test runs.` : "",
    r.both.length ? `${n(r.both.length)} differ${r.both.length === 1 ? "s" : ""} from ${r.both.length === 1 ? "its" : "their"} ` +
      `stored copy; left as ${r.both.length === 1 ? "it is" : "they are"}: ${r.both.slice(0, 3).join(", ")}` +
      `${r.both.length > 3 ? ", …" : ""}` : ""].filter(Boolean).join("\n");
}

const LABEL: Record<ChangedTest["change"], string> = { modified: "modified", deleted: "deleted ", repinned: "repinned",
  unpinned: "unpinned", duplicate: "twice   ", added: "added   ", collides: "collides" };
const WHY: Record<ChangedTest["change"], string> = { modified: "", deleted: "",
  repinned: `: its entry in ${ACCEPTED_RECORD} changed, not by arnx on this machine`,
  unpinned: `: its entry in ${ACCEPTED_RECORD} was removed`,
  duplicate: ": one test stored under two names that differ",
  added: `: not in ${ACCEPTED_RECORD} (arnx accept did not write it)`,
  collides: ": it runs from a path your project already has" };

/** The changes arnx accept can restore (--again) or keep (--keep-edits): an edit, a deletion or a pin changed. A link,
 * two copies of one test, a file accept did not write and one in the project's way are settled by hand. */
function fixable(repo: string, changed: ChangedTest[]): ChangedTest[] {
  return changed.filter((c) => ["modified", "deleted", "repinned", "unpinned"].includes(c.change) &&
    !(c.change === "modified" && keptSha(repo, c.path) === "other"));
}

/** Whether `git checkout` brings back the accepted version of a changed file: HEAD has it as its trusted pin says. */
function restorable(repo: string, c: ChangedTest): boolean {
  if (!hasCommits(repo)) return false;
  // An entry refused as it stands at HEAD (lists dropped in a commit, an accept never committed): checkout changes nothing.
  const [w, at] = [readRecord(repo).files[c.path], committedRecord(repo)[c.path]];
  if (c.change === "repinned" && w && at && w.sha256 === at.sha256 && listsOf(w) === listsOf(at)) return false;
  const pin = c.change === "modified" || c.change === "deleted" ? readRecord(repo).files[c.path]?.sha256
    : committedRecord(repo)[c.path]?.sha256;
  const r = spawnSync("git", ["-C", repo, "show", `HEAD:${c.path}`], { maxBuffer: 64 * 1024 * 1024 });
  return !!pin && r.status === 0 && createHash("sha256").update(r.stdout).digest("hex") === pin;
}

/** What check prints when accepted tests changed; it runs nothing. Restoring is one line per review, with
 * `git checkout` only when HEAD holds the accepted version (accepted tests are often not committed yet). */
export function changedSummary(changed: ChangedTest[], repo: string): string {
  const kinds = new Set(changed.map((c) => c.change));
  const only = kinds.size === 1 ? [...kinds][0]! : null;
  const verb = only === "deleted" || only === "repinned" || only === "unpinned" ? only : "changed";
  // Added, duplicate and colliding files and a link where a folder belongs are not accepted tests that changed.
  const plain = changed.every((c) => ["modified", "deleted", "repinned", "unpinned"].includes(c.change) &&
    ![".arnx", DOME].includes(c.path));
  const lines = [plain ? `✗ ${count(changed.length, "accepted test file")} ${verb} since arnx accept; nothing ran:`
    : `✗ ${count(changed.length, "path")} in .arnx differ${changed.length === 1 ? "s" : ""} from what arnx accept recorded; nothing ran:`,
    ...changed.map((c) => `  ${LABEL[c.change]} ${c.path}${WHY[c.change]}`)];
  const fix = fixable(repo, changed);
  const reviews = [...new Set(fix.map((c) => c.review))];
  for (const r of reviews) {
    const mine = fix.filter((c) => c.review === r);
    const it = mine.length === 1 ? "it" : "them";
    const what = reviews.length === 1 ? it : `the file${mine.length === 1 ? "" : "s"} of review ${r}`;
    const paths = mine.every((c) => restorable(repo, c)) ? mine.map((c) => c.path) : [];
    if (paths.length && mine.some((c) => c.change === "repinned" || c.change === "unpinned")) {
      paths.push(ACCEPTED_RECORD);
    }
    lines.push(`To restore ${what}: arnx accept --again ${r} (rewrites ${it} from the review; your edits are lost)` +
      (paths.length ? `, or git checkout -- ${paths.join(" ")}` : ""));
  }
  const by = (pick: (c: ChangedTest) => boolean) => changed.filter(pick).map((c) => c.path);
  const say = (paths: string[], text: (them: string) => string) => {
    if (paths.length) lines.push(text(paths.length === 1 ? "it" : "them"));
  };
  // A file behind a link in place of its folder is deleted by deleting the link, never through it.
  const odd = by((c) => c.change === "modified" && keptSha(repo, c.path) === "other");
  const links = [...new Set([...by((c) => c.change === "modified" && c.path === linkedDome(repo)),
    ...odd.map((p) => linkOnTheWay(repo, p)).filter((p): p is string => !!p)])];
  say(odd.filter((p) => !linkOnTheWay(repo, p) && p !== linkedDome(repo)), (them) =>
    `A link or a folder where a kept test belongs: delete ${them}, then arnx check`);
  if (links.length) lines.push(linkAdvice(links));
  say(by((c) => c.change === "duplicate"), () => "A test stored under two names: delete the copy you do not want, then arnx check");
  say(by((c) => c.change === "added"), (them) => `Not written by arnx accept: delete ${them}, then arnx check`);
  say(by((c) => c.change === "collides"), (them) => "arnx never puts a kept test over a file of your project: move or " +
    `delete ${them} or that file, then arnx check`);
  // An entry that dropped a list arnx pinned is restored by accept --again alone (keepEdits refuses it).
  const keep = fix.filter((c) => !droppedLists.has(c));
  if (!keep.length) return lines.join("\n");
  const one = keep.length === 1;
  lines.push(keep.every((c) => c.change === "deleted")
    ? `To keep ${one ? "it" : "them"} deleted: arnx accept --keep-edits (drops ${one ? "it" : "them"} from the accepted tests)`
    : `To keep your edit${one ? "" : "s"}: arnx accept --keep-edits (records ${one ? "it" : "them"} as the new ` +
      `accepted version; it does not re-prove the bug${one ? "" : "s"})`);
  return lines.join("\n");
}

/** `arnx check --json`: the result for programs and coding agents (plugin/skills/arnx/references/check-json.md). */
export const CHECK_SCHEMA_VERSION = 1;
const RESULTS = ["pass", "fail", "no-report", "nothing-accepted", "tests-changed"] as const;

export function checkJson(results: ProjectCheck[], code: number, changed: ChangedTest[] = [],
  contradict: MayContradict[] = [], storedOlder = 0): string {
  return JSON.stringify({ schema_version: CHECK_SCHEMA_VERSION, command: "check",
    result: RESULTS[code] ?? "fail", exit_code: code,
    projects: results.map((r) => {
      const acc = (id: string) => !r.accepted || r.accepted.includes(id);
      return { project: r.project, files: r.files, no_report: r.noReport, no_report_reason: r.reason ?? null,
        log: r.log ?? null, passed: r.passed, accepted: [...r.passed, ...r.failed.map((t) => t.testId)].filter(acc),
        failed: r.failed.map((t) => ({ test_id: t.testId, outcome: t.outcome, message: t.message,
          accepted: acc(t.testId) })),
        skipped: r.skipped,
        ...(r.notRun ? { not_run: r.notRun.map(runPath) } : {}),
        ...(r.skippedAccepted ? { skipped_accepted: r.skippedAccepted } : {}),
        ...(r.missingAccepted ? { missing_accepted: r.missingAccepted } : {}),
        ...(r.leftOut ? { left_out: r.leftOut } : {}),
        ...(r.fakedKeys ? { faked_keys: r.fakedKeys } : {}),
        ...(r.couldNotRun ? { could_not_run: r.couldNotRun.map((x) => ({ test_id: x.testId, needs: x.needs, ...(x.faked ? { faked_key: true } : {}),
          ...(x.notRerun ? { not_rerun: true } : {}) })) } : {}) };
    }),
    changed, may_contradict: contradict, stand_ins_shown: results.some((r) => !!r.standInsShown),
    stored_older: storedOlder }, null, 2);
}
