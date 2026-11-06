// The coverage follow-up: arnx, not the reviewer, decides when a round is done; and the reviewer is told how the
// project's tests reach their services.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, Workspace } from "../src/agent";
import { getAdapter } from "../src/adapters";
import type { Facts, RoundTools } from "../src/brain";
import { LocalBrain } from "../src/localbrain";
import { filesToAsk } from "../src/untested";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp } from "../src/config";
import { snapshot } from "../src/change";
import { PRICES } from "../src/llm";
import { coverageTask, PROMPT_VERSION, reviewSystem } from "../src/prompts";
import { parseReport, parseReports } from "../src/report";
import { ModelError } from "../src/errors";
import type { Reply } from "../src/llm";
import { envTests, runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { FakeJson, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

test("a follow-up continues the same conversation once, and the round ends on the last reply", async () => {
  const model = new ScriptedAgent([[text("first")], [text("second")]]);
  let asked = 0;
  const r = await runAgent(model, new Workspace(tmp()), { system: "s", user: "u", budgetUsd: 1, prices: PRICES,
    transcript: join(tmp(), "t.jsonl"), followUp: () => (asked++ ? null : "cover more") });
  expect([r.stop, r.finalText, r.earlierTexts]).toEqual(["end_turn", "second", ["first"]]);
  expect(model.calls[1]!.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  expect(model.calls[1]!.messages.at(-1)!.content).toBe("cover more");
});

test("a follow-up cut short still ends the round normally, on the reply before it", async () => {
  const model = new ScriptedAgent([[text("first")]], { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  const r = await runAgent(model, new Workspace(tmp()), { system: "s", user: "u", budgetUsd: 100, prices: PRICES,
    transcript: join(tmp(), "t.jsonl"), maxTurns: 1, followUp: () => "cover more" });
  expect([r.stop, r.finalText, r.earlierTexts]).toEqual(["end_turn", "first", undefined]);
});

test("the coverage request names the files and asks for reasons", () => {
  const t = coverageTask(["services/billing/queries.py", "services/billing/main.py"]);
  expect(t).toContain("`services/billing/queries.py`, `services/billing/main.py`");
  expect(t).toContain('"not_tested": [{"file"');
  expect(PROMPT_VERSION).not.toBe("49ef35d72aa6"); // the reviewer's instructions changed: a new version
});

test("the reviewer is told the project's variables and the project's own tests that use them", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc/tests"), { recursive: true });
  writeFileSync(join(repo, "svc/tests/test_pg.py"), "DB = os.environ.get('TEST_DATABASE_URL')\n");
  writeFileSync(join(repo, "svc/tests/test_plain.py"), "def test_x(): pass\n");
  writeFileSync(join(repo, "svc/conftest.py"), "TEST_DATABASE_URL\n"); // not a test file
  commit(repo, "tests");
  const file = parseReviewFile(`version: 1
services:
  tapepg: {image: postgres:16, ready: pg_isready}
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
    services: [tapepg]
    env: {TEST_DATABASE_URL: "postgresql://app:app@db:5432/app"}
  bare:
    root: bare
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`);
  const [svc, bare] = file.projects;
  const snap = join(tmp(), "snap");
  snapshot(repo, null, snap);
  expect(envTests(snap, svc!)).toEqual(["tests/test_pg.py"]);
  const system = reviewSystem(svc!, envTests(snap, svc!));
  expect(system).toContain("Environment variables the tests see (test values, set for you): `TEST_DATABASE_URL`.");
  expect(system).toContain("whose setup you can copy (connecting, creating tables, planting rows): `tests/test_pg.py`.");
  expect(system).not.toContain("postgresql://"); // names only
  expect(reviewSystem(bare!)).not.toContain("Environment variables"); // unchanged without variables
});

// envTests listed the index while the reviewer reads the review's snapshot: untracked files a review sends (no
// commits yet, or --untracked) were missed, and files .arnxignore leaves out were named.
test("the project's tests that use its variables are found in what the review's snapshot holds", async () => {
  const repo = gitRepo(tmp());
  const yaml = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest {targets}\n" +
    "env: {DATABASE_URL: \"postgresql://app:app@db:5432/app\"}\n";
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(yaml), "Dev", "2026-10-26"));
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "tests/test_committed.py"), "URL = os.environ['DATABASE_URL']\n");
  writeFileSync(join(repo, ".arnxignore"), "tests/test_ignored.py\n");
  commit(repo, "tests");
  writeFileSync(join(repo, "tests/test_staged.py"), "URL = os.environ['DATABASE_URL']\n");
  runGit(repo, "add", "tests/test_staged.py");
  writeFileSync(join(repo, "tests/test_untracked.py"), "URL = os.environ['DATABASE_URL']\n");
  writeFileSync(join(repo, "tests/test_ignored.py"), "URL = os.environ['DATABASE_URL']\n");
  runGit(repo, "add", "-f", "tests/test_ignored.py");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return b + a\n");
  const cfg = parseReviewConfig(yaml);
  const at = (untracked: boolean) => {
    const snap = join(tmp(), `snap-${untracked}`);
    snapshot(repo, null, snap, [], { untracked });
    return envTests(snap, cfg);
  };
  expect(at(false)).toEqual(["tests/test_committed.py", "tests/test_staged.py"]);
  expect(at(true)).toEqual(["tests/test_committed.py", "tests/test_staged.py", "tests/test_untracked.py"]);
  // A review hands the reviewer the files its own snapshot holds.
  const review = async (untracked: boolean) => {
    const agent = new ScriptedAgent([[text('{"tests": []}')], [text('{"tests": []}')]]);
    await runReview(repo, { settings: { ...defaultSettings(), consentAt: "2026-10-26T00:00:00Z" }, untracked,
      agentModel: agent, challenger: new FakeJson([]),
      sessionFactory: fakeFactory(() => [junitXml([]), "", false]) });
    return agent.calls[0]!.system;
  };
  expect(await review(true)).toContain("`tests/test_committed.py`, `tests/test_staged.py`, `tests/test_untracked.py`");
  expect(await review(false)).not.toContain("test_untracked.py");
});

