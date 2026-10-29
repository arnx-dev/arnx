// `[models] setup` and `setup_effort`: the model setup runs on, and its effort. Unset, setup runs on Claude Sonnet with
// a Claude reviewer, else on the reviewer, at `effort`.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeAgentModel } from "../src/llm";
import { defaultSettings, loadSettings, missingKeys, parseModelRef, refString, settingsPath, setupRef, setupSettings,
  writeSettings } from "../src/settings";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const HAIKU = "anthropic:claude-haiku-5-5";

const load = (models: string) => {
  const dir = tmp();
  mkdirSync(join(dir, ".arnx"), { recursive: true });
  writeFileSync(settingsPath(dir), `[models]\n${models}\n`);
  return loadSettings(dir);
};

test("setup and setup_effort load, are checked, and round-trip", () => {
  const unset = load("");
  expect([unset.setup, unset.setupEffort]).toEqual([undefined, undefined]);
  const set = load(`setup = "${HAIKU}"\nsetup_effort = "low"`);
  expect([refString(set.setup!), set.setupEffort]).toEqual([HAIKU, "low"]);
  expect(() => load('setup = "claude-haiku-5-5"')).toThrow(/model 'claude-haiku-5-5': write it as provider:model/);
  expect(() => load('setup_effort = "max"')).toThrow('.arnx/config.toml: models.setup_effort: "max"; write "low", ' +
    '"medium", "high"');
  expect(() => load("setup_effort = 1")).toThrow(/models.setup_effort/);
  const s = { ...defaultSettings(), consentAt: "2026-10-28T00:00:00Z", setup: parseModelRef(HAIKU),
    setupEffort: "high" as const };
  const dir = tmp();
  writeSettings(dir, s);
  expect(loadSettings(dir)).toEqual(s);
  expect(readFileSync(settingsPath(dir), "utf8")).toContain(`reviewer = "anthropic:claude-sonnet-5-5"      # reviews ` +
    `the change, writes and runs the tests\nsetup = "${HAIKU}"          # sets up the test environment\n` +
    'setup_effort = "high"                         # setup\'s own effort\n');
});

test("unset, setup runs on Sonnet with a Claude reviewer, else on the reviewer; effort falls back on its own", () => {
  const s = { ...defaultSettings(), setup: undefined };
  expect(setupSettings(s)).toBe(s);
  expect(refString(setupRef(s))).toBe("anthropic:claude-sonnet-5-5");
  const opus = { ...s, reviewer: parseModelRef("anthropic:claude-opus-5-5") };
  expect(refString(setupRef(opus))).toBe("anthropic:claude-sonnet-5-5");
  expect([refString(setupSettings(opus).reviewer), setupSettings(opus).effort])
    .toEqual(["anthropic:claude-sonnet-5-5", "medium"]);
  const gpt = { ...s, reviewer: parseModelRef("openai:gpt-5.5-2026-04-23") };
  expect(setupSettings(gpt)).toBe(gpt);
  expect(missingKeys(gpt, { OPENAI_API_KEY: "o" }, [setupRef(gpt)])).toEqual([]);
  expect(missingKeys(opus, { OPENAI_API_KEY: "o" }, [setupRef(opus)])).toEqual(["ANTHROPIC_API_KEY"]);
  const model = setupSettings({ ...s, setup: parseModelRef(HAIKU) });
  expect([refString(model.reviewer), model.effort]).toEqual([HAIKU, "medium"]);
  const effort = setupSettings({ ...s, setupEffort: "low" });
  expect([refString(effort.reviewer), effort.effort]).toEqual(["anthropic:claude-sonnet-5-5", "low"]);
  // Setup checks its own model's key; the other commands only the keys of the models they call.
  const openai = { ...s, setup: parseModelRef("openai:gpt-5.5-2026-04-23") };
  const claude = { ...defaultSettings(), reviewer: parseModelRef("openai:gpt-5.5-2026-04-23"),
    challenger: parseModelRef("openai:gpt-5.5-2026-04-23"), hunter: undefined, answerModel: undefined,
    secondHunter: undefined, challengerFallback: undefined, setup: parseModelRef("anthropic:claude-sonnet-5-5") };
  expect(missingKeys(claude, { OPENAI_API_KEY: "o" })).toEqual([]);
  expect(missingKeys(claude, { OPENAI_API_KEY: "o" }, [setupRef(claude)])).toEqual(["ANTHROPIC_API_KEY"]);
  expect(missingKeys(openai, { ANTHROPIC_API_KEY: "a" }, [setupRef(openai)])).toEqual(["OPENAI_API_KEY"]);
  expect(missingKeys(openai, { OPENAI_API_KEY: "o" }, [setupRef(openai)])).toEqual([]);
});

test("init writes setup on Sonnet, next to the reviewer; commented after a reviewer of another vendor", async () => {
  const repo = initRepo(tmp());
  expect(await new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } }).run("init")).toBe(0);
  const text = readFileSync(settingsPath(repo), "utf8");
  expect(text).toContain("# reviews the change, writes and runs the tests\n" +
    'setup = "anthropic:claude-sonnet-5-5"         # sets up the test environment\n');
  expect(refString(loadSettings(repo).setup!)).toBe("anthropic:claude-sonnet-5-5");
  const dir = tmp();
  writeSettings(dir, { ...defaultSettings(), setup: undefined, reviewer: parseModelRef("openai:gpt-5.5-2026-04-23") });
  expect(readFileSync(settingsPath(dir), "utf8")).toContain(
    '# setup = "anthropic:claude-sonnet-5-5"       # sets up the test environment; default: reviewer\n');
  expect(loadSettings(dir).setup).toBeUndefined();
});

