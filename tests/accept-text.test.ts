// The text `arnx accept` prints: what was accepted, the accepted tests run on the code as it is now, and what next.
// No model, Docker or network: a fake sandbox reports the test results.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { type Group, save } from "../src/report";
import type { SessionFactory } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const DIR = "tests/arnx/r20261011_a1b2c3";
const IDS = ["F1", "F2", "F3", "F4"];
const group = (findings: string[], title: string): Group =>
  ({ findings, title, input: "", actual: "", expected: "", consequence: "" });

/** The fake sandbox reports these results, whatever is run. */
const sessions = (cases: [string, string, string, string][]): SessionFactory => async (_c, snap, _l, body) =>
  body(new FakeSession(snap, () => [junitXml(cases), "", false]));

/** A repository with an approved environment and a review of four findings in two issues, all pre-filled real. */
async function reviewed(o: { cases?: [string, string, string, string][]; questions?: string[];
  real?: boolean } = {}): Promise<{ repo: string; rdir: string; cli: Cli }> {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, check: true, checkSessions: sessions(o.cases ?? []),
    env: { ANTHROPIC_API_KEY: "a" } });
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
    group(["F3", "F4"], "Bulk")], questions: o.questions ?? [], questionProjects: (o.questions ?? []).map(() => "shop"),
  projects: ["main"], writeDir: "tests/g" }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"),
    IDS.map((id) => `def test_${id}():\n    assert False\n`).join("\n"));
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  writeFileSync(join(rdir, "review.md"), o.real === false ? blankMarks(md) : md);
  return { repo, rdir, cli };
}

const OWNER: [string, string, string, string][] = [
  [`${DIR}/test_r20261011_a1b2c3.py`, "test_s1_discount_over_100_rejected", "failed", "Failed: DID NOT RAISE ValueError\ntrace"],
  [`${DIR}/test_r20261011_a1b2c3.py`, "test_s2_discount_over_100_rejected_float", "failed", "Failed: DID NOT RAISE ValueError"],
  [`${DIR}/test_r20261011_a1b2c3.py`, "test_s3_bulk_10_discounted", "failed", "assert 50.0 == 45.0"],
  [`${DIR}/test_r20261011_a1b2c3.py`, "test_s4_bulk_10_discounted_unit10", "failed", "assert 100.0 == 90.0"],
  ...[1, 2, 3, 4, 5].map((i): [string, string, string, string] => [`${DIR}/test_r20261011_a1b2c3.py`, `test_ok${i}`, "passed", ""]),
];

test("accept: the owner's example (one file, all marks pre-filled, no questions)", async () => {
  const { cli } = await reviewed({ cases: OWNER });
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(cli.stdout.slice(cli.stdout.indexOf("✓ Accepted"))).toBe([
    "✓ Accepted 4 tests from 2 issues (4 findings)",
    "  4 marks were pre-filled (not reviewed in triage)",
    `  kept: .arnx/tests/${DIR}/test_r20261011_a1b2c3.py`,
    "",
    "4 fail, as expected until the bugs are fixed; 5 pass:",
    "  ✗ test_s1_discount_over_100_rejected  Failed: DID NOT RAISE ValueError",
    "  ✗ test_s2_discount_over_100_rejected_float  Failed: DID NOT RAISE ValueError",
    "  ✗ test_s3_bulk_10_discounted  assert 50.0 == 45.0",
    "  ✗ test_s4_bulk_10_discounted_unit10  assert 100.0 == 90.0",
    "",
    `Fix prompt: .arnx/reviews/${RID}/fix-prompt.md`,
    "Next: give the fix prompt to your coding agent (arnx prompt prints it)",
    "Then: arnx check",
    "Commit the fix and the accepted tests together.",
  ].join("\n"));
  expect(cli.stderr).toContain("shop: running the accepted tests");
  expect(cli.stderr).not.toContain(" real, ");
});

