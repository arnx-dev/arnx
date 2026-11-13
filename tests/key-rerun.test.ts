// A failure beside a faked private key is settled by one rerun with the real key, no network, in a throwaway copy:
// only the rerun's outcome is kept. Keys are generated here, at run time.
import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeAnswerRunner } from "../src/accept";
import { takeSnapshot, withSandboxFiles } from "../src/change";
import { check, checkSummary } from "../src/check";
import { loadReviewFile, parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { exitCode, render, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import { dockerSteps, REPORT_DIR, type Runner, runArgv, Session, sandboxOptions } from "../src/sandbox";
import { commandReruns, KEY_RERUN_MOST, keyReruns, rerunWithRealKeys, withCommandReruns } from "../src/realkey";
import { writeDirOf } from "../src/testround";
import { fakeKeys, withRealKeys } from "../src/secrets";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { approveFile, runSetup } from "../src/setup";
import { Cli } from "./helpers/cli";
import { fakeFactory, FakeSession, type Script, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { RecordingAgent, RecordingJson } from "./helpers/recording";
import { pinKept } from "./helpers/pins";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex");
/** The real key's body lines: none may be anywhere arnx writes or sends. */
const bodyLines = pem.split("\n").filter((l) => l.length >= 32 && !l.startsWith("-----"));
const PEM_PATH = "tests/data/server.pem";
const put = (repo: string, path: string, content: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };
const GEN = "tests/arnx_generated/test_key.py";
const SOURCE = "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n\ndef test_other():\n    assert 1\n";
const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }, { test: `${GEN}::test_other`, expects: "x" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }, { test: `${GEN}::test_other`, explanation: "x." }],
  questions: [] });
const WRITE = () => [[tool("write_file", { path: GEN, content: SOURCE }), tool("run_tests", {})]];

function project(): string {
  const repo = gitRepo(mkdtempSync(join(tmp(), "r-")));
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-11-04"));
  writeSettings(repo, SETTINGS);
  put(repo, PEM_PATH, pem);
  commit(repo, "the code");
  put(repo, "app.py", "def add(a, b):\n    return a - b\n");
  commit(repo, "the change");
  return repo;
}

/** Whether the run at `dir` holds the real key. */
const realIn = (dir: string) => existsSync(join(dir, PEM_PATH)) && sha(readFileSync(join(dir, PEM_PATH))) === sha(pem);

async function review(repo: string, script: Script) {
  const seen: FakeSession[] = [];
  const agent = new RecordingAgent(WRITE(), REPORT), json = new RecordingJson();
  const said: string[] = [];
  const out = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: json, progress: (m) => said.push(m),
    sessionFactory: fakeFactory(script, seen) });
  return { ...out, seen, agent, json, said };
}

// --- a failure the fake caused, with no word that says so --------------------------------------------------------------------

for (const [row, message, outcome] of [
  ["a hash check", "E   AssertionError: assert '3f9a0c' == '81d2e4'", "failed"],
  ["a swallowed parse error", "E   assert None is not None", "failed"],
  ["a skip", "the key does not load", "skipped"],
] as const) {
  test(`${row} beside a fake that passes with the real key reads as unproven, needing the real key, never a finding`, async () => {
    const repo = project();
    const r = await review(repo, (_c, _n, dir) => [junitXml([[GEN, "test_add", realIn(dir) ? "passed" : outcome, message],
      [GEN, "test_other", "passed", ""]]), "ran\n", false]);
    const sealed = r.seen.flatMap((s) => s.sealedRuns);
    expect(sealed.length).toBe(1);
    expect(r.review.findings).toEqual([]);
    expect(r.review.couldNotRun).toEqual([{ test: `${GEN}::test_add`, needs: PEM_PATH, faked: true }]);
    expect(exitCode(r.review)).toBe(2);
    expect(summary(r.review, "review.md")).toContain(`it needs the real key in ${PEM_PATH}`);
    expect(render(r.review)).toContain(`needs the real key in \`${PEM_PATH}\``);
  });
}

