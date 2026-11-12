// A file holding a private key stays in: only the key is replaced. The sandbox holds a fake, the wire `[private key]`, and a
// failure the fake may cause reads as unproven. Keys are built at run time.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Workspace } from "../src/agent";
import { Boundary } from "../src/boundary";
import { resolveChange, takeSnapshot } from "../src/change";
import { check, checkSummary } from "../src/check";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp, stampFile } from "../src/config";
import { changedDefinitions } from "../src/context";
import { exitCode, render, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import * as secrets from "../src/secrets";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { Cli } from "./helpers/cli";
import { fakeFactory, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { RecordingAgent, RecordingJson, treeText } from "./helpers/recording";
import { useTmp } from "./helpers/tmp";

const { fakeKeys, looksLikeName, maskPrivateKeys, secretPins } = secrets;
const tmp = useTmp();
const KEY = "PRIVATE " + "KEY";
const HDR = `-----BEGIN ${KEY}-----`, END = `-----END ${KEY}-----`;
const SHOWN = "[private key]";
// The key's last base64 character is made a digit: a last line with no digit, `+` or `/` reads as a name, which the sandbox
// keeps and a view fakes (about 1 draw in 100), and no test here should hang on that.
const pem = (generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string)
  .replace(/[A-Za-z0-9+/](=*\n-----END)/, "7$1");
const lines = pem.split("\n").filter((l) => l && !l.startsWith("-----"));
const der = lines.join("");
const random = randomBytes(1200).toString("base64").match(/.{1,64}/g)!;
const put = (repo: string, path: string, content: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};
const clean = (what: string, sent: string, body: string[] = lines) => {
  const found = body.filter((l) => l.length >= 8 && !looksLikeName(l) && sent.includes(l)).length;
  if (found) throw new Error(`${what}: ${found} of ${body.length} body lines`);
};
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python3 -m pytest -q -p no:cacheprovider {targets}\n";
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
const snap = (repo: string, head: string | null = null, pins: secrets.SecretPin[] = []) => {
  const dest = join(mkdtempSync(join(tmp(), "s-")), "s");
  return { dest, ...takeSnapshot(repo, head, dest, pins, { standIns: true }) };
};
/** A run in this process, with the system's python: nothing else from the machine reaches it. */
const pytest: SessionFactory = async (_cfg, at, _log, body) => body({
  run(command: string, timeout: number) {
    const c = command.replaceAll("/src/", `${at}/`).replaceAll("/src", at);
    const r = spawnSync("sh", ["-c", c], { cwd: at, encoding: "utf8", timeout: timeout * 1000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: "1" } });
    return { exitCode: r.status, output: (r.stdout ?? "") + (r.stderr ?? ""), timedOut: false, seconds: 0.2 };
  },
  // The rerun with the real key: in the copy it is given, its output dropped.
  sealed(command: string, timeout: number, src: string) {
    const c = command.replaceAll("/src/", `${src}/`).replaceAll("/src", src);
    const r = spawnSync("sh", ["-c", c], { cwd: src, stdio: "ignore", timeout: timeout * 1000,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, PYTHONDONTWRITEBYTECODE: "1" } });
    return { exitCode: r.status, timedOut: false };
  } });
const hasPytest = spawnSync("python3", ["-m", "pytest", "--version"]).status === 0;
/** How long a test may take that runs real pytest several times: on a loaded machine that passes bun's default. */
const REAL_PYTEST_MS = 30_000;

// --- rule 1: stays in, with a fake --------------------------------------------------------------------------------------------

const JSONFORM = JSON.stringify({ k: pem });
const CODE = `KEY = """${pem}"""\n\ndef load():\n    return KEY\n`;
for (const [path, content] of [["keys.py", CODE], ["config/k.json", `${JSONFORM}\n`], ["certs/server.pem", pem],
  ["certs/server.key", pem], ["tests/fixtures/a.txt", pem]] as const) {
  test(`a file with a key stays in the snapshot with a fake: ${path}`, () => {
    const repo = project({ [path]: content });
    const s = snap(repo);
    expect(s.withheld.map((w) => w.path)).not.toContain(path);
    expect(s.fakedKeys).toEqual([path]);
    const held = readFileSync(join(s.dest, path), "utf8");
    expect(held).toContain(HDR);
    expect(held).toContain(END);
    clean(path, held);
    expect(held.length).toBe(content.length);
    // All that is not a token stays as it was.
    const shape = (t: string) => t.replace(/[A-Za-z0-9+/=_-]{8,}/g, (m) => `${m.length}`);
    expect(shape(held.replaceAll(HDR, "H").replaceAll(END, "E"))).toBe(shape(content.replaceAll(HDR, "H").replaceAll(END, "E")));
  });
}

