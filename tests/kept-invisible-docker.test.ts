// Docker end to end: after `arnx accept`, the project's own test runner, type checker and linter give the same result
// as before it, since accept stores each kept file under a name none of them picks up; `arnx check` still runs the
// kept test (red until the bug is fixed). Real images and tools, scripted models. Run with ARNX_DOCKER_TESTS=1.
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { accept } from "../src/accept";
import { snapshot } from "../src/change";
import { check, checkSummary } from "../src/check";
import { loadReviewFile, reviewConfigPath } from "../src/config";
import { exitCode } from "../src/report";
import { runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { approveFile } from "../src/setup";
import { dockerSession, runPath } from "../src/testround";
import { FakeJson, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { blankMarks } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const SETTINGS = { ...defaultSettings(), consentAt: "2026-11-13T00:00:00Z" };
const tmp = useTmp();

function repoWith(name: string, files: Record<string, string>): string {
  const repo = initRepo(join(tmp(), name));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  commit(repo, "start");
  return repo;
}

function markReal(rdir: string): void {
  const md = join(rdir, "review.md");
  writeFileSync(md, blankMarks(readFileSync(md, "utf8")).replace("Mark: [ ] real", "Mark: [x] real"));
}

/** The project's own commands, each in the approved image, on the repository as a developer's checkout holds it:
 * arnx's snapshot leaves .arnx/ out, so all of it is copied back in (kept tests, reviews with their copies of the
 * generated tests, review.yaml, setup's files; only run/, check's logs, is left out). Each command's exit code, and its
 * output when it is not 0. */
async function ownRun(repo: string, commands: string[]): Promise<Record<string, number | null | string>> {
  const cfg = loadReviewFile(repo).projects[0]!;
  const snap = join(mkdtempSync(join(tmpdir(), "arnx-own-")), "repo");
  try {
    snapshot(repo, null, snap, [], { untracked: true });
    cpSync(join(repo, ".arnx"), join(snap, ".arnx"), { recursive: true,
      filter: (p) => p !== join(repo, ".arnx", "run") });
    return await dockerSession(cfg, snap, join(tmp(), "build.log"), async (s) => {
      const out: Record<string, number | null | string> = {};
      for (const c of commands) {
        const r = await s.run(c, 600);
        out[c] = r.exitCode === 0 ? 0 : `${r.exitCode}: ${r.output.slice(-1500)}`;
      }
      return out;
    });
  } finally {
    rmSync(join(snap, ".."), { recursive: true, force: true });
  }
}

// A TypeScript project whose own run is a plain `vitest run`, whose tsconfig includes every file and whose eslint
// lints every .ts file (with espree: a type annotation in a file it reaches is a parse error).
const TS_YAML = `version: 1
projects:
  calc:
    root: .
    language: typescript
    runner: vitest
    image: node:22-bookworm-slim
    install: ["mkdir -p /opt/deps && cp package.json /opt/deps/ && cd /opt/deps && npm install --no-audit --no-fund && chmod -R a+rwX /opt/deps"]
    deps_dir: /opt/deps
    test_command: npx vitest run {targets}
`;
const TS_FILES: Record<string, string> = {
  "package.json": JSON.stringify({ name: "calc", private: true, type: "module", scripts: { test: "vitest run" },
    devDependencies: { vitest: "3.2.4", typescript: "5.9.3", eslint: "9.30.0" } }) + "\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { noEmit: true, target: "es2022", module: "esnext",
    moduleResolution: "bundler", skipLibCheck: true, types: [] }, include: ["**/*"] }) + "\n",
  "eslint.config.mjs": 'export default [{ files: ["**/*.ts"] }];\n',
  "src/calc.ts": "export function add(a, b) {\n  return a + b;\n}\n",
  "src/calc.test.ts": 'import { expect, test } from "vitest";\nimport { add } from "./calc";\n\n' +
    'test("adds", () => {\n  expect(add(1, 2)).toBe(3);\n});\n',
};
const TS_GEN = "__tests__/arnx_generated/calc.test.ts";
// Fails on the change; holds a type error only tsc sees and a type annotation espree cannot parse.
const TS_TEST = 'import { expect, test } from "vitest";\nimport { add } from "../../src/calc";\n\n' +
  'const label: number = "sum";\n\ntest("adds negative numbers", () => {\n  expect(add(-1, -2)).toBe(-3);\n});\n';
const TS_OWN = ["npx vitest run", "npx tsc --noEmit", "npx eslint ."];