test("a real regression next to a faked key stays a finding: the rerun with the real key fails too", async () => {
  const repo = project();
  const r = await review(repo, () => [junitXml([[GEN, "test_add", "failed", "E   assert -1 == 5"], [GEN, "test_other", "passed", ""]]),
    "ran\n", false]);
  expect(r.seen.flatMap((s) => s.sealedRuns).length).toBe(1);
  expect(r.review.findings.map((f) => f.testId)).toEqual([`${GEN}::test_add`]);
  expect(r.review.couldNotRun).toBeUndefined();
});

test("no fake, no rerun; a passing test is never rerun", async () => {
  const repo = project();
  const r = await review(repo, () => [junitXml([[GEN, "test_add", "passed", ""], [GEN, "test_other", "passed", ""]]), "ran\n", false]);
  expect(r.seen.flatMap((s) => s.sealedRuns)).toEqual([]);
});

// --- nothing of the real-key run is kept ------------------------------------------------------------------------------------------

/** Every file under `dir` but `skip`, with its path. */
function files(dir: string, skip: (rel: string) => boolean, rel = ""): [string, string][] {
  return readdirSync(join(dir, rel)).flatMap((name) => {
    const r = rel ? `${rel}/${name}` : name;
    if (skip(r)) return [];
    const st = lstatSync(join(dir, r));
    return st.isDirectory() ? files(dir, skip, r) : st.isFile() ? [[r, readFileSync(join(dir, r), "latin1")] as [string, string]] : [];
  });
}

test("the real-key run's output, report and files are in no request, file or log", async () => {
  const repo = project();
  const SENTINEL = "SENTINEL-REAL-KEY-RUN";
  const r = await review(repo, (_c, _n, dir) => {
    if (!realIn(dir)) {
      return [junitXml([[GEN, "test_add", "failed", "E   assert digest == expected"], [GEN, "test_other", "failed", "E   assert 1 == 2"]]),
        "2 failed\n", false];
    }
    // The run with the real key prints it, quotes it in its report and leaves it in files.
    writeFileSync(join(dir, "leak.txt"), `${SENTINEL}\n${pem}`);
    put(dir, "tests/arnx_generated/__pycache__/test_key.cpython-312.pyc", pem);
    return [junitXml([[GEN, "test_add", "passed", ""], [GEN, "test_other", "failed", `E   ${SENTINEL} ${pem}`]]),
      `${SENTINEL} ${pem}`, false];
  });
  const sealed = r.seen.flatMap((s) => s.sealedRuns);
  expect(sealed.length).toBe(1);
  // Only the outcomes came back: one test needs the key, the other's finding stands with the fake run's own words.
  expect(r.review.couldNotRun).toEqual([{ test: `${GEN}::test_add`, needs: PEM_PATH, faked: true }]);
  expect(r.review.findings.map((f) => [f.testId, f.message.split("\n")[0]])).toEqual([[`${GEN}::test_other`, "E   assert 1 == 2"]]);
  // The copy the rerun saw is gone.
  for (const s of sealed) expect(existsSync(s.src)).toBe(false);
  // The snapshot's own file still held the fake for the runs after it.
  const leaks = (t: string) => t.includes(SENTINEL) || bodyLines.some((l) => t.includes(l));
  const written = files(repo, (p) => p === ".git" || p === PEM_PATH).filter(([, t]) => leaks(t)).map(([p]) => p);
  expect(written).toEqual([]);
  expect(r.agent.bodies.filter(leaks)).toEqual([]);
  expect(r.json.bodies.filter(leaks)).toEqual([]);
  expect(r.said.filter(leaks)).toEqual([]);
  expect(leaks(JSON.stringify(r.review))).toBe(false);
});

const GEN2 = "tests/arnx_generated/test_more.py";
type Row = [string, string, string, string];
const named = (file: string, n: number, prefix: string) => Array.from({ length: n }, (_, i) => `${prefix}${String(i).padStart(2, "0")}`)
  .map((name) => [file, name, "failed", "E   assert 1 == 2"] as Row);

