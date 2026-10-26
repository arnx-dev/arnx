// A whole review through CloudBrain against a small scripted fake of arnx cloud's contract, with the fake Docker
// session: the same findings and report as LocalBrain gives for the same script, usage named by tier and harness and
// never by model, the contract's requests (ids, turns, facts after a final, finish), and what each failure means.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CloudClient, UNAVAILABLE } from "../src/cloud";
import { CloudBrain, clipOutput, finishStop } from "../src/cloudbrain";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { SetupRequired } from "../src/errors";
import { type Finding, exitCode, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import { CLOUD_URL, defaultSettings, writeSettings } from "../src/settings";
import { writeCredentials } from "../src/cloud";
import { Cli } from "./helpers/cli";
import { type CloudScript, type FakeCloud, fakeCloud, HARNESS, type StepScript, TOKEN } from "./helpers/cloudfake";
import { FakeJson, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";
const SOURCE = "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_zero():\n    assert add(0, 0) == 0\n";
const REPORT = { tests: [{ test: `${GEN}::test_add`, expects: "add sums", suspect: "S1" },
  { test: `${GEN}::test_zero`, expects: "zero is neutral" }],
suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts instead of adding." }],
questions: [{ question: "Should add accept strings?", tests: [] }] };
const S1 = { id: "S1", file: "app.py", line: 2, claim: "add subtracts", by: "reviewer" };
const HUNT = { lists: [{ source: "reviewer", suspects: [S1] }, { source: "second", suspects: [{ ...S1, by: "second" },
  { id: "S2", file: "app.py", line: 1, claim: "no type check", by: "second" }] }], tested: ["S1"],
merged: [{ source: "reviewer", index: 0, into: "S1", duplicate: false },
  { source: "second", index: 0, into: "S1", duplicate: true }],
dropped: [{ source: "second", index: 1, reason: "over-limit" }] };
/** The brain's round: look, write and run, report (with the hunt's record), done. */
const ROUND: StepScript[] = [
  { type: "actions", text: "Looking first.", actions: [{ name: "read_file", input: { path: "app.py" } }] },
  { type: "actions", actions: [{ name: "write_file", input: { path: GEN, content: SOURCE } },
    { name: "run_tests", input: {} }] },
  { type: "final", report: REPORT, suspects: [S1], hunt: HUNT },
  { type: "done", stop: "end_turn" },
];
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-20T00:00:00Z" };
const LABEL = `arnx:medium/${HARNESS}`;
const runs = (): [string | null, string, boolean] =>
  [junitXml([[GEN, "test_add", "failed", "assert -1 == 5"], [GEN, "test_zero", "passed", ""]]), "", false];

const tmp = useTmp();
let repo = "";
let cloud: FakeCloud | null = null;
beforeEach(() => {
  repo = gitRepo(tmp());
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, stamp(parseReviewConfig(YAML), "Dev", "2026-10-20"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
});
afterEach(() => {
  cloud?.stop();
  cloud = null;
});

/** The first round's start bills the reviewer and the second hunter; every other step the reviewer. */
const billed: CloudScript["billed"] = (_path, step) => step?.type === "actions" && step.text === "Looking first."
  ? [{ role: "reviewer", calls: 1, cost_micro_usd: 40_000 }, { role: "second-hunt", calls: 1, cost_micro_usd: 25_000 }]
  : [{ role: "reviewer", calls: 1, cost_micro_usd: 20_000 }];

function brainFor(c: FakeCloud, said: string[] = []): CloudBrain {
  return new CloudBrain({ client: new CloudClient(c.url, { token: TOKEN, delays: [0] }), tier: "medium",
    progress: (m) => said.push(m) });
}

const shape = (fs: Finding[]) => fs.map((f) => ({ id: f.id, testId: f.testId, func: f.func, file: f.file,
  message: f.message, explanation: f.explanation, verdict: f.verdict, project: f.project }));

test("a scripted review through arnx cloud: the same findings and report as the local brain", async () => {
  const c = cloud = fakeCloud({ rounds: { "*": ROUND.map((s) => ({ ...s })) }, billed });
  const said: string[] = [];
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, brain: brainFor(c, said), hunt: true,
    sessionFactory: fakeFactory(runs), progress: (m) => said.push(m) });

  // The same script on the local brain: the same tool calls, the same report.
  const local = await runReview(repo, { settings: SETTINGS, sessionFactory: fakeFactory(runs),
    agentModel: new ScriptedAgent([[tool("read_file", { path: "app.py" })],
      [tool("write_file", { path: GEN, content: SOURCE }), tool("run_tests")], [text(JSON.stringify(REPORT))]]),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]) });
  expect(shape(review.findings)).toEqual(shape(local.review.findings));
  expect(review.findings).toHaveLength(1);
  expect([review.questions, review.passed, review.testsWritten, review.checked, review.stop, exitCode(review)])
    .toEqual([local.review.questions, local.review.passed, local.review.testsWritten, local.review.checked,
      local.review.stop, exitCode(local.review)]);
  expect(review.findings[0]!.verdict).toBe("confirmed");
  expect(review.findings[0]!.suspect).toBe("S1");
  expect(review.suspects!.map((s) => [s.id, s.outcome])).toEqual([["S1", "proven"]]);

  // The brain's work goes by its tier and harness, one line per role; no model is named anywhere.
  expect([review.reviewer, review.challenger, review.promptVersion]).toEqual([LABEL, LABEL, LABEL]);
  expect(review.usage.map((u) => [u.model, u.calls, u.costUsd])).toEqual([
    [`${LABEL}/reviewer`, 3, 0.08], [`${LABEL}/challenge`, 1, 0.03], [`${LABEL}/explain`, 1, 0.02],
    [`${LABEL}/second-hunt`, 1, 0.025], [`${LABEL}/merge-questions`, 1, 0.01]]);
  expect(review.costUsd).toBeCloseTo(0.165, 10);
  const written = [readFileSync(join(rdir, "review.json"), "utf8"), readFileSync(join(rdir, "review.md"), "utf8"),
    readFileSync(join(rdir, "events.jsonl"), "utf8"), readFileSync(join(repo, ".arnx", "usage.jsonl"), "utf8")
      .trim().split("\n").at(0)!];
  for (const w of written) expect(w).not.toMatch(/claude|gpt|anthropic:|openai:|sonnet|haiku/i);
  expect(readFileSync(join(rdir, "review.md"), "utf8")).toContain("- Models: arnx cloud medium\n" +
    "- Billed $0.17 by arnx cloud · ");
  expect(readFileSync(join(rdir, "review.md"), "utf8")).not.toMatch(/h-2026|harness/);

  // The hunt's record became hunt.json and the hunt events, as with the local brain.
  const hunt = JSON.parse(readFileSync(join(rdir, "hunt.json"), "utf8"));
  expect([hunt.reviewer.length, hunt.second.length, hunt.tested.map((s: { id: string }) => s.id)]).toEqual([1, 2, ["S1"]]);
  const events = readFileSync(join(rdir, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const types = events.map((e) => e.type);
  expect(types.filter((t) => t.startsWith("hunt."))).toEqual(["hunt.list", "hunt.list", "hunt.suspect", "hunt.merged",
    "hunt.merged", "hunt.dropped"]);
  expect(events.find((e) => e.type === "review.started").data.models.reviewer).toBe(LABEL);
  expect(events.filter((e) => e.type === "model.call").every((e) => e.data.provider === "arnx")).toBe(true);

  // What the CLI sent: the change summary with a key, the round's inputs, results by id, facts after the final.
  const create = c.seen.find((x) => x.path === "/v1/reviews")!;
  expect(create.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  expect(create.body).toMatchObject({ effort: "medium", mode: { models: true, tests: false },
    budget_cap_micro_usd: 3_000_000, change: { files_changed: ["app.py"], projects: [{ name: "main",
      language: "python", runner: "pytest" }] } });
  const start = c.seen.find((x) => x.path.endsWith("/agent"))!;
  expect(start.headers.accept).toBe("text/event-stream");
  expect(start.body).toMatchObject({ max_questions: 5, hunt: true,
    scope: { changed_owned: ["app.py"], changed_used: [], scoped: false },
    facts: { language: "python", write_dir: "tests/arnx_generated", words: { runner: "pytest" } } });
  expect(start.headers["idempotency-key"]).toMatch(/^[0-9a-f-]{36}$/);
  // The review's id on arnx cloud is kept with the review (the local brain has none to keep).
  expect(JSON.parse(readFileSync(join(rdir, "state.json"), "utf8")).cloud_review_id).toBe("rev_test00000001");
  expect(Object.keys(JSON.parse(readFileSync(join(local.rdir, "state.json"), "utf8")))).toEqual(["change",
    "diff_sha256"]);
  expect((create.body as { resume_of: unknown }).resume_of).toBeNull();
  expect(typeof (start.body as { context_pack: string }).context_pack).toBe("string");
  const steps = c.seen.filter((x) => x.path.endsWith("/agent/steps")).map((x) => x.body as Record<string, unknown>);
  expect(steps.map((s) => [s.turn, (s.results as { id: string }[]).map((r) => r.id)])).toEqual([[1, ["t1c1"]],
    [2, ["t2c1", "t2c2"]], [3, []]]);
  const read = (steps[0]!.results as { output: string; is_error: boolean }[])[0]!;
  expect([read.output, read.is_error]).toEqual(["1\tdef add(a, b):\n2\t    return a - b", false]);
  expect(steps[2]!.facts).toEqual({ untested_files: [], db_untested: [], generated_files: [GEN] });
  const judge = c.seen.find((x) => x.path.endsWith("/judge"))!.body as Record<string, unknown>;
  expect(judge.findings).toEqual([{ id: "F1", project: "main", test_id: `${GEN}::test_add`, test_file: GEN,
    failure: review.findings[0]!.message, explanation: "add subtracts instead of adding.", suspect: "S1",
    before: null, depends_on: null }]);
  // The whole change goes with the judge (here one project's, so the same as its diff).
  expect(judge.diff).toBe((judge.diffs as Record<string, string>).main!);
  expect(judge.questions).toEqual([{ id: "Q1", project: "main", question: "Should add accept strings?" }]);
  expect(Object.keys(judge.test_sources as object)).toEqual([GEN]);
  expect(c.seen.find((x) => x.path.endsWith("/finish"))!.body).toEqual({ stop: "completed", projects_reviewed: 1,
    tests_written: 2, passed: 1, findings: 1, flaky: 0, seconds: review.seconds });
  // Progress lines streamed by the brain reached the user, and so did the bill.
  expect(said).toContain("main: hunting");
  expect(said).toContain("merging questions");
  expect(said.some((m) => m.includes("billed $0.17 for this review"))).toBe(true);
  // The terminal names arnx cloud by its tier only: the harness version stays internal (review.json, events.jsonl).
  expect(said.filter((m) => m.startsWith("arnx cloud (")).map((m) => m.slice(0, m.indexOf(")") + 1)))
    .toEqual(["arnx cloud (arnx:medium)", "arnx cloud (arnx:medium)"]);
  expect(said.filter((m) => m.includes(HARNESS))).toEqual([]);
});

test("a round the budget stopped with no final: the runs keep what they found, the round stops at the budget", async () => {
  const c = cloud = fakeCloud({ rounds: { "*": [ROUND[0]!, ROUND[1]!, { type: "done", stop: "budget" }] } });
  const { review } = await runReview(repo, { settings: SETTINGS, brain: brainFor(c), sessionFactory: fakeFactory(runs) });
  expect(review.stop).toBe("budget");
  expect(review.projectStats?.[0]?.stop).toBe("budget");
  // Its failing test is still a finding (with no explanation: there is no report).
  expect(review.findings.map((f) => [f.func, f.explanation])).toEqual([["test_add", ""]]);
  expect(c.seen.find((x) => x.path.endsWith("/finish"))!.body).toMatchObject({ stop: "budget" });
});

test("a final, then a follow-up the budget cut: a budget stop, said in the report with how to go on", async () => {
  const c = cloud = fakeCloud({ rounds: { "*": [...ROUND.slice(0, 3), { type: "done", reason: "budget", stop: "budget" }] } });
  const { review } = await runReview(repo, { settings: SETTINGS, brain: brainFor(c), sessionFactory: fakeFactory(runs) });
  expect(review.projectStats?.[0]?.stop).toBe("budget");
  expect(c.seen.find((x) => x.path.endsWith("/finish"))!.body).toMatchObject({ stop: "budget" });
  expect(summary(review, "review.md")).toContain("the review budget ran out before the reviewer finished (raise " +
    "`review_usd` under [budget] in .arnx/config.toml, or top up: arnx credits, then run arnx review again)");
});

test("409 turn_conflict sends the same turn once more", async () => {
  const c = cloud = fakeCloud({ rounds: { "*": ROUND.map((s) => ({ ...s })) },
    fail: { "POST /v1/reviews/*/projects/*/agent/steps": [{ status: 409, body: { code: "turn_conflict",
      message: "expected turn 1", expected_turn: 1 } }] } });
  const said: string[] = [];
  const { review } = await runReview(repo, { settings: SETTINGS, brain: brainFor(c), sessionFactory: fakeFactory(runs),
    progress: (m) => said.push(m) });
  expect(review.findings).toHaveLength(1);
  const turns = c.seen.filter((x) => x.path.endsWith("/agent/steps")).map((x) => (x.body as { turn: number }).turn);
  expect(turns).toEqual([1, 1, 2, 3]);
  expect(said.some((m) => m.includes("sending it again"))).toBe(true);
});

test("a review that fails is closed with stop failed", async () => {
  const c = cloud = fakeCloud({ rounds: { "*": ROUND.map((s) => ({ ...s })) } });
  const broken = async () => { throw new Error("docker went away"); };
  await expect(runReview(repo, { settings: SETTINGS, brain: brainFor(c), sessionFactory: broken }))
    .rejects.toThrow(/docker went away/);
  expect(c.seen.find((x) => x.path.endsWith("/finish"))!.body).toMatchObject({ stop: "failed", projects_reviewed: 0 });
});

test("a review whose environment runs no test never starts the round: nothing billed", async () => {
  const c = cloud = fakeCloud({ rounds: { "*": ROUND.map((s) => ({ ...s })) }, billed });
  const broken = (): [string | null, string, boolean] => [null, "error: failed to build `dep`", false];
  await expect(runReview(repo, { settings: SETTINGS, brain: brainFor(c), hunt: true,
    sessionFactory: fakeFactory(broken, [], { probe: "ignore" }) }))
    .rejects.toThrow(/the test environment runs no test at this commit/);
  expect(c.seen.some((x) => x.path.endsWith("/agent"))).toBe(false);
  expect(c.seen.find((x) => x.path.endsWith("/finish"))!.body).toMatchObject({ stop: "failed", projects_reviewed: 0 });
});

test("a tool call the CLI does not run is answered as an error result", async () => {
  const c = cloud = fakeCloud({ rounds: { "*": [{ type: "actions", actions: [{ name: "try_project",
    input: { yaml: "x" } }, { name: "read_file", input: { path: "../../etc/passwd" } }] },
  { type: "done", stop: "end_turn" }] } });
  await runReview(repo, { settings: SETTINGS, brain: brainFor(c), sessionFactory: fakeFactory(runs) });
  const results = (c.seen.find((x) => x.path.endsWith("/agent/steps"))!.body as { results: { output: string;
    is_error: boolean }[] }).results;
  expect(results.map((r) => r.is_error)).toEqual([true, true]);
  expect(results[0]!.output).toContain("unknown tool try_project");
  expect(results[1]!.output).toContain("path outside the repository");
});

/** A repository set up for arnx models, logged in to the fake. */
function cloudRepo(c: FakeCloud): Cli {
  const home = join(tmp(), "home");
  writeSettings(repo, { ...SETTINGS, cloudConsentAt: "2026-10-20T00:00:00Z",
    cloud: { models: true, tests: false, effort: "medium" } });
  writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
  return new Cli({ cwd: repo, env: { HOME: home, ARNX_CLOUD_URL: c.url }, sleep: async () => {} });
}

test("402 at the review's start stops with exit 3, the balance and the top-up link", async () => {
  const c = cloud = fakeCloud({ fail: { "POST /v1/reviews": [{ status: 402, body: { code: "insufficient_credits",
    message: "Your arnx cloud balance is too low to start a review.", balance_micro_usd: 120_000,
    needed_micro_usd: 380_000, topup_url: "https://arnx.dev/credits" } }] } });
  const cli = cloudRepo(c);
  expect(await cli.run("review", "--quiet")).toBe(3);
  expect(cli.stderr).toContain("too low to start a review. Balance $0.12; $0.38 more lets this start. Top up at " +
    "https://arnx.dev/credits");
  expect(c.seen.some((x) => x.path.endsWith("/agent"))).toBe(false);
});

test("503 at the review's start stops with exit 2, naming the brain (no keys set: no hint)", async () => {
  const down = { status: 503, body: { code: "unavailable", message: "arnx cloud brain is unavailable",
    component: "brain", retry_after: 0 } };
  const c = cloud = fakeCloud({ fail: { "POST /v1/reviews": [down, down, down] } });
  const cli = cloudRepo(c);
  expect(await cli.run("review", "--quiet")).toBe(2);
  // ANTHROPIC_API_KEY is not set: nothing about the user's own keys.
  expect(cli.stderr).toBe(`arnx: arnx cloud unavailable: its brain at ${c.url} is down (arnx cloud brain is ` +
    "unavailable). Try again later.");
  // Retried twice (Retry-After 0), the create carrying the same Idempotency-Key each time.
  const creates = c.seen.filter((x) => x.path === "/v1/reviews");
  expect(creates).toHaveLength(3);
  expect(new Set(creates.map((x) => x.headers["idempotency-key"])).size).toBe(1);
});

test("review --cloud while the default address does not answer: unavailable, --local for this run (exit 2)", async () => {
  const home = join(tmp(), "home");
  writeSettings(repo, { ...SETTINGS, cloudConsentAt: "2026-10-20T00:00:00Z" });
  writeCredentials({ HOME: home }, { url: CLOUD_URL, token: TOKEN });
  const tried: string[] = [];
  const cli = new Cli({ cwd: repo, env: { HOME: home, ANTHROPIC_API_KEY: "a" }, sleep: async () => {},
    fetch: async (u) => {
      tried.push(u);
      throw new Error("Unable to connect. Is the computer able to access the url?");
    } });
  expect(await cli.run("review", "--cloud", "--quiet")).toBe(2);
  expect(cli.err).toEqual([`arnx: ${UNAVAILABLE(CLOUD_URL)}\nTo use your own keys for this run: --local`]);
  expect(tried[0]).toBe(`${CLOUD_URL}/v1/reviews`);
});

test("arnx models with no login stops before anything is sent", async () => {
  const c = cloud = fakeCloud();
  writeSettings(repo, { ...SETTINGS, cloudConsentAt: "2026-10-20T00:00:00Z",
    cloud: { models: true, tests: false, effort: "low" } });
  const cli = new Cli({ cwd: repo, env: { HOME: join(tmp(), "nobody"), ARNX_CLOUD_URL: c.url } });
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toContain("run `arnx login`"); // doctor's check, before cloudBrain's own stop
  expect(c.seen).toHaveLength(0);
});

test("small pieces: the finish stop, a tool output cut to the brain's limit", () => {
  expect([finishStop("end_turn"), finishStop("budget"), finishStop("api_error: boom")]).toEqual(["completed", "budget",
    "api_error"]);
  const cut = clipOutput("x".repeat(1000), 100);
  expect(Buffer.byteLength(cut)).toBeLessThanOrEqual(100);
  expect(cut).toContain("output cut at 100 bytes");
  expect(clipOutput("short", 100)).toBe("short");
});

test("a project round's start that fails on the way is sent once more with the same Idempotency-Key", async () => {
  // First a 503 before the round ran, then an answer lost after it ran: the third start gets that round's answer.
  const c = cloud = fakeCloud({ rounds: { "*": ROUND.map((s) => ({ ...s })) },
    fail: { "POST /v1/reviews/*/projects/*/agent": [{ status: 503, body: { code: "unavailable", message: "busy",
      component: "brain", retry_after: 0 } }] } });
  const { review } = await runReview(repo, { settings: SETTINGS, brain: brainFor(c), hunt: true,
    sessionFactory: fakeFactory(runs) });
  expect(review.findings).toHaveLength(1);
  const starts = c.seen.filter((x) => x.path.endsWith("/agent"));
  expect(starts).toHaveLength(2);
  expect(new Set(starts.map((x) => x.headers["idempotency-key"])).size).toBe(1);
  expect(c.roundsStarted()).toBe(1);

  // A start whose answer is cut off after the round started: the retry is answered from that round (turn 1, not a
  // second round), and only once.
  cloud.stop();
  const d = cloud = fakeCloud({ rounds: { "*": ROUND.map((s) => ({ ...s })) },
    cut: { "POST /v1/reviews/*/projects/*/agent": 1 } });
  const again = await runReview(repo, { settings: SETTINGS, brain: brainFor(d), hunt: true,
    sessionFactory: fakeFactory(runs) });
  expect(again.review.findings).toHaveLength(1);
  const retried = d.seen.filter((x) => x.path.endsWith("/agent"));
  expect(retried).toHaveLength(2);
  expect(retried[0]!.headers["idempotency-key"]).toBe(retried[1]!.headers["idempotency-key"]!);
  expect(d.roundsStarted()).toBe(1);
  expect(d.seen.filter((x) => x.path.endsWith("/agent/steps")).map((x) => (x.body as { turn: number }).turn))
    .toEqual([1, 2, 3]);

  // Two failures in a row: the start is not sent a third time.
  cloud.stop();
  const e = cloud = fakeCloud({ rounds: { "*": ROUND.map((s) => ({ ...s })) },
    cut: { "POST /v1/reviews/*/projects/*/agent": 2 } });
  await expect(runReview(repo, { settings: SETTINGS, brain: brainFor(e), hunt: true,
    sessionFactory: fakeFactory(runs) })).rejects.toThrow(`arnx cloud unavailable: no answer from ${e.url}. Check your ` +
    "connection or try again later.");
  expect(e.seen.filter((x) => x.path.endsWith("/agent"))).toHaveLength(2);
});

test("--no-hunt starts the round with hunt false and no hunt inputs", async () => {
  const c = cloud = fakeCloud({ rounds: { "*": [ROUND[1]!, { type: "final", report: REPORT }, { type: "done",
    stop: "end_turn" }] } });
  await runReview(repo, { settings: SETTINGS, brain: brainFor(c), sessionFactory: fakeFactory(runs) });
  const start = c.seen.find((x) => x.path.endsWith("/agent"))!.body as Record<string, unknown>;
  expect([start.hunt, start.context_pack, start.changed_definitions, start.parts]).toEqual([false, "", "",
    undefined]);
});

test("judge sends the whole change and each finding's question link; setup sends --project and --add", async () => {
  const c = cloud = fakeCloud();
  const brain = brainFor(c);
  await brain.start({ files: ["app.py"], added: 1, removed: 1, diffSha256: "0".repeat(64), budgetUsd: 1,
    projects: [{ name: "main", language: "python", runner: "pytest" }] });
  const f = (id: string, dependsOn?: string): Finding => ({ id, testId: `${GEN}::test_${id}`, func: `test_${id}`,
    file: GEN, message: "assert 1 == 2", explanation: "", verdict: null, reason: "", project: "main",
    ...(dependsOn ? { dependsOn } : {}) });
  await brain.judge([f("F1", "Q1"), f("F2"), f("F3", "Q9")], ["Should add accept strings?"], { main: "MAIN DIFF" },
    { diff: "WHOLE DIFF", sources: { [GEN]: SOURCE }, maxQuestions: 5, budgetLeft: () => 1, trace: () => {} });
  const judge = c.seen.find((x) => x.path.endsWith("/judge"))!.body as { diff: string;
    findings: { id: string; depends_on: string | null }[] };
  expect(judge.diff).toBe("WHOLE DIFF");
  // A link to a question that was not sent is no link.
  expect(judge.findings.map((x) => [x.id, x.depends_on])).toEqual([["F1", "Q1"], ["F2", null], ["F3", null]]);

  const setup = (input: Record<string, unknown>) => brain.agentRound("setup", { hints: "", withheld: "", current: "",
    budgetUsd: 1, ...input }, Promise.resolve({ tools: () => [], call: async () => "" }));
  await setup({ project: "svc" });
  await setup({ add: true });
  await setup({});
  expect(c.seen.filter((x) => x.path === "/v1/setup").map((x) => {
    const b = x.body as { project: unknown; add: unknown };
    return [b.project, b.add];
  })).toEqual([["svc", false], [null, true], [null, false]]);
  // Withheld files go as their paths (older servers) and with their label and line, never their content.
  await setup({ withheldFiles: [{ path: "config/prod.env", label: "AWS key", line: 3 }] });
  const last = c.seen.filter((x) => x.path === "/v1/setup").at(-1)!.body as { withheld: unknown; withheld_files: unknown };
  expect([last.withheld, last.withheld_files]).toEqual([["config/prod.env"],
    [{ path: "config/prod.env", label: "AWS key", line: 3 }]]);
});

test("--resume names the cloud review it continues: its id was kept in state.json", async () => {
  const c = cloud = fakeCloud({ rounds: { "*": ROUND.map((s) => ({ ...s })) } });
  const broken = async () => { throw new Error("docker went away"); };
  await expect(runReview(repo, { settings: SETTINGS, brain: brainFor(c), sessionFactory: broken }))
    .rejects.toThrow(/docker went away/);
  expect((c.seen.find((x) => x.path === "/v1/reviews")!.body as { resume_of: unknown }).resume_of).toBeNull();
  cloud.stop();
  const d = cloud = fakeCloud({ rounds: { "*": ROUND.map((s) => ({ ...s })) } });
  const { rdir } = await runReview(repo, { settings: SETTINGS, brain: brainFor(d), sessionFactory: fakeFactory(runs),
    resume: true });
  expect((d.seen.find((x) => x.path === "/v1/reviews")!.body as { resume_of: unknown }).resume_of)
    .toBe("rev_test00000001");
  expect(JSON.parse(readFileSync(join(rdir, "state.json"), "utf8")).cloud_review_id).toBe("rev_test00000001");
});

test("a hold below the cap (the balance allows less) is said once; a full hold says nothing more", async () => {
  const c = cloud = fakeCloud(); // its hold is the cap, at most $2.00
  const start = (budgetUsd: number) => ({ files: ["app.py"], added: 1, removed: 1, diffSha256: "0".repeat(64), budgetUsd,
    projects: [{ name: "main", language: "python", runner: "pytest" }] });
  const capped: string[] = [];
  await brainFor(c, capped).start(start(3));
  expect(capped.filter((m) => m.includes("caps this review"))).toEqual(["Your arnx cloud balance caps this review at " +
    "$2.00 (your cap is $3.00): it may stop early; `arnx credits` tops up"]);
  const full: string[] = [];
  await brainFor(c, full).start(start(1));
  expect(full.some((m) => m.includes("caps this review"))).toBe(false);
});
