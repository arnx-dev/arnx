// arnx cloud's HTTP side, for arnx models (the arnx cloud API, v1): the account token from a device login
// (RFC 8628), kept per user and machine, never in the repository; the calls, as JSON or as server-sent events with
// progress lines; and what an error answer means for the user: 402 is a top-up and `unsupported_cli` an update of arnx
// (exit 3), an unreachable service or a 503 says arnx cloud is unavailable (exit 2) and, when the user's own keys are
// set, how to use them instead. A network failure does not prove arnx cloud is closed: only its explicit `not_open`
// answer says so (exit 2).
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { ArnxError, SetupRequired } from "./errors";
import { CLOUD_URL, type Env, missingKeys, type ModelsMode, type Settings } from "./settings";
import { VERSION } from "./version";

/** Waits before each retry of a call that may be sent again (network failure, 503, 429). */
export const RETRY_DELAYS_MS = [2_000, 8_000];
/** Longest one call may take, its stream included (a hunt answers in minutes). */
export const CALL_SECONDS = 900;
/** Longest the wait for one 429's Retry-After. */
const MAX_RETRY_AFTER_S = 30;

export type Component = "api" | "brain" | "runner";

/** An arnx cloud error answer (the contract's flat Error body). */
export interface ApiError { code: string; message: string; status?: number; request_id?: string; component?: Component;
  balance_micro_usd?: number; needed_micro_usd?: number; topup_url?: string; retry_after?: number;
  expected_turn?: number; problems?: string[]; min_cli_version?: string }

/** Dollars from micro-dollars, for messages: "$1.25", "-$0.25". */
export const usd = (micro: number): string => `${micro < 0 ? "-" : ""}$${(Math.abs(micro) / 1_000_000).toFixed(2)}`;

/** arnx cloud answered with an error the run cannot get past (exit 2). */
export class CloudError extends ArnxError {
  override name = "CloudError";
  constructor(message: string, readonly status: number, readonly body: ApiError | null, readonly component: Component) {
    super(message);
  }
}

/** arnx cloud could not be reached, or a part of it is down (exit 2). */
export class CloudUnavailable extends ArnxError {
  override name = "CloudUnavailable";
  constructor(message: string, readonly component: Component) {
    super(message);
  }
}

/** arnx cloud answered that access is not open (code `not_open`): the waitlist (exit 2, as unreachable). */
export class CloudNotOpen extends CloudUnavailable {
  override name = "CloudNotOpen";
}

export const NOT_OPEN = "arnx cloud is not open yet. Your own keys work today (`--local`); join the waitlist at " +
  "https://arnx.dev.";
/** Nothing of arnx cloud's answered: no connection, or something else at the default address. */
export const UNAVAILABLE = (url: string) =>
  `arnx cloud unavailable: could not connect to ${url}. Check your connection or try again later.`;
/** The call was sent and its answer did not come: it timed out, or its stream ended before the result. */
export const LOST = (url: string) =>
  `arnx cloud unavailable: no answer from ${url}. Check your connection or try again later.`;

/** How to get a newer arnx, as the README installs it. */
export const UPDATE = "Update it: npm install -g @arnx-dev/arnx, or download the latest binary from " +
  "https://github.com/arnx-dev/arnx/releases/latest";

/** A call whose answer started (or timed out) and did not finish: the connection was there. */
class Lost extends Error {}

// --- credentials, per person and machine -------------------------------------------------------------------------------

export interface Credentials { url: string; token: string }

/** `$XDG_CONFIG_HOME/arnx/credentials.json`, else `~/.config/arnx/credentials.json`, as telemetry.ts finds its file;
 * null when the environment names neither. */
export function credentialsPath(env: Env): string | null {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "arnx", "credentials.json");
  return env.HOME && isAbsolute(env.HOME) ? join(env.HOME, ".config", "arnx", "credentials.json") : null;
}

export function readCredentials(env: Env): Credentials | null {
  const path = credentialsPath(env);
  if (!path) return null;
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as Partial<Credentials>;
    return typeof d.url === "string" && typeof d.token === "string" && d.token ? { url: d.url, token: d.token } : null;
  } catch {
    return null;
  }
}

/** The token for `url`, or null when this machine is not logged in there. */
export function tokenFor(env: Env, url: string): string | null {
  const c = readCredentials(env);
  return c && c.url === url ? c.token : null;
}

/** Written readable by this user only (0600), never readable on the way: a 0600 file renamed over the old one. The
 * directory is 0700 when arnx makes it, and made so when others can write to it. */
