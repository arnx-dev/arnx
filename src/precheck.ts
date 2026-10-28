// Setup's look before a try runs the whole suite, which can take half an hour: the runner lists the tests (seconds,
// none runs), then a few small test files run. No tests, files that do not load, a runner that does not start: each
// goes back to the setup agent at once, with the runner's output. The whole suite still runs once before a project
// counts as proven.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { adapterFor } from "./adapters";
import type { Listing, TestResult } from "./adapters/types";
import type { ReviewConfig } from "./config";
import { describeHints, diagnose, firstErrors } from "./diagnose";
import { ownerFile, runTests } from "./outcomes";
import { REPORT_DIR, type Runner, type RunResult } from "./sandbox";
import { isKeptPath, writeDirOf } from "./testround";

/** A list run collects, it runs no test: minutes means it is stuck, and the suite then tells. */
export const LIST_TIMEOUT = 300;
/** A few small files: minutes means something hangs (a service never answers). */
export const SAMPLE_TIMEOUT = 600;
/** How many of the smallest listed files run before the whole suite. */
export const SAMPLE_FILES = 3;

/** What stopped the try before the whole suite ran: why, in a sentence, the runner's output, and what the failures
 * of the sample point to. */
export interface Early { summary: string; output: string; hints: string }

/** Said with every early stop: the agent may know better, and the whole suite settles it. */
const AGAIN = " (Tried again unchanged, the project runs its whole suite.)";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const few = (xs: string[], max = 3) => xs.slice(0, max).join(", ") + (xs.length > max ? ", …" : "");

/** What the runner lists for `targets` (every test with none), and the run; null when the runner has no list form,
 * the list run timed out, or its output cannot be read for sure. */
export function listTests(session: Runner, snap: string, cfg: ReviewConfig, targets: string[], name = "list.json")
  : { listing: Listing; result: RunResult } | null {
  const adapter = adapterFor(cfg);
  const command = adapter.listCommand?.(cfg.testCommand, targets, `/src/${REPORT_DIR}/${name}`, cfg.runner);
  if (!command || !adapter.parseList) return null;
  const path = join(snap, REPORT_DIR, name);
  rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  adapter.reportSetup?.(snap, cfg.runner);
  const result = session.run(command, LIST_TIMEOUT);
  if (result.timedOut) return null;
  const listed = existsSync(path) ? readFileSync(path, "utf8") : null;
  rmSync(path, { force: true });
  const listing = adapter.parseList(result.output, listed, result.exitCode, cfg.runner, cfg.workdir);
  return listing ? { listing, result } : null;
}

/** Why a listing stops the try ("" when it does not). */
export function listingProblem(listing: Listing, exitCode: number | null): string {
  if (listing.failed) {
    return `listing the tests stopped with an error (exit ${exitCode ?? "?"}) before any test ran: the runner does not ` +
      "start, or its configuration does not load; the end of the output says why";
  }
  if (!(listing.tests ?? listing.files.length)) return "listing the tests found none: test_command collects no tests";
  const n = listing.broken.length;
  if (n) {
    return `listing the tests: ${plural(n, "test file")} do${n === 1 ? "es" : ""} not load (${few(listing.broken)}), ` +
      "so none of their tests would run";
  }
  return "";
}

/** Up to SAMPLE_FILES of the listed files, the smallest first, as targets (relative to the project root); none when
 * the listing holds few more files than that (the whole suite is then about as quick). A listed path is relative to
 * the runner's root, which can sit above the project's: its leading folders go until it names a file there. */
export function sampleOf(listing: Listing, cfg: ReviewConfig, snap: string, acceptedTestsDir?: string): string[] {
  const root = join(snap, cfg.workdir);
  const generated = writeDirOf(cfg);
  const found = new Map<string, number>();
  for (const listed of listing.files) {
    for (let p = listed; p; p = p.includes("/") ? p.slice(p.indexOf("/") + 1) : "") {
      const st = statSync(join(root, p), { throwIfNoEntry: false });
      if (!st?.isFile()) continue;
      const repo = posix.join(cfg.workdir, p);
      if (!repo.startsWith(`${generated}/`) && !repo.startsWith(".arnx/") && !isKeptPath(cfg, repo, acceptedTestsDir)) {
        found.set(p, st.size);
      }
      break;
    }
  }
  if (found.size <= SAMPLE_FILES) return [];
  return [...found].sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0])).slice(0, SAMPLE_FILES).map(([p]) => p);
}

