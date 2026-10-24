// The before/after check: findings' tests run again on the code before the change and are classified; pre-existing
// failures are not challenged and do not set the exit code; the check is timed, traced, and kept across a resume.
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BeforeRun, judgeBefore } from "../src/before";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { EVENTS_FILE, type TraceEvent } from "../src/events";
import type { TestResult } from "../src/outcomes";
import { exitCode, load, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import { envKey, type SessionFactory } from "../src/sandbox";
import { defaultSettings, loadSettings, writeSettings } from "../src/settings";
import { testRound, COPY_SUFFIX } from "../src/testround";
import { answerRound, FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo, gitRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const GEN = "tests/arnx_generated/test_add.py";
const t = (name: string, outcome: string, message = ""): TestResult =>
  ({ testId: `${GEN}::${name}`, fileAttr: GEN, name, outcome, message });
const run = (...results: TestResult[]): BeforeRun => ({ results, output: "", timedOut: false });
const three = (r: BeforeRun) => [r, r, r];
const failing = t("test_add", "failed", "assert -1 == 5");

describe("judgeBefore", () => {
  test("passes in every run before the change: a regression", () => {
    const b = judgeBefore(failing, GEN, three(run(t("test_add", "passed"))));
    expect(b.status).toBe("regression");
    expect(b.runs).toEqual(["passed", "passed", "passed"]);
    expect(b.message).toBeUndefined();
  });

  test("fails the same way in every run: pre-existing; addresses do not count as a difference", () => {
    expect(judgeBefore(failing, GEN, three(run(t("test_add", "failed", "assert -1 == 5\ntrace"))))).toMatchObject(
      { status: "pre-existing", message: "assert -1 == 5\ntrace" });
    const at = (a: string) => t("test_add", "failed", `TypeError: <object at ${a}> is wrong`);
    expect(judgeBefore(at("0x7f01"), GEN, three(run(at("0x7fee")))).status).toBe("pre-existing");
  });

  test("the same failure, but the change also changes the dependencies: unknown", () => {
    const b = judgeBefore(failing, GEN, three(run(t("test_add", "failed", "assert -1 == 5"))), true);
    expect(b.status).toBe("unknown");
    expect(b.detail).toContain("dependencies");
  });

  test("what it tests is missing before the change: new code", () => {
    const missing = t("test_add", "failed", "AttributeError: module 'app' has no attribute 'add'");
    expect(judgeBefore(failing, GEN, three(run(missing))).status).toBe("new-code");
    // the file fails while loading (an import): none of its tests ran
    const load = { testId: GEN, fileAttr: GEN, name: GEN, outcome: "failed",
      message: "ImportError: cannot import name 'add' from 'app'" };
    expect(judgeBefore(failing, GEN, three(run(load))).status).toBe("new-code");
    // no report at all, the console says the test does not build (Rust)
    const build: BeforeRun = { results: null, timedOut: false,
      output: "error[E0425]: cannot find function `add` in crate `calc`\nerror: could not compile" };
    const b = judgeBefore(failing, GEN, three(build));
    expect(b.status).toBe("new-code");
    expect(b.detail).toContain("cannot find function");
  });

  test("a test that reads a source file the code before the change lacks: new code", () => {
    // Messages as node and pytest record them when a test opens a file of the repository (/src) by path.
    const assertion = t("test_add", "failed", "AssertionError: expected 402, got 200");
    for (const m of ["ENOENT: no such file or directory, open '/src/web/src/app/api/credits/route.ts'",
      "FileNotFoundError: [Errno 2] No such file or directory: '/src/app/routes.py'"]) {
      const b = judgeBefore(assertion, GEN, three(run(t("test_add", "failed", m))));
      expect(b.status).toBe("new-code");
      expect(b.detail).toContain(m.slice(0, 40));
    }
    // A missing file outside the repository says nothing about the code: still a different failure.
    expect(judgeBefore(assertion, GEN, three(run(t("test_add", "failed",
      "ENOENT: no such file or directory, open '/tmp/cache.json'")))).status).toBe("changed");
  });

  test("fails before the change, differently: changed, with the earlier failure", () => {
    const b = judgeBefore(failing, GEN, three(run(t("test_add", "failed", "assert 1 == 5"))));
    expect(b.status).toBe("changed");
    expect(b.detail).toContain("assert 1 == 5");
    expect(b.message).toBe("assert 1 == 5");
  });

  test("an undefined value on the code before the change is never \"fails differently\"", () => {
    // Messages as node (V8), bun (JSC) and pytest record them when the old code lacks what the test loads.
    const recorded = ["Cannot read properties of undefined (reading 'address')",
      "Cannot destructure property 'port' of 'server' as it is undefined.",
      "TypeError: undefined is not an object (evaluating 'app.address')",
      "TypeError: Right side of assignment cannot be destructured",
      "AttributeError: 'NoneType' object has no attribute 'post'",
      "TypeError: cannot unpack non-iterable NoneType object"];
    const assertion = t("test_add", "failed", "AssertionError: expected 200, got 500");
    for (const m of recorded) {
      // One test in its file: the old code may lack it or may return nothing, so the comparison says nothing.
      const one = judgeBefore(assertion, GEN, three(run(t("test_add", "failed", m))));
      expect(one.status).toBe("unknown");
      expect(one.detail).toStartWith("could not compare: the test could not load the code before the change");
      expect(one.detail).toContain(m.slice(0, 30));
      // Every test in its file hits an undefined value there: what they load (an export, the app) is missing.
      const all = judgeBefore(assertion, GEN, three(run(t("test_add", "failed", m), t("test_get", "failed", m))));
      expect(all.status).toBe("new-code");
      expect(all.detail).toStartWith("what it tests does not exist on the code before the change");
    }
    // A test elsewhere in the file that runs past the setup there: not clearly missing code.
    const some = judgeBefore(assertion, GEN, three(run(t("test_add", "failed", recorded[0]!),
      t("test_get", "passed"))));
    expect(some.status).toBe("unknown");
    // node's and bun's "is not a function" names missing code already.
    expect(judgeBefore(assertion, GEN, three(run(t("test_add", "failed", "app.address is not a function")))).status)
      .toBe("new-code");
    expect(judgeBefore(assertion, GEN, three(run(t("test_add", "failed",
      "TypeError: app.address is not a function. (In 'app.address()', 'app.address' is undefined)")))).status)
      .toBe("new-code");
    // The change's failure is an undefined value too: a genuine difference stays changed.
    const both = t("test_add", "failed", "Cannot read properties of undefined (reading 'id')");
    expect(judgeBefore(both, GEN, three(run(t("test_add", "failed", recorded[0]!)))).status).toBe("changed");
  });

  test("flaky, an error, a timeout, skipped or absent before the change: unknown, with why", () => {
    const flaky = judgeBefore(failing, GEN, [run(t("test_add", "passed")), run(failing), run(failing)]);
    expect([flaky.status, flaky.detail]).toEqual(["unknown", "flaky on the code before the change (passed in 1 of 3 runs)"]);
    const error = judgeBefore(failing, GEN, three(run(t("test_add", "error", "fixture 'db' not found"))));
    expect([error.status, error.detail]).toEqual(["unknown", "could not run on the code before the change (fixture 'db' not found)"]);
    const late = judgeBefore(failing, GEN, [run(failing), { results: null, output: "[timed out]", timedOut: true },
      run(failing)]);
    expect([late.status, late.detail]).toEqual(["unknown", "1 of 3 runs on the code before the change gave no report (1 timed out)"]);
    expect(late.runs).toEqual(["failed", "timeout", "failed"]);
    expect(judgeBefore(failing, GEN, three(run(t("test_add", "skipped")))).status).toBe("unknown");
    expect(judgeBefore(failing, GEN, three(run(t("test_other", "passed")))).detail)
      .toBe("did not run on the code before the change");
  });
});

// A repo whose change breaks add() (a regression) and leaves old() broken as it was (pre-existing).
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-11T00:00:00Z" };
const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" },
  { test: `${GEN}::test_old`, expects: "old is one" }, { test: `${GEN}::test_ok`, expects: "ok" }],
suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: [] });
const agent = () => new ScriptedAgent([
  [tool("write_file", { path: GEN, content: "from app import add, old\n\ndef test_add():\n    assert add(2, 3) == 5\n" +
    "\ndef test_old():\n    assert old() == 1\n\ndef test_ok():\n    pass\n" })],
  [text(REPORT)],
]);
const AFTER = junitXml([[GEN, "test_add", "failed", "assert -1 == 5"], [GEN, "test_old", "failed", "assert 0 == 1"],
  [GEN, "test_ok", "passed", ""]]);