/** Each request `fn` sends through the global fetch, answered with a text reply that ends the turn. */
async function sent(fn: () => Promise<unknown>): Promise<{ url: string; body: Record<string, unknown> }[]> {
  const out: { url: string; body: Record<string, unknown> }[] = [];
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = input instanceof Request ? input : null;
    out.push({ url: req ? req.url : String(input),
      body: JSON.parse(init?.body ? String(init.body) : req ? await req.text() : "{}") });
    const events = [{ type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m",
      content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Giving up." } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: "message_stop" }];
    return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),
      { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as typeof fetch;
  try {
    await fn();
  } finally {
    globalThis.fetch = real;
  }
  return out;
}

test("setup's agent sends the setup model and its effort; without them, the reviewer's", async () => {
  const s = defaultSettings();
  const env = { ANTHROPIC_API_KEY: "a" };
  const turn = (t: typeof s) => sent(() => makeAgentModel(setupSettings(t), env).create({ system: "s", tools: [],
    messages: [{ role: "user", content: "u" }], maxTokens: 10 }));
  const [own] = await turn({ ...s, setup: parseModelRef(HAIKU), setupEffort: "low" });
  expect([own!.body.model, own!.body.output_config]).toEqual(["claude-haiku-5-5", { effort: "low" }]);
  const [plain] = await turn({ ...s, setup: undefined });
  expect([plain!.body.model, plain!.body.output_config]).toEqual(["claude-sonnet-5-5", { effort: "medium" }]);
});

/** A repository with one passing test, initialized and agreed to, its reviewer on OpenAI (unpriced) and its setup on
 * Claude Haiku at low effort. */
async function shop(): Promise<string> {
  const repo = initRepo(join(tmp(), "shop"));
  writeFileSync(join(repo, "pricing.py"), "def total(xs):\n    return sum(xs)\n");
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests", "test_pricing.py"), "def test_total():\n    assert True\n");
  commit(repo, "shop");
  const env = { ANTHROPIC_API_KEY: "a" };
  expect(await new Cli({ cwd: repo, env }).run("init")).toBe(0);
  expect(await new Cli({ cwd: repo, env }).run("consent", "--yes")).toBe(0);
  writeFileSync(settingsPath(repo), readFileSync(settingsPath(repo), "utf8")
    .replace(/^reviewer = .*$/m, 'reviewer = "openai:mystery-model"')
    .replace(/^setup = .*$/m, `setup = "${HAIKU}"\nsetup_effort = "low"`));
  return repo;
}

test("setup runs on the setup model: its key only, its price, its name in the events and the usage log", async () => {
  const repo = await shop();
  const env = { ANTHROPIC_API_KEY: "a" };
  const pass = junitXml([["tests/test_pricing.py", "test_total", "passed", ""]]);
  const cli = new Cli({ cwd: repo, env,
    setupSessions: async (_cfg, snap, _log, body) => body(new FakeSession(snap, () => [pass, "1 passed", false])) });
  const reqs = await sent(() => cli.run("setup", "--yes"));
  expect(cli.stderr).not.toContain("OPENAI_API_KEY"); // the reviewer's key is not needed to set up
  expect(cli.stdout).not.toContain("No price for");
  expect(reqs.length).toBeGreaterThan(0);
  for (const r of reqs) {
    expect([r.url, r.body.model, r.body.output_config]).toEqual(["https://api.anthropic.com/v1/messages",
      "claude-haiku-5-5", { effort: "low" }]);
  }
  const outDir = join(repo, ".arnx", "setup");
  const id = readdirSync(outDir).find((n) => existsSync(join(outDir, n, "events.jsonl")))!;
  const started = JSON.parse(readFileSync(join(outDir, id, "events.jsonl"), "utf8").split("\n")[0]!);
  expect([started.type, started.data.model]).toEqual(["setup.started", HAIKU]);
  const usage = JSON.parse(readFileSync(join(repo, ".arnx", "usage.jsonl"), "utf8").trim().split("\n").at(-1)!);
  expect(usage.usage.map((u: { model: string }) => u.model)).toEqual([HAIKU]);
  // A review still needs the reviewer's key.
  const review = new Cli({ cwd: repo, env });
  expect(await review.run("review")).toBe(3);
  expect(review.stderr).toContain("OPENAI_API_KEY");
});

test("doctor names setup's model when it is not the reviewer's", async () => {
  const repo = await shop();
  const env = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };
  const doctor = async () => {
    const cli = new Cli({ cwd: repo, env });
    await cli.run("doctor");
    return cli.stdout;
  };
  expect(await doctor()).toContain(`✓ Models: BYOM\n  setup: ${HAIKU}, effort low\n`);
  const text = readFileSync(settingsPath(repo), "utf8");
  writeFileSync(settingsPath(repo), text.replace(/^setup_effort = .*\n/m, ""));
  expect(await doctor()).toContain(`✓ Models: BYOM\n  setup: ${HAIKU}\n`);
  writeFileSync(settingsPath(repo), text.replace(/^setup.*\n/gm, ""));
  expect(await doctor()).not.toContain("setup:");
  writeFileSync(settingsPath(repo), text.replace(/^setup = .*$/m, 'setup = "openai:mystery-model"')
    .replace(/^setup_effort = .*\n/m, ""));
  expect(await doctor()).not.toContain("setup:"); // the reviewer's model, at the reviewer's effort
});