test(`the cap counts every test run with the key: past ${KEY_RERUN_MOST} a file is not rerun, and its failures read as unproven, not rerun`, async () => {
  const repo = project();
  // 15 tests in one file, 7 in another: the first fits, the second would pass the cap.
  const rows = [...named(GEN, 15, "test_a"), ...named(GEN2, 7, "test_b")];
  const seen: FakeSession[] = [];
  const agent = new RecordingAgent([[tool("write_file", { path: GEN, content: SOURCE }), tool("write_file", { path: GEN2, content: SOURCE }),
    tool("run_tests", {})]], REPORT);
  const out = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(), progress: () => {},
    sessionFactory: fakeFactory(() => [junitXml(rows), "ran\n", false], seen) });
  const sealed = seen.flatMap((s) => s.sealedRuns);
  expect(sealed.length).toBe(1);
  expect(sealed[0]!.command).toContain(GEN);
  expect(sealed[0]!.command).not.toContain(GEN2);
  expect(out.review.couldNotRun?.map((x) => x.test)).toEqual(rows.slice(15).map(([f, n]) => `${f}::${n}`));
  expect(out.review.couldNotRun?.every((x) => x.notRerun)).toBe(true);
  expect(summary(out.review, "review.md")).toContain(`they may need the real key in ${PEM_PATH}`);
  expect(render(out.review)).toContain("not rerun with it");
});

test(`a file of more than ${KEY_RERUN_MOST} tests is never rerun, even for one failure`, async () => {
  const repo = project();
  const rows: Row[] = [...named(GEN, KEY_RERUN_MOST, "test_p").map(([f, n]) => [f, n, "passed", ""] as Row), [GEN, "test_add", "failed", "E   x"]];
  const r = await review(repo, () => [junitXml(rows), "ran\n", false]);
  expect(r.seen.flatMap((s) => s.sealedRuns)).toEqual([]);
  expect(r.review.couldNotRun).toEqual([{ test: `${GEN}::test_add`, needs: PEM_PATH, faked: true, notRerun: true }]);
});

test("arnx accept's answer rounds share one cap: what one round ran with the key, the next cannot", async () => {
  const repo = project();
  const file = loadReviewFile(repo);
  const base = writeDirOf(file.projects[0]!, "answers");
  const rows = named(`${base}/test_ans.py`, 15, "test_q");
  const round = () => [[tool("write_file", { path: `${base}/test_ans.py`, content: SOURCE }), tool("run_tests", {})],
    [text(`{"tests": [{"test": "${base}/test_ans.py::test_q00", "expects": "x"}]}`)]];
  const agent = new ScriptedAgent([...round(), ...round()]);
  const seen: FakeSession[] = [];
  const run = makeAnswerRunner(repo, file, SETTINGS, agent, fakeFactory(() => [junitXml(rows), "ran\n", false], seen));
  await run("Q1", "q?", "yes", "", join(tmp(), "a1"), file.projects[0]!.name);
  expect(seen.flatMap((s) => s.sealedRuns).length).toBe(1);
  await run("Q2", "q?", "yes", "", join(tmp(), "a2"), file.projects[0]!.name);
  expect(seen.flatMap((s) => s.sealedRuns).length).toBe(1);
});

test("one command's steps share one cap: accept's re-prove, answer rounds and closing check together run at most 20 with the key", async () => {
  const repo = project();
  const file = loadReviewFile(repo);
  const base = writeDirOf(file.projects[0]!, "answers");
  const KEPT = "tests/arnx/r1/test_kept.py";
  put(repo, `.arnx/tests/${KEPT}`, SOURCE);
  pinKept(repo);
  const sealed = (seen: FakeSession[]) => seen.flatMap((x) => x.sealedRuns).length;
  await withCommandReruns(async () => {
    // The re-prove: its suite fails 15 tests on the fake.
    const proof: FakeSession[] = [];
    await approveFile(repo, { by: "Dev", at: "x", sessionFactory: fakeFactory(() => [junitXml(named("tests/test_s.py", 15, "test_s")),
      "ran\n", false], proof) });
    expect(sealed(proof)).toBe(1);
    // An answer round of 10 failing tests no longer fits.
    const answers: FakeSession[] = [];
    const agent = new ScriptedAgent([[tool("write_file", { path: `${base}/test_ans.py`, content: SOURCE }), tool("run_tests", {})],
      [text(`{"tests": [{"test": "${base}/test_ans.py::test_q00", "expects": "x"}]}`)]]);
    await makeAnswerRunner(repo, file, SETTINGS, agent, fakeFactory(() => [junitXml(named(`${base}/test_ans.py`, 10, "test_q")), "ran\n",
      false], answers))("Q1", "q?", "yes", "", join(tmp(), "a1"), file.projects[0]!.name);
    expect(sealed(answers)).toBe(0);
    // The closing check's 5 still do.
    const checked: FakeSession[] = [];
    await check(repo, SETTINGS, { sessionFactory: fakeFactory(() => [junitXml(named(KEPT, 5, "test_k")), "ran\n", false], checked) });
    expect(sealed(checked)).toBe(1);
  });
});

