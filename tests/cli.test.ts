import { blankMarks } from "./helpers/review";
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { precisionOf } from "../src/accept";
import { parseReviewFile, stampFile } from "../src/config";
import { save } from "../src/report";
import { loadSettings, settingsPath } from "../src/settings";
import { commandHelp } from "../src/cli";
import { VERSION } from "../src/version";
import { Cli } from "./helpers/cli";
import { commit, gitRepo } from "./helpers/gitutil";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const bare = (over = {}) => sampleReview({ id: RID, change: "commit abc", filesChanged: 1, added: 1, removed: 0,
  reviewer: "r", challenger: "c", promptVersion: "v", findings: [], questions: [], flaky: [], errors: [], passed: 0,
  testsWritten: 0, missingRuns: 0, notSent: [], costUsd: 0.1, seconds: 1, stop: "end_turn", writeDir: "tests/g",
  ...over });

test("test_version", async () => {
  const cli = new Cli({ cwd: tmp() });
  expect(await cli.run("--version")).toBe(0);
  // Run from source, the version names the commit it comes from.
  expect(cli.stdout.trim()).toMatch(new RegExp(`^arnx ${VERSION.replaceAll(".", "\\.")} \\(source [0-9a-f]{7,} \\(committed \\d{4}-\\d\\d-\\d\\d \\d\\d:\\d\\d\\)`));
  expect(JSON.parse(readFileSync(join(import.meta.dir, "..", "package.json"), "utf8")).version).toBe(VERSION);
});

test("init only writes the files: no consent, no key line; doctor and setup name the missing key", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, env: { OPENAI_API_KEY: "o" } });
  expect(await cli.run("init")).toBe(0);
  const s = loadSettings(repo);
  expect(s.consentAt).toBeNull(); // asked on the first send
  // The harness, keys deciding: OpenAI's key brings its second hunter; without River's, Claude gives the second opinion.
  expect([s.challenger.provider, s.secondHunter?.provider, s.challengerFallback]).toEqual(["anthropic", "openai",
    undefined]);
  expect(cli.stdout).toBe([
    "✓ arnx initialized",
    "  .arnx/config.toml  created (models, budgets: edit to change)",
    "  .arnxignore        created",
    "",
    "Next: arnx setup",
    "Optional: arnx skill install (coding agents)",
  ].join("\n"));
  expect(readFileSync(join(repo, ".arnx", "config.toml"), "utf8")).toMatch(
    /^# challenger = "river:zai-org\/GLM-5\.3-Flash" +# harness; needs RIVER_API_KEY$/m);
  expect(readFileSync(join(repo, ".arnx", ".gitignore"), "utf8").startsWith("reviews/")).toBe(true);
  expect(await cli.run("doctor")).toBe(3);
  const missing = "✗ Keys: missing ANTHROPIC_API_KEY: export it (https://console.anthropic.com/settings/keys), " +
    "or `arnx cloud on`";
  expect(cli.stdout).toContain(missing);
  expect(cli.stdout).toContain("· Consent: pending\n· Environment: not configured\n");
  expect(cli.stdout).toMatch(/\nNot ready for review\.\nNext: fix the ✗ line above$/);
  // setup runs the same checks first: the same line, and nothing asked, read or sent.
  const setup = new Cli({ cwd: repo, env: { OPENAI_API_KEY: "o" }, ask: async () => { throw new Error("asked"); } });
  expect(await setup.run("setup")).toBe(3);
  expect(setup.stderr).toBe(missing);
  expect(setup.stdout).toBe("");
  expect(await cli.run("key", "set", "anthropic")).toBe(2); // keys come from the environment only
});

