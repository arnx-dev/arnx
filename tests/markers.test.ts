// What accept leaves in an accepted test file: tests it does not keep are removed, not skipped; a confirmed bug's
// test is marked expected to fail, so the project's own suite stays green; check removes the marker once it passes.
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

test("python expectFail: a strict xfail above the decorators, naming the bug; import pytest added", () => {
  const src = "@some.deco\ndef test_a():\n    assert 0\n";
  const out = py.expectFail(src, set("test_a"), "arnx F3: not fixed yet", "pytest");
  expect(out.left.size).toBe(0);
  expect(out.text).toBe("import pytest\n@pytest.mark.xfail(strict=True, reason='arnx F3: not fixed yet')\n" +
    "@some.deco\ndef test_a():\n    assert 0\n");
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

test("python: expectFail then unmark gives the source back", () => {
  const src = "import pytest\n\nclass TestX:\n    def test_a(self):\n        assert 0\n";
  const marked = py.expectFail(src, set("test_a"), "arnx F1: not fixed yet", "pytest").text;
  expect(py.unmark(marked).text).toBe(src);
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

test("typescript expectFail: each runner's own expected-fail form, the reason in a comment above", () => {
  const src = "describe(\"pay\", () => {\n  it(\"total\", () => {\n    expect(f()).toBe(2);\n  });\n});\n";
  const mark = (runner: string) => ts.expectFail(src, set("pay > total"), "arnx F3: not fixed yet", runner).text;
  const want = (fn: string) => src.replace("  it(\"total\"", `  // arnx F3: not fixed yet\n  it.${fn}("total"`);
  expect(mark("vitest")).toBe(want("fails"));
  expect(mark("jest")).toBe(want("failing"));
  expect(mark("node")).toBe(want("todo"));
  expect(mark("bun")).toBe(want("todo"));
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

test("rust expectFail: should_panic right above the fn (where tokio::test keeps it); not on a Result test", () => {
  const src = "#[test]\nfn a() {\n    assert!(false);\n}\n\n#[test]\nfn b() -> Result<(), E> {\n    Err(e)\n}\n";
  const out = rs.expectFail(src, set("a", "b"), "arnx F1: not fixed yet", "nextest");
  expect([...out.left]).toEqual(["b"]);
  expect(out.text).toBe(src.replace("#[test]\nfn a()", "#[test]\n// arnx F1: not fixed yet\n#[should_panic]\nfn a()"));
  expect(rs.unmark(out.text)).toEqual({ text: src, names: ["a"] });
});

test("rust drop: a marked test goes whole, #[test] above the marker included", () => {
  const src = "#[test]\n// arnx F1: not fixed yet\n#[should_panic]\nfn a() {\n    assert!(false);\n}\n";
  expect(rs.drop(src, set("a")).text).toBe("");
});

test("variants: a parametrized python test gets a non-strict xfail (its passing variants must not fail the run)", () => {
  const src = "import pytest\n\n@pytest.mark.parametrize(\"x\", [1, 2])\ndef test_a(x):\n    assert x == 1\n";
  const out = py.expectFail(src, set("test_a"), "arnx F1: not fixed yet", "pytest").text;
  expect(out).toContain("@pytest.mark.xfail(strict=False, reason='arnx F1: not fixed yet')\n@pytest.mark.parametrize");
  expect(py.unmark(out)).toEqual({ text: src, names: ["test_a"] });
});

test("variants: a TypeScript .each test or any test under describe.each, and an rstest case, keep no marker", () => {
  const each = "test.each([1, 2])(\"pays %i\", (x) => {\n  expect(x).toBe(1);\n});\n";
  expect([...ts.expectFail(each, set("pays %i"), "arnx F1: not fixed yet", "vitest").left]).toEqual(["pays %i"]);
  const outer = "describe.each([1, 2])(\"n %i\", (n) => {\n  it(\"pays\", () => {\n    expect(n).toBe(1);\n  });\n});\n";
  expect(ts.expectFail(outer, set("n 1 > pays"), "arnx F1: not fixed yet", "vitest").text).toBe(outer);
  const rstest = "#[rstest]\n#[case(1)]\n#[case(2)]\nfn a(#[case] x: u8) {\n    assert_eq!(x, 1);\n}\n";
  expect(rs.expectFail(rstest, set("a"), "arnx F1: not fixed yet", "nextest").text).toBe(rstest);
});

test("python drop: a class left with no body goes too (an empty class does not parse)", () => {
  const src = "def test_a():\n    pass\n\n\n@decorate\nclass TestMore:\n    @staticmethod\n    def test_neg():\n" +
    "        pass\n\n\nclass TestKeep:\n    x = 1\n\n    def test_b(self):\n        pass\n";
  expect(py.drop(src, set("test_neg", "test_b")).text).toBe("def test_a():\n    pass\n\n\nclass TestKeep:\n    x = 1\n");
});
