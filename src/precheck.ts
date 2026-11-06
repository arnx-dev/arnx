// Setup's look before a try runs the whole suite, which can take half an hour: the runner lists the tests (seconds,
// none runs), then a few small test files run. No tests, files that do not load, a runner that does not start: each
// goes back to the setup agent at once, with the runner's output. The whole suite still runs once before a project
// counts as proven, except in a quick setup (a first review's), where the sample's run is the project's proof.
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { adapterFor, getAdapter } from "./adapters";
import type { Listing, TestResult } from "./adapters/types";
import type { BaselineTest } from "./baseline";
import type { ReviewConfig } from "./config";
import { describeHints, diagnose, firstErrors } from "./diagnose";
import { ownerFile, runTests } from "./outcomes";
import { REPORT_DIR, type Runner, type RunResult } from "./sandbox";
import { namesFor } from "./testsdir";
import { isKeptPath, writeDirOf } from "./testround";

/** A list run collects, it runs no test: minutes means it is stuck, and the suite then tells. */
export const LIST_TIMEOUT = 300;
/** A few small files: minutes means something hangs (a service never answers). */
export const SAMPLE_TIMEOUT = 600;
/** How many of the smallest listed files run before the whole suite. */
export const SAMPLE_FILES = 3;

/** What stopped the try before the whole suite ran: why, in a sentence, the runner's output, and what the failures
 * of the sample point to. `kind`: what stopped it (a probe that is not seen counts as the listing). */
export interface Early { summary: string; output: string; hints: string; kind: "listing" | "sample" }

/** Said with every early stop: the agent may know better, and the whole suite settles it. */
const AGAIN = " (Tried again unchanged, the project runs its whole suite.)";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const few = (xs: string[], max = 3) => xs.slice(0, max).join(", ") + (xs.length > max ? ", …" : "");

/** What the runner lists for `targets` (every test with none), and the run; null when the runner has no list form,
 * the list run timed out, or its output cannot be read for sure. */
export async function listTests(session: Runner, snap: string, cfg: ReviewConfig, targets: string[], name = "list.json")
  : Promise<{ listing: Listing; result: RunResult } | null> {
  const adapter = adapterFor(cfg);
  const command = adapter.listCommand?.(cfg.testCommand, targets, `/src/${REPORT_DIR}/${name}`, cfg.runner);
  if (!command || !adapter.parseList) return null;
  const path = join(snap, REPORT_DIR, name);
  rmSync(path, { force: true });
  mkdirSync(dirname(path), { recursive: true });
  adapter.reportSetup?.(snap, cfg.runner);
  const result = await session.run(command, LIST_TIMEOUT);
  // A listing cut by the output limit would count only its end: no listing is better than a false one.
  if (result.timedOut || result.truncated) return null;
  const listed = existsSync(path) ? readFileSync(path, "utf8") : null;
  rmSync(path, { force: true });
  const listing = adapter.parseList(result.output, listed, result.exitCode, cfg.runner, cfg.workdir);
  return listing ? { listing, result } : null;
}

