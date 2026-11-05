import { expect, test } from "bun:test";
import { python } from "../src/adapters/python";
import { sliceDiff } from "../src/change";
import { changedSources, codeOf, dbUntested, framesIn, moduleName, notReached, untestedFiles } from "../src/untested";

test("a test refers to a file by its module name; index and __init__ files by their directory", () => {
  expect(moduleName("services/billing/snapshot.py")).toBe("snapshot");
  expect(moduleName("pkg/api/__init__.py")).toBe("api");
  expect(moduleName("src/routes/index.ts")).toBe("routes");
  const owned = ["a/snapshot.py", "a/queries.py", "a/main.py", "a/tests/test_x.py", "a/conftest.py", "a/schema.sql"];
  expect(changedSources(owned, python)).toEqual(["a/snapshot.py", "a/queries.py", "a/main.py"]);
  const tests = { "t.py": "import snapshot\nfrom queries_extra import x\nif __name__ == '__main__': pass\n" };
  expect(untestedFiles(owned, tests, python)).toEqual(["a/queries.py", "a/main.py"]);
});

test("a diff is sliced to the files asked for, new and deleted files included", () => {
  const part = (a: string, b: string, minus: string, plus: string) =>
    `diff --git a/${a} b/${b}\nindex 1..2 100644\n--- ${minus}\n+++ ${plus}\n@@ -1 +1 @@\n-x\n+y\n`;
  const diff = part("one.py", "one.py", "a/one.py", "b/one.py") + part("two.py", "two.py", "/dev/null", "b/two.py") +
    part("old.py", "old.py", "a/old.py", "/dev/null");
  expect(sliceDiff(diff, ["two.py", "old.py"])).toBe(diff.slice(diff.indexOf("diff --git a/two.py")));
  expect(sliceDiff(diff, ["one.py"])).toBe(diff.slice(0, diff.indexOf("diff --git a/two.py")));
  expect(sliceDiff(diff, ["none.py"])).toBe("");
});

test("a Rust crate root counts as tested by any generated test", async () => {
  const { rust } = await import("../src/adapters/rust");
  expect(untestedFiles(["src/lib.rs", "src/parse.rs"], { "tests/a.rs": "use calc::add;" }, rust)).toEqual(["src/parse.rs"]);
  expect(untestedFiles(["src/lib.rs"], {}, rust)).toEqual(["src/lib.rs"]);
});

test("an index file counts as referred to when a test imports a relative path that resolves to it", async () => {
  const { typescript } = await import("../src/adapters/typescript");
  const owned = ["parser/index.ts"];
  const at = (body: string) => ({ "parser/__tests__/arnx/app.test.ts": body });
  for (const body of ["const { app } = require('../../index');", 'import { app } from "../../index.js";',
    "import { app } from '../../index.ts';", 'const m = require("../..");', 'import x from "../../";',
    "const m = await import('../../index.mjs');"]) {
    expect(untestedFiles(owned, at(body), typescript)).toEqual([]);
  }
  expect(untestedFiles(owned, { "parser/app.test.ts": 'import { app } from "./";' }, typescript)).toEqual([]);
  expect(untestedFiles(owned, { "parser/__tests__/app.test.ts": "require('../index')" }, typescript)).toEqual([]);
  // The directory's name still counts; a mention of `index` elsewhere, or a path that resolves elsewhere, does not.
  for (const body of ["const { app } = require('../index');", "import x from '../../other/index.js';",
    "expect(list.indexOf(1)).toBe(0); // index", "const index = require('./index');", "fetch('../../index.html')"]) {
    expect(untestedFiles(owned, at(body), typescript)).toEqual(owned);
  }
  // A root index file is not referred to by any dotted name.
  expect(untestedFiles(["index.ts"], { "tests/a.test.ts": "a.b(); import x from './x';" }, typescript))
    .toEqual(["index.ts"]);
  expect(untestedFiles(["index.ts"], { "tests/a.test.ts": "import x from '../index';" }, typescript)).toEqual([]);
});

test("a package __init__ counts when a test imports it relatively; a Rust mod.rs when a #[path] points at it", async () => {
  const { rust } = await import("../src/adapters/rust");
  const owned = ["svc/billing/__init__.py"];
  expect(untestedFiles(owned, { "svc/billing/tests/test_a.py": "from .. import charge\n" }, python)).toEqual([]);
  expect(untestedFiles(owned, { "svc/tests/test_a.py": "from ..billing import charge\n" }, python)).toEqual([]);
  expect(untestedFiles(owned, { "svc/tests/test_a.py": "from .. import charge\n" }, python)).toEqual(owned);
  expect(untestedFiles(["src/parse/mod.rs"], { "tests/a.rs": '#[path = "../src/parse/mod.rs"]\nmod p;' }, rust))
    .toEqual([]);
  expect(untestedFiles(["src/parse/mod.rs"], { "tests/a.rs": "use calc::lex::x;" }, rust)).toEqual(["src/parse/mod.rs"]);
});

test("an index file holding SQL counts for the database check when a connecting test imports it relatively", async () => {
  const { typescript } = await import("../src/adapters/typescript");
  const read = () => "const Q = `SELECT a FROM t`;\n";
  const owned = ["parser/index.ts"];
  const connects = "const db = process.env.DB;\n";
  expect(dbUntested(owned, read, { "parser/__tests__/a.test.ts": connects + "require('../index')" },
    typescript, ["DB"])).toEqual([]);
  // The import must be in a test that connects: another test importing it does not count.
  expect(dbUntested(owned, read, { "parser/__tests__/a.test.ts": connects,
    "parser/__tests__/b.test.ts": "require('../index')" }, typescript, ["DB"])).toEqual(owned);
});

