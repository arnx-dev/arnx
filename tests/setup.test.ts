import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestResult } from "../src/adapters/types";
import { isApproved, loadReviewConfig, parseReviewConfig, reviewConfigPath } from "../src/config";
import type { Reply } from "../src/llm";
import { defaultSettings } from "../src/settings";
import { approveConfig, ignoredTargets, outsideTargets, runSetup, suiteOk } from "../src/setup";
import { type FakeSession, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { gitRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const YAML = `version: 1
image: python:3.12-slim
install: [pip install pytest]
test_command: python -m pytest -q {targets}
known_failing: [tests/test_net.py]
notes: [tests/test_net.py calls a public API]
`;
const tmp = useTmp();
const t = (file: string, outcome: string): TestResult => ({ testId: `${file}::t`, fileAttr: file, name: "t", outcome,
  message: "" });
const lastToolResult = (m: ScriptedAgent, call: number) =>
  String((m.calls[call]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content);

test("test_suite_ok", () => {
  const cfg = parseReviewConfig(YAML);
  expect(suiteOk([t("tests/test_a.py", "passed"), t("tests/test_net.py", "failed")], cfg)[0]).toBe(true);
  const [ok, summary] = suiteOk([t("tests/test_a.py", "failed")], cfg);
  expect(ok).toBe(false);
  expect(summary).toContain("tests/test_a.py::t");
  expect(suiteOk([], cfg)[0] || suiteOk(null, cfg)[0]).toBe(false);
});

test("test_suite_with_only_known_errors_does_not_run", () => {
  const [ok, summary] = suiteOk([t("tests/test_net.py", "error")], parseReviewConfig(YAML));
  expect(ok).toBe(false);
  expect(summary).toContain("no test passed");
});

const passing = (): [string | null, string, boolean] =>
  [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false];

test("test_setup_keeps_the_last_config_that_ran", async () => {
  const model = new ScriptedAgent([
    [tool("try_project", { yaml: "version: 2\n" })],
    [tool("try_project", { yaml: YAML })],
    [tool("propose", { yaml: YAML })],
    [text("Chose python:3.12-slim.")],
  ]);
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir: `${tmp()}/setup`,
    sessionFactory: fakeFactory(passing) });
  expect([r.ok, r.yamlText, r.stop]).toEqual([true, YAML, "end_turn"]);
  expect(r.summary).toContain("1 passed");
  expect(model.calls[0]!.tools).toContain("try_project");
  expect(model.calls[0]!.tools).toContain("propose");
  expect(model.calls[0]!.tools).not.toContain("write_file");
  expect(lastToolResult(model, 1)).toContain("version: must be 1");
});

test("test_setup_refuses_a_stamped_proposal", async () => {
  const stamped = YAML + "approved: {by: x, at: y, sha256: z}\n";
  const model = new ScriptedAgent([[tool("try_project", { yaml: stamped })], [text("done")]]);
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir: `${tmp()}/s`,
    sessionFactory: fakeFactory(passing) });
  expect(r.ok).toBe(false);
  expect(lastToolResult(model, 1)).toContain("approved");
});

test("test_approve_stamps_only_a_running_config", async () => {
  const repo = gitRepo(tmp());
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, YAML);
  const failing = fakeFactory(() => [junitXml([["tests/test_a.py", "test_a", "failed", "x"]]), "", false]);
  let [ok] = await approveConfig(repo, { by: "Dev", at: "2026-10-11", sessionFactory: failing });
  expect(ok).toBe(false);
  expect(isApproved(parseReviewConfig(readFileSync(path, "utf8")))).toBe(false);
  [ok] = await approveConfig(repo, { by: "Dev", at: "2026-10-11", sessionFactory: fakeFactory(passing) });
  expect(ok).toBe(true);
  expect((loadReviewConfig(repo).raw.approved as Record<string, unknown>).by).toBe("Dev");
});