test("what is not a key's token stays: quotes, comments, escapes, line ends, code outside, and `${x}`, `{x}`, `<x>`", () => {
  const body = lines[0]!;
  const text = `a = "${HDR}\\n${body}\\n${body}\\r\\n${END}\\n"\r\n# ${HDR}\r\n# ${body}\r\n# ${END}\r\nconst b = \`${HDR}\${signingPrivateKey}{anotherPlaceholder}<yetAnotherPlaceholder>${END}\`;\nkept_name_here = 1\n`;
  const out = fakeKeys(text).text;
  expect(out).not.toContain(body);
  expect(out.split("\n").length).toBe(text.split("\n").length);
  expect(out.length).toBe(text.length);
  for (const stays of ['a = "', "\\n", "\\r\\n", "\r\n# ", "${signingPrivateKey}", "{anotherPlaceholder}", "<yetAnotherPlaceholder>",
    "kept_name_here = 1\n", HDR, END]) expect(out).toContain(stays);
  // Each token keeps its length, and the same token gets the same fake.
  const [one, two] = [...out.matchAll(new RegExp(`\\\\n([A-Za-z0-9+/=]{${body.length}})(?=\\\\)`, "g"))].map((m) => m[1]);
  expect(one).toBe(two);
  expect(fakeKeys(text).text).toBe(out);
});

test("the same key has the same fake on the base side, the change side and in the diff", () => {
  const repo = project({ "k.txt": `${pem}\n# one\n` }, { "k.txt": `${pem}\n# two\n` });
  const a = readFileSync(join(snap(repo, "HEAD^").dest, "k.txt"), "utf8"), b = readFileSync(join(snap(repo, "HEAD").dest, "k.txt"), "utf8");
  expect(a.replace("# one", "")).toBe(b.replace("# two", ""));
  clean("base", a);
  const c = resolveChange(repo);
  expect(c.withheld).toBeUndefined();
  clean("the diff", c.diff);
  const section = c.diff.slice(c.diff.indexOf("k.txt"));
  expect(b).toContain(section.split("\n").find((l) => l.startsWith(" ") && l.length > 8 && !l.includes("-----"))!.slice(1));
});

test("the build context holds the fake too", () => {
  const guess = 'API_TOKEN = "abcDEF123ghiJKL456"\n';
  const repo = project({ "k.txt": pem, "conf.py": guess });
  const s = snap(repo);
  clean("the snapshot", treeText(s.dest));
  expect(treeText(`${s.dest}.build`)).toContain(HDR);
  clean("the build context", treeText(`${s.dest}.build`));
});

// --- rule 2: no END -----------------------------------------------------------------------------------------------------------

for (const [name, form] of [
  ["real line ends", (l: string[]) => `${HDR}\n${l.join("\n")}\nnext_line(1)\n`],
  ["written \\n", (l: string[]) => `x = "${HDR}\\n${l.join("\\n")}\\n"\nnext_line(1)\n`],
  ["concatenated with +", (l: string[]) => `x = "${HDR}\\n" +\n  "${l.join('\\n" +\n  "')}"\nnext_line(1)\n`],
  ["concatenated with .", (l: string[]) => `$x = "${HDR}" .\n  "${l.join('" .\n  "')}";\nnext_line(1);\n`],
  ["a string array", (l: string[]) => `x = ["${HDR}", "${l.join('", "')}"]\nnext_line(1)\n`],
] as const) {
  test(`no END, ${name}: the header line stays, the run gets a fake, and the code after it stays`, () => {
    const text = form(random);
    const out = fakeKeys(text).text;
    expect(out).toContain(HDR);
    clean(name, out, random);
    expect(out).toContain("next_line(1)");
    expect(out.length).toBe(text.length);
    const masked = maskPrivateKeys(text);
    clean(`${name}, the wire`, masked, random);
    expect(masked).toContain(SHOWN);
    expect(masked).toContain("next_line(1)");
  });
}

