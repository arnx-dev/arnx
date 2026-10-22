// Review lifecycle and hunt events in a review's events.jsonl.
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { challenge } from "../src/challenge";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp, stampFile } from "../src/config";
import { EVENTS_FILE, EventLog, type TraceEvent, withEvents } from "../src/events";
import { ModelError } from "../src/errors";
import { PROMPT_VERSION } from "../src/prompts";
import { exitCode } from "../src/report";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, fakeFactory, text, tool } from "./helpers/fakes";
import { finding } from "./helpers/review";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
const NOW = new Date("2026-10-16T12:00:00Z");
const GEN = "tests/arnx_generated/test_x.py";
// The fakes report the same failure on any snapshot, so the before/after check would call every finding
// pre-existing; it is off here and tested in before.test.ts.
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" };

const events = (rdir: string): TraceEvent[] =>
  readFileSync(join(rdir, EVENTS_FILE), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as TraceEvent);
const ofType = (es: TraceEvent[], type: string) => es.filter((e) => e.type === type);

/** The hunting review of tests/neutral.test.ts: one project, a reviewer and a second hunter. */
async function huntReview() {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"), { recursive: true });
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return 0\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
  const session: SessionFactory = async (_cfg, snap, _log, body) =>
    body(new FakeSession(snap, () => [junitXml([[GEN, "test_spread_positive", "failed", "assert -0.5 >= 0"],
      [GEN, "test_empty", "passed", ""]]), "1 failed, 1 passed", false]));
  const hunter = JSON.stringify({ suspects: [
    { file: "svc/calc.py", line: 2, claim: "spread is negative", why: "returns -0.5", input: "[1, 3]", expected: "0.5",
      actual: "-0.5" },
    { file: "svc/calc.py", line: 1, claim: "empty input crashes", why: "w", input: "[]", expected: "0",
      actual: "error" }],
    questions: ["Should an empty list count as equal?"] });
  const proved = JSON.stringify({ tests: [
    { test: `${GEN}::test_spread_positive`, expects: "non-negative", suspect: "S1" },
    { test: `${GEN}::test_empty`, expects: "0", suspect: "S3" }], suspected_defects: [], questions: [],
    suspects_not_tested: [{ suspect: "S2", reason: "needs the network" }] });
  const agent = new ScriptedAgent([
    [tool("write_file", { path: `svc/${GEN}`, content: "x" })],
    [tool("read_file", { path: "svc/calc.py" })], [text(hunter)],
    [tool("write_file", { path: `svc/${GEN}`,
      content: "import calc\ndef test_spread_positive(): pass\ndef test_empty(): pass\n" })],
    [text(proved)],
    [text(proved)],
  ]);
  const second = new FakeJson([{ suspects: [{ file: "svc/calc.py", line: 2, claim: "dup", why: "", input: "",
    expected: "", actual: "" }, { file: "svc/calc.py", line: 40, claim: "far away", why: "", input: "", expected: "",
    actual: "" }], questions: [] }, { verdict: "confirmed", reason: "sign" }]);
  const out = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: second,
    sessionFactory: session, hunt: true, now: NOW });
  return { ...out, repo };
}