export function writeCredentials(env: Env, c: Credentials): string {
  const path = credentialsPath(env);
  if (!path) throw new ArnxError("no config directory to keep the login in: set HOME or XDG_CONFIG_HOME");
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (statSync(dir).mode & 0o022) {
    try {
      chmodSync(dir, 0o700);
    } catch {
      throw new ArnxError(`${dir} is writable by others and arnx cannot change that; nothing was saved`);
    }
  }
  const tmp = `${path}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(c, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  return path;
}

/** True when there was a login to delete. */
export function deleteCredentials(env: Env): boolean {
  const path = credentialsPath(env);
  if (!path || readCredentials(env) === null) return false;
  rmSync(path, { force: true });
  return true;
}

// --- calls ---------------------------------------------------------------------------------------------------------------

export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface ClientOptions {
  token?: string | null;
  fetch?: Fetch;
  /** The waits before retries (tests make them short). */
  delays?: number[];
  sleep?: (ms: number) => Promise<void>;
  /** What the user can do instead when arnx cloud is unreachable (one line, or ""). */
  hint?: () => string;
}

export interface CallOptions {
  /** Ask for server-sent events: `progress` lines go to `onProgress`, the `result` is the answer. */
  stream?: boolean;
  onProgress?: (p: { message: string; phase?: string; project?: string }) => void;
  /** For a create call: the same key on every retry, so a retried create is the first one. */
  idempotencyKey?: string;
  /** Whether the call may be sent again after a network failure (a 503 or 429 is always retried: nothing ran). */
  retry?: boolean;
  /** At most this many retries (default: one per wait in the client's delays). */
  retries?: number;
  /** The part of arnx cloud that serves the call, named when it fails without saying. */
  component?: Component;
}

/** One HTTP answer: its status and body (an Error body for status 400 and up); `notJson` when the body was not JSON
 * (then `body` is a malformed_answer Error made here). */
export interface Answer { status: number; body: unknown; headers: Headers; notJson?: true }

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The component a path belongs to. */
export function componentOf(path: string): Component {
  if (path.startsWith("/v1/sessions")) return "runner";
  return /^\/v1\/(reviews|answers|setup)\b/.test(path) ? "brain" : "api";
}

/** An answer that comes from arnx cloud: one of its Error bodies, or a status below 400 with a JSON body (or none). A
 * parked domain or a proxy in front of nothing answers 404, 5xx or HTML. */
const fromArnx = (a: Answer): boolean => !a.notJson &&
  (a.status < 400 || isObject(a.body) && typeof a.body.code === "string");

export class CloudClient {
  readonly fetch: Fetch;
  /** True once arnx cloud has answered this client (until then, a non-arnx answer at CLOUD_URL is no answer). */
  private answered = false;
  constructor(readonly url: string, private readonly o: ClientOptions = {}) {
    this.fetch = o.fetch ?? ((u, init) => fetch(u, init));
  }

  /** Nothing of arnx cloud's has answered yet, at the default address (an ARNX_CLOUD_URL or `[cloud] url` is a
   * developer's server: its failures stay as they are). */
  private get unopened(): boolean {
    return !this.answered && this.url === CLOUD_URL;
  }

  /** One request, retried as the contract allows; the answer whatever its status, except that an unreachable service
   * throws CloudUnavailable. */
  async send(method: string, path: string, body?: unknown, c: CallOptions = {}): Promise<Answer> {
    const component = c.component ?? componentOf(path);
    const delays = (this.o.delays ?? RETRY_DELAYS_MS).slice(0, Math.max(0, c.retries ?? Infinity));
    const sleep = this.o.sleep ?? wait;
    for (let attempt = 0; ; attempt++) {
      let answer: Answer | null = null, failure: string;
      try {
        answer = await this.once(method, path, body, c);
        if (fromArnx(answer)) this.answered = true;
        else if (this.unopened) throw this.unreachable(component, "");
        if (isObject(answer.body) && answer.body.code === "not_open") return answer;
        if (answer.status !== 503 && answer.status !== 429) return answer;
        const e = isObject(answer.body) ? answer.body as unknown as ApiError : null;
        failure = e?.message ?? `HTTP ${answer.status}`;
        if (attempt >= delays.length) {
          if (answer.status === 429) return answer;
          throw this.unreachable(e?.component ?? component, failure, true);
        }
        const after = Number(answer.headers.get("retry-after") ?? e?.retry_after ?? NaN);
        await sleep(Number.isFinite(after) ? Math.min(after, MAX_RETRY_AFTER_S) * 1000 : delays[attempt]!);
        continue;
      } catch (e) {
        if (e instanceof CloudUnavailable || e instanceof CloudError) throw e;
        failure = e instanceof Lost || e instanceof Error && e.name === "TimeoutError" ? "lost" : "connect";
        if (c.retry === false || attempt >= delays.length) throw this.unreachable(component, failure);
        await sleep(delays[attempt]!);
      }
    }
  }

  /** One request and its answer; a streamed answer is read to its `result` (or `error`) event. */
  private async once(method: string, path: string, body: unknown, c: CallOptions): Promise<Answer> {
    const headers: Record<string, string> = { accept: c.stream ? "text/event-stream" : "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.o.token) headers.authorization = `Bearer ${this.o.token}`;
    if (c.idempotencyKey) headers["idempotency-key"] = c.idempotencyKey;
    const res = await this.fetch(this.url + path, { method, headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(CALL_SECONDS * 1000) });
    if ((res.headers.get("content-type") ?? "").includes("text/event-stream")) {
      return readStream(res, c).catch((e: unknown) => {
        throw new Lost(e instanceof Error ? e.message : String(e));
      });
    }
    const text = await res.text();
    let parsed: unknown = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = { code: "malformed_answer", message: `arnx cloud answered ${res.status} with a body that is not JSON` };
      return { status: res.status, body: parsed, headers: res.headers, notJson: true };
    }
    return { status: res.status, body: parsed, headers: res.headers };
  }

  /** The 2xx body of a call; any other answer is thrown as what it means for the user (see `failure`). */
  async call<T>(method: string, path: string, body?: unknown, c: CallOptions = {}): Promise<T> {
    const a = await this.send(method, path, body, c);
    if (a.status >= 200 && a.status < 300) return a.body as T;
    throw this.failure(a, c.component ?? componentOf(path));
  }

  /** An error answer as the error the CLI stops with. */
  failure(a: Answer, component: Component): ArnxError {
    const e: ApiError = isObject(a.body) && typeof a.body.code === "string" ? a.body as unknown as ApiError
      : { code: "unknown", message: `HTTP ${a.status}` };
    const part = e.component ?? component;
    if (e.code === "not_open") return new CloudNotOpen(NOT_OPEN, part);
    if (e.code === "insufficient_credits" || a.status === 402) {
      return new SetupRequired(`${e.message} Balance ${usd(e.balance_micro_usd ?? 0)}; ${usd(e.needed_micro_usd ?? 0)} ` +
        `more lets this start. Top up at ${e.topup_url ?? "https://arnx.dev/credits"} (\`arnx credits\` shows the ` +
        "balance); `arnx review --resume` continues an interrupted review after a top-up");
    }
    if (e.code === "unsupported_cli") {
      const needs = e.min_cli_version ? `arnx ${e.min_cli_version} or later` : "a newer arnx";
      return new SetupRequired(`arnx cloud needs ${needs} (this is ${VERSION}). ${UPDATE}`);
    }
    if (a.status === 401) {
      return new SetupRequired(`arnx cloud refused the login (${e.message}); run \`arnx login\``);
    }
    if (a.status === 503) return this.unreachable(part, e.message, true);
    if (a.status === 500) {
      return new CloudError(`arnx cloud ${part} failed on its side${e.request_id ? ` (request ${e.request_id})` : ""}: ` +
        e.message, a.status, e, part);
    }
    const problems = e.problems?.length ? ` (${e.problems.slice(0, 3).join("; ")})` : "";
    return new CloudError(`arnx cloud ${part}: ${e.message}${problems} [${e.code}]`, a.status, e, part);
  }

  /** `down`: arnx cloud said a part of it is down (a 503, `why` its message); else no connection (`why` "connect", or
   * nothing of arnx cloud's answered) or no answer to a call sent ("lost"). */
  private unreachable(component: Component, why: string, down = false): CloudUnavailable {
    const hint = this.o.hint?.() ?? "";
    const line = down ? `arnx cloud unavailable: its ${component} at ${this.url} is down (${why.slice(0, 200)}). ` +
      "Try again later." : why === "lost" ? LOST(this.url) : UNAVAILABLE(this.url);
    return new CloudUnavailable(hint ? `${line}\n${hint}` : line, component);
  }
}

