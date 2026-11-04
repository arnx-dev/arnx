// The offline replay of the second opinion: it must send what a review sends, score what comes back against grades
// the prompt never sees, and not pay twice for a finding.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { CONCURRENCY } from "../src/challenge";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { ModelError, NoCredits, SetupRequired } from "../src/errors";
import { FallbackJson, type JsonModel, type JsonReply } from "../src/llm";
import { CHALLENGE_SCHEMA, DEFAULT_PROMPTS } from "../src/prompts";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { defaultModel, loadContext, main, type Row } from "../scripts/replay-judge";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
const SENTINEL = "GRADESENTINEL";
const HEADER = "repo\tcommit\treview\tfinding\tgrade\tevidence";
const OK = (reason = "r") => ({ verdict: "confirmed", reason });
const NO = (reason = "r") => ({ verdict: "disputed", reason });

const YAML = `version: 1
projects:
  main:
    root: .
    language: python
    image: python:3.12-slim
    test_command: python -m pytest -q {targets}
    tests_dir: tests/gen
`;
const DIFF = `diff --git a/app.py b/app.py
--- a/app.py
+++ b/app.py
@@ -1 +1 @@
-X = 1
+X = 2
`;
const TEST = "tests/gen/test_app.py";

/** Two findings of one review. F1 fails on an open question's test; F2 can be made pre-existing. */
function fixture(o: { grades?: [string, string]; preExisting?: boolean; linked?: boolean; judged?: string[] } = {}) {
  const root = tmp();
  const repo = join(root, "alpha"), rdir = join(repo, ".arnx", "reviews", "r1");
  mkdirSync(join(rdir, "projects", "main"), { recursive: true });
  writeFileSync(join(repo, ".arnx", "review.yaml"), YAML);
  writeFileSync(join(rdir, "change.diff"), DIFF);
  const finding = (id: string, func: string) => ({ id, test_id: `${TEST}::${func}`, func, file: TEST,
    message: `failure of ${func}`, explanation: `why ${func}`, verdict: null, reason: "", project: "main" });
  const second = o.preExisting
    ? { ...finding("F2", "test_two"), before: { status: "pre-existing", detail: "same", runs: ["failed"] } }
    : finding("F2", "test_two");
  writeFileSync(join(rdir, "review.json"), JSON.stringify({ schema_version: 1, id: "r1", change: "commit abc",
    files_changed: 1, added: 1, removed: 1, reviewer: "x:y", challenger: "x:y", prompt_version: "v",
    findings: [finding("F1", "test_one"), second], questions: ["Is one allowed?"], flaky: [], errors: [], passed: 0,
    tests_written: 2, missing_runs: 0, not_sent: [], cost_usd: 0, seconds: 1, stop: "end_turn", write_dir: "tests/gen",
    projects: ["main"], not_reviewed: [], uncovered: [] }));
  const report = { tests: [], suspected_defects: [],
    questions: [o.linked ? { question: "Is one allowed?", tests: [`${TEST}::test_one`] } : "Is one allowed?"] };
  writeFileSync(join(rdir, "projects", "main", "round.json"), JSON.stringify({ round: {
    agent: { finalText: JSON.stringify(report) }, files: { [TEST]: "def test_one(): assert 0\ndef test_two(): assert 0\n" } },
    hunted: null, second: null, extras: [] }));
  const judged = o.judged ?? ["F1", "F2"];
  const key = (func: string) => `main::${TEST}::${func}`;
  const stored: Record<string, unknown> = {};
  if (judged.includes("F1")) stored[key("test_one")] = { verdict: "confirmed", reason: "s", dependsOn: null, judge: null, model: "x:y", cost: 0 };
  if (judged.includes("F2")) stored[key("test_two")] = { verdict: "disputed", reason: "s", dependsOn: null, judge: null, model: "x:y", cost: 0 };
  writeFileSync(join(rdir, "verdicts.json"), JSON.stringify(stored));
  const [g1, g2] = o.grades ?? ["real-minor", "intended"];
  const grades = join(root, "grades.tsv");
  writeFileSync(grades, [HEADER, `alpha\tabc\tr1\tF1\t${g1}\tevidence one ${SENTINEL}`,
    `alpha\tabc\tr1\tF2\t${g2}\tevidence two ${SENTINEL}`, ""].join("\n"));
  return { root, repo, rdir, grades, out: join(root, "out") };
}

