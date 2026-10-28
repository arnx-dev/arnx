// User settings in `.arnx/config.toml`: consent, models, budgets. The file holds no secrets; keys come from the
// environment.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { ArnxError, SetupRequired } from "./errors";
import { envNames, PRESETS, type Provider, providerHost, providerLabel, providerNames, parseProviders,
  type ProviderTable, providerToml, resolveProvider } from "./providers";
import { pyFloat, pyJson, pyRepr } from "./util";

export type Env = Record<string, string | undefined>;
/** USD per million tokens: input, output, cache read, cache write. A tiered price adds the prompt size (tokens) above
 * which a request is billed at the four prices after it. */
export type Price = [number, number, number, number] | [number, number, number, number, number, number, number, number,
  number];
export type Prices = Record<string, Price>;

/** The environment variables each built-in provider needs (from PRESETS). */
export const PROVIDER_KEYS: Record<string, readonly string[]> = Object.fromEntries(Object.keys(PRESETS)
  .map((name) => [name, envNames(resolveProvider(name)!)]));
export const REVIEWER = "anthropic:claude-sonnet-5-5";
export const OPENAI_CHALLENGER = "openai:gpt-5.5-2026-04-23";

export interface ModelRef { provider: string; model: string }

/** arnx cloud's brain tiers, picked by `[cloud] effort`. */
export const TIERS = ["low", "medium", "high"] as const;
export type Tier = typeof TIERS[number];
export const CLOUD_URL = "https://api.arnx.dev";

/** `[cloud]`: arnx models (the brain API) instead of the user's own keys; arnx tests is not available yet. */
export interface CloudSettings {
  models: boolean;
  /** arnx tests (the runner API); always false for now. */
  tests: boolean;
  effort: Tier;
  /** The API's base URL when it is not CLOUD_URL (ARNX_CLOUD_URL overrides both). */
  url?: string;
}
/** `[cloud]` when nothing turns arnx cloud on: the user's own keys. */
export const CLOUD_OFF: CloudSettings = { models: false, tests: false, effort: "medium" };
export const OPENAI_TRANSPORTS = ["background", "stream"] as const;
export type OpenaiTransport = typeof OPENAI_TRANSPORTS[number];

/** A `provider:model` ref, its provider a preset or one of `tables` (the user's `[providers.<name>]`). */
export function parseModelRef(text: string, tables?: Record<string, ProviderTable>): ModelRef {
  const at = text.indexOf(":");
  const provider = at < 0 ? text : text.slice(0, at);
  const model = at < 0 ? "" : text.slice(at + 1);
  if (at < 0 || !resolveProvider(provider, tables) || !model) {
    throw new ArnxError(`model ${pyRepr(text)}: write it as provider:model, with provider one of ` +
      providerNames(tables).join(", "));
  }
  return { provider, model };
}

export function refString(r: ModelRef): string {
  return `${r.provider}:${r.model}`;
}

