// The map check: a project's `uses` against what its code refers to, from the projects' code indexes.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile } from "../src/config";
import type { projectIndex } from "../src/indexer";
import { DEFINITION, type Occurrence, type ScipIndex } from "../src/scip";
import { defaultSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

/** An index from `file: [symbols it defines], [symbols it refers to]`. */
function index(files: Record<string, [string[], string[]]>): ScipIndex {
  const ix: ScipIndex = { byFileLine: new Map(), bySymbol: new Map(), defined: new Set() };
  for (const [file, [defs, refs]] of Object.entries(files)) {
    const occs: Occurrence[] = [...defs.map((symbol, i) => ({ file, line: i + 1, start: 0, end: 1, symbol, roles: DEFINITION })),
      ...refs.map((symbol, i) => ({ file, line: 100 + i, start: 0, end: 1, symbol, roles: 0 }))];
    const lines = new Map<number, Occurrence[]>();
    for (const o of occs) {
      lines.set(o.line, [...(lines.get(o.line) ?? []), o]);
      ix.bySymbol.set(o.symbol, [...(ix.bySymbol.get(o.symbol) ?? []), o]);
      if (o.roles & DEFINITION) ix.defined.add(o.symbol);
    }
    ix.byFileLine.set(file, lines);
  }
  return ix;
}

test("a uses entry the code never reaches, an unanchored one, a missing one and a referenced uncovered path", async () => {
  const { fileReferences, usesHints } = await import("../src/usescheck");
  const run = "    image: node:22\n    language: typescript\n    runner: vitest\n    test_command: vitest run {targets}\n";
  const file = parseReviewFile(`version: 1
projects:
  app:
    root: packages/app
${run}    owns: [packages/app/]
    uses: [packages/shared/, packages/queue/]
  shared:
    root: packages/shared
${run}    owns: [/packages/shared/]
    uses: [app/]
  scripts:
    root: .
${run}    owns: [/scripts/]
    uses: [packages/]
uncovered:
  - path: packages/web/
    reason: tested on its own
`);
  const refs = fileReferences([index({
    "packages/app/src/app.ts": [["app/app."], ["shared/money.", "core/plan.", "web/job."]],
    "packages/shared/src/money.ts": [["shared/money.", "shared/cents."], ["shared/cents."]],
    "packages/queue/src/run.ts": [["queue/run."], ["shared/money."]],
    "packages/core/src/plan.ts": [["core/plan."], []],
    "packages/web/src/job.ts": [["web/job."], []],
    "scripts/report.ts": [["scripts/report."], []] })]);
  expect(refs.get("packages/app/src/app.ts")).toEqual(new Set(["packages/shared/src/money.ts",
    "packages/core/src/plan.ts", "packages/web/src/job.ts"]));
  expect(usesHints(file, refs).map((h) => [h.project, h.kind, h.text])).toEqual([
    ["app", "unreferenced", "app: its code never refers to the 1 source file uses packages/queue/ matches " +
      "(packages/queue/); drop it unless the project depends on them in a way code does not show (a file it reads, " +
      "a contract it mirrors)"],
    ["app", "missing", "app: its code refers to packages/core/src/plan.ts, which it neither owns nor uses, so a " +
      "change there is not reviewed with it; add packages/core/ to its uses"],
    ["app", "missing", "app: its code refers to packages/web/src/job.ts, which it neither owns nor uses, so a " +
      "change there is not reviewed with it; add packages/web/ to its uses"],
    ["shared", "unreferenced", "shared: its code never refers to the 1 source file uses app/ matches " +
      "(packages/app/); if you meant the top-level folder, anchor it (/app/)"],
    ["scripts", "unreferenced", "scripts: its code never refers to the 5 source files uses packages/ matches " +
      "(packages/app/, packages/shared/, packages/queue/, and 2 more); drop it unless the project depends on them " +
      "in a way code does not show (a file it reads, a contract it mirrors)"],
    ["app", "uncovered", "packages/web/ is listed under uncovered, but the code of app refers to it: add it to " +
      "their uses"]]);
  // A uses entry reached only through another used file is not flagged; nor is one whose files no index holds.
  const through = fileReferences([index({ "a/main.py": [["a/main."], ["lib/x."]], "lib/x.py": [["lib/x."], ["deep/y."]],
    "deep/y.py": [["deep/y."], []] })]);
  const two = parseReviewFile("version: 1\nprojects:\n  a:\n    root: a\n    image: python:3.12-slim\n" +
    "    test_command: python -m pytest {targets}\n    uses: [lib/, deep/, docs/]\n");
  expect(usesHints(two, through)).toEqual([]);
});

const YAML = `version: 1
projects:
  app:
    root: app
    image: python:3.12-slim
    install: [pip install pytest]
    test_command: python -m pytest -q {targets}
    uses: [lib/, extra/]
uncovered:
  - path: /app.py
    reason: a script run by hand
`;

test("with context = precise, setup sends what the code does not bear out back to the agent once", async () => {
  const repo = gitRepo(tmp());
  for (const [f, body] of [["app/main.py", "from lib import util\n"], ["app/tests/test_a.py", "def test_a(): pass\n"],
    ["lib/util.py", "def f(): pass\n"], ["extra/x.py", "def g(): pass\n"]]) {
    mkdirSync(join(repo, f!, ".."), { recursive: true });
    writeFileSync(join(repo, f!), body!);
  }
  commit(repo, "layout");
  const indexed: string[] = [];
  const indexer: typeof projectIndex = async (cfg, snap) => {
    indexed.push(`${cfg.name}@${snap === repo ? "repo" : "snapshot"}`);
    return { index: index({ "app/main.py": [["app/main."], ["lib/f()."]], "lib/util.py": [["lib/f()."], []],
      "extra/x.py": [["extra/g()."], []] }), secs: 1 };
  };
  const passing = (): [string | null, string, boolean] => [junitXml([["app/tests/test_a.py", "test_a", "passed", ""]]),
    "1 passed", false];
  const run = async (context: "names" | "precise") => {
    const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("propose", { yaml: YAML })],
      [tool("propose", { yaml: YAML })], [text("done")]]);
    const progress: string[] = [];
    const r = await runSetup(repo, { ...defaultSettings(), context }, model, { outDir: join(tmp(), "setup"),
      sessionFactory: fakeFactory(passing), indexer, progress: (m) => progress.push(m) });
    const replies = model.calls.slice(2).map((c) => JSON.stringify(c.messages.at(-1)!.content));
    return { r, replies, progress };
  };
  const precise = await run("precise");
  expect(precise.r.ok).toBe(true);
  expect(indexed).toEqual(["app@snapshot"]);
  expect(precise.replies[0]).toContain("refused once: the projects' code (from their code indexes)");
  expect(precise.replies[0]).toContain("app: its code never refers to the 1 source file uses extra/ matches (extra/)");
  expect(precise.replies[0]).not.toContain("uses lib/");
  expect(precise.replies[1]).toContain("accepted:");
  expect(precise.progress).toContain("the code does not bear out 1 map entry; asking the agent");
  indexed.length = 0;
  const names = await run("names");
  expect(indexed).toEqual([]);
  expect(names.replies[0]).toContain("accepted:");
});

