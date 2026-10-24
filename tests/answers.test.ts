// Answer rounds: one per answered question, several at once, each sent only its project's part of the change.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeAnswerRunner, reportedFiles } from "../src/accept";
import { getAdapter } from "../src/adapters";
import { loadReviewFile, parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings, parseModelRef } from "../src/settings";
import { FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { junitXml } from "./helpers/junit";
import { writeDirOf } from "../src/testround";
import { commit, gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();

test("an answer round is sent only its project's part of the change", async () => {
  const repo = gitRepo(tmp());
  for (const p of ["services/pay/pay.py", "services/feed/feed.py", "services/shared/db.py", "infra/main.tf"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "X = 1\n");
  }
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  commit(repo, "layout");
  const file = (p: string, t: string) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n-X = 1\n+${t}\n`;
  const diff = file("services/pay/pay.py", "PAY_CHANGE") + file("services/feed/feed.py", "FEED_CHANGE");
  const agent = new ScriptedAgent([[text('{"tests": []}')]]);
  const session: SessionFactory = async (_c, snap, _l, body) => body(new FakeSession(snap, () => [null, "", false]));
  const run = makeAnswerRunner(repo, loadReviewFile(repo), { ...defaultSettings(), consentAt: "x" }, agent, session);
  await run("Q1", "Should pay round up?", "yes", diff, join(tmp(), "out"), "pay");
  const sent = String(agent.calls[0]!.messages[0]!.content);
  expect(sent).toContain("PAY_CHANGE");
  expect(sent).not.toContain("FEED_CHANGE");
});

test("answer_model is read from the config and written back", () => {
  const s = { ...defaultSettings(), answerModel: parseModelRef("anthropic:claude-haiku-5-5") };
  expect(s.answerModel.model).toBe("claude-haiku-5-5");
});

// Seen on arnx's own review: the answer agent wrote a scratch file ("debug-notmarked.test.ts", expect(1).toBe(1)) while
// debugging, then named only its real test in its final reply; accept kept the scratch file as a lock.
test("an answer keeps only the test files its final reply names, with their support files", () => {
  const files = { "t/answers/not-marked.test.ts": "real", "t/answers/debug-notmarked.test.ts": "scratch",
    "t/answers/arnx-helpers.ts": "helper" };
  const reply = '{"tests": [{"test": "t/answers/not-marked.test.ts::lists the .each test", "expects": "it is named"}]}';
  expect(Object.keys(reportedFiles(files, [reply], getAdapter("typescript"))).sort())
    .toEqual(["t/answers/arnx-helpers.ts", "t/answers/not-marked.test.ts"]);
});

test("an answer whose reply names no file it wrote keeps every file, as before", () => {
  const files = { "t/answers/test_a.py": "a", "t/answers/test_b.py": "b" };
  const py = getAdapter("python");
  expect(reportedFiles(files, ["not json"], py)).toEqual(files);
  expect(reportedFiles(files, ['{"tests": [{"test": "elsewhere/test_x.py::t"}]}'], py)).toEqual(files);
});

test("an answer round returns only the files its reply names: a scratch test written along the way is dropped", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "services", "pay"), { recursive: true });
  writeFileSync(join(repo, "services", "pay", "pay.py"), "X = 1\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  commit(repo, "layout");
  const file = loadReviewFile(repo);
  const base = writeDirOf(file.projects.find((p) => p.name === "pay")!, "answers");
  const agent = new ScriptedAgent([
    [tool("write_file", { path: `${base}/test_scratch.py`, content: "def test_s():\n    assert 1 == 1\n" }),
      tool("write_file", { path: `${base}/test_rounds.py`, content: "def test_r():\n    assert True\n" })],
    [text(`{"tests": [{"test": "${base}/test_rounds.py::test_r", "expects": "pay rounds up"}]}`)]]);
  const rel = (f: string) => `${base}/${f}`.replace(/^services\/pay\//, "");
  const session: SessionFactory = async (_c, snap, _l, body) => body(new FakeSession(snap, () =>
    [junitXml([[rel("test_scratch.py"), "test_s", "passed", ""], [rel("test_rounds.py"), "test_r", "passed", ""]]),
      "2 passed", false]));
  const run = makeAnswerRunner(repo, file, { ...defaultSettings(), consentAt: "x" }, agent, session);
  const out = await run("Q1", "Should pay round up?", "yes", "", join(tmp(), "out"), "pay");
  expect(Object.keys(out.files)).toEqual([`${base}/test_rounds.py`]);
  expect(Object.keys(out.keep)).toEqual([`${base}/test_rounds.py`]);
});