test("init again changes nothing and names the flow's next step; a deleted .arnxignore comes back", async () => {
  const repo = gitRepo(tmp());
  await new Cli({ cwd: repo }).run("init");
  const config = readFileSync(settingsPath(repo), "utf8").replace("review_usd = 3.0", "review_usd = 9.0  # mine");
  writeFileSync(settingsPath(repo), config);
  const again = new Cli({ cwd: repo });
  expect(await again.run("init")).toBe(0);
  expect(again.stdout).toBe(["✓ arnx is already initialized", "  .arnx/config.toml  kept", "  .arnxignore        kept",
    "", "Next: arnx setup", "Optional: arnx skill install (coding agents)"].join("\n"));
  expect(readFileSync(settingsPath(repo), "utf8")).toBe(config);
  rmSync(join(repo, ".arnxignore"));
  const back = new Cli({ cwd: repo });
  expect(await back.run("init")).toBe(0);
  expect(back.stdout).toContain("  .arnx/config.toml  kept\n  .arnxignore        created\n");
  // --cloud on a repository set up for the user's own keys switches nothing.
  const cloud = new Cli({ cwd: repo });
  expect(await cloud.run("init", "--cloud")).toBe(0);
  expect(cloud.stdout).toContain("It uses your own keys; `arnx cloud on` switches it to arnx cloud.");
  expect(readFileSync(settingsPath(repo), "utf8")).toBe(config);
  // A config that does not read is kept too: doctor says what is wrong.
  writeFileSync(settingsPath(repo), "[models\n");
  const broken = new Cli({ cwd: repo });
  expect(await broken.run("init")).toBe(0);
  expect(readFileSync(settingsPath(repo), "utf8")).toBe("[models\n");
});

test("init --force rewrites the config but keeps the consents, the telemetry choice and [cloud]", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  await cli.run("consent", "--yes");
  await cli.run("cloud", "on", "--yes");
  const s0 = loadSettings(repo);
  writeFileSync(settingsPath(repo), readFileSync(settingsPath(repo), "utf8")
    .replace(/^telemetry = true .*$/m, "telemetry = false").replace("review_usd = 3.0", "review_usd = 9.0"));
  const force = new Cli({ cwd: repo });
  expect(await force.run("init", "--force")).toBe(0);
  expect(force.stdout).toStartWith("✓ arnx configuration replaced\n  .arnx/config.toml  replaced (models, budgets: " +
    "edit to change)\n  .arnxignore        kept\n");
  const s = loadSettings(repo);
  expect([s.consentAt, s.cloudConsentAt, s.telemetry, s.cloud?.models, s.reviewBudgetUsd])
    .toEqual([s0.consentAt, s0.cloudConsentAt, false, true, 3.0]);
});

test("--json: one JSON object on stdout, the human text on stderr, nothing asked; errors and usage errors too",
  async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, env: {}, ask: async () => { throw new Error("asked"); } });
  expect(await cli.run("init", "--json")).toBe(0);
  expect(JSON.parse(cli.stdout)).toMatchObject({ schema_version: 1, command: "init", exit_code: 0 });
  expect(cli.stderr).toContain("✓ arnx initialized");
  for (const [argv, fields] of [
    [["setup", "--json"], { command: "setup", result: "not-ready", exit_code: 3,
      checks: [{ name: "keys", ok: false }] }],
    [["accept", "--json"], { command: "accept", result: "error", exit_code: 2, error: "no reviews yet; run `arnx review`" }],
    [["init", "--yes", "--json"], { command: "init", result: "usage-error", exit_code: 2,
      error: "unknown option '--yes'" }],
  ] as const) {
    const one = new Cli({ cwd: repo, env: {} });
    await one.run(...argv);
    expect(JSON.parse(one.stdout)).toMatchObject(fields);
  }
});

