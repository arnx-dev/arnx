// The Brain's agent round in the shape of the arnx cloud API (v1): steps of tool calls the
// CLI runs and answers by id, a final report, the CLI's facts after each final, and the end. A remote brain speaks
// the same sequence over HTTP, so the interface must not need reshaping for it.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { RawToolError, ToolError, toolErrorText, Workspace } from "../src/agent";
import type { Facts, RoundTools, Step } from "../src/brain";
import { parseReviewConfig } from "../src/config";
import { type JsonModel, PRICES } from "../src/llm";
import { LocalBrain } from "../src/localbrain";
import { askedTask, coverageTask, untestedSuspectsTask } from "../src/prompts";
import { FakeJson, ScriptedAgent, text, tool } from "./helpers/fakes";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const CFG = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest {targets}\n");
const GEN = "tests/arnx_generated/test_a.py";
/** The contract's ToolName. */
const CONTRACT_TOOLS = ["list_dir", "read_file", "grep", "write_file", "run_tests", "try_project", "propose"];
const NONE: Facts = { untestedFiles: [], dbUntested: [], generatedFiles: [] };

type Logged = Step | { type: "facts"; facts: Facts } | { type: "ran"; name: string };

/** The CLI's side, faked: tools that answer with their name, facts given in turn, every step logged. */
function cli(facts: Facts[], log: Logged[]): RoundTools {
  const offered = new Workspace(tmp(), { writeDir: "tests/arnx_generated", runTests: () => "" }).tools();
  return {
    tools: () => offered,
    call: async (name) => {
      log.push({ type: "ran", name });
      return `${name} ok`;
    },
    facts: () => {
      const f = facts.shift() ?? NONE;
      log.push({ type: "facts", facts: f });
      return f;
    },
    onStep: (s) => log.push(s),
  };
}

const input = (over: Record<string, unknown> = {}) => ({ cfg: CFG, diff: "diff --git a/a.py b/a.py\n", scoped: false,
  scope: { owned: ["a.py", "b.py"], used: [] }, envTests: [], maxQuestions: 3, dbNames: [], budgetUsd: 5,
  outDir: tmp(), ...over });

/** Results go back to the model one per call id, as the contract's ToolResult does. */
function resultIds(model: ScriptedAgent, call: number): string[] {
  const last = model.calls[call]!.messages.at(-1)!.content as { type: string; tool_use_id: string }[];
  return last.map((r) => r.tool_use_id);
}

test("a review round: actions answered by id, a final report, facts after each final, then done", async () => {
  const report = JSON.stringify({ tests: [{ test: `${GEN}::test_a`, expects: "a works" }], suspected_defects: [],
    questions: [{ question: "Is b meant to be public?", tests: [] }] });
  const model = new ScriptedAgent([
    [tool("read_file", { path: "a.py" }), tool("grep", { pattern: "def ", path: "." })],
    [tool("write_file", { path: GEN, content: "def test_a(): pass\n" }), tool("run_tests")],
    [text(report)],
    [tool("write_file", { path: "tests/arnx_generated/test_b.py", content: "def test_b(): pass\n" })],
    [text(report)],
  ]);
  const log: Logged[] = [];
  // The facts are the CLI's, not the brain's: b.py is "untested" though nothing here could tell.
  const tools = cli([{ untestedFiles: ["b.py"], dbUntested: [], generatedFiles: [GEN] },
    { untestedFiles: [], dbUntested: [], generatedFiles: [GEN, "tests/arnx_generated/test_b.py"] }], log);
  const r = await new LocalBrain({ agentModel: model, prices: PRICES }).agentRound("review", input(),
    Promise.resolve(tools));

  const steps = log.filter((e) => e.type !== "ran").map((e) => e.type);
  expect(steps).toEqual(["actions", "actions", "final", "facts", "actions", "final", "facts", "done"]);
  const actions = log.filter((e): e is Extract<Step, { type: "actions" }> => e.type === "actions");
  for (const a of actions) {
    expect(a.actions.length).toBeGreaterThan(0);
    for (const c of a.actions) {
      expect(CONTRACT_TOOLS).toContain(c.name);
      expect(c.id).toMatch(/^toolu_/);
      expect(typeof c.input).toBe("object");
    }
  }
  expect(actions[0]!.actions.map((c) => [c.name, c.input])).toEqual([["read_file", { path: "a.py" }],
    ["grep", { pattern: "def ", path: "." }]]);
  // Each action ran once in the CLI, in order, and its result went back under its id.
  expect(log.filter((e) => e.type === "ran").map((e) => (e as { name: string }).name)).toEqual(["read_file", "grep",
    "write_file", "run_tests", "write_file"]);
  expect(resultIds(model, 1)).toEqual(actions[0]!.actions.map((c) => c.id));
  expect(resultIds(model, 2)).toEqual(actions[1]!.actions.map((c) => c.id));
  // The final carries the report in the contract's AgentReport shape.
  const final = log.find((e): e is Extract<Step, { type: "final" }> => e.type === "final")!;
  expect(final.turn).toBe(3);
  expect(final.report).toEqual({ tests: [{ test: `${GEN}::test_a`, expects: "a works" }], suspected_defects: [],
    questions: [{ question: "Is b meant to be public?", tests: [] }] });
  expect(final.suspects).toEqual([]);
  // The brain worded the follow-up from the facts it was given, once; the second final ended the round.
  expect(model.calls[3]!.messages.at(-1)!.content).toBe(coverageTask(["b.py"], { files: [], names: [] }) +
    askedTask(["Is b meant to be public?"]));
  expect(log.at(-1)).toEqual({ type: "done", stop: "end_turn", turns: 5 });
  expect([r.agent.stop, r.agent.turns, r.hunt]).toEqual(["end_turn", 5, undefined]);
});

