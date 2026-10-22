import { beforeEach, expect, test } from "bun:test";
import { COPY_SUFFIX } from "../src/testround";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { SetupRequired } from "../src/errors";
import { exitCode, load, render, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
// The fakes report the same failure on any snapshot, so the before/after check would call every finding
// pre-existing; it is off here and tested in before.test.ts.
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" };
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
  for (const p of ["services/pay/pay.py", "services/feed/feed.py", "services/shared/db.py", "infra/main.tf"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "X = 1\n");
  }
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  commit(repo, "layout");
});

const GEN = "tests/arnx_generated/test_x.py";
/** Each project's fake session fails test_bad and passes test_ok in its own generated file. */
const perProject: SessionFactory = async (cfg, snap, _log, body) =>
  body(new FakeSession(snap, () => [junitXml([[GEN, "test_bad", "failed", `boom in ${cfg.name}`],
    [GEN, "test_ok", "passed", ""]]), "1 failed, 1 passed", false]));

function agentFor(...projects: string[]): ScriptedAgent {
  return new ScriptedAgent(projects.flatMap((p) => [
    [tool("write_file", { path: `services/${p}/${GEN}`,
      content: `import ${p}\ndef test_bad(): assert 0\ndef test_ok(): pass\n` })],
    [text(JSON.stringify({ tests: [], suspected_defects: [{ test: `${GEN}::test_bad`, explanation: `${p} is wrong` }],
      questions: [`Question about ${p}?`] }))],
  ]));
}

test("a change to a shared path reviews each project that uses it", async () => {
  writeFileSync(join(repo, "services/shared/db.py"), "X = 2\n");
  const agent = agentFor("feed", "pay");
  const judge = new FakeJson([{ verdict: "confirmed", reason: "r1" }, { verdict: "confirmed", reason: "r2" }]);
  const { review, rdir } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agent, challenger: judge,
    sessionFactory: perProject });
  expect(review.projects).toEqual(["feed", "pay"]);
  expect(review.findings.map((f) => [f.id, f.project, f.file, f.explanation])).toEqual([
    ["F1", "feed", `services/feed/${GEN}`, "feed is wrong"], ["F2", "pay", `services/pay/${GEN}`, "pay is wrong"]]);
  expect(review.questions).toEqual(["Question about feed?", "Question about pay?"]);
  expect(review.questionProjects).toEqual(["feed", "pay"]);
  expect(review.writeDirs).toEqual({ feed: "services/feed/tests/arnx_generated", pay: "services/pay/tests/arnx_generated" });
  expect([review.passed, review.testsWritten]).toEqual([2, 4]);
  expect(exitCode(review)).toBe(1);
  for (const p of ["feed", "pay"]) {
    expect(existsSync(join(rdir, "projects", p, "transcript.jsonl"))).toBe(true);
    expect(existsSync(join(rdir, "projects", p, "tests", "services", p, GEN + COPY_SUFFIX))).toBe(true);
  }
  // the agent saw the project's scope in its task
  expect(String(agent.calls[0]!.messages[0]!.content)).toContain("This review covers the project `feed`");
  expect(load(rdir)).toEqual(review);
  expect(render(review)).toContain("- Project: feed");
});

test("a change no project covers needs setup (exit 3)", async () => {
  writeFileSync(join(repo, "infra/main.tf"), "X = 2\n");
  const err = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agentFor(), challenger: new FakeJson([]),
    sessionFactory: perProject }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(SetupRequired);
  expect(String(err)).toContain("infra/main.tf (Terraform; no adapter)");
  expect(String(err)).toContain("arnx setup --add");
});

test("a partly covered change names the rest in the status", async () => {
  writeFileSync(join(repo, "services/pay/pay.py"), "X = 2\n");
  writeFileSync(join(repo, "infra/main.tf"), "X = 2\n");
  const { review, rdir } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agentFor("pay"),
    challenger: new FakeJson([{ verdict: "disputed", reason: "no" }]), sessionFactory: perProject });
  expect(review.projects).toEqual(["pay"]);
  expect(review.uncovered).toEqual([{ path: "infra/main.tf", reason: "Terraform; no adapter" }]);
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  expect(md).toContain("Not covered: `infra/main.tf` (Terraform; no adapter).");
});

