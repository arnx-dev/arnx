// Accepted tests run in the project's own runner, in one process with its other tests, and can break them (an
// accepted conftest that swaps a module in sys.modules for the whole pytest run). arnx check runs only the accepted
// tests, so before accept records anything, each project's whole suite runs with the kept files in; tests outside them
// that fail run once more without them, and those that pass then are broken by the accepted tests.
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { snapshot } from "./change";
import { loadReviewFile, reviewConfigPath, secretPinsOf } from "./config";
import { runTests, type TestResult } from "./outcomes";
import type { Say } from "./progress";
import { sayingDocker, type SessionFactory } from "./sandbox";
import { SUITE_TIMEOUT } from "./setup";
import { dockerSession } from "./testround";

/** A project whose own tests (`broken`) fail with the accepted `files` in and pass without them. */
export interface SuiteBreak { project: string; files: string[]; broken: TestResult[] }

const failing = (t: TestResult) => t.outcome === "failed" || t.outcome === "error";

/** Each project's tests outside `files` (repository-relative: the kept files) that the files break. A suite that gives
 * no report proves nothing either way: its project is left out. */
export async function suiteBreaks(repo: string, files: string[],
  o: { sessionFactory?: SessionFactory; progress?: Say } = {}): Promise<SuiteBreak[]> {
  // A review from before projects, in a repository with no review.yaml, has no suite arnx knows how to run.
  if (!existsSync(reviewConfigPath(repo))) return [];
  const file = loadReviewFile(repo, { requireApproved: false });
  const out: SuiteBreak[] = [];
  for (const cfg of file.projects) {
    const own = files.filter((f) => cfg.workdir === "." || f.startsWith(`${cfg.workdir}/`));
    if (!own.length) continue;
    o.progress?.(`${cfg.name}: running its own tests with the accepted ones`);
    const tmp = mkdtempSync(join(tmpdir(), "arnx-suite-"));
    try {
      const snap = join(tmp, "repo");
      snapshot(repo, null, snap, secretPinsOf(file.raw), { untracked: true });
      const inRepo = (t: TestResult) => posix.normalize(posix.join(cfg.workdir, t.testId.split("::")[0]!));
      const broken = await sayingDocker(o.progress, () => (o.sessionFactory ?? dockerSession)(cfg, snap,
        join(repo, ".arnx", "run", `suite-${cfg.name}-build.log`), async (session) => {
          const [, with_] = runTests(session, snap, cfg, [], "suite-with.xml", SUITE_TIMEOUT);
          const red = (with_ ?? []).filter((t) => failing(t) && !own.includes(inRepo(t)));
          if (!red.length) return [];
          for (const f of own) rmSync(join(snap, f), { force: true });
          const [, without] = runTests(session, snap, cfg, [], "suite-without.xml", SUITE_TIMEOUT);
          const passed = new Set((without ?? []).filter((t) => t.outcome === "passed").map((t) => t.testId));
          return red.filter((t) => passed.has(t.testId));
        }));
      if (broken.length) out.push({ project: cfg.name, files: own, broken });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
  return out;
}