test("usage errors say which command and how to see its options; --help after a command shows only its lines",
  async () => {
  const cli = new Cli({ cwd: tmp() });
  expect(await cli.run("init", "--yes")).toBe(2);
  expect(cli.err).toEqual(["arnx init: unknown option '--yes'", "Run `arnx init --help` for its options."]);
  cli.err = [];
  expect(await cli.run("review", "--range")).toBe(2);
  expect(cli.err[0]).toBe("arnx review: option '--range' needs a value");
  cli.err = [];
  expect(await cli.run("review", "--quiet=1")).toBe(2);
  expect(cli.err[0]).toBe("arnx review: option '--quiet' takes no value");
  cli.err = [];
  expect(await cli.run("prompt", "a", "b")).toBe(2);
  expect(cli.err[0]).toBe("arnx prompt: unexpected argument 'b'");
  cli.err = [];
  expect(await cli.run("frobnicate")).toBe(2);
  expect(cli.err).toEqual(["arnx: unknown command 'frobnicate'", "Run `arnx --help` for the commands."]);
  expect(await cli.run("init", "--help")).toBe(0);
  expect(cli.stdout).toBe("arnx init [--cloud] [--force]  write .arnx/config.toml and .arnxignore\n\n" +
    "--json prints one JSON object.");
  expect(commandHelp("check")).toBe("arnx check                run the accepted tests: what still fails\n" +
    "arnx check --review [id]  run a review's confirmed tests before accepting\n\n--quiet hides progress. --json prints " +
    "one JSON object.");
  expect(commandHelp("review")).toBe("arnx review [--range A..B] [--untracked] [--no-hunt] [--resume]\n" +
    "     test the change: branch commits, uncommitted work, or the last commit\n\n" +
    "--quiet hides progress. --local or --cloud picks the models for one run. --json prints one JSON object.");
  expect(commandHelp("logout")).toBe("arnx login | arnx logout | arnx credits  arnx cloud: sign this machine in or " +
    "out; the balance\n\n--json prints one JSON object.");
});

test("the first send asks the consent: declined, nothing is sent; without a terminal, `arnx consent`", async () => {
  const repo = gitRepo(tmp());
  const env = { ANTHROPIC_API_KEY: "a" };
  await new Cli({ cwd: repo, env }).run("init");
  const declined = new Cli({ cwd: repo, env, interactive: true, ask: async () => "n" });
  expect(await declined.run("setup")).toBe(3);
  expect(declined.stdout).toBe("");
  expect(declined.stderr).toBe("arnx: consent declined; nothing sent");
  expect(loadSettings(repo).consentAt).toBeNull();
  const script = new Cli({ cwd: repo, env });
  expect(await script.run("review")).toBe(3);
  expect(script.stderr).toBe("arnx: sending code to your model provider has not been agreed to; nothing sent: run " +
    "`arnx consent`");
  expect(await script.run("consent", "--yes")).toBe(0);
  expect(loadSettings(repo).consentAt).toBeTruthy();
});

test("review accepts --quiet (no progress lines on stderr)", async () => {
  const cli = new Cli({ cwd: gitRepo(tmp()) });
  expect(await cli.run("review", "--quiet")).toBe(3); // reached the consent check: the option parsed
});

test("test_review_before_init", async () => {
  const cli = new Cli({ cwd: gitRepo(tmp()) });
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toContain("arnx init");
});

test("test_doctor", async () => {
  const cli = new Cli({ cwd: gitRepo(tmp()), env: {}, dockerOk: () => [false, "Docker is not running; start it and try again"] });
  await cli.run("init");
  const code = await cli.run("doctor");
  expect(code).toBe(3);
  expect(cli.stdout).toContain("✗ Keys: missing ANTHROPIC_API_KEY: export it");
  expect(cli.stdout).toContain("✗ Docker: not running; start it and try again");
  expect(cli.stdout).toContain("· Environment: not configured");
  expect(cli.stdout).toMatch(/\nNext: fix the 2 ✗ lines above$/);
});

