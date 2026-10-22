// Model providers as data: each is a table, as `.arnx/config.toml` writes it under `[providers.<name>]`. The built-in
// providers (Anthropic, OpenAI, and River, which the harness's second opinion runs on) are presets in the same form (PRESETS); a user table with a preset's name overrides only the
// fields it gives. Two wire formats so far: OpenAI Responses ("responses") and Anthropic Messages ("messages").
// A table never holds a key: `key_env` names the environment variable that does, and keys are read only from the env
// object arnx is given, never printed.
import { ArnxError } from "./errors";
import { hasSecretContent } from "./secrets";
import type { Env } from "./settings";

export const APIS = ["responses", "messages"] as const;
export type Api = typeof APIS[number];

/** A `[providers.<name>]` table, with TOML's field names. */
export interface ProviderTable {
  /** The wire format. */
  api?: Api;
  /** The base URL: Responses requests go to `<url>/responses`; Messages ones to `<url>/v1/messages`, as the Anthropic
   * SDK's base URL. */
  url?: string;
  /** The environment variable holding the base URL, instead of `url`. */
  url_env?: string;
  /** The environment variable holding the key (its name, never the key). */
  key_env?: string;
  /** arnx's effort word -> the vendor's (an endpoint may take "high" for arnx's "medium"). Unlisted words are sent as is. */
  effort?: Record<string, string>;
  /** Sent as `store` (responses; false: reasoning goes back between tool turns as encrypted content). */
  store?: boolean;
  /** The model family when the model name does not say it (kept for the same-vendor note of a later version). */
  family?: string;
}

/** Fields only the built-in presets carry: how messages name them, and OpenAI's own settings. */
interface PresetOnly {
  /** How messages name the provider ("Anthropic"). */
  label: string;
  /** `[models] openai_transport` applies: a polled background response unless it is "stream". */
  background?: boolean;
  /** `[models] openai_tier` applies (priced as "<model>@<tier>"). */
  tier?: boolean;
}

export const ANTHROPIC_URL = "https://api.anthropic.com";
export const OPENAI_URL = "https://api.openai.com/v1";
export const RIVER_URL = "https://api.river.ai/v1";

/** The built-in providers, in the order messages list them. */
export const PRESETS: Readonly<Record<string, Readonly<ProviderTable & PresetOnly>>> = {
  anthropic: { api: "messages", url: ANTHROPIC_URL, key_env: "ANTHROPIC_API_KEY", family: "anthropic",
    label: "Anthropic" },
  openai: { api: "responses", url: OPENAI_URL, key_env: "OPENAI_API_KEY", family: "openai", label: "OpenAI",
    background: true, tier: true },
  // River's models take low/high/max (GLM) or none/high/max (DeepSeek): arnx's default "medium" becomes "high".
  // River refuses stored responses.
  river: { api: "responses", url: RIVER_URL, key_env: "RIVER_API_KEY", effort: { medium: "high" }, store: false,
    label: "River" },
};

/** A provider with every field it needs: a preset, a user table, or a user table over a preset. */
export interface Provider extends ProviderTable {
  name: string;
  api: Api;
  key_env: string;
  label?: string;
  background?: boolean;
  tier?: boolean;
}

/** The provider `name` names, from the presets and the user's tables; undefined when neither has it. */
export function resolveProvider(name: string, tables?: Record<string, ProviderTable>): Provider | undefined {
  const preset = Object.hasOwn(PRESETS, name) ? PRESETS[name] : undefined;
  const own = tables && Object.hasOwn(tables, name) ? tables[name] : undefined;
  if (!preset && !own) return undefined;
  const merged: Record<string, unknown> = { ...preset, ...own };
  // One source for the URL: a table's own url (or url_env) replaces the preset's.
  if (own?.url !== undefined && own.url_env === undefined) delete merged.url_env;
  if (own?.url_env !== undefined && own.url === undefined) delete merged.url;
  return { name, ...merged } as Provider;
}

/** The provider names a model ref may use: the presets, then the user's own tables. */
export function providerNames(tables?: Record<string, ProviderTable>): string[] {
  return [...Object.keys(PRESETS), ...Object.keys(tables ?? {}).filter((n) => !Object.hasOwn(PRESETS, n))];
}

