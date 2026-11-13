// The coverage map arnx derives itself: .arnx/ never counts, source files outside every project go back to the agent
// once by folder and are then listed under uncovered with a reason arnx states, browser suites are listed as browser
// tests, a web UI app gets one try, and the end screen groups what no project tests by reason.
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { browserSuites, uiFramework } from "../src/browser";
import { parseReviewFile } from "../src/config";
import { ArnxError } from "../src/errors";
import type { SessionFactory } from "../src/sandbox";
import { NOT_SET_UP } from "../src/draft";
import { coverageMap, honestReasons, runSetup, sourceGroups, webUiPaths, withUncovered } from "../src/setup";
import { filesLine, worthALook } from "../src/setupview";
import { defaultSettings } from "../src/settings";
import { FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
let repo = "";

const FILES: Record<string, string> = {
  "api/app.py": "X = 1\n",
  "api/tests/test_app.py": "def test_a():\n    pass\n",
  "web/package.json": JSON.stringify({ dependencies: { "react-dom": "18.3.1" }, devDependencies: { vitest: "2" } }),
  "web/src/app.tsx": "export const A = 1;\n",
  "web/playwright.config.ts": "export default { testDir: './e2e' };\n",
  "web/e2e/home.spec.ts": "test('home', () => {});\n",
  "tools/gen.py": "print(1)\n",
  "legacy/old.py": "X = 2\n",
  "docs/guide.md": "# guide\n",
  // Accepted tests: arnx's own, never part of the map.
  ".arnx/tests/api/tests/arnx/r1/test_kept.py": "def test_kept():\n    pass\n",
};

beforeEach(() => {
  repo = initRepo(join(tmp(), "repo"));
  for (const [p, body] of Object.entries(FILES)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  commit(repo, "layout");
});

const API = `  api:
    root: api
    language: python
    image: python:3.12-slim
    test_command: python -m pytest -q {targets}
`;
const WEB = `  web:
    root: web
    language: typescript
    runner: vitest
    image: node:22-slim
    test_command: npx vitest run {targets}
`;
const BOTH = `version: 1\nprojects:\n${API}${WEB}`;
/** BOTH with web's environment changed `n` times: a try in a changed environment runs the whole suite again. */
const bothEnv = (n: number) => BOTH.replace("npx vitest run {targets}", `npx vitest run${" --silent".repeat(n)} {targets}`);

/** A session whose vitest run writes `xml` where --outputFile says, like the real runner. */
class VitestSession extends FakeSession {
  constructor(snap: string, private readonly xml: string) { super(snap, () => [null, "out", false]); }
  override run(command: string) {
    const r = super.run(command);
    const m = /--outputFile=\/src\/(\S+)/.exec(command);
    if (m) {
      mkdirSync(dirname(join(this.snap, m[1]!)), { recursive: true });
      // The one-line test arnx places, when it is the target: it passes whenever the runner runs it.
      const probe = /(\S*arnx-probe\.test\.\w+)/.exec(command)?.[1]?.replace(/^'|'$/g, "").replace(/^\/?src\/web\//, "");
      writeFileSync(join(this.snap, m[1]!), probe ? junitXml([[probe, "arnx probe", "passed", ""]]) : this.xml);
    }
    return r;
  }
}
const apiSession = (snap: string) => new FakeSession(snap, () => [API_PASSES, "1 passed", false]);

/** web's suite runs and fails; api's passes. */
const webFails = (): SessionFactory => async (cfg, snap, _log, body) =>
  body(cfg.name === "web" ? new VitestSession(snap, WEB_FAILS) : apiSession(snap));

/** api's suite runs; web's environment does not build. */
const sessions: SessionFactory = async (cfg, snap, _log, body) => {
  if (cfg.name === "web") throw new ArnxError("npm ci failed: no lockfile");
  return body(new FakeSession(snap, () => [junitXml([["tests/test_app.py", "test_a", "passed", ""]]), "1 passed", false]));
};
/** web has a test file of its own, and its suite fails (a counted run) or passes. */
const addWebTest = () => {
  writeFileSync(join(repo, "web", "src", "app.test.tsx"), "test('a', () => {});\n");
  commit(repo, "web test");
};
const WEB_FAILS = junitXml([["src/app.test.tsx", "renders", "failed", "boom"]]);
const WEB_PASSES = junitXml([["src/app.test.tsx", "renders", "passed", ""]]);
const API_PASSES = junitXml([["tests/test_app.py", "test_a", "passed", ""]]);
const result = (m: ScriptedAgent, call: number) =>
  (m.calls[call]!.messages.at(-1)!.content as Record<string, unknown>[]).map((r) => String(r.content)).join("\n");

test(".arnx/ is never part of the coverage map", () => {
  const map = coverageMap(repo, parseReviewFile(`version: 1\nprojects:\n${API}${WEB}uncovered:\n` +
    "  - {path: /tools/, reason: scripts}\n  - {path: /legacy/, reason: no tests}\n"));
  expect(map.unexplained).toEqual([]);
  expect(map.groups).toEqual([]);
});

test("source files outside every project are grouped by the shallowest folder no project reaches into", () => {
  expect(sourceGroups(["tools/gen.py", "tools/x/y.py", "legacy/old.py", "setup.py", "packages/util.ts",
    "packages/web/a.ts"], ["packages/api/b.ts"])).toEqual([
    { path: "/tools/", reason: "scripts", files: 2 },
    { path: "/legacy/", reason: "no tests", files: 1 },
    { path: "/setup.py", reason: "no tests", files: 1 },
    // packages/ holds a project's files: each file, or the folder below it that holds none.
    { path: "/packages/util.ts", reason: "no tests", files: 1 },
    { path: "/packages/web/", reason: "no tests", files: 1 },
  ]);
});

test("a web UI app gets two runs; propose asks once about the rest, then lists it under uncovered itself", async () => {
  addWebTest();
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: bothEnv(1), project: "web" })],
    [tool("try_project", { yaml: bothEnv(2), project: "web" })],
    [tool("try_project", { yaml: bothEnv(3), project: "web" })],
    [tool("try_project", { yaml: BOTH, project: "api" })],
    [tool("propose", { yaml: BOTH })],
    [tool("propose", { yaml: BOTH })],
    [text("api only.")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: webFails() });
  expect(result(m, 2)).toContain("web is a web UI app (react-dom among its dependencies), which gets two runs");
  expect(result(m, 3)).toContain("web is listed under uncovered as web UI: do not try it again");
  // Once, by folder: web/ is arnx's own entry by now, .arnx/ never counts.
  expect(result(m, 5)).toBe("refused:\nsource files outside every project, by folder (with the reason arnx lists " +
    "them under uncovered with):\n- /legacy/ (1 file): no tests\n- /tools/ (1 file): scripts\nPut those a project " +
    "tests under its owns or uses; propose again and arnx lists the rest under uncovered itself.");
  expect(result(m, 6)).toContain("accepted");
  expect(r.ok).toBe(true);
  const f = parseReviewFile(r.yamlText!);
  expect(f.projects.map((p) => p.name)).toEqual(["api"]);
  expect(f.uncovered).toEqual([
    { path: "/web/e2e/", reason: "browser tests (Playwright)" },
    { path: "/web/playwright.config.ts", reason: "browser tests (Playwright)" },
    { path: "/web/", reason: "web UI" },
    { path: "/legacy/", reason: "no tests" },
    { path: "/tools/", reason: "scripts" },
  ]);
  // The end screen: one line per kind of reason.
  expect(worthALook(f, repo, {})).toEqual([
    "not tested (browser tests): /web/e2e/, /web/playwright.config.ts (2 files)",
    "not tested (web UI): /web/ (5 files)",
    "not tested (no tests): /legacy/ (1 file)",
    "not tested (scripts): /tools/ (1 file)",
  ]);
});

