import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewConfig } from "../src/config";
import { EventLog, withEvents } from "../src/events";
import { PROMPT_VERSION, reviewSystem, reviewTask } from "../src/prompts";
import type { SessionFactory } from "../src/sandbox";
import { ownTestsInWriteDir, testRound, writeDirOf, COPY_SUFFIX } from "../src/testround";
import { answerRound, FakeSession, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { ROUND_CFG } from "./helpers/yaml";

const CFG = parseReviewConfig(ROUND_CFG);
const PLAIN = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest {targets}\n");
const GEN = "tests/arnx_generated/test_x.py";
const tmp = useTmp();

test("test_prompts_carry_config", () => {
  const system = reviewSystem(CFG);
  expect(system).toContain("set DATABASE_URL before importing db");
  expect(system).toContain("db");
  expect(system).toContain("data");
  const task = reviewTask(CFG, "diff --git a/x b/x\n+$weird {braces}\n", 5);
  expect(task).toContain("+$weird {braces}");
  expect(task).toContain("app/tests/arnx_generated");
  expect(task).toContain("At most 5");
  expect(PROMPT_VERSION).toHaveLength(12);
});

test("test_write_dir_of", () => {
  expect(writeDirOf(CFG)).toBe("app/tests/arnx_generated");
  expect(writeDirOf(CFG, "answers")).toBe("app/tests/arnx_generated/answers");
  expect(writeDirOf(parseReviewConfig("version: 1\nimage: i\ntest_command: pytest {targets}\n")))
    .toBe("tests/arnx_generated");
});

function script(command: string): [string | null, string, boolean] {
  if (command.includes("agent-")) return [junitXml([[GEN, "test_x", "failed", "assert 1 == 2"]]), "1 failed", false];
  if (command.includes("final-2")) return [null, "[timed out]", true];
  return [junitXml([[GEN, "test_x", "failed", "assert 1 == 2"], [GEN, "test_y", "passed", ""]]), "out", false];
}

test("test_round_end_to_end_with_fakes", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "app", "tests", "arnx_generated"), { recursive: true });
  writeFileSync(join(repo, "app", "svc.py"), "X = 1\n");
  writeFileSync(join(repo, "app", "tests", "arnx_generated", "test_stale.py"), "def test_old(): pass\n");
  const model = new ScriptedAgent([
    [tool("write_file", { path: "app/" + GEN, content: "def test_x(): assert 1 == 2\ndef test_y(): pass\n" })],
    [tool("run_tests")],
    [text('{"tests": []}')],
  ]);
  const sessions: FakeSession[] = [];
  const out = join(tmp(), "out");
  const r = await testRound(repo, null, CFG, { ...answerRound(model, CFG),
    writeDir: writeDirOf(CFG), budgetUsd: 1.0, runs: 3, outDir: out, sessionFactory: fakeFactory(script, sessions) });
  expect(r.agent.stop).toBe("end_turn");
  expect(Object.keys(r.files)).toEqual(["app/" + GEN]); // the stale file was cleared before the agent ran
  expect(existsSync(join(out, "tests", "app", GEN + COPY_SUFFIX)) && existsSync(join(out, "transcript.jsonl"))).toBe(true);
  expect(r.classified.missingRuns).toBe(2); // one run timed out, the last was skipped after it
  expect(r.classified.findings).toEqual([]);
  expect(r.classified.flaky.map((t) => t.name)).toEqual(["test_x"]);
  const commands = sessions[0]!.commands;
  expect(commands[0]).toContain("test_arnx_probe.py"); // the environment runs a test before the agent writes any
  expect(commands[1]).toContain("tests/arnx_generated");
  expect(commands).toHaveLength(4); // the probe, one agent run, two final runs (the second timed out)
  expect(existsSync(join(repo, "app", "tests", "arnx_generated", "test_stale.py"))).toBe(true); // user's tree untouched
});

