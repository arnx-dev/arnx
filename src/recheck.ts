// check --review: run a review's confirmed tests again, from .arnx/reviews/<id>/, on the working tree as it is now, in
// the approved sandbox, and say per finding whether it is fixed. This closes a coding agent's loop before anyone has
// accepted the review: the agent fixes the code, then sees the tests that proved the bugs pass. Nothing is copied
// into the repository, no mark or record is touched, no model is called.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix } from "node:path";
import { adapterFor } from "./adapters";
import { Boundary, STAND_INS_NOTE } from "./boundary";
import { filesAt, takeSnapshot } from "./change";
import { configSuspects, loadReviewFile, sandboxOnlyOf, secretPinsOf } from "./config";
import { A_FAKED_FILE, markUnproven, unprovenText } from "./diagnose";
import { SetupRequired } from "./errors";
import { asError, ownerFile, runTests, type TestResult } from "./outcomes";
import type { Say } from "./progress";
import { confirmed, notChecked, type Finding, load, type Review } from "./report";
import type { SessionFactory } from "./sandbox";
import type { Settings } from "./settings";
import { collect, dockerSession, readCopies, RUN_TIMEOUT, swapFiles, swapIn } from "./testround";

/** fixed: passed in every run. still-failing: failed (or errored) in a run; one is enough. no-report: a run gave no
 * report, or the test did not appear in it, and it never failed. */
export type RecheckStatus = "fixed" | "still-failing" | "no-report";

export interface FindingRecheck { id: string; project: string; testId: string; status: RecheckStatus;
  /** Its outcome in each run: passed, failed, error, skipped, absent (not in the report), missing (no report). */
  runs: string[]; message: string }

export interface ReviewRecheck { review: string; findings: FindingRecheck[];
  /** A message was masked. */
  standInsShown?: boolean;
  /** Files left out as secret-looking that its tests needed, and those left out in all. */
  couldNotRun?: { needs: string; faked?: boolean }[]; leftOut?: string[]; fakedKeys?: string[] }

/** The generated tests a review kept for one project, by repository-relative path. */
function generated(rdir: string, project: string, writable: RegExp): Record<string, string> {
  const own = join(rdir, "projects", project, "tests");
  const root = existsSync(own) ? own : join(rdir, "tests");
  return readCopies(root, writable);
}

/** A finding's outcome in one run: its own result, else the load error of its file, else absent. */
function outcomeIn(run: TestResult[] | null, f: Finding): { outcome: string; message: string; needs?: string; fakedKey?: true } {
  if (run === null) return { outcome: "missing", message: "" };
  const own = run.find((t) => t.testId === f.testId);
  const need = (t: TestResult) => ({ ...(t.needs ? { needs: t.needs } : {}), ...(t.fakedKey ? { fakedKey: t.fakedKey } : {}) });
  if (own) return { outcome: own.outcome, message: own.message, ...need(own) };
  const load = f.file ? run.find((t) => t.outcome === "error" && ownerFile(t.fileAttr, [f.file!]) !== null) : undefined;
  return load ? { outcome: "error", message: load.message, ...need(load) } : { outcome: "absent", message: "" };
}

/** Run the review's confirmed tests `settings.runs` times at most: a test that fails once is still failing and its file
 * is not run again; a fix counts only when its test passed in every run (the review's own rule for a stable result). */