/** Runs the script over the fixture with a fake in place of the model factory. */
async function replay(f: { root: string; grades: string; out: string }, model: JsonModel, ...extra: string[]) {
  const lines: string[] = [];
  const code = await main(["--grades", f.grades, "--root", f.root, "--model", model.ref, "--out", f.out,
    "--concurrency", "1", ...extra], { env: {}, makeModel: () => model, log: (l) => lines.push(l) });
  return { code, lines, text: lines.join("\n") };
}

const rowsIn = (path: string) => readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Row);
const FILE = "openai_gpt-5.5-2026-04-23-current";
/** The value after a summary label in the output's mean line (or its only line). */
const metric = (out: string, name: string) => new RegExp(`mean[^\\n]*\\b${name} ([\\d./%-]+)`).exec(out)?.[1];

// ---- the prompt

class Recording extends FakeJson {
  systems: string[] = [];
  schemas: Record<string, unknown>[] = [];
  override async completeJson(system: string, user: string, schema?: Record<string, unknown>): Promise<JsonReply> {
    this.systems.push(system);
    this.schemas.push(schema ?? {});
    return super.completeJson(system, user);
  }
}

const GEN = "tests/arnx_generated/test_x.py";
const perProject: SessionFactory = async (cfg, snap, _log, body) =>
  body(new FakeSession(snap, () => [junitXml([[GEN, "test_bad", "failed", `boom in ${cfg.name}`],
    [GEN, "test_ok", "passed", ""]]), "1 failed, 1 passed", false]));

test("the rebuilt prompts are the ones a review sent, project by project", async () => {
  const repo = initRepo(join(tmp(), "alpha"));
  for (const p of ["services/pay/pay.py", "services/feed/feed.py", "services/shared/db.py", "infra/main.tf"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "X = 1\n");
  }
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-11-04"));
  commit(repo, "layout");
  // pay alone owns its file, and the other project's file is named to it as elsewhere.
  writeFileSync(join(repo, "services/pay/pay.py"), "X = 2\n");
  writeFileSync(join(repo, "services/feed/feed.py"), "X = 3\n");
  const agent = new ScriptedAgent(["feed", "pay"].flatMap((p) => [
    [tool("write_file", { path: `services/${p}/${GEN}`, content: `import ${p}\ndef test_bad(): assert 0\ndef test_ok(): pass\n` })],
    [text(JSON.stringify({ tests: [], suspected_defects: [{ test: `${GEN}::test_bad`, explanation: `${p} is wrong` }],
      questions: [`Question about ${p}?`] }))]]));
  const sent = new FakeJson([OK(), NO(), { groups: [] }]);
  const settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };
  const { review, rdir } = await runReview(repo, { projectConcurrency: 1, settings, agentModel: agent, challenger: sent,
    sessionFactory: perProject });
  expect(review.findings).toHaveLength(2);
  const sentJudge = sent.calls.slice(0, 2);
  expect(sentJudge[0]).toContain("feed.py");
  expect(sentJudge[0]).not.toContain("+++ b/services/pay/pay.py");

  const root = dirname(repo), grades = join(root, "grades.tsv");
  writeFileSync(grades, [HEADER, ...review.findings.map((x) => `alpha\thead\t${basename(rdir)}\t${x.id}\tintended\te`), ""].join("\n"));
  const again = new Recording([OK(), NO()]);
  const code = await main(["--grades", grades, "--root", root, "--model", again.ref, "--out", join(root, "out"), "--concurrency", "1"],
    { env: {}, makeModel: () => again, log: () => {} });
  expect(code).toBe(0);
  expect(again.calls).toEqual(sentJudge);
  // The real system prompt and reply schema, not a copy.
  expect(again.systems[0]).toBe(DEFAULT_PROMPTS.challengeSystem());
  expect(again.schemas[0]).toBe(CHALLENGE_SCHEMA);
});

