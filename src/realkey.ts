// A test that failed or skipped in a sandbox holding a fake of a private key (secrets.ts fakeKeys) runs once more with the
// real key: in a throwaway copy of the snapshot, the key read from the file on the host only for that run, no network, its
// output never read. Only each test's outcome comes back; the copy is removed before anything else reads it. A test that
// goes otherwise with the real key failed for the fake (diagnose.ts markUnproven); one that fails again stands.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { adapterFor } from "./adapters";
import type { TestResult } from "./adapters/types";
import type { ReviewConfig } from "./config";
import { asError, serialFlag } from "./outcomes";
import { REPORT_DIR, realKeyCopies, type Runner } from "./sandbox";
import { withRealKeys } from "./secrets";

/** Most tests rerun with the real key in one review (in `arnx check`, one check; in setup, one run of the suite). Past it, a
 * failure beside a fake is not rerun: it reads as unproven, never a finding, and a skip stays a skip. */
export const KEY_RERUN_MOST = 20;
/** What is left of that number. */
export interface KeyReruns { left: number }
export const keyReruns = (): KeyReruns => ({ left: KEY_RERUN_MOST });

/** What the rerun gave a test, by test id: its outcome; ABSENT when its file ran and it did not; null when it was not rerun
 * (past KEY_RERUN_MOST, out of time, no report, or no run can reach the real key). */
export type RealOutcomes = ReadonlyMap<string, string | null>;
export const ABSENT = "absent";

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

/** The copy's `rel` with its real key in place, a new file (no link of it sees the write); false when it cannot be. */
function placeRealKey(source: KeySource, copy: string, rel: string): boolean {
  const at = join(copy, rel);
  if (!existsSync(at)) return false;
  const own = ownText(source, rel);
  const real = own === null ? null : withRealKeys(own, readFileSync(at, "utf8"));
  if (real === null) return false;
  const mode = statSync(at).mode & 0o777;
  rmSync(at, { force: true });
  writeFileSync(at, real, { mode });
  return true;
}

/** Runs the files of `tests` (up to what `budget` has left) once in a sealed run (sandbox.ts Runner.sealed) on a copy of `snap`
 * holding the real keys of `fakedKeys`, and gives back each test's outcome, nothing else. `target`: what runs a test's file,
 * relative to the project (null: nothing does). `id`: a test id as the callers' results hold it (setup's are masked). */
export async function rerunWithRealKeys(runner: Runner, snap: string, cfg: ReviewConfig, o: {
  source: KeySource; fakedKeys: readonly string[]; tests: readonly TestResult[]; target: (t: TestResult) => string | null;
  budget: KeyReruns; timeout: number; serial?: boolean; id?: (testId: string) => string }): Promise<RealOutcomes> {
  const out = new Map<string, string | null>(o.tests.map((t) => [t.testId, null]));
  if (!o.fakedKeys.length || !runner.sealed) return out;
  const take = o.tests.filter((t) => o.target(t) !== null).slice(0, Math.max(0, o.budget.left));
  if (!take.length) return out;
  o.budget.left -= take.length;
  const targets = [...new Set(take.map((t) => o.target(t)!))];
  const copy = `${snap}.realkey`;
  realKeyCopies.add(copy);
  try {
    rmSync(copy, { recursive: true, force: true });
    cpSync(snap, copy, { recursive: true, verbatimSymlinks: true });
    let placed = 0;
    for (const rel of o.fakedKeys) if (placeRealKey(o.source, copy, rel)) placed++;
    if (!placed) return out;
    const adapter = adapterFor(cfg);
    const report = join(copy, REPORT_DIR, "realkey.xml");
    rmSync(report, { force: true });
    mkdirSync(dirname(report), { recursive: true });
    adapter.reportSetup?.(copy, cfg.runner);
    const flag = o.serial ? serialFlag(cfg, copy) : null;
    const command = adapter.command(cfg.testCommand, targets, `/src/${REPORT_DIR}/realkey.xml`, cfg.runner);
    const run = await runner.sealed(flag ? `${command} ${flag}` : command, o.timeout, copy);
    if (run.timedOut || !existsSync(report)) return out;
    const parsed = adapter.parseReport(readFileSync(report, "utf8"), cfg.runner, cfg.workdir,
      (rel) => existsSync(join(copy, cfg.workdir, rel))) ?? [];
    // Outcomes only: no message, no output and no file of this run goes on.
    const id = o.id ?? ((x: string) => x);
    const got = new Map(parsed.map((t) => [id(t.testId), asError(t).outcome]));
    const ran = new Set(parsed.map((t) => id(t.fileAttr)));
    for (const t of take) out.set(t.testId, got.get(t.testId) ?? (ran.has(t.fileAttr) ? ABSENT : null));
    return out;
  } finally {
    rmSync(copy, { recursive: true, force: true });
    realKeyCopies.delete(copy);
  }
}