test("a project is not proven until a test placed in its tests folder is picked up by the runner", async () => {
  const repo = gitRepo(tmp());
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, YAML);
  const sessions: FakeSession[] = [];
  const ignoring = fakeFactory(passing, sessions, { probe: "ignore" }); // like jest roots that leave the folder out
  const [ok, detail] = await approveConfig(repo, { by: "Dev", at: "2026-10-11", sessionFactory: ignoring });
  expect(ok).toBe(false);
  expect(detail).toContain("tests/arnx_generated");
  expect(detail).toContain("tests_dir");
  expect(sessions[0]!.commands.some((c) => c.includes("test_arnx_probe.py"))).toBe(true);
  const [ok2] = await approveConfig(repo, { by: "Dev", at: "2026-10-11", sessionFactory: fakeFactory(passing) });
  expect(ok2).toBe(true);
});

const PROBE_FILE = "tests/arnx_generated/test_arnx_probe.py";

test("a run with one target that reports tests from other files shows test_command ignores {targets}", () => {
  const cfg = parseReviewConfig(YAML);
  const probe = t(PROBE_FILE, "passed");
  expect(outsideTargets([probe], [PROBE_FILE])).toEqual([]);
  expect(ignoredTargets([probe], [PROBE_FILE], cfg)).toBe("");
  // Tests reported without a file (a plugin's own item) cannot be placed, so they do not count.
  expect(ignoredTargets([probe, { ...t("", "passed"), testId: "mypy-status" }], [PROBE_FILE], cfg)).toBe("");
  // The runner may report files relative to the project root, the targets are relative to the repository.
  expect(outsideTargets([t("arnx_generated/test_arnx_probe.py", "passed")], ["svc/arnx_generated/test_arnx_probe.py"]))
    .toEqual([]);
  const ran = [probe, t("integ_tests/test_ui.py", "passed"), { ...t("integ_tests/test_ui.py", "passed"), testId: "u2" },
    t("integ_tests/test_login.py", "failed")];
  expect(outsideTargets(ran, [PROBE_FILE]).length).toBe(3);
  expect(ignoredTargets(ran, [PROBE_FILE], cfg)).toBe("test_command does not run only {targets}: run with only " +
    "arnx's one-line test in tests/arnx_generated/ as its target, it also ran 3 tests from 2 other files " +
    "(integ_tests/test_login.py, integ_tests/test_ui.py). Every review runs its generated tests with this command, " +
    "so each run would run those files too: minutes instead of seconds, and a review can hit its time limit. Remove " +
    "what adds tests besides {targets} from test_command (a test directory or file after {targets}, an option that " +
    "collects more), so it runs only the files it is given");
});

const integ = (): [string | null, string, boolean] => [junitXml([["tests/test_a.py", "test_a", "passed", ""],
  ["integ_tests/test_ui.py", "test_ui", "passed", ""]]), "2 passed", false];

test("approve refuses a test_command that runs more than {targets}, naming the other files", async () => {
  const repo = gitRepo(tmp());
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, YAML.replace("{targets}", "{targets} integ_tests"));
  const sessions: FakeSession[] = [];
  const [ok, detail] = await approveConfig(repo, { by: "Dev", at: "2026-10-20",
    sessionFactory: fakeFactory(integ, sessions, { probe: "with-suite" }) });
  expect(ok).toBe(false);
  expect(detail).toContain("2 passed; but test_command does not run only {targets}: run with only arnx's one-line " +
    "test in tests/arnx_generated/ as its target, it also ran 2 tests from 2 other files (integ_tests/test_ui.py, " +
    "tests/test_a.py)");
  expect(isApproved(parseReviewConfig(readFileSync(path, "utf8")))).toBe(false);
  // One run of the suite and one of the probe: the check costs no extra run.
  expect(sessions[0]!.commands.length).toBe(2);
  writeFileSync(path, YAML);
  const [ok2] = await approveConfig(repo, { by: "Dev", at: "2026-10-20", sessionFactory: fakeFactory(integ) });
  expect(ok2).toBe(true);
});

