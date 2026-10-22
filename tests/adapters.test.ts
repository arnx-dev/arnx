import { expect, test } from "bun:test";
import { getAdapter, LANGUAGES } from "../src/adapters";
import { digest, parseReviewConfig } from "../src/config";
import { GOOD } from "./helpers/yaml";

test("the four languages are known; python is the one implemented", () => {
  expect(LANGUAGES).toEqual(["python", "typescript", "rust", "csharp"]);
  expect(getAdapter("python").id).toBe("python");
  expect(() => getAdapter("csharp")).toThrow(/not supported in this version/);
  expect(() => getAdapter("cobol")).toThrow(/unknown language/);
});

test("review.yaml language defaults to python and is validated", () => {
  expect(parseReviewConfig(GOOD).language).toBe("python");
  expect(parseReviewConfig(GOOD + "language: python\n").language).toBe("python");
  expect(() => parseReviewConfig(GOOD + "language: csharp\n")).toThrow(/language/);
  expect(() => parseReviewConfig(GOOD + "language: [x]\n")).toThrow(/language/);
});

test("the hash covers language only when present", () => {
  expect(digest(parseReviewConfig(GOOD + "language: python\n"))).not.toBe(digest(parseReviewConfig(GOOD)));
});

test("python adapter checks the test command", () => {
  const py = getAdapter("python");
  expect(py.validateCommand("python -m pytest -q {targets}", "pytest")).toEqual([]);
  expect(py.validateCommand("npm test {targets}", "pytest"))
    .toEqual(["test_command: must run pytest and contain {targets}"]);
  expect(py.validateCommand(3, "pytest")).toHaveLength(1);
  expect(py.writable.test("conftest.py") && py.writable.test("test_x.py") && !py.writable.test("notes.txt")).toBe(true);
});

const skip = (src: string, ...names: string[]) => getAdapter("python").skip(src, new Set(names), "r");
const MARK = "@pytest.mark.skip(reason='r')\n";

test("python skip: a decorator spanning several lines gets the marker above it", () => {
  const src = "import pytest\n\n@pytest.mark.parametrize(\"a\", [\n    1,\n])\ndef test_a(a):\n    pass\n";
  expect(skip(src, "test_a")).toBe("import pytest\n\n" + MARK + src.slice("import pytest\n\n".length));
});

test("python skip: async tests and methods", () => {
  const src = "import pytest\n\nclass TestX:\n    async def test_a(self):\n        pass\n";
  expect(skip(src, "test_a")).toBe("import pytest\n\nclass TestX:\n    " + MARK + "    async def test_a(self):\n        pass\n");
});

test("python skip: a def inside a docstring is left alone", () => {
  const src = '"""Example:\n\ndef test_a():\n    pass\n"""\nimport pytest\n\ndef test_a():\n    pass\n';
  const out = skip(src, "test_a");
  expect(out).toBe('"""Example:\n\ndef test_a():\n    pass\n"""\nimport pytest\n\n' + MARK + "def test_a():\n    pass\n");
});

test("python skip: import pytest is added once, after a parenthesised __future__ import", () => {
  const src = "from __future__ import (\n    annotations,\n)\n\ndef test_a():\n    pass\n";
  expect(skip(src, "test_a")).toBe("from __future__ import (\n    annotations,\n)\nimport pytest\n\n" + MARK +
    "def test_a():\n    pass\n");
  const withImport = "import os, pytest\n\ndef test_a():\n    pass\n";
  expect(skip(withImport, "test_a")).toBe("import os, pytest\n\n" + MARK + "def test_a():\n    pass\n");
});

test("python skip: no matching test leaves the source unchanged", () => {
  const src = "def test_a():\n    pass\n";
  expect(skip(src, "test_b")).toBe(src);
});

test("python adapter v2: runners, accepted paths, relocation, words", () => {
  const py = getAdapter("python");
  expect(py.runners).toEqual(["pytest"]);
  expect(py.defaultRunner).toBe("pytest");
  expect(py.acceptedPath("test_add.py", "20261011_a1b2c3", "tests/arnx", "deep_json_recursion"))
    .toBe("tests/arnx/r20261011_a1b2c3/test_deep_json_recursion.py");
  expect(py.acceptedPath("sub/test_a.py", "t", "tests/arnx", "a_2")).toBe("tests/arnx/rt/sub/test_a_2.py");
  expect(py.acceptedPath("sub/conftest.py", "t", "tests/arnx", "x")).toBe("tests/arnx/rt/sub/conftest.py");
  expect(py.testStem("test_add_more.py")).toBe("add_more");
  expect(py.relocate("from x import y\n", "a", "b/c")).toBe("from x import y\n");
  expect(py.words("pytest").runner).toBe("pytest");
  expect(parseReviewConfig(GOOD).runner).toBe("pytest");
});

test("accept shifts path arithmetic that climbs above the moved test folder, and nothing else", async () => {
  const { relocatePaths } = await import("../src/adapters/python");
  const src = 'AGG = Path(__file__).resolve().parents[2]\nHERE = Path(__file__).parent\n' +
    'UP = pathlib.Path(__file__).parent.parent / "a"\nD = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))\n';
  expect(relocatePaths(src, "tests/arnx_generated", "tests/arnx/r1")).toBe(
    'AGG = Path(__file__).resolve().parents[3]\nHERE = Path(__file__).parent\n' +
    'UP = pathlib.Path(__file__).parent.parent.parent / "a"\nD = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))\n');
  // answers/ moved with the file: parents[0] and [1] stay inside the moved folders, [4] climbs above them
  expect(relocatePaths("S = Path(__file__).resolve().parents[4]\nT = Path(__file__).resolve().parents[1]\n",
    "tests/arnx_generated/answers", "tests/arnx/r1/answers"))
    .toBe("S = Path(__file__).resolve().parents[5]\nT = Path(__file__).resolve().parents[1]\n");
  expect(relocatePaths(src, "a/b", "c/d")).toBe(src);
});

test("accept rewrites TypeScript paths built from the test's own folder, as it does imports", async () => {
  const { relocate } = await import("../src/adapters/typescript");
  const src = 'import { a } from "../src/a";\nconst s = path.join(__dirname, "..", "..", "schema.sql");\n' +
    'const f = path.resolve(__dirname, "fixtures/x.json");\nconst u = new URL("../data.json", import.meta.url);\n';
  expect(relocate(src, "tests/arnx_generated", "__tests__/arnx/r1/tests/arnx_generated")).toBe(
    'import { a } from "../../../../../tests/src/a";\nconst s = path.join(__dirname, "../../../../../schema.sql");\n' +
    'const f = path.resolve(__dirname, "../../../../../tests/arnx_generated/fixtures/x.json");\n' +
    'const u = new URL("../../../../../tests/data.json", import.meta.url);\n');
});
