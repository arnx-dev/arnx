// The repository's own prompts (.arnx/prompts.toml): an override replaces its key only; unknown keys and
// placeholders are refused when read; `arnx prompts` lists and copies; doctor warns; a review on the user's keys runs
// them and records them; arnx cloud runs its own and is sent nothing of them; approval does not cover the file.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { approvalStamp, parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { writeCredentials } from "../src/cloud";
import { fixPrompt } from "../src/fixprompt";
import { LocalBrain } from "../src/localbrain";
import { DEFAULT_PROMPTS, DEFAULTS, PROMPT_KEYS, PROMPT_VERSION, Prompts, textHash } from "../src/prompts";
import { load } from "../src/report";
import { runReview } from "../src/reviewer";
import { defaultSettings, writeSettings } from "../src/settings";
import { CLOUD_PROMPTS, copyDefault, hasOverrides, overrideWarnings, parseOverrides, promptsFor, promptsPath,
  readOverrides } from "../src/userprompts";
import { Cli } from "./helpers/cli";
import { type FakeCloud, fakeCloud, TOKEN } from "./helpers/cloudfake";
import { FakeJson, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { promptCases } from "./helpers/promptcases";
import { sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-11T00:00:00Z" };

function approvedRepo(): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-11"));
  return repo;
}

const writePrompts = (repo: string, text: string) => {
  mkdirSync(dirname(promptsPath(repo)), { recursive: true });
  writeFileSync(promptsPath(repo), text);
};

test("an override replaces its key only: every other prompt is arnx's", () => {
  const defaults = promptCases();
  for (const key of PROMPT_KEYS) {
    const mark = `<<${key}>>`;
    const built = promptCases(new Prompts({ ...DEFAULTS, [key]: mark }, [key]));
    const changed = Object.keys(built).filter((name) => built[name] !== defaults[name]);
    expect(changed.length).toBeGreaterThan(0);
    // The fix prompt also names the keys it took from the file, so it changes even where the key's text is not used.
    const named = `instead of arnx's defaults: ${key}.`;
    for (const name of changed) {
      expect(`${name}: ${built[name]!.includes(mark) || built[name]!.includes(named)}`).toBe(`${name}: true`);
    }
  }
  expect(promptCases(new Prompts({ ...DEFAULTS, "rank.system": "x" }, ["rank.system"])).PROMPT_VERSION)
    .toBe(PROMPT_VERSION);
});

test("the prompts read from .arnx/prompts.toml: defaults without it, its keys and their hash with it", () => {
  const repo = approvedRepo();
  expect(promptsFor(repo)).toBe(DEFAULT_PROMPTS);
  writePrompts(repo, `[rank]\nsystem = "Rank by harm."\n\n[hunt]\ntask_base = "abc"\ntask = """\nFind bugs.\\\n At \
most $max_suspects."""\n`);
  const p = promptsFor(repo);
  expect(p.overridden).toEqual(["hunt.task", "rank.system"]);
  expect(p.rankSystem()).toBe("Rank by harm.");
  expect(p.t["hunt.task"]).toBe("Find bugs.At most $max_suspects.");
  expect(p.hash).not.toBe(DEFAULT_PROMPTS.hash);
  expect(readOverrides(repo).map((o) => o.base)).toEqual(["abc", null]);
});

test("unknown steps, keys and placeholders are refused, naming the valid ones", () => {
  const err = (t: string) => {
    try {
      parseOverrides(t);
    } catch (e) {
      return (e as Error).message;
    }
    return "accepted";
  };
  expect(err('[hunt]\ntsak = "x"\n')).toBe(".arnx/prompts.toml: unknown key hunt.tsak; hunt has system, opening, " +
    "task, no_tests, second_files");
  expect(err('[hnut]\ntask = "x"\n')).toBe(".arnx/prompts.toml: unknown key hnut; the steps are review, hunt, prove, " +
    "rank, questions, challenge, answer, explain, setup, fix (`arnx prompts` lists the keys)");
  expect(err('task = "x"\n')).toContain("unknown key task; the steps are review,");
  expect(err('[hunt]\ntask = "Look at $diff"\n')).toBe(".arnx/prompts.toml: hunt.task has $diff; it offers " +
    "$no_tests, $max_suspects");
  expect(err('[rank]\nsystem = "costs $USD"\n')).toBe(".arnx/prompts.toml: rank.system has $USD; it offers none");
  expect(err("[rank]\nsystem = 3\n")).toBe(".arnx/prompts.toml: rank.system must be text");
  expect(err("[rank\n")).toStartWith(".arnx/prompts.toml: ");
  expect(err('[rank]\nsystem_base = "abc"\n')).toBe("accepted"); // a base without its text is ignored
  expect(parseOverrides('[rank]\nsystem_base = "abc"\n')).toEqual([]);
});

test("arnx prompts lists the keys and marks yours; copy writes the default with its base", async () => {
  const repo = approvedRepo();
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("prompts")).toBe(0);
  expect(cli.out.slice(0, PROMPT_KEYS.length)).toEqual(PROMPT_KEYS);
  expect(cli.out.at(-1)).toBe("To change one: arnx prompts copy KEY");

  const copy = new Cli({ cwd: repo });
  expect(await copy.run("prompts", "copy", "hunt.task")).toBe(0);
  expect(copy.stdout).toBe("Wrote arnx's hunt.task to .arnx/prompts.toml; edit it there.");
  const file = readFileSync(promptsPath(repo), "utf8");
  expect(file).toContain(`[hunt]\ntask_base = "${textHash(DEFAULTS["hunt.task"])}"\ntask = """\n`);
  expect(readOverrides(repo)).toEqual([{ key: "hunt.task", text: DEFAULTS["hunt.task"],
    base: textHash(DEFAULTS["hunt.task"]) }]);

  // Another key of the same step goes into the same table; the user's comments stay.
  writeFileSync(promptsPath(repo), file.replace("[hunt]", "[hunt]  # mine"));
  expect(copyDefault(repo, "hunt.system")).toBe("written");
  expect(copyDefault(repo, "setup.task")).toBe("written");
  expect(readOverrides(repo).map((o) => o.key)).toEqual(["hunt.system", "hunt.task", "setup.task"]);
  expect(readFileSync(promptsPath(repo), "utf8")).toContain("[hunt]  # mine\nsystem_base");

  // Copying a key the file has already writes nothing and prints arnx's default to compare with.
  const again = new Cli({ cwd: repo });
  expect(await again.run("prompts", "copy", "hunt.task")).toBe(0);
  expect(again.stdout).toBe(DEFAULTS["hunt.task"]);
  expect(again.stderr).toContain("hunt.task is in .arnx/prompts.toml already; nothing written.");

  const list = new Cli({ cwd: repo });
  expect(await list.run("prompts")).toBe(0);
  expect(list.out.find((l) => l.startsWith("hunt.task "))).toMatch(/^hunt\.task +yours$/);
  expect(list.out.at(-1)).toBe("3 yours, in .arnx/prompts.toml.");

  const bad = new Cli({ cwd: repo });
  expect(await bad.run("prompts", "copy", "hunt.tsak")).toBe(2);
  expect(bad.stderr).toBe("arnx: unknown key hunt.tsak; hunt has system, opening, task, no_tests, second_files");
  expect(await bad.run("prompts", "show")).toBe(2);
});

