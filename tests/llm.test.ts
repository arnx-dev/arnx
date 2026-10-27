import { expect, test } from "bun:test";
import { ModelError } from "../src/errors";
import {
  AnthropicAgent, AnthropicJson, CANCEL_SECONDS, cancelInFlight, costUsd, FallbackJson, makeAgentModel, makeJsonModel,
  makeChallenger, makeSecondHunter, parseJsonObject, PRICES, ResponsesAgent,
  responsesInput, ResponsesJson, unpricedModels, unpricedNote,
} from "../src/llm";
import { exitCodeAfter, finalExitCode, onInterrupt, startInterrupt } from "../src/interrupt";
import { type ProviderTable } from "../src/providers";
import { defaultSettings, parseModelRef } from "../src/settings";
import { PROVIDER_CONCURRENCY } from "../src/provider";

const SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"],
  additionalProperties: false };
const GPT = parseModelRef("openai:gpt-5.5-2026-04-23");
const noSleep = async () => {};
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;
const fakeFetch = (h: Handler) => (async (url: string | URL | Request, init?: RequestInit) =>
  h(String(url), init ?? {})) as typeof fetch;

test("test_cost", () => {
  expect(costUsd("claude-sonnet-5-5", { input: 1_000_000, output: 100_000, cacheRead: 0, cacheWrite: 0 }, PRICES))
    .toBeCloseTo(3.0, 10);
  // No price: the cost is unknown, not an error.
  expect(costUsd("mystery", { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, PRICES)).toBeNull();
});

test("test_parse_json_object", () => {
  expect(parseJsonObject('{"a": 1}')).toEqual({ a: 1 });
  expect(parseJsonObject('```json\n{"a": 1}\n```')).toEqual({ a: 1 });
  expect(parseJsonObject('Here: {"a": {"b": 2}} done')).toEqual({ a: { b: 2 } });
  expect(parseJsonObject("no json")).toBeNull();
  expect(parseJsonObject("[1, 2]")).toBeNull();
});

const responsesBody = (text: string) => ({ status: "completed", model: "gpt-5.5-2026-04-23",
  output: [{ type: "reasoning" }, { type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text }] }],
  usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 0 } } });

function sse(body: unknown, terminal = true): string {
  const events: Record<string, unknown>[] = [{ type: "response.created", response: { status: "in_progress" } },
    { type: "response.output_text.delta", delta: "x" }];
  if (terminal) events.push({ type: "response.completed", response: body });
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

test("test_responses_json_streams", async () => {
  const sent: Record<string, unknown>[] = [];
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch((_u, init) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(sse(responsesBody('{"verdict": "disputed"}')),
        { status: 200, headers: { "content-type": "text/event-stream" } });
    }) });
  expect((await m.completeJson("s", "u", SCHEMA))[0]).toEqual({ verdict: "disputed" });
  expect(sent[0]!.stream).toBe(true);
});

test("test_responses_stream_without_terminal_event_is_an_error", async () => {
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch(() => new Response(sse({}, false), { status: 200 })) });
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(String(err)).toMatch(/terminal/);
  expect(err.unknownCalls).toBe(4); // each truncated attempt was accepted and may be billed
});

test("test_idle_stream_times_out", async () => {
  let calls = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    idleSeconds: 0.05, fetch: fakeFetch((_u, init) => {
      calls += 1;
      const body = new ReadableStream({ start(controller) {
        init.signal?.addEventListener("abort", () => controller.error(new DOMException("aborted", "AbortError")));
      } });
      return new Response(body, { status: 200 });
    }) });
  await expect(m.completeJson("s", "u", SCHEMA)).rejects.toThrow(ModelError);
  expect(calls).toBe(4);
});

test("test_responses_json_retries_then_parses", async () => {
  const calls: Record<string, unknown>[] = [];
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch((_u, init) => {
      calls.push(JSON.parse(String(init.body)));
      if (calls.length === 1) return new Response("busy", { status: 503 });
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer k");
      return new Response(sse(responsesBody('{"verdict": "confirmed"}')), { status: 200 });
    }) });
  const [data, cost] = await m.completeJson("sys", "user", SCHEMA);
  expect(data).toEqual({ verdict: "confirmed" });
  expect(cost).toBeGreaterThan(0);
  expect(calls).toHaveLength(2);
  expect((calls[1]!.text as { format: { schema: unknown } }).format.schema).toEqual(SCHEMA);
  expect(calls[1]!.reasoning).toEqual({ effort: "medium" });
});

test("test_responses_json_gives_up", async () => {
  const m = new ResponsesJson(GPT, "https://api.example/v1", "secret-key", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch(() => new Response("down", { status: 500 })) });
  const err = await m.completeJson("sys", "user", SCHEMA).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ModelError);
  expect(String(err)).not.toContain("secret-key");
});

test("test_responses_json_client_error_is_not_retried", async () => {
  let n = 0;
  const m = new ResponsesJson(GPT, "https://x/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch(() => {
      n += 1;
      return new Response("bad schema", { status: 400 });
    }) });
  await expect(m.completeJson("s", "u", SCHEMA)).rejects.toThrow(/400/);
  expect(n).toBe(1);
});

const message = (text: string) => ({ content: [{ type: "text", text }], stop_reason: "end_turn",
  usage: { input_tokens: 100, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } });

/** A message stream that yields one event and ends, or (message null) stays silent until aborted. */
function fakeStream(msg: ReturnType<typeof message> | null) {
  let abort = () => {};
  return {
    abort: () => abort(),
    async *[Symbol.asyncIterator]() {
      if (msg === null) await new Promise((_resolve, reject) => { abort = () => reject(new Error("Request was aborted.")); });
      yield { type: "message_start" };
    },
    finalMessage: async () => msg,
  };
}

class FakeMessages {
  kwargs: Record<string, unknown>[] = [];
  constructor(readonly texts: (string | null)[]) {}
  stream(kwargs: Record<string, unknown>) {
    this.kwargs.push(kwargs);
    const text = this.texts.shift();
    return fakeStream(text === null || text === undefined ? null : message(text));
  }
}

test("test_anthropic_json_repairs_once", async () => {
  const messages = new FakeMessages(["I think confirmed", '{"verdict": "confirmed"}']);
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", { messages });
  const m = new AnthropicJson(parseModelRef("anthropic:claude-sonnet-5-5"), agent, PRICES);
  const [data, cost] = await m.completeJson("sys", "user", SCHEMA);
  expect(data).toEqual({ verdict: "confirmed" });
  expect(cost).toBeGreaterThan(0);
  expect("tools" in messages.kwargs[0]!).toBe(false);
  expect(messages.kwargs[0]!.output_config).toEqual({ effort: "medium" });
  // thinking summaries stream while the model thinks, so a silent stream really means a dead connection
  expect(messages.kwargs[0]!.thinking).toEqual({ type: "adaptive", display: "summarized" });
});

/** Generic tables, as a user writes them for an endpoint that copies the OpenAI Responses API: one at a fixed URL
 * that takes "high" for arnx's "medium" and refuses stored responses, one whose URL is in the environment. */
const TABLES: Record<string, ProviderTable> = {
  compat: { api: "responses", url: "https://llm.example.com/v1", key_env: "COMPAT_KEY", effort: { medium: "high" },
    store: false },
  compatenv: { api: "responses", url_env: "COMPAT_URL", key_env: "COMPAT_ENV_KEY" },
};
const PRICED = { "some-model": [1, 2, 0.1, 0] as [number, number, number, number] };
const COMPAT_ENV = { COMPAT_KEY: "c", COMPAT_ENV_KEY: "e", COMPAT_URL: "https://env.example/v1" };