export interface Settings {
  consentAt: string | null;
  /** When sending code to arnx cloud was agreed to (`cloud_consent_at`); arnx models asks for it once. */
  cloudConsentAt?: string;
  /** Anonymous usage counts after setup, review, accept and check (`telemetry`, default off: opt-in). */
  telemetry: boolean;
  reviewer: ModelRef;
  /** The model that sets up the test environment (`setup`, default: the reviewer). */
  setup?: ModelRef;
  /** Setup's own effort (`setup_effort`, default: `effort`). */
  setupEffort?: Tier;
  challenger: ModelRef;
  /** The model that hunts each part of a big change (default: the reviewer). */
  hunter?: ModelRef;
  /** The model that turns answered questions into tests (default: the reviewer). */
  answerModel?: ModelRef;
  /** Asked for a finding's second opinion when the challenger fails or does not reply in time. */
  challengerFallback?: ModelRef;
  /** The tool-less hunter from another vendor (default: the challenger, when it is from another vendor). */
  secondHunter?: ModelRef;
  /** OpenAI service tier for OpenAI models ("fast": priority processing, priced as "<model>@fast"). */
  openaiTier?: string;
  /** How OpenAI calls travel: a polled background response (unset) or a stream. */
  openaiTransport?: OpenaiTransport;
  /** The second hunter's reasoning effort, sent as is (unset: `effort`, through the provider's `effort` map). */
  secondHunterEffort?: string;
  effort: string;
  reviewBudgetUsd: number;
  setupBudgetUsd: number;
  answerBudgetUsd: number;
  runs: number;
  maxQuestions: number;
  maxProjects: number;
  /** Run each test that failed in every run again on the code before the change, to tell a regression from a
   * failure that was already there (`[review] before_check`, default on). */
  beforeCheck: boolean;
  /** Reviews (and setup) send untracked files too (`[review] untracked`, default off: tracked changes only; the
   * --untracked and --no-untracked flags win). */
  untracked: boolean;
  /** A file holding key-shaped text in code goes to the model and the sandbox with a stand-in for each such string,
   * the real values kept here (`[review] stand_ins`, default on); off, the file is left out. */
  standIns: boolean;
  /** With the before/after check on, at most this many tests that passed in every run (per project, by test id) run
   * on the code before the change too, to show the change fixes what they check (`[review] fix_proof_max`, default
   * 20; 0 turns it off). */
  fixProofMax: number;
  acceptedTestsDir: string;
  /** Where the hunter's context finds the code a change reaches (`[review] context`): "names" matches definitions
   * by name; "precise" also indexes each project in its environment (SCIP) and follows symbols, falling back to
   * names when the index cannot be built. Default "names". */
  context: ContextMode;
  /** Experimental: setup asks JEV about failures no signature explains (`[setup] jev`, default off; it needs
   * JEV_API_KEY too). init never turns it on. */
  jev: boolean;
  prices: Prices;
  /** The `[providers.<name>]` tables, as the file gives them (only when it has some); a preset's name overrides only
   * the fields given. */
  providers?: Record<string, ProviderTable>;
  /** `[cloud]`, only when the file has the table (init always writes it). */
  cloud?: CloudSettings;
}

export type ContextMode = "names" | "precise";

export function settingsPath(repo: string): string {
  return join(repo, ".arnx", "config.toml");
}

function withDefaults(consentAt: string | null, reviewer: ModelRef, challenger: ModelRef): Settings {
  return { consentAt, telemetry: false, reviewer, challenger, effort: "medium", reviewBudgetUsd: 3.0,
    setupBudgetUsd: 3.0, answerBudgetUsd: 0.5, runs: 3, maxQuestions: 5, maxProjects: 4, beforeCheck: true, untracked: false,
    standIns: true, fixProofMax: 20, acceptedTestsDir: "tests/arnx", context: "names", jev: false, prices: {} };
}

export const HAIKU = "anthropic:claude-haiku-5-5";
export const OPENAI_HUNTER = "openai:gpt-6.1-sol";
/** A provider arnx knows besides the built-in ones: `arnx init` writes its table into .arnx/config.toml, with the
 * model arnx suggests for the second opinion (priced in llm.ts PRICES), so using it is exporting its key, uncommenting
 * the table and naming it in a role. A provider a live review has gone through is written as a table, the others as
 * comments. */
export interface KnownProvider {
  name: string;
  label: string;
  table: ProviderTable;
  model: string;
  checked: boolean;
}

/** Endpoints and model names from each provider's docs, 2026-10-21. */
export const KNOWN_PROVIDERS: readonly KnownProvider[] = [
  { name: "deepseek", label: "DeepSeek", model: "deepseek-flash", checked: false,
    table: { api: "messages", url: "https://api.deepseek.com/anthropic", key_env: "DEEPSEEK_API_KEY" } },
  { name: "kimi", label: "Kimi", model: "kimi-k3", checked: false,
    table: { api: "responses", url: "https://api.moonshot.ai/v1", key_env: "MOONSHOT_API_KEY",
      effort: { medium: "high" }, store: false } },
  { name: "openrouter", label: "OpenRouter", model: "z-ai/glm-5.3", checked: false,
    table: { api: "responses", url: "https://openrouter.ai/api/v1", key_env: "OPENROUTER_API_KEY", store: false } },
  // Checked 2026-10-21: a live review with glm-5.3-flash as the second opinion (7 calls, all priced).
  { name: "zai", label: "Z.ai", model: "glm-5.3-flash", checked: true,
    table: { api: "messages", url: "https://api.z.ai/api/anthropic", key_env: "ZAI_API_KEY" } },
];

/** The line that starts the known providers in a written file: what follows it is init's, written again each time. */
const KNOWN_MARKER = "# Other providers arnx knows";

export const RIVER_CHALLENGER = "river:zai-org/GLM-5.3-Flash";