test("arnx prompts --json: every key, overridden or not, with its placeholders", async () => {
  const repo = approvedRepo();
  writePrompts(repo, '[rank]\nsystem = "Rank."\nsystem_base = "000000000000"\n');
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("prompts", "--json")).toBe(0);
  const json = JSON.parse(cli.stdout) as { prompts: { key: string; overridden: boolean; default_changed: boolean;
    placeholders: string[] }[]; cloud: boolean; file: string };
  expect(json.prompts).toHaveLength(27);
  expect(json.prompts.find((p) => p.key === "rank.system")).toEqual({ key: "rank.system", overridden: true,
    default_changed: true, placeholders: [] });
  expect(json.prompts.find((p) => p.key === "hunt.task")).toEqual({ key: "hunt.task", overridden: false,
    default_changed: false, placeholders: ["no_tests", "max_suspects"] });
  expect([json.cloud, json.file]).toEqual([false, ".arnx/prompts.toml"]);
});

test("doctor: a default changed since copied, a needed placeholder dropped, a file that does not read", async () => {
  const repo = approvedRepo();
  writeSettings(repo, SETTINGS);
  writePrompts(repo, `[hunt]\ntask_base = "000000000000"\ntask = "Find bugs, at most $max_suspects."\n` +
    `[review]\ntask_base = "${textHash(DEFAULTS["review.task"])}"\ntask = "Test it in $tests_dir."\n`);
  expect(overrideWarnings(readOverrides(repo))).toEqual([
    "review.task drops $diff",
    "arnx changed hunt.task; compare with `arnx prompts copy hunt.task`",
  ]);
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "k" } });
  await cli.run("doctor");
  expect(cli.out).toContain("Prompts: yours for review.task, hunt.task");
  expect(cli.out).toContain("  review.task drops $diff");
  expect(cli.out).toContain("  arnx changed hunt.task; compare with `arnx prompts copy hunt.task`");

  writePrompts(repo, '[hunt]\ntsak = "x"\n');
  const bad = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "k" } });
  expect(await bad.run("doctor")).toBe(3);
  expect(bad.out).toContain("✗ Prompts: .arnx/prompts.toml: unknown key hunt.tsak; hunt has system, opening, task, " +
    "no_tests, second_files");
});

