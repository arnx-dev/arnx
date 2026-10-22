// Telemetry: after setup, review, accept and check, one line of anonymous counts to arnx's endpoint. Off unless
// `telemetry = true` in .arnx/config.toml (the user edits it); ARNX_TELEMETRY=0 or DO_NOT_TRACK=1 turns it off anyway.
// The only thing kept on the machine is a random install id, in the user's config directory. Payloads are
// allow-listed (SCHEMA): whole numbers, booleans and enumerated words, plus the install id, version, OS, CPU type and
// time; anything else is not sent at all. Sending never blocks or fails a command: at most SEND_TIMEOUT_MS, one try,
// every error swallowed.
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import type { AcceptResult } from "./accept";
import type { ProjectCheck } from "./check";
import { exitCode, type Marks, type Review } from "./report";
import { isCustom, resolveProvider } from "./providers";
import type { Env, ModelRef, Settings } from "./settings";
import { VERSION } from "./version";

export const TELEMETRY_URL = "https://api.arnx.dev/v1/telemetry";
/** True: TELEMETRY_URL is live. False would send nothing, whatever the config says (tests set it). */
export const TELEMETRY_OPEN = true;
export const SEND_TIMEOUT_MS = 2000;
export const TELEMETRY_EVENTS = ["setup", "review", "accept", "check"] as const;
export type TelemetryEvent = typeof TELEMETRY_EVENTS[number];

const LANGUAGES = ["python", "typescript", "javascript", "rust", "csharp", "other"] as const;
const EFFORTS = ["low", "medium", "high"] as const;
const PROVIDERS = ["anthropic", "openai", "river", "arnx", "other"] as const;

/** A field's shape: a whole number ≥ 0, a boolean, one word of a list, a set of words of a list, or an object. */
type Field = "int" | "bool" | { one: readonly string[] } | { some: readonly string[] } | { object: Record<string, Field> };
const INT = "int", BOOL = "bool";

/** Everything telemetry may send under `data`, per event. The server refuses any other field, and so does arnx. */
export const SCHEMA: Record<TelemetryEvent, Record<string, Field>> = {
  setup: { projects: INT, languages: { some: LANGUAGES }, approved: BOOL, cost_micro_usd: INT, seconds: INT },
  review: { languages: { some: LANGUAGES }, projects: INT, files_changed: INT, diff_kb: INT, effort: { one: EFFORTS },
    providers: { some: PROVIDERS }, findings: INT, confirmed: INT, disputed: INT, unjudged: INT, questions: INT,
    tests_written: INT, passed: INT, flaky: INT, errors: INT, suspects: INT, cost_micro_usd: INT, unknown_calls: INT,
    seconds: INT, exit_code: INT, before: { object: { regression: INT, pre_existing: INT, new_code: INT, changed: INT,
      unknown: INT } } },
  accept: { real: INT, intended: INT, noise: INT, unmarked: INT, chosen: INT, defaulted: INT, answers: INT,
    kept_tests: INT },
  check: { tests: INT, passed: INT, failed: INT, skipped: INT, seconds: INT, exit_code: INT },
};

const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

function fits(f: Field, v: unknown): boolean {
  if (f === INT) return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
  if (f === BOOL) return typeof v === "boolean";
  if ("one" in f) return typeof v === "string" && f.one.includes(v);
  if ("some" in f) return Array.isArray(v) && v.every((x) => typeof x === "string" && f.some.includes(x)) &&
    new Set(v).size === v.length;
  return isRecord(v) && fitsObject(f.object, v);
}

function fitsObject(fields: Record<string, Field>, v: Record<string, unknown>): boolean {
  const keys = Object.keys(v);
  return keys.length === Object.keys(fields).length && keys.every((k) => k in fields && fits(fields[k]!, v[k]));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** True when the whole body is what the schema allows, and nothing else. */
export function conforms(body: Record<string, unknown>): boolean {
  const top = ["schema", "install_id", "arnx_version", "os", "arch", "event", "at", "data"];
  if (Object.keys(body).length !== top.length || !top.every((k) => k in body)) return false;
  const event = body.event as TelemetryEvent;
  return body.schema === 1 && typeof body.install_id === "string" && UUID4.test(body.install_id) &&
    body.arnx_version === VERSION && typeof body.os === "string" && typeof body.arch === "string" &&
    typeof body.at === "string" && ISO.test(body.at) && TELEMETRY_EVENTS.includes(event) && isRecord(body.data) &&
    fitsObject(SCHEMA[event], body.data);
}

// --- the install id, per machine; the setting, per repository -------------------------------------------------------

/** `$XDG_CONFIG_HOME/arnx/telemetry.json`, else `~/.config/arnx/telemetry.json` (macOS included), from the
 * environment arnx was given; null when it names neither (then nothing is sent). */
export function telemetryPath(env: Env): string | null {
  const xdg = env.XDG_CONFIG_HOME;
  if (xdg && isAbsolute(xdg)) return join(xdg, "arnx", "telemetry.json");
  return env.HOME && isAbsolute(env.HOME) ? join(env.HOME, ".config", "arnx", "telemetry.json") : null;
}

/** The install id kept at `path`, or null. */
function readId(path: string): string | null {
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as unknown;
    return isRecord(d) && typeof d.install_id === "string" && UUID4.test(d.install_id) ? d.install_id : null;
  } catch {
    return null;
  }
}

