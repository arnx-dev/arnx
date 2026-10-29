// `arnx setup --baseline` and doctor's word on known_failing, through the CLI with suites outside Docker.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isProven, loadReviewFile, reviewConfigPath } from "../src/config";
import { Cli } from "./helpers/cli";
import { fakeFactory } from "./helpers/fakes";
import { gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const ENV = { ANTHROPIC_API_KEY: "a" };
const OLD = `version: 1
image: python:3.12-slim
install: [pip install pytest]
test_command: python -m pytest -q {targets}
known_failing: [tests/test_net.py]
notes: [tests/test_net.py calls a public API]
`;

type Row = [string, string, string, string];
const suite = (rows: Row[] | null) => fakeFactory(() => [rows && junitXml(rows), "", false]);
const ROWS: Row[] = [["tests/test_a.py", "test_a", "passed", ""], ["tests/test_net.py", "test_offline", "passed", ""],
  ["tests/test_net.py", "test_live", "failed", "socket.gaierror: [Errno -3] Temporary failure in name resolution"]];

function repoWith(yaml: string): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), yaml);
  return repo;
}

test("setup --baseline turns known_failing into the failing tests themselves, says what changed and proves the file",
  async () => {
    const repo = repoWith(OLD);
    const doctor = new Cli({ cwd: repo, env: ENV });
    await doctor.run("doctor");
    expect(doctor.stdout).toContain("  known_failing sets aside 1 whole test file; `arnx setup --baseline` records the " +
      "failing tests one by one instead, so the passing tests next to them count");
    const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suite(ROWS) });
    expect(await cli.run("setup", "--baseline")).toBe(0);
    expect(cli.stdout).toContain(["Recording the tests each suite fails today (no model, Docker only).", "Changed:",
      "  baseline main: 1 test added",
      "  known_failing removed (1 file): 1 of its tests passes and counts again", "✓ Environment proven"].join("\n"));
    expect(cli.stdout).toContain("Worth a look:\n  ! unresolved-host (1 test in main): add a service by that name, " +
      "or point env at one\n  ! main: 1 test fails today, recorded in .arnx/baseline.json\n");
    const file = loadReviewFile(repo);
    expect(file.projects[0]!.knownFailing).toEqual([]);
    expect(isProven(repo, file)).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, ".arnx", "baseline.json"), "utf8")).projects.main).toEqual([
      { id: "tests/test_net.py::test_live", file: "tests/test_net.py",
        first: "socket.gaierror: [Errno -3] Temporary failure in name resolution", cause: "unresolved-host" }]);
    expect(readFileSync(join(repo, ".arnx", "setup", "approval.md"), "utf8")).toContain("- known_failing removed");
    // Recorded again with nothing new: unchanged.
    const again = new Cli({ cwd: repo, env: ENV, approveSessions: suite(ROWS) });
    expect(await again.run("setup", "--baseline", "--json")).toBe(0);
    expect(JSON.parse(again.stdout)).toMatchObject({ result: "ok", recorded: true, changes: [],
      projects: [{ name: "main", ok: true, failing_today: 1 }] });
  });

test("setup --baseline whose suite does not run changes nothing", async () => {
  const repo = repoWith(OLD);
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suite([["tests/test_a.py", "test_a", "failed", "x"]]) });
  expect(await cli.run("setup", "--baseline")).toBe(2);
  expect(cli.stdout).toContain("Not recorded (nothing changed):\n✗ 1 failed; no test passed, so the suite does not run yet");
  expect(readFileSync(reviewConfigPath(repo), "utf8")).toBe(OLD);
  expect(existsSync(join(repo, ".arnx", "baseline.json"))).toBe(false);
});

test("setup --baseline goes on its own", async () => {
  const cli = new Cli({ cwd: repoWith(OLD), env: ENV });
  expect(await cli.run("setup", "--baseline", "--add")).not.toBe(0);
  expect(cli.stderr + cli.stdout).toContain("--baseline records the tests failing today for the whole file");
});

test("setup --baseline records nothing when most of the suite fails: that is the environment", async () => {
  const repo = repoWith(OLD);
  const rows: Row[] = [["tests/test_a.py", "test_a", "passed", ""], ["tests/test_b.py", "test_b", "failed", "refused"],
    ["tests/test_c.py", "test_c", "failed", "refused"]];
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suite(rows) });
  expect(await cli.run("setup", "--baseline")).toBe(2);
  expect(cli.stdout).toContain("most of the suite fails (2 failing, 1 passing), which points to the environment");
  expect(readFileSync(reviewConfigPath(repo), "utf8")).toBe(OLD);
  expect(existsSync(join(repo, ".arnx", "baseline.json"))).toBe(false);
});

test("setup --baseline says what changed in review.yaml since its proof, and records it", async () => {
  const repo = repoWith(OLD);
  expect(await new Cli({ cwd: repo, env: ENV, approveSessions: suite(ROWS) }).run("setup", "--baseline")).toBe(0);
  const text = readFileSync(reviewConfigPath(repo), "utf8");
  writeFileSync(reviewConfigPath(repo), text.replace("python -m pytest -q {targets}", "python -m pytest -q -x {targets}"));
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suite(ROWS) });
  expect(await cli.run("setup", "--baseline")).toBe(0);
  expect(cli.stdout).toContain("test_command `python -m pytest -q {targets}` → `python -m pytest -q -x {targets}`");
  expect(readFileSync(join(repo, ".arnx", "setup", "approval.md"), "utf8")).toContain("- test_command `python -m pytest");
});