test("editing .arnx/prompts.toml leaves the environment approved: the stamp covers review.yaml only", async () => {
  const repo = approvedRepo();
  writeSettings(repo, SETTINGS);
  expect(approvalStamp(repo)?.current).toBe(true);
  expect(copyDefault(repo, "review.system")).toBe("written");
  const file = readFileSync(promptsPath(repo), "utf8");
  writeFileSync(promptsPath(repo), file.replace("senior engineer", "careful engineer"));
  expect(approvalStamp(repo)?.current).toBe(true);
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "k" } });
  await cli.run("doctor");
  expect(cli.out.find((l) => l.includes("Environment"))).toBe("✓ Environment: approved");
});

const GEN = "tests/arnx_generated/test_add.py";
const REPORT = '{"tests": [{"test": "tests/arnx_generated/test_add.py::test_add", "expects": "add sums"}],' +
  ' "suspected_defects": [{"test": "tests/arnx_generated/test_add.py::test_add", "explanation": "add subtracts."}],' +
  ' "questions": []}';
/** The reviewer writes one test and reports it. */
const writer = () => new ScriptedAgent([
  [tool("write_file", { path: GEN, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" })],
  [text(REPORT)],
]);
const runs = (): [string | null, string, boolean] => [junitXml([[GEN, "test_add", "failed", "assert -1 == 5"]]), "",
  false];

test("a review on your keys runs your prompts and records the keys and the prompts' hash", async () => {
  const repo = approvedRepo();
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  writePrompts(repo, '[review]\nsystem = "MY SYSTEM for $runner."\n[challenge]\ntask = "MY CHECK of $test_id: ' +
    '$failure"\n');
  const agent = writer();
  const judge = new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]);
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge,
    sessionFactory: fakeFactory(runs) });
  expect(agent.calls[0]!.system).toBe("MY SYSTEM for pytest.");
  expect(judge.calls[0]!.startsWith("MY CHECK of tests/arnx_generated/test_add.py::test_add: assert -1 == 5"))
    .toBe(true);
  const hash = promptsFor(repo).hash;
  expect([review.promptVersion, review.promptOverrides, review.promptsHash]).toEqual([PROMPT_VERSION,
    ["review.system", "challenge.task"], hash]);
  const json = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as Record<string, unknown>;
  expect([json.prompt_overrides, json.prompts_hash]).toEqual([["review.system", "challenge.task"], hash]);
  expect(load(rdir).promptOverrides).toEqual(["review.system", "challenge.task"]);
  expect(readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " ")).toContain(`Prompts: ${PROMPT_VERSION}, ` +
    `yours for review.system, challenge.task (${hash})`);
});

