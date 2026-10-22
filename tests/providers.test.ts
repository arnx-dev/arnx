// Providers as data: [providers.<name>] tables in .arnx/config.toml, the two presets (Anthropic, OpenAI) in the same
// form, and the other providers arnx knows, written by init.
import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArnxError } from "../src/errors";
import { makeAgentModel, makeJsonModel, PRICES } from "../src/llm";
import { providerFailures } from "../src/outage";
import { PRESETS, resolveProvider } from "../src/providers";
import { defaultSettings, KNOWN_PROVIDERS, loadSettings, missingKeys, PROVIDER_KEYS, PROVIDER_NAMES, parseModelRef,
  refString, settingsPath, type Settings, writeSettings } from "../src/settings";
import { providersOf } from "../src/telemetry";
import { Cli } from "./helpers/cli";
import { gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SCHEMA = { type: "object", properties: { verdict: { type: "string" } }, required: ["verdict"],
  additionalProperties: false };

const MYPROVIDER = `
[providers.myprovider]
api = "responses"
url = "https://llm.example.com/v1"
key_env = "MY_PROVIDER_KEY"
effort = { medium = "high" }
store = false
family = "myfamily"
`;

/** A repo whose config.toml is `body` (models and all). */
function config(body: string): string {
  const repo = tmp();
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(settingsPath(repo), body);
  return repo;
}

const load = (body: string) => loadSettings(config(body));
const refused = (body: string): string => {
  try {
    load(body);
  } catch (e) {
    if (e instanceof ArnxError) return e.message;
    throw e;
  }
  throw new Error("not refused");
};

test("three presets, Anthropic, OpenAI and River (the harness's); the exported tables come from them", () => {
  expect(Object.keys(PRESETS)).toEqual(["anthropic", "openai", "river"]);
  expect(PROVIDER_KEYS).toEqual({ anthropic: ["ANTHROPIC_API_KEY"], openai: ["OPENAI_API_KEY"],
    river: ["RIVER_API_KEY"] });
  expect(PROVIDER_NAMES).toEqual({ anthropic: "Anthropic", openai: "OpenAI", river: "River" });
  expect(() => parseModelRef("other:large")).toThrow("with provider one of anthropic, openai, river");
});

test("a model ref may name a defined table; an unknown one lists the presets and the tables", () => {
  const s = load(`[models]\nchallenger = "myprovider:some-model"\n${MYPROVIDER}`);
  expect(s.challenger).toEqual({ provider: "myprovider", model: "some-model" });
  expect(s.providers).toEqual({ myprovider: { api: "responses", url: "https://llm.example.com/v1", key_env: "MY_PROVIDER_KEY",
    effort: { medium: "high" }, store: false, family: "myfamily" } });
  expect(refused(`[models]\nchallenger = "nope:x"\n${MYPROVIDER}`))
    .toContain("with provider one of anthropic, openai, river, myprovider");
});

test("a table is refused when it is incomplete, unsafe or holds a key; the refusal never repeats the value", () => {
  const t = (body: string) => refused(`[providers.x]\n${body}\n`);
  expect(t('api = "chat"\nurl = "https://a.example/v1"\nkey_env = "K"')).toContain("comes in a later version");
  expect(t('api = "grpc"\nurl = "https://a.example/v1"\nkey_env = "K"')).toContain('write "responses" or "messages"');
  expect(t('url = "https://a.example/v1"\nkey_env = "K"')).toContain("needs api");
  expect(t('api = "responses"\nkey_env = "K"')).toContain("needs url");
  expect(t('api = "responses"\nurl = "https://a.example/v1"')).toContain("needs key_env");
  expect(t('api = "responses"\nurl = "http://a.example/v1"\nkey_env = "K"')).toContain("needs https");
  for (const local of ["http://localhost:11434/v1", "http://127.0.0.1:8000/v1", "http://[::1]:8000/v1"]) {
    expect(() => load(`[providers.x]\napi = "responses"\nurl = "${local}"\nkey_env = "K"\n`)).not.toThrow();
  }
  const key = "sk-proj-" + "x".repeat(40); // built at runtime: no key-shaped literal in the tree
  for (const body of [`api = "responses"\nurl = "https://a.example/v1"\nkey_env = "${key}"`,
    `api = "responses"\nurl = "https://a.example/v1"\nkey_env = "K"\napi_key = "${key}"`,
    `api = "responses"\nurl = "https://user:${key}@a.example/v1"\nkey_env = "K"`,
    `api = "responses"\nurl = "https://a.example/v1?key=${key}"\nkey_env = "K"`,
    `api = "responses"\nurl = "https://a.example/v1"\nkey_env = "K"\nfamily = "${key}"`]) {
    const why = t(body);
    expect(why).not.toContain(key);
    expect(why).toMatch(/key|credentials|environment variable/);
  }
  expect(t('api = "messages"\nurl = "https://a.example"\nkey_env = "K"\nstore = false')).toContain("responses");
  expect(t('api = "responses"\nurl = "https://a.example/v1"\nkey_env = "K"\nheaders = 1')).toContain("not a provider field");
  expect(refused('[providers.arnx]\napi = "responses"\nurl = "https://a.example/v1"\nkey_env = "K"\n'))
    .toContain("arnx uses itself");
});

test("a table with a preset's name overrides only the fields it gives", () => {
  const s = load('[providers.openai]\neffort = { medium = "max" }\n');
  expect(resolveProvider("openai", s.providers)).toEqual({ name: "openai", api: "responses",
    url: "https://api.openai.com/v1", key_env: "OPENAI_API_KEY", family: "openai", label: "OpenAI", background: true,
    tier: true, effort: { medium: "max" } });
  // Its own url_env replaces the preset's url.
  const gw = load('[providers.openai]\nurl_env = "MY_OPENAI_URL"\n');
  expect(resolveProvider("openai", gw.providers)!.url).toBeUndefined();
  expect(missingKeys({ ...gw, challenger: parseModelRef("openai:gpt-6.1-sol") }, {})).toEqual(["ANTHROPIC_API_KEY",
    "OPENAI_API_KEY", "MY_OPENAI_URL"]);
});

test("telemetry counts a custom provider, or a preset sent elsewhere, as other", () => {
  const s = load(`[models]\nchallenger = "myprovider:some-model"\n${MYPROVIDER}`);
  const proxied = load('[models]\nchallenger = "openai:gpt-5.5-2026-04-23"\n[providers.openai]\n' +
    'url = "https://proxy.example/v1"\n');
  expect(providersOf([s.reviewer, s.challenger], s)).toEqual(["anthropic", "other"]);
  expect(providersOf([proxied.reviewer, proxied.challenger], proxied)).toEqual(["anthropic", "other"]);
  expect(providersOf([s.reviewer, parseModelRef("openai:m")], s)).toEqual(["anthropic", "openai"]);
  expect(JSON.stringify(providersOf([s.challenger], s))).not.toContain("myprovider");
});

test("a refused key on a custom provider names its key_env and its table", () => {
  const s = load(MYPROVIDER);
  const [f] = providerFailures([{ provider: "myprovider", role: "challenge", ok: false,
    fault: { kind: "auth", detail: "HTTP 401" } }], s);
  expect([f!.key, f!.name]).toEqual(["MY_PROVIDER_KEY", "myprovider (llm.example.com)"]);
});

test("writeSettings keeps [providers] tables, from the settings or else from the file (init --force)", () => {
  const repo = config(`[models]\nchallenger = "myprovider:some-model"\n${MYPROVIDER}`);
  const s = loadSettings(repo);
  writeSettings(repo, s);
  expect(loadSettings(repo)).toEqual({ ...s, cloud: { models: false, tests: false, effort: "medium" } });
  expect(readFileSync(settingsPath(repo), "utf8")).toContain('[providers.myprovider]\napi = "responses"\n' +
    'url = "https://llm.example.com/v1"\nkey_env = "MY_PROVIDER_KEY"\neffort = { medium = "high" }\nstore = false\n' +
    'family = "myfamily"\n');
  // Settings that carry no tables (init's defaults) keep the file's, as written there.
  appendFileSync(settingsPath(repo), '# my gateway\n[providers.gw]\napi = "messages"\nurl = "https://gw.example"\n' +
    'key_env = "GW_KEY"\n');
  writeSettings(repo, defaultSettings());
  const after = loadSettings(repo);
  expect(Object.keys(after.providers!)).toEqual(["myprovider", "gw"]);
  expect(readFileSync(settingsPath(repo), "utf8")).toContain("# my gateway\n[providers.gw]");
});

test("arnx init --force keeps the user's provider tables, and doctor lists the ones a role uses (names only)",
  async () => {
  const repo = gitRepo(tmp());
  const env = { ANTHROPIC_API_KEY: "a-secret-value", MY_PROVIDER_KEY: "r-secret-value" };
  const cli = new Cli({ cwd: repo, env });
  expect(await cli.run("init")).toBe(0);
  appendFileSync(settingsPath(repo), MYPROVIDER);
  expect(await cli.run("init", "--force")).toBe(0);
  expect(loadSettings(repo).providers?.myprovider?.key_env).toBe("MY_PROVIDER_KEY");
  await cli.run("doctor");
  expect(cli.stdout).not.toContain("myprovider"); // no role names it yet
  writeFileSync(settingsPath(repo), readFileSync(settingsPath(repo), "utf8")
    .replace(/^challenger = .*$/m, 'challenger = "myprovider:m1"'));
  cli.out = [];
  await cli.run("doctor");
  expect(cli.stdout).toContain("✓ Models: BYOM\n  provider myprovider:");
  expect(cli.stdout).toContain("provider myprovider: responses at llm.example.com, MY_PROVIDER_KEY set");
  expect(cli.stdout).not.toContain("secret-value");
  const unset = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  await unset.run("doctor");
  expect(unset.stdout).toContain("MY_PROVIDER_KEY not set");
});

/** Each request `fn` sends through the global fetch, answered as a provider would. */
async function sent(fn: () => Promise<unknown>): Promise<{ url: string; headers: Headers; body: string }[]> {
  const out: { url: string; headers: Headers; body: string }[] = [];
  const real = globalThis.fetch;
  const text = '{"verdict": "ok"}';
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    out.push({ url, headers: new Headers(init?.headers ?? req?.headers),
      body: init?.body ? String(init.body) : req ? await req.text() : "" });
    if (url.endsWith("/v1/messages")) {
      const events = [{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m",
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: "message_stop" }];
      return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
        { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const response = { status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }],
      usage: { input_tokens: 1, output_tokens: 1 } };
    return new Response(`data: ${JSON.stringify({ type: "response.completed", response })}\n\n`, { status: 200 });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return out;
}

test("a custom Responses provider is called at its URL with its own key, from the env object arnx is given", async () => {
  const s: Settings = { ...load(MYPROVIDER), prices: { m: [1, 1, 0, 0] } };
  const ref = parseModelRef("myprovider:m", s.providers);
  expect(() => makeJsonModel(ref, s, {})).toThrow("missing MY_PROVIDER_KEY: export it");
  const [req] = await sent(() => makeJsonModel(ref, s, { MY_PROVIDER_KEY: "mine" }).completeJson("s", "u", SCHEMA));
  expect(req!.url).toBe("https://llm.example.com/v1/responses");
  expect(req!.headers.get("authorization")).toBe("Bearer mine");
  const body = JSON.parse(req!.body) as Record<string, unknown>;
  expect([body.store, body.reasoning, body.background]).toEqual([false, { effort: "high" }, undefined]);
  const [turn] = await sent(() => makeAgentModel({ ...s, reviewer: ref }, { MY_PROVIDER_KEY: "mine" }).create({
    system: "s", tools: [], messages: [{ role: "user", content: "u" }], maxTokens: 10 }));
  expect(JSON.parse(turn!.body)).toMatchObject({ store: false, include: ["reasoning.encrypted_content"] });
});

test("a custom Messages provider gets its own base URL and key, never a token from the process", async () => {
  const s: Settings = { ...load('[providers.ds]\napi = "messages"\nurl = "https://llm2.example/anthropic"\n' +
    'key_env = "DS_KEY"\n'), prices: { m: [1, 1, 0, 0] } };
  const was = process.env.ANTHROPIC_AUTH_TOKEN;
  process.env.ANTHROPIC_AUTH_TOKEN = "process-token";
  try {
    const ref = parseModelRef("ds:m", s.providers);
    const reqs = await sent(() => makeJsonModel(ref, s, { DS_KEY: "ds-key" }).completeJson("s", "u", SCHEMA));
    expect(reqs[0]!.url).toBe("https://llm2.example/anthropic/v1/messages");
    expect(reqs[0]!.headers.get("x-api-key")).toBe("ds-key");
    expect(reqs[0]!.headers.get("authorization")).toBeNull();
    const agent = makeAgentModel({ ...s, reviewer: ref }, { DS_KEY: "ds-key" });
    expect(agent.provider).toBe("ds");
  } finally {
    if (was === undefined) delete process.env.ANTHROPIC_AUTH_TOKEN;
    else process.env.ANTHROPIC_AUTH_TOKEN = was;
  }
});

test("init writes the known providers: checked ones as tables, the others commented; their models are priced", async () => {
  const repo = gitRepo(tmp());
  expect(await new Cli({ cwd: repo, env: {} }).run("init")).toBe(0);
  const text = readFileSync(settingsPath(repo), "utf8");
  for (const k of KNOWN_PROVIDERS) {
    expect(text).toContain(`${k.checked ? "" : "# "}[providers.${k.name}]\n`);
    expect(text).toContain(`challenger = "${k.name}:${k.model}"`);
  }
  const s = loadSettings(repo);
  expect(Object.keys(s.providers ?? {})).toEqual(KNOWN_PROVIDERS.filter((k) => k.checked).map((k) => k.name));
  expect(s.prices).toEqual({}); // no [prices]: the known models' prices are built in
  for (const k of KNOWN_PROVIDERS) expect(PRICES[k.model]).toBeDefined();
  // Nothing calls them: only the default model's key is missing.
  expect(missingKeys(s, {})).toEqual(["ANTHROPIC_API_KEY"]);
});

test("init --force keeps a table the user added after the known providers, or uncommented there; init's own lines are " +
  "written once", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, env: {} });
  await cli.run("init");
  const path = settingsPath(repo);
  writeFileSync(path, readFileSync(path, "utf8").replace("# [providers.deepseek]\n# api = \"messages\"\n" +
    "# url = \"https://api.deepseek.com/anthropic\"\n# key_env = \"DEEPSEEK_API_KEY\"",
  "[providers.deepseek]\napi = \"messages\"\nurl = \"https://api.deepseek.com/anthropic\"\nkey_env = \"MY_DS_KEY\"") +
    MYPROVIDER);
  expect(await cli.run("init", "--force")).toBe(0);
  const text = readFileSync(path, "utf8");
  const s = loadSettings(repo);
  expect(s.providers?.myprovider?.key_env).toBe("MY_PROVIDER_KEY");
  expect(s.providers?.deepseek?.key_env).toBe("MY_DS_KEY");
  expect(text.match(/\[providers\.deepseek\]/g)).toHaveLength(1);
  expect(text).not.toContain("[providers.river]"); // built in
  expect(text.match(/# Other providers arnx knows/g)).toHaveLength(1);
});

test("the harness's keys decide its roles; another provider's key changes nothing", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a", RIVER_API_KEY: "r", DEEPSEEK_API_KEY: "d" } });
  expect(await cli.run("init")).toBe(0);
  const s = loadSettings(repo);
  expect([refString(s.challenger), s.secondHunter, Object.keys(s.providers ?? {})])
    .toEqual(["river:zai-org/GLM-5.3-Flash", undefined, ["zai"]]); // Z.ai's table is written (checked), unused
});
