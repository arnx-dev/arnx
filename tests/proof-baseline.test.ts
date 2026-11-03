// A test file recorded as not loading stays recorded: the proof after setup, and any later quick proof, do not stop
// on it. Only a file that newly stops loading fails a proof.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeBaseline } from "../src/baseline";
import { Cli } from "./helpers/cli";
import { reviewConfigPath } from "../src/config";
import type { RunResult, Runner, SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { approveFile, runSetup } from "../src/setup";
import { ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const GOOD = ["tests/test_a.py", "tests/test_b.py", "tests/test_c.py", "tests/test_d.py", "tests/test_e.py"];
const BROKEN = "tests/test_broken.py";
const OTHER = "tests/test_other.py";
const WHY = "pkg.errors.ConfigurationError: Invalid URI host: localhost is not a valid hostname";

interface Answer { exit?: number; output?: string; xml?: string }

class Session implements Runner {
  commands: string[] = [];
  constructor(readonly snap: string, readonly answer: (command: string) => Answer) {}
  run(command: string): RunResult {
    this.commands.push(command);
    const a = this.answer(command);
    const m = /--junitxml=\/src\/(\S+)/.exec(command);
    if (a.xml && m) {
      mkdirSync(dirname(join(this.snap, m[1]!)), { recursive: true });
      writeFileSync(join(this.snap, m[1]!), a.xml);
    }
    return { exitCode: a.exit ?? 0, output: a.output ?? "", timedOut: false, seconds: 0.1 };
  }
}

const factory = (answer: (command: string) => Answer, seen: Session[] = []): SessionFactory =>
  async (_cfg, snap, _log, body) => {
    const s = new Session(snap, answer);
    seen.push(s);
    return body(s);
  };

/** A pytest over five files that load and the files in `broken`, which do not. */
function pytest(broken: string[]) {
  return (command: string): Answer => {
    const probe = /(\S*test_arnx_probe\.py)/.exec(command)?.[1];
    if (command.includes("--collect-only")) {
      if (probe) return { output: `${probe}::test_arnx_probe` };
      return { exit: broken.length ? 1 : 0, output: [...GOOD.map((f) => `${f}::test_x`),
        ...broken.map((f) => `ERROR ${f} - ${WHY}`), `${GOOD.length} tests collected`].join("\n") };
    }
    if (probe) return { xml: junitXml([[probe, "test_x", "passed", ""]]), output: "1 passed" };
    const targets = GOOD.filter((f) => command.includes(f));
    const cases = targets.length ? targets.map((f) => [f, "test_x", "passed", ""] as [string, string, string, string])
      : [...GOOD.map((f) => [f, "test_x", "passed", ""] as [string, string, string, string]),
        ...broken.map((f) => [f, f, "error", WHY] as [string, string, string, string])];
    return { exit: broken.length && !targets.length ? 1 : 0, xml: junitXml(cases), output: "ran" };
  };
}

function project(): string {
  const r = gitRepo(tmp());
  mkdirSync(join(r, "tests"), { recursive: true });
  writeFileSync(join(r, "pyproject.toml"), "[project]\nname = \"svc\"\nversion = \"0.1\"\n");
  writeFileSync(join(r, "app.py"), "X = 1\n");
  [...GOOD, BROKEN, OTHER].forEach((f, i) => writeFileSync(join(r, f), "def test_x():\n    pass\n" + "#\n".repeat(i)));
  commit(r, "svc");
  mkdirSync(join(r, ".arnx"), { recursive: true });
  return r;
}

const YAML = "version: 1\nprojects:\n  svc:\n    root: .\n    language: python\n    image: python:3.12\n" +
  "    install: [pip install pytest]\n    test_command: python -m pytest {targets}\n";
const quickProof = (repo: string, answer: (command: string) => Answer, seen: Session[] = []) =>
  approveFile(repo, { by: "Dev", at: "2026-11-03", quick: ["svc"], sessionFactory: factory(answer, seen) });
const recorded = { id: `${BROKEN}::tests.test_broken`, file: BROKEN, first: WHY, load: true as const };

test("a file recorded as not loading does not stop a quick proof", async () => {
  const repo = project();
  writeFileSync(reviewConfigPath(repo), YAML);
  writeBaseline(repo, new Map([["svc", [recorded]]]));
  const [ok, detail, suites] = await quickProof(repo, pytest([BROKEN]));
  expect(detail).not.toContain("do not load");
  expect(detail).not.toContain("does not load");
  expect(ok).toBe(true);
  expect(suites[0]!.summary).toStartWith("quick look:");
});

test("a file known_failing sets aside does not stop a quick proof", async () => {
  const repo = project();
  writeFileSync(reviewConfigPath(repo), YAML.replace("    test_command:", `    known_failing: [${BROKEN}]\n` +
    `    notes: ["${BROKEN}: needs a database"]\n    test_command:`));
  const [ok] = await quickProof(repo, pytest([BROKEN]));
  expect(ok).toBe(true);
});

test("a file that newly stops loading fails the quick proof, in words for the developer", async () => {
  const repo = project();
  writeFileSync(reviewConfigPath(repo), YAML);
  writeBaseline(repo, new Map([["svc", [recorded]]]));
  const [ok, detail] = await quickProof(repo, pytest([BROKEN, OTHER]));
  expect(ok).toBe(false);
  expect(detail).toContain(`1 test file does not load (${OTHER})`);
  expect(detail).not.toContain(`${BROKEN},`);
  expect(detail).not.toContain("Tried again");
});

test("a file that fails today, but loaded when recorded, stopping to load fails the quick proof", async () => {
  const repo = project();
  writeFileSync(reviewConfigPath(repo), YAML);
  writeBaseline(repo, new Map([["svc", [{ id: `${BROKEN}::test_x`, file: BROKEN, first: "assert 1 == 2" }]]]));
  const [ok, detail] = await quickProof(repo, pytest([BROKEN]));
  expect(ok).toBe(false);
  expect(detail).toContain(`1 test file does not load (${BROKEN})`);
});

test("a first run whose agent adds a note after its last run: setup's run stands, nothing runs again", async () => {
  const repo = project();
  const env = "    env:\n      DB_URL: localhost\n";
  const file = YAML + env;
  const noted = file + "    notes:\n      - pkg connects at import time, so 1 test file does not load\n";
  const model = new ScriptedAgent([[tool("try_project", { yaml: file })], [tool("try_project", { yaml: file })],
    [tool("propose", { yaml: noted })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "s"),
    sessionFactory: factory(pytest([BROKEN])), quick: { files: ["app.py"] } });
  expect(r.ok).toBe(true);
  writeFileSync(reviewConfigPath(repo), r.yamlText!);
  writeBaseline(repo, new Map(r.projects.map((p) => [p.name, p.failed ?? []])));
  const sessions: Session[] = [];
  const [ok, detail, suites] = await approveFile(repo, { by: "Dev", at: "2026-11-03", afterSetup: r.runs, quick: ["svc"],
    sessionFactory: factory(pytest([BROKEN]), sessions) });
  expect(detail).not.toContain("does not load");
  expect(ok).toBe(true);
  expect(sessions).toEqual([]);
  expect(suites[0]!.reused).toBe(true);
});

test("a first run stopped by its proof names what to fix and the command that goes on", async () => {
  const repo = project();
  const env = { ANTHROPIC_API_KEY: "a" };
  expect(await new Cli({ cwd: repo, env }).run("init")).toBe(0);
  commit(repo, "init");
  writeFileSync(join(repo, "app.py"), "X = 2\n");
  commit(repo, "change");
  // The agent changes the project's map after its last run, so the proof runs; there, one more file does not load.
  const file = YAML + "    env:\n      DB_URL: localhost\n";
  const model = new ScriptedAgent([[tool("try_project", { yaml: file })], [tool("try_project", { yaml: file })],
    [tool("propose", { yaml: `${file}    uses: [pyproject.toml]\n` })], [text("done")]]);
  const cli = new Cli({ cwd: repo, env, setupModel: model, setupSessions: factory(pytest([BROKEN])),
    approveSessions: factory(pytest([BROKEN, OTHER])) });
  expect(await cli.run("consent", "--yes")).toBe(0);
  expect(await cli.run("review")).toBe(2);
  expect(cli.stdout).toContain(`1 test file does not load (${OTHER})`);
  expect(cli.stdout).not.toContain("Tried again");
  expect(cli.stdout.trimEnd()).toEndWith("Next: fix the ✗ above, then arnx review");
  expect(cli.stderr).not.toContain("Proposal rejected");
});
