// `arnx setup` as a person sees it, end to end through the CLI with a scripted agent and suites outside Docker:
// milestones on one clock, the table and its files line, the proof (nobody is asked), what is worth a look, recorded in
// .arnx/setup/approval.md, the two kinds of failure, and `setup --json`.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFileApproved, parseReviewFile, reviewConfigPath } from "../src/config";
import { dockerSteps, type Runner, type SessionFactory } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const ENV = { ANTHROPIC_API_KEY: "a" };

const GOOD = "version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
  "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n";
/** Owns only the manifest: pricing.py and its test are unaccounted for. */
const PARTIAL = GOOD.replace("    install:", "    owns: [pyproject.toml]\n    install:");
/** An install step that hides its own errors: worth a look. */
const SHORTCUT = GOOD.replace("[pip install pytest]", "[\"pip install pytest || true\"]");

type Case = [string, string, string, string];
const PASS: Case = ["tests/test_pricing.py", "test_total", "passed", ""];
const FAIL: Case = ["tests/test_pricing.py", "test_discount", "failed", "assert 90 == 81"];
const SKIP: Case = ["tests/test_pricing.py", "test_db", "skipped", "tests/test_pricing.py:9: TEST_DATABASE_URL not set"];

/** Suites that report `cases` (null: no report at all); `build`: the first run builds its image. */
function suites(cases: Case[] | null, { build = false } = {}): SessionFactory {
  let built = !build;
  return async <T>(cfg: { name: string }, snap: string, _log: string, body: (r: Runner) => Promise<T>) => {
    if (!built) {
      built = true;
      dockerSteps.say?.(`${cfg.name}: building its test image (minutes on a first build)`);
    }
    return body(new FakeSession(snap, () => [cases && junitXml(cases), "out", false]));
  };
}

/** A small Python repository, initialized and agreed to send; notes.md is untracked. */
async function shop(): Promise<string> {
  const repo = initRepo(join(tmp(), "shop"));
  writeFileSync(join(repo, "pyproject.toml"), "[project]\nname = \"shop\"\n");
  writeFileSync(join(repo, "pricing.py"), "def total(xs):\n    return sum(xs)\n");
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests", "test_pricing.py"), "def test_total():\n    assert True\n");
  commit(repo, "shop");
  writeFileSync(join(repo, "notes.md"), "scratch\n");
  const cli = new Cli({ cwd: repo, env: ENV });
  expect(await cli.run("init")).toBe(0);
  expect(await cli.run("consent", "--yes")).toBe(0);
  return repo;
}

/** A clock that moves one second each time it is read: every stamp is later than the one before. */
const ticking = () => {
  let ms = 0;
  return () => (ms += 1000);
};

const stamps = (lines: string[]) => lines.flatMap((l) => {
  const m = /^\[(\d+):(\d\d)\]/.exec(l);
  return m ? [Number(m[1]) * 60 + Number(m[2])] : [];
});

/** Reads, a first proposal refused, then the right one: what an interactive run goes through. */
const refusedThenRight = () => new ScriptedAgent([
  [tool("read_file", { path: "pyproject.toml" }), tool("list_dir", { path: "tests" })],
  [tool("read_file", { path: "pricing.py" })],
  [tool("try_project", { yaml: PARTIAL })],
  [tool("propose", { yaml: PARTIAL })],
  [tool("try_project", { yaml: GOOD })],
  [tool("propose", { yaml: GOOD })],
  [text("One project.")],
]);

