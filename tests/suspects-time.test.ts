// Reading a file for values takes time that grows with the file, whatever its shape: the scan is synchronous, so nothing
// can stop one that runs away. And reading a name backwards from its `=` finds what a pattern from the name's side found.
import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { assignedPairs, holdsPrivateKey, scanKeys, suspects } from "../src/secrets";

const repeat = (unit: string, size: number) => unit.repeat(Math.ceil(size / unit.length));
const SIZE = 1_100_000;
/** Each ran for minutes or more when a name could start after every `.` or `-`, or a hit searched every comment. */
const SHAPES: Record<string, string> = {
  "base64url on one line": `token = ${randomBytes(SIZE).toString("base64url").slice(0, SIZE)}\n`,
  "a dotted name": `key ${repeat("ab.", SIZE)}\n`,
  "a dashed name": `key ${repeat("a-", SIZE)}\n`,
  "hex with dashes": `key ${repeat("1f3a9c2e-7b4d-4e6f-8a1b-2c3d4e5f6a7b-", SIZE)}\n`,
  "names with a dollar": `key ${repeat("$a-", SIZE)}\n`,
  "a key's prefix again and again": `key ${repeat("sk-ant-a", SIZE)}\n`,
  "open pairs": `key ${repeat('("a', SIZE)}\n`,
  "pairs with blanks": `key ${repeat(`(${" ".repeat(50)}`, SIZE)}\n`,
  "addresses": `key ${repeat("://a:", SIZE)}\n`,
  "colons in an address": `key ://${":".repeat(SIZE)}\n`,
  "open quotes": `key ${repeat('a="', SIZE)}\n`,
  "blanks after a name": `token a${" ".repeat(SIZE)}\n`,
  "a name on every line": repeat('  "auth_token": "Zq7xK2mP9vR4tY1w",\n', SIZE),
  "a key in every comment": Array.from({ length: SIZE / 60 }, (_, i) => `# sk-${"a".repeat(32)}${String(i).padStart(8, "0")}`)
    .join("\n"),
  "many keys on one comment line": `# ${Array.from({ length: SIZE / 60 }, (_, i) =>
    `sk-${"a".repeat(32)}${String(i).padStart(8, "0")}`).join(" ")}`,
  "a key header in every comment": repeat(`# -----BEGIN ${"PRIVATE"} KEY-----\n`, SIZE),
  "a key header, then keys": `# -----BEGIN ${"PRIVATE"} KEY-----\n${Array.from({ length: SIZE / 60 }, (_, i) =>
    `# sk-${"a".repeat(32)}${String(i).padStart(8, "0")}`).join("\n")}`,
};

for (const [name, text] of Object.entries(SHAPES)) {
  // Each takes under 0.3 s: far from the limit, and the limit far from what it took before.
  test(`scanning a large file takes seconds at most: ${name}`, () => {
    const t0 = performance.now();
    suspects("a.py", text, []);
    scanKeys("a.py", text, []);
    holdsPrivateKey(text, []);
    expect(performance.now() - t0).toBeLessThan(5000);
  }, 60_000);
}

test("an unquoted config line takes no longer", () => {
  const t0 = performance.now();
  suspects("a.env", `api_token=${"a".repeat(SIZE)} #\n`, []);
  suspects("a.env", `api_token=a${" ".repeat(SIZE)}x\n`, []);
  expect(performance.now() - t0).toBeLessThan(5000);
}, 60_000);

/** The pattern this replaced: right, and quadratic on a long run of a name's characters. */
const FROM_THE_NAME = /(?<![\w$])(["'`]?)([A-Za-z_$][\w$.-]*)\1\]?\s*(?::=|=>|==?|:)\s*(["'`])([^"'`\n\\]{1,4096})\3/g;
const byPattern = (text: string) => [...text.matchAll(FROM_THE_NAME)].map((m) => [m[2]!, m[4]!]);

test("reading names backwards finds what the pattern found", () => {
  for (const text of ['api_token = "v1"', '"api_token": "v1"', "'k': 'v'", "`k`: `v`", 'x.y-z.token="v"', '--password="v"',
    '1.2.token = "v"', '9a.token = "v"', 'row["k"] = "v"', 'row[k]="v"', 'a] = "v"', 'a ]= "v"', 'k := "v"', 'k => "v"', 'k == "v"',
    'k:= ="v"', 'a="b"c="d"', 'a="b:"c"', ': "a" : "b"', '"a" : "b" : "c"', '"a.b": "v"', '".a": "v"', '"a b": "v"', 'x"a": "v"',
    'x$"a": "v"', '.-"a": "v"', "k =\n  'v'", 'k = "v\n"', 'k = "a\\b"', '$a-b = "v"', 'a$b="v"', '_="v"', '-="v"', "k = ''"]) {
    expect([text, assignedPairs(text)]).toEqual([text, byPattern(text)] as never);
  }
});

test("on many random texts too", () => {
  const TOKENS = ["a", "token", "K9", "1", ".", "-", "_", "$", '"', "'", "`", "]", "[", " ", "  ", "\n", "=", ":", "=>", ":=", "==",
    "v", "\\", "(", ")", ",", "x.y", "\0"];
  // A fixed seed: a failure here can be run again.
  let seed = 20261104;
  const next = (n: number) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  for (let i = 0; i < 60_000; i++) {
    let text = "";
    for (let k = next(24) + 1; k > 0; k--) text += TOKENS[next(TOKENS.length)];
    const got = assignedPairs(text), want = byPattern(text);
    if (JSON.stringify(got) !== JSON.stringify(want)) expect([text, got]).toEqual([text, want] as never);
  }
}, 60_000);