/** Reads a text/event-stream answer: progress lines as they come, then the `result` (status 200) or the `error`
 * (its own status). A stream that ends without either is a network failure. */
async function readStream(res: Response, c: CallOptions): Promise<Answer> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  const take = (block: string): Answer | null => {
    let event = "message";
    const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
    }
    if (!data.length) return null;
    const parsed = JSON.parse(data.join("\n")) as unknown;
    if (event === "progress" && isObject(parsed) && typeof parsed.message === "string") {
      c.onProgress?.(parsed as { message: string; phase?: string; project?: string });
      return null;
    }
    if (event === "result") return { status: 200, body: parsed, headers: res.headers };
    if (event === "error") {
      const status = isObject(parsed) && typeof parsed.status === "number" ? parsed.status : 500;
      return { status, body: parsed, headers: res.headers };
    }
    return null;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (value) buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, "\n");
    let at: number;
    while ((at = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, at);
      buf = buf.slice(at + 2);
      const answer = take(block);
      if (answer) {
        await reader.cancel().catch(() => {});
        return answer;
      }
    }
    if (done) {
      const answer = buf.trim() ? take(buf) : null;
      if (answer) return answer;
      throw new Error("the answer stream ended before its result");
    }
  }
}

// --- account and login ---------------------------------------------------------------------------------------------------