test("test_factories", () => {
  const s = { ...defaultSettings(), challenger: parseModelRef("openai:gpt-6.1-sol"), providers: TABLES };
  expect(() => makeAgentModel(s, { OPENAI_API_KEY: "o" })).toThrow(/ANTHROPIC_API_KEY/);
  expect(makeAgentModel(s, { ANTHROPIC_API_KEY: "a" }).model).toBe("claude-sonnet-5-5");
  expect(makeJsonModel(s.challenger, s, { OPENAI_API_KEY: "o" }).ref).toBe("openai:gpt-6.1-sol");
  // A model arnx has no price for runs, its cost unknown; the command says so once.
  const unpriced = parseModelRef("compat:unpriced", TABLES);
  expect(makeJsonModel(unpriced, s, COMPAT_ENV).ref).toBe("compat:unpriced");
  expect(makeAgentModel({ ...s, reviewer: unpriced }, COMPAT_ENV).model).toBe("unpriced");
  expect(unpricedModels(s, [s.reviewer, unpriced, null, unpriced])).toEqual([{ ref: "compat:unpriced", name: "unpriced" }]);
  expect(unpricedModels({ ...s, prices: PRICED }, [parseModelRef("compat:some-model", TABLES)])).toEqual([]);
  // Priced by the name [prices] uses: with the OpenAI tier when one applies.
  expect(unpricedModels({ ...s, openaiTier: "flex" }, [s.challenger]))
    .toEqual([{ ref: "openai:gpt-6.1-sol", name: "gpt-6.1-sol@flex" }]);
  expect(unpricedNote([])).toBeNull();
  expect(unpricedNote([{ name: "unpriced" }])).toBe("No price for unpriced: cost unknown, and the budget cap does not " +
    "cover it ([prices] in .arnx/config.toml)");
  expect(unpricedNote([{ name: "a" }, { name: "b" }])).toBe("No price for a, b: cost unknown, and the budget cap does " +
    "not cover them ([prices] in .arnx/config.toml)");
});

test("a JSON call to a model with no price costs 0 and counts as billed with unknown usage", async () => {
  const messages = new FakeMessages(['{"verdict": "confirmed"}']);
  const agent = new AnthropicAgent("claude-mystery", "medium", "k", { messages });
  const reply = await new AnthropicJson(parseModelRef("anthropic:claude-mystery"), agent, PRICES)
    .completeJson("sys", "user", SCHEMA);
  expect([reply[0], reply[1], reply[3]]).toEqual([{ verdict: "confirmed" }, 0, 1]);
  const m = new ResponsesJson(parseModelRef("openai:gpt-mystery"), "https://api.example/v1", "k", "medium", PRICES,
    { sleep: noSleep, fetch: fakeFetch(() => new Response(sse(responsesBody('{"verdict": "disputed"}')),
      { status: 200, headers: { "content-type": "text/event-stream" } })) });
  const r = await m.completeJson("s", "u", SCHEMA);
  expect([r[0], r[1], r[3]]).toEqual([{ verdict: "disputed" }, 0, 1]);
});

test("anthropic: a stream that goes silent is retried", async () => {
  const messages = new FakeMessages([null, "hello"]);
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", { messages }, { idleSeconds: 0.05, sleep: noSleep });
  const reply = await agent.create({ system: "s", tools: [], messages: [{ role: "user", content: "u" }], maxTokens: 10 });
  expect(reply.content[0]!.text).toBe("hello");
  expect(messages.kwargs).toHaveLength(2);
  // Each attempt is recorded: the first never received an event, the second did.
  expect(reply.attempts!.map((a) => [a.outcome, a.firstEventSecs === null, a.events > 0]))
    .toEqual([["stalled", true, false], ["ok", false, true]]);
});

test("anthropic: a stream with no first event is retried at the first-event limit, not the idle limit", async () => {
  const messages = new FakeMessages([null, "hello"]);
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", { messages },
    { idleSeconds: 30, firstEventSeconds: 0.05, sleep: noSleep });
  const t0 = performance.now();
  const reply = await agent.create({ system: "s", tools: [], messages: [{ role: "user", content: "u" }], maxTokens: 10 });
  expect(performance.now() - t0).toBeLessThan(5000);
  expect(reply.attempts!.map((a) => a.outcome)).toEqual(["stalled", "ok"]);
});

test("anthropic: once the stream has started, a pause longer than the first-event limit is not cut off", async () => {
  let calls = 0;
  const client = { messages: { stream: () => {
    calls++;
    return { abort: () => {}, finalMessage: async () => message("done"),
      async *[Symbol.asyncIterator]() {
        yield { type: "message_start" };
        await new Promise((r) => setTimeout(r, 150)); // thinking, past the first-event limit
        yield { type: "message_delta" };
      } };
  } } };
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", client, { idleSeconds: 5, firstEventSeconds: 0.05 });
  const reply = await agent.create({ system: "s", tools: [], messages: [{ role: "user", content: "u" }], maxTokens: 10 });
  expect([calls, reply.attempts!.map((a) => a.outcome)]).toEqual([1, ["ok"]]);
});

test("anthropic: silent on every attempt is a ModelError", async () => {
  const messages = new FakeMessages([null, null, null]);
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", { messages }, { idleSeconds: 0.05, sleep: noSleep });
  const err = await agent.create({ system: "s", tools: [], messages: [], maxTokens: 10 }).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(ModelError);
  expect(String(err)).toContain("no reply");
  expect(messages.kwargs).toHaveLength(3);
});

// Cost accounting: a reply the provider produced is billed even when arnx cannot use it.
test("an incomplete reply is still billed: the error carries its cost and usage", async () => {
  const body = { ...responsesBody('{"verdict": "con'), status: "incomplete" };
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch(() => new Response(sse(body), { status: 200 })) });
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.costUsd).toBeCloseTo((1000 * 5 + 100 * 30) / 1e6, 10);
  expect(err.usage).toEqual({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
});

test("an unreadable completed reply is still billed", async () => {
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch(() => new Response(sse(responsesBody("not json")), { status: 200 })) });
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.costUsd).toBeGreaterThan(0);
});

test("a stream cut after the request was accepted counts as a call with unknown usage", async () => {
  let n = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch(() => {
      n += 1;
      if (n > 1) return new Response(sse(responsesBody('{"verdict": "confirmed"}')), { status: 200 });
      const body = new ReadableStream({ start(c) {
        c.enqueue(new TextEncoder().encode('data: {"type":"response.created"}\n'));
        c.error(new Error("socket hang up"));
      } });
      return new Response(body, { status: 200 });
    }) });
  const [data, cost, usage, unknown] = await m.completeJson("s", "u", SCHEMA);
  expect(data).toEqual({ verdict: "confirmed" });
  expect(cost).toBeGreaterThan(0);
  expect(usage).toEqual({ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
  expect(unknown).toBe(1);
});

test("the JSON reply carries the token usage it was priced from", async () => {
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch(() => new Response(sse({ ...responsesBody('{"verdict": "confirmed"}'),
      usage: { input_tokens: 1000, output_tokens: 100, input_tokens_details: { cached_tokens: 400 } } }),
    { status: 200 })) });
  const [, cost, usage, unknown] = await m.completeJson("s", "u", SCHEMA);
  expect(usage).toEqual({ input: 600, output: 100, cacheRead: 400, cacheWrite: 0 });
  expect(cost).toBeCloseTo((600 * 5 + 100 * 30 + 400 * 0.5) / 1e6, 10);
  expect(unknown).toBe(0);
});

test("an Anthropic JSON call that never yields JSON is still billed for both attempts", async () => {
  const messages = new FakeMessages(["no", "still no"]);
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", { messages });
  const m = new AnthropicJson(parseModelRef("anthropic:claude-sonnet-5-5"), agent, PRICES);
  const err = await m.completeJson("sys", "user", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.costUsd).toBeCloseTo(2 * (100 * 2 + 10 * 10) / 1e6, 10);
  expect(err.usage).toEqual({ input: 200, output: 20, cacheRead: 0, cacheWrite: 0 });
});

// A review must not wait on the second model without limit: each call has a total deadline across its attempts.
test("a reply that trickles forever hits the call's total deadline", async () => {
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    idleSeconds: 10, totalSeconds: 0.3, fetch: fakeFetch((_u, init) => {
      const body = new ReadableStream({ start(c) {
        const tick = setInterval(() => c.enqueue(new TextEncoder().encode(": keepalive\n")), 20);
        init.signal?.addEventListener("abort", () => { clearInterval(tick); c.error(new DOMException("aborted", "AbortError")); });
      } });
      return new Response(body, { status: 200 });
    }) });
  const started = performance.now();
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.timedOut).toBe(true);
  expect(String(err)).toContain("no reply within");
  expect(performance.now() - started).toBeLessThan(2000);
});

test("every attempt is traced with its outcome and duration", async () => {
  const lines: Record<string, unknown>[] = [];
  let n = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch(() => (++n === 1 ? new Response("busy", { status: 503 })
      : new Response(sse(responsesBody('{"verdict": "confirmed"}')), { status: 200 }))) });
  m.trace = (l) => lines.push(l);
  await m.completeJson("s", "u", SCHEMA);
  expect(lines.map((l) => [l.attempt, l.outcome])).toEqual([[1, "HTTP 503: busy"], [2, "ok"]]);
  expect(typeof lines[0]!.secs).toBe("number");
});

