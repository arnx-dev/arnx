// A test that failed or skipped in a sandbox holding a fake of a private key (secrets.ts fakeKeys) runs once more with the
// real key: in a throwaway copy of the snapshot, the key read from the file on the host only for that run, no network, its
// output never read. Only each test's outcome comes back; the copy is removed before anything else reads it. A test that
// goes otherwise with the real key failed for the fake (diagnose.ts markUnproven); one that fails again stands.
import { spawnSync } from "node:child_process";
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, unlinkSync, writeSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { adapterFor } from "./adapters";
import type { TestResult } from "./adapters/types";
import type { ReviewConfig } from "./config";
import { asError, serialFlag } from "./outcomes";
import { copyTreeInside, readRegular, realFolders, removeTree, writeNew } from "./safefs";
import { REPORT_DIR, realKeyCopies, type Runner } from "./sandbox";
import { withRealKeys } from "./secrets";

/** Most tests run with the real key in one command: a review (with `arnx accept`'s answer rounds, one accept), a setup, a
 * check. Every test of a file it reruns counts. Past it, a failure beside a fake is not rerun: it reads as unproven, never a
 * finding, and a skip stays a skip. */
export const KEY_RERUN_MOST = 20;
/** What is left of that number. */
export interface KeyReruns { left: number }
export const keyReruns = (): KeyReruns => ({ left: KEY_RERUN_MOST });

/** What the rerun gave a test, by test id: its outcome, or null when it was not rerun (past KEY_RERUN_MOST, out of time, no
 * report or not in it, no run can reach the real key, or a copy that could not be made safely). */
export type RealOutcomes = ReadonlyMap<string, string | null>;

/** Where a faked file's own text is: the working tree (`head` null) or a commit. */
export interface KeySource { repo: string; head: string | null }

const RERUN_OUTCOMES = new Set(["failed", "error", "skipped"]);

/** The tests of `runs` that failed or were skipped in any of them, nothing left out to blame, less `skip` (a file that did not
 * finish, which is no test), first by test id. */
export function rerunCandidates(runs: readonly (readonly TestResult[] | null)[], skip: ReadonlySet<string> = new Set()): TestResult[] {
  const byId = new Map<string, TestResult>();
  for (const run of runs) {
    for (const t of run ?? []) {
      if (!t.needs && !skip.has(t.testId) && RERUN_OUTCOMES.has(t.outcome) && !byId.has(t.testId)) byId.set(t.testId, t);
    }
  }
  return [...byId.values()].sort((a, b) => a.testId < b.testId ? -1 : a.testId > b.testId ? 1 : 0);
}

