// The text `arnx check` prints: accepted tests (behind findings marked real) told apart from the other tests the review
// wrote into the same files, what to do next, and why nothing ran when accepted tests changed or gave no report.
// No model, Docker or network: a fake sandbox reports the test results.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type ChangedTest, changedSummary, checkSummary, type ProjectCheck } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { type Group, save } from "../src/report";
import type { SessionFactory } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const KEPT = "tests/arnx/r20261011_a1b2c3/test_r20261011_a1b2c3.py";
const IDS = ["F1", "F2", "F3", "F4"];
const group = (findings: string[], title: string): Group =>
  ({ findings, title, input: "", actual: "", expected: "", consequence: "" });
type Case = [string, string, string, string];

/** The fake sandbox reports `cases`, or no report (timed out) when null. */
const sessions = (cases: () => Case[] | null): SessionFactory => async (_c, snap, _l, body) =>
  body(new FakeSession(snap, () => {
    const c = cases();
    return c ? [junitXml(c), "", false] : [null, "collecting ...\nstill running", true];
  }));

/** A repository where review RID was accepted: four findings in two issues, all marked real (pre-filled), kept in
 * one file. The CLI's sandbox reports whatever `cases` holds when check runs. */
async function accepted(): Promise<{ repo: string; cli: Cli; cases: { now: Case[] | null } }> {
  const repo = gitRepo(tmp());
  const cases: { now: Case[] | null } = { now: [] };
  const cli = new Cli({ cwd: repo, checkSessions: sessions(() => cases.now), env: { ANTHROPIC_API_KEY: "a" } });
  await cli.run("init");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  shop:
    root: .
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(sampleReview({ id: RID, findings: IDS.map((id) => finding(id, `tests/g/test_a.py::test_${id}`, `test_${id}`,
    "tests/g/test_a.py", "x", "discount", "confirmed")), groups: [group(["F1", "F2"], "Over 100"),
    group(["F3", "F4"], "Bulk")], questions: [], projects: ["main"], writeDir: "tests/g" }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"),
    [...IDS, "ok"].map((id) => `def test_${id}():\n    assert False\n`).join("\n"));
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(existsSync(join(repo, KEPT))).toBe(true);
  cli.out.length = 0;
  return { repo, cli, cases };
}

const ACCEPTED: Case[] = [
  [KEPT, "test_F1", "failed", "Failed: DID NOT RAISE ValueError\ntrace"],
  [KEPT, "test_F2", "failed", "Failed: DID NOT RAISE ValueError"],
  [KEPT, "test_F3", "failed", "assert 50.0 == 45.0"],
  [KEPT, "test_F4", "failed", "assert 100.0 == 90.0"],
];
const OTHERS = (n: number): Case[] => [1, 2, 3, 4, 5].slice(0, n).map((i) => [KEPT, `test_other${i}`, "passed", ""]);
const pass = (cs: Case[]): Case[] => cs.map(([f, n]) => [f, n, "passed", ""]);

test("check: accepted tests still failing, the other tests in their file passing", async () => {
  const { cli, cases } = await accepted();
  cases.now = [...ACCEPTED, ...OTHERS(5)];
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toBe([
    "✗ 4 accepted tests still fail (bugs not fixed yet)",
    "✓ 5 other tests in the accepted files pass",
    "  ✗ test_F1  Failed: DID NOT RAISE ValueError",
    "  ✗ test_F2  Failed: DID NOT RAISE ValueError",
    "  ✗ test_F3  assert 50.0 == 45.0",
    "  ✗ test_F4  assert 100.0 == 90.0",
    "Fix the code, not the accepted tests. A real bug whose test is wrong: mark it rewrite in review.md with a " +
      "`Rewrite:` line saying why (noise only when there is no bug), then `arnx accept --again 20261011-a1b2c3`.",
    "Next: arnx check",
  ].join("\n"));
  cli.out.length = 0;
  expect(await cli.run("check", "--json", "--quiet")).toBe(1);
  const p = JSON.parse(cli.stdout).projects[0];
  expect(p.accepted).toEqual(ACCEPTED.map(([f, n]) => `${f}::${n}`));
  expect(p.failed.map((t: { accepted: boolean }) => t.accepted)).toEqual([true, true, true, true]);
});

test("check: other tests in the accepted files that fail are their own line, not called expected", async () => {
  const { cli, cases } = await accepted();
  cases.now = [ACCEPTED[0]!, ...pass(ACCEPTED.slice(1)), ...OTHERS(3), [KEPT, "test_other4", "failed", "assert 1 == 2"],
    [KEPT, "test_other5", "failed", "KeyError: 'x'"]];
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toBe([
    "✗ 1 accepted test still fails (bug not fixed yet)",
    "✓ 3 accepted tests pass",
    "✓ 3 other tests in the accepted files pass",
    "  ✗ test_F1  Failed: DID NOT RAISE ValueError",
    "✗ 2 other tests in the accepted files fail",
    "  ✗ test_other4  assert 1 == 2",
    "  ✗ test_other5  KeyError: 'x'",
    "Fix the code, not the accepted tests. A real bug whose test is wrong: mark it rewrite in review.md with a " +
      "`Rewrite:` line saying why (noise only when there is no bug), then `arnx accept --again 20261011-a1b2c3`.",
    "The 2 other tests that fail are not findings: marks do not cover them. Fix the code, or fix or delete them in " +
      "the file (then `arnx accept --keep-edits`).",
    "Next: arnx check",
  ].join("\n"));
  cli.out.length = 0;
  cases.now = [...pass(ACCEPTED), [KEPT, "test_other1", "failed", "assert 1 == 2"]];
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toBe([
    "✓ All 4 accepted tests pass",
    "✗ 1 other test in the accepted files fails",
    "  ✗ test_other1  assert 1 == 2",
    "The 1 other test that fails is not a finding: marks do not cover it. Fix the code, or fix or delete it in the " +
      "file (then `arnx accept --keep-edits`).",
    "Next: arnx check",
  ].join("\n"));
});

test("check: all pass", async () => {
  const { cli, cases } = await accepted();
  cases.now = [...pass(ACCEPTED), ...OTHERS(5)];
  expect(await cli.run("check")).toBe(0);
  expect(cli.stdout).toBe([
    "✓ All 4 accepted tests pass (5 other tests in their files too)",
    "✓ Accepted tests unchanged since arnx accept",
    "Commit the fixes, the accepted tests and .arnx/accepted-tests.json together.",
  ].join("\n"));
});

test("check: an accepted test file that is committed can be restored from git too", async () => {
  const { repo, cli } = await accepted();
  commit(repo, "accepted tests");
  writeFileSync(join(repo, KEPT), "def test_F1():\n    assert True\n");
  expect(await cli.run("check")).toBe(4);
  expect(cli.stdout).toBe([
    "✗ 1 accepted test file changed since arnx accept; nothing ran:",
    `  modified ${KEPT}`,
    `To restore it: arnx accept --again ${RID} (rewrites it from the review; your edits are lost), or git checkout -- ` +
      KEPT,
    "To keep your edit: arnx accept --keep-edits (records it as the new accepted version; it does not re-prove the bug)",
  ].join("\n"));
});

test("check: a deleted accepted test file", async () => {
  const { repo, cli } = await accepted();
  rmSync(join(repo, KEPT));
  expect(await cli.run("check")).toBe(4);
  expect(cli.stdout).toBe([
    "✗ 1 accepted test file deleted since arnx accept; nothing ran:",
    `  deleted  ${KEPT}`,
    `To restore it: arnx accept --again ${RID} (rewrites it from the review; your edits are lost)`,
    "To keep it deleted: arnx accept --keep-edits (drops it from the accepted tests)",
  ].join("\n"));
});

test("check: files of several reviews changed: one restore line per review", () => {
  const repo = gitRepo(tmp());
  const changed: ChangedTest[] = [{ path: "tests/arnx/r1/test_a.py", review: "r1", change: "modified" },
    { path: "tests/arnx/r1/test_b.py", review: "r1", change: "deleted" },
    { path: "tests/arnx/r2/test_c.py", review: "r2", change: "modified" }];
  expect(changedSummary(changed, repo)).toBe([
    "✗ 3 accepted test files changed since arnx accept; nothing ran:",
    "  modified tests/arnx/r1/test_a.py",
    "  deleted  tests/arnx/r1/test_b.py",
    "  modified tests/arnx/r2/test_c.py",
    "To restore the files of review r1: arnx accept --again r1 (rewrites them from the review; your edits are lost)",
    "To restore the file of review r2: arnx accept --again r2 (rewrites it from the review; your edits are lost)",
    "To keep your edits: arnx accept --keep-edits (records them as the new accepted version; it does not re-prove the " +
      "bugs)",
  ].join("\n"));
});

test("check: no report names the reason and the log it wrote (exit 2)", async () => {
  const { repo, cli, cases } = await accepted();
  cases.now = null;
  expect(await cli.run("check")).toBe(2);
  expect(cli.stdout).toBe([
    "✗ shop: check incomplete: the tests timed out after 900 s (log: .arnx/run/check-shop.log)",
    "The accepted tests could not be verified: a timeout is neither a fix nor a bug.",
  ].join("\n"));
  expect(readFileSync(join(repo, ".arnx/run/check-shop.log"), "utf8")).toBe("collecting ...\nstill running");
  cli.out.length = 0;
  expect(await cli.run("check", "--json", "--quiet")).toBe(2);
  const p = JSON.parse(cli.stdout).projects[0];
  expect([p.no_report, p.no_report_reason, p.log]).toEqual([true, "the tests timed out after 900 s",
    ".arnx/run/check-shop.log"]);
  cases.now = [...pass(ACCEPTED)];
  expect(await cli.run("check")).toBe(0);
  expect(existsSync(join(repo, ".arnx/run/check-shop.log"))).toBe(false); // a run that reported leaves no stale log
});

test("check: nothing accepted yet (exit 3)", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  shop:
    root: .
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(3);
  expect(cli.stdout).toBe("No accepted tests yet: arnx accept keeps them after a review.");
});