/** True for a provider arnx does not know as is: a user's own table, or a preset sent somewhere else. Telemetry
 * counts it as "other", and messages name it by its table name and host. */
export function isCustom(p: Provider): boolean {
  const preset = Object.hasOwn(PRESETS, p.name) ? PRESETS[p.name] : undefined;
  return !preset || p.url !== preset.url || p.url_env !== preset.url_env || p.api !== preset.api;
}

/** The environment variables a provider needs: its key, and its URL's when it has one. */
export const envNames = (p: Provider): string[] => [p.key_env, ...(p.url_env ? [p.url_env] : [])];

/** The host of a URL, or "" when it is not one. */
function hostOf(url: string | undefined): string {
  try {
    return url ? new URL(url).host : "";
  } catch {
    return "";
  }
}

/** How messages name a provider: a preset by its name ("Anthropic"); anything else by its table name and where the
 * code goes ("myprovider (llm.example.com)"). */
export function providerLabel(p: Provider): string {
  if (!isCustom(p) && p.label) return p.label;
  return `${p.name} (${p.url !== undefined ? hostOf(p.url) : `the URL in ${p.url_env}`})`;
}

/** Where a provider's requests go, for `arnx doctor`: its host, from the env when it names its URL there. */
export function providerHost(p: Provider, env: Env): string {
  if (p.url !== undefined) return hostOf(p.url);
  const url = env[p.url_env!];
  return url ? hostOf(url) || `${p.url_env} (not a URL)` : `${p.url_env} (not set)`;
}

const FIELDS = ["api", "url", "url_env", "key_env", "effort", "store", "family"] as const;
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const NAME = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
/** Names arnx itself uses for a provider (arnx cloud, telemetry's catch-all, a ref without one). */
const RESERVED = new Set(["arnx", "other", "unknown"]);
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const isTable = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** An address arnx may send code to: https, or http to this machine only. Never echoes the URL (it may hold a key). */
function checkUrl(where: string, value: unknown): string {
  const bad = (why: string) => new ArnxError(`.arnx/config.toml: ${where}: ${why}`);
  if (typeof value !== "string" || !value.trim()) throw bad("write the provider's base address, such as " +
    "\"https://api.example.com/v1\"");
  let u: URL;
  try {
    u = new URL(value);
  } catch {
    throw bad("not a URL; write the provider's base address, such as \"https://api.example.com/v1\"");
  }
  if (u.username || u.password || u.search) {
    throw bad("write the address without credentials or a query (a key is never written in this file; set key_env " +
      "to the name of the environment variable that holds it)");
  }
  if (u.protocol !== "https:" && !(u.protocol === "http:" && LOCAL_HOSTS.has(u.hostname))) {
    throw bad("needs https (plain http only to localhost, 127.0.0.1 or ::1)");
  }
  return value.replace(/\/+$/, "");
}

function checkEnvName(where: string, value: unknown, example: string): string {
  if (typeof value !== "string" || !ENV_NAME.test(value)) {
    throw new ArnxError(`.arnx/config.toml: ${where}: write the name of the environment variable that holds it, ` +
      `in capitals, such as ${example}; never the value itself`);
  }
  return value;
}

/** `[providers]` from a parsed `.arnx/config.toml`: each table checked, and complete once merged over its preset.
 * Nothing in a refusal repeats a value that could be a key. */
