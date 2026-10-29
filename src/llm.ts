// Model clients. The agent loop uses Anthropic tool use; one-shot JSON calls (the challenger) use Anthropic or an
// OpenAI-compatible Responses API (OpenAI, and endpoints that copy it). Keys are read from the environment by the caller and never logged
// or written anywhere.
import Anthropic from "@anthropic-ai/sdk";
import { spend } from "./spend";
import { ModelError, NoCredits, type ProviderFault, SetupRequired, survivable } from "./errors";
import { type Env, type ModelRef, type Prices, providerOfRef, refString, type Settings } from "./settings";
import { sleep } from "./util";
import { clip, emitModelCall, providerOf } from "./events";
import { recordCall } from "./outage";
import { withProviderSlot } from "./provider";
import { ANTHROPIC_URL, envNames, OPENAI_URL, PRESETS, type Provider, RIVER_URL } from "./providers";

export { OPENAI_URL, RIVER_URL };

// USD per million tokens: input, output, cache read, cache write. gpt-5.5 from the OpenAI price page (2026-09-29).
// Others go in [prices] in .arnx/config.toml.
export const PRICES: Prices = {
  "claude-sonnet-5-5": [2.0, 10.0, 0.2, 2.5], // Anthropic model table, 2026-10-06 (5-minute cache writes)
  "claude-opus-5-5": [4.0, 20.0, 0.2, 5.0], // Anthropic model table, 2026-10-06; cache write is 1.25x input (5 minutes)
  "gpt-5.5-2026-04-23": [5.0, 30.0, 0.5, 5.0],
  // 2026-10-14, short-context rates (the long-context threshold is not known yet).
  "gpt-6.1-sol": [2.0, 10.0, 0.1, 2.5],
  // Fast (priority) processing, 2026-10-14: twice the standard rates.
  "gpt-6.1-sol@fast": [4.0, 20.0, 0.2, 5.0],
  // River (docs.river.ai, 2026-10-14): no cache-write charge.
  "zai-org/GLM-5.3-Flash": [0.12, 0.40, 0.024, 0.0],
  "deepseek-ai/DeepSeek-V4.1-Flash": [0.12, 0.48, 0.0024, 0.0],
  // The other providers arnx knows (settings.ts KNOWN_PROVIDERS), from their docs, 2026-10-21. DeepSeek: peak rates
  // (off-peak is half); OpenRouter: as Z.ai's own price for the model.
  "deepseek-flash": [0.3, 1.2, 0.006, 0.0],
  "kimi-k3": [3.0, 15.0, 0.3, 0.0],
  "z-ai/glm-5.3": [1.4, 4.4, 0.26, 0.0],
  "glm-5.3-flash": [0.15, 0.5, 0.03, 0.0],
  // 2026-10-13: prompts over 100K tokens are billed at five times the rate.
  "claude-haiku-5-5": [0.1, 0.5, 0.01, 0.125, 100_000, 0.5, 2.5, 0.05, 0.625],
};
export const RETRY_STATUS = new Set([408, 409, 429, 500, 502, 503, 504, 529]);

/** A failed call's message for a progress line: the HTTP status without the body the provider sent. */
export function brief(message: string): string {
  const status = /^HTTP (\d+)/.exec(message)?.[1];
  if (status) return `HTTP ${status}${status === "429" ? " (rate limit)" : ""}`;
  return message.length > 100 ? `${message.slice(0, 100)}…` : message;
}
export const DELAYS = [2, 8, 30];
/** A status that says the provider is down or overloaded, not that the request was wrong. */
const isDown = (status: number) => status >= 500 || status === 429;
/** A refused key, which no retry fixes. */
const authFault = (status: number): ProviderFault | undefined =>
  status === 401 || status === 403 ? { kind: "auth", detail: `HTTP ${status}` } : undefined;
/** How providers say a key has no credits left: OpenAI's error codes (an HTTP 429, or a background response that
 * failed), Anthropic's billing error and its 400 "Your credit balance is too low". */
const NO_CREDITS = /\b(insufficient_quota|credit_balance_exhausted|billing_error)\b|credit balance is too low/i;
/** NoCredits for `provider` (as model refs name it) when `text`, an error body or message, says so. */
export function noCredits(provider: string, text: string): NoCredits | null {
  return NO_CREDITS.test(text) ? new NoCredits(PRESETS[provider]?.label ?? provider) : null;
}
/** A request that found no connection (DNS, refused, reset), named by the runtime's error code when it has one. */
function noConnection(e: unknown): string {
  const code = (e as { code?: unknown } | null)?.code;
  return `no connection (${clip(typeof code === "string" && code ? code : errorName(e), 60)})`;
}
/** The fault of a call whose every attempt found the provider down, from what each attempt met. */
const unavailable = (seen: string[]): ProviderFault => ({ kind: "unavailable", detail: [...new Set(seen)].join(", ") });
/** Provider backoff, in seconds. Ignore malformed values; never shorten the local backoff. */
function retryAfter(headers?: Headers): number | undefined {
  const ms = headers?.get("retry-after-ms");
  if (ms !== null && ms !== undefined && ms.trim() && Number.isFinite(Number(ms)) && Number(ms) >= 0) {
    return Number(ms) / 1000;
  }
  const value = headers?.get("retry-after");
  if (!value?.trim()) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? seconds : undefined;
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, (date - Date.now()) / 1000) : undefined;
}
// Streaming keeps a long reasoning call from looking idle. IDLE_TIMEOUT is the longest gap allowed between two
// stream chunks; CONNECT_TIMEOUT bounds the wait for response headers.
export const IDLE_TIMEOUT = 300;
export const CONNECT_TIMEOUT = 30;
// TOTAL_TIMEOUT bounds one JSON call across all its attempts: a stream that keeps sending keepalives but never
// finishes would otherwise hold a review open without limit.
export const TOTAL_TIMEOUT = 300;
// ATTEMPT_TIMEOUT bounds one attempt: a request still unanswered after it is abandoned and sent again (within the
// total), since a second try of a hung request usually answers in seconds.
export const ATTEMPT_TIMEOUT = 150;
// Second opinions are short calls (3–20 s when the connection is up): a stalled one is abandoned after 60 s, so a
// dropped connection costs a minute, not two and a half. Hunt calls keep ATTEMPT_TIMEOUT (they take 60–90 s). In
// background mode (OpenAI) the attempt limit bounds only the create; polling runs to the call's total timeout.
// When the challenger has a fallback, its first model is given one timed-out attempt only (`timeoutAttempts: 1`):
// retrying a stalled model four times cost up to 280 s before the fallback, which answers in seconds, was asked.
// Retryable statuses and network errors that are not timeouts keep the usual retries.
export const VERDICT_ATTEMPT_TIMEOUT = 60;
// OpenAI streams of hidden reasoning go quiet for long stretches and stall on some networks although the response
// completes: OpenAI calls run in background mode instead, polled every POLL_SECONDS (a GET, not a new generation).
export const POLL_SECONDS = 3;
/** A response given up on is cancelled so it stops working and billing; the cancel is not waited on longer. */
export const CANCEL_SECONDS = 5;
/** A poll answered 404 this soon after the create is tried again: OpenAI's store can lag behind the create. */
export const STORE_GRACE_SECONDS = 15;
/** Longest an interrupted arnx waits for its in-flight background responses to be cancelled. */
export const INTERRUPT_CANCEL_SECONDS = 3;
const TERMINAL = new Set(["completed", "incomplete", "failed", "cancelled"]);
/** Background responses created and not yet terminal, by id: an interrupt cancels them so they stop billing. */
const inFlight = new Map<string, () => Promise<boolean>>();

