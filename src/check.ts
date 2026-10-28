// check: run the accepted tests (kept in .arnx/tests/, out of the project's own test run) of every project in its
// approved sandbox, on the working tree as it is now, and say which still fail. After `arnx accept` the tests behind findings marked real
// fail; fixing the code turns them green, and this is how to see it without setting up the services by hand.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix } from "node:path";
import { adapterFor } from "./adapters";
import { git, hasCommits, snapshot } from "./change";
import { loadReviewFile, type ReviewConfig, sandboxOnlyOf, secretPinsOf } from "./config";
import { ArnxError } from "./errors";
import { placed } from "./fixprompt";
import { baseName, runTests, type TestResult } from "./outcomes";
import { load, type Review } from "./report";
import type { Say } from "./progress";
import { sayingDocker, type SessionFactory } from "./sandbox";
import type { Env, Settings } from "./settings";
import { DOME, dockerSession, keptTestFiles, legacyKeptFiles, runPath } from "./testround";

export const CHECK_TIMEOUT = 900;

/** `accepted`: the ids among passed and failed that are accepted tests (behind findings marked real; absent: all are).
 * `reason` and `log`, with noReport: why there is no report, and the runner's output (repository-relative).
 * `reviews`: a failed test → the review that accepted its file, when known. */
export interface ProjectCheck { project: string; files: string[]; passed: string[]; failed: TestResult[];
  skipped: number; noReport: boolean; accepted?: string[]; reason?: string; log?: string | null;
  reviews?: Record<string, string>; workdir?: string }

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

