// arnx scan: the hunt alone, on this machine. Scripted models only: no test here calls a paid model or Docker.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Boundary } from "../src/boundary";
import { ModelError } from "../src/errors";
import type { AgentModel } from "../src/llm";
import { detectedProject, runScan, type ScanModels, scanSummary, testNames } from "../src/scan";
import { defaultSettings, type Settings } from "../src/settings";
import { Cli } from "./helpers/cli";
import { AWS_KEY } from "./helpers/fakekeys";
import { FakeJson, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo, runGit } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

const SUSPECT = { file: "app.py", line: 2, claim: "add returns the difference of its arguments",
  why: "the change replaced + with -", input: "add(1, 2)", expected: "3", actual: "-1" };
const hunted = (suspects: unknown[]) => text(JSON.stringify({ suspects }));

/** A repository with one commit and add() changed in the working tree. */
function changed(): string {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  return repo;
}

/** The reviewer reads app.py, then replies to the hunt; the second hunter has its own list. */
function models(o: { reviewer?: unknown[]; second?: unknown[]; agent?: AgentModel } = {}) {
  const agent = o.agent as ScriptedAgent ?? new ScriptedAgent([[tool("read_file", { path: "app.py" })],
    [hunted(o.reviewer ?? [SUSPECT])]]);
  const second = new FakeJson([{ suspects: o.second ?? [] }]);
  return { agent, second, m: { agentModel: agent, secondHunter: second } as ScanModels };
}

const settings = (over: Partial<Settings> = {}): Settings => ({ ...defaultSettings({}), ...over });

/** Every message the reviewer and the second hunter were sent, as one text. */
const sent = (agent: ScriptedAgent, second: FakeJson) =>
  JSON.stringify(agent.calls.map((c) => [c.system, c.messages])) + second.calls.join("\n");

test("a scan runs the reviewer's hunt with read tools only and stops at its reply", async () => {
  const repo = changed();
  const { agent, second, m } = models({ second: [{ ...SUSPECT, line: 1, claim: "add has no type check" }] });
  const r = await runScan(repo, { settings: settings(), models: m, boundary: new Boundary() });
  // Two turns: one read, one hunt reply; no test was asked for.
  expect(agent.calls.length).toBe(2);
  for (const c of agent.calls) {
    expect(c.tools).not.toContain("write_file");
    expect(c.tools).not.toContain("run_tests");
    expect(c.tools).toContain("read_file");
  }
  expect(second.calls.length).toBe(1);
  expect(r.suspects.map((s) => [s.id, s.file, s.line, s.claim])).toEqual([
    ["S1", "app.py", 2, SUSPECT.claim], ["S2", "app.py", 1, "add has no type check"]]);
  expect(r.projectsFrom).toBe("detected");
  expect(r.projects.map((p) => [p.name, p.language])).toEqual([["main", "python"]]);
  expect(r.costUsd).toBeGreaterThan(0);
});

test("a scan writes only its own folder, which git ignores: no config, no review, nothing review or check reads", async () => {
  const repo = changed();
  const r = await runScan(repo, { settings: settings(), models: models().m, boundary: new Boundary() });
  expect(readdirSync(join(repo, ".arnx")).sort()).toEqual(["scans"]);
  expect(readFileSync(join(repo, ".arnx", "scans", ".gitignore"), "utf8")).toBe("*\n");
  const saved = JSON.parse(readFileSync(join(repo, r.dir, "scan.json"), "utf8"));
  expect(saved.unproven).toBe(true);
  expect(saved.suspects[0].claim).toBe(SUSPECT.claim);
  // Only the change itself shows in git status.
  expect(runGit(repo, "status", "--porcelain").trim()).toBe("M app.py");
});