const PY_YAML = `version: 1
projects:
  calc:
    root: .
    image: python:3.12-slim
    install: [pip install -r requirements.txt]
    test_command: python -m pytest -q {targets}
`;
const PY_FILES: Record<string, string> = {
  "requirements.txt": "pytest>=8,<9\n",
  "calc.py": "def add(a, b):\n    return a + b\n",
  "tests/test_calc.py": "from calc import add\n\n\ndef test_add():\n    assert add(1, 2) == 3\n",
};
const PY_DIR = "tests/arnx_generated";
// The test needs its support file: without conftest.py in place, its fixture is missing and it errors.
const PY_CONFTEST = "import pytest\n\n\n@pytest.fixture\ndef minus_one():\n    return -1\n";
const PY_TEST = "from calc import add\n\n\ndef test_adds_negative_numbers(minus_one):\n    assert add(minus_one, -2) == -3\n";

describe.skipIf(!process.env.ARNX_DOCKER_TESTS)("docker: kept tests are invisible to the project's own tools", () => {
  test("TypeScript: vitest, tsc and eslint give the same result after accept; check still runs the kept test",
    async () => {
    const repo = repoWith("ts-kept", TS_FILES);
    mkdirSync(join(repo, ".arnx"));
    writeFileSync(reviewConfigPath(repo), TS_YAML);
    commit(repo, "arnx");
    const [ok, detail] = await approveFile(repo, { by: "Dev", at: "2026-11-13" });
    expect([ok, detail]).toEqual([true, "calc: 1 passed"]);
    writeFileSync(join(repo, "src/calc.ts"), "export function add(a, b) {\n  return Math.abs(a) + b;\n}\n");
    commit(repo, "abs");
    const before = await ownRun(repo, TS_OWN);
    expect(before).toEqual(Object.fromEntries(TS_OWN.map((c) => [c, 0])));

    const report = text(JSON.stringify({ tests: [], suspected_defects: [{ test: `${TS_GEN}::adds negative numbers`,
      explanation: "abs drops the sign" }], questions: [] }));
    const agent = new ScriptedAgent([[tool("write_file", { path: TS_GEN, content: TS_TEST })], [tool("run_tests")],
      [report], [report]]);
    const { review, rdir } = await runReview(repo, { settings: { ...SETTINGS, fixProofMax: 0 }, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "-1 becomes 1" }]) });
    expect([review.missingRuns, review.findings.map((f) => f.func), exitCode(review)])
      .toEqual([0, ["adds negative numbers"], 0]);
    markReal(rdir);
    const result = await accept(repo, rdir, SETTINGS);
    expect(await ownRun(repo, TS_OWN)).toEqual(before);
    expect(result.kept.map((p) => p.slice(repo.length + 1))).toEqual([
      expect.stringMatching(/^\.arnx\/tests\/__tests__\/arnx\/r[0-9_a-f]+\/abs_drops_the_sign\.test\.ts\.arnx$/)]);
    const [r] = await check(repo, SETTINGS);
    expect(r!.failed.map((t) => t.testId.split("::").at(-1))).toEqual(["adds negative numbers"]);
    expect(r!.failed.map((t) => t.message).join("\n")).not.toContain("Cannot find");
  }, 900_000);

  test("Python: pytest gives the same result after accept; check places the support file and runs the kept test",
    async () => {
    const repo = repoWith("py-kept", PY_FILES);
    mkdirSync(join(repo, ".arnx"));
    writeFileSync(reviewConfigPath(repo), PY_YAML);
    commit(repo, "arnx");
    const [ok] = await approveFile(repo, { by: "Dev", at: "2026-11-13" });
    expect(ok).toBe(true);
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return abs(a) + b\n");
    commit(repo, "abs");
    const own = ["python -m pytest -q"];
    const before = await ownRun(repo, own);
    expect(before).toEqual({ "python -m pytest -q": 0 });

    const gen = `${PY_DIR}/test_calc.py`;
    const report = text(JSON.stringify({ tests: [], suspected_defects: [{ test: `${gen}::test_adds_negative_numbers`,
      explanation: "abs drops the sign" }], questions: [] }));
    const agent = new ScriptedAgent([[tool("write_file", { path: `${PY_DIR}/conftest.py`, content: PY_CONFTEST })],
      [tool("write_file", { path: gen, content: PY_TEST })], [tool("run_tests")], [report], [report]]);
    const { review, rdir } = await runReview(repo, { settings: { ...SETTINGS, fixProofMax: 0 }, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "-1 becomes 1" }]) });
    expect([review.missingRuns, review.findings.map((f) => f.func)]).toEqual([0, ["test_adds_negative_numbers"]]);
    markReal(rdir);
    const result = await accept(repo, rdir, SETTINGS);
    expect(await ownRun(repo, own)).toEqual(before);
    expect(result.kept.map((p) => p.slice(repo.length + 1)).sort()).toEqual([
      expect.stringMatching(/^\.arnx\/tests\/tests\/arnx\/r[0-9_a-f]+\/conftest\.py\.arnx$/),
      expect.stringMatching(/^\.arnx\/tests\/tests\/arnx\/r[0-9_a-f]+\/test_abs_drops_the_sign\.py\.arnx$/)]);
    const [r] = await check(repo, SETTINGS);
    expect(r!.failed.map((t) => [t.testId.split("::").at(-1), t.outcome])).toEqual([["test_adds_negative_numbers", "failed"]]);

    // The project's own configuration leaves the red accepted test out: pytest reports nothing for it, and check
    // names it and does not pass (exit 1), never "The accepted test passes".
    const run = runPath(result.kept.map((p) => p.slice(repo.length + 1)).find((p) => p.includes("test_abs"))!);
    const id = `${run}::test_adds_negative_numbers`;
    for (const [file, body] of [["pytest.ini", `[pytest]\naddopts = --deselect ${id}\n`],
      ["conftest.py", "def pytest_collection_modifyitems(items):\n" +
        "    items[:] = [i for i in items if i.name != 'test_adds_negative_numbers']\n"]] as const) {
      writeFileSync(join(repo, file), body);
      const [left] = await check(repo, SETTINGS);
      expect([file, left!.missingAccepted, left!.failed.length, left!.noReport]).toEqual([file, [id], 0, false]);
      const [said, code] = checkSummary([left!]);
      expect([file, code]).toEqual([file, 1]);
      expect(said).toContain("✗ 1 accepted test did not report, so not shown to pass:\n  ✗ test_adds_negative_numbers");
      rmSync(join(repo, file));
    }
  }, 900_000);

  test("Python: the variant of a parametrized test that fails on the bug must report; one left out is named (exit 1)",
    async () => {
    const repo = repoWith("py-param", PY_FILES);
    mkdirSync(join(repo, ".arnx"));
    writeFileSync(reviewConfigPath(repo), PY_YAML);
    commit(repo, "arnx");
    const [ok] = await approveFile(repo, { by: "Dev", at: "2026-11-13" });
    expect(ok).toBe(true);
    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return abs(a) + b\n");
    commit(repo, "abs");

    // test_z[0] passes on the bug; test_z[1] and test_z[slow_path] fail on it.
    const gen = `${PY_DIR}/test_param.py`;
    const body = "import pytest\n\nfrom calc import add\n\n\n" +
      "@pytest.mark.parametrize('a', [0, 1, pytest.param(2, id='slow_path')])\n" +
      "def test_z(a):\n    assert add(-a, 0) == -a\n";
    const report = text(JSON.stringify({ tests: [], suspected_defects: [{ test: `${gen}::test_z`,
      explanation: "abs drops the sign" }], questions: [] }));
    const agent = new ScriptedAgent([[tool("write_file", { path: gen, content: body })], [tool("run_tests")], [report],
      [report]]);
    const { review, rdir } = await runReview(repo, { settings: { ...SETTINGS, fixProofMax: 0 }, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "-1 becomes 1" }, { verdict: "confirmed", reason: "-2 becomes 2" }]) });
    expect([review.missingRuns, review.findings.map((f) => f.testId.split("::").at(-1))])
      .toEqual([0, ["test_z[1]", "test_z[slow_path]"]]);
    const md = join(rdir, "review.md");
    writeFileSync(md, blankMarks(readFileSync(md, "utf8")).replaceAll("Mark: [ ] real", "Mark: [x] real"));
    const result = await accept(repo, rdir, SETTINGS);
    const run = runPath(result.kept.map((p) => p.slice(repo.length + 1)).find((p) => p.includes("test_abs"))!);
    const [one, slow] = [`${run}::test_z[1]`, `${run}::test_z[slow_path]`];
    const [r] = await check(repo, SETTINGS);
    expect([r!.failed.map((t) => t.testId).sort(), r!.missingAccepted]).toEqual([[one, slow], undefined]);

    // Each leaves out what fails on the bug: before, test_z[0] passing stood in for its variants (exit 0).
    const cases: [string, string, string[], string[]][] = [
      ["pytest.ini", `[pytest]\naddopts = --deselect ${one} --deselect ${slow}\n`, [one, slow], []],
      ["conftest.py", "def pytest_collection_modifyitems(items):\n" +
        "    items[:] = [i for i in items if i.name not in ('test_z[1]', 'test_z[slow_path]')]\n", [one, slow], []],
      // By accident: -k matches parameter ids too.
      ["pytest.ini", "[pytest]\naddopts = -k 'not slow'\n", [slow], [one]],
    ];
    for (const [file, text, missing, failing] of cases) {
      writeFileSync(join(repo, file), text);
      const [left] = await check(repo, SETTINGS);
      expect([text, left!.missingAccepted, left!.failed.map((t) => t.testId), left!.noReport])
        .toEqual([text, missing, failing, false]);
      const [said, code] = checkSummary([left!]);
      expect([text, code]).toEqual([text, 1]);
      expect(said).toContain(`did not report, so not shown to pass:\n${missing.map((m) => `  ✗ ${m.split("::")[1]}`).join("\n")}`);
      expect(said).not.toContain("✓ The accepted test passes");
      rmSync(join(repo, file));
    }
  }, 900_000);
});
