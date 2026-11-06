// What the evidence pack is built from holds real values: a commit's message, every file of a commit's tree, the
// files a pack leaves out. None of them may reach a pack, round.json or second-opinion-input.jsonl as they are.
import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Boundary } from "../src/boundary";
import { changeMessage, takeSnapshot } from "../src/change";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { ArnxError } from "../src/errors";
import { commitEvidence, gitTree, GIT_TREE_LIMITS, judgeEvidence, snapshotTree } from "../src/evidence";
import { runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { AWS_KEY_2, PRIVATE_KEY_BLOCK } from "./helpers/fakekeys";
import { FakeJson, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const put = (root: string, files: Record<string, string>) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), body);
  }
};
// Built at runtime, each plain-looking: only where it is defined says it is a secret.
const ROOT_ENV = "Pl41n" + "Passw0rdValue";
const LOCAL_ENV = "L0cal" + "OnlyValue77q";
const SUB_ENV = "Sub3nv" + "ValueQ81z";
const YAML_PW = "Yaml5" + "ecretValue991";
const TOKEN = "Tk9q" + "Zx81LmWp3Rv";
const KEY_LINE = PRIVATE_KEY_BLOCK.split("\n")[1]!;
const ALL = [ROOT_ENV, LOCAL_ENV, SUB_ENV, YAML_PW, TOKEN, KEY_LINE, AWS_KEY_2];
const leaks = (s: string) => ALL.filter((v) => s.includes(v));

const CALC = 'def total(items):\n    """Sum."""\n    return sum(items)\n';
const PROJECT: Record<string, string> = {
  "app/calc.py": CALC,
  ".env": `DB_PASSWORD=${ROOT_ENV}\n`,
  "app/.env": `SECRET=${SUB_ENV}\n`,
  "config/app.yaml": `db:\n  password: ${YAML_PW}\n`,
  "app/settings.py": `API_TOKEN = "${TOKEN}"\n`,
  // Each value below stands bare, with no name that says what it is.
  "app/db.py": `from app.calc import total\ndef run(items):\n    conn = connect("${ROOT_ENV}", "${LOCAL_ENV}")\n` +
    "    return total(items)\n",
  "app/cli.py": `from app.calc import total\ndef main(items):\n    t = "${TOKEN}"\n    return total(items)\n`,
  "tests/test_calc.py": `from app.calc import total\n\ndef test_sum():\n    pw = "${SUB_ENV}"\n    assert total([1]) == 1\n` +
    `    key = """${PRIVATE_KEY_BLOCK}"""\n`,
  "docs/usage.md": `# Use\n\nUser ${YAML_PW} calls \`total(items)\`.\n\n${PRIVATE_KEY_BLOCK}\nSee \`total(x)\`.\n`,
};
const GEN = "tests/arnx_generated/test_x.py";
const GEN_SRC = "from app.calc import total\n\ndef test_x():\n    assert total([1, 2]) == 4\n";
const MESSAGE = `Off by one\n\nThe old key ${AWS_KEY_2} was rotated`;

/** PROJECT committed, then calc.py changed in a commit whose message holds a key no file holds. An untracked root
 * .env file holds one more value. */
function project(): { repo: string; head: string } {
  const repo = initRepo(join(tmp(), "repo"));
  put(repo, PROJECT);
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig("version: 1\nimage: python:3.12-slim\n" +
    "test_command: python -m pytest -q {targets}\n"), "Dev", "2026-10-11"));
  commit(repo, "first");
  writeFileSync(join(repo, "app/calc.py"), CALC.replace("sum(items)", "sum(items) + 1"));
  commit(repo, MESSAGE);
  writeFileSync(join(repo, ".env.local"), `LOCAL_PASSWORD=${LOCAL_ENV}\n`);
  return { repo, head: runGit(repo, "rev-parse", "HEAD").trim() };
}

test("a commit's tree hides every value its files hold, from files the pack leaves out too, wherever another file quotes it", () => {
  const { repo, head } = project();
  const diff = runGit(repo, "show", "--format=", head);
  const boundary = new Boundary();
  const tree = gitTree(repo, head, boundary);
  const pack = judgeEvidence({ tree, diff, testSource: GEN_SRC, testFile: GEN, func: "test_x", boundary,
    commitMessage: changeMessage(repo, { kind: "commit", base: `${head}~1`, head }), writeDir: "tests/arnx_generated" });
  // The lines that quote them are in the pack: what is missing is only the values.
  for (const shown of ["conn = connect(", "t = ", "pw = ", "calls `total(items)`", "The old key"]) expect(pack).toContain(shown);
  expect(leaks(pack)).toEqual([]);
  expect(leaks(tree.files().map((p) => tree.read(p) ?? "").join("\n"))).toEqual([]);
  // Secret files are not given out at all; a config file is, masked.
  for (const p of [".env", "app/.env"]) expect(tree.read(p)).toBeNull();
  expect(tree.read("config/app.yaml")).toContain("password: ");
});