test("an unexpected error is one line naming it as a bug in arnx; the stack only with ARNX_DEBUG=1", async () => {
  const boom = (): [boolean, string] => {
    const o = undefined as unknown as { probe(): [boolean, string] };
    return o.probe();
  };
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, dockerOk: boom });
  expect(await cli.run("doctor")).toBe(2);
  expect(cli.stderr).toMatch(/^arnx: internal error \(TypeError: [^\n]+\)\. This is a bug in arnx, not in your code: /);
  expect(cli.stderr).toContain("please report it with the command you ran and `arnx --version`.");
  expect(cli.err).toHaveLength(1);
  expect(cli.stderr).not.toContain("    at ");
  const debug = new Cli({ cwd: repo, dockerOk: boom, env: { ARNX_DEBUG: "1" } });
  expect(await debug.run("doctor")).toBe(2);
  expect(debug.stderr).toContain("arnx: internal error (TypeError: ");
  expect(debug.stderr).toContain("    at ");
});

test("test_accept_command", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(bare({ findings: [finding("F1", "tests/g/test_a.py::test_a", "test_a", "tests/g/test_a.py", "x", "y",
    "confirmed")] }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"), "def test_a():\n    assert False\n");
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replace("Mark: [ ] real", "Mark: [x] real"));
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(existsSync(join(repo, ".arnx", "tests", "tests", "arnx", "r20261011_a1b2c3", "test_y.py"))).toBe(true);
  expect(cli.stdout).toContain("✓ Accepted 1 test from 1 issue (1 finding)\n" +
    "  1 mark was pre-filled (not reviewed in triage)\n  kept: .arnx/tests/tests/arnx/r20261011_a1b2c3/test_y.py\n\n1 accepted test fails until the fix (not run: --no-check).");
});

test("test_accept_with_answers_requires_consent", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  const config = join(repo, ".arnx", "config.toml");
  writeFileSync(config, readFileSync(config, "utf8").split("\n").filter((l) => !l.startsWith("consent_at")).join("\n"));
  save(bare({ questions: ["Q?"] }), join(repo, ".arnx", "reviews", RID), "d");
  expect(await cli.run("accept")).toBe(3);
  expect(cli.stderr).toContain("consent");
});

test("usage errors exit 2", async () => {
  const cli = new Cli({ cwd: tmp() });
  expect(await cli.run()).toBe(2);
  expect(await cli.run("nope")).toBe(2);
  expect(await cli.run("review", "--bogus")).toBe(2);
  expect(await cli.run("--help")).toBe(0);
  expect(cli.stdout).toContain("accept");
});

test("doctor shows each project and the coverage map", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "services", "pay"), { recursive: true });
  writeFileSync(join(repo, "services", "pay", "a.py"), "X = 1\n");
  commit(repo, "pay");
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  await cli.run("init");
  await cli.run("consent", "--yes");
  writeFileSync(join(repo, ".arnx", "review.yaml"), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  expect(await cli.run("doctor")).toBe(0);
  expect(cli.stdout).toMatch(/✓ Consent: given \d{4}-\d\d-\d\d\n/);
  expect(cli.stdout).toContain("\nReady for review.\nNext: arnx review");
  expect(cli.stdout).toContain("✓ Environment: approved (2 projects: pay, feed)");
  expect(cli.stdout).toContain("- pay: owns 1 files, uses 0");
  expect(cli.stdout).toContain("- not tested: infra/ (0 files): Terraform; no adapter");
  expect(cli.stdout).toContain("- not explained: 1 source files");
});

test("setup and approve take --project; setup takes --add", async () => {
  const cli = new Cli({ cwd: tmp() });
  expect(await cli.run("setup", "--project")).toBe(2);
  expect(await cli.run("approve", "--project", "pay", "--yes", "--bogus")).toBe(2);
  expect(await cli.run("setup", "--add", "--project", "pay")).toBe(2);
  expect(cli.stderr).toContain("--add and --project");
});

