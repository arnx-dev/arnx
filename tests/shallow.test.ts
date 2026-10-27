// Tests that check the code's text, or only that something exists, are named as such: a change can pass them without
// fixing the behaviour.
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { projectSource, shallowKind } from "../src/shallow";
import { COPY_SUFFIX, readCopies, suffixReviewCopies } from "../src/testround";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

const JS = `const fs = jest.requireActual('fs');
describe('app wiring', () => {
  it('API key comparison is constant-time', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../app.js'), 'utf8');
    expect(src).toMatch(/timingSafeEqual/);
  });

  it('rejects a wrong key', async () => {
    expect((await request(app).get('/balance').set('x-api-key', 'wrong')).status).toBe(401);
  });
  it('splitProfile defines update and cancel', () => {
    expect(typeof api.splitProfile.update).toBe('function');
    expect(typeof api.splitProfile.cancel).toBe('function');
  });
  it('reads a fixture', () => {
    const data = JSON.parse(fs.readFileSync('fixtures/a.json', 'utf8'));
    expect(parse(data).ok).toBe(true);
  });
});
`;

test("a test that matches a source file's text, or only checks that something exists, is shallow", () => {
  expect(shallowKind(JS, "app wiring > API key comparison is constant-time")).toBe("source-text");
  expect(shallowKind(JS, "app wiring > splitProfile defines update and cancel")).toBe("existence");
  expect(shallowKind(JS, "app wiring > rejects a wrong key")).toBeNull();
  expect(shallowKind(JS, "app wiring > reads a fixture")).toBeNull(); // a data file, and behaviour checked
  expect(shallowKind(JS, "app wiring > not there")).toBeNull();
  expect(shallowKind(undefined, "x")).toBeNull();
  const py = "import inspect\n\ndef test_uses_compare_digest():\n    assert 'compare_digest' in inspect.getsource(auth)\n\n" +
    "def test_has_cancel():\n    assert hasattr(api, 'cancel')\n    assert callable(api.cancel)\n\n" +
    "def test_cancel_works():\n    assert api.cancel(1) is None\n";
  expect(shallowKind(py, "test_uses_compare_digest")).toBe("source-text");
  expect(shallowKind(py, "tests/test_a.py::test_has_cancel")).toBe("existence");
  expect(shallowKind(py, "test_cancel_works")).toBeNull();
});

// A real review counted three "fixes" and one regression from tests that read index.js as text and matched it: a
// read at the top of the file, a node:test assert.match. Fixtures and data files read as input are not that.
const NODE_TEST = `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../index.js', import.meta.url), 'utf8');

test('compares keys in constant time', () => {
  assert.match(source, /timingSafeEqual\\(/);
});

test('minifies its fixture', () => {
  const input = readFileSync(new URL('./fixtures/payload.js', import.meta.url), 'utf8');
  assert.ok(minify(input).includes('x'));
});

test('rejects a wrong key', async () => {
  assert.equal((await fetchBalance('wrong')).status, 401);
});
`;
const TS = `import { readFileSync } from "fs";
import { join } from "node:path";

describe("auth", () => {
  const code = readFileSync(join(__dirname, "..", "..", "src", "auth.ts"), "utf8");
  it("uses a constant-time compare", () => {
    expect(code).toContain("timingSafeEqual");
  });
  it("rejects a wrong key", async () => {
    expect(await check("wrong")).toBe(false);
  });
  it("matches its snapshot text", () => {
    const want = readFileSync(join(__dirname, "__snapshots__", "auth.ts"), "utf8");
    expect(render("x")).toContain(want);
  });
});
`;
const PY = `from pathlib import Path

SOURCE = (Path(__file__).parents[2] / "app" / "auth.py").read_text()


def test_uses_compare_digest():
    assert "compare_digest" in SOURCE


def test_reads_sample():
    sample = open("tests/fixtures/sample.py").read()
    assert "def" in tokenize(sample)


class TestAuth:
    def test_wrong_key(self):
        source = render("x")
        assert "denied" in source

    def test_regex(self):
        with open("app/auth.py") as f:
            text = f.read()
        self.assertRegex(text, r"compare_digest")
`;

test("a read at the top of the file, in node:test, TypeScript and Python, is found; fixtures are not", () => {
  expect(shallowKind(NODE_TEST, "compares keys in constant time")).toBe("source-text");
  expect(shallowKind(NODE_TEST, "minifies its fixture")).toBeNull();
  expect(shallowKind(NODE_TEST, "rejects a wrong key")).toBeNull();
  expect(shallowKind(TS, "auth > uses a constant-time compare")).toBe("source-text");
  expect(shallowKind(TS, "auth > rejects a wrong key")).toBeNull();
  expect(shallowKind(TS, "auth > matches its snapshot text")).toBeNull(); // a snapshot file, read as data
  expect(shallowKind(PY, "tests/arnx/test_auth.py::test_uses_compare_digest")).toBe("source-text");
  expect(shallowKind(PY, "tests/arnx/test_auth.py::test_reads_sample")).toBeNull();
  expect(shallowKind(PY, "tests/arnx/test_auth.py::TestAuth::test_wrong_key")).toBeNull(); // not the module's read
  expect(shallowKind(PY, "tests/arnx/test_auth.py::TestAuth::test_regex")).toBe("source-text");
});

