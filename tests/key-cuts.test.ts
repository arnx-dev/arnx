// What arnx cuts is masked first, what it saves is not, and a pin is usable. Keys are built at run time.
import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accept } from "../src/accept";
import { getAdapter } from "../src/adapters";
import { Workspace } from "../src/agent";
import { Boundary } from "../src/boundary";
import { resolveChange } from "../src/change";
import { check } from "../src/check";
import { CloudClient } from "../src/cloud";
import { CloudBrain } from "../src/cloudbrain";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp } from "../src/config";
import { describeRun } from "../src/outcomes";
import { DEFAULT_PROMPTS } from "../src/prompts";
import { runReview } from "../src/reviewer";
import { fakeKeys, holdsPrivateKey, looksLikeName, maskPrivateKeys, secretHits, secretPins } from "../src/secrets";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { noReport, probe } from "../src/setup";
import { Cli } from "./helpers/cli";
import { type FakeCloud, fakeCloud, type StepScript, TOKEN } from "./helpers/cloudfake";
import { fakeFactory, type FakeSession, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { RecordingAgent, RecordingJson, treeText } from "./helpers/recording";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SHOWN = "[private key]";
const KEY = "PRIVATE " + "KEY";
const HDR = `-----BEGIN ${KEY}-----`, END = `-----END ${KEY}-----`;
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = rsa.privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const der = rsa.privateKey.export({ type: "pkcs8", format: "der" }) as Buffer;
const b64 = der.toString("base64");
const random = randomBytes(1200).toString("base64");
const wrap = (text: string, w: number) => text.match(new RegExp(`.{1,${w}}`, "g"))!;
const block = (body: string) => `${HDR}\n${wrap(body, 64).join("\n")}\n${END}\n`;
const bodyLines = (body: string) => wrap(body, 64);
const clean = (what: string, sent: string, lines: string[]) => {
  // Where the fake is what counts, a short line or one that reads as a name keeps its text by rule; the wire hides those too.
  const held = /diff|fake/.test(what) ? lines.filter((l) => l.length >= 8 && !looksLikeName(l)) : lines;
  const found = held.filter((l) => l.length >= 4 && sent.includes(l)).length;
  if (found) throw new Error(`${what}: ${found} of ${lines.length} body lines`);
};
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const CFG = parseReviewConfig(YAML);
const GEN = "tests/arnx_generated/test_add.py";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };
const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: [] });
const SOURCE = "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n";
const editApp = (repo: string, to = "a - b") => writeFileSync(join(repo, "app.py"), `def add(a, b):\n    return ${to}\n`);
const put = (repo: string, path: string, content: string | Buffer) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};
function configured(extra = ""): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML + extra), "Dev", "2026-11-04"));
  writeSettings(repo, SETTINGS);
  commit(repo, "set up");
  return repo;
}
let clouds: FakeCloud[] = [];
afterEach(() => {
  for (const c of clouds) c.stop();
  clouds = [];
});

// --- masked before each cut -----------------------------------------------------------------------------------------------

const ORDINARY = "ordinary runner output\n";
const printed = (body: string, n: number) => `start\n${block(body)}\n${ORDINARY.repeat(Math.ceil(n / ORDINARY.length)).slice(0, n)}`;
const run = (output: string, extra: object = {}) => ({ output, exitCode: 1, timedOut: false, seconds: 1, ...extra });
for (const n of [0, 500, 2000, 2500, 3000, 3500, 3900, 5000]) {
  for (const [kind, body] of [["a key", b64], ["a random body", random]] as const) {
    test(`a run's console, cut after the filter's look: ${kind}, ${n} characters after it`, () => {
      const said = new Boundary().mask(describeRun(run(printed(body, n)), [], []));
      clean("the run_tests answer", said, bodyLines(body));
    });
  }
}