/** Cancel every in-flight background response, within `capSeconds` overall; each id, and whether its cancel was
 * accepted in time. */
export async function cancelInFlight(capSeconds = INTERRUPT_CANCEL_SECONDS): Promise<[string, boolean][]> {
  const ids = [...inFlight.keys()];
  const results: boolean[] = ids.map(() => false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([
    Promise.allSettled(ids.map(async (id, i) => { results[i] = await inFlight.get(id)!(); })),
    new Promise((r) => { timer = setTimeout(r, capSeconds * 1000); }),
  ]);
  clearTimeout(timer);
  return ids.map((id, i) => [id, results[i]!]);
}

export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number }
export const NO_USAGE: Usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

export interface Block { type: string; text?: string; id?: string; name?: string; input?: Record<string, unknown> }
/** One attempt at a streamed request: when the first event came, the longest silence between events, and how it
 * ended (a stalled attempt was aborted after the idle limit and sent again). */
export interface Attempt { secs: number; firstEventSecs: number | null; longestGapSecs: number; events: number;
  outcome: "ok" | "stalled" | "late" | "error"; chunks?: number; firstByteSecs?: number | null;
  timeout?: "first-byte" | "idle" | "attempt" | "total"; error?: string }
/** unknownCalls: earlier attempts that streamed and were then cut off (billed, usage unknown). */
export interface Reply { content: Block[]; stopReason: string; usage: Usage; raw: unknown[]; attempts?: Attempt[];
  unknownCalls?: number; /** Requests sent for this reply, for trace events only (attempts feeds the transcript). */
  tries?: number }
export interface Tool { name: string; description: string; input_schema: Record<string, unknown> }
export interface Message { role: "user" | "assistant"; content: unknown }

export interface AgentModel {
  model: string;
  /** Who serves the model, for trace events. */
  readonly provider?: string;
  /** Told when a call stalls or loses its connection and is retried, so progress can say so. */
  notice?: (message: string) => void;
  create(a: { system: string; tools: Tool[]; messages: Message[]; maxTokens: number }): Promise<Reply>;
}

/** The parsed reply, its cost, the token usage it was priced from, attempts billed with unknown usage, and (from a
 * model with a fallback) the model that answered. */
export type JsonReply = [Record<string, unknown>, number, Usage?, number?, string?];

/** One line of the second-opinion log (attempts, calls, outcomes). */
export type Trace = (line: Record<string, unknown>) => void;

export interface JsonModel {
  ref: string;
  /** Called once per attempt with its outcome; set by the reviewer to log the calls. */
  trace?: Trace;
  /** Told when a call stalls or loses its connection and is retried, so progress can say so. */
  notice?: (message: string) => void;
  completeJson(system: string, user: string, schema: Record<string, unknown>): Promise<JsonReply>;
}

/** What one model was used for in a run: calls with known usage, calls billed with unknown usage, tokens and cost.
 * `unpriced`: arnx has no price for the model, so its cost is unknown (each of its calls is in unknownCalls). */
export interface ModelUse extends Usage { model: string; calls: number; unknownCalls: number; costUsd: number;
  unpriced?: boolean }

/** The `model.call` event of one JSON call (tokens and cost as the call was billed; `error` when it failed). */
function emitJsonCall(ref: string, model: string, t0: number, c: { cost: number; usage: Usage | null; unknown: number;
  error?: string; timedOut?: boolean; attempts?: number; fault?: ProviderFault }): void {
  const u = c.usage ?? NO_USAGE;
  recordCall({ provider: providerOf(ref), ok: c.error === undefined, ...(c.fault ? { fault: c.fault } : {}),
    ...(c.attempts === undefined ? {} : { attempts: c.attempts }) });
  emitModelCall({ provider: providerOf(ref), model, ok: c.error === undefined,
    ...(c.error === undefined ? {} : { error: clip(c.error, 300) }), ...(c.fault ? { fault: c.fault.kind } : {}),
    input: u.input, output: u.output,
    cache_read: u.cacheRead, cache_write: u.cacheWrite, cost_usd: c.cost,
    latency_ms: Math.round(performance.now() - t0), ...(c.attempts === undefined ? {} : { attempts: c.attempts }),
    unknown_usage: c.unknown, timed_out: c.timedOut ?? false });
}

export const newUse = (model: string): ModelUse => ({ model, calls: 0, unknownCalls: 0, ...NO_USAGE, costUsd: 0 });

/** Add one call's usage to a model's tally (usage null: priced, but the provider reported no tokens). */
export function tally(use: ModelUse, costUsd: number, usage: Usage | null | undefined, unknownCalls = 0): void {
  use.calls += 1;
  use.unknownCalls += unknownCalls;
  use.costUsd = Math.round((use.costUsd + costUsd) * 1_000_000) / 1_000_000;
  if (usage) Object.assign(use, addUsage(use, usage));
}

export const addUsage = (a: Usage, b: Usage): Usage => ({ input: a.input + b.input, output: a.output + b.output,
  cacheRead: a.cacheRead + b.cacheRead, cacheWrite: a.cacheWrite + b.cacheWrite });

/** A ModelError that carries what the failed call was billed. */
export function billedError(message: string, costUsd: number, usage: Usage | null, unknownCalls = 0): ModelError {
  const e = new ModelError(message);
  [e.costUsd, e.usage, e.unknownCalls] = [costUsd, usage, unknownCalls];
  return e;
}

/** What a reply cost; null when arnx has no price for the model: the call then counts as billed with unknown usage,
 * and no budget cap covers it. */
export function costUsd(model: string, usage: Usage, prices: Prices): number | null {
  const price = prices[model];
  if (!price) return null;
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite;
  const [pIn, pOut, pRead, pWrite] = (price.length === 9 && prompt > price[4] ? price.slice(5) : price) as number[] as
    [number, number, number, number];
  return (usage.input * pIn + usage.output * pOut + usage.cacheRead * pRead + usage.cacheWrite * pWrite) / 1_000_000;
}

export function allPrices(s: Settings): Prices {
  return { ...PRICES, ...s.prices };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function parseJsonObject(text: string): Record<string, unknown> | null {
  const stripped = text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const first = stripped.indexOf("{"), last = stripped.lastIndexOf("}");
  const candidates = [stripped];
  if (first >= 0 && last >= first) candidates.push(stripped.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const value: unknown = JSON.parse(candidate);
      if (isObject(value)) return value;
    } catch {
      // not JSON; try the next candidate
    }
  }
  return null;
}

interface MessageStream extends AsyncIterable<unknown> {
  abort(): void;
  finalMessage(): Promise<unknown>;
}
interface MessagesClient { messages: { stream(params: Record<string, unknown>): MessageStream } }

/** Longest silence allowed on an Anthropic stream once it has started (the API sends events, including pings, while
 * it works). A request that stalls is aborted and sent again instead of waiting minutes. */
export const ANTHROPIC_IDLE = 45;
/** Longest wait for a stream's first event. The API answers a request it has taken with message_start within
 * seconds, so a request still silent after this never started: it is sent again without waiting out ANTHROPIC_IDLE. */
export const ANTHROPIC_FIRST_EVENT = 30;
export const ANTHROPIC_ATTEMPTS = 3;
/** Longest one request may take across its attempts. Pings keep a stalled stream from ever going idle, so idle alone
 * cannot end it; a 16k-token reply takes about 5 minutes. */