test("interactive: one reading milestone, the build in the suite line, a short rejection, the files line, proven",
  async () => {
  const repo = await shop();
  const asked: string[] = [];
  const cli = new Cli({ cwd: repo, env: ENV, interactive: true, now: ticking(), setupModel: refusedThenRight(),
    setupSessions: suites([PASS], { build: true }), approveSessions: suites([PASS]),
    ask: async (q) => (asked.push(q), "y") });
  expect(await cli.run("setup")).toBe(0);
  expect(asked).toEqual([]);
  const progress = cli.err.map((l) => l.replace(/^\[\d+:\d\d\] /, ""));
  expect(progress).toEqual([
    "reading the repository",
    "shop: building the test image, running its suite (try 1)",
    "shop: ✓ 1 passed",
    "Proposal rejected: 2 files unaccounted for (pricing.py, tests/test_pricing.py). Retrying...",
    "shop: running its suite (try 2)",
    "shop: ✓ 1 passed",
    "shop: ✓ setup's run stands: 1 passed",
  ]);
  // One clock from setup's start to the proof's last line.
  const t = stamps(cli.err);
  expect(t).toHaveLength(7);
  expect(t.every((s, i) => i === 0 || s > t[i - 1]!)).toBe(true);
  expect(cli.stdout).toContain([
    "  project  runs in  with                  existing suite",
    "  shop     .        python:3.12 · pytest  1 passed",
    "  Files: shop owns 3, uses 0 · not tested: none · 1 untracked left out (notes.md)",
    "",
  ].join("\n"));
  expect(cli.stdout).not.toContain("Worth a look");
  expect(cli.stdout).toMatch(/\nWrote \.arnx\/review\.yaml \(\dm\d\ds, \$\d+\.\d\d\); notes in \.arnx\/setup\/notes\.md\.\n/);
  expect(cli.stdout).toEndWith("\n✓ Environment proven\nNext: arnx review (the last commit: " +
    `${cli.stdout.match(/the last commit: ([0-9a-f]+) shop\)$/)![1]} shop)`);
  const record = readFileSync(join(repo, ".arnx", "setup", "approval.md"), "utf8");
  expect(record).toMatch(/^# Environment proven\n\n\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\+00:00 · by Dev · \.arnx\/review\.yaml sha256 [0-9a-f]{12}\n\nWorth a look: nothing\n$/);
  expect(isFileApproved(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")))).toBe(true);
});

test("--yes: what is worth a look comes after the proof and is recorded in approval.md", async () => {
  const repo = await shop();
  const model = new ScriptedAgent([[tool("try_project", { yaml: SHORTCUT })], [tool("propose", { yaml: SHORTCUT })],
    [text("done")]]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: suites([PASS, SKIP]),
    approveSessions: suites([PASS, SKIP]), ask: async () => { throw new Error("asked"); } });
  expect(await cli.run("setup", "--yes")).toBe(0);
  const warnings = [
    'shop: tests skipped because "TEST_DATABASE_URL not set" (1)',
    "shop: 1 command(s) ignore their own errors (|| true)",
  ];
  expect(cli.stdout).toContain(["✓ Environment proven", "", "Worth a look:", ...warnings.map((w) => `  ! ${w}`), "",
    "Next: arnx review"].join("\n"));
  const sha = createHash("sha256").update(readFileSync(reviewConfigPath(repo))).digest("hex").slice(0, 12);
  const record = readFileSync(join(repo, ".arnx", "setup", "approval.md"), "utf8");
  expect(record.replace(/^\d{4}-\S+ /m, "AT ")).toBe(["# Environment proven", "",
    `AT · by Dev · .arnx/review.yaml sha256 ${sha}`, "", "Worth a look:", ...warnings.map((w) => `- ${w}`), ""]
    .join("\n"));
  // The config format does not change: no warnings in review.yaml.
  expect(readFileSync(reviewConfigPath(repo), "utf8")).not.toContain("Warnings");
});

test("a suite that runs while the current code fails tests: setup records those tests as failing today, and the " +
  "proof stamps the baseline with review.yaml", async () => {
  const repo = await shop();
  const model = new ScriptedAgent([[tool("try_project", { yaml: GOOD })], [tool("propose", { yaml: GOOD })],
    [text("One test fails on the current code.")]]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: suites([PASS, FAIL]),
    approveSessions: suites([PASS, FAIL]) });
  expect(await cli.run("setup", "--yes")).toBe(0);
  expect(cli.stdout).toContain("✓ Environment proven\n\nWorth a look:\n  ! shop: 1 test fails today, recorded in " +
    ".arnx/baseline.json\n");
  const base = JSON.parse(readFileSync(join(repo, ".arnx", "baseline.json"), "utf8"));
  expect(base).toEqual({ version: 1, projects: { shop: [{ id: "tests/test_pricing.py::test_discount",
    file: "tests/test_pricing.py", first: "assert 90 == 81" }] } });
  const file = parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8"));
  expect((file.raw.approved as Record<string, unknown>).baseline).toBe(createHash("sha256")
    .update(readFileSync(join(repo, ".arnx", "baseline.json"))).digest("hex"));
  expect(readFileSync(join(repo, ".arnx", "setup", "proven-baseline.json"), "utf8"))
    .toBe(readFileSync(join(repo, ".arnx", "baseline.json"), "utf8"));
  // A hand edit of the baseline is a change like one of review.yaml: proved again before the next command.
  writeFileSync(join(repo, ".arnx", "baseline.json"), JSON.stringify({ version: 1, projects: {} }));
  const after = new Cli({ cwd: repo, env: ENV, approveSessions: suites([PASS, FAIL]) });
  expect(await after.run("approve", "--yes")).toBe(2);
  expect(after.stdout + after.stderr).toContain("failing outside the baseline");
});

test("a setup that never proves leaves its attempt unproven, and the next setup runs again", async () => {
  const repo = await shop();
  const model = new ScriptedAgent([[tool("try_project", { yaml: GOOD })], [text("No report.")]]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: suites(null) });
  expect(await cli.run("setup", "--yes")).toBe(2);
  expect(readFileSync(reviewConfigPath(repo), "utf8")).toBe(GOOD);
  expect(existsSync(join(repo, ".arnx", "review.draft.yaml"))).toBe(false);
  // Never proven, so setup runs again rather than saying it exists; with no attempt at all, --force is next.
  const again = new Cli({ cwd: repo, env: ENV, setupModel: new ScriptedAgent([[text("Giving up.")]]),
    setupSessions: suites([PASS]) });
  expect(await again.run("setup", "--yes")).toBe(2);
  expect(again.out.slice(-3)).toEqual(["Setup could not build a working environment: no proposal.",
    again.out.at(-2)!, "Next: arnx setup --force"]);
  expect(again.out.at(-2)).toMatch(/^Cost \$\d+\.\d\d · last attempt: none · logs: \.arnx\/setup\/$/);
});

