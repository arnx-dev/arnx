// Request goldens: what arnx sends to each built-in provider (Anthropic, OpenAI, River) and to two generic tables that copy the
// OpenAI Responses API, per role, byte for byte (the URL, the method, the headers but the runtime's platform ones, and
// the body). The built-in providers' requests were captured before providers became data, and stay as they were.
// ARNX_WRITE_GOLDEN=1 writes the file again (only on purpose).
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type JsonModel, makeAgentModel, makeChallenger, makeJsonModel, makeSecondHunter } from "../src/llm";
import { defaultSettings, type Env, parseModelRef, type Settings } from "../src/settings";
import { GOLDEN } from "./helpers/golden";

const FILE = join(GOLDEN, "requests.json");
const SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"],
  additionalProperties: false };
const TOOL = { name: "read_file", description: "Read a file", input_schema: { type: "object",
  properties: { path: { type: "string" } }, required: ["path"] } };
const ENV: Env = { ANTHROPIC_API_KEY: "test-anthropic", OPENAI_API_KEY: "test-openai", RIVER_API_KEY: "test-river",
  COMPAT_KEY: "test-compat",
  COMPAT_ENV_KEY: "test-compat-env", COMPAT_URL: "https://env.example/v1/" };
/** Headers that say which machine and runtime sent the request (the Anthropic SDK's), not what arnx sent. */
const PLATFORM = /^x-stainless-(os|arch|runtime|runtime-version|package-version|lang)$/;

interface Sent { url: string; method: string; headers: Record<string, string>; body: string | null }

const verdict = '{"verdict": "ok"}';
const responsesBody = { status: "completed", model: "m", output: [{ type: "message", role: "assistant",
  status: "completed", content: [{ type: "output_text", text: verdict }] }],
  usage: { input_tokens: 10, output_tokens: 5, input_tokens_details: { cached_tokens: 0 } } };

