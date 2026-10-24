// Tests that are wrong about a real bug: a finding's test set aside when the owner's answer to the question it assumed
// has a test of its own, and the rewrite mark (the bug is real, the test is wrong), whose reason becomes a new test
// through the answer round. No model or Docker: a fake answer runner, a fake sandbox, saved outcomes.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AnswerOutcome, accept, precisionOf, REWRITE_PREFIX } from "../src/accept";
import { ACCEPTED_RECORD } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { type Finding, type Group, save } from "../src/report";
import { defaultSettings } from "../src/settings";
import { Cli } from "./helpers/cli";
import { commit, gitRepo } from "./helpers/gitutil";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const WD = "tests/arnx_generated";
const GEN = `${WD}/test_add.py`;
const DEST = ".arnx/tests/tests/arnx/r20261011_a1b2c3";
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-11T00:00:00Z" };
const SRC = "def test_a():\n    assert False\n\ndef test_b():\n    assert False\n";

/** F1 confirmed; F2 confirmed but assuming an answer to Q1; one question. `groups`: one issue holding both. */
function savedReview(repo: string, groups: Group[] = []): string {
  const rdir = join(repo, ".arnx", "reviews", RID);
  const f2: Finding = { ...finding("F2", `${GEN}::test_b`, "test_b", GEN, "assert 4 == 5", "add drops one", "confirmed"),
    dependsOn: "Q1" };
  save(sampleReview({ id: RID, writeDir: WD, flaky: [], groups, questions: ["Should add round?"],
    findings: [finding("F1", `${GEN}::test_a`, "test_a", GEN, "assert -1 == 5", "add subtracts", "confirmed"), f2] }),
  rdir, "diff --git a/app.py b/app.py\n");
  mkdirSync(join(rdir, "tests", WD), { recursive: true });
  writeFileSync(join(rdir, "tests", GEN), SRC);
  return rdir;
}

const ISSUE: Group = { findings: ["F1", "F2"], title: "add subtracts", input: "", actual: "add(2, 3) is -1",
  expected: "add(2, 3) is 5", consequence: "" };

const md = (rdir: string) => readFileSync(join(rdir, "review.md"), "utf8");
const edit = (rdir: string, f: (s: string) => string) => writeFileSync(join(rdir, "review.md"), f(md(rdir)));
const mark = (which: "real" | "rewrite") =>
  `Mark: [${which === "real" ? "x" : " "}] real  [ ] intended  [ ] noise  [${which === "rewrite" ? "x" : " "}] rewrite`;
/** Both findings' Mark lines (marked one by one) set to `f1` and `f2`. */
const marks = (f1: string, f2: string) => (s: string) => {
  const [a, b, c] = s.split(/^Mark: .*$/m);
  return a + f1 + b + f2 + c;
};
const record = (repo: string) => JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files;

/** An answer runner that writes one test for whatever it is asked, kept (and failing when `fails`), or none. */
function runner(seen: string[][], o: { fails?: boolean; none?: boolean } = {}) {
  return async (qid: string, question: string, answer: string, _diff: string, outDir: string, project: string)
    : Promise<AnswerOutcome> => {
    seen.push([qid, question, answer, outDir.split("/").slice(-2).join("/"), project]);
    const file = `${WD}/answers/test_${qid.toLowerCase()}.py`;
    if (o.none) return { qid, files: {}, keep: {}, skip: {}, disagree: [], costUsd: 0.1, stop: "end_turn", base: `${WD}/answers` };
    return { qid, files: { [file]: `def test_${qid.toLowerCase()}():\n    assert False\n` },
      keep: { [file]: new Set([`test_${qid.toLowerCase()}`]) }, skip: {},
      disagree: o.fails ? [`${file}::test_${qid.toLowerCase()}`] : [], costUsd: 0.1, stop: "end_turn",
      base: `${WD}/answers` };
  };
}