test("check: failing tests in several files and projects: each file once, under its project", () => {
  const t = (testId: string, message: string) => ({ testId, fileAttr: "", name: testId.split("::")[1]!,
    outcome: "failed" as const, message });
  const results: ProjectCheck[] = [
    { project: "api", files: ["api/tests/arnx/r1/test_a.py", "api/tests/arnx/r1/test_b.py"], passed: [], skipped: 0,
      noReport: false, failed: [t("tests/arnx/r1/test_a.py::test_s1", "assert 1 == 2"),
        t("tests/arnx/r1/test_b.py::test_s2", "assert 3 == 4")],
      accepted: ["tests/arnx/r1/test_a.py::test_s1", "tests/arnx/r1/test_b.py::test_s2"] },
    { project: "web", files: ["web/tests/arnx/r1/test_c.py"], passed: [], skipped: 0, noReport: false,
      failed: [t("tests/arnx/r1/test_c.py::test_s3", "boom")], accepted: ["tests/arnx/r1/test_c.py::test_s3"] },
  ];
  expect(checkSummary(results)).toEqual([[
    "✗ 3 accepted tests still fail (bugs not fixed yet)",
    "  api: tests/arnx/r1/test_a.py:",
    "    ✗ test_s1  assert 1 == 2",
    "  api: tests/arnx/r1/test_b.py:",
    "    ✗ test_s2  assert 3 == 4",
    "  web: tests/arnx/r1/test_c.py:",
    "    ✗ test_s3  boom",
    "Fix the code, not the accepted tests. A real bug whose test is wrong: mark it rewrite in review.md with a " +
      "`Rewrite:` line saying why (noise only when there is no bug), then accept the review that kept it again (`arnx accept --again` with its id; `ls .arnx/reviews` lists them).",
    "Next: arnx check",
  ].join("\n"), 1]);
});

