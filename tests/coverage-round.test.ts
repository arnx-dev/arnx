// The coverage follow-up: arnx, not the reviewer, decides when a round is done; and the reviewer is told how the
// project's tests reach their services.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, Workspace } from "../src/agent";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp } from "../src/config";
import { snapshot } from "../src/change";
import { PRICES } from "../src/llm";
import { coverageTask, PROMPT_VERSION, reviewSystem } from "../src/prompts";
import { parseReports } from "../src/report";
import { envTests, runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { FakeJson, fakeFactory, ScriptedAgent, text } from "./helpers/fakes";
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
