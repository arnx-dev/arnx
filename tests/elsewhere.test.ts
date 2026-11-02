// A project's round sees only its part of the change: the change's other files are named to it and to the second
// opinion, so neither takes an edit it cannot see for one missing from the change.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { elsewhereNote } from "../src/prompts";
import { runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { FakeJson, ScriptedAgent, fakeFactory, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

test("a round and its second opinion are told which files of the change its diff leaves out", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"), { recursive: true });
  mkdirSync(join(repo, "web"), { recursive: true });
  writeFileSync(join(repo, "svc/notes.py"), "NOTE = 'old'\n");
  writeFileSync(join(repo, "web/package.json"), '{"version": "1.0.0"}\n');
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile("version: 1\nprojects:\n  svc:\n    root: svc\n" +
    "    image: python:3.12-slim\n    test_command: python -m pytest {targets}\nuncovered:\n" +
    "  - path: /web/\n    reason: not set up yet\n"), "Dev", "2026-10-12"));
  commit(repo, "layout");
  writeFileSync(join(repo, "svc/notes.py"), "NOTE = 'bump web to 2.0.0'\n");
  writeFileSync(join(repo, "web/package.json"), '{"version": "2.0.0"}\n');
  const gen = "svc/tests/arnx_generated/test_note.py";
  const agent = new ScriptedAgent([
    [tool("write_file", { path: gen, content: "from notes import NOTE\n\ndef test_note():\n    assert NOTE == 'old'\n" })],
    [text('{"tests": [{"test": "' + gen + '::test_note", "expects": "x"}], "suspected_defects": [{"test": "' + gen +
      '::test_note", "explanation": "the note claims a bump the change does not make"}], "questions": []}')],
  ]);
  const judge = new FakeJson([{ verdict: "disputed", reason: "web/package.json is bumped." }]);
  const settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-11T00:00:00Z" };
  await runReview(repo, { settings, agentModel: agent, challenger: judge,
    sessionFactory: fakeFactory(() => [junitXml([[gen, "test_note", "failed", "assert False"]]), "", false]) });
  const first = JSON.stringify(agent.calls[0]!.messages);
  expect(first).toContain("also edits files not shown here");
  expect(first).toContain("`web/package.json`");
  expect(judge.calls.join("\n")).toContain("`web/package.json`");
});

test("the note names at most 40 files and counts the rest; no other files, no note", () => {
  expect(elsewhereNote([])).toBe("");
  const many = Array.from({ length: 45 }, (_, i) => `f${i}.ts`);
  expect(elsewhereNote(many)).toContain("`f39.ts`, and 5 more");
  expect(elsewhereNote(many)).not.toContain("`f40.ts`");
});