test("a web UI app whose image build fails may be tried again", async () => {
  addWebTest();
  let builds = 0;
  const flaky: SessionFactory = async (cfg, snap, _log, body) => {
    if (cfg.name === "web" && ++builds === 1) throw new ArnxError("npm ci failed: network");
    return body(cfg.name === "web" ? new VitestSession(snap, WEB_PASSES) : apiSession(snap));
  };
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: BOTH, project: "web" })],
    [tool("try_project", { yaml: BOTH, project: "web" })],
    [tool("try_project", { yaml: BOTH, project: "api" })],
    [tool("propose", { yaml: BOTH })],
    [tool("propose", { yaml: BOTH })],
    [text("both.")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: flaky });
  expect(result(m, 1)).toContain("failed: npm ci failed");
  expect(result(m, 1)).not.toContain("web UI");
  expect(result(m, 2)).toContain("the suite of web runs");
  expect(r.ok).toBe(true);
  const f = parseReviewFile(r.yamlText!);
  expect(f.projects.map((p) => p.name)).toEqual(["api", "web"]);
  expect(f.uncovered.some((u) => u.reason === "web UI")).toBe(false);
});

test("a web UI app gets two runs of its tests", async () => {
  addWebTest();
  const failing = webFails();
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: bothEnv(1), project: "web" })],
    [tool("try_project", { yaml: bothEnv(2), project: "web" })],
    [tool("try_project", { yaml: bothEnv(3), project: "web" })],
    [tool("try_project", { yaml: BOTH, project: "api" })],
    [tool("propose", { yaml: BOTH })],
    [tool("propose", { yaml: BOTH })],
    [text("api only.")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: failing });
  expect(result(m, 1)).not.toContain("web UI");
  expect(result(m, 2)).toContain("web is a web UI app (react-dom among its dependencies), which gets two runs");
  expect(result(m, 3)).toContain("web is listed under uncovered as web UI: do not try it again");
  expect(r.ok).toBe(true);
  expect(parseReviewFile(r.yamlText!).uncovered).toContainEqual({ path: "/web/", reason: "web UI" });
});

