// model.call and agent.turn events: one per model call or agent turn, with the caller's role, from the real clients
// (fed scripted models and injected fetch) and the agent loop.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, Workspace } from "../src/agent";
import { parseReviewConfig } from "../src/config";
import { ModelError } from "../src/errors";
import { EventLog, withEvents, withRole } from "../src/events";
import { jevModel } from "../src/jev";
import { type AgentModel, AnthropicJson, FallbackJson, PRICES, type Reply, ResponsesAgent, ResponsesJson }
  from "../src/llm";
import { parseModelRef } from "../src/settings";
import { ScriptedAgent, text, tool } from "./helpers/fakes";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();
const SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"],
  additionalProperties: false };
const GPT = parseModelRef("openai:gpt-5.5-2026-04-23");
const SONNET = parseModelRef("anthropic:claude-sonnet-5-5");
const noSleep = async () => {};
let logs = 0;
const USAGE = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 };

/** Runs `fn` with a log open on a fresh file, and returns the events it wrote. */
async function traced<T>(fn: () => Promise<T>):
  Promise<{ events: { type: string; data: Record<string, any> }[]; result: T | Error }> {
  const path = join(tmp(), `events-${++logs}.jsonl`);
  let result: T | Error;
  try {
    result = await withEvents(new EventLog(path, "T1"), fn);
  } catch (e) {
    result = e as Error;
  }
  const events = readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
  return { events, result };
}

const sse = (body: unknown) => [{ type: "response.created", response: { status: "in_progress" } },
  { type: "response.completed", response: body }]
  .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
const completed = { status: "completed", output: [{ type: "message", role: "assistant", status: "completed",
  content: [{ type: "output_text", text: '{"verdict": "ok"}' }] }],
usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } } };
const okFetch = (() => new Response(sse(completed), { status: 200 })) as unknown as typeof fetch;
const badFetch = (() => new Response("bad request", { status: 400 })) as unknown as typeof fetch;
const responses = (f: typeof fetch) => new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES,
  { sleep: noSleep, fetch: f });

test("runAgent emits a model.call and an agent.turn per turn, with the role and context", async () => {
  const ws = new Workspace(tmp());
  const model = new ScriptedAgent([[tool("read_file", { path: "nope.py" })], [text("done")]]);
  const { events } = await traced(() => withRole("reviewer", () => runAgent(model, ws, { system: "s", user: "u",
    budgetUsd: 1, prices: PRICES, transcript: join(tmp(), "t.jsonl") }), { project: "main" }));
  const calls = events.filter((e) => e.type === "model.call").map((e) => e.data);
  const turns = events.filter((e) => e.type === "agent.turn").map((e) => e.data);
  expect(calls).toHaveLength(2);
  expect(calls.map((c) => [c.role, c.project, c.turn, c.ok])).toEqual([["reviewer", "main", 1, true],
    ["reviewer", "main", 2, true]]);
  expect(calls[0]).toMatchObject({ provider: "unknown", model: "claude-sonnet-5-5", input: 1000, output: 200,
    unknown_usage: 0, timed_out: false });
  expect(calls[0]!.cost_usd).toBeGreaterThan(0);
  expect(turns).toHaveLength(2);
  expect(turns[0]).toMatchObject({ role: "reviewer", project: "main", turn: 1, stop_reason: "tool_use",
    tools: ["read_file"], tool_errors: 1, writes: 0, test_runs: 0 });
  expect(turns[1]).toMatchObject({ turn: 2, stop_reason: "end_turn", tools: [] });
  expect(turns.map((t) => t.paths)).toEqual([["nope.py"], []]);
});

test("agent.turn lists the path of each read tool call in order, never contents or write paths", async () => {
  const long = "d/".repeat(200);
  const model = new ScriptedAgent([[tool("list_dir", { path: "src" }), tool("grep", { pattern: "x" }),
    tool("grep", { pattern: "y", path: "lib" }), tool("read_file", { path: long }),
    tool("write_file", { path: "tests/arnx_generated/t.py", content: "SECRET-BODY" })], [text("done")]]);
  const { events } = await traced(() => runAgent(model, new Workspace(tmp(), { writeDir: "tests/arnx_generated" }),
    { system: "s", user: "u", budgetUsd: 1, prices: PRICES, transcript: join(tmp(), "t.jsonl") }));
  const turn = events.find((e) => e.type === "agent.turn")!.data;
  expect(turn.paths).toEqual(["src", ".", "lib", long.slice(0, 300) + "…"]);
  expect(JSON.stringify(events)).not.toContain("SECRET-BODY");
});

test("a ModelError in the agent loop is one failed model.call with its unknown usage and timeout", async () => {
  const model: AgentModel = { model: "claude-sonnet-5-5", provider: "anthropic", create: async () => {
    const e = new ModelError("no reply");
    [e.unknownCalls, e.timedOut] = [1, true];
    throw e;
  } };
  const { events } = await traced(() => runAgent(model, new Workspace(tmp()), { system: "s", user: "u", budgetUsd: 1,
    prices: PRICES, transcript: join(tmp(), "t.jsonl") }));
  expect(events).toHaveLength(1);
  expect(events[0]!.data).toMatchObject({ role: "unknown", provider: "anthropic", ok: false, error: "no reply",
    unknown_usage: 1, timed_out: true, turn: 1, input: 0, cost_usd: 0 });
});