test("a hunting review records its lifecycle and every suspect's path", async () => {
  const { review, rdir } = await huntReview();
  const es = events(rdir);
  const rid = rdir.split("/").at(-1)!;
  expect(es.map((e) => e.seq)).toEqual(es.map((_e, i) => i + 1));
  expect(es.every((e) => e.trace_id === rid)).toBe(true);
  const first = es[0]!, last = es.at(-1)!;
  expect(first.type).toBe("review.started");
  expect(first.data.prompt_version).toBe(PROMPT_VERSION);
  expect((first.data.models as Record<string, unknown>).reviewer).toBeTruthy();
  expect((first.data.models as Record<string, unknown>).second_hunter).toBe("openai:gpt-5.5-2026-04-23");
  expect(first.data.resumed).toBe(false);
  expect(first.data.diff_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(first.data.config_sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(first.data.projects).toEqual(["svc"]);
  expect((first.data.settings as Record<string, unknown>).hunt).toBe(true);
  expect(last.type).toBe("review.completed");
  expect(last.data.rc).toBe(exitCode(review));
  expect(last.data.findings).toBe(review.findings.length);
  expect(last.data.confirmed).toBe(review.findings.filter((f) => f.verdict === "confirmed").length);
  expect(last.data.cost_usd).toBe(review.costUsd);
  expect((last.data.usage as { cost_usd: number }[]).length).toBe(review.usage.length);

  expect(ofType(es, "hunt.list").map((e) => e.data.source)).toEqual(["reviewer", "second"]);
  const huntFile = join(rdir, "projects/svc/hunt.json");
  const tested = (JSON.parse(readFileSync(huntFile, "utf8")) as { tested: unknown[] }).tested;
  const suspects = ofType(es, "hunt.suspect");
  expect(suspects).toHaveLength(tested.length);
  expect(suspects.map((e) => e.data.rank)).toEqual(suspects.map((_e, i) => i + 1));
  const ids = new Set(suspects.map((e) => e.data.hyp_id));
  expect(ids.has(`${rid}:svc:S1`)).toBe(true);
  const merged = ofType(es, "hunt.merged");
  expect(merged.length).toBe(4);
  expect(merged.every((e) => ids.has(e.data.into))).toBe(true);
  const dup = merged.find((e) => e.data.source === "second" && e.data.index === 0)!;
  const claimOf = (hyp: unknown) => suspects.find((e) => e.data.hyp_id === hyp)!.data.claim;
  expect(claimOf(dup.data.into)).toBe("dup");
  expect(dup.data.into).not.toBe(`${rid}:svc:S1`);
  expect(ofType(es, "hunt.dropped")).toHaveLength(0);
});

test("a repeat from the second hunter maps to the suspect it repeats", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"), { recursive: true });
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return 0\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
  const s = (line: number, claim: string) => ({ file: "svc/calc.py", line, claim, why: "", input: "", expected: "",
    actual: "" });
  const proved = JSON.stringify({ tests: [{ test: `${GEN}::t`, expects: "x", suspect: "S1" }], suspected_defects: [],
    questions: [], suspects_not_tested: [{ suspect: "S2", reason: "no" }] });
  const agent = new ScriptedAgent([
    [text(JSON.stringify({ suspects: [s(2, "Spread is negative!")], questions: [] }))],
    [tool("write_file", { path: `svc/${GEN}`, content: "def t(): pass\n" })], [text(proved)], [text(proved)],
    [text(proved)],
  ]);
  const second = new FakeJson([{ suspects: [s(2, "spread is negative"), s(9, "other")], questions: [] }]);
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: second,
    sessionFactory: fakeFactory(() => [junitXml([[GEN, "t", "passed", ""]]), "", false]), hunt: true, now: NOW });
  const es = events(rdir);
  const suspects = ofType(es, "hunt.suspect");
  const merged = ofType(es, "hunt.merged");
  expect(merged.find((e) => e.data.source === "second" && e.data.index === 0)!.data.into)
    .toBe(suspects[0]!.data.hyp_id);
  // the first entry mapping to a suspect is not a duplicate; the repeat is
  expect(merged.map((e) => [e.data.source, e.data.index, e.data.duplicate])).toEqual([
    ["reviewer", 0, false], ["second", 0, true], ["second", 1, false]]);
});

test("a review that throws records review.failed and throws the same error", async () => {
  const repo = gitRepo(tmp());
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, stamp(parseReviewConfig("version: 1\nimage: python:3.12-slim\n" +
    "test_command: python -m pytest -q {targets}\n"), "Dev", "2026-10-11"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const boom = new Error("boom");
  const agent = new ScriptedAgent([]);
  agent.create = async () => {
    throw boom;
  };
  let caught: unknown;
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([]),
    sessionFactory: fakeFactory(() => [null, "", false]), now: NOW }).catch((e: unknown) => { caught = e; });
  expect(caught).toBe(boom);
  const [rid] = readdirSync(join(repo, ".arnx/reviews"));
  const es = events(join(repo, ".arnx/reviews", rid!));
  expect(es[0]!.type).toBe("review.started");
  expect(es.at(-1)!.type).toBe("review.failed");
  expect(es.at(-1)!.data).toEqual({ error: "boom", name: "Error" });
});

