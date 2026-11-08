// The one checkpoint on the way out: private-key text is replaced in everything outgoing, whatever told the filter of it or
// not, pinned or not. Keys are built at run time.
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Boundary } from "../src/boundary";
import { CloudClient } from "../src/cloud";
import { CloudBrain } from "../src/cloudbrain";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { runReview } from "../src/reviewer";
import type { ExecFactory } from "../src/sandbox";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { type FakeCloud, fakeCloud, type StepScript, TOKEN } from "./helpers/cloudfake";
import { fakeFactory, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { RecordingAgent, RecordingJson } from "./helpers/recording";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SHOWN = "[private key]";
const KEY = "PRIVATE " + "KEY";
const HDR = `-----BEGIN ${KEY}-----`, END = `-----END ${KEY}-----`;
const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
const der = pair.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
const b64 = der.toString("base64");
const wrap = (w: number) => b64.match(new RegExp(`.{1,${w}}`, "g"))!;
const random = randomBytes(1200).toString("base64");
const randomWrap = (w: number) => random.match(new RegExp(`.{1,${w}}`, "g"))!;
const mask = (text: string) => new Boundary().mask(text);
/** Fails naming how much of a body stayed, never printing it. */
const clean = (what: string, sent: string, lines: string[]) => {
  // The run's rule: a last line under 16 characters with no "=" is not part of a no-header key's run, so it may stay.
  const last = lines.length - 1;
  const found = lines.filter((l, i) => l.length >= 4 && !(i === last && lines.length > 1 && l.length < 16 && !l.includes("=")) &&
    sent.includes(l)).length;
  if (found) throw new Error(`${what}: ${found} of ${lines.length} body lines`);
};

const between = (lines: string[], sep: string, before = "", after = "") =>
  `x = ${before}${[HDR, ...lines, END].join(sep)}${after}\nkept = 1\n`;
/** Every way a body has been seen to break, under a whole header: a filter reading no body has nothing to get wrong. */
const SHAPES: [string, (lines: string[]) => string][] = [
  ["line ends", (l) => between(l, "\n")],
  ["\\u000a", (l) => between(l, "\\u000a", '"', '"')],
  ["\\x0a", (l) => between(l, "\\x0a", '"', '"')],
  ["\\012", (l) => between(l, "\\012", '"', '"')],
  ["&#10;", (l) => between(l, "&#10;", 'a="', '"')],
  ["&#xA;", (l) => between(l, "&#xA;", 'a="', '"')],
  ["<br>", (l) => between(l, "<br>")],
  ["a comment on each line", (l) => between(l, " // line\n")],
  ["a number before each line", (l) => [HDR, ...l.map((x, i) => `${i + 1}  ${x}`), END, "kept = 1", ""].join("\n")],
  ["a log prefix on each line", (l) => [HDR, ...l, END, "kept = 1", ""].map((x) => `10:00 INFO ${x}`).join("\n")],
  ["PHP concatenation", (l) => between(l, '" .\n"', '"', '"')],
  ["a one-line array", (l) => `x = [${[HDR, ...l, END].map((s) => `"${s}"`).join(", ")}].join("\\n");\nkept = 1\n`],
  ["JSON escapes", (l) => JSON.stringify({ k: [HDR, ...l, END].join("\n") }).replaceAll("/", "\\/") + "\nkept = 1\n"],
];
for (const [name, shape] of SHAPES) {
  for (const w of [64, 32, 7]) {
    test(`a body goes, ${name}, wrapped at ${w}`, () => {
      const lines = randomWrap(w);
      const out = mask(shape(lines));
      clean(name, out, lines);
      expect(out).toContain(SHOWN);
      expect(out).toContain("kept = 1");
    });
  }
}

test("from a header to its END; with no END, its line and the run of tokens after it", () => {
  expect(mask(`a\n${HDR}\nabc\n${END}\nb\n`)).toBe(`a\n${SHOWN}\nb\n`);
  expect(mask(`a\n${HDR}\nabc\nb\n`)).toBe(`a\n${SHOWN}\nabc\nb\n`);
  expect(mask(`a\n${HDR}\nabcdefg1\nijklmno2\nb\n`)).toBe(`a\n${SHOWN}\nb\n`);
  // A placeholder too: the filter does not read what is under a header.
  expect(mask(`${HDR}\n...\n${END}`)).toBe(SHOWN);
  const twice = `${HDR}\none\n${END}\nmiddle\n${HDR}\ntwo\n${END}\nend`;
  expect(mask(twice)).toBe(`${SHOWN}\nmiddle\n${SHOWN}\nend`);
});

test("each armour: PGP's block, SSH2's four dashes, a digit or a hyphen in the label, URL-encoded", () => {
  for (const [begin, end] of [[`-----BEGIN PGP ${KEY} BLOCK-----`, `-----END PGP ${KEY} BLOCK-----`],
    [`---- BEGIN SSH2 ENCRYPTED ${KEY} ----`, `---- END SSH2 ENCRYPTED ${KEY} ----`],
    [`-----BEGIN ED25519 ${KEY}-----`, `-----END ED25519 ${KEY}-----`],
    [`-----BEGIN ML-DSA-65 ${KEY}-----`, `-----END ML-DSA-65 ${KEY}-----`]] as const) {
    expect(mask(`a\n${begin}\n${random}\n${end}\nb`)).toBe(`a\n${SHOWN}\nb`);
  }
  const url = encodeURIComponent(`${HDR}\n${random}\n${END}\n`);
  clean("URL-encoded", mask(`x=${url}&y=1`), [encodeURIComponent(random.slice(0, 64))]);
});

test("a header with no END in a diff hides its own run, and the file after it stays", () => {
  const next = "diff --git a/app.py b/app.py\n--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-a = 1\n+a = 2\n";
  const near = `diff --git a/k.txt b/k.txt\n--- a/k.txt\n+++ b/k.txt\n@@ -0,0 +1,2 @@\n+${HDR}\n+abcdefgh12345678\n${next}`;
  expect(mask(near)).not.toContain("abcdefgh12345678");
  expect(mask(near)).toContain(next);
});

test("a run of 64 or more that starts as a key goes, whole or wrapped, in a diff's marks too", () => {
  const whole = `const k = "${b64}";\nkept = 1\n`;
  expect(mask(whole)).toBe(`const k = "${SHOWN}";\nkept = 1\n`);
  for (const w of [64, 32, 20]) {
    const lines = wrap(w);
    clean(`wrapped at ${w}`, mask(`${lines.join("\n")}\nnot base64 here\n`), lines);
    clean(`marks, wrapped at ${w}`, mask(lines.map((l) => `+${l}`).join("\n")), lines);
    clean(`quotes, wrapped at ${w}`, mask(lines.map((l) => `  "${l}\\n" +`).join("\n")), lines);
  }
  // Base64url, too.
  const url = der.toString("base64url");
  clean("base64url", mask(`d = "${url}"`), [url]);
  // And nothing else goes.
  const stays = [`MIIEpAIBAAKCAQEA...`, "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC...\n...", `sha512-${random.slice(0, 88)}`,
    (pair.publicKey.export({ type: "spki", format: "der" }) as Buffer).toString("base64"), random];
  for (const text of stays) expect(mask(text)).toBe(text);
});

test("a filter told no value still masks every string of a value", () => {
  const out = new Boundary().maskValue({ a: [`${HDR}\nabc\n${END}`], [b64]: 1 });
  expect(JSON.stringify(out)).not.toContain("abc");
  expect(JSON.stringify(out)).not.toContain(b64);
  expect(out.a[0]).toBe(SHOWN);
});

test("linear time: shapes built to make it slow stay quick", () => {
  const n = 8_000_000;
  const shapes: [string, string][] = [
    ["headers on one line", `${HDR} `.repeat(n / 29)],
    ["begins with no key", "-----BEGIN ".repeat(n / 11)],
    ["a long label", `-----BEGIN ${"A".repeat(n)}`],
    ["one header, no END, long", `${HDR}\n${"x".repeat(n)}`],
    ["backslashes", `${HDR}\n${"\\".repeat(n)}`],
    ["backslashes after a key's start", `MIIEvgIBAAKC${"\\".repeat(n)}`],
    ["key starts, spaced", "MIIEvgIBAAKC ".repeat(n / 13)],
    ["key starts, one a line", "MIIEvgIBAAKC\n".repeat(n / 13)],
    ["short starts over blank lines", `MIIEvgIBAAKC${"\n".repeat(1000)}`.repeat(n / 1012)],
  ];
  for (const [name, text] of shapes) {
    const started = performance.now();
    mask(text);
    const ms = performance.now() - started;
    if (ms > 5000) throw new Error(`${name}: ${Math.round(ms)} ms`);
  }
}, 60_000);

// --- the routes, at the outermost layer ----------------------------------------------------------------------------------

const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };
const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: [] });
const SOURCE = "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n";
const printed = () => [HDR, ...randomWrap(32), END].join("\n");
const printing = () => [junitXml([[GEN, "test_add", "failed", printed()]]), `out\n${printed()}\nend\n`, false] as [string, string, boolean];

