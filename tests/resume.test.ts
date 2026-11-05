// A review cut off halfway (a dropped connection) continues with --resume: finished project rounds and verdicts are
// kept, not paid for again.
import { beforeEach, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { ModelError } from "../src/errors";
import { nextSteps, render } from "../src/report";
import { resumable, roundCut, runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
// The fakes report the same failure on any snapshot, so the before/after check would call every finding
// pre-existing; it is off here and tested in before.test.ts.
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" };
const GEN = "tests/arnx_generated/test_x.py";
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
  for (const p of ["services/pay/pay.py", "services/feed/feed.py", "services/shared/db.py", "infra/main.tf"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "X = 1\n");
  }
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  commit(repo, "layout");
  writeFileSync(join(repo, "services/shared/db.py"), "X = 2\n"); // reviewed by feed and pay
});

const steps = (p: string) => [
  [tool("write_file", { path: `services/${p}/${GEN}`, content: `import ${p}\ndef test_bad(): assert 0\n` })],
  [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))]];
const failing = (snap: string) => new FakeSession(snap, () => [junitXml([[GEN, "test_bad", "failed", "boom"]]),
  "1 failed", false]);

test("an interrupted review resumes: the finished project and its cost are kept, the rest is done", async () => {
  // first attempt: feed finishes, then the connection drops while pay is being set up
  const cut: SessionFactory = async (cfg, snap, _log, body) => {
    if (cfg.name === "pay") throw new Error("network is unreachable");
    return body(failing(snap));
  };
  const first = new ScriptedAgent(steps("feed"));
  await expect(runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: first, challenger: new FakeJson([]),
    sessionFactory: cut })).rejects.toThrow("network is unreachable");
  const [rid] = readdirSync(join(repo, ".arnx/reviews"));
  expect(existsSync(join(repo, ".arnx/reviews", rid!, "projects/feed/round.json"))).toBe(true);
  expect(existsSync(join(repo, ".arnx/reviews", rid!, "review.json"))).toBe(false);
  // resume: only pay runs; feed's round and cost are kept
  const second = new ScriptedAgent(steps("pay"));
  const judge = new FakeJson([{ verdict: "confirmed", reason: "a" }, { verdict: "confirmed", reason: "b" }]);
  const { review } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: second, challenger: judge,
    sessionFactory: async (_c, snap, _l, body) => body(failing(snap)), resume: true });
  expect(review.id).toBe(rid!);
  expect(second.calls).toHaveLength(2);
  expect(review.findings.map((f) => f.project)).toEqual(["feed", "pay"]);
  expect(review.usage[0]!.calls).toBe(4); // feed's 2 calls from before, pay's 2 now
});

test("verdicts given before an interruption are not asked again", async () => {
  const agent = () => new ScriptedAgent([...steps("feed"), ...steps("pay")]);
  const session: SessionFactory = async (_c, snap, _l, body) => body(failing(snap));
  // the second model answers F1, then the run dies (not a model error: the process stops)
  const dying = new FakeJson([{ verdict: "confirmed", reason: "a" }]);
  const orig = dying.completeJson.bind(dying);
  let n = 0;
  dying.completeJson = async (...args: Parameters<typeof orig>) => {
    if (++n === 2) throw new Error("connection reset");
    return orig(...args);
  };
  await expect(runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agent(), challenger: dying,
    sessionFactory: session })).rejects.toThrow("connection reset");
  const judge = new FakeJson([{ verdict: "disputed", reason: "b" }]);
  const { review } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: new ScriptedAgent([]),
    challenger: judge, sessionFactory: session, resume: true });
  // only F2 is judged again (the second call is the grouping step every review ends with)
  expect(judge.calls.filter((c) => c.includes("The failing test:"))).toHaveLength(1);
  expect(judge.calls[0]).toContain("services/pay/");
  expect(review.findings.map((f) => f.verdict)).toEqual(["confirmed", "disputed"]);
});