test("a bare header takes no code: the name on the next line, a call, a keyword", () => {
  for (const code of [`HDR = "${HDR}"\nsome_long_variable = 1\n`, `if p.startswith("${HDR}"):\n    do_something_now(p)\n`,
    `f("${HDR}").startswith_something(1)\n`, `# ${HDR}\nfunction someLongName() {}\n`]) {
    expect(fakeKeys(code).text).toBe(code);
    expect(maskPrivateKeys(code)).toBe(code.replace(HDR, SHOWN));
  }
});

test("no header: the key's start, its run and such a continuation get a fake, and the wire hides them", () => {
  const text = `x = "${der}"\nnext_line(1)\n`;
  const out = fakeKeys(text).text;
  clean("whole", out);
  expect(out).not.toContain(der.slice(0, 64));
  expect(out).toContain("next_line(1)");
  const wrapped = `y = (\n  "${lines.join('"\n  "')}"\n)\nnext_line(1)\n`;
  clean("wrapped", fakeKeys(wrapped).text);
  clean("wrapped, the wire", maskPrivateKeys(wrapped));
  expect(maskPrivateKeys(wrapped)).toContain("next_line(1)");
});

// --- a token that looks like an identifier is no key's text ---------------------------------------------------------------------

test("between a header and END a name stays in the sandbox, and the wire still hides it all", () => {
  const code = `assert "${HDR}" in private_pem\nassert "${END}" in private_pem\n`;
  expect(fakeKeys(code).text).toBe(code);
  const cert = `c = client_cert.replace("${HDR}", x)\nclient_cert = client_cert.replace(\n  "${END}\\n-----BEGIN CERTIFICATE-----", y)\n`;
  expect(fakeKeys(cert).text).toBe(cert);
  expect(maskPrivateKeys(code)).toBe(`assert "${SHOWN}" in private_pem\n`);
});

test("what counts as a name: 32 characters or fewer with no digit, + or /; anything else gets its fake", () => {
  const under = (t: string) => fakeKeys(`${HDR}\n${t}\n${END}\n`).text.includes(t);
  for (const t of ["private_pem", "client-cert-value", "a".repeat(32), "not-a-valid-key"]) expect(under(t)).toBe(true);
  for (const t of ["a".repeat(33), "abcdefg1", "abcd+efg", "abcd/efg"]) expect(under(t)).toBe(false);
});

test("a no-END run stops at a name: shorthand names stay in the sandbox and read normally to a model", () => {
  const text = `const a = {\n  privateKey: "${HDR}",\n  clientEmail,\n  projectId,\n  tokenUri,\n};\n`;
  expect(fakeKeys(text).text).toBe(text);
  expect(maskPrivateKeys(text)).toBe(text.replace(HDR, SHOWN));
  const stops = `${HDR}\n${random[0]}\nclientEmail\nprojectId\n${random[1]}\n`;
  expect(fakeKeys(stops).text).not.toContain(random[0]!);
  expect(fakeKeys(stops).text).toContain(`clientEmail\nprojectId\n${random[1]}`);
  expect(maskPrivateKeys(stops)).toBe(`${SHOWN}\nclientEmail\nprojectId\n${random[1]}\n`);
});

// --- rule 3: the wire filter ----------------------------------------------------------------------------------------------------

test("the filter: header to END, a stray END with only base64 lines before it, and no END left", () => {
  expect(maskPrivateKeys(`head\n${pem}tail\n`)).toBe(`head\n${SHOWN}\ntail\n`);
  expect(maskPrivateKeys(`code = 1\n${lines.slice(0, 3).join("\n")}\n${END}\nafter\n`)).toBe(`code = 1\n${SHOWN}\nafter\n`);
  expect(maskPrivateKeys(`FOOTER = "${END}"\nkept\n`)).toBe(`FOOTER = "${SHOWN}"\nkept\n`);
  expect(maskPrivateKeys(`task head\nsome text here\n\`\`\`\n${END}\n`)).toBe(`task head\nsome text here\n\`\`\`\n${SHOWN}\n`);
});