/** This machine's install id: the one kept, or a random one made and kept now. */
export function installId(env: Env): string {
  const path = telemetryPath(env);
  if (!path) throw new Error("no config directory: set HOME or XDG_CONFIG_HOME");
  const kept = readId(path);
  if (kept) return kept;
  const id = randomUUID();
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ install_id: id }, null, 2) + "\n");
  return id;
}

/** The environment variable that turns telemetry off whatever the config says: ARNX_TELEMETRY=0 (or false, off, no),
 * or DO_NOT_TRACK set to anything but empty, 0 or false. */
export function forcedOff(env: Env): string | null {
  const arnx = (env.ARNX_TELEMETRY ?? "").trim().toLowerCase();
  if (["0", "false", "off", "no"].includes(arnx)) return "ARNX_TELEMETRY";
  const dnt = (env.DO_NOT_TRACK ?? "").trim().toLowerCase();
  if (dnt && dnt !== "0" && dnt !== "false") return "DO_NOT_TRACK";
  return null;
}

export interface TelemetryStatus { path: string | null; configured: boolean; forced: string | null; on: boolean }

/** On only when the repository's config turns it on (`configured`), no environment variable turns it off, and there is a
 * config directory to keep the install id in. */
export function telemetryStatus(env: Env, configured = false): TelemetryStatus {
  const path = telemetryPath(env);
  const forced = forcedOff(env);
  return { path, configured, forced, on: !forced && configured && path !== null };
}

export const telemetryUrl = (env: Env) => env.ARNX_TELEMETRY_URL?.trim() || TELEMETRY_URL;

/** One line for `arnx doctor`. */
export function telemetryLine(st: TelemetryStatus, open = TELEMETRY_OPEN): string {
  if (!open) return "Telemetry: disabled in this build";
  if (st.forced) return `Telemetry: disabled (${st.forced} is set)`;
  if (!st.configured) return "Telemetry: off (telemetry = true in .arnx/config.toml turns it on)";
  if (!st.path) return "Telemetry: disabled (no config directory: HOME and XDG_CONFIG_HOME are unset)";
  return "Telemetry: on (telemetry = false in .arnx/config.toml turns it off)";
}

// --- sending -----------------------------------------------------------------------------------------------------------

/** Posts a body; the response is not read. Injectable so tests never reach the network. */
export type Sender = (url: string, body: string, signal: AbortSignal) => Promise<unknown>;

export const fetchSender: Sender = async (url, body, signal) => {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body, signal });
  await res.body?.cancel().catch(() => undefined);
};

/** When telemetry is on, build the event's data and send it: at most `timeoutMs`, once, every error
 * swallowed. Otherwise `data` is never called and nothing happens. `open` defaults to TELEMETRY_OPEN (tests set it). */
export async function reportTelemetry(env: Env, event: TelemetryEvent, data: () => Record<string, unknown>,
                                      o: { sender?: Sender; timeoutMs?: number; open?: boolean; configured?: boolean }
                                        = {}): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  if (!(o.open ?? TELEMETRY_OPEN)) return;
  try {
    const st = telemetryStatus(env, o.configured ?? false);
    if (!st.on) return;
    const body = { schema: 1, install_id: installId(env), arnx_version: VERSION, os: process.platform,
      arch: process.arch, event, at: new Date().toISOString(), data: data() };
    if (!conforms(body)) return;
    const ctrl = new AbortController();
    const out = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        ctrl.abort();
        resolve();
      }, o.timeoutMs ?? SEND_TIMEOUT_MS);
    });
    const sent = Promise.resolve().then(() => (o.sender ?? fetchSender)(telemetryUrl(env), JSON.stringify(body),
      ctrl.signal)).then(() => undefined, () => undefined);
    await Promise.race([sent, out]);
  } catch {
    // telemetry never fails a command
  } finally {
    clearTimeout(timer);
  }
}

// --- what each event sends -------------------------------------------------------------------------------------------