test("try_project tells the setup agent that its test_command ignores {targets}", async () => {
  const bad = YAML.replace("{targets}", "{targets} integ_tests");
  const model = new ScriptedAgent([[tool("try_project", { yaml: bad })], [tool("try_project", { yaml: YAML })],
    [tool("propose", { yaml: YAML })], [text("done")]]);
  let n = 0;
  // The first try's runner adds integ_tests to every run, like the command; the fixed command's runs only its targets.
  const factory = fakeFactory(integ, undefined, { probe: "with-suite" });
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir: `${tmp()}/s`,
    sessionFactory: (cfg, snap, log, body) => (n++ === 0 ? factory : fakeFactory(integ))(cfg, snap, log, body) });
  expect(lastToolResult(model, 1)).toContain("the suite of main does not run yet: 2 passed; but test_command does " +
    "not run only {targets}");
  expect(lastToolResult(model, 1)).toContain("integ_tests/test_ui.py");
  expect(lastToolResult(model, 2)).toContain("runs: 2 passed");
  expect([r.ok, r.yamlText]).toEqual([true, YAML]);
});

test("tests_dir may not be a folder that already holds the project's own tests", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "tests", "unit"), { recursive: true });
  writeFileSync(join(repo, "tests", "unit", "test_own.py"), "def test_own(): pass\n");
  runGit(repo, "add", "tests"); // the project's own tests are tracked; approve runs on tracked files
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, YAML + "tests_dir: tests/unit\n");
  const [ok, detail] = await approveConfig(repo, { by: "Dev", at: "2026-10-12", sessionFactory: fakeFactory(passing) });
  expect(ok).toBe(false);
  expect(detail).toContain("tests/unit/ already holds the project's own tests");
  expect(detail).toContain("tests/unit/arnx_generated");
});

test("tests_dir may not hold the project's conftest.py or __init__.py either; tests arnx accept kept there are fine", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "tests", "arnx", "r1"), { recursive: true });
  writeFileSync(join(repo, "tests", "arnx", "r1", "test_kept.py"), "def test_kept(): pass\n");
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, YAML + "tests_dir: tests\n");
  const [ok] = await approveConfig(repo, { by: "Dev", at: "2026-10-12", sessionFactory: fakeFactory(passing) });
  expect(ok).toBe(true);
  writeFileSync(join(repo, "tests", "conftest.py"), "import pytest\n");
  runGit(repo, "add", "tests/conftest.py");
  writeFileSync(path, YAML + "tests_dir: tests\n");
  const [ok2, detail] = await approveConfig(repo, { by: "Dev", at: "2026-10-12", sessionFactory: fakeFactory(passing) });
  expect(ok2).toBe(false);
  expect(detail).toContain("tests/ already holds the project's own tests (tests/conftest.py)");
  expect(detail).toContain("tests/arnx_generated");
});

test("propose refuses a tests_dir that holds the project's own tests, naming them", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "tests"));
  writeFileSync(join(repo, "tests", "test_own.py"), "def test_own(): pass\n");
  writeFileSync(join(repo, "tests", "__init__.py"), "");
  runGit(repo, "add", "tests");
  const bad = YAML + "tests_dir: tests\n";
  const model = new ScriptedAgent([[tool("propose", { yaml: bad })], [text("done")]]);
  await runSetup(repo, defaultSettings(), model, { outDir: `${tmp()}/setup`, sessionFactory: fakeFactory(passing) });
  const reply = lastToolResult(model, 1);
  expect(reply).toContain("refused");
  expect(reply).toContain("tests/ already holds the project's own tests (tests/__init__.py, tests/test_own.py)");
  expect(reply).toContain("tests/arnx_generated");
});

test("setup logs what its agent spent, for checking against the bill", async () => {
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("propose", { yaml: YAML })],
    [text("done")]]);
  const repo = gitRepo(tmp());
  await runSetup(repo, defaultSettings(), model, { outDir: `${tmp()}/setup`, sessionFactory: fakeFactory(passing) });
  const line = JSON.parse(readFileSync(join(repo, ".arnx", "usage.jsonl"), "utf8").trim());
  expect(line.command).toBe("setup");
  expect(line.usage).toEqual([{ model: "anthropic:claude-sonnet-5-5", calls: 3, unknown_calls: 0, input: 3000,
    output: 600, cache_read: 0, cache_write: 0, cost_usd: 0.012 }]);
});