test("the review keeps per-project stats: tests, passes, runs without a report, whether the agent saw them run", async () => {
  writeFileSync(join(repo, "services/shared/db.py"), "X = 2\n");
  // feed's runner never reports anything; pay's works (the agent did not call run_tests in either)
  const mixed: SessionFactory = async (cfg, snap, _log, body) => body(new FakeSession(snap, () => cfg.name === "feed"
    ? [null, "No tests found", false] : [junitXml([[GEN, "test_ok", "passed", ""]]), "", false]));
  const agent = new ScriptedAgent(["feed", "pay"].flatMap((p) => [
    [tool("write_file", { path: `services/${p}/${GEN}`, content: "def test_ok(): pass\n" })],
    [text('{"tests": []}')]]));
  const { review } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agent, challenger: new FakeJson([]),
    sessionFactory: mixed });
  expect(review.projectStats).toEqual([
    { name: "feed", testFiles: 1, tests: 0, passed: 0, missingRuns: 3, sawResults: false, stop: "end_turn" },
    { name: "pay", testFiles: 1, tests: 1, passed: 1, missingRuns: 0, sawResults: false, stop: "end_turn" },
  ]);
});

test("a question can name the tests that assume its answer; their findings depend on it", async () => {
  writeFileSync(join(repo, "services/pay/pay.py"), "X = 2\n");
  const agent = new ScriptedAgent([
    [tool("write_file", { path: `services/pay/${GEN}`, content: "import pay\ndef test_bad(): assert 0\ndef test_ok(): pass\n" })],
    [text(JSON.stringify({ tests: [], suspected_defects: [{ test: `${GEN}::test_bad`, explanation: "negative is a typo" }],
      questions: ["Unrelated?", { question: "Should a negative threshold turn the alert off?", tests: [`${GEN}::test_bad`] }] }))],
  ]);
  const { review } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agent,
    challenger: new FakeJson([{ verdict: "confirmed", reason: "r" }]), sessionFactory: perProject });
  expect(review.questions).toEqual(["Unrelated?", "Should a negative threshold turn the alert off?"]);
  expect(review.findings.map((f) => [f.id, f.dependsOn])).toEqual([["F1", "Q2"]]);
  expect(exitCode(review)).toBe(0);
});

test("the same question from two projects is asked once, and both findings wait on it", async () => {
  writeFileSync(join(repo, "services/shared/db.py"), "X = 2\n");
  const agent = new ScriptedAgent(["feed", "pay"].flatMap((p) => [
    [tool("write_file", { path: `services/${p}/${GEN}`,
      content: `import ${p}\ndef test_bad(): assert 0\ndef test_ok(): pass\n` })],
    [text(JSON.stringify({ tests: [], suspected_defects: [{ test: `${GEN}::test_bad`, explanation: `${p} is wrong` }],
      questions: [{ question: p === "feed" ? "Is X meant to be 2?" : "Should X be 2 now?",
        tests: [`${GEN}::test_bad`] }] }))],
  ]));
  const merger = new FakeJson([{ same: [["Q1", "Q2"]] }]);
  const judge = new FakeJson([{ verdict: "confirmed", reason: "r1" }, { verdict: "confirmed", reason: "r2" }]);
  const said: string[] = [];
  const { review } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agent,
    challenger: judge, hunter: merger, hunt: false, sessionFactory: perProject, progress: (m) => said.push(m) });
  expect(review.questions).toEqual(["Is X meant to be 2?"]);
  expect(review.questionProjects).toEqual(["feed"]);
  expect(review.findings.map((f) => [f.id, f.dependsOn])).toEqual([["F1", "Q1"], ["F2", "Q1"]]);
  expect(said).toContain("1 repeated question merged");
  expect(merger.calls).toHaveLength(1);
});