test("the CLI runs each command in one budget, and none outlives it", async () => {
  const repo = project();
  put(repo, ".arnx/tests/tests/arnx/r1/test_kept.py", SOURCE);
  pinKept(repo);
  const during: (object | null)[] = [];
  const cli = new Cli({ cwd: repo, checkSessions: async (_c, snap, _l, body) => {
    during.push(commandReruns());
    return body(new FakeSession(snap, () => [junitXml([["tests/arnx/r1/test_kept.py", "test_add", "passed", ""]]), "ran\n", false]));
  } });
  await cli.run("check");
  expect(during.length).toBeGreaterThan(0);
  expect(during.every((b) => b !== null)).toBe(true);
  expect(commandReruns()).toBeNull();
});

// --- a test that turns on the rerun: links, modes, its report ----------------------------------------------------------------------

/** A snapshot of a project holding the key, as a review takes it, and what reruns there need. */
function keyedSnap() {
  const repo = project();
  const snap = join(mkdtempSync(join(tmp(), "arnx-")), "repo");
  takeSnapshot(repo, null, snap, [], {});
  expect(readFileSync(join(snap, PEM_PATH), "utf8")).not.toBe(pem);
  const cfg = parseReviewConfig(YAML);
  const failing = { testId: `${GEN}::test_add`, fileAttr: GEN, name: "test_add", outcome: "failed", message: "E   x" };
  const rerun = (runner: Runner, rows: Row[] = [[GEN, "test_add", "passed", ""]], budget = keyReruns()) => rerunWithRealKeys(runner, snap,
    cfg, { source: { repo, head: null }, fakedKeys: [PEM_PATH], tests: [failing], all: [[failing]], target: () => GEN, budget,
      timeout: 30 });
  return { repo, snap, cfg, rerun };
}
/** A runner whose sealed run does `act` in the copy, then writes `rows` as its report. */
const sealedRunner = (act: (src: string) => void, rows: Row[] = [[GEN, "test_add", "passed", ""]]) => {
  const seen: string[] = [];
  const runner: Runner = { run: () => ({ exitCode: 0, output: "", timedOut: false, seconds: 0 }), sealed: (command, _t, src) => {
    seen.push(src);
    act(src);
    const m = /--junitxml=\/src\/(\S+)/.exec(command);
    if (m && rows.length && existsSync(dirname(join(src, m[1]!)))) writeFileSync(join(src, m[1]!), junitXml(rows));
    return { exitCode: 0, timedOut: false };
  } };
  return { runner, seen };
};
/** Every file under `dir` that holds a body line of the real key, no link followed. */
const holdingKey = (dir: string) => files(dir, () => false).filter(([, t]) => bodyLines.some((l) => t.includes(l))).map(([p]) => p);

test("a link the faked run left that leads out of the copy takes nothing out: the snapshot keeps its fake, and nothing reruns", async () => {
  const { snap, rerun } = keyedSnap();
  // As the reviewer's probe: tests/data becomes a link to a folder of the snapshot holding the fake.
  mkdirSync(join(snap, "leak"));
  writeFileSync(join(snap, "leak/server.pem"), readFileSync(join(snap, PEM_PATH)));
  rmSync(join(snap, "tests/data"), { recursive: true });
  symlinkSync("../../repo/leak", join(snap, "tests/data"));
  const before = files(snap, () => false);
  const { runner, seen } = sealedRunner(() => {});
  const got = await rerun(runner);
  expect(got.get(`${GEN}::test_add`)).toBeNull();
  expect(seen).toEqual([]);
  expect(files(snap, () => false)).toEqual(before);
  expect(holdingKey(dirname(snap))).toEqual([]);
});

