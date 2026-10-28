// Setup lists a project's tests and runs a few small files before its whole suite: what they show wrong goes back to the
// agent in seconds, and the same environment tried again runs the whole suite.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parsePytestList } from "../src/adapters/python";
import { parseNextestList, rust } from "../src/adapters/rust";
import { typescript } from "../src/adapters/typescript";
import { parseReviewFile } from "../src/config";
import { probeText, sampleOf } from "../src/precheck";
import type { RunResult, Runner, SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = `version: 1
image: python:3.12-slim
install: [pip install pytest]
test_command: python -m pytest -q {targets}
`;
const FILES = ["tests/test_a.py", "tests/test_b.py", "tests/test_c.py", "tests/test_d.py", "tests/test_e.py"];
const PROBE = "tests/arnx_generated/test_arnx_probe.py";

/** An answer to one command: its exit code, its output, and the JUnit report it writes (if any). */
interface Answer { exit?: number; output?: string; xml?: string }

/** A Docker session whose commands answer by what they are: a listing (`--collect-only`), or a run. */
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

const passed = (files: string[]) => junitXml(files.map((f) => [f, "test_x", "passed", ""] as [string, string, string, string]));
const listed = FILES.map((f) => `${f}::test_x`).join("\n") + "\n\n5 tests collected in 0.01s";

/** Answers a listing with `list`, the one-line test's listing with `probe`, a run of a few files with `sample`, the
 * whole suite and the probe run with passing tests. */
function answers(list: Answer, { probe = { output: `${PROBE}::test_arnx_probe` } as Answer,
  sample = undefined as Answer | undefined } = {}) {
  return (command: string): Answer => {
    const isProbe = command.includes("test_arnx_probe.py");
    if (command.includes("--collect-only")) return isProbe ? probe : list;
    if (isProbe) return { xml: passed([PROBE]), output: "1 passed" };
    const targets = FILES.filter((f) => command.includes(f));
    if (targets.length) return sample ?? { xml: passed(targets), output: `${targets.length} passed` };
    return { xml: passed(FILES), output: "5 passed" };
  };
}

function factory(answer: (command: string) => Answer, seen: Session[]): SessionFactory {
  return async (_cfg, snap, _log, body) => {
    const s = new Session(snap, answer);
    seen.push(s);
    return body(s);
  };
}

/** A repository whose test files grow from a to e. */
function repo(): string {
  const r = gitRepo(tmp());
  FILES.forEach((f, i) => {
    mkdirSync(join(r, "tests"), { recursive: true });
    writeFileSync(join(r, f), "def test_x():\n    pass\n" + "# padding\n".repeat(i * 10));
  });
  commit(r, "tests");
  return r;
}

const result = (m: ScriptedAgent, call: number) =>
  String((m.calls[call]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content);

async function setup(answer: (command: string) => Answer, steps: number) {
  const model = new ScriptedAgent([...Array.from({ length: steps }, () => [tool("try_project", { yaml: YAML })]),
    [tool("propose", { yaml: YAML })], [text("done")]]);
  const sessions: Session[] = [];
  const r = await runSetup(repo(), defaultSettings(), model, { outDir: join(tmp(), "s"),
    sessionFactory: factory(answer, sessions) });
  return { r, model, sessions };
}

test("a listing that shows tests: the one-line test is listed, the three smallest files run, then the whole suite",
  async () => {
  const { r, model, sessions } = await setup(answers({ output: listed }), 1);
  expect(r.ok).toBe(true);
  expect(result(model, 1)).toContain("runs: 5 passed");
  const c = sessions[0]!.commands;
  expect(c.length).toBe(5); // list, the probe's listing, the sample, the suite, the probe
  expect(c[0]).toContain("--collect-only -q");
  expect(c[1]).toContain(`--collect-only`);
  expect(c[1]).toContain(PROBE);
  expect(FILES.filter((f) => c[2]!.includes(f))).toEqual(FILES.slice(0, 3));
  expect(c[3]).not.toContain("tests/test_");
});

test("a test_command that collects no tests goes back at once; tried again unchanged, the whole suite runs", async () => {
  const { r, model, sessions } = await setup(answers({ exit: 5, output: "\nno tests collected in 0.01s" }), 2);
  expect(sessions[0]!.commands.length).toBe(1);
  expect(result(model, 1)).toContain("does not run yet: listing the tests found none: test_command collects no tests");
  expect(result(model, 1)).toContain("no tests collected in 0.01s");
  expect(result(model, 1)).toContain("Tried again unchanged, the project runs its whole suite");
  // The same environment again: no listing, the whole suite.
  expect(sessions[1]!.commands.some((c) => c.includes("--collect-only"))).toBe(false);
  expect(result(model, 2)).toContain("runs: 5 passed");
  expect(r.ok).toBe(true);
});

test("files that do not load are named, with the runner's output, before the suite runs", async () => {
  const output = `${FILES.slice(0, 4).map((f) => `${f}::test_x`).join("\n")}\n\n` +
    "______________________ ERROR collecting tests/test_e.py ______________________\n" +
    "E   ModuleNotFoundError: No module named 'redis'\n" +
    "=========================== short test summary info ============================\n" +
    "ERROR tests/test_e.py\n4 tests collected, 1 error in 0.05s";
  const { model, sessions } = await setup(answers({ exit: 1, output }), 1);
  expect(sessions[0]!.commands.length).toBe(1);
  expect(result(model, 1)).toContain("listing the tests: 1 test file does not load (tests/test_e.py)");
  expect(result(model, 1)).toContain("No module named 'redis'");
});

test("a runner that does not start stops at the listing", async () => {
  const { model, sessions } = await setup(answers({ exit: 4, output: "ERROR: usage: unrecognized arguments: --cov" }), 1);
  expect(sessions[0]!.commands.length).toBe(1);
  expect(result(model, 1)).toContain("listing the tests stopped with an error (exit 4) before any test ran");
  expect(result(model, 1)).toContain("unrecognized arguments: --cov");
});

test("a one-line test the runner does not list from tests_dir stops the try before the suite", async () => {
  const { model, sessions } = await setup(answers({ output: listed },
    { probe: { exit: 5, output: "no tests collected in 0.01s" } }), 1);
  expect(sessions[0]!.commands.length).toBe(2);
  expect(result(model, 1)).toContain(probeText(parseReviewFile(YAML).projects[0]!));
});

test("a sample with no test passing stops the try, with what the failures point to", async () => {
  const xml = junitXml(FILES.slice(0, 3).map((f) => [f, "test_x", "error", "ModuleNotFoundError: No module named 'redis'"]));
  const { model, sessions } = await setup(answers({ output: listed }, { sample: { xml, output: "3 error" } }), 1);
  expect(sessions[0]!.commands.length).toBe(3);
  expect(result(model, 1)).toContain("a run of 3 small test files (tests/test_a.py, tests/test_b.py, tests/test_c.py): " +
    "3 error; no test passed, so the whole suite was not run");
  expect(result(model, 1)).toContain("redis");
});

test("a sample with no report stops the try", async () => {
  const { model } = await setup(answers({ output: listed }, { sample: { exit: 1, output: "Segmentation fault" } }), 1);
  expect(result(model, 1)).toContain("produced no report, so the whole suite was not run");
  expect(result(model, 1)).toContain("Segmentation fault");
});

test("a listing that cannot be read leaves the try as it was: the whole suite runs", async () => {
  const tree = "collected 5 items\n\n<Module tests/test_a.py>\n  <Function test_x>";
  const { r, sessions } = await setup(answers({ output: tree }), 1);
  expect(r.ok).toBe(true);
  expect(sessions[0]!.commands.length).toBe(3); // list, suite, probe
});

test("pytest's listing: node ids, counts per file, files that do not load, and the exit codes that tell", () => {
  expect(parsePytestList("a/test_x.py::test_1\na/test_x.py::C::test_2[1]\nb/test_y.py::t\n\n3 tests collected", 0))
    .toEqual({ tests: 3, files: ["a/test_x.py", "b/test_y.py"], broken: [], failed: false });
  expect(parsePytestList("a/test_x.py: 2\nb/test_y.py: 5\n", 0)!.tests).toBe(7);
  expect(parsePytestList("", 5)).toEqual({ tests: 0, files: [], broken: [], failed: false });
  expect(parsePytestList("ERROR a/test_z.py - ImportError: x\n1 error", 1)!.broken).toEqual(["a/test_z.py"]);
  expect(parsePytestList("ImportError while loading conftest", 4)!.failed).toBe(true);
  expect(parsePytestList("sh: pytest: not found", 127)!.failed).toBe(true);
  // Nothing it can read for sure: a verbose tree, a failure with no file named, a run killed or timed out.
  expect(parsePytestList("<Module a/test_x.py>", 0)).toBeNull();
  expect(parsePytestList("1 failed", 1)).toBeNull();
  expect(parsePytestList("Killed", 137)).toBeNull();
  expect(parsePytestList("", null)).toBeNull();
});

test("vitest and jest list; node and bun have no list form", () => {
  const vitest = (c: string) => typescript.listCommand!(c, ["a.test.ts"], "/src/.arnx-run/list.json", "vitest");
  expect(vitest("ln -sfn /opt/deps/node_modules node_modules && npx vitest run --project unit {targets}")).toBe(
    "ln -sfn /opt/deps/node_modules node_modules && npx vitest list --project unit a.test.ts " +
    "--json=/src/.arnx-run/list.json");
  expect(vitest("npx vitest --run {targets}")).toBeNull();
  expect(typescript.listCommand!("npx jest {targets}", [], "/x", "jest")).toBe("npx jest  --listTests --json");
  expect(typescript.listCommand!("node --test {targets}", [], "/x", "node")).toBeNull();
  expect(typescript.listCommand!("bun test {targets}", [], "/x", "bun")).toBeNull();
  const parse = typescript.parseList!;
  const entries = JSON.stringify([{ name: "g > a", file: "/src/web/src/a.test.ts" }, { name: "b", file: "/src/web/src/a.test.ts" }]);
  expect(parse("", entries, 0, "vitest", "web")).toEqual({ tests: 2, files: ["src/a.test.ts"], broken: [], failed: false });
  expect(parse("", "[]", 0, "vitest", ".")!.tests).toBe(0);
  expect(parse("", null, 0, "vitest", ".")).toBeNull();
  expect(parse("CACError: Unknown option `--json`", null, 1, "vitest", ".")).toBeNull(); // vitest 1
  expect(parse("Error: Failed to load url ./x.js", null, 1, "vitest", ".")!.failed).toBe(true);
  expect(parse("", null, 137, "vitest", ".")).toBeNull();
  expect(parse('ts-jest warning\n["/src/a.test.js","/src/b.test.js"]\n', null, 0, "jest", ".")).toEqual(
    { tests: null, files: ["a.test.js", "b.test.js"], broken: [], failed: false });
  expect(parse("[]", null, 0, "jest", ".")!.files).toEqual([]);
  expect(parse("● Validation Error: Preset ts-jest not found.", null, 1, "jest", ".")!.failed).toBe(true);
});

test("nextest lists with the run's filters; a failed build stops it, an option only a run takes reads as unknown", () => {
  const c = rust.listCommand!("cargo nextest run {targets}", [], "/x", "nextest")!;
  expect(c).toContain('cargo nextest list --workspace -E "$pkg" --message-format json');
  expect(c).not.toContain("--profile arnx");
  const json = JSON.stringify({ "test-count": 3, "rust-suites": {
    "app": { testcases: { "a::t1": { "filter-match": { status: "matches" } },
      "a::t2": { "filter-match": { status: "mismatch", reason: "ignored" } } } },
    "app::it": { testcases: { t3: { "filter-match": { status: "matches" } } } } } });
  expect(parseNextestList(`${json}\n   Compiling app v0.1.0\n`, 0)).toEqual({ tests: 2, files: [], broken: [], failed: false });
  expect(parseNextestList("error[E0425]: cannot find value", 101)!.failed).toBe(true);
  expect(parseNextestList("error: unexpected argument '--no-fail-fast' found", 2)).toBeNull();
  expect(parseNextestList("not json", 0)).toBeNull();
});

test("the sample: the smallest files the listing names, found under the project when the runner's root sits above it",
  () => {
  const snap = tmp();
  const cfg = { ...parseReviewFile(YAML).projects[0]!, workdir: "svc" };
  const sizes: Record<string, number> = { "tests/test_big.py": 900, "tests/test_a.py": 10, "tests/test_b.py": 20,
    "tests/test_c.py": 30, "tests/arnx_generated/test_old.py": 1 };
  for (const [f, n] of Object.entries(sizes)) {
    mkdirSync(dirname(join(snap, "svc", f)), { recursive: true });
    writeFileSync(join(snap, "svc", f), "x".repeat(n));
  }
  const listing = { tests: 5, files: Object.keys(sizes).map((f) => `svc/${f}`), broken: [], failed: false };
  expect(sampleOf(listing, cfg, snap)).toEqual(["tests/test_a.py", "tests/test_b.py", "tests/test_c.py"]);
  // Few more files than the sample: the whole suite is about as quick.
  expect(sampleOf({ ...listing, files: listing.files.slice(1, 4) }, cfg, snap)).toEqual([]);
});