test("with the project's files at hand, only a read of one of its source files counts", () => {
  const root = tmp();
  for (const f of ["index.js", "src/auth.ts", "app/auth.py", "tests/arnx/fixtures/payload.js", "tests/test_app.py"]) {
    mkdirSync(join(root, f, ".."), { recursive: true });
    writeFileSync(join(root, f), "x\n");
  }
  const isTest = (name: string) => /^test_.*\.py$|\.test\.[jt]s$/.test(name);
  const src = projectSource(root, ".", isTest);
  const file = "tests/arnx/app.test.js";
  expect(src(file, "../../index.js")).toBe(true); // from the test's folder
  expect(src(file, "src/auth.ts")).toBe(true); // from the project's
  expect(src(file, "/src/app/auth.py")).toBe(true); // the sandbox's path
  expect(src("tests/arnx/test_auth.py", "auth.py")).toBe(false); // a bare name somewhere in the tree is not enough
  expect(src("tests/arnx/test_auth.py", "../../src/auth.ts")).toBe(true); // a path built from parts, joined
  expect(src(file, "./fixtures/payload.js")).toBe(false); // a fixture
  expect(src(file, "tests/test_app.py")).toBe(false); // a test file
  expect(src(file, "../../missing.js")).toBe(false); // not the project's
  expect(shallowKind(NODE_TEST, "compares keys in constant time", (p) => src(file, p))).toBe("source-text");
  expect(shallowKind(NODE_TEST.replace("../../index.js", "../../gone.js"), "compares keys in constant time",
    (p) => src(file, p))).toBeNull();
});

// An independent review found tests reported as reading the code as text that do not: the value checked was not the
// text read, the "read" was a process started, the text read was run, or the file was a test fixture.
test("only a check of the text read from a source file counts, and not when that text is run", () => {
  const popen = "import subprocess\n\ndef test_cli_usage():\n    p = subprocess.Popen([\"python\", \"cli.py\", " +
    "\"--help\"], stdout=subprocess.PIPE, text=True)\n    out, _ = p.communicate()\n    assert \"usage\" in out\n";
  expect(shallowKind(popen, "test_cli_usage", () => true)).toBeNull();
  const jsdom = `const fs = require("node:fs");
const script = fs.readFileSync("src/widget.js", "utf8");
test("renders greeting", () => {
  const dom = new JSDOM("<div id=a></div>", { runScripts: "outside-only" });
  dom.window.eval(script);
  expect(dom.window.document.body.innerHTML).toContain("Hello");
});
`;
  expect(shallowKind(jsdom, "renders greeting", () => true)).toBeNull();
  const fixture = `const input = readFileSync(join(__dirname, "__testfixtures__/basic.input.js"), "utf8");
test("transforms", () => {
  expect(transform(input)).toContain("const x");
});
`;
  expect(shallowKind(fixture, "transforms", () => true)).toBeNull();
  for (const dir of ["cases", "inputs"]) {
    const read = `test("reads", () => {\n  const src = readFileSync("${dir}/a.js", "utf8");\n  ` +
      "expect(src).toContain('x');\n});\n";
    expect(shallowKind(read, "reads", () => true)).toBeNull();
  }
  // The text read is passed on, not checked; or it is run before a check of it.
  const used = `const src = readFileSync("src/app.js", "utf8");
test("renders", () => {
  expect(render(src)).toContain("Hello");
  expect(src.length).toBeGreaterThan(0);
});
test("runs", () => {
  const out = vm.runInNewContext(src, {});
  expect(src).toContain("module");
});
test("checks", () => {
  expect(src.replace(/\\s+/g, " ")).toMatch(/timingSafeEqual/);
});
test("checks the read itself", () => {
  expect(readFileSync(join(root, "src", "app.js"), "utf8").includes("timingSafeEqual")).toBe(true);
});
`;
  expect(shallowKind(used, "renders", () => true)).toBeNull();
  expect(shallowKind(used, "runs", () => true)).toBeNull();
  expect(shallowKind(used, "checks", () => true)).toBe("source-text");
  expect(shallowKind(used, "checks the read itself", () => true)).toBe("source-text");
  const py = "import importlib\nSRC = open('app/auth.py').read()\n\ndef test_loads():\n" +
    "    mod = importlib.import_module('app.auth')\n    exec(compile(SRC, 'auth', 'exec'))\n    assert 'x' in SRC\n\n" +
    "def test_in():\n    assert 'compare_digest' not in SRC, 'uses ==' \n\ndef test_re():\n" +
    "    assert re.search(r'compare_digest', SRC)\n\ndef test_other():\n    assert 'x' in tokenize(SRC)\n";
  expect(shallowKind(py, "test_loads", () => true)).toBeNull();
  expect(shallowKind(py, "test_in", () => true)).toBe("source-text");
  expect(shallowKind(py, "test_re", () => true)).toBe("source-text");
  expect(shallowKind(py, "test_other", () => true)).toBeNull();
});

test("a review's kept tests carry a suffix test runners do not match; older reviews are renamed, both read", () => {
  const repo = tmp();
  const old = join(repo, ".arnx", "reviews", "20261021-2a4a65", "projects", "app", "tests", "__tests__", "gen");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "a.test.js"), "test('a', () => {});\n");
  writeFileSync(join(old, `b.test.js${COPY_SUFFIX}`), "test('b', () => {});\n");
  const root = join(repo, ".arnx", "reviews", "20261021-2a4a65", "projects", "app", "tests");
  expect(Object.keys(readCopies(root, /\.test\.js$/))).toEqual(["__tests__/gen/a.test.js", "__tests__/gen/b.test.js"]);
  expect(suffixReviewCopies(repo)).toBe(1);
  expect(readdirSync(old).sort()).toEqual([`a.test.js${COPY_SUFFIX}`, `b.test.js${COPY_SUFFIX}`]);
  expect(Object.keys(readCopies(root, /\.test\.js$/))).toEqual(["__tests__/gen/a.test.js", "__tests__/gen/b.test.js"]);
  expect(suffixReviewCopies(repo)).toBe(0);
});
