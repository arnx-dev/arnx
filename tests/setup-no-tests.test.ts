// A project with no tests of its own (an app an agent built, dexdash) has no suite to prove its environment: setup
// proves it with arnx's one-line test, says so before and after, and refuses a test_command that deletes or writes
// files (dexdash's setup wrote `rm -rf tests && echo "test(...)" > smoke/smoke.test.ts` into one).
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, writesFiles } from "../src/config";
import { describeDetection, detect } from "../src/detect";
import { defaultSettings } from "../src/settings";
import { hasOwnTests, NO_OWN_TESTS, runSuite } from "../src/setup";
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

let apps = 0;
function app(files: Record<string, string> = {}): string {
  const repo = initRepo(join(tmp(), `app${++apps}`));
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
    "find . -name '*.pyc' -delete && pytest {targets}",
    // arnx review 20261022-20f6fa: by path, cp and sed -i, redirects of stderr or all output to a file.
    "/bin/rm -rf tests && pytest {targets}", "cp -r other tests && pytest {targets}", "sed -i s/a/b/ f; pytest {targets}",
    "pytest {targets} 2>out.log", "pytest {targets} &>out.log", "ls | xargs rm; pytest {targets}"]) {
    expect([c, writesFiles(c)]).toEqual([c, true]);
  }
  for (const c of ["python -m pytest -q {targets}", "pytest {targets} 2>&1", "pytest {targets} >/dev/null 2>&1",
    "pytest {targets} &> /dev/null", "ln -sfn /opt/deps/node_modules node_modules && npx vitest run {targets}",
    "cd app && pytest --rootdir=. {targets}", "pytest {targets} > /dev/null", "pytest {targets} >&2",
    "pytest -k rm {targets}"]) {
    expect([c, writesFiles(c)]).toEqual([c, false]);
  }
  expect(() => parseReviewFile(YAML.replace("python -m pytest", "rm -rf tests && python -m pytest")))
    .toThrow("projects.app.test_command: must not delete or write files (rm, mv, cp, sed -i, tee, > file)");
});