test("accept counts kept Rust tests (their kept names differ from generated ones)", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(bare({ language: "rust", writeDir: "tests", findings: [finding("F1", "tests/arnx_generated_x.rs::adds",
    "adds", "tests/arnx_generated_x.rs", "x", "y", "confirmed")] }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "arnx_generated_x.rs"), "#[test]\nfn adds() { assert!(false); }\n");
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replace("Mark: [ ] real", "Mark: [x] real"));
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(cli.stdout).toContain("  kept: .arnx/tests/tests/arnx_20261011_a1b2c3_y.rs\n");
  expect(existsSync(join(repo, ".arnx", "tests", "tests", "arnx_20261011_a1b2c3_y.rs"))).toBe(true);
  expect(existsSync(join(repo, "tests", "arnx_20261011_a1b2c3_y.rs"))).toBe(false); // cargo never compiles it
});

test("accept across projects names no empty directory", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  writeFileSync(join(repo, ".arnx", "review.yaml"), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  const rdir = join(repo, ".arnx", "reviews", RID);
  const gen = "services/pay/tests/arnx_generated";
  save(bare({ projects: ["pay", "feed"], writeDirs: { pay: gen, feed: "services/feed/tests/arnx_generated" },
    findings: [{ ...finding("F1", "tests/arnx_generated/test_x.py::test_x", "test_x", `${gen}/test_x.py`, "x", "y",
      "confirmed"), project: "pay" }] }), rdir, "d");
  mkdirSync(join(rdir, "projects", "pay", "tests", gen), { recursive: true });
  writeFileSync(join(rdir, "projects", "pay", "tests", gen, "test_x.py"), "def test_x():\n    assert False\n");
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replace("Mark: [ ] real", "Mark: [x] real"));
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(cli.stdout).toMatch(/\n  kept: \.arnx\/tests\/services\/pay\/tests\/arnx\/r20261011_a1b2c3\/[^\n]+\.py\n/);
});