test("AnthropicJson emits one model.call for a retry after a reply that was not JSON, with summed tokens", async () => {
  const reply = (t: string, n: number): Reply => ({ content: [{ type: "text", text: t }], stopReason: "end_turn",
    usage: USAGE, raw: [], attempts: Array.from({ length: n }, () => ({ secs: 1, firstEventSecs: 1, longestGapSecs: 0,
      events: 1, outcome: "ok" as const })) });
  const replies = [reply("not json", 1), reply('{"verdict": "ok"}', 2)];
  const agent: AgentModel = { model: "claude-sonnet-5-5", provider: "anthropic", create: async () => replies.shift()! };
  const { events } = await traced(() => withRole("rank", () =>
    new AnthropicJson(SONNET, agent, PRICES).completeJson("s", "u", SCHEMA)));
  expect(events).toHaveLength(1);
  expect(events[0]!.data).toMatchObject({ role: "rank", provider: "anthropic", model: "claude-sonnet-5-5", ok: true,
    input: 2000, output: 400, attempts: 3, unknown_usage: 0, timed_out: false });
  expect(events[0]!.data.cost_usd).toBeCloseTo(2 * (1000 * 2 + 200 * 10) / 1_000_000, 10);
});

test("AnthropicJson that never gets JSON emits one failed model.call, then throws", async () => {
  const agent = new ScriptedAgent([[text("no")], [text("still no")]]);
  const { events, result } = await traced(() =>
    new AnthropicJson(SONNET, agent, PRICES).completeJson("s", "u", SCHEMA));
  expect(result).toBeInstanceOf(ModelError);
  expect(events).toHaveLength(1);
  expect(events[0]!.data).toMatchObject({ ok: false, input: 2000, output: 400 });
  expect(events[0]!.data.error).toMatch(/did not reply with JSON/);
});

test("ResponsesJson emits one model.call per call: success, then an HTTP 400 that propagates", async () => {
  const ok = await traced(() => withRole("explain", () => responses(okFetch).completeJson("s", "u", SCHEMA)));
  expect(ok.events).toHaveLength(1);
  expect(ok.events[0]!.data).toMatchObject({ role: "explain", provider: "openai", model: "gpt-5.5-2026-04-23",
    ok: true, input: 1000, output: 100, unknown_usage: 0, timed_out: false });
  expect(ok.events[0]!.data.cost_usd).toBeGreaterThan(0);
  expect(ok.events[0]!.data.attempts).toBe(1);
  const bad = await traced(() => responses(badFetch).completeJson("s", "u", SCHEMA));
  expect(bad.result).toBeInstanceOf(ModelError);
  expect(bad.events).toHaveLength(1);
  expect(bad.events[0]!.data).toMatchObject({ ok: false, input: 0, output: 0, cost_usd: 0, timed_out: false });
  expect(bad.events[0]!.data.error).toMatch(/HTTP 400/);
  expect(bad.events[0]!.data.attempts).toBe(1);
});

/** A fetch whose first request is accepted and cut off (no terminal event), and whose second completes. */
const cutThenOk = () => {
  let n = 0;
  return (() => new Response(++n === 1 ? sse(completed).split("\n\n")[0]! + "\n\n" : sse(completed),
    { status: 200 })) as unknown as typeof fetch;
};

test("ResponsesJson that retried once after a cut-off reply reports 2 attempts and 1 unknown usage", async () => {
  const { events, result } = await traced(() => responses(cutThenOk()).completeJson("s", "u", SCHEMA));
  expect(result).toEqual([{ verdict: "ok" }, expect.any(Number), expect.anything(), 1]);
  expect(events).toHaveLength(1);
  expect(events[0]!.data).toMatchObject({ ok: true, attempts: 2, unknown_usage: 1 });
});

test("ResponsesJson that fails on its last retry reports the attempts it made", async () => {
  const cut = (() => new Response(sse(completed).split("\n\n")[0]! + "\n\n",
    { status: 200 })) as unknown as typeof fetch;
  const { events, result } = await traced(() => responses(cut).completeJson("s", "u", SCHEMA));
  expect(result).toBeInstanceOf(ModelError);
  expect(events[0]!.data.ok).toBe(false);
  expect(events[0]!.data.attempts).toBe(events[0]!.data.unknown_usage);
  expect(events[0]!.data.attempts).toBeGreaterThan(1);
});