test("a header with no END, its head cut off: masked before the cut, so its body goes too", () => {
  const output = `start\n${HDR}\n${bodyLines(random).join("\n")}\n${ORDINARY.repeat(140)}`;
  clean("the run_tests answer", new Boundary().mask(describeRun(run(output), [], [])), bodyLines(random));
});

test("a failure's message goes on its own: a header in one takes no other test's result with it", () => {
  const results = [
    { testId: "t.py::a", fileAttr: "t.py", name: "a", outcome: "failed", message: `assert pem.startswith("${HDR}")` },
    { testId: "t.py::b", fileAttr: "t.py", name: "b", outcome: "failed", message: "assert 1 == 2" },
  ];
  const said = new Boundary().mask(describeRun(run("the console's tail\n"), results, ["t.py"]));
  expect(said).toContain("FAILED t.py::b");
  expect(said).toContain("assert 1 == 2");
  expect(said).toContain("the console's tail");
  expect(said).toContain(SHOWN);
  expect(said).not.toContain(HDR);
});

test("a suite with no report: its last lines hold no key", () => {
  const said = noReport(run(`a\n${pem}`), CFG);
  clean("the last lines", said, pem.split("\n").filter(Boolean).slice(1, -1));
  expect(said).not.toContain("END PRIVATE");
});

test("a probe's tail is taken after the mask", async () => {
  const output = `${pem}${ORDINARY.repeat(Math.ceil(5900 / ORDINARY.length)).slice(0, 5900)}`;
  const session = { run: () => run(output) };
  const [, tail] = await probe(session, tmp(), CFG);
  clean("the probe's tail", tail, pem.split("\n").filter(Boolean).slice(1, -1));
});

test("an END with no header before it hides the base64-only lines before it: a cut, or a page inside a key", () => {
  expect(maskPrivateKeys(`abc\ndef\n${END}\nafter\n`)).toBe(`${SHOWN}\nafter\n`);
  // A later END, after a whole key, likewise, and text that is not base64 stays.
  expect(maskPrivateKeys(`before\n${HDR}\nabc\n${END}\nthe middle\n${END}\nafter`)).toBe(`before\n${SHOWN}\nthe middle\n${SHOWN}\nafter`);
  // The cut in a sandbox's output.
  const cut = printed(random, 100).slice(600);
  clean("the cut", maskPrivateKeys(cut), bodyLines(random).slice(10, -1));
});

test("a header with no END hides its run of tokens and no more; a body after other text is a stated limit", () => {
  expect(maskPrivateKeys(`a\n${HDR}\n${"x".repeat(16_383)}\nsome other text\n`)).toBe(`a\n${SHOWN}\nsome other text\n`);
  // A body after a line that reads like the next file, with its END, goes as lines before a stray END.
  const lines = bodyLines(random);
  clean("past `diff --git`", maskPrivateKeys(`${HDR}\ndiff --git a/x b/x\n${lines.join("\n")}\n${END}\n`), lines);
  // A stray END in a body is a stated limit.
  const stray = maskPrivateKeys(`${HDR}\nabc\n${END}\nrest of it\n`);
  expect(stray).toBe(`${SHOWN}\nrest of it\n`);
});

for (const n of [3000, 3900]) {
  test(`route: a key a test prints, then ${n} characters, to a local model and to arnx cloud`, async () => {
    const repo = configured();
    editApp(repo);
    commit(repo, "an edit");
    const printing = () => [junitXml([[GEN, "test_add", "failed", "assert 1 == 5"]]), printed(b64, n), false] as [string, string, boolean];
    const agent = new RecordingAgent([[tool("write_file", { path: GEN, content: SOURCE }), tool("run_tests", {})]], REPORT);
    await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(), sessionFactory: fakeFactory(printing) });
    clean("a model's messages", agent.bodies.join("\n"), bodyLines(b64));
    const rounds: StepScript[] = [
      { type: "actions", actions: [{ name: "write_file", input: { path: GEN, content: SOURCE } }, { name: "run_tests", input: {} }] },
      { type: "final", report: { tests: [], suspected_defects: [], questions: [] } },
      { type: "done", stop: "end_turn" },
    ];
    const cloud = fakeCloud({ rounds: { "*": rounds } });
    clouds.push(cloud);
    await runReview(repo, { settings: SETTINGS, brain: new CloudBrain({ boundary: new Boundary(),
      client: new CloudClient(cloud.url, { token: TOKEN, delays: [0] }), tier: "medium" }), sessionFactory: fakeFactory(printing) });
    clean("the wire", JSON.stringify(cloud.seen.map((x) => [x.path, x.body])), bodyLines(b64));
  });
}

