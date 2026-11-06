// Test results from the adapter's report, classified over repeated runs: a test that fails in every run is a
// finding; errors, flaky tests and runs without a report never are.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { adapterFor } from "./adapters";
import type { TestResult } from "./adapters/types";
import type { ReviewConfig } from "./config";
import { REPORT_DIR, type RunResult, type Runner } from "./sandbox";
import { maskPrivateKeys } from "./secrets";

export type { TestResult };

/** A test's name without the parameters its runner added: pytest's trailing `[...]` after the function's name
 * ("test_pay[0-1]" is test_pay). A bracket in a JavaScript title is the title's own ("topup generated [memory] > S1:
 * pays", from describe.each), so a name with anything but a bare identifier before its "[" is kept whole. */
export const baseName = (name: string): string => /^[\w.:]+\[[^]*\]$/.test(name) ? name.split("[")[0]! : name;

/** The key that links a reported test to its result: a test id's name without its file, its parameters or its
 * describe blocks. `file::test_ip[2001:0db8::1]` is `test_ip` (a parameter may hold "::"), `file::pays > charges once`
 * is `charges once`, and a title alone is itself. A parametrised case and its siblings share a key. */
export function testKey(id: string): string {
  const param = /^.*?::(\w+)\[[^]*\]\s*$/s.exec(id);
  const name = param ? param[1]! : id.split("::").at(-1)!;
  return name.split(" > ").at(-1)!.trim();
}

export const funcOf = (t: TestResult) => baseName(t.name);

export interface Classified {
  findings: TestResult[];
  flaky: TestResult[];
  errors: TestResult[];
  passed: TestResult[];
  /** Tests every run skipped. */
  skipped: number;
  /** Those tests (absent in rounds saved before they were kept). */
  skippedTests?: TestResult[];
  missingRuns: number;
  totalRuns: number;
}

/** A failure reported for a whole file, named after the file itself: the file crashed while loading (an import or
 * setup error), so no test in it ran. */
function fileLevel(t: TestResult): boolean {
  if (t.outcome !== "failed" || !t.name || !t.fileAttr) return false;
  return t.name === t.fileAttr || t.fileAttr.endsWith("/" + t.name) || t.name.endsWith("/" + t.fileAttr);
}

/** A file-level failure as the error it is (see `fileLevel`); any other result as it is. */
export const asError = (t: TestResult): TestResult => fileLevel(t)
  ? { ...t, outcome: "error", message: `the file failed while loading, so none of its tests ran${
    t.message && t.message !== "test failed" ? `: ${t.message}` : " (see the runner's output)"}` }
  : t;

export function classify(runs: (TestResult[] | null)[]): Classified {
  const complete = runs.filter((r): r is TestResult[] => r !== null).map((run) => run.map(asError));
  const byId = new Map<string, TestResult[]>();
  for (const run of complete) for (const t of run) byId.set(t.testId, [...(byId.get(t.testId) ?? []), t]);
  const c: Classified = { findings: [], flaky: [], errors: [], passed: [], skipped: 0, skippedTests: [], missingRuns: runs.length - complete.length,
    totalRuns: runs.length };
  for (const id of [...byId.keys()].sort()) {
    const results = byId.get(id)!;
    const outcomes = results.map((t) => t.outcome);
    const last = results[results.length - 1]!;
    if (outcomes.includes("error")) c.errors.push(results.find((t) => t.outcome === "error")!);
    else if (results.length === runs.length && outcomes.every((o) => o === "failed")) c.findings.push(last);
    else if (outcomes.includes("failed")) c.flaky.push(results.find((t) => t.outcome === "failed")!);
    else if (outcomes.every((o) => o === "skipped")) { c.skipped++; c.skippedTests!.push(results[results.length - 1]!); }
    else c.passed.push(last);
  }
  return c;
}

export function ownerFile(fileAttr: string, files: Iterable<string>): string | null {
  if (!fileAttr) return null;
  for (const f of files) if (f === fileAttr || f.endsWith("/" + fileAttr)) return f;
  return null;
}

const DESCRIBE_TAIL = 4000;

/** What the agent sees after run_tests: the parsed results of its own files first (the console alone can be empty:
 * node:test and vitest write results only to arnx's report), then the end of the runner's console. */