test("the filter is idempotent, and a text placed in a bigger one loses nothing: no END stays in what it leaves", () => {
  for (const text of [`a\n${END}\nb\n${END}\nc`, `${HDR}\nabc\n${END}\nb\n${END}\nc`, `${HDR}\nabc\n${END}\n${HDR}\nabc\n${END}\n`,
    `pem = "${HDR}"\nassert pem.endswith("${END}")\nassert pem.endswith("${END}")\n`, `a ${HDR} b`, pem, der, `x ${END}`]) {
    const once = maskPrivateKeys(text);
    expect(once).not.toContain("-----END");
    expect(maskPrivateKeys(once)).toBe(once);
    const bigger = `THE TASK\n<failure>${once}</failure>\nTHE REPLY FORMAT`;
    expect(maskPrivateKeys(bigger)).toBe(bigger);
  }
});

test("the ordinary key test costs the judge nothing", () => {
  const test1 = `def test_is_key():\n    pem = "${HDR}"\n    assert pem.startswith("${HDR}")\n    assert pem.endswith("${END}")\n`;
  const prompt = `THE TASK\n<test>\n${test1}</test>\n<failure>E  ${END}\nE  ${END}</failure>\nTHE REPLY FORMAT`;
  const out = maskPrivateKeys(prompt);
  expect(out).toContain("THE TASK");
  expect(out).toContain("THE REPLY FORMAT");
  expect(out).toContain("def test_is_key");
  expect(out).not.toContain("-----END");
});

test("a header in one section of a diff does not take the next section's END with it", () => {
  const diff = `diff --git a/a.py b/a.py\n+x = "${HDR}"\n+kept_in_a = 1\ndiff --git a/b.py b/b.py\n+y = "${END}"\n+kept_in_b = 1\n`;
  const out = maskPrivateKeys(diff);
  expect(out).toContain("kept_in_a");
  expect(out).toContain("diff --git a/b.py");
  expect(out).toContain("kept_in_b");
  clean("a printed key over a section line", maskPrivateKeys(`${HDR}\ndiff --git x\n${random.join("\n")}\n${END}\n`), random);
});

// --- rule 4: the diff is not sealed for keys ------------------------------------------------------------------------------------

test("a section with a key stays, its body faked, a hunk with no header too; the wire hides the rest", async () => {
  const repo = project({ "keys.py": `KEY = """${pem}"""\nVERSION = 1\n` }, { "keys.py": `KEY = """${pem}"""\nVERSION = 2\n` });
  const c = resolveChange(repo);
  expect(c.withheld).toBeUndefined();
  expect(c.files).toContain("keys.py");
  expect(c.diff).toContain("+VERSION = 2");
  clean("the diff", c.diff);
  // An edit inside the key, with neither header nor END in the hunk.
  const repo2 = project({ "k.txt": pem }, { "k.txt": pem.replace(lines[12]!, lines[12]!.split("").reverse().join("")) });
  const inside = resolveChange(repo2);
  expect(inside.withheld).toBeUndefined();
  clean("the hunk", inside.diff);
  expect(inside.diff).not.toContain(lines[12]!.split("").reverse().join(""));
  const agent = new RecordingAgent(WRITE(), REPORT), judge = new RecordingJson();
  const { rdir } = await runReview(repo2, { settings: SETTINGS, agentModel: agent, challenger: judge, progress: () => {},
    sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "failed", "assert 1 == 5"]]), "1 failed\n", false]) });
  clean("the model", agent.bodies.join("\n"));
  clean("the judge", judge.bodies.join("\n"));
  clean("what is saved", treeText(rdir));
});

test("a change of only a key file is reviewed, with no stop", () => {
  const repo = project({ "k.txt": "x\n" });
  put(repo, "k.txt", pem);
  commit(repo, "only the key");
  const c = resolveChange(repo);
  expect(c.withheld).toBeUndefined();
  expect(c.files).toEqual(["k.txt"]);
  clean("the diff", c.diff);
});

test("a .pem or .key holding a key is in the diff; one holding none stays out by its name", () => {
  const repo = project({ "a.pem": pem, "b.key": pem, "c.pem": "not a key\n", ".env": "A=1\n" },
    { "a.pem": `${pem}# a\n`, "b.key": `${pem}# b\n`, "c.pem": "still not a key\n", ".env": "A=2\n" });
  const c = resolveChange(repo);
  expect(c.files).toContain("a.pem");
  expect(c.files).toContain("b.key");
  expect(c.files).not.toContain("c.pem");
  expect(c.files).not.toContain(".env");
  expect(c.diff).toContain("+# a");
  expect(c.diff).not.toContain("still not a key");
  clean("the diff", c.diff);
});