/** The harness: the model arnx is measured with for each role. */
export const HARNESS = { reviewer: REVIEWER, hunter: HAIKU, secondHunter: OPENAI_HUNTER, challenger: RIVER_CHALLENGER,
  challengerFallback: OPENAI_HUNTER, answerModel: HAIKU } as const;
export type HarnessRole = keyof typeof HARNESS;

/** The environment variables a built-in model ref needs. */
export const keysOf = (ref: string): string[] => envNames(resolveProvider(parseModelRef(ref).provider)!);

/** What `arnx init` writes: the harness, role by role, where the role's key is in `env`. Without River's key Claude
 * Sonnet gives the second opinion; without OpenAI's there is no second hunter, and the fallback needs both. */
export function defaultSettings(env: Env = {}): Settings {
  const has = (ref: string) => keysOf(ref).every((k) => !!env[k]);
  const challenger = has(HARNESS.challenger) ? HARNESS.challenger : REVIEWER;
  const s = withDefaults(null, parseModelRef(HARNESS.reviewer), parseModelRef(challenger));
  s.hunter = parseModelRef(HARNESS.hunter);
  s.answerModel = parseModelRef(HARNESS.answerModel);
  if (has(HARNESS.secondHunter)) s.secondHunter = parseModelRef(HARNESS.secondHunter);
  if (challenger === HARNESS.challenger && has(HARNESS.challengerFallback)) {
    s.challengerFallback = parseModelRef(HARNESS.challengerFallback);
  }
  s.cloud = { ...CLOUD_OFF };
  return s;
}

/** Python's float(): numbers and numeric strings. */
function float(v: unknown): number {
  const n = typeof v === "number" || typeof v === "bigint" ? Number(v)
    : typeof v === "string" && v.trim() !== "" ? Number(v) : typeof v === "boolean" ? Number(v) : NaN;
  if (Number.isNaN(n)) throw new ArnxError(`.arnx/config.toml: could not convert ${JSON.stringify(v)} to a number`);
  return n;
}

const table = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};

