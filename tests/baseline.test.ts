// The per-test baseline: what setup records, how a proof judges against it, how it shrinks, and when it grows.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestResult } from "../src/adapters/types";
import { type Baseline, baselineText, describeBaselineChanges, parseBaseline, readBaseline, testKey, writeBaseline }
  from "../src/baseline";
import { isProven, loadReviewFile, parseReviewConfig, parseReviewFile, reviewConfigPath } from "../src/config";
import { defaultSettings } from "../src/settings";
import { snapshot, snapshotDigest } from "../src/change";
import { approveFile, coverageGap, envDigest, runSetup, type SetupRun, suiteOk, withoutKnownFailing } from "../src/setup";
import { approvalChecks, baselineLines, environmentLines, worthALook } from "../src/setupview";
import { fakeFactory, type FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { gitRepo, runGit } from "./helpers/gitutil";
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
  // A hex value as a parameter is the test's own: two of them stay two tests.
  expect(testKey("t.py::test_parse[0xdeadbeef]")).not.toBe(testKey("t.py::test_parse[0xcafebabe]"));
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

test("a flaky baseline test leaves once it passes, like any other", () => {
  const cfg = parseReviewConfig(YAML);
  const base = [entry("tests/test_a.py", "test_a", { flaky: true })];
  const pass = [t("tests/test_a.py", "test_a", "passed"), t("tests/test_c.py", "test_c", "passed")];
  expect(suiteOk(pass, cfg, undefined, undefined, base)[2].left).toEqual(["tests/test_a.py::test_a"]);
  expect(suiteOk([t("tests/test_a.py", "test_a", "failed"), pass[1]!], cfg, undefined, undefined, base)[2].left)
    .toEqual([]);
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

function repoWith(yaml: string, base?: Baseline, name = "repo"): string {
  const repo = gitRepo(join(tmp(), name));
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

/** A run of setup that proved `name` on the repository's code as it is now, with an older part of review.yaml (so it
 * does not stand, and the suite runs again). */
function olderRun(repo: string, name = "main"): SetupRun {
  const dest = join(tmp(), `snap-${name}`);
  snapshot(repo, null, dest);
  const cfg = loadReviewFile(repo, { requireApproved: false }).projects[0]!;
  const [, summary, counts] = suiteOk([t("tests/test_a.py", "test_a", "passed")], cfg, undefined, undefined, "record");
  return { name, digest: "an older file", env: envDigest(cfg), snapshot: snapshotDigest(dest), untracked: false,
    summary, after: "", skips: [], counts };
}

test("right after setup, a project run again on setup's code and environment: a test failing outside its baseline " +
  "joins it as flaky", async () => {
  const repo = repoWith(YAML);
  const whole: Row[] = [["tests/test_a.py", "test_a", "passed", ""], ["tests/test_b.py", "test_b", "failed", "timing"]];
  const [ok] = await approveFile(repo, { by: "Dev", at: "2026-10-27", afterSetup: [olderRun(repo)],
    sessionFactory: fakeFactory(runs(whole, whole)) });
  expect(ok).toBe(true);
  expect(readBaseline(repo).get("main")).toEqual([{ id: "tests/test_b.py::test_b", file: "tests/test_b.py",
    first: "timing", flaky: true }]);
  // A project setup did not run this time (setup --add) gets no such pass: a test failing twice fails the proof.
  const other = repoWith(YAML, undefined, "other");
  const [kept] = await approveFile(other, { by: "Dev", at: "2026-10-27", afterSetup: [olderRun(other, "web")],
    sessionFactory: fakeFactory(runs(whole, whole)) });
  expect(kept).toBe(false);
  // Nor does one whose code changed since setup's run: the change may be what fails.
  const edited = repoWith(YAML, undefined, "edited");
  const run = olderRun(edited);
  writeFileSync(join(edited, "app.py"), "def add(a, b):\n    return a - b\n");
  const [changed] = await approveFile(edited, { by: "Dev", at: "2026-10-27", afterSetup: [run],
    sessionFactory: fakeFactory(runs(whole, whole)) });
  expect(changed).toBe(false);
});

test("right after setup, most of the suite failing is the environment: the proof fails, nothing joins", async () => {
  const repo = repoWith(YAML);
  const whole: Row[] = [["tests/test_a.py", "test_a", "passed", ""], ["tests/test_b.py", "test_b", "failed", "refused"],
    ["tests/test_c.py", "test_c", "failed", "refused"]];
  const [ok] = await approveFile(repo, { by: "Dev", at: "2026-10-27", afterSetup: [olderRun(repo)],
    sessionFactory: fakeFactory(runs(whole, whole)) });
  expect(ok).toBe(false);
  expect(existsSync(join(repo, ".arnx", "baseline.json"))).toBe(false);
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

test("approve --project refuses a baseline changed since its proof: other projects' entries would go unproven",
  async () => {
    const yaml = "version: 1\nprojects:\n  api:\n    root: .\n    language: python\n    image: python:3.12\n" +
      "    test_command: pytest {targets}\n  web:\n    root: web\n    language: python\n    image: python:3.12\n" +
      "    test_command: pytest {targets}\n";
    const repo = repoWith(yaml);
    const pass = fakeFactory(runs([["tests/test_a.py", "test_a", "passed", ""]]));
    expect((await approveFile(repo, { by: "Dev", at: "x", sessionFactory: pass }))[0]).toBe(true);
    writeBaseline(repo, new Map([["web", [entry("web/tests/test_w.py", "test_w")]]]));
    const [ok, why] = await approveFile(repo, { by: "Dev", at: "x", project: "api", sessionFactory: pass });
    expect([ok, why]).toEqual([false, ".arnx/baseline.json changed since its proof; run `arnx approve` without " +
      "--project"]);
  });

test("setup --project keeps a kept project's known_failing as it is: it must stay as approved", async () => {
  const yaml = "version: 1\nprojects:\n  api:\n    root: .\n    language: python\n    image: python:3.12\n" +
    "    test_command: pytest {targets}\n    owns: [app.py, tests/]\n    known_failing: [tests/test_net.py]\n" +
    "  web:\n    root: web\n    language: python\n    image: python:3.12\n    test_command: pytest {targets}\n" +
    "uncovered:\n  - {path: '**', reason: rest}\n";
  const repo = repoWith(yaml);
  const model = new ScriptedAgent([[tool("try_project", { yaml, project: "web" })], [tool("propose", { yaml })],
    [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "s"), project: "web",
    sessionFactory: fakeFactory(runs([["web/tests/test_w.py", "test_w", "passed", ""]])) });
  expect(r.ok).toBe(true);
  expect(r.yamlText).toContain("known_failing: [tests/test_net.py]");
});

test("known_failing comes out of a proposal with the rest of the file as it was written", () => {
  const yaml = "version: 1\nprojects:\n  api:\n    root: .\n    install: [pip install pytest]  # keep\n" +
    "    known_failing: [tests/test_net.py]\n    test_command: pytest {targets}\n";
  expect(withoutKnownFailing(yaml)).toEqual(["version: 1\nprojects:\n  api:\n    root: .\n" +
    "    install: [pip install pytest] # keep\n    test_command: pytest {targets}\n", true]);
  expect(withoutKnownFailing(YAML)).toEqual([YAML, false]);
  expect(withoutKnownFailing(yaml, new Set(["api"]))).toEqual([yaml, false]);
});

test("worth a look: per project, how many tests fail today, with their causes and flaky ones", () => {
  const file = loadReviewFile(repoWith(YAML), { requireApproved: false });
  const base: Baseline = new Map([["main", [entry("a.py", "x", { cause: "connection-refused: db" }),
    entry("a.py", "y", { cause: "connection-refused: db" }), entry("b.py", "z", { flaky: true }), entry("c.py", "w"),
    entry("d.py", "v", { cause: "order-dependent" })]]]);
  // The environment's causes have lines of their own (environmentLines).
  expect(baselineLines(file, base)).toEqual(["main: 5 tests fail today, recorded in .arnx/baseline.json " +
    "(1 flaky; 1 order-dependent)"]);
  expect(baselineLines(file, new Map())).toEqual([]);
});

test("worth a look: environment faults first, one line per cause with its count and what to fix", () => {
  const repo = repoWith(YAML);
  const file = loadReviewFile(repo, { requireApproved: false });
  const base: Baseline = new Map([["main", [entry("a.py", "x", { cause: "connection-refused: db:5432" }),
    entry("a.py", "y", { cause: "connection-refused: db:5432" }), entry("b.py", "z", { cause: "env-value: API_URL" }),
    { ...entry("c.py", "c.py"), load: true as const, cause: "missing-package: pg" },
    entry("e.py", "f", { cause: "connection-refused: db:5432", flaky: true }), entry("f.py", "g")]]]);
  expect(environmentLines(file, base)).toEqual([
    "connection-refused: db:5432 (2 tests in main): nothing listens there; add the service, or fix its host and " +
      "port in env",
    "env-value: API_URL (1 test in main): the value env gives does not work; set one that does",
    "missing-package: pg (1 test file that does not load in main): add it to install"]);
  writeBaseline(repo, base);
  const look = worthALook(file, repo, {});
  expect(look.slice(0, 4)).toEqual([...environmentLines(file, base), baselineLines(file, base)[0]!]);
  expect(environmentLines(file, new Map([["main", [entry("f.py", "g")]]]))).toEqual([]);
});

test("the baseline's changes are named per project", () => {
  const old: Baseline = new Map([["api", [entry("a.py", "x"), entry("a.py", "y")]]]);
  const now: Baseline = new Map([["api", [entry("a.py", "x"), entry("b.py", "z"), entry("b.py", "w")]],
    ["web", [entry("c.py", "v")]]]);
  expect(describeBaselineChanges(old, now)).toEqual(["baseline api: 2 tests added, 1 left", "baseline web: 1 test added"]);
});

/** A snapshot with `n` test files in each folder, for the coverage check. */
function testTree(dirs: Record<string, number>): string {
  const snap = join(tmp(), "snap");
  for (const [dir, n] of Object.entries(dirs)) {
    mkdirSync(join(snap, dir), { recursive: true });
    for (let i = 0; i < n; i++) writeFileSync(join(snap, dir, `test_${i}.py`), "def test_x():\n    pass\n");
  }
  return snap;
}

test("tests that test_command leaves out are named: files no run reported, and fewer tests than an earlier try", () => {
  const cfg = parseReviewConfig(YAML);
  const snap = testTree({ "tests/boundary": 30, "src/domain": 5 });
  const ran = Array.from({ length: 5 }, (_, i) => t(`src/domain/test_${i}.py`, "test_x", "passed"));
  expect(coverageGap(cfg, snap, ran, undefined)).toEqual({ line: "30 of 35 files that look like tests never ran " +
    "(tests/boundary 30)" });
  // A runner reporting paths from its own root further down still counts as having run them.
  expect(coverageGap(cfg, snap, ran.map((r) => ({ ...r, fileAttr: r.fileAttr.replace("src/", "") })), undefined))
    .toEqual({ line: "30 of 35 files that look like tests never ran (tests/boundary 30)" });
  expect(coverageGap(cfg, snap, ran, { tests: 100, command: "pytest -k fast {targets}" })!.line).toBe(
    "30 of 35 files that look like tests never ran (tests/boundary 30); it runs 5 tests where an earlier try ran 100 " +
    "(`pytest -k fast {targets}`)");
  // Another project's folder and paths listed under uncovered are not this project's to run.
  expect(coverageGap(cfg, snap, ran, undefined, undefined, (p) => p.startsWith("tests/boundary"))).toBeNull();
  // A few files, or a small share, are left alone.
  expect(coverageGap(cfg, testTree({ "tests/boundary": 30, "src/domain": 200 }),
    Array.from({ length: 200 }, (_, i) => t(`src/domain/test_${i}.py`, "test_x", "passed")), undefined)).toBeNull();
});

test("setup sends tests left out of test_command back to the agent once; kept, they are worth a look", async () => {
  const repo = gitRepo(join(tmp(), "gap"));
  mkdirSync(join(repo, "tests", "slow"), { recursive: true });
  for (let i = 0; i < 25; i++) writeFileSync(join(repo, "tests", "slow", `test_s${i}.py`), "def test_s():\n    pass\n");
  writeFileSync(join(repo, "tests", "test_fast.py"), "def test_f():\n    pass\n");
  runGit(repo, "add", "-A");
  runGit(repo, "commit", "-qm", "tests");
  const narrow = YAML.replace("{targets}", "tests/test_fast.py {targets}");
  const commands: string[] = [];
  const script = (command: string): [string | null, string, boolean] => {
    commands.push(command);
    return [junitXml([["tests/test_fast.py", "test_f", "passed", ""]]), "", false];
  };
  const model = new ScriptedAgent([[tool("try_project", { yaml: narrow })], [tool("try_project", { yaml: narrow })],
    [tool("propose", { yaml: narrow })], [text("the slow tests need hardware")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "s"), sessionFactory: fakeFactory(script) });
  const first = String((model.calls[1]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content);
  expect(first).toContain("but 25 of 26 files that look like tests never ran (tests/slow 25)");
  expect(first).toContain("try the project again unchanged");
  expect(r.ok).toBe(true);
  expect(commands.filter((c) => c.includes("suite.xml"))).toHaveLength(1); // the kept run is not run again
  expect(r.projects[0]!.gap).toBe("25 of 26 files that look like tests never ran (tests/slow 25)");
  expect(approvalChecks(parseReviewFile(narrow), r.projects)).toContain("main: 25 of 26 files that look like tests " +
    "never ran (tests/slow 25); test_command leaves them out");
});