// --- what is saved -----------------------------------------------------------------------------------------------------------

test("a model's test holding a PEM or a bare header survives accept then check, whole; what goes to models is masked", async () => {
  const sources = [
    `PEM = """${pem}"""\n\ndef test_add():\n    assert PEM\n\ndef test_more():\n    assert True\n`,
    `def test_add():\n    assert "${HDR}" and add(2, 3) == 5\n\ndef test_more():\n    assert True\n`,
  ];
  for (const source of sources) {
    const repo = gitRepo(join(tmp(), `saved-${sources.indexOf(source)}`));
    mkdirSync(dirname(reviewConfigPath(repo)));
    writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-11-04"));
    writeSettings(repo, SETTINGS);
    commit(repo, "set up");
    editApp(repo);
    commit(repo, "an edit");
    const agent = new RecordingAgent([[tool("write_file", { path: GEN, content: source }), tool("run_tests", {})]], REPORT);
    const judge = new RecordingJson();
    const failing = () => [junitXml([[GEN, "test_add", "failed", "assert 1 == 5"]]), "1 failed\n", false] as [string, string, boolean];
    const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge, sessionFactory: fakeFactory(failing) });
    clean("the judge", judge.bodies.join("\n"), pem.split("\n").filter(Boolean).slice(1, -1));
    expect(judge.bodies.join("\n")).not.toContain(HDR);
    const md = readFileSync(join(rdir, "review.md"), "utf8");
    writeFileSync(join(rdir, "review.md"), md.replace(/Mark: \[[^\]]*\] real/g, "Mark: [x] real"));
    await accept(repo, rdir, SETTINGS, { answerRunner: null });
    const held = treeText(join(repo, ".arnx/tests"));
    expect(held).toContain(source);
    expect(held).not.toContain(SHOWN);
    const seen: FakeSession[] = [];
    let sandbox = "";
    await check(repo, SETTINGS, { sessionFactory: fakeFactory(() => {
      sandbox = treeText(seen.at(-1)!.snap);
      return [junitXml([[GEN, "test_add", "passed", ""]]), "1 passed\n", false];
    }, seen) });
    expect(sandbox).toContain(source);
  }
});

// --- a pinned placeholder ----------------------------------------------------------------------------------------------------

const CRED = (version: number) => ["/**", " * A service credential.", " * @example", ` * privateKey: "${HDR}..."`, " */",
  "export interface Cred { clientEmail: string; projectId: string }", `export const version = ${version};`,
  "export const getSignedUrl = (c: Cred) => c.clientEmail;", ""].join("\n");