test("a link inside the copy that leads out through another is dropped too", async () => {
  const { snap, rerun } = keyedSnap();
  const fake = readFileSync(join(snap, PEM_PATH));
  mkdirSync(join(snap, "sub"));
  symlinkSync("..", join(snap, "sub/up"));
  // Read as text it stays inside; followed, sub/up/.. is the folder above the copy, and repo/ there is the snapshot.
  rmSync(join(snap, "tests/data"), { recursive: true });
  mkdirSync(join(snap, "elsewhere/tests/data"), { recursive: true });
  writeFileSync(join(snap, "elsewhere/tests/data/server.pem"), fake);
  symlinkSync("../sub/up/../repo/elsewhere/tests/data", join(snap, "tests/data"));
  const { runner } = sealedRunner(() => {});
  await rerun(runner);
  expect(holdingKey(dirname(snap))).toEqual([]);
});

test("a FIFO the faked run left is left out of the copy, and the rerun goes on", async () => {
  const { snap, rerun } = keyedSnap();
  expect(spawnSync("mkfifo", [join(snap, "pipe")]).status).toBe(0);
  const { runner, seen } = sealedRunner(() => {});
  expect((await rerun(runner)).get(`${GEN}::test_add`)).toBe("passed");
  expect(seen.length).toBe(1);
});

test("a test that takes the write bit from a folder of the copy leaves no real key on disk", async () => {
  const { snap, rerun } = keyedSnap();
  const { runner, seen } = sealedRunner((src) => chmodSync(join(src, "tests/data"), 0o500));
  const got = await rerun(runner);
  expect(got.get(`${GEN}::test_add`)).toBe("passed");
  expect(seen.length).toBe(1);
  expect(existsSync(seen[0]!)).toBe(false);
  expect(holdingKey(dirname(snap))).toEqual([]);
});

test("a copy an earlier arnx left behind is removed by the next run", async () => {
  const dead = spawnSync("true").pid!;
  const left = join(tmp(), `repo.${dead}.realkey`);
  mkdirSync(join(left, "tests/data"), { recursive: true });
  writeFileSync(join(left, PEM_PATH), pem);
  chmodSync(join(left, "tests/data"), 0o500);
  const repo = project();
  await check(repo, SETTINGS, { sessionFactory: fakeFactory(() => [null, "", false]) });
  expect(existsSync(left)).toBe(false);
});

test("the report is read only as a regular file in the copy: a link to a file outside is not followed", async () => {
  const { snap, rerun } = keyedSnap();
  const outside = join(dirname(snap), "outside.xml");
  writeFileSync(outside, junitXml([[GEN, "test_add", "passed", ""]]));
  const { runner } = sealedRunner((src) => {
    mkdirSync(join(src, REPORT_DIR), { recursive: true });
    rmSync(join(src, REPORT_DIR, "realkey.xml"), { force: true });
    symlinkSync(outside, join(src, REPORT_DIR, "realkey.xml"));
  }, []);
  expect((await rerun(runner)).get(`${GEN}::test_add`)).toBeNull();
});

test("nor is a report under a folder the test made a link to outside", async () => {
  const { snap, rerun } = keyedSnap();
  const outside = join(dirname(snap), "out");
  mkdirSync(outside);
  writeFileSync(join(outside, "realkey.xml"), junitXml([[GEN, "test_add", "passed", ""]]));
  const { runner } = sealedRunner((src) => {
    rmSync(join(src, REPORT_DIR), { recursive: true, force: true });
    symlinkSync(outside, join(src, REPORT_DIR));
  }, []);
  expect((await rerun(runner)).get(`${GEN}::test_add`)).toBeNull();
});

test("a test missing from the rerun's report is not rerun, however its file ran", async () => {
  const { rerun } = keyedSnap();
  const { runner } = sealedRunner(() => {}, [[GEN, "test_other", "passed", ""]]);
  expect((await rerun(runner, [[GEN, "test_other", "passed", ""]])).get(`${GEN}::test_add`)).toBeNull();
});