export function describeRun(result: RunResult, results: TestResult[] | null, files: string[]): string {
  // Masked before any cut, which could take a key's header and leave its body. Each message on its own, as a header with no
  // END hides what follows it.
  const console = result.output.trim() ? maskPrivateKeys(result.output).slice(-DESCRIBE_TAIL) : "(empty)";
  const tail = `\n\nEnd of the runner's console output:\n${console}`;
  if (result.timedOut) return `The run timed out after ${Math.round(result.seconds)}s; no results.${tail}`;
  if (results === null) {
    return `The runner wrote no report (exit code ${result.exitCode}). Usually a test file failed while loading ` +
      `(an import or setup error), or the runner could not start.${tail}`;
  }
  const ours = results.filter((t) => ownerFile(t.fileAttr, files) !== null);
  if (!ours.length) {
    return `The runner did not run any of your test files (exit code ${result.exitCode}): its configuration ` +
      `(for example jest roots or vitest include) may leave out the folder they are in.${tail}`;
  }
  const counts = new Map<string, number>();
  for (const t of ours) counts.set(t.outcome, (counts.get(t.outcome) ?? 0) + 1);
  const summary = [...counts.keys()].sort((a, b) => order(a) - order(b)).map((o) => `${counts.get(o)} ${o}`).join(", ");
  const lines = ours.map((t) => t.outcome === "passed" || t.outcome === "skipped"
    ? `${t.outcome} ${t.testId}`
    : `${t.outcome.toUpperCase()} ${t.testId}${t.message ? `\n    ${maskPrivateKeys(t.message).slice(0, 600).replaceAll("\n", "\n    ")}` : ""}`);
  return `${ours.length} tests: ${summary}\n${lines.join("\n")}${tail}`;
}
const order = (o: string) => ["passed", "failed", "error", "skipped"].indexOf(o);

/** The flag that keeps a run of a few generated files in one process (pytest `-n0`, jest `--runInBand`), when the
 * project configures parallel workers and has not opted out with `parallel: keep`; else null. */
export function serialFlag(cfg: ReviewConfig, snap: string): string | null {
  if (cfg.keepParallel) return null;
  const read = (rel: string) => {
    try {
      return readFileSync(join(snap, cfg.workdir, rel), "utf8");
    } catch {
      return null;
    }
  };
  return adapterFor(cfg).serialFlag?.(cfg.testCommand, read, cfg.runner) ?? null;
}

/** Run the targets with the configured command; null results when the run timed out or wrote no readable report.
 * A report left by an earlier run never counts. `o.serial`: the one-process flag goes last, so it wins over the
 * project's own setting; default off, so setup's suite and `check` run as the project configured them. */
export async function runTests(session: Runner, snap: string, cfg: ReviewConfig, targets: string[], reportName: string,
                               timeout: number, o: { serial?: boolean } = {}): Promise<[RunResult, TestResult[] | null]> {
  const adapter = adapterFor(cfg);
  const report = join(snap, REPORT_DIR, reportName);
  rmSync(report, { force: true });
  mkdirSync(dirname(report), { recursive: true }); // pytest creates it; node:test and others do not
  adapter.reportSetup?.(snap, cfg.runner);
  const flag = o.serial ? serialFlag(cfg, snap) : null;
  const command = adapter.command(cfg.testCommand, targets, `/src/${REPORT_DIR}/${reportName}`, cfg.runner);
  const result = await session.run(flag ? `${command} ${flag}` : command, timeout);
  if (result.timedOut) return [result, null];
  const file = existsSync(report) ? report : reportElsewhere(adapter.reportSaid?.(result.output, cfg.runner), snap);
  if (!file || !existsSync(file)) return [result, null];
  // A report outside arnx's report folder was not cleaned after the run: what it quotes of sandbox-only files goes.
  const raw = readFileSync(file, "utf8");
  const text = file !== report && session.clean ? session.clean(raw) : raw;
  if (file !== report) rmSync(file, { force: true });
  const exists = (rel: string) => existsSync(join(snap, cfg.workdir, rel));
  return [result, adapter.parseReport(text, cfg.runner, cfg.workdir, exists)];
}

/** The report a runner says it wrote somewhere else in the code under test, as a path in the snapshot: vitest keeps
 * the file a project's configuration names for its junit reporter (`reporters: [["junit", { outputFile }]]`) over
 * arnx's --outputFile. Elsewhere, or not said: null. */
function reportElsewhere(said: string | null | undefined, snap: string): string | null {
  if (!said?.startsWith("/src/") || said.split("/").includes("..")) return null;
  return join(snap, said.slice("/src/".length));
}