function responsesSse(): string {
  return [{ type: "response.created", response: { status: "in_progress" } },
    { type: "response.completed", response: responsesBody }]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function messagesSse(): string {
  const events: Record<string, unknown>[] = [
    { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model: "m", content: [],
      stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: verdict } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: "message_stop" }];
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

function headersOf(h: ConstructorParameters<typeof Headers>[0]): Record<string, string> {
  const out: Record<string, string> = {};
  new Headers(h).forEach((v, k) => { if (!PLATFORM.test(k)) out[k] = v; });
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

/** Runs `fn` with the global fetch answering every provider, and returns each request it sent. A background create
 * is answered "queued" when `poll` is set, so its poll is captured too. */
async function requestsOf(fn: () => Promise<unknown>, poll = false): Promise<Sent[]> {
  const sent: Sent[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    const method = init?.method ?? req?.method ?? "GET";
    const body = init?.body !== undefined && init.body !== null ? String(init.body)
      : req ? (await req.text()) || null : null;
    sent.push({ url, method, headers: headersOf(init?.headers ?? req?.headers), body });
    if (url.endsWith("/v1/messages")) {
      return new Response(messagesSse(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (method === "GET") return Response.json({ id: "resp_1", ...responsesBody });
    const parsed = body ? JSON.parse(body) as Record<string, unknown> : {};
    if (parsed.stream) return new Response(responsesSse(), { status: 200, headers: { "content-type": "text/event-stream" } });
    return Response.json(poll ? { id: "resp_1", status: "queued" } : { id: "resp_1", ...responsesBody });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return sent;
}

/** Generic tables: one at a fixed URL that takes "high" for arnx's "medium" and refuses stored responses, one whose URL
 * is in the environment. */
const TABLES: Settings["providers"] = {
  compat: { api: "responses", url: "https://llm.example.com/v1", key_env: "COMPAT_KEY", effort: { medium: "high" },
    store: false },
  compatenv: { api: "responses", url_env: "COMPAT_URL", key_env: "COMPAT_ENV_KEY" },
};
const base = (): Settings => ({ ...defaultSettings(), providers: TABLES,
  prices: { "some-model": [1, 2, 0.1, 0], "other-model": [0.12, 0.40, 0.024, 0.0] } });
const MODELS: Record<string, string> = { anthropic: "anthropic:claude-sonnet-5-5", openai: "openai:gpt-6.1-sol",
  river: "river:zai-org/GLM-5.3-Flash", compat: "compat:other-model", compatenv: "compatenv:some-model" };
const agentTurn = (s: Settings) => makeAgentModel(s, ENV).create({ system: "sys", tools: [TOOL],
  messages: [{ role: "user", content: "go" }], maxTokens: 900 });

/** Every case: a name and the call that sends its requests. */
function cases(): [string, () => Promise<unknown>, boolean?][] {
  const out: [string, () => Promise<unknown>, boolean?][] = [];
  for (const [p, m] of Object.entries(MODELS)) {
    const ref = parseModelRef(m, TABLES);
    for (const effort of ["medium", "low"]) {
      const s = { ...base(), effort };
      out.push([`${p}/${effort}/reviewer`, () => agentTurn({ ...s, reviewer: ref })]);
      out.push([`${p}/${effort}/answer_model`, () => agentTurn({ ...s, answerModel: ref, reviewer: ref })]);
      out.push([`${p}/${effort}/hunter`, () => makeJsonModel(ref, s, ENV).completeJson("sys", "user", SCHEMA)]);
      out.push([`${p}/${effort}/challenger`, () => makeChallenger({ ...s, challenger: ref,
        challengerFallback: parseModelRef(MODELS.anthropic!) }, ENV).completeJson("sys", "user", SCHEMA)]);
      // What the fallback is sent when it is asked (the first model having failed).
      out.push([`${p}/${effort}/challenger_fallback`, () => (makeChallenger({ ...s,
        challenger: parseModelRef(p === "compatenv" ? MODELS.compat! : MODELS.compatenv!, TABLES), challengerFallback: ref }, ENV) as unknown as
        { second: JsonModel }).second.completeJson("sys", "user", SCHEMA)]);
      out.push([`${p}/${effort}/second_hunter`, () => makeSecondHunter({ ...s, secondHunter: ref }, ENV)!
        .completeJson("sys", "user", SCHEMA)]);
      out.push([`${p}/${effort}/second_hunter_effort`, () => makeSecondHunter({ ...s, secondHunter: ref,
        secondHunterEffort: "none" }, ENV)!.completeJson("sys", "user", SCHEMA)]);
    }
  }
  const gpt = parseModelRef(MODELS.openai!);
  for (const [name, extra] of [["stream", { openaiTransport: "stream" as const }], ["fast", { openaiTier: "fast" }],
    ["fast-stream", { openaiTier: "fast", openaiTransport: "stream" as const }]] as const) {
    const s = { ...base(), ...extra };
    out.push([`openai/${name}/reviewer`, () => agentTurn({ ...s, reviewer: gpt })]);
    out.push([`openai/${name}/hunter`, () => makeJsonModel(gpt, s, ENV).completeJson("sys", "user", SCHEMA)]);
  }
  out.push(["openai/background-poll/hunter", () => makeJsonModel(gpt, base(), ENV).completeJson("sys", "user", SCHEMA),
    true]);
  return out;
}

test("requests to the built-in providers and the generic tables are byte-identical, per role", async () => {
  const got: Record<string, Sent[]> = {};
  for (const [name, fn, poll] of cases()) got[name] = await requestsOf(fn, poll);
  for (const [name, reqs] of Object.entries(got)) expect([name, reqs.length > 0]).toEqual([name, true]);
  const text = JSON.stringify(got, null, 1) + "\n";
  if (process.env.ARNX_WRITE_GOLDEN === "1") writeFileSync(FILE, text);
  expect(existsSync(FILE)).toBe(true);
  const want = JSON.parse(readFileSync(FILE, "utf8")) as Record<string, Sent[]>;
  expect(Object.keys(got)).toEqual(Object.keys(want));
  for (const name of Object.keys(want)) expect([name, got[name]]).toEqual([name, want[name]!]);
}, 30_000);
