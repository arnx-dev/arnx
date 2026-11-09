// Which definition holds a changed line: Go's patterns are read for .go files only, and other languages read as before.
import { expect, test } from "bun:test";
import { enclosing } from "../src/context";

const GO = [
  "package lib", "", "const Rate = 3", "", "func Add(a, b int) int {", "\tx := func() int {", "\t\treturn a", "\t}()",
  "\treturn x + b", "}", "", "func (r *Store) Save(v string) error {", "\tr.v = v", "\treturn nil", "}", "",
  "func Map[T any](xs []T) []T {", "\treturn xs", "}", "", "func (s Store) Name() string { return s.v }", "",
].join("\n").split("\n");

const at = (needle: string) => GO.findIndex((l) => l.includes(needle)) + 1;

test("a line of a Go function or method: func Name( and func (r *T) Name(", () => {
  expect(enclosing(GO, at("return a"), "lib/a.go")).toEqual({ name: "Add", kind: "function", line: 5 });
  expect(enclosing(GO, at("return x + b"), "lib/a.go")).toEqual({ name: "Add", kind: "function", line: 5 });
  expect(enclosing(GO, at("r.v = v"), "lib/a.go")).toEqual({ name: "Save", kind: "function", line: 12 });
  expect(enclosing(GO, at("return xs"), "lib/a.go")).toEqual({ name: "Map", kind: "function", line: 17 });
  expect(enclosing(GO, at("func (s Store) Name"), "lib/a.go")).toEqual({ name: "Name", kind: "function", line: 21 });
});

test("a Go package-level constant", () => {
  expect(enclosing(GO, at("const Rate"), "lib/a.go")).toEqual({ name: "Rate", kind: "constant", line: 3 });
  const lines = ["package lib", "", "var Query = `", "SELECT 1", "`", ""];
  expect(enclosing(lines, 4, "lib/q.go")).toEqual({ name: "Query", kind: "constant", line: 3 });
});

test("Go's patterns need a .go path: the same lines read as before under any other name", () => {
  for (const path of ["lib/a.py", "lib/a.ts", "lib/a.rs", ""]) {
    expect(enclosing(GO, at("return a"), path)).toBeNull();
    expect(enclosing(GO, at("r.v = v"), path)).toBeNull();
  }
  expect(enclosing(GO, at("return a"))).toBeNull();
});

test("other languages' definitions are unchanged, with or without a path", () => {
  const py = ["def outer():", "    x = 1", "    return x", ""];
  const ts = ["export function go() {", "  return 1;", "}", ""];
  const rs = ["pub fn run() {", "    let x = 1;", "}", ""];
  for (const [lines, name, path] of [[py, "outer", "a.py"], [ts, "go", "a.ts"], [rs, "run", "a.rs"]] as const) {
    expect(enclosing([...lines], 2)).toEqual({ name, kind: "function", line: 1 });
    expect(enclosing([...lines], 2, path)).toEqual({ name, kind: "function", line: 1 });
  }
});