test("stops on the project's settings are not runs of a web UI app's tests", async () => {
  addWebTest();
  // tests_dir holds the project's own tests: the suite never runs.
  const inSrc = BOTH + "    tests_dir: src\n";
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: inSrc, project: "web" })],
    [tool("try_project", { yaml: inSrc, project: "web" })],
    [tool("try_project", { yaml: inSrc, project: "web" })],
    [text("stop")],
  ]);
  await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: webFails() });
  for (const call of [1, 2, 3]) expect(result(m, call)).not.toContain("web UI app");
});

test("a rerun of the files that failed last time is not a run of a web UI app's tests", async () => {
  addWebTest();
  const m = new ScriptedAgent([
    ...[1, 2, 3, 4].map(() => [tool("try_project", { yaml: BOTH, project: "web" })]),
    [text("stop")],
  ]);
  await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: webFails() });
  // The first full run counts once; the reruns of its failing files never reach two.
  for (const call of [1, 2, 3, 4]) expect(result(m, call)).not.toContain("web UI app");
});

test("a web UI app whose try first needs a file .arnxignore leaves out is not charged a run for it", async () => {
  addWebTest();
  writeFileSync(join(repo, "web", "fixture.json"), "{}\n");
  writeFileSync(join(repo, ".arnxignore"), "web/fixture.json\n");
  commit(repo, "fixture");
  const missing = "Error: ENOENT: no such file or directory, open '/src/web/fixture.json'";
  const web: SessionFactory = async (cfg, snap, _log, body) => body(new FakeSession(snap, () =>
    [junitXml([["web/src/app.test.tsx", "renders", "error", missing]]), missing, false]));
  const m = new ScriptedAgent([[tool("try_project", { yaml: bothEnv(1), project: "web" })],
    [tool("try_project", { yaml: bothEnv(2), project: "web" })], [text("stop")]]);
  await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: web });
  expect(result(m, 1)).not.toContain("web UI app");
  expect(result(m, 2)).toContain("web is a web UI app (react-dom among its dependencies), which gets two runs");
});

test("a web UI app at the repository root lists only its own paths, not **", () => {
  const f = parseReviewFile(`version: 1\nprojects:\n${API}  site:\n    root: .\n    language: typescript\n` +
    "    runner: vitest\n    image: node:22-slim\n    test_command: npx vitest run {targets}\n");
  const files = ["package.json", "index.html", "src/main.tsx", "src/app/view.tsx", "api/app.py", "api/tests/test_app.py",
    "README.md"];
  expect(webUiPaths(f, "site", files)).toEqual(["/src/"]);
  // In its own folder, the folder.
  expect(webUiPaths(parseReviewFile(BOTH), "web", Object.keys(FILES))).toEqual(["/web/"]);
});

test("a web UI app that is the only project ends setup after its two runs", async () => {
  addWebTest();
  const only = `version: 1\nprojects:\n${WEB}`;
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: only })],
    [tool("try_project", { yaml: only.replace("{targets}", "--silent {targets}") })],
    [tool("propose", { yaml: only })],
    [text("unreachable")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: webFails() });
  expect(r.ok).toBe(false);
  expect([r.stop, r.problem]).toEqual(["web-ui", "only web UI here, which arnx does not set up"]);
});