test("the real key goes back only where its fake stands: a file that differs otherwise gets nothing", () => {
  const text = `KEY = """${pem}"""\nPASSWORD = "x"\n`;
  const faked = fakeKeys(text).text;
  expect(faked).not.toBe(text);
  expect(withRealKeys(text, faked)).toBe(text);
  // Another stand-in beside it stays.
  expect(withRealKeys(text, faked.replace('"x"', '"y"'))).toBe(text.replace('"x"', '"y"'));
  // A line the file on the host no longer has, or a key that is not this one: nothing goes in.
  expect(withRealKeys(text, faked.replace("KEY =", "KEYS ="))).toBe(text.replace("KEY =", "KEYS ="));
  expect(withRealKeys(text.replace(bodyLines[0]!, bodyLines[0]!.split("").reverse().join("")), faked)).toBeNull();
});

test("a sandbox-only file is never written through a link a run left, for a run or a sealed run", async () => {
  const root = mkdtempSync(join(tmp(), "w-"));
  const snap = join(root, "repo"), outside = join(root, "outside");
  mkdirSync(join(`${snap}.sandbox`, "data"), { recursive: true });
  writeFileSync(join(`${snap}.sandbox`, "data/cfg.txt"), "SANDBOX-ONLY");
  mkdirSync(outside);
  mkdirSync(snap);
  symlinkSync("../outside", join(snap, "data"));
  const copy = join(root, "copy");
  mkdirSync(copy);
  symlinkSync("../outside", join(copy, "data"));
  const inner: Runner = { run: () => ({ exitCode: 0, output: "", timedOut: false, seconds: 0 }),
    sealed: () => ({ exitCode: 0, timedOut: false }) };
  const placed = withSandboxFiles(inner, snap);
  await placed.run("true", 5);
  await placed.sealed!("true", 5, copy);
  expect(readdirSync(outside)).toEqual([]);
  // A dangling link where the file goes is not written through either.
  rmSync(join(snap, "data"));
  mkdirSync(join(snap, "data"));
  symlinkSync(join(outside, "made.txt"), join(snap, "data/cfg.txt"));
  await placed.run("true", 5);
  expect(readdirSync(outside)).toEqual([]);
});

// --- check and setup's baseline ---------------------------------------------------------------------------------------------------

test("arnx check: a kept test failing on the fake and passing with the real key is unproven, exit 2", async () => {
  const repo = project();
  const KEPT = "tests/arnx/r1/test_kept.py";
  put(repo, `.arnx/tests/${KEPT}`, SOURCE);
  pinKept(repo);
  const seen: FakeSession[] = [];
  const results = await check(repo, SETTINGS, { sessionFactory: fakeFactory((_c, _n, dir) =>
    [junitXml([[KEPT, "test_add", realIn(dir) ? "passed" : "failed", "E   assert '3f' == '81'"]]), "ran\n", false], seen) });
  expect(seen.flatMap((s) => s.sealedRuns).length).toBe(1);
  expect(results[0]!.failed).toEqual([]);
  expect(results[0]!.couldNotRun).toEqual([{ testId: `${KEPT}::test_add`, needs: PEM_PATH, faked: true }]);
  expect(checkSummary(results)[1]).toBe(2);
  // A failure that stands with the real key is still red.
  const red = await check(repo, SETTINGS, { sessionFactory: fakeFactory(() =>
    [junitXml([[KEPT, "test_add", "failed", "E   assert -1 == 5"]]), "ran\n", false]) });
  expect(red[0]!.failed.map((t) => t.testId)).toEqual([`${KEPT}::test_add`]);
  expect(checkSummary(red)[1]).toBe(1);
});

const SETUP_YAML = "version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
  "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n";
