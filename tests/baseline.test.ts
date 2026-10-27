// The per-test baseline: what setup records, how a proof judges against it, how it shrinks, and when it grows.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestResult } from "../src/adapters/types";
import { type Baseline, baselineText, describeBaselineChanges, parseBaseline, readBaseline, testKey, writeBaseline }
  from "../src/baseline";
import { isProven, loadReviewFile, parseReviewConfig, reviewConfigPath } from "../src/config";
import { defaultSettings } from "../src/settings";
import { approveFile, runSetup, suiteOk, withoutKnownFailing } from "../src/setup";
import { baselineLines } from "../src/setupview";
import { fakeFactory, type FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = `version: 1
image: python:3.12-slim
install: [pip install pytest]
test_command: python -m pytest -q {targets}
`;
const t = (file: string, name: string, outcome: string, message = ""): TestResult =>
  ({ testId: `${file}::${name}`, fileAttr: file, name, outcome, message });
const entry = (file: string, name: string, more: Record<string, unknown> = {}) =>
  ({ id: `${file}::${name}`, file, first: "boom", ...more });

test("the file reads back what it was written from, one test per line, and none when it holds no test", () => {
  const b: Baseline = new Map([["api", [entry("tests/test_b.py", "test_b"), entry("tests/test_a.py", "test_a",
    { cause: "connection-refused: db:5432" })]], ["web", []]]);
  const text = baselineText(b)!;
  expect(text.split("\n")).toEqual(['{', '  "version": 1,', '  "projects": {', '    "api": [',
    '      {"id":"tests/test_a.py::test_a","file":"tests/test_a.py","first":"boom","cause":"connection-refused: db:5432"},',
    '      {"id":"tests/test_b.py::test_b","file":"tests/test_b.py","first":"boom"}', '    ]', '  }', '}', '']);
  expect([...parseBaseline(text)]).toEqual([["api", [entry("tests/test_a.py", "test_a",
    { cause: "connection-refused: db:5432" }), entry("tests/test_b.py", "test_b")]]]);
  expect(baselineText(new Map([["api", []]]))).toBeNull();
  const repo = tmp();
  mkdirSync(join(repo, ".arnx"));
  writeBaseline(repo, b);
  expect(readBaseline(repo).get("api")).toHaveLength(2);
  writeBaseline(repo, new Map());
  expect(existsSync(join(repo, ".arnx", "baseline.json"))).toBe(false);
  expect(readBaseline(repo).size).toBe(0);
});

test("a baseline that does not read says how to record it again", () => {
  expect(() => parseBaseline("{")).toThrow("arnx setup --baseline");
  expect(() => parseBaseline(JSON.stringify({ version: 1, projects: { api: [{ id: "x" }] } })))
    .toThrow("projects.api[0] must have id, file and first");
});

test("memory addresses in test ids do not count, so a parameter id holding one matches run to run", () => {
  expect(testKey("t.py::test_x[<Foo object at 0x7f3a2b1c9d00>]")).toBe(testKey("t.py::test_x[<Foo object at 0x7f99aa001122>]"));
  expect(testKey("t.py::test_x[0x10]")).toBe("t.py::test_x[0x10]");
});

test("a suite passes while its failures are in the baseline; a baseline test that passes leaves it", () => {
  const cfg = parseReviewConfig(YAML);
  const base = [entry("tests/test_a.py", "test_a"), entry("tests/test_b.py", "test_b")];
  const [ok, summary, counts] = suiteOk([t("tests/test_a.py", "test_a", "failed"), t("tests/test_b.py", "test_b", "passed"),
    t("tests/test_c.py", "test_c", "passed")], cfg, undefined, undefined, base);
  expect([ok, summary]).toEqual([true, "1 failed, 2 passed (1 in the baseline)"]);
  expect(counts).toMatchObject({ baselineFailing: 1, left: ["tests/test_b.py::test_b"], unexpected: [] });
  const [bad, why] = suiteOk([t("tests/test_a.py", "test_a", "failed"), t("tests/test_c.py", "test_c", "failed"),
    t("tests/test_b.py", "test_b", "passed")], cfg, undefined, undefined, base);
  expect([bad, why]).toEqual([false, "2 failed, 1 passed (1 in the baseline); failing outside the baseline: " +
    "tests/test_c.py::test_c"]);
});

test("a flaky baseline test stays while the suite has it, passing or not, and leaves once the suite does not", () => {
  const cfg = parseReviewConfig(YAML);
  const base = [entry("tests/test_a.py", "test_a", { flaky: true })];
  const pass = [t("tests/test_a.py", "test_a", "passed"), t("tests/test_c.py", "test_c", "passed")];
  expect(suiteOk(pass, cfg, undefined, undefined, base)[2].left).toEqual([]);
  expect(suiteOk(pass.slice(1), cfg, undefined, undefined, base)[2].left).toEqual(["tests/test_a.py::test_a"]);
});

test("while setup records, every failure may fail and is returned to be recorded; no test passing still fails", () => {
  const cfg = parseReviewConfig(YAML);
  const [ok, summary, counts] = suiteOk([t("tests/test_a.py", "test_a", "failed", "E   assert 1 == 2\nmore"),
    t("tests/test_c.py", "test_c", "passed")], cfg, undefined, undefined, "record");
  expect([ok, summary]).toEqual([true, "1 failed, 1 passed"]);
  expect(counts.failed.map((x) => x.testId)).toEqual(["tests/test_a.py::test_a"]);
  expect(suiteOk([t("tests/test_a.py", "test_a", "failed")], cfg, undefined, undefined, "record")[1])
    .toContain("no test passed");
});

function repoWith(yaml: string, base?: Baseline): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), yaml);
  if (base) writeBaseline(repo, base);
  return repo;
}

