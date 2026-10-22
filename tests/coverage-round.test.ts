// The coverage follow-up: arnx, not the reviewer, decides when a round is done; and the reviewer is told how the
// project's tests reach their services.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, Workspace } from "../src/agent";
import { parseReviewFile } from "../src/config";
import { PRICES } from "../src/llm";
import { coverageTask, PROMPT_VERSION, reviewSystem } from "../src/prompts";
import { parseReports } from "../src/report";
import { envTests } from "../src/reviewer";
import { ScriptedAgent, text } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
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
  expect(envTests(repo, svc!)).toEqual(["tests/test_pg.py"]);
  const system = reviewSystem(svc!, envTests(repo, svc!));
  expect(system).toContain("Environment variables the tests see (test values, set for you): `TEST_DATABASE_URL`.");
  expect(system).toContain("whose setup you can copy (connecting, creating tables, planting rows): `tests/test_pg.py`.");
  expect(system).not.toContain("postgresql://"); // names only
  expect(reviewSystem(bare!)).not.toContain("Environment variables"); // unchanged without variables
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