test("an uncommitted edit of a .pem holding a key is a change; of a .env it is not", () => {
  const repo = project({ "a.pem": pem, ".env": "A=1\n" });
  put(repo, ".env", "A=2\n");
  expect(resolveChange(repo).kind).toBe("commit");
  put(repo, "a.pem", `${pem}# a\n`);
  const c = resolveChange(repo);
  expect(c.kind).toBe("worktree");
  expect(c.diff).toContain("+# a");
  clean("the diff", c.diff);
});

// --- rule 5: a pin keeps the real key in the sandbox, and changes nothing a model sees ---------------------------------------------

const pinned = (repo: string, path: string, text: string) => [{ path, matches: secretPins(text) }];

/** A pattern that matches `text` as written: a random key line may start with `+` or hold `/`, which a regex reads as syntax. */
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("a key line searched for as a pattern is literal, whatever signs it holds", () => {
  for (const line of ["+Ab3dE6gH9jK2mN5pQ8sT1vW4", "++a/b+c==", "(x)[y]{2}.*?^$|\\"]) {
    expect(new RegExp(literal(line)).test(`before ${line} after`)).toBe(true);
    expect(() => new RegExp(literal(line))).not.toThrow();
  }
});

test("a pin: the sandbox holds the real key; the diff, a read and a search read as without one", async () => {
  const text = `KEY = """${pem}"""\nVERSION = 1\n`;
  const repo = project({ "keys.py": text });
  const pins = pinned(repo, "keys.py", text);
  const s = snap(repo, null, pins);
  expect(s.fakedKeys).toEqual([]);
  expect(readFileSync(join(s.dest, "keys.py"), "utf8")).toBe(text);
  const after = text.replace("VERSION = 1", "VERSION = 2");
  put(repo, "keys.py", after);
  const pins2 = [...pins, ...pinned(repo, "keys.py", after)].reduce((a, p) => [{ path: p.path, matches: [...a[0]?.matches ?? [], ...p.matches] }], [] as secrets.SecretPin[]);
  const c = resolveChange(repo, null, pins2);
  clean("the pinned diff", c.diff);
  expect(c.diff).toContain("+VERSION = 2");
  const tools = new Workspace(s.dest);
  const page = await tools.call("read_file", { path: "keys.py", start_line: 8 });
  clean("a page", page);
  expect(page).not.toContain(SHOWN);
  clean("a search", await tools.call("grep", { pattern: literal(lines[10]!), path: "." }));
  clean("a search for anything", await tools.call("grep", { pattern: "[A-Z]", path: "keys.py" }));
  expect(await tools.call("grep", { pattern: "VERSION", path: "keys.py" })).toContain("VERSION = 1");
});

test("a pinned bare header renames and hides no code", async () => {
  const text = `const a = {\n  privateKey: "${HDR}",\n  clientEmail,\n  projectId,\n  tokenUri,\n};\nexport function changed_function() {\n  return "${HDR}";\n}\n`;
  const repo = project({ "cred.ts": text, "other.py": "clientEmail = 2\n" });
  const pins = pinned(repo, "cred.ts", text);
  const s = snap(repo, null, pins);
  expect(s.suspects.has("clientEmail")).toBe(false);
  const b = new Boundary();
  b.addScrubbed(s);
  expect(b.mask(readFileSync(join(s.dest, "other.py"), "utf8"))).toBe("clientEmail = 2\n");
});

test("what `keyLines`, `keyPieces` and `withKeyLines` served is gone", () => {
  for (const name of ["keyLines", "keyPieces", "withKeyLines", "ownLines"]) expect(name in secrets).toBe(false);
});

test("the definitions a hunter reads go the same way", () => {
  const text = `def changed():\n    # example: ${pem.replaceAll("\n", "\n    # ")}\n    a = 1\n    return a\n`;
  const repo = project({ "x.py": text }, { "x.py": text.replace("a = 1", "a = 2") });
  const s = snap(repo, null, pinned(repo, "x.py", text.replace("a = 1", "a = 2")));
  const diff = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,3 +1,3 @@\n def changed():\n";
  clean("the definitions", changedDefinitions(s.dest, diff, ["x.py"]));
});