test("a hunting round: the hunt reply is no final, writing waits for it, and the final names the suspects", async () => {
  const hunt = JSON.stringify({ suspects: [
    { file: "a.py", line: 2, claim: "a returns a negative", why: "", input: "[1]", expected: "1", actual: "-1" },
    { file: "b.py", line: 5, claim: "b drops the last item", why: "", input: "[1, 2]", expected: "2", actual: "1" }],
  questions: [] });
  const proved = JSON.stringify({ tests: [{ test: `${GEN}::test_a`, expects: "positive", suspect: "S1" }],
    suspected_defects: [], questions: [] });
  const model = new ScriptedAgent([
    [tool("write_file", { path: GEN, content: "x" })], // closed during the hunt: the CLI never runs it
    [tool("read_file", { path: "a.py" })],
    [text(hunt)],
    [tool("write_file", { path: GEN, content: "def test_a(): pass\n" })],
    [text(proved)],
    [text(proved)], // asked once about S2: keeps its answer
  ]);
  const log: Logged[] = [];
  const r = await new LocalBrain({ agentModel: model, prices: PRICES }).agentRound("review",
    input({ hunt: { context: "(none found)", root: tmp(), searchDirs: ["."] } }), Promise.resolve(cli([], log)));

  // The write refused during the hunt is no step: only calls that reach the CLI are listed.
  expect(log.map((e) => e.type)).toEqual(["actions", "ran", "actions", "ran", "final", "facts", "final", "facts",
    "done"]);
  const closed = (model.calls[1]!.messages.at(-1)!.content as { is_error?: boolean; content: string }[])[0]!;
  expect(closed.is_error).toBe(true);
  expect(closed.content).toContain("not yet: first reply with the suspects as JSON");
  const finals = log.filter((e): e is Extract<Step, { type: "final" }> => e.type === "final");
  expect(finals[0]!.suspects!.map((s) => [s.id, s.file, s.line, s.by])).toEqual([["S1", "a.py", 2, model.model],
    ["S2", "b.py", 5, model.model]]);
  expect(model.calls[5]!.messages.at(-1)!.content).toBe(untestedSuspectsTask([{ id: "S2" }]));
  expect(r.hunt!.suspects!.map((s) => s.id)).toEqual(["S1", "S2"]);
  expect([r.hunt!.second, r.hunt!.extras, r.hunt!.late]).toEqual([null, [], null]);
  expect(existsSync(join(tmp(), "hunt.json"))).toBe(true); // every hunter's list, as before
});

test("a report that reaches the budget is still the round's final, before done", async () => {
  const report = JSON.stringify({ tests: [{ test: `${GEN}::test_a`, expects: "a works" }], suspected_defects: [],
    questions: [] });
  const model = new ScriptedAgent([
    [tool("write_file", { path: GEN, content: "def test_a(): pass\n" })],
    [text(report)],
  ]);
  const log: Logged[] = [];
  // The first reply is under the budget; the report crosses it, so no follow-up is asked.
  const tools = cli([{ untestedFiles: ["b.py"], dbUntested: [], generatedFiles: [GEN] }], log);
  const r = await new LocalBrain({ agentModel: model, prices: PRICES }).agentRound("review",
    input({ budgetUsd: 0.005 }), Promise.resolve(tools));
  expect(log.filter((e) => e.type !== "ran").map((e) => e.type)).toEqual(["actions", "final", "done"]);
  const final = log.find((e): e is Extract<Step, { type: "final" }> => e.type === "final")!;
  expect([final.turn, final.report!.tests]).toEqual([2, [{ test: `${GEN}::test_a`, expects: "a works" }]]);
  expect([r.agent.stop, r.agent.finalText, model.calls.length]).toEqual(["end_turn", report, 2]);
});

