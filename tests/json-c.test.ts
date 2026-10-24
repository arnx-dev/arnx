// --json for accept (and --keep-edits), prompt, and the `command` field in check's own objects. No model, Docker or
// network: a fake sandbox runs the tests, and an answer's tests come from an earlier accept's saved outcome.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTED_RECORD } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { save } from "../src/report";
import type { SessionFactory } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const KEPT = "tests/arnx/r20261011_a1b2c3/test_y.py";

/** The accepted test fails in the fake sandbox; any other test passes. */
const sessions: SessionFactory = async (_c, snap, _l, body) =>
  body(new FakeSession(snap, () => [junitXml([[KEPT, "test_a", "failed", "assert False"]]), "1 failed", false]));

/** A repository with an approved environment and a review: F1 marked real, F2 marked noise, Q1 answered when
 * `answer`, with the tests of that answer already written by an earlier accept (so no model is called). */
async function reviewed(answer = false): Promise<{ repo: string; rdir: string; cli: Cli }> {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, checkSessions: sessions, env: { ANTHROPIC_API_KEY: "a" } });
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
  save(sampleReview({ id: RID, findings: ["F1", "F2"].map((id) => finding(id, `tests/g/test_a.py::test_${id}`,
    `test_${id}`, "tests/g/test_a.py", "x", "y", "confirmed")), questions: answer ? ["Does it round?"] : [],
  questionProjects: answer ? ["app"] : [], projects: ["main"], writeDir: "tests/g" }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"),
    "def test_F1():\n    assert False\n\ndef test_F2():\n    assert False\n");
  let md = blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replace("Mark: [ ] real", "Mark: [x] real")
    .replace(/(## F2[\s\S]*?)\[ \] noise/, "$1[x] noise");
  if (answer) {
    md = md.replace(/^Answer:$/m, "Answer: it rounds down");
    const gen = "tests/answers/test_round.py";
    mkdirSync(join(rdir, "answers", "Q1"), { recursive: true });
    writeFileSync(join(rdir, "answers", "Q1", "outcome.json"), JSON.stringify({ answer: "it rounds down", qid: "Q1",
      files: { [gen]: "def test_rounds_down():\n    assert True\n" }, keep: { [gen]: ["test_rounds_down"] },
      skip: {}, disagree: [], costUsd: 0.3, stop: "end_turn", base: "tests/answers" }));
  }
  writeFileSync(join(rdir, "review.md"), md);
  return { repo, rdir, cli };
}

test("accept --json: the review, kept files, marks, answers, the check, the fix prompt and the next steps", async () => {
  const { cli } = await reviewed(true);
  expect(await cli.run("consent", "--yes")).toBe(0);
  const run = new Cli({ ...cli.deps, check: true, ask: async () => { throw new Error("asked"); } });
  expect(await run.run("accept", "--json", "--quiet")).toBe(0);
  const j = JSON.parse(run.stdout);
  expect(j).toEqual({ schema_version: 1, command: "accept", result: "ok", exit_code: 0, review_id: RID,
    kept: [KEPT, "tests/arnx/r20261011_a1b2c3/answers/test_round.py"], dest: "tests/arnx/r20261011_a1b2c3",
    issues: 1, marks: { real: 1, intended: 0, noise: 1, rewrite: 0, unmarked: 0, left_as_prefilled: 1 }, // F1 real as pre-filled
    answers: [{ question: "Q1", result: "locked", tests: ["test_rounds_down"], cost_usd: 0, rewrite_of: null }],
    check: { failing: [{ project: "app", test_id: `${KEPT}::test_a`, message: "assert False\ntrace" }], passing: 0 },
    not_marked: [], fix_prompt: `.arnx/reviews/${RID}/fix-prompt.md`,
    next: ["give the fix prompt to your coding agent", "arnx check"] });
  // The text a person reads goes to stderr, as without --json.
  expect(run.stderr).toContain(`✓ Accepted 1 test from 1 issue (1 finding)\n  1 mark was pre-filled (not reviewed in ` +
    `triage)\n  kept: ${KEPT}\n  kept: tests/arnx/r20261011_a1b2c3/answers/test_round.py\nQ1: `);
  expect(run.stderr).toContain("Q1: the code already does it; 1 test(s) kept to lock it · $0.00");
});

test("accept --json --no-check --no-answers: check is null, nothing kept leaves dest null", async () => {
  const { repo, rdir } = await reviewed();
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("accept", "--json", "--no-check", "--no-answers")).toBe(0);
  expect(JSON.parse(cli.stdout)).toMatchObject({ result: "ok", kept: [KEPT], check: null, answers: [] });
  writeFileSync(join(rdir, "review.md"), readFileSync(join(rdir, "review.md"), "utf8").replace("[x] real", "[ ] real"));
  const again = new Cli({ cwd: repo });
  expect(await again.run("accept", "--again", "--json", "--no-answers")).toBe(0);
  expect(JSON.parse(again.stdout)).toMatchObject({ kept: [], dest: null, marks: { real: 0, noise: 1, unmarked: 1 } });
});

test("accept --json: errors are the error object (no reviews; answers without the consent are not asked)", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, ask: async () => { throw new Error("asked"); } });
  await cli.run("init");
  cli.out.length = 0;
  expect(await cli.run("accept", "--json")).toBe(2);
  expect(JSON.parse(cli.stdout)).toEqual({ schema_version: 1, command: "accept", result: "error", exit_code: 2,
    error: "no reviews yet; run `arnx review`" });
  const { cli: c2 } = await reviewed(true);
  const run = new Cli({ ...c2.deps, ask: async () => { throw new Error("asked"); } });
  expect(await run.run("accept", "--json")).toBe(3);
  expect(JSON.parse(run.stdout)).toMatchObject({ command: "accept", result: "error", exit_code: 3 });
});

