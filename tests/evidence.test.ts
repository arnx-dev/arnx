// The evidence pack the second opinion gets per finding: who calls the changed definition, the project's own tests of
// it, its docs, the commit message, how the test ran before the change and what kind of test it is. Read from a tree
// (the round's snapshot, or a commit's git objects), never written to, and masked as everything that leaves arnx is.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeMessage } from "../src/change";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { EVIDENCE_LIMIT, gitTree, judgeEvidence, snapshotTree, type TreeReader } from "../src/evidence";
import { runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { AWS_KEY, PRIVATE_KEY_BLOCK } from "./helpers/fakekeys";
import { FakeJson, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
/** Built at runtime: no arnx file holds a secret-named literal. */
const TOKEN = "Zq7x" + "K2mP9vR4tY1w";
const WRITE_DIR = "tests/arnx_generated";
const GEN = `${WRITE_DIR}/test_x.py`;

function put(root: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
}

const CALC_OLD = 'def total(items):\n    """Sum of the prices; an empty list sums to 0."""\n' +
  "    return sum(i.price for i in items)\n\n\ndef helper(x):\n    return x\n";
const CALC_NEW = CALC_OLD.replace("for i in items)", "for i in items if i.price > 0)").replace("return x\n", "return x + 1\n");
const PROJECT = {
  "app/calc.py": CALC_OLD,
  // Line 1 imports, line 2 is a comment: neither calls it. Line 5 does, in main.
  "app/cli.py": "from app.calc import total\n# total is printed below\ndef main():\n    items = load()\n" +
    "    print(total(items))\n",
  "app/__main__.py": "from app.cli import main\n\nmain()\n",
  "tests/test_calc.py": "from app.calc import total\n\n\ndef test_empty():\n    assert total([]) == 0\n",
  "docs/usage.md": "# Usage\n\nCall `total(items)` for the sum.\n",
};
const GEN_TOTAL = "from app.calc import total\n\n\ndef test_negative():\n    assert total([Item(-1)]) == -1\n";

/** A repository with PROJECT committed, then calc.py changed: the diff of the change. */
function changed(root: string, extra: Record<string, string> = {}): { repo: string; diff: string } {
  const repo = initRepo(root);
  put(repo, { ...PROJECT, ...extra });
  commit(repo, "first");
  writeFileSync(join(repo, "app/calc.py"), CALC_NEW);
  return { repo, diff: runGit(repo, "diff") };
}

test("evidence names callers, project tests and docs of the changed definition", () => {
  const { repo, diff } = changed(join(tmp(), "repo"));
  // The generated test sits in the tree too, as in a round's snapshot: it is no project test.
  put(repo, { [GEN]: GEN_TOTAL });
  const pack = judgeEvidence({ tree: snapshotTree(repo), diff, testSource: GEN_TOTAL, testFile: GEN,
    func: "test_negative", commitMessage: "Skip items with no price", writeDir: WRITE_DIR });
  expect(pack).toContain("Skip items with no price");
  expect(pack).toContain("`total`");
  expect(pack).toContain("app/calc.py:1");
  expect(pack).toContain("app/cli.py:5");
  expect(pack).toContain("print(total(items))");
  expect(pack).toContain("in `main`");
  // Two levels out: where the caller is used.
  expect(pack).toContain("app/__main__.py:3");
  expect(pack).toContain("tests/test_calc.py:5");
  expect(pack).toContain("assert total([]) == 0");
  expect(pack).toContain("docs/usage.md:3");
  // The definition's own docstring.
  expect(pack).toContain("Sum of the prices; an empty list sums to 0.");
  // An import, a comment and the generated tests are not callers or project tests.
  expect(pack).not.toContain("app/cli.py:1 ");
  expect(pack).not.toContain("app/cli.py:2 ");
  expect(pack).not.toContain(WRITE_DIR);
  // The test does not use helper: it is no target.
  expect(pack).not.toContain("`helper`");
});

test("evidence says when no caller exists", () => {
  const { repo, diff } = changed(join(tmp(), "repo"));
  const source = "from app.calc import helper\n\n\ndef test_helper():\n    assert helper(1) == 1\n";
  const pack = judgeEvidence({ tree: snapshotTree(repo), diff, testSource: source, testFile: GEN, func: "test_helper",
    commitMessage: "", writeDir: WRITE_DIR });
  expect(pack).toContain("`helper`");
  expect(pack).toMatch(/`helper`[^\n]*\n?[^\n]*no caller found/);
  expect(pack).toMatch(/`helper`[^\n]*\n?[^\n]*no project test found/);
  expect(pack).not.toContain("app/cli.py");
});

test("evidence finds a class the change edits outside a method, and a name it newly exports", () => {
  const repo = initRepo(join(tmp(), "repo"));
  put(repo, { "pkg/grammar.py": "class SelectSegment(Base):\n    match = Seq('SELECT')\n",
    "pkg/dialect.py": "from pkg.grammar import SelectSegment\n\nSEGMENTS = [\n    SelectSegment,\n]\n",
    "lib/index.ts": "export { parse } from './parse.js';\n",
    "lib/defaults.ts": "export const LIMITS = { depth: 3 };\n",
    "lib/env.ts": "import { LIMITS } from './defaults.js';\nexport function depth() {\n  return LIMITS.depth;\n}\n" });
  commit(repo, "first");
  writeFileSync(join(repo, "pkg/grammar.py"), "class SelectSegment(Base):\n    match = Seq('SELECT', 'TOP')\n");
  writeFileSync(join(repo, "lib/index.ts"), "export { parse } from './parse.js';\nexport { LIMITS } from './defaults.js';\n");
  const diff = runGit(repo, "diff");
  const py = "from pkg.grammar import SelectSegment\n\n\ndef test_top():\n    assert SelectSegment.match\n";
  const one = judgeEvidence({ tree: snapshotTree(repo), diff, testSource: py, testFile: GEN, func: "test_top",
    commitMessage: "", writeDir: WRITE_DIR });
  expect(one).toContain("`SelectSegment` (class, pkg/grammar.py:1)");
  expect(one).toContain("pkg/dialect.py:4");
  expect(one).not.toContain("pkg/grammar.py:1 in");
  const ts = "import { LIMITS } from '../lib/index.js';\nit('is frozen', () => {\n  expect(Object.isFrozen(LIMITS)).toBe(true);\n});\n";
  const two = judgeEvidence({ tree: snapshotTree(repo), diff, testSource: ts, testFile: "tests/arnx_generated/x.test.ts",
    func: "is frozen", commitMessage: "", writeDir: WRITE_DIR });
  expect(two).toContain("`LIMITS` (name, lib/index.ts:2)");
  expect(two).toContain("lib/env.ts:3");
  expect(two).not.toContain("`from`");
});

test("a caller is named by the function that holds it, not by a nested one that ended above it", () => {
  const { repo, diff } = changed(join(tmp(), "repo"), {
    "app/server.py": "def make_app():\n    def on_clear():\n        return 1\n\n    query = '''\nSELECT 1\n'''\n" +
      "    return total(query)\n\n\nmake_app()\n",
  });
  const pack = judgeEvidence({ tree: snapshotTree(repo), diff, testSource: GEN_TOTAL, testFile: GEN, func: "test_negative",
    commitMessage: "", writeDir: WRITE_DIR });
  expect(pack).toContain("app/server.py:8 in `make_app`");
  expect(pack).toContain("`make_app` is used at app/server.py:11");
});

test("evidence gives how the test ran before the change and what kind of test it is", () => {
  const { repo, diff } = changed(join(tmp(), "repo"));
  const source = "from app import calc\n\n\ndef test_negative(monkeypatch):\n    monkeypatch.setattr(calc, 'load', list)\n" +
    "    assert calc._round(calc.total([])) == 0  # type: ignore\n";
  const pack = judgeEvidence({ tree: snapshotTree(repo), diff, testSource: source, testFile: GEN, func: "test_negative",
    commitMessage: "", writeDir: WRITE_DIR,
    before: { status: "regression", detail: "", runs: ["passed", "passed"], message: "first line\nsecond line" },
    shallow: "source-text" });
  expect(pack).toContain("regression");
  expect(pack).toContain("passed, passed");
  expect(pack).toContain("first line");
  expect(pack).not.toContain("second line");
  expect(pack).toContain("`_round`");
  expect(pack).toContain("monkeypatch");
  expect(pack).toContain("setattr");
  expect(pack).toContain("# type: ignore");
  expect(pack).toContain("reads the code as text");
});

test("evidence read from git objects holds no key and no secret-named value, and leaves the repository as it was", () => {
  const { repo, diff: _ } = changed(join(tmp(), "repo"), {
    "app/cli.py": `from app.calc import total\ndef main():\n    api_token = "${TOKEN}"\n    print(total(load(api_token)))\n` +
      `    key = "${AWS_KEY}"\n`,
    "README.md": `Use \`total(items)\`.\n\n${PRIVATE_KEY_BLOCK}\n`,
  });
  commit(repo, "Skip items with no price");
  const head = runGit(repo, "rev-parse", "HEAD").trim();
  const diff = runGit(repo, "show", "--format=", head);
  const status = runGit(repo, "status", "--porcelain");
  const tree = gitTree(repo, head);
  const readme = tree.read("README.md")!;
  expect(readme).toContain("[private key]");
  expect(readme).not.toContain(PRIVATE_KEY_BLOCK.split("\n")[1]!);
  const cli = tree.read("app/cli.py")!;
  expect(cli).toContain("print(total(load(api_token)))");
  for (const v of [TOKEN, AWS_KEY]) expect(cli).not.toContain(v);
  const pack = judgeEvidence({ tree, diff, testSource: GEN_TOTAL, testFile: GEN, func: "test_negative",
    commitMessage: changeMessage(repo, { kind: "commit", base: `${head}~1`, head }), writeDir: WRITE_DIR });
  expect(pack).toContain("Skip items with no price");
  expect(pack).toContain("app/cli.py:4");
  expect(pack).toContain("api_token");
  for (const v of [TOKEN, AWS_KEY, PRIVATE_KEY_BLOCK.split("\n")[1]!]) expect(pack).not.toContain(v);
  expect(runGit(repo, "status", "--porcelain")).toBe(status);
  expect(runGit(repo, "rev-parse", "HEAD").trim()).toBe(head);
});

test("the change's message is its commits' messages, and uncommitted work has none", () => {
  const repo = initRepo(join(tmp(), "repo"));
  put(repo, { "a.py": "A = 1\n" });
  commit(repo, "first");
  const base = runGit(repo, "rev-parse", "HEAD").trim();
  put(repo, { "a.py": "A = 2\n" });
  commit(repo, "Raise A\n\nThe limit was too low.");
  put(repo, { "a.py": "A = 3\n" });
  commit(repo, "Raise A again");
  const head = runGit(repo, "rev-parse", "HEAD").trim();
  const range = changeMessage(repo, { kind: "range", base, head });
  expect(range).toContain("Raise A again");
  expect(range).toContain("The limit was too low.");
  expect(range).not.toContain("first");
  expect(changeMessage(repo, { kind: "worktree", base: head, head: null })).toBe("");
});

test("evidence stays within its limit", () => {
  const { repo, diff } = changed(join(tmp(), "repo"));
  const many: Record<string, string> = {};
  for (let i = 0; i < 60; i++) {
    many[`app/use${i}.py`] = `from app.calc import total\ndef use${i}():\n    return total(${"x".repeat(150)})\n`;
    many[`tests/test_use${i}.py`] = `def test_${i}():\n    assert total([${"1, ".repeat(60)}]) == 60\n`;
    many[`docs/page${i}.md`] = `See \`total(items)\` ${"word ".repeat(40)}\n`;
  }
  put(repo, many);
  const o = { tree: snapshotTree(repo), diff, testSource: GEN_TOTAL, testFile: GEN, func: "test_negative",
    commitMessage: "m".repeat(5000), writeDir: WRITE_DIR };
  const pack = judgeEvidence(o);
  expect(pack.length).toBeLessThanOrEqual(EVIDENCE_LIMIT);
  expect(pack).toContain("app/use0.py:3");
  expect(pack).not.toContain("m".repeat(1600));
  expect(judgeEvidence({ ...o, limit: 2000 }).length).toBeLessThanOrEqual(2000);
});

test("evidence on a large tree stops searching at its bound and says so", () => {
  const { repo, diff } = changed(join(tmp(), "repo"));
  const real = snapshotTree(repo);
  const huge: TreeReader = {
    files: () => [...real.files(), ...Array.from({ length: 30_000 }, (_, i) => `pkg/m${i}.py`)],
    read: (p) => real.read(p) ?? (p.startsWith("pkg/") ? `def f():\n    return total(${p.length})\n` : null),
  };
  const o = { tree: huge, diff, testSource: GEN_TOTAL, testFile: GEN, func: "test_negative", commitMessage: "",
    writeDir: WRITE_DIR };
  const t0 = performance.now();
  const pack = judgeEvidence({ ...o, scan: { files: 2000 } });
  expect(pack).toContain("stopped");
  expect(pack).toContain("app/cli.py:5"); // the change's neighbours are searched first
  expect(judgeEvidence({ ...o, scan: { ms: 0 } })).toContain("stopped");
  expect(performance.now() - t0).toBeLessThan(10_000);
});

test("a snapshot tree does not follow a link out of it", () => {
  const outside = join(tmp(), "outside.py");
  writeFileSync(outside, "def g():\n    return total([])\n");
  const { repo } = changed(join(tmp(), "repo"));
  symlinkSync(outside, join(repo, "app/linked.py"));
  mkdirSync(join(tmp(), "dir"));
  writeFileSync(join(tmp(), "dir/x.py"), "total()\n");
  symlinkSync(join(tmp(), "dir"), join(repo, "app/linkdir"));
  const tree = snapshotTree(repo);
  expect(tree.files()).not.toContain("app/linked.py");
  expect(tree.files().some((p) => p.startsWith("app/linkdir"))).toBe(false);
  expect(tree.read("app/linked.py")).toBeNull();
  expect(tree.read("app/linkdir/x.py")).toBeNull();
  expect(tree.read("../outside.py")).toBeNull();
});

test("a review saves each second opinion's input with its evidence, masked, in second-opinion-input.jsonl", async () => {
  const repo = initRepo(join(tmp(), "repo"));
  put(repo, { "app.py": "def add(a, b):\n    return a + b\n",
    "cli.py": `from app import add\ndef main():\n    api_token = "${TOKEN}"\n    return add(api_token, 1)\n` +
      `    key = "${AWS_KEY}"\n` });
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig("version: 1\nimage: python:3.12-slim\n" +
    "test_command: python -m pytest -q {targets}\n"), "Dev", "2026-10-11"));
  commit(repo, "first");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const gen = "tests/arnx_generated/test_add.py";
  const agent = new ScriptedAgent([
    [tool("write_file", { path: gen, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" })],
    [text(JSON.stringify({ tests: [{ test: `${gen}::test_add`, expects: "add sums" }],
      suspected_defects: [{ test: `${gen}::test_add`, explanation: "add subtracts." }], questions: [] }))],
  ]);
  const runs = (): [string | null, string, boolean] => [junitXml([[gen, "test_add", "failed", "assert -1 == 5"]]), "", false];
  const judge = new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }, { groups: [] }]);
  const settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-11T00:00:00Z" };
  const { review, rdir } = await runReview(repo, { settings, agentModel: agent, challenger: judge,
    sessionFactory: fakeFactory(runs) });
  expect(review.findings).toHaveLength(1);
  const path = join(rdir, "second-opinion-input.jsonl");
  expect(existsSync(path)).toBe(true);
  const saved = readFileSync(path, "utf8");
  const lines = saved.trim().split("\n").map((l) => JSON.parse(l) as Record<string, string | undefined>);
  expect(lines).toHaveLength(1);
  const [line] = lines;
  expect(line!.finding).toBe("F1");
  expect(line!.test_id).toBe(review.findings[0]!.testId);
  expect(line!.user).toBe(judge.calls[0]);
  expect(line!.system!.length).toBeGreaterThan(0);
  expect(line!.evidence).toContain("cli.py:4");
  expect(line!.evidence).toContain("add(api_token, 1)");
  const round = readFileSync(join(rdir, "round.json"), "utf8");
  expect(JSON.parse(round).round.evidence[review.findings[0]!.testId]).toBe(line!.evidence);
  for (const v of [TOKEN, AWS_KEY]) {
    expect(saved).not.toContain(v);
    expect(round).not.toContain(v);
  }
});