test("scan output and JSON never call a suspect a finding, an issue or a bug", async () => {
  const repo = changed();
  const { m } = models();
  const cli = new Cli({ cwd: repo, scanModels: () => m });
  expect(await cli.run("scan")).toBe(0);
  const json = new Cli({ cwd: repo, scanModels: () => models().m });
  expect(await json.run("scan", "--json")).toBe(0);
  const obj = JSON.parse(json.stdout);
  const keys = JSON.stringify(obj, (_k, v) => v).match(/"[a-z_]+":/g) ?? [];
  for (const k of keys) expect(k).not.toMatch(/finding|issue|bug/);
  // Our own words only: the claim and why are the model's.
  const ours = cli.stdout.replace(SUSPECT.claim, "").replace(SUSPECT.why, "");
  expect(ours).not.toMatch(/finding|issue|\bbug/i);
  expect(cli.stdout).toContain("Unproven");
  expect(cli.stdout.trim().split("\n").at(-1)).toBe("Next: arnx review proves or rules them out with tests.");
  expect(obj).toMatchObject({ command: "scan", result: "ok", exit_code: 0, unproven: true, next: ["arnx review"] });
  expect(obj.file).toBe(`${obj.scan_id ? `.arnx/scans/${obj.scan_id}` : ""}/scan.json`);
  expect(obj.suspects[0]).toMatchObject({ id: "S1", file: "app.py", line: 2, claim: SUSPECT.claim });
});

test("no suspects is exit 0, and the next step says a scan proves nothing", async () => {
  const repo = changed();
  const cli = new Cli({ cwd: repo, scanModels: () => models({ reviewer: [] }).m });
  expect(await cli.run("scan")).toBe(0);
  expect(cli.stdout).toContain("no suspects");
  expect(cli.stdout).toContain("Next: arnx review tests the change; a scan proves nothing either way.");
});

test("a scan never asks for Docker", async () => {
  const repo = changed();
  const cli = new Cli({ cwd: repo, scanModels: () => models().m,
    dockerOk: () => { throw new Error("scan asked for Docker"); } });
  expect(await cli.run("scan")).toBe(0);
});

test("a scan that could not run exits non-zero: the reviewer's model failed", async () => {
  const repo = changed();
  const failing: AgentModel = { model: "claude-sonnet-5-5",
    create: async () => { throw new ModelError("Anthropic API error 500: overloaded"); } };
  const cli = new Cli({ cwd: repo, scanModels: () => ({ agentModel: failing }) });
  const code = await cli.run("scan");
  expect(code).not.toBe(0);
  expect(cli.stderr).toContain("could not run");
});

test("the budget stops a scan before the hunt reply: not run, the cap named", async () => {
  const repo = changed();
  writeFileSync(join(repo, ".gitignore"), ".arnx/\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(join(repo, ".arnx", "config.toml"), "[budget]\nscan_usd = 0.000001\n");
  const { agent, m } = models();
  const cli = new Cli({ cwd: repo, scanModels: () => m });
  expect(await cli.run("scan")).toBe(2);
  expect(cli.stderr).toContain("scan_usd");
  expect(agent.calls.length).toBe(1);
});

test("arnx cloud does not scan: refused before anything is sent", async () => {
  const repo = changed();
  const { agent, m } = models();
  const cli = new Cli({ cwd: repo, scanModels: () => m });
  expect(await cli.run("scan", "--cloud")).toBe(3);
  expect(cli.stderr).toContain("arnx cloud does not scan");
  expect(agent.calls.length).toBe(0);
});

test("missing keys stop a scan with exit 3, nothing sent", async () => {
  const repo = changed();
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("scan")).toBe(3);
  expect(cli.stderr).toContain("ANTHROPIC_API_KEY");
  expect(existsSync(join(repo, ".arnx"))).toBe(false);
});

test("a repository only in languages arnx does not review is refused, as review refuses it", async () => {
  const root = tmp();
  const repo = gitRepo(root);
  runGit(repo, "rm", "-q", "app.py");
  writeFileSync(join(repo, "main.lua"), "print(1)\n");
  commit(repo, "lua");
  writeFileSync(join(repo, "main.lua"), "print(2)\n");
  const { agent, m } = models();
  const cli = new Cli({ cwd: repo, scanModels: () => m });
  expect(await cli.run("scan")).toBe(3);
  expect(agent.calls.length).toBe(0);
});

test("documentation alone is nothing to scan (exit 0), and nothing is sent", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "README.md"), "# hi\n");
  commit(repo, "readme");
  writeFileSync(join(repo, "README.md"), "# hello\n");
  const { agent, m } = models();
  const cli = new Cli({ cwd: repo, scanModels: () => m });
  expect(await cli.run("scan")).toBe(0);
  expect(cli.stderr).toContain("nothing to scan");
  expect(agent.calls.length).toBe(0);
});

