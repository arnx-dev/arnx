// Test results from the adapter's report, classified over repeated runs: a test that fails in every run is a
// finding; errors, flaky tests and runs without a report never are.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { adapterFor } from "./adapters";
import type { TestResult } from "./adapters/types";
import type { ReviewConfig } from "./config";
import { REPORT_DIR, type RunResult, type Runner } from "./sandbox";

export type { TestResult };

/** A test's name without the parameters its runner added: pytest's trailing `[...]` after the function's name
 * ("test_pay[0-1]" is test_pay). A bracket in a JavaScript title is the title's own ("topup generated [memory] > S1:
 * pays", from describe.each), so a name with anything but a bare identifier before its "[" is kept whole. */
export const baseName = (name: string): string => /^[\w.:]+\[[^]*\]$/.test(name) ? name.split("[")[0]! : name;

export const funcOf = (t: TestResult) => baseName(t.name);

export interface Classified {
  findings: TestResult[];
  flaky: TestResult[];
  errors: TestResult[];
  passed: TestResult[];
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
  const c: Classified = { findings: [], flaky: [], errors: [], passed: [], missingRuns: runs.length - complete.length,
    totalRuns: runs.length };
  for (const id of [...byId.keys()].sort()) {
    const results = byId.get(id)!;
    const outcomes = results.map((t) => t.outcome);
    const last = results[results.length - 1]!;
    if (outcomes.includes("error")) c.errors.push(results.find((t) => t.outcome === "error")!);
    else if (results.length === runs.length && outcomes.every((o) => o === "failed")) c.findings.push(last);
    else if (outcomes.includes("failed")) c.flaky.push(results.find((t) => t.outcome === "failed")!);
    else if (outcomes.every((o) => o === "skipped")) continue;
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
  const console = result.output.trim() ? result.output.slice(-DESCRIBE_TAIL) : "(empty)";
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
    : `${t.outcome.toUpperCase()} ${t.testId}${t.message ? `\n    ${t.message.slice(0, 600).replaceAll("\n", "\n    ")}` : ""}`);
  return `${ours.length} tests: ${summary}\n${lines.join("\n")}${tail}`;
}
const order = (o: string) => ["passed", "failed", "error", "skipped"].indexOf(o);

/** Run the targets with the configured command; null results when the run timed out or wrote no readable report.
 * A report left by an earlier run never counts. */
export function runTests(session: Runner, snap: string, cfg: ReviewConfig, targets: string[], reportName: string,
                         timeout: number): [RunResult, TestResult[] | null] {
  const adapter = adapterFor(cfg);
  const report = join(snap, REPORT_DIR, reportName);
  rmSync(report, { force: true });
  mkdirSync(dirname(report), { recursive: true }); // pytest creates it; node:test and others do not
  adapter.reportSetup?.(snap, cfg.runner);
  const result = session.run(adapter.command(cfg.testCommand, targets, `/src/${REPORT_DIR}/${reportName}`, cfg.runner),
    timeout);
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