test("the write rule names what in test_command writes, and how to fix a setup approved before the rule", () => {
  const said = (c: string) => {
    try {
      parseReviewFile(YAML.replace("python -m pytest -q {targets}", c));
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  expect(said("printf '[x]' > .wrapper.cfg && python -m pytest {targets}")).toContain("`> .wrapper.cfg` writes");
  expect(said("rm -rf build; python -m pytest {targets}")).toContain("`rm` writes");
  expect(said("python -m pytest {targets} 2>out.log")).toContain("`2>out.log` writes");
  expect(said("rm -rf build; python -m pytest {targets}")).toContain("move it to install (arnx writes its own tests), then run `arnx approve`");
});

test("tests named by the runner's configuration, or under build/, count as the project's own", () => {
  // arnx review 20261022-20f6fa: such a project whose suite reports nothing is not proven by the one-line test.
  const cfg = parseReviewFile(YAML).projects[0]!;
  expect(hasOwnTests(cfg, app())).toBe(false);
  expect(hasOwnTests(cfg, app({ "pytest.ini": "[pytest]\npython_files = check_*.py\n", "checks/check_app.py": "" })))
    .toBe(true);
  expect(hasOwnTests(cfg, app({ "build/tests/test_x.py": "def test_x():\n    pass\n" }))).toBe(true);
  expect(hasOwnTests(cfg, app({ "node_modules/x/test_y.py": "" }))).toBe(false);
});

test("a test_command that starts another command after {targets} is refused before it runs: no report could come", () => {
  const said = (c: string, yaml = YAML) => {
    try {
      parseReviewFile(yaml.replace("python -m pytest -q {targets}", c));
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  for (const [c, part] of [["python -m pytest {targets} 2>&1 | tail -c 1500", "| tail -c 1500"],
    ["python -m pytest {targets} | grep FAIL", "| grep FAIL"], ["python -m pytest {targets}; echo done", "; echo done"],
    ["python -m pytest {targets} && echo ok", "&& echo ok"]]) {
    expect(said(c!)).toContain(`\`${part}\` comes after {targets}`);
  }
  for (const c of ["python -m pytest {targets}", "python -m pytest {targets} 2>&1", "cd app && python -m pytest {targets}",
    "echo y | python -m pytest -q {targets} -x", "python -m pytest {targets} &>/dev/null"]) {
    expect([c, said(c)]).toEqual([c, ""]);
  }
});

test("a test_command with {targets} inside quotes is refused: the report options would land after the closing quote",
  () => {
  const said = (c: string, yaml = YAML) => {
    try {
      parseReviewFile(yaml.replace("python -m pytest -q {targets}", c));
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  for (const c of ["sh -c \"make build; python -m pytest {targets}\"", "sh -c 'python -m pytest {targets}'",
    "bash -lc \"cd app && python -m pytest {targets} -x\""]) {
    expect([c, said(c)]).toEqual([c, expect.stringContaining("{targets} is inside quotes")]);
  }
  for (const c of ["python -m pytest -k \"not slow\" {targets}", "python -m pytest {targets} -k 'a or b'",
    "echo \"it's\" && python -m pytest {targets}", "python -m pytest \\\"{targets}"]) {
    expect([c, said(c)]).toEqual([c, ""]);
  }
  // Every runner that gets its options at the end; node's go in at --test, inside the quotes with it.
  const ts = (runner: string, c: string) => "version: 1\nprojects:\n  app:\n    root: .\n    language: typescript\n" +
    `    runner: ${runner}\n    image: node:22\n    test_command: ${c}\n`;
  for (const [runner, c] of [["jest", "npx jest {targets}"], ["vitest", "npx vitest run {targets}"],
    ["bun", "bun test {targets}"]]) {
    expect(said("", ts(runner!, `sh -c "${c}"`))).toContain("{targets} is inside quotes");
  }
  expect(said("", ts("node", "sh -c \"node --test {targets}\""))).toBe("");
  const rust = "version: 1\nprojects:\n  app:\n    root: .\n    language: rust\n    image: rust:1\n" +
    "    test_command: sh -c \"cargo nextest run {targets}\"\n";
  expect(said("", rust)).toContain("{targets} is inside quotes");
});

test("a test_command with {targets} inside parentheses is refused: the report options would land after the `)`", () => {
  const said = (c: string, yaml = YAML) => {
    try {
      parseReviewFile(yaml.replace("python -m pytest -q {targets}", c));
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  };
  for (const c of ["(cd app && python -m pytest {targets})", "make && (cd app && python -m pytest {targets} -x)",
    "echo $(python -m pytest {targets})", "(cd app && python -m pytest -k \"a)\" {targets})"]) {
    expect([c, said(c)]).toEqual([c, expect.stringContaining("{targets} is inside parentheses")]);
  }
  expect(said("(cd app && python -m pytest {targets})")).toBe("review.yaml: projects.app.test_command: {targets} is " +
    "inside parentheses: the report options arnx adds at the end would follow the `)`, so no report is written. " +
    "Leave the runner and {targets} outside them (cd app && <runner> {targets})");
  for (const c of ["(make build) && python -m pytest {targets}", "python -m pytest -k \"f(x)\" {targets}",
    "python -m pytest -k 'a (b' {targets}", "python -m pytest -k a\\(b {targets}",
    "python -m pytest $(cat args.txt) {targets}"]) {
    expect([c, said(c)]).toEqual([c, ""]);
  }
  // Quotes say it once: the message about quotes.
  expect(said("sh -c \"(python -m pytest {targets})\"")).not.toContain("parentheses");
  // Same runners as quotes: node's options go in at --test, inside the parentheses with it.
  const ts = (runner: string, c: string) => "version: 1\nprojects:\n  app:\n    root: .\n    language: typescript\n" +
    `    runner: ${runner}\n    image: node:22\n    test_command: "${c}"\n`;
  for (const [runner, c] of [["jest", "npx jest {targets}"], ["vitest", "npx vitest run {targets}"],
    ["bun", "bun test {targets}"]]) {
    expect(said("", ts(runner!, `(cd web && ${c})`))).toContain("{targets} is inside parentheses");
  }
  expect(said("", ts("node", "(cd web && node --test {targets})"))).toBe("");
  const rust = "version: 1\nprojects:\n  app:\n    root: .\n    language: rust\n    image: rust:1\n" +
    "    test_command: (cd core && cargo nextest run {targets})\n";
  expect(said("", rust)).toContain("{targets} is inside parentheses");
});