test("--resume with nothing unfinished says so", async () => {
  await expect(runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: new ScriptedAgent([]), challenger: new FakeJson([]),
    resume: true })).rejects.toThrow("nothing to resume");
});

/** An agent that answers `steps`, then fails every call as a provider that is down. */
function downAfter(steps: ReturnType<typeof text>[][]): ScriptedAgent {
  const agent = new ScriptedAgent(steps);
  const answer = agent.create.bind(agent);
  agent.create = async (x) => {
    if (agent.steps.length) return answer(x);
    agent.calls.push({ system: x.system, tools: x.tools.map((t) => t.name), messages: [...x.messages] });
    const e = new ModelError("HTTP 503");
    e.fault = { kind: "unavailable", detail: "HTTP 503" };
    throw e;
  };
  return agent;
}

test("a review an outage cut resumes: the round it stopped runs again, the finished one is kept", async () => {
  const session: SessionFactory = async (_c, snap, _l, body) => body(failing(snap));
  // feed finishes; the reviewer's provider is down by the time pay starts
  const first = downAfter(steps("feed"));
  const cut = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: first,
    challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }]), sessionFactory: session });
  expect(cut.review.providerFailures?.[0]).toMatchObject({ kind: "unavailable", roles: ["reviewer"] });
  expect(cut.review.projectStats!.map((p) => p.stop)).toEqual(["end_turn", "api_error: HTTP 503"]);
  const diffSha = JSON.parse(readFileSync(join(cut.rdir, "state.json"), "utf8")).diff_sha256 as string;
  expect(resumable(repo, diffSha)).toBe(cut.rdir);
  const second = new ScriptedAgent(steps("pay"));
  const { review } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: second,
    challenger: new FakeJson([{ verdict: "confirmed", reason: "b" }]), sessionFactory: session, resume: true });
  expect(review.id).toBe(cut.review.id);
  expect(second.calls).toHaveLength(2);
  expect(review.findings.map((f) => [f.project, f.verdict])).toEqual([["feed", "confirmed"], ["pay", "confirmed"]]);
  expect(review.providerFailures).toBeUndefined();
  expect(resumable(repo, diffSha)).toBeNull();
});

test("a review that finished is not resumed, nor one whose outage left nothing a resume does again", async () => {
  const session: SessionFactory = async (_c, snap, _l, body) => body(failing(snap));
  const done = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS,
    agentModel: new ScriptedAgent([...steps("feed"), ...steps("pay")]),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }, { verdict: "confirmed", reason: "b" }]),
    sessionFactory: session });
  const diffSha = JSON.parse(readFileSync(join(done.rdir, "state.json"), "utf8")).diff_sha256 as string;
  expect(resumable(repo, diffSha)).toBeNull();
  await expect(runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: new ScriptedAgent([]),
    challenger: new FakeJson([]), resume: true })).rejects.toThrow("nothing to resume");
  // Only the second hunter was down: the rounds finished, and a resume keeps them as they are.
  const file = join(done.rdir, "review.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), provider_failures: [{
    provider: "other", name: "Other", kind: "unavailable", detail: "HTTP 503", calls: 2, failed: 2, attempts: 8,
    roles: ["second-hunt"], missing: ["second-hunt"] }] }));
  expect(resumable(repo, diffSha)).toBeNull();
});

// --- a round a failed call cut is redone with the hunt's suspects, not hunted again ----------------------------------------

const HUNTED = JSON.stringify({ suspects: [{ file: "svc/calc.py", line: 2, claim: "spread is negative", why: "returns -0.5",
  input: "[1, 3]", expected: "0.5", actual: "-0.5" }], questions: [] });
const SECOND_SUSPECTS = { suspects: [{ file: "svc/calc.py", line: 1, claim: "second hunter finds this", why: "", input: "",
  expected: "", actual: "" }], questions: [] };