// --- which tests are accepted: recorded by accept in .arnx/accepted-tests.json --------------------------------------

const LABELLED = [
  "✗ 4 accepted tests still fail (bugs not fixed yet)",
  "✓ 5 other tests in the accepted files pass",
];
const record = (repo: string) => JSON.parse(readFileSync(join(repo, ".arnx", "accepted-tests.json"), "utf8"));

test("accept records the accepted tests of each file it keeps", async () => {
  const { repo } = await accepted();
  expect(record(repo).files[KEPT].tests).toEqual(["test_F1", "test_F2", "test_F3", "test_F4"]);
});

test("check on a fresh clone (no .arnx/reviews/) tells accepted tests from the others by the record", async () => {
  const { repo, cli, cases } = await accepted();
  rmSync(join(repo, ".arnx", "reviews"), { recursive: true, force: true });
  cases.now = [...ACCEPTED, ...OTHERS(5)];
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout.split("\n").slice(0, 2)).toEqual(LABELLED);
});

test("a record without the accepted tests (an older arnx): from the reviews, else every test counts", async () => {
  const { repo, cli, cases } = await accepted();
  const rec = record(repo);
  delete rec.files[KEPT].tests;
  writeFileSync(join(repo, ".arnx", "accepted-tests.json"), JSON.stringify(rec, null, 2) + "\n");
  cases.now = [...ACCEPTED, ...OTHERS(5)];
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout.split("\n").slice(0, 2)).toEqual(LABELLED);
  rmSync(join(repo, ".arnx", "reviews"), { recursive: true, force: true });
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout.split("\n").slice(0, 2)).toEqual(["✗ 4 accepted tests still fail (bugs not fixed yet)",
    "✓ 5 accepted tests pass"]);
});

