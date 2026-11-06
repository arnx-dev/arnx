// The before/after check: findings' tests run again on the code before the change and are classified; pre-existing
// failures are not challenged and do not set the exit code; the check is timed, traced, and kept across a resume.
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CopyDiffers } from "../src/baked";
import { type Before, type BeforeRun, judgeBefore, judgeFix, missingName, namesAdded, newNames, sharedFailure, sharedInGroups, usesNew, vacuousBefore, vacuousPass } from "../src/before";
import { testBody } from "../src/shallow";
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
  expect(exitCode(review, true)).toBe(1);
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
  expect(text).toContain("Already failing before the change:\n  · F2  ");
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
  expect(exitCode(review, true)).toBe(1);
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
  expect(exitCode(review, true)).toBe(1);
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
  expect(exitCode(review, true)).toBe(1);
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

/** As dockerSession on an image holding a copy of the code: code copied in after the session starts is refused, and
 * code there from the start gets an image of its own. `started`: what the code before the change held at each start. */
function bakedSessions(started: string[]): SessionFactory {
  return async (cfg, snap, log, body, envFrom, key) => {
    if (!snap.endsWith("/before")) return sessions(BEFORE)(cfg, snap, log, body, envFrom, key);
    const app = join(snap, "app.py");
    started.push(existsSync(app) ? readFileSync(app, "utf8") : "");
    if (!existsSync(app)) {
      return body({ run: () => {
        throw new CopyDiffers("main: the tests run the image's own copy of the code at /opt/ws, which differs from this code in 1 file");
      } });
    }
    expect(existsSync(join(snap, "tests/arnx_generated"))).toBe(false); // the image is made from the code alone
    return sessions(BEFORE)(cfg, snap, log, body, envFrom, key);
  };
}

test("a project whose image holds a copy of the code gets an image of the code before the change, and a verdict", async () => {
  const started: string[] = [];
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent(), sessionFactory: bakedSessions(started),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]) });
  expect(started).toEqual(["", "def add(a, b):\n    return a + b\n\ndef old():\n    return 0\n"]);
  const [add, old] = review.findings;
  expect([add!.func, add!.before!.status]).toEqual(["test_add", "regression"]);
  expect([old!.func, old!.before!.status]).toEqual(["test_old", "pre-existing"]);
});

test("an image made from the code before the change has that code's dependencies: no doubt about them", async () => {
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a + b\n\ndef old():\n    return 0\n");
  writeFileSync(join(repo, "requirements.txt"), "pytest\n");
  commit(repo, "requirements");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n\ndef old():\n    return 0\n");
  writeFileSync(join(repo, "requirements.txt"), "pytest\nrequests\n");
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent(), sessionFactory: bakedSessions([]),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]) });
  expect(review.findings[0]!.before!.status).toBe("regression");
});

test("a finding that fails the same way but uses what the change adds is judged, not set aside as old", async () => {
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return helper(a) - b\n\ndef old():\n    return 0\n");
  const uses = new ScriptedAgent([
    [tool("write_file", { path: GEN, content: "import app\n\ndef test_add():\n    assert app.helper(2) == 5\n\ndef test_old():\n    assert app.old() == 1\n" })],
    [text(REPORT)]]);
  const same = junitXml([[GEN, "test_add", "failed", "assert 0 == 5"], [GEN, "test_old", "failed", "assert 0 == 1"]]);
  const sessionsSame: SessionFactory = async (_cfg, snap, _log, body) => body(new FakeSession(snap, () => [same, "", false]));
  const judge = new FakeJson([{ verdict: "disputed", reason: "no" }]);
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: uses, challenger: judge, sessionFactory: sessionsSame });
  const [add, old] = [review.findings.find((f) => f.func === "test_add")!, review.findings.find((f) => f.func === "test_old")!];
  expect(add.before!.status).toBe("unknown");
  expect(add.before!.detail).toContain("the test uses `helper`, which the change adds");
  expect(add.verdict).toBe("disputed");
  expect(old.before!.status).toBe("pre-existing");
});