/** The text of `rel` at the source, or null. */
function ownText(source: KeySource, rel: string): string | null {
  if (source.head === null) {
    try {
      return readFileSync(join(source.repo, rel), "utf8");
    } catch {
      return null;
    }
  }
  const r = spawnSync("git", ["-C", source.repo, "show", `${source.head}:${rel}`], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return r.status === 0 ? r.stdout : null;
}

/** Whether a pid is a live process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The copy of `snap` a rerun of this process uses: the pid in its name tells a later arnx whether it is still in use. */
const copyOf = (snap: string) => `${snap}.${process.pid}.realkey`;
const COPY_NAME = /\.(\d+)\.realkey$/;

/** Removes the copies an arnx that ended without its cleanup (killed outright) left in its temp folders: every
 * `arnx-*` folder of the system's, whose process is gone. Run at the start of a review, a setup and a check. */
export function sweepRealKeyCopies(root = tmpdir()): void {
  const me = process.getuid?.();
  let names: string[];
  try {
    names = readdirSync(root).filter((n) => n.startsWith("arnx-"));
  } catch {
    return;
  }
  for (const name of names) {
    const dir = join(root, name);
    try {
      const st = lstatSync(dir);
      if (!st.isDirectory() || (me !== undefined && st.uid !== me)) continue;
      for (const child of readdirSync(dir)) {
        const m = COPY_NAME.exec(child);
        const at = join(dir, child);
        if (!m || realKeyCopies.has(at) || (Number(m[1]) !== process.pid && alive(Number(m[1])))) continue;
        removeTree(at);
      }
    } catch {
      // not ours to read
    }
  }
}

/** The faked file `rel` of the copy with its real key, checked before anything is written: every folder on the way a real
 * folder of the copy, the file a regular file. "unsafe": a check failed, so nothing may be written; null: no key to place. */
function realText(source: KeySource, copy: string, rel: string): { at: string; real: string; faked: string; mode: number } | "unsafe" | null {
  if (!realFoldersOrMissing(copy, rel)) return "unsafe";
  const at = join(copy, rel);
  const st = lstatSync(at, { throwIfNoEntry: false });
  if (!st) return null;
  if (!st.isFile() || !realFolders(copy, rel)) return "unsafe";
  const faked = readRegular(at, MAX_KEY_FILE);
  const own = faked === null ? null : ownText(source, rel);
  const real = own === null || faked === null ? null : withRealKeys(own, faked);
  return real === null ? null : { at, real, faked: faked!, mode: st.mode & 0o777 };
}

/** Whether the way to `rel` is free of links and other files, as far as it goes (a folder may be missing). */
function realFoldersOrMissing(root: string, rel: string): boolean {
  let at = root;
  for (const part of rel.split("/").slice(0, -1)) {
    at = join(at, part);
    const st = lstatSync(at, { throwIfNoEntry: false });
    if (!st) return true;
    if (!st.isDirectory()) return false;
  }
  return true;
}

/** The largest faked file and report read here. */
const MAX_KEY_FILE = 32 * 1024 * 1024;

/** How many tests each target holds, by what the faked runs reported. */
function testsPer(all: readonly (readonly TestResult[] | null)[], target: (t: TestResult) => string | null): Map<string, number> {
  const ids = new Map<string, Set<string>>();
  for (const run of all) {
    for (const t of run ?? []) {
      const at = target(t);
      if (at !== null) ids.set(at, (ids.get(at) ?? new Set()).add(t.testId));
    }
  }
  return new Map([...ids].map(([k, v]) => [k, v.size]));
}

/** Runs the files of `tests` once in a sealed run (sandbox.ts Runner.sealed) on a copy of `snap` holding the real keys of
 * `fakedKeys`, and gives back each test's outcome, nothing else. Every test of a file runs with the key, so a file goes only
 * while `budget` holds all of its tests (counted in `all`, the faked runs); the rest are not rerun. `target`: what runs a
 * test's file, relative to the project (null: nothing does). `id`: a test id as the callers' results hold it (setup's are
 * masked). A copy with a link out of it, or a faked file it cannot place safely, reruns nothing. */
export async function rerunWithRealKeys(runner: Runner, snap: string, cfg: ReviewConfig, o: {
  source: KeySource; fakedKeys: readonly string[]; tests: readonly TestResult[]; all: readonly (readonly TestResult[] | null)[];
  target: (t: TestResult) => string | null; budget: KeyReruns; timeout: number; serial?: boolean;
  id?: (testId: string) => string }): Promise<RealOutcomes> {
  const out = new Map<string, string | null>(o.tests.map((t) => [t.testId, null]));
  if (!o.fakedKeys.length || !runner.sealed) return out;
  const per = testsPer(o.all, o.target);
  const targets: string[] = [];
  let count = 0;
  for (const t of o.tests) {
    const at = o.target(t);
    if (at === null || targets.includes(at)) continue;
    const n = Math.max(per.get(at) ?? 1, 1);
    if (count + n > o.budget.left) continue;
    targets.push(at);
    count += n;
  }
  const take = o.tests.filter((t) => targets.includes(o.target(t) ?? ""));
  if (!take.length) return out;
  const copy = copyOf(snap);
  realKeyCopies.add(copy);
  const placed: { at: string; faked: string }[] = [];
  try {
    if (!removeTree(copy)) return out;
    let real: { at: string; real: string; faked: string; mode: number }[];
    try {
      copyTreeInside(snap, copy);
      const found = o.fakedKeys.map((rel) => realText(o.source, copy, rel));
      if (found.includes("unsafe")) return out;
      real = found.filter((x): x is { at: string; real: string; faked: string; mode: number } => !!x && x !== "unsafe");
    } catch {
      return out;
    }
    if (!real.length) return out;
    // Every check passed: each goes in as a new file, never through a link.
    for (const r of real) {
      unlinkSync(r.at);
      placed.push({ at: r.at, faked: r.faked });
      writeNew(r.at, r.real, r.mode);
    }
    o.budget.left -= count;
    const adapter = adapterFor(cfg);
    const report = join(copy, REPORT_DIR, "realkey.xml");
    rmSync(report, { force: true });
    mkdirSync(dirname(report), { recursive: true });
    adapter.reportSetup?.(copy, cfg.runner);
    const flag = o.serial ? serialFlag(cfg, copy) : null;
    const command = adapter.command(cfg.testCommand, targets, `/src/${REPORT_DIR}/realkey.xml`, cfg.runner);
    const run = await runner.sealed(flag ? `${command} ${flag}` : command, o.timeout, copy);
    // Only a regular file in a real folder of the copy: a link the test made there is not followed.
    const text = run.timedOut || !realFolders(copy, `${REPORT_DIR}/realkey.xml`) ? null : readRegular(report, MAX_KEY_FILE);
    if (text === null) return out;
    const parsed = adapter.parseReport(text, cfg.runner, cfg.workdir, (rel) => existsSync(join(copy, cfg.workdir, rel))) ?? [];
    // A file holding more tests than the faked runs showed ran them all with the key.
    o.budget.left = Math.max(0, o.budget.left - Math.max(0, parsed.length - count));
    // Outcomes only: no message, no output and no file of this run goes on. A test the report does not hold is not rerun.
    const id = o.id ?? ((x: string) => x);
    const got = new Map(parsed.map((t) => [id(t.testId), asError(t).outcome]));
    for (const t of take) out.set(t.testId, got.get(t.testId) ?? null);
    return out;
  } finally {
    if (removeTree(copy)) realKeyCopies.delete(copy);
    else {
      // Kept for the exit's sweep and the next run's; its keys are fakes again meanwhile.
      for (const p of placed) {
        try {
          const fd = openSync(p.at, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
          try {
            writeSync(fd, p.faked);
          } finally {
            closeSync(fd);
          }
        } catch {
          // gone or moved: nothing to put back
        }
      }
      process.stderr.write(`arnx: could not remove ${copy}; its key files hold fakes again\n`);
    }
  }
}