export async function recheckReview(repo: string, rdir: string, settings: Settings, o: {
  sessionFactory?: SessionFactory; progress?: Say } = {}): Promise<ReviewRecheck> {
  const review: Review = load(rdir);
  const todo = [...confirmed(review), ...notChecked(review)];
  const out: FindingRecheck[] = [];
  if (!todo.length) return { review: review.id, findings: out };
  const file = loadReviewFile(repo);
  // A coding agent reads what a check says, and the code it ran on holds real values.
  const boundary = new Boundary(configSuspects(repo));
  let shown = false;
  const leftOut = new Set<string>(), fakedKeys = new Set<string>(), couldNotRun = new Map<string, boolean>();
  for (const name of [...new Set(todo.map((f) => f.project))]) {
    const cfg = file.projects.find((p) => p.name === name) ?? (file.legacy ? file.projects[0] : undefined);
    if (!cfg) {
      throw new SetupRequired(`review ${review.id} names project ${name}, which .arnx/review.yaml no longer has`);
    }
    const adapter = adapterFor(cfg);
    const files = generated(rdir, name, adapter.writable);
    const mine = todo.filter((f) => f.project === name);
    const owner = (f: Finding) => f.file && files[f.file] !== undefined ? f.file : ownerFile(f.testId.split("::")[0]!,
      Object.keys(files));
    const runs = new Map<string, { outcome: string; message: string; needs?: string; fakedKey?: true }[]>(mine.map((f) => [f.id, []]));
    const unrunnable = mine.filter((f) => !owner(f));
    for (const f of unrunnable) runs.get(f.id)!.push({ outcome: "missing", message: "the review kept no test file for it" });
    const runnable = mine.filter((f) => owner(f));
    if (runnable.length) {
      const writeDir = review.writeDirs?.[name] ?? review.writeDir;
      o.progress?.(`${name}: running ${runnable.length} confirmed test${runnable.length === 1 ? "" : "s"} of review ` +
        `${review.id}`);
      const tmp = mkdtempSync(join(tmpdir(), "arnx-recheck-"));
      try {
        const snap = join(tmp, "repo");
        // The working tree as it is now, fixes included, untracked files too (accepted tests are untracked until
        // committed): no model sees what a check runs.
        const taken = takeSnapshot(repo, null, snap, secretPinsOf(file.raw), { sandbox: sandboxOnlyOf(file.raw),
          untracked: true });
        boundary.addScrubbed(taken);
        const lacking = taken.withheld.map((w) => w.path);
        lacking.forEach((p) => leftOut.add(p));
        taken.fakedKeys.forEach((p) => fakedKeys.add(p));
        const tree = lacking.length || taken.fakedKeys.length ? filesAt(repo, null, true) : [];
        // The review's generated files go in as they ran, in place of anything in its tests directory.
        mkdirSync(join(snap, writeDir), { recursive: true });
        for (const rel of collect(snap, writeDir, adapter.writable)) rmSync(join(snap, rel), { force: true });
        for (const [rel, source] of Object.entries(files)) {
          mkdirSync(dirname(join(snap, rel)), { recursive: true });
          writeFileSync(join(snap, rel), source);
        }
        const ours = Object.keys(files);
        const swap = swapIn(boundary, snap, (rel) => ours.includes(rel));
        await (o.sessionFactory ?? dockerSession)(cfg, snap, join(tmp, "build.log"), async (session) => {
          if (!session.copies) swapFiles(snap, ours, swap);
          for (let i = 1; i <= settings.runs; i++) {
            // Only tests not yet decided: none of their runs failed, none went without a report.
            const open = runnable.filter((f) => runs.get(f.id)!.every((r) => r.outcome === "passed"));
            if (!open.length) break;
            const targets = [...new Set(open.map((f) => owner(f)!))].sort()
              .map((p) => posix.relative(cfg.workdir, p) || p);
            o.progress?.(`${name}: run ${i}/${settings.runs}, ${targets.length} file${targets.length === 1 ? "" : "s"}`);
            const [, parsed] = runTests(session, snap, cfg, targets, `recheck-${i}.xml`, RUN_TIMEOUT);
            // The saved finding's id holds a stand-in where the run's holds the value (a parametrized test).
            const results = parsed && markUnproven(parsed.map(asError), { leftOut: lacking, fakedKeys: taken.fakedKeys, all: tree }).map((t) => ({ ...t, testId: boundary.mask(t.testId) }));
            for (const f of open) runs.get(f.id)!.push(outcomeIn(results, f));
          }
          return null;
        }, undefined, undefined, swap);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
    for (const f of mine) {
      const seen = runs.get(f.id)!;
      const failed = seen.find((r) => (r.outcome === "failed" || r.outcome === "error") && !r.needs);
      const lack = seen.find((r) => r.needs);
      const status: RecheckStatus = lack && !failed ? "no-report" : failed ? "still-failing"
        : seen.length === settings.runs && seen.every((r) => r.outcome === "passed") ? "fixed" : "no-report";
      if (lack && !failed) couldNotRun.set(lack.needs!, !!lack.fakedKey);
      const message = failed?.message ?? seen.find((r) => r.outcome !== "passed")?.message ?? "";
      const said = boundary.mask(message);
      shown ||= said !== message;
      out.push({ id: f.id, project: name, testId: f.testId, status, runs: seen.map((r) => r.outcome), message: said });
    }
  }
  const order = new Map(review.findings.map((f, i) => [f.id, i]));
  out.sort((a, b) => order.get(a.id)! - order.get(b.id)!);
  return { review: review.id, findings: out, ...(shown ? { standInsShown: true } : {}),
    ...(couldNotRun.size ? { couldNotRun: [...couldNotRun].sort().map(([needs, faked]) => ({ needs, ...(faked ? { faked } : {}) })) } : {}),
    ...(leftOut.size ? { leftOut: [...leftOut].sort() } : {}), ...(fakedKeys.size ? { fakedKeys: [...fakedKeys].sort() } : {}) };
}

/** The exit code, as check's: 0 every confirmed test passes (or none to run), 1 some still fail, 2 some gave no
 * report (the larger wins, as in check). */
export function recheckCode(r: ReviewRecheck): number {
  return r.findings.reduce((code, f) => Math.max(code, f.status === "no-report" ? 2 : f.status === "still-failing" ? 1
    : 0), 0);
}

export function recheckSummary(r: ReviewRecheck): [string, number] {
  const code = recheckCode(r);
  if (!r.findings.length) {
    return [`Review ${r.review} has no confirmed findings: nothing to run.`, 0];
  }
  const n = (s: RecheckStatus) => r.findings.filter((f) => f.status === s).length;
  const lines = [`Review ${r.review}: ${n("fixed")} fixed, ${n("still-failing")} still failing` +
    (n("no-report") ? `, ${n("no-report")} without a report` : "")];
  for (const f of r.findings) {
    const mark = f.status === "fixed" ? "✓" : f.status === "still-failing" ? "✗" : "?";
    const why = f.status === "fixed" ? `passed in ${f.runs.length} run${f.runs.length === 1 ? "" : "s"}`
      : f.status === "still-failing" ? (f.message.split("\n")[0] ?? "").slice(0, 120) || "failed"
      : `no report (${f.runs.join(", ") || "not run"})`;
    lines.push(`  ${mark} ${f.id} ${f.testId}: ${why}`);
  }
  if (r.standInsShown) lines.push(STAND_INS_NOTE);
  if (r.couldNotRun) {
    lines.push(`${unprovenText(r.couldNotRun.length, r.couldNotRun, (p) => p.join(", ")).replace(/^./, (c) => c.toUpperCase())}. If it is a test fixture: \`arnx allow-secret ` +
      `${r.couldNotRun.length === 1 && r.couldNotRun[0]!.needs !== A_FAKED_FILE ? r.couldNotRun[0]!.needs : "PATH"}\`, then run this again.`);
  } else if (code !== 0) {
    if (r.leftOut) lines.push(`Left out as secret-looking, which these tests may need: ${r.leftOut.join(", ")}. If one is a test fixture: \`arnx allow-secret PATH\`.`);
  }
  lines.push(code === 0 ? "Every confirmed test passes now."
    : code === 1 ? `${r.fakedKeys ? "Fix the code; if this test needs a real key: `arnx allow-secret PATH`. " : "Fix the code (not the tests) and "}${r.fakedKeys ? "Run" : "run"} \`arnx check --review\` again.`
    : r.couldNotRun ? "These tests say nothing about the code until it is." : "Some tests did not report; see above.");
  return [lines.join("\n"), code];
}

/** `arnx check --review <id> --json` (skills/arnx/references/check-json.md). */
export function recheckJson(r: ReviewRecheck): string {
  const code = recheckCode(r);
  return JSON.stringify({ schema_version: 1, command: "check", review: r.review,
    result: !r.findings.length ? "nothing-confirmed" : ["pass", "fail", "no-report"][code], exit_code: code,
    findings: r.findings.map((f) => ({ id: f.id, project: f.project, test_id: f.testId, status: f.status, runs: f.runs,
      message: f.message })), stand_ins_shown: !!r.standInsShown }, null, 2);
}
