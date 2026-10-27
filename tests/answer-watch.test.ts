// An answer's test can ask for the opposite of an accepted test. At accept, each answer test that fails on the code is
// recorded with the accepted tests of its project that pass; when a later check finds the answer's test passing and
// one of those failing, it names the pair (one line, `may_contradict` in --json), and the exit code is unchanged.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AnswerOutcome, accept } from "../src/accept";
import { ANSWER_WATCH, contradictionLines, mayContradict, type ProjectCheck, recordAnswerWatch } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { save } from "../src/report";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import type { TestResult } from "../src/outcomes";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const WD = "tests/arnx_generated";
const DIR = "tests/arnx/r20261011_a1b2c3";
const F1 = `${DIR}/test_mint_for_any_account.py::test_mint`;
const Q1 = `${DIR}/answers/test_unknown.py::test_refuses_unknown`;
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-11T00:00:00Z" };

const result = (passed: string[], failed: string[]): ProjectCheck => ({ project: "main", workdir: ".", files: [],
  passed, skipped: 0, noReport: false, accepted: [...passed, ...failed],
  failed: failed.map((testId): TestResult => ({ testId, fileAttr: "", name: "", outcome: "failed", message: "x" })) });

/** A review with F1 marked real and Q1 answered; the answer round's test fails on the code. */
async function accepted(): Promise<{ repo: string; outcome: Awaited<ReturnType<typeof accept>> }> {
  const repo = gitRepo(tmp());
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(sampleReview({ id: RID, findings: [finding("F1", `${WD}/test_mint.py::test_mint`, "test_mint",
    `${WD}/test_mint.py`, "assert False", "mint for any account", "confirmed")], groups: [],
  questions: ["Should mint refuse unknown accounts?"], questionProjects: ["main"], writeDir: WD }), rdir, "d");
  mkdirSync(join(rdir, "tests", WD), { recursive: true });
  writeFileSync(join(rdir, "tests", WD, "test_mint.py"), "def test_mint():\n    assert False\n");
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8"))
    .replace("Mark: [ ] real", "Mark: [x] real").replace("Answer:", "Answer: Yes."));
  const file = `${WD}/answers/test_unknown.py`;
  const runner = async (qid: string): Promise<AnswerOutcome> => ({ qid,
    files: { [file]: "def test_refuses_unknown():\n    assert False\n" }, keep: { [file]: new Set(["test_refuses_unknown"]) },
    skip: {}, disagree: [`${file}::test_refuses_unknown`], costUsd: 0, stop: "end_turn", base: `${WD}/answers` });
  return { repo, outcome: await accept(repo, rdir, SETTINGS, { answerRunner: runner }) };
}

test("accept records what passes beside a failing answer test; check names a pair that swapped", async () => {
  const { repo, outcome } = await accepted();
  const disagree = Object.fromEntries(outcome.answers.map((a) => [a.qid, a.disagree]));
  recordAnswerWatch(repo, RID, disagree, outcome.moved, [result([F1], [Q1])]);
  expect(JSON.parse(readFileSync(join(repo, ANSWER_WATCH), "utf8"))).toEqual({ schema_version: 1, answers: [
    { review: RID, answer: "Q1", test: Q1, passing: [{ id: "F1", review: RID, test: F1 }] }] });

  const pairs = mayContradict(repo, [result([Q1], [F1])]);
  expect(pairs).toEqual([{ answer: "Q1", accepted: "F1", review: RID, accepted_review: RID, answer_test: Q1,
    accepted_test: F1 }]);
  expect(contradictionLines(pairs)).toEqual(["Q1's test now passes and F1's fails: they may contradict"]);
  // Both pass (the fix did both), or the answer's test still fails: nothing to say.
  expect(mayContradict(repo, [result([Q1, F1], [])])).toEqual([]);
  expect(mayContradict(repo, [result([], [Q1, F1])])).toEqual([]);
  // Another review's accepted test is named with its review.
  expect(contradictionLines([{ ...pairs[0]!, accepted: "F3", accepted_review: "20261009-0f0f0f" }]))
    .toEqual(["Q1's test now passes and F3's (review 20261009-0f0f0f) fails: they may contradict"]);

  // Accepted again with nothing passing beside it: the review's entries go, and with them the file.
  recordAnswerWatch(repo, RID, disagree, outcome.moved, [result([], [Q1, F1])]);
  expect(existsSync(join(repo, ANSWER_WATCH))).toBe(false);
});

test("check prints the pair before its Next line and in --json; the exit code is unchanged", async () => {
  const repo = gitRepo(tmp());
  const run = (outcome: string): SessionFactory => async (_c, snap, _l, body) =>
    body(new FakeSession(snap, () => [junitXml([[F1.split("::")[0]!, "test_mint", outcome, "assert False"],
      [Q1.split("::")[0]!, "test_refuses_unknown", "passed", ""]]), "", false]));
  const cli = (outcome: string) => new Cli({ cwd: repo, checkSessions: run(outcome) });
  await cli("failed").run("init");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile("version: 1\nprojects:\n  app:\n    root: .\n" +
    "    image: python:3.12-slim\n    test_command: python -m pytest {targets}\n"), "Dev", "2026-10-12"));
  for (const id of [F1, Q1]) {
    const path = join(repo, ".arnx", "tests", id.split("::")[0]!);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "def test():\n    pass\n");
  }
  writeFileSync(join(repo, ANSWER_WATCH), JSON.stringify({ schema_version: 1, answers: [
    { review: RID, answer: "Q1", test: Q1, passing: [{ id: "F1", review: RID, test: F1 }] }] }));
  commit(repo, "accepted");

  const text = cli("failed");
  expect(await text.run("check")).toBe(1);
  const lines = text.stdout.split("\n");
  expect(lines.slice(-2)).toEqual(["Q1's test now passes and F1's fails: they may contradict", "Next: arnx check"]);
  const json = cli("failed");
  expect(await json.run("check", "--json")).toBe(1);
  expect(JSON.parse(json.stdout).may_contradict).toEqual([{ answer: "Q1", accepted: "F1", review: RID,
    accepted_review: RID, answer_test: Q1, accepted_test: F1 }]);

  const fine = cli("passed");
  expect(await fine.run("check", "--json")).toBe(0);
  expect(JSON.parse(fine.stdout).may_contradict).toEqual([]);
});