test("anthropic: a stream that only sends pings hits the request's total deadline", async () => {
  let aborted = 0;
  const pinging = {
    abort: () => { aborted += 1; },
    async *[Symbol.asyncIterator]() {
      while (!aborted) {
        await new Promise((r) => setTimeout(r, 10));
        if (aborted) throw new Error("Request was aborted.");
        yield { type: "ping" };
      }
      throw new Error("Request was aborted.");
    },
    finalMessage: async () => null,
  };
  const client = { messages: { stream: () => pinging } };
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", client, { idleSeconds: 10, totalSeconds: 0.2 });
  const started = performance.now();
  const err = await agent.create({ system: "s", tools: [], messages: [], maxTokens: 10 }).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.timedOut).toBe(true);
  expect(String(err)).toContain("no reply within");
  expect(performance.now() - started).toBeLessThan(2000);
});

test("a hung attempt is abandoned after the attempt limit and sent again within the total", async () => {
  let n = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    attemptSeconds: 0.05, totalSeconds: 5,
    fetch: (async (_u: unknown, init?: RequestInit) => {
      if (++n === 1) {
        return await new Promise<Response>((_res, rej) =>
          init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }
      return new Response(sse(responsesBody('{"verdict": "confirmed"}')), { status: 200 });
    }) as typeof fetch });
  expect((await m.completeJson("s", "u", SCHEMA))[0]).toEqual({ verdict: "confirmed" });
  expect(n).toBe(2);
});

test("the fast tier is requested as priority processing and priced as <model>@fast", async () => {
  const sent: Record<string, unknown>[] = [];
  const m = new ResponsesJson({ provider: "openai", model: "gpt-6.1-sol" }, "https://api.example/v1", "k", "medium",
    PRICES, { sleep: noSleep, tier: "fast", fetch: fakeFetch((_u, init) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(sse(responsesBody('{"verdict": "confirmed"}')), { status: 200 });
    }) });
  const [, cost] = await m.completeJson("s", "u", SCHEMA);
  expect(sent[0]!.service_tier).toBe("priority");
  expect(cost).toBeCloseTo((1000 * 4 + 100 * 20) / 1e6, 9);
});

test("a stalled attempt is reported before it is retried", async () => {
  let n = 0;
  const notes: string[] = [];
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    attemptSeconds: 0.05, totalSeconds: 5,
    fetch: (async (_u: unknown, init?: RequestInit) => {
      if (++n === 1) {
        return await new Promise<Response>((_res, rej) =>
          init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
      }
      return new Response(sse(responsesBody('{"verdict": "confirmed"}')), { status: 200 });
    }) as typeof fetch });
  m.notice = (x) => notes.push(x);
  await m.completeJson("s", "u", SCHEMA);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toMatch(/^openai:gpt-5\.5[^:]*: attempt timeout after 0.05s; retrying \(attempt 2\) in 2s$/);
});

// The reviewer over the Responses API: tools as functions, arnx's history translated each turn.
const callBody = { status: "completed", model: "gpt-5.5-2026-04-23",
  output: [{ type: "reasoning", id: "rs_1" }, { type: "function_call", id: "fc_1", call_id: "call_1", name: "read_file",
    arguments: '{"path": "pkg/calc.py"}' }],
  usage: { input_tokens: 1000, output_tokens: 50, input_tokens_details: { cached_tokens: 400 } } };

function agentOver(bodies: unknown[], sent: Record<string, unknown>[], store?: boolean) {
  const transport = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch((_u, init) => {
      sent.push(JSON.parse(String(init.body)));
      return new Response(sse(bodies.shift()), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) });
  return new ResponsesAgent(transport, "medium", store === undefined ? {} : { store });
}

test("responses agent: a function call is a tool_use, and the request offers arnx's tools as functions", async () => {
  const sent: Record<string, unknown>[] = [];
  const agent = agentOver([callBody], sent);
  const tool = { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: {} } };
  const reply = await agent.create({ system: "sys", tools: [tool], messages: [{ role: "user", content: "go" }],
    maxTokens: 900 });
  expect(reply.stopReason).toBe("tool_use");
  expect(reply.content).toEqual([{ type: "tool_use", id: "call_1", name: "read_file", input: { path: "pkg/calc.py" } }]);
  expect(reply.usage).toEqual({ input: 600, output: 50, cacheRead: 400, cacheWrite: 0 });
  expect(sent[0]).toMatchObject({ instructions: "sys", max_output_tokens: 900, input: [{ role: "user", content: "go" }],
    tools: [{ type: "function", name: "read_file", description: "Read a file", parameters: tool.input_schema }] });
  expect("store" in sent[0]!).toBe(false);
  expect(agent.model).toBe("gpt-5.5-2026-04-23"); // the price key
});

test("responses agent: the history goes back as output items and function_call_output items", () => {
  const input = responsesInput([{ role: "user", content: "go" }, { role: "assistant", content: callBody.output },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call_1", content: "def add" },
      { type: "tool_result", tool_use_id: "call_2", is_error: true, content: "Error: no such file" }] },
    { role: "user", content: "Your reply was cut off. Continue." }]);
  expect(input).toEqual([{ role: "user", content: "go" }, ...callBody.output,
    { type: "function_call_output", call_id: "call_1", output: "def add" },
    { type: "function_call_output", call_id: "call_2", output: "error: Error: no such file" },
    { role: "user", content: "Your reply was cut off. Continue." }]);
});

test("responses agent: a cut-off reply is max_tokens, and without storage reasoning comes back encrypted", async () => {
  const sent: Record<string, unknown>[] = [];
  const cut = { ...responsesBody("partial"), status: "incomplete", incomplete_details: { reason: "max_output_tokens" } };
  const reply = await agentOver([cut], sent, false).create({ system: "s", tools: [], messages: [], maxTokens: 10 });
  expect([reply.stopReason, reply.content]).toEqual(["max_tokens", [{ type: "text", text: "partial" }]]);
  expect(sent[0]).toMatchObject({ store: false, include: ["reasoning.encrypted_content"] });
  expect("tools" in sent[0]!).toBe(false);
});

test("the reviewer may be any provider, priced or not", () => {
  const as = (ref: string) => ({ ...defaultSettings(), providers: TABLES, prices: PRICED,
    reviewer: parseModelRef(ref, TABLES) });
  expect(makeAgentModel(as("openai:gpt-5.5-2026-04-23"), { OPENAI_API_KEY: "o" })).toBeInstanceOf(ResponsesAgent);
  expect(makeAgentModel(as("compat:some-model"), COMPAT_ENV).model).toBe("some-model");
  expect(() => makeAgentModel(as("openai:gpt-5.5-2026-04-23"), {})).toThrow(/OPENAI_API_KEY/);
  expect(makeAgentModel(as("compatenv:unpriced"), COMPAT_ENV).model).toBe("unpriced");
});

// Provider backoff headers: the wait is never shorter than the local backoff (DELAYS[0] = 2s for the first retry).
async function retryWaits(status: number, headers: Record<string, string>): Promise<number[]> {
  const waits: number[] = [];
  let n = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, {
    sleep: async (s) => { waits.push(s); },
    fetch: fakeFetch(() => (++n === 1 ? new Response("busy", { status, headers })
      : new Response(sse(responsesBody('{"verdict": "confirmed"}')), { status: 200 }))) });
  await m.completeJson("s", "u", SCHEMA);
  return waits;
}

test("responses: retry-after (seconds) and retry-after-ms wait max(local backoff, header)", async () => {
  expect(await retryWaits(429, { "retry-after": "5" })).toEqual([5]);
  expect(await retryWaits(503, { "retry-after": "1" })).toEqual([2]);
  expect(await retryWaits(503, { "retry-after-ms": "7000" })).toEqual([7]);
  expect(await retryWaits(429, { "retry-after-ms": "500" })).toEqual([2]);
});

test("responses: a malformed retry-after falls back to the local backoff", async () => {
  expect(await retryWaits(429, { "retry-after": "soon" })).toEqual([2]);
  expect(await retryWaits(429, { "retry-after": "-3" })).toEqual([2]);
  expect(await retryWaits(503, { "retry-after-ms": "abc", "retry-after": "oops" })).toEqual([2]);
});

