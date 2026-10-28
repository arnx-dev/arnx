// The coverage map arnx derives itself: .arnx/ never counts, source files outside every project go back to the agent
// once by folder and are then listed under uncovered with a reason arnx states, browser suites are listed as browser
// tests, a web UI app gets one try, and the end screen groups what no project tests by reason.
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { browserSuites, uiFramework } from "../src/browser";
import { parseReviewFile } from "../src/config";
import { ArnxError } from "../src/errors";
import type { SessionFactory } from "../src/sandbox";
import { coverageMap, runSetup, sourceGroups, withUncovered } from "../src/setup";
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

/** api's suite runs; web's environment does not build. */
const sessions: SessionFactory = async (cfg, snap, _log, body) => {
  if (cfg.name === "web") throw new ArnxError("npm ci failed: no lockfile");
  return body(new FakeSession(snap, () => [junitXml([["tests/test_app.py", "test_a", "passed", ""]]), "1 passed", false]));
};
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

test("a web UI app gets one try; propose asks once about the rest, then lists it under uncovered itself", async () => {
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: BOTH, project: "web" })],
    [tool("try_project", { yaml: BOTH, project: "web" })],
    [tool("try_project", { yaml: BOTH, project: "api" })],
    [tool("propose", { yaml: BOTH })],
    [tool("propose", { yaml: BOTH })],
    [text("api only.")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: sessions });
  expect(result(m, 1)).toContain("web is a web UI app (react-dom among its dependencies), which gets one try");
  expect(result(m, 2)).toContain("web is listed under uncovered as web UI: do not try it again");
  // Once, by folder: web/ is arnx's own entry by now, .arnx/ never counts.
  expect(result(m, 4)).toBe("refused:\nsource files outside every project, by folder (with the reason arnx lists " +
    "them under uncovered with):\n- /legacy/ (1 file): no tests\n- /tools/ (1 file): scripts\nPut those a project " +
    "tests under its owns or uses; propose again and arnx lists the rest under uncovered itself.");
  expect(result(m, 5)).toContain("accepted");
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
    "not tested (web UI): /web/ (4 files)",
    "not tested (no tests): /legacy/ (1 file)",
    "not tested (scripts): /tools/ (1 file)",
  ]);
});

test("a web UI app that is the only project ends setup after its one try", async () => {
  const only = `version: 1\nprojects:\n${WEB}`;
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: only })],
    [tool("propose", { yaml: only })],
    [text("unreachable")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: sessions });
  expect(r.ok).toBe(false);
  expect(r.problem).toContain("web: web UI app whose tests did not run on the first try, and no other project");
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

test("the files line counts the paths no project tests once there are more than three", () => {
  const f = { projects: [{ name: "api", owned: 3, used: 0 }], untrackedLeftOut: [] };
  expect(filesLine({ ...f, notTested: ["/a/", "/b/"] })).toBe("  Files: api owns 3, uses 0 · not tested: /a/, /b/");
  expect(filesLine({ ...f, notTested: ["/a/", "/b/", "/c/", "/d/"] })).toBe("  Files: api owns 3, uses 0 · not tested: 4 paths");
});