test("an environment that never runs: that failure, told apart from failing tests", async () => {
  const repo = await shop();
  const model = new ScriptedAgent([[tool("try_project", { yaml: GOOD })], [text("No report.")]]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: suites(null) });
  expect(await cli.run("setup", "--yes")).toBe(2);
  expect(cli.out.slice(-3)).toEqual([
    "Setup could not build a working environment: shop: the suite produced no report (exit 0; pytest never said it " +
      "wrote one, so it stopped first or missed arnx's report option); last lines: out.",
    cli.out.at(-2)!,
    "Next: fix .arnx/review.yaml, then arnx approve",
  ]);
  expect(cli.out.at(-2)).toMatch(/^Cost \$\d+\.\d\d · last attempt: \.arnx\/review\.yaml \(not proven\) · logs: /);
});

test("only web UI apps whose one try failed: setup stops with exit 2, nothing to fix", async () => {
  const repo = initRepo(join(tmp(), "site"));
  writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { "react-dom": "18.3.1" } }));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "app.test.tsx"), "test('a', () => {});\n");
  commit(repo, "site");
  const init = new Cli({ cwd: repo, env: ENV });
  expect(await init.run("init")).toBe(0);
  expect(await init.run("consent", "--yes")).toBe(0);
  const site = "version: 1\nprojects:\n  site:\n    root: .\n    language: typescript\n    runner: vitest\n" +
    "    image: node:22-slim\n    test_command: npx vitest run {targets}\n";
  const model = new ScriptedAgent([[tool("try_project", { yaml: site })], [tool("propose", { yaml: site })],
    [text("unreachable")]]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: suites(null) });
  expect(await cli.run("setup", "--yes")).toBe(2);
  expect(cli.out.slice(-2)).toEqual(["Setup stopped: only web UI here, which arnx does not set up.", cli.out.at(-1)!]);
  expect(cli.out.at(-1)).toMatch(/^Cost \$\d+\.\d\d · logs: \.arnx\/setup\/$/);
  expect(existsSync(reviewConfigPath(repo))).toBe(false);
  const json = new Cli({ cwd: repo, env: ENV, setupModel: new ScriptedAgent([[tool("try_project", { yaml: site })],
    [text("done")]]), setupSessions: suites(null) });
  expect(await json.run("setup", "--yes", "--json")).toBe(2);
  expect(JSON.parse(json.stdout)).toMatchObject({ result: "fail", exit_code: 2, review_yaml: null,
    failure: { kind: "environment", reason: "only web UI here, which arnx does not set up" }, next: [] });
});