test("a pinned file with a bare header in a doc comment reads as it is, and its names stay names", async () => {
  expect(fakeKeys(CRED(1)).text).toBe(CRED(1));
  const repo = configured();
  put(repo, "cred.ts", CRED(1));
  put(repo, "other.ts", "import { getSignedUrl } from './cred';\nexport const a = 1;\n");
  commit(repo, "a doc comment");
  put(repo, "cred.ts", CRED(2));
  put(repo, "other.ts", "import { getSignedUrl } from './cred';\nexport const a = 2;\n");
  const pins = [...secretPins(CRED(1)), ...secretPins(CRED(2))];
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(`${YAML}allow_secret_looking:\n  - path: cred.ts\n    matches: [${pins.map((m) => `"${m}"`).join(", ")}]\n`), "Dev", "2026-11-04"));
  commit(repo, "allowed, and an edit");
  const c = resolveChange(repo, null, [{ path: "cred.ts", matches: pins }]);
  expect(c.diff).toContain("+export const version = 2;");
  expect(c.diff).toContain("export const getSignedUrl");
  expect(c.diff).not.toContain(SHOWN);

  const agent = new RecordingAgent([[tool("read_file", { path: "cred.ts" }), tool("grep", { pattern: "privateKey|getSignedUrl", path: "." })]], REPORT);
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(), progress: () => {},
    sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "passed", ""]]), "1 passed\n", false]) });
  const sent = agent.bodies.join("\n");
  expect(sent).not.toContain(HDR);
  expect(sent).toContain("+export const a = 2;");
  // The file read: all but the header's line. The search: the other hits.
  const read = agent.bodies[1]!.slice(agent.bodies[1]!.indexOf("tool_result"));
  expect(read).toContain("export const version = 2;");
  expect(read).toContain("cred.ts:8:");
  expect(read).toContain("other.ts:1:");
  for (const name of ["clientEmail", "getSignedUrl", "projectId"]) expect(sent).toContain(name);
});

test("a pinned header's own run: the base64 after it gets its fake, and only that", () => {
  const lines = bodyLines(random);
  const text = `# note\n${HDR}\n${lines.join("\n")}\nnext = clientEmail\n`;
  clean("the fake", fakeKeys(text).text, lines);
  expect(fakeKeys(text).text).toContain("next = clientEmail\n");
  const repo = gitRepo(tmp());
  put(repo, "fix.txt", text);
  commit(repo, "a fixture");
  const edited = text.replace("next = clientEmail", "next = other");
  put(repo, "fix.txt", edited);
  const c = resolveChange(repo, null, [{ path: "fix.txt", matches: [...secretPins(text), ...secretPins(edited)] }]);
  expect(c.diff).toContain("+next = other");
  clean("the diff", c.diff, lines);
});

// --- a key right after an escape ------------------------------------------------------------------------------------------------

test("a key's start after a literal \\n, \\r, \\t, %0A or %0D counts, in the scan and the filter; a word glued to it is a limit", () => {
  const lines = wrap(b64, 64);
  for (const before of ["\\n", "\\r\\n", "\\t", "%0A", "%0D", "%0a"]) {
    const text = `{"k": "${before}${lines.join("\\n")}"}\n`;
    expect(holdsPrivateKey(text, [])).toBe(true);
    clean(before, maskPrivateKeys(text), lines);
  }
  expect(holdsPrivateKey(`k=rsa${b64}`, [])).toBe(false);
  const repo = gitRepo(tmp());
  put(repo, "conf.json", `{"signing_key": "\\n${lines.join("\\n")}"}\n`);
  editApp(repo);
  commit(repo, "a key");
  const c = resolveChange(repo);
  expect(c.withheld).toBeUndefined();
  clean("the diff", c.diff, lines);
});

// --- allow-secret's way out ------------------------------------------------------------------------------------------------------

const allowed = async (repo: string, path: string) => {
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("allow-secret", path)).toBe(0);
  return (await import("../src/config")).readSecretPins(repo);
};

test("on the default branch: allow-secret frees the last commit, and a range over it", async () => {
  const repo = gitRepo(tmp());
  put(repo, "doc.md", `${HDR}\n...\n`);
  commit(repo, "a doc");
  put(repo, "doc.md", `${HDR}\n...\nmore\n`);
  commit(repo, "an edit");
  const pins = await allowed(repo, "doc.md");
  const last = resolveChange(repo, null, pins);
  expect([last.files, last.withheld]).toEqual([["doc.md"], undefined]);
  const range = resolveChange(repo, "HEAD~1..HEAD", pins);
  expect([range.files, range.withheld]).toEqual([["doc.md"], undefined]);
});