test("a follow-up's report repeats the first: entries count once, not_tested comes from the last", () => {
  const first = JSON.stringify({ tests: [{ test: "a", expects: "x" }], questions: ["Q1?"], suspected_defects: [] });
  const second = JSON.stringify({ tests: [{ test: "a", expects: "x" }, { test: "b", expects: "y" }],
    questions: ["Q1?", "Q2?"], suspected_defects: [], not_tested: [{ file: "main.py", reason: "wiring" }] });
  const r = parseReports([first, second]);
  expect(r.tests).toHaveLength(2);
  expect(r.questions).toEqual(["Q1?", "Q2?"]);
  expect(r.not_tested).toEqual([{ file: "main.py", reason: "wiring" }]);
  expect(parseReports([second, "not json"]).tests).toHaveLength(2); // a broken last reply loses nothing
});

test("a failure before the first report is not a follow-up cut short", async () => {
  class FailsSecond extends ScriptedAgent {
    override async create(a: Parameters<ScriptedAgent["create"]>[0]): Promise<Reply> {
      if (this.calls.length === 1) throw new ModelError("HTTP 529: overloaded");
      return super.create(a);
    }
  }
  const run = (first: string) => runAgent(new FailsSecond([[text(first)]]), new Workspace(tmp()), { system: "s",
    user: "u", budgetUsd: 100, prices: PRICES, followUp: () => "write the tests",
    isReport: (t) => parseReport(t).tests.length > 0 });
  const hunt = await run("S1: suspect");
  expect(hunt.stop.startsWith("api_error")).toBe(true);
  expect(hunt.cut).toContain("529");
  const report = await run('{"tests": [{"test": "a::b"}]}');
  expect([report.stop, report.finalText]).toEqual(["end_turn", '{"tests": [{"test": "a::b"}]}']);
  expect(report.cut).toContain("529");
});