const BEFORE = junitXml([[GEN, "test_add", "passed", ""], [GEN, "test_old", "failed", "assert 0 == 1"]]);
/** Sessions on the code before the change (the check's snapshot is named "before") answer with `before`. */
function sessions(before: string = BEFORE, seen: { snap: string; envFrom?: string; commands: string[] }[] = [])
  : SessionFactory {
  return async (_cfg, snap, _log, body, envFrom) => {
    const isBefore = snap.endsWith("/before");
    const s = new FakeSession(snap, () => [isBefore ? before : AFTER, "", false]);
    seen.push({ snap, ...(envFrom ? { envFrom } : {}), commands: s.commands });
    return body(s);
  };
}
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a + b\n\ndef old():\n    return 0\n");
  commit(repo, "old is broken");
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-11"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n\ndef old():\n    return 0\n");
});
const events = (rdir: string) => readFileSync(join(rdir, EVENTS_FILE), "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as TraceEvent);

test("a regression is marked; a pre-existing failure is reported apart, not challenged, not counted", async () => {
  const seen: { snap: string; envFrom?: string; commands: string[] }[] = [];
  const judge = new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]);
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: judge,
    sessionFactory: sessions(BEFORE, seen) });
  const [add, old] = review.findings;
  expect([add!.func, add!.before!.status, add!.verdict]).toEqual(["test_add", "regression", "confirmed"]);
  expect([old!.func, old!.before!.status, old!.verdict]).toEqual(["test_old", "pre-existing", null]);
  expect(old!.before!.runs).toEqual(["failed", "failed", "failed"]);
  // only the regression went to the second model (the second call is the grouping step)
  expect(judge.calls.filter((c) => c.includes("The failing test:"))).toHaveLength(1);
  expect(judge.calls[0]).toContain("test_add");
  expect(exitCode(review)).toBe(1);
  // the check ran in a second session on the base, in the change's image, the failing file only, `runs` times
  expect(seen).toHaveLength(2);
  expect(seen[1]!.envFrom).toBe(seen[0]!.snap);
  expect(seen[1]!.commands.filter((c) => c.includes("before-"))).toHaveLength(3);
  expect(seen[1]!.commands.every((c) => c.includes("tests/arnx_generated/test_add.py"))).toBe(true);
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  expect(md).toContain("### F1 · regression · confirmed by the second opinion");
  expect(md).toContain("- Before the change (regression): passes on the code before the change (3 runs)");
  const section = md.slice(md.indexOf("## Already failing before this change"), md.indexOf("## Questions"));
  expect(section).toContain("### F2 · already failing before this change");
  expect(section).toContain("Mark: [ ] real");
  const json = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as Record<string, unknown>;
  expect(typeof (json.timings as Record<string, unknown>).before_check_secs).toBe("number");
  expect((json.findings as Record<string, unknown>[])[1]!.before).toMatchObject({ status: "pre-existing" });
  expect(load(rdir).timings).toEqual({ beforeCheckSecs: review.timings!.beforeCheckSecs,
    fixProofSecs: review.timings!.fixProofSecs! });
  expect(json.before_base_empty).toBeUndefined();
  expect(md).not.toContain("nothing to compare");
  const text = summary(review, "review.md");
  expect(text).toContain("regression: add subtracts.");
  expect(text).toContain("Already failing before the change: F2");
});