export function loadSettings(repo: string): Settings {
  const path = settingsPath(repo);
  if (!existsSync(path)) throw new SetupRequired("no .arnx/config.toml; run `arnx init`");
  let data: Record<string, unknown>;
  try {
    data = parseToml(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new ArnxError(`.arnx/config.toml: ${(e as Error).message.split("\n")[0]}`);
  }
  const models = table(data.models), budget = table(data.budget), review = table(data.review);
  const setup = table(data.setup);
  const providers = data.providers === undefined ? undefined : parseProviders(data.providers);
  const parseRef = (text: string) => parseModelRef(text, providers);
  const cloud = data.cloud === undefined ? undefined : parseCloud(table(data.cloud));
  const prices: Prices = {};
  for (const [k, v] of Object.entries(table(data.prices))) {
    if (!Array.isArray(v) || (v.length !== 4 && v.length !== 9)) {
      throw new ArnxError(`.arnx/config.toml: prices.${k}: needs four numbers (or nine: four, a prompt size in ` +
        "tokens, and four for prompts over it)");
    }
    prices[k] = v.map(float) as Price;
  }
  const str = (v: unknown, d: string) => v === undefined ? d : String(v);
  const transport = models.openai_transport;
  if (transport !== undefined && !OPENAI_TRANSPORTS.includes(transport as OpenaiTransport)) {
    throw new ArnxError(`.arnx/config.toml: models.openai_transport: ${JSON.stringify(transport)}; write ` +
      OPENAI_TRANSPORTS.map((t) => JSON.stringify(t)).join(" or "));
  }
  const rawEffort = models.second_hunter_effort;
  // Any value the provider takes ("none", "low", …): the provider rejects one it does not know.
  if (rawEffort !== undefined && (typeof rawEffort !== "string" || !rawEffort.trim())) {
    throw new ArnxError(".arnx/config.toml: models.second_hunter_effort: needs an effort name, such as \"low\"");
  }
  // It sets no effort on a challenger standing in as the second hunter: without its own model it would do nothing.
  if (rawEffort !== undefined && models.second_hunter === undefined) {
    throw new ArnxError(".arnx/config.toml: second_hunter_effort needs second_hunter");
  }
  const ownEffort = typeof rawEffort === "string" ? rawEffort.trim() : undefined;
  const setupEffort = models.setup_effort;
  if (setupEffort !== undefined && !TIERS.includes(setupEffort as Tier)) {
    throw new ArnxError(`.arnx/config.toml: models.setup_effort: ${JSON.stringify(setupEffort)}; write ` +
      TIERS.map((x) => JSON.stringify(x)).join(", "));
  }
  if (review.before_check !== undefined && typeof review.before_check !== "boolean") {
    throw new ArnxError(".arnx/config.toml: review.before_check: write true or false");
  }
  const fixProofMax = review.fix_proof_max;
  if (fixProofMax !== undefined && !(Number.isInteger(fixProofMax) && (fixProofMax as number) >= 0)) {
    throw new ArnxError(".arnx/config.toml: review.fix_proof_max: write a whole number, 0 or more (0 turns it off)");
  }
  if (review.untracked !== undefined && typeof review.untracked !== "boolean") {
    throw new ArnxError(".arnx/config.toml: review.untracked: write true or false");
  }
  if (review.stand_ins !== undefined && typeof review.stand_ins !== "boolean") {
    throw new ArnxError(".arnx/config.toml: review.stand_ins: write true or false");
  }
  if (review.context !== undefined && review.context !== "names" && review.context !== "precise") {
    throw new ArnxError(".arnx/config.toml: review.context: write \"names\" or \"precise\"");
  }
  if (setup.jev !== undefined && typeof setup.jev !== "boolean") {
    throw new ArnxError(".arnx/config.toml: setup.jev: write true or false");
  }
  return {
    consentAt: typeof data.consent_at === "string" ? data.consent_at : null,
    telemetry: telemetrySetting(data.telemetry),
    ...(typeof data.cloud_consent_at === "string" ? { cloudConsentAt: data.cloud_consent_at } : {}),
    reviewer: parseRef(str(models.reviewer, REVIEWER)),
    ...(models.setup !== undefined ? { setup: parseRef(String(models.setup)) } : {}),
    ...(setupEffort !== undefined ? { setupEffort: setupEffort as Tier } : {}),
    challenger: parseRef(str(models.challenger, REVIEWER)),
    ...(models.hunter !== undefined ? { hunter: parseRef(String(models.hunter)) } : {}),
    ...(models.openai_tier !== undefined ? { openaiTier: String(models.openai_tier) } : {}),
    ...(transport !== undefined ? { openaiTransport: transport as OpenaiTransport } : {}),
    ...(ownEffort !== undefined ? { secondHunterEffort: ownEffort } : {}),
    ...(models.challenger_fallback !== undefined ? { challengerFallback: parseRef(String(models.challenger_fallback)) }
      : {}),
    ...(models.second_hunter !== undefined ? { secondHunter: parseRef(String(models.second_hunter)) } : {}),
    ...(models.answer_model !== undefined ? { answerModel: parseRef(String(models.answer_model)) } : {}),
    effort: str(models.effort, "medium"),
    reviewBudgetUsd: float(budget.review_usd ?? 3.0),
    setupBudgetUsd: float(budget.setup_usd ?? 3.0),
    answerBudgetUsd: float(budget.answer_usd ?? 0.5),
    runs: Math.trunc(float(review.runs ?? 3)),
    maxQuestions: Math.trunc(float(review.max_questions ?? 5)),
    maxProjects: Math.trunc(float(review.max_projects ?? 4)),
    beforeCheck: review.before_check !== false,
    fixProofMax: fixProofMax === undefined ? 20 : Number(fixProofMax),
    untracked: review.untracked === true,
    standIns: review.stand_ins !== false,
    acceptedTestsDir: str(review.accepted_tests_dir, "tests/arnx"),
    context: review.context === "precise" ? "precise" : "names",
    jev: setup.jev === true,
    prices,
    ...(providers ? { providers } : {}),
    ...(cloud ? { cloud } : {}),
  };
}

function parseCloud(t: Record<string, unknown>): CloudSettings {
  for (const key of ["models", "tests"]) {
    if (t[key] !== undefined && typeof t[key] !== "boolean") {
      throw new ArnxError(`.arnx/config.toml: cloud.${key}: write true or false`);
    }
  }
  if (t.tests === true) {
    throw new ArnxError(".arnx/config.toml: cloud.tests: arnx tests is not available yet; write false (tests run in " +
      "Docker here)");
  }
  const effort = t.effort ?? "medium";
  if (!TIERS.includes(effort as Tier)) {
    throw new ArnxError(`.arnx/config.toml: cloud.effort: ${JSON.stringify(effort)}; write ` +
      TIERS.map((x) => JSON.stringify(x)).join(", "));
  }
  if (t.url !== undefined && (typeof t.url !== "string" || !/^https?:\/\/\S+$/.test(t.url))) {
    throw new ArnxError(".arnx/config.toml: cloud.url: write the API's address, such as \"https://api.arnx.dev\"");
  }
  return { models: t.models === true, tests: false, effort: effort as Tier,
    ...(typeof t.url === "string" && t.url.replace(/\/+$/, "") !== CLOUD_URL ? { url: t.url.replace(/\/+$/, "") } : {}) };
}

/** The arnx cloud API this repository uses: ARNX_CLOUD_URL, else `[cloud] url`, else CLOUD_URL. */
export function cloudUrl(s: Settings | null, env: Env): string {
  return (env.ARNX_CLOUD_URL?.trim() || s?.cloud?.url || CLOUD_URL).replace(/\/+$/, "");
}

/** True when arnx models stands in for the user's keys. */
export const cloudModels = (s: Settings): boolean => s.cloud?.models === true;

/** The models in effect for a run and what chose them: the committed file is the team's default, and a person or a
 * run overrides it with ARNX_MODELS or --local / --cloud (a flag beats the variable, which beats the file). */
export interface ModelsMode { cloud: boolean; from: "file" | "ARNX_MODELS" | "flag" }

export function modelsMode(s: Settings, env: Env, flag?: "local" | "cloud"): ModelsMode {
  if (flag) return { cloud: flag === "cloud", from: "flag" };
  const v = env.ARNX_MODELS?.trim();
  if (!v) return { cloud: cloudModels(s), from: "file" };
  if (v !== "local" && v !== "cloud") {
    throw new ArnxError(`ARNX_MODELS: ${JSON.stringify(v)}; write "local" (your own keys) or "cloud" (arnx models)`);
  }
  return { cloud: v === "cloud", from: "ARNX_MODELS" };
}

/** The settings with the models in effect; only this run sees them, the file is not rewritten. */
export function withModels(s: Settings, m: ModelsMode): Settings {
  return cloudModels(s) === m.cloud ? s : { ...s, cloud: { ...(s.cloud ?? CLOUD_OFF), models: m.cloud } };
}

/** The setting that chose the models, as the user would write it. */
export function modelsSetting(m: ModelsMode): string {
  return m.from === "flag" ? (m.cloud ? "--cloud" : "--local")
    : m.from === "ARNX_MODELS" ? `ARNX_MODELS=${m.cloud ? "cloud" : "local"}` : `\`[cloud] models = ${m.cloud}\``;
}

/** `[review] untracked` from .arnx/config.toml; off when there is no config yet or it cannot be read. */
export function untrackedSetting(repo: string): boolean {
  try {
    return existsSync(settingsPath(repo)) && loadSettings(repo).untracked;
  } catch (e) {
    if (e instanceof ArnxError) return false;
    throw e;
  }
}

/** `[review] stand_ins` from .arnx/config.toml; on when there is no config yet or it cannot be read. */
export function standInsSetting(repo: string): boolean {
  try {
    return !existsSync(settingsPath(repo)) || loadSettings(repo).standIns;
  } catch (e) {
    if (e instanceof ArnxError) return true;
    throw e;
  }
}

/** Writes .arnx/config.toml. With `known` (init), the harness's lines for roles that are not on it, and the providers
 * arnx knows after the user's own. */
export function writeSettings(repo: string, s: Settings, opts: { known?: boolean } = {}): void {
  const q = (v: string) => pyJson(v); // a JSON string is a valid TOML basic string
  const cloud = s.cloud ?? CLOUD_OFF;
  const lines: string[] = [];
  if (s.consentAt) lines.push(`consent_at = ${q(s.consentAt)}`);
  if (s.cloudConsentAt) lines.push(`cloud_consent_at = ${q(s.cloudConsentAt)}`);
  lines.push(telemetryLineToml(s.telemetry));
  const commented = (assignment: string, what: string) => `${assignment.padEnd(52)} # ${what}`;
  const setting = (assignment: string, what: string) => `${assignment.padEnd(33)} # ${what}`;
  // The four everyday roles, then only the advanced settings that are set (the README lists them all).
  const model = (key: string, value: string, what: string) => `${`${key} = ${value}`.padEnd(45)} # ${what}`;
  const ref = (key: string, r: ModelRef | undefined, what: string) => r ? [model(key, q(refString(r)), what)] : [];
  // At init, a harness role that is not the harness's model (its key missing) gets the harness's line, commented.
  const harness = (key: string, role: HarnessRole, r: ModelRef | undefined) =>
    opts.known && (r ? refString(r) : undefined) !== HARNESS[role]
      ? [`${`# ${key} = ${q(HARNESS[role])}`.padEnd(45)} # harness; needs ${keysOf(HARNESS[role]).join(", ")}`] : [];
  lines.push("", "[models]",
    model("reviewer", q(refString(s.reviewer)), "reviews the change, writes and runs the tests"),
    s.setup ? model("setup", q(refString(s.setup)), "sets up the test environment")
      : `${`# setup = ${q(REVIEWER)}`.padEnd(45)} # sets up the test environment; default: reviewer`,
    ...(s.setupEffort ? [model("setup_effort", q(s.setupEffort), "setup's own effort")] : []),
    ...ref("hunter", s.hunter, "looks at each part of a big change"),
    ...ref("second_hunter", s.secondHunter, "a second look, from another vendor"),
    ...harness("second_hunter", "secondHunter", s.secondHunter),
    ...(s.secondHunterEffort ? [model("second_hunter_effort", q(s.secondHunterEffort), "its own effort")] : []),
    model("challenger", q(refString(s.challenger)), "second opinion on each finding"),
    ...harness("challenger", "challenger", s.challenger),
    ...ref("challenger_fallback", s.challengerFallback, "asked when the challenger fails"),
    ...harness("challenger_fallback", "challengerFallback", s.challengerFallback),
    ...ref("answer_model", s.answerModel, "turns your answers into tests"),
    ...(s.openaiTier ? [`openai_tier = ${q(s.openaiTier)}`] : []),
    ...(s.openaiTransport ? [model("openai_transport", q(s.openaiTransport), "how OpenAI calls travel")] : []),
    model("effort", q(s.effort), "low, medium or high"),
    "", `${"[budget]".padEnd(19)} # the most a run may spend, in USD; it stops there`,
    `review_usd = ${pyFloat(s.reviewBudgetUsd)}`, `setup_usd = ${pyFloat(s.setupBudgetUsd)}`,
    `answer_usd = ${pyFloat(s.answerBudgetUsd)}`,
    "", "[review]", setting(`runs = ${s.runs}`, `each test runs ${s.runs} times; a finding fails every time`),
    setting(`max_questions = ${s.maxQuestions}`, "questions you are asked, at most"),
    ...(s.maxProjects !== 4 ? [setting(`max_projects = ${s.maxProjects}`, "projects one review covers, at most")] : []),
    setting(`before_check = ${s.beforeCheck}`, "rerun failing tests on the code before the change"),
    ...(s.fixProofMax !== 20 ? [setting(`fix_proof_max = ${s.fixProofMax}`,
      "passing tests per project rerun there to prove a fix (0: off)")] : []),
    ...(s.untracked ? [setting("untracked = true", "send untracked files too")] : []),
    ...(!s.standIns ? [setting("stand_ins = false", "leave out files with key-shaped text, no stand-ins")] : []),
    setting(`accepted_tests_dir = ${q(s.acceptedTestsDir)}`, "path accepted tests run from; kept in .arnx/tests/"),
    ...(s.context !== "names" ? [setting(`context = ${q(s.context)}`, "follow symbols with a code index")] : []),
    ...(s.jev ? ["", "[setup]", commented("jev = true", "experimental: ask JEV (needs JEV_API_KEY)")] : []),
    // Always written, models off unless turned on, so going to arnx cloud and back is one word in the file.
    "", "[cloud]", commented(`models = ${cloud.models}`, "true: arnx models instead of your own keys"),
    commented(`tests = ${cloud.tests}`, "arnx tests (not available yet): tests run in Docker here"),
    commented(`effort = ${q(cloud.effort)}`, "low, medium or high: the brain's tier"),
    ...(cloud.url ? [`url = ${q(cloud.url)}`] : []));
  const priced = Object.entries(s.prices).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  if (priced.length) {
    lines.push("", "# USD per million tokens: input, output, cache read, cache write", "[prices]");
    for (const [k, v] of priced) lines.push(`${q(k)} = [${v.map(pyFloat).join(", ")}]`);
  }
  const path = settingsPath(repo);
  // The user's own providers: from the settings when they carry them, else kept from the file as written there
  // (comments included), so `arnx init --force` does not drop them.
  const own = new Set<string>();
  if (s.providers) {
    for (const [name, t] of Object.entries(s.providers)) lines.push("", ...providerToml(name, t));
    for (const name of Object.keys(s.providers)) own.add(name);
  } else if (existsSync(path)) {
    const kept = providerSections(readFileSync(path, "utf8"));
    if (kept.length) lines.push("", ...kept);
    for (const l of kept) {
      const m = /^\s*\[\s*providers\.([^\]\s]+)\s*\]/.exec(l);
      if (m) own.add(m[1]!);
    }
  }
  const more = opts.known ? KNOWN_PROVIDERS.filter((k) => !own.has(k.name)) : [];
  if (more.length) {
    lines.push("", `${KNOWN_MARKER}; each copies the Anthropic or OpenAI API.`,
      "# To use one: export its key, uncomment its table if it is commented, name it in [models].");
    for (const k of more) {
      const use = `challenger = ${q(`${k.name}:${k.model}`)}`;
      if (k.checked) lines.push("", `# ${k.label}: ${use}`, ...providerToml(k.name, k.table));
      else lines.push("", `# ${k.label} (not checked with arnx yet): ${use}`,
        ...providerToml(k.name, k.table).map((l) => `# ${l}`));
    }
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, lines.join("\n").replace(/^\n+/, "") + "\n");
}

/** The user's `[providers…]` sections of a config file's text, as written (each header to the next table that is not
 * one). After the known providers' marker, init's own lines are left out, since init writes them again: the comments,
 * and a known provider's table as init wrote it. A table the user added or changed there is kept. */
function providerSections(text: string): string[] {
  const out: string[] = [];
  let inside = false, known = false;
  let section: string[] = [];
  const flush = () => {
    const name = /^\s*\[\s*providers\.([^\]\s]+)\s*\]/.exec(section[0] ?? "")?.[1];
    const k = KNOWN_PROVIDERS.find((p) => p.name === name);
    const asWritten = k && section.join("\n") === providerToml(k.name, k.table).join("\n");
    if (section.length && !asWritten) out.push(...(out.length ? [""] : []), ...section);
    section = [];
  };
  for (const line of text.replace(/\n+$/, "").split("\n")) {
    if (line.startsWith(KNOWN_MARKER)) known = true;
    const header = /^\s*\[\s*([^\]]*?)\s*\]/.exec(line);
    if (header && !line.trim().startsWith("[[")) inside = /^providers(\.|$)/.test(header[1]!);
    if (!known) {
      if (inside) out.push(line);
      continue;
    }
    if (header) flush();
    if (inside && line.trim() && !line.trim().startsWith("#")) section.push(line);
  }
  flush();
  return out;
}