test("a test that assumed an answer is set aside when the owner's answer has its own test", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  edit(rdir, (s) => marks(mark("real"), mark("real"))(s).replace(/^Answer:$/m, "Answer: no, it truncates"));
  const seen: string[][] = [];
  const result = await accept(repo, rdir, SETTINGS, { answerRunner: runner(seen, { fails: true }) });
  expect(seen).toEqual([["Q1", "Should add round?", "no, it truncates", "answers/Q1", "main"]]);
  expect(result.setAside).toEqual({ F2: "Q1" });
  // F2's test leaves the kept file (the answer's test replaces it); it is no accepted test.
  const kept = readFileSync(join(repo, DEST, "test_add_subtracts.py"), "utf8");
  expect(kept).not.toContain("def test_b");
  expect(kept).not.toContain("not confirmed");
  expect(record(repo)[`${DEST}/test_add_subtracts.py`].tests).toEqual(["test_a"]);
  expect(record(repo)[`${DEST}/answers/test_q1.py`].tests).toEqual(["test_q1"]);
  expect(result.red.map((r) => r.id)).toEqual(["F1"]);
  const prompt = readFileSync(join(rdir, "fix-prompt.md"), "utf8");
  expect(prompt).toContain("`test_a` (F1)");
  expect(prompt).not.toContain("`test_b`");
  expect(prompt).toContain("- F2: its test assumed an answer the owner gave differently (Q1); the answer's test " +
    "replaces it.");
  expect(prompt).toContain(`- Fails now: \`${DEST}/answers/test_q1.py::test_q1\``);
});

test("an answer that kept no test sets nothing aside: the finding's test stays accepted", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  edit(rdir, (s) => marks(mark("real"), mark("real"))(s).replace(/^Answer:$/m, "Answer: whatever"));
  const result = await accept(repo, rdir, SETTINGS, { answerRunner: runner([], { none: true }) });
  expect(result.setAside).toEqual({});
  // Two problems in one file: it is named after the review.
  expect(record(repo)[`${DEST}/test_r20261011_a1b2c3.py`].tests).toEqual(["test_a", "test_b"]);
  expect(readFileSync(join(rdir, "fix-prompt.md"), "utf8")).toContain("- F2 assumed an answer to Q1; see the " +
    "owner's answer below.");
});