test("without a code index, the map's paths: an unanchored uses entry that matches in several places, and one that " +
  "takes in other projects whole", async () => {
  const { mapHints } = await import("../src/usescheck");
  const run = "    image: node:22\n    language: typescript\n    runner: vitest\n    test_command: vitest run {targets}\n";
  const file = parseReviewFile(`version: 1
projects:
  api:
    root: api
${run}  web:
    root: services/web
${run}  jobs:
    root: services/jobs
${run}  shared:
    root: packages/shared
${run}    uses: [api/, /packages/api/, util.ts]
  scripts:
    root: scripts
${run}    uses: [services/, packages/shared/]
`);
  const files = ["api/src/a.ts", "packages/api/src/b.ts", "packages/shared/src/c.ts", "services/web/util.ts",
    "services/web/src/d.ts", "services/jobs/src/e.ts", "services/README.md", "scripts/run.ts", "scripts/util.ts"];
  expect(mapHints(file, files).map((h) => [h.project, h.kind, h.text])).toEqual([
    ["shared", "unanchored", "shared: uses api/ matches in 2 places (api/, packages/api/); anchor it to the one meant " +
      "(/api/, /packages/api/)"],
    ["scripts", "catch-all", "scripts: uses services/ takes in 2 other projects whole (web, jobs), so every change " +
      "in them is reviewed by scripts too (duplicate findings, double cost); narrow it to what scripts depends on"]]);
  // A file name or a glob matching several files is meant to: no hint.
  expect(mapHints(parseReviewFile(`version: 1
projects:
  api:
    root: api
${run}    uses: ["*.proto", tsconfig*.json, package.json, "lib*/"]
`), ["api/a.ts", "proto/x.proto", "proto/y.proto", "tsconfig.base.json", "web/tsconfig.json", "package.json",
    "web/package.json", "lib1/a.ts", "web/lib2/b.ts"])).toEqual([]);
  // One project used whole (a shared library), an anchored entry and an unanchored one with one place: no hint.
  expect(mapHints(parseReviewFile(`version: 1
projects:
  app:
    root: app
${run}    uses: [/packages/shared/, lib/]
  shared:
    root: packages/shared
${run}`), ["app/a.ts", "packages/shared/b.ts", "packages/lib/c.ts"])).toEqual([]);
});

test("setup sends the map's path hints back to the agent once, without a code index", async () => {
  const repo = gitRepo(tmp());
  for (const [f, body] of [["app/main.py", "import lib\n"], ["app/tests/test_a.py", "def test_a(): pass\n"],
    ["lib/util.py", "def f(): pass\n"], ["tools/lib/x.py", "def g(): pass\n"]]) {
    mkdirSync(join(repo, f!, ".."), { recursive: true });
    writeFileSync(join(repo, f!), body!);
  }
  commit(repo, "layout");
  const yaml = YAML.replace("uses: [lib/, extra/]", "uses: [lib/]").replace("uncovered:\n",
    "uncovered:\n  - path: /tools/\n    reason: scripts run by hand\n");
  const passing = (): [string | null, string, boolean] => [junitXml([["app/tests/test_a.py", "test_a", "passed", ""]]),
    "1 passed", false];
  const model = new ScriptedAgent([[tool("try_project", { yaml })], [tool("propose", { yaml })],
    [tool("propose", { yaml })], [text("done")]]);
  const progress: string[] = [];
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "setup"),
    sessionFactory: fakeFactory(passing), progress: (m) => progress.push(m) });
  const replies = model.calls.slice(2).map((c) => JSON.stringify(c.messages.at(-1)!.content));
  expect(r.ok).toBe(true);
  expect(replies[0]).toContain("refused once: these uses entries reach further than meant:");
  expect(replies[0]).toContain("app: uses lib/ matches in 2 places (lib/, tools/lib/); anchor it to the one meant " +
    "(/lib/, /tools/lib/)");
  expect(replies[0]).toContain("propose the same file again to keep it as it is");
  expect(replies[1]).toContain("accepted:");
  expect(progress).toContain("1 uses entry too wide; asking the agent");
});