const SPREAD = "tests/arnx_generated/test_spread.py";
const spreadReport = [text(JSON.stringify({ tests: [{ test: `${SPREAD}::test_neg`, expects: "non-negative", suspect: "S1" }],
  suspected_defects: [], questions: [], suspects_not_tested: [{ suspect: "S2", reason: "needs the network" }] }))];
// The write, the report, and the same report again for the one follow-up the round is asked.
const spreadTests = () => [
  [tool("write_file", { path: `svc/${SPREAD}`, content: "import calc\ndef test_neg(): assert 0\n" })],
  spreadReport, spreadReport];
const spreadSession: SessionFactory = async (_c, snap, _l, body) =>
  body(new FakeSession(snap, () => [junitXml([[SPREAD, "test_neg", "failed", "assert 0"]]), "1 failed", false]));

/** One project whose change a hunting review looks at. */
function huntRepo(extra: Record<string, string> = {}): string {
  const r = gitRepo(mkdtempSync(join(tmp(), "h-")));
  mkdirSync(join(r, "svc"), { recursive: true });
  writeFileSync(join(r, "svc/calc.py"), "def spread(xs):\n    return 0\n");
  mkdirSync(join(r, ".arnx"));
  writeFileSync(reviewConfigPath(r), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  for (const [p, t] of Object.entries(extra)) writeFileSync(join(r, p), t);
  commit(r, "layout");
  writeFileSync(join(r, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
  return r;
}
const usageSum = (r: string, id: string) => readFileSync(join(r, ".arnx/usage.jsonl"), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l) as { id?: string; usage: { cost_usd: number }[] }).filter((l) => l.id === id)
  .reduce((a, l) => a + l.usage.reduce((b, u) => b + u.cost_usd, 0), 0);
const stateOf = (rdir: string) => JSON.parse(readFileSync(join(rdir, "state.json"), "utf8")) as Record<string, unknown>;
/** The first run: the reviewer hunts, then its provider is down. */
async function cutAfterHunt(r: string) {
  const second = new FakeJson([SECOND_SUSPECTS, { verdict: "confirmed", reason: "x" }]);
  const cut = await runReview(r, { settings: SETTINGS, agentModel: downAfter([[text(HUNTED)]]), challenger: second,
    sessionFactory: spreadSession, hunt: true });
  return { cut, second };
}
const roundOf = (rdir: string) => join(rdir, "projects/svc/round.json");

test("a model call failing right after the hunt is redone on resume, reusing the suspects", async () => {
  const r = huntRepo();
  const { cut, second } = await cutAfterHunt(r);
  expect(cut.review.projectStats![0]!.stop).toStartWith("api_error");
  expect(second.calls).toHaveLength(1); // the second hunter
  const agent = new ScriptedAgent(spreadTests());
  const judge = new FakeJson([{ verdict: "confirmed", reason: "sign" }, { groups: [] }]);
  const { review } = await runReview(r, { settings: SETTINGS, agentModel: agent, challenger: judge,
    sessionFactory: spreadSession, hunt: true, resume: true });
  expect(review.id).toBe(cut.review.id);
  // no hunter ran: the only calls to the second model judge the test
  expect(judge.calls.every((c) => !c.includes("second hunter") && !c.includes("Look for defects"))).toBe(true);
  expect(judge.calls.filter((c) => c.includes("The failing test:"))).toHaveLength(1);
  // the reviewer opens with the task and the earlier suspects, in one message
  const first = String(agent.calls[0]!.messages[0]!.content);
  expect(first).toContain("S1 `svc/calc.py:2`: spread is negative");
  expect(first).toContain("S2 `svc/calc.py:1`: second hunter finds this");
  expect(first).not.toContain("Do not write or run tests yet");
  expect(agent.calls[0]!.tools).toContain("write_file");
  expect(review.projectStats![0]!.stop).toBe("end_turn");
  expect(review.suspects!.map((s) => [s.id, s.outcome])).toEqual([["S1", "proven"], ["S2", "not tested"]]);
  // the cut attempt and the hunters are paid once and counted; usage.jsonl holds the review's cost once
  expect(review.costUsd).toBeGreaterThan(cut.review.costUsd);
  expect(usageSum(r, review.id)).toBeCloseTo(review.costUsd, 4);
  expect(review.costUsd).toBeGreaterThanOrEqual(cut.review.costUsd + 0.01);
  // a hunter's use is in the total
  expect(review.usage.map((u) => u.model)).toContain("openai:gpt-5.5-2026-04-23");
});

// What a cut round of an earlier arnx left: its stop is rewritten to a normal end and only the transcript shows the failed call.
function olderShape(rdir: string, version: "0.1.7" | "0.1.8") {
  const f = roundOf(rdir);
  const saved = JSON.parse(readFileSync(f, "utf8"));
  saved.round.agent.stop = "end_turn";
  delete saved.round.agent.cut;
  delete saved.round.standInsShown;
  for (const k of ["noReport"]) for (const p of saved.round.projectStats ?? []) delete p[k];
  if (version === "0.1.7") delete saved.round.fakedKeys;
  writeFileSync(f, JSON.stringify(saved) + "\n");
  const review = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8"));
  delete review.seconds;
  writeFileSync(join(rdir, "review.json"), JSON.stringify(review) + "\n");
  const state = stateOf(rdir);
  delete state.seconds;
  writeFileSync(join(rdir, "state.json"), JSON.stringify(state) + "\n");
}

test("a review whose transcript ends on a failed call is redone", async () => {
  const r = huntRepo();
  const { cut } = await cutAfterHunt(r);
  olderShape(cut.rdir, "0.1.8");
  const saved = JSON.parse(readFileSync(roundOf(cut.rdir), "utf8"));
  expect(saved.round.agent.stop).toBe("end_turn");
  expect(roundCut(saved, join(cut.rdir, "projects/svc"))).toBe(true);
  const agent = new ScriptedAgent(spreadTests());
  const { review } = await runReview(r, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([
    { verdict: "confirmed", reason: "sign" }, { groups: [] }]), sessionFactory: spreadSession, hunt: true, resume: true });
  expect(agent.calls.length).toBe(3); // the write, the report, the one follow-up
  expect(review.findings.map((f) => f.verdict)).toEqual(["confirmed"]);
});

test("a review folder from the previous version resumes", async () => {
  for (const version of ["0.1.7", "0.1.8"] as const) {
    const r = huntRepo();
    const { cut } = await cutAfterHunt(r);
    olderShape(cut.rdir, version);
    const diffSha = stateOf(cut.rdir).diff_sha256 as string;
    expect(resumable(r, diffSha)).toBe(cut.rdir);
    const agent = new ScriptedAgent(spreadTests());
    const judge = new FakeJson([{ verdict: "confirmed", reason: "sign" }, { groups: [] }]);
    const { review } = await runReview(r, { settings: SETTINGS, agentModel: agent, challenger: judge, hunt: true,
      sessionFactory: spreadSession, resume: true });
    expect(review.id).toBe(cut.review.id);
    // the suspects of the folder are reused: nothing is hunted, and the reviewer is given them
    expect(judge.calls.some((c) => c.includes("Look for defects"))).toBe(false);
    expect(String(agent.calls[0]!.messages[0]!.content)).toContain("spread is negative");
    // a folder with no seconds counts from zero
    expect(typeof stateOf(cut.rdir).seconds).toBe("number");
    expect(usageSum(r, review.id)).toBeCloseTo(review.costUsd, 4);
  }
});

test("a round cut only in the follow-up about untested suspects is kept, one with a suspect left unaccounted is not", () => {
  const rdir = tmp();
  const round = (report: object, cut?: string) => ({ round: { agent: { stop: "end_turn", ...(cut ? { cut } : {}),
    finalText: JSON.stringify(report), costUsd: 0, calls: 1, turns: 1, usage: {} }, files: { "t.py": "x" } },
    hunted: [{ id: "S1" }, { id: "S2" }] });
  const done = { tests: [{ test: "t.py::a", suspect: "S1" }], suspected_defects: [], questions: [] };
  expect(roundCut(round({ ...done, suspects_not_tested: [{ suspect: "S2", reason: "network" }] }, "api_error: 503") as never,
    rdir)).toBe(false);
  expect(roundCut(round(done, "api_error: 503") as never, rdir)).toBe(true);
  expect(roundCut(round(done) as never, rdir)).toBe(false);
  expect(roundCut(round(done, "budget") as never, rdir)).toBe(false);
});

test("a resume that fails again still names the outage and can be resumed", async () => {
  const r = huntRepo();
  const { cut } = await cutAfterHunt(r);
  const diffSha = stateOf(cut.rdir).diff_sha256 as string;
  const again = await runReview(r, { settings: SETTINGS, agentModel: downAfter([]), challenger: new FakeJson([]),
    sessionFactory: spreadSession, hunt: true, resume: true });
  expect(again.review.id).toBe(cut.review.id);
  expect(again.review.providerFailures?.[0]).toMatchObject({ kind: "unavailable", roles: ["reviewer"] });
  expect(resumable(r, diffSha)).toBe(cut.rdir);
  expect(nextSteps(again.review)).toEqual(["arnx review --resume"]);
  // and the suspects survive for the next try
  const agent = new ScriptedAgent(spreadTests());
  const { review } = await runReview(r, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([
    { verdict: "confirmed", reason: "sign" }, { groups: [] }]), sessionFactory: spreadSession, hunt: true, resume: true });
  expect(String(agent.calls[0]!.messages[0]!.content)).toContain("second hunter finds this");
  expect(usageSum(r, review.id)).toBeCloseTo(review.costUsd, 4);
  expect(review.providerFailures).toBeUndefined();
});