test("a grade never reaches the prompt", async () => {
  const f = fixture({ grades: [SENTINEL, `${SENTINEL}x`] });
  const model = new Recording([OK(), NO()]);
  await replay(f, model);
  expect(model.calls).toHaveLength(2);
  for (const s of [...model.calls, ...model.systems]) {
    expect(s).not.toContain(SENTINEL);
    expect(s).not.toContain("evidence");
  }
});

test("a grade naming the wrong commit is refused before anything is sent", async () => {
  const f = fixture();
  writeFileSync(join(f.rdir, "events.jsonl"), JSON.stringify({ type: "review.started", data: { head: "fff0000" } }) + "\n");
  const model = new FakeJson([]);
  const { code, text } = await replay(f, model);
  expect(code).toBe(2);
  expect(text).toContain("alpha abc r1 F1");
  expect(model.calls).toHaveLength(0);
});

test("a finding that cannot be built stops the run before anything is sent", async () => {
  const f = fixture();
  writeFileSync(f.grades, readFileSync(f.grades, "utf8") + `alpha\tabc\tr1\tF9\tintended\te\n`);
  const model = new FakeJson([]);
  const { code, text } = await replay(f, model);
  expect(code).toBe(2);
  expect(text).toContain("F9");
  expect(model.calls).toHaveLength(0);
});

// ---- the score

test("both confirmed: one false confirm, one real, and the run holds a real defect", async () => {
  const f = fixture();
  const { code, text } = await replay(f, new FakeJson([OK(), OK()]));
  expect(code).toBe(0);
  expect(metric(text, "false_confirms")).toBe("1.0");
  expect(metric(text, "real_confirmed")).toBe("1.0/1");
  expect(metric(text, "graded_real_confirmed")).toBe("0.0/0");
  expect(metric(text, "precision")).toBe("50%");
  expect(metric(text, "runs_failing_no_defect")).toBe("0.0/1");
});

test("a run whose only confirmation is wrong fails with no defect", async () => {
  const { text } = await replay(fixture(), new FakeJson([NO(), OK()]));
  expect(metric(text, "false_confirms")).toBe("1.0");
  expect(metric(text, "real_confirmed")).toBe("0.0/1");
  expect(metric(text, "precision")).toBe("0%");
  expect(metric(text, "runs_failing_no_defect")).toBe("1.0/1");
});

test("real means real or real-minor; graded real is counted apart", async () => {
  const { text } = await replay(fixture({ grades: ["real", "real-minor"] }), new FakeJson([OK(), OK()]));
  expect(metric(text, "real_confirmed")).toBe("2.0/2");
  expect(metric(text, "graded_real_confirmed")).toBe("1.0/1");
  expect(metric(text, "precision")).toBe("100%");
});

test("a finding the reviewer's question names waits, and sets no exit code", async () => {
  const f = fixture({ grades: ["intended", "intended"], linked: true });
  const { text } = await replay(f, new FakeJson([OK(), NO()]));
  expect(metric(text, "false_confirms")).toBe("1.0");
  expect(metric(text, "runs_failing_no_defect")).toBe("0.0/1");
});

test("a confirmation the judge makes wait on a question sets no exit code", async () => {
  const f = fixture({ grades: ["intended", "intended"] });
  const { text } = await replay(f, new FakeJson([{ ...OK(), depends_on: "Q1" }, NO()]));
  expect(metric(text, "false_confirms")).toBe("1.0");
  expect(metric(text, "runs_failing_no_defect")).toBe("0.0/1");
  expect(rowsIn(join(f.out, `${FILE}-1.jsonl`))[0]!.depends_on).toBe("Q1");
});