export const ANTHROPIC_TOTAL = 600;
/** Longest one attempt may take. Pings keep a stalled generation from going idle, so it is cut here and sent again
 * within ANTHROPIC_TOTAL rather than holding the whole total. */
export const ANTHROPIC_ATTEMPT = 300;

export class AnthropicAgent implements AgentModel {
  /** Who serves the model: "anthropic", or the name of a provider table speaking Anthropic Messages. */
  readonly provider: string;
  notice?: (message: string) => void;
  /** Another Messages endpoint than Anthropic's (unset: the SDK's own default). */
  private baseURL?: string;
  private idle: number;
  private firstEvent: number;
  private total: number;
  private attemptLimit: number;
  /** How many attempts may end in a timeout before the call fails (default: the usual retries). */
  private timeoutAttempts: number;
  private fetch: typeof fetch;
  private sleep: (seconds: number) => Promise<void>;

  constructor(readonly model: string, readonly effort: string, private apiKey: string, private client?: MessagesClient,
              opts: { idleSeconds?: number; firstEventSeconds?: number; totalSeconds?: number; attemptSeconds?: number;
                timeoutAttempts?: number; fetch?: typeof fetch; sleep?: (seconds: number) => Promise<void>;
                provider?: string; baseURL?: string } = {}) {
    this.provider = opts.provider ?? "anthropic";
    this.baseURL = opts.baseURL;
    this.timeoutAttempts = opts.timeoutAttempts ?? Infinity;
    this.fetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((s) => sleep(s * 1000));
    this.idle = opts.idleSeconds ?? ANTHROPIC_IDLE;
    this.firstEvent = Math.min(opts.firstEventSeconds ?? ANTHROPIC_FIRST_EVENT, this.idle);
    this.total = opts.totalSeconds ?? ANTHROPIC_TOTAL;
    this.attemptLimit = opts.attemptSeconds ?? ANTHROPIC_ATTEMPT;
  }

  /** Stream one request to its final message; a stream silent for `idle` seconds, or still running after the attempt
   * limit, is aborted and retried. `billed.unknown` counts attempts that streamed and were then cut off. */
  private async send(params: Record<string, unknown>, attempts: Attempt[], billed: { unknown: number }):
    Promise<Anthropic.Message> {
    const deadline = performance.now() + this.total * 1000;
    let timeouts = 0;
    // What each attempt met while every one found the provider down; null once one failed otherwise.
    let down: string[] | null = [];
    for (let attempt = 1; ; attempt++) {
      let stream: MessageStream | undefined;
      let timeout: Attempt["timeout"], events = 0, chunks = 0, first: number | null = null, gap = 0;
      let firstByte: number | null = null;
      const t0 = performance.now();
      let last = t0;
      const secs = (ms: number) => Math.round(ms / 100) / 10;
      const record = (outcome: Attempt["outcome"], error?: string) => attempts.push({ secs: secs(performance.now() - t0),
        firstEventSecs: first === null ? null : secs(first - t0),
        firstByteSecs: firstByte === null ? null : secs(firstByte - t0), chunks,
        longestGapSecs: secs(Math.max(gap, performance.now() - last)), events, outcome,
        ...(timeout ? { timeout } : {}), ...(error ? { error } : {}) });
      let timer: ReturnType<typeof setTimeout> | undefined, settled = false;
      const remaining = Math.max(0, deadline - performance.now());
      const cutoff = setTimeout(() => {
        timeout ??= remaining <= this.attemptLimit * 1000 ? "total" : "attempt";
        stream?.abort();
      }, Math.min(remaining, this.attemptLimit * 1000));
      const arm = (seconds: number) => {
        clearTimeout(timer);
        timer = setTimeout(() => {
          timeout ??= firstByte === null ? "first-byte" : "idle";
          stream?.abort();
        }, seconds * 1000);
      };
      const activity = () => {
        if (settled) return; // a late chunk of an attempt already given up
        const now = performance.now();
        firstByte ??= now;
        gap = Math.max(gap, now - last);
        last = now;
        arm(this.idle);
      };
      let delay = 0;
      try {
        arm(this.firstEvent);
        // The SDK filters SSE pings before its iterator. Observe bytes before parsing so heartbeats (and partial
        // events) keep a live connection alive. Each attempt owns its callback, including concurrent calls.
        const observedFetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
          const response = await this.fetch(input, init);
          if (!response.ok || !response.body) return response;
          const body = response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, controller) {
              if (chunk.byteLength) { chunks++; activity(); }
              controller.enqueue(chunk);
            },
          }));
          return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
        }) as typeof fetch;
        // One retry owner: SDK retries would otherwise multiply these attempts and hide their diagnostics.
        // Another endpoint gets this provider's key only: never a token the SDK would read from the process.
        const client = this.client ?? new Anthropic({ apiKey: this.apiKey, maxRetries: 0,
          timeout: this.total * 1000, fetch: observedFetch,
          ...(this.baseURL ? { baseURL: this.baseURL, authToken: null } : {}) }) as unknown as MessagesClient;
        stream = client.messages.stream(params);
        for await (const _event of stream) {
          first ??= performance.now();
          events++;
          if (this.client) activity(); // injected clients need not expose their raw transport
        }
        const message = await stream.finalMessage() as Anthropic.Message;
        if (timeout) throw new Error("request timed out");
        record("ok");
        return message;
      } catch (e) {
        // Not the SDK, its transport or our timeout: a bug in arnx, passed on as is (never retried).
        if (!timeout && !(e instanceof Anthropic.AnthropicError)) throw e;
        const reason = timeout === "total" ? `no reply within ${this.total}s (total timeout)`
          : timeout === "first-byte" ? `no reply: first-byte timeout after ${this.firstEvent}s`
          : timeout === "idle" ? `no reply: idle timeout after ${this.idle}s without bytes`
          : timeout === "attempt" ? `no reply: attempt timeout after ${this.attemptLimit}s`
          : e instanceof Anthropic.APIError && e.status ? `HTTP ${e.status}: ${e.message.slice(0, 200)}` : errorName(e);
        record(timeout === "total" ? "late" : timeout ? "stalled" : "error", reason);
        const broke = !timeout && e instanceof Anthropic.APIError ? noCredits(this.provider, `${e.type ?? ""} ${e.message}`)
          : null;
        if (broke) throw broke;
        // The request was taken and streamed before it failed: the provider may bill it.
        if (first !== null || firstByte !== null) billed.unknown++;
        // An APIError by its status or type; any other SDK error (a dropped or truncated stream) is the transport's.
        const retryable = !!timeout || !(e instanceof Anthropic.APIError) || e instanceof Anthropic.APIConnectionError ||
          RETRY_STATUS.has(e.status ?? 0) || ["overloaded_error", "rate_limit_error", "api_error"].includes(e.type ?? "");
        delay = Math.max(DELAYS[attempt - 1] ?? 0,
          e instanceof Anthropic.APIError ? retryAfter(e.headers) ?? 0 : 0);
        if (timeout) timeouts += 1;
        const met = timeout || e instanceof Anthropic.APIConnectionTimeoutError ? null
          : e instanceof Anthropic.APIConnectionError ? noConnection(e.cause ?? e)
          : e instanceof Anthropic.APIError && e.status && isDown(e.status) ? `HTTP ${e.status}` : null;
        down = down && met ? [...down, met] : null;
        const exhausted = timeout === "total" || timeouts >= this.timeoutAttempts ||
          performance.now() + delay * 1000 >= deadline;
        if (!retryable || attempt >= ANTHROPIC_ATTEMPTS || exhausted) {
          const err = new ModelError(`${this.model}: ${reason} (${attempt} attempts)`);
          err.timedOut = !!timeout || (retryable && exhausted);
          err.unknownCalls = billed.unknown;
          const fault = !timeout && e instanceof Anthropic.APIError && e.status ? authFault(e.status) : undefined;
          if (fault ?? down) err.fault = fault ?? unavailable(down!);
          throw err;
        }
        this.notice?.(`${this.model}: ${reason}; retrying (${attempt + 1}/${ANTHROPIC_ATTEMPTS}) in ${delay}s`);
      } finally {
        settled = true;
        clearTimeout(timer);
        clearTimeout(cutoff);
        stream?.abort();
      }
      await this.sleep(delay);
    }
  }

  async create({ system, tools, messages, maxTokens }: Parameters<AgentModel["create"]>[0]): Promise<Reply> {
    // Summarized thinking streams while the model thinks (billed the same as hidden thinking). Without it the API
    // sends nothing until thinking ends, and a long think would look like a dead connection.
    const params: Record<string, unknown> = { model: this.model, max_tokens: maxTokens, system, messages,
      thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: this.effort },
      cache_control: { type: "ephemeral" } };
    if (tools.length) params.tools = tools;
    let resp: Anthropic.Message;
    const attempts: Attempt[] = [], billed = { unknown: 0 };
    try {
      // One pool per model: a busy Sonnet reviewer does not hold back Haiku part hunters.
      resp = await withProviderSlot(`${this.provider}:${this.model}`, () => this.send(params, attempts, billed));
    } catch (e) {
      if (e instanceof ModelError) e.attempts = attempts;
      throw e;
    }
    const content: Block[] = resp.content.map((b) => {
      const x = b as unknown as Record<string, unknown>;
      return { type: String(x.type), text: typeof x.text === "string" ? x.text : "",
        id: typeof x.id === "string" ? x.id : "", name: typeof x.name === "string" ? x.name : "",
        input: isObject(x.input) ? x.input : {} };
    });
    const u = resp.usage;
    const usage = { input: u.input_tokens, output: u.output_tokens, cacheRead: u.cache_read_input_tokens ?? 0,
      cacheWrite: u.cache_creation_input_tokens ?? 0 };
    // The content goes back to the model unchanged on the next turn (thinking blocks included).
    return { content, stopReason: String(resp.stop_reason), usage, raw: resp.content, attempts,
      ...(billed.unknown ? { unknownCalls: billed.unknown } : {}) };
  }
}

