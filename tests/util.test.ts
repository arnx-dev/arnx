import { expect, test } from "bun:test";
import { isoSeconds, pyFloat, pyJson, pyRepr, pyStr, pyTruthy, shQuote, splitLines } from "../src/util";

test("pyJson matches json.dumps", () => {
  expect(pyJson({ b: [1, 2.5], a: "é\n", c: null, d: true }, { sortKeys: true }))
    .toBe('{"a": "\\u00e9\\n", "b": [1, 2.5], "c": null, "d": true}');
  expect(pyJson(["x"], { indent: 2 })).toBe('[\n  "x"\n]');
  expect(pyJson({ a: [], b: {} }, { indent: 2 })).toBe('{\n  "a": [],\n  "b": {}\n}');
  expect(pyJson(10n)).toBe("10");
  expect(pyJson([1, 1.5], { floatNumbers: true })).toBe("[1.0, 1.5]");
  expect(pyJson("\u007f→😀")).toBe('"\\u007f\\u2192\\ud83d\\ude00"');
});

test("pyFloat matches repr", () => {
  const cases: [number, string][] = [[1, "1.0"], [0.1, "0.1"], [1e-5, "1e-05"], [1e16, "1e+16"], [123.5, "123.5"],
    [1.5e-7, "1.5e-07"], [-2, "-2.0"], [0.0001, "0.0001"], [1e22, "1e+22"], [1.25e100, "1.25e+100"]];
  for (const [n, s] of cases) expect(pyFloat(n)).toBe(s);
});

test("pyRepr matches repr", () => {
  expect(pyRepr("arnx: not confirmed")).toBe("'arnx: not confirmed'");
  expect(pyRepr("it's")).toBe('"it\'s"');
  expect(pyRepr("a'\"b\n")).toBe("'a\\'\"b\\n'");
  expect(pyRepr("back\\slash\t")).toBe("'back\\\\slash\\t'");
});

test("pyStr matches str of a YAML scalar", () => {
  expect(pyStr(5n)).toBe("5");
  expect(pyStr(1.5)).toBe("1.5");
  expect(pyStr(true)).toBe("True");
  expect(pyStr("x")).toBe("x");
});

test("shQuote matches shlex.quote", () => {
  expect(shQuote("tests/x.py")).toBe("tests/x.py");
  expect(shQuote("x y")).toBe("'x y'");
  expect(shQuote("a'b")).toBe("'a'\"'\"'b'");
  expect(shQuote("")).toBe("''");
});

test("isoSeconds", () => {
  expect(isoSeconds(new Date(Date.UTC(2026, 9, 11, 1, 2, 3, 400)))).toBe("2026-10-11T01:02:03+00:00");
});

test("splitLines matches str.splitlines", () => {
  expect(splitLines("a\r\nb\rc\nd\n")).toEqual(["a", "b", "c", "d"]);
  expect(splitLines("")).toEqual([]);
  expect(splitLines("\n")).toEqual([""]);
  expect(splitLines("a\n\nb")).toEqual(["a", "", "b"]);
});

test("pyTruthy", () => {
  for (const v of [null, undefined, "", 0, 0n, false, [], {}]) expect(pyTruthy(v)).toBe(false);
  for (const v of ["x", 1, true, [0], { a: 1 }, 1n]) expect(pyTruthy(v)).toBe(true);
});