function changed(): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-11-04"));
  writeSettings(repo, SETTINGS);
  commit(repo, "set up");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  commit(repo, "an edit");
  return repo;
}

test("route: a key a test prints, to a local model and in what a review saves", async () => {
  const repo = changed();
  const agent = new RecordingAgent([[tool("write_file", { path: GEN, content: SOURCE }), tool("run_tests", {})]], REPORT);
  const judge = new RecordingJson();
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge, sessionFactory: fakeFactory(printing) });
  const sent = [...agent.bodies, ...judge.bodies].join("\n");
  clean("a model's messages", sent, randomWrap(32));
  expect(sent).toContain(SHOWN);
});

let clouds: FakeCloud[] = [];
afterEach(() => {
  for (const c of clouds) c.stop();
  clouds = [];
});

test("route: a key a test prints, to arnx cloud", async () => {
  const repo = changed();
  const rounds: StepScript[] = [
    { type: "actions", actions: [{ name: "write_file", input: { path: GEN, content: SOURCE } }, { name: "run_tests", input: {} }] },
    { type: "final", report: { tests: [], suspected_defects: [], questions: [] } },
    { type: "done", stop: "end_turn" },
  ];
  const cloud = fakeCloud({ rounds: { "*": rounds } });
  clouds.push(cloud);
  await runReview(repo, { settings: SETTINGS, brain: new CloudBrain({ boundary: new Boundary(),
    client: new CloudClient(cloud.url, { token: TOKEN, delays: [0] }), tier: "medium" }), sessionFactory: fakeFactory(printing) });
  const wire = JSON.stringify(cloud.seen.map((x) => [x.path, x.body]));
  clean("the wire", wire, randomWrap(32));
  expect(wire).toContain(SHOWN);
});

test("route: a key setup's `exec` prints", async () => {
  const repo = gitRepo(tmp());
  const APP = "version: 1\nprojects:\n  app:\n    root: .\n    language: python\n    image: python:3.12-slim\n" +
    "    test_command: python -m pytest -q {targets}\n";
  const passing = (): [string | null, string, boolean] => [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false];
  const box: ExecFactory = async () => ({
    exec: () => ({ exitCode: 0, output: printed(), timedOut: false, seconds: 0.1 }),
    close: () => {},
  });
  const agent = new RecordingAgent([[tool("try_project", { yaml: APP, project: "app" })],
    [tool("exec", { project: "app", command: "cat a" })]], "done");
  await runSetup(repo, SETTINGS, agent, { outDir: join(tmp(), "setup"), sessionFactory: fakeFactory(passing), execFactory: box });
  const sent = agent.bodies.join("\n");
  clean("setup's messages", sent, randomWrap(32));
  expect(sent).toContain(SHOWN);
});