const textOf = (blocks: Block[]) => blocks.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");

export class AnthropicJson implements JsonModel {
  readonly ref: string;
  set notice(n: ((message: string) => void) | undefined) {
    this.agent.notice = n;
  }

  constructor(ref: ModelRef, private agent: AgentModel, private prices: Prices) {
    this.ref = refString(ref);
  }

  async completeJson(system: string, user: string, schema: Record<string, unknown>): Promise<JsonReply> {
    const messages: Message[] = [{ role: "user", content: user + "\n\nReply with one JSON object matching this JSON " +
      "Schema, and nothing else:\n" + JSON.stringify(schema) }];
    let total = 0, usage = NO_USAGE, unknown = 0, tries = 0;
    const t0 = performance.now();
    for (let i = 0; i < 2; i++) {
      let reply: Reply;
      try {
        // Thinking counts toward max_tokens: room for a hunt's thinking and its list.
        reply = await this.agent.create({ system, tools: [], messages, maxTokens: 16_000 });
      } catch (e) {
        if (e instanceof ModelError) e.unknownCalls += unknown;
        if (e instanceof ModelError && total > 0) {
          e.costUsd += total;
          e.usage = addUsage(e.usage ?? NO_USAGE, usage);
        }
        if (e instanceof ModelError) {
          emitJsonCall(this.ref, this.agent.model, t0, { cost: e.costUsd, usage: e.usage, unknown: e.unknownCalls,
            error: e.message, timedOut: e.timedOut, ...(e.fault ? { fault: e.fault } : {}),
            ...(e.attempts || tries ? { attempts: tries + (e.attempts?.length ?? 0) } : {}) });
        }
        throw e;
      }
      tries += reply.attempts?.length ?? 0;
      const priced = costUsd(this.agent.model, reply.usage, this.prices), replyCost = priced ?? 0;
      unknown += (reply.unknownCalls ?? 0) + (priced === null ? 1 : 0);
      total += replyCost;
      spend.add(replyCost);
      usage = addUsage(usage, reply.usage);
      const parsed = parseJsonObject(textOf(reply.content));
      if (parsed !== null) {
        emitJsonCall(this.ref, this.agent.model, t0, { cost: total, usage, unknown, attempts: tries });
        return [parsed, total, usage, unknown];
      }
      messages.push({ role: "assistant", content: reply.raw },
        { role: "user", content: "That was not a single JSON object. Reply with the JSON object only." });
    }
    const failed = billedError(`${this.ref} did not reply with JSON`, total, usage, unknown);
    emitJsonCall(this.ref, this.agent.model, t0, { cost: total, usage, unknown, error: failed.message,
      attempts: tries });
    throw failed;
  }
}

class Retryable extends Error {
  /** The request was accepted (status 200) before it failed, so the provider may bill it. */
  accepted = false;
  timedOut = false;
  retryAfter?: number;
  /** What the attempt met when it found the provider down ("HTTP 503", "no connection (…)"): a 5xx or 429 status or
   * a failed connection. Unset for timeouts and broken replies. */
  down?: string;
}

export class ResponsesJson implements JsonModel {
  readonly ref: string;
  readonly model: string;
  private fetch: typeof fetch;
  private sleep: (seconds: number) => Promise<void>;
  private idle: number;
  private connect: number;
  private total: number;
  private attemptLimit: number;
  /** How many attempts may end in a timeout before the call fails (default: the usual retries). */
  private timeoutAttempts: number;
  private baseUrl: string;
  notice?: (message: string) => void;
  /** OpenAI service tier ("fast" for priority processing), priced under "<model>@<tier>". */
  readonly tier: string | null;
  /** Sent as `store` when set (some endpoints refuse stored responses). */
  private store?: boolean;
  /** Create a background response and poll it instead of streaming (OpenAI; needs stored responses). */
  private background: boolean;
  private pollSeconds: number;
  private graceSeconds: number;
  trace?: Trace;

  constructor(ref: ModelRef, baseUrl: string, private apiKey: string, readonly effort: string, private prices: Prices,
              opts: { fetch?: typeof fetch; sleep?: (seconds: number) => Promise<void>; idleSeconds?: number;
                      connectSeconds?: number; totalSeconds?: number; attemptSeconds?: number;
                      timeoutAttempts?: number; tier?: string | null; store?: boolean; background?: boolean; pollSeconds?: number;
                      graceSeconds?: number } = {}) {
    this.ref = refString(ref);
    this.model = ref.model;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.fetch = opts.fetch ?? fetch;
    this.sleep = opts.sleep ?? ((s) => sleep(s * 1000));
    this.idle = opts.idleSeconds ?? IDLE_TIMEOUT;
    this.connect = opts.connectSeconds ?? CONNECT_TIMEOUT;
    this.total = opts.totalSeconds ?? TOTAL_TIMEOUT;
    this.attemptLimit = opts.attemptSeconds ?? ATTEMPT_TIMEOUT;
    this.timeoutAttempts = opts.timeoutAttempts ?? Infinity;
    this.tier = opts.tier ?? null;
    this.store = opts.store;
    this.background = opts.background ?? false;
    this.pollSeconds = opts.pollSeconds ?? POLL_SECONDS;
    this.graceSeconds = opts.graceSeconds ?? STORE_GRACE_SECONDS;
  }

