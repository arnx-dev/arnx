// What accept leaves in an accepted test file: tests it does not keep are removed, not skipped. The expected-fail
// markers an older arnx put on a confirmed bug's test (when accepted tests sat in the project's own suite) are removed
// by `arnx accept --move`.
import { expect, test } from "bun:test";
import { getAdapter } from "../src/adapters";

const py = getAdapter("python");
const set = (...n: string[]) => new Set(n);

test("python drop: a test goes with its decorators and body; the tests around it stay", () => {
  const src = "import pytest\n\n\ndef test_a():\n    assert 1\n\n\n@pytest.mark.parametrize(\n    \"x\", [1, 2],\n)\n" +
    "def test_b(x):\n    y = (\n        x\n    )\n    assert y\n\n\ndef test_c():\n    assert 3\n";
  const out = py.drop(src, set("test_b"));
  expect(out.left.size).toBe(0);
  expect(out.text).toBe("import pytest\n\n\ndef test_a():\n    assert 1\n\n\ndef test_c():\n    assert 3\n");
});

test("python drop: a method, a signature over several lines, and the last test of the file", () => {
  const src = "class TestX:\n    def test_a(self):\n        pass\n\n    def test_b(\n        self,\n    ):\n" +
    "        \"\"\"\ndef test_c(): not code\n\"\"\"\n        pass\n";
  expect(py.drop(src, set("test_b")).text).toBe("class TestX:\n    def test_a(self):\n        pass\n");
});

test("python drop: a name it cannot find is left for the caller", () => {
  const src = "def test_a():\n    pass\n";
  const out = py.drop(src, set("test_zz"));
  expect(out.text).toBe(src);
  expect([...out.left]).toEqual(["test_zz"]);
});

test("python unmark: removes arnx's xfail, only for the names given, and leaves the owner's own xfail", () => {
  const src = "import pytest\n\n@pytest.mark.xfail(strict=True, reason='arnx F1: not fixed yet')\ndef test_a():\n" +
    "    assert 1\n\n@pytest.mark.xfail(strict=True, reason='arnx F2: not fixed yet')\n@pytest.mark.slow\n" +
    "def test_b():\n    assert 1\n\n@pytest.mark.xfail(reason='known')\ndef test_c():\n    assert 0\n";
  const one = py.unmark(src, set("test_b"));
  expect(one.names).toEqual(["test_b"]);
  expect(one.text).toBe(src.replace("@pytest.mark.xfail(strict=True, reason='arnx F2: not fixed yet')\n", ""));
  const all = py.unmark(src);
  expect(all.names).toEqual(["test_a", "test_b"]);
  expect(all.text).not.toContain("arnx F");
  expect(all.text).toContain("@pytest.mark.xfail(reason='known')");
});

test("python unmark: a method's marker, at its indent", () => {
  const src = "import pytest\n\nclass TestX:\n    def test_a(self):\n        assert 0\n";
  const marked = src.replace("    def test_a", "    @pytest.mark.xfail(strict=True, reason='arnx F1: not fixed yet')\n    def test_a");
  expect(py.unmark(marked)).toEqual({ text: src, names: ["test_a"] });
});
const ts = getAdapter("typescript");
const rs = getAdapter("rust");

test("typescript drop: a test goes with the comment above it and the blank lines after; describe stays", () => {
  const src = "import { describe, it, expect } from \"vitest\";\n\ndescribe(\"pay\", () => {\n  it(\"keeps\", () => {\n" +
    "    expect(1).toBe(1);\n  });\n\n  // checks the total\n  it(\"drops\", async () => {\n    const x = f(\n      1,\n" +
    "    );\n    expect(x).toBe(2);\n  }, 10_000);\n\n  it('one line', () => expect(2).toBe(2));\n});\n";
  const out = ts.drop(src, set("pay > drops", "pay > one line"));
  expect(out.left.size).toBe(0);
  expect(out.text).toBe("import { describe, it, expect } from \"vitest\";\n\ndescribe(\"pay\", () => {\n" +
    "  it(\"keeps\", () => {\n    expect(1).toBe(1);\n  });\n\n});\n");
});