test("setup's log counts a reply that came after a cut-off attempt as an unknown call", async () => {
  class CutOnce extends ScriptedAgent {
    override async create(o: Parameters<ScriptedAgent["create"]>[0]): Promise<Reply> {
      const reply = await super.create(o);
      return this.calls.length === 1 ? { ...reply, unknownCalls: 1 } : reply;
    }
  }
  const model = new CutOnce([[tool("try_project", { yaml: YAML })], [tool("propose", { yaml: YAML })], [text("done")]]);
  const repo = gitRepo(tmp());
  await runSetup(repo, defaultSettings(), model, { outDir: `${tmp()}/setup`, sessionFactory: fakeFactory(passing) });
  const line = JSON.parse(readFileSync(join(repo, ".arnx", "usage.jsonl"), "utf8").trim());
  expect(line.usage[0]).toMatchObject({ calls: 3, unknown_calls: 1 });
});

test("a retry with the same environment reruns only the files that failed, then the whole suite to prove it", async () => {
  const commands: string[] = [];
  const script = (command: string): [string | null, string, boolean] => {
    commands.push(command);
    const fixed = commands.filter((c) => c.includes("suite.xml")).length > 1; // the second try fixes test_b
    return [junitXml([["tests/test_a.py", "test_a", "passed", ""],
      ["tests/test_b.py", "test_b", fixed ? "passed" : "failed", "x"]]), "", false];
  };
  // only the files set aside change: the environment is the same
  const withKnown = YAML.replace("known_failing: [tests/test_net.py]", "known_failing: [tests/test_net.py, tests/test_x.py]")
    .replace("notes: [tests/test_net.py calls a public API]", "notes: [tests/test_net.py and tests/test_x.py call a public API]");
  const model = new ScriptedAgent([
    [tool("try_project", { yaml: YAML })], // fails on test_b
    [tool("try_project", { yaml: withKnown })], // same environment: only test_b runs, then the whole suite
    [tool("propose", { yaml: withKnown })], [text("done")]]);
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir: `${tmp()}/setup`,
    sessionFactory: fakeFactory(script) });
  expect(r.ok).toBe(true);
  const suites = commands.filter((c) => c.includes("suite.xml"));
  expect(suites).toHaveLength(3);
  expect(suites[1]).toContain("tests/test_b.py");
  expect(suites[1]).not.toContain("tests/test_a.py");
  expect(suites[2]).not.toContain("tests/test_b.py"); // the proving run names no files: the whole suite
});

test("a failing suite tells the agent which files pass without the rest of the suite, and why tests fail", async () => {
  const commands: string[] = [];
  const script = (command: string): [string | null, string, boolean] => {
    commands.push(command);
    if (command.includes("apart.xml")) return [junitXml([["tests/test_b.py", "test_b", "passed", ""]]), "", false];
    return [junitXml([["tests/test_a.py", "test_a", "passed", ""], ["tests/test_b.py", "test_b", "failed", "x"],
      ["tests/test_c.py", "test_c", "error", "ModuleNotFoundError: No module named 'fancyfmt'"]]), "", false];
  };
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [text("stop")]]);
  await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir: `${tmp()}/setup`,
    sessionFactory: fakeFactory(script) });
  const reply = lastToolResult(model, 1);
  expect(reply).toContain("module `fancyfmt` is not installed");
  expect(reply).toMatch(/pass when run without the rest of the suite[^\n]*Files: tests\/test_b\.py\./);
  // One run apart, of the failure no hint explains: test_c has its hint and is not run again.
  const apart = commands.filter((c) => c.includes("apart.xml"));
  expect(apart).toHaveLength(1);
  expect(apart[0]).toContain("tests/test_b.py");
  expect(apart[0]).not.toContain("tests/test_c.py");
});