test("check: the hint names the reviews whose accepted tests fail; other tests that fail are not covered by marks", () => {
  const t = (testId: string, message: string) => ({ testId, fileAttr: "", name: testId.split("::")[1]!,
    outcome: "failed" as const, message });
  const results: ProjectCheck[] = [{ project: "api", files: ["tests/arnx/r1/test_a.py", "tests/arnx/r2/test_b.py"],
    passed: [], skipped: 0, noReport: false,
    failed: [t("tests/arnx/r1/test_a.py::test_s1", "assert 1 == 2"), t("tests/arnx/r2/test_b.py::test_s2", "boom"),
      t("tests/arnx/r2/test_b.py::test_x", "KeyError")],
    accepted: ["tests/arnx/r1/test_a.py::test_s1", "tests/arnx/r2/test_b.py::test_s2"],
    reviews: { "tests/arnx/r1/test_a.py::test_s1": "20261011-aaaaaa", "tests/arnx/r2/test_b.py::test_s2": "20261012-bbbbbb",
      "tests/arnx/r2/test_b.py::test_x": "20261012-bbbbbb" } }];
  const [text, code] = checkSummary(results);
  expect(code).toBe(1);
  expect(text.split("\n").slice(-3)).toEqual([
    "Fix the code, not the accepted tests. A real bug whose test is wrong: mark it rewrite in review.md with a " +
      "`Rewrite:` line saying why (noise only when there is no bug), then `arnx accept --again 20261011-aaaaaa` " +
      "(and `20261012-bbbbbb`).",
    "The 1 other test that fails is not a finding: marks do not cover it. Fix the code, or fix or delete it in the " +
      "file (then `arnx accept --keep-edits`).",
    "Next: arnx check"]);
  // Only other tests fail: no marks hint at all.
  const others = checkSummary([{ ...results[0]!, failed: [results[0]!.failed[2]!, t("tests/arnx/r2/test_b.py::test_y", "x")],
    passed: ["tests/arnx/r1/test_a.py::test_s1"] }])[0];
  expect(others).not.toContain("rewrite");
  expect(others.split("\n").slice(-2)).toEqual([
    "The 2 other tests that fail are not findings: marks do not cover them. Fix the code, or fix or delete them in " +
      "the file (then `arnx accept --keep-edits`).", "Next: arnx check"]);
});