test("arnx allow-secret says what a pin does", async () => {
  const repo = project({ "k.txt": pem });
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("allow-secret", "k.txt")).toBe(0);
  const said = cli.stdout.replace(/\s+/g, " ");
  expect(said).toContain("real key");
  expect(said).toContain(SHOWN);
  expect(said).not.toContain("may include");
});

// --- rule 6: a failing test near a faked key ------------------------------------------------------------------------------------

const PARSE = `import base64\nimport re\n\ndef parse(pem):\n    body = "".join(pem.strip().splitlines()[1:-1])\n    der = base64.b64decode(body)\n    if der[:2] != b"\\x30\\x82":\n        raise ValueError("Could not deserialize key data")\n    return der\n`;
const FIXTURE_TEST = "from keyparse import parse\n\ndef test_add():\n    parse(open('tests/data/fixture.txt').read())\n";
const reportFor = (t: string) => JSON.stringify({ tests: [{ test: `${t}::test_add`, expects: "x" }], suspected_defects: [{ test: `${t}::test_add`, explanation: "It broke." }], questions: [] });
const keptTest = (repo: string, content: string) => {
  put(repo, ".arnx/tests/tests/arnx/r1/test_kept.py", content);
};

test("real pytest, a test that parses a fixture key: a fake reads as unproven, and a pin makes it run", async () => {
  if (!hasPytest) return;
  const files = { "tests/data/fixture.txt": pem, "keyparse.py": PARSE };
  const repo = project(files);
  const agent = new RecordingAgent([[tool("write_file", { path: GEN, content: FIXTURE_TEST }), tool("run_tests", {})]], reportFor(GEN));
  const { review: r, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(),
    progress: () => {}, sessionFactory: pytest });
  expect(r.findings).toEqual([]);
  expect(exitCode(r)).toBe(2);
  expect(r.couldNotRun?.[0]?.needs).toBe("tests/data/fixture.txt");
  // The rerun with the real key parsed it and passed: settled, not a guess.
  expect(r.couldNotRun?.[0]?.notRerun).toBeUndefined();
  const said = summary(r, join(rdir, "review.md"));
  expect(said).toContain("tests/data/fixture.txt");
  expect(said).toContain("arnx allow-secret");
  expect(said).not.toContain("No findings and no questions.");
  expect(render(r)).not.toContain("Complete:");
  expect(render(r)).toContain("tests/data/fixture.txt");
  keptTest(repo, FIXTURE_TEST);
  const [text, code] = checkSummary(await check(repo, SETTINGS, { sessionFactory: pytest }));
  expect(code).toBe(2);
  expect(text).toContain("tests/data/fixture.txt");
  expect(text).toContain("arnx allow-secret");
  expect(text).not.toContain("Fix the code");
  // With the file allowed the same test runs and passes.
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("allow-secret", "tests/data/fixture.txt")).toBe(0);
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")), "Dev", "2026-11-04"));
  const again = await check(repo, SETTINGS, { sessionFactory: pytest });
  expect(checkSummary(again)[1]).toBe(0);
}, REAL_PYTEST_MS);

test("the review and setup line names a faked key and the way to the real one, with no failure at all", async () => {
  const repo = project({ "tests/data/fixture.txt": pem });
  const agent = new RecordingAgent(WRITE(), JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "x" }], suspected_defects: [], questions: [] }));
  const { review: r, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(), progress: () => {},
    sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "passed", ""]]), "1 passed\n", false]) });
  expect(exitCode(r)).toBe(0);
  for (const said of [summary(r, join(rdir, "review.md")), render(r)]) {
    expect(said).toContain("tests/data/fixture.txt");
    expect(said).toContain("arnx allow-secret");
  }
  expect(r.notSent).not.toContain("tests/data/fixture.txt");
});

