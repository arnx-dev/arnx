import { beforeEach, expect, test } from "bun:test";
import { COPY_SUFFIX } from "../src/testround";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { ArnxError, ModelError, SetupRequired } from "../src/errors";
import { closeOpen, closers } from "../src/interrupt";
import { LocalBrain } from "../src/localbrain";
import { exitCode } from "../src/report";
import { newReviewId, runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { PRICES, type Reply } from "../src/llm";
import type { SessionFactory } from "../src/sandbox";
import { FakeJson, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { gitRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";
const REPORT = '{"tests": [{"test": "tests/arnx_generated/test_add.py::test_add", "expects": "add sums"},' +
  ' {"test": "tests/arnx_generated/test_add.py::test_zero", "expects": "zero is neutral"}],' +
  ' "suspected_defects": [{"test": "tests/arnx_generated/test_add.py::test_add",' +
  ' "explanation": "add subtracts instead of adding."}],' +
  ' "questions": ["Should add accept strings?"]}';
// The fakes report the same failure on any snapshot, so the before/after check would call every finding
// pre-existing; it is off here and tested in before.test.ts.
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-11T00:00:00Z" };
const tmp = useTmp();
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, stamp(parseReviewConfig(YAML), "Dev", "2026-10-11"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
});

const agent = () => new ScriptedAgent([
  [tool("write_file", { path: GEN, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" +
    "\ndef test_zero():\n    assert add(0, 0) == 0\n" })],
  [text(REPORT)],
]);
const runs = (): [string | null, string, boolean] =>
  [junitXml([[GEN, "test_add", "failed", "assert -1 == 5"], [GEN, "test_zero", "passed", ""]]), "", false];

test("test_review_produces_a_challenged_finding", async () => {
  const judge = new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]);
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: judge,
    sessionFactory: fakeFactory(runs) });
  expect(exitCode(review)).toBe(1);
  expect(review.stop).toBe("end_turn");
  expect(review.findings).toHaveLength(1);
  const f = review.findings[0]!;
  expect([f.id, f.func, f.file, f.verdict]).toEqual(["F1", "test_add", GEN, "confirmed"]);
  expect(f.explanation).toBe("add subtracts instead of adding.");
  expect(f.message.startsWith("assert -1 == 5")).toBe(true);
  expect(review.questions).toEqual(["Should add accept strings?"]);
  expect([review.passed, review.testsWritten]).toEqual([1, 2]);
  expect(review.change.startsWith("uncommitted")).toBe(true);
  expect(review.writeDir).toBe("tests/arnx_generated");
  expect(review.costUsd).toBeCloseTo(2 * (1000 * 2 + 200 * 10) / 1e6 + 0.01, 10);
  expect(existsSync(join(rdir, "review.md")) && existsSync(join(rdir, "tests", GEN + COPY_SUFFIX))).toBe(true);
  expect(judge.calls[0]).toContain("def test_add");
  expect(existsSync(join(repo, GEN))).toBe(false); // never written into the user's tree
});

test("test_hanging_tests_make_the_review_incomplete", async () => {
  const hang = fakeFactory(() => [null, "[timed out]", true]);
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: new FakeJson([]),
    sessionFactory: hang });
  expect(review.findings).toEqual([]);
  expect(review.missingRuns).toBe(3);
  expect(exitCode(review)).toBe(2);
});

test("test_requires_consent_and_approval", async () => {
  await expect(runReview(repo, { settings: defaultSettings(), agentModel: agent(), challenger: new FakeJson([]),
    sessionFactory: fakeFactory(runs) })).rejects.toThrow(/run `arnx consent`/);
  writeFileSync(reviewConfigPath(repo), YAML);
  const err = await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: new FakeJson([]),
    sessionFactory: fakeFactory(runs) }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SetupRequired);
  expect(String(err)).toContain("approve");
});