test("each project sees only its part of the change, and files no test names are listed, not called complete",
  async () => {
    writeFileSync(join(repo, "services/pay/pay.py"), "X = 2\n");
    writeFileSync(join(repo, "services/feed/feed.py"), "X = 3\n");
    const agent = new ScriptedAgent([
      [tool("write_file", { path: `services/feed/${GEN}`, content: "import feed\ndef test_ok(): pass\n" })],
      [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))],
      [tool("write_file", { path: `services/pay/${GEN}`, content: "def test_ok(): pass\n" })],
      [text(JSON.stringify({ tests: [{ test: `${GEN}::test_ok`, expects: "ok" }], suspected_defects: [],
        questions: ["Q?"] }))],
      // arnx asks once about pay.py; the reviewer gives a reason instead of a test
      [text(JSON.stringify({ tests: [{ test: `${GEN}::test_ok`, expects: "ok" }], suspected_defects: [],
        questions: ["Q?"], not_tested: [{ file: "pay.py", reason: "needs a live payment gateway" }] }))],
    ]);
    const passing: SessionFactory = async (_cfg, snap, _log, body) =>
      body(new FakeSession(snap, () => [junitXml([[GEN, "test_ok", "passed", ""]]), "1 passed", false]));
    const { review, rdir } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agent,
      challenger: new FakeJson([]), sessionFactory: passing });
    const feedTask = String(agent.calls[0]!.messages[0]!.content);
    expect(feedTask).toContain("services/feed/feed.py");
    expect(feedTask).not.toContain("services/pay/pay.py");
    expect(String(agent.calls[2]!.messages[0]!.content)).not.toContain("services/feed/feed.py");
    expect(String(agent.calls[4]!.messages.at(-1)!.content))
      .toContain("These changed files have no test that refers to them yet: `services/pay/pay.py`");
    expect(String(agent.calls[4]!.messages.at(-1)!.content))
      .toContain("The questions you have asked so far:\n- Q?\nDo not ask them again.");
    expect(agent.calls.length).toBe(5); // feed was covered: no follow-up for it
    expect(review.questions).toEqual(["Q?"]); // the repeated report is not counted twice
    expect(review.untested).toEqual([{ project: "feed", files: [], of: 1 },
      { project: "pay", files: ["services/pay/pay.py"], of: 1,
        reasons: { "services/pay/pay.py": "needs a live payment gateway" } }]);
    expect(exitCode(review)).toBe(0);
    expect(load(rdir)).toEqual(review);
    const md = render(review);
    expect(md).toContain("Partly covered: no arnx test refers to 1 of the 2 changed source files below");
    expect(md).toContain("Not tested by arnx in `pay`: `services/pay/pay.py` (reviewer: needs a live payment gateway).");
    expect(md).not.toContain("Complete:");
    const short = summary(review, "review.md");
    expect(short).toContain("Partly covered: no test refers to 1 of 2 changed source files");
    expect(short).toContain("  Not tested (pay): services/pay/pay.py");
  });

test("projects are tested two at a time, and the report keeps review order", async () => {
  writeFileSync(join(repo, "services/shared/db.py"), "X = 2\n");
  let inFlight = 0, most = 0;
  const overlap: SessionFactory = async (_cfg, snap, _log, body) => {
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 30));
    try {
      return await body(new FakeSession(snap, () => [null, "", false]));
    } finally {
      inFlight--;
    }
  };
  const agent = { model: "claude-sonnet-5-5", calls: 0, async create() {
    this.calls++;
    return { content: [{ type: "text", text: '{"tests": [], "suspected_defects": [], "questions": []}' }],
      stopReason: "end_turn", usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, raw: [] };
  } };
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([]),
    sessionFactory: overlap });
  expect(most).toBe(2);
  expect(review.projects).toEqual(["feed", "pay"]);
  expect(review.projectStats.map((p) => p.name)).toEqual(["feed", "pay"]);
});
