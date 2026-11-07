// The default prompts live in src/prompts.toml; every prompt built from them is byte for byte what a release froze,
// in three layers: arnx 0.1.2's (tests/fixtures/prompts-0.1.2.json), the setup task as 0.1.5 to 0.1.8 left it
// (tests/fixtures/prompts-0.1.7.json), and what changed after 0.1.8 (tests/fixtures/prompts-0.1.9.json), which also
// holds PROMPT_VERSION. 0.1.9 changed: the hunt, review and prove tasks (a question holds the question alone and
// asks only what the change does not settle; an explanation states as fact only what a test or the code shows) and
// the setup task (test_files, the reasons for uncovered folders, two runs for a web UI app, a type check that
// names one missing module, a proven project stays in the file). The default judge prompt did not change.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, NEEDED, PLACEHOLDERS, placeholdersIn, PROMPT_KEYS, PROMPT_VERSION } from "../src/prompts";
import { parseOverrides, tomlText } from "../src/userprompts";
import { promptCases } from "./helpers/promptcases";

type Frozen = Record<string, { sha256: string; text?: string }>;
const FROZEN = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "prompts-0.1.2.json"), "utf8")) as Frozen;
const CHANGED = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "prompts-0.1.7.json"), "utf8")) as Frozen;
// The default judge prompt's templates, as 0.1.8 shipped them (the J3 "new" variant is opt-in and lives in code).
const JUDGE_SHA = ["12121d7b3881127998db9156d6cf140331a06a2944eaf8d48d36fdf202df7fa7",
  "877fc100e912bd3ec9004d79dee5659d7a8dc1a6ea86bb1ded1e0231b5f1b3e4",
  "dcd1eecca51e7f1936a7a4d1c2bf343dce0c95dcebe484bf03cec93e190e4bce"];
const NEWER = JSON.parse(readFileSync(join(import.meta.dir, "fixtures", "prompts-0.1.9.json"), "utf8")) as Frozen;

test("PROMPT_VERSION has 0.1.9's value; 0.1.7's fixture keeps what 0.1.8 shipped", () => {
  expect(PROMPT_VERSION).toBe("57d401f4abf3");
  expect(NEWER.PROMPT_VERSION?.text).toBe(PROMPT_VERSION);
  expect(CHANGED.PROMPT_VERSION?.text).toBe("1624d507cd4f");
  expect(Object.keys(CHANGED)).toEqual(["setupTask", "setupTask/draft", "PROMPT_VERSION"]);
});

test("every built prompt is byte-equal to the release that last changed it", () => {
  const cases = promptCases();
  expect(Object.keys(cases).filter((k) => !(k in FROZEN))).toEqual(["setupTask/draft"]);
  expect(Object.keys(FROZEN).filter((k) => !(k in cases))).toEqual([]);
  expect(Object.keys(NEWER).filter((k) => !(k in cases) && k !== "PROMPT_VERSION")).toEqual([]);
  for (const [name, text] of Object.entries(cases)) {
    const want = NEWER[name] ?? CHANGED[name] ?? FROZEN[name]!;
    if (want.text !== undefined) expect(`${name}: ${text}`).toBe(`${name}: ${want.text}`);
    expect(`${name}: ${createHash("sha256").update(text).digest("hex")}`).toBe(`${name}: ${want.sha256}`);
  }
  // Only the prompts 0.1.9 words differ from 0.1.8's.
  const moved = Object.keys(NEWER).map((k) => k.split("/")[0]!);
  expect([...new Set(moved)].sort()).toEqual(["PROMPT_VERSION", "huntTask", "proveTask", "reviewTask", "secondHuntTask",
    "setupTask"]);
});

test("0.1.9's lines are in the review, hunt, prove and setup tasks, and the judge prompt is untouched", () => {
  const ask = "Ask only what the change does not settle: read its changelog, docs and comments first. A question holds " +
    "the question alone, with no remark about what you read.";
  const fact = "In an explanation, state as fact only what a test or the code you read shows.";
  for (const k of ["review.task", "hunt.task", "prove.task"] as const) expect(DEFAULTS[k]).toContain(ask);
  for (const k of ["review.task", "prove.task"] as const) expect(DEFAULTS[k]).toContain(fact);
  expect(DEFAULTS["setup.task"]).toContain("gets two runs of its node or jsdom unit tests");
  expect(DEFAULTS["setup.task"]).not.toContain("one try");
  expect(DEFAULTS["setup.task"]).toContain("A type check whose errors name one missing module");
  expect(DEFAULTS["setup.task"]).toContain("not set up (a folder with tests you did not set up)");
  expect(DEFAULTS["setup.task"]).toContain("A project that try_project has proven stays in the file");
  const judge = ["challenge.system", "challenge.task", "challenge.depends"] as const;
  const sha = (k: (typeof judge)[number]) => createHash("sha256").update(DEFAULTS[k]).digest("hex");
  expect(judge.map(sha)).toEqual(JUDGE_SHA);
});

test("src/prompts.toml holds every key, each using exactly the placeholders the code fills", () => {
  const toml = readFileSync(join(import.meta.dir, "..", "src", "prompts.toml"), "utf8");
  const steps = [...toml.matchAll(/^\[([a-z]+)\]$/gm)].map((m) => m[1]);
  expect(steps).toEqual(["review", "hunt", "prove", "rank", "questions", "challenge", "answer", "explain", "setup",
    "fix"]);
  expect(PROMPT_KEYS).toHaveLength(28);
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

test("setup is told how to stand in for a service the sandbox cannot run", () => {
  expect(DEFAULTS["setup.task"]).toContain("use a stand-in that behaves like it, such as mongomock for MongoDB");
  expect(DEFAULTS["setup.task"]).toContain("Never replace it with MagicMock");
});
