// What uses the repository's own prompts says so: accept names the fix prompt's keys it used (its text, fix-prompt.md
// and --json); a review whose change edits .arnx/prompts.toml says it ran that version (progress, review.md,
// review.json); doctor checks the file under arnx cloud too, since accept reads its fix keys there.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp, stampFile } from "../src/config";
import { save } from "../src/report";
import { runReview } from "../src/reviewer";
import { defaultSettings, writeSettings } from "../src/settings";
import { CLOUD_PROMPTS, promptsPath } from "../src/userprompts";
import { Cli } from "./helpers/cli";
import { FakeJson, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const FIX_RULES = '[fix]\nrules = """\n## Rules\n\n- Fix it, then commit."""\n';

const writePrompts = (repo: string, text: string) => {
  mkdirSync(dirname(promptsPath(repo)), { recursive: true });
  writeFileSync(promptsPath(repo), text);
};

/** A repository with an approved environment and a review of one confirmed finding, marked real. */
async function reviewed(): Promise<{ repo: string; rdir: string }> {
  const repo = gitRepo(tmp());
  await new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } }).run("init");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile("version: 1\nprojects:\n  shop:\n    root: .\n" +
    "    image: python:3.12-slim\n    test_command: python -m pytest {targets}\n"), "Dev", "2026-10-12"));
  commit(repo, "layout");
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(sampleReview({ id: RID, findings: [finding("F1", "tests/g/test_a.py::test_F1", "test_F1", "tests/g/test_a.py",
    "x", "discount", "confirmed")], groups: [], questions: [], questionProjects: [], projects: ["main"],
  writeDir: "tests/g" }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"), "def test_F1():\n    assert False\n");
  return { repo, rdir };
}

test("accept names the fix prompt's keys it used: one line, fix-prompt.md and --json", async () => {
  const { repo, rdir } = await reviewed();
  const plain = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  expect(await plain.run("accept", "--no-answers", "--json")).toBe(0);
  expect("fix_prompt_overrides" in JSON.parse(plain.stdout)).toBe(false);
  expect(plain.stderr).not.toContain("yours for");
  expect(readFileSync(join(rdir, "fix-prompt.md"), "utf8")).not.toContain("prompts.toml");

  writePrompts(repo, FIX_RULES);
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  expect(await cli.run("accept", "--again", "--no-answers")).toBe(0);
  expect(cli.out).toContain("Fix prompt: yours for fix.rules (.arnx/prompts.toml)");
  const md = readFileSync(join(rdir, "fix-prompt.md"), "utf8");
  expect(md).toContain("## Rules\n\n- Fix it, then commit.\n");
  expect(md.trimEnd().endsWith("Taken from .arnx/prompts.toml instead of arnx's defaults: fix.rules.")).toBe(true);
  const json = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  expect(await json.run("accept", "--again", "--no-answers", "--json")).toBe(0);
  expect(JSON.parse(json.stdout).fix_prompt_overrides).toEqual(["fix.rules"]);
});

const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-11T00:00:00Z" };
const GEN = "tests/arnx_generated/test_add.py";
const REPORT = '{"tests": [{"test": "tests/arnx_generated/test_add.py::test_add", "expects": "add sums"}],' +
  ' "suspected_defects": [], "questions": []}';
const runs = (): [string | null, string, boolean] => [junitXml([[GEN, "test_add", "passed", ""]]), "", false];
const writer = () => new ScriptedAgent([
  [tool("write_file", { path: GEN, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" })],
  [text(REPORT)],
]);
const EDITED = "this change edits .arnx/prompts.toml; the review uses its version";

/** A review of the working tree (or `range`), its progress lines, review.json and review.md. */
async function review(repo: string, range: string | null = null) {
  const said: string[] = [];
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: writer(), challenger: new FakeJson([]),
    sessionFactory: fakeFactory(runs), progress: (m) => said.push(m), range });
  return { said, json: JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as Record<string, unknown>,
    md: readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " ") };
}

function approvedRepo(): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-11"));
  writePrompts(repo, '[rank]\nsystem = "Rank by harm."\n');
  commit(repo, "arnx files");
  return repo;
}

test("a review whose change edits .arnx/prompts.toml says it ran that version", async () => {
  const repo = approvedRepo();
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const untouched = await review(repo);
  expect(untouched.said).not.toContain(EDITED);
  expect("prompts_file_edited" in untouched.json).toBe(false);
  expect(untouched.md).not.toContain("prompts.toml");

  writePrompts(repo, '[rank]\nsystem = "Rank by cost."\n');
  const edited = await review(repo);
  expect(edited.said).toContain(EDITED);
  expect(edited.json.prompts_file_edited).toBe(true);
  expect(edited.md).toContain("- This change edits .arnx/prompts.toml; the review used its version.");

  // A committed change counts the same.
  commit(repo, "cheaper ranking");
  expect((await review(repo, "HEAD~1..HEAD")).json.prompts_file_edited).toBe(true);
});

test("doctor reads .arnx/prompts.toml under arnx cloud too: accept uses its fix keys there", async () => {
  const repo = approvedRepo();
  writeSettings(repo, { ...SETTINGS, cloudConsentAt: "2026-10-20T00:00:00Z",
    cloud: { models: true, tests: false, effort: "medium" } });
  const doctor = async () => {
    const cli = new Cli({ cwd: repo, env: { HOME: join(tmp(), "home") } });
    await cli.run("doctor");
    return cli.out;
  };
  writePrompts(repo, '[fix]\ntsak = "x"\n');
  expect(await doctor()).toContain("✗ Prompts: .arnx/prompts.toml: unknown key fix.tsak; fix has intro, rules, decided");
  writePrompts(repo, FIX_RULES);
  expect(await doctor()).toContain("Prompts: yours for fix.rules");
  writePrompts(repo, `${FIX_RULES}[rank]\nsystem = "Rank."\n`);
  expect(await doctor()).toContain(`Prompts: yours for fix.rules; ${CLOUD_PROMPTS}`);
  writePrompts(repo, '[rank]\nsystem = "Rank."\n');
  expect(await doctor()).toContain(`Prompts: ${CLOUD_PROMPTS}`);
});