test("a pre-existing failure sets no exit code even when confirmed", async () => {
  const f = fixture({ grades: ["intended", "intended"], preExisting: true });
  const { text } = await replay(f, new FakeJson([NO(), OK()]));
  expect(metric(text, "false_confirms")).toBe("1.0");
  expect(metric(text, "runs_failing_no_defect")).toBe("0.0/1");
});

test("no confirmation scores an empty precision, not zero", async () => {
  const { text } = await replay(fixture(), new FakeJson([NO(), NO()]));
  expect(metric(text, "precision")).toBe("-");
});

// ---- the rows and the passes

test("each pass writes one row per finding under the model and prompt, and stability compares them", async () => {
  const f = fixture();
  const { text } = await replay(f, new FakeJson([OK(), OK(), OK(), NO()], 0.25), "--repeat", "2");
  const [one, two] = [rowsIn(join(f.out, `${FILE}-1.jsonl`)), rowsIn(join(f.out, `${FILE}-2.jsonl`))];
  expect(one.map((r) => [r.repo, r.commit, r.review, r.finding, r.verdict, r.reason, r.cost_usd])).toEqual([
    ["alpha", "abc", "r1", "F1", "confirmed", "r", 0.25], ["alpha", "abc", "r1", "F2", "confirmed", "r", 0.25]]);
  expect(typeof one[0]!.seconds).toBe("number");
  expect(two.map((r) => r.verdict)).toEqual(["confirmed", "disputed"]);
  expect(text).toContain("stability 1/2 (50%)");
  expect(text).toContain("total cost $1.00");
  expect(metric(text, "false_confirms")).toBe("0.5");
  expect(text).toMatch(/pass 1\b.*false_confirms 1\b/);
  expect(text).toMatch(/pass 2\b.*false_confirms 0\b/);
});

test("a finding no review ever judged is sent and marked", async () => {
  const f = fixture({ judged: ["F1"] });
  const model = new FakeJson([OK(), NO()]);
  const { text } = await replay(f, model);
  expect(model.calls).toHaveLength(2);
  const rows = rowsIn(join(f.out, `${FILE}-1.jsonl`));
  expect(rows.map((r) => r.never_judged ?? false)).toEqual([false, true]);
  expect(text).toContain("never judged 1");
});

test("finished rows are not sent again; a call that errored is recorded and retried", async () => {
  const f = fixture();
  const first = new FakeJson([OK(), new ModelError("no reply within 60 s")]);
  const a = await replay(f, first);
  expect(a.code).toBe(0);
  const path = join(f.out, `${FILE}-1.jsonl`);
  const failed = rowsIn(path);
  expect(failed[1]).toMatchObject({ finding: "F2", verdict: null, error: "no reply within 60 s" });
  expect(a.text).toContain("errors 1");

  const second = new FakeJson([NO()]);
  await replay(f, second);
  expect(second.calls).toHaveLength(1);
  expect(second.calls[0]).toContain("test_two");
  const rows = rowsIn(path);
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ finding: "F2", verdict: "disputed" });
  expect(rows[1]!.error).toBeUndefined();

  const third = new FakeJson([]);
  await replay(f, third);
  expect(third.calls).toHaveLength(0);
});

test("a reply with no verdict is an error row, to be retried", async () => {
  const f = fixture();
  await replay(f, new FakeJson([{ verdict: "maybe", reason: "x" }, OK()]));
  const [row] = rowsIn(join(f.out, `${FILE}-1.jsonl`));
  expect(row!.verdict).toBeNull();
  expect(row!.error).toContain("unexpected verdict");
});

test("what a failed call cost stays counted after its retry", async () => {
  const f = fixture();
  const billed = new ModelError("unreadable reply");
  billed.costUsd = 0.5;
  await replay(f, new FakeJson([OK(), billed], 0.25));
  const path = join(f.out, `${FILE}-1.jsonl`);
  expect(rowsIn(path)[1]!.cost_usd).toBe(0.5);
  const { text } = await replay(f, new FakeJson([NO()], 0.25));
  expect(rowsIn(path)[1]!.cost_usd).toBe(0.75);
  expect(text).toContain("total cost $1.00");
});

