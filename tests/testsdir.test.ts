// Setup works out tests_dir from the runner's own configuration before its first try: vitest's include, jest's roots
// and testMatch, pytest's testpaths. Only literal configuration is read; anything else keeps the default, and the
// probe decides as before.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAdapter } from "../src/adapters";
import { defaultSettings } from "../src/settings";
import { runSetup, withTestsDirs } from "../src/setup";
import { exportedConfig, globRegex, runnerArgs, SPREAD, staticPrefix, testsDirFor, UNKNOWN } from "../src/testsdir";
import { fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

function files(root: string, map: Record<string, string>): string {
  for (const [p, body] of Object.entries(map)) {
    mkdirSync(dirname(join(root, p)), { recursive: true });
    writeFileSync(join(root, p), body);
  }
  return root;
}

const ts = (runner: string, testCommand: string, workdir = ".") =>
  ({ language: "typescript" as const, runner, workdir, testCommand, testsDir: getAdapter("typescript").defaultTestsDir });
const py = (testCommand = "python -m pytest {targets}", workdir = ".") =>
  ({ language: "python" as const, runner: "pytest", workdir, testCommand, testsDir: getAdapter("python").defaultTestsDir });

test("globs read as vitest and jest read them", () => {
  const vitestDefault = globRegex("**/*.{test,spec}.?(c|m)[jt]s?(x)");
  expect(vitestDefault.test("__tests__/arnx_generated/arnx-probe.test.ts")).toBe(true);
  expect(vitestDefault.test("a.spec.mjs")).toBe(true);
  expect(vitestDefault.test("a.tests.ts")).toBe(false);
  const src = globRegex("src/**/*.test.(js|ts)");
  expect(["src/a.test.ts", "src/x/y/b.test.js", "lib/a.test.ts", "src/a.test.tsx"].map((p) => src.test(p)))
    .toEqual([true, true, false, false]);
  expect(globRegex("**/?(*.)+(spec|test).?([mc])[jt]s?(x)").test("/src/app/__tests__/unit/x.test.js")).toBe(true);
  expect(globRegex("app/test/**/*_test.ts").test("app/test/arnx_generated/arnx-probe.test.ts")).toBe(false);
  expect(globRegex("**/node_modules/**").test("a/node_modules/b/c.js")).toBe(true);
  expect(staticPrefix("./src/domain/**/*.test.ts")).toBe("src/domain");
  expect(staticPrefix("**/*.test.ts")).toBe(".");
});

test("a configuration file's literal export, through defineConfig, arrow functions and variables", () => {
  expect(exportedConfig("import { defineConfig } from 'vitest/config';\n// a 'comment\nexport default defineConfig({\n" +
    "  test: { include: ['src/**/*.test.ts'], /* x */ coverage: { include: ['src/**'] } },\n});\n"))
    .toEqual({ test: { include: ["src/**/*.test.ts"], coverage: { include: ["src/**"] } } });
  expect(exportedConfig("export default defineConfig(({ mode }) => ({ test: { include: [\"a/**\"] } }))"))
    .toEqual({ test: { include: ["a/**"] } });
  expect(exportedConfig("export default defineConfig(async ({ mode }) => {\n  const x = { test: 1 };\n" +
    "  if (mode) { return { nope: true }; }\n  return {\n    plugins: [react(), /['\"]/.test(mode) && b()],\n" +
    "    test: { include: ['src/**/*.test.ts'], onLog(l: string): boolean { return l === '}'; } },\n  };\n});\n"))
    .toEqual({ plugins: [UNKNOWN, UNKNOWN], test: { include: ["src/**/*.test.ts"], onLog: UNKNOWN } });
  expect(exportedConfig("const shared = require('./shared');\nconst config: Config = {\n  ...shared,\n" +
    "  roots: ['<rootDir>/test'], testMatch: [`**/*.test.ts`],\n};\nmodule.exports = config;\n"))
    .toEqual({ [SPREAD]: UNKNOWN, roots: ["<rootDir>/test"], testMatch: ["**/*.test.ts"] });
  expect(exportedConfig("export default mergeConfig(base, defineConfig({ test: { include: ['x'] } }))")).toBe(UNKNOWN);
  expect(exportedConfig("export default defineConfig({ test: { include: [...SOURCES, 'b/**'], root: here } })"))
    .toEqual({ test: { include: [UNKNOWN, "b/**"], root: UNKNOWN } });
});

test("the runner's arguments and the folder it runs in, through cd", () => {
  const vitest = /(?:^|\/)vitest$/;
  expect(runnerArgs("ln -sfn /opt/deps/node_modules node_modules && npx vitest run -c 'a b.ts' {targets}", vitest,
    "web")).toEqual({ cwd: "web", args: ["run", "-c", "a b.ts", "{targets}"] });
  expect(runnerArgs("unset CI; cd /opt/app && x; cd /src/packages/sync && npx vitest run {targets}", vitest, "."))
    ?.toMatchObject({ cwd: "packages/sync" });
  expect(runnerArgs("cd /opt/app && npx vitest run {targets}", vitest, ".")).toBeNull();
  expect(runnerArgs("cd .. && npx vitest run", vitest, "a/b")).toMatchObject({ cwd: "a" });
  expect(runnerArgs("python -m pytest -q {targets}", /(?:^|\/)pytest$/, ".", true)?.args).toEqual(["-q", "{targets}"]);
  expect(runnerArgs("node --test {targets}", vitest, ".")).toBeNull();
});

test("vitest: a new folder inside the include; none when the default is included or nothing fits", () => {
  const repo = files(tmp(), {
    "packages/sync/vitest.config.mts": "export default defineConfig({ test: { include: ['src/**/*.test.(js|ts)'] } });\n",
    "packages/sync/src/a.test.ts": "", "packages/plain/package.json": "{}",
    "packages/spec/vitest.config.ts": "export default defineConfig({ test: { include: ['src/**/*.spec.ts'] } });\n",
  });
  const run = "npx vitest run {targets}";
  expect(testsDirFor(repo, ts("vitest", run, "packages/sync"))).toEqual({ dir: "src/arnx_generated", why: "vitest include" });
  // No configuration: vitest's default include takes __tests__/arnx_generated as it is.
  expect(testsDirFor(repo, ts("vitest", run, "packages/plain"))).toBeNull();
  // Files named *.spec.ts only: no folder makes arnx's *.test.ts files run, so the probe tells the agent.
  expect(testsDirFor(repo, ts("vitest", run, "packages/spec"))).toBeNull();
  // A tests_dir already set and included stays.
  expect(testsDirFor(repo, { ...ts("vitest", run, "packages/sync"), testsDir: "src/mine" })).toBeNull();
});

test("vitest: --config and cd in test_command, a configuration outside the repository, --project", () => {
  const repo = files(tmp(), {
    "scripts/tests/vitest.config.ts": "export default defineConfig({ test: { include: ['scripts/tests/**/*.test.js'] } });\n",
    "vitest.config.ts": "export default defineConfig({ test: { projects: [\n" +
      "  { test: { name: 'unit:app', include: ['app/test/**/*.test.ts'] } },\n" +
      "  { test: { name: 'unit:tools', include: ['tools/test/**/*_test.ts'] } },\n] } });\n",
  });
  expect(testsDirFor(repo, ts("vitest", "cd /src && npx vitest run --config ./scripts/tests/vitest.config.ts {targets}",
    "scripts"))).toEqual({ dir: "tests/arnx_generated", why: "vitest include" });
  expect(testsDirFor(repo, ts("vitest", "npx vitest run -c /opt/deps/wrap.config.ts {targets}", "scripts"))).toBeNull();
  expect(testsDirFor(repo, ts("vitest", "cd /src && npx vitest run --project unit:app {targets}", "app")))
    .toEqual({ dir: "test/arnx_generated", why: "vitest include" });
  expect(testsDirFor(repo, ts("vitest", "cd /src && npx vitest run --project unit:tools {targets}", "tools"))).toBeNull();
});

test("vitest: of several included folders, the one holding the project's own tests", () => {
  const repo = files(tmp(), {
    "vitest.config.ts": "export default defineConfig({ test: { include: ['scripts/**/*.test.ts', 'src/**/*.test.ts'] } })",
    "scripts/one.test.ts": "", "src/a.test.ts": "", "src/b/c.test.ts": "",
  });
  expect(testsDirFor(repo, ts("vitest", "npx vitest run {targets}"))?.dir).toBe("src/arnx_generated");
});

test("jest: roots and testMatch, from jest.config.js or package.json; a spread that may hold them is not read", () => {
  const repo = files(tmp(), {
    "api/jest.config.js": "const shared = require('../shared');\nmodule.exports = {\n  ...shared,\n" +
      "  roots: ['<rootDir>/__tests__/unit'],\n  testMatch: ['**/*.test.js'],\n};\n",
    "api/__tests__/unit/a.test.js": "",
    "infra/package.json": JSON.stringify({ jest: { roots: ["<rootDir>/test"], testMatch: ["**/*.test.ts"] } }),
    "spread/jest.config.js": "module.exports = { ...require('../shared') };\n",
    "regex/jest.config.json": JSON.stringify({ testRegex: "/spec/.*\\.test\\.[jt]s$" }),
    "regex/spec/a.test.ts": "",
  });
  const run = "npx jest {targets}";
  expect(testsDirFor(repo, ts("jest", run, "api"))).toEqual({ dir: "__tests__/unit/arnx_generated",
    why: "jest roots and testMatch" });
  expect(testsDirFor(repo, ts("jest", run, "infra"))?.dir).toBe("test/arnx_generated");
  expect(testsDirFor(repo, ts("jest", run, "spread"))).toBeNull();
  expect(testsDirFor(repo, ts("jest", run, "regex"))?.dir).toBe("spec/arnx_generated");
});

test("pytest: testpaths that leave tests/ out give a folder inside them; none without testpaths", () => {
  const repo = files(tmp(), {
    "svc/pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\"tests/unit\", \"tests/integration\"]\n",
    "svc/tests/unit/test_a.py": "", "svc/tests/unit/test_b.py": "", "svc/tests/integration/test_c.py": "",
    "ini/pytest.ini": "[pytest]\ntestpaths =\n    src/tests\n", "ini/src/tests/test_x.py": "",
    "plain/setup.cfg": "[tool:pytest]\naddopts = -q\n",
    "covered/tox.ini": "[pytest]\ntestpaths = tests\n",
  });
  expect(testsDirFor(repo, py(undefined, "svc"))).toEqual({ dir: "tests/unit/arnx_generated", why: "pytest testpaths" });
  expect(testsDirFor(repo, py(undefined, "ini"))?.dir).toBe("src/tests/arnx_generated");
  expect(testsDirFor(repo, py(undefined, "plain"))).toBeNull();
  expect(testsDirFor(repo, py(undefined, "covered"))).toBeNull();
  expect(testsDirFor(repo, { ...py(), language: "rust" as never, runner: "nextest" })).toBeNull();
});

test("withTestsDirs sets tests_dir only where the file has none, and never on a project kept as approved", () => {
  const repo = files(tmp(), {
    "a/vitest.config.ts": "export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })",
    "b/vitest.config.ts": "export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })",
    "c/vitest.config.ts": "export default defineConfig({ test: { include: ['src/**/*.test.ts'] } })",
  });
  const project = (root: string, extra = "") => `  ${root}:\n    root: ${root}\n    language: typescript\n` +
    `    runner: vitest\n    image: node:22\n    test_command: npx vitest run {targets}\n${extra}`;
  const yaml = `version: 1\nprojects:\n${project("a")}${project("b", "    tests_dir: other\n")}${project("c")}`;
  const [out, set] = withTestsDirs(yaml, repo, new Set(["c"]));
  expect(set).toEqual([{ project: "a", dir: "src/arnx_generated", why: "vitest include" }]);
  expect(out).toContain("test_command: npx vitest run {targets}\n    tests_dir: src/arnx_generated\n  b:");
  expect(out).toContain("tests_dir: other");
  expect(out.match(/tests_dir/g)).toHaveLength(2);
  expect(withTestsDirs("version: 2\n", repo)).toEqual(["version: 2\n", []]);
});

test("setup sets tests_dir from pytest's testpaths, tells the agent once, and the accepted file keeps it", async () => {
  const repo = gitRepo(tmp());
  files(repo, { "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = [\"tests/unit\"]\n",
    "tests/unit/test_a.py": "def test_a(): pass\n" });
  commit(repo, "tests");
  const yaml = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest {targets}\n";
  const model = new ScriptedAgent([[tool("try_project", { yaml })], [tool("propose", { yaml })], [text("done")]]);
  const sessions: { commands: string[] }[] = [];
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "setup"),
    sessionFactory: fakeFactory(() => [junitXml([["tests/unit/test_a.py", "test_a", "passed", ""]]), "1 passed", false],
      sessions as never) });
  expect(r.ok).toBe(true);
  expect(r.yamlText).toBe(`${yaml}tests_dir: tests/unit/arnx_generated\n`);
  const reply = (call: number) => String((model.calls[call]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!
    .content);
  expect(reply(1)).toStartWith("(tests_dir of main set to tests/unit/arnx_generated: the default folder lies outside " +
    "its pytest testpaths.)\n");
  expect(reply(2)).not.toContain("tests_dir of main");
  expect(sessions.some((s) => s.commands.some((c) => c.includes("tests/unit/arnx_generated/test_arnx_probe.py"))))
    .toBe(true);
});