/** Why a sample run stops the try ("" when it does not): no report, or not one test passing or skipped. A sample that
 * reports no test says nothing (a runner may not take files as targets the way the listing names them). */
export function sampleProblem(sample: string[], result: RunResult, results: TestResult[] | null): string {
  const head = `a run of ${plural(sample.length, "small test file")} (${few(sample)})`;
  if (results === null) {
    return `${head} ${result.timedOut ? `did not finish in ${SAMPLE_TIMEOUT} s` : "produced no report"}, so the whole ` +
      "suite was not run";
  }
  if (!results.length || results.some((t) => t.outcome === "passed" || t.outcome === "skipped")) return "";
  const counts = new Map<string, number>();
  for (const t of results) counts.set(t.outcome, (counts.get(t.outcome) ?? 0) + 1);
  return `${head}: ${[...counts].sort().map(([o, n]) => `${n} ${o}`).join(", ")}; no test passed, so the whole suite ` +
    "was not run";
}

/** The look before the whole suite, in the session it then runs in: the listing, arnx's one-line test among what the
 * runner lists from tests_dir, a few small files. Null when nothing it saw stops the try. */
export function precheck(session: Runner, snap: string, cfg: ReviewConfig, acceptedTestsDir?: string): Early | null {
  const listed = listTests(session, snap, cfg, []);
  if (!listed) return null;
  const { listing, result } = listed;
  const why = listingProblem(listing, result.exitCode);
  if (why) return { summary: why + AGAIN, output: result.output, hints: "" };
  if (!listing.files.length) return null;
  const probe = probeListed(session, snap, cfg);
  if (probe && !probe.seen) return { summary: probeText(cfg) + AGAIN, output: probe.output, hints: "" };
  const sample = sampleOf(listing, cfg, snap, acceptedTestsDir);
  if (!sample.length) return null;
  const [run, results] = runTests(session, snap, cfg, sample, "sample.xml", SAMPLE_TIMEOUT);
  const stop = sampleProblem(sample, run, results);
  if (!stop) return null;
  return { summary: stop + AGAIN, output: run.output,
    hints: [describeHints(diagnose(results, cfg, snap), cfg), firstErrors(results, cfg)].filter(Boolean).join("\n") };
}

// ---- The one-line test, listed: what runSuite's probe tells after the whole suite, told before it. ----

/** Whether the runner lists arnx's one-line test, placed in tests_dir and given as the only target (the probe run
 * collects the same way), and the list run's output; null when the listing cannot tell. */
export function probeListed(session: Runner, snap: string, cfg: ReviewConfig): { seen: boolean; output: string } | null {
  const dir = writeDirOf(cfg);
  const files = adapterFor(cfg).probes(cfg.runner).map((p) => ({ ...p, rel: posix.join(dir, p.file) }));
  try {
    for (const p of files) {
      mkdirSync(join(snap, dir), { recursive: true });
      writeFileSync(join(snap, p.rel), p.source);
    }
    const listed = listTests(session, snap, cfg, files.map((p) => posix.relative(cfg.workdir, p.rel)), "probe-list.json");
    if (!listed || listed.listing.failed) return null;
    const rels = files.map((p) => p.rel);
    return { seen: listed.listing.files.some((f) => ownerFile(f, rels) !== null), output: listed.result.output };
  } finally {
    for (const p of files) rmSync(join(snap, p.rel), { force: true });
  }
}

/** Why the try stops when the runner does not list the one-line test. */
export function probeText(cfg: ReviewConfig): string {
  return `the runner does not list a one-line test placed in ${writeDirOf(cfg)}/ (the folder reviews write tests to): it ` +
    "leaves that folder out (jest roots, vitest include, testMatch) or does not collect tests named the usual way. Set " +
    "tests_dir to a folder the runner includes, or fix test_command";
}