test("a review without overrides records nothing more", async () => {
  const repo = approvedRepo();
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: writer(), challenger: new FakeJson([]),
    sessionFactory: fakeFactory(runs) });
  const json = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as Record<string, unknown>;
  expect("prompt_overrides" in json || "prompts_hash" in json).toBe(false);
  expect(readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " "))
    .toContain(`Prompts: ${PROMPT_VERSION} - Cost`);
});

test("with arnx cloud, one line says your prompts are not used, and nothing of them is sent", async () => {
  const repo = approvedRepo();
  commit(repo, ".arnx/review.yaml");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const MARK = "MY-OWN-PROMPT-91c2";
  writePrompts(repo, `[review]\nsystem = "${MARK} $runner"\n`);
  const home = join(tmp(), "home");
  writeSettings(repo, { ...SETTINGS, cloudConsentAt: "2026-10-20T00:00:00Z",
    cloud: { models: true, tests: false, effort: "medium" } });
  // A 402 at the create stops the review once the change is sent: enough to see what was sent.
  const c: FakeCloud = fakeCloud({ fail: { "POST /v1/reviews": [{ status: 402, body: { code: "insufficient_credits",
    message: "too low", balance_micro_usd: 0, needed_micro_usd: 1, topup_url: "https://arnx.dev/credits" } }] } });
  try {
    writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
    const cli = new Cli({ cwd: repo, env: { HOME: home, ARNX_CLOUD_URL: c.url }, sleep: async () => {} });
    expect(await cli.run("review", "--quiet")).toBe(3);
    expect(cli.out.filter((l) => l === CLOUD_PROMPTS)).toHaveLength(1);
    expect(c.seen.length).toBeGreaterThan(0);
    expect(JSON.stringify(c.seen.map((x) => x.body))).not.toContain(MARK);

    const doctor = new Cli({ cwd: repo, env: { HOME: home, ARNX_CLOUD_URL: c.url } });
    await doctor.run("doctor");
    expect(doctor.out).toContain(`Prompts: ${CLOUD_PROMPTS}`);
    const list = new Cli({ cwd: repo, env: { HOME: home, ARNX_CLOUD_URL: c.url } });
    await list.run("prompts");
    expect(list.out.at(-1)).toBe(CLOUD_PROMPTS);
  } finally {
    c.stop();
  }
});

test("the fix prompt's keys: they change fix-prompt.md, are no model's prompts, and apply with arnx cloud too", () => {
  const repo = approvedRepo();
  writePrompts(repo, '[fix]\nrules = """\n## Rules\n\n- Fix it, then commit."""\nintro = "# Fix review $id"\n');
  const p = promptsFor(repo);
  const text = fixPrompt({ review: sampleReview({ findings: [] }), marks: { findings: {}, severity: {}, answers: {} },
    answers: [], moved: {} }, undefined, p);
  expect(text.startsWith("# Fix review 20261011-a1b2c3\n\n## Rules\n\n- Fix it, then commit.\n")).toBe(true);
  // A brain records none of them, and arnx cloud's line is not said for them.
  expect(new LocalBrain({ agentModel: new ScriptedAgent([]), prices: {}, prompts: p }).overrides).toBeUndefined();
  expect(p.hash).toBe(DEFAULT_PROMPTS.hash);
  expect(hasOverrides(repo)).toBe(false);
});
