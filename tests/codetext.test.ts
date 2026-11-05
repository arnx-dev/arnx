// codeText: comments and string literals cut, by language, in one linear pass.
import { expect, test } from "bun:test";
import { CODE_LANGUAGES, codeText } from "../src/codetext";
import { SOURCE } from "../src/untested";

const words = (s: string) => (s.match(/[A-Za-z_$][\w$]*/g) ?? []).join(" ");

test("each language arnx reads: comments and strings go, code and line breaks stay", () => {
  const cases: [string, string][] = [
    ["a.py", 'x = f("SHOW")  # AGGREGATE\n"""doc\nREGION"""\ny = g(\'it\\\'s\')\n'],
    ["a.rb", "x = f('SHOW') # AGGREGATE\n=begin\nREGION\n=end\ny = g\n"],
    ["a.php", '<?php x = f("SHOW"); // AGGREGATE\n# REGION\n/* more\nGEN */ y = g();'],
    ["a.ts", "const x = f('SHOW'); // AGGREGATE\n/* REGION\nGEN */ const y = g(`T ${h(1)} IND`);"],
    ["a.go", 'x := f("SHOW") // AGGREGATE\n/* REGION */ y := g(`raw\nGEN`)'],
    ["a.java", 'x = f("SHOW"); // AGGREGATE\n/* REGION */ y = g("""\nGEN""");'],
    ["a.kt", 'val x = f("SHOW") // AGGREGATE\n/* a /* nested REGION */ still */ val y = g()'],
    ["a.cs", 'var x = f("SHOW"); // AGGREGATE\n/* REGION */ var y = g();'],
    ["a.swift", 'let x = f("SHOW") // AGGREGATE\n/* a /* nested REGION */ still */ let y = g()'],
    ["a.c", 'x = f("SHOW"); // AGGREGATE\n/* REGION */ y = g(\'c\');'],
    ["a.cpp", 'x = f("SHOW"); // AGGREGATE\n/* REGION */ y = g(\'c\');'],
    ["a.h", '/* REGION */ int x = f("SHOW"); // AGGREGATE'],
    ["a.hpp", '/* REGION */ int x = f("SHOW"); // AGGREGATE'],
    ["a.rs", 'let x = f("SHOW"); // AGGREGATE\n/* a /* nested REGION */ still */ let y: &\'a str = r#"raw "GEN" "#; let c = \'x\';'],
    ["a.js", "x = f('SHOW'); // AGGREGATE"], ["a.jsx", "x = f('SHOW'); // AGGREGATE"], ["a.mjs", "x = f('SHOW'); // AGGREGATE"],
    ["a.cjs", "x = f('SHOW'); // AGGREGATE"], ["a.tsx", "x = f('SHOW'); // AGGREGATE"],
  ];
  for (const [path, src] of cases) {
    const out = codeText(src, path);
    expect([path, out.match(/SHOW|AGGREGATE|REGION|GEN\b|IND\b/)]).toEqual([path, null]);
    expect(out.split("\n").length).toBe(src.split("\n").length);
    expect(words(out)).toMatch(/\b[fg]\b/);
  }
  // Names inside a template's expression are code.
  expect(words(codeText("g(`T ${h(1)} IND ${k}`)", "a.ts"))).toBe("g h k");
  // A lifetime is not a quote.
  expect(words(codeText("fn f<'a>(x: &'a str) { run(x) }", "a.rs"))).toBe("fn f a x a str run x");
});

test("every extension of a source file is covered; a file of another type is returned unchanged", () => {
  const exts = SOURCE.source.match(/\(([^)]*)\)/)![1]!.replace("[cm]?[jt]sx?", "js|jsx|ts|tsx|mjs|cjs|mts|cts").split("|");
  for (const e of exts) expect([e, CODE_LANGUAGES.includes(e)]).toEqual([e, true]);
  expect(codeText("# SHOW 'x'\n", "notes.md")).toBe("# SHOW 'x'\n");
  expect(codeText("SHOW", "Makefile")).toBe("SHOW");
});

test("strings are handed over; an unterminated one ends at its line, a template at the end", () => {
  const seen: string[] = [];
  codeText("a = 'one'\nb = 'two\nc = 3", "a.js", (t) => seen.push(t));
  expect(seen).toEqual(["one", "two"]);
  expect(codeText("x = 'oops\ny = 2", "a.py")).toBe("x = '\ny = 2");
});

