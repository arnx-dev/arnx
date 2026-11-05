// The rules for a private key in a file: a header leaves the file out, whatever is under it; a long run that starts as a key
// does too; a pin is for one file's whole text and sends no key; a read that fails counts as a hit. Keys are built at run time.
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { changeLimits, keyInStream, resolveChange, takeSnapshot } from "../src/change";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { holdsPrivateKey, scanKeys, secretPins } from "../src/secrets";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { commit, gitRepo } from "./helpers/gitutil";
import { fakeFactory, type FakeSession, tool } from "./helpers/fakes";
import { junitXml } from "./helpers/junit";
import { RecordingAgent, RecordingJson, treeText } from "./helpers/recording";
import { runReview } from "../src/reviewer";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SHOWN = "[private key]";
const KEY = "PRIVATE " + "KEY";
const HDR = `-----BEGIN ${KEY}-----`, END = `-----END ${KEY}-----`;
const pair = () => generateKeyPairSync("rsa", { modulusLength: 2048 });
const b64Of = (k: ReturnType<typeof pair>) => (k.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer).toString("base64");
const b64 = b64Of(pair()), other = b64Of(pair());
const wrap = (text: string, w: number) => text.match(new RegExp(`.{1,${w}}`, "g"))!;
const random = randomBytes(1200).toString("base64");
const editApp = (repo: string, body = "a - b") => writeFileSync(join(repo, "app.py"), `def add(a, b):\n    return ${body}\n`);
const put = (repo: string, path: string, content: string | Buffer) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};
const clean = (what: string, sent: string, lines: string[]) => {
  const found = lines.filter((l) => l.length >= 4 && sent.includes(l)).length;
  if (found) throw new Error(`${what}: ${found} of ${lines.length} body lines`);
};
afterEach(() => {
  changeLimits.maxScanBytes = 32_000_000;
});

// --- a header means out -------------------------------------------------------------------------------------------------