  async completeJson(system: string, user: string, schema: Record<string, unknown>): Promise<JsonReply> {
    const payload = { model: this.model, stream: true, reasoning: { effort: this.effort },
      ...(this.tier ? { service_tier: this.tier === "fast" ? "priority" : this.tier } : {}),
      ...(this.store !== undefined ? { store: this.store } : {}),
      input: [{ role: "system", content: system }, { role: "user", content: user }],
      text: { format: { type: "json_schema", name: "output", schema, strict: true } } };
    const t0 = performance.now(), priced = this.tier ? `${this.model}@${this.tier}` : this.model;
    let data: Record<string, unknown>, unknown: number, tries: number;
    try {
      [data, unknown, tries] = await this.post(payload);
    } catch (e) {
      if (e instanceof ModelError) {
        emitJsonCall(this.ref, priced, t0, { cost: e.costUsd, usage: null, unknown: e.unknownCalls, error: e.message,
          timedOut: e.timedOut, attempts: e.tries, ...(e.fault ? { fault: e.fault } : {}) });
      }
      throw e;
    }
    const usage = responsesUsage(data);
    const known = costUsd(priced, usage, this.prices), cost = known ?? 0;
    if (known === null) unknown += 1;
    spend.add(cost);
    let parsed: Record<string, unknown>, text = "";
    try {
      const texts = responsesTexts(data);
      text = texts.join("");
      parsed = lastJsonObject(texts);
    } catch (e) {
      // Say what came back, so a reply that is not JSON can be told apart from an empty or cut-off one.
      const seen = text ? ` (${text.length} chars, starts ${JSON.stringify(text.slice(0, 80))}, ends ` +
        `${JSON.stringify(text.slice(-80))}, ${Array.isArray(data.output) ? data.output.length : 0} output items)` : "";
      const failed = billedError(`${this.ref}: ${(e as Error).message}${seen}`, cost, usage, unknown);
      emitJsonCall(this.ref, priced, t0, { cost, usage, unknown, error: failed.message, attempts: tries });
      throw failed;
    }
    emitJsonCall(this.ref, priced, t0, { cost, usage, unknown, attempts: tries });
    return [parsed, cost, usage, unknown];
  }

  /** The terminal response, and how many earlier attempts were accepted (status 200) but cut off: the provider may
   * bill those, and their usage is unknown; then the number of requests sent. Shared with ResponsesAgent. */
  async post(payload: Record<string, unknown>): Promise<[Record<string, unknown>, number, number]> {
    const { stream: _stream, ...rest } = payload;
    const body = this.background ? { ...rest, background: true } : payload;
    return withProviderSlot(this.baseUrl, () => this.postWithinSlot(body));
  }

  private async postWithinSlot(payload: Record<string, unknown>): Promise<[Record<string, unknown>, number, number]> {
    let unknown = 0, attempt = 0, timeouts = 0;
    // What each attempt met while every one found the provider down; null once one failed otherwise.
    let down: string[] | null = [];
    const deadline = performance.now() + this.total * 1000;
    const failed = (e: ModelError) => {
      if (down?.length && down.length === attempt) e.fault = unavailable(down);
      return e;
    };
    const late = (reason = "total timeout") => {
      const e = billedError(`${this.ref}: no reply within ${this.total}s (${reason})`, 0, null, unknown);
      [e.timedOut, e.tries] = [true, attempt];
      return failed(e);
    };
    for (const backoff of [...DELAYS, null]) {
      if (performance.now() >= deadline) throw late();
      attempt += 1;
      const started = performance.now();
      const diagnostics: Record<string, unknown> = {};
      const traced = (outcome: string) => this.trace?.({ attempt, outcome: outcome.slice(0, 300),
        secs: Math.round((performance.now() - started) / 100) / 10, ...diagnostics });
      let delay = backoff ?? 0;
      try {
        const data = this.background ? await this.backgroundAttempt(payload, deadline, attempt, diagnostics)
          : await this.attempt(payload, deadline, diagnostics);
        const broke = data.status === "failed" ? noCredits(providerOf(this.ref), JSON.stringify(data.error ?? "")) : null;
        if (broke) throw broke;
        traced("ok");
        return [data, unknown, attempt];
      } catch (e) {
        traced(e instanceof Error ? e.message : String(e));
        if (e instanceof ModelError) {
          e.unknownCalls += unknown;
          e.tries = attempt;
          throw e;
        }
        if (!(e instanceof Retryable)) throw e;
        if (e.accepted) unknown += 1;
        down = down && e.down ? [...down, e.down] : null;
        if (performance.now() >= deadline || diagnostics.timeout === "total") throw late(e.message);
        if (e.timedOut) timeouts += 1;
        if (backoff === null || timeouts >= this.timeoutAttempts) {
          const err = billedError(`${this.ref}: ${e.message} (${attempt} attempt${attempt === 1 ? "" : "s"})`, 0, null, unknown);
          [err.timedOut, err.tries] = [e.timedOut, attempt];
          throw failed(err);
        }
        delay = Math.max(delay, e.retryAfter ?? 0);
        if (performance.now() + delay * 1000 >= deadline) throw late(`retry would exceed deadline; ${e.message}`);
        this.notice?.(`${this.ref}: ${brief(e.message)}; retrying (attempt ${attempt + 1}) in ${delay}s`);
      }
      await this.sleep(delay);
    }
    throw new ModelError(`${this.ref}: no reply`);
  }

