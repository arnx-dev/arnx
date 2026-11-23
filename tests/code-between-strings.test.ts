// A name's `:` or `=` inside a string is text, not an assignment: the quote after it closes that string, and what runs
// up to the next quote is code. Taken as a value it got a stand-in wherever a model read it, in every file.
import { expect, test } from "bun:test";
import { suspects } from "../src/secrets";

const found = (line: string, path = "a.test.ts") => suspects(path, line, []);

test("code between two strings is not the value of a name that ends the first", () => {
  for (const line of [
    'expect(ask("Password:")).toBe("")',
    'expect(ask("Password: ")).toBe("")',
    'expect(read("Enter the token:")).toEqual("")',
    "expect(ask('Password:')).toBe('')",
    "expect(ask(`Password:`)).toBe(``)",
    'log("secret=")+String(fooBar1)+("")',
    'const s = "it\'s the password:"+suffixName1+"x"',
    'x = "a"; expect(ask("\\"quoted\\" password:")).toBe("")',
  ]) expect([line, found(line)]).toEqual([line, []]);
});

test("a quoted value given to a name is still found, whatever stands before it on the line", () => {
  const V = ")x7Kq2mP9vR4";
  for (const line of [
    `password = "${V}"`,
    `const password = "${V}";`,
    `{ user: "admin", password: "${V}" }`,
    `connect("db", password="${V}")`,
    `# it's the default: password = '${V}'`,
    `// don't change: password = '${V}'`,
    `"password": "${V}"`,
    `-d "{"password":"${V}"}"`,
    `x = 'say "hi'; password = "Zq7xK2mP9vR4tY1w"`,
    `'<input token="${V}">'`,
    `"<input token='${V}'>"`,
  ]) expect([line, found(line)]).toEqual([line, [line.includes(V) ? V : "Zq7xK2mP9vR4tY1w"]]);
});

test("a multi-line string's line is read as before", () => {
  expect(found('const doc = `\n  password: "Zq7xK2mP9vR4tY1w"\n`')).toEqual(["Zq7xK2mP9vR4tY1w"]);
});