test("only pre-existing findings: nothing is challenged and the exit code is 0", async () => {
  const same = junitXml([[GEN, "test_add", "failed", "assert -1 == 5"], [GEN, "test_old", "failed", "assert 0 == 1"]]);
  const judge = new FakeJson([]);
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: judge,
    sessionFactory: sessions(same) });
  expect(review.findings.map((f) => f.before!.status)).toEqual(["pre-existing", "pre-existing"]);
  expect(judge.calls).toEqual([]);
  expect(exitCode(review)).toBe(0);
  expect(readFileSync(join(rdir, "review.md"), "utf8"))
    .toContain("No test failed because of this change; 2 tests already failed before it (below).");
});

test("before_check = false: one session, no before fields, no timings", async () => {
  const seen: { snap: string; commands: string[] }[] = [];
  const settings = { ...SETTINGS, beforeCheck: false };
  const { review, rdir } = await runReview(repo, { settings, agentModel: agent(),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }, { verdict: "confirmed", reason: "b" }]),
    sessionFactory: sessions(BEFORE, seen) });
  expect(seen).toHaveLength(1);
  expect(review.findings.every((f) => f.before === undefined)).toBe(true);
  const raw = readFileSync(join(rdir, "review.json"), "utf8");
  expect(raw).not.toContain("before");
  expect(raw).not.toContain("timings");
  expect(events(rdir).some((e) => e.type.startsWith("before."))).toBe(false);
  expect(exitCode(review)).toBe(1);
});