// Names, not words: what the change brings is read from the code of its source files, and a test uses it only in code.
const diffOf = (path: string, added: string[]) => [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`,
  `@@ -1 +1,${added.length + 1} @@`, " keep", ...added.map((l) => `+${l}`), ""].join("\n");
const notTest = (n: string) => n.startsWith("test_");

describe("names, not words", () => {
  test("a word the change adds only in a comment is not a name it brings", () => {
    const diff = diffOf("app.py", ["# SHOW the totals, then AGGREGATE them", 'MSG = "region indicated"',
      "def total():", '    """generation of the total"""', "    return realname(1)  # trailing remark"]);
    expect([...namesAdded(diff, notTest)].sort()).toEqual(["MSG", "def", "realname", "return", "total"].sort());
    const block = diffOf("lib.rs", ["/* AGGREGATE", " SHOW */", 'fn go() { let s = "indicated"; run_it(s); } // region']);
    expect([...namesAdded(block, notTest)]).not.toContain("AGGREGATE");
    expect([...namesAdded(block, notTest)]).toContain("run_it");
  });

  test("a word from a data file in the change is not a name it brings", () => {
    const docs = diffOf("docs/notes.md", ["AGGREGATE the region"]);
    const data = diffOf("data/rows.json", ['{"indicated": 1}']);
    const fixture = diffOf("tests/fixtures/sample.py", ["def generation(): pass"]);
    const inTests = diffOf("tests/helpers.py", ["def shown(): pass"]);
    for (const d of [docs, data, fixture, inTests]) expect([...newNames(d, notTest, () => null)]).toEqual([]);
    expect([...newNames(diffOf("src/app.py", ["def generation(): pass"]), notTest, () => null)]).toContain("generation");
  });

  test("an assert message does not make a test use what the change adds", () => {
    const source = 'def test_a():\n    assert total() == 3, "SHOW the region indicated"\n    # AGGREGATE later\n';
    expect(usesNew(source, "test_a", new Set(["SHOW", "AGGREGATE", "region", "indicated"]))).toBeNull();
    expect(usesNew(source, "test_a", new Set(["total"]))).toBe("total");
    // A string that looks like a name (a patch target, a key) still counts.
    const target = 'def test_b():\n    mocker.patch("app.new_helper")\n';
    expect(usesNew(target, "test_b", new Set(["new_helper"]))).toBe("new_helper");
    const same: Before = { status: "pre-existing", detail: "d", runs: ["failed"], message: "x" };
    expect(vacuousBefore(same, source, "test_a", new Set(["SHOW"]))).toBe(same);
    // No whole-file fallback: a test that cannot be found uses nothing.
    expect(usesNew(source, "test_missing", new Set(["total"]))).toBeNull();
  });

  test("the next test's decorator is not part of this test", () => {
    const py = 'def test_a():\n    assert 1\n\n@pytest.mark.parametrize(\n    "x",\n    [AGGREGATE],\n)\n@other\ndef test_b(x):\n    pass\n';
    expect(testBody(py, "test_a")).not.toContain("AGGREGATE");
    expect(testBody(py, "test_a")).not.toContain("@");
    expect(testBody(py, "test_b")).toContain("def test_b");
    const rs = "#[test]\nfn one() {\n    assert!(true);\n}\n\n#[should_panic]\n#[test]\nfn two() {}\n";
    expect(testBody(rs, "one")).not.toContain("should_panic");
  });

  test("a message shared with tests the change fixes does not make a failure pre-existing", () => {
    const fail = (name: string, message: string) => ({ testId: `t.py::${name}`, fileAttr: "t.py", name, outcome: "failed", message });
    const same: Before = { status: "pre-existing", detail: "fails the same way", runs: ["failed"], message: "AssertionError: assert False" };
    const base = [0, 1, 2].map(() => run(fail("test_p", "AssertionError: assert False"), fail("test_q", "AssertionError: assert False"),
      fail("test_r", "AssertionError: other")));
    const b = sharedFailure(same, "AssertionError: assert False", base, new Set(["t.py::test_p", "t.py::test_q", "t.py::test_r"]));
    expect(b.status).toBe("unknown");
    expect(b.detail).toBe("fails with the same message there, but so do 2 tests that pass with the change");
    // Another message, or no passing test failing there: the verdict stands.
    expect(sharedFailure(same, "AssertionError: assert False", base, new Set(["t.py::test_r"]))).toBe(same);
    expect(sharedFailure(same, "AssertionError: assert False", base, new Set())).toBe(same);
    // A test that failed in only some runs, or errored, settles nothing.
    const mixed = [run(fail("test_p", "AssertionError: assert False")), run({ ...fail("test_p", ""), outcome: "passed" }), base[0]!];
    expect(sharedFailure(same, "AssertionError: assert False", mixed, new Set(["t.py::test_p"]))).toBe(same);
    // Only a pre-existing verdict is touched.
    const other: Before = { status: "changed", detail: "d", runs: [] };
    expect(sharedFailure(other, "AssertionError: assert False", base, new Set(["t.py::test_p"]))).toBe(other);
  });
});

describe("fix round: whole files, shared messages", () => {
  const HEAD = ["def a():", '    """Docs that', "    mention AGGREGATE and SHOW", "    go on and on", '    """', "    return brand_new(1)", ""].join("\n");
  const BASE = ["def a():", '    """Docs that', "    go on and on", '    """', "    return 1", ""].join("\n");
  const hunkDiff = (hunks: string[]) => ["diff --git a/lib/a.py b/lib/a.py", "--- a/lib/a.py", "+++ b/lib/a.py", ...hunks, ""].join("\n");
  const read = (_path: string, side: "new" | "old") => side === "new" ? HEAD : BASE;

  test("a hunk that starts inside a docstring is read with the whole file around it", () => {
    // Lines 3-6 of the head: the docstring's inside, its end, then a line of code.
    const code = hunkDiff(["@@ -3,3 +3,4 @@", "+    mention AGGREGATE and SHOW", "     go on and on", '     """', "-    return 1", "+    return brand_new(1)"]);
    const names = [...namesAdded(code, notTest, read)];
    expect(names).toContain("brand_new");
    expect(names).not.toContain("AGGREGATE");
    expect(names).not.toContain("SHOW");
    // Without the file, the hunk alone gets both wrong (the fallback keeps working, with that limit).
    expect([...namesAdded(code, notTest)]).toContain("AGGREGATE");
    // A file that cannot be read falls back to its hunks.
    expect([...namesAdded(code, notTest, () => null)]).toContain("AGGREGATE");
    expect([...newNames(code, notTest, () => BASE, read)]).toEqual(["brand_new"]);
  });

  const fail = (name: string, message: string) => ({ testId: `t.py::${name}`, fileAttr: "t.py", name, outcome: "failed", message });
  test("shared messages are counted across the finding files' runs and the fix proof's own, however many runs each has", () => {
    const same: Before = { status: "pre-existing", detail: "d", runs: ["failed"], message: "x" };
    const m = "AssertionError: assert False";
    const own = [0, 1, 2].map(() => run(fail("test_q", m)));
    const proofRuns = [run(fail("test_p", m))]; // cut after one run
    const b = sharedInGroups(same, m, [own, proofRuns], new Set(["t.py::test_p"]));
    expect(b.status).toBe("unknown");
    expect(b.detail).toBe("fails with the same message there, but so does 1 test that passes with the change");
    expect(sharedInGroups(same, m, [own, []], new Set(["t.py::test_p"]))).toBe(same);
    expect(sharedInGroups(same, m, [own, proofRuns], new Set(["t.py::test_z"]))).toBe(same);
  });

  const SHARED = junitXml([[GEN, "test_add", "passed", ""], [GEN, "test_old", "failed", "assert 0 == 1"],
    [GEN, "test_ok", "failed", "assert 0 == 1"], [GEN, "test_aaa", "passed", ""]]);
  const writes = () => new ScriptedAgent([
    [tool("write_file", { path: GEN, content: "from app import add, old\n\ndef test_aaa():\n    pass\n\ndef test_add():\n    assert add(2, 3) == 5\n" +
      "\ndef test_old():\n    assert old() == 1\n\ndef test_ok():\n    pass\n" })],
    [text(REPORT.replace("}]", "}, { \"test\": \"" + GEN + "::test_aaa\", \"expects\": \"a\" }]"))]]);
  const AFTER_SHARED = junitXml([[GEN, "test_add", "failed", "assert -1 == 5"], [GEN, "test_old", "failed", "assert 0 == 1"],
    [GEN, "test_ok", "passed", ""], [GEN, "test_aaa", "passed", ""]]);
  const factory: SessionFactory = async (_cfg, snap, _log, body) =>
    body(new FakeSession(snap, () => [snap.endsWith("/before") ? SHARED : AFTER_SHARED, "", false]));
  for (const [name, fixProofMax] of [["with the fix proof on", 20], ["with the fix proof off", 0], ["past the fix proof's cap", 1]] as const) {
    test(`a message shared with a test that passes with the change settles nothing, ${name}`, async () => {
      const { review } = await runReview(repo, { settings: { ...SETTINGS, fixProofMax }, agentModel: writes(),
        challenger: new FakeJson([{ verdict: "confirmed", reason: "x" }]), sessionFactory: factory });
      const old = review.findings.find((f) => f.func === "test_old")!;
      expect(old.before!.status).toBe("unknown");
      expect(old.before!.detail).toBe("fails with the same message there, but so does 1 test that passes with the change");
    });
  }
});

describe("fix round 2: reading the diff against the files", () => {
  const diffFor = (hunks: string[], from = "lib/a.py", to = "lib/a.py") =>
    [`diff --git a/${from} b/${to}`, `--- a/${from}`, `+++ b/${to}`, ...hunks, ""].join("\n");

  test("a mapped line that is not the row's text falls back to the hunk", () => {
    const diff = diffFor(["@@ -1,1 +1,2 @@", " keep", "+brand_new(1)"]);
    // The head text is not the file the diff was made from: its line 2 differs.
    const names = [...namesAdded(diff, notTest, () => "something\nelse_entirely(2)\n")];
    expect(names).toContain("brand_new");
    expect(names).not.toContain("else_entirely");
  });

  test("a renamed file's old side is read by its old path", () => {
    const diff = diffFor(["@@ -1,2 +1,2 @@", " keep", "-def old_one(): pass", "+def new_one(): pass"], "lib/old.py", "lib/new.py");
    const seen: string[] = [];
    const names = [...namesAdded(diff, notTest, (path, side) => {
      seen.push(`${side}:${path}`);
      return side === "new" ? "keep\ndef new_one(): pass\n" : "keep\ndef old_one(): pass\n";
    })];
    expect(seen.sort()).toEqual(["new:lib/new.py", "old:lib/old.py"]);
    expect(names).toContain("new_one");
    expect([...newNames(diff, notTest, (path) => path === "lib/old.py" ? "def new_one(): pass\n" : null)]).not.toContain("new_one");
  });

  test("an unreadable file whose hunk starts after a closing docstring keeps the code", () => {
    const diff = diffFor(["@@ -3,2 +3,3 @@", '     """', "-    return 1", "+    return brand_new(1)"]);
    expect([...namesAdded(diff, notTest, () => null)]).toContain("brand_new");
    expect([...namesAdded(diff, notTest)]).toContain("brand_new");
    const block = diffFor(["@@ -3,2 +3,3 @@", "     */", "+  run_new(1);"], "lib/a.js", "lib/a.js");
    expect([...namesAdded(block, notTest)]).toContain("run_new");
  });
});

describe("a pass and a failure say only what the runs show", () => {
  const passed: Before = { status: "regression", detail: "passes on the code before the change (3 runs), fails with it",
    runs: ["passed", "passed", "passed"] };
  const o = (source: string, names: string[], baseOutput: string[] = []) =>
    ({ source, func: "test_a", names: new Set(names), baseOutput });

  test("a pass that uses a name the change adds is no regression", () => {
    const b = vacuousPass(passed, o("def test_a():\n    assert cell_ran_at_or_after(1)\n", ["cell_ran_at_or_after"]));
    expect(b.status).toBe("unknown");
    expect(b.vacuous).toBe("new-name");
    expect(b.detail).toContain("`cell_ran_at_or_after`");
    expect(b.detail).toContain("no proof of a regression");
  });

  test("a pass whose helper thread died is no regression", () => {
    const out = ["tests/x.py::test_a\n  PytestUnhandledThreadExceptionWarning: Exception in thread\n" +
      "  AttributeError: module 'app' has no attribute 'add'\n"];
    const b = vacuousPass(passed, o("def test_a():\n    assert add(1, 2) == 3\n", ["other_name"], out));
    expect(b.status).toBe("unknown");
    expect(b.vacuous).toBe("background-error");
    // a warning with nothing missing in it, or missing code with no background error, proves nothing either way
    expect(vacuousPass(passed, o("def test_a():\n    assert 1\n", [], ["PytestUnraisableExceptionWarning: x"]))).toBe(passed);
    expect(vacuousPass(passed, o("def test_a():\n    assert 1\n", [], ["NameError: name 'x' is not defined"]))).toBe(passed);
  });

  test("a background error of another thread, and a sibling's missing name, leave a regression", () => {
    const out = ["== warnings summary ==\ntests/x.py::test_other\n  threadexception.py: PytestUnhandledThreadExceptionWarning: Exception in thread\n\n" +
      "== short test summary ==\nFAILED tests/x.py::test_new - ImportError: cannot import name 'fresh' from 'app'\n"];
    expect(vacuousPass(passed, o("def test_a():\n    assert add(1, 2) == 3\n", [], out))).toBe(passed);
    // the same lines in another test's block, or in one run the test's block is not in
    const mine = ["tests/x.py::test_a\n  PytestUnhandledThreadExceptionWarning: died\n  NameError: name 'fresh' is not defined\n"];
    expect(vacuousPass(passed, o("def test_a():\n    assert 1\n", [], mine)).vacuous).toBe("background-error");
    expect(vacuousPass(passed, { ...o("def test_ab():\n    assert 1\n", [], mine), func: "test_ab" })).toBe(passed);
  });

  test("a pass that uses only old names stays a regression", () => {
    expect(vacuousPass(passed, o("def test_a():\n    assert add(1, 2) == 3  # cell_ran_at_or_after\n", ["cell_ran_at_or_after"]))).toBe(passed);
    // only a regression is set aside
    const same: Before = { status: "pre-existing", detail: "d", runs: [] };
    expect(vacuousPass(same, o("def test_a():\n    cell_ran_at_or_after()\n", ["cell_ran_at_or_after"]))).toBe(same);
  });

  test("a clipped import failure is new code", () => {
    const clipped = "TypeError: __vite_ssr_import_2__.assertNever is not a function";
    for (const m of ["…__vite_ssr_import_2__.assertNeve…", clipped, "x.__vi_import_0__.helper(…)"]) {
      expect(judgeBefore(failing, GEN, three(run(t("test_add", "failed", m)))).status).toBe("new-code");
    }
  });

  test("an unknown keyword on the code before is new code", () => {
    const m = "TypeError: connect() got an unexpected keyword argument 'timeout'";
    expect(judgeBefore(failing, GEN, three(run(t("test_add", "failed", m)))).status).toBe("new-code");
  });

  const loadFail = (m: string): TestResult => ({ testId: GEN, fileAttr: GEN, name: GEN, outcome: "failed", message: m });
  const source = "def test_add():\n    assert add(2, 3) == 5\n\ndef test_uses():\n    assert Gadget() == 1\n";
  const body = (func: string) => ({ source, func });

  test("a file that cannot load for a name this test does not use settles nothing", () => {
    const err = loadFail("ImportError: cannot import name 'Gadget' from 'app'");
    const b = judgeBefore(failing, GEN, three(run(err)), false, body("test_add"));
    expect(b.status).toBe("unknown");
    expect(b.detail).toBe("its file cannot load there because `Gadget` is missing, which this test does not use");
    // the same for a passing test's fix proof
    const f = judgeFix(t("test_add", "passed"), GEN, three(run(err)), false, body("test_add"));
    expect(f.status).toBe("unknown");
    expect(f.detail).toContain("`Gadget` is missing");
  });

  test("a load failure for a name the test uses is new code", () => {
    const err = loadFail("ImportError: cannot import name 'Gadget' from 'app'");
    expect(judgeBefore(failing, GEN, three(run(err)), false, body("test_uses")).status).toBe("new-code");
    // a module that is missing altogether: the file's imports from it are the tests' to use
    const mod = loadFail("ModuleNotFoundError: No module named 'app.gadgets'");
    expect(judgeBefore(failing, GEN, three(run(mod)), false, body("test_add")).status).toBe("new-code");
    expect(judgeFix(t("test_uses", "passed"), GEN, three(run(err)), false, body("test_uses")).status).toBe("new-code");
    // without the test's source, nothing is known about it: the old reading stands
    expect(judgeBefore(failing, GEN, three(run(err))).status).toBe("new-code");
  });

  test("missingName reads the name out of the usual messages", () => {
    expect(missingName("ImportError: cannot import name 'Gadget' from 'app'")).toBe("Gadget");
    expect(missingName("AttributeError: module 'app' has no attribute 'add'")).toBe("add");
    expect(missingName("NameError: name 'frob' is not defined")).toBe("frob");
    expect(missingName("ReferenceError: frob is not defined")).toBe("frob");
    // a whole module missing names no single thing: what the file imports from it, its tests use
    expect(missingName("ModuleNotFoundError: No module named 'app.thing'")).toBeNull();
    expect(missingName("Cannot find module './thing' from 'a.test.ts'")).toBeNull();
    expect(missingName("assert 1 == 2")).toBeNull();
  });
});
