// The default prompts live in src/prompts.toml; every prompt built from them is byte for byte what arnx 0.1.2 built
// from the templates in code (tests/fixtures/prompts-0.1.2.json), and PROMPT_VERSION keeps 0.1.2's value.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, NEEDED, PLACEHOLDERS, placeholdersIn, PROMPT_KEYS, PROMPT_VERSION } from "../src/prompts";
import { parseOverrides, tomlText } from "../src/userprompts";
import { promptCases } from "./helpers/promptcases";

const FROZEN = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "prompts-0.1.2.json"), "utf8")) as
  Record<string, { sha256: string; text?: string }>;

test("PROMPT_VERSION keeps 0.1.2's value", () => {
  expect(PROMPT_VERSION).toBe("9e0a877404fd");
});

test("every built prompt is byte-equal to 0.1.2's", () => {
  const cases = promptCases();
  expect(Object.keys(cases)).toEqual(Object.keys(FROZEN));
  for (const [name, text] of Object.entries(cases)) {
    const want = FROZEN[name]!;
    if (want.text !== undefined) expect(`${name}: ${text}`).toBe(`${name}: ${want.text}`);
    expect(`${name}: ${createHash("sha256").update(text).digest("hex")}`).toBe(`${name}: ${want.sha256}`);
  }
});

test("src/prompts.toml holds every key, each using exactly the placeholders the code fills", () => {
  const toml = readFileSync(join(import.meta.dir, "..", "src", "prompts.toml"), "utf8");
  const steps = [...toml.matchAll(/^\[([a-z]+)\]$/gm)].map((m) => m[1]);
  expect(steps).toEqual(["review", "hunt", "prove", "rank", "questions", "challenge", "answer", "explain", "setup"]);
  expect(PROMPT_KEYS).toHaveLength(24);
  for (const key of PROMPT_KEYS) {
    expect([key, ...placeholdersIn(DEFAULTS[key])].sort()).toEqual([key, ...PLACEHOLDERS[key]].sort());
    for (const p of NEEDED[key] ?? []) expect(PLACEHOLDERS[key] as readonly string[]).toContain(p);
  }
});

test("a default copied as TOML reads back as the same text", () => {
  for (const key of PROMPT_KEYS) {
    const [step, name] = key.split(".");
    const back = parseOverrides(`[${step}]\n${name} = ${tomlText(DEFAULTS[key])}\n`);
    expect(back[0]?.text).toBe(DEFAULTS[key]);
  }
  for (const text of ["", "  lead", "a  b ".repeat(60), "x\\y \"\"\" z", "\n\nend\n", "w".repeat(300) + " tail"]) {
    expect(parseOverrides(`[rank]\nsystem = ${tomlText(text)}\n`)[0]?.text).toBe(text);
  }
});