describe("a resumed review", () => {
  // A resumed review continues the same log (copy of the first test in resume.test.ts).
  let repo = "";
  beforeEach(() => {
    repo = gitRepo(tmp());
    for (const p of ["services/pay/pay.py", "services/feed/feed.py", "services/shared/db.py", "infra/main.tf"]) {
      mkdirSync(join(repo, p, ".."), { recursive: true });
      writeFileSync(join(repo, p), "X = 1\n");
    }
    mkdirSync(join(repo, ".arnx"), { recursive: true });
    writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
    commit(repo, "layout");
    writeFileSync(join(repo, "services/shared/db.py"), "X = 2\n");
  });

  const steps = (p: string) => [
    [tool("write_file", { path: `services/${p}/${GEN}`, content: `import ${p}\ndef test_bad(): assert 0\n` })],
    [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))]];
  const failing = (snap: string) => new FakeSession(snap, () => [junitXml([[GEN, "test_bad", "failed", "boom"]]),
    "1 failed", false]);

  test("a resumed review appends to the same events.jsonl and keeps counting", async () => {
    const cut: SessionFactory = async (cfg, snap, _log, body) => {
      if (cfg.name === "pay") throw new Error("network is unreachable");
      return body(failing(snap));
    };
    const first = new ScriptedAgent(steps("feed"));
    await expect(runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: first,
      challenger: new FakeJson([]), sessionFactory: cut })).rejects.toThrow("network is unreachable");
    const [rid] = readdirSync(join(repo, ".arnx/reviews"));
    const rdir = join(repo, ".arnx/reviews", rid!);
    const before = events(rdir);
    expect(before.at(-1)!.type).toBe("review.failed");
    const judge = new FakeJson([{ verdict: "confirmed", reason: "a" }, { verdict: "confirmed", reason: "b" }]);
    await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: new ScriptedAgent(steps("pay")),
      challenger: judge, sessionFactory: async (_c, snap, _l, body) => body(failing(snap)), resume: true });
    const es = events(rdir);
    expect(es.map((e) => e.seq)).toEqual(es.map((_e, i) => i + 1));
    expect(es.slice(0, before.length)).toEqual(before);
    const started = ofType(es, "review.started");
    expect(started.map((e) => e.data.resumed)).toEqual([false, true]);
    expect(es.at(-1)!.type).toBe("review.completed");
  });

  test("a verdict restored from verdicts.json is recorded as resumed", async () => {
    const cut: SessionFactory = async (cfg, snap, _log, body) => {
      if (cfg.name === "pay") throw new Error("network is unreachable");
      return body(failing(snap));
    };
    await expect(runReview(repo, { projectConcurrency: 1, settings: SETTINGS,
      agentModel: new ScriptedAgent(steps("feed")), challenger: new FakeJson([]), sessionFactory: cut }))
      .rejects.toThrow("network is unreachable");
    const [rid] = readdirSync(join(repo, ".arnx/reviews"));
    const rdir = join(repo, ".arnx/reviews", rid!);
    writeFileSync(join(rdir, "verdicts.json"), JSON.stringify({ [`feed::${GEN}::test_bad`]: { verdict: "confirmed",
      reason: "saved", dependsOn: null, judge: null, model: "openai:gpt-5.5-2026-04-23", cost: 0.02 } }) + "\n");
    await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: new ScriptedAgent(steps("pay")),
      challenger: new FakeJson([{ verdict: "confirmed", reason: "b" }]),
      sessionFactory: async (_c, snap, _l, body) => body(failing(snap)), resume: true });
    const verdicts = ofType(events(rdir), "challenge.verdict");
    expect(verdicts.map((e) => [e.data.project, e.data.resumed ?? false])).toEqual([["feed", true], ["pay", false]]);
    expect(verdicts[0]!.data).toMatchObject({ outcome: "ok", verdict: "confirmed", reason: "saved", cost_usd: 0.02,
      judge: "openai:gpt-5.5-2026-04-23", depends_on: null, hyp_id: null });
  });
});

