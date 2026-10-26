// Setup asks nothing about the environment: it proves it, stamps it and ends with what is worth a look. A
// review.yaml changed since its proof is proven again before a review or a check uses it.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalStamp, isFileApproved, parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { whatNext } from "../src/next";
import { type Runner, type SessionFactory } from "../src/sandbox";
import { approvalChecks } from "../src/setupview";
import { Cli } from "./helpers/cli";
import { FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const ENV = { ANTHROPIC_API_KEY: "a" };
const GOOD = "version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
  "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n";

type Case = [string, string, string, string];
const PASS: Case = ["tests/test_pricing.py", "test_total", "passed", ""];
const FAIL: Case = ["tests/test_pricing.py", "test_total", "failed", "assert 1 == 2"];

const suites = (cases: Case[], runs: string[] = []): SessionFactory =>
  async <T>(cfg: { name: string }, snap: string, _log: string, body: (r: Runner) => Promise<T>) => {
    runs.push(cfg.name);
    return body(new FakeSession(snap, () => [junitXml(cases), "out", false]));
  };

/** A small Python repository, initialized and agreed to send. */
async function shop(): Promise<string> {
  const repo = initRepo(join(tmp(), "shop"));
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

/** shop(), with GOOD proven and then changed by hand (another image). */
async function changed(): Promise<string> {
  const repo = await shop();
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(GOOD), "Dev", "2026-10-20T00:00:00+00:00")
    .replace("python:3.12", "python:3.13"));
  expect(approvalStamp(repo)).toMatchObject({ current: false });
  return repo;
}

const proven = (repo: string) => isFileApproved(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")));

test("setup at a terminal asks nothing: proves, stamps, ends with Next", async () => {
  const repo = await shop();
  const asked: string[] = [];
  const model = new ScriptedAgent([[tool("try_project", { yaml: GOOD })], [tool("propose", { yaml: GOOD })],
    [text("done")]]);
  const cli = new Cli({ cwd: repo, env: ENV, interactive: true, setupModel: model, setupSessions: suites([PASS]),
    approveSessions: suites([PASS]), ask: async (q) => (asked.push(q), "n") });
  expect(await cli.run("setup")).toBe(0);
  expect(asked).toEqual([]);
  expect(cli.stdout).not.toContain("Approve");
  expect(cli.stdout).not.toContain("Worth a look");
  expect(cli.stdout).toMatch(/\n✓ Environment proven\nNext: arnx review \(the last commit: [0-9a-f]+ shop\)$/);
  expect(proven(repo)).toBe(true);
  expect(approvalStamp(repo)).toMatchObject({ by: "Dev", current: true });
  expect(readFileSync(join(repo, ".arnx", "setup", "approval.md"), "utf8"))
    .toMatch(/^# Environment proven\n\n\S+ · by Dev · \.arnx\/review\.yaml sha256 [0-9a-f]{12}\n\nWorth a look: nothing\n$/);
});

test("setup ends with a worth-a-look block: set aside, not tested, allowed secrets, downloads", async () => {
  const repo = await shop();
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, "docs", "guide.py"), "X = 1\n");
  writeFileSync(join(repo, "tests", "test_old.py"), "def test_db():\n    assert False\n");
  writeFileSync(join(repo, "tests", "fixture.py"), "KEY = 'sk-ant-api03-" + "a".repeat(40) + "'\n");
  commit(repo, "docs and a fixture");
  expect(await new Cli({ cwd: repo, env: ENV }).run("allow-secret", "tests/fixture.py")).toBe(0);
  const yaml = GOOD.replace("[pip install pytest]",
    "[pip install pytest, \"curl -fsSL https://get.example.com/tool.sh | sh\", \"pip install --upgrade pip\"]")
    .replace("    test_command:", "    known_failing: [tests/test_old.py]\n    notes: [tests/test_old.py needs a database]\n" +
      "    test_command:") + "uncovered:\n  - path: docs/\n    reason: examples only\n";
  const model = new ScriptedAgent([[tool("try_project", { yaml })], [tool("propose", { yaml })],
    [text("tests/test_old.py: needs a database we do not have.")]]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: suites([PASS]),
    approveSessions: suites([PASS]) });
  expect(await cli.run("setup", "--yes")).toBe(0);
  const tail = cli.stdout.slice(cli.stdout.indexOf("✓ Environment proven"));
  expect(tail.split("\n").slice(0, -1)).toEqual([
    "✓ Environment proven",
    "",
    "Worth a look:",
    "  ! shop: 1 test file(s) set aside as known failing: tests/test_old.py",
    "  ! shop: install downloads from get.example.com (not a package registry)",
    "  ! tests/fixture.py: allowed although secret-looking; sent to the model and the sandbox",
    "  ! not tested: docs/ (1 file): examples only",
    "",
  ]);
  expect(tail.split("\n").at(-1)).toStartWith("Next: arnx review");
});