test("a ResponsesAgent turn after a cut-off attempt is one model.call with unknown usage and tries", async () => {
  const model = new ResponsesAgent(responses(cutThenOk()), "medium");
  const transcript = join(tmp(), "t.jsonl");
  const { events } = await traced(() => runAgent(model, new Workspace(tmp()), { system: "s", user: "u", budgetUsd: 1,
    prices: PRICES, transcript }));
  const calls = events.filter((e) => e.type === "model.call");
  expect(calls).toHaveLength(1);
  expect(calls[0]!.data).toMatchObject({ provider: "openai", ok: true, unknown_usage: 1, attempts: 2, turn: 1 });
  // the transcript keeps its shape: tries is for events only
  const line = JSON.parse(readFileSync(transcript, "utf8").split("\n")[0]!);
  expect(line).not.toHaveProperty("attempts");
  expect(line).not.toHaveProperty("tries");
});

test("a ResponsesAgent call that fails gives the failed model.call the attempts made", async () => {
  const model = new ResponsesAgent(responses(badFetch), "medium");
  const { events } = await traced(() => runAgent(model, new Workspace(tmp()), { system: "s", user: "u", budgetUsd: 1,
    prices: PRICES, transcript: join(tmp(), "t.jsonl") }));
  expect(events[0]!.data).toMatchObject({ ok: false, attempts: 1 });
});

test("a ResponsesJson reply that is not JSON is a failed model.call that still carries its cost", async () => {
  const notJson = structuredClone(completed);
  notJson.output[0]!.content![0]!.text = "plain words";
  const f = (() => new Response(sse(notJson), { status: 200 })) as unknown as typeof fetch;
  const { events, result } = await traced(() => responses(f).completeJson("s", "u", SCHEMA));
  expect(result).toBeInstanceOf(ModelError);
  expect(events).toHaveLength(1);
  expect(events[0]!.data).toMatchObject({ ok: false, input: 1000, output: 100 });
  expect(events[0]!.data.cost_usd).toBeGreaterThan(0);
});

test("FallbackJson emits one model.call per model asked, both with the caller's role", async () => {
  const model = new FallbackJson(responses(badFetch), responses(okFetch));
  const { events } = await traced(() => withRole("challenge", () => model.completeJson("s", "u", SCHEMA),
    { finding: "F1", project: "main" }));
  expect(events.map((e) => [e.type, e.data.role, e.data.ok, e.data.finding])).toEqual([
    ["model.call", "challenge", false, "F1"], ["model.call", "challenge", true, "F1"]]);
});

test("jevModel emits a model.call with role jev, and nothing for a message withheld as secret", async () => {
  const answer = (async () => new Response(JSON.stringify({ model: "jev-1", answers: { cause: { type: "choice",
    choice: "genuine-failure", confidence: 0.95 } } }))) as unknown as typeof fetch;
  const cfg = parseReviewConfig(CFG);
  const { events } = await traced(async () => {
    const ask = jevModel("k", null, answer);
    await withRole("setup", () => ask("boom", cfg, []));
    await ask(`token = ${"sk-ant-" + "x".repeat(40)}`, cfg, []); // built at runtime: no key-shaped literal in the tree
  });
  expect(events).toHaveLength(1);
  expect(events[0]!.data).toMatchObject({ role: "jev", provider: "typesafe", model: "jev-latest", ok: true,
    cost_usd: 0, unknown_usage: 1, timed_out: false });
});

test("jevModel marks an unanswered request as failed with no response counted", async () => {
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  const { events } = await traced(() => jevModel("k", null, offline)("boom", parseReviewConfig(CFG), []));
  expect(events[0]!.data).toMatchObject({ role: "jev", ok: false, error: "Error", unknown_usage: 0, timed_out: false });
});

/** An OpenAI background client: create answers queued; polls answer in_progress, then `last` (or forever in_progress). */
const background = (last: Record<string, unknown> | null, totalSeconds = 5) => {
  let polls = 0;
  return new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { background: true, totalSeconds,
    sleep: (s) => new Promise((r) => setTimeout(r, Math.min(s, 0.01) * 1000)),
    fetch: (async (url: string | URL | Request) => {
      const u = String(url);
      if (u.endsWith("/responses")) return Response.json({ id: "resp_1", status: "queued" });
      if (u.endsWith("/cancel")) return Response.json({ id: "resp_1", status: "cancelled" });
      return Response.json(last && ++polls > 1 ? { id: "resp_1", ...last } : { id: "resp_1", status: "in_progress" });
    }) as typeof fetch });
};

test("a polled background call is one model.call: priced once, 1 attempt; one that times out is 1 unknown", async () => {
  const ok = await traced(() => withRole("second-hunt", () => background(completed).completeJson("s", "u", SCHEMA)));
  expect(ok.events).toHaveLength(1);
  expect(ok.events[0]!.data).toMatchObject({ role: "second-hunt", provider: "openai", ok: true, input: 1000,
    output: 100, attempts: 1, unknown_usage: 0, timed_out: false });
  expect(ok.events[0]!.data.cost_usd).toBeCloseTo((1000 * 5 + 100 * 30) / 1e6, 10);
  const late = await traced(() => background(null, 0.1).completeJson("s", "u", SCHEMA));
  expect(late.result).toBeInstanceOf(ModelError);
  expect(late.events).toHaveLength(1);
  expect(late.events[0]!.data).toMatchObject({ ok: false, input: 0, cost_usd: 0, attempts: 1, unknown_usage: 1,
    timed_out: true });
});