test("accept: failing tests in several files are listed under each file once", async () => {
  const { cli } = await reviewed({ cases: [
    [`${DIR}/test_r20261011_a1b2c3.py`, "test_s1", "failed", "assert 1 == 2"],
    [`${DIR}/test_bulk.py`, "test_s3", "failed", "assert 3 == 4"],
    [`${DIR}/test_r20261011_a1b2c3.py`, "test_s2", "failed", "assert 5 == 6"],
    [`${DIR}/test_bulk.py`, "test_ok", "passed", ""],
  ] });
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(cli.stdout).toContain([
    "",
    "3 fail, as expected until the bugs are fixed; 1 pass:",
    `  ${DIR}/test_r20261011_a1b2c3.py:`,
    "    ✗ test_s1  assert 1 == 2",
    "    ✗ test_s2  assert 5 == 6",
    `  ${DIR}/test_bulk.py:`,
    "    ✗ test_s3  assert 3 == 4",
    "",
  ].join("\n"));
});

test("accept: one failing test is singular", async () => {
  const { cli } = await reviewed({ cases: [[`${DIR}/test_r20261011_a1b2c3.py`, "test_s1", "failed", "boom"]] });
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(cli.stdout).toContain("\n1 fails, as expected until the bugs are fixed; 0 pass:\n  ✗ test_s1  boom\n");
});

test("accept: questions skipped with --no-answers, or left unanswered, are counted once", async () => {
  const { cli, repo } = await reviewed({ questions: ["Does it round?", "Is 0 allowed?"], cases: OWNER });
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(cli.stdout).toContain("✓ Accepted 4 tests from 2 issues (4 findings)\n" +
    "  4 marks were pre-filled (not reviewed in triage)\n  2 questions not answered (--no-answers)\n  kept: ");
  await cli.run("consent", "--yes");
  const again = new Cli({ ...cli.deps, cwd: repo });
  expect(await again.run("accept", "--again")).toBe(0); // nothing answered: no model is called
  expect(again.stdout).toContain("\n  2 questions not answered\n  kept: ");
  expect(again.stdout).not.toContain("--no-answers");
});

test("accept: all accepted tests pass: nothing to fix, commit them", async () => {
  const { cli } = await reviewed({ cases: [[`${DIR}/test_r20261011_a1b2c3.py`, "test_s1", "passed", ""],
    [`${DIR}/test_r20261011_a1b2c3.py`, "test_s2", "passed", ""]] });
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(cli.stdout.slice(cli.stdout.indexOf(`  kept: `))).toBe([
    `  kept: .arnx/tests/${DIR}/test_r20261011_a1b2c3.py`,
    "",
    "All 2 accepted tests pass: the bugs they prove look fixed already.",
    "",
    "Next: commit the fix and the accepted tests together",
  ].join("\n"));
});

test("accept: nothing marked real keeps nothing, and nothing is next", async () => {
  const { repo } = await reviewed({ real: false });
  const cli = new Cli({ cwd: repo, check: true, checkSessions: sessions([]) });
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(cli.stdout).toBe("No findings marked real; nothing kept.");
});

test("accept --no-check: the accepted tests fail until the fix, not run", async () => {
  const { cli } = await reviewed({ cases: OWNER });
  expect(await cli.run("accept", "--no-answers", "--no-check")).toBe(0);
  expect(cli.stdout.slice(cli.stdout.indexOf(`  kept: `))).toBe([
    `  kept: .arnx/tests/${DIR}/test_r20261011_a1b2c3.py`,
    "",
    "4 accepted tests fail until the fix (not run: --no-check).",
    "",
    `Fix prompt: .arnx/reviews/${RID}/fix-prompt.md`,
    "Next: give the fix prompt to your coding agent (arnx prompt prints it)",
    "Then: arnx check",
    "Commit the fix and the accepted tests together.",
  ].join("\n"));
});