const lit = (lines: string[], sep: string) => [HDR, ...lines, END].join(sep);
const FORMS: [string, (l: string[]) => string][] = [
  ["\\u000a", (l) => `x = "${lit(l, "\\u000a")}"\n`],
  ["\\x0a", (l) => `x = "${lit(l, "\\x0a")}"\n`],
  ["\\012", (l) => `x = "${lit(l, "\\012")}"\n`],
  ["&#10;", (l) => `<a k="${lit(l, "&#10;")}"/>\n`],
  ["&#xA;", (l) => `<a k="${lit(l, "&#xA;")}"/>\n`],
  ["<br>", (l) => `<p>${lit(l, "<br>")}</p>\n`],
  ["a comment on each line", (l) => `${lit(l, " // line\n")}\n`],
  ["# on each line", (l) => `${lit(l, " # n\n")}\n`],
  ["a number before each line", (l) => `${[HDR, ...l, END].map((x, i) => `${i + 1}  ${x}`).join("\n")}\n`],
  ["a log prefix", (l) => `${[HDR, ...l, END].map((x) => `10:00 INFO ${x}`).join("\n")}\n`],
  ["PHP concatenation", (l) => `$k = "${lit(l, '" .\n"')}";\n`],
  ["a one-line array", (l) => `x = [${[HDR, ...l, END].map((s) => `"${s}"`).join(", ")}].join("\\n");\n`],
  ["Python implicit concatenation", (l) => `x = (${[HDR, ...l, END].map((s) => `"${s}\\n"`).join(" ")})\n`],
  ["named YAML lines", (l) => `${[HDR, ...l, END].map((s, i) => `l${i}: ${s}`).join("\n")}\n`],
  ["a comment line after the header", (l) => `${HDR}\n# a note\n${l.join("\n")}\n${END}\n`],
  ["a prose line after the header", (l) => `${HDR}\nthis is the key we use\n${l.join("\n")}\n${END}\n`],
  ["a # comment", (l) => `${lit(l, "\n").split("\n").map((x) => `# ${x}`).join("\n")}\nx = 1\n`],
];
for (const [name, form] of FORMS) {
  for (const w of [64, 32, 7]) {
    test(`a header leaves the file out: ${name}, wrapped at ${w}`, () => {
      const lines = wrap(random, w);
      const repo = gitRepo(tmp());
      put(repo, "k.py", form(lines));
      editApp(repo);
      commit(repo, "a key");
      const c = resolveChange(repo);
      expect(c.withheld?.map((w2) => [w2.path, w2.label])).toEqual([["k.py", "a private key"]]);
      clean("the diff", c.diff, lines);
      expect(takeSnapshot(repo, "HEAD", join(tmp(), "s"), [], { standIns: true }).withheld.map((x) => x.path)).toEqual(["k.py"]);
    });
  }
}

test("Ed25519 in JSON with `/` and `+` escaped: out, with no body rule to miss it", () => {
  for (let i = 0; i < 40; i++) {
    const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
    const line = pem.split("\n")[1]!;
    for (const json of [JSON.stringify({ k: pem }).replaceAll("/", "\\/"), JSON.stringify({ k: pem }).replaceAll("+", "\\u002b")]) {
      expect(holdsPrivateKey(json, [])).toBe(true);
      expect(json).toContain(HDR);
      expect(line.length).toBe(64);
    }
  }
});

test("a placeholder header leaves its file out too, a hyphen in the label counts, and a comment does not save a file", () => {
  for (const text of [`${HDR}\n...\n${END}\n`, `assert "${HDR}" in pem\n`, `const a = "${HDR}";\n`,
    `-----BEGIN ML-DSA-65 ${KEY}-----\n${wrap(random, 64).join("\n")}\n-----END ML-DSA-65 ${KEY}-----\n`]) {
    expect(holdsPrivateKey(text, [])).toBe(true);
  }
  expect(scanKeys("a.py", `# ${HDR}\n# abc\n# ${END}\nx = 1\n`, [])).toEqual({ withhold: { line: 1, label: "a private key" } });
  const repo = gitRepo(tmp());
  put(repo, "README.md", `Set it:\n\n\`\`\`\n${HDR}\n...\n${END}\n\`\`\`\n`);
  editApp(repo);
  commit(repo, "a doc");
  expect(resolveChange(repo).withheld?.map((w) => w.path)).toEqual(["README.md"]);
});

// --- no header ------------------------------------------------------------------------------------------------------------

test("no header: a key's start on a run of 64 or more, in either alphabet, whole or wrapped; a wrap too short for the start is a limit", () => {
  expect(holdsPrivateKey(b64, [])).toBe(true);
  expect(holdsPrivateKey(Buffer.from(b64, "base64").toString("base64url"), [])).toBe(true);
  for (const w of [64, 32, 20]) expect(holdsPrivateKey(wrap(b64, w).join("\n"), [])).toBe(true);
  expect(holdsPrivateKey(wrap(b64, 12).join("\n"), [])).toBe(false);
  expect(holdsPrivateKey(`${b64.slice(0, 40)}...`, [])).toBe(false);
});

test("no read cap to get past: any number of short starts before a key", () => {
  const key = wrap(b64, 32).join("\n");
  const shorts = "MIIEvQIBADANBgkq x\n";
  for (const n of [999, 1000, 5000]) {
    expect(holdsPrivateKey(`${shorts.repeat(n)}${key}\n`, [])).toBe(true);
    expect(holdsPrivateKey(`${"MIIEvQIBADANBgkq x ".repeat(n)}\n${key}\n`, [])).toBe(true);
  }
  // Nor any number of headers: one is enough.
  expect(holdsPrivateKey(`${HDR}\n`.repeat(1001), [])).toBe(true);
});

// --- pins -------------------------------------------------------------------------------------------------------------------

function configured(o: Partial<Settings> = {}): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig("version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n"), "Dev", "2026-11-04"));
  writeSettings(repo, { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z", ...o });
  commit(repo, "set up");
  return repo;
}
const pemOf = (b: string) => `${HDR}\n${wrap(b, 64).join("\n")}\n${END}\n`;

test("a pin is a hash of the whole file: another key, another edit, an old string pin: each is left out", () => {
  const text = pemOf(b64);
  const pins = secretPins(text);
  expect(holdsPrivateKey(text, pins)).toBe(false);
  expect(holdsPrivateKey(`${text}# an edit\n`, pins)).toBe(true);
  expect(holdsPrivateKey(pemOf(other), pins)).toBe(true);
  // No header: a key with the same first line, or the same first line and other tail lines, is another file.
  const a = wrap(b64, 64), b = wrap(other, 64);
  expect(holdsPrivateKey([a[0], ...b.slice(1)].join("\n"), secretPins(a.join("\n")))).toBe(true);
  // A pin of the header alone, as older versions wrote, holds nothing.
  const old = secretPins(HDR);
  expect(holdsPrivateKey(text, old)).toBe(true);
});

test("a pinned file stays in the diff, and `[private key]` stands in its key lines though the hunk shows no header", () => {
  const repo = configured();
  const lines = wrap(b64, 64);
  const v1 = `# fixture\n${pemOf(b64)}x = 1\n`;
  put(repo, "fix.txt", v1);
  commit(repo, "a fixture");
  // An edit inside the body: no header in the hunk to go by.
  const v2 = v1.replace(lines[10]!, lines[10]!.slice(0, 60) + "AAAA");
  put(repo, "fix.txt", v2);
  editApp(repo);
  commit(repo, "edit");
  const allow = [{ path: "fix.txt", matches: [...secretPins(v1), ...secretPins(v2)] }];
  const c = resolveChange(repo, null, allow);
  expect([c.files, c.withheld]).toEqual([["app.py", "fix.txt"], undefined]);
  expect(c.diff).toContain(`-${SHOWN}`);
  expect(c.diff).toContain(`+${SHOWN}`);
  clean("change.diff", c.diff, lines);

});

test("a re-pinned file's diff works when its old side's hash was pinned earlier; its old side alone unpinned leaves it out", () => {
  const repo = gitRepo(tmp());
  const v1 = pemOf(b64), v2 = `${v1}# edit\n`;
  put(repo, "fix.txt", v1);
  commit(repo, "a fixture");
  put(repo, "fix.txt", v2);
  editApp(repo);
  commit(repo, "edit");
  const both = resolveChange(repo, null, [{ path: "fix.txt", matches: [...secretPins(v1), ...secretPins(v2)] }]);
  expect([both.files, both.withheld]).toEqual([["app.py", "fix.txt"], undefined]);
  expect(both.diff).toContain("+# edit");
  const newOnly = resolveChange(repo, null, [{ path: "fix.txt", matches: secretPins(v2) }]);
  expect(newOnly.withheld?.map((w) => w.path)).toEqual(["fix.txt"]);
});

// --- a read that fails ---------------------------------------------------------------------------------------------------

test("a name that is not UTF-8, whose file cannot be read by that name, counts as a hit", () => {
  const repo = gitRepo(tmp());
  const name = Buffer.concat([Buffer.from(join(repo, "k")), Buffer.from([0xff]), Buffer.from(".txt")]);
  const lines = wrap(random, 64);
  const text = (mid: string) => `${HDR}\n${lines.slice(0, 12).join("\n")}\n${mid}\n${lines.slice(12).join("\n")}\n${END}\n`;
  writeFileSync(name, text("one"));
  commit(repo, "an odd name");
  writeFileSync(name, text("two"));
  editApp(repo);
  const c = resolveChange(repo);
  expect(c.withheld?.length).toBe(1);
  expect(c.files).toEqual(["app.py"]);
  clean("the diff", c.diff, lines);
});

test("a stream that cannot read a file counts as a hit", () => {
  expect(keyInStream(join(tmp(), "no-such-file"))).toEqual({ line: 1, label: "too large to scan" });
});

test("a change holding a pinned file still has a usable diff: the rest of it reads as it is", () => {
  const repo = configured();
  const v1 = `first = 1\n${pemOf(b64)}last = 1\n`, v2 = `first = 2\n${pemOf(b64)}last = 2\n`;
  put(repo, "fix.txt", v1);
  commit(repo, "a fixture");
  put(repo, "fix.txt", v2);
  commit(repo, "edit");
  const c = resolveChange(repo, null, [{ path: "fix.txt", matches: [...secretPins(v1), ...secretPins(v2)] }]);
  expect(c.diff).toContain("+first = 2");
  expect(c.diff).toContain("+last = 2");
  clean("the diff", c.diff, wrap(b64, 64));
});

test("a whole review with a pinned file: the sandbox holds the key, and no request or saved file does", async () => {
  const yaml = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
  const repo = gitRepo(tmp());
  const v1 = `first = 1\n${pemOf(b64)}last = 1\n`, v2 = `first = 2\n${pemOf(b64)}last = 2\n`;
  put(repo, "fix.txt", v1);
  mkdirSync(dirname(reviewConfigPath(repo)));
  const pins = [...secretPins(v1), ...secretPins(v2)];
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(`${yaml}allow_secret_looking:\n  - path: fix.txt\n    matches: [${pins.map((m) => `"${m}"`).join(", ")}]\n`), "Dev", "2026-11-04"));
  const settings: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };
  writeSettings(repo, settings);
  commit(repo, "a fixture");
  put(repo, "fix.txt", v2);
  commit(repo, "edit");
  const lines = wrap(b64, 64);
  const seen: FakeSession[] = [];
  let sandbox = "";
  const GEN = "tests/arnx_generated/test_a.py";
  const report = JSON.stringify({ tests: [{ test: `${GEN}::test_a`, expects: "x" }], suspected_defects: [], questions: [] });
  const agent = new RecordingAgent([
    [tool("read_file", { path: "fix.txt" }), tool("grep", { pattern: lines[5]!.slice(0, 12).replace(/[+/=]/g, "."), path: "." })],
    [tool("write_file", { path: GEN, content: "def test_a():\n    assert True\n" }), tool("run_tests", {})]], report);
  const judge = new RecordingJson();
  const { rdir } = await runReview(repo, { settings, agentModel: agent, challenger: judge, progress: () => {},
    sessionFactory: fakeFactory(() => {
      sandbox = treeText(seen.at(-1)!.snap);
      return [junitXml([[GEN, "test_a", "passed", ""]]), `printed\n${pemOf(b64)}\n`, false];
    }, seen) });
  expect(sandbox).toContain(lines[5]!);
  const sent = [...agent.bodies, ...judge.bodies].join("\n");
  clean("a model's messages", sent, lines);
  expect(sent).toContain(SHOWN);
  expect(sent).toContain("+first = 2");
  clean("the saved review", treeText(rdir), lines);
});