test("a UI app whose two runs stop at listing says its tests did not list", async () => {
  addWebTest();
  const only = `version: 1\nprojects:\n${WEB}`;
  const error = "Error: Cannot find module './setup-env' imported from vitest.config.ts";
  class Unlisted extends VitestSession {
    override run(command: string) {
      const r = super.run(command);
      return /vitest list/.test(command) ? { ...r, exitCode: 1, output: `boot noise\n${error}` } : r;
    }
  }
  const sessions: SessionFactory = async (_cfg, snap, _log, body) => body(new Unlisted(snap, WEB_FAILS));
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: only })],
    [tool("try_project", { yaml: only.replace("{targets}", "--silent {targets}") })],
    [tool("propose", { yaml: only })],
    [text("unreachable")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: sessions });
  expect(r.stop).toBe("web-ui");
  expect(r.problem).toContain("its tests did not list in 2 tries");
  expect(r.problem).toContain(error);
  expect(r.problem).not.toContain("only web UI here");
});

test("a UI app that never listed is still listed under uncovered as web UI", async () => {
  addWebTest();
  class Unlisted extends VitestSession {
    override run(command: string) {
      const r = super.run(command);
      return /vitest list/.test(command) ? { ...r, exitCode: 1, output: "Error: no config" } : r;
    }
  }
  const sessions: SessionFactory = async (cfg, snap, _log, body) =>
    body(cfg.name === "web" ? new Unlisted(snap, WEB_FAILS) : apiSession(snap));
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: bothEnv(1), project: "web" })],
    [tool("try_project", { yaml: bothEnv(2), project: "web" })],
    [tool("try_project", { yaml: BOTH, project: "api" })],
    [tool("propose", { yaml: BOTH })],
    [tool("propose", { yaml: BOTH })],
    [text("api only.")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: sessions });
  expect(result(m, 2)).toContain("web is a web UI app");
  expect(parseReviewFile(r.yamlText!).uncovered).toContainEqual({ path: "/web/", reason: "web UI" });
});

test("browser suites: Playwright, Cypress, Storybook and vitest's browser mode", () => {
  const files = ["app/playwright.config.ts", "app/tests/e2e/a.spec.ts", "site/cypress.config.js", "site/cypress/e2e/b.cy.js",
    "ui/.storybook/main.ts", "ui/src/Button.stories.tsx", "lib/vitest.config.ts", "plain/vitest.config.ts",
    "self/playwright.config.ts", "self/a.spec.ts"];
  const read = (p: string) => p === "app/playwright.config.ts" ? "export default { testDir: 'tests/e2e' }"
    : p === "lib/vitest.config.ts" ? "export default { test: { browser: { provider: 'playwright', enabled: true } } }"
    : p === "self/playwright.config.ts" ? "export default { testDir: '.' }" : "";
  expect(browserSuites(files, read)).toEqual([
    { path: "/app/tests/e2e/", tool: "Playwright" },
    { path: "/app/playwright.config.ts", tool: "Playwright" },
    { path: "/site/cypress/", tool: "Cypress" },
    { path: "/site/cypress.config.js", tool: "Cypress" },
    { path: "/ui/.storybook/", tool: "Storybook" },
    { path: "/ui/**/*.stories.*", tool: "Storybook" },
    { path: "/lib/vitest.config.ts", tool: "vitest browser mode" },
    // A testDir that is the configuration's own folder would take in the whole project: the file alone.
    { path: "/self/playwright.config.ts", tool: "Playwright" },
  ]);
});

test("a UI framework among the runtime dependencies makes a web UI app; a dev dependency does not", () => {
  expect(uiFramework(JSON.stringify({ dependencies: { next: "15", react: "19" } }))).toBe("next");
  expect(uiFramework(JSON.stringify({ dependencies: { express: "4" }, devDependencies: { vue: "3" } }))).toBeNull();
  expect(uiFramework("not json")).toBeNull();
});