test("a file named only in a read path or comment is not reached", async () => {
  const { typescript } = await import("../src/adapters/typescript");
  const owned = ["parser/index.ts", "src/lexer.ts"];
  const at = (body: string) => ({ "parser/__tests__/arnx/app.test.ts": body });
  const none = { frames: [] as string[] };
  for (const body of ["// covers parser and lexer", "const t = readFileSync('src/lexer.ts', 'utf8');",
    "/* lexer */ expect(1).toBe(1);", "it('parser and lexer', () => {});"]) {
    expect(notReached(owned, { tests: at(body), ...none }, typescript)).toEqual(owned);
  }
  // A load by path or module name, and a name used as code, still reach.
  expect(notReached(owned, { tests: at("import { lex } from '../../src/lexer';\nlex();\nparser.run();"), ...none }, typescript))
    .toEqual([]);
  expect(notReached(["pkg/mod.py"], { tests: { "t/test_a.py": "# mod\nx = 'mod'\nimport_module('pkg.mod')\n" }, ...none },
    python)).toEqual([]);
  expect(notReached(["pkg/mod.py"], { tests: { "t/test_a.py": "# mod\nx = open('mod.py').read()\n" }, ...none }, python))
    .toEqual(["pkg/mod.py"]);
  // The old match still counts those names, for the mid-round follow-up.
  expect(untestedFiles(owned, at("// covers parser and lexer"), typescript)).toEqual([]);
  expect(codeOf("a = 1  # mock('x')\nmock('./y')\n", "t.py")).toMatch(/^a = 1\s*\nmock\('\.\/y'\)\n$/);
});

test("a changed *_test.py is not a source file", () => {
  expect(changedSources(["a/billing.py", "a/billing_test.py", "tests/helper.py", "a/tests/util.py", "a/x.test.ts"], python))
    .toEqual(["a/billing.py"]);
});

test("a stack frame, from a message, names a file", () => {
  expect(framesIn("FAIL  src/a.test.ts > x\n at Object.<anonymous> (/src/lib/a.ts:12:5)\n ❯ src/b.ts:3:1")
    .sort()).toEqual(["/src/lib/a.ts", "src/b.ts"].sort());
  expect(framesIn("at run (file:///src/lib/jest.js:4:2)\n    at node_modules/x/index.js:9:1")).toEqual(["/src/lib/jest.js"]);
  expect(framesIn("pkg/mod.py:41: in run\n/src/pkg/other.py:7: AssertionError")).toEqual(["pkg/mod.py", "/src/pkg/other.py"]);
  expect(framesIn("no frame here, took 3:20 and [private key]:1")).toEqual([]);
  expect(notReached(["pkg/mod.py", "pkg/other.py", "pkg/z.py"], { tests: {}, frames: ["pkg/mod.py", "/src/pkg/other.py"] },
    python)).toEqual(["pkg/z.py"]);
});

test("a bare name in a string of a loaded test counts as reaching the file", () => {
  const none = { frames: [] as string[] };
  const list = { "t/test_p.py": 'NAMES = ["autobpm", "metasync", "info/x"]\nfor n in NAMES: load(f"plug.{n}")\n' };
  const owned = ["plug/autobpm.py", "plug/metasync/__init__.py", "plug/other.py", "plug/info.py", "plug/x.py"];
  expect(notReached(owned, { tests: list, ...none }, python)).toEqual(["plug/other.py", "plug/info.py", "plug/x.py"]);
  expect(notReached(["a/b/c.py"], { tests: { "t/test_p.py": "m = 'b.c'" }, ...none }, python)).toEqual([]);
  // A path, a name with an extension or a sentence is not a module name.
  expect(notReached(["a/c.py"], { tests: { "t/test_p.py": "m = 'a/c'; n = 'c.py'; o = 'c is slow'" }, ...none }, python))
    .toEqual(["a/c.py"]);
});

test("a loader call keeps its path string", () => {
  const body = 'spec = importlib.util.spec_from_file_location("t", "docs_src/tut.py")\nspec.loader.exec_module(m)\n';
  expect(notReached(["docs_src/tut.py"], { tests: { "t/test_d.py": body }, frames: [] }, python)).toEqual([]);
  // The path may be held in a variable first.
  const apart = 'p = Path("docs_src/tut.py")\nspec = importlib.util.spec_from_file_location("t", p)\nspec.loader.exec_module(m)\n';
  expect(notReached(["docs_src/tut.py"], { tests: { "t/test_d.py": apart }, frames: [] }, python)).toEqual([]);
  expect(notReached(["docs_src/tut.py"], { tests: { "t/test_d.py": 'p = Path("docs_src/tut.py").read_text()' },
    frames: [] }, python)).toEqual(["docs_src/tut.py"]);
  expect(notReached(["docs_src/tut.py"], { tests: { "t/test_d.py": 'runpy.run_path("docs_src/tut.py")' }, frames: [] },
    python)).toEqual([]);
});

test("a frame that fits more than one changed file hides none", () => {
  const owned = ["a/utils.py", "b/utils.py", "c/main.py"];
  expect(notReached(owned, { tests: {}, frames: ["utils.py", "main.py"] }, python)).toEqual(["a/utils.py", "b/utils.py"]);
  expect(notReached(owned, { tests: {}, frames: ["b/utils.py"] }, python)).toEqual(["a/utils.py", "c/main.py"]);
});