test("test runs, classifications, verdicts, suspect outcomes and the report are recorded", async () => {
  const { review, rdir } = await huntReview();
  const es = events(rdir);
  const rid = rdir.split("/").at(-1)!;
  const T = "tests/arnx_generated/test_x.py";
  expect(ofType(es, "test.files").map((e) => e.data)).toEqual([{ project: "svc", files: [`svc/${T}`] }]);
  const runs = ofType(es, "test.run");
  expect([...new Set(runs.map((e) => e.data.repeat))]).toEqual([1, 2, 3]);
  expect(runs.filter((e) => e.data.repeat === 1)).toHaveLength(2);
  expect(runs.find((e) => e.data.test_id === `${T}::test_spread_positive`)!.data).toEqual({ project: "svc",
    repeat: 1, test_id: `${T}::test_spread_positive`, func: "test_spread_positive", file: T, outcome: "failed",
    message: "assert -0.5 >= 0\ntrace", carried: false, run_seconds: 0.1 });
  // Both tests share one file, and that file has a failure: the whole file runs again, so nothing is carried.
  expect(runs.every((e) => e.data.carried === false)).toBe(true);
  expect(ofType(es, "test.run_missing")).toHaveLength(0);
  expect(ofType(es, "test.classified").map((e) => [e.data.test_id, e.data.class])).toEqual([
    [`${T}::test_spread_positive`, "finding"], [`${T}::test_empty`, "passed"]]);
  const written = ofType(es, "test.written");
  expect(written.map((e) => e.data.hyp_id)).toEqual([`${rid}:svc:S1`, `${rid}:svc:S3`]);
  expect(written[0]!.data).toMatchObject({ project: "svc", test_id: `${T}::test_spread_positive`,
    func: "test_spread_positive", expects: "non-negative" });
  expect(ofType(es, "test.classified")[0]!.data.func).toBe("test_spread_positive");
  const verdicts = ofType(es, "challenge.verdict");
  expect(verdicts).toHaveLength(1);
  expect(verdicts[0]!.data).toMatchObject({ project: "svc", finding: "F1", outcome: "ok", verdict: "confirmed",
    hyp_id: `${rid}:svc:S1`, reason: "sign", depends_on: null, judge: "openai:gpt-5.5-2026-04-23", cost_usd: 0.01 });
  expect(verdicts[0]!.data.resumed).toBeUndefined();
  const outcomes = ofType(es, "suspect.outcome");
  expect(outcomes.map((e) => [e.data.hyp_id, e.data.outcome]))
    .toEqual(review.suspects!.map((x) => [`${rid}:svc:${x.id}`, x.outcome]));
  expect(outcomes[0]!.data).toMatchObject({ outcome: "proven", tests: [`${T}::test_spread_positive`],
    findings: ["F1"] });
  expect(outcomes[1]!.data.reason).toBe("needs the network");
  const done = ofType(es, "report.done");
  expect(done).toHaveLength(1);
  expect(done[0]!.data).toEqual({ findings: 1, questions: 1, checked: 1, untested_files: 0,
    suspects: { proven: 1, "not tested": 2, "not reproduced": 1 } });
  expect(done[0]!.seq).toBe(es.at(-1)!.seq - 1);
});

/** A plain review whose agent writes two test files, one failing; `final` gives each final run's report. */
async function twoFiles(final: (n: number) => string | null, timedOutAt = 0) {
  const repo = gitRepo(tmp());
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, stamp(parseReviewConfig("version: 1\nimage: python:3.12-slim\n" +
    "test_command: python -m pytest -q {targets}\n"), "Dev", "2026-10-11"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const bad = "tests/arnx_generated/test_bad.py", ok = "tests/arnx_generated/test_ok.py";
  const agent = new ScriptedAgent([
    [tool("write_file", { path: bad, content: "from app import add\n\ndef test_bad():\n    assert add(2, 3) == 5\n" })],
    [tool("write_file", { path: ok, content: "def test_ok():\n    pass\n" })],
    [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))]]);
  const run = (command: string): [string | null, string, boolean] => {
    const m = /final-(\d)\.xml/.exec(command);
    return [m ? final(Number(m[1])) : junitXml([[bad, "test_bad", "failed", "x"], [ok, "test_ok", "passed", ""]]), "",
      !!m && Number(m[1]) === timedOutAt];
  };
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent,
    challenger: new FakeJson([{ verdict: "confirmed", reason: "r" }]), sessionFactory: fakeFactory(run), now: NOW });
  return { es: events(rdir), bad, ok };
}