test("withUncovered drops projects and appends entries not listed yet; an unchanged file stays byte-equal", () => {
  const text = `version: 1\nprojects:\n${API}${WEB}uncovered:\n  - {path: /tools/, reason: scripts}\n`;
  expect(withUncovered(text, [{ path: "/tools/", reason: "scripts" }])).toBe(text);
  const out = parseReviewFile(withUncovered(text, [{ path: "/web/", reason: "web UI" }], ["web"]));
  expect(out.projects.map((p) => p.name)).toEqual(["api"]);
  expect(out.uncovered).toEqual([{ path: "/tools/", reason: "scripts" }, { path: "/web/", reason: "web UI" }]);
  const none = parseReviewFile(withUncovered(BOTH, [{ path: "/legacy/", reason: "no tests" }]));
  expect(none.uncovered).toEqual([{ path: "/legacy/", reason: "no tests" }]);
});

test("withUncovered drops a project whose anchor the others' merge keys name, and keeps their settings", () => {
  const text = "version: 1\nprojects:\n  api: &base\n    root: api\n    language: python\n    runner: pytest\n" +
    "    image: python:3.12\n    test_command: pytest {targets}\n  web:\n    <<: *base\n    root: web\n";
  const out = parseReviewFile(withUncovered(text, [{ path: "/api/", reason: "setup reached its time limit" }], ["api"]));
  expect(out.projects.map((p) => [p.name, p.workdir, p.testCommand])).toEqual([["web", "web", "pytest {targets}"]]);
  expect(out.uncovered).toEqual([{ path: "/api/", reason: "setup reached its time limit" }]);
});

test("the files line counts the paths no project tests once there are more than three", () => {
  const f = { projects: [{ name: "api", owned: 3, used: 0 }], untrackedLeftOut: [] };
  expect(filesLine({ ...f, notTested: ["/a/", "/b/"] })).toBe("  Files: api owns 3, uses 0 · not tested: /a/, /b/");
  expect(filesLine({ ...f, notTested: ["/a/", "/b/", "/c/", "/d/"] })).toBe("  Files: api owns 3, uses 0 · not tested: 4 paths");
});

test("a folder holding test files is not listed as having no tests", () => {
  const all = ["svc/app.py", "svc/tests/test_app.py", "legacy/old.py", "tools/gen.py"];
  expect(sourceGroups(["svc/app.py", "legacy/old.py", "tools/gen.py"], [], all)).toEqual([
    { path: "/svc/", reason: NOT_SET_UP, files: 1 },
    { path: "/legacy/", reason: "no tests", files: 1 },
    { path: "/tools/", reason: "scripts", files: 1 },
  ]);
});

test("a lone test file, or a file beside tests, is not listed as having no tests", () => {
  const all = ["test_a.py", "api/test_b.py", "api/x.py", "api/y.py", "solo/z.py"];
  expect(sourceGroups(["test_a.py", "api/test_b.py", "solo/z.py"], ["api/x.py"], all)).toEqual([
    { path: "/test_a.py", reason: NOT_SET_UP, files: 1 },
    { path: "/api/test_b.py", reason: NOT_SET_UP, files: 1 },
    { path: "/solo/", reason: "no tests", files: 1 },
  ]);
  const yaml = `version: 1\nprojects:\n${API}uncovered:\n  - {path: /test_a.py, reason: no tests}\n` +
    "  - {path: /api/y.py, reason: no tests}\n  - {path: /solo/z.py, reason: no tests}\n";
  expect(parseReviewFile(honestReasons(yaml, all)).uncovered.map((u) => u.reason))
    .toEqual([NOT_SET_UP, NOT_SET_UP, "no tests"]);
});

test("a folder with none still is", () => {
  expect(sourceGroups(["legacy/old.py"], [], ["legacy/old.py", "other/test_x.py"]))
    .toEqual([{ path: "/legacy/", reason: "no tests", files: 1 }]);
});

test("an agent's no-tests reason is corrected", () => {
  const files = ["svc/app.py", "svc/tests/test_app.py", "legacy/old.py"];
  const yaml = `version: 1\nprojects:\n${API}` +
    "uncovered:\n  - {path: /svc/, reason: no tests}\n  - {path: /legacy/, reason: no tests}\n" +
    "  - {path: /gone/, reason: \"vendored, no tests\"}\n";
  const f = parseReviewFile(honestReasons(yaml, files));
  expect(f.uncovered).toEqual([{ path: "/svc/", reason: NOT_SET_UP }, { path: "/legacy/", reason: "no tests" },
    { path: "/gone/", reason: "vendored, no tests" }]);
  expect(honestReasons("version: 1\n", files)).toBe("version: 1\n");
});