test("what leaves the machine is what a review sends: .arnxignore, secret fakes, untracked only with --untracked", async () => {
  const repo = changed();
  writeFileSync(join(repo, ".arnxignore"), "data/\n");
  mkdirSync(join(repo, "data"));
  writeFileSync(join(repo, "data", "dump.py"), "ROWS = 'private-row-text'\n");
  writeFileSync(join(repo, "keys.py"), "def key():\n    return 1\n");
  commit(repo, "data and keys");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(join(repo, "data", "dump.py"), "ROWS = 'private-row-text-2'\n");
  writeFileSync(join(repo, "keys.py"), `def key():\n    return "${AWS_KEY}"\n`);
  writeFileSync(join(repo, "notes_untracked.py"), "SECRET_PLAN = 'untracked-text'\n");
  let { agent, second, m } = models();
  await runScan(repo, { settings: settings(), models: m, boundary: new Boundary() });
  let all = sent(agent, second);
  expect(all).not.toContain("private-row-text");
  expect(all).not.toContain(AWS_KEY);
  expect(all).not.toContain("untracked-text");
  ({ agent, second, m } = models());
  await runScan(repo, { settings: settings(), models: m, boundary: new Boundary(), untracked: true });
  all = sent(agent, second);
  expect(all).toContain("untracked-text");
  expect(all).not.toContain(AWS_KEY);
});

test("with .arnx/review.yaml, its projects are scanned", async () => {
  const repo = changed();
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(join(repo, ".arnx", "review.yaml"), "version: 1\nimage: python:3.12-slim\nworkdir: .\n" +
    "test_command: python -m pytest -q {targets}\n");
  const r = await runScan(repo, { settings: settings(), models: models().m, boundary: new Boundary() });
  expect(r.projectsFrom).toBe("review.yaml");
  expect(r.suspects.length).toBe(1);
});

test("which changed files a project's tests name: false is certain, true only means a test names it", () => {
  const snap = tmp();
  mkdirSync(join(snap, "tests"));
  writeFileSync(join(snap, "app.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(join(snap, "util.py"), "X = 1\n");
  writeFileSync(join(snap, "tests", "test_app.py"), "from app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n");
  const cfg = detectedProject({ root: ".", language: "python", runner: null });
  const named = testNames(snap, cfg, ["app.py", "util.py", "README.md"]);
  expect(named("app.py")).toBe(true);
  expect(named("util.py")).toBe(false);
  expect(named("README.md")).toBeNull();
});

test("the summary is short: where, what, why, and one next line", () => {
  const lines = scanSummary({ id: "20261116-abc123", dir: ".arnx/scans/20261116-abc123", change: "uncommitted changes",
    projectsFrom: "detected", projects: [{ name: "main", language: "python", root: ".", files: ["app.py"] }],
    suspects: [{ ...SUSPECT, id: "S1", by: "claude-sonnet-5-5", project: "main", testNamesFile: false }],
    notScanned: [{ path: "main.lua", reason: "no project arnx reviews holds it" }], costUsd: 0.0412, costUnknown: false,
    budgetUsd: 0.5, capped: false, seconds: 21.3,
    models: { reviewer: "anthropic:claude-sonnet-5-5", hunter: null, ranker: null, second_hunter: null } });
  expect(lines).toEqual([
    "Scanned uncommitted changes: 1 suspect ($0.04, 21.3 s).",
    "Unproven: nothing was run. Each is a guess until a test fails.",
    "",
    "S1  app.py:2",
    `    ${SUSPECT.claim}`,
    `    Why: ${SUSPECT.why}`,
    "    Try: add(1, 2)",
    "    Expected: 3",
    "    May get: -1",
    "    No test file names app.py.",
    "",
    "Not scanned: main.lua (no project arnx reviews holds it)",
    "",
    "Saved: .arnx/scans/20261116-abc123/scan.json",
    "Next: arnx review proves or rules them out with tests.",
  ]);
});

test("arnx scan --help names the command and its options", async () => {
  const cli = new Cli({});
  expect(await cli.run("scan", "--help")).toBe(0);
  expect(cli.stdout).toContain("arnx scan [--range A..B] [--untracked] [--docs]");
  expect(cli.stdout).toContain("unproven");
});