  /** One request. Network errors, timeouts and retryable statuses throw Retryable. */
  private async attempt(payload: unknown, deadline: number, diagnostics: Record<string, unknown>): Promise<Record<string, unknown>> {
    const abort = new AbortController();
    const started = performance.now();
    let last = started, first: number | null = null, gap = 0, chunks = 0, accepted = false;
    let timeout: string | undefined;
    const expire = (kind: string) => { timeout ??= kind; abort.abort(); };
    const remaining = deadline - started;
    const cutoff = setTimeout(() => expire(remaining <= this.attemptLimit * 1000 ? "total" : "attempt"),
      Math.max(0, Math.min(remaining, this.attemptLimit * 1000)));
    let timer = setTimeout(() => expire("connect"), this.connect * 1000);
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => expire("idle"), this.idle * 1000);
    };
    try {
      let r: Response;
      try {
        r = await this.fetch(`${this.baseUrl}/responses`, { method: "POST", signal: abort.signal,
          headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
          body: JSON.stringify(payload) });
      } catch (e) {
        throw Object.assign(new Retryable(errorName(e)), { down: noConnection(e) });
      }
      diagnostics.status = r.status;
      diagnostics.headersSecs = Math.round((performance.now() - started) / 100) / 10;
      arm();
      if (r.status !== 200) {
        const body = await r.text().catch(() => "");
        const message = `HTTP ${r.status}: ${body.slice(0, 200)}`;
        const broke = noCredits(providerOf(this.ref), body);
        if (broke) throw broke;
        if (RETRY_STATUS.has(r.status)) {
          const e = new Retryable(message);
          e.retryAfter = retryAfter(r.headers);
          if (isDown(r.status)) e.down = `HTTP ${r.status}`;
          throw e;
        }
        throw refused(this.ref, message, r.status);
      }
      accepted = true;
      return await terminalResponse(this.ref, r, () => {
        const now = performance.now();
        first ??= now;
        gap = Math.max(gap, now - last);
        last = now;
        chunks++;
        arm();
      });
    } catch (error) {
      let e = error;
      if (timeout) {
        const limit = timeout === "connect" ? this.connect : timeout === "idle" ? this.idle
          : timeout === "attempt" ? this.attemptLimit : this.total;
        e = Object.assign(new Retryable(`${timeout} timeout after ${limit}s`), { timedOut: true });
      }
      if (e instanceof Retryable) e.accepted = accepted;
      if (e instanceof ModelError && accepted) e.unknownCalls += 1;
      throw e;
    } finally {
      Object.assign(diagnostics, { chunks, firstByteSecs: first === null ? null : Math.round((first - started) / 100) / 10,
        longestGapSecs: Math.round(Math.max(gap, performance.now() - last) / 100) / 10,
        ...(timeout ? { timeout } : {}) });
      clearTimeout(timer);
      clearTimeout(cutoff);
      abort.abort();
    }
  }

  /** One background request: create the response, then poll it until it is terminal. Only the create is a new
   * generation (retried by the caller); a failed poll is tried again at the next tick. A response given up on before
   * it is terminal is cancelled. Traced: the create, each change of the polled status, the cancel. */
  private async backgroundAttempt(payload: unknown, deadline: number, attempt: number,
                                  diagnostics: Record<string, unknown>): Promise<Record<string, unknown>> {
    const started = performance.now();
    const note = (line: Record<string, unknown>) =>
      this.trace?.({ step: "poll", attempt, ...line, secs: Math.round((performance.now() - started) / 100) / 10 });
    let id: string | undefined, polls = 0, accepted = false, done = false, timeout: string | undefined;
    try {
      const remaining = deadline - started, window = Math.min(this.connect, this.attemptLimit) * 1000;
      const kind = remaining <= window ? "total" : this.connect <= this.attemptLimit ? "connect" : "attempt";
      const abort = new AbortController();
      const timer = setTimeout(() => { timeout ??= kind; abort.abort(); }, Math.max(0, Math.min(remaining, window)));
      let data: Record<string, unknown>;
      try {
        let r: Response;
        try {
          r = await this.fetch(`${this.baseUrl}/responses`, { method: "POST", signal: abort.signal,
            headers: { authorization: `Bearer ${this.apiKey}`, "content-type": "application/json" },
            body: JSON.stringify(payload) });
        } catch (e) {
          throw Object.assign(new Retryable(errorName(e)), { down: noConnection(e) });
        }
        diagnostics.status = r.status;
        diagnostics.headersSecs = Math.round((performance.now() - started) / 100) / 10;
        if (r.status !== 200) {
          const body = await r.text().catch(() => "");
          const message = `HTTP ${r.status}: ${body.slice(0, 200)}`;
          const broke = noCredits(providerOf(this.ref), body);
          if (broke) throw broke;
          if (RETRY_STATUS.has(r.status)) {
            throw Object.assign(new Retryable(message), { retryAfter: retryAfter(r.headers),
              ...(isDown(r.status) ? { down: `HTTP ${r.status}` } : {}) });
          }
          throw refused(this.ref, message, r.status);
        }
        accepted = true; // queued: the provider bills it from here
        let body: unknown;
        try {
          body = await r.json();
        } catch (e) {
          throw new Retryable(`unreadable reply to the create (${errorName(e)})`);
        }
        if (!isObject(body) || typeof body.id !== "string") throw new Retryable("the create reply has no response id");
        data = body;
        id = body.id;
        const created = id;
        inFlight.set(created, () => this.cancel(created, note));
      } finally {
        clearTimeout(timer);
        abort.abort();
      }
      const createdAt = performance.now();
      let status = String(data.status), last = status;
      note({ phase: "create", id, state: status }); // `status` in trace lines is the HTTP status
      while (!TERMINAL.has(status)) {
        const left = deadline - performance.now();
        if (left > 0) await this.sleep(Math.min(this.pollSeconds, left / 1000));
        if (performance.now() >= deadline) {
          timeout = "total";
          throw new Retryable(`still ${status} after ${polls} polls`);
        }
        polls += 1;
        const got = await this.poll(id, deadline, performance.now() - createdAt < this.graceSeconds * 1000);
        const seen = typeof got === "string" ? got : String(got.status);
        if (seen !== last) note({ phase: "poll", polls, [typeof got === "string" ? "error" : "state"]: seen });
        last = seen;
        if (typeof got === "string") continue;
        [data, status] = [got, seen];
      }
      done = true;
      if (status === "cancelled") throw new ModelError(`${this.ref}: the response was cancelled`);
      return data;
    } catch (error) {
      let e = error;
      if (timeout) {
        const limit = timeout === "connect" ? this.connect : timeout === "attempt" ? this.attemptLimit : this.total;
        e = Object.assign(new Retryable(`${timeout} timeout after ${limit}s`), { timedOut: true });
      }
      if (e instanceof Retryable) e.accepted = accepted;
      if (e instanceof ModelError && accepted) e.unknownCalls += 1;
      throw e;
    } finally {
      Object.assign(diagnostics, { transport: "background", ...(id ? { id } : {}), polls,
        ...(timeout ? { timeout } : {}) });
      if (id && !done) await this.cancel(id, note);
      if (id) inFlight.delete(id);
    }
  }

  /** One GET of a background response: the response, or why this poll failed (tried again at the next tick). A
   * status that no retry can fix (401; 404 once the store has had `young` time to catch up) is a ModelError. */
  private async poll(id: string, deadline: number, young: boolean): Promise<Record<string, unknown> | string> {
    const abort = new AbortController();
    const left = Math.max(0, Math.min(deadline - performance.now(), this.connect * 1000));
    const timer = setTimeout(() => abort.abort(), left);
    try {
      const r = await this.fetch(`${this.baseUrl}/responses/${id}`, { signal: abort.signal,
        headers: { authorization: `Bearer ${this.apiKey}` } });
      if (r.status !== 200) {
        const message = `HTTP ${r.status}: ${(await r.text().catch(() => "")).slice(0, 200)}`;
        if (RETRY_STATUS.has(r.status) || (r.status === 404 && young)) return message;
        throw refused(this.ref, `poll: ${message}`, r.status);
      }
      const body: unknown = await r.json();
      return isObject(body) ? body : "unreadable poll reply";
    } catch (e) {
      if (e instanceof ModelError) throw e;
      return errorName(e);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }

  /** Best effort: its failure is only traced. True when the provider took the cancel. */
  private async cancel(id: string, note: (line: Record<string, unknown>) => void): Promise<boolean> {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), CANCEL_SECONDS * 1000);
    try {
      const r = await this.fetch(`${this.baseUrl}/responses/${id}/cancel`, { method: "POST", signal: abort.signal,
        headers: { authorization: `Bearer ${this.apiKey}` } });
      note({ phase: "cancel", http: r.status });
      return r.ok;
    } catch (e) {
      note({ phase: "cancel", error: errorName(e) });
      return false;
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  }
}

/** Usage of a Responses reply, with cached input counted apart. */
function responsesUsage(data: Record<string, unknown>): Usage {
  const u = isObject(data.usage) ? data.usage : {};
  const details = isObject(u.input_tokens_details) ? u.input_tokens_details : {};
  const cached = Number(details.cached_tokens ?? 0) || 0;
  return { input: Number(u.input_tokens ?? 0) - cached, output: Number(u.output_tokens ?? 0), cacheRead: cached,
    cacheWrite: 0 };
}

/** arnx's agent history (Anthropic-shaped: user text, tool_result blocks, and each assistant turn's raw content) as
 * Responses input items. An assistant turn's raw content is the output items this agent received, sent back as is. */
