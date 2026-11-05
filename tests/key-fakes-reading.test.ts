// How a failure near a fake is read, and what a view shows of a key: narrow words, the same fake everywhere, and a file left out
// that does not stop or crowd out the rest. Keys are built at run time.
import { expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const body = pem.split("\n").filter((l) => l && !l.startsWith("-----")).join("");
const der = body;
const wrapped = (w: number) => `${HDR}\n${body.match(new RegExp(`.{1,${w}}`, "g"))!.join("\n")}\n${END}\n`;
const piecesOf = (w: number) => body.match(new RegExp(`.{1,${w}}`, "g"))!;
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
const mark = (message: string, leftOut: string[] = [], fakedKeys = ["tests/data/server.pem"]) => markUnproven(
  [{ testId: "t.py::a", fileAttr: "t.py", name: "a", outcome: "failed", message }], { leftOut, fakedKeys, all: [...leftOut, ...fakedKeys] })[0]!;
/** As pytest writes a failure: its short message, the source lines, the exception on `E` lines. */
const pytest = (source: string, ...exception: string[]) => `${exception[0]}\n${source.split("\n").map((l) => `    ${l}`).join("\n")}\n${exception.map((l) => `E   ${l}`).join("\n")}\n\napp.py:3: ${exception[0]!.split(":")[0]}`;

// --- 1. the exception's own last line ------------------------------------------------------------------------------------------

for (const [row, message] of [
  ["a local named for base64", pytest("encoded_as_base64 = 3\n> assert encoded_as_base64 == 2", "assert 3 == 2")],
  ["a local named pem, the raise inside it", pytest("pem = load()\n> raise ValueError('nope')", "ValueError: nope")],
  ["a source line that says base64", pytest("> return base64.b64encode(None)", "TypeError: a bytes-like object is required")],
  ["binascii", pytest("> decode(x)", "binascii.Error: Incorrect padding")],
  ["bare pem, lower case", pytest("> load(x)", "ValueError: bad pem in config")],
  ["a source line with the words", pytest("# could not parse the private key\n> assert 1 == 2", "assert 1 == 2")],
  ["the file's name in an assert", pytest("> assert p == q", "assert 'tests/data/server.pem' == 'tests/data/other.pem'")],
] as const) {
  test(`a real failure beside a fake is a finding: ${row}`, () => {
    expect(mark(message).needs).toBeUndefined();
    expect(mark(message).outcome).toBe("failed");
  });
}

for (const [row, line] of [
  ["cryptography", "ValueError: Could not deserialize key data. The data may be in an incorrect format."],
  ["ssl", "ssl.SSLError: [SSL] PEM lib (_ssl.c:3851)"],
  ["PyCryptodome", "ValueError: RSA key format is not supported"],
  ["paramiko", "paramiko.ssh_exception.SSHException: not a valid RSA private key file"],
  ["rsa", "pyasn1.error.PyAsn1Error: BER length field size 71 exceeds limit (8)"],
  ["PyJWT", "jwt.exceptions.InvalidKeyError: Expecting a PEM-formatted key."],
  ["node", "Error: error:1E08010C:DECODER routines::unsupported"],
  ["node's ASN.1", "Error: error:0680007B:ASN.1 encoding routines::header too long"],
] as const) {
  test(`a key that does not parse is unproven: ${row}`, () => {
    expect(mark(pytest("> load(x)", line)).needs).toBe("a faked file");
    expect(mark(line).needs).toBe("a faked file");
    // A chained exception reads by its last one.
    expect(mark(pytest("> load(x)", "KeyError: 'a'", "", "During handling of the above exception", line)).needs).toBe("a faked file");
  });
}

test("a name counts in a missing-file or open-failure line only, for a fake and for a file left out", () => {
  expect(mark("E   OSError: could not open tests/data/server.pem").needs).toBe("tests/data/server.pem");
  expect(mark("E   FileNotFoundError: [Errno 2] No such file or directory: 'tests/data/server.pem'").needs).toBe("tests/data/server.pem");
  expect(mark("E   assert 'tests/data/ca.p12' == 'x'", ["tests/data/ca.p12"], []).needs).toBeUndefined();
  expect(mark("E   OSError: unable to read tests/data/ca.p12", ["tests/data/ca.p12"], []).needs).toBe("tests/data/ca.p12");
});

// --- 2. the words at the fail point -------------------------------------------------------------------------------------------

const FIX = "Fix the code; if this test needs a real key: `arnx allow-secret PATH`";
test("a finding beside a fake says fix the code, and how to run it with the real key", async () => {
  const repo = project({ "tests/data/server.pem": pem });
  const { review: r } = await review(repo, "E   assert 1 == 2");
  expect(exitCode(r)).toBe(1);
  expect(summary(r, "review.md")).toContain(FIX);
  expect(render(r).replace(/\s+/g, " ")).toContain(FIX);
  put(repo, ".arnx/tests/tests/arnx/r1/test_kept.py", SOURCE);
  const [said, code] = checkSummary(await check(repo, SETTINGS, { sessionFactory: fakeFactory(() =>
    [junitXml([["tests/arnx/r1/test_kept.py", "test_add", "failed", "E   assert 1 == 2"]]), "1 failed\n", false]) }));
  expect(code).toBe(1);
  expect(said).toContain(FIX);
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
  const repo = project({ "k.txt": `${wrapped(64)}# one\n` }, { "k.txt": `${wrapped(64)}# two\n` });
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
const setupWith = (repo: string, rows: [string, string, string, string][]) => runSetup(repo, defaultSettings(),
  new ScriptedAgent([[tool("propose", { yaml: SETUP_YAML })], [text("done")]]), { outDir: join(tmp(), "setup"), progress: () => {},
    sessionFactory: fakeFactory(() => [junitXml(rows), "ran\n", false]) });

test("setup: a test failing on the fake is no failure of the project: not in the baseline, listed as needing the key", async () => {
  const repo = setupRepo({ "tests/data/server.pem": pem });
  const r = await setupWith(repo, [["test_shop.py", "test_ok", "passed", ""],
    ["test_shop.py", "test_key", "failed", "E   ValueError: Could not deserialize key data. Open tests/data/server.pem"]]);
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
  const r = await recheckReview(repo, rdir, SETTINGS, { sessionFactory: fakeFactory(() =>
    [junitXml([[GEN, "test_add", "failed", "E   ValueError: Could not deserialize key data."]]), "1 failed\n", false]) });
  const [said, code] = recheckSummary(r);
  expect(code).toBe(2);
  expect(said).not.toContain("left out");
  expect(said).toContain("arnx allow-secret");
});

test("the unproven line names the file the failure read; with two fakes and a computed path it does not guess", async () => {
  const two = { "a_deploy/real.key": pem, "tests/data/server.pem": pem };
  const repo = project(two);
  const { review: r } = await review(repo, "E   ValueError: Could not deserialize key data.");
  expect(r.couldNotRun?.[0]?.needs).toBe("a faked file");
  const said = summary(r, "review.md");
  expect(said).toContain("arnx allow-secret PATH");
  expect(said).not.toContain("allow-secret a_deploy");
  const named = await review(project(two), `> load(open("tests/data/server.pem"))\nE   ValueError: Could not deserialize key data.`);
  expect(named.review.couldNotRun?.[0]?.needs).toBe("tests/data/server.pem");
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