test("rewrite: the issue's test is set aside and one answer round writes a test of the owner's reason", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo, [ISSUE]);
  edit(rdir, (s) => s.replace(`${mark("real")}  (both tests)`, `${mark("rewrite")}  (both tests)\n` +
    "Rewrite: it checks the log line; check that add(2, 3) returns 5"));
  const seen: string[][] = [];
  const result = await accept(repo, rdir, SETTINGS, { answerRunner: runner(seen, { fails: true }) });
  // The question from the issue's title and expected behaviour; the answer is the reason after a fixed sentence.
  expect(seen).toEqual([["R1", "add subtracts. Expected: add(2, 3) is 5",
    "The test arnx wrote for this was wrong. it checks the log line; check that add(2, 3) returns 5", "answers/R1",
    "main"]]);
  expect(REWRITE_PREFIX).toBe("The test arnx wrote for this was wrong. ");
  expect(result.rewrites).toEqual([{ id: "R1", findings: ["F1", "F2"], project: "main",
    reason: "it checks the log line; check that add(2, 3) returns 5", question: "add subtracts. Expected: add(2, 3) is 5",
    answer: `${REWRITE_PREFIX}it checks the log line; check that add(2, 3) returns 5` }]);
  expect(result.setAside).toEqual({ F1: "R1", F2: "R1" });
  // Nothing of the old tests is kept; the rewrite's test is, under answers/, and recorded as failing until fixed.
  expect(existsSync(join(repo, DEST, "test_add_subtracts.py"))).toBe(false);
  expect(Object.keys(record(repo))).toEqual([`${DEST}/answers/test_r1.py`]);
  expect(record(repo)[`${DEST}/answers/test_r1.py`].tests).toEqual(["test_r1"]);
  expect(result.answers.map((a) => a.qid)).toEqual(["R1"]);
  const done = JSON.parse(readFileSync(join(rdir, "accepted.json"), "utf8"));
  expect(done.set_aside).toEqual({ F1: "R1", F2: "R1" });
  expect(done.rewrites).toEqual({ R1: { findings: ["F1", "F2"],
    reason: "it checks the log line; check that add(2, 3) returns 5" } });
  // The fix prompt: still a bug to fix, the rewrite's test in place of the old ones.
  const prompt = readFileSync(join(rdir, "fix-prompt.md"), "utf8");
  expect(prompt).toContain("### 1. add subtracts (F1, F2)");
  expect(prompt).not.toContain("Accepted test");
  expect(prompt).toContain("- F1: its test was wrong; the owner's rewrite (R1, below) replaces it.");
  expect(prompt).toContain("- R1: add subtracts. Expected: add(2, 3) is 5 (rewrite of F1, F2)\n" +
    "  - Owner: \"it checks the log line; check that add(2, 3) returns 5\"\n" +
    `  - Fails now: \`${DEST}/answers/test_r1.py::test_r1\``);
  expect(prompt).not.toContain("## Not bugs");
  // The precision log: rewrite is the mark, and it counts as real.
  const lines = readFileSync(join(repo, ".arnx", "precision.jsonl"), "utf8").trim().split("\n");
  expect(lines.map((l) => JSON.parse(l).mark)).toEqual(["rewrite", "rewrite", undefined]);
  expect(result.precision).toEqual({ real: 2, chosen: 2, defaulted: 0, unknown: 0 });

  // Accepting again with the issue marked real: the old tests are back, the rewrite's file is removed.
  edit(rdir, (s) => s.replace(`${mark("rewrite")}  (both tests)`, `${mark("real")}  (both tests)`));
  const again: string[][] = [];
  const back = await accept(repo, rdir, SETTINGS, { again: true, answerRunner: runner(again) });
  expect(again).toEqual([]);
  expect(back.rewrites).toEqual([]);
  expect(back.setAside).toEqual({});
  expect(existsSync(join(repo, DEST, "answers", "test_r1.py"))).toBe(false);
  expect(record(repo)[`${DEST}/test_add_subtracts.py`].tests).toEqual(["test_a", "test_b"]);
  expect(Object.keys(record(repo))).toEqual([`${DEST}/test_add_subtracts.py`]);
  expect(readFileSync(join(rdir, "fix-prompt.md"), "utf8")).not.toContain("R1");
});

test("rewrite marked on one finding: only its test is set aside, and leaves the kept file", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  edit(rdir, marks(mark("real"), `${mark("rewrite")}\nRewrite: compare the sum, not the message`));
  const seen: string[][] = [];
  const result = await accept(repo, rdir, SETTINGS, { answerRunner: runner(seen) });
  // Marked one by one, the "issue" is the finding: its explanation is the title, with no expected behaviour.
  expect(seen).toEqual([["R1", "add drops one.", `${REWRITE_PREFIX}compare the sum, not the message`, "answers/R1",
    "main"]]);
  const kept = readFileSync(join(repo, DEST, "test_add_subtracts.py"), "utf8");
  expect(kept).not.toContain("def test_b");
  expect(kept).toContain("def test_a");
  expect(kept).not.toContain("xfail");
  expect(record(repo)[`${DEST}/test_add_subtracts.py`].tests).toEqual(["test_a"]);
  // Its test passes on the code: kept to lock it, not an accepted (failing) test.
  expect(record(repo)[`${DEST}/answers/test_r1.py`].tests).toEqual([]);
  expect(result.red.map((r) => r.id)).toEqual(["F1"]);
});

test("a rewrite mark without a reason stops accept, naming the issue and what to add", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo, [ISSUE]);
  edit(rdir, (s) => s.replace(`${mark("real")}  (both tests)`, `${mark("rewrite")}  (both tests)`));
  await expect(accept(repo, rdir, SETTINGS, { answerRunner: runner([]) })).rejects.toThrow("Issue 1: marked rewrite " +
    "without a reason; add a line `Rewrite: <what the test should check>` right after its Mark line");
  expect(existsSync(join(rdir, "accepted.json"))).toBe(false);
});