test("typescript drop: a test it cannot cut cleanly is left for the caller", () => {
  const src = "const t = test(\"bound\", () => {\n  expect(1).toBe(1);\n});\ntest(`a ${x}`, () => {});\n" +
    "test(\"open\", () => {\n  expect(1).toBe(1);\n";
  const out = ts.drop(src, set("bound", "a ${x}", "open", "missing"));
  expect(out.text).toBe(src);
  expect([...out.left].sort()).toEqual(["a ${x}", "bound", "missing", "open"]);
});

test("typescript unmark: each runner's expected-fail form an older arnx wrote, the reason in a comment above", () => {
  const src = "describe(\"pay\", () => {\n  it(\"total\", () => {\n    expect(f()).toBe(2);\n  });\n});\n";
  for (const fn of ["fails", "failing", "todo"]) {
    const marked = src.replace("  it(\"total\"", `  // arnx F3: not fixed yet\n  it.${fn}("total"`);
    expect(ts.unmark(marked)).toEqual({ text: src, names: ["total"] });
  }
});
test("typescript unmark: only arnx's markers, only the names given; the owner's .todo and arnx's skips stay", () => {
  const src = "// arnx F1: not fixed yet\ntest.fails(\"a\", () => {});\n// arnx F2: not fixed yet\n" +
    "test.fails(\"b\", () => {});\n// later\ntest.todo(\"c\");\n// arnx review r1: not confirmed\ntest.skip(\"d\", () => {});\n";
  const one = ts.unmark(src, set("x > b"));
  expect(one.names).toEqual(["x > b"]);
  expect(one.text).toBe(src.replace("// arnx F2: not fixed yet\ntest.fails(\"b\"", "test(\"b\""));
  const all = ts.unmark(src);
  expect(all.names).toEqual(["a", "b"]);
  expect(all.text).toBe("test(\"a\", () => {});\ntest(\"b\", () => {});\n// later\ntest.todo(\"c\");\n" +
    "// arnx review r1: not confirmed\ntest.skip(\"d\", () => {});\n");
});

test("rust drop: attributes, doc comments, body; a one-line test too", () => {
  const src = "use x::y;\n\n#[test]\nfn keeps() {\n    assert!(true);\n}\n\n/// checks it\n#[tokio::test]\n" +
    "async fn drops() {\n    let v = vec![\n        1,\n    ];\n    assert_eq!(v.len(), 2);\n}\n\n#[test]\nfn short() { assert!(false) }\n";
  const out = rs.drop(src, set("drops", "short"));
  expect(out.left.size).toBe(0);
  expect(out.text).toBe("use x::y;\n\n#[test]\nfn keeps() {\n    assert!(true);\n}\n");
});

test("rust unmark: the reason comment and should_panic an older arnx put above the fn", () => {
  const src = "#[test]\nfn a() {\n    assert!(false);\n}\n";
  const marked = src.replace("#[test]\nfn a()", "#[test]\n// arnx F1: not fixed yet\n#[should_panic]\nfn a()");
  expect(rs.unmark(marked)).toEqual({ text: src, names: ["a"] });
});
test("rust drop: a marked test goes whole, #[test] above the marker included", () => {
  const src = "#[test]\n// arnx F1: not fixed yet\n#[should_panic]\nfn a() {\n    assert!(false);\n}\n";
  expect(rs.drop(src, set("a")).text).toBe("");
});

test("python unmark: the non-strict xfail an older arnx put on a parametrized test", () => {
  const src = "import pytest\n\n@pytest.mark.parametrize(\"x\", [1, 2])\ndef test_a(x):\n    assert x == 1\n";
  const marked = src.replace("@pytest.mark.parametrize", "@pytest.mark.xfail(strict=False, reason='arnx F1: not fixed yet')\n@pytest.mark.parametrize");
  expect(py.unmark(marked)).toEqual({ text: src, names: ["test_a"] });
});
test("python drop: a class left with no body goes too (an empty class does not parse)", () => {
  const src = "def test_a():\n    pass\n\n\n@decorate\nclass TestMore:\n    @staticmethod\n    def test_neg():\n" +
    "        pass\n\n\nclass TestKeep:\n    x = 1\n\n    def test_b(self):\n        pass\n";
  expect(py.drop(src, set("test_neg", "test_b")).text).toBe("def test_a():\n    pass\n\n\nclass TestKeep:\n    x = 1\n");
});