/** Why a listing stops the try ("" when it does not). `known`: files recorded as not loading, which do not stop it. */
export function listingProblem(listing: Listing, exitCode: number | null, known: (file: string) => boolean = () => false): string {
  if (listing.failed) {
    if (exitCode === 127) return "listing the tests stopped: the runner is not installed (exit 127); install it in install";
    return `listing the tests stopped with an error (exit ${exitCode ?? "?"}) before any test ran: the runner does not ` +
      "start, or its configuration does not load; the end of the output says why";
  }
  const broken = listing.broken.filter((f) => !known(f));
  const n = broken.length;
  if (n) {
    return `listing the tests: ${plural(n, "test file")} do${n === 1 ? "es" : ""} not load (${few(broken)}), ` +
      "so none of their tests would run";
  }
  // Files that do not load are named above, never called "none".
  if (!(listing.tests ?? listing.files.length) && !listing.broken.length) {
    return "listing the tests found none: test_command collects no tests";
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
export async function precheck(session: Runner, snap: string, cfg: ReviewConfig, acceptedTestsDir?: string)
  : Promise<Early | null> {
  return (await look(session, snap, cfg, acceptedTestsDir)).early;
}

/** What the look saw: what stops the try (null when nothing does), how many tests and files the runner listed, and
 * the sample's run when one ran and nothing stopped it (a quick setup takes it for the suite's run). */
export interface Look { early: Early | null; tests: number; files: number;
  /** Where the runner collects arnx's one-line test, when the project's settings were wrong and its own listing showed
   * the place (tests_dir, and test_files when it names the files another way): the look stopped there, for the try to
   * write it into review.yaml and run again. */
  placement?: Placement;
  /** The test files the runner listed (relative to the project root). */
  listed: string[];
  /** The runner listed nothing (it has no list form): `listed` holds the project's own test files, found by name. */
  found?: true;
  sample: { files: string[]; run: RunResult; results: TestResult[] } | null }

/** A place for arnx's tests the runner was seen to collect: tests_dir, and test_files when the files are named another
 * way (TypeScript only). */
export interface Placement { testsDir: string; testFiles?: string }

/** precheck, with what it listed and the sample's run. `baseline`: "record" while setup's agent is trying the project;
 * in a proof, the tests recorded as failing today: a file recorded as not loading stays recorded, and nobody tries
 * again, so nothing says it. */
export async function look(session: Runner, snap: string, cfg: ReviewConfig, acceptedTestsDir?: string,
                           baseline: BaselineTest[] | "record" = "record",
                           { files }: { files?: () => string[] } = {}): Promise<Look> {
  const proof = baseline === "record" ? null : baseline;
  const again = proof ? "" : AGAIN;
  const known = (file: string) => !!proof && (proof.some((t) => t.load && t.file === file) ||
    cfg.knownFailing.some((k) => file.startsWith(k)));
  const none: Look = { early: null, tests: 0, files: 0, listed: [], sample: null };
  const listed = await listTests(session, snap, cfg, []);
  let counts: { tests: number; files: number; listed: string[]; found?: true };
  let sample: string[];
  if (listed) {
    const { listing, result } = listed;
    counts = { tests: listing.tests ?? listing.files.length, files: listing.files.length, listed: listing.files };
    const why = listingProblem(listing, result.exitCode, known);
    if (why) return { ...none, ...counts, early: { summary: why + again, output: result.output, hints: "", kind: "listing" } };
    if (!listing.files.length) return { ...none, ...counts };
    const probe = await probeListed(session, snap, cfg);
    if (probe && !probe.seen) {
      const placement = await placementFrom(session, snap, cfg, listing);
      if (placement) return { ...none, ...counts, placement };
      return { ...none, ...counts, early: { summary: probeText(cfg) + again, output: probe.output, hints: "", kind: "listing" } };
    }
    sample = sampleOf(listing, cfg, snap, acceptedTestsDir);
  } else {
    // No list form (or no listing to trust): with `files` (the project's test files, relative to the repository), a
    // few small ones of them run all the same.
    if (!files) return none;
    const own = files().map((f) => posix.relative(cfg.workdir, f));
    counts = { tests: 0, files: own.length, listed: own, found: true };
    sample = sampleOf({ tests: null, files: own, broken: [], failed: false }, cfg, snap, acceptedTestsDir);
  }
  if (!sample.length) return { ...none, ...counts };
  const [run, results] = await runTests(session, snap, cfg, sample, "sample.xml", SAMPLE_TIMEOUT);
  const stop = sampleProblem(sample, run, results);
  if (!stop) return { ...none, ...counts, sample: { files: sample, run, results: results ?? [] } };
  return { ...none, ...counts, early: { summary: stop + again, output: run.output, kind: "sample",
    hints: [describeHints(diagnose(results, cfg, snap), cfg), firstErrors(results, cfg)].filter(Boolean).join("\n") } };
}

// ---- The one-line test, listed: what runSuite's probe tells after the whole suite, told before it. ----

/** Whether the runner lists arnx's one-line test, placed in tests_dir and given as the only target (the probe run
 * collects the same way), and the list run's output; null when the listing cannot tell. */
export async function probeListed(session: Runner, snap: string, cfg: ReviewConfig)
  : Promise<{ seen: boolean; output: string } | null> {
  const dir = writeDirOf(cfg);
  const files = adapterFor(cfg).probes(cfg.runner).map((p) => ({ ...p, rel: posix.join(dir, p.file) }));
  try {
    for (const p of files) {
      mkdirSync(join(snap, dir), { recursive: true });
      writeFileSync(join(snap, p.rel), p.source);
    }
    const listed = await listTests(session, snap, cfg, files.map((p) => posix.relative(cfg.workdir, p.rel)), "probe-list.json");
    if (!listed || listed.listing.failed) return null;
    const rels = files.map((p) => p.rel);
    return { seen: listed.listing.files.some((f) => ownerFile(f, rels) !== null), output: listed.result.output };
  } finally {
    for (const p of files) rmSync(join(snap, p.rel), { force: true });
  }
}

/** Where to put arnx's tests so the runner lists them, from the test files it listed (relative to the project root):
 * a new folder beside most of them, named like them when the usual names are not what they have. It is tried once, in
 * the same session; null when the listing shows no other place, or the runner still does not list the one-line test
 * there. */
export async function placementFrom(session: Runner, snap: string, cfg: ReviewConfig, listing: Listing)
  : Promise<Placement | null> {
  if (!listing.files.length) return null;
  const adapter = adapterFor(cfg);
  const counts = new Map<string, number>();
  for (const f of listing.files) counts.set(posix.dirname(f), (counts.get(posix.dirname(f)) ?? 0) + 1);
  const folder = [...counts].sort((a, b) => b[1] - a[1] || a[0].split("/").length - b[0].split("/").length ||
    (a[0] < b[0] ? -1 : 1))[0]![0];
  const testsDir = posix.join(folder, "arnx_generated");
  // The usual names first: a custom ending only when none of the listed files has them, and then only one that names a
  // test (namesFor); else the folder keeps the usual names.
  const usual = listing.files.some((f) => getAdapter(cfg.language).isTestFile(posix.basename(f)));
  const name = cfg.language === "typescript" && !cfg.testFiles && !usual ? namesFor(listing.files)[0] : undefined;
  const testFiles = cfg.testFiles ?? (name !== undefined ? `*${name}` : undefined);
  if (testsDir === cfg.testsDir && testFiles === cfg.testFiles) return null;
  const placed = { ...cfg, testsDir, ...(testFiles === undefined ? {} : { testFiles }) };
  const probe = await probeListed(session, snap, placed);
  return probe?.seen ? { testsDir, ...(testFiles === undefined ? {} : { testFiles }) } : null;
}

/** Why the try stops when the runner does not list the one-line test. */
export function probeText(cfg: ReviewConfig): string {
  return `the runner does not list a one-line test placed in ${writeDirOf(cfg)}/ (the folder reviews write tests to): it ` +
    "leaves that folder out (jest roots, vitest include, testMatch) or does not collect tests named the usual way. Set " +
    `tests_dir to a folder the runner includes${cfg.language === "typescript" ? " (and test_files when it collects only " +
      "files named another way)" : ""}, or fix test_command`;
}