test("a review.md with three boxes accepts as it did before rewrite existed", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  edit(rdir, (s) => marks("Mark: [x] real  [ ] intended  [ ] noise", "Mark: [ ] real  [ ] intended  [x] noise")(s));
  expect(md(rdir)).not.toContain("] rewrite");
  const result = await accept(repo, rdir, SETTINGS);
  expect(result.setAside).toEqual({});
  expect(result.rewrites).toEqual([]);
  expect(readFileSync(join(repo, DEST, "test_add_subtracts.py"), "utf8")).not.toContain("def test_b");
  expect(record(repo)[`${DEST}/test_add_subtracts.py`].tests).toEqual(["test_a"]);
});

test("precision counts a rewrite mark as real", () => {
  const line = (mark: string) => JSON.stringify({ review: "r", item: "F1", kind: "finding", mark, mark_source: "chosen" });
  expect(precisionOf([line("rewrite"), line("real"), line("noise"), line("intended")]))
    .toEqual({ real: 2, chosen: 4, defaulted: 0, unknown: 0 });
});

// --- the command line -----------------------------------------------------------------------------------------------

test("accept says which tests were set aside and what each rewrite wrote; --json carries the rewrite", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  await cli.run("init");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  app:
    root: .
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  const rdir = join(repo, ".arnx", "reviews", RID);
  const f1: Finding = { ...finding("F1", "tests/g/test_a.py::test_F1", "test_F1", "tests/g/test_a.py", "x",
    "rounds up", "confirmed"), dependsOn: "Q1" };
  save(sampleReview({ id: RID, projects: ["main"], writeDir: "tests/g", questions: ["Does it round?"],
    questionProjects: ["app"], findings: [f1, finding("F2", "tests/g/test_a.py::test_F2", "test_F2",
      "tests/g/test_a.py", "x", "logs the total", "confirmed")] }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"), "def test_F1():\n    assert False\n\ndef test_F2():\n    assert False\n");
  edit(rdir, (s) => marks(mark("real"), `${mark("rewrite")}\nRewrite: check the total returned`)(s)
    .replace(/^Answer:$/m, "Answer: it rounds down"));
  // The rounds' tests, written by an earlier accept: no model is called.
  const saved = (id: string, key: string, gen: string, name: string, disagree: string[]) => {
    mkdirSync(join(rdir, "answers", id), { recursive: true });
    writeFileSync(join(rdir, "answers", id, "outcome.json"), JSON.stringify({ answer: key, qid: id,
      files: { [gen]: `def ${name}():\n    assert False\n` }, keep: { [gen]: [name] }, skip: {}, disagree,
      costUsd: 0.3, stop: "end_turn", base: "tests/answers" }));
  };
  saved("Q1", "it rounds down", "tests/answers/test_round.py", "test_rounds_down", []);
  saved("R1", `logs the total.\n${REWRITE_PREFIX}check the total returned`, "tests/answers/test_total.py", "test_total",
    ["tests/answers/test_total.py::test_total"]);
  expect(await cli.run("consent", "--yes")).toBe(0);
  const run = new Cli({ ...cli.deps, check: false, ask: async () => { throw new Error("asked"); } });
  expect(await run.run("accept", "--json", "--quiet")).toBe(0);
  const j = JSON.parse(run.stdout);
  expect(j.marks).toEqual({ real: 1, intended: 0, noise: 0, rewrite: 1, unmarked: 0, left_as_prefilled: 0 });
  expect(j.answers).toEqual([
    { question: "Q1", result: "locked", tests: ["test_rounds_down"], cost_usd: 0, rewrite_of: null },
    { question: "R1", result: "disagree", tests: ["test_total"], cost_usd: 0, rewrite_of: ["F2"] }]);
  expect(j.next).toEqual(["give the fix prompt to your coding agent", "arnx check"]);
  expect(run.stderr).toContain("No test of a finding kept: their tests were set aside.\n");
  expect(run.stderr).toContain("F1 set aside: your answer to Q1 has its own test\n");
  expect(run.stderr).toContain("Q1: the code already does it; 1 test(s) kept to lock it · $0.00\n" +
    "R1 (rewrite of F2): the code does not do what your reason says; kept failing: test_total · $0.00");
});