test("the setting is written with a comment and read back", () => {
  writeSettings(tmp(), { ...SETTINGS, beforeCheck: false });
  expect(readFileSync(join(tmp(), ".arnx", "config.toml"), "utf8")).toMatch(/^before_check = false +# rerun failing tests/m);
  expect(loadSettings(tmp()).beforeCheck).toBe(false);
  writeSettings(tmp(), SETTINGS);
  expect(loadSettings(tmp()).beforeCheck).toBe(true);
  writeFileSync(join(tmp(), ".arnx", "config.toml"), "[review]\nbefore_check = \"no\"\n");
  expect(() => loadSettings(tmp())).toThrow("before_check: write true or false");
});

test("a change with no earlier commit is not checked, and says why", async () => {
  const first = initRepo(join(tmp(), "first"));
  writeFileSync(join(first, "app.py"), "def add(a, b):\n    return a - b\n\ndef old():\n    return 0\n");
  mkdirSync(dirname(reviewConfigPath(first)));
  writeFileSync(reviewConfigPath(first), stamp(parseReviewConfig(YAML), "Dev", "2026-10-11"));
  commit(first, "everything");
  const seen: { snap: string; commands: string[] }[] = [];
  const { review, rdir } = await runReview(first, { settings: SETTINGS, agentModel: agent(),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }, { verdict: "confirmed", reason: "b" }]),
    sessionFactory: sessions(BEFORE, seen) });
  expect(seen).toHaveLength(1);
  expect(review.findings.map((f) => f.before)).toEqual([0, 1].map(() => ({ status: "unknown",
    detail: "not checked: the change has no earlier commit to compare with", runs: [] })));
  const done = events(rdir).find((e) => e.type === "before.done")!;
  expect(done.data.skipped_reason).toBe("no-base");
  expect(exitCode(review)).toBe(1);
  // said once, above the findings, instead of on each one
  expect(review.beforeBaseEmpty).toBe("first-commit");
  expect(JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")).before_base_empty).toBe("first-commit");
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  const findings = md.slice(md.indexOf("## Findings"), md.indexOf("## Questions")).replace(/\s+/g, " ");
  expect(findings.split("nothing to compare").length - 1).toBe(1);
  expect(findings).toContain("This change is the first commit");
  expect(findings).not.toContain("- Before the change");
});

test("a base that holds none of the changed files: said once above the findings, statuses and exit code kept", async () => {
  const empty = initRepo(join(tmp(), "empty"));
  runGit(empty, "commit", "-q", "--allow-empty", "-m", "init");
  mkdirSync(dirname(reviewConfigPath(empty)));
  writeFileSync(reviewConfigPath(empty), stamp(parseReviewConfig(YAML), "Dev", "2026-10-11"));
  writeFileSync(join(empty, "app.py"), "def add(a, b):\n    return a - b\n\ndef old():\n    return 0\n");
  runGit(empty, "add", "app.py");
  const missing = "ModuleNotFoundError: No module named 'app'";
  const before = junitXml([[GEN, "test_add", "error", missing], [GEN, "test_old", "error", missing]]);
  const { review, rdir } = await runReview(empty, { settings: SETTINGS, agentModel: agent(),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }, { verdict: "confirmed", reason: "b" }]),
    sessionFactory: sessions(before) });
  expect(review.findings.map((f) => f.before!.status)).toEqual(["new-code", "new-code"]);
  expect(exitCode(review)).toBe(1);
  expect(review.beforeBaseEmpty).toBe("new-files");
  expect(load(rdir).beforeBaseEmpty).toBe("new-files");
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  const findings = md.slice(md.indexOf("## Findings"), md.indexOf("## Questions")).replace(/\s+/g, " ");
  expect(findings.split("nothing to compare").length - 1).toBe(1);
  expect(findings).toContain("does not contain the changed files");
  expect(findings).not.toContain("- Before the change (new-code)");
});