/** The accepted tests of each kept file: the part of its ids after `file::`, parameters dropped. */
export function testsByFile(paths: string[], ids: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = Object.fromEntries(paths.map((p) => [p, []]));
  for (const id of ids) {
    const [file, rest] = splitId(id);
    const name = baseName(rest);
    if (out[file] && !out[file].includes(name)) out[file].push(name);
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

/** Whether a test the runner reported (its id relative to the project's workdir) is an accepted test. */
function isAccepted(known: AcceptedIds, workdir: string, testId: string): boolean {
  const [file, rest] = splitId(testId);
  const inRepo = posix.join(workdir, file);
  if (known.ids.has(testKey(inRepo, rest)) || known.ids.has(testKey(file, rest))) return true;
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
  const holds = (cfg: ReviewConfig, p: string) => posix.normalize(cfg.workdir) === "." ||
    p.startsWith(`${posix.normalize(cfg.workdir)}/`);
  for (const p of Object.keys(readRecord(repo).files)) {
    if (p.startsWith(`${DOME}/`) || out.has(p) || !existsSync(join(repo, p))) continue;
    const cfg = projects.filter((c) => holds(c, p)).at(-1);
    if (cfg) out.set(p, cfg);
  }
  return new Map([...out].sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** `arnx accept --move`: move the accepted files an older arnx kept inside the projects (legacyAccepted) to the same
 * path under .arnx/tests/, out of the projects' own test runs, without their expected-fail markers (a red test is
 * red only in check now), and pin them there (`local`: this machine's record, localPinsPath). Folders left empty are
 * removed. Accepted files changed since accept are not moved: they block (ArnxError) until restored or kept. */
export function moveOut(repo: string, settings: Settings, local: string | null = null): Record<string, string> {
  const files = legacyAccepted(repo, settings);
  const changed = changedAccepted(repo, local).filter((c) => files.has(c.path));
  if (changed.length) throw new ArnxError(changedSummary(changed, repo));
  const rec = readRecord(repo);
  const pins: Record<string, Pin | null> = {};
  const review: Record<string, string> = {};
  const moved: Record<string, string> = {};
  for (const [p, cfg] of files) {
    const to = `${DOME}/${p}`;
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
    if (!pin) continue;
    delete rec.files[p];
    rec.files[to] = { ...pin, sha256: sha256(join(repo, to)) };
    pins[p] = null;
    pins[to] = rec.files[to]!;
    review[p] = review[to] = pin.review;
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
  const rust = /(?:^|\/)arnx_(\d{8}_[0-9a-f]{6})(?:_[^/]*)?\.rs$/.exec(path);
  return /(?:^|\/)(r\d{8}_[0-9a-f]{6})\//.exec(path)?.[1] ?? (rust ? `r${rust[1]}` : "");
}

/** Run each project's accepted tests: each is copied from .arnx/tests/ to the path it runs from in a throwaway copy
 * of the working tree, and run there, each review's files in a run of their own; a confirmed bug's test is red while
 * the bug is open. */
export async function check(repo: string, settings: Settings, o: { sessionFactory?: SessionFactory;
  progress?: Say; what?: string; pins?: string | null } = {}): Promise<ProjectCheck[]> {
  const file = loadReviewFile(repo);
  const out: ProjectCheck[] = [];
  let known: AcceptedIds | undefined;
  for (const cfg of file.projects) {
    const files = keptTestFiles(repo, cfg, settings.acceptedTestsDir);
    if (!files.length) continue;
    o.progress?.(`${cfg.name}: running ${o.what ?? "the accepted tests"}`);
    const tmp = mkdtempSync(join(tmpdir(), "arnx-check-"));
    try {
      const snap = join(tmp, "repo");
      // The working tree as it is now, fixes included, untracked files too (accepted tests are untracked until
      // committed): no model sees what a check runs.
      snapshot(repo, null, snap, secretPinsOf(file.raw), { sandbox: sandboxOnlyOf(file.raw), untracked: true });
      // The accepted tests and their support files, in place in this copy only.
      cpSync(join(repo, DOME), snap, { recursive: true });
      // Each review's files run apart (reviewGroup); the build log is kept where a failed build's error can point to
      // it (the snapshot is removed below).
      const groups = [...new Set(files.map(reviewGroup))];
      const target = (f: string) => posix.relative(cfg.workdir, runPath(f)) || runPath(f);
      const runs = await sayingDocker(o.progress, () => (o.sessionFactory ?? dockerSession)(cfg, snap,
        join(repo, ".arnx", "run", `check-${cfg.name}-build.log`), async (session) =>
          groups.map((g, i) => [g, ...runTests(session, snap, cfg, files.filter((f) => reviewGroup(f) === g).map(target),
            groups.length > 1 ? `check-${i + 1}.xml` : "check.xml", CHECK_TIMEOUT)] as const)));
      const results = runs.flatMap(([, , r]) => r ?? []);
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
        writeFileSync(join(repo, log), missing.map(([, r]) => r.output).join("\n"));
      }
      known ??= acceptedIds(repo);
      const ran = results.filter((t) => t.outcome !== "skipped");
      const failed = ran.filter((t) => t.outcome === "failed" || t.outcome === "error");
      const reviews = Object.fromEntries(failed.map((t) => [t.testId, reviewOf(known!, cfg.workdir, t.testId)])
        .filter(([, r]) => r));
      out.push({ project: cfg.name, workdir: cfg.workdir, files, noReport: missing.length > 0,
        passed: ran.filter((t) => t.outcome === "passed").map((t) => t.testId), failed, reviews,
        skipped: results.filter((t) => t.outcome === "skipped").length,
        accepted: ran.filter((t) => isAccepted(known!, cfg.workdir, t.testId)).map((t) => t.testId),
        ...(reason ? { reason, log } : { log: null }) });
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
  // With no accepted test among them (an answer's tests alone), the rest are not "other".
  const other = accTotal ? "other " : "";
  const where = "in the accepted files";
  if (ran.length) {
    const clean = !failed.length;
    if (accFail.length) {
      lines.push(`✗ ${count(accFail.length, "accepted test")} still fail${accFail.length === 1 ? "s (bug" : " (bugs"} ` +
        "not fixed yet)");
      if (accPass) lines.push(`✓ ${count(accPass, "accepted test")} pass${accPass === 1 ? "es" : ""}`);
    } else if (accTotal) {
      const too = clean && othPass ? ` (${count(othPass, "other test")} in ${accTotal === 1 ? "its file" : "their files"}` +
        " too)" : "";
      lines.push(`✓ ${accTotal === 1 ? "The accepted test passes" : `All ${accTotal} accepted tests pass`}${too}`);
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
  if (missing.length) {
    const timeout = missing.every((r) => r.reason?.startsWith("the tests timed out"));
    lines.push(`The accepted tests${multi ? ` of ${missing.map((r) => r.project).join(", ")}` : ""} could not be ` +
      `verified: ${timeout ? "a timeout" : "a run without a report"} is neither a fix nor a bug.`);
    return [lines.join("\n"), 2];
  }
  if (failed.length) {
    // A wrong test of a real bug is marked rewrite; tests that are not findings no mark covers.
    if (accFail.length) {
      const ids = [...new Set(accFail.map((x) => x.review).filter((r): r is string => !!r))].sort();
      // The review is unknown (a record by an older arnx): say where its id is rather than print a placeholder.
      const again = ids.length ? `\`arnx accept --again ${ids[0]}\`` +
        (ids.length > 1 ? ` (and ${ids.slice(1).map((r) => `\`${r}\``).join(", ")})` : "")
        : "accept the review that kept it again (`arnx accept --again` with its id; `ls .arnx/reviews` lists them)";
      lines.push("Fix the code, not the accepted tests. A real bug whose test is wrong: mark it rewrite in review.md " +
        `with a \`Rewrite:\` line saying why (noise only when there is no bug), then ${again}.`);
    }
    if (othFail.length) {
      const one = othFail.length === 1;
      lines.push(`The ${count(othFail.length, `${other}test`)} that fail${one ? "s is not a finding" : " are not findings"}: ` +
        `marks do not cover ${one ? "it" : "them"}. Fix the code, or fix or delete ${one ? "it" : "them"} in the file ` +
        "(then `arnx accept --keep-edits`).");
    }
    lines.push("Next: arnx check");
    return [lines.join("\n"), 1];
  }
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
// check's accepted tests from the other tests in the file without .arnx/reviews/. The list is pinned with the sha256:
// edited, it could turn a red accepted test into an "other" one, so an entry is trusted only when both its sha256 and
// its list (absent included: an older arnx wrote none) are HEAD's or ones arnx wrote here; else it is `repinned`.

export const ACCEPTED_RECORD = ".arnx/accepted-tests.json";
/** check's exit code when an accepted test file was changed or deleted since accept recorded it. */
export const TESTS_CHANGED = 4;

interface Pin { sha256: string; review: string; tests?: string[] }
interface AcceptedRecord { schema_version: 1; files: Record<string, Pin> }
/** modified/deleted: the file differs from its pin, or is gone. repinned: the pin itself was changed, and not by arnx
 * on this machine. unpinned: its entry was removed from the record (or the record deleted). */
export const CHANGES = ["modified", "deleted", "repinned", "unpinned"] as const;
export interface ChangedTest { path: string; review: string; change: typeof CHANGES[number] }

/** What arnx wrote to the record on this machine: per file, every sha256 and accepted-test list it pinned (a branch
 * switch brings back an older one; null: none, an entry by an older arnx), and whether it removed the entry (accept
 * --again keeping fewer files, --keep-edits of a deleted one). */
interface LocalPins { schema_version: 1; repo: string;
  files: Record<string, { review: string; sha256: string[]; tests?: (string[] | null)[]; removed?: boolean }> }

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
/** An accepted-test list as compared: order and repeats do not count; "" when there is none. */
const testsOf = (tests: unknown) => Array.isArray(tests) ? JSON.stringify([...new Set(tests.map(String))].sort()) : "";

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
      if (!lists.some((t) => testsOf(t) === testsOf(pin.tests))) lists.push(pin.tests ?? null);
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

/** Record what one accept wrote (repository-relative paths, each with its accepted tests: testsByFile), replacing that
 * review's earlier entries; `local`: this machine's record (localPinsPath). */
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
    rec.files[p] = { sha256: sha256(join(repo, p)), review, tests: t };
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
  const out: string[] = [];
  for (let i = 0; i + 1 < status.length; i += 2) {
    if (status[i] !== "A") out.push(status[i + 1]!);
  }
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
  if (before && Object.entries(before).some(([p, pin]) => !after?.[p] || after[p]!.sha256 !== pin.sha256 ||
    testsOf(after[p]!.tests) !== testsOf(pin.tests))) {
    out.push(ACCEPTED_RECORD);
  }
  return out.sort();
}

/** Paths that some commit of `revs` touched. */
function touched(repo: string, revs: string[], paths: string[]): Set<string> {
  if (!paths.length || !hasCommits(repo)) return new Set();
  return new Set(git(repo, ["--literal-pathspecs", "log", ...revs, "-z", "--format=", "--name-only", "--", ...paths])
    .split("\0").map((p) => p.trim()).filter(Boolean));
}

/** Whether an entry's accepted-test list is trusted: one arnx wrote here (`l`), else HEAD's (`c`; none: any). */
const trustedTests = (w: Pin, c: Pin | undefined, l: LocalPins["files"][string] | undefined) => l
  ? (Array.isArray(l.tests) ? l.tests : [null]).some((t) => testsOf(t) === testsOf(w.tests))
  : !c || testsOf(c.tests) === testsOf(w.tests);

/** Accepted files changed or deleted since accept recorded them, and pins changed or removed by anything but arnx on
 * this machine (`local`, localPinsPath). Files accept never recorded (kept by an arnx that did not record them) are not
 * checked. */
export function changedAccepted(repo: string, local: string | null = null): ChangedTest[] {
  const now = readRecord(repo).files;
  const head = committedRecord(repo);
  const mine = readLocal(local, repo).files;
  const paths = [...new Set([...Object.keys(now), ...Object.keys(head), ...Object.keys(mine)])].sort();
  // A file arnx pinned here whose file and entry are both gone, and that HEAD never pinned: on another branch (it is in
  // a commit HEAD does not reach), or removed (only in HEAD's history: a commit deleted it; in no commit: never
  // committed, then deleted).
  const gone = paths.filter((p) => !now[p] && !head[p] && mine[p] && !mine[p]!.removed && !existsSync(join(repo, p)));
  const anywhere = touched(repo, ["--all"], gone);
  const onHead = touched(repo, ["HEAD"], gone);
  const out: ChangedTest[] = [];
  for (const path of paths) {
    const [w, c, l] = [now[path], head[path], mine[path]];
    const review = w?.review ?? c?.review ?? l?.review ?? "";
    if (!w) {
      const removed = l ? !l.removed && (!!c || existsSync(join(repo, path)) || !anywhere.has(path) || onHead.has(path))
        : !!c;
      if (removed) out.push({ path, review, change: "unpinned" });
      continue;
    }
    // Pinned here: one of the pins (and test lists) arnx wrote. Not here: the committed pin, or a file HEAD never pinned.
    if (!trustedTests(w, c, l) || (l ? !l.sha256.includes(w.sha256) : !!c && c.sha256 !== w.sha256)) {
      out.push({ path, review, change: "repinned" });
      continue;
    }
    const full = join(repo, path);
    if (!existsSync(full)) out.push({ path, review, change: "deleted" });
    else if (sha256(full) !== w.sha256) out.push({ path, review, change: "modified" });
  }
  return out;
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
  const rec = readRecord(repo);
  const head = committedRecord(repo);
  const mine = readLocal(local, repo).files;
  const pins: Record<string, Pin | null> = {};
  for (const c of changed) {
    const full = join(repo, c.path);
    // Its accepted tests as recorded when trusted; else (edited, or the entry removed) HEAD's, else the last arnx
    // wrote here.
    const w = rec.files[c.path];
    const trusted = head[c.path] ? head[c.path]!.tests : mine[c.path]?.tests?.at(-1) ?? undefined;
    const ok = w && trustedTests(w, head[c.path], mine[c.path]);
    if (w && !ok) restoredTests.push(c.path);
    const tests = ok ? w.tests : trusted ?? undefined;
    if (existsSync(full)) rec.files[c.path] = { sha256: sha256(full), review: c.review, ...(tests ? { tests } : {}) };
    else delete rec.files[c.path];
    pins[c.path] = rec.files[c.path] ?? null;
  }
  writeLocal(local, repo, (p) => changed.find((c) => c.path === p)!.review, pins);
  writeRecord(repo, rec);
  return { changed, restoredTests };
}

const LABEL: Record<ChangedTest["change"], string> = { modified: "modified", deleted: "deleted ", repinned: "repinned",
  unpinned: "unpinned" };
const WHY: Record<ChangedTest["change"], string> = { modified: "", deleted: "",
  repinned: `: its entry in ${ACCEPTED_RECORD} changed, not by arnx on this machine`,
  unpinned: `: its entry in ${ACCEPTED_RECORD} was removed` };

/** Whether `git checkout` brings back the accepted version of a changed file: HEAD has it as its trusted pin says. */
function restorable(repo: string, c: ChangedTest): boolean {
  if (!hasCommits(repo)) return false;
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
  const verb = !only || only === "modified" ? "changed" : only;
  const one = changed.length === 1;
  const lines = [`✗ ${count(changed.length, "accepted test file")} ${verb} since arnx accept; nothing ran:`,
    ...changed.map((c) => `  ${LABEL[c.change]} ${c.path}${WHY[c.change]}`)];
  const reviews = [...new Set(changed.map((c) => c.review))];
  for (const r of reviews) {
    const mine = changed.filter((c) => c.review === r);
    const it = mine.length === 1 ? "it" : "them";
    const what = reviews.length === 1 ? it : `the file${mine.length === 1 ? "" : "s"} of review ${r}`;
    const paths = mine.every((c) => restorable(repo, c)) ? mine.map((c) => c.path) : [];
    if (paths.length && mine.some((c) => c.change === "repinned" || c.change === "unpinned")) {
      paths.push(ACCEPTED_RECORD);
    }
    lines.push(`To restore ${what}: arnx accept --again ${r} (rewrites ${it} from the review; your edits are lost)` +
      (paths.length ? `, or git checkout -- ${paths.join(" ")}` : ""));
  }
  lines.push(only === "deleted"
    ? `To keep ${one ? "it" : "them"} deleted: arnx accept --keep-edits (drops ${one ? "it" : "them"} from the accepted tests)`
    : `To keep your edit${one ? "" : "s"}: arnx accept --keep-edits (records ${one ? "it" : "them"} as the new ` +
      `accepted version; it does not re-prove the bug${one ? "" : "s"})`);
  return lines.join("\n");
}

/** `arnx check --json`: the result for programs and coding agents (skills/arnx/references/check-json.md). */
export const CHECK_SCHEMA_VERSION = 1;
const RESULTS = ["pass", "fail", "no-report", "nothing-accepted", "tests-changed"] as const;

export function checkJson(results: ProjectCheck[], code: number, changed: ChangedTest[] = [],
  contradict: MayContradict[] = []): string {
  return JSON.stringify({ schema_version: CHECK_SCHEMA_VERSION, command: "check",
    result: RESULTS[code] ?? "fail", exit_code: code,
    projects: results.map((r) => {
      const acc = (id: string) => !r.accepted || r.accepted.includes(id);
      return { project: r.project, files: r.files, no_report: r.noReport, no_report_reason: r.reason ?? null,
        log: r.log ?? null, passed: r.passed, accepted: [...r.passed, ...r.failed.map((t) => t.testId)].filter(acc),
        failed: r.failed.map((t) => ({ test_id: t.testId, outcome: t.outcome, message: t.message,
          accepted: acc(t.testId) })),
        skipped: r.skipped };
    }),
    changed, may_contradict: contradict }, null, 2);
}