/** A whole number ≥ 0 (NaN and negatives are 0). */
const int = (x: number) => (Number.isFinite(x) && x > 0 ? Math.round(x) : 0);
const micro = (usd: number) => int(usd * 1_000_000);

/** Words of `allowed`, in its order, each once; anything else becomes "other" when the list has it. */
function words(values: readonly string[], allowed: readonly string[]): string[] {
  const seen = new Set(values.map((v) => (allowed.includes(v) ? v : "other")));
  return allowed.filter((a) => seen.has(a));
}

export const languagesOf = (langs: readonly string[]) => words(langs, LANGUAGES);
/** The providers of `refs` as telemetry's words: a preset by its name, any provider of the user's own (a table of
 * theirs, or a preset sent elsewhere) as "other", never its name or URL. */
export const providersOf = (refs: (ModelRef | undefined)[], s?: Pick<Settings, "providers">) =>
  words(refs.flatMap((r) => {
    if (!r) return [];
    const p = resolveProvider(r.provider, s?.providers);
    return [p && !isCustom(p) ? r.provider : "other"];
  }), PROVIDERS);

/** The configured effort as low / medium / high: "none" and "minimal" count as low, "xhigh" and "max" as high, any
 * other word as medium. */
export function effortOf(effort: string): string {
  const e = effort.trim().toLowerCase();
  if ((EFFORTS as readonly string[]).includes(e)) return e;
  return ["none", "minimal"].includes(e) ? "low" : ["xhigh", "max"].includes(e) ? "high" : "medium";
}

export function setupData(o: { languages: string[]; approved: boolean; costUsd: number; seconds: number }) {
  return { projects: o.languages.length, languages: languagesOf(o.languages), approved: o.approved,
    cost_micro_usd: micro(o.costUsd), seconds: int(o.seconds) };
}

/** `languages`: of the reviewed projects; `diffBytes`: the change's diff, sent in KB rounded up. */
export function reviewData(review: Review, o: { settings: Settings; languages: string[]; diffBytes: number }) {
  const s = o.settings;
  const f = review.findings;
  const verdict = (v: string) => f.filter((x) => x.verdict === v).length;
  const before = (status: string) => f.filter((x) => x.before?.status === status).length;
  return { languages: languagesOf(o.languages), projects: review.projects.length, files_changed: int(review.filesChanged),
    diff_kb: int(Math.ceil(o.diffBytes / 1024)), effort: s.cloud?.models ? s.cloud.effort : effortOf(s.effort),
    providers: s.cloud?.models ? ["arnx"]
      : providersOf([s.reviewer, s.challenger, s.challengerFallback, s.hunter, s.secondHunter], s),
    findings: f.length, confirmed: verdict("confirmed"), disputed: verdict("disputed"),
    unjudged: f.length - verdict("confirmed") - verdict("disputed"), questions: review.questions.length,
    tests_written: int(review.testsWritten), passed: int(review.passed), flaky: review.flaky.length,
    errors: review.errors.length, suspects: review.suspects?.length ?? 0, cost_micro_usd: micro(review.costUsd),
    unknown_calls: int(review.usage.reduce((n, u) => n + (u.unknownCalls ?? 0), 0)), seconds: int(review.seconds),
    exit_code: exitCode(review),
    before: { regression: before("regression"), pre_existing: before("pre-existing"), new_code: before("new-code"),
      changed: before("changed"), unknown: before("unknown") } };
}

/** Marks over every finding of the review; `chosen` / `defaulted` count each finding's mark source (an unmarked
 * finding too: clearing a pre-filled mark is a choice). `answers`: questions answered in review.md. */
export function acceptData(r: Pick<AcceptResult, "review" | "sources"> & { marks: Marks }, keptTests: number) {
  const ids = r.review.findings.map((f) => f.id);
  const mark = (m: string) => ids.filter((id) => r.marks.findings[id] === m).length;
  const source = (s: string) => ids.filter((id) => r.sources[id] === s).length;
  // A rewrite mark counts as real: the bug is real, only its test was wrong.
  return { real: mark("real") + mark("rewrite"), intended: mark("intended"), noise: mark("noise"),
    unmarked: ids.filter((id) => !r.marks.findings[id]).length, chosen: source("chosen"), defaulted: source("default"),
    answers: r.review.questions.filter((_q, i) => `Q${i + 1}` in r.marks.answers).length, kept_tests: int(keptTests) };
}

export function checkData(results: ProjectCheck[], code: number, seconds: number) {
  const passed = results.reduce((n, r) => n + r.passed.length, 0);
  const failed = results.reduce((n, r) => n + r.failed.length, 0);
  const skipped = results.reduce((n, r) => n + r.skipped, 0);
  return { tests: passed + failed + skipped, passed, failed, skipped, seconds: int(seconds), exit_code: int(code) };
}
