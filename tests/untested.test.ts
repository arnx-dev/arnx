import { expect, test } from "bun:test";
import { python } from "../src/adapters/python";
import { sliceDiff } from "../src/change";
import { changedSources, dbUntested, moduleName, untestedFiles } from "../src/untested";

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
  const owned = ["solana-parser/index.ts"];
  const at = (body: string) => ({ "solana-parser/__tests__/arnx/app.test.ts": body });
  for (const body of ["const { app } = require('../../index');", 'import { app } from "../../index.js";',
    "import { app } from '../../index.ts';", 'const m = require("../..");', 'import x from "../../";',
    "const m = await import('../../index.mjs');"]) {
    expect(untestedFiles(owned, at(body), typescript)).toEqual([]);
  }
  expect(untestedFiles(owned, { "solana-parser/app.test.ts": 'import { app } from "./";' }, typescript)).toEqual([]);
  expect(untestedFiles(owned, { "solana-parser/__tests__/app.test.ts": "require('../index')" }, typescript)).toEqual([]);
  // The directory's name still counts; a mention of `index` elsewhere, or a path that resolves elsewhere, does not.
  expect(untestedFiles(owned, at("// covers solana-parser"), typescript)).toEqual([]);
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
  const owned = ["solana-parser/index.ts"];
  const connects = "const db = process.env.DB;\n";
  expect(dbUntested(owned, read, { "solana-parser/__tests__/a.test.ts": connects + "require('../index')" },
    typescript, ["DB"])).toEqual([]);
  // The import must be in a test that connects: another test importing it does not count.
  expect(dbUntested(owned, read, { "solana-parser/__tests__/a.test.ts": connects,
    "solana-parser/__tests__/b.test.ts": "require('../index')" }, typescript, ["DB"])).toEqual(owned);
});
