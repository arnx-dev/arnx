// Setup asks nothing about the environment: it proves it, stamps it and ends with what is worth a look. A
// review.yaml changed since its proof is proven again before a review or a check uses it.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { approvalStamp, isFileApproved, parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { whatNext } from "../src/next";
import { save } from "../src/report";
import { loadSettings, writeSettings } from "../src/settings";
import { type Runner, sandboxOptions, type SessionFactory } from "../src/sandbox";
import { approvalChecks } from "../src/setupview";
import { Cli } from "./helpers/cli";
import { FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const ENV = { ANTHROPIC_API_KEY: "a" };
const GOOD = "version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
  "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n";

type Case = [string, string, string, string];
const PASS: Case = ["tests/test_pricing.py", "test_total", "passed", ""];
const FAIL: Case = ["tests/test_pricing.py", "test_total", "failed", "assert 1 == 2"];

/** Suites that report `cases`; `runs` gets each project run, `seen` whether its snapshot held notes.md. */
const suites = (cases: Case[], runs: string[] = [], seen: boolean[] = []): SessionFactory =>
  async <T>(cfg: { name: string }, snap: string, _log: string, body: (r: Runner) => Promise<T>) => {
    runs.push(cfg.name);
    seen.push(existsSync(join(snap, "notes.md")));
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

/** A docker that only answers `docker info` (approve checks Docker runs; its suites run in a fake session). */
function dockerThatRuns(): string {
  const dir = join(tmp(), "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "docker"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "docker"), 0o755);
  return join(dir, "docker");
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

test("review proves a changed review.yaml again first and goes on; without a copy of the proven file, it says so",
  async () => {
  const repo = await changed();
  const runs: string[] = [];
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS], runs), ask: async () => {
    throw new Error("asked");
  } });
  await cli.run("review", "--range", "HEAD..HEAD", "--quiet");
  expect(cli.out).toEqual([".arnx/review.yaml changed since its proof (no copy of the proven file to compare): running its suites again"]);
  expect(runs).toEqual(["shop"]);
  expect(proven(repo)).toBe(true);
  expect(cli.stderr).not.toContain("arnx approve");
  expect(readFileSync(join(repo, ".arnx", "setup", "approval.md"), "utf8"))
    .toContain("\nChanged since the last proof: no copy of the proven file to compare\n");
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
  expect(cli.out).toEqual([".arnx/review.yaml changed since its proof (no copy of the proven file to compare): running its suites again",
    "No accepted tests yet: arnx accept keeps them after a review."]);
  expect(runs).toEqual(["shop"]);
  expect(proven(repo)).toBe(true);
});

test("a weakened test_command and a file added to known_failing are named before the suites run, then worth a look",
  async () => {
  const repo = await shop();
  writeFileSync(reviewConfigPath(repo), GOOD);
  const first = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS]) });
  await first.run("review", "--range", "HEAD..HEAD", "--quiet"); // proves it, and keeps a copy of what it proved
  expect(first.out).toEqual([".arnx/review.yaml is not proven yet: running its suites"]);
  expect(existsSync(join(repo, ".arnx", "setup", "proven-review.yaml"))).toBe(true);
  writeFileSync(reviewConfigPath(repo), readFileSync(reviewConfigPath(repo), "utf8")
    .replace("python -m pytest -q {targets}", "python -m pytest -q -k 'not pricing' {targets}")
    .replace("    test_command:", "    known_failing: [tests/test_pricing.py]\n    test_command:"));
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS]) });
  await cli.run("review", "--range", "HEAD..HEAD", "--quiet");
  const changes = [
    "  shop: test_command `python -m pytest -q {targets}` → `python -m pytest -q -k 'not pricing' {targets}`",
    "  shop: known_failing added tests/test_pricing.py",
  ];
  expect(cli.out).toEqual([[".arnx/review.yaml changed since its proof:", ...changes, "Running its suites again."]
    .join("\n"), ["", "Worth a look:",
    "  ! shop: 1 test file(s) set aside as known failing (1 with no reason in notes): tests/test_pricing.py", ""]
    .join("\n")]);
  expect(readFileSync(join(repo, ".arnx", "setup", "approval.md"), "utf8"))
    .toContain(["", "Changed since the last proof:", ...changes.map((c) => `- ${c.trim()}`), ""].join("\n"));
  // Proven again: the next run says nothing, and the copy is the new proof.
  const again = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS]) });
  await again.run("review", "--range", "HEAD..HEAD", "--quiet");
  expect(again.out).toEqual([]);
  expect(readFileSync(join(repo, ".arnx", "setup", "proven-review.yaml"), "utf8"))
    .toBe(readFileSync(reviewConfigPath(repo), "utf8"));
});

