// A file left out must never hide or fake a result: whatever could not run says why, names the file and the way out.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Boundary } from "../src/boundary";
import { check, checkJson, checkSummary } from "../src/check";
import { CloudClient } from "../src/cloud";
import { CloudBrain } from "../src/cloudbrain";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { recheckReview, recheckSummary } from "../src/recheck";
import { exitCode, load, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { type FakeCloud, fakeCloud, type StepScript, TOKEN } from "./helpers/cloudfake";
import { fakeFactory, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { RecordingAgent, RecordingJson } from "./helpers/recording";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const KEY = "PRIVATE " + "KEY";
const LIB = `def is_key(s):\n    return s.startswith("-----BEGIN ${KEY}-----")\n`;
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";
const OTHER = "tests/arnx_generated/test_other.py";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };
const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: [] });
const SOURCE = "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n";
const WRITE = () => [[tool("write_file", { path: GEN, content: SOURCE }), tool("run_tests", {})]];
const LOAD = "collection failure\nE   ModuleNotFoundError: No module named 'lib'";
const LAZY = "E   ModuleNotFoundError: No module named 'lib'";

function repoWith(o: { inChange?: boolean; settings?: Settings } = {}): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-11-04"));
  writeSettings(repo, o.settings ?? SETTINGS);
  writeFileSync(join(repo, "lib.py"), o.inChange ? "def is_key(s):\n    return True\n" : LIB);
  commit(repo, "the code");
  writeFileSync(join(repo, "app.py"), "import lib\n\ndef add(a, b):\n    return a - b\n");
  if (o.inChange) writeFileSync(join(repo, "lib.py"), LIB);
  commit(repo, "the change");
  return repo;
}
const failing = (message: string) => () => [junitXml([[GEN, "test_add", "failed", message]]), "1 failed\n", false] as [string, string, boolean];
const review = async (repo: string, message: string, settings = SETTINGS) => {
  const agent = new RecordingAgent(WRITE(), REPORT), judge = new RecordingJson();
  const r = await runReview(repo, { settings, agentModel: agent, challenger: judge, progress: () => {},
    sessionFactory: fakeFactory(failing(message)) });
  return { ...r, agent, judge };
};

for (const [name, message] of [["its import stops the file loading", LOAD], ["its import fails inside the test", LAZY]] as const) {
  test(`a review whose test needs a left-out file does not read as clean: ${name}`, async () => {
    const repo = repoWith();
    const { review: r, rdir, agent } = await review(repo, message);
    expect(r.findings).toEqual([]);
    expect(exitCode(r)).toBe(2);
    const said = summary(r, "review.md");
    expect(said).not.toContain("No findings and no questions.");
    expect(said).toContain("lib.py");
    expect(said).toContain("arnx allow-secret");
    expect(said).toContain("could not run");
    const md = readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " ");
    expect(md).toContain("`lib.py`");
    expect(md).toContain("arnx allow-secret");
    expect(md).toContain(`\`${GEN}::test_add\` needs \`lib.py\``);
    expect(md).not.toContain("Run `arnx review` again to cover it");
    // The saved review reads the same, and the model was told.
    expect(exitCode(load(rdir))).toBe(2);
    expect(agent.bodies[0]).toContain("`lib.py` (a private key)");
  });
}

test("a file the change adds a header to: the test is no regression, on the code before the change or after", async () => {
  const settings = { ...SETTINGS, beforeCheck: true };
  const repo = repoWith({ inChange: true, settings });
  const { review: r } = await review(repo, LAZY, settings);
  expect(r.findings).toEqual([]);
  expect(exitCode(r)).toBe(2);
  expect(summary(r, "review.md")).toContain("lib.py");
});

test("the second opinion is told what was left out, as a finding beside it may read otherwise", async () => {
  const repo = repoWith();
  const twin = "def test_other():\n    assert 1 == 2\n";
  const agent = new RecordingAgent([[tool("write_file", { path: GEN, content: SOURCE }), tool("write_file", { path: OTHER, content: twin }),
    tool("run_tests", {})]], JSON.stringify({ tests: [], suspected_defects: [{ test: `${OTHER}::test_other`, explanation: "x" }], questions: [] }));
  const judge = new RecordingJson();
  const { review: r } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge, progress: () => {},
    sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "failed", LAZY], [OTHER, "test_other", "failed", "assert 1 == 2"]]), "2 failed\n", false]) });
  expect(r.findings.map((f) => f.testId)).toEqual([`${OTHER}::test_other`]);
  expect(judge.bodies.join("\n")).toContain("`lib.py` (a private key)");
  expect(exitCode(r)).toBe(1);
  expect(summary(r, "review.md")).toContain("lib.py");
});