export interface Bounds {
  /** Seconds for one run of all the files (today's run limit), for each file alone, and for all the files run apart. */
  together: number;
  file: number;
  total: number;
  /** Run each in one process (outcomes.ts serialFlag). */
  serial?: boolean;
  /** Set when an earlier repeat already ran the files apart: they go file by file from the start. */
  apart?: boolean;
  /** Files that did not finish alone in an earlier repeat, with the seconds they had: not run again, each still one error. */
  hung?: Record<string, number>;
}
export interface Bounded {
  results: TestResult[] | null;
  run: RunResult;
  /** Every file that did not finish alone (earlier repeats' too), with the seconds it had. */
  hung: Record<string, number>;
  /** Files the apart stage had no time left for: not hung, each one error, and the review is incomplete. */
  notRun: string[];
  apart: boolean;
}

const hungError = (file: string, limit: number): TestResult => ({ testId: file, fileAttr: file, name: file,
  outcome: "error", message: `did not finish in ${limit} s; its tests have no result` });
const notRunError = (file: string): TestResult => ({ testId: file, fileAttr: file, name: file, outcome: "error",
  message: "was not run: out of time; its tests have no result" });

/** One repeat of the targets. They run together first within `bounds.together`, so the usual case, and a suite that
 * fits today's limit, costs nothing more. When that times out they run apart: each within `bounds.file`, all within
 * `bounds.total` of their own, and the reports are merged. A file that does not finish alone is one error (never a
 * finding) listed in `hung`; one the time ran out before is one error listed in `notRun`. Runs are one at a time. The
 * output is as the runs gave it: the caller masks it before it is cut or saved. */
export async function runBounded(session: Runner, snap: string, cfg: ReviewConfig, targets: string[], report: string,
                                 bounds: Bounds): Promise<Bounded> {
  const prior = bounds.hung ?? {};
  const live = targets.filter((t) => !(t in prior));
  const carried = targets.filter((t) => t in prior);
  if (!bounds.apart && !carried.length) {
    const [run, results] = await runTests(session, snap, cfg, targets, report, bounds.together, { serial: bounds.serial });
    if (!run.timedOut) return { results, run, hung: {}, notRun: [], apart: false };
    if (targets.length === 1) {
      return { results: [hungError(targets[0]!, bounds.together)], run: { ...run, timedOut: false },
        hung: { [targets[0]!]: bounds.together }, notRun: [], apart: false };
    }
    return await apartRuns(session, snap, cfg, targets, report, bounds, run.seconds, run.output, {});
  }
  return await apartRuns(session, snap, cfg, live, report, bounds, 0, "", prior, carried);
}

async function apartRuns(session: Runner, snap: string, cfg: ReviewConfig, targets: string[], report: string,
                         bounds: Bounds, spent: number, output: string, prior: Record<string, number>,
                         carried: string[] = []): Promise<Bounded> {
  // The apart stage has a budget of its own; what the run together used is not taken from it.
  let used = 0;
  const hung: Record<string, number> = { ...prior }, notRun: string[] = [];
  const results: TestResult[] = carried.map((h) => hungError(h, prior[h]!));
  const out = [output];
  let seconds = spent, seen = carried.length > 0;
  for (const [k, target] of targets.entries()) {
    // A file gets its whole time, or what is left of the budget; one that times out on less is not run, not hung.
    const left = bounds.total - used;
    if (left <= 0) {
      notRun.push(target);
      results.push(notRunError(target));
      continue;
    }
    const limit = Math.min(bounds.file, left);
    const [run, parsed] = await runTests(session, snap, cfg, [target], report.replace(/\.xml$/, `-${k + 1}.xml`), limit,
      { serial: bounds.serial });
    used += run.timedOut ? limit : run.seconds;
    seconds += run.seconds;
    out.push(`== ${target} ==\n${run.output}`);
    if (run.timedOut && limit < bounds.file) {
      notRun.push(target);
      results.push(notRunError(target));
    } else if (run.timedOut) {
      hung[target] = bounds.file;
      results.push(hungError(target, bounds.file));
    } else if (parsed) {
      results.push(...parsed);
      seen = true;
    }
  }
  const run: RunResult = { exitCode: Object.keys(hung).length || notRun.length ? null : 0,
    output: out.filter(Boolean).join("\n"), timedOut: false, seconds };
  const any = seen || Object.keys(hung).length > 0 || notRun.length > 0;
  return { results: any ? results : null, run, hung, notRun, apart: true };
}
