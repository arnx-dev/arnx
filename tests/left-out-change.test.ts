// A changed file holding a private key leaves the change, and the rest is reviewed. What each party sees: no model gets a
// section, a read, a search hit or a sandbox file of it; only its path and a label go anywhere.
import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync }
  from "node:fs";
import { dirname, join } from "node:path";
import { Boundary } from "../src/boundary";
import { changeLimits, MAX_DIFF_BYTES, resolveChange, SCAN_LIMIT, sealDiff, sliceDiff, takeSnapshot } from "../src/change";
import { CloudClient } from "../src/cloud";
import { CloudBrain } from "../src/cloudbrain";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp, stampFile } from "../src/config";
import type { Block } from "../src/llm";
import { nextStep } from "../src/setupview";
import { DEFAULT_PROMPTS, leftOutNote, PROMPT_VERSION } from "../src/prompts";
import { load } from "../src/report";
import { runReview } from "../src/reviewer";
import { secretPins } from "../src/secrets";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { type FakeCloud, fakeCloud, type StepScript, TOKEN } from "./helpers/cloudfake";
import { AWS_KEY, PRIVATE_KEY, PRIVATE_KEY_BLOCK } from "./helpers/fakekeys";
import { fakeFactory, type FakeSession, tool } from "./helpers/fakes";
import { commit, gitRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { RecordingAgent, RecordingJson, treeText } from "./helpers/recording";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const BODY = PRIVATE_KEY_BLOCK.split("\n")[1]!;
const IN_CODE = `const PEM = \`${PRIVATE_KEY_BLOCK}\`;\nexport const a = 1;\n`;
const WAY_OUT = "arnx allow-secret";
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };

const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: [] });
const SOURCE = "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n";
/** Tries every way to the file, then writes a test and runs it. */
const PRYING = (path: string): Block[][] => [
  [tool("read_file", { path }), tool("grep", { pattern: BODY.slice(0, 20), path: "." }), tool("list_dir", { path: "." })],
  [tool("write_file", { path: GEN, content: SOURCE }), tool("run_tests", {})],
];
const failing = (message = "assert 1 == 5"): [string | null, string, boolean] =>
  [junitXml([[GEN, "test_add", "failed", message]]), "1 failed\n", false];

/** A repository set up for a review, its change uncommitted or committed by the caller. */
function configured(o: Partial<Settings> = {}, under = tmp()): string {
  const repo = gitRepo(under);
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-11-04"));
  writeSettings(repo, { ...SETTINGS, ...o });
  commit(repo, "set up");
  return repo;
}
const editApp = (repo: string) => writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");

let clouds: FakeCloud[] = [];
afterEach(() => {
  for (const c of clouds) c.stop();
  clouds = [];
  changeLimits.maxScanBytes = 32_000_000;
});

// --- what the input names ---------------------------------------------------------------------------------------------

test("a changed file holding a private key is left out and the rest is reviewed", async () => {
  const repo = configured();
  editApp(repo);
  writeFileSync(join(repo, "keys.ts"), IN_CODE);
  commit(repo, "a key and an edit");
  const seen: FakeSession[] = [];
  const inSandbox: string[] = [];
  const said: string[] = [];
  const agent = new RecordingAgent(PRYING("keys.ts"), REPORT), judge = new RecordingJson();
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge,
    progress: (m) => said.push(m),
    sessionFactory: fakeFactory(() => {
      inSandbox.push(...seen.map((s) => treeText(s.snap)));
      return failing();
    }, seen) });

  const c = resolveChange(repo);
  expect(c.files).toEqual(["app.py"]);
  expect(c.withheld).toEqual([{ path: "keys.ts", line: 1, label: "a private key" }]);
  expect(c.diff).not.toContain("keys.ts");
  expect(c.diff).toContain("-    return a + b");

  // No body line in any message a model got, in the sandbox, or in what is saved.
  const sent = [...agent.bodies, ...judge.bodies].join("\n");
  expect(sent).toContain("return a - b");
  expect(sent).not.toContain(BODY);
  expect(sent).not.toContain(PRIVATE_KEY);
  expect(inSandbox.length).toBeGreaterThan(0);
  for (const tree of inSandbox) expect(tree).not.toContain(BODY);
  const saved = treeText(rdir);
  expect(saved).toContain("-    return a + b");
  expect(saved).not.toContain(BODY);
  expect(readFileSync(join(rdir, "change.diff"), "utf8")).not.toContain("keys.ts");

  // Told, by path and label, to each model; the one read of it says nothing.
  expect(agent.bodies[0]).toContain("`keys.ts` (a private key)");
  expect(judge.bodies.join("\n")).toContain("`keys.ts` (a private key)");

  // The report and the progress line name it, with the way out.
  expect(review.notSent).toEqual(["keys.ts"]);
  expect(review.filesChanged).toBe(1);
  expect(review.findings.length).toBe(1);
  const md = readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " ");
  expect(md).toContain("Files left out because they looked like secrets: `keys.ts` (a private key, line 1).");
  expect(md).toContain(WAY_OUT);
  // Read back, as triage and the fix prompt read it.
  expect(load(rdir).leftOutFiles).toEqual([{ path: "keys.ts", line: 1, label: "a private key" }]);
  expect(said).toContain("left out as secret-looking: keys.ts (a private key, line 1); if one is a test fixture, allow it " +
    "with `arnx allow-secret PATH`");
});