// One hanging test made every final run wait the whole timeout: three runs, three times RUN_TIMEOUT.
test("after a final run times out the other final runs are skipped, counted as runs without a report", async () => {
  const repo = gitRepo(tmp());
  const model = new ScriptedAgent([
    [tool("write_file", { path: "app/" + GEN, content: "def test_x(): pass\n" })],
    [text('{"tests": []}')],
  ]);
  const hangs = (command: string): [string | null, string, boolean] => command.includes("final-")
    ? [null, "[timed out]", true] : [junitXml([[GEN, "test_x", "passed", ""]]), "1 passed", false];
  const sessions: FakeSession[] = [];
  const said: string[] = [];
  const path = join(tmp(), "events.jsonl");
  const r = await withEvents(new EventLog(path, "t"), () => testRound(repo, null, CFG, { ...answerRound(model, CFG),
    writeDir: writeDirOf(CFG), budgetUsd: 1.0, runs: 3, outDir: join(tmp(), "o"), progress: (m) => said.push(m),
    sessionFactory: fakeFactory(hangs, sessions) }));
  expect(sessions[0]!.commands.filter((c) => c.includes("final-"))).toHaveLength(1);
  expect([r.classified.missingRuns, r.classified.totalRuns]).toEqual([3, 3]); // as when all three timed out
  expect(said).toContain("main: final run 1/3 timed out; the other runs skipped");
  const missing = readFileSync(path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
    .filter((e) => e.type === "test.run_missing").map((e) => [e.data.repeat, e.data.timed_out, e.data.skipped]);
  expect(missing).toEqual([[1, true, undefined], [2, false, true], [3, false, true]]);
});

test("test_round_without_tests_skips_runs", async () => {
  const repo = gitRepo(tmp());
  const model = new ScriptedAgent([[text('{"tests": [], "questions": ["Is X meant to be 1?"]}')]]);
  const sessions: FakeSession[] = [];
  const r = await testRound(repo, null, PLAIN, {
    ...answerRound(model, PLAIN), writeDir: "tests/arnx_generated", budgetUsd: 1.0,
    runs: 3, outDir: join(tmp(), "o"), sessionFactory: fakeFactory(script, sessions) });
  expect(r.files).toEqual({});
  expect(r.classified.totalRuns).toBe(0);
  expect(sessions[0]!.commands.map((c) => c.includes("test_arnx_probe.py"))).toEqual([true]); // the probe only
});

// An image whose build differed from the commit under review rebuilt a build script that downloads,
// offline. Every run failed to build; the review wrote and billed tests that never ran and said "No findings".
test("a round whose environment runs no test stops before the agent writes one", async () => {
  const repo = gitRepo(tmp());
  const model = new ScriptedAgent([
    [tool("write_file", { path: "app/" + GEN, content: "def test_x(): pass\n" })],
    [text('{"tests": []}')],
  ]);
  const sessions: FakeSession[] = [];
  const broken = (): [string | null, string, boolean] =>
    [null, "error: failed to run custom build command for `fetcher v1.0.0`", false];
  const out = join(tmp(), "o");
  await expect(testRound(repo, null, CFG, { ...answerRound(model, CFG), writeDir: writeDirOf(CFG), budgetUsd: 1.0,
    runs: 3, outDir: out, sessionFactory: fakeFactory(broken, sessions, { probe: "ignore" }) }))
    .rejects.toThrow(/the test environment runs no test at this commit[\s\S]*custom build command for `fetcher/);
  expect(sessions[0]!.commands).toHaveLength(1);
  expect(readFileSync(join(out, "probe.log"), "utf8")).toContain("fetcher v1.0.0");
});

// A setup whose tests relied on a file the install made only in the image's copy of the code stopped after the
// upgrade with "runs no test" and no word of that copy.
test("a round stopped by the probe on an image holding a copy of the code says so and what to do", async () => {
  const repo = gitRepo(tmp());
  const model = new ScriptedAgent([[text('{"tests": []}')]]);
  const output = "Error: ENOENT: no such file or directory, open '/src/packages/core/default.db'";
  const factory = (files: string[]): SessionFactory => async (_cfg, snap, _log, body) => {
    const s = new FakeSession(snap, () => [null, output, false], { probe: "ignore" });
    return body({ run: (c) => s.run(c), copies: () => ({ roots: ["/opt/app"], files }) });
  };
  const round = (files: string[]) => testRound(repo, null, CFG, { ...answerRound(model, CFG),
    writeDir: writeDirOf(CFG), budgetUsd: 1.0, runs: 3, outDir: join(tmp(), "o"), sessionFactory: factory(files) });
  await expect(round(["packages/core/default.db"])).rejects.toThrow(/the test environment runs no test at this commit/);
  await expect(round(["packages/core/default.db"])).rejects.toThrow("\nmain: packages/core/default.db exists only " +
    "in the image's copy of the code (/opt/app), not in /src. Set the project up again: arnx setup --project main");
  await expect(round(["a.db", "b.db", "c.db", "d.db"])).rejects.toThrow("\nmain: a.db, b.db, c.db and 1 more exist " +
    "only in the image's copy of the code (/opt/app), not in /src.");
  await expect(round([])).rejects.toThrow("\nmain: the image holds a copy of the code (/opt/app); a setup that " +
    "relied on it can stop here since arnx 0.1.2. Set the project up again: arnx setup --project main");
});

test("a round clears only generated files, never the project's own tests", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests", "test_existing.py"), "def test_kept(): pass\n");
  writeFileSync(join(repo, "tests", "helper.txt"), "data\n");
  commit(repo, "own tests");
  const seen: string[] = [];
  const model = new ScriptedAgent([[tool("list_dir", { path: "tests" })], [text('{"tests": []}')]]);
  const cfg = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest {targets}\ntests_dir: tests\n");
  const r = await testRound(repo, null, cfg, { ...answerRound(model, cfg),
    writeDir: "tests", budgetUsd: 1.0, runs: 3, outDir: join(tmp(), "o"), sessionFactory: fakeFactory(script) });
  const listing = String((model.calls[1]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content);
  seen.push(listing);
  expect(listing).toContain("helper.txt");
  expect(listing).not.toContain("test_existing.py");
  expect(r.files).toEqual({});
});

test("runs target the generated test files, never the whole tests directory", async () => {
  const repo = gitRepo(tmp());
  const model = new ScriptedAgent([
    [tool("write_file", { path: "tests/test_new.py", content: "def test_n(): pass\n" })],
    [tool("run_tests")],
    [text('{"tests": []}')],
  ]);
  const sessions: FakeSession[] = [];
  const cfg = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest {targets}\ntests_dir: tests\n");
  await testRound(repo, null, cfg, { ...answerRound(model, cfg), writeDir: "tests",
    budgetUsd: 1.0, runs: 3, outDir: join(tmp(), "o"), sessionFactory: fakeFactory(script, sessions) });
  const commands = sessions[0]!.commands.slice(1); // after the probe
  expect(commands).toHaveLength(3); // one agent run, two final runs (the second timed out)
  for (const c of commands) expect(c.startsWith("pytest tests/test_new.py ")).toBe(true);
});

test("only generated tests count; a run without them counts as missing", async () => {
  const repo = gitRepo(tmp());
  const model = new ScriptedAgent([
    [tool("write_file", { path: "tests/arnx_generated/test_new.py", content: "def test_n(): pass\n" })],
    [text('{"tests": []}')],
  ]);
  const own = "tests/test_existing.py";
  // The generated test fails in the first run, so it runs again; those runs report only a test the command ran
  // although it was not asked for (it ignored {targets}): they count as runs without a report.
  const scripted = (command: string): [string | null, string, boolean] => command.includes("final-1")
    ? [junitXml([["tests/arnx_generated/test_new.py", "test_n", "failed", "x"], [own, "test_old", "failed", "x"]]), "", false]
    : [junitXml([[own, "test_old", "failed", "x"]]), "", false];
  const r = await testRound(repo, null, PLAIN, {
    ...answerRound(model, PLAIN), writeDir: "tests/arnx_generated", budgetUsd: 1.0,
    runs: 3, outDir: join(tmp(), "o"), sessionFactory: fakeFactory(scripted) });
  expect(r.classified.findings).toEqual([]); // not failing in every run: not a finding
  expect(r.classified.missingRuns).toBe(2);
  expect(r.classified.flaky.map((t) => t.name)).toEqual(["test_n"]);
  expect(r.classified.passed).toEqual([]);
});

test("final runs: everything once, then only the files with a failing test", async () => {
  const repo = gitRepo(tmp());
  const model = new ScriptedAgent([
    [tool("write_file", { path: "tests/arnx_generated/test_a.py", content: "def test_a(): pass\n" }),
      tool("write_file", { path: "tests/arnx_generated/test_b.py", content: "def test_b(): assert 0\n" })],
    [text('{"tests": []}')],
  ]);
  const commands: string[] = [];
  const scripted = (command: string): [string | null, string, boolean] => {
    commands.push(command);
    return [junitXml([
      ...(command.includes("test_a.py") ? [["tests/arnx_generated/test_a.py", "test_a", "passed", ""]] : []),
      ["tests/arnx_generated/test_b.py", "test_b", "failed", "assert 0"]] as [string, string, string, string][]), "", false];
  };
  const r = await testRound(repo, null, PLAIN, {
    ...answerRound(model, PLAIN), writeDir: "tests/arnx_generated", budgetUsd: 1.0,
    runs: 3, outDir: join(tmp(), "o"), sessionFactory: fakeFactory(scripted) });
  const finals = commands.filter((c) => c.includes("final-"));
  expect(finals).toHaveLength(3);
  expect(finals[0]).toContain("test_a.py");
  expect(finals.slice(1).every((c) => c.includes("test_b.py") && !c.includes("test_a.py"))).toBe(true);
  expect(r.classified.findings.map((t) => t.name)).toEqual(["test_b"]);
  expect(r.classified.passed.map((t) => t.name)).toEqual(["test_a"]);
});

test("run_tests shows the agent the parsed results when the runner's console is empty", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "X = 1\n");
  const cfg = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest {targets}\n");
  const gen = "tests/arnx_generated/test_x.py";
  const model = new ScriptedAgent([
    [tool("write_file", { path: gen, content: "def test_x(): assert 1 == 2\n" })],
    [tool("run_tests")],
    [text('{"tests": []}')],
  ]);
  const quiet = (): [string | null, string, boolean] => [junitXml([[gen, "test_x", "failed", "assert 1 == 2"]]), "", false];
  await testRound(repo, null, cfg, { ...answerRound(model, cfg),
    writeDir: "tests/arnx_generated", budgetUsd: 1.0, runs: 1, outDir: join(tmp(), "o"), sessionFactory: fakeFactory(quiet) });
  const seen = String((model.calls[2]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content);
  expect(seen).toContain("1 tests: 1 failed");
  expect(seen).toContain(`FAILED ${gen}::test_x`);
  expect(seen).toContain("assert 1 == 2");
});

test("a round records whether the agent ever saw its own tests run", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "X = 1\n");
  const cfg = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest {targets}\n");
  const gen = "tests/arnx_generated/test_x.py";
  const round = async (script: (c: string) => [string | null, string, boolean]) => testRound(repo, null, cfg, {
    ...answerRound(new ScriptedAgent([[tool("write_file", { path: gen, content: "def test_x(): pass\n" })],
      [tool("run_tests")], [text('{"tests": []}')]]), cfg), writeDir: "tests/arnx_generated", budgetUsd: 1.0, runs: 1,
    outDir: join(tmp(), "o"), sessionFactory: fakeFactory(script) });
  const seeing = await round(() => [junitXml([[gen, "test_x", "passed", ""]]), "", false]);
  expect(seeing.sawResults).toBe(true);
  const blind = await round((c) => c.includes("agent-") ? [null, "", false] : [junitXml([[gen, "test_x", "passed", ""]]), "", false]);
  expect(blind.sawResults).toBe(false);
});

test("the project's own files a round would clear from tests_dir are found, outside the folders arnx accept keeps", () => {
  const py = parseReviewConfig("version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest {targets}\n" +
    "tests_dir: tests\n");
  expect(ownTestsInWriteDir(py, ["app.py", "tests/a_test.py", "tests/helpers.py", "tests/unit/conftest.py",
    "tests/test_a.py", "tests/__init__.py", "tests/arnx/r1/test_r1.py", "tests/arnx/r1/conftest.py", "tests_x/test_b.py"]))
    .toEqual(["tests/__init__.py", "tests/test_a.py", "tests/unit/conftest.py"]);
  expect(ownTestsInWriteDir(py, ["tests/kept/test_k.py", "tests/test_a.py"], "tests/kept")).toEqual(["tests/test_a.py"]);
  expect(ownTestsInWriteDir(parseReviewConfig("version: 1\nimage: python:3.12-slim\n" +
    "test_command: python -m pytest {targets}\n"), ["tests/test_a.py", "tests/conftest.py"])).toEqual([]);
  // A crate's own integration tests live in tests/, its generated ones too: only arnx_generated_*.rs are cleared.
  const rs = parseReviewConfig("version: 1\nlanguage: rust\nimage: rust:1-bookworm\n" +
    "test_command: cargo nextest run {targets}\n");
  expect(writeDirOf(rs)).toBe("tests");
  expect(ownTestsInWriteDir(rs, ["tests/basic.rs", "tests/common/mod.rs", "tests/arnx_20261012_ab_calc.rs",
    "src/lib.rs"])).toEqual([]);
});