test("responses: a 400 with retry-after is not retried or slept on", async () => {
  const waits: number[] = [];
  let n = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, {
    sleep: async (s) => { waits.push(s); },
    fetch: fakeFetch(() => { n++; return new Response("bad", { status: 400, headers: { "retry-after": "5" } }); }) });
  await expect(m.completeJson("s", "u", SCHEMA)).rejects.toThrow(/400/);
  expect([n, waits]).toEqual([1, []]);
});

test("responses: a backoff that would pass the total deadline is a timed-out ModelError", async () => {
  const waits: number[] = [];
  let n = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { totalSeconds: 1,
    sleep: async (s) => { waits.push(s); },
    fetch: fakeFetch(() => { n++; return new Response("busy", { status: 429, headers: { "retry-after": "100" } }); }) });
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.timedOut).toBe(true);
  expect(String(err)).toContain("retry would exceed deadline");
  expect([n, waits]).toEqual([1, []]);
});

// AnthropicAgent over a fake transport: the real SDK client parses these bytes.
const enc = new TextEncoder();
const sseEvent = (type: string, data: Record<string, unknown>) =>
  `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
const anthropicEvents = (text: string) => [
  sseEvent("message_start", { message: { id: "m1", type: "message", role: "assistant", model: "claude-sonnet-5-5",
    content: [], stop_reason: null, stop_sequence: null,
    usage: { input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }),
  sseEvent("content_block_start", { index: 0, content_block: { type: "text", text: "" } }),
  sseEvent("content_block_delta", { index: 0, delta: { type: "text_delta", text } }),
  sseEvent("content_block_stop", { index: 0 }),
  sseEvent("message_delta", { delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 10 } }),
  sseEvent("message_stop", {}),
];
const sseResponse = (parts: string[]) => new Response(parts.join(""),
  { status: 200, headers: { "content-type": "text/event-stream" } });
const errorResponse = (status: number, type: string) => new Response(
  JSON.stringify({ type: "error", error: { type, message: type } }),
  { status, headers: { "content-type": "application/json" } });
/** A 200 stream that sends nothing and errors when the request is aborted. */
const stalledResponse = (init: RequestInit) => new Response(new ReadableStream({ start(c) {
  init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
} }), { status: 200, headers: { "content-type": "text/event-stream" } });
const ask = (agent: AnthropicAgent) => agent.create({ system: "s", tools: [], messages: [{ role: "user", content: "u" }],
  maxTokens: 10 });

test("anthropic: SSE pings alone keep the idle timer from firing", async () => {
  let calls = 0;
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, { idleSeconds: 0.15, sleep: noSleep,
    fetch: fakeFetch(() => {
      calls++;
      const parts = anthropicEvents("hello");
      return new Response(new ReadableStream({ async start(c) {
        c.enqueue(enc.encode(parts[0]!));
        // Ten pings, 40 ms apart: 400 ms in all, far past the 150 ms idle limit, but never 150 ms of silence.
        for (let i = 0; i < 10; i++) {
          await new Promise((r) => setTimeout(r, 40));
          c.enqueue(enc.encode(sseEvent("ping", {})));
        }
        for (const p of parts.slice(1)) c.enqueue(enc.encode(p));
        c.close();
      } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) });
  const reply = await ask(agent);
  expect(reply.content[0]!.text).toBe("hello");
  expect(calls).toBe(1);
  expect(reply.attempts!.map((a) => a.outcome)).toEqual(["ok"]);
  expect(reply.attempts![0]!.chunks!).toBeGreaterThanOrEqual(10);
});

test("anthropic: HTTP 529 overloaded_error is retried after the local backoff, then succeeds", async () => {
  const waits: number[] = [];
  const notes: string[] = [];
  let n = 0;
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, {
    sleep: async (s) => { waits.push(s); },
    fetch: fakeFetch(() => (++n === 1 ? errorResponse(529, "overloaded_error") : sseResponse(anthropicEvents("hi")))) });
  agent.notice = (x) => notes.push(x);
  const reply = await ask(agent);
  expect(reply.content[0]!.text).toBe("hi");
  expect([n, waits]).toEqual([2, [2]]);
  expect(notes).toHaveLength(1);
  expect(notes[0]).toContain("HTTP 529");
  expect(reply.attempts!.map((a) => a.outcome)).toEqual(["error", "ok"]);
  expect(reply.attempts![0]!.error).toContain("HTTP 529");
});

test("anthropic: a retry-after header longer than the local backoff is honored", async () => {
  const waits: number[] = [];
  let n = 0;
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, {
    sleep: async (s) => { waits.push(s); },
    fetch: fakeFetch(() => {
      if (++n > 1) return sseResponse(anthropicEvents("hi"));
      return new Response(JSON.stringify({ type: "error", error: { type: "rate_limit_error", message: "slow down" } }),
        { status: 429, headers: { "content-type": "application/json", "retry-after": "9" } });
    }) });
  await ask(agent);
  expect(waits).toEqual([9]);
});

test("anthropic: an HTTP 400 is not retried, and the ModelError carries the attempt", async () => {
  const waits: number[] = [];
  let n = 0;
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, {
    sleep: async (s) => { waits.push(s); },
    fetch: fakeFetch(() => { n++; return errorResponse(400, "invalid_request_error"); }) });
  const err = await ask(agent).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(String(err)).toContain("HTTP 400");
  expect(err.timedOut).toBe(false);
  expect([n, waits]).toEqual([1, []]);
  expect(err.attempts).toHaveLength(1);
  expect(err.attempts![0]!.outcome).toBe("error");
  expect(err.attempts![0]!.error).toContain("HTTP 400");
});

test("anthropic: a stalled attempt records its timeout kind, and a failed call's ModelError carries all attempts", async () => {
  let n = 0;
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, { firstEventSeconds: 0.05,
    idleSeconds: 0.05, sleep: noSleep, fetch: fakeFetch((_u, init) => (++n === 1 ? stalledResponse(init)
      : sseResponse(anthropicEvents("hi")))) });
  const reply = await ask(agent);
  expect(reply.attempts!.map((a) => [a.outcome, a.timeout])).toEqual([["stalled", "first-byte"], ["ok", undefined]]);
  expect(reply.attempts![0]!.error).toContain("first-byte timeout");

  const dead = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, { firstEventSeconds: 0.05,
    idleSeconds: 0.05, sleep: noSleep, fetch: fakeFetch((_u, init) => stalledResponse(init)) });
  const err = await ask(dead).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.timedOut).toBe(true);
  expect(err.attempts!.map((a) => a.timeout)).toEqual(["first-byte", "first-byte", "first-byte"]);
});

test("anthropic json: a ModelError after an earlier billed turn keeps timedOut and gains that turn's cost", async () => {
  const usage = { input: 100, output: 10, cacheRead: 0, cacheWrite: 0 };
  let n = 0;
  const agent = { model: "claude-sonnet-5-5", create: async () => {
    if (++n === 1) return { content: [{ type: "text", text: "no json" }], stopReason: "end_turn", usage, raw: [] };
    const e = new ModelError("claude-sonnet-5-5: no reply within 600s (total timeout)");
    e.timedOut = true;
    throw e;
  } };
  const m = new AnthropicJson(parseModelRef("anthropic:claude-sonnet-5-5"), agent, PRICES);
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.timedOut).toBe(true);
  expect(err.costUsd).toBeCloseTo((100 * 2 + 10 * 10) / 1e6, 10);
  expect(err.usage).toEqual(usage);
});

/** message_start, then a ping every 10 ms until the request is aborted (a stalled generation that keeps pinging). */
const pingingResponse = (init: RequestInit) => {
  let timer: ReturnType<typeof setInterval>;
  return new Response(new ReadableStream({ start(c) {
    c.enqueue(enc.encode(anthropicEvents("x")[0]!));
    timer = setInterval(() => { try { c.enqueue(enc.encode(sseEvent("ping", {}))); } catch { clearInterval(timer); } }, 10);
    init.signal?.addEventListener("abort", () => { clearInterval(timer); c.error(new DOMException("aborted", "AbortError")); });
  }, cancel() { clearInterval(timer); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
};

test("anthropic: a ping-only stream is cut at the attempt limit and sent again", async () => {
  let n = 0;
  const notes: string[] = [];
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, { idleSeconds: 0.15,
    attemptSeconds: 0.3, totalSeconds: 3, sleep: noSleep,
    fetch: fakeFetch((_u, init) => (++n === 1 ? pingingResponse(init) : sseResponse(anthropicEvents("hi")))) });
  agent.notice = (x) => notes.push(x);
  const reply = await ask(agent);
  expect(reply.content[0]!.text).toBe("hi");
  expect(n).toBe(2);
  expect(reply.attempts!.map((a) => [a.outcome, a.timeout])).toEqual([["stalled", "attempt"], ["ok", undefined]]);
  expect(reply.attempts![0]!.error).toContain("attempt timeout after 0.3s");
  expect(notes[0]).toContain("retrying");
  // The cut attempt had started streaming: it may be billed, with unknown usage.
  expect(reply.unknownCalls).toBe(1);
});

test("anthropic: the attempt limit never outlasts the total; the last attempt is a total timeout", async () => {
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, { idleSeconds: 0.15,
    attemptSeconds: 5, totalSeconds: 0.3, sleep: noSleep, fetch: fakeFetch((_u, init) => pingingResponse(init)) });
  const err = await ask(agent).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.timedOut).toBe(true);
  expect(String(err)).toContain("no reply within");
  expect(err.attempts!.map((a) => a.timeout)).toEqual(["total"]);
});

test("anthropic: a connection reset after message_start is retried", async () => {
  let n = 0;
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, { sleep: noSleep,
    fetch: fakeFetch(() => {
      if (++n > 1) return sseResponse(anthropicEvents("hi"));
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(enc.encode(anthropicEvents("x")[0]!));
        setTimeout(() => c.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })), 5);
      } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) });
  const reply = await ask(agent);
  expect(reply.content[0]!.text).toBe("hi");
  expect(n).toBe(2);
  expect(reply.attempts!.map((a) => [a.outcome, a.error])).toEqual([["error", "socket hang up"], ["ok", undefined]]);
  expect(reply.unknownCalls).toBe(1);
});

test("anthropic: a stream that closes before message_stop is retried", async () => {
  let n = 0;
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, { sleep: noSleep,
    fetch: fakeFetch(() => sseResponse(++n === 1 ? anthropicEvents("x").slice(0, 1) : anthropicEvents("hi"))) });
  const reply = await ask(agent);
  expect(reply.content[0]!.text).toBe("hi");
  expect(n).toBe(2);
  expect(reply.attempts![0]!.error).toContain("stream ended");
});

test("anthropic: a cut-off attempt on a failed call is counted as unknown usage", async () => {
  const json = new AnthropicJson(parseModelRef("anthropic:claude-sonnet-5-5"), new AnthropicAgent("claude-sonnet-5-5",
    "medium", "k", undefined, { sleep: noSleep, fetch: fakeFetch(() => sseResponse(anthropicEvents("x").slice(0, 1))) }),
  PRICES);
  const err = await json.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.unknownCalls).toBe(3);
  const ok = new AnthropicJson(parseModelRef("anthropic:claude-sonnet-5-5"), new AnthropicAgent("claude-sonnet-5-5",
    "medium", "k", undefined, { sleep: noSleep, fetch: fakeFetch((() => { let n = 0; return () =>
      sseResponse(++n === 1 ? anthropicEvents("x").slice(0, 1) : anthropicEvents('{"verdict": "confirmed"}')); })()) }),
  PRICES);
  const [, , , unknown] = await ok.completeJson("s", "u", SCHEMA);
  expect(unknown).toBe(1);
});

test("anthropic: a network failure before the response is retried", async () => {
  let n = 0;
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, { sleep: noSleep,
    fetch: fakeFetch(() => { if (++n === 1) throw new TypeError("fetch failed"); return sseResponse(anthropicEvents("hi")); }) });
  const reply = await ask(agent);
  expect(reply.content[0]!.text).toBe("hi");
  expect([n, reply.unknownCalls ?? 0]).toEqual([2, 0]);
});

test("anthropic: an error that is not from the SDK, the transport or a timeout is rethrown as is, not retried", async () => {
  let calls = 0;
  const bug = new TypeError("cannot read properties of undefined");
  const client = { messages: { stream: () => {
    calls++;
    return { abort: () => {}, finalMessage: async () => null,
      async *[Symbol.asyncIterator]() { yield { type: "message_start" }; throw bug; } };
  } } };
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", client, { sleep: noSleep });
  const err = await ask(agent).catch((e: unknown) => e);
  expect(err).toBe(bug);
  expect(calls).toBe(1);
});

test("anthropic: Sonnet and Haiku calls do not share one provider slot pool", async () => {
  let release = () => {};
  const held = new Promise<void>((r) => { release = r; });
  const blocked = Array.from({ length: PROVIDER_CONCURRENCY }, () => ask(new AnthropicAgent("claude-haiku-5-5", "medium",
    "k", undefined, { fetch: fakeFetch(async () => { await held; return sseResponse(anthropicEvents("h")); }) })));
  const sonnet = ask(new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined,
    { fetch: fakeFetch(() => sseResponse(anthropicEvents("s"))) }));
  const first = await Promise.race([sonnet.then(() => "sonnet"), new Promise((r) => setTimeout(() => r("blocked"), 500))]);
  release();
  await Promise.all([sonnet, ...blocked]);
  expect(first).toBe("sonnet");
});

test("anthropic: a chunk that arrives after the call settled arms no idle timer", async () => {
  // A transport that keeps sending after the SDK gave up on a malformed event (it ignores cancel).
  let n = 0, timer: ReturnType<typeof setInterval> | undefined;
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, { idleSeconds: 0.777, sleep: noSleep,
    fetch: fakeFetch(() => {
      if (++n > 1) return sseResponse(anthropicEvents("hi"));
      return new Response(new ReadableStream({ start(c) {
        c.enqueue(enc.encode(anthropicEvents("x")[0]! + "event: content_block_start\ndata: {not json\n\n"));
        timer = setInterval(() => { try { c.enqueue(enc.encode(sseEvent("ping", {}))); } catch { /* closed */ } }, 10);
      } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) });
  const real = globalThis.setTimeout;
  let late = 0, settled = false;
  globalThis.setTimeout = ((fn: () => void, ms?: number, ...rest: unknown[]) => {
    if (settled && ms === 777) late++;
    return real(fn, ms, ...rest);
  }) as typeof setTimeout;
  try {
    await ask(agent);
    settled = true;
    await new Promise((r) => real(r, 150));
  } finally {
    globalThis.setTimeout = real;
    clearInterval(timer);
  }
  expect(n).toBe(2);
  expect(late).toBe(0);
});

// OpenAI background mode: the response is created, then polled until it is terminal (no long-lived stream).
const RID = "resp_1";
const queued = { id: RID, status: "queued" };
/** A background client whose create answers `queued` and whose polls answer `polls` in turn, the last one repeated
 * (a number is an HTTP status). Each request is logged as "METHOD path"; create bodies go to `sent`. */
function backgroundOver(polls: (Record<string, unknown> | number)[], log: string[],
                        sent: Record<string, unknown>[] = [],
                        opts: { totalSeconds?: number; sleep?: (s: number) => Promise<void> } = {}) {
  return new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep, background: true,
    ...opts, fetch: fakeFetch((url, init) => {
      const path = url.replace("https://api.example/v1", "");
      log.push(`${init.method ?? "GET"} ${path}`);
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer k");
      if (path === "/responses") {
        sent.push(JSON.parse(String(init.body)));
        return Response.json(queued);
      }
      if (path.endsWith("/cancel")) return Response.json({ id: RID, status: "cancelled" });
      const next = polls.length > 1 ? polls.shift()! : polls[0]!;
      return typeof next === "number" ? new Response("oops", { status: next }) : Response.json({ id: RID, ...next });
    }) });
}
const GET = `GET /responses/${RID}`;

test("background: created queued, polled in_progress twice, then completed: parsed and priced once", async () => {
  const log: string[] = [], sent: Record<string, unknown>[] = [], lines: Record<string, unknown>[] = [];
  const waits: number[] = [];
  const m = backgroundOver([{ status: "in_progress" }, { status: "in_progress" },
    responsesBody('{"verdict": "confirmed"}')], log, sent, { sleep: async (s) => { waits.push(s); } });
  m.trace = (l) => lines.push(l);
  const [data, cost, usage, unknown] = await m.completeJson("s", "u", SCHEMA);
  expect(data).toEqual({ verdict: "confirmed" });
  expect(cost).toBeCloseTo((1000 * 5 + 100 * 30) / 1e6, 10);
  expect([usage, unknown]).toEqual([{ input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 }, 0]);
  expect(log).toEqual(["POST /responses", GET, GET, GET]);
  expect(waits).toEqual([3, 3, 3]);
  // background mode needs a stored response: no stream, no store: false
  expect(sent[0]).toMatchObject({ background: true, model: "gpt-5.5-2026-04-23", reasoning: { effort: "medium" } });
  expect("stream" in sent[0]! || "store" in sent[0]!).toBe(false);
  // one line per status change, then the attempt's outcome
  expect(lines.map((l) => [l.attempt, l.phase, l.state ?? l.outcome])).toEqual([[1, "create", "queued"],
    [1, "poll", "in_progress"], [1, "poll", "completed"], [1, undefined, "ok"]]);
  expect(lines[3]).toMatchObject({ transport: "background", id: RID, polls: 3 });
  // second-opinion.jsonl tells poll lines from attempt outcomes by `step`
  expect(lines.map((l) => l.step)).toEqual(["poll", "poll", "poll", undefined]);
});

test("background: no terminal status before the total deadline cancels it: timed out, one unknown call", async () => {
  const log: string[] = [], lines: Record<string, unknown>[] = [];
  const m = backgroundOver([{ status: "in_progress" }], log, [], { totalSeconds: 0.2,
    sleep: (s) => new Promise((r) => setTimeout(r, Math.min(s, 0.01) * 1000)) });
  m.trace = (l) => lines.push(l);
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.timedOut).toBe(true);
  expect(err.message).toBe("openai:gpt-5.5-2026-04-23: no reply within 0.2s (total timeout after 0.2s)");
  expect([err.unknownCalls, err.tries, err.costUsd]).toEqual([1, 1, 0]);
  expect(log.filter((l) => l.startsWith("POST"))).toEqual(["POST /responses", `POST /responses/${RID}/cancel`]);
  expect(log.at(-1)).toBe(`POST /responses/${RID}/cancel`);
  expect(lines.filter((l) => l.phase === "poll")).toHaveLength(1); // in_progress, traced once however many ticks
  expect(lines.find((l) => l.phase === "cancel")).toMatchObject({ http: 200 });
});

test("background: a failed cancel is ignored and the call still times out", async () => {
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { background: true,
    totalSeconds: 0.1, sleep: (s) => new Promise((r) => setTimeout(r, Math.min(s, 0.01) * 1000)),
    fetch: fakeFetch((url) => {
      if (url.endsWith("/cancel")) throw new TypeError("fetch failed");
      return url.endsWith("/responses") ? Response.json(queued) : Response.json({ id: RID, status: "in_progress" });
    }) });
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect([err instanceof ModelError, err.timedOut, err.unknownCalls]).toEqual([true, true, 1]);
});

test("background: a poll that fails (500, network) is tried again at the next tick, not created again", async () => {
  const log: string[] = [];
  const m = backgroundOver([500, { status: "in_progress" }, responsesBody('{"verdict": "ok"}')], log);
  expect((await m.completeJson("s", "u", SCHEMA))[0]).toEqual({ verdict: "ok" });
  expect(log).toEqual(["POST /responses", GET, GET, GET]);
  let n = 0;
  const flaky = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    background: true, fetch: fakeFetch((url) => {
      if (url.endsWith("/responses")) return Response.json(queued);
      if (++n === 1) throw new TypeError("fetch failed");
      return Response.json({ id: RID, ...responsesBody('{"verdict": "ok"}') });
    }) });
  const [, , , unknown] = await flaky.completeJson("s", "u", SCHEMA);
  expect([n, unknown]).toEqual([2, 0]);
});

test("background: a poll status no retry can fix fails the call, cancels it, and counts it as unknown", async () => {
  const log: string[] = [];
  const err = await backgroundOver([401], log).completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.message).toContain("poll: HTTP 401");
  expect([err.unknownCalls, err.timedOut]).toEqual([1, false]);
  expect(log).toEqual(["POST /responses", GET, `POST /responses/${RID}/cancel`]);
});

test("background: failed and incomplete give the streamed path's errors, billed from their usage", async () => {
  for (const status of ["failed", "incomplete"]) {
    const body = { ...responsesBody('{"verdict": "con'), status };
    const streamed = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
      fetch: fakeFetch(() => new Response(sse(body), { status: 200 })) });
    const want = await streamed.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
    const got = await backgroundOver([body], []).completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
    expect(got).toBeInstanceOf(ModelError);
    expect([got.message, got.costUsd, got.usage, got.unknownCalls])
      .toEqual([want.message, want.costUsd, want.usage, want.unknownCalls]);
  }
});

test("background: a response cancelled elsewhere is a ModelError, one unknown call, not cancelled again", async () => {
  const log: string[] = [];
  const err = await backgroundOver([{ status: "cancelled" }], log).completeJson("s", "u", SCHEMA)
    .catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect(err.message).toContain("cancelled");
  expect(err.unknownCalls).toBe(1);
  expect(log).toEqual(["POST /responses", GET]);
});

test("background: the create keeps today's retry rules (a 503 is sent again; a 400 is not)", async () => {
  const log: string[] = [];
  let n = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    background: true, fetch: fakeFetch((url, init) => {
      log.push(`${init.method ?? "GET"} ${url.replace("https://api.example/v1", "")}`);
      if (url.endsWith("/responses")) return ++n === 1 ? new Response("busy", { status: 503 }) : Response.json(queued);
      return Response.json({ id: RID, ...responsesBody('{"verdict": "ok"}') });
    }) });
  const [, , , unknown] = await m.completeJson("s", "u", SCHEMA);
  expect([log, unknown]).toEqual([["POST /responses", "POST /responses", GET], 0]);
  const bad = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    background: true, fetch: fakeFetch(() => new Response("bad schema", { status: 400 })) });
  await expect(bad.completeJson("s", "u", SCHEMA)).rejects.toThrow(/HTTP 400/);
});

test("background: a create answered already completed needs no poll", async () => {
  const log: string[] = [];
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    background: true, fetch: fakeFetch((url) => {
      log.push(url);
      return Response.json({ id: RID, ...responsesBody('{"verdict": "ok"}') });
    }) });
  expect((await m.completeJson("s", "u", SCHEMA))[0]).toEqual({ verdict: "ok" });
  expect(log).toHaveLength(1);
});

test("background: the reviewer's agent turns are created and polled the same way", async () => {
  const log: string[] = [], sent: Record<string, unknown>[] = [];
  const agent = new ResponsesAgent(backgroundOver([{ status: "in_progress" }, callBody], log, sent), "medium");
  const tool = { name: "read_file", description: "Read a file", input_schema: { type: "object", properties: {} } };
  const reply = await agent.create({ system: "sys", tools: [tool], messages: [{ role: "user", content: "go" }],
    maxTokens: 900 });
  expect(reply.stopReason).toBe("tool_use");
  expect([reply.tries, reply.unknownCalls]).toEqual([1, undefined]);
  expect(sent[0]).toMatchObject({ background: true, instructions: "sys", max_output_tokens: 900 });
  expect("stream" in sent[0]!).toBe(false);
  expect(log).toEqual(["POST /responses", GET, GET]);
});

/** Runs `fn` with the global fetch answering every request, and returns each request body. */
async function bodiesSent(fn: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
  const sent: Record<string, unknown>[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = fakeFetch((url, init) => {
    const body = init.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (init.method === "POST") sent.push(body);
    const reply = responsesBody('{"verdict": "ok"}');
    if (body.stream) return new Response(sse(reply), { status: 200 });
    return Response.json({ id: RID, ...reply });
  });
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return sent;
}

test("openai_transport: OpenAI clients run in background by default and stream when it is \"stream\"", async () => {
  const s = { ...defaultSettings(), challenger: GPT, reviewer: GPT };
  const env = { OPENAI_API_KEY: "o" };
  const json = (t: typeof s) => bodiesSent(() => makeJsonModel(GPT, t, env).completeJson("s", "u", SCHEMA));
  const turn = (t: typeof s) => bodiesSent(() => makeAgentModel(t, env).create({ system: "s", tools: [],
    messages: [{ role: "user", content: "u" }], maxTokens: 10 }));
  for (const sent of [await json(s), await turn(s)]) {
    expect([sent.length, sent[0]!.background, sent[0]!.stream]).toEqual([1, true, undefined]);
  }
  const streaming = { ...s, openaiTransport: "stream" as const };
  for (const sent of [await json(streaming), await turn(streaming)]) {
    expect([sent.length, sent[0]!.background, sent[0]!.stream]).toEqual([1, undefined, true]);
  }
});

test("generic Responses tables keep streaming; store = false is sent", async () => {
  const s = { ...defaultSettings(), providers: TABLES, prices: PRICED };
  const fixed = await bodiesSent(() => makeJsonModel(parseModelRef("compat:some-model", TABLES), s, COMPAT_ENV)
    .completeJson("s", "u", SCHEMA).catch(() => null));
  expect([fixed[0]!.stream, fixed[0]!.background, fixed[0]!.store]).toEqual([true, undefined, false]);
  const fromEnv = await bodiesSent(() => makeJsonModel(parseModelRef("compatenv:some-model", TABLES), s, COMPAT_ENV)
    .completeJson("s", "u", SCHEMA).catch(() => null));
  expect([fromEnv[0]!.stream, fromEnv[0]!.background]).toEqual([true, undefined]);
});

test("second_hunter_effort is sent as is to the second hunter; unset, the table's effort map applies", async () => {
  const hunter = parseModelRef("compat:some-model", TABLES);
  const s = { ...defaultSettings(), providers: TABLES, prices: PRICED, secondHunter: hunter };
  const env = COMPAT_ENV;
  const effort = async (t: typeof s) => (await bodiesSent(() => makeSecondHunter(t, env)!.completeJson("s", "u",
    SCHEMA)))[0]!.reasoning;
  expect(await effort({ ...s, secondHunterEffort: "none" })).toEqual({ effort: "none" });
  expect(await effort(s)).toEqual({ effort: "high" });
  // only the second hunter: the challenger keeps the shared effort
  const challenger = await bodiesSent(() => makeJsonModel(hunter, { ...s, secondHunterEffort: "none" }, env)
    .completeJson("s", "u", SCHEMA));
  expect(challenger[0]!.reasoning).toEqual({ effort: "high" });
  expect(makeSecondHunter(defaultSettings(), env)).toBeUndefined();
});

test("background: a 404 poll soon after the create is tried again; past the grace it fails the call", async () => {
  const log: string[] = [];
  const m = backgroundOver([404, responsesBody('{"verdict": "ok"}')], log);
  expect((await m.completeJson("s", "u", SCHEMA))[0]).toEqual({ verdict: "ok" });
  expect(log).toEqual(["POST /responses", GET, GET]);
  const late: string[] = [];
  const old = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    background: true, graceSeconds: 0, fetch: fakeFetch((url, init) => {
      late.push(`${init.method ?? "GET"} ${url.replace("https://api.example/v1", "")}`);
      if (url.endsWith("/responses")) return Response.json(queued);
      return url.endsWith("/cancel") ? Response.json({}) : new Response("no such response", { status: 404 });
    }) });
  const err = await old.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect([err.message.includes("poll: HTTP 404"), err.unknownCalls]).toEqual([true, 1]);
  expect(late).toEqual(["POST /responses", GET, `POST /responses/${RID}/cancel`]);
});

// Abort-aware fakes: a request that hangs until its signal aborts it.
const hang = (init?: RequestInit) => new Promise<Response>((_r, rej) => {
  init?.signal?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
});
const realSleep = (s: number) => new Promise<void>((r) => setTimeout(r, s * 1000));

test("background: a poll that hangs is cut at the total deadline, and the response cancelled", async () => {
  const log: string[] = [];
  let n = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { background: true,
    totalSeconds: 0.5, pollSeconds: 0.05, sleep: realSleep, fetch: fakeFetch((url, init) => {
      log.push(`${init.method ?? "GET"} ${url.replace("https://api.example/v1", "")}`);
      if (url.endsWith("/responses")) return Response.json(queued);
      if (url.endsWith("/cancel")) return Response.json({ id: RID, status: "cancelled" });
      return ++n === 1 ? Response.json({ id: RID, status: "in_progress" }) : hang(init);
    }) });
  const t0 = performance.now();
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect([err instanceof ModelError, err.timedOut, err.unknownCalls]).toEqual([true, true, 1]);
  expect(performance.now() - t0).toBeLessThan(800);
  expect(log.at(-1)).toBe(`POST /responses/${RID}/cancel`);
});

test("background: a cancel that hangs is given up after CANCEL_SECONDS", async () => {
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { background: true,
    totalSeconds: 0.2, pollSeconds: 0.05, sleep: realSleep, fetch: fakeFetch((url, init) => {
      if (url.endsWith("/responses")) return Response.json(queued);
      return url.endsWith("/cancel") ? hang(init) : Response.json({ id: RID, status: "in_progress" });
    }) });
  const t0 = performance.now();
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  const secs = (performance.now() - t0) / 1000;
  expect([err instanceof ModelError, err.timedOut]).toEqual([true, true]);
  expect(secs).toBeGreaterThan(CANCEL_SECONDS - 0.1);
  expect(secs).toBeLessThan(CANCEL_SECONDS + 0.6);
}, 10_000);

/** A background call that polls in_progress until its response is cancelled; `hangCancel` makes the cancel hang. */
function inFlightCall(log: string[], hangCancel = false, totalSeconds = 5) {
  let cancelled = false;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { background: true,
    totalSeconds, pollSeconds: 0.01, sleep: realSleep, fetch: fakeFetch((url, init) => {
      log.push(`${init.method ?? "GET"} ${url.replace("https://api.example/v1", "")}`);
      if (url.endsWith("/responses")) return Response.json(queued);
      if (url.endsWith("/cancel")) {
        if (hangCancel) return hang(init);
        cancelled = true;
        return Response.json({ id: RID, status: "cancelled" });
      }
      return Response.json({ id: RID, status: cancelled ? "cancelled" : "in_progress" });
    }) });
  return m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e);
}
const created = async (log: string[]) => {
  while (!log.includes(GET)) await realSleep(0.005);
};

test("an interrupt (SIGTERM) cancels in-flight background responses, logs each id, then exits 143", async () => {
  const log: string[] = [], err: string[] = [], exits: number[] = [];
  let cleaned = 0;
  const call = inFlightCall(log);
  await created(log);
  await onInterrupt("SIGTERM", { cleanup: () => { cleaned++; }, cancel: cancelInFlight, err: (t) => err.push(t),
    exit: (c) => exits.push(c) });
  expect(log).toContain(`POST /responses/${RID}/cancel`);
  expect([cleaned, exits]).toEqual([1, [143]]);
  expect(err).toEqual(["arnx: terminated\n", `arnx: cancelled background response ${RID}\n`]);
  const result = await call as ModelError; // the call itself then sees its response cancelled
  expect(result.message).toContain("cancelled");
  expect(await cancelInFlight()).toEqual([]); // nothing left in flight
  await onInterrupt("SIGINT", { cleanup: () => {}, cancel: cancelInFlight, err: (t) => err.push(t),
    exit: (c) => exits.push(c) });
  expect([exits, err.at(-1)]).toEqual([[143, 130], "arnx: interrupted\n"]);
});

test("an interrupt in progress makes main's final exit 130/143, whichever signal came first", async () => {
  const state = {}, exits: number[] = [];
  expect(finalExitCode(1, state)).toBe(1); // no interrupt: the review's own code
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  const handling = onInterrupt("SIGINT", { cleanup: () => {}, cancel: async () => { await hold; return []; },
    err: () => {}, exit: (c) => exits.push(c) }, state);
  expect([finalExitCode(0, state), finalExitCode(1, state)]).toEqual([130, 130]); // main finishes meanwhile
  const later = onInterrupt("SIGTERM", { cleanup: () => {}, cancel: async () => [], err: () => {},
    exit: (c) => exits.push(c) }, state);
  await later;
  expect(finalExitCode(0, state)).toBe(130); // the first signal wins
  release();
  await handling;
  expect(exits).toEqual([143, 130]);
});

test("a cleanup that throws still exits 143, with one stderr line and the cancels still attempted", async () => {
  const err: string[] = [], exits: number[] = [];
  let cancelled = 0;
  await onInterrupt("SIGTERM", { cleanup: () => { throw new Error("docker gone"); },
    cancel: async () => { cancelled++; return []; }, err: (t) => err.push(t), exit: (c) => exits.push(c) }, {});
  expect(exits).toEqual([143]);
  expect(cancelled).toBe(1);
  expect(err.filter((t) => t.includes("docker gone"))).toEqual(["arnx: interrupt cleanup failed: docker gone\n"]);
  const err2: string[] = [];
  await onInterrupt("SIGINT", { cleanup: () => {}, cancel: async () => { throw new Error("boom"); },
    err: (t) => err2.push(t), exit: (c) => exits.push(c) }, {});
  expect([exits, err2.at(-1)]).toEqual([[143, 130], "arnx: interrupt cleanup failed: boom\n"]);
});

test("cancelInFlight gives up on cancels that hang after its cap", async () => {
  const log: string[] = [];
  const call = inFlightCall(log, true, 0.5);
  await created(log);
  const t0 = performance.now();
  expect(await cancelInFlight(0.1)).toEqual([[RID, false]]);
  expect(performance.now() - t0).toBeLessThan(1000);
  await call;
}, 15_000);

// A first challenger that stalls is not retried when a fallback stands behind it (timeoutAttempts: 1).
const STALL = parseModelRef("openai:gpt-6.1-sol");
const okReply = () => new Response(sse(responsesBody('{"verdict": "confirmed"}')), { status: 200 });
/** A 200 whose stream starts and then goes quiet until the request is aborted (accepted, then cut off). */
const stalledStream = (init: RequestInit) => new Response(new ReadableStream({ start(c) {
  c.enqueue(enc.encode(`event: response.created\ndata: ${JSON.stringify({ type: "response.created",
    response: { status: "in_progress" } })}\n\n`));
  init.signal?.addEventListener("abort", () => c.error(new DOMException("aborted", "AbortError")));
} }), { status: 200, headers: { "content-type": "text/event-stream" } });
const stalling = (count: { n: number }, opts: { timeoutAttempts?: number } = {}) =>
  new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep, attemptSeconds: 0.05,
    totalSeconds: 5, ...opts, fetch: fakeFetch((_u, init) => { count.n++; return stalledStream(init); }) });

test("timeoutAttempts 1: a first model that stalls is asked once, then the fallback answers", async () => {
  const first = { n: 0 }, second = { n: 0 };
  const fallback = new ResponsesJson(STALL, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch(() => { second.n++; return okReply(); }) });
  const model = new FallbackJson(stalling(first, { timeoutAttempts: 1 }), fallback);
  const trace: Record<string, unknown>[] = [];
  model.trace = (line) => trace.push(line);
  const reply = await model.completeJson("s", "u", SCHEMA);
  expect([first.n, second.n]).toEqual([1, 1]);
  expect(reply[0]).toEqual({ verdict: "confirmed" });
  expect(reply[4]).toBe("openai:gpt-6.1-sol");
  expect(model.uses[0]!.unknownCalls).toBe(1);
  expect(model.uses[1]!.unknownCalls).toBe(0);
  expect(trace.some((l) => l.model === GPT.provider + ":" + GPT.model && l.outcome === "fallback")).toBe(true);
  expect(trace.filter((l) => l.model === "openai:gpt-5.5-2026-04-23" && l.step === undefined && typeof l.outcome === "string"
    && String(l.outcome).includes("attempt timeout after 0.05s")).length).toBe(1);
});

test("timeoutAttempts 1: the error is the timed-out attempt's, with its accounting", async () => {
  const count = { n: 0 };
  const err = await stalling(count, { timeoutAttempts: 1 }).completeJson("s", "u", SCHEMA)
    .catch((e: unknown) => e) as ModelError;
  expect(err).toBeInstanceOf(ModelError);
  expect([count.n, err.timedOut, err.tries, err.unknownCalls]).toEqual([1, true, 1, 1]);
  expect(err.message).toContain("attempt timeout after 0.05s");
});

test("without timeoutAttempts a stalled first model is retried as before, before the fallback", async () => {
  const first = { n: 0 }, second = { n: 0 };
  const fallback = new ResponsesJson(STALL, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fakeFetch(() => { second.n++; return okReply(); }) });
  const model = new FallbackJson(stalling(first), fallback);
  const reply = await model.completeJson("s", "u", SCHEMA);
  expect(first.n).toBeGreaterThan(1);
  expect([second.n, reply[4]]).toEqual([1, "openai:gpt-6.1-sol"]);
  expect(model.uses[0]!.unknownCalls).toBe(first.n);
});

test("timeoutAttempts 2 allows one retry after a timeout", async () => {
  const count = { n: 0 };
  const err = await stalling(count, { timeoutAttempts: 2 }).completeJson("s", "u", SCHEMA)
    .catch((e: unknown) => e) as ModelError;
  expect([count.n, err.timedOut, err.tries]).toEqual([2, true, 2]);
});

test("timeoutAttempts 1: a retryable status is still retried on the same model", async () => {
  let n = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep, timeoutAttempts: 1,
    fetch: fakeFetch(() => (++n === 1 ? new Response("overloaded", { status: 503 }) : okReply())) });
  expect((await m.completeJson("s", "u", SCHEMA))[0]).toEqual({ verdict: "confirmed" });
  expect(n).toBe(2);
});

test("timeoutAttempts 1: a status retry does not use up the timeout allowance", async () => {
  let n = 0;
  const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep, timeoutAttempts: 1,
    attemptSeconds: 0.05, totalSeconds: 5,
    fetch: fakeFetch((_u, init) => (++n === 1 ? new Response("overloaded", { status: 503 }) : stalledStream(init))) });
  const err = await m.completeJson("s", "u", SCHEMA).catch((e: unknown) => e) as ModelError;
  expect([n, err.timedOut, err.tries]).toEqual([2, true, 2]);
});

test("anthropic: timeoutAttempts 1 fails after one timed-out attempt; without it the attempt is sent again", async () => {
  let n = 0;
  const make = (opts: { timeoutAttempts?: number }) => new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined,
    { idleSeconds: 0.15, attemptSeconds: 0.3, totalSeconds: 3, sleep: noSleep, ...opts,
      fetch: fakeFetch((_u, init) => (++n, pingingResponse(init))) });
  const err = await ask(make({ timeoutAttempts: 1 })).catch((e: unknown) => e) as ModelError;
  expect([n, err.timedOut, err.attempts!.map((a) => a.timeout), err.unknownCalls]).toEqual([1, true, ["attempt"], 1]);
  n = 0;
  await ask(make({})).catch(() => null);
  expect(n).toBeGreaterThan(1);
});

test("makeChallenger: timeoutAttempts 1 on the first model only, and only with a fallback", () => {
  const env = { ...COMPAT_ENV, OPENAI_API_KEY: "o" };
  const s = { ...defaultSettings(), providers: TABLES, prices: PRICED,
    challenger: parseModelRef("compat:some-model", TABLES), challengerFallback: parseModelRef("openai:gpt-6.1-sol") };
  const limit = (m: unknown) => (m as { timeoutAttempts: number }).timeoutAttempts;
  const attempt = (m: unknown) => (m as { attemptLimit: number }).attemptLimit;
  const withFallback = makeChallenger(s, env) as FallbackJson;
  expect(withFallback).toBeInstanceOf(FallbackJson);
  const [first, second] = [(withFallback as unknown as { first: unknown }).first,
    (withFallback as unknown as { second: unknown }).second];
  expect([limit(first), attempt(first)]).toEqual([1, 60]);
  expect([limit(second), attempt(second)]).toEqual([Infinity, 60]);
  const alone = makeChallenger({ ...s, challengerFallback: undefined }, env);
  expect(alone).not.toBeInstanceOf(FallbackJson);
  expect([limit(alone), attempt(alone)]).toEqual([Infinity, 60]);
});

test("main's exit waits for an interrupt in progress, so its cancel calls are not cut off", async () => {
  const state = {}, exits: number[] = [];
  expect(await exitCodeAfter(1, state)).toBe(1); // no interrupt: at once, the review's own code
  let release!: () => void;
  const hold = new Promise<void>((r) => { release = r; });
  let cancelled = false;
  void startInterrupt("SIGINT", { cleanup: () => {}, err: () => {}, exit: (c) => exits.push(c),
    cancel: async () => { await hold; cancelled = true; return [["resp_1", true]]; } }, state);
  let settled = false;
  const done = exitCodeAfter(0, state).then((c) => { settled = true; return c; });
  await new Promise((r) => setTimeout(r, 10));
  expect(settled).toBe(false); // the review finished, but the cancel is still in flight
  release();
  expect(await done).toBe(130);
  expect([cancelled, exits]).toEqual([true, [130]]);
});

test("a retry's progress line gives the HTTP status, never the body the provider sent", async () => {
  const { brief } = await import("../src/llm");
  expect(brief('HTTP 429: {"error":{"message":"Account request rate limit exceeded"}}')).toBe("HTTP 429 (rate limit)");
  expect(brief("HTTP 503: No ready deployment")).toBe("HTTP 503");
  expect(brief("no reply within 300s")).toBe("no reply within 300s");
});