test("a key only on the removed side leaves the section out", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "keys.ts"), IN_CODE);
  commit(repo, "a key");
  writeFileSync(join(repo, "keys.ts"), "export const a = 1;\n");
  editApp(repo);
  // Uncommitted, and then the same as a commit.
  for (const c of [resolveChange(repo), (commit(repo, "the key goes"), resolveChange(repo))]) {
    expect(c.files).toEqual(["app.py"]);
    expect(c.withheld?.map((w) => w.path)).toEqual(["keys.ts"]);
    expect(c.diff).not.toContain(BODY);
    expect(c.diff).not.toContain("keys.ts");
  }
  // A file deleted with its key, likewise.
  const gone = gitRepo(join(tmp(), "gone"));
  writeFileSync(join(gone, "keys.ts"), IN_CODE);
  commit(gone, "a key");
  rmSync(join(gone, "keys.ts"));
  editApp(gone);
  const c = resolveChange(gone);
  expect([c.files, c.withheld?.map((w) => w.path), c.diff.includes(BODY)]).toEqual([["app.py"], ["keys.ts"], false]);
});

test("a change of only such files stops with the way out", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "keys.ts"), IN_CODE);
  commit(repo, "a key");
  expect(() => resolveChange(repo)).toThrow("the change contains text that looks like a secret (a key or token) in " +
    "keys.ts (a private key); arnx will not send it to a model. If it is a test fixture, not a secret, allow the file: " +
    "`arnx allow-secret keys.ts`, then `arnx review` again");
  writeFileSync(join(repo, "more.ts"), IN_CODE);
  commit(repo, "two");
  writeFileSync(join(repo, "keys.ts"), `${IN_CODE}export const b = 1;\n`);
  expect(() => resolveChange(repo)).toThrow("keys.ts (a private key)");
  writeFileSync(join(repo, "more.ts"), `${IN_CODE}export const b = 1;\n`);
  expect(() => resolveChange(repo)).toThrow("keys.ts (a private key), more.ts (a private key); arnx will not send it");
  expect(() => resolveChange(repo)).toThrow("`arnx allow-secret PATH`");
  // What says the next step says the same; none of it holds the key.
  expect(nextStep(repo)).toContain(WAY_OUT);
  expect(nextStep(repo)).not.toContain(BODY);
});

test("a pinned file is sent as before", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "keys.ts"), IN_CODE);
  const allow = [{ path: "keys.ts", matches: secretPins(IN_CODE) }];
  runGit(repo, "add", "keys.ts");
  const c = resolveChange(repo, null, allow);
  expect([c.files, c.withheld, c.diff.includes(BODY)]).toEqual([["keys.ts"], undefined, true]);
  // A new key in it withholds it again.
  const other = PRIVATE_KEY.replace("RSA", "EC");
  writeFileSync(join(repo, "keys.ts"), `${IN_CODE}const B = \`${other}\n${BODY}\`;\n`);
  expect(() => resolveChange(repo, null, allow)).toThrow("keys.ts (a private key)");
  // Another file with the same strings is not pinned.
  writeFileSync(join(repo, "keys.ts"), IN_CODE);
  writeFileSync(join(repo, "more.ts"), IN_CODE);
  runGit(repo, "add", "more.ts");
  const both = resolveChange(repo, null, allow);
  expect([both.files, both.withheld?.map((w) => w.path)]).toEqual([["keys.ts"], ["more.ts"]]);
});

