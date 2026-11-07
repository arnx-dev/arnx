// How a failure near a fake is read, and what a view shows of a key: narrow words, the same fake everywhere, and a file left out
// that does not stop or crowd out the rest. Keys are built at run time.
import { expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Workspace } from "../src/agent";
import { changeLimits, resolveChange, takeSnapshot } from "../src/change";
import { check, checkSummary } from "../src/check";
import { CloudClient } from "../src/cloud";
import { CloudBrain } from "../src/cloudbrain";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp } from "../src/config";
import { changedDefinitions, contextPack } from "../src/context";
import { markUnproven } from "../src/diagnose";
import { recheckReview, recheckSummary } from "../src/recheck";
import { exitCode, render, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import { fakeKeys, keyTokens, maskPrivateKeys, secretPins, BIG_KEYS_MOST } from "../src/secrets";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { approvalWarnings } from "../src/setupview";
import { Boundary } from "../src/boundary";
import { fakeCloud, TOKEN } from "./helpers/cloudfake";
import { Cli } from "./helpers/cli";
import { fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { RecordingAgent, RecordingJson } from "./helpers/recording";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const KEY = "PRIVATE " + "KEY";
const HDR = `-----BEGIN ${KEY}-----`, END = `-----END ${KEY}-----`;
// The key's last base64 character is made a digit: a last line with no digit, `+` or `/` reads as a name, which the sandbox
// keeps and a view fakes (about 1 draw in 100), and no test here should hang on that.
const pem = (generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string)
  .replace(/[A-Za-z0-9+/](=*\n-----END)/, "7$1");
const body = pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
const der = body;
const wrapped = (w: number) => `${HDR}\n${body.match(new RegExp(`.{1,${w}}`, "g"))!.join("\n")}\n${END}\n`;
const piecesOf = (w: number) => body.match(new RegExp(`.{1,${w}}`, "g"))!;
// The final line of a wrapped key is short. When it has no digit, `+` or `/` it reads as a name: the sandbox keeps it,
// and the view fakes it (a name-like line between an intact header and END, as ruled above).
const lastLine = "AbCdEfGhIjKlMnOpQrStUvWx";
const withLastLine = (last: string) => `${HDR}\n${[...piecesOf(64).slice(0, -1), last].join("\n")}\n${END}\n`;
// A last line that holds a digit never reads as a name, so a test of the same fake everywhere does not hang on a random key.
const fixedKey = withLastLine("AbCdEfGhIjKlMnOpQrStUv7x");
const put = (repo: string, path: string, content: string | Buffer) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };
const GEN = "tests/arnx_generated/test_add.py";
const SOURCE = "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n";
const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: [] });
const WRITE = () => [[tool("write_file", { path: GEN, content: SOURCE }), tool("run_tests", {})]];
function project(files: Record<string, string> = {}, after: Record<string, string> = {}): string {
  const repo = gitRepo(mkdtempSync(join(tmp(), "r-")));
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-11-04"));
  writeSettings(repo, SETTINGS);
  put(repo, "app.py", "def add(a, b):\n    return a + b\n");
  for (const [p, t] of Object.entries(files)) put(repo, p, t);
  commit(repo, "the code");
  put(repo, "app.py", "def add(a, b):\n    return a - b\n");
  for (const [p, t] of Object.entries(after)) put(repo, p, t);
  commit(repo, "the change");
  return repo;
}
const review = (repo: string, message: string, outcome = "failed") => runReview(repo, { settings: SETTINGS,
  agentModel: new RecordingAgent(WRITE(), REPORT), challenger: new RecordingJson(), progress: () => {},
  sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", outcome, message]]), "1 run\n", false]) });
/** A failure beside a fake as markUnproven reads it, with what the rerun with the real key gave (undefined: no rerun was asked). */
const mark = (message: string, leftOut: string[] = [], fakedKeys = ["tests/data/server.pem"], real?: string | null) => markUnproven(
  [{ testId: "t.py::a", fileAttr: "t.py", name: "a", outcome: "failed", message }],
  { leftOut, fakedKeys, all: [...leftOut, ...fakedKeys], ...(real === undefined ? {} : { real: new Map([["t.py::a", real]]) }) })[0]!;
/** As pytest writes a failure: its short message, the source lines, the exception on `E` lines. */
const pytest = (source: string, ...exception: string[]) => `${exception[0]}\n${source.split("\n").map((l) => `    ${l}`).join("\n")}\n${exception.map((l) => `E   ${l}`).join("\n")}\n\napp.py:3: ${exception[0]!.split(":")[0]}`;

// --- 1. no word decides: the rerun with the real key does ---------------------------------------------------------------------

for (const [row, message] of [
  ["a local named for base64", pytest("encoded_as_base64 = 3\n> assert encoded_as_base64 == 2", "assert 3 == 2")],
  ["the file's name in an assert", pytest("> assert p == q", "assert 'tests/data/server.pem' == 'tests/data/other.pem'")],
  ["cryptography", pytest("> load(x)", "ValueError: Could not deserialize key data. The data may be in an incorrect format.")],
  ["ssl", "ssl.SSLError: [SSL] PEM lib (_ssl.c:3851)"],
  ["node", "Error: error:1E08010C:DECODER routines::unsupported"],
  ["a missing-file line naming the fake", "E   OSError: could not open tests/data/server.pem"],
] as const) {
  test(`a failure beside a fake reads by the rerun, not its words: ${row}`, () => {
    // Fails again with the real key: a finding, as it ran.
    expect(mark(message, [], undefined, "failed")).toMatchObject({ outcome: "failed", message });
    expect(mark(message, [], undefined, "failed").needs).toBeUndefined();
    // Passes with it: the fake's, needing the real key.
    expect(mark(message, [], undefined, "passed")).toMatchObject({ outcome: "error", needs: "tests/data/server.pem", fakedKey: true });
    expect(mark(message, [], undefined, "passed").notRerun).toBeUndefined();
    // Not rerun: it may need it, never a finding.
    expect(mark(message, [], undefined, null)).toMatchObject({ outcome: "error", needs: "tests/data/server.pem", notRerun: true });
    // No rerun asked of it: as it ran.
    expect(mark(message).needs).toBeUndefined();
  });
}

test("a name counts in a missing-file or open-failure line only, for a file left out", () => {
  expect(mark("E   assert 'tests/data/ca.p12' == 'x'", ["tests/data/ca.p12"], []).needs).toBeUndefined();
  expect(mark("E   OSError: unable to read tests/data/ca.p12", ["tests/data/ca.p12"], []).needs).toBe("tests/data/ca.p12");
  // A file left out goes first, whatever the rerun gave.
  expect(mark("E   OSError: unable to read tests/data/ca.p12", ["tests/data/ca.p12"], undefined, "passed").needs).toBe("tests/data/ca.p12");
});

test("with two faked files the rerun cannot tell which: a faked file", () => {
  expect(mark("E   assert 1 == 2", [], ["a.pem", "b.pem"], "passed").needs).toBe("a faked file");
});

// --- 2. the words at the fail point -------------------------------------------------------------------------------------------

const FIX = "Fix the code; if this test needs a real key: `arnx allow-secret PATH`";
test("a finding beside a fake says fix the code, and how to run it with the real key", async () => {
  const repo = project({ "tests/data/server.pem": pem });
  const { review: r } = await review(repo, "E   assert 1 == 2");
  expect(exitCode(r)).toBe(0);
  expect(summary(r, "review.md")).toContain(FIX);
  expect(render(r).replace(/\s+/g, " ")).toContain(FIX);
  put(repo, ".arnx/tests/tests/arnx/r1/test_kept.py", SOURCE);
  const [said, code] = checkSummary(await check(repo, SETTINGS, { sessionFactory: fakeFactory(() =>
    [junitXml([["tests/arnx/r1/test_kept.py", "test_add", "failed", "E   assert 1 == 2"]]), "1 failed\n", false]) }));
  expect(code).toBe(1);
  expect(said).toContain(FIX);
  expect(said.split("Fix the code").length - 1).toBe(1);
  // A test that is no finding, beside a fake: once too.
  const [other] = checkSummary(await check(repo, SETTINGS, { sessionFactory: fakeFactory(() =>
    [junitXml([["tests/arnx/r1/test_kept.py", "test_add", "passed", ""], ["tests/arnx/r1/test_kept.py", "test_more", "failed", "E   assert 1 == 2"]]), "1 failed\n", false]) }));
  expect(other.split("Fix the code").length - 1).toBe(1);
  // With no fake, the words are as they were.
  const plain = project();
  expect(summary((await review(plain, "E   assert 1 == 2")).review, "review.md")).not.toContain("allow-secret");
});

test("a skipped test in a run with a fake counts in the line about faked keys", async () => {
  const repo = project({ "tests/data/server.pem": pem });
  const { review: r } = await review(repo, "", "skipped");
  expect(summary(r, "review.md")).toContain("1 test skipped");
  put(repo, ".arnx/tests/tests/arnx/r1/test_kept.py", SOURCE);
  const [said] = checkSummary(await check(repo, SETTINGS, { sessionFactory: fakeFactory(() =>
    [junitXml([["tests/arnx/r1/test_kept.py", "test_add", "skipped", ""]]), "1 skipped\n", false]) }));
  expect(said).toContain("tests/data/server.pem");
  expect(said).toContain("arnx allow-secret");
});

// --- 3. the fake keeps no character's class, and a view fakes every token ----------------------------------------------------------

const classOf = (c: string) => /[A-Z]/.test(c) ? "A" : /[a-z]/.test(c) ? "a" : /[0-9]/.test(c) ? "0" : c;
test("a key's fake keeps no character's class: length, line ends, quotes and marks only", () => {
  const faked = fakeKeys(`x = "${wrapped(64).replaceAll("\n", "\\n")}"\n`).text;
  const real = body.slice(0, 64), fakedLine = faked.split("\\n")[1]!;
  expect(fakedLine.length).toBe(64);
  const same = [...real].filter((c, i) => classOf(c) === classOf(fakedLine[i]!)).length;
  expect(same).toBeLessThan(50);
  expect(faked.startsWith(`x = "${HDR}\\n`)).toBe(true);
  expect(faked.endsWith(`\\n${END}\\n"\n`)).toBe(true);
  const pad = fakeKeys(`${HDR}\nabcd1234efgh==\n${END}\n`).text;
  expect(pad.split("\n")[1]!.endsWith("==")).toBe(true);
  // Every process reads the same fake: nothing here is random.
  expect(fakeKeys(wrapped(64)).text).toBe(fakeKeys(wrapped(64)).text);
});

test("the sandbox keeps the identifier rule; a view fakes every token of any length or shape between a header and END", () => {
  const code = `a = "${HDR}"\n${"name_here x1 ${templ} <angle>"}\nb = "${END}"\n`;
  expect(fakeKeys(code).text).toBe(code);
  const view = fakeKeys(code, { view: true }).text;
  expect(view).toContain(HDR);
  expect(view).toContain(END);
  expect(view.split("\n").length).toBe(code.split("\n").length);
  expect(view.length).toBe(code.length);
  for (const t of ["name_here", "templ", "angle", "x1"]) expect(view).not.toContain(t);
  // With no END the run's rule stands, and code after a bare header reads as it is.
  const bare = `a = "${HDR}"\nsome_name = 1\n`;
  expect(fakeKeys(bare, { view: true }).text).toBe(bare);
});

for (const w of [64, 32, 20, 16, 7]) {
  test(`a view at wrap ${w}: a page and a search with no header show none of the key`, async () => {
    const repo = project({ "k.txt": wrapped(w) });
    const pin = [{ path: "k.txt", matches: secretPins(wrapped(w)) }];
    const dest = join(mkdtempSync(join(tmp(), "s-")), "s");
    // Pinned: the real key is in the sandbox, and the view is all there is between it and a model.
    takeSnapshot(repo, null, dest, pin, { standIns: true });
    expect(readFileSync(join(dest, "k.txt"), "utf8")).toBe(wrapped(w));
    const tools = new Workspace(dest);
    const page = await tools.call("read_file", { path: "k.txt", start_line: 3 });
    const search = await tools.call("grep", { pattern: "[a-z]", path: "k.txt" });
    for (const piece of piecesOf(w).slice(1).filter((p) => p.length >= 4)) {
      if (page.includes(`\t${piece}\n`) || search.includes(`: ${piece}\n`)) throw new Error(`wrap ${w}: a real line in a view`);
    }
  });
}

test("the same fake in the sandbox, the view and the diff, on both sides of a change", async () => {
  const repo = project({ "k.txt": `${fixedKey}# one\n` }, { "k.txt": `${fixedKey}# two\n` });
  const snap = (rev: string) => {
    const dest = join(mkdtempSync(join(tmp(), "s-")), "s");
    takeSnapshot(repo, rev, dest, [], { standIns: true });
    return dest;
  };
  const a = readFileSync(join(snap("HEAD^"), "k.txt"), "utf8"), b = readFileSync(join(snap("HEAD"), "k.txt"), "utf8");
  expect(a.replace("# one", "")).toBe(b.replace("# two", ""));
  const diff = resolveChange(repo).diff;
  const context = diff.slice(diff.indexOf("k.txt")).split("\n").filter((l) => l.startsWith(" ") && l.length > 8 && !l.includes("-----"));
  expect(context.length).toBeGreaterThan(0);
  for (const l of context) expect(b).toContain(l.slice(1));
  const seen = await new Workspace(snap("HEAD")).call("read_file", { path: "k.txt", start_line: 3 });
  expect(b).toContain(seen.split("\n")[0]!.split("\t")[1]!);
});

test("the definitions and the context a hunter reads hold the view: a pinned key shows in neither", () => {
  const text = `def changed():\n    # ${wrapped(32).replaceAll("\n", "\n    # ")}\n    a = 2\n    return a\n\ndef caller():\n    return changed()\n`;
  const repo = project({ "x.py": text.replace("a = 2", "a = 1") }, { "x.py": text });
  const dest = join(mkdtempSync(join(tmp(), "s-")), "s");
  takeSnapshot(repo, null, dest, [{ path: "x.py", matches: secretPins(text) }], { standIns: true });
  expect(readFileSync(join(dest, "x.py"), "utf8")).toBe(text);
  const line = text.split("\n").findIndex((l) => l.includes("a = 2")) + 1;
  const diff = `diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -${line},1 +${line},1 @@\n-    a = 1\n+    a = 2\n`;
  const defs = changedDefinitions(dest, diff, ["x.py"]);
  expect(defs).toContain("def changed():");
  const pack = contextPack(dest, diff, ["x.py"], ["."]);
  for (const piece of piecesOf(32).slice(0, -1)) {
    expect(defs.includes(piece)).toBe(false);
    expect(pack.includes(piece)).toBe(false);
  }
});

// --- 4. a no-header run --------------------------------------------------------------------------------------------------------

test("a no-header run ends at a token under 16 characters, unless it ends in =", () => {
  const code = `const k = "${der}",\n  'base64url',\n  next(1);\n`;
  expect(fakeKeys(code).text).toContain("'base64url',");
  expect(maskPrivateKeys(code)).toContain("'base64url',");
  expect(fakeKeys(code).text).not.toContain(der.slice(0, 64));
  const lines = der.match(/.{1,64}/g)!;
  const padded = `x = "${lines.slice(0, 3).join('"\n"')}"\n"abc1=="\nnext(1)\n`;
  expect(maskPrivateKeys(padded)).not.toContain('"abc1=="');
  expect(maskPrivateKeys(padded)).toContain("next(1)");
});

// --- a name-like line inside a no-END key --------------------------------------------------------------------------------------------

// A line of a wrapped key with no digit, `+` or `/`, built so no test here hangs on what a random key holds.
const SHOWN = "[private key]";
const NAME_LINE = "AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEf";
const KEY_LINES = ["aB3dE6gH9jK2mN5pQ8sT1vW4yZ7bC0eF", "gH2jK5mN8pQ1sT4vW7yZ0bC3eF6hJ9kL", "mN4pQ7sT0vW3yZ6bC9eF2hJ5kL8nP1qR"];

test("no END: a line that reads as a name stays in the run while a key-like token follows, in the fake and the filter alike", () => {
  for (const [name, text] of [
    ["in the middle", `${HDR}\n${KEY_LINES[0]}\n${NAME_LINE}\n${KEY_LINES[1]}\n${KEY_LINES[2]}\nnext_line(1)\n`],
    ["right after the header", `${HDR}\n${NAME_LINE}\n${KEY_LINES[0]}\n${KEY_LINES[1]}\n${KEY_LINES[2]}\nnext_line(1)\n`],
    ["written \\n", `x = "${HDR}\\n${KEY_LINES[0]}\\n${NAME_LINE}\\n${KEY_LINES[1]}\\n${KEY_LINES[2]}\\n"\nnext_line(1)\n`],
  ] as const) {
    const out = fakeKeys(text).text, masked = maskPrivateKeys(text);
    for (const l of [...KEY_LINES, NAME_LINE]) {
      if (out.includes(l)) throw new Error(`${name}: the fake keeps a line`);
      if (masked.includes(l)) throw new Error(`${name}: the filter shows a line`);
    }
    expect(out).toContain("next_line(1)");
    expect(masked).toContain("next_line(1)");
    expect(masked.split(SHOWN).length - 1).toBe(1);
    expect(fakeKeys(text, { view: true }).text.includes(NAME_LINE)).toBe(false);
  }
});

test("no END: a name with no key-like token after it still ends the run", () => {
  for (const code of [`a = {\n  privateKey: "${HDR}",\n  clientEmail,\n  projectId,\n  tokenUri,\n};\n`,
    `${HDR}\nclientEmail\nprojectId\n`, `"${HDR}"\nsome_long_name = 1\nother_long_name2 = 2\n`,
    `# ${HDR}\nfunction someName2() {}\n`]) {
    expect(fakeKeys(code).text).toBe(code);
    expect(maskPrivateKeys(code)).toBe(code.replace(HDR, SHOWN));
  }
  // At the run's end too: what follows the key is no part of it.
  const after = `${HDR}\n${KEY_LINES[0]}\n${KEY_LINES[1]}\nclientEmail,\nprojectId,\n`;
  expect(fakeKeys(after).text).toContain("clientEmail,\nprojectId,\n");
  expect(maskPrivateKeys(after)).toBe(`${SHOWN}\nclientEmail,\nprojectId,\n`);
});

test("a name-like line between an intact header and END keeps its text in the sandbox, as ruled", () => {
  const text = `${HDR}\n${KEY_LINES[0]}\n${NAME_LINE}\n${KEY_LINES[1]}\n${END}\n`;
  expect(fakeKeys(text).text).toContain(NAME_LINE);
  expect(fakeKeys(text, { view: true }).text).not.toContain(NAME_LINE);
  expect(maskPrivateKeys(text)).toBe(`${SHOWN}\n`);
});

// --- 5, 6. setup -----------------------------------------------------------------------------------------------------------------

const SETUP_YAML = "version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
  "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n";
const setupRepo = (files: Record<string, string>) => {
  const repo = gitRepo(mkdtempSync(join(tmp(), "r-")));
  for (const [p, t] of Object.entries(files)) put(repo, p, t);
  put(repo, "test_shop.py", "def test_a():\n    assert 1\n");
  commit(repo, "shop");
  return repo;
};
type Rows = [string, string, string, string][];
const setupWith = (repo: string, rows: Rows | ((dir: string) => Rows)) => runSetup(repo, defaultSettings(),
  new ScriptedAgent([[tool("propose", { yaml: SETUP_YAML })], [text("done")]]), { outDir: join(tmp(), "setup"), progress: () => {},
    sessionFactory: fakeFactory((_c, _n, dir) => [junitXml(typeof rows === "function" ? rows(dir) : rows), "ran\n", false]) });
/** Whether the run at `dir` holds the real key of `path`. */
const realIn = (dir: string, path = "tests/data/server.pem") => existsSync(join(dir, path)) && readFileSync(join(dir, path), "utf8") === pem;

test("setup: a test failing on the fake is no failure of the project: not in the baseline, listed as needing the key", async () => {
  const repo = setupRepo({ "tests/data/server.pem": pem });
  const r = await setupWith(repo, (dir) => [["test_shop.py", "test_ok", "passed", ""],
    ["test_shop.py", "test_key", realIn(dir) ? "passed" : "failed", "E   ValueError: Could not deserialize key data. Open tests/data/server.pem"]]);
  expect(r.ok).toBe(true);
  const proof = r.projects[0]!;
  expect(proof.failed ?? []).toEqual([]);
  expect(proof.unproven?.map((u) => u.testId)).toEqual(["test_shop.py::test_key"]);
  expect(approvalWarnings(parseReviewFile(r.yamlText!), r.projects).join("\n")).toContain("1 test needs tests/data/server.pem");
});

test("setup: some tests need a file left out by name: it goes on and lists them", async () => {
  const repo = setupRepo({ ".env.example": "A=1\n" });
  const r = await setupWith(repo, [["test_shop.py", "test_ok", "passed", ""],
    ["test_shop.py", "test_env", "error", "E   FileNotFoundError: [Errno 2] No such file or directory: '.env.example'"]]);
  expect([r.ok, r.stop === "stopped"]).toEqual([true, false]);
  expect(r.projects[0]!.failed ?? []).toEqual([]);
  expect(r.projects[0]!.unproven).toEqual([{ testId: "test_shop.py::test_env", needs: ".env.example" }]);
});

test("setup: no test can run for it: it stops, as before", async () => {
  const repo = setupRepo({ ".env.example": "A=1\n" });
  const r = await setupWith(repo, [["test_shop.py", "test_env", "error", "E   FileNotFoundError: [Errno 2] No such file or directory: '.env.example'"]]);
  expect(r.stop).toBe("stopped");
  expect(r.needed).toEqual([{ path: ".env.example", secret: true }]);
});

// --- 7. a .pem with no key ---------------------------------------------------------------------------------------------------------

const CERT = `-----BEGIN CERTIFICATE-----\n${randomBytes(300).toString("base64")}\n-----END CERTIFICATE-----\n`;
for (const [what, block, stays] of [
  ["a certificate", CERT, true],
  ["a public key", `-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n`, true],
  ["DH parameters", `-----BEGIN DH PARAMETERS-----\nabc\n-----END DH PARAMETERS-----\n`, true],
  ["a certificate and an unknown block", `${CERT}-----BEGIN SECRET THING-----\nabc\n-----END SECRET THING-----\n`, false],
  ["no block at all", "just some text\n", false],
] as const) {
  test(`a .pem holding ${what} ${stays ? "stays" : "is left out by its name"}`, () => {
    const repo = project({ "tests/ca.pem": block, "tests/ca.key": block }, { "tests/ca.pem": `${block}# edit\n` });
    const dest = join(mkdtempSync(join(tmp(), "s-")), "s");
    const left = takeSnapshot(repo, null, dest, [], { standIns: true }).withheld.map((w) => w.path);
    expect(left.includes("tests/ca.pem")).toBe(!stays);
    // Only a .pem: a .key with no key stays out.
    expect(left).toContain("tests/ca.key");
    expect(resolveChange(repo).files.includes("tests/ca.pem")).toBe(stays);
  });
}

// --- 8. the left-out line ------------------------------------------------------------------------------------------------------------

test("the left-out line: a file the change touches or a failure names, else a count; the full list in review.md", async () => {
  const repo = project({ ".env.example": "A=1\n", ".npmrc": "x=1\n", "a.p12": "\0bin\n" }, { ".npmrc": "x=2\n" });
  const { review: r } = await review(repo, "E   OSError: unable to read a.p12");
  const said = summary(r, "review.md");
  expect(said).toContain(".npmrc");
  expect(said).toContain("a.p12");
  expect(said).not.toContain(".env.example");
  expect(said).toContain("1 more left out (review.md)");
  expect(said.split("named like a secret").length - 1).toBeLessThanOrEqual(1);
  const md = render(r);
  for (const p of [".env.example", ".npmrc", "a.p12"]) expect(md).toContain(p);
  expect(md.split("named like a secret").length - 1).toBeLessThanOrEqual(1);
});

test("the left-out line, nothing touched and no failure: one short count", async () => {
  const repo = project({ ".env.example": "A=1\n", ".npmrc": "x=1\n" });
  const { review: r } = await review(repo, "E   assert 1 == 2");
  const said = summary(r, "review.md");
  expect(said).toContain("2 files left out (review.md)");
  expect(said).not.toContain(".npmrc");
  expect(said).not.toContain("named like a secret");
});

// --- 9. check --review, the name read, words, a stop that cannot be freed, and what the tests prove -------------------------------

test("check --review says a file holds a fake, not that it is left out", async () => {
  const repo = project({ "tests/data/server.pem": pem });
  const { rdir } = await review(repo, "E   assert 1 == 5");
  const r = await recheckReview(repo, rdir, SETTINGS, { sessionFactory: fakeFactory((_c, _n, dir) =>
    [junitXml([[GEN, "test_add", realIn(dir) ? "passed" : "failed", "E   ValueError: Could not deserialize key data."]]), "1 failed\n", false]) });
  const [said, code] = recheckSummary(r);
  expect(code).toBe(2);
  expect(said).not.toContain("left out");
  expect(said).toContain("arnx allow-secret");
});

test("with two fakes the unproven line cannot tell which, even when the failure names one: it does not guess", async () => {
  const two = { "a_deploy/real.key": pem, "tests/data/server.pem": pem };
  const reviewReal = (message: string) => runReview(project(two), { settings: SETTINGS, agentModel: new RecordingAgent(WRITE(), REPORT),
    challenger: new RecordingJson(), progress: () => {}, sessionFactory: fakeFactory((_c, _n, dir) =>
      [junitXml([[GEN, "test_add", realIn(dir) ? "passed" : "failed", message]]), "1 run\n", false]) });
  const { review: r } = await reviewReal("E   ValueError: Could not deserialize key data.");
  expect(r.couldNotRun?.[0]?.needs).toBe("a faked file");
  const said = summary(r, "review.md");
  expect(said).toContain("arnx allow-secret PATH");
  expect(said).not.toContain("allow-secret a_deploy");
  const named = await reviewReal(`> load(open("tests/data/server.pem"))\nE   ValueError: Could not deserialize key data.`);
  expect(named.review.couldNotRun?.[0]?.needs).toBe("a faked file");
});

test("allow-secret's words: a new key-like string gets a stand-in", async () => {
  const repo = project({ "d.py": `A = "AKIA${"IOSFODNN7EXAMPLE"}"\n` });
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("allow-secret", "d.py")).toBe(0);
  expect(cli.stdout).toContain("gets a stand-in");
  expect(cli.stdout).not.toContain("withholds");
});

test("a pinned big binary holding a key is reviewed, with no stop; a pinned file too large to read says so and does not tell you to allow", () => {
  const bin = Buffer.concat([Buffer.alloc(16), Buffer.from("x\n".repeat(600_000)), Buffer.from(pem)]);
  const repo = project();
  put(repo, "b.bin", bin);
  commit(repo, "only the binary");
  const cli = new Cli({ cwd: repo });
  return cli.run("allow-secret", "b.bin").then(async (code) => {
    expect(code).toBe(0);
    const pins = (await import("../src/config")).readSecretPins(repo);
    expect(resolveChange(repo, null, pins).withheld).toBeUndefined();
    const big = project();
    const pad = "// padding line\n".repeat(2000);
    put(big, "t.ts", `${pad}end\n`);
    commit(big, "large");
    changeLimits.maxScanBytes = 1000;
    try {
      put(big, "t.ts", `${pad}${pem}end\n`);
      commit(big, "a key in it");
      const pin = [{ path: "t.ts", matches: [(await import("../src/change")).pinOfFile(join(big, "t.ts"))!] }];
      expect(() => resolveChange(big, null, pin)).toThrow("too large");
      expect(() => resolveChange(big, null, pin)).not.toThrow("allow the file");
    } finally {
      changeLimits.maxScanBytes = 32_000_000;
    }
  });
});

test("a file over the token cap is left out and named; a view of an allowed one stays quick", () => {
  const many = Array.from({ length: BIG_KEYS_MOST + 1 }, (_, i) => `tok${String(i).padStart(9, "0")}`).join("\n");
  const text = `${HDR}\n${many}\n${END}\n`;
  expect(keyTokens(text).size).toBe(BIG_KEYS_MOST + 1);
  const repo = project({ "many.txt": "x\n" }, { "many.txt": text });
  const left = takeSnapshot(repo, null, join(mkdtempSync(join(tmp(), "s-")), "s"), [], { standIns: true }).withheld;
  expect(left).toEqual([{ path: "many.txt", line: 1, label: `over ${BIG_KEYS_MOST} key tokens` }]);
  expect(resolveChange(repo).withheld?.map((w) => w.path)).toEqual(["many.txt"]);
  const at = performance.now();
  expect(fakeKeys(text, { view: true }).text.length).toBe(text.length);
  expect(performance.now() - at).toBeLessThan(2000);
});

test("arnx cloud is given a line of 1 or more for a file left out by its name", async () => {
  const repo = setupRepo({ ".env.example": "A=1\n" });
  const cloud = fakeCloud({ setup: [{ type: "done", stop: "end_turn" }] } as never);
  try {
    await runSetup(repo, defaultSettings(), null, { outDir: join(tmp(), "setup"), progress: () => {},
      brain: new CloudBrain({ boundary: new Boundary(), client: new CloudClient(cloud.url, { token: TOKEN, delays: [0] }), tier: "medium" }),
      sessionFactory: fakeFactory(() => [junitXml([["test_shop.py", "test_a", "passed", ""]]), "ok\n", false]) }).catch(() => null);
    const start = cloud.seen.find((x) => x.path === "/v1/setup")!.body as { withheld_files: { path: string; line: number }[] };
    expect(start.withheld_files.find((f) => f.path === ".env.example")!.line).toBe(1);
  } finally {
    cloud.stop();
  }
});


test("a key's short last line with no digit, + or / is kept in the sandbox and faked in the view", () => {
  const text = withLastLine(lastLine);
  expect(fakeKeys(text).text).toContain(lastLine);
  expect(fakeKeys(text, { view: true }).text).not.toContain(lastLine);
  const digit = withLastLine("AbCdEfGhIjKlMnOpQrStUv7x");
  expect(fakeKeys(digit).text).not.toContain("AbCdEfGhIjKlMnOpQrStUv7x");
});

test("the diff shows a faked last line the sandbox keeps, when the line reads as a name (the flaky case, built)", () => {
  const key = withLastLine(lastLine);
  const repo = project({ "k.txt": `${key}# one\n` }, { "k.txt": `${key}# two\n` });
  const dest = join(mkdtempSync(join(tmp(), "s-")), "s");
  takeSnapshot(repo, "HEAD", dest, [], { standIns: true });
  const sandbox = readFileSync(join(dest, "k.txt"), "utf8");
  const diff = resolveChange(repo).diff;
  const context = diff.slice(diff.indexOf("k.txt")).split("\n").filter((l) => l.startsWith(" ") && l.length > 8 && !l.includes("-----"))
    .map((l) => l.slice(1));
  expect(context.length).toBeGreaterThan(0);
  expect(sandbox).toContain(lastLine);
  expect(context).not.toContain(lastLine);
  expect(context.filter((l) => !sandbox.includes(l))).toHaveLength(1);
});
