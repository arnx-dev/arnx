// A project with no tests of its own (an app an agent built, dexdash) has no suite to prove its environment: setup
// proves it with arnx's one-line test, says so before and after, and refuses a test_command that deletes or writes
// files (dexdash's setup wrote `rm -rf tests && echo "test(...)" > smoke/smoke.test.ts` into one).
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, writesFiles } from "../src/config";
import { describeDetection, detect } from "../src/detect";
import { defaultSettings } from "../src/settings";
import { NO_OWN_TESTS, runSuite } from "../src/setup";
import { setupPreview } from "../src/setupview";
import { Cli } from "./helpers/cli";
import { fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const ENV = { ANTHROPIC_API_KEY: "a" };
const YAML = "version: 1\nprojects:\n  app:\n    root: .\n    language: python\n    image: python:3.12\n" +
  "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n";
/** A run that reports no test at all. */
const NONE = () => [junitXml([]), "no tests ran", false] as [string, string, boolean];

function app(files: Record<string, string> = {}): string {
  const repo = initRepo(join(tmp(), "app"));
  for (const [p, body] of Object.entries({ "pyproject.toml": "[project]\nname = \"app\"\n", "app.py": "X = 1\n",
    ...files })) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  commit(repo, "app");
  return repo;
}

test("setup on a project with no tests: said before it starts, proven by arnx's one-line test, said in the table",
  async () => {
  const repo = app();
  expect(describeDetection(detect(repo))).toContain("No test files of their own: .");
  expect(setupPreview(repo, defaultSettings())).toEndWith(
    "No tests of your own were found: arnx checks the environment with its own one-line test.");
  const cli = new Cli({ cwd: repo, env: ENV });
  expect(await cli.run("init")).toBe(0);
  expect(await cli.run("consent", "--yes")).toBe(0);
  const agent = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("propose", { yaml: YAML })],
    [text("done")]]);
  const setup = new Cli({ cwd: repo, env: ENV, setupModel: agent, setupSessions: fakeFactory(NONE),
    approveSessions: fakeFactory(NONE) });
  expect(await setup.run("setup", "--yes")).toBe(0);
  expect(setup.err.map((l) => l.replace(/^\[\d+:\d\d\] /, ""))).toContain(`app: ✓ ${NO_OWN_TESTS}`);
  expect(setup.stdout).toContain(`  app      .        python:3.12 · pytest  ${NO_OWN_TESTS}`);
  // The agent was told it is fine, and not to write tests.
  expect(JSON.stringify(agent.calls.at(-1)!.messages)).toContain("app has no tests of its own, which is fine");
});

test("a project with tests of its own that reports none still does not run", async () => {
  const repo = app({ "tests/test_app.py": "def test_x():\n    pass\n" });
  const cfg = parseReviewFile(YAML).projects[0]!;
  const [ok, summary] = await runSuite(cfg, repo, join(tmp(), "build.log"), { sessionFactory: fakeFactory(NONE) });
  expect([ok, summary]).toEqual([false, "the suite ran no tests"]);
});

test("no tests of its own and the runner does not start: what to install, and not to write tests", async () => {
  const repo = app();
  const cfg = parseReviewFile(YAML).projects[0]!;
  const silent = () => [null, "pytest: not found", false] as [null, string, boolean];
  const [ok, summary] = await runSuite(cfg, repo, join(tmp(), "build.log"),
    { sessionFactory: fakeFactory(silent, undefined, { probe: "ignore" }) });
  expect(ok).toBe(false);
  expect(summary).toStartWith("the project has no tests of its own (the suite wrote no report), and arnx's one-line " +
    "test placed in tests/arnx_generated/ did not run either: install the runner in install");
  expect(summary).toEndWith("Do not write tests in test_command: arnx writes them");
});

test("a test_command that deletes or writes files is refused; redirects to /dev/null and links are fine", () => {
  const dexdash = "rm -rf tests && mkdir -p smoke && echo \"import {test,expect} from 'vitest';test('smoke',()=>" +
    "{expect(1).toBe(1)})\" > smoke/smoke.test.ts; npx vitest run {targets}";
  for (const c of [dexdash, "rm -rf build; pytest {targets}", "pytest {targets} | tee out.log",
    "pytest {targets} > out.log", "pytest {targets} >>out.log", "mv conftest.py x; pytest {targets}",
    "find . -name '*.pyc' -delete && pytest {targets}"]) {
    expect([c, writesFiles(c)]).toEqual([c, true]);
  }
  for (const c of ["python -m pytest -q {targets}", "pytest {targets} 2>&1", "pytest {targets} >/dev/null 2>&1",
    "pytest {targets} &> /dev/null", "ln -sfn /opt/deps/node_modules node_modules && npx vitest run {targets}",
    "cd app && pytest --rootdir=. {targets}"]) {
    expect([c, writesFiles(c)]).toEqual([c, false]);
  }
  expect(() => parseReviewFile(YAML.replace("python -m pytest", "rm -rf tests && python -m pytest")))
    .toThrow("projects.app.test_command: must not delete or write files (rm, mv, tee, > file)");
});