test("a key-shaped string gets one stand-in in diff and snapshot", async () => {
  const repo = configured();
  writeFileSync(join(repo, "creds.py"), `KEY = "${AWS_KEY}"\n`);
  commit(repo, "a key-shaped string");
  const c = resolveChange(repo);
  expect([c.files, c.withheld]).toEqual([["creds.py"], undefined]);

  const seen: FakeSession[] = [];
  let inSandbox = "";
  const agent = new RecordingAgent([[tool("read_file", { path: "creds.py" })], ...PRYING("creds.py").slice(1)], REPORT);
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(),
    sessionFactory: fakeFactory(() => {
      inSandbox = treeText(seen.at(-1)!.snap);
      return failing();
    }, seen) });
  const sent = agent.bodies.join("\n");
  expect(sent).not.toContain(AWS_KEY);
  const made = [...new Set(sent.match(/AKIA[0-9A-Z]{16}/g))];
  expect(made.length).toBe(1);
  // In the diff, in the file read and in the sandbox alike.
  expect(agent.bodies[0]).toContain(`+KEY = \\"${made[0]}\\"`);
  // The second request holds the diff and the file the model read: the same one in each.
  expect(agent.bodies[1]!.split(made[0]!).length - 1).toBeGreaterThanOrEqual(2);
  expect(inSandbox).toContain(`KEY = "${made[0]}"`);
  expect(inSandbox).not.toContain(AWS_KEY);
});

test("with stand-ins off the file is left out", async () => {
  const repo = configured({ standIns: false });
  editApp(repo);
  writeFileSync(join(repo, "creds.py"), `KEY = "${AWS_KEY}"\n`);
  writeFileSync(join(repo, "doc.ts"), `/** e.g. ${AWS_KEY} */\nexport const a = 1;\n`);
  commit(repo, "a key-shaped string");
  const c = resolveChange(repo);
  expect(c.withheld).toEqual([{ path: "creds.py", line: 1, label: "AKIA…" }]);
  // A key in a comment is blanked, stand-ins or not.
  expect(c.files).toEqual(["app.py", "doc.ts"]);
  expect(c.blanked?.map((b) => b.path)).toEqual(["doc.ts"]);
  expect(c.diff).not.toContain(AWS_KEY);

  const seen: FakeSession[] = [];
  let inSandbox = "";
  const agent = new RecordingAgent(PRYING("creds.py"), REPORT);
  await runReview(repo, { settings: { ...SETTINGS, standIns: false }, agentModel: agent, challenger: new RecordingJson(),
    sessionFactory: fakeFactory(() => {
      inSandbox = treeText(seen.at(-1)!.snap);
      return failing();
    }, seen) });
  expect(agent.bodies.join("\n")).not.toContain(AWS_KEY);
  expect(agent.bodies[0]).toContain("`creds.py` (AKIA…)");
  expect(inSandbox).not.toContain("KEY = ");
  // Only the secret left it: a stand-ins-off change of that one file stops.
  const alone = configured({ standIns: false }, join(tmp(), "alone"));
  writeFileSync(join(alone, "creds.py"), `KEY = "${AWS_KEY}"\n`);
  commit(alone, "a key-shaped string");
  expect(() => resolveChange(alone)).toThrow("creds.py (AKIA…)");
});

test("a file over the scan limit holding a private key is left out", () => {
  const repo = gitRepo(tmp());
  const filler = "# just some long text that is not code\n".repeat(Math.ceil(SCAN_LIMIT / 39) + 10);
  const big = (first: string) => `${first}\n${filler}const PEM = \`${PRIVATE_KEY_BLOCK}\`;\n`;
  writeFileSync(join(repo, "big.ts"), big("// one"));
  expect(lstatSync(join(repo, "big.ts")).size).toBeGreaterThan(SCAN_LIMIT);
  commit(repo, "a big file with a key at its end");
  writeFileSync(join(repo, "big.ts"), big("// two"));
  editApp(repo);
  const check = (c: ReturnType<typeof resolveChange>) => {
    expect(c.files).toEqual(["app.py"]);
    expect(c.withheld?.map((w) => [w.path, w.label])).toEqual([["big.ts", "a private key"]]);
    expect(c.diff).not.toContain("big.ts");
    expect(c.diff).not.toContain("just some long text");
  };
  check(resolveChange(repo));
  // On both sides, from the repository's history.
  commit(repo, "edit");
  check(resolveChange(repo));
  // The snapshots agree.
  for (const rev of [null, "HEAD"]) {
    const snap = join(tmp(), `snap-${rev}`);
    const taken = takeSnapshot(repo, rev, snap, [], { standIns: true });
    expect(taken.withheld.map((w) => w.path)).toEqual(["big.ts"]);
    expect(existsSync(join(snap, "big.ts"))).toBe(false);
  }
});

