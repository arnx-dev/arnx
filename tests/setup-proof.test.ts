// The proof right after setup: setup's last whole-suite run of a project stands while the project's part of
// review.yaml, its environment and the code are what that run had; anything else runs again.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readBaseline, writeBaseline } from "../src/baseline";
import { snapshot, snapshotDigest } from "../src/change";
import { approvalStamp, reviewConfigPath } from "../src/config";
import { defaultSettings } from "../src/settings";
import type { Runner, SessionFactory } from "../src/sandbox";
import { approveFile, runSetup, type SetupResult } from "../src/setup";
import { Cli } from "./helpers/cli";
import { fakeFactory, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = `version: 1
image: python:3.12-slim
install: [pip install pytest]
test_command: python -m pytest -q {targets}
`;
type Row = [string, string, string, string];
const A: Row = ["tests/test_a.py", "test_a", "passed", ""];
const B_FAILS: Row = ["tests/test_b.py", "test_b", "failed", "assert 2 == 3"];

/** The snapshot digest of the repository's working tree as a proof would take it. */
function codeOf(repo: string, untracked = false, name = "snap"): string {
  const dest = join(tmp(), name);
  snapshot(repo, null, dest, [], { untracked });
  return snapshotDigest(dest);
}

test("the snapshot digest shows a file edited, added, made executable or let in, and nothing else", () => {
  const repo = gitRepo(tmp());
  const first = codeOf(repo, false, "s1");
  expect(codeOf(repo, false, "s2")).toBe(first);
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(join(repo, ".arnx", "review.yaml"), YAML); // arnx's own files never reach a snapshot
  writeFileSync(join(repo, "notes.md"), "scratch\n"); // untracked: only when untracked files are let in
  expect(codeOf(repo, false, "s3")).toBe(first);
  expect(codeOf(repo, true, "s4")).not.toBe(first);
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const edited = codeOf(repo, false, "s5");
  expect(edited).not.toBe(first);
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a + b\n");
  expect(codeOf(repo, false, "s6")).toBe(first);
  chmodSync(join(repo, "app.py"), 0o755);
  expect(codeOf(repo, false, "s7")).not.toBe(first);
});

/** runSetup over `repo` with YAML tried and proposed, its suite answering `script`; the file and the baseline written
 * as setup writes them. */
async function setUp(repo: string, script: (command: string, n: number) => [string | null, string, boolean],
                     tries = 1): Promise<SetupResult> {
  const steps = [...Array.from({ length: tries }, () => [tool("try_project", { yaml: YAML })]),
    [tool("propose", { yaml: YAML })], [text("done")]];
  const r = await runSetup(repo, defaultSettings(), new ScriptedAgent(steps), { outDir: join(tmp(), "out"),
    sessionFactory: fakeFactory(script) });
  expect(r.ok).toBe(true);
  writeFileSync(reviewConfigPath(repo), r.yamlText!);
  writeBaseline(repo, new Map(r.projects.map((p) => [p.name, p.failed ?? []])));
  return r;
}

const whole = (rows: Row[]) => (): [string, string, boolean] => [junitXml(rows), "", false];

test("right after setup, setup's run is the proof: no suite runs, the baseline stays as recorded, the file is stamped",
  async () => {
    const repo = gitRepo(tmp());
    const r = await setUp(repo, whole([A, B_FAILS]));
    expect(r.runs.map((x) => x.name)).toEqual(["main"]);
    const sessions: FakeSession[] = [];
    const lines: string[] = [];
    const [ok, , suites] = await approveFile(repo, { by: "Dev", at: "2026-10-28", afterSetup: r.runs,
      sessionFactory: fakeFactory(whole([A]), sessions), progress: (l) => lines.push(l) });
    expect(ok).toBe(true);
    expect(sessions).toHaveLength(0);
    expect(suites[0]).toMatchObject({ reused: true, summary: "1 failed, 1 passed (1 in the baseline)",
      baselineFailing: 1, left: [], flaky: [] });
    expect(lines).toEqual(["main: ✓ setup's run stands: 1 failed, 1 passed (1 in the baseline)"]);
    expect(readBaseline(repo).get("main")!.map((x) => x.id)).toEqual(["tests/test_b.py::test_b"]);
    expect(approvalStamp(repo)).toMatchObject({ by: "Dev", current: true });
  });

test("a file edited after setup's run proves again, and a test it breaks is not taken for flaky", async () => {
  const repo = gitRepo(tmp());
  const r = await setUp(repo, whole([A]));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const sessions: FakeSession[] = [];
  const [ok, detail, suites] = await approveFile(repo, { by: "Dev", at: "2026-10-28", afterSetup: r.runs,
    sessionFactory: fakeFactory(whole([A, B_FAILS]), sessions) });
  expect(sessions).toHaveLength(1);
  expect(suites[0]!.reused).toBeUndefined();
  expect(ok).toBe(false);
  expect(detail).toContain("failing outside the baseline:\n  tests/test_b.py::test_b");
});

test("a project whose part of review.yaml changed after setup's run runs again", async () => {
  const repo = gitRepo(tmp());
  const r = await setUp(repo, whole([A]));
  writeFileSync(reviewConfigPath(repo), `${r.yamlText!.trimEnd()}\nnotes: [edited after setup]\n`);
  const sessions: FakeSession[] = [];
  const [ok, , suites] = await approveFile(repo, { by: "Dev", at: "2026-10-28", afterSetup: r.runs,
    sessionFactory: fakeFactory(whole([A]), sessions) });
  expect([ok, sessions.length, suites[0]!.reused]).toEqual([true, 1, undefined]);
});

test("the run kept is the whole suite's, not the rerun of the files that failed", async () => {
  const repo = gitRepo(tmp());
  const runs: string[] = [];
  // First try: the only test fails, so the suite does not run yet. Second: the failing file passes on its own, then
  // the whole suite runs.
  const r = await setUp(repo, (command) => {
    runs.push(command);
    if (!command.includes("suite.xml")) return [junitXml([A]), "", false];
    return [junitXml(runs.length === 1 ? [["tests/test_a.py", "test_a", "failed", "boom"]]
      : command.includes("tests/test_a.py") ? [A] : [A, ["tests/test_c.py", "test_c", "passed", ""]]), "", false];
  }, 2);
  expect(runs.filter((c) => c.includes("suite.xml"))).toHaveLength(3);
  expect(r.runs[0]!.counts.all.map((t) => t.testId)).toEqual(["tests/test_a.py::test_a", "tests/test_c.py::test_c"]);
  const [ok, , suites] = await approveFile(repo, { by: "Dev", at: "2026-10-28", afterSetup: r.runs,
    sessionFactory: fakeFactory(whole([])) });
  expect([ok, suites[0]!.summary, suites[0]!.reused]).toEqual([true, "2 passed", true]);
});

test("approve without setup's runs proves every suite as before", async () => {
  const repo = gitRepo(tmp());
  await setUp(repo, whole([A]));
  const sessions: FakeSession[] = [];
  const [ok] = await approveFile(repo, { by: "Dev", at: "2026-10-28", sessionFactory: fakeFactory(whole([A]), sessions) });
  expect([ok, sessions.length]).toEqual([true, 1]);
});

// The command: setup's approval runs nothing unless the working tree changed during setup.
const ENV = { ANTHROPIC_API_KEY: "a" };
const GOOD = "version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
  "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n";
const PASS: Row = ["tests/test_pricing.py", "test_total", "passed", ""];

const suites = (runs: string[], during?: () => void): SessionFactory =>
  async <T>(cfg: { name: string }, snap: string, _log: string, body: (r: Runner) => Promise<T>) => {
    runs.push(cfg.name);
    during?.();
    return body(new FakeSession(snap, () => [junitXml([PASS]), "out", false]));
  };

async function shop(name = "shop"): Promise<string> {
  const repo = initRepo(join(tmp(), name));
  writeFileSync(join(repo, "pyproject.toml"), "[project]\nname = \"shop\"\n");
  writeFileSync(join(repo, "pricing.py"), "def total(xs):\n    return sum(xs)\n");
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests", "test_pricing.py"), "def test_total():\n    assert True\n");
  commit(repo, "shop");
  const cli = new Cli({ cwd: repo, env: ENV });
  expect(await cli.run("init")).toBe(0);
  expect(await cli.run("consent", "--yes")).toBe(0);
  return repo;
}

const agent = () => new ScriptedAgent([[tool("try_project", { yaml: GOOD })], [tool("propose", { yaml: GOOD })],
  [text("done")]]);

test("setup proves the file with its own runs, and runs a suite again only when the code changed meanwhile",
  async () => {
    const repo = await shop();
    const [setupRuns, approveRuns] = [[] as string[], [] as string[]];
    const cli = new Cli({ cwd: repo, env: ENV, setupModel: agent(), setupSessions: suites(setupRuns),
      approveSessions: suites(approveRuns) });
    expect(await cli.run("setup")).toBe(0);
    expect([setupRuns, approveRuns]).toEqual([["shop"], []]);
    expect(cli.stderr).toContain("shop: ✓ setup's run stands: 1 passed");
    expect(approvalStamp(repo)).toMatchObject({ current: true });

    const again = await shop("edited");
    const edited: string[] = [];
    const cli2 = new Cli({ cwd: again, env: ENV, setupModel: agent(),
      setupSessions: suites([], () => writeFileSync(join(again, "pricing.py"), "def total(xs):\n    return 0\n")),
      approveSessions: suites(edited) });
    expect(await cli2.run("setup")).toBe(0);
    expect(edited).toEqual(["shop"]);
  });
