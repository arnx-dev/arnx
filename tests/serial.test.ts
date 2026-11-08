// A review round runs a few generated files: it asks the runner for one process, and where the runner refuses, runs as
// the project configured it.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewConfig } from "../src/config";
import { testRound } from "../src/testround";
import { answerRound, FakeSession, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const GEN = "tests/arnx_generated/test_x.py";
const CFG = parseReviewConfig("version: 1\nimage: i\ntest_command: python -m pytest -n auto {targets}\n");

/** A runner that knows `-n0` or not; the probe and every other run report a passing test. */
const runner = (knows: boolean) => (command: string): [string | null, string, boolean] => {
  if (!knows && command.includes("-n0")) return [null, "error: unrecognized arguments: -n0", false];
  const probe = /\S*test_arnx_probe\.py/.exec(command);
  return [junitXml([[probe ? probe[0].replace(/^'|'$/g, "") : GEN, probe ? "test_arnx_probe" : "test_x", "passed", ""]]),
    "1 passed", false];
};

async function round(knows: boolean) {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "svc.py"), "X = 1\n");
  commit(repo, "init");
  const model = new ScriptedAgent([
    [tool("write_file", { path: GEN, content: "def test_x(): pass\n" })], [tool("run_tests")], [text('{"tests": []}')]]);
  const sessions: FakeSession[] = [];
  const said: string[] = [];
  await testRound(repo, null, CFG, { ...answerRound(model, CFG), writeDir: "tests/arnx_generated", budgetUsd: 1,
    runs: 2, outDir: join(tmp(), "out"), progress: (m) => said.push(m),
    sessionFactory: fakeFactory(runner(knows), sessions, { probe: "ignore" }) });
  return { commands: sessions[0]!.commands, said };
}

test("a round asks for one process in every run, the probe's included", async () => {
  const { commands, said } = await round(true);
  expect(commands.length).toBeGreaterThanOrEqual(3); // probe, agent run, final run
  for (const c of commands) expect(c.endsWith(" -n0") || / -n0 /.test(c)).toBe(true);
  expect(said.join("\n")).not.toContain("as configured");
});

test("a runner that refuses the flag runs as configured", async () => {
  const { commands, said } = await round(false);
  expect(commands[0]).toContain("-n0"); // tried first
  expect(commands[1]).not.toContain("-n0"); // the probe again, as configured
  for (const c of commands.slice(1)) expect(c).not.toContain("-n0"); // and the session keeps that
  expect(commands.length).toBeGreaterThanOrEqual(4); // tried probe, probe again, agent run, final run
  expect(said.some((m) => m.includes("running as configured"))).toBe(true);
});