/** Sets `models` under `[cloud]` in .arnx/config.toml, changing that one value (its comment kept), or adding the line
 * (or the table) when it is missing; the rest of the file stays as it is. */
export function recordCloudModels(repo: string, on: boolean): void {
  const path = settingsPath(repo);
  const lines = readFileSync(path, "utf8").replace(/\n+$/, "").split("\n");
  const start = lines.findIndex((l) => /^\s*\[\s*cloud\s*\]/.test(l));
  if (start < 0) {
    lines.push("", "[cloud]", `models = ${on}`);
  } else {
    let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
    if (end < 0) end = lines.length;
    const at = lines.findIndex((l, i) => i > start && i < end && /^\s*models\s*=/.test(l));
    if (at >= 0) lines[at] = lines[at]!.replace(/^(\s*models\s*=\s*)(true|false)/, `$1${on}`);
    else lines.splice(start + 1, 0, `models = ${on}`);
  }
  writeFileSync(path, lines.join("\n") + "\n");
}

const telemetryLineToml = (on: boolean) => `telemetry = ${on}   # true: send anonymous usage counts, never code or file names`;

function telemetrySetting(v: unknown): boolean {
  if (v === undefined) return false;
  if (typeof v !== "boolean") throw new ArnxError(".arnx/config.toml: telemetry: write true or false");
  return v;
}