test("a proven file is kept: setup says it is set up; changed by hand, the next review proves it again", async () => {
  const repo = await shop();
  const model = () => new ScriptedAgent([[tool("try_project", { yaml: GOOD })], [tool("propose", { yaml: GOOD })],
    [text("done")]]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model(), setupSessions: suites([PASS]),
    approveSessions: suites([PASS]) });
  expect(await cli.run("setup", "--quiet")).toBe(0);
  const exists = new Cli({ cwd: repo, env: ENV, setupModel: model() });
  expect(await exists.run("setup")).toBe(2);
  const day = new Date().toISOString().slice(0, 10);
  expect(exists.stderr).toBe(`arnx: .arnx/review.yaml is already set up (proven ${day} by Dev). Next: arnx review ` +
    "— or arnx setup --force to start over (--project NAME redoes one project, --add covers more).");
  writeFileSync(reviewConfigPath(repo), readFileSync(reviewConfigPath(repo), "utf8").replace("python:3.12", "python:3.13"));
  exists.err.length = 0;
  expect(await exists.run("setup")).toBe(2);
  expect(exists.stderr).toBe(`arnx: .arnx/review.yaml changed since its proof (${day} by Dev); the next review proves ` +
    "it again. Next: arnx review — or arnx setup --force to start over.");
});

test("arnx cloud without a login: setup stops on the login line, nothing sent", async () => {
  const repo = initRepo(join(tmp(), "cloudy"));
  writeFileSync(join(repo, "app.py"), "X = 1\n");
  commit(repo, "app");
  const env = { HOME: tmp(), ARNX_CLOUD_URL: "http://127.0.0.1:9" };
  expect(await new Cli({ cwd: repo, env }).run("init", "--cloud")).toBe(0);
  const cli = new Cli({ cwd: repo, env, ask: async () => { throw new Error("asked"); } });
  expect(await cli.run("setup", "--yes")).toBe(3);
  expect(cli.stderr).toBe("✗ Login: not logged in to http://127.0.0.1:9; run `arnx login`");
});

test("setup --json: the object; proven with or without --yes", async () => {
  const repo = await shop();
  const model = () => new ScriptedAgent([[tool("try_project", { yaml: SHORTCUT })],
    [tool("propose", { yaml: SHORTCUT })], [text("done")]]);
  const no = new Cli({ cwd: repo, env: ENV, setupModel: model(), setupSessions: suites([PASS]),
    approveSessions: suites([PASS]) });
  expect(await no.run("setup", "--json")).toBe(0);
  expect(JSON.parse(no.stdout)).toMatchObject({ command: "setup", result: "ok", exit_code: 0,
    approved: true, auto_approved: true, approval_record: ".arnx/setup/approval.md", next: ["arnx review"] });
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model(), setupSessions: suites([PASS]),
    approveSessions: suites([PASS]) });
  expect(await cli.run("setup", "--yes", "--json", "--force")).toBe(0);
  const o = JSON.parse(cli.stdout);
  expect(typeof o.cost_usd).toBe("number");
  expect(typeof o.seconds).toBe("number");
  expect({ ...o, cost_usd: 0, seconds: 0 }).toEqual({ schema_version: 1, command: "setup", result: "ok", exit_code: 0,
    approved: true, auto_approved: true,
    projects: [{ name: "shop", runs_in: ".", image: "python:3.12", runner: "pytest", suite: "1 passed", ok: true,
      accepted_failing: 0, unexpected: [] }],
    files: { projects: [{ name: "shop", owned: 3, used: 0 }], not_tested: [], untracked_left_out: ["notes.md"] },
    warnings: ["shop: 1 command(s) ignore their own errors (|| true)"], review_yaml: ".arnx/review.yaml",
    approval_record: ".arnx/setup/approval.md", cost_usd: 0, seconds: 0, failure: null, next: ["arnx review"] });
  expect(cli.stderr).toContain("✓ Environment proven\n\nWorth a look:\n  ! shop: 1 command(s) ignore their own errors (|| true)");
});

test("setup --json on a failure: kind and reason", async () => {
  const repo = await shop();
  const model = new ScriptedAgent([[tool("try_project", { yaml: GOOD })], [text("No report.")]]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: suites(null) });
  expect(await cli.run("setup", "--yes", "--json")).toBe(2);
  expect(JSON.parse(cli.stdout)).toMatchObject({ result: "fail", exit_code: 2, approved: false,
    review_yaml: ".arnx/review.yaml", files: null, failure: { kind: "environment", failing: [] },
    next: ["arnx approve"] });
});