// --- each way a section could keep a body -----------------------------------------------------------------------------

test("a section shows a body with no header in its hunk: left out, as the snapshot leaves the file out", () => {
  const repo = gitRepo(tmp());
  const rows = ["a", "b", "c", "d", "e"].map((c) => `MIIEowIBAAKCAQEA${c.repeat(48)}`);
  const file = (tail: string) => `const PEM = \`${PRIVATE_KEY}\n${rows.join("\n")}\n-----END RSA ${"PRIVATE KEY"}-----\`;\n${tail}\n`;
  writeFileSync(join(repo, "k.ts"), file("x();"));
  commit(repo, "key in code");
  writeFileSync(join(repo, "k.ts"), file("y();"));
  editApp(repo);
  const c = resolveChange(repo);
  expect(c.diff).not.toContain("MIIEowIBAAKCAQEA");
  expect(c.withheld?.map((w) => w.path)).toEqual(["k.ts"]);
  expect(takeSnapshot(repo, null, join(tmp(), "s"), [], { standIns: true }).withheld.map((w) => w.path)).toEqual(["k.ts"]);
});

test("a key far from the hunk leaves the section out: no part of a withheld file is sent", () => {
  const repo = gitRepo(tmp());
  const pad = Array.from({ length: 30 }, (_, i) => `a${i}();`).join("\n");
  const file = (first: string) => `${first}\n${pad}\n${IN_CODE}`;
  writeFileSync(join(repo, "k.ts"), file("x();"));
  commit(repo, "key far below");
  writeFileSync(join(repo, "k.ts"), file("y();"));
  editApp(repo);
  const c = resolveChange(repo);
  expect(c.withheld?.map((w) => w.path)).toEqual(["k.ts"]);
  expect(c.diff).not.toContain("k.ts");
  expect(c.diff).not.toContain("x();");
});

test("a private key header with no body on either side stays, as in a snapshot", () => {
  const repo = gitRepo(tmp());
  const form = `const HINT = "${PRIVATE_KEY}";\n`;
  writeFileSync(join(repo, "form.ts"), form);
  commit(repo, "a form's hint");
  writeFileSync(join(repo, "form.ts"), `${form}export const a = 1;\n`);
  const c = resolveChange(repo);
  expect([c.files, c.withheld]).toEqual([["form.ts"], undefined]);
  expect(c.diff).toContain("export const a = 1");
  expect(takeSnapshot(repo, null, join(tmp(), "s"), [], { standIns: true }).withheld).toEqual([]);
  // A body on either side is enough.
  writeFileSync(join(repo, "form.ts"), `${form}${BODY}\n`);
  expect(() => resolveChange(repo)).toThrow("form.ts (a private key)");
});

test("the last guard: a body left in a section refuses the change", () => {
  const section = (path: string) => `diff --git a/${path} b/${path}\nnew file mode 100644\n--- /dev/null\n+++ b/${path}\n` +
    `@@ -0,0 +1,2 @@\n+${PRIVATE_KEY}\n+${BODY}\n`;
  const none = () => null;
  // Neither side could be read, so nothing says what the file holds.
  expect(() => sealDiff(section("k.ts"), [], none, none, true)).toThrow("k.ts (a private key)");
  expect(() => sealDiff(section("k.ts"), [], none, none, true)).toThrow("arnx allow-secret k.ts");
  const pinned = [{ path: "k.ts", matches: secretPins(section("k.ts")) }];
  expect(sealDiff(section("k.ts"), pinned, none, none, true).withheld).toEqual([]);
  // With no path to read, a body alone is enough.
  expect(() => sealDiff(`diff --git something odd\n+${BODY}\n`, [], none, none, true)).toThrow("(a private key)");
});