/** Records a consent in .arnx/config.toml, changing that one line (or adding it with the other top-level keys) and
 * leaving the rest of the file as it is, comments included. */
export function recordConsent(repo: string, key: "consent_at" | "cloud_consent_at", at: string): void {
  const path = settingsPath(repo);
  const lines = readFileSync(path, "utf8").split("\n");
  const table = lines.findIndex((l) => /^\s*\[/.test(l));
  const top = lines.slice(0, table < 0 ? lines.length : table);
  const find = (k: string) => top.findIndex((l) => new RegExp(`^\\s*${k}\\s*=`).test(l));
  const line = `${key} = ${pyJson(at)}`;
  if (find(key) >= 0) lines[find(key)] = line;
  // Where writeSettings puts it: the cloud consent after consent_at, consent_at first.
  else lines.splice(key === "cloud_consent_at" ? find("consent_at") + 1 : 0, 0, line);
  writeFileSync(path, lines.join("\n"));
}

/** Every model these settings call, whatever its role. */
export const modelRefs = (s: Settings): ModelRef[] =>
  [s.reviewer, s.setup, s.challenger, s.challengerFallback, s.secondHunter, s.hunter, s.answerModel]
    .filter((r): r is ModelRef => r != null);

/** The model setup runs on: `setup`, else the reviewer. */
export const setupRef = (s: Settings): ModelRef => s.setup ?? s.reviewer;

/** The settings setup's agent runs on: `setup` and `setup_effort` in the reviewer's and `effort`'s place. Without
 * them, the settings as they are. */
export const setupSettings = (s: Settings): Settings => s.setup || s.setupEffort
  ? { ...s, reviewer: setupRef(s), effort: s.setupEffort ?? s.effort } : s;

/** The provider a ref names under these settings (a preset, the user's table, or both merged). */
export function providerOfRef(s: Pick<Settings, "providers"> | null | undefined, ref: ModelRef): Provider | undefined {
  return resolveProvider(ref.provider, s?.providers);
}

/** The variables the models in these settings read their keys (and base URLs) from, each once; with `refs`, only
 * those models'. */
export function keyNames(s: Settings, refs: ModelRef[] = modelRefs(s)): string[] {
  return [...new Set(refs.flatMap((r) => {
    const p = providerOfRef(s, r);
    return p ? envNames(p) : [];
  }))];
}

export function missingKeys(s: Settings, env: Env, refs?: ModelRef[]): string[] {
  return keyNames(s, refs).filter((k) => !env[k]);
}

/** How messages name a built-in provider (from PRESETS). */
export const PROVIDER_NAMES: Record<string, string> = Object.fromEntries(Object.entries(PRESETS)
  .map(([name, p]) => [name, p.label]));

/** How messages name a provider: a preset by its name, anything else by its table name and host. */
export function providerName(s: Pick<Settings, "providers"> | null | undefined, provider: string): string {
  const p = resolveProvider(provider, s?.providers);
  return p ? providerLabel(p) : provider;
}

/** One line per provider the file defines, for `arnx doctor`: its name, wire format, host and whether its key's
 * variable is set (the variable's name only, never its value). */
export function providerLines(s: Settings, env: Env): string[] {
  return Object.keys(s.providers ?? {}).map((name) => {
    const p = resolveProvider(name, s.providers)!;
    return `provider ${name}: ${p.api} at ${providerHost(p, env)}, ${p.key_env} ${env[p.key_env] ? "set" : "not set"}`;
  });
}

/** Harness roles init wrote commented because their key was missing, whose key is set now: doctor's note, as
 * "OPENAI_API_KEY is set but unused: `arnx init --force` adds second_hunter, challenger_fallback". Null when none. */
export function unusedKeysNote(repo: string, env: Env): string | null {
  let text: string;
  try {
    text = readFileSync(settingsPath(repo), "utf8");
  } catch {
    return null;
  }
  const roles: string[] = [], keys: string[] = [];
  for (const m of text.matchAll(/^# (\w+) = "[^"]+"\s+# harness; needs ([A-Z0-9_]+)$/gm)) {
    if (!env[m[2]!]) continue;
    roles.push(m[1]!);
    if (!keys.includes(m[2]!)) keys.push(m[2]!);
  }
  if (!keys.length) return null;
  return `${keys.join(", ")} ${keys.length === 1 ? "is" : "are"} set but unused: \`arnx init --force\` adds ` +
    `${[...new Set(roles)].join(", ")}`;
}
