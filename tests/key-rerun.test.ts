// A failure beside a faked private key is settled by one rerun with the real key, no network, in a throwaway copy:
// only the rerun's outcome is kept. Keys are generated here, at run time.
import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check, checkSummary } from "../src/check";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { exitCode, render, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import { dockerSteps, Session, sandboxOptions } from "../src/sandbox";
import { KEY_RERUN_MOST } from "../src/realkey";
import { fakeKeys, withRealKeys } from "../src/secrets";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { fakeFactory, type FakeSession, type Script, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { RecordingAgent, RecordingJson } from "./helpers/recording";
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

test(`past ${KEY_RERUN_MOST} tests a review reruns no more: the rest read as unproven, not rerun, never a finding`, async () => {
  const repo = project();
  const many = Array.from({ length: KEY_RERUN_MOST + 2 }, (_, i) => `test_k${String(i).padStart(2, "0")}`);
  const r = await review(repo, () => [junitXml(many.map((n) => [GEN, n, "failed", "E   assert 1 == 2"] as [string, string, string, string])),
    "ran\n", false]);
  expect(r.seen.flatMap((s) => s.sealedRuns).length).toBe(1);
  // The first by test id were rerun and failed again; the last two were not rerun.
  expect(r.review.couldNotRun?.map((x) => x.test)).toEqual(many.slice(KEY_RERUN_MOST).map((n) => `${GEN}::${n}`));
  expect(summary(r.review, "review.md")).toContain(`they may need the real key in ${PEM_PATH}`);
  expect(render(r.review)).toContain("not rerun with it");
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

// --- check and setup's baseline ---------------------------------------------------------------------------------------------------

test("arnx check: a kept test failing on the fake and passing with the real key is unproven, exit 2", async () => {
  const repo = project();
  const KEPT = "tests/arnx/r1/test_kept.py";
  put(repo, `.arnx/tests/${KEPT}`, SOURCE);
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
    expect(argv).not.toContain(`${join(dir, "snap")}:/src`);
    expect(logged.join("\n")).not.toContain("SENTINEL");
    s.close();
  } finally {
    sandboxOptions.docker = saved;
    dockerSteps.log = savedLog;
  }
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