test("a path git quotes or ends with a tab is read all the same, under any prefix setting", () => {
  const repo = gitRepo(tmp());
  const names = ["my keys.ts", "café.ts", 'odd"name.ts'];
  for (const n of names) writeFileSync(join(repo, n), IN_CODE);
  commit(repo, "keys in oddly named files");
  const pad = "z();\n".repeat(20);
  for (const n of names) writeFileSync(join(repo, n), `${IN_CODE}${pad}export const b = 2;\n`);
  editApp(repo);
  for (const [k, v] of [["core.quotePath", "true"], ["diff.noprefix", "true"], ["diff.mnemonicPrefix", "true"],
    ["color.ui", "always"], ["diff.external", "false"], ["grep.patternType", "fixed"]] as const) {
    runGit(repo, "config", k, v);
    const c = resolveChange(repo);
    expect(c.files).toEqual(["app.py"]);
    expect(c.withheld?.map((w) => w.path)).toEqual([...names].sort());
    expect(c.diff).not.toContain("export const b");
    // From the commits' sides too, and with the search's own settings.
    runGit(repo, "add", "-A");
    runGit(repo, "commit", "-q", "-m", "edit");
    const done = resolveChange(repo);
    expect(done.withheld?.map((w) => w.path)).toEqual([...names].sort());
    runGit(repo, "reset", "-q", "--soft", "HEAD~1");
    runGit(repo, "reset", "-q");
    runGit(repo, "config", "--unset", k);
  }
});

test("a diff shows what git holds, whatever a text conversion, a submodule setting or an outside tool would show", () => {
  const body = PRIVATE_KEY_BLOCK.split("\n")[1]!;
  // The shape of a decrypting driver: the file in git says nothing, the driver prints the secret.
  for (const how of ["local", "global attributes"]) {
    const repo = gitRepo(join(tmp(), `conv-${how.replace(" ", "-")}`));
    const attrs = join(repo, "..", "attrs");
    if (how === "local") writeFileSync(join(repo, ".gitattributes"), "*.sec diff=dec\n");
    else {
      writeFileSync(attrs, "*.sec diff=dec\n");
      runGit(repo, "config", "core.attributesFile", attrs);
    }
    runGit(repo, "config", "diff.dec.textconv", `sh -c 'echo ${body}'`);
    writeFileSync(join(repo, "v.sec"), "ciphertext\n");
    editApp(repo);
    commit(repo, "a value only a driver can read");
    const c = resolveChange(repo);
    expect(c.diff).not.toContain(body);
    expect(c.diff).toContain("+ciphertext");
    // An outside diff tool, by setting and by attribute, likewise.
    runGit(repo, "config", "diff.external", `sh -c 'echo ${body}'`);
    runGit(repo, "config", "diff.dec.command", `sh -c 'echo ${body}'`);
    expect(resolveChange(repo).diff).not.toContain(body);
  }
  // A submodule's own files are not this repository's change.
  const sub = gitRepo(join(tmp(), "sub"));
  const repo = gitRepo(join(tmp(), "super"));
  runGit(repo, "-c", "protocol.file.allow=always", "submodule", "add", "-q", join(sub), "sm");
  commit(repo, "add the submodule");
  writeFileSync(join(repo, "sm/f.txt"), `${body}\n`);
  commit(join(repo, "sm"), "a value in the submodule");
  editApp(repo);
  commit(repo, "bump");
  runGit(repo, "config", "diff.submodule", "diff");
  const c = resolveChange(repo);
  expect(c.diff).not.toContain(body);
  expect(c.diff).toContain("Subproject commit");
});