test("the check is traced with its durations", async () => {
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent(),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }]), sessionFactory: sessions() });
  const ev = events(rdir);
  const of = (type: string) => ev.filter((e) => e.type === type);
  expect(of("before.started").map((e) => e.data)).toEqual([{ project: "main", findings: 2, files: 1 }]);
  expect(of("before.run").map((e) => e.data.run)).toEqual([1, 2, 3]);
  expect(of("before.run").every((e) => typeof e.data.duration_ms === "number" && e.data.files === 1)).toBe(true);
  expect(of("before.finding").map((e) => [e.data.finding, e.data.status])).toEqual([["F1", "regression"],
    ["F2", "pre-existing"]]);
  const done = of("before.done")[0]!.data;
  for (const k of ["duration_ms", "snapshot_ms", "runs_ms"]) expect(typeof done[k]).toBe("number");
  expect(done.counts).toEqual({ regression: 1, "pre-existing": 1, "new-code": 0, changed: 0, unknown: 0 });
  // the check comes after the final runs and before the second opinion
  const seq = (type: string) => ev.findIndex((e) => e.type === type);
  expect(seq("before.started")).toBeGreaterThan(ev.findLastIndex((e) => e.type === "test.run"));
  expect(seq("before.done")).toBeLessThan(seq("challenge.verdict"));
});

test("a resumed review keeps the finished check and does not run it again", async () => {
  const dying = new FakeJson([]);
  dying.completeJson = async () => {
    throw new Error("connection reset");
  };
  const seen: { snap: string; commands: string[] }[] = [];
  await expect(runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: dying,
    sessionFactory: sessions(BEFORE, seen) })).rejects.toThrow("connection reset");
  expect(seen).toHaveLength(2);
  const again: { snap: string; commands: string[] }[] = [];
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: new ScriptedAgent([]),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }]), sessionFactory: sessions(BEFORE, again),
    resume: true });
  expect(again).toHaveLength(0);
  expect(review.findings.map((f) => f.before!.status)).toEqual(["regression", "pre-existing"]);
  expect(review.timings!.beforeCheckSecs).toBeGreaterThanOrEqual(0);
  const finding = events(rdir).filter((e) => e.type === "before.finding");
  expect(finding.at(-1)!.data.resumed).toBe(true);
  expect(events(rdir).filter((e) => e.type === "before.done")).toHaveLength(1);
});

test("out of time: the check is skipped with reason time", async () => {
  const out = join(tmp(), "out");
  const r = await testRound(repo, null, parseReviewConfig(YAML), { ...answerRound(agent(), parseReviewConfig(YAML)),
    writeDir: "tests/arnx_generated", budgetUsd: 1, runs: 3, outDir: out, sessionFactory: sessions(),
    before: { base: "HEAD", deadline: 0 } });
  expect(r.before!.skipped).toBe("time");
  expect(Object.values(r.before!.tests).map((b) => b.detail)).toEqual([0, 1].map(() =>
    "not checked: the review ran out of time"));
  expect(readdirSync(out)).not.toContain("before-env-build.log");
  expect(existsSync(join(out, "tests", GEN + COPY_SUFFIX))).toBe(true);
});

test("runs that write a manifest into the change's snapshot (cargo's Cargo.lock) do not change the check's image", async () => {
  // A crate without a committed Cargo.lock: cargo writes one into the snapshot during the round's runs. The check
  // must use the image the round used (keyed before the runs) and copy the code before the change only once its
  // image is ready, so no image is newer than those files (cargo would run the change's build as fresh).
  const seen: { key?: string; filesAtStart: boolean; envFrom?: string }[] = [];
  let headKey = "";
  const factory: SessionFactory = async (cfg, snap, _log, body, envFrom, key) => {
    const isBefore = snap.endsWith("/before");
    if (!isBefore) headKey = envKey(cfg, snap);
    seen.push({ ...(key ? { key } : {}), filesAtStart: existsSync(join(snap, "app.py")), ...(envFrom ? { envFrom } : {}) });
    const s = new FakeSession(snap, () => {
      if (!isBefore) writeFileSync(join(snap, "uv.lock"), "# written by a run\n");
      return [isBefore ? BEFORE : AFTER, "", false];
    });
    return body(s);
  };
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent(),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]), sessionFactory: factory });
  expect(review.findings.map((f) => f.before!.status)).toEqual(["regression", "pre-existing"]);
  expect(seen).toHaveLength(2);
  expect(seen[1]).toMatchObject({ key: headKey, filesAtStart: false });
});