test("approve says what changed since the last proof, projects added or removed too", async () => {
  const saved = sandboxOptions.docker;
  try {
    sandboxOptions.docker = dockerThatRuns();
    const repo = await shop();
    writeFileSync(reviewConfigPath(repo), GOOD);
    const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS]) });
    expect(await cli.run("approve", "--quiet")).toBe(0);
    expect(cli.stdout).not.toContain("changed since");
    writeFileSync(reviewConfigPath(repo), readFileSync(reviewConfigPath(repo), "utf8")
      .replace("  shop:", "  store:").replace("- pip install pytest", "- pip install pytest\n      - pip install requests"));
    cli.out.length = 0;
    expect(await cli.run("approve", "--quiet")).toBe(0);
    expect(cli.stdout).toContain(["", ".arnx/review.yaml changed since its proof:", "  project shop removed",
      "  project store added", "Running its suites again."].join("\n"));
    writeFileSync(reviewConfigPath(repo), readFileSync(reviewConfigPath(repo), "utf8")
      .replace("pip install requests", "pip install httpx").replace("image: python:3.12", "image: python:3.13"));
    cli.out.length = 0;
    expect(await cli.run("approve", "--quiet")).toBe(0);
    expect(cli.stdout).toContain("\n  store: install changed\n  store: image changed\n");
  } finally {
    sandboxOptions.docker = saved;
  }
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

/** shop() with GOOD proven by arnx, so a copy of the proven file is kept. */
async function provenShop(): Promise<string> {
  const repo = await shop();
  writeFileSync(reviewConfigPath(repo), GOOD);
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS]) });
  await cli.run("review", "--range", "HEAD..HEAD", "--quiet");
  expect(proven(repo)).toBe(true);
  return repo;
}

const WEAK = (text: string) => text.replace("python -m pytest -q {targets}", "python -m pytest -q -k 'not pricing' {targets}");
const WEAKENED = "  shop: test_command `python -m pytest -q {targets}` → `python -m pytest -q -k 'not pricing' {targets}`";

test("an unstamped file over a proven one is compared with the proven copy", async () => {
  const repo = await provenShop();
  writeFileSync(reviewConfigPath(repo), WEAK(GOOD)); // a saved attempt copied over it, an old checkout: no stamp
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS]) });
  await cli.run("review", "--range", "HEAD..HEAD", "--quiet");
  expect(cli.out[0]).toBe([".arnx/review.yaml changed since its proof:", WEAKENED, "Running its suites again."].join("\n"));
});

test("a stamp recomputed by hand over changed content is proven again, the changes shown", async () => {
  const repo = await provenShop();
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(WEAK(GOOD)), "Dev", "2026-10-26T00:00:00+00:00"));
  expect(proven(repo)).toBe(true); // the stamp holds; the content is not what this machine proved
  const runs: string[] = [];
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS], runs) });
  await cli.run("review", "--range", "HEAD..HEAD", "--quiet");
  expect(cli.out[0]).toBe([".arnx/review.yaml changed since its proof:", WEAKENED, "Running its suites again."].join("\n"));
  expect(runs).toEqual(["shop"]);
  const doctor = new Cli({ cwd: repo, env: ENV });
  expect(await doctor.run("doctor")).toBe(0);
  expect(doctor.stdout).toContain("✓ Environment: proven (1 project: shop)\n");
});

test("--json: review and check carry the re-proof and its changes", async () => {
  const repo = await provenShop();
  writeFileSync(reviewConfigPath(repo), WEAK(readFileSync(reviewConfigPath(repo), "utf8")));
  const review = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS]) });
  await review.run("review", "--range", "HEAD..HEAD", "--json", "--quiet");
  expect(JSON.parse(review.stdout)).toMatchObject({ command: "review", result: "error",
    reproved: { changes: [WEAKENED.trim()], no_copy: false } });
  writeFileSync(reviewConfigPath(repo), readFileSync(reviewConfigPath(repo), "utf8").replace("python:3.12", "python:3.13"));
  rmSync(join(repo, ".arnx", "setup", "proven-review.yaml"));
  const check = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS]), checkSessions: suites([PASS]) });
  await check.run("check", "--json", "--quiet");
  expect(JSON.parse(check.stdout)).toMatchObject({ command: "check", reproved: { changes: null, no_copy: true } });
  // Proven now: nothing to say.
  const again = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS]), checkSessions: suites([PASS]) });
  await again.run("check", "--json", "--quiet");
  expect(JSON.parse(again.stdout).reproved).toBeUndefined();
});

test("the automatic proof reads untracked files when the review does", async () => {
  const repo = await changed();
  writeFileSync(join(repo, "notes.md"), "scratch\n");
  const seen: boolean[] = [];
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS], [], seen) });
  await cli.run("review", "--untracked", "--range", "HEAD..HEAD", "--quiet");
  expect(seen).toEqual([true]);
});

test("check --review finds the review, and accept asks the consent, before any proof", async () => {
  const repo = await changed();
  const runs: string[] = [];
  const check = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS], runs) });
  expect(await check.run("check", "--review", "--quiet")).toBe(3);
  expect(check.stderr).toContain("no reviews yet");
  const rdir = join(repo, ".arnx", "reviews", "20261026-abcdef");
  mkdirSync(rdir, { recursive: true });
  save({ ...sampleReview(), id: "20261026-abcdef" }, rdir, "d");
  writeSettings(repo, { ...loadSettings(repo), consentAt: null });
  const accept = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS], runs) });
  expect(await accept.run("accept", "--quiet")).toBe(3);
  expect(accept.stderr).toContain("arnx consent");
  expect(runs).toEqual([]);
});