test("every armour a private key comes in is one: PGP, SSH2's four dashes, a digit in the label, a .ppk", () => {
  const random = randomBytes(600).toString("base64").match(/.{1,64}/g)!.join("\n");
  const block = (begin: string, end: string) => `${begin}\n\n${random}\n${end}\n`;
  const key = "PRIVATE " + "KEY";
  const armours = [block(`-----BEGIN PGP ${key} BLOCK-----`, `-----END PGP ${key} BLOCK-----`),
    block(`---- BEGIN SSH2 ENCRYPTED ${key} ----`, `---- END SSH2 ENCRYPTED ${key} ----`),
    block(`-----BEGIN ED25519 ${key}-----`, `-----END ED25519 ${key}-----`)];
  armours.forEach((armour, i) => {
    const repo = gitRepo(join(tmp(), `armour-${i}`));
    writeFileSync(join(repo, "k.txt"), armour);
    editApp(repo);
    commit(repo, "a key");
    const c = resolveChange(repo);
    expect(c.withheld?.map((w) => [w.path, w.label])).toEqual([["k.txt", "a private key"]]);
    expect(c.diff).not.toContain(random.slice(0, 64));
    const snap = join(tmp(), `armour-${i}-snap`);
    takeSnapshot(repo, "HEAD", snap, [], { standIns: true });
    expect(existsSync(join(snap, "k.txt"))).toBe(false);
  });
  const repo = gitRepo(join(tmp(), "ppk"));
  writeFileSync(join(repo, "k.ppk"), `PuTTY-User-Key-File-3: ssh-ed25519\nPrivate-Lines: 1\n${random.slice(0, 44)}\n`);
  editApp(repo);
  commit(repo, "a key");
  expect(resolveChange(repo).diff).not.toContain("PuTTY");
  takeSnapshot(repo, "HEAD", join(tmp(), "ppk-snap"), [], { standIns: true });
  expect(existsSync(join(tmp(), "ppk-snap", "k.ppk"))).toBe(false);
});

test("bytes that are not text beside a key do not hide it from the search", () => {
  const repo = gitRepo(tmp());
  const latin = Buffer.concat([Buffer.from([0xe9, 0xff, 0x20]), Buffer.from(PRIVATE_KEY_BLOCK), Buffer.from("\n")]);
  writeFileSync(join(repo, "latin.txt"), latin);
  commit(repo, "a key after bytes that are not UTF-8");
  writeFileSync(join(repo, "latin.txt"), Buffer.concat([latin, Buffer.from("more\n")]));
  editApp(repo);
  commit(repo, "edit");
  expect(resolveChange(repo).withheld?.map((w) => w.path)).toEqual(["latin.txt"]);
});

test("a rename, a mode change and a binary file: left out with their key, whatever the section shows", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "keys.ts"), IN_CODE);
  writeFileSync(join(repo, "run.ts"), IN_CODE);
  writeFileSync(join(repo, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(PRIVATE_KEY_BLOCK)]));
  commit(repo, "keys");
  renameSync(join(repo, "keys.ts"), join(repo, "moved.ts"));
  runGit(repo, "add", "-A");
  chmodSync(join(repo, "run.ts"), 0o755);
  writeFileSync(join(repo, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 3]), Buffer.from(PRIVATE_KEY_BLOCK)]));
  editApp(repo);
  const c = resolveChange(repo);
  expect(c.files).toEqual(["app.py"]);
  expect(c.withheld?.map((w) => w.path)).toEqual(["blob.bin", "moved.ts", "run.ts"]);
  expect(c.diff).not.toContain("moved.ts");
  expect(c.diff).not.toContain("run.ts");
  expect(c.diff).not.toContain("blob.bin");
});

test("a file too large for any scan: a key found piece by piece leaves it out; without one its section stays", () => {
  const repo = gitRepo(tmp());
  const filler = "text text text text text text text text\n".repeat(200);
  writeFileSync(join(repo, "big.txt"), `one\n${filler}${PRIVATE_KEY}\n`);
  writeFileSync(join(repo, "clean.txt"), `one\n${filler}`);
  commit(repo, "large files");
  changeLimits.maxScanBytes = 1000;
  writeFileSync(join(repo, "big.txt"), `two\n${filler}${PRIVATE_KEY}\n`);
  writeFileSync(join(repo, "clean.txt"), `two\n${filler}`);
  const check = (c: ReturnType<typeof resolveChange>) => {
    expect(c.files).toEqual(["clean.txt"]);
    expect(c.withheld).toEqual([{ path: "big.txt", line: 202, label: "a private key" }]);
  };
  check(resolveChange(repo));
  commit(repo, "edit");
  check(resolveChange(repo));
  // A pin cannot vouch for what no scan reads.
  check(resolveChange(repo, null, [{ path: "big.txt", matches: secretPins(PRIVATE_KEY) }]));
});