test("a half-written last line is taken as not sent", async () => {
  const f = fixture();
  await replay(f, new FakeJson([OK(), OK()]));
  const path = join(f.out, `${FILE}-1.jsonl`);
  writeFileSync(path, readFileSync(path, "utf8").trim().split("\n")[0]! + "\n{\"repo\":\"alp");
  const model = new FakeJson([NO()]);
  await replay(f, model);
  expect(model.calls).toHaveLength(1);
  expect(rowsIn(path)).toHaveLength(2);
});

test("a key out of credits stops the run and keeps what was done", async () => {
  const f = fixture();
  const { code, text } = await replay(f, new FakeJson([OK(), new NoCredits("Fake")]));
  expect(code).toBe(2);
  expect(text).toContain("Fake");
  expect(rowsIn(join(f.out, `${FILE}-1.jsonl`)).map((r) => r.finding)).toEqual(["F1"]);
});

// ---- the spend limit

test("sending stops when the spend reaches --max-usd, and says so", async () => {
  const f = fixture();
  const model = new FakeJson([OK(), OK()], 0.5);
  const { code, text } = await replay(f, model, "--max-usd", "0.5");
  expect(code).toBe(0);
  expect(model.calls).toHaveLength(1);
  expect(text).toContain("stopped at $0.50 (--max-usd 0.5): 1 not sent");
  expect(rowsIn(join(f.out, `${FILE}-1.jsonl`))).toHaveLength(1);
});

test("the spend limit counts rows already on disk and later passes send nothing", async () => {
  const f = fixture();
  await replay(f, new FakeJson([OK()], 0.5), "--max-usd", "0.5");
  const model = new FakeJson([]);
  const { text } = await replay(f, model, "--max-usd", "0.5", "--repeat", "2");
  expect(model.calls).toHaveLength(0);
  expect(text).toContain("3 not sent");
  expect(existsSync(join(f.out, `${FILE}-2.jsonl`))).toBe(false);
});

// ---- the comparison

test("--compare gives agreement with stored verdicts over the judged findings only", async () => {
  const f = fixture({ judged: ["F1"] });
  const { text } = await replay(f, new FakeJson([OK(), NO()]), "--compare", "verdicts.json");
  expect(text).toContain("agreement pass 1 1/1 (100%), mean 100%");
  expect(text).not.toContain("below");
});

test("--compare says when agreement is below what the plan needs", async () => {
  const { text } = await replay(fixture(), new FakeJson([OK(), OK()]), "--compare", "verdicts.json");
  expect(text).toContain("agreement pass 1 1/2 (50%), mean 50%, below 85%");
});

test("--compare leaves out a finding the replay has no verdict for, and says how many", async () => {
  const f = fixture();
  const { text } = await replay(f, new FakeJson([OK(), new ModelError("boom")]), "--compare", "verdicts.json");
  expect(text).toContain("agreement pass 1 1/1 (100%), mean 100%, 1 without a verdict");
});

// ---- the dump and the arguments

test("--dump-prompts writes each prompt and calls nothing", async () => {
  const f = fixture({ judged: ["F1"] });
  const dir = join(f.root, "dump"), lines: string[] = [];
  const code = await main(["--grades", f.grades, "--root", f.root, "--dump-prompts", dir],
    { env: {}, makeModel: () => { throw new Error("no model in a dump"); }, log: (l) => lines.push(l) });
  expect(code).toBe(0);
  expect(lines.join("\n")).toContain("built 2 of 2");
  expect(readdirSync(dir).sort()).toEqual(["alpha-abc-r1-F1.txt", "alpha-abc-r1-F2.txt", "index.tsv"]);
  const one = readFileSync(join(dir, "alpha-abc-r1-F1.txt"), "utf8");
  expect(one).toContain(DEFAULT_PROMPTS.challengeSystem());
  expect(one).toContain("+X = 2");
  expect(one).toContain("def test_one(): assert 0");
  expect(one).toContain("failure of test_one");
  expect(one).toContain("why test_one");
  expect(one).toContain("Q1: Is one allowed?");
  expect(one).not.toContain(SENTINEL);
  const index = readFileSync(join(dir, "index.tsv"), "utf8");
  expect(index).toContain("alpha-abc-r1-F2.txt");
  expect(index).toMatch(/alpha-abc-r1-F2\.txt[^\n]*\tyes/);
  expect(index).not.toContain("real-minor");
});

