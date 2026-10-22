import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ArnxError, SetupRequired } from "../src/errors";
import { defaultSettings, loadSettings, missingKeys, parseModelRef, refString, writeSettings } from "../src/settings";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

test("test_model_ref_parse", () => {
  expect(refString(parseModelRef("anthropic:claude-sonnet-5-5"))).toBe("anthropic:claude-sonnet-5-5");
  expect(() => parseModelRef("claude-sonnet-5-5")).toThrow(ArnxError);
  expect(() => parseModelRef("mistral:large")).toThrow(ArnxError);
});

test("test_no_openai_floor", () => {
  // The gpt-5.5 floor is arnx's own choice for its defaults and arnx cloud, never a limit on the user's config.
  expect(refString(parseModelRef("openai:gpt-5.4-mini-2026-03-17"))).toBe("openai:gpt-5.4-mini-2026-03-17");
  expect(refString(parseModelRef("openai:o4-mini"))).toBe("openai:o4-mini");
});

/** The default with an OpenAI second opinion and second hunter, as a user would write it. */
const crossVendor = () => ({ ...defaultSettings(), challenger: parseModelRef("openai:gpt-6.1-sol"),
  secondHunter: parseModelRef("openai:gpt-6.1-sol") });

test("the default is Claude, whatever keys are set", () => {
  expect(refString(defaultSettings().challenger)).toBe("anthropic:claude-sonnet-5-5");
  expect(refString(defaultSettings().reviewer)).toBe("anthropic:claude-sonnet-5-5");
});

test("test_round_trip", () => {
  const s = { ...crossVendor(), consentAt: "2026-10-10T12:00:00Z",
    prices: { "some-model": [1.0, 2.0, 0.1, 0.0] as [number, number, number, number] } };
  writeSettings(tmp(), s);
  expect(loadSettings(tmp())).toEqual(s);
});

test("test_load_missing", () => {
  expect(() => loadSettings(tmp())).toThrow(SetupRequired);
  expect(() => loadSettings(tmp())).toThrow(/arnx init/);
});

test("test_missing_keys", () => {
  const s = crossVendor();
  expect(missingKeys(s, { OPENAI_API_KEY: "x" })).toEqual(["ANTHROPIC_API_KEY"]);
  expect(missingKeys(s, { OPENAI_API_KEY: "x", ANTHROPIC_API_KEY: "y" })).toEqual([]);
});

test("init names every role, and the file reads back the same", async () => {
  const { defaultSettings, loadSettings, writeSettings, refString } = await import("../src/settings");
  const s = { ...crossVendor(), challengerFallback: parseModelRef("openai:gpt-6.1-sol") };
  const dir = tmp();
  writeSettings(dir, { ...s, consentAt: "2026-10-14T00:00:00Z" });
  const back = loadSettings(dir);
  expect(refString(back.challengerFallback!)).toBe("openai:gpt-6.1-sol");
  expect(refString(back.hunter!)).toBe("anthropic:claude-haiku-5-5");
  const anthropicOnly = defaultSettings();
  expect([refString(anthropicOnly.challenger), anthropicOnly.challengerFallback, anthropicOnly.secondHunter])
    .toEqual(["anthropic:claude-sonnet-5-5", undefined, undefined]);
});

test("openai_transport and second_hunter_effort load, are checked, and round-trip", () => {
  const load = (models: string) => {
    const dir = tmp();
    mkdirSync(join(dir, ".arnx"), { recursive: true });
    writeFileSync(join(dir, ".arnx", "config.toml"), `[models]\n${models}\n`);
    return loadSettings(dir);
  };
  const unset = load("");
  expect([unset.openaiTransport, unset.secondHunterEffort]).toEqual([undefined, undefined]);
  const hunter = 'second_hunter = "openai:gpt-6.1-sol"\n';
  const set = load(hunter + 'openai_transport = "stream"\nsecond_hunter_effort = " none "');
  expect([set.openaiTransport, set.secondHunterEffort]).toEqual(["stream", "none"]); // trimmed
  expect(() => load('openai_transport = "poll"')).toThrow(/openai_transport.*"background" or "stream"/);
  expect(() => load(hunter + 'second_hunter_effort = ""')).toThrow(/second_hunter_effort/);
  expect(() => load(hunter + 'second_hunter_effort = "  "')).toThrow(/second_hunter_effort/);
  expect(() => load(hunter + "second_hunter_effort = 3")).toThrow(/second_hunter_effort/);
  expect(() => load('second_hunter_effort = "none"')).toThrow("second_hunter_effort needs second_hunter");
  const s = { ...crossVendor(), consentAt: "2026-10-10T12:00:00Z",
    openaiTransport: "background" as const, secondHunterEffort: "low" };
  const dir = tmp();
  writeSettings(dir, s);
  expect(loadSettings(dir)).toEqual(s);
});

test("JEV is off unless [setup] jev = true; the setting is checked and round-trips", () => {
  const load = (text: string) => {
    const dir = tmp();
    mkdirSync(join(dir, ".arnx"), { recursive: true });
    writeFileSync(join(dir, ".arnx", "config.toml"), text);
    return loadSettings(dir);
  };
  expect(load("[models]\n").jev).toBe(false);
  expect(load("[setup]\njev = true\n").jev).toBe(true);
  expect(load("[setup]\njev = false\n").jev).toBe(false);
  expect(() => load('[setup]\njev = "yes"\n')).toThrow("setup.jev: write true or false");
  expect(defaultSettings().jev).toBe(false); // init never turns it on
  const s = { ...defaultSettings(), consentAt: "2026-10-10T12:00:00Z", jev: true };
  const dir = tmp();
  writeSettings(dir, s);
  expect(loadSettings(dir)).toEqual(s);
});

test("with every key, the defaults are the harness, role by role (arnx cloud builds its harness from them)", async () => {
  const { HARNESS, PROVIDER_KEYS } = await import("../src/settings");
  const { costUsd, NO_USAGE, PRICES } = await import("../src/llm");
  const every = Object.fromEntries(Object.values(PROVIDER_KEYS).flat().map((k) => [k, "set"]));
  const s = defaultSettings(every);
  expect({ reviewer: refString(s.reviewer), hunter: refString(s.hunter!), secondHunter: refString(s.secondHunter!),
    challenger: refString(s.challenger), challengerFallback: refString(s.challengerFallback!),
    answerModel: refString(s.answerModel!) }).toEqual({ ...HARNESS });
  // As arnx cloud's loader checks them: each ref parses with no tables, and has a price in the built-in table.
  for (const ref of Object.values(HARNESS)) {
    expect(() => costUsd(parseModelRef(ref).model, NO_USAGE, PRICES)).not.toThrow();
  }
});

test("a role whose key is missing falls back: Claude for the second opinion, no second hunter, no fallback", () => {
  const only = defaultSettings({ ANTHROPIC_API_KEY: "a" });
  expect([refString(only.challenger), only.secondHunter, only.challengerFallback])
    .toEqual(["anthropic:claude-sonnet-5-5", undefined, undefined]);
  const openai = defaultSettings({ ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" });
  expect([refString(openai.challenger), refString(openai.secondHunter!), openai.challengerFallback])
    .toEqual(["anthropic:claude-sonnet-5-5", "openai:gpt-6.1-sol", undefined]);
});