test("a withheld file's size does not count against the change", () => {
  const repo = gitRepo(tmp());
  const rows = "x".repeat(70) + "\n";
  writeFileSync(join(repo, "keys.ts"), `${IN_CODE}${rows.repeat(Math.ceil(MAX_DIFF_BYTES / 71) + 10)}`);
  editApp(repo);
  runGit(repo, "add", "keys.ts");
  expect(resolveChange(repo).files).toEqual(["app.py"]);
  // What is left still counts.
  writeFileSync(join(repo, "app.py"), rows.repeat(Math.ceil(MAX_DIFF_BYTES / 71) + 10));
  expect(() => resolveChange(repo)).toThrow("arnx reviews up to");
});

// --- what follows the change ------------------------------------------------------------------------------------------

test("no project is asked to cover a withheld file, and a project with only that file gets no round", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"));
  mkdirSync(join(repo, "secrets"));
  writeFileSync(join(repo, "svc/app.py"), "def add(a, b):\n    return a + b\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile("version: 1\nprojects:\n  svc:\n    root: svc\n" +
    "    image: python:3.12-slim\n    test_command: python -m pytest {targets}\n  vault:\n    root: secrets\n" +
    "    image: python:3.12-slim\n    test_command: python -m pytest {targets}\n"), "Dev", "2026-11-04"));
  writeSettings(repo, SETTINGS);
  commit(repo, "layout");
  writeFileSync(join(repo, "svc/app.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(join(repo, "secrets/keys.ts"), IN_CODE);
  commit(repo, "edit");
  const agent = new RecordingAgent(PRYING("../secrets/keys.ts").slice(1), JSON.stringify({ tests: [],
    suspected_defects: [], questions: [] }));
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(),
    sessionFactory: fakeFactory(() => failing()) });
  expect(review.projectStats?.map((p) => p.name)).toEqual(["svc"]);
  expect(review.notSent).toEqual(["secrets/keys.ts"]);
  expect(agent.bodies[0]).toContain("`secrets/keys.ts` (a private key)");
  expect(agent.bodies[0]).not.toContain("also edits files not shown");
  expect(agent.bodies.join("\n")).not.toContain(BODY);
  expect(sliceDiff(resolveChange(repo).diff, ["secrets/keys.ts"])).toBe("");
});

test("the code before the change holds no key either, and the proof runs on the sealed diff", async () => {
  const repo = configured({ beforeCheck: true });
  writeFileSync(join(repo, "keys.ts"), IN_CODE);
  commit(repo, "a key");
  writeFileSync(join(repo, "keys.ts"), `${IN_CODE}export const b = 2;\n`);
  editApp(repo);
  commit(repo, "edit");
  const seen: FakeSession[] = [];
  const trees: string[] = [];
  const agent = new RecordingAgent(PRYING("keys.ts"), REPORT);
  const { review, rdir } = await runReview(repo, { settings: { ...SETTINGS, beforeCheck: true }, agentModel: agent,
    challenger: new RecordingJson(), sessionFactory: fakeFactory(() => {
      trees.push(...seen.map((s) => treeText(s.snap)));
      return failing();
    }, seen) });
  expect(seen.length).toBeGreaterThan(1);
  for (const tree of trees) expect(tree).not.toContain(BODY);
  expect(review.findings[0]!.before).toBeDefined();
  expect(treeText(rdir)).not.toContain(BODY);
});

test("a test needing a left-out file reads as one that could not run, never as a defect of the project", async () => {
  // Loaded inside the test, so the runner reports a plain failure in every run.
  const repo = configured();
  editApp(repo);
  writeFileSync(join(repo, "keys.py"), `PEM = """${PRIVATE_KEY_BLOCK}"""\n`);
  commit(repo, "a key and an edit");
  const missing = `E   ModuleNotFoundError: No module named 'keys'`;
  const { review, rdir } = await runReview(repo, { settings: SETTINGS,
    agentModel: new RecordingAgent(PRYING("keys.py"), REPORT), challenger: new RecordingJson(),
    sessionFactory: fakeFactory(() => failing(missing)) });
  expect(review.findings).toEqual([]);
  expect(review.errors).toEqual([`${GEN}::test_add`]);
  const md = readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " ");
  expect(md).toContain(`Errors (the test could not run): \`${GEN}::test_add\``);
  expect(md).toContain("`keys.py` (a private key, line 1)");
  // Anything else stays what it was.
  const other = await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent(PRYING("keys.py"), REPORT),
    challenger: new RecordingJson(),
    sessionFactory: fakeFactory(() => failing("E   ModuleNotFoundError: No module named 'other'")) });
  expect(other.review.findings.length).toBe(1);
});