test("--dump-prompts says which findings it could not build", async () => {
  const f = fixture();
  writeFileSync(f.grades, readFileSync(f.grades, "utf8") + "alpha\tabc\tr1\tF9\tintended\te\n");
  const dir = join(f.root, "dump"), lines: string[] = [];
  const code = await main(["--grades", f.grades, "--root", f.root, "--dump-prompts", dir],
    { env: {}, makeModel: () => { throw new Error("no model"); }, log: (l) => lines.push(l) });
  expect(code).toBe(2);
  expect(lines.join("\n")).toContain("built 2 of 3");
  expect(lines.join("\n")).toContain("F9");
});

test("--help names the arguments and needs nothing else", async () => {
  const lines: string[] = [];
  const code = await main(["--help"], { env: {}, makeModel: () => { throw new Error("no model"); }, log: (l) => lines.push(l) });
  expect(code).toBe(0);
  for (const a of ["--grades", "--root", "--model", "--prompt", "--repeat", "--concurrency", "--out", "--compare", "--max-usd", "--dump-prompts"]) {
    expect(lines.join("\n")).toContain(a);
  }
});

test("only the current prompt can be replayed, and flags it does not have are refused", async () => {
  const f = fixture();
  const model = new FakeJson([]);
  const { code, text } = await replay(f, model, "--prompt", "new");
  expect(code).toBe(2);
  expect(text).toContain("new");
  expect(text).toContain("current");
  expect((await replay(f, model, "--gates", "on")).code).toBe(2);
  expect(model.calls).toHaveLength(0);
});

test("the default concurrency is the one reviews use", async () => {
  expect(CONCURRENCY).toBe(4);
  const f = fixture();
  let inFlight = 0, most = 0;
  const model: JsonModel = { ref: "x:y", completeJson: async () => {
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return [OK(), 0];
  } };
  await main(["--grades", f.grades, "--root", f.root, "--model", "x:y", "--out", f.out],
    { env: {}, makeModel: () => model, log: () => {} });
  expect(most).toBe(2);
});

test("the real factory gives the named model alone, with no fallback behind it", () => {
  const model = defaultModel("river:zai-org/GLM-5.3-Flash", { RIVER_API_KEY: "k", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" });
  expect(model.ref).toBe("river:zai-org/GLM-5.3-Flash");
  expect(model).not.toBeInstanceOf(FallbackJson);
  expect(() => defaultModel("river:zai-org/GLM-5.3-Flash", {})).toThrow(SetupRequired);
  // Each model to compare has a price, so its cost and the spend limit hold.
  const keys = { RIVER_API_KEY: "k", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k" };
  for (const ref of ["anthropic:claude-sonnet-5-5", "openai:gpt-6.1-sol"]) expect(defaultModel(ref, keys).ref).toBe(ref);
});

test("a project set up after the review does not change what the review's projects were given", async () => {
  const f = fixture();
  writeFileSync(join(f.repo, ".arnx", "review.yaml"), `${YAML}  later:
    root: later
    language: python
    image: python:3.12-slim
    test_command: python -m pytest -q {targets}
    uses:
      - /app.py
`);
  // Only main ran, so main is the only project given a part of the change, and it sees all of it.
  expect(loadContext(f.repo, "r1").diffs).toEqual({ main: DIFF });
});

test("a review whose project is gone from review.yaml cannot be rebuilt", () => {
  const f = fixture();
  writeFileSync(join(f.repo, ".arnx", "review.yaml"), YAML.replace("main:", "other:"));
  expect(() => loadContext(f.repo, "r1")).toThrow("main");
});
