import { expect, test } from "bun:test";
import { standIn, suspects } from "../src/secrets";

// A value given a stand-in is replaced in every file of the tree, so a wrong pick rewrites the project's own code.
const picked = (line: string, path = "a.ts") => suspects(path, line, []);

test("an expression bound to a secret-looking name is code, not a value", () => {
  for (const line of [
    `<li :key="row[rowKeyField]">`,
    `<li :key="item[props.itemValue]">`,
    `<li :key="choice[itemValue]">`,
    `<li :key="group.date.toString()">`,
    `<li :key="idFor(candidate)">`,
    `<li :key="String(item.value)">`,
    `<li :key="item[keyFieldPath!]">`,
    `<Doc :password="pdfPassword()" />`,
    `<Doc :token="tokens[currentUser]" />`,
  ]) expect(picked(line, "a.vue")).toEqual([]);
});

test("a package spec under a name ending in a secret word is not a key", () => {
  for (const line of [
    `"some-auth": "npm:some-auth@^4.24.15",`,
    `"some-auth": "npm:some-auth@~4.24.15",`,
    `"some-auth": "npm:some-auth@>=4.24.15",`,
  ]) expect(picked(line, "package.json")).toEqual([]);
});

test("text with a key's name but a shape no key has stays", () => {
  expect(picked(`auth_key: "127.0.0.1|/get-session"`)).toEqual([]);
  expect(picked(`cache_key = "text/plain+frozenset:[NaN]"`)).toEqual([]);
  expect(picked(`password: "[Function]"`)).toEqual([]);
});

test("the code around such a name is left as it is", () => {
  const code = `<li :key="row[rowKeyField]">\nconst x = row[rowKeyField];\n`;
  expect(standIn(code, [], "a.vue")).toEqual({ text: code, count: 0 });
});

test("real values beside the same names still get stand-ins", () => {
  const weak = "Q7vX2mK9pL4zR8tB1nW6yC3f";
  expect(picked(`auth_key: "${weak}"`)).toEqual([weak]);
  const b64 = "EG47ZWjYjr+Y97abXk2Lm9Qz/w8TnVc1hR5dPqU3sJ0=";
  expect(picked(`private_key = "${b64}"`)).toEqual([b64]);
  // A password may hold any character; only a whole expression reads as code.
  for (const pw of ["x)yMQt7ZNK3k", "Pa(ss)w0rd!", "N3verSt0red!", "a[1]b2C3d4"]) {
    expect(picked(`password: "${pw}"`)).toEqual([pw]);
  }
});

test("a cookie's own separators do not hide it", () => {
  const cookie = "sid=Q7vX2mK9pL4zR8tB&t=1n6yC3f;Secure";
  expect(picked(`cookie: "${cookie}"`)).toEqual([cookie]);
});

test("the expression check is linear in the value's length", () => {
  for (const tail of ["!", ")", "]"]) {
    const value = `f()Aa1${"a".repeat(4000)}${tail}`;
    const t = performance.now();
    picked(`token: "${value}"`);
    expect(performance.now() - t).toBeLessThan(200);
  }
});