test("a review refuses a tests_dir that holds the project's own tests before any model is asked", async () => {
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML + "tests_dir: tests\n"), "Dev", "2026-10-11"));
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "tests", "conftest.py"), "import pytest\n");
  runGit(repo, "add", "tests/conftest.py");
  const model = agent();
  const err = await runReview(repo, { settings: SETTINGS, agentModel: model, challenger: new FakeJson([]),
    sessionFactory: fakeFactory(runs) }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SetupRequired);
  expect(String(err)).toContain("tests/ already holds the project's own tests (tests/conftest.py)");
  expect(model.calls).toHaveLength(0);
});

test("test_review_id", () => {
  const rid = newReviewId(new Date(Date.UTC(2026, 9, 11)));
  expect(rid.startsWith("20261011-")).toBe(true);
  expect(rid).toHaveLength(15);
});

test("the review records each model's calls, tokens and cost, and logs them for checking against a bill", async () => {
  const judge = new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]);
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: judge,
    sessionFactory: fakeFactory(runs), now: new Date("2026-10-13T23:30:00-03:00") });
  expect(review.usage).toEqual([
    { model: "anthropic:claude-sonnet-5-5", calls: 2, unknownCalls: 0, input: 2000, output: 400, cacheRead: 0,
      cacheWrite: 0, costUsd: 0.008 },
    { model: "openai:gpt-5.5-2026-04-23", calls: 1, unknownCalls: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
      costUsd: 0.01 },
  ]);
  expect(review.costUsd).toBeCloseTo(review.usage.reduce((a, u) => a + u.costUsd, 0), 10);
  expect(JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")).usage).toHaveLength(2);
  // one line per run, dated in UTC like the providers' bills
  const lines = readFileSync(join(repo, ".arnx", "usage.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines).toHaveLength(1);
  expect(lines[0].utc_day).toBe("2026-10-14");
  expect(lines[0].command).toBe("review");
  expect(lines[0].usage[1].cost_usd).toBe(0.01);
});

test("a reviewer reply that came after a cut-off attempt counts as an unknown call in review.json and the log", async () => {
  class CutOnce extends ScriptedAgent {
    override async create(o: Parameters<ScriptedAgent["create"]>[0]): Promise<Reply> {
      const reply = await super.create(o);
      return this.calls.length === 1 ? { ...reply, unknownCalls: 1 } : reply;
    }
  }
  const model = new CutOnce(agent().steps);
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: model,
    challenger: new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]), sessionFactory: fakeFactory(runs) });
  const saved = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")).usage;
  expect(saved[0]).toMatchObject({ model: "anthropic:claude-sonnet-5-5", calls: 2, unknown_calls: 1 });
  const line = JSON.parse(readFileSync(join(repo, ".arnx", "usage.jsonl"), "utf8").trim());
  expect(line.usage[0]).toMatchObject({ model: "anthropic:claude-sonnet-5-5", calls: 2, unknown_calls: 1 });
});

test("the review lists what each passing test checks, from the reviewer's report", async () => {
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent(),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "r" }]), sessionFactory: fakeFactory(runs) });
  expect(review.checked).toEqual([{ project: "main", test: "tests/arnx_generated/test_add.py::test_zero",
    expects: "zero is neutral" }]);
});

test("after the challenge, the second model groups the findings for the report", async () => {
  const judge = new FakeJson([{ verdict: "confirmed", reason: "add subtracts." },
    { groups: [{ findings: ["F1"], title: "add subtracts", input: "add(2, 3)", actual: "-1", expected: "5",
      consequence: "every sum is wrong" }] }]);
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: judge,
    sessionFactory: fakeFactory(runs) });
  expect(review.groups).toEqual([{ findings: ["F1"], title: "add subtracts", input: "add(2, 3)", actual: "-1",
    expected: "5", consequence: "every sum is wrong" }]);
  expect(review.findings[0]!.verdict).toBe("confirmed");
  expect(exitCode(review)).toBe(1);
  expect(review.usage[1]!.calls).toBe(2);
  expect(readFileSync(join(rdir, "review.md"), "utf8")).toContain("### Issue 1 · add subtracts");
});

