// A model arnx has no price for runs: its cost is unknown, each of its calls counts as billed with unknown usage, the
// budget cap cannot stop it, and the command says so once at its start.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import type { JsonReply } from "../src/llm";
import { runReview } from "../src/reviewer";
import { defaultSettings, parseModelRef, settingsPath } from "../src/settings";
import { Cli } from "./helpers/cli";
import { FakeJson, FakeSession, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";
const REPORT = '{"tests": [{"test": "tests/arnx_generated/test_add.py::test_add", "expects": "add sums"}],' +
  ' "suspected_defects": [{"test": "tests/arnx_generated/test_add.py::test_add", "explanation": "add subtracts."}],' +
  ' "questions": []}';

/** What the client gives for a model with no price: no cost, the call billed with unknown usage. */
class Unpriced extends FakeJson {
  override ref = "anthropic:claude-mystery";
  override async completeJson(system: string, user: string): Promise<JsonReply> {
    const [reply] = await super.completeJson(system, user);
    return [reply, 0, undefined, 1];
  }
}

test("a review with an unpriced second opinion: the entry says cost unknown, its calls count as unknown usage", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-11"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-11T00:00:00Z",
    challenger: parseModelRef("anthropic:claude-mystery") };
  const agent = new ScriptedAgent([
    [tool("write_file", { path: GEN, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" })],
    [text(REPORT)]]);
  const judge = new Unpriced([{ verdict: "confirmed", reason: "add subtracts." }]);
  const runs = (): [string | null, string, boolean] => [junitXml([[GEN, "test_add", "failed", "assert -1 == 5"]]), "",
    false];
  const { review, rdir } = await runReview(repo, { settings, agentModel: agent, challenger: judge,
    sessionFactory: fakeFactory(runs) });
  const entry = review.usage.find((u) => u.model === "anthropic:claude-mystery")!;
  expect([entry.unpriced, entry.costUsd, entry.calls, entry.unknownCalls]).toEqual([true, 0, 1, 1]);
  expect(review.usage.find((u) => u.model === "anthropic:claude-sonnet-5-5")!.unpriced).toBeUndefined();
  const md = readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " ");
  expect(md).toContain("claude-mystery cost unknown)");
  expect(md).not.toContain("cut off mid-reply");
});

test("setup on an unpriced model runs, says once that the budget cap does not cover it, and shows cost unknown",
  async () => {
  const repo = initRepo(join(tmp(), "shop"));
  writeFileSync(join(repo, "pricing.py"), "def total(xs):\n    return sum(xs)\n");
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests", "test_pricing.py"), "def test_total():\n    assert True\n");
  commit(repo, "shop");
  const env = { ANTHROPIC_API_KEY: "a" };
  expect(await new Cli({ cwd: repo, env }).run("init")).toBe(0);
  expect(await new Cli({ cwd: repo, env }).run("consent", "--yes")).toBe(0);
  const config = readFileSync(settingsPath(repo), "utf8");
  writeFileSync(settingsPath(repo), config.replace(/^setup = .*$/m, 'setup = "anthropic:claude-mystery"'));
  const good = "version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
    "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n";
  const model = new ScriptedAgent([[tool("try_project", { yaml: good })], [text("Tests fail on the current code.")]]);
  model.model = "claude-mystery";
  const fail = junitXml([["tests/test_pricing.py", "test_total", "failed", "assert 1 == 2"]]);
  const cli = new Cli({ cwd: repo, env, setupModel: model,
    setupSessions: async (_cfg, snap, _log, body) => body(new FakeSession(snap, () => [fail, "out", false])) });
  expect(await cli.run("setup", "--yes")).toBe(2);
  const note = "No price for claude-mystery: cost unknown, and the budget cap does not cover it ([prices] in " +
    ".arnx/config.toml)";
  expect(cli.out.filter((l) => l === note)).toHaveLength(1);
  expect(cli.out.at(-2)).toMatch(/^Cost unknown · last attempt: /);
});