test("triage records the marks chosen there; accept counts the pre-filled ones apart", async () => {
  const repo = gitRepo(tmp());
  const queue: string[] = [];
  const cli = new Cli({ cwd: repo, draw: () => {}, keys: () => {
    let i = 0;
    return { async next() { return i < queue.length ? { value: queue[i++] as never, done: false }
      : { value: "quit" as never, done: true }; } };
  } });
  await cli.run("init");
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(bare({ findings: ["F1", "F2"].map((id) => finding(id, `tests/g/test_a.py::test_${id}`, `test_${id}`,
    "tests/g/test_a.py", "x", "y", "confirmed")) }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"),
    "def test_F1():\n    assert False\n\ndef test_F2():\n    assert False\n");
  queue.push("right", "enter", "enter", "enter"); // F1 passed over; F2's pre-filled real confirmed, severity high; save
  expect(await cli.run("triage")).toBe(0);
  expect(JSON.parse(readFileSync(join(rdir, "triage.json"), "utf8"))).toEqual({ chosen: ["F2"] });
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(cli.stdout).toContain("✓ Accepted 2 tests from 2 issues (2 findings)\n  1 mark was pre-filled (not reviewed in triage)\n");
  expect(cli.stdout).not.toContain("Precision"); // the owner's own measure stays in precision.jsonl
  const lines = readFileSync(join(repo, ".arnx", "precision.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => [l.item, l.mark, l.mark_source])).toEqual([["F1", "real", "default"], ["F2", "real", "chosen"]]);
});

test("accept's precision leaves out pre-filled marks and lines from before mark_source, and says how many", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(bare({ findings: ["F1", "F2"].map((id) => finding(id, `tests/g/test_a.py::test_${id}`, `test_${id}`,
    "tests/g/test_a.py", "x", "y", "confirmed")) }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"),
    "def test_F1():\n    assert False\n\ndef test_F2():\n    assert False\n");
  writeFileSync(join(repo, ".arnx", "precision.jsonl"), ["F1", "F2"].map((item) => JSON.stringify({
    review: "20261001-000000", item, kind: "finding", verdict: "confirmed", mark: "real" })).join("\n") + "\n");
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  // Precision counts only the marks the owner chose: here none (2 pre-filled, 2 from before mark_source).
  const lines = readFileSync(join(repo, ".arnx", "precision.jsonl"), "utf8").trim().split("\n");
  expect(precisionOf(lines)).toMatchObject({ chosen: 0, defaulted: 2, unknown: 2 });
});

test("precision.jsonl stays out of git, also in a repository set up before arnx ignored it", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  const gitignore = join(repo, ".arnx", ".gitignore");
  expect(readFileSync(gitignore, "utf8")).toContain("\nprecision.jsonl\n");
  writeFileSync(gitignore, "reviews/\nrun/\nsetup/\nusage.jsonl"); // an older init's, without a final newline
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(bare({ findings: [finding("F1", "tests/g/test_a.py::test_F1", "test_F1", "tests/g/test_a.py", "x", "y",
    "confirmed")] }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"), "def test_F1():\n    assert False\n");
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(await cli.run("accept", "--no-answers", "--again")).toBe(0);
  expect(readFileSync(gitignore, "utf8")).toBe("reviews/\nrun/\nsetup/\nusage.jsonl\nprecision.jsonl\n");
});

test("a plain init writes [cloud] with models = false, so switching is one word", async () => {
  const repo = gitRepo(tmp());
  expect(await new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } }).run("init")).toBe(0);
  const text = readFileSync(join(repo, ".arnx", "config.toml"), "utf8");
  expect(text).toContain("\n[cloud]\nmodels = false                                       # true: arnx models instead " +
    "of your own keys\ntests = false");
  expect(text).toContain('effort = "medium"                                    # low, medium or high');
  expect(loadSettings(repo).cloud).toEqual({ models: false, tests: false, effort: "medium" });
});

test("doctor notes keys set after a key-less init that no model uses", async () => {
  const repo = gitRepo(tmp());
  await new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } }).run("init");
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" } });
  await cli.run("doctor");
  expect(cli.stdout).toContain("✓ Keys: 1 required key present\n  OPENAI_API_KEY is set but unused: `arnx init --force` " +
    "adds second_hunter, challenger_fallback\n");
  const quiet = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  await quiet.run("doctor");
  expect(quiet.stdout).not.toContain("unused");
});


test("allow-secret marks the file and says it may be sent from now on", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "detect.py"), 'AWS = "AKIAABCDEFGHIJKLMNOP"\n');
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("allow-secret", "detect.py")).toBe(0);
  expect(cli.stdout).toBe(["! detect.py: 1 key-like string (AKIA… line 1)",
    "✓ Allowed in .arnx/review.yaml: from now on, model calls and the sandbox may include this file.",
    "  A new key-like string in it withholds the file again.", "Next: arnx setup"].join("\n"));
});

test("init's banner: first init at a terminal only, coloured with colour; never again, in a pipe or with --json", async () => {
  const repo = gitRepo(tmp());
  const plain = new Cli({ cwd: repo, banner: true });
  await plain.run("init");
  expect(plain.stdout).toContain("ascii by cl!");
  expect(plain.stdout).not.toContain("\x1b[");
  expect(plain.stdout).toMatch(/>>\n\n✓ arnx initialized\n/);
  const again = new Cli({ cwd: repo, banner: true });
  await again.run("init");
  expect(again.stdout).not.toContain("ascii by cl!");
  const coloured = new Cli({ cwd: gitRepo(join(tmp(), "c")), banner: true, color: true });
  await coloured.run("init");
  expect(coloured.stdout).toContain("\x1b[93m");
  const piped = new Cli({ cwd: gitRepo(join(tmp(), "p")) });
  await piped.run("init");
  expect(piped.stdout).not.toContain("ascii by cl!");
  const json = new Cli({ cwd: gitRepo(join(tmp(), "j")), banner: true });
  await json.run("init", "--json");
  expect(json.stdout + json.stderr).not.toContain("ascii by cl!");
});