test("a regular expression literal hides nothing past itself", () => {
  const rows: [string, string][] = [
    ["x = s.replace(/['\"]/g, ''); newFn()", "newFn"],
    ["x = s.split(/`/);\nnewFn();\ny = `t`;", "newFn"],
    ["x = s.replace(/\\/*$/, ''); newFn(); /* c */", "newFn"],
    ["if (a) { return /[/]\"/.test(b) && newFn(); }", "newFn"],
    ["const r = a / b; const q = c / d; newFn();", "newFn"],
  ];
  for (const [src, name] of rows) expect([src, words(codeText(src, "a.ts"))]).toEqual([src, expect.stringContaining(name)]);
  // A division is not a regex; one that cannot end on its line is code.
  expect(words(codeText("a = b / c; d = e / f; // gone", "a.js"))).toBe("a b c d e f");
});

test("code inside strings is code: names in interpolation reach the result", () => {
  const rows: [string, string, string][] = [
    ["a.py", 'x = f"{helper()} and {{lit}} text {obj.attr!r:>{width}}"', "helper obj attr r width"],
    ["a.py", "x = rf'{newFn()}'\ny = 'plain {nope}'", "newFn"],
    ["a.rb", 'x = "text #{newFn(1)} more"\ny = \'#{nope}\'', "newFn"],
    ["a.kt", 'val x = "t ${newFn()} u $other v"', "newFn other"],
    ["a.swift", 'let x = "t \\(newFn(1)) u"', "newFn"],
    ["a.cs", 'var x = $"t {newFn()} u {{lit}}"; var y = "{nope}";', "newFn"],
    ["a.rs", 'let x = format!("{helper} and {{lit}} {}", other());', "helper other"],
    ["a.php", '$x = "t $name u";', "name"],
    ["a.ts", "x = `t ${newFn({a: 1})} u ${k}`", "newFn a k"],
  ];
  for (const [path, src, expected] of rows) {
    const got = words(codeText(src, path));
    for (const w of expected.split(" ")) expect([path, got]).toEqual([path, expect.stringContaining(w)]);
  }
  expect(words(codeText("x = 'plain {nope}'", "a.py"))).not.toContain("nope");
  expect(words(codeText('x = "{nope}"', "a.cs"))).not.toContain("nope");
});

// Crafted text up to 32 MB: every shape that could make a scanner back up or stack.
const MB = 1 << 20;
const shapes: [string, string, () => string][] = [
  ["a long base64 run in a string", "a.py", () => 'KEY = "' + "QUJDREVGR0hJSktMTU5PUA==".repeat(32 * MB / 24).slice(0, 32 * MB - 20) + '"\nx = 1\n'],
  ["a long base64 run in a comment", "a.ts", () => "// " + "QUJDREVG".repeat(4 * MB) + "\nx = 1\n"],
  ["a block comment never closed", "a.rs", () => "/* ".repeat(10 * MB)],
  ["a template string never closed", "a.js", () => "`${".repeat(10 * MB)],
  ["quotes and lifetimes alternating", "a.rs", () => "'a '\\ r#\"\n".repeat(3 * MB)],
  ["triple quotes never closed", "a.py", () => "'''\\\n".repeat(6 * MB)],
  ["many braces and backticks", "a.ts", () => "`${{}`".repeat(5 * MB)],
  ["regex starts that never end", "a.js", () => "x = /[(\\\\ ".repeat(3 * MB)],
  ["slashes and spaces", "a.ts", () => "= / ".repeat(7 * MB)],
  ["f-string braces never closed", "a.py", () => 'f"{'.repeat(10 * MB)],
  ["interpolation openers", "a.kt", () => '"${$x{{'.repeat(4 * MB)],
];
for (const [name, path, make] of shapes) {
  test(`linear on crafted input: ${name}`, () => {
    const text = make();
    expect(text.length).toBeLessThanOrEqual(33 * MB);
    const t = performance.now();
    const out = codeText(text, path);
    const ms = performance.now() - t;
    expect(out.length).toBeLessThanOrEqual(text.length + 2);
    console.log(`${name}: ${text.length} chars, ${Math.round(ms)} ms`);
    Bun.gc(true);
    expect(ms).toBeLessThan(15000); // loose for a loaded machine; quadratic work would take minutes
  }, 60000);
}