test("a left-out file no test needs: the review is as it was, and the terminal still names it", async () => {
  const repo = repoWith();
  const agent = new RecordingAgent(WRITE(), JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "x" }], suspected_defects: [], questions: [] }));
  const { review: r } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(), progress: () => {},
    sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "passed", ""]]), "1 passed\n", false]) });
  expect(exitCode(r)).toBe(0);
  const said = summary(r, "review.md");
  expect(said).toContain("lib.py (a private key, line 2)");
  expect(said).toContain("arnx allow-secret");
});

test("a run with no report beside a left-out file names it", async () => {
  const repo = repoWith();
  const { review: r } = await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent(WRITE(), REPORT), challenger: new RecordingJson(), progress: () => {},
    sessionFactory: fakeFactory(() => [null, "error[E0583]: file not found for module\n", false]) });
  expect(exitCode(r)).toBe(2);
  expect(summary(r, "review.md")).toContain("lib.py");
});

let clouds: FakeCloud[] = [];
afterEach(() => {
  for (const c of clouds) c.stop();
  clouds = [];
});
test("arnx cloud is told through the diff it takes", async () => {
  const repo = repoWith();
  const rounds: StepScript[] = [{ type: "final", report: { tests: [], suspected_defects: [], questions: [] } }, { type: "done", stop: "end_turn" }];
  const cloud = fakeCloud({ rounds: { "*": rounds } });
  clouds.push(cloud);
  await runReview(repo, { settings: SETTINGS, brain: new CloudBrain({ boundary: new Boundary(),
    client: new CloudClient(cloud.url, { token: TOKEN, delays: [0] }), tier: "medium" }), sessionFactory: fakeFactory(failing(LAZY)) });
  const started = cloud.seen.find((x) => /\/agent$/.test(x.path))!.body as { diff: string };
  expect(started.diff).toContain("`lib.py` (a private key)");
});

// --- arnx check -----------------------------------------------------------------------------------------------------------------

const KEPT = "tests/arnx/r1/test_kept.py";
function kept(): string {
  const repo = repoWith();
  mkdirSync(join(repo, ".arnx/tests/tests/arnx/r1"), { recursive: true });
  writeFileSync(join(repo, `.arnx/tests/${KEPT}`), "import lib\n\ndef test_kept():\n    assert lib\n");
  return repo;
}
for (const [name, message] of [["at the top of the test file", LOAD], ["inside the test", LAZY]] as const) {
  test(`arnx check, a passing test now needing a left-out file, ${name}: no bug to fix, and the file named`, async () => {
    const results = await check(kept(), SETTINGS, { sessionFactory: fakeFactory(() =>
      [junitXml([[KEPT, "test_kept", "failed", message]]), "1 failed\n", false]) });
    const [text, code] = checkSummary(results);
    expect(code).toBe(2);
    expect(text).toContain("lib.py");
    expect(text).toContain("left out");
    expect(text).toContain("arnx allow-secret");
    expect(text).not.toContain("Fix the code");
    expect(text).not.toContain("still fail");
    const json = JSON.parse(checkJson(results, code));
    expect(json.projects[0].could_not_run).toEqual([{ test_id: `${KEPT}::test_kept`, needs: "lib.py" }]);
    expect(json.projects[0].failed).toEqual([]);
    expect(json.projects[0].left_out.map((w: { path: string }) => w.path)).toEqual(["lib.py"]);
  });
}

test("arnx check, a real failure beside it stays a failure, and the file is named as what it may need", async () => {
  const results = await check(kept(), SETTINGS, { sessionFactory: fakeFactory(() =>
    [junitXml([[KEPT, "test_kept", "failed", "assert 1 == 2"]]), "1 failed\n", false]) });
  const [text, code] = checkSummary(results);
  expect(code).toBe(1);
  expect(text).toContain("lib.py");
  expect(text).toContain("arnx allow-secret");
});

test("arnx check, no report: the file is named", async () => {
  const results = await check(kept(), SETTINGS, { sessionFactory: fakeFactory(() => [null, "boom\n", false]) });
  const [text, code] = checkSummary(results);
  expect(code).toBe(2);
  expect(text).toContain("lib.py");
});

test("arnx check, all passing with a file left out: as it was", async () => {
  const results = await check(kept(), SETTINGS, { sessionFactory: fakeFactory(() =>
    [junitXml([[KEPT, "test_kept", "passed", ""]]), "1 passed\n", false]) });
  expect(checkSummary(results)[1]).toBe(0);
});

test("arnx check --review: a confirmed test needing a left-out file is no bug still there", async () => {
  const repo = repoWith();
  const agent = new RecordingAgent(WRITE(), REPORT);
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(), progress: () => {},
    sessionFactory: fakeFactory(failing("assert 1 == 5")) });
  const r = await recheckReview(repo, rdir, SETTINGS, { sessionFactory: fakeFactory(failing(LAZY)) });
  const [text, code] = recheckSummary(r);
  expect(code).toBe(2);
  expect(text).toContain("lib.py");
  expect(text).toContain("arnx allow-secret");
  expect(text).not.toContain("Fix the code");
});