test("a commit's tree too large to read says so instead of reading as empty", () => {
  const { repo, head } = project();
  const was = GIT_TREE_LIMITS.outputBytes;
  GIT_TREE_LIMITS.outputBytes = 200;
  try {
    const tree = gitTree(repo, head);
    expect(() => tree.files()).toThrow(ArnxError);
    expect(() => tree.read("app/calc.py")).toThrow(/too large|limit/);
  } finally {
    GIT_TREE_LIMITS.outputBytes = was;
  }
  expect(() => gitTree(repo, "f".repeat(40)).files()).toThrow(ArnxError);
});

test("a pack hides what only its commit message holds", () => {
  const { repo, head } = project();
  const boundary = new Boundary();
  const pack = judgeEvidence({ tree: gitTree(repo, head, boundary), diff: runGit(repo, "show", "--format=", head),
    testSource: GEN_SRC, testFile: GEN, func: "test_x", commitMessage: MESSAGE, writeDir: "tests/arnx_generated", boundary });
  expect(pack).toContain("The old key");
  expect(pack).not.toContain(AWS_KEY_2);
});

function walk(d: string, out: string[] = []): string[] {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test("a review keeps no value of its commit message or tree in round.json, second-opinion-input.jsonl or any file it writes", async () => {
  const { repo } = project();
  const agent = new ScriptedAgent([
    [tool("write_file", { path: GEN, content: GEN_SRC })],
    [text(JSON.stringify({ tests: [{ test: `${GEN}::test_x`, expects: "sums" }],
      suspected_defects: [{ test: `${GEN}::test_x`, explanation: "off by one." }], questions: [] }))],
  ]);
  const runs = (): [string | null, string, boolean] => [junitXml([[GEN, "test_x", "failed", "assert 4 == 3"]]), "", false];
  const judge = new FakeJson([{ verdict: "confirmed", reason: "x" }, { groups: [] }]);
  const settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-11T00:00:00Z" };
  const { review, rdir } = await runReview(repo, { settings, agentModel: agent, challenger: judge,
    sessionFactory: fakeFactory(runs), range: "HEAD~1..HEAD" });
  expect(review.findings).toHaveLength(1);
  const round = JSON.parse(readFileSync(join(rdir, "round.json"), "utf8")) as { round: { evidence: Record<string, string> } };
  const pack = Object.values(round.round.evidence).join("\n");
  expect(pack).toContain("The old key");
  expect(readFileSync(join(rdir, "second-opinion-input.jsonl"), "utf8")).toContain("The old key");
  for (const f of walk(rdir)) expect([f, leaks(readFileSync(f, "utf8"))]).toEqual([f, []]);
  expect(leaks(JSON.stringify(judge.calls))).toEqual([]);
}, 60_000);

// ---- values in files secret by their name, the commit message's pairs, cut lines

const PAY = "Su8e" + "nVq1Lm7Zx3";
const CRED = "Cr3d" + "Wq8Lm1Zx5Rv";
const LONG = "L0ngPw4Rx" + "9QmZ2Lk7Vt";
const MSG_PW = "M5g" + "Pw81LmZq3Rx";
const MSG_TOKEN = "Tq7v" + "Lm20ZxWp4Rs";
const NAMED_FILES: Record<string, string> = {
  "app/calc.py": CALC,
  "services/pay/.env.production": `PAY=${PAY}\n`,
  "config/sub/credentials.json": `{"v": "${CRED}"}\n`,
  ".env": `LONG_PW=${LONG}\n`,
  // Quoted bare, under no name that says what they are.
  "app/deploy.py": `from app.calc import total\ndef deploy(items):\n    a, b, c = "${PAY}", "${CRED}", "${LONG}"\n` +
    "    return total(items)\n",
};
const NAMED = [PAY, CRED, LONG, MSG_PW, MSG_TOKEN];
const MESSAGE_PAIRS = `Rotate the keys\n\npassword: ${MSG_PW}\nThen set token=${MSG_TOKEN} in production.`;

function namedProject(): { repo: string; head: string } {
  const repo = initRepo(join(tmp(), "repo"));
  put(repo, NAMED_FILES);
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig("version: 1\nimage: python:3.12-slim\n" +
    "test_command: python -m pytest -q {targets}\n"), "Dev", "2026-10-11"));
  commit(repo, "first");
  writeFileSync(join(repo, "app/calc.py"), CALC.replace("sum(items)", "sum(items) + 1"));
  commit(repo, MESSAGE_PAIRS);
  return { repo, head: runGit(repo, "rev-parse", "HEAD").trim() };
}