for (const [name, message] of [
  ["names the file in an open failure", "E   OSError: could not open tests/data/fixture.txt"],
  ["names the file in an assert", "E   assert 'tests/data/fixture.txt' == 'x'"],
  ["a key that does not parse", "ValueError: Could not deserialize key data"],
  ["openssl's words", "ssl.SSLError: [SSL] PEM lib (_ssl.c:3862)"],
  ["a plain failure", "assert 1 == 5"],
] as const) {
  for (const unproven of [true, false]) {
    test(`a failure beside a faked key reads by the rerun, not its words: ${name}, ${unproven ? "passing" : "failing"} with the real key`, async () => {
      const repo = project({ "tests/data/fixture.txt": pem });
      const real = (dir: string) => readFileSync(join(dir, "tests/data/fixture.txt"), "utf8") === pem;
      const { review: r } = await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent(WRITE(), REPORT), challenger: new RecordingJson(),
        progress: () => {}, sessionFactory: fakeFactory((_c, _n, dir) => [junitXml([[GEN, "test_add", unproven && real(dir) ? "passed" : "failed", message]]),
          "1 failed\n", false]) });
      expect(r.findings.length).toBe(unproven ? 0 : 1);
      expect(exitCode(r)).toBe(unproven ? 2 : 0);
    });
  }
}

test("no faked key, a failure about a key is a finding", async () => {
  const repo = project();
  const { review: r } = await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent(WRITE(), REPORT), challenger: new RecordingJson(),
    progress: () => {}, sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "failed", "ValueError: Could not deserialize key data"]]), "1 failed\n", false]) });
  expect(r.findings.length).toBe(1);
  expect(exitCode(r)).toBe(0);
});

// --- rule 7: what still leaves -----------------------------------------------------------------------------------------------------

test("a file left out by its name: named, models told, and a failure naming it is unproven", async () => {
  const repo = project({ "tests/data/ca.pem": "not a key\n", ".env.example": "A=1\n" });
  const agent = new RecordingAgent(WRITE(), REPORT);
  const { review: r, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(), progress: () => {},
    sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "failed", "E   OSError: could not open tests/data/ca.pem"]]), "1 failed\n", false]) });
  expect(r.findings).toEqual([]);
  expect(exitCode(r)).toBe(2);
  expect(r.notSent).toEqual([".env.example", "tests/data/ca.pem"]);
  const said = summary(r, join(rdir, "review.md"));
  expect(said).toContain("tests/data/ca.pem");
  expect(said).toContain("arnx allow-secret");
  expect(render(r)).toContain("tests/data/ca.pem");
  expect(agent.bodies[0]).toContain("`tests/data/ca.pem`");
});

test("real pytest, a file left out by its name: a failure naming it is unproven, and allowing it lets the test run", async () => {
  if (!hasPytest) return;
  const FIRST = "def test_add():\n    assert open('tests/data/server.key').read() == 'not a key\\n'\n";
  const repo = project({ "tests/data/server.key": "not a key\n" });
  const run = () => runReview(repo, { settings: SETTINGS, challenger: new RecordingJson(), progress: () => {}, sessionFactory: pytest,
    agentModel: new RecordingAgent([[tool("write_file", { path: GEN, content: FIRST }), tool("run_tests", {})]], reportFor(GEN)) });
  const { review: r } = await run();
  expect(r.findings).toEqual([]);
  expect(exitCode(r)).toBe(2);
  expect(r.couldNotRun?.[0]).toMatchObject({ needs: "tests/data/server.key" });
  keptTest(repo, FIRST);
  const [text, code] = checkSummary(await check(repo, SETTINGS, { sessionFactory: pytest }));
  expect(code).toBe(2);
  expect(text).toContain("tests/data/server.key");
  expect(text).not.toContain("Fix the code");
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("allow-secret", "tests/data/server.key")).toBe(0);
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")), "Dev", "2026-11-04"));
  expect(checkSummary(await check(repo, SETTINGS, { sessionFactory: pytest }))[1]).toBe(0);
}, REAL_PYTEST_MS);

test("one failing with no name in it stays a failure, and the report says that much", async () => {
  const repo = project({ "tests/data/ca.pem": "not a key\n" });
  const { review: r } = await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent(WRITE(), REPORT), challenger: new RecordingJson(), progress: () => {},
    sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "failed", "assert 1 == 5"]]), "1 failed\n", false]) });
  expect(r.findings.length).toBe(1);
  expect(render(r).replace(/\s+/g, " ")).toContain("A test can fail for one of these with no name in its message");
});