test("accept --keep-edits --json: what was recorded, and where", async () => {
  const { repo, cli } = await reviewed();
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  const none = new Cli({ cwd: repo });
  expect(await none.run("accept", "--keep-edits", "--json")).toBe(0);
  expect(JSON.parse(none.stdout)).toEqual({ schema_version: 1, command: "accept", result: "ok", exit_code: 0,
    changed: [], restored_tests: [], recorded: ACCEPTED_RECORD });
  writeFileSync(join(repo, KEPT), "def test_a():\n    assert 1 == 1\n");
  const one = new Cli({ cwd: repo });
  expect(await one.run("accept", "--keep-edits", "--json")).toBe(0);
  expect(JSON.parse(one.stdout)).toMatchObject({ result: "ok", changed: [{ path: KEPT, change: "modified" }],
    restored_tests: [], recorded: ".arnx/accepted-tests.json" });
  expect(one.stderr).toContain(`modified ${KEPT}`);
});

test("prompt --json: the review, the file and its whole text", async () => {
  const { repo, rdir, cli } = await reviewed();
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  const p = new Cli({ cwd: repo });
  expect(await p.run("prompt", "--json")).toBe(0);
  const text = readFileSync(join(rdir, "fix-prompt.md"), "utf8");
  expect(JSON.parse(p.stdout)).toEqual({ schema_version: 1, command: "prompt", result: "ok", exit_code: 0,
    review_id: RID, path: `.arnx/reviews/${RID}/fix-prompt.md`, text });
  expect(p.stderr).toBe(text.trimEnd());
  const none = new Cli({ cwd: repo });
  expect(await none.run("prompt", "nope", "--json")).toBe(2);
  expect(JSON.parse(none.stdout)).toEqual({ schema_version: 1, command: "prompt", result: "error", exit_code: 2,
    error: "no review nope under .arnx/reviews" });
});

test("check --json and check --review --json carry command: check; their errors are the error object", async () => {
  const { repo, cli } = await reviewed();
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  const c = new Cli({ cwd: repo, checkSessions: sessions });
  expect(await c.run("check", "--json", "--quiet")).toBe(1);
  expect(JSON.parse(c.stdout)).toMatchObject({ schema_version: 1, command: "check", result: "fail", exit_code: 1 });
  // A review with no confirmed findings: nothing runs, and the object says which command it is.
  save(sampleReview({ id: "20261012-000000", findings: [], questions: [] }), join(repo, ".arnx", "reviews",
    "20261012-000000"), "d");
  const r = new Cli({ cwd: repo, checkSessions: sessions });
  expect(await r.run("check", "--review", "20261012-000000", "--json", "--quiet")).toBe(0);
  expect(JSON.parse(r.stdout)).toEqual({ schema_version: 1, command: "check", review: "20261012-000000",
    result: "nothing-confirmed", exit_code: 0, findings: [] });
  const e = new Cli({ cwd: repo, checkSessions: sessions });
  expect(await e.run("check", "--review", "nope", "--json")).toBe(3);
  expect(JSON.parse(e.stdout)).toEqual({ schema_version: 1, command: "check", result: "error", exit_code: 3,
    error: "no review nope under .arnx/reviews" });
});