type Row = [string, string, string, string];
/** Suites by run: the whole suite reports `whole`, a rerun of named files (again.xml) reports `again`. */
const runs = (whole: Row[], again: Row[] = []) => (command: string): [string | null, string, boolean] =>
  [junitXml(command.includes("again.xml") ? again : whole), "", false];

test("a proof drops baseline tests that pass now and stamps the smaller baseline with review.yaml", async () => {
  const repo = repoWith(YAML, new Map([["main", [entry("tests/test_a.py", "test_a"), entry("tests/test_b.py", "test_b")]]]));
  const [ok, , suites] = await approveFile(repo, { by: "Dev", at: "2026-10-27", sessionFactory: fakeFactory(runs([
    ["tests/test_a.py", "test_a", "failed", "boom"], ["tests/test_b.py", "test_b", "passed", ""]])) });
  expect(ok).toBe(true);
  expect(suites[0]).toMatchObject({ baselineFailing: 1, left: ["tests/test_b.py::test_b"] });
  expect(readBaseline(repo).get("main")!.map((x) => x.id)).toEqual(["tests/test_a.py::test_a"]);
  expect(isProven(repo, loadReviewFile(repo, { requireApproved: false }))).toBe(true);
  // Once nothing fails, there is no file, and the stamp holds no baseline.
  await approveFile(repo, { by: "Dev", at: "2026-10-27", sessionFactory: fakeFactory(runs([
    ["tests/test_a.py", "test_a", "passed", ""], ["tests/test_b.py", "test_b", "passed", ""]])) });
  expect(existsSync(join(repo, ".arnx", "baseline.json"))).toBe(false);
  const f = loadReviewFile(repo);
  expect("baseline" in (f.raw.approved as Record<string, unknown>)).toBe(false);
});

test("a proof reruns a test failing outside the baseline: passing then, it does not count and is not recorded", async () => {
  const repo = repoWith(YAML);
  const sessions: FakeSession[] = [];
  const whole: Row[] = [["tests/test_a.py", "test_a", "passed", ""], ["tests/test_b.py", "test_b", "failed", "timing"]];
  const [ok, , suites] = await approveFile(repo, { by: "Dev", at: "2026-10-27",
    sessionFactory: fakeFactory(runs(whole, [["tests/test_b.py", "test_b", "passed", ""]]), sessions) });
  expect(ok).toBe(true);
  expect(suites[0]!.flaky).toEqual(["tests/test_b.py::test_b"]);
  expect(sessions[0]!.commands.some((c) => c.includes("again.xml") && c.includes("tests/test_b.py"))).toBe(true);
  expect(existsSync(join(repo, ".arnx", "baseline.json"))).toBe(false); // a proof never adds to the baseline
  // Failing again on the rerun, it fails the proof.
  const [bad, detail] = await approveFile(repo, { by: "Dev", at: "2026-10-27",
    sessionFactory: fakeFactory(runs(whole, [["tests/test_b.py", "test_b", "failed", "timing"]])) });
  expect(bad).toBe(false);
  expect(detail).toContain("failing outside the baseline:\n  tests/test_b.py::test_b");
});