export function parseProviders(raw: unknown): Record<string, ProviderTable> {
  if (!isTable(raw)) throw new ArnxError(".arnx/config.toml: providers: write each provider as a [providers.<name>] table");
  const out: Record<string, ProviderTable> = {};
  for (const [name, t] of Object.entries(raw)) {
    const at = `providers.${name}`;
    const bad = (why: string) => new ArnxError(`.arnx/config.toml: ${at}: ${why}`);
    if (!NAME.test(name)) throw bad("a provider's name takes letters, digits, - and _ only");
    if (RESERVED.has(name)) throw bad(`"${name}" is a name arnx uses itself; choose another`);
    if (!isTable(t)) throw bad("write it as a table: [providers." + name + "] with api, url and key_env");
    for (const [k, v] of Object.entries(t)) {
      if ((FIELDS as readonly string[]).includes(k)) {
        if (typeof v === "string" && hasSecretContent(v)) throw bad(`${k}: looks like a key; a key is never written ` +
          "in this file: set key_env to the name of the environment variable that holds it");
        continue;
      }
      if (/key|token|secret|passw|auth|bearer|credential/i.test(k)) {
        throw bad(`${k}: a key is never written in this file; set key_env to the name of the environment variable ` +
          "that holds it");
      }
      throw bad(`${k}: not a provider field; write ${FIELDS.join(", ")}`);
    }
    const table: ProviderTable = {};
    if (t.api !== undefined) {
      if (t.api === "chat") {
        throw bad("api: \"chat\" (OpenAI Chat Completions) comes in a later version of arnx; for now write " +
          "\"responses\" (OpenAI Responses) or \"messages\" (Anthropic Messages)");
      }
      if (!APIS.includes(t.api as Api)) throw bad(`api: write ${APIS.map((a) => `"${a}"`).join(" or ")}`);
      table.api = t.api as Api;
    }
    if (t.url !== undefined && t.url_env !== undefined) throw bad("write url or url_env, not both");
    if (t.url !== undefined) table.url = checkUrl(`${at}.url`, t.url);
    if (t.url_env !== undefined) table.url_env = checkEnvName(`${at}.url_env`, t.url_env, "MY_PROVIDER_URL");
    if (t.key_env !== undefined) table.key_env = checkEnvName(`${at}.key_env`, t.key_env, "MY_PROVIDER_KEY");
    if (t.effort !== undefined) {
      if (!isTable(t.effort) || !Object.entries(t.effort).every(([k, v]) => k.trim() && typeof v === "string" &&
          v.trim())) {
        throw bad("effort: write arnx's effort and the vendor's word for it, such as { medium = \"high\" }");
      }
      table.effort = Object.fromEntries(Object.entries(t.effort).map(([k, v]) => [k, String(v).trim()]));
    }
    if (t.store !== undefined) {
      if (typeof t.store !== "boolean") throw bad("store: write true or false");
      table.store = t.store;
    }
    if (t.family !== undefined) {
      if (typeof t.family !== "string" || !/^[a-z0-9][a-z0-9._-]*$/i.test(t.family)) {
        throw bad("family: write the model family's name, such as \"myfamily\"");
      }
      table.family = t.family;
    }
    out[name] = table;
    const p = resolveProvider(name, out)!;
    if (!Object.hasOwn(PRESETS, name)) {
      if (p.api === undefined) throw bad("needs api: \"responses\" (OpenAI Responses) or \"messages\" (Anthropic Messages)");
      if (p.url === undefined && p.url_env === undefined) throw bad("needs url, the provider's base address");
      if (p.key_env === undefined) throw bad("needs key_env, the name of the environment variable holding its key");
    }
    if (p.store !== undefined && p.api !== "responses") throw bad("store applies to api = \"responses\" only");
  }
  return out;
}

/** A `[providers.<name>]` table as TOML lines, fields in a fixed order. */
export function providerToml(name: string, t: ProviderTable): string[] {
  const q = (v: string) => JSON.stringify(v);
  const lines = [`[providers.${name}]`];
  if (t.api !== undefined) lines.push(`api = ${q(t.api)}`);
  if (t.url !== undefined) lines.push(`url = ${q(t.url)}`);
  if (t.url_env !== undefined) lines.push(`url_env = ${q(t.url_env)}`);
  if (t.key_env !== undefined) lines.push(`key_env = ${q(t.key_env)}`);
  if (t.effort !== undefined) {
    const pairs = Object.entries(t.effort).map(([k, v]) => `${/^[A-Za-z0-9_-]+$/.test(k) ? k : q(k)} = ${q(v)}`);
    lines.push(`effort = { ${pairs.join(", ")} }`);
  }
  if (t.store !== undefined) lines.push(`store = ${t.store}`);
  if (t.family !== undefined) lines.push(`family = ${q(t.family)}`);
  return lines;
}