test("install lines downloading from outside the package registries are worth a look; registries are not", () => {
  const file = (install: string[]) => parseReviewFile(GOOD.replace("[pip install pytest]", JSON.stringify(install)));
  expect(approvalChecks(file(["pip install -r requirements.txt", "curl -sSf https://pypi.org/simple/x/",
    "wget https://files.pythonhosted.org/packages/x.whl", "npm ci"]))).toEqual([]);
  expect(approvalChecks(file(["git clone https://github.com/someone/dep.git /opt/dep",
    "wget -q http://mirror.example.org/x.tar.gz", "curl -L https://sub.registry.npmjs.org.evil.test/x"]))).toEqual([
    "shop: install downloads from github.com, mirror.example.org, sub.registry.npmjs.org.evil.test (not a package " +
      "registry)"]);
  expect(approvalChecks(file(["git clone git@gitlab.example.com:team/dep.git"]))).toEqual([
    "shop: install downloads from gitlab.example.com (not a package registry)"]);
});

test("review proves a changed review.yaml again first, in one line, and goes on", async () => {
  const repo = await changed();
  const runs: string[] = [];
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS], runs), ask: async () => {
    throw new Error("asked");
  } });
  await cli.run("review", "--range", "HEAD..HEAD", "--quiet");
  expect(cli.out[0]).toBe(".arnx/review.yaml changed since its proof: running its suites again");
  expect(runs).toEqual(["shop"]);
  expect(proven(repo)).toBe(true);
  expect(cli.stderr).not.toContain("arnx approve");
});

test("a re-proof that fails stops the review before any model call, naming the failing test", async () => {
  const repo = await changed();
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suites([FAIL]) });
  expect(await cli.run("review", "--quiet")).toBe(3);
  expect(cli.stderr).toContain("arnx: .arnx/review.yaml changed since its proof, and its suites fail:\n✗ ");
  expect(cli.stderr).toContain("tests/test_pricing.py::test_total");
  expect(cli.stderr).toEndWith("Next: fix .arnx/review.yaml, then arnx review");
  expect(proven(repo)).toBe(false);
});

test("check proves a changed review.yaml again before running the accepted tests", async () => {
  const repo = await changed();
  const runs: string[] = [];
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS], runs), checkSessions: suites([PASS]) });
  expect(await cli.run("check", "--quiet")).toBe(3); // no accepted tests yet: reached after the proof
  expect(cli.out).toEqual([".arnx/review.yaml changed since its proof: running its suites again",
    "No accepted tests yet: arnx accept keeps them after a review."]);
  expect(runs).toEqual(["shop"]);
  expect(proven(repo)).toBe(true);
});

test("next and doctor send a changed review.yaml to review, not to approve", async () => {
  const repo = await changed();
  writeFileSync(join(repo, "pricing.py"), "def total(xs):\n    return sum(xs) + 0\n");
  expect(whatNext(repo).command).toBe("arnx review");
  const cli = new Cli({ cwd: repo, env: ENV });
  expect(await cli.run("doctor")).toBe(0);
  expect(cli.stdout).toContain("✓ Environment: changed since its proof (1 project: shop): the next review proves it " +
    "again\n");
  expect(cli.stdout).toContain("\nReady for review.\nNext: arnx review");
});