test("with stand-ins off, the stop's advice works where it is given", async () => {
  const repo = gitRepo(tmp());
  writeSettings(repo, { ...defaultSettings(), standIns: false });
  put(repo, "doc.md", `${HDR}\n...\n`);
  commit(repo, "a doc");
  put(repo, "doc.md", "clean\n");
  commit(repo, "the header goes");
  const said = () => {
    try {
      resolveChange(repo);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  // The file is here, and the old side is the commit before: allow-secret reads that.
  expect(said()).toContain("`arnx allow-secret doc.md`");
  // An older range: nothing here can allow what it holds, and the stop says so.
  put(repo, "doc.md", "clean again\n");
  commit(repo, "later");
  const older = () => {
    try {
      resolveChange(repo, "HEAD~3..HEAD~2");
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };
  expect(older()).toContain("cannot be allowed");
  expect(older()).not.toContain("arnx allow-secret");
  expect(older()).toContain("--range");
});

// --- `[private key]` is not a value --------------------------------------------------------------------------------------------

test("write_file refuses text holding `[private key]`, with the advice", async () => {
  const dir = tmp();
  const ws = new Workspace(dir, { writeDir: "tests/arnx_generated", adapter: getAdapter("python") });
  await expect(ws.call("write_file", { path: GEN, content: `k = "${SHOWN}"\n` })).rejects.toThrow("read the file at run time");
  expect(existsSync(join(dir, GEN))).toBe(false);
});

test("a proposed or saved review.yaml holding `[private key]` is refused", () => {
  expect(() => parseReviewFile(`${YAML}env:\n  K: "${SHOWN}"\n`)).toThrow("[private key]");
});

test("a prompt whose diff shows `[private key]` says what it means; with none, it says nothing", () => {
  const with_ = DEFAULT_PROMPTS.reviewTask(CFG, `+${SHOWN}\n`, 5);
  expect(with_).toContain("read the file at run time");
  expect(DEFAULT_PROMPTS.reviewTask(CFG, "+x = 1\n", 5)).not.toContain("read the file at run time");
  expect(DEFAULT_PROMPTS.huntTask(CFG, `+${SHOWN}\n`, "", undefined)).toContain("read the file at run time");
});

// --- small ones -----------------------------------------------------------------------------------------------------------------

test("a section holding a NUL always reads its file: a UTF-16 key with no header, edited inside its body", () => {
  const repo = gitRepo(tmp());
  put(repo, ".gitattributes", "*.txt diff\n");
  const lines = wrap(b64, 64);
  const text = (mid: string) => Buffer.from(`${lines.slice(0, 12).join("\n")}\n${mid}\n${lines.slice(12).join("\n")}\n`, "utf16le");
  put(repo, "k.txt", text("one"));
  commit(repo, "a key");
  put(repo, "k.txt", text("two"));
  editApp(repo);
  commit(repo, "edit");
  const c = resolveChange(repo);
  expect(c.withheld?.map((w) => w.path)).toEqual(["k.txt"]);
  clean("the diff", c.diff.replaceAll("\0", ""), lines);
});

test("allow-secret takes a UTF-16 file, as the stop says it can", async () => {
  const text = Buffer.from(`\ufeff${pem}`, "utf16le");
  expect(secretHits(text.toString("utf8")).length).toBeGreaterThan(0);
  const repo = gitRepo(tmp());
  put(repo, "k.txt", text);
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("allow-secret", "k.txt")).toBe(0);
});

test("a %20 right after the dashes is a header to the scan too", () => {
  expect(holdsPrivateKey(`-----%20BEGIN%20${KEY.replace(" ", "%20")}-----\n`, [])).toBe(true);
  expect(holdsPrivateKey(`----%20BEGIN%20SSH2%20${KEY.replace(" ", "%20")}%20----\n`, [])).toBe(true);
});