export function responsesInput(messages: Message[]): unknown[] {
  const input: unknown[] = [];
  for (const m of messages) {
    if (m.role === "assistant") {
      input.push(...(Array.isArray(m.content) ? m.content : [{ role: "assistant", content: String(m.content) }]));
    } else if (typeof m.content === "string") {
      input.push({ role: "user", content: m.content });
    } else {
      for (const b of Array.isArray(m.content) ? m.content as Record<string, unknown>[] : []) {
        if (b.type === "tool_result") {
          input.push({ type: "function_call_output", call_id: String(b.tool_use_id),
            output: `${b.is_error ? "error: " : ""}${typeof b.content === "string" ? b.content : JSON.stringify(b.content)}` });
        } else if (b.type === "text") {
          input.push({ role: "user", content: String(b.text ?? "") });
        }
      }
    }
  }
  return input;
}

/** The reviewer's agent loop over the Responses API (OpenAI, and endpoints that copy it): arnx's tools become functions. The
 * transport (timeouts, retries, cut-off attempts) is ResponsesJson's. */
export class ResponsesAgent implements AgentModel {
  /** The name prices are looked up by (with the OpenAI tier when one is set). */
  readonly model: string;
  readonly provider: string;
  set notice(n: ((message: string) => void) | undefined) {
    this.transport.notice = n;
  }

  constructor(private transport: ResponsesJson, readonly effort: string, private opts: { store?: boolean } = {}) {
    this.model = transport.tier ? `${transport.model}@${transport.tier}` : transport.model;
    this.provider = providerOf(transport.ref);
  }

  async create({ system, tools, messages, maxTokens }: Parameters<AgentModel["create"]>[0]): Promise<Reply> {
    // Without stored responses, reasoning goes back to the model as encrypted content.
    const payload = { model: this.transport.model, stream: true, reasoning: { effort: this.effort },
      ...(this.transport.tier ? { service_tier: this.transport.tier === "fast" ? "priority" : this.transport.tier } : {}),
      ...(this.opts.store === false ? { store: false, include: ["reasoning.encrypted_content"] } : {}),
      instructions: system, input: responsesInput(messages), max_output_tokens: maxTokens,
      ...(tools.length ? { tools: tools.map((t) => ({ type: "function", name: t.name, description: t.description,
        parameters: t.input_schema })) } : {}) };
    const [data, unknown, tries] = await this.transport.post(payload);
    const output = (Array.isArray(data.output) ? data.output : []).filter(isObject);
    const content: Block[] = [];
    let refused = false;
    for (const item of output) {
      if (item.type === "message") {
        for (const part of Array.isArray(item.content) ? item.content.filter(isObject) : []) {
          if (part.type === "output_text") content.push({ type: "text", text: String(part.text ?? "") });
          else if (part.type === "refusal") refused = true;
        }
      } else if (item.type === "function_call") {
        let input: Record<string, unknown> = {};
        try {
          const parsed = JSON.parse(String(item.arguments ?? "{}"));
          if (isObject(parsed)) input = parsed;
        } catch { /* the tool reports the missing arguments to the model */ }
        content.push({ type: "tool_use", id: String(item.call_id), name: String(item.name), input });
      }
    }
    const details = isObject(data.incomplete_details) ? data.incomplete_details : {};
    const stopReason = refused ? "refusal" : content.some((b) => b.type === "tool_use") ? "tool_use"
      : data.status === "incomplete" && details.reason === "max_output_tokens" ? "max_tokens" : "end_turn";
    if (data.status !== "completed" && stopReason === "end_turn") {
      const message = `${this.model}: incomplete response (status ${String(data.status)})`;
      throw Object.assign(new ModelError(message), { tries });
    }
    return { content, stopReason, usage: responsesUsage(data), raw: output, tries,
      ...(unknown ? { unknownCalls: unknown } : {}) };
  }
}

const errorName = (e: unknown) => e instanceof Error ? (e.name === "Error" ? e.message : e.name) : String(e);

/** A status no retry fixes, as the call's error (a refused key says so). */
function refused(ref: string, message: string, status: number): ModelError {
  const e = new ModelError(`${ref}: ${message}`);
  const fault = authFault(status);
  if (fault) e.fault = fault;
  return e;
}