test("an answer whose report reaches the budget also ends on final, then done", async () => {
  const report = JSON.stringify({ tests: [], suspected_defects: [], questions: [] });
  const log: Logged[] = [];
  await new LocalBrain({ agentModel: new ScriptedAgent([[text(report)]]), prices: PRICES }).agentRound("answer",
    { cfg: CFG, question: "q", answer: "a", diff: "", budgetUsd: 0.000001, outDir: tmp() },
    Promise.resolve(cli([], log)));
  expect(log.map((e) => e.type)).toEqual(["final", "done"]);
});

test("a hunt reply that reaches the budget is no final", async () => {
  const hunt = JSON.stringify({ suspects: [], questions: [] });
  const log: Logged[] = [];
  await new LocalBrain({ agentModel: new ScriptedAgent([[text(hunt)]]), prices: PRICES }).agentRound("review",
    input({ budgetUsd: 0.000001, hunt: { context: "", root: tmp(), searchDirs: ["."] } }), Promise.resolve(cli([], log)));
  expect(log.map((e) => e.type)).toEqual(["done"]);
});

test("facts given as a promise are awaited: a remote CLI's facts word the follow-up", async () => {
  const report = JSON.stringify({ tests: [{ test: `${GEN}::test_a`, expects: "a works" }], suspected_defects: [],
    questions: [] });
  const model = new ScriptedAgent([[text(report)], [text(report)]]);
  const log: Logged[] = [];
  const tools: RoundTools = { ...cli([], log),
    // As a bridge to a remote CLI gives them: they come with the CLI's next step, after the final is sent.
    facts: () => new Promise<Facts>((r) => setTimeout(() => r({ untestedFiles: ["b.py"], dbUntested: [],
      generatedFiles: [GEN] }), 20)) };
  await new LocalBrain({ agentModel: model, prices: PRICES }).agentRound("review", input(), Promise.resolve(tools));
  expect(model.calls).toHaveLength(2);
  expect(model.calls[1]!.messages.at(-1)!.content).toBe(coverageTask(["b.py"], { files: [], names: [] }) +
    askedTask([]));
});

test("during the hunt a step lists only the calls that reach the CLI; the refusal the model reads is unchanged",
  async () => {
    const hunt = JSON.stringify({ suspects: [], questions: [] });
    const model = new ScriptedAgent([
      [tool("read_file", { path: "a.py" }), tool("write_file", { path: GEN, content: "x" }), tool("run_tests")],
      [text(hunt)],
      [tool("write_file", { path: GEN, content: "def test_a(): pass\n" }), tool("run_tests")],
      [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))],
    ]);
    const log: Logged[] = [];
    await new LocalBrain({ agentModel: model, prices: PRICES }).agentRound("review",
      input({ hunt: { context: "", root: tmp(), searchDirs: ["."] } }), Promise.resolve(cli([], log)));
    const actions = log.filter((e): e is Extract<Step, { type: "actions" }> => e.type === "actions");
    // Turn 1 lists the read only; after the hunt reply the write and the run are listed and run.
    expect(actions.map((a) => [a.turn, a.actions.map((c) => c.name)])).toEqual([[1, ["read_file"]],
      [3, ["write_file", "run_tests"]]]);
    expect(log.filter((e) => e.type === "ran").map((e) => (e as { name: string }).name)).toEqual(["read_file",
      "write_file", "run_tests"]);
    const results = model.calls[1]!.messages.at(-1)!.content as { is_error?: boolean; content: string }[];
    const refusal = "ToolError: not yet: first reply with the suspects as JSON; then you can write and run tests";
    expect(results.map((r) => [r.content, r.is_error ?? false])).toEqual([["read_file ok", false], [refusal, true],
      [refusal, true]]);
  });