test("the time a cut review took counts toward the resumed one", async () => {
  const r = huntRepo();
  const { cut } = await cutAfterHunt(r);
  expect(typeof stateOf(cut.rdir).seconds).toBe("number");
  writeFileSync(join(cut.rdir, "state.json"), JSON.stringify({ ...stateOf(cut.rdir), seconds: 500 }) + "\n");
  const { review, rdir } = await runReview(r, { settings: SETTINGS, agentModel: new ScriptedAgent(spreadTests()),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "sign" }, { groups: [] }]), sessionFactory: spreadSession,
    hunt: true, resume: true });
  expect(review.seconds).toBeGreaterThanOrEqual(500);
  expect(stateOf(rdir).seconds).toBe(review.seconds);
});

test("a resume gives the model no route to a real private key, whatever the saved suspects hold", async () => {
  const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const body = pem.split("\n").filter((l) => l && !l.startsWith("-----"));
  const r = huntRepo({ "svc/keys.py": `KEY = """\n${pem}"""\n` });
  const { cut } = await cutAfterHunt(r);
  // a saved suspect that holds the real key (as an older arnx could have kept it)
  const f = roundOf(cut.rdir);
  const saved = JSON.parse(readFileSync(f, "utf8"));
  saved.hunted[0].claim = `leaks ${pem}`;
  saved.hunted[0].why = pem;
  writeFileSync(f, JSON.stringify(saved) + "\n");
  const agent = new ScriptedAgent(spreadTests());
  const judge = new FakeJson([{ verdict: "confirmed", reason: "sign" }, { groups: [] }]);
  await runReview(r, { settings: SETTINGS, agentModel: agent, challenger: judge, sessionFactory: spreadSession,
    hunt: true, resume: true });
  const sent = JSON.stringify(agent.calls) + judge.calls.join("\n");
  expect(sent).toContain("S1 `svc/calc.py:2`");
  for (const l of body.filter((x) => x.length >= 16)) expect(sent).not.toContain(l);
});