test("every value of a file secret by its name is hidden where code quotes it, at any depth and under any key", () => {
  const { repo, head } = namedProject();
  const pack = commitEvidence(repo, head, runGit(repo, "show", "--format=", head))({ testSource: GEN_SRC, testFile: GEN,
    func: "test_x", commitMessage: changeMessage(repo, { kind: "commit", base: `${head}~1`, head }),
    writeDir: "tests/arnx_generated" });
  expect(pack).toContain("a, b, c = ");
  expect(pack).toContain("Rotate the keys");
  expect(NAMED.filter((v) => pack.includes(v))).toEqual([]);
  // The snapshot knows them too, and tests still run on the real code: a guess hides text, it rewrites no code.
  const taken = takeSnapshot(repo, head, join(tmp(), "snap"));
  for (const v of [PAY, CRED, LONG]) expect(taken.suspects.has(v)).toBe(true);
  const code = readFileSync(join(tmp(), "snap", "app/deploy.py"), "utf8");
  for (const v of [PAY, CRED, LONG]) expect(code).toContain(v);
});

test("a review hides the values of files secret by their name and the commit message's pairs in all it writes", async () => {
  const { repo } = namedProject();
  const agent = new ScriptedAgent([
    [tool("write_file", { path: GEN, content: GEN_SRC })],
    [text(JSON.stringify({ tests: [{ test: `${GEN}::test_x`, expects: "sums" }],
      suspected_defects: [{ test: `${GEN}::test_x`, explanation: "off by one." }], questions: [] }))],
  ]);
  const runs = (): [string | null, string, boolean] => [junitXml([[GEN, "test_x", "failed", "assert 4 == 3"]]), "", false];
  const judge = new FakeJson([{ verdict: "confirmed", reason: "x" }, { groups: [] }]);
  const settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-11T00:00:00Z" };
  const { rdir } = await runReview(repo, { settings, agentModel: agent, challenger: judge,
    sessionFactory: fakeFactory(runs), range: "HEAD~1..HEAD" });
  const round = readFileSync(join(rdir, "round.json"), "utf8");
  expect(round).toContain("a, b, c = ");
  expect(round).toContain("Rotate the keys");
  for (const f of walk(rdir)) {
    const body = readFileSync(f, "utf8");
    expect([f, NAMED.filter((v) => body.includes(v))]).toEqual([f, []]);
  }
}, 60_000);

test("a pack is not built without the filter", () => {
  const { repo, head } = namedProject();
  expect(() => judgeEvidence({ tree: gitTree(repo, head), diff: "", testSource: GEN_SRC, func: "test_x", commitMessage: "m",
    writeDir: "tests/arnx_generated" } as unknown as Parameters<typeof judgeEvidence>[0])).toThrow(/filter/);
});

test("a line is masked before it is cut, so a cut leaves no piece of a value", () => {
  const value = "Wd7Kq2Lm9" + "Zx4Rv8Tp3Nb";
  const repo = initRepo(join(tmp(), "repo"));
  // Cut at 160 characters with 7 of the value's left before the cut, too few for the filter to know it as a piece.
  const lead = '    conn = connect(host="';
  const wide = lead + "h".repeat(160 - 1 - 7 - lead.length - '", password="'.length) + `", password="${value}")`;
  const doc = "See `total(items)` " + "w".repeat(200 - 1 - 7 - "See `total(items)` ".length) + value + " end";
  put(repo, { "app/calc.py": CALC, "app/wide.py": `from app.calc import total\ndef wide(items):\n${wide}\n    return total(items)\n`,
    "docs/use.md": `${doc}\n` });
  commit(repo, "first");
  writeFileSync(join(repo, "app/calc.py"), CALC.replace("sum(items)", "sum(items) + 1"));
  const boundary = new Boundary([value]);
  const pack = judgeEvidence({ tree: snapshotTree(repo), diff: runGit(repo, "diff"), testSource: GEN_SRC, testFile: GEN,
    func: "test_x", commitMessage: "", writeDir: "tests/arnx_generated", boundary });
  expect(pack).toContain('conn = connect(host="');
  expect(pack).toContain("docs/use.md:1");
  expect(pack).not.toContain(value.slice(0, 7));
});

test("a value only the base commit names is hidden in a pack built for a replay", () => {
  const base = "Bz5Rm0" + "Qx2Wv8Ln4Tp";
  const repo = initRepo(join(tmp(), "repo"));
  put(repo, { "app/calc.py": `API_KEY = "${base}"\n\n${CALC}`,
    "app/legacy.py": `from app.calc import total\ndef legacy(items):\n    k = "${base}"\n    return total(items)\n` });
  commit(repo, "first");
  writeFileSync(join(repo, "app/calc.py"), CALC.replace("sum(items)", "sum(items) + 1"));
  commit(repo, "second");
  const head = runGit(repo, "rev-parse", "HEAD").trim();
  const pack = commitEvidence(repo, head, runGit(repo, "show", "--format=", head))({ testSource: GEN_SRC, testFile: GEN,
    func: "test_x", commitMessage: "second", writeDir: "tests/arnx_generated" });
  expect(pack).toContain("app/legacy.py:4");
  expect(pack).not.toContain(base);
});