test("setup: a hash check failing on the fake and passing with the real key is kept out of the baseline, needing the key", async () => {
  const repo = gitRepo(mkdtempSync(join(tmp(), "r-")));
  put(repo, PEM_PATH, pem);
  put(repo, "test_shop.py", "def test_a():\n    assert 1\n");
  commit(repo, "shop");
  const seen: FakeSession[] = [];
  const r = await runSetup(repo, defaultSettings(), new ScriptedAgent([[tool("propose", { yaml: SETUP_YAML })], [text("done")]]),
    { outDir: join(tmp(), "setup"), progress: () => {}, sessionFactory: fakeFactory((_c, _n, dir) => [junitXml([
      ["test_shop.py", "test_ok", "passed", ""], ["test_shop.py", "test_key", realIn(dir) ? "passed" : "failed", "E   assert '3f' == '81'"]]),
      "ran\n", false], seen) });
  expect(r.ok).toBe(true);
  expect(seen.flatMap((s) => s.sealedRuns).length).toBeGreaterThan(0);
  const proof = r.projects[0]!;
  expect(proof.unproven).toEqual([{ testId: "test_shop.py::test_key", needs: PEM_PATH, faked: true }]);
  expect(proof.failed ?? []).toEqual([]);
});

// --- the rerun's container --------------------------------------------------------------------------------------------------------

test("the rerun runs with no network, even with services, and what it prints is never read", async () => {
  const dir = mkdtempSync(join(tmp(), "d-"));
  const args = join(dir, "args"), fake = join(dir, "docker");
  writeFileSync(fake, `#!/bin/sh\nprintf '%s\\n' "$@" > '${args}'\necho SENTINEL-OUT\necho SENTINEL-ERR >&2\nexit 3\n`);
  chmodSync(fake, 0o755);
  const saved = sandboxOptions.docker, savedLog = dockerSteps.log;
  const logged: string[] = [];
  sandboxOptions.docker = fake;
  dockerSteps.log = (line) => { logged.push(JSON.stringify(line)); };
  try {
    const cfg = parseReviewConfig(YAML + "services:\n  db: {image: postgres:16-alpine}\n");
    const s = new Session("img", cfg, join(dir, "snap"));
    expect(s.network).not.toBe("none");
    const src = join(dir, "copy");
    mkdirSync(src);
    const r = await s.sealed("python -m pytest -q t.py", 30, src);
    expect(r).toEqual({ exitCode: 3, timedOut: false });
    const argv = readFileSync(args, "utf8").split("\n");
    expect(argv[0]).toBe("run");
    expect(argv[argv.indexOf("--network") + 1]).toBe("none");
    expect(argv.filter((a) => a === "--network").length).toBe(1);
    expect(argv).toContain(`${src}:/src`);
    expect(argv[argv.indexOf("--log-driver") + 1]).toBe("none");
    expect(argv).not.toContain(`${join(dir, "snap")}:/src`);
    expect(logged.join("\n")).not.toContain("SENTINEL");
    s.close();
  } finally {
    sandboxOptions.docker = saved;
    dockerSteps.log = savedLog;
  }
});

test("runArgv: a run that keeps no log asks Docker for none; other runs keep the daemon's own", () => {
  const o = { image: "img", name: "n", network: "none", snapshot: "/s", workdir: ".", env: {}, command: "true",
    limits: { cpus: "1", memory: "1g", pids: 10, tmp: "1g" }, user: "1:1", runEnv: [] };
  const sealed = runArgv({ ...o, noLog: true });
  expect(sealed[sealed.indexOf("--log-driver") + 1]).toBe("none");
  expect(runArgv(o)).not.toContain("--log-driver");
});

test.skipIf(!process.env.ARNX_DOCKER_TESTS)("docker: the rerun's container has no network but loopback", async () => {
  const cfg = parseReviewConfig(YAML);
  const src = mkdtempSync(join(tmp(), "copy-"));
  chmodSync(src, 0o777);
  const s = new Session("python:3.12-slim", cfg, join(tmp(), "snap"));
  try {
    const r = await s.sealed("ls /sys/class/net > /src/net.txt; python -c 'import socket; socket.create_connection((\"1.1.1.1\", 53), 3)' " +
      "&& echo reached >> /src/net.txt; true", 120, src);
    expect(r.timedOut).toBe(false);
    expect(readFileSync(join(src, "net.txt"), "utf8")).toBe("lo\n");
  } finally {
    s.close();
  }
}, 180_000);
