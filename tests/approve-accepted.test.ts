// Tests kept by `arnx accept` fail by design until their bug is fixed: approve and setup let them fail while each file
// matches its pin (check's trust rules), and still refuse one changed since accept. A failing approval names a few
// tests and where the whole output is, not the end of the runner's output.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestResult } from "../src/adapters/types";
import { ACCEPTED_RECORD } from "../src/check";
import { isFileApproved, parseReviewConfig, parseReviewFile, reviewConfigPath } from "../src/config";
import { defaultSettings } from "../src/settings";
import type { SessionFactory } from "../src/sandbox";
import { sandboxOptions } from "../src/sandbox";
import { approveFile, runSetup, suiteOk } from "../src/setup";
import { Cli } from "./helpers/cli";
import { FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
const KEPT = "tests/arnx/r20261011_a1b2c3/test_y.py";
const SOURCE = "def test_y():\n    assert False\n";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const t = (file: string, outcome: string): TestResult => ({ testId: `${file}::t`, fileAttr: file, name: "t", outcome,
  message: "" });
const CFG = parseReviewConfig("version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n");

test("a pinned accepted test that fails does not block the suite; it is counted", () => {
  const [ok, summary, counts] = suiteOk([t("tests/test_a.py", "passed"), t(KEPT, "failed")], CFG,
    { pinned: [KEPT], changed: [] });
  expect([ok, summary]).toEqual([true, "1 passed (1 accepted test still fails)"]);
  expect(counts).toMatchObject({ acceptedFailing: 1, unexpected: [] });
  // Not pinned (accept never recorded it), it is a failure like any other.
  const [bad, why, c2] = suiteOk([t("tests/test_a.py", "passed"), t(KEPT, "failed")], CFG, { pinned: [], changed: [] });
  expect(bad).toBe(false);
  expect(why).toContain("failing outside the baseline");
  expect(c2.unexpected).toEqual([`${KEPT}::t`]);
  // Accepted tests alone do not make a suite that runs.
  expect(suiteOk([t(KEPT, "failed")], CFG, { pinned: [KEPT], changed: [] })[1]).toContain("no test passed");
});

test("an accepted test changed since accept blocks the suite, named, even when it passes", () => {
  const [ok, summary] = suiteOk([t("tests/test_a.py", "passed"), t(KEPT, "passed")], CFG,
    { pinned: [], changed: [{ path: KEPT, review: "r", change: "modified" }] });
  expect(ok).toBe(false);
  expect(summary).toContain(`accepted test changed since \`arnx accept\`: modified ${KEPT}`);
});

/** A docker that only answers `docker info` (approve checks Docker runs; its suites run in a fake session). */
function dockerThatRuns(): string {
  const dir = join(tmp(), "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "docker"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "docker"), 0o755);
  return join(dir, "docker");
}

/** One project at the root, with an accepted test pinned and committed (red: the bug is not fixed). */
async function acceptedRepo(): Promise<{ repo: string; cli: Cli }> {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, approveSessions: suite([["tests/test_a.py", "test_a", "passed", ""],
    [KEPT, "test_y", "failed", "assert False"]]) });
  expect(await cli.run("init")).toBe(0);
  writeFileSync(reviewConfigPath(repo), "version: 1\nprojects:\n  app:\n    root: .\n    image: python:3.12-slim\n" +
    "    test_command: python -m pytest {targets}\n");
  mkdirSync(join(repo, KEPT, ".."), { recursive: true });
  writeFileSync(join(repo, KEPT), SOURCE);
  writeFileSync(join(repo, ACCEPTED_RECORD), JSON.stringify({ schema_version: 1,
    files: { [KEPT]: { sha256: sha(SOURCE), review: "20261011-a1b2c3" } } }));
  commit(repo, "accepted tests");
  return { repo, cli };
}

const suite = (cases: [string, string, string, string][], output = "RAW RUNNER OUTPUT"): SessionFactory =>
  async (_cfg, snap, _log, body) => body(new FakeSession(snap, () => [junitXml(cases), output, false]));