test("right after setup recorded the baseline, a test failing outside it joins it as flaky", async () => {
  const repo = repoWith(YAML);
  const whole: Row[] = [["tests/test_a.py", "test_a", "passed", ""], ["tests/test_b.py", "test_b", "failed", "timing"]];
  const [ok] = await approveFile(repo, { by: "Dev", at: "2026-10-27", afterSetup: true,
    sessionFactory: fakeFactory(runs(whole, whole)) });
  expect(ok).toBe(true);
  expect(readBaseline(repo).get("main")).toEqual([{ id: "tests/test_b.py::test_b", file: "tests/test_b.py",
    first: "timing", flaky: true }]);
});

const SVC = YAML.replace("test_command:", "services:\n  db: {image: postgres:16}\ntest_command:");

test("failures that look like the environment go back to the agent once; tried again unchanged, they are recorded " +
  "with their cause and the suite does not run again", async () => {
  const commands: string[] = [];
  const refused = "psycopg.OperationalError: connection to server at \"db\" (10.0.0.2), port 5432 failed: Connection refused";
  const script = (command: string): [string | null, string, boolean] => {
    commands.push(command);
    return [junitXml([["tests/test_a.py", "test_a", "passed", ""], ["tests/test_b.py", "test_b", "passed", ""],
      ["tests/test_db.py", "test_db", "failed", refused], ["tests/test_calc.py", "test_calc", "failed", "assert 2 == 3"]]),
    "", false];
  };
  const model = new ScriptedAgent([[tool("try_project", { yaml: SVC })], [tool("try_project", { yaml: SVC })],
    [tool("propose", { yaml: SVC })], [text("done")]]);
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir: join(tmp(), "s"),
    sessionFactory: fakeFactory(script) });
  const first = String((model.calls[1]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content);
  expect(first).toContain("the suite of main runs (2 failed, 2 passed), but its failures are not recorded yet:\n" +
    "1 failing test fails on the environment, not the code.");
  expect(first).toContain("service `db` refuses connections");
  expect(first).toContain("try the project again unchanged");
  expect(r.ok).toBe(true);
  expect(commands.filter((c) => c.includes("suite.xml"))).toHaveLength(1);
  const byId = (x: { id: string }, y: { id: string }) => x.id < y.id ? -1 : 1;
  expect([...r.projects[0]!.failed!].sort(byId)).toEqual([
    { id: "tests/test_calc.py::test_calc", file: "tests/test_calc.py", first: "assert 2 == 3" },
    { id: "tests/test_db.py::test_db", file: "tests/test_db.py", first: refused, cause: "connection-refused: db" },
  ]);
});

test("known_failing comes out of a proposal with the rest of the file as it was written", () => {
  const yaml = "version: 1\nprojects:\n  api:\n    root: .\n    install: [pip install pytest]  # keep\n" +
    "    known_failing: [tests/test_net.py]\n    test_command: pytest {targets}\n";
  expect(withoutKnownFailing(yaml)).toEqual(["version: 1\nprojects:\n  api:\n    root: .\n" +
    "    install: [pip install pytest] # keep\n    test_command: pytest {targets}\n", true]);
  expect(withoutKnownFailing(YAML)).toEqual([YAML, false]);
});

test("worth a look: per project, how many tests fail today, with their causes and flaky ones", () => {
  const file = loadReviewFile(repoWith(YAML), { requireApproved: false });
  const base: Baseline = new Map([["main", [entry("a.py", "x", { cause: "connection-refused: db" }),
    entry("a.py", "y", { cause: "connection-refused: db" }), entry("b.py", "z", { flaky: true }), entry("c.py", "w")]]]);
  expect(baselineLines(file, base)).toEqual(["main: 4 tests fail today, recorded in .arnx/baseline.json " +
    "(2 connection-refused: db; 1 flaky)"]);
  expect(baselineLines(file, new Map())).toEqual([]);
});

test("the baseline's changes are named per project", () => {
  const old: Baseline = new Map([["api", [entry("a.py", "x"), entry("a.py", "y")]]]);
  const now: Baseline = new Map([["api", [entry("a.py", "x"), entry("b.py", "z"), entry("b.py", "w")]],
    ["web", [entry("c.py", "v")]]]);
  expect(describeBaselineChanges(old, now)).toEqual(["baseline api: 2 tests added, 1 left", "baseline web: 1 test added"]);
});
