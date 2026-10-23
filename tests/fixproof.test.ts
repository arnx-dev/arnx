// The fix proof: tests that passed in every run on the change run again on the code before it; one that fails there
// in every run, for a real reason, shows the change fixes what it checks. No model is called.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type BeforeRun, judgeFix } from "../src/before";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { EVENTS_FILE, type TraceEvent } from "../src/events";
import type { TestResult } from "../src/outcomes";
import { exitCode, load, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings, loadSettings, writeSettings } from "../src/settings";
import { testRound } from "../src/testround";
import { answerRound, FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo, initRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

const GEN = "tests/arnx_generated/test_add.py";
const t = (name: string, outcome: string, message = ""): TestResult =>
  ({ testId: `${GEN}::${name}`, fileAttr: GEN, name, outcome, message });
const run = (...results: TestResult[]): BeforeRun => ({ results, output: "", timedOut: false });
const three = (r: BeforeRun) => [r, r, r];
const passing = t("test_add", "passed");

describe("judgeFix", () => {
  test("fails in every run before the change: fixed, with the earlier failure", () => {
    const f = judgeFix(passing, GEN, three(run(t("test_add", "failed", "assert -1 == 5\ntrace"))));
    expect(f.status).toBe("fixed");
    expect(f.detail).toBe("fails on the code before the change (3 runs) and passes after: the change fixes this " +
      "(assert -1 == 5)");
    expect(f.runs).toEqual(["failed", "failed", "failed"]);
    expect(f.message).toBe("assert -1 == 5\ntrace");
  });

  test("passes before the change too: unchanged", () => {
    const f = judgeFix(passing, GEN, three(run(t("test_add", "passed"))));
    expect([f.status, f.detail]).toEqual(["unchanged", "passes on the code before the change too (3 runs)"]);
    expect(f.message).toBeUndefined();
  });

  test("what it tests does not exist before the change: new code, never a fix", () => {
    const attr = t("test_add", "failed", "AttributeError: module 'app' has no attribute 'add'");
    expect(judgeFix(passing, GEN, three(run(attr))).status).toBe("new-code");
    const load = { testId: GEN, fileAttr: GEN, name: GEN, outcome: "error",
      message: "ImportError: cannot import name 'add' from 'app'" };
    expect(judgeFix(passing, GEN, three(run(load))).status).toBe("new-code");
    const build: BeforeRun = { results: null, timedOut: false,
      output: "error[E0425]: cannot find function `add` in crate `calc`\nerror: could not compile" };
    expect(judgeFix(passing, GEN, three(build)).status).toBe("new-code");
    expect(judgeFix(passing, GEN, three(run(t("test_add", "failed", "app.add is not a function")))).status)
      .toBe("new-code");
  });

  test("a source file the code before the change lacks: new code, even when the dependencies changed too", () => {
    const m = "ENOENT: no such file or directory, open '/src/web/src/components/KeySignup.tsx'";
    expect(judgeFix(passing, GEN, three(run(t("test_add", "failed", m))), true).status).toBe("new-code");
    expect(judgeFix(passing, GEN, three(run(t("test_add", "failed",
      "ENOENT: no such file or directory, open '/tmp/cache.json'")))).status).toBe("fixed");
  });

  test("an undefined value before the change: new code when the whole file hits it, else unknown", () => {
    const m = "Cannot read properties of undefined (reading 'address')";
    const one = judgeFix(passing, GEN, three(run(t("test_add", "failed", m))));
    expect(one.status).toBe("unknown");
    expect(one.detail).toStartWith("could not tell: the test could not load the code before the change");
    expect(judgeFix(passing, GEN, three(run(t("test_add", "failed", m), t("test_get", "failed", m)))).status)
      .toBe("new-code");
  });

  test("flaky, an error, a timeout, skipped, absent, or new dependencies before the change: unknown", () => {
    const failed = t("test_add", "failed", "assert -1 == 5");
    const flaky = judgeFix(passing, GEN, [run(passing), run(failed), run(failed)]);
    expect([flaky.status, flaky.detail]).toEqual(["unknown",
      "flaky on the code before the change (passed in 1 of 3 runs)"]);
    expect(judgeFix(passing, GEN, three(run(t("test_add", "error", "fixture 'db' not found")))).status)
      .toBe("unknown");
    const late = judgeFix(passing, GEN, [run(failed), { results: null, output: "[timed out]", timedOut: true },
      run(failed)]);
    expect([late.status, late.detail]).toEqual(["unknown",
      "1 of 3 runs on the code before the change gave no report (1 timed out)"]);
    expect(judgeFix(passing, GEN, three({ results: null, output: "boom", timedOut: false })).status).toBe("unknown");
    expect(judgeFix(passing, GEN, three(run(t("test_add", "skipped")))).status).toBe("unknown");
    expect(judgeFix(passing, GEN, three(run(t("test_other", "failed", "x")))).detail)
      .toBe("did not run on the code before the change");
    const deps = judgeFix(passing, GEN, three(run(failed)), true);
    expect(deps.status).toBe("unknown");
    expect(deps.detail).toContain("dependencies");
    expect(judgeFix(passing, GEN, []).status).toBe("unknown");
  });
});

// A bug fix: add() subtracted before the change and adds after it. Four generated test files, all passing on the
// change; on the code before it, each file shows one fix-proof status.
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-20T00:00:00Z" };
const G = "tests/arnx_generated";
const FILES: Record<string, string> = {
  [`${G}/test_add.py`]: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
  [`${G}/test_zero.py`]: "from app import add\n\ndef test_zero():\n    assert add(0, 0) == 0\n",
  [`${G}/test_neg.py`]: "from app import neg\n\ndef test_neg():\n    assert neg(2) == -2\n",
  [`${G}/test_flaky.py`]: "from app import add\n\ndef test_flaky():\n    assert add(1, 1) == 2\n",
};
const id = (name: string) => `${G}/test_${name}.py::test_${name}`;
const REPORT = JSON.stringify({ tests: [{ test: id("add"), expects: "add sums its arguments" },
  { test: id("zero"), expects: "zero is neutral" }, { test: id("neg"), expects: "neg negates" },
  { test: id("flaky"), expects: "one and one" }], suspected_defects: [], questions: [] });
const agent = () => new ScriptedAgent([
  Object.entries(FILES).map(([path, content]) => tool("write_file", { path, content })),
  [text(REPORT)],
  [text(REPORT)], // a coverage follow-up, if asked
]);
const AFTER = junitXml(["add", "zero", "neg", "flaky"].map((n) => [`${G}/test_${n}.py`, `test_${n}`, "passed", ""]));
/** The code before the change, run `n` (1-based, per session): add() is wrong, neg() is missing, test_flaky passes
 * in the first run only. Only the files a command names are reported. */
const beforeXml = (command: string, n: number) => junitXml(([
  ["add", "failed", "assert -1 == 5"], ["zero", "passed", ""],
  ["neg", "error", "ImportError: cannot import name 'neg' from 'app'"],
  ["flaky", n === 1 ? "passed" : "failed", n === 1 ? "" : "assert 0 == 2"],
] as const).filter(([name]) => command.includes(`test_${name}.py`))
  .map(([name, outcome, message]) => [`${G}/test_${name}.py`, `test_${name}`, outcome, message]));
interface Seen { snap: string; commands: string[] }
function sessions(seen: Seen[] = []): SessionFactory {
  return async (_cfg, snap, _log, body) => {
    const isBefore = snap.endsWith("/before");
    let n = 0;
    const s = new FakeSession(snap, (command) => [isBefore ? beforeXml(command, ++n) : AFTER, "", false]);
    seen.push({ snap, commands: s.commands });
    return body(s);
  };
}
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-20"));
  commit(repo, "add subtracts");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a + b\n\ndef neg(x):\n    return -x\n");
});
const events = (rdir: string) => readFileSync(join(rdir, EVENTS_FILE), "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as TraceEvent);
const review = (settings = SETTINGS, seen: Seen[] = []) => runReview(repo, { settings, agentModel: agent(),
  challenger: new FakeJson([]), sessionFactory: sessions(seen) });

test("a fix: fixed, unchanged, new code and flaky told apart; reported, and the exit code is unchanged", async () => {
  const seen: Seen[] = [];
  const { review: r, rdir } = await review(SETTINGS, seen);
  expect(r.findings).toEqual([]);
  expect(r.fixProof!.map((x) => [x.testId, x.beforeStatus])).toEqual([[id("add"), "fixed"], [id("flaky"), "unknown"],
    [id("neg"), "new-code"], [id("zero"), "unchanged"]]);
  expect(r.fixProof![0]).toEqual({ testId: id("add"), project: "main", file: `${G}/test_add.py`, beforeStatus: "fixed",
    beforeRuns: ["failed", "failed", "failed"], beforeDetail: "fails on the code before the change (3 runs) and passes " +
    "after: the change fixes this (assert -1 == 5)" });
  expect(exitCode(r)).toBe(0);
  // one session on the base, the four files run together `runs` times, after the change's own session
  expect(seen).toHaveLength(2);
  const base = seen[1]!.commands.filter((c) => c.includes("fix-proof-"));
  expect(base).toHaveLength(3);
  for (const f of Object.keys(FILES)) expect(base.every((c) => c.includes(f))).toBe(true);
  // no finding failed: the findings' check did not run, and says nothing
  const ev = events(rdir);
  expect(ev.some((e) => e.type.startsWith("before."))).toBe(false);
  expect(ev.filter((e) => e.type === "fix_proof.run")).toHaveLength(3);
  expect(ev.find((e) => e.type === "fix_proof.done")!.data.counts).toEqual({ fixed: 1, "new-code": 1, unchanged: 1,
    unknown: 1 });
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  const section = md.slice(md.indexOf("## The change fixes"), md.indexOf("## Findings"));
  expect(section.replace(/\s+/g, " ")).toBe("## The change fixes This test fails on the code before the change in " +
    "every run and passes on the change: the change fixes what it checks. - " +
    "`tests/arnx_generated/test_add.py::test_add`: add sums its arguments ");
  expect(md.indexOf("## The change fixes")).toBeLessThan(md.indexOf("## Findings"));
  expect(summary(r, "review.md")).toContain("\n1 test proves the change fixes something.\n");
  const json = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as Record<string, unknown>;
  expect((json.fix_proof as Record<string, unknown>[])[0]).toEqual({ test_id: id("add"), project: "main",
    file: `${G}/test_add.py`, before_status: "fixed", before_runs: ["failed", "failed", "failed"],
    before_detail: r.fixProof![0]!.beforeDetail });
  expect(json.exit_code).toBe(0);
  expect(typeof (json.timings as Record<string, unknown>).fix_proof_secs).toBe("number");
  expect(load(rdir).fixProof).toEqual(r.fixProof!);
});

test("fix_proof_max: the first N passing tests by test id; 0 turns it off", async () => {
  const seen: Seen[] = [];
  const { review: r } = await review({ ...SETTINGS, fixProofMax: 2 }, seen);
  expect(r.fixProof!.map((x) => x.testId)).toEqual([id("add"), id("flaky")]);
  const base = seen[1]!.commands.filter((c) => c.includes("fix-proof-"));
  expect(base.every((c) => c.includes("test_add.py") && c.includes("test_flaky.py") && !c.includes("test_neg.py") &&
    !c.includes("test_zero.py"))).toBe(true);
  const off: Seen[] = [];
  const { review: none, rdir } = await review({ ...SETTINGS, fixProofMax: 0 }, off);
  expect(off).toHaveLength(1);
  expect(none.fixProof).toBeUndefined();
  const raw = readFileSync(join(rdir, "review.json"), "utf8");
  expect(raw).not.toContain("fix_proof");
  expect(readFileSync(join(rdir, "review.md"), "utf8")).not.toContain("The change fixes");
});

test("before_check = false turns the fix proof off too", async () => {
  const seen: Seen[] = [];
  const { review: r, rdir } = await review({ ...SETTINGS, beforeCheck: false }, seen);
  expect(seen).toHaveLength(1);
  expect(r.fixProof).toBeUndefined();
  expect(readFileSync(join(rdir, "review.json"), "utf8")).not.toContain("fix_proof");
  expect(events(rdir).some((e) => e.type.startsWith("fix_proof."))).toBe(false);
});

test("a change that touches no source (tests, docs) proves no fix: no session on the base", async () => {
  runGit(repo, "checkout", "--", "app.py");
  writeFileSync(join(repo, "NOTES.md"), "notes\n");
  commit(repo, "notes");
  writeFileSync(join(repo, "NOTES.md"), "more notes\n");
  const seen: Seen[] = [];
  const { review: r } = await review(SETTINGS, seen);
  expect(r.testsWritten).toBe(4);
  expect(seen).toHaveLength(1);
  expect(r.fixProof).toBeUndefined();
});

test("a passing test beside a finding is judged from the findings' runs; the findings do not change", async () => {
  // test_add fails on the change too (a finding); test_add2 in its file passes, and failed before the change.
  const file = `${G}/test_add.py`;
  const after = junitXml([[file, "test_add", "failed", "assert 4 == 5"], [file, "test_add2", "passed", ""]]);
  const before = junitXml([[file, "test_add", "failed", "assert -1 == 5"], [file, "test_add2", "failed", "assert 0 == 2"]]);
  const factory = (seen: Seen[]): SessionFactory => async (_cfg, snap, _log, body) => {
    const s = new FakeSession(snap, () => [snap.endsWith("/before") ? before : after, "", false]);
    seen.push({ snap, commands: s.commands });
    return body(s);
  };
  const steps = () => new ScriptedAgent([[tool("write_file", { path: file, content: "from app import add\n" +
    "def test_add():\n    assert add(2, 3) == 5\ndef test_add2():\n    assert add(1, 1) == 2\n" })],
  [text(JSON.stringify({ tests: [{ test: `${file}::test_add2`, expects: "one and one" }], suspected_defects: [],
    questions: [] }))], [text("{}")]]);
  const run = async (settings: typeof SETTINGS) => {
    const seen: Seen[] = [];
    const out = await runReview(repo, { settings, agentModel: steps(), sessionFactory: factory(seen),
      challenger: new FakeJson([{ verdict: "confirmed", reason: "off by one" }]) });
    return { ...out, seen };
  };
  const on = await run(SETTINGS), off = await run({ ...SETTINGS, fixProofMax: 0 });
  expect(on.review.fixProof!.map((x) => [x.testId, x.beforeStatus])).toEqual([[`${file}::test_add2`, "fixed"]]);
  // no runs of its own: the findings' three runs on the code before the change said it
  expect(on.seen[1]!.commands.filter((c) => c.includes("fix-proof-"))).toEqual([]);
  expect(on.seen[1]!.commands.filter((c) => c.includes("before-"))).toHaveLength(3);
  expect(on.review.findings.map((f) => [f.testId, f.before, f.verdict])).toEqual(off.review.findings.map((f) =>
    [f.testId, f.before, f.verdict]));
  expect(on.review.findings[0]!.before!.status).toBe("changed");
  expect(exitCode(on.review)).toBe(exitCode(off.review));
});

test("the setting is read, checked, and written only when it is not the default", () => {
  writeSettings(tmp(), SETTINGS);
  expect(readFileSync(join(tmp(), ".arnx", "config.toml"), "utf8")).not.toContain("fix_proof_max");
  expect(loadSettings(tmp()).fixProofMax).toBe(20);
  writeSettings(tmp(), { ...SETTINGS, fixProofMax: 0 });
  expect(readFileSync(join(tmp(), ".arnx", "config.toml"), "utf8")).toMatch(/^fix_proof_max = 0 +# passing tests/m);
  expect(loadSettings(tmp()).fixProofMax).toBe(0);
  for (const bad of ["-1", "2.5", "\"5\"", "true"]) {
    writeFileSync(join(tmp(), ".arnx", "config.toml"), `[review]\nfix_proof_max = ${bad}\n`);
    expect(() => loadSettings(tmp())).toThrow("review.fix_proof_max: write a whole number");
  }
});

test("a first commit has no code before it: no fix proof and no session for one", async () => {
  const first = initRepo(join(tmp(), "first"));
  writeFileSync(join(first, "app.py"), "def add(a, b):\n    return a + b\n\ndef neg(x):\n    return -x\n");
  mkdirSync(dirname(reviewConfigPath(first)));
  writeFileSync(reviewConfigPath(first), stamp(parseReviewConfig(YAML), "Dev", "2026-10-20"));
  commit(first, "everything");
  const seen: Seen[] = [];
  const { review: r, rdir } = await runReview(first, { settings: SETTINGS, agentModel: agent(),
    challenger: new FakeJson([]), sessionFactory: sessions(seen) });
  expect(seen).toHaveLength(1);
  expect(r.fixProof).toBeUndefined();
  expect(events(rdir).some((e) => e.type.startsWith("fix_proof."))).toBe(false);
});

test("out of time: the fix proof is skipped with reason time and judges nothing", async () => {
  const r = await testRound(repo, null, parseReviewConfig(YAML), { ...answerRound(agent(), parseReviewConfig(YAML)),
    writeDir: G, budgetUsd: 1, runs: 3, outDir: join(tmp(), "out"), sessionFactory: sessions(),
    before: { base: "HEAD", deadline: 0, fixProofMax: 20 } });
  expect(r.before).toBeUndefined();
  expect(r.fixProof).toMatchObject({ tests: {}, skipped: "time" });
});