test("arnx cloud gets no new field: it hears of the file in the diff it already takes", async () => {
  const repo = configured();
  editApp(repo);
  writeFileSync(join(repo, "keys.ts"), IN_CODE);
  commit(repo, "a key and an edit");
  const rounds: StepScript[] = [
    { type: "actions", actions: [{ name: "read_file", input: { path: "keys.ts" } }] },
    { type: "final", report: { tests: [], suspected_defects: [], questions: [] } },
    { type: "done", stop: "end_turn" },
  ];
  const cloud = fakeCloud({ rounds: { "*": rounds } });
  clouds.push(cloud);
  await runReview(repo, { settings: SETTINGS, brain: new CloudBrain({ boundary: new Boundary(),
    client: new CloudClient(cloud.url, { token: TOKEN, delays: [0] }), tier: "medium" }),
    sessionFactory: fakeFactory(() => failing()) });
  const wire = JSON.stringify(cloud.seen.map((x) => [x.path, x.body]));
  expect(wire).not.toContain(BODY);
  const started = cloud.seen.find((x) => /\/agent$/.test(x.path))!.body as Record<string, unknown>;
  expect(String(started.diff)).toContain("`keys.ts` (a private key)");
  expect(Object.keys(started).sort()).toEqual(["budget_micro_usd", "changed_definitions", "context_pack", "diff", "facts",
    "hunt", "max_questions", "scope"]);
  expect(Object.keys(started.scope as object).sort()).toEqual(["changed_owned", "changed_used", "owns", "scoped", "uses"]);
  const opened = cloud.seen.find((x) => x.path === "/v1/reviews")!.body as { change?: { files?: string[] } };
  expect(JSON.stringify(opened)).not.toContain("keys.ts");
});

test("the note is one sentence of paths and labels, absent when empty, in code: no prompt template changed", () => {
  expect(leftOutNote([])).toBe("");
  const one = leftOutNote([{ path: "a.ts", line: 3, label: "a private key" }]);
  expect(one).toContain("`a.ts` (a private key)");
  expect(one.match(/\. |\.$/g)?.length).toBe(1);
  expect(one).not.toContain("line 3");
  const many = leftOutNote(Array.from({ length: 45 }, (_, i) => ({ path: `f${i}.ts`, line: 1, label: "a private key" })));
  expect(many).toContain("`f39.ts` (a private key), and 5 more");
  expect(many).not.toContain("f40.ts");
  const cfg = parseReviewConfig(YAML);
  expect(DEFAULT_PROMPTS.reviewTask(cfg, "the diff", 5, { owned: ["a"], used: [] })).not.toContain("left out");
  expect(DEFAULT_PROMPTS.reviewTask(cfg, "the diff", 5, { owned: ["a"], used: [],
    leftOut: [{ path: "k.ts", line: 1, label: "a private key" }] })).toContain("`k.ts` (a private key)");
  expect(PROMPT_VERSION).toMatch(/^[0-9a-f]+$/);
});

test("only a real line end starts a diff section: a CR or U+2028 before `diff --git` is the file's own text", () => {
  for (const mark of ["\r", " ", " "]) {
    const repo = gitRepo(join(tmp(), `split-${mark.charCodeAt(0)}`));
    const rows = Array.from({ length: 5 }, (_, i) => `MIIEowIBAAKCAQEA${String(i).repeat(48)}`);
    const file = (tail: string) => [PRIVATE_KEY, ...rows.slice(0, 4), `#${mark}diff --git a/s.txt b/s.txt`, rows[4],
      "-----END RSA " + "PRIVATE KEY-----", tail, ""].join("\n");
    writeFileSync(join(repo, "k.txt"), file("one"));
    commit(repo, "a key");
    writeFileSync(join(repo, "k.txt"), file("two"));
    editApp(repo);
    const c = resolveChange(repo);
    expect(c.withheld?.map((w) => w.path)).toEqual(["k.txt"]);
    expect(c.diff).not.toContain(rows[4]!);
    expect(c.diff).not.toContain("s.txt");
  }
});