test("second-model calls are logged in second-opinion.jsonl; after a timeout the explain call is skipped", async () => {
  const late = new ModelError("no reply within 300s");
  late.timedOut = true;
  const judge = new FakeJson([late, { groups: [] }]);
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: judge,
    sessionFactory: fakeFactory(runs) });
  expect(judge.calls).toHaveLength(1); // no explain call after the timeout
  expect(review.groups).toEqual([]);
  const lines = readFileSync(join(rdir, "second-opinion.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => [l.step, l.outcome])).toEqual([["challenge", "error"], ["explain", "skipped"]]);
});

test("an idle or attempt timeout (not worded 'no reply within') also skips the explain call", async () => {
  const late = new ModelError("anthropic:claude-haiku-5-5: no reply: attempt timeout after 300s (3 attempts)");
  late.timedOut = true;
  const judge = new FakeJson([late, { groups: [] }]);
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: judge,
    sessionFactory: fakeFactory(runs) });
  expect(judge.calls).toHaveLength(1);
  const lines = readFileSync(join(rdir, "second-opinion.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => [l.step, l.outcome])).toEqual([["challenge", "error"], ["explain", "skipped"]]);
});

test("the review reports progress: project, reviewer turns, final runs, second opinion", async () => {
  const said: string[] = [];
  const judge = new FakeJson([{ verdict: "confirmed", reason: "r" }]);
  await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: judge, sessionFactory: fakeFactory(runs),
    progress: (m) => said.push(m) });
  expect(said[0]).toBe("main (1/1): preparing the test environment");
  expect(said).toContain("main: writing tests");
  // No line per model turn: the live line shows time and cost.
  expect(said.some((m) => /turn \d/.test(m))).toBe(false);
  expect(said).toContain("main: final run 1/3");
  expect(said).not.toContain("main: final run 2/3"); // every test passed in the first run: nothing to repeat
  expect(said).toContain("second opinion on F1 (1/1)");
  expect(said).toContain("grouping findings");
});

/** A LocalBrain that records each finish it is told. */
function finishSpy(stops: { stop: string; projectsReviewed: number }[]) {
  const brain = new LocalBrain({ agentModel: agent(), prices: PRICES, challenger: new FakeJson([]) });
  const finish = brain.finish.bind(brain);
  brain.finish = async (t) => {
    stops.push({ stop: t.stop, projectsReviewed: t.projectsReviewed });
    return finish(t);
  };
  return brain;
}

test("the brain is told a review failed: finish with stop failed and the totals so far", async () => {
  const stops: { stop: string; projectsReviewed: number }[] = [];
  const broken: SessionFactory = async () => { throw new ArnxError("docker went away"); };
  await expect(runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: new FakeJson([]),
    sessionFactory: broken, brain: finishSpy(stops) })).rejects.toThrow(/docker went away/);
  expect(stops).toEqual([{ stop: "failed", projectsReviewed: 0 }]);
});

test("an interrupted review closes its brain once, with stop interrupted", async () => {
  const stops: { stop: string; projectsReviewed: number }[] = [];
  let release!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const slow: SessionFactory = async (cfg, snap, log, body) => {
    await held;
    return fakeFactory(runs)(cfg, snap, log, body);
  };
  const review = runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: new FakeJson([]),
    sessionFactory: slow, brain: finishSpy(stops) });
  while (!closers.size) await new Promise((r) => setTimeout(r, 5));
  await closeOpen();
  release();
  await review;
  expect(stops).toEqual([{ stop: "interrupted", projectsReviewed: 0 }]);
  expect(closers.size).toBe(0);
});

test("a completed review closes its brain with the agent's stop", async () => {
  const stops: { stop: string; projectsReviewed: number }[] = [];
  await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: new FakeJson([{ verdict: "confirmed",
    reason: "add subtracts." }]), sessionFactory: fakeFactory(runs), brain: finishSpy(stops) });
  expect(stops).toEqual([{ stop: "end_turn", projectsReviewed: 1 }]);
  expect(closers.size).toBe(0);
});