/** The response object of the stream's terminal event (completed, incomplete or failed). */
async function terminalResponse(ref: string, r: Response, onChunk: () => void): Promise<Record<string, unknown>> {
  if (!r.body) throw new Retryable("the stream ended without a terminal event");
  const reader = r.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
  for (;;) {
    let chunk: Awaited<ReturnType<typeof reader.read>>;
    try {
      chunk = await reader.read();
    } catch (e) {
      throw new Retryable(errorName(e));
    }
    if (chunk.done) break;
    if (chunk.value.byteLength) onChunk();
    buffer += decoder.decode(chunk.value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).replace(/\r$/, "");
      buffer = buffer.slice(nl + 1);
      const event = parseEvent(ref, line);
      if (event) return event;
    }
  }
  const event = parseEvent(ref, buffer);
  if (event) return event;
  throw new Retryable("the stream ended without a terminal event");
  } finally {
    // Also cancel malformed/error streams; releasing just the lock would leave their producer running.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

function parseEvent(ref: string, line: string): Record<string, unknown> | null {
  if (!line.startsWith("data:")) return null;
  const data = line.slice(5).trim();
  if (data === "" || data === "[DONE]") return null;
  let event: Record<string, unknown>;
  try {
    event = JSON.parse(data) as Record<string, unknown>;
  } catch {
    throw new ModelError(`${ref}: unreadable stream event`);
  }
  if (["response.completed", "response.incomplete", "response.failed"].includes(String(event.type))) {
    return isObject(event.response) ? event.response : {};
  }
  if (event.type === "error") throw noCredits(providerOf(ref), data) ?? new ModelError(`${ref}: ${String(event.message ?? JSON.stringify(event)).slice(0, 200)}`);
  return null;
}

/** The text of each output message, in order. A reply can hold several messages (an empty draft, then the answer). */
function responsesTexts(data: Record<string, unknown>): string[] {
  if (data.status !== "completed") throw new Error(`incomplete response (status ${String(data.status)})`);
  const texts: string[] = [];
  for (const item of Array.isArray(data.output) ? data.output : []) {
    if (!isObject(item) || item.type !== "message") continue;
    const parts: string[] = [];
    for (const part of Array.isArray(item.content) ? item.content : []) {
      if (!isObject(part) || part.type !== "output_text") throw new Error("the model refused or replied without text");
      parts.push(String(part.text));
    }
    texts.push(parts.join(""));
  }
  return texts;
}

/** The answer among a reply's messages: the last one that is a JSON object. Each message is parsed on its own, so
 * `{…}{…}` from two messages is not read as one broken object. */
export function lastJsonObject(texts: string[]): Record<string, unknown> {
  let error: Error | null = null;
  for (const t of [...texts].reverse()) {
    try {
      const v: unknown = JSON.parse(t);
      if (isObject(v)) return v;
      error = new Error("the reply is not a JSON object");
    } catch (e) {
      error ??= e as Error;
    }
  }
  throw error ?? new Error("the reply has no text");
}

/** The provider a ref names under these settings. */
function providerFor(ref: ModelRef, s: Settings): Provider {
  const p = providerOfRef(s, ref);
  if (!p) throw new SetupRequired(`model ${refString(ref)}: no provider ${ref.provider} (a preset or a ` +
    "[providers.<name>] table in .arnx/config.toml)");
  return p;
}

/** The provider's key and base URL, from the env object arnx was given (never process.env). */
function keys(env: Env, p: Provider): { key: string; url: string } {
  const names = envNames(p);
  const values = names.map((k) => env[k] ?? "");
  const missing = names.filter((_, i) => !values[i]);
  if (missing.length) {
    throw new SetupRequired(`missing ${missing.join(", ")}: export ${missing.length > 1 ? "them" : "it"}, or \`arnx cloud on\``);
  }
  return { key: values[0]!, url: p.url ?? values[1]! };
}

/** arnx's effort in the provider's words (a table's \`effort\`, such as "high" for "medium"); a role's own effort is sent as is. */
const vendorEffort = (p: Provider, effort: string): string => p.effort?.[effort] ?? effort;

/** A Messages client's options for the provider at `url`: the anthropic preset needs none (the SDK's defaults). */
const messagesOpts = (p: Provider, url: string): { provider?: string; baseURL?: string } =>
  p.name === "anthropic" && url === ANTHROPIC_URL ? {} : { provider: p.name, baseURL: url };

/** OpenAI's own settings, for the providers that take them: the service tier and the polled background transport. */
function responsesOpts(p: Provider, s: Settings): { tier: string | null; background: boolean } {
  return { tier: p.tier ? s.openaiTier ?? null : null, background: !!p.background && s.openaiTransport !== "stream" };
}

/** The models of `refs` arnx has no price for: `ref` as usage names it, `name` as [prices] would (with the OpenAI tier
 * when one applies). They run with their cost unknown, their calls counted as billed with unknown usage. */
export function unpricedModels(s: Settings, refs: (ModelRef | null | undefined)[]): { ref: string; name: string }[] {
  const prices = allPrices(s), out = new Map<string, string>();
  for (const r of refs) {
    if (!r) continue;
    const p = providerOfRef(s, r);
    const tier = p && p.api !== "messages" ? responsesOpts(p, s).tier : null;
    const name = tier ? `${r.model}@${tier}` : r.model;
    if (!prices[name]) out.set(refString(r), name);
  }
  return [...out].map(([ref, name]) => ({ ref, name }));
}

/** Said once when a command runs models arnx has no price for. */
export function unpricedNote(models: { name: string }[]): string | null {
  if (!models.length) return null;
  const names = models.map((m) => m.name).join(", "), it = models.length === 1 ? "it" : "them";
  return `No price for ${names}: cost unknown, and the budget cap does not cover ${it} ([prices] in .arnx/config.toml)`;
}

/** A second opinion from `first`, and from `second` for any call `first` fails (an error or no reply in time). Its
 * per-model use is kept in `uses`; `lastModel` names the model that gave the latest reply. */
export class FallbackJson implements JsonModel {
  readonly ref: string;
  trace?: Trace;
  notice?: (message: string) => void;
  readonly uses: ModelUse[];
  lastModel = "";

  constructor(private first: JsonModel, private second: JsonModel) {
    this.ref = first.ref;
    this.uses = [newUse(first.ref), newUse(second.ref)];
  }

  async completeJson(system: string, user: string, schema: Record<string, unknown>): Promise<JsonReply> {
    const models = [this.first, this.second];
    for (const [i, m] of models.entries()) {
      // Set once, never cleared: calls run in parallel, and each reply names the model that gave it.
      const outer = this.trace;
      m.trace = outer ? (line) => outer({ model: m.ref, ...line }) : undefined;
      m.notice = this.notice;
      try {
        const reply = await m.completeJson(system, user, schema);
        tally(this.uses[i]!, reply[1], reply[2], reply[3]);
        this.lastModel = m.ref;
        return [reply[0], reply[1], reply[2], reply[3], m.ref];
      } catch (e) {
        if (!survivable(e)) throw e;
        if (e.costUsd > 0 || e.usage) tally(this.uses[i]!, e.costUsd, e.usage, e.unknownCalls);
        else this.uses[i]!.unknownCalls += e.unknownCalls;
        if (i === models.length - 1) throw e;
        outer?.({ model: m.ref, outcome: "fallback", error: e.message.slice(0, 300) });
        this.notice?.(`${m.ref} gave no verdict (${e.message.slice(0, 80)}); asking ${models[i + 1]!.ref}`);
      }
    }
    throw new ModelError("no model replied");
  }
}

/** Agent calls (setup, hunts, answer rounds) run longer than a verdict: up to 16k tokens of thinking and tools. */
const AGENT_TOTAL = 600, AGENT_ATTEMPT = 300;

/** The reviewer's agent model (or any role run as one: `s.reviewer` names it), from its provider's data. */
export function makeAgentModel(s: Settings, env: Env): AgentModel {
  const ref = s.reviewer, prices = allPrices(s);
  const timing = { totalSeconds: AGENT_TOTAL, attemptSeconds: AGENT_ATTEMPT };
  const p = providerFor(ref, s);
  const { key, url } = keys(env, p);
  const effort = vendorEffort(p, s.effort);
  if (p.api === "messages") {
    return new AnthropicAgent(ref.model, effort, key, undefined, messagesOpts(p, url));
  }
  const { tier, background } = responsesOpts(p, s);
  return new ResponsesAgent(new ResponsesJson(ref, url, key, effort, prices,
    { tier, background, ...(p.store !== undefined ? { store: p.store } : {}), ...timing }), effort,
    p.store !== undefined ? { store: p.store } : {});
}

/** `effort`, when given, is sent as is (a role's own effort, such as second_hunter_effort); else `s.effort`, in the
 * provider's words. */
export function makeJsonModel(ref: ModelRef, s: Settings, env: Env,
                              opts: { attemptSeconds?: number; timeoutAttempts?: number; effort?: string } = {}): JsonModel {
  const prices = allPrices(s);
  const { effort: own, ...timing } = opts;
  const p = providerFor(ref, s);
  const { key, url } = keys(env, p);
  const effort = own ?? vendorEffort(p, s.effort);
  if (p.api === "messages") {
    return new AnthropicJson(ref, new AnthropicAgent(ref.model, effort, key, undefined,
      { ...(timing.timeoutAttempts ? { timeoutAttempts: timing.timeoutAttempts } : {}), ...messagesOpts(p, url) }),
      prices);
  }
  const { tier, background } = responsesOpts(p, s);
  return new ResponsesJson(ref, url, key, effort, prices,
    { tier, background, ...(p.store !== undefined ? { store: p.store } : {}), ...timing });
}

/** The challenger: a second opinion per finding, with the configured fallback for any call the first model fails.
 * Both give up on a stalled attempt after VERDICT_ATTEMPT_TIMEOUT; the first model, when a fallback stands behind it,
 * after one timed-out attempt, so the fallback is asked at once. Without a fallback it retries as usual. */
export function makeChallenger(s: Settings, env: Env): JsonModel {
  const verdict = { attemptSeconds: VERDICT_ATTEMPT_TIMEOUT };
  const first = makeJsonModel(s.challenger, s, env, s.challengerFallback ? { ...verdict, timeoutAttempts: 1 } : verdict);
  return s.challengerFallback ? new FallbackJson(first, makeJsonModel(s.challengerFallback, s, env, verdict)) : first;
}

/** The configured second hunter, with its own effort when second_hunter_effort is set (a model that reasons
 * long at arnx's default effort can run past the attempt limit on a hunt). */
export function makeSecondHunter(s: Settings, env: Env): JsonModel | undefined {
  if (!s.secondHunter) return undefined;
  return makeJsonModel(s.secondHunter, s, env, s.secondHunterEffort ? { effort: s.secondHunterEffort } : {});
}