// The coverage nudge is limited, not removed: few lines, test-named and generated files are not asked about; at most
// three files; nothing past half the round's budget; and the follow-up has a spend limit of its own.
const PY = getAdapter("python");
/** A diff section adding `n` code lines to `path`. */
const added = (path: string, n: number, line = (i: number) => `value_${i} = compute(${i})`) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -0,0 +1,${n} @@\n` +
  Array.from({ length: n }, (_, i) => `+${line(i)}\n`).join("");
const ASK = { minLines: 20, max: 3 };

test("a file with few added lines gets no follow-up", () => {
  const diff = added("small.py", 19) + added("big.py", 20);
  expect(filesToAsk(["small.py", "big.py"], diff, PY, ASK)).toEqual(["big.py"]);
  // Blank lines, comments and imports are not counted.
  const padded = added("padded.py", 30, (i) => (i % 3 === 0 ? "" : i % 3 === 1 ? "# a note" : "import os"));
  expect(filesToAsk(["padded.py"], padded, PY, ASK)).toEqual([]);
  expect(filesToAsk(["gone.py"], "", PY, ASK)).toEqual([]);
});

test("at most three files, largest first", () => {
  const diff = added("a.py", 25) + added("b.py", 60) + added("c.py", 40) + added("d.py", 30) + added("e.py", 21);
  expect(filesToAsk(["a.py", "b.py", "c.py", "d.py", "e.py"], diff, PY, ASK)).toEqual(["b.py", "c.py", "d.py"]);
});

test("test-named and generated files are never asked about", () => {
  const names = ["db_test.py", "FooterSpec.tsx", "WidgetTest.java", "api.generated.ts", "x_pb2.py", "__snapshots__/ui.ts", "real.py"];
  const diff = names.map((n) => added(n, 50)).join("");
  expect(filesToAsk(names, diff, PY, ASK)).toEqual(["real.py"]);
});

const REPORT = JSON.stringify({ tests: [{ test: "tests/arnx_generated/test_a.py::test_a", expects: "x" }],
  suspected_defects: [], questions: [] });
const FACTS: Facts = { untestedFiles: ["b.py"], dbUntested: [], generatedFiles: [] };
const roundTools = (): RoundTools => ({ tools: () => new Workspace(tmp(), { writeDir: "tests/arnx_generated",
  runTests: () => "" }).tools(), call: async () => "ok", facts: () => FACTS });
const reviewInput = (budgetUsd: number) => ({ cfg: parseReviewConfig("version: 1\nimage: i\ntest_command: pytest {targets}\n"),
  diff: added("b.py", 40), scoped: false, scope: { owned: ["b.py"], used: [] }, envTests: [], maxQuestions: 3,
  dbNames: [], budgetUsd, outDir: tmp() });

test("no follow-up past half the round's budget", async () => {
  // One reply costs $0.004: of a $0.006 budget that is past half.
  const spent = new ScriptedAgent([[text(REPORT)], [text(REPORT)]]);
  await new LocalBrain({ agentModel: spent, prices: PRICES }).agentRound("review", reviewInput(0.006),
    Promise.resolve(roundTools()));
  expect(spent.calls).toHaveLength(1);
  // The same round with room left still asks.
  const room = new ScriptedAgent([[text(REPORT)], [text(REPORT)]]);
  await new LocalBrain({ agentModel: room, prices: PRICES }).agentRound("review", reviewInput(0.05),
    Promise.resolve(roundTools()));
  expect(room.calls).toHaveLength(2);
});

test("a follow-up stops at its limit and the round keeps its report", async () => {
  // Each reply costs $0.04; the follow-up may spend $0.10 more than the round had when it began.
  const usage = { input: 20_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  const read = () => [tool("read_file", { path: "b.py" })];
  const model = new ScriptedAgent([[text(REPORT)], read(), read(), read(), read(), read(), [text(REPORT + " ")]], usage);
  const r = await new LocalBrain({ agentModel: model, prices: PRICES }).agentRound("review", reviewInput(5),
    Promise.resolve(roundTools()));
  expect(model.calls).toHaveLength(4); // the report, then replies until $0.14 is reached
  expect([r.agent.stop, r.agent.finalText, r.agent.cut]).toEqual(["end_turn", REPORT, "budget"]);
});