test("approve passes with accepted tests still red, in one line; a changed one blocks, named", async () => {
  const saved = sandboxOptions.docker;
  try {
    sandboxOptions.docker = dockerThatRuns();
    const { repo, cli } = await acceptedRepo();
    expect(await cli.run("approve", "--yes", "--quiet")).toBe(0);
    expect(cli.out).toContain("✓ Environment proven");
    expect(cli.out).toContain("1 accepted test still fails (bugs not fixed yet): arnx check");
    expect(cli.stdout).not.toContain("Approved.");
    expect(isFileApproved(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")))).toBe(true);
    writeFileSync(join(repo, KEPT), "def test_y():\n    assert True\n");
    cli.out.length = 0;
    expect(await cli.run("approve", "--yes", "--quiet")).toBe(2);
    expect(cli.stdout).toContain(`modified ${KEPT}`);
  } finally {
    sandboxOptions.docker = saved;
  }
});

test("approve --json: each project's accepted_failing and unexpected tests", async () => {
  const saved = sandboxOptions.docker;
  try {
    sandboxOptions.docker = dockerThatRuns();
    const { cli } = await acceptedRepo();
    cli.out.length = 0;
    expect(await cli.run("approve", "--yes", "--json", "--quiet")).toBe(0);
    expect(JSON.parse(cli.stdout).projects).toEqual([{ name: "app", ok: true, summary: "1 passed (1 accepted test still fails)",
      accepted_failing: 1, unexpected: [] }]);
  } finally {
    sandboxOptions.docker = saved;
  }
});

test("a failing approval names 5 tests, how many more, and where the whole output is", async () => {
  const repo = gitRepo(tmp());
  for (const p of ["services/pay/a.py", "services/feed/b.py", "services/shared/db.py", "infra/main.tf"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "X = 1\n");
  }
  commit(repo, "layout");
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(reviewConfigPath(repo), PROJECTS);
  const cases = [0, 1, 2, 3, 4, 5, 6].map((i): [string, string, string, string] =>
    [`tests/test_${i}.py`, `test_${i}`, "failed", "boom"]);
  const [ok, detail, projects] = await approveFile(repo, { by: "Dev", at: "x", sessionFactory: suite(cases) });
  expect(ok).toBe(false);
  const ids = cases.map(([f, n]) => `${f}::${n}`);
  expect(detail.split("\n\n")[0]).toBe([
    "✗ pay: 7 failed; failing outside the baseline:",
    ...ids.slice(0, 5).map((id) => `  ${id}`),
    "  and 2 more",
    "  Full output: .arnx/run/approve-pay.log",
  ].join("\n"));
  expect(detail).not.toContain("RAW RUNNER OUTPUT");
  expect(readFileSync(join(repo, ".arnx", "run", "approve-pay.log"), "utf8")).toContain("RAW RUNNER OUTPUT");
  expect(projects.map((p) => [p.name, p.ok, p.acceptedFailing, p.unexpected.length, p.log])).toEqual([
    ["pay", false, 0, 7, ".arnx/run/approve-pay.log"], ["feed", false, 0, 7, ".arnx/run/approve-feed.log"]]);
});

test("setup proves a project whose accepted tests are still red, and says so in one line", async () => {
  const { repo } = await acceptedRepo();
  const yaml = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest {targets}\n";
  const model = new ScriptedAgent([[tool("try_project", { yaml })], [tool("propose", { yaml })], [text("Done.")]]);
  const lines: string[] = [];
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "setup"), progress: (l) => lines.push(l),
    sessionFactory: async (_c, snap, _l, body) => body(new FakeSession(snap, () => [junitXml([
      ["tests/test_a.py", "test_a", "passed", ""], [KEPT, "test_y", "failed", "assert False"]]), "out", false])) });
  expect(r.ok).toBe(true);
  expect(lines).toContain("1 accepted test still fails (bugs not fixed yet): arnx check");
  expect(existsSync(join(repo, KEPT))).toBe(true);
});