test("without an outDir a round writes nothing; the hunt's record is on the result and the final step", async () => {
  const root = join(tmp(), "snapshot");
  mkdirSync(root);
  const hunt = JSON.stringify({ suspects: [{ file: "a.py", line: 2, claim: "a returns a negative" }], questions: [] });
  const proved = JSON.stringify({ tests: [{ test: `${GEN}::test_a`, expects: "positive", suspect: "S1" }],
    suspected_defects: [], questions: [] });
  // S2 has no test, so the reviewer is asked about it once.
  const model = new ScriptedAgent([[tool("read_file", { path: "a.py" })], [text(hunt)], [text(proved)], [text(proved)]]);
  // Whether the second hunter's attempts were being logged when it was called (to hunt-second.jsonl).
  const traced: boolean[] = [];
  const hunter = (reply: Record<string, unknown>) => {
    const m: FakeJson & Pick<JsonModel, "trace"> = new FakeJson([reply]);
    const ask = m.completeJson.bind(m);
    m.completeJson = (system, user) => {
      traced.push(m.trace !== undefined);
      return ask(system, user);
    };
    return m;
  };
  const second = hunter({ suspects: [{ file: "b.py", line: 5, claim: "b drops the last item" }] });
  const log: Logged[] = [];
  const x = input({ hunt: { context: "", root, searchDirs: ["."] } });
  delete (x as { outDir?: string }).outDir;
  const r = await new LocalBrain({ agentModel: model, prices: PRICES, secondHunter: second }).agentRound("review", x,
    Promise.resolve(cli([], log)));
  expect(readdirSync(tmp())).toEqual(["snapshot"]);
  expect(readdirSync(root)).toEqual([]);
  expect(existsSync(join(process.cwd(), "transcript.jsonl")) || existsSync(join(process.cwd(), "hunt.json")))
    .toBe(false);
  expect(second.trace).toBeUndefined(); // left as it was
  // What hunt.json would hold.
  const record = r.hunt!.record!;
  expect([record.reviewer.map((s) => s.claim), record.parts, record.second!.map((s) => s.claim),
    record.tested.map((s) => s.id)]).toEqual([["a returns a negative"], [], ["b drops the last item"], ["S1", "S2"]]);
  const final = log.find((e): e is Extract<Step, { type: "final" }> => e.type === "final")!;
  expect(final.hunt).toEqual(record);
  expect(r.agent.stop).toBe("end_turn");

  // The same round with an outDir writes its logs, as before.
  const out = join(tmp(), "out");
  await new LocalBrain({ agentModel: new ScriptedAgent([[tool("read_file", { path: "a.py" })], [text(hunt)],
    [text(proved)], [text(proved)]]), prices: PRICES, secondHunter: hunter({ suspects: [] }) }).agentRound("review",
    { ...x, outDir: out }, Promise.resolve(cli([], [])));
  expect(readdirSync(out).sort()).toEqual(["hunt.json", "transcript.jsonl"]);
  expect(traced).toEqual([false, true]);
});

test("an error result worded by a remote CLI reaches the model as it would locally, not named twice", async () => {
  const ws = new Workspace(tmp(), { writeDir: "tests/arnx_generated", runTests: () => "" });
  const run = async (tools: RoundTools) => {
    const model = new ScriptedAgent([[tool("read_file", { path: "nope.py" }), tool("write_file", { path: "x.txt",
      content: "x" })], [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))]]);
    await new LocalBrain({ agentModel: model, prices: PRICES }).agentRound("review", input(), Promise.resolve(tools));
    return (model.calls[1]!.messages.at(-1)!.content as { is_error?: boolean; content: string }[])
      .map((r) => [r.content, r.is_error]);
  };
  // Locally: the Workspace's ToolError, named by the loop.
  const local = await run({ tools: () => ws.tools(), call: (n, a) => ws.call(n, a) });
  // Remotely: the CLI words the error (as CloudBrain sends it) and the bridge passes that text on as it is.
  const remote = await run({ tools: () => ws.tools(), call: async (n, a) => {
    let output: string;
    try {
      return await ws.call(n, a);
    } catch (e) {
      output = toolErrorText(e);
    }
    throw new RawToolError(output);
  } });
  expect(local).toEqual([["ToolError: not a file: nope.py", true],
    ["ToolError: writes are allowed only for test_*.py, conftest.py or __init__.py under tests/arnx_generated/", true]]);
  expect(remote).toEqual(local);
  expect([toolErrorText(new ToolError("x")), toolErrorText(new Error("y")), toolErrorText(new RawToolError("z"))])
    .toEqual(["ToolError: x", "Error: y", "z"]);
});