export interface Account { account_id: string; email?: string; balance_micro_usd: number; held_micro_usd: number;
  topup_url: string }

/** `arnx credits`, in a few lines. `balance_micro_usd` is already what is spendable: the contract keeps the holds of
 * reviews in progress (`held_micro_usd`) out of it. */
export function describeAccount(a: Account): string[] {
  if (a.balance_micro_usd < 0) {
    return [`✗ Outstanding balance: ${usd(-a.balance_micro_usd)} (a review's overage)`,
      "New arnx cloud reviews are paused until you top up.", `Top up: ${a.topup_url}`];
  }
  return [`arnx cloud · ${a.email ?? a.account_id}`, `  Available: ${usd(a.balance_micro_usd)}`,
    ...a.held_micro_usd ? [`  Reserved:  ${usd(a.held_micro_usd)} (reviews in progress)`] : [],
    `Top up: ${a.topup_url}`];
}

export interface LoginDeps {
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  say: (line: string) => void;
}

export interface DeviceLogin { device_code: string; user_code: string; verification_uri: string;
  verification_uri_complete?: string; expires_in: number; interval: number }
export interface DeviceToken { access_token: string; email?: string }

/** The device code ran out before it was confirmed (the server's `expires_in`, or its expired_token). */
export const CODE_EXPIRED = "the code expired; run arnx login again";
/** How long a device code lives when the server does not say. */
const DEFAULT_EXPIRES_S = 900;

/** RFC 8628 device login: show the code and the page, poll until the user confirms it there (waiting `interval`
 * seconds, 5 more after each slow_down) or the code's `expires_in` runs out, and keep the token. Ctrl+C is main's
 * interrupt (exit 130): nothing is saved before the token comes. */
export async function deviceLogin(url: string, env: Env, d: LoginDeps): Promise<{ email: string | null; path: string }> {
  const now = d.now ?? Date.now;
  const sleep = d.sleep ?? wait;
  const client = new CloudClient(url, { ...(d.fetch ? { fetch: d.fetch } : {}), sleep });
  // The device is named by arnx's version and the OS only: the machine's own name is never sent.
  const start = await client.call<DeviceLogin>("POST", "/v1/auth/device",
    { cli_version: VERSION, device_name: `arnx ${VERSION} on ${process.platform}` });
  d.say("Sign in to arnx cloud");
  d.say(`  1. Open: ${start.verification_uri}`);
  d.say(`  2. Enter code: ${start.user_code}`);
  if (start.verification_uri_complete) d.say(`  (or open ${start.verification_uri_complete} to skip step 2)`);
  d.say("Waiting for the browser... (Ctrl+C cancels)");
  const life = Number.isFinite(start.expires_in) && start.expires_in > 0 ? start.expires_in : DEFAULT_EXPIRES_S;
  const deadline = now() + life * 1000;
  let interval = Math.max(1, Number.isFinite(start.interval) ? start.interval : 5);
  for (;;) {
    await sleep(Math.max(0, Math.min(interval * 1000, deadline - now())));
    if (now() >= deadline) throw new ArnxError(CODE_EXPIRED);
    const a = await client.send("POST", "/v1/auth/token", { device_code: start.device_code });
    if (a.status === 200) {
      const t = a.body as DeviceToken;
      const path = writeCredentials(env, { url, token: t.access_token });
      return { email: t.email ?? null, path };
    }
    const code = isObject(a.body) ? String(a.body.code) : "";
    if (code === "authorization_pending") continue;
    if (code === "slow_down") {
      interval += 5;
      continue;
    }
    if (code === "expired_token") throw new ArnxError(CODE_EXPIRED);
    if (code === "access_denied") throw new ArnxError("the login was refused in the browser; nothing was saved");
    throw client.failure(a, "api");
  }
}

/** What a user of arnx models can do while arnx cloud is unreachable: their own keys, when every key the repository's
 * models need is set ("" otherwise). `arnx cloud off` when the file chose arnx cloud, `--local` when a flag or
 * ARNX_MODELS did (the flag beats both). */
export function byokHint(s: Settings, env: Env, mode: ModelsMode): string {
  if (!mode.cloud || missingKeys(s, env).length) return "";
  return mode.from === "file" ? "To use your own keys: arnx cloud off" : "To use your own keys for this run: --local";
}