test("a file that passed is carried into the later runs; only the failing file is rerun", async () => {
  const { es, bad, ok } = await twoFiles((n) => n === 1
    ? junitXml([["tests/arnx_generated/test_bad.py", "test_bad", "failed", "x"],
      ["tests/arnx_generated/test_ok.py", "test_ok", "passed", ""]])
    : junitXml([["tests/arnx_generated/test_bad.py", "test_bad", "failed", "x"]]));
  const key = (e: TraceEvent) => [e.data.repeat, e.data.file, e.data.carried];
  expect(ofType(es, "test.run").map(key)).toEqual([[1, bad, false], [1, ok, false], [2, ok, true], [2, bad, false],
    [3, ok, true], [3, bad, false]]);
});

test("a final run without a report is recorded as missing", async () => {
  const { es } = await twoFiles((n) => n === 2 ? null : junitXml([
    ["tests/arnx_generated/test_bad.py", "test_bad", "failed", "x"]]));
  const missing = ofType(es, "test.run_missing");
  expect(missing.map((e) => e.data)).toEqual([{ project: "main", repeat: 2, timed_out: false, exit_code: 0,
    seconds: 0.1 }]);
  expect(ofType(es, "test.run").filter((e) => e.data.repeat === 2)).toHaveLength(0);
  // runs that did report carry their duration; carried results do not
  expect(ofType(es, "test.run").filter((e) => e.data.carried === false).every((e) => e.data.run_seconds === 0.1))
    .toBe(true);
  expect(ofType(es, "test.run").filter((e) => e.data.carried === true).every((e) => !("run_seconds" in e.data)))
    .toBe(true);
});

test("a final run that timed out is recorded as missing with timed_out and no exit code", async () => {
  const { es } = await twoFiles((n) => n === 2 ? null : junitXml([
    ["tests/arnx_generated/test_bad.py", "test_bad", "failed", "x"]]), 2);
  expect(ofType(es, "test.run_missing").map((e) => [e.data.repeat, e.data.timed_out, e.data.exit_code]))
    .toEqual([[2, true, null]]);
});

test("a test message that looks like a secret is withheld from test.run and test.classified", async () => {
  const key = "sk-ant-" + "x".repeat(40); // built at runtime: no key-shaped literal in the tree
  const { es } = await twoFiles(() => junitXml([
    ["tests/arnx_generated/test_bad.py", "test_bad", "failed", `bad token ${key}`]]));
  const withheld = "(withheld: looks like a secret)";
  const bads = ofType(es, "test.run").filter((e) => String(e.data.test_id).endsWith("test_bad"));
  expect(bads.filter((e) => Number(e.data.repeat) > 1).map((e) => e.data.message)).toEqual([withheld, withheld]);
  expect(ofType(es, "test.classified").find((e) => e.data.class === "finding")!.data.message).toBe(withheld);
  expect(es.some((e) => JSON.stringify(e).includes(key))).toBe(false);
});

test("two timeouts in a row: the first two findings error, the third is skipped", async () => {
  const dir = tmp();
  const log = new EventLog(join(dir, EVENTS_FILE), "tr1");
  const late = () => Object.assign(new ModelError("openai:gpt-5.5: no reply within 300s"), { timedOut: true });
  const model = new FakeJson([late(), late()]);
  const f = (i: number) => finding(`F${i}`, `t.py::test_${i}`, `test_${i}`, "app/t.py", "boom", "why");
  const findings = [f(1), f(2), f(3)];
  findings[0]!.suspect = "S1";
  await withEvents(log, () => challenge(findings, { concurrency: 1, model, diff: "d", sources: {}, budgetUsd: 1 }));
  const es = events(dir);
  expect(es.map((e) => e.type)).toEqual(Array(3).fill("challenge.verdict"));
  expect(es.map((e) => [e.data.finding, e.data.outcome, e.data.verdict, e.data.judge, e.data.cost_usd]))
    .toEqual([["F1", "error", null, null, 0], ["F2", "error", null, null, 0], ["F3", "skipped", null, null, 0]]);
  expect(es.map((e) => e.data.timed_out)).toEqual([true, true, false]);
  expect(es[0]!.data.hyp_id).toBe("tr1:main:S1");
  expect(es[1]!.data.hyp_id).toBeNull();
  expect(String(es[2]!.data.reason)).toContain("did not reply in time");
});