// --- a folder a real outage cut, from an earlier arnx: no outage in its report, no stamp ------------------------------------

/** The saved cut folder of tests/fixtures/cut-folder as `r`'s review of its current change. */
function planted(r: string): string {
  const diffSha = createHash("sha256").update(spawnSync("git", ["diff", "HEAD"], { cwd: r, encoding: "utf8" }).stdout).digest("hex");
  const rdir = join(r, ".arnx/reviews/20261104-aaaaaa");
  cpSync(join(import.meta.dir, "fixtures/cut-folder"), rdir, { recursive: true });
  renameSync(join(rdir, "projects/main"), join(rdir, "projects/svc"));
  writeFileSync(join(rdir, "state.json"), JSON.stringify({ change: "uncommitted changes", diff_sha256: diffSha }) + "\n");
  return rdir;
}

test("a review an earlier arnx cut, whose report names no outage, resumes: nothing is hunted again", async () => {
  const r = huntRepo();
  const rdir = planted(r);
  expect(existsSync(join(rdir, "review.json"))).toBe(true);
  expect(JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")).provider_failures).toBeUndefined();
  const agent = new ScriptedAgent(spreadTests());
  const judge = new FakeJson([{ verdict: "confirmed", reason: "sign" }, { groups: [] }]);
  const { review } = await runReview(r, { settings: SETTINGS, agentModel: agent, challenger: judge, hunt: true,
    sessionFactory: spreadSession, resume: true });
  expect(review.id).toBe("20261104-aaaaaa");
  expect(String(agent.calls[0]!.messages[0]!.content)).toContain("S1 `svc/calc.py:2`: spread is negative");
  expect(judge.calls.some((c) => c.includes("Look for defects"))).toBe(false);
  expect(review.findings.map((f) => f.verdict)).toEqual(["confirmed"]);
  expect(review.costUsd).toBeGreaterThan(0.12); // the cut attempt and its second hunter stay in the cost
});

test("a review cut under another review.yaml, model or prompt is run fresh, and says so", async () => {
  const r = huntRepo();
  const { cut } = await cutAfterHunt(r);
  expect(typeof stateOf(cut.rdir).stamp).toBe("string");
  writeFileSync(reviewConfigPath(r), readFileSync(reviewConfigPath(r), "utf8") + "# edited\n");
  const said: string[] = [];
  const agent = new ScriptedAgent([[text(HUNTED)], ...spreadTests()]);
  const { review } = await runReview(r, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([SECOND_SUSPECTS,
    { verdict: "confirmed", reason: "sign" }, { groups: [] }]), sessionFactory: spreadSession, hunt: true, resume: true,
    progress: (m) => said.push(m) });
  expect(said).toContain("review.yaml, models or prompts changed since that review: running it fresh");
  expect(review.id).not.toBe(cut.review.id);
  expect(String(agent.calls[0]!.messages[0]!.content)).toContain("Do not write or run tests yet"); // it hunted
  expect(stateOf(cut.rdir).superseded).toBe(review.id);
  const diffSha = stateOf(cut.rdir).diff_sha256 as string;
  expect(resumable(r, diffSha)).toBeNull(); // the old one is not offered again, the new one finished
});

test("a round an outage cut says so, not that the reviewer gave no report", async () => {
  const r = huntRepo();
  const { cut } = await cutAfterHunt(r);
  const review = { ...cut.review, projectStats: cut.review.projectStats!.map((p) => ({ ...p, stop: "end_turn",
    noReport: true as const })) };
  const md = render(review);
  expect(md).toContain("a model call failed before the reviewer gave its report");
  expect(md).not.toContain("the reviewer gave no report");
  expect(nextSteps(cut.review)).toEqual(["arnx review --resume"]);
});