test("arnx allow-secret works on a file left out by its name, whatever it holds; any edit ends it", async () => {
  const repo = project({ "tests/data/ca.pem": "not a key\n", ".env.example": "A=1\n", "bin.p12": "\0\xff binary\n" });
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("allow-secret", "tests/data/ca.pem", ".env.example", "bin.p12")).toBe(0);
  const pins = (await import("../src/config")).readSecretPins(repo);
  const s = snap(repo, null, pins);
  expect(s.withheld).toEqual([]);
  expect(readFileSync(join(s.dest, "tests/data/ca.pem"), "utf8")).toBe("not a key\n");
  expect(readFileSync(join(s.dest, ".env.example"), "utf8")).toBe("A=1\n");
  put(repo, "tests/data/ca.pem", "another\n");
  expect(snap(repo, null, pins).withheld.map((w) => w.path)).toEqual(["tests/data/ca.pem"]);
});

test("a file over the cap is left out and named the same way, and can be allowed", async () => {
  const { changeLimits } = await import("../src/change");
  const was = changeLimits.maxScanBytes;
  changeLimits.maxScanBytes = 2_000_000;
  try {
    const big = "x = 1\n".repeat(400_000);
    const repo = project({ "big.txt": big });
    const s = snap(repo);
    expect(s.withheld.map((w) => [w.path, w.label])).toEqual([["big.txt", "too large to scan"]]);
    const cli = new Cli({ cwd: repo });
    expect(await cli.run("allow-secret", "big.txt")).toBe(0);
    const pins = (await import("../src/config")).readSecretPins(repo);
    const held = snap(repo, null, pins);
    expect(held.withheld).toEqual([]);
    expect(readFileSync(join(held.dest, "big.txt"), "utf8")).toBe(big);
  } finally {
    changeLimits.maxScanBytes = was;
  }
});

test("allow-secret with several paths allows each that qualifies and names each that does not", async () => {
  const { readSecretPins } = await import("../src/config");
  const repo = project({ "a.txt": pem, "b.txt": pem, "plain.txt": "nothing here\n" });
  const all = new Cli({ cwd: repo });
  expect(await all.run("allow-secret", "a.txt", "b.txt")).toBe(0);
  expect(readSecretPins(repo).map((p) => p.path).sort()).toEqual(["a.txt", "b.txt"]);
  expect(all.stdout).not.toContain("nothing to allow");

  const repo2 = project({ "a.txt": pem, "plain.txt": "nothing here\n", "b.txt": pem });
  const mixed = new Cli({ cwd: repo2 });
  expect(await mixed.run("allow-secret", "a.txt", "plain.txt", "gone.txt", "b.txt")).toBe(0);
  expect(readSecretPins(repo2).map((p) => p.path).sort()).toEqual(["a.txt", "b.txt"]);
  expect(mixed.stdout).toContain("! plain.txt: holds nothing that looks like a key");
  expect(mixed.stdout).toContain("! gone.txt: no such file");
  expect(mixed.stdout).toContain("Allowed in");
});

test("allow-secret with no path that qualifies names each one and exits 2", async () => {
  const { readSecretPins } = await import("../src/config");
  const repo = project({ "p.txt": "one\n", "q.txt": "two\n" });
  const none = new Cli({ cwd: repo });
  expect(await none.run("allow-secret", "p.txt", "q.txt")).toBe(2);
  expect(none.stderr + none.stdout).toContain("p.txt: holds nothing that looks like a key; nothing to allow");
  expect(none.stderr + none.stdout).toContain("q.txt: holds nothing that looks like a key; nothing to allow");
  expect(readSecretPins(repo)).toEqual([]);
});

const LAST_LINE_LINES = [0, 1, 2].map((i) => String(i + 1).repeat(64));
const LAST_LINE = "abcdefghijklmnopqrstuvwxyzabcdef";
test("a key's last line of letters alone is replaced", () => {
  const doc = [HDR, ...LAST_LINE_LINES, LAST_LINE, END, ""].join("\n");
  expect(secrets.keyTokens(doc)).toContain(LAST_LINE);
  expect(fakeKeys(doc).text).not.toContain(LAST_LINE);
});
test("the same with CRLF line ends", () => {
  expect(fakeKeys([HDR, ...LAST_LINE_LINES, LAST_LINE, END, ""].join("\r\n")).text).not.toContain(LAST_LINE);
});
test("a placeholder between header and END keeps its words", () => {
  const doc = [HDR, "yourprivatekeygoeshere", END, ""].join("\n");
  expect(fakeKeys(doc)).toEqual({ text: doc, count: 0 });
});
