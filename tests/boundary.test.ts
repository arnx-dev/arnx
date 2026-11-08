// The outbound filter: a value under a secret-looking name never leaves arnx by any route, whatever the snapshot holds.
// One test per route, each recording at the outermost layer a request passes. A route added later belongs here, and the
// last test fails until it is named.
import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeAnswerRunner } from "../src/accept";
import { agreements, selfAgreement } from "../src/valueindex";
import { accept } from "../src/accept";
import { Boundary, boundaryOf, diffSuspects, isMasked, maskedAgent, maskedJson, piecesAllowed, STAND_INS_NOTE }
  from "../src/boundary";
import { check, checkJson, checkSummary } from "../src/check";
import { recheckJson, recheckReview, recheckSummary } from "../src/recheck";
import { CloudClient } from "../src/cloud";
import { clipOutput as cutForBrain, CloudBrain } from "../src/cloudbrain";
import { loadReviewFile, parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { BIG_KEYS_MOST, changeLimits, takeSnapshot } from "../src/change";
import { ModelError } from "../src/errors";
import { EventLog } from "../src/events";
import { classify, describeHints, errorLine, firstLine } from "../src/diagnose";
import { jevModel } from "../src/jev";
import { AnthropicJson, FallbackJson, type AgentModel, type Block, type JsonModel, type JsonReply, makeAgentModel,
  makeChallenger, makeJsonModel, makeSecondHunter, PRICES, type Reply, ResponsesJson } from "../src/llm";
import { LocalBrain } from "../src/localbrain";
import { describeRun } from "../src/outcomes";
import { DEFAULT_PROMPTS, explainUser } from "../src/prompts";
import { runReview } from "../src/reviewer";
import { probeFailure } from "../src/testround";
import type { ExecFactory } from "../src/sandbox";
import { isCertainRule, standInsFor, suspects } from "../src/secrets";
import { defaultSettings, parseModelRef, type Settings, writeSettings } from "../src/settings";
import { runSetup, skipReasons } from "../src/setup";
import { clipOutput } from "../src/setupexec";
import { checkData, reportTelemetry } from "../src/telemetry";
import { Cli } from "./helpers/cli";
import { type FakeCloud, fakeCloud, type StepScript, TOKEN } from "./helpers/cloudfake";
import { fakeFactory, FakeSession, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

// No test here may reach a provider: only this machine's own fake server gets past this.
const realFetch = globalThis.fetch;
const outside: string[] = [];
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = input instanceof Request ? input.url : String(input);
  if (new URL(url).hostname === "localhost") return realFetch(input, init);
  outside.push(url);
  throw new Error(`a test tried to reach ${url}`);
}) as typeof fetch;
afterAll(() => {
  globalThis.fetch = realFetch;
  expect(outside).toEqual([]);
});

/** On a changed line, in a file read, and printed by a test. */
const CANARY = "Zq7xK2mP9vR4tY1w";
/** Only on the removed side of the diff. */
const REMOVED = "Hb3nW8sL5cT2jF6g";
/** Only in a file the change leaves alone. */
const UNCHANGED = "Pd4rG9yQ1mV7kX3e";
/** Under a name in a secret file, which never enters the snapshot, and bare in a file that does. */
const IN_SECRET_FILE = "Lc2vN7bJ4wS9hD5a";
/** Only in .arnx/review.yaml. */
const IN_CONFIG = "Vg5tB1nM8qC6zJ2p";
const ALL = [CANARY, REMOVED, UNCHANGED, IN_SECRET_FILE];
const FAKED = new Boundary(ALL).mask(CANARY);

const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };
const tmp = useTmp();

/** Fails naming the value, never printing the whole request. */
function expectClean(what: string, sent: string): void {
  for (const value of ALL) {
    if (sent.includes(value)) throw new Error(`${what}: a real value left arnx: ${value}`);
  }
}

/** `api_token` changes value; another file holds a secret that stays; the snapshot keeps real values (no stand-ins). */
function leakyRepo(o: { standIns?: boolean; big?: boolean } = {}): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-11-04"));
  writeSettings(repo, { ...SETTINGS, standIns: o.standIns ?? false });
  writeFileSync(join(repo, "settings.py"), `api_token = "${REMOVED}"\n`);
  writeFileSync(join(repo, "other.py"), `db_password = "${UNCHANGED}"\nwire = "${IN_SECRET_FILE}"\n`);
  writeFileSync(join(repo, ".env"), `SESSION_SECRET=${IN_SECRET_FILE}\n`);
  writeFileSync(join(repo, "more.py"), "# nothing yet\n");
  commit(repo, "the secrets");
  writeFileSync(join(repo, "settings.py"), `api_token = "${CANARY}"\n`);
  if (o.big) {
    // Over the limit a change is hunted in parts.
    writeFileSync(join(repo, "app.py"), `token = "${CANARY}"\n` + "x = 1 # padding padding padding padding\n".repeat(1200));
    writeFileSync(join(repo, "more.py"), `secret = "${CANARY}"\n` + "y = 2 # padding padding padding padding\n".repeat(1200));
  }
  return repo;
}

const REPORT = (extra: string[] = []) => JSON.stringify({
  tests: [{ test: `${GEN}::test_add`, expects: "add sums" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: ["Keep it?", ...extra] });
const SOURCE = "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n";
/** Reads the files, searches, writes a test, runs it, reports. */
const TURNS = (): Block[][] => [
  [tool("read_file", { path: "settings.py" }), tool("read_file", { path: "other.py" }),
    tool("grep", { pattern: "api_token|db_password", path: "." })],
  [tool("write_file", { path: GEN, content: SOURCE }), tool("run_tests", {})],
];
/** What the fake sandbox prints: the value in the output and in the failure message. */
const leakyRun = (): [string | null, string, boolean] => [junitXml([[GEN, "test_add", "failed",
  `assert "${CANARY}" == 5`]]), `E   token=${CANARY}\n1 failed\n`, false];

/** A provider's place in a test: everything a call was given is what would go on the wire. */
class RecordingAgent implements AgentModel {
  model = "claude-sonnet-5-5";
  notice?: (message: string) => void;
  bodies: string[] = [];
  constructor(private steps: Block[][], private last = REPORT()) {}
  async create(a: Parameters<AgentModel["create"]>[0]): Promise<Reply> {
    this.bodies.push(JSON.stringify(a));
    const blocks = this.steps.shift() ?? [text(this.last)];
    return { content: blocks, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, raw: blocks,
      stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
  }
}
class RecordingJson implements JsonModel {
  bodies: string[] = [];
  constructor(readonly ref: string, private reply: Record<string, unknown> | ((n: number) => Record<string, unknown>)) {}
  async completeJson(system: string, user: string, schema: Record<string, unknown>): Promise<JsonReply> {
    this.bodies.push(JSON.stringify({ system, user, schema }));
    return [typeof this.reply === "function" ? this.reply(this.bodies.length) : this.reply, 0.01];
  }
}
const VERDICT = { verdict: "confirmed", reason: "It subtracts.", groups: [] };

let clouds: FakeCloud[] = [];
afterEach(() => {
  for (const c of clouds) c.stop();
  clouds = [];
});
const ROUND: StepScript[] = [
  { type: "actions", actions: [{ name: "read_file", input: { path: "settings.py" } },
    { name: "read_file", input: { path: "other.py" } }, { name: "grep", input: { pattern: "api_token", path: "." } }] },
  { type: "actions", actions: [{ name: "write_file", input: { path: GEN, content: SOURCE } }, { name: "run_tests", input: {} }] },
  { type: "final", report: { tests: [{ test: `${GEN}::test_add`, expects: "add sums" }], suspected_defects: [],
    questions: [] } },
  { type: "done", stop: "end_turn" },
];
const cloudOf = (rounds: StepScript[] = ROUND) => {
  const c = fakeCloud({ rounds: { "*": rounds.map((s) => ({ ...s })) } });
  clouds.push(c);
  return c;
};
const brainOf = (c: FakeCloud, boundary = new Boundary()) => new CloudBrain({ boundary,
  client: new CloudClient(c.url, { token: TOKEN, delays: [0] }), tier: "medium" });
const wire = (c: FakeCloud) => JSON.stringify(c.seen.map((x) => [x.path, x.body]));

// --- all of them at once ---------------------------------------------------------------------------------------------

test("a canary under a secret-looking name never leaves by any route", async () => {
  const repo = leakyRepo();
  const agent = new RecordingAgent(TURNS()), judge = new RecordingJson("openai:x", VERDICT);
  const local = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge,
    sessionFactory: fakeFactory(leakyRun) });
  const c = cloudOf();
  await runReview(repo, { settings: SETTINGS, brain: brainOf(c), sessionFactory: fakeFactory(leakyRun) });
  const asked: string[] = [];
  const jev = (async (_u: string, init: RequestInit) => {
    asked.push(String(init.body));
    return new Response("{}");
  }) as unknown as typeof fetch;
  await jevModel("k", null, new Boundary([CANARY]), jev)(`assert "${CANARY}"`, parseReviewConfig(YAML), []);
  for (const [route, sent] of Object.entries({ agent: agent.bodies, json: judge.bodies, cloud: [wire(c)], jev: asked })) {
    expect([route, sent.length > 0]).toEqual([route, true]);
    expectClean(route, sent.join("\n"));
  }
  expectClean("events", readFileSync(join(local.rdir, "events.jsonl"), "utf8"));
});

test("with stand-ins on, as by default, a value on a changed line still never reaches a model", async () => {
  const repo = leakyRepo({ standIns: true });
  const agent = new RecordingAgent([]);
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson("openai:x", VERDICT),
    sessionFactory: fakeFactory(leakyRun) });
  expectClean("the diff", agent.bodies.join("\n"));
  expect(agent.bodies[0]).toContain("+api_token");
});

test("a guess stays real in the run snapshot, and reaches no model through read_file, grep or run output", async () => {
  const repo = leakyRepo({ standIns: true });
  const agent = new RecordingAgent(TURNS());
  let seen = "";
  // A run sees the snapshot as it is: what it prints holds the real values of every file it read.
  const realRun = (snap: () => string) => (): [string | null, string, boolean] => {
    seen = ["settings.py", "other.py"].map((f) => readFileSync(join(snap(), f), "utf8")).join("");
    return [junitXml([[GEN, "test_add", "failed", `assert "${seen}" == 5`]]), `E   ${seen}\n1 failed\n`, false];
  };
  const made: FakeSession[] = [];
  const factory = fakeFactory(realRun(() => made[0]!.snap), made);
  const judge = new RecordingJson("openai:x", VERDICT);
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge, sessionFactory: factory });
  // The snapshot held the real values, so this is the filter's work.
  expect(seen).toContain(CANARY);
  expect(seen).toContain(UNCHANGED);
  const sent = agent.bodies.join("\n");
  expectClean("every tool's result", sent);
  expectClean("the second opinion", judge.bodies.join("\n"));
  const faked = new Boundary(ALL);
  // Each tool came back, with the stand-in where the value was.
  expect(sent).toContain(`api_token = \\\"${faked.mask(CANARY)}`);
  expect(sent).toContain(`db_password = \\\"${faked.mask(UNCHANGED)}`);
  expect(sent).toContain(`E   api_token = \\\"${faked.mask(CANARY)}`);
});

// --- what a test can make of a real value --------------------------------------------------------------------------

const b64 = (t: string) => Buffer.from(t).toString("base64");
const url64 = (t: string) => b64(t).replaceAll("+", "-").replaceAll("/", "_");
/** A value whose base64 holds both the signs base64 and its URL form differ on. */
const SIGNS_VALUE = "Zq~7x?K2>mP9vR4tY1wA";

test("each encoded form of a value is masked, and each stand-in is the stand-in's own encoding", () => {
  expect(b64(SIGNS_VALUE)).toMatch(/[+/]/);
  expect(b64(SIGNS_VALUE)).toMatch(/=$/);
  for (const value of [CANARY, SIGNS_VALUE]) {
    const b = new Boundary([value]);
    const fake = b.mask(value);
    expect(fake).not.toBe(value);
    for (const [name, encode] of Object.entries({
      "base64": b64, "base64 unpadded": (t: string) => b64(t).replace(/=+$/, ""), "base64url": url64,
      "base64url unpadded": (t: string) => url64(t).replace(/=+$/, ""),
      "hex": (t: string) => Buffer.from(t).toString("hex"), "HEX": (t: string) => Buffer.from(t).toString("hex").toUpperCase(),
      "upper": (t: string) => t.toUpperCase(), "lower": (t: string) => t.toLowerCase() })) {
      const form = encode(value);
      const out = b.mask(`x = "${form}";`);
      expect([name, out.includes(form)]).toEqual([name, false]);
      if (!name.includes("padded")) expect([name, out]).toEqual([name, `x = "${encode(fake)}";`]);
    }
  }
});

test("a value in the base64 of a longer text is masked, whatever stands around it", () => {
  const b = new Boundary([CANARY]);
  for (const text of [`app:${CANARY}`, `a:${CANARY}`, `someone@example.com:${CANARY}`, `${CANARY}:suffix`, `x${CANARY}yz`]) {
    for (const encode of [b64, url64]) {
      const whole = encode(text);
      const out = b.mask(`Authorization: Basic ${whole}`);
      expect([text, out.includes(whole)]).toEqual([text, false]);
      // What is left is what stands around it, and at most the bits it shares with those characters.
      const decoded = Buffer.from(out.slice("Authorization: Basic ".length), "base64").toString("latin1");
      expect([text, decoded.includes(CANARY)]).toEqual([text, false]);
      for (let i = 0; i + 4 <= CANARY.length; i++) {
        expect([text, i, decoded.includes(CANARY.slice(i, i + 4))]).toEqual([text, i, false]);
      }
    }
  }
});

test("a runner's cut of that base64 leaves no long tail of it", () => {
  const b = new Boundary([CANARY]);
  for (const user of ["app", "ab", "a"]) {
    const whole = b64(`${user}:${CANARY}`);
    const tail = whole.replace(/=+$/, "").slice(-12);
    const out = b.mask(`assert 'Basic ${whole.slice(0, 6)}...${tail}${whole.slice(whole.replace(/=+$/, "").length)}' == 'x'`);
    expect([user, out.includes(tail)]).toEqual([user, false]);
  }
});

test("a word-like address password keeps its case: its other case is a name, and its encodings are not", () => {
  const value = "access_token@";
  const b = new Boundary([value]);
  expect(b.mask("ACCESS_TOKEN = 1; access_token = 2")).toBe("ACCESS_TOKEN = 1; access_token = 2");
  const encoded = b64("access_token").replace(/=+$/, "");
  expect(b.mask(`x ${encoded} y`)).not.toContain(encoded);
});

test("short values have no encoded forms: short text turns up by chance", () => {
  const b = new Boundary(["abc@"]);
  expect(b.mask(`${b64("abc")} ABC`)).toBe(`${b64("abc")} ABC`);
});

// What a dump prints, as the tools lay it out: 16 bytes a line, in pairs (xxd) or apart (hexdump -C, with a gap in the middle).
const bytesOf = (t: string) => [...Buffer.from(t)].map((n) => n.toString(16).padStart(2, "0"));
const xxdOf = (t: string) => bytesOf(t).reduce<string[][]>((lines, h, i) => {
  if (i % 16 === 0) lines.push([]);
  lines.at(-1)!.push(h);
  return lines;
}, []).map((l, n) => `${(n * 16).toString(16).padStart(8, "0")}: ${l.map((h, i) => i % 2 ? h : ` ${h}`).join("").trim()}`).join("\n") + "\n";
const hexdumpOf = (t: string) => bytesOf(t).reduce<string[][]>((lines, h, i) => {
  if (i % 16 === 0) lines.push([]);
  lines.at(-1)!.push(h);
  return lines;
}, []).map((l, n) => `${(n * 16).toString(16).padStart(8, "0")}  ${l.slice(0, 8).join(" ")}  ${l.slice(8).join(" ")}`).join("\n") + "\n";

test("the hex column of a dump goes: spaced, in pairs at either start, whole or split across lines", () => {
  const b = new Boundary([CANARY]);
  const fake = b.mask(CANARY);
  const inner = bytesOf(CANARY);
  expect(b.mask(`x ${inner.join(" ")} y`)).toBe(`x ${bytesOf(fake).join(" ")} y`);
  /** Whether `text` shows six bytes running of the value, in any of the layouts. */
  const shows = (text: string) => Array.from({ length: inner.length - 5 }, (_, i) => inner.slice(i, i + 6))
    .some((run) => text.includes(run.join(" ")) || text.includes(run.join("")) ||
      text.includes(run.join("").match(/.{1,4}/g)!.join(" ")) || text.includes(`${run[0]} ${run.slice(1).join("").match(/.{1,4}/g)!.join(" ")}`));
  expect(shows(xxdOf(CANARY))).toBe(true);
  // Aligned to a line, off by one, two or three bytes: then it runs over two lines.
  for (const before of ["", "a", "ab", "abc"]) {
    expect([before, shows(b.mask(xxdOf(`${before}${CANARY}`)))]).toEqual([before, false]);
  }
  expect(shows(b.mask(hexdumpOf(CANARY)))).toBe(false);
});

test("what hexdump's gap leaves between a value's two ends stays, as SAFETY.md says", () => {
  const b = new Boundary([CANARY]);
  const out = b.mask(hexdumpOf(`abc${CANARY}`));
  const inner = bytesOf(CANARY);
  // Its start is gone; the eight bytes after the gap are a piece from the middle.
  expect(out).not.toContain(inner.slice(0, 5).join(" "));
  expect(out).toContain(inner.slice(5, 13).join(" "));
});

test("hex that only looks alike stays: a dump of other bytes, a checksum, a list of numbers", () => {
  const b = new Boundary([CANARY]);
  const other = xxdOf("nothing to see in this file at all\n") + hexdumpOf("nothing to see in this file at all\n");
  expect(b.mask(other)).toBe(other);
  expect(b.mask("5a 71 37 78")).toBe("5a 71 37 78");
  const text = "ff 00 ff 00 de ad be ef 12 34\n0123 4567 89ab cdef\n";
  expect(b.mask(text)).toBe(text);
});

test("only the value's plain forms come back from unmask: an encoded form's stand-in has no one place to go", () => {
  const b = new Boundary([CANARY]);
  expect(b.unmask(b.mask(CANARY))).toBe(CANARY);
});

test("many values with their forms stay quick to add and to mask with", () => {
  const values = Array.from({ length: 5000 }, (_, i) => `Zq7xK2mP9vR4tY${i}w`);
  const t0 = performance.now();
  const b = new Boundary(values);
  const text = "lorem ipsum dolor sit amet ".repeat(40_000);
  expect(b.mask(text)).toBe(text);
  expect(performance.now() - t0).toBeLessThan(1500);
});

// --- what a coding agent reads next -----------------------------------------------------------------------------------

/** A review whose failing test prints the real values, as the code holds them. */
async function reviewedCanary() {
  const repo = leakyRepo({ standIns: true });
  const out = `E  token=${CANARY} ${b64(`app:${CANARY}`)} ${CANARY.toUpperCase()}\n1 failed\n`;
  const run = (): [string | null, string, boolean] => [junitXml([[GEN, "test_add", "failed",
    `assert "${CANARY}" == "${b64(`app:${UNCHANGED}`)}"`]]), out, false];
  const settings: Settings = { ...SETTINGS, standIns: true };
  writeSettings(repo, settings);
  const r = await runReview(repo, { settings, agentModel: new RecordingAgent(TURNS()),
    challenger: new RecordingJson("openai:x", VERDICT), sessionFactory: fakeFactory(run) });
  return { repo, settings, run, ...r };
}
/** Fails on the value in any form a test here makes of it. */
function expectNoForm(what: string, text: string): void {
  const encoded = [CANARY, UNCHANGED].flatMap((v) => [v, v.toUpperCase(), b64(`app:${v}`)]);
  for (const form of encoded) if (text.includes(form)) throw new Error(`${what} holds a real value: ${form}`);
}

test("review.json, review.md, round.json and the review returned hold no real value, and say so", async () => {
  const { review, rdir } = await reviewedCanary();
  expect(review.findings.length).toBeGreaterThan(0);
  expectNoForm("the review returned", JSON.stringify(review));
  for (const f of ["review.json", "review.md"]) expectNoForm(f, readFileSync(join(rdir, f), "utf8"));
  const rounds = (readdirSync(rdir, { recursive: true }) as string[]).filter((f) => f.endsWith("round.json"));
  expect(rounds.length).toBeGreaterThan(0);
  for (const f of rounds) expectNoForm(f, readFileSync(join(rdir, f), "utf8"));
  expect(readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " ")).toContain(STAND_INS_NOTE);
  expect(JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")).stand_ins_shown).toBe(true);
});

test("what a model's report quotes is masked in the saved review too", async () => {
  const repo = leakyRepo({ standIns: true });
  const report = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }], questions: [],
    suspected_defects: [{ test: `${GEN}::test_add`, explanation: `It sends ${UNCHANGED}.` }] });
  // The judge's reply goes straight into the review: no round's mask covers it.
  const judge = new RecordingJson("openai:x", { ...VERDICT, reason: `It holds ${UNCHANGED}.` });
  const { review, rdir } = await runReview(repo, { settings: { ...SETTINGS, standIns: true },
    agentModel: new RecordingAgent(TURNS(), report), challenger: judge, sessionFactory: fakeFactory(leakyRun) });
  expect(review.findings[0]!.explanation).toContain("It sends ");
  expect(review.findings[0]!.reason).toContain("It holds ");
  expectNoForm("the review returned", JSON.stringify(review));
  for (const f of ["review.json", "review.md"]) expectNoForm(f, readFileSync(join(rdir, f), "utf8"));
});

test("the fix prompt holds no real value, whatever the review on disk quotes", async () => {
  const { repo, rdir, settings } = await reviewedCanary();
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  writeFileSync(join(rdir, "review.md"), md.replace(/Mark: \[[^\]]*\] real/g, "Mark: [x] real"));
  const saved = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8"));
  saved.findings[0].explanation = `It sends ${UNCHANGED}.`;
  writeFileSync(join(rdir, "review.json"), JSON.stringify(saved));
  await accept(repo, rdir, settings, { answerRunner: null });
  expect(readFileSync(join(rdir, "fix-prompt.md"), "utf8")).toContain("It sends");
  const prompt = readFileSync(join(rdir, "fix-prompt.md"), "utf8");
  expectNoForm("fix-prompt.md", prompt);
  expect(prompt.replace(/\s+/g, " ")).toContain(STAND_INS_NOTE);
});

test("arnx check says no real value: its results, its JSON, its summary and its log", async () => {
  const repo = leakyRepo({ standIns: true });
  mkdirSync(join(repo, ".arnx/tests/tests/arnx/r1"), { recursive: true });
  writeFileSync(join(repo, ".arnx/tests/tests/arnx/r1/test_kept.py"), "def test_kept():\n    assert False\n");
  const failing = () => [junitXml([["tests/arnx/r1/test_kept.py", "test_kept", "failed",
    `assert "${UNCHANGED}" == "${b64(`app:${UNCHANGED}`)}"`]]), `E  ${UNCHANGED}\n`, false] as [string, string, boolean];
  const results = await check(repo, SETTINGS, { sessionFactory: fakeFactory(failing) });
  expect(results[0]!.failed.length).toBe(1);
  const [summary, code] = checkSummary(results);
  expectNoForm("check", JSON.stringify(results));
  expectNoForm("check --json", checkJson(results, code));
  expect(JSON.parse(checkJson(results, code)).stand_ins_shown).toBe(true);
  expect(summary).toContain(STAND_INS_NOTE);
  // A run that gave no report: its output goes to a log a coding agent is pointed at.
  const none = () => [null, `E  ${UNCHANGED}\n`, false] as [null, string, boolean];
  const [gone] = await check(repo, SETTINGS, { sessionFactory: fakeFactory(none) });
  expect(gone!.log).toBeTruthy();
  expectNoForm("the check's log", readFileSync(join(repo, gone!.log!), "utf8"));
});

test("arnx check --review says no real value", async () => {
  const { repo, rdir, settings, run } = await reviewedCanary();
  const r = await recheckReview(repo, rdir, settings, { sessionFactory: fakeFactory(run) });
  expect(r.findings.some((f) => f.message)).toBe(true);
  expectNoForm("the recheck", JSON.stringify(r));
  expectNoForm("check --review --json", recheckJson(r));
  expect(recheckSummary(r)[0]).toContain(STAND_INS_NOTE);
  expect(JSON.parse(recheckJson(r)).stand_ins_shown).toBe(true);
});

test("the before-snapshot's values reach the filter: a value only the code before the change holds", async () => {
  const onlyBefore = "Mn6bV1cX8zL3kJ9h";
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-11-04"));
  const settings: Settings = { ...SETTINGS, standIns: true, beforeCheck: true };
  writeSettings(repo, settings);
  // A lockfile: no diff shows it, so only that snapshot can name the value.
  writeFileSync(join(repo, "composer.lock"), `auth_token = "${onlyBefore}"\n`);
  commit(repo, "old");
  rmSync(join(repo, "composer.lock"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  commit(repo, "the change");
  const run = (command: string): [string | null, string, boolean] => {
    const quote = /before-\d/.test(command) ? ` ${onlyBefore}` : "";
    return [junitXml([[GEN, "test_add", "failed", `assert 1 == 5${quote}`]]), `1 failed${quote}\n`, false];
  };
  const judge = new RecordingJson("openai:x", VERDICT);
  const { review, rdir } = await runReview(repo, { settings, agentModel: new RecordingAgent(TURNS()), challenger: judge,
    sessionFactory: fakeFactory(run) });
  expect(review.findings[0]?.before).toBeTruthy();
  expect(JSON.stringify(review)).not.toContain(onlyBefore);
  expect(judge.bodies.join("\n")).not.toContain(onlyBefore);
  for (const f of readdirSync(rdir, { recursive: true }) as string[]) {
    if (f.endsWith(".json") && statSync(join(rdir, f)).isFile()) {
      expect([f, readFileSync(join(rdir, f), "utf8").includes(onlyBefore)]).toEqual([f, false]);
    }
  }
});

// --- the review, on the user's own keys ---------------------------------------------------------------------------

test("route: the reviewer's messages, with read_file, grep and run output in them", async () => {
  const repo = leakyRepo();
  const agent = new RecordingAgent(TURNS());
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson("openai:x", VERDICT),
    sessionFactory: fakeFactory(leakyRun) });
  const sent = agent.bodies.join("\n");
  expectClean("reviewer", sent);
  // The route ran: the diff, the file read, the search and the run all came back, each with the stand-in.
  expect(sent).toContain(`+api_token = \\"${FAKED}\\"`);
  expect(sent).toContain(`token=${FAKED}`);
  expect(sent).toMatch(/settings\.py:1:\s*api_token/);
  expect(sent).toContain("db_password");
});

test("route: a value only on the diff's removed side", async () => {
  const repo = leakyRepo();
  const agent = new RecordingAgent([]);
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson("openai:x", VERDICT),
    sessionFactory: fakeFactory(leakyRun) });
  const first = agent.bodies[0]!;
  expect(first).toContain("-api_token");
  expect(first).not.toContain(REMOVED);
});

test("route: the second opinion and the grouping, with the test's failure message and source", async () => {
  const repo = leakyRepo();
  const judge = new RecordingJson("openai:x", VERDICT);
  await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent(TURNS()), challenger: judge,
    sessionFactory: fakeFactory(leakyRun) });
  expect(judge.bodies.length).toBeGreaterThan(1);
  expectClean("second opinion", judge.bodies.join("\n"));
  expect(judge.bodies.join("\n")).toContain(FAKED);
});

test("route: the part hunters, the second hunter, the ranking and the merging of questions", async () => {
  const repo = leakyRepo({ big: true });
  // Replies that quote the value: a model that was told it elsewhere must not get it back from arnx.
  const many = (tag: string) => Array.from({ length: 8 }, (_, i) => ({ file: "app.py", line: i + 1,
    claim: `${tag} ${i} ${CANARY}` }));
  const hunter = new RecordingJson("anthropic:hunter", (n) => ({ suspects: many(`part ${n}`), questions: ["one", "two"] }));
  const second = new RecordingJson("openai:second", { suspects: many("other") });
  const ranker = new RecordingJson("anthropic:ranker", { order: [] });
  const judge = new RecordingJson("openai:judge", VERDICT);
  const agent = new RecordingAgent([[text('{"suspects": []}')], ...TURNS()], REPORT([`Is ${CANARY} right?`]));
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge, hunter, ranker, secondHunter: second,
    sessionFactory: fakeFactory(leakyRun), hunt: true });
  for (const [name, m] of Object.entries({ hunter, second, ranker })) {
    expect([name, m.bodies.length > 0]).toEqual([name, true]);
    expectClean(name, m.bodies.join("\n"));
  }
  expect(hunter.bodies.length).toBeGreaterThan(2); // the parts, then the merging of questions
  expect(hunter.bodies.join("\n")).toContain(FAKED);
});

test("route: a resumed review with every round saved knows the tree's values before it judges", async () => {
  const repo = leakyRepo();
  // The failure message quotes what only the tree holds; on resume no round runs, so no snapshot tells the filter.
  const quoting = (): [string | null, string, boolean] => [junitXml([[GEN, "test_add", "failed",
    `assert "${UNCHANGED}" == 5`]]), "", false];
  const cut = new RecordingJson("openai:x", VERDICT);
  cut.completeJson = async () => {
    throw new Error("the connection went");
  };
  await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent(TURNS()), challenger: cut,
    sessionFactory: fakeFactory(quoting) }).catch(() => null);
  const judge = new RecordingJson("openai:x", VERDICT);
  await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent([]), challenger: judge,
    sessionFactory: fakeFactory(quoting), resume: true });
  expect(judge.bodies.length).toBeGreaterThan(0);
  expectClean("resumed judge", judge.bodies.join("\n"));
  expect(judge.bodies.join("\n")).toContain(`assert \\\"`);
});

test("route: a resumed review knows the values of sandbox-only files too", async () => {
  const repo = leakyRepo();
  const yaml = stamp(parseReviewConfig(`${YAML}sandbox_only: [fixtures/seed.py]\n`), "Dev", "2026-11-04");
  writeFileSync(reviewConfigPath(repo), yaml);
  writeFileSync(join(repo, ".arnxignore"), "fixtures/\n");
  mkdirSync(join(repo, "fixtures"));
  writeFileSync(join(repo, "fixtures/seed.py"), `seed_token = "${IN_CONFIG}"\n`);
  commit(repo, "a file only the tests read");
  writeFileSync(join(repo, "settings.py"), `api_token = "${CANARY}"\n`);
  const quoting = (): [string | null, string, boolean] => [junitXml([[GEN, "test_add", "failed",
    `assert "${IN_CONFIG}" == 5`]]), "", false];
  const cut = new RecordingJson("openai:x", VERDICT);
  cut.completeJson = async () => {
    throw new Error("the connection went");
  };
  await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent(TURNS()), challenger: cut,
    sessionFactory: fakeFactory(quoting) }).catch(() => null);
  const judge = new RecordingJson("openai:x", VERDICT);
  await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent([]), challenger: judge,
    sessionFactory: fakeFactory(quoting), resume: true });
  expect(judge.bodies.length).toBeGreaterThan(0);
  expect(judge.bodies.join("\n")).not.toContain(IN_CONFIG);
});

test("route: the review's event log", async () => {
  const repo = leakyRepo();
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent(TURNS()),
    challenger: new RecordingJson("openai:x", VERDICT), sessionFactory: fakeFactory(leakyRun) });
  const log = readFileSync(join(rdir, "events.jsonl"), "utf8");
  expectClean("events", log);
  expect(log).toContain(`assert \\"${FAKED}\\"`);
});

test("route: the values of review.yaml, which a snapshot leaves out: its env reaches the tests' output", async () => {
  const repo = leakyRepo();
  const env = `env:\n  API_TOKEN: ${IN_CONFIG}\nallow_env_names: [API_TOKEN]\n`;
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML + env), "Dev", "2026-11-04"));
  const printing = (): [string | null, string, boolean] => [junitXml([[GEN, "test_add", "failed", `env ${IN_CONFIG}`]]),
    `API_TOKEN=${IN_CONFIG}\n`, false];
  const agent = new RecordingAgent(TURNS()), judge = new RecordingJson("openai:x", VERDICT);
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge, sessionFactory: fakeFactory(printing) });
  expect(agent.bodies.join("\n")).toContain("API_TOKEN=");
  expect(agent.bodies.join("\n") + judge.bodies.join("\n")).not.toContain(IN_CONFIG);

  const answer = new RecordingAgent([[tool("write_file", { path: "tests/arnx_generated/answers/test_a.py", content: SOURCE }),
    tool("run_tests", {})]], '{"tests": []}');
  await makeAnswerRunner(repo, loadReviewFile(repo), SETTINGS, answer, fakeFactory(printing))("Q1", "q", "a", "", join(tmp(), "a"),
    "main");
  expect(answer.bodies.join("\n")).toContain("API_TOKEN=");
  expect(answer.bodies.join("\n")).not.toContain(IN_CONFIG);

  // Setting up more of a repository, the file itself goes in the prompt.
  const setup = new RecordingAgent([], "done");
  await runSetup(repo, SETTINGS, setup, { outDir: join(tmp(), "s"), add: true, sessionFactory: fakeFactory(printing) });
  expect(setup.bodies.join("\n")).toContain("API_TOKEN:");
  expect(setup.bodies.join("\n")).not.toContain(IN_CONFIG);
});

test("route: an event log with a boundary masks every string of an event", () => {
  const path = join(tmp(), "e.jsonl");
  const log = new EventLog(path, "t");
  log.filter = new Boundary([CANARY]);
  log.emit("test.run", { message: `x ${CANARY}`, nested: { list: [CANARY] } });
  expectClean("event", readFileSync(path, "utf8"));
});

// --- the transports themselves ----------------------------------------------------------------------------------

/** Replaces global fetch while `fn` runs: the SDK and the Responses client go through it. A model takes fetch when it is
 * made, so `fn` makes it too: no test here may reach a provider. */
async function onTheWire(fn: () => Promise<unknown>, reply: (url: string, n: number) => Response | null = () => null)
  : Promise<string[]> {
  const real = globalThis.fetch, sent: string[] = [];
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const req = input instanceof Request ? input : null;
    const url = req ? req.url : String(input);
    sent.push(init?.body !== undefined && init.body !== null ? String(init.body) : req ? await req.text() : "");
    return reply(url, sent.length) ?? new Response(JSON.stringify({ error: { type: "invalid_request_error", message: "no" } }),
      { status: 400, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  try {
    await fn().catch(() => null);
  } finally {
    globalThis.fetch = real;
  }
  return sent;
}

const ENV = { ANTHROPIC_API_KEY: "a", OPENAI_API_KEY: "o" };
const ANTHROPIC = parseModelRef("anthropic:claude-sonnet-5-5"), OPENAI = parseModelRef("openai:gpt-6.1-sol");
const SCHEMA = { type: "object", properties: {} };
const LEAK = `api_token = "${CANARY}"`;
const turnOf = (m: AgentModel) => m.create({ system: LEAK, tools: [{ name: "t", description: LEAK,
  input_schema: { type: "object" } }], messages: [{ role: "user", content: [{ type: "tool_result", tool_use_id: "1",
    content: LEAK }] }, { role: "assistant", content: [{ type: "tool_use", id: "1", name: "t", input: { q: LEAK } }] },
  { role: "user", content: LEAK }], maxTokens: 10 });

for (const [name, ref] of [["Anthropic Messages", ANTHROPIC], ["Responses", OPENAI]] as const) {
  test(`route: makeAgentModel on ${name}: system, tools, tool results and tool calls`, async () => {
    const sent = await onTheWire(() => turnOf(makeAgentModel({ ...SETTINGS, reviewer: ref }, ENV, new Boundary(ALL))));
    expect(sent.length).toBeGreaterThan(0);
    expectClean(name, sent.join("\n"));
    expect(sent.join("\n")).toContain(FAKED);
  });

  test(`route: makeJsonModel on ${name}`, async () => {
    const sent = await onTheWire(() => makeJsonModel(ref, SETTINGS, ENV, new Boundary(ALL)).completeJson(LEAK, LEAK, SCHEMA));
    expect(sent.length).toBeGreaterThan(0);
    expectClean(name, sent.join("\n"));
    expect(sent.join("\n")).toContain(FAKED);
  });
}

test("route: makeChallenger with a fallback: both models", async () => {
  const s = { ...SETTINGS, challenger: OPENAI, challengerFallback: ANTHROPIC };
  const sent = await onTheWire(() => makeChallenger(s, ENV, new Boundary(ALL)).completeJson(LEAK, LEAK, SCHEMA));
  // Refused by the first (a 400 is not retried), so asked of the second.
  expect(sent.length).toBe(2);
  expectClean("challenger", sent.join("\n"));
  expect(sent[1]).toContain(FAKED);
});

test("route: makeSecondHunter, with its own reasoning effort", async () => {
  const s = { ...SETTINGS, secondHunter: OPENAI, secondHunterEffort: "high" };
  const sent = await onTheWire(() => makeSecondHunter(s, ENV, new Boundary(ALL))!.completeJson(LEAK, LEAK, SCHEMA));
  expect(sent[0]).toContain('"effort":"high"');
  expectClean("second hunter", sent.join("\n"));
  expect(sent[0]).toContain(FAKED);
});

test("route: a call sent again after a failure holds no value on any attempt", async () => {
  const sent: string[] = [];
  const raw = new ResponsesJson(OPENAI, "https://api.example/v1", "k", "medium", PRICES, { sleep: async () => {},
    fetch: (async (_u: string, init: RequestInit) => {
      sent.push(String(init.body));
      return new Response("{}", { status: 503 });
    }) as unknown as typeof fetch });
  await maskedJson(raw, new Boundary(ALL)).completeJson(LEAK, LEAK, SCHEMA).catch(() => null);
  expect(sent.length).toBeGreaterThan(1);
  expectClean("retries", sent.join("\n"));
});

test("route: a JSON call asked again after a reply that is not JSON", async () => {
  const inner = new RecordingAgent([[text("not json")], [text("still not")]]);
  const m = maskedJson(new AnthropicJson(ANTHROPIC, inner, PRICES), new Boundary(ALL));
  await m.completeJson(LEAK, LEAK, SCHEMA).catch(() => null);
  expect(inner.bodies.length).toBe(2);
  expectClean("second ask", inner.bodies.join("\n"));
});

test("route: a fallback model gets the masked text, and stays what callers take it for", async () => {
  const first = new RecordingJson("a:one", VERDICT), second = new RecordingJson("b:two", VERDICT);
  first.completeJson = async (s, u, sc) => {
    first.bodies.push(JSON.stringify([s, u, sc]));
    throw new ModelError("down");
  };
  const m = maskedJson(new FallbackJson(first, second), new Boundary(ALL));
  await m.completeJson(LEAK, LEAK, SCHEMA);
  expectClean("fallback", [...first.bodies, ...second.bodies].join("\n"));
  expect(second.bodies).toHaveLength(1);
  expect(m).toBeInstanceOf(FallbackJson);
  expect((m as FallbackJson).uses).toHaveLength(2);
  // A setting on the wrapper reaches the model it wraps.
  m.notice = () => {};
  expect((m as FallbackJson).notice).toBeDefined();
});

// --- setup and answers ----------------------------------------------------------------------------------------------

test("route: setup's agent, with read_file, grep and exec output", async () => {
  const repo = leakyRepo();
  const APP = "version: 1\nprojects:\n  app:\n    root: .\n    language: python\n    image: python:3.12-slim\n" +
    "    test_command: python -m pytest -q {targets}\n";
  const passing = (): [string | null, string, boolean] => [junitXml([["tests/test_a.py", "test_a", "passed", ""]]),
    "1 passed", false];
  const commands: string[] = [];
  const box: ExecFactory = async () => ({
    exec: (command) => {
      commands.push(command);
      return { exitCode: 0, output: `db_password=${UNCHANGED}\n`, timedOut: false, seconds: 0.1 };
    },
    close: () => {},
  });
  const agent = new RecordingAgent([[tool("read_file", { path: "other.py" }), tool("grep", { pattern: "db_password", path: "." })],
    [tool("try_project", { yaml: APP, project: "app" })], [tool("exec", { project: "app", command: "env" })]], "done");
  await runSetup(repo, SETTINGS, agent, { outDir: join(tmp(), "setup"), sessionFactory: fakeFactory(passing), execFactory: box });
  expect(commands).toEqual(["env"]);
  const sent = agent.bodies.join("\n");
  expectClean("setup", sent);
  expect(sent).toContain("db_password=");
});

test("route: setup's event log", async () => {
  const repo = leakyRepo();
  const out = join(tmp(), "setup");
  // A provider's error quoting what it was sent goes into the log of the call.
  const agent = new RecordingAgent([]);
  agent.create = async () => {
    throw new ModelError(`HTTP 400: bad input: ${UNCHANGED}`);
  };
  await runSetup(repo, SETTINGS, agent, { outDir: out, sessionFactory: fakeFactory(leakyRun) });
  const logs = readdirSync(out).map((id) => join(out, id, "events.jsonl")).filter(existsSync)
    .map((p) => readFileSync(p, "utf8")).join("\n");
  expect(logs).toContain("HTTP 400");
  expectClean("setup events", logs);
});

test("route: an answer round: the question, the answer, the diff and the tools", async () => {
  const repo = leakyRepo();
  const diff = `diff --git a/settings.py b/settings.py\n--- a/settings.py\n+++ b/settings.py\n@@ -1 +1 @@\n` +
    `-api_token = "${REMOVED}"\n+api_token = "${CANARY}"\n`;
  const agent = new RecordingAgent([[tool("read_file", { path: "settings.py" })]], '{"tests": []}');
  const run = makeAnswerRunner(repo, loadReviewFile(repo), SETTINGS, agent, fakeFactory(leakyRun));
  await run("Q1", `Is ${CANARY} right?`, `Yes, ${UNCHANGED}`, diff, join(tmp(), "out"), "main");
  expectClean("answer", agent.bodies.join("\n"));
  expect(agent.bodies[0]).toContain(FAKED);
});

test("route: setup from the CLI: the model it is given goes through the filter", async () => {
  const repo = leakyRepo();
  const agent = new RecordingAgent([[tool("read_file", { path: "other.py" })]], "done");
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" }, setupModel: agent,
    setupSessions: fakeFactory(leakyRun) });
  await cli.run("setup", "--force", "--quiet");
  expect(agent.bodies.length).toBeGreaterThan(0);
  expectClean("cli setup", agent.bodies.join("\n"));
  expect(agent.bodies.join("\n")).toContain("db_password");
});

test("route: JEV from the CLI: setup tells it the values it found", async () => {
  const repo = leakyRepo();
  writeSettings(repo, { ...SETTINGS, standIns: false, jev: true });
  const failing = (): [string | null, string, boolean] => [junitXml([["tests/test_a.py", "test_a", "failed",
    `assert "${UNCHANGED}" == 5`]]), "1 failed", false];
  const agent = new RecordingAgent([[tool("try_project", { yaml: YAML })]], "done");
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a", JEV_API_KEY: "k" }, setupModel: agent,
    setupSessions: fakeFactory(failing) });
  const sent = await onTheWire(() => cli.run("setup", "--force", "--quiet"), () => new Response("{}"));
  expect(sent.length).toBeGreaterThan(0);
  expect(sent[0]).toContain("Failure message");
  expectClean("jev", sent.join("\n"));
});

// --- arnx cloud ---------------------------------------------------------------------------------------------------

test("route: a cloud review: the change, the diff, tool results, facts, findings and the end", async () => {
  const repo = leakyRepo();
  const c = cloudOf();
  await runReview(repo, { settings: SETTINGS, brain: brainOf(c), sessionFactory: fakeFactory(leakyRun), hunt: true });
  expect(c.seen.some((x) => x.path.endsWith("/judge"))).toBe(true);
  const sent = wire(c);
  expectClean("cloud review", sent);
  expect(sent).toContain(FAKED);
  // Values change, the request's shape does not: no field was added.
  const start = c.seen.find((x) => x.path.endsWith("/agent"))!.body as Record<string, unknown>;
  expect(Object.keys(start).sort()).toEqual(["budget_micro_usd", "changed_definitions", "context_pack", "diff", "facts",
    "hunt", "max_questions", "scope"]);
});

test("route: a cloud setup: its tree and detection, here a file named with the value", async () => {
  const repo = leakyRepo();
  writeFileSync(join(repo, `${CANARY}.py`), "x = 1\n");
  commit(repo, "a file so named");
  const c = cloudOf();
  await runSetup(repo, SETTINGS, null, { outDir: join(tmp(), "setup"), brain: brainOf(c),
    sessionFactory: fakeFactory(leakyRun) });
  expect(c.seen.some((x) => x.path === "/v1/setup")).toBe(true);
  expectClean("cloud setup", wire(c));
  expect(wire(c)).toContain(`${FAKED}.py`);
});

test("route: a cloud answer round", async () => {
  const repo = leakyRepo();
  const c = cloudOf([{ type: "actions", actions: [{ name: "read_file", input: { path: "settings.py" } }] },
    { type: "final", report: { tests: [], suspected_defects: [], questions: [] } }, { type: "done", stop: "end_turn" }]);
  const diff = `diff --git a/settings.py b/settings.py\n--- a/settings.py\n+++ b/settings.py\n@@ -1 +1 @@\n` +
    `-api_token = "${REMOVED}"\n+api_token = "${CANARY}"\n`;
  const run = makeAnswerRunner(repo, loadReviewFile(repo), SETTINGS, null, fakeFactory(leakyRun), undefined, brainOf(c));
  await run("Q1", `Is ${CANARY} right?`, "Yes", diff, join(tmp(), "out"), "main").catch(() => null);
  expect(c.seen.some((x) => x.path === "/v1/answers")).toBe(true);
  expectClean("cloud answer", wire(c));
});

// --- the other requests arnx makes ----------------------------------------------------------------------------------

test("route: JEV: the failure message and the repository's top-level names, and its log", async () => {
  const sent: string[] = [];
  const log = join(tmp(), "jev.jsonl");
  const fetcher = (async (_u: string, init: RequestInit) => {
    sent.push(String(init.body));
    return new Response(JSON.stringify({ answers: { cause: { choice: "genuine-failure", confidence: 1 } } }));
  }) as unknown as typeof fetch;
  await jevModel("k", log, new Boundary(ALL), fetcher)(`assert "${CANARY}" == 5`, parseReviewConfig(YAML), [UNCHANGED]);
  expect(sent).toHaveLength(1);
  expectClean("jev", sent.join("\n"));
  expect(sent[0]).toContain(FAKED);
  expectClean("jev log", readFileSync(log, "utf8"));
});

test("route: telemetry: its allow-list sends no free text, and what it does send goes through the filter", async () => {
  const sent: string[] = [];
  const sender = async (_u: string, body: string) => void sent.push(body);
  const env = { HOME: tmp() };
  await reportTelemetry(env, "check", () => checkData([], 0, 1), { sender, open: true, configured: true,
    boundary: new Boundary([process.platform]) });
  expect(sent).toHaveLength(1);
  expect(sent[0]).not.toContain(`"os":"${process.platform}"`);
  // A value in a count's place is refused before anything is sent.
  sent.length = 0;
  await reportTelemetry(env, "check", () => ({ ...checkData([], 0, 1), tests: CANARY }), { sender, open: true,
    configured: true, boundary: new Boundary() });
  expect(sent).toEqual([]);
});

// --- the wrappers: nothing gets around them ---------------------------------------------------------------------------

test("a new model class that bypasses the boundary fails this test: every factory returns a wrapped model", () => {
  const b = new Boundary();
  const refs = [ANTHROPIC, OPENAI];
  for (const ref of refs) {
    expect(isMasked(makeAgentModel({ ...SETTINGS, reviewer: ref }, ENV, b))).toBe(true);
    expect(isMasked(makeJsonModel(ref, SETTINGS, ENV, b))).toBe(true);
    expect(isMasked(makeJsonModel(ref, SETTINGS, ENV, b, { effort: "high", attemptSeconds: 1 }))).toBe(true);
    expect(isMasked(makeChallenger({ ...SETTINGS, challenger: ref }, ENV, b))).toBe(true);
    expect(isMasked(makeChallenger({ ...SETTINGS, challenger: ref, challengerFallback: ref }, ENV, b))).toBe(true);
    expect(isMasked(makeSecondHunter({ ...SETTINGS, secondHunter: ref }, ENV, b)!)).toBe(true);
  }
  expect(boundaryOf(makeJsonModel(OPENAI, SETTINGS, ENV, b))).toBe(b);
});

test("a local brain masks every model it is given, whoever made it", () => {
  const judge = new RecordingJson("a:b", VERDICT);
  const m = new LocalBrain({ agentModel: new RecordingAgent([]), prices: PRICES, challenger: judge, hunter: judge,
    ranker: judge, secondHunter: judge }).m;
  for (const model of [m.agentModel, m.challenger!, m.hunter!, m.ranker!, m.secondHunter!]) {
    expect(isMasked(model)).toBe(true);
  }
});

test("a local brain takes the boundary of the models it is given, so one run has one", () => {
  const b = new Boundary();
  const brain = new LocalBrain({ agentModel: maskedAgent(new RecordingAgent([]), b), prices: PRICES });
  expect(brain.boundary).toBe(b);
});

test("wrapping twice with one boundary changes nothing, and a model keeps what callers read from it", () => {
  const b = new Boundary();
  const raw = new RecordingAgent([]);
  const once = maskedAgent(raw, b);
  expect(maskedAgent(once, b)).toBe(once);
  expect(once.model).toBe("claude-sonnet-5-5");
  expect(once).toBeInstanceOf(RecordingAgent);
  once.notice = () => {};
  expect(raw.notice).toBeDefined();
});

/** Every place in src that opens a connection, and the test above that covers it. */
const OUTBOUND: Record<string, [number, string]> = {
  "src/cloud.ts": [2, "cloud routes; the rest are login and account calls that carry no code"],
  "src/jev.ts": [1, "route: JEV"],
  "src/llm.ts": [6, "route: makeAgentModel, makeJsonModel"],
  "src/telemetry.ts": [1, "route: telemetry"],
};
const CONNECTS = /\bfetch\(|\bfetcher\(|new Anthropic\(|Bun\.(?:connect|serve)\(|https?\.(?:request|get)\(|node:(?:https?|net|tls|dgram)|new WebSocket\(/g;
/** The classes that talk to a provider: only llm.ts's factories may make one. */
const MODELS = /new (?:AnthropicAgent|AnthropicJson|ResponsesAgent|ResponsesJson|FallbackJson)\(/;

/** Every source file under `dir`. */
function sources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sources(p, out);
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

test("every way out of arnx is a route named here: a new one fails until it is covered", () => {
  const found: Record<string, number> = {};
  for (const p of [...sources("src"), ...sources("scripts")]) {
    const code = readFileSync(p, "utf8");
    const hits = code.match(CONNECTS)?.length ?? 0;
    if (hits) found[p] = hits;
    if (p !== "src/llm.ts") expect([p, MODELS.test(code)]).toEqual([p, false]);
  }
  expect(found).toEqual(Object.fromEntries(Object.entries(OUTBOUND).map(([k, v]) => [k, v[0]])));
  // The one script that asks a model puts the filter around whichever it is given (replay-judge.test.ts).
  expect(readFileSync("scripts/replay-judge.ts", "utf8")).toContain("maskedJson(deps.makeModel(");
});

test("arnx's own CLI passes its one boundary to every model, the cloud brain and JEV", () => {
  const cli = readFileSync("src/cli.ts", "utf8");
  for (const m of cli.matchAll(/\bmake(?:AgentModel|JsonModel|Challenger|SecondHunter)\(/g)) {
    const line = cli.slice(m.index, cli.indexOf("\n", cli.indexOf(";", m.index)));
    expect(line).toContain("this.boundary");
  }
  expect(cli).toContain("boundary: this.boundary");
  expect(cli).toMatch(/jevModel\(.*this\.boundary/);
});

// --- the filter ---------------------------------------------------------------------------------------------------

test("Masking is deterministic across calls", () => {
  const a = new Boundary([CANARY]), b = new Boundary([CANARY]);
  const line = `api_token = "${CANARY}"`;
  expect(a.mask(line)).toBe(a.mask(line));
  expect(a.mask(line)).toBe(b.mask(line));
  expect(a.mask(line)).not.toContain(CANARY);
  expect(a.mask(a.mask(line))).toBe(a.mask(line));
});

test("a stand-in has the value's shape and comes back as the value", () => {
  const b = new Boundary([CANARY, REMOVED]);
  const text = `${CANARY} and ${REMOVED}, again ${CANARY}`;
  const masked = b.mask(text);
  expect(masked).not.toContain(CANARY);
  expect(b.mask(CANARY)).toHaveLength(CANARY.length);
  expect(b.unmask(masked)).toBe(text);
});

test("no values: the same string and the same object come back", () => {
  const b = new Boundary();
  const msg = { role: "user", content: [{ type: "text", text: "x" }] };
  expect(b.mask("anything")).toBe("anything");
  expect(b.maskValue(msg)).toBe(msg);
  expect(b.unmask("anything")).toBe("anything");
  expect(new Boundary(["", ""]).mask("anything")).toBe("anything");
  const raw = new RecordingAgent([]);
  expect(maskedAgent(raw, b)).toBeDefined();
});

test("a value inside a longer word, or after a slash, is still the value", () => {
  const b = new Boundary([CANARY]);
  for (const text of [`https://api.example.com/v1/${CANARY}/x`, `x${CANARY}y`, `+${CANARY}`, `a/${CANARY}`]) {
    expect(b.mask(text)).not.toContain(CANARY);
  }
  expect(b.unmask(b.mask(`x${CANARY}y`))).toBe(`x${CANARY}y`);
});

// What the prompts and tools cut before the filter sees the text.
const LONG = Array.from({ length: 12 }, (_, i) => createHash("sha256").update(`long ${i}`).digest("base64url")).join("");

test("the start of a value left by a cut goes: at the text's end, a line's end, or before a mark", () => {
  const b = new Boundary([LONG]);
  const start = LONG.slice(0, 170);
  for (const text of [`key = "${start}`, `a:1: key = "${start}\nb:2: other`, `${start}\r\nnext`, `key ${start}…`,
    `key ${start}...`, `could not run (${start}), 2 runs`, `${start}\n[diff truncated; read the changed files with the tools]\n`]) {
    const masked = b.mask(text);
    expect(masked).not.toContain(LONG.slice(0, 12));
    expect(masked.length).toBe(text.length);
  }
});

test("the end of a value left by a cut goes: at the text's start, a line's start, or after a mark", () => {
  const b = new Boundary([LONG]);
  const end = LONG.slice(-170);
  for (const text of [`${end}" more`, `failed: boom\n${end}"\n`, `…${end}`, `...${end}`,
    `head\n[… 500 characters left out …]\n${end}`]) {
    expect(b.mask(text)).not.toContain(LONG.slice(-12));
  }
});

test("a piece of a value inside a longer word, or shorter than 12 characters, stays: a name can begin the same way", () => {
  const value = "ResetPasswordXy12Zq9";
  const b = new Boundary([value]);
  for (const text of ["ResetPasswordOk(user)", "x = ResetPasswo\n", "def ResetPasswordLink():\n"]) {
    expect(b.mask(text)).toBe(text);
  }
  expect(b.mask("y = ResetPassword\n")).not.toContain("ResetPassword");
  // The same at its other end: its last characters count only where a word starts.
  expect(b.mask("beforeswordXy12Zq9(x)")).toBe("beforeswordXy12Zq9(x)");
  expect(b.mask("swordXy12Zq9(x)")).not.toContain("swordXy12Zq9");
});

test("a value's own signs are edges: what stands past one goes, though a letter stands before the piece", () => {
  const value = "aB3-dE6gH9jK2mN5pQ8sT-1vW4yZ7bC0fG3iL";
  const b = new Boundary([value]);
  expect(b.mask("Xb3-dE6gH9jK2mN5pQ8sT-1vW4yZ7bC0fG3iL end")).not.toContain("dE6gH9jK2mN5pQ8sT");
  expect(b.mask("aB3-dE6gH9jK2mN5pQ8sT-1vW4yZ0Q")).not.toContain("dE6gH9jK2mN5pQ8sT");
  // Longer than the value, a run still leaves nothing of it.
  const run = `Ab1-${`${SIGNED}-`.repeat(5)}`;
  expect(new Boundary([run]).mask(`${SIGNED}-`.repeat(12))).not.toContain(SIGNED);
});

// Whether a value's pieces count is decided from the whole value: a piece of a word-like one is a name in code.
/** Random, with signs of every kind that may stand inside a value. */
const SIGNED = "Ab3_dE6gH9-jK2mN5pQ8.sT1vW4yZ7bC0fG3iL6";

test("a word-like value's piece stays in the text, and the value itself still goes", () => {
  const cases: [string, string[]][] = [
    ["Beschreibungstext...", ["label: Beschreibungstext\n", "x = Beschreibungstext", "{ title: 'Beschreibungs' }"]],
    ["ReturningGuest123!", ["const user = ReturningGuest\n", "(ReturningGuest)"]],
    ["2:new-signing-key,1:old-signing-key", ["env = 2:new-signing\n", "1:old-signing-key\n"]],
    ["correct-horse-12-battery-staple", ["word = correct-horse\n", "correct-horse-12 ", "(battery-staple)"]],
  ];
  for (const [value, texts] of cases) {
    const b = new Boundary([value]);
    for (const text of texts) expect(b.mask(text)).toBe(text);
    expect(b.mask(`[${value}]`)).not.toContain(value);
  }
});

test("a name is one name: the piece of a value that names a variable does not rename it there", () => {
  const b = new Boundary(["row[sortableField]"]);
  const line = "query.select(sortableField).first()?.[sortableField]";
  expect(b.mask(line)).toBe(line);
  expect(b.mask(`const key = row[sortableField];`)).not.toContain("row[sortableField]");
});

test("an address's password that reads like a name: the name alone stays, the password in its address goes", () => {
  const comment = ["# postgres://user", "session_handle@db.prod.net/app\n"].join(":");
  const picked = suspects("a.py", comment, []);
  expect(picked).toEqual(["session_handle@"]);
  const b = new Boundary(picked);
  const line = `params["session_handle"] = value`;
  expect(b.mask(line)).toBe(line);
  expect(b.mask(comment)).not.toContain("session_handle");
  expect(b.mask(JSON.stringify(comment))).not.toContain("session_handle");
});

test("a random value's piece goes at each kind of edge, from either end", () => {
  const b = new Boundary([LONG, SIGNED]);
  for (const value of [LONG, SIGNED]) {
    for (const n of [12, 20, 30]) {
      const start = value.slice(0, n), end = value.slice(-n);
      const texts = [start, `x ${start}`, `${start}\n`, `${start}\r\n`, `${start}…`, `${start}...`, `(${start})`, `"${start}"`,
        `'${start}'`, `${start}:`, `${start}=`, `${start} `, `${start}\t`, `${start}/`, `${start}�`, `${start}_`, `${start}é`];
      for (const text of texts) expect([text, b.mask(text).includes(start)]).toEqual([text, false]);
      const ends = [end, `${end} x`, `\n${end}`, `\t${end}`, `…${end}`, `...${end}`, `(${end})`, `"${end}"`, `'${end}'`, `:${end}`,
        `=${end}`, ` ${end}`, `/${end}`, `�${end}`, `_${end}`, `é${end}`];
      for (const text of ends) expect([text, b.mask(text).includes(end)]).toEqual([text, false]);
    }
  }
});

test("a random value's tail that reads as a dotted name goes", () => {
  const tail = SIGNED.slice(SIGNED.indexOf("Q8."));
  expect(tail).toBe("Q8.sT1vW4yZ7bC0fG3iL6");
  const b = new Boundary([SIGNED]);
  for (const text of [`${tail} failed`, `\n    ${tail}`, `error: ${tail}`, `"${tail}"`, `(${tail})`]) {
    expect(b.mask(text)).not.toContain(tail);
  }
});

test("a value's JSON and URL forms are judged as the value", () => {
  const random = "Ab3/dE6+gH9=jK2$mN5pQ8sT1vW4";
  const url = encodeURIComponent(random);
  expect(url).not.toBe(random);
  expect(new Boundary([random]).mask(`${url.slice(0, 16)} failed`)).not.toContain(url.slice(0, 16));
  const quoted = 'Ab3"dE6gH9jK2mN5pQ8sT1vW4';
  const json = JSON.stringify(quoted).slice(1, -1);
  expect(new Boundary([quoted]).mask(`${json.slice(0, 16)}…`)).not.toContain(json.slice(0, 16));
  // Word-like, all its forms keep whole-value masking only, though an encoded one by itself would not read as words.
  const worded = "session handle/primary@";
  const form = encodeURIComponent(worded);
  expect([piecesAllowed(worded), piecesAllowed(form)]).toEqual([false, true]);
  const b = new Boundary([worded]);
  expect(b.mask(`${form.slice(0, 16)} failed`)).toBe(`${form.slice(0, 16)} failed`);
  expect(b.mask(`=${form}=`)).not.toContain(form);
});

test("piecesAllowed: a random value yes, a word-like one no, from the value as a whole", () => {
  const hash = (s: string) => createHash("sha256").update(s).digest();
  const random = [LONG, SIGNED, "Q8.sT1vW4yZ7bC0fG3iL6", "Xk9#mP2$vL5!qR8wT", "ab12.c0DEF5g7hQ_some_oauth_token_with-dashes",
    hash("a").toString("hex"), hash("b").toString("hex").toUpperCase(), `0x${hash("c").toString("hex")}`,
    hash("d").toString("hex").slice(0, 16), "f47ac10b-58cc-4372-a567-0e02b2c3d479", hash("e").toString("base64"),
    hash("f").toString("base64url"), `sk-${hash("g").toString("hex")}`, `AKIA${"Q3X9RT5L2MZP7WKJ"}`, `ghp_${hash("h").toString("base64url").slice(0, 40)}`,
    `xoxb${"-263594206564-2343594206564-AbCdEfGhIjKlMnOpQrStUvWx"}`, "key_test_9fZ31HqLyjWDarjtT1zdp7dc", "k3jd9xm2qp7wzr5t",
    "JBSWY3DPEHPK3PXP", "mycompany_production_api_aB3dE6gH9jK2mN", "rotate_password_Xy12Zq9", "48213975601827364",
    "70e4d786628fea6478f785a6d7e704777c86a7c5"];
  for (const v of random) expect([v, piecesAllowed(v)]).toEqual([v, true]);
  // An address's password keeps its @ in the value; the choice is made without it.
  expect(piecesAllowed(`${SIGNED}@`)).toBe(true);
  expect(piecesAllowed("70e4d786628fea6478f785a6d7e704777c86a7c5@")).toBe(true);
  expect(piecesAllowed("1111aaaa2222bbbb3333cccc4444dddd@")).toBe(true);
  const worded = ["session_handle@", "session_handle", "sortableField]", "[sortableField]", "row[sortableField]", "item[sortableKey",
    "Beschreibungstext...", "ReturningGuest123!", "correctPassword123!", "text/plain+frozenset:[NaN]", "props.itemValue]",
    "2:new-signing-key,1:old-signing-key", "at-least-32-chars-long!!", "old-signing-key", "correct-horse-12-battery-staple",
    "oauth2Client", "base64Encoded", "sha256sum", "XMLParserOptions", "group.date.toString()", "String(item.value)", "_v402_is_retry",
    "demo-m2m-signing", "getIdFromUrl", "quizQuestionnaireQ1No", "v402ChargeCounts"];
  for (const v of worded) expect([v, piecesAllowed(v)]).toEqual([v, false]);
  // Too little spread to be random.
  for (const v of ["aB1aB1aB1aB1aB1aB1", "0x0000000000000000000000000000000000000001", "deadbeefdeadbeef", "AAAAAAAAAAAAAAAAAAAA", "-".repeat(30), "!".repeat(30)]) {
    expect([v, piecesAllowed(v)]).toEqual([v, false]);
  }
});

test("piecesAllowed: strings drawn at random from a key's alphabets are taken as random", () => {
  let seed = 11;
  const next = (n: number) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0, (seed >>> 8) % n);
  const lower = "abcdefghijklmnopqrstuvwxyz", upper = lower.toUpperCase(), digits = "0123456789";
  const alphabets = [lower + upper + digits, `${lower + upper + digits}-_`, `${lower + upper + digits}+/`, digits + "abcdef", digits + "ABCDEF", lower + digits,
    upper + digits, `${upper}234567`, `${lower + upper + digits}!@#$%^&*`];
  for (const alphabet of alphabets) {
    for (const length of [24, 32, 40, 64, 128]) {
      let yes = 0;
      for (let i = 0; i < 500; i++) {
        if (piecesAllowed(Array.from({ length }, () => alphabet[next(alphabet.length)]).join(""))) yes++;
      }
      expect([alphabet, length, yes >= 480]).toEqual([alphabet, length, true]);
    }
  }
  // Short hex spreads least.
  let yes = 0;
  for (let i = 0; i < 500; i++) if (piecesAllowed(Array.from({ length: 16 }, () => (digits + "abcdef")[next(16)]).join(""))) yes++;
  expect(yes).toBeGreaterThanOrEqual(450);
});

// Random strings for the rate tests: a fixed stream, so a rate near its bar can't flake.
function randomText(label: string) {
  let block = 0;
  let bytes = Buffer.alloc(0), at = 0;
  return (length: number, alphabet: string) => Array.from({ length }, () => {
    for (;;) {
      if (at === bytes.length) [bytes, at] = [createHash("sha256").update(`${label} ${block++}`).digest(), 0];
      const x = bytes[at++]!;
      if (x < 256 - 256 % alphabet.length) return alphabet[x % alphabet.length]!;
    }
  }).join("");
}
const LOWER = "abcdefghijklmnopqrstuvwxyz", UPPER = LOWER.toUpperCase(), DIGITS = "0123456789", HEX = `${DIGITS}abcdef`;
const BASE62 = LOWER + UPPER + DIGITS, BASE32 = `${UPPER}234567`;

/** How many of 500 fresh values from `make` have pieces that count. */
function piecesRate(label: string, make: (r: ReturnType<typeof randomText>) => string): number {
  const r = randomText(label);
  return Array.from({ length: 500 }, () => make(r)).filter(piecesAllowed).length / 500;
}

const KEY_SHAPES: Record<string, (r: ReturnType<typeof randomText>) => string> = {
  "name_ and 32 hex": (r) => `api_${r(32, HEX)}`,
  "name_ and 40 hex": (r) => `tok_${r(40, HEX)}`,
  "name- and 32 hex": (r) => `key-${r(32, HEX)}`,
  "sk- and 32 hex": (r) => `s${"k-"}${r(32, HEX)}`,
  "a longer name_ and 32 hex": (r) => `shpss_${r(32, HEX)}`,
  "four letters and 32 hex": (r) => `dapi${r(32, HEX)}`,
  "two capitals and 32 hex": (r) => `SK${r(32, HEX)}`,
  "chat app token": (r) => `xa${"pp-"}1-A${r(10, UPPER + DIGITS)}-${r(13, DIGITS)}-${r(64, HEX)}`,
  "chat user token": (r) => `xo${"xp-"}${r(12, DIGITS)}-${r(12, DIGITS)}-${r(13, DIGITS)}-${r(32, HEX)}`,
  "chat bot token": (r) => `xo${"xb-"}${r(12, DIGITS)}-${r(13, DIGITS)}-${r(24, BASE62)}`,
  "cloud access key": (r) => `AK${"IA"}${r(16, BASE32)}`,
  "cloud session key": (r) => `AS${"IA"}${r(16, BASE32)}`,
  "base32, 16": (r) => r(16, BASE32),
  "base32, 32": (r) => r(32, BASE32),
  "digits, 16": (r) => r(16, DIGITS),
  "letters, one case, 32": (r) => r(32, LOWER),
  "framework's insecure key": (r) => `webapp-insecure-${r(50, `${LOWER}${DIGITS}!@#$%^&*(-_=+)`)}`,
};
for (const [shape, make] of Object.entries(KEY_SHAPES)) {
  test(`a key's pieces count at least 99% of the time: ${shape}`, () => {
    expect(piecesRate(shape, make)).toBeGreaterThanOrEqual(0.99);
  });
}

for (const [name, alphabet] of Object.entries({ base62: BASE62, base64url: `${BASE62}-_`, base64: `${BASE62}+/`, hex: HEX,
  "upper hex": `${DIGITS}ABCDEF`, "lower and digits": LOWER + DIGITS, "upper and digits": UPPER + DIGITS, base32: BASE32,
  "with signs": `${BASE62}!@#$%^&*` })) {
  test(`a random string's pieces count at least 99% of the time from 24 characters: ${name}`, () => {
    for (const length of [24, 32, 40, 64, 128]) {
      expect([length, piecesRate(`${name} ${length}`, (r) => r(length, alphabet)) >= 0.99]).toEqual([length, true]);
    }
  });
}

test("a value in a key's shape always has pieces that count, however little it looks random", () => {
  for (const v of [`AK${"IA"}IOSFODNN7EXAMPLE`, `s${"k-"}abcdefghijklmnopqrstuvwxyz123456`, `sk-a${"nt-"}test-fake-provider-key`,
    `xo${"xb-"}just-some-words-here`]) {
    expect([v, piecesAllowed(v)]).toEqual([v, true]);
  }
});

test("a value of capitals and digits, 16 characters or more, has pieces that count; a constant's name does not", () => {
  for (const v of ["JBSWY3DPEHPK3PXP", `AS${"IA"}Q3X9RT5L2MZP7WKJ`, "GEZDGNBVGY3TQOJQ", "48213975601827364", "abcdef-1234-abcd-1234"]) {
    expect([v, piecesAllowed(v)]).toEqual([v, true]);
  }
  for (const v of ["MAX_RETRY_COUNT", "SOME_LONG_CONSTANT_NAME_HERE", "SHORTCAPS"]) expect([v, piecesAllowed(v)]).toEqual([v, false]);
});

test("a short name before a key says nothing about the rest: it goes by what follows", () => {
  const hex = createHash("sha256").update("short name").digest("hex").slice(0, 32);
  for (const name of ["api", "tok", "key", "x", "shpat"]) {
    expect(piecesAllowed(`${name}_${hex}`)).toBe(true);
    expect(piecesAllowed(`${name}-${hex}`)).toBe(true);
  }
  // A repetitive hex part: the name before it must not change how it is judged.
  for (const v of ["tok_1111aaaa2222bbbb3333cccc4444dddd", "0x1111aaaa2222bbbb3333cccc4444dddd", `shpat_${"1111aaaa2222bbbb3333cccc4444dddd".repeat(2)}`]) {
    expect([v, piecesAllowed(v)]).toEqual([v, true]);
  }
  // Words after it stay words.
  for (const v of ["api_request_timeout", "tok-refresh-interval", "key_value_store_options"]) expect([v, piecesAllowed(v)]).toEqual([v, false]);
});

test("a run of letters or digits no word has is not proven a name", () => {
  // No vowel; a vowel too rarely for a word; digits alone, too short for the capitals rule.
  for (const v of ["xkqzjwvmplhrtbnc", "xkqzjw-plhrtb-vmnqgd", "kzrtaxlmqevnbpiwdfgo", "4821397560182"]) expect([v, piecesAllowed(v)]).toEqual([v, true]);
});

test("names proven by words, humps or separators stay word-like", () => {
  for (const v of ["access_token", "access_token@", "Identifikatorius", "Identifikatorius...", "permit2Authorization", "v402ChargeCounts",
    "e2e-entry-access-token", "swapsAB4135AbtestButtonColor", "correct-horse-12-battery-staple", "useHTTPSAgent", "group.date.toString()"]) {
    expect([v, piecesAllowed(v)]).toEqual([v, false]);
  }
});

test("a value cut by what really cuts it: grep, the diff limits, a clipped output, a run's tail", async () => {
  const b = new Boundary([LONG]);
  const pad = (n: number) => "x".repeat(n - 30);
  const failure = pad(4000) + LONG;
  const cuts = {
    second: DEFAULT_PROMPTS.challengeUser(`+${pad(30_000)}${LONG}`, "t.py", pad(40_000) + LONG, "t", failure, "e"),
    grouping: explainUser(`+${pad(30_000)}${LONG}`, [{ id: "F1", testId: "t", message: pad(2000) + LONG, explanation: "e",
      reason: "", verdict: null, file: "t.py" }], { "t.py": pad(20_000) + LONG }),
    exec: clipOutput(`${LONG}${pad(60_000)}${LONG}`),
    run: describeRun({ exitCode: 1, output: `${LONG}${pad(10_000)}`.slice(-4100), timedOut: false, seconds: 1 }, null, []),
    tail: `failed: boom\n${`${LONG}${pad(6000)}`.slice(-6100)}`,
  };
  for (const [name, text] of Object.entries(cuts)) {
    const masked = b.mask(text);
    expect([name, masked.includes(LONG.slice(0, 12)) || masked.includes(LONG.slice(-12))]).toEqual([name, false]);
  }
});

test("a value cut in a hint's evidence or a skip reason goes: each is written inside quotes", () => {
  const b = new Boundary([LONG]);
  const cfg = parseReviewConfig(YAML);
  const start = LONG.slice(0, 12);
  // The three cuts of a failure's line: a signature's line, a file that did not load, and the first line of a message.
  const signature = classify(`ModuleNotFoundError: No module named 'x' ${LONG}`, cfg, tmp())!;
  expect(signature.evidence.endsWith("…")).toBe(true);
  const written = describeHints([{ ...signature, files: ["tests/test_a.py"] }], cfg);
  expect(written).toContain('…"');
  expect(b.mask(written)).not.toContain(start);
  for (const cut of [errorLine(`collection failure\nE   boom ${LONG}`), firstLine(`boom ${LONG}`)]) {
    expect(cut.endsWith("…")).toBe(true);
    expect(b.mask(`From: "${cut}"`)).not.toContain(start);
  }
  // A short line stays as it was.
  expect(firstLine("E   short line")).toBe("short line");
  const [reason] = skipReasons([{ testId: "t", fileAttr: "t.py", name: "t", outcome: "skipped", message: `needs ${LONG}` }]);
  expect(reason).toContain('…" (1)');
  expect(b.mask(reason!)).not.toContain(start);
});

test("the end of a value goes after any sign: how a run's output, a quote or an error really starts", () => {
  const b = new Boundary([LONG]);
  const end = LONG.slice(-20);
  // An adapter keeps the end of stderr; describeRun then indents the message under its test.
  const run = describeRun({ exitCode: 1, output: "", timedOut: false, seconds: 1 },
    [{ testId: "t.test.ts::a", fileAttr: "t.test.ts", name: "a", outcome: "failed", message: `${end} failed` }], ["t.test.ts"]);
  expect(run).toContain(`\n    ${end}`);
  expect(b.mask(run)).not.toContain(end);
  const cfg = parseReviewConfig(YAML);
  const failed = { exitCode: 1, output: `one\n${end}`, timedOut: false, seconds: 1 };
  for (const text of [`the indexer exited with 1: ${end}`, `the indexer layer did not build: ${end}`,
    probeFailure(cfg, failed, "probe.log").message, `could not run on the code before the change (${end})`, `From: "${end}"`,
    `�${end}`, `\t${end}`, `=${end}`, `/${end}`]) {
    expect([text.slice(0, 40), b.mask(text).includes(end)]).toEqual([text.slice(0, 40), false]);
  }
});

test("the start of a value goes before any sign, a broken character too", () => {
  const accented = `pä${LONG.slice(0, 30)}é${LONG.slice(30, 50)}`;
  const b = new Boundary([accented]);
  // Cut in bytes, inside the é: what stays of it reads as a broken character, and the note follows.
  const cut = Array.from({ length: 300 }, (_, max) => cutForBrain(`${accented} and on and on`, max))
    .find((c) => c.includes(`${accented.slice(0, 32)}�`));
  expect(cut).toBeDefined();
  expect(b.mask(cut!)).not.toContain(accented.slice(0, 20));
  for (const text of [`${LONG.slice(0, 30)} `, `${LONG.slice(0, 30)}"`, `${LONG.slice(0, 30)}:`, `${LONG.slice(0, 30)}�`]) {
    expect(new Boundary([LONG]).mask(text)).not.toContain(LONG.slice(0, 12));
  }
});

test("route: a long value on a grep line, which grep cuts at 200 characters", async () => {
  const repo = leakyRepo();
  writeFileSync(join(repo, "creds.py"), `private_key = "${LONG}"\n`);
  commit(repo, "a long value");
  writeFileSync(join(repo, "settings.py"), `api_token = "${CANARY}"\n`);
  const agent = new RecordingAgent([[tool("grep", { pattern: "private_key", path: "." })]]);
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson("openai:x", VERDICT),
    sessionFactory: fakeFactory(leakyRun) });
  const sent = agent.bodies.join("\n");
  expect(sent).toContain("creds.py:1: private_key");
  expect(sent).not.toContain(LONG.slice(0, 12));
});

test("a value in a URL goes in its encoded form too", () => {
  const value = "Ab3/cd+Ef9=gh&Ij2";
  const b = new Boundary([value]);
  const masked = b.mask(`https://x.example/?t=${encodeURIComponent(value)}&n=1`);
  expect(masked).not.toContain(encodeURIComponent(value));
  expect(masked).toContain("&n=1");
});

test("a value made of signs alone, which keeps its shape, still goes", () => {
  const b = new Boundary(["%%%%--%%@"]);
  expect(b.mask("a://u:%%%%--%%@host")).not.toContain("%%%%--%%@");
});

test("a value holding what JSON escapes goes from text that was made into JSON too", () => {
  const value = 'ab"cd\\ef12GH34';
  const b = new Boundary([value]);
  const masked = b.mask(JSON.stringify({ quoted: value }));
  expect(masked).not.toContain(JSON.stringify(value).slice(1, -1));
  expect(b.mask(`plain ${value}`)).not.toContain(value);
});

test("values added later count from then on, and the matcher sees them", () => {
  const b = new Boundary([CANARY]);
  expect(b.mask(REMOVED)).toBe(REMOVED);
  expect(b.mask(CANARY)).not.toBe(CANARY);
  b.add([REMOVED]);
  expect(b.mask(REMOVED)).not.toContain(REMOVED);
  expect(b.mask(CANARY)).not.toBe(CANARY);
});

test("every string in a request goes through: nested, in a list and as a key", () => {
  const b = new Boundary([CANARY]);
  const got = b.maskValue({ a: [{ b: `x ${CANARY}` }], [CANARY]: 1, n: 3, none: null, flag: true, u: undefined });
  expect(JSON.stringify(got)).not.toContain(CANARY);
  expect((got as { n: number }).n).toBe(3);
  expect((got as { none: null }).none).toBeNull();
});

test("a large diff with no value in it costs little; one with a value is still quick", () => {
  const big = "+x = 1 # some ordinary line of a change\n".repeat(25_000); // 1 MB
  const none = new Boundary();
  const t0 = performance.now();
  for (let i = 0; i < 100; i++) none.mask(big);
  expect(performance.now() - t0).toBeLessThan(20);
  const many = new Boundary(Array.from({ length: 500 }, (_, i) => `${CANARY}${i}`));
  const t1 = performance.now();
  for (let i = 0; i < 10; i++) many.mask(big);
  expect((performance.now() - t1) / 10).toBeLessThan(200);
});

// A named field on every line of a large file: as many values as that file has lines.
const VALUES = 200_000;
const manyValues = () => Array.from({ length: VALUES }, (_, i) => createHash("sha256").update(`v${i}`).digest("base64url").slice(0, 24));

test("masking costs no more with many values, and every one of them still goes", () => {
  const values = manyValues();
  const b = new Boundary(values);
  const line = "+x = 1 # some ordinary line of a change\n";
  b.mask("the index is made once");
  for (const [size, most] of [[2_000, 100], [20_000, 100], [200_000, 200], [1_000_000, 500]] as const) {
    const text = line.repeat(Math.ceil(size / line.length));
    const t0 = performance.now();
    expect(b.mask(text)).toBe(text);
    expect([size, performance.now() - t0 < most]).toEqual([size, true]);
  }
  // Any of them: first, last, a whole one, its start and end by a cut, and its URL form.
  const [first, last, odd] = [values[0]!, values.at(-1)!, "Ab3/cd+Ef9=gh&Ij2KL"];
  b.add([odd]);
  expect(b.mask(`a ${first} b ${last} c`)).not.toMatch(new RegExp(`${first}|${last}`));
  expect(b.mask(`key = "${first.slice(0, 15)}\nnext`)).not.toContain(first.slice(0, 12));
  expect(b.mask(`${last.slice(-15)}" more`)).not.toContain(last.slice(-12));
  expect(b.mask(`?t=${encodeURIComponent(odd)}&n=1`)).not.toContain(encodeURIComponent(odd));
  expect(b.mask(`has ${odd}!`)).not.toContain(odd);
}, 60_000);

test("a matcher for a whole tree costs no more with many values either", () => {
  const values = manyValues();
  const replace = standInsFor(values);
  const text = "x = 1\n".repeat(30_000);
  const t0 = performance.now();
  for (let i = 0; i < 10; i++) expect(replace(text).count).toBe(0);
  expect(performance.now() - t0).toBeLessThan(500);
  expect(replace(`x = "${values[7]}"`).count).toBe(1);
  // Whole occurrences only, as with few values.
  expect(replace(`x${values[7]}y`).count).toBe(0);
}, 60_000);

// A value of one letter over and over: a place in the text that looks like its end at every character. Word-like, so only
// the whole value goes.
const RUN = 100_000;
const longRun = `sk-${"a".repeat(RUN)}`;
const QUICK = 2000;
for (const [name, text, leaves] of [
  ["the whole value", `key = "${longRun}"`, longRun],
  ["twice the length, whole", `key = "${`sk-${"a".repeat(2 * RUN)}`}"`, null],
  ["a run with no start", `key = "${"a".repeat(RUN - 5)}"`, null],
  ["a run inside a word", `key = "b${"a".repeat(RUN)}c"`, null],
  ["a run broken in the middle", `-${"a".repeat(RUN / 2)}b${"a".repeat(RUN / 2)}-`, null],
  ["its start, cut", `key = "${longRun.slice(0, RUN - 7)}\n`, null],
] as const) {
  test(`masking a long run takes no time to speak of: ${name}`, () => {
    const b = new Boundary([longRun]);
    const t0 = performance.now();
    const masked = b.mask(text);
    expect(performance.now() - t0).toBeLessThan(QUICK);
    if (leaves) expect(masked).not.toContain(leaves);
  }, 60_000);
}

// A random block over and over: as many places to compare, and here each piece goes too.
const BLOCK = LONG.slice(0, 64);
const blockRun = BLOCK.repeat(RUN / 64);
for (const [name, text] of [
  ["the whole value", `key = "${blockRun}"`],
  ["twice the length", `key = "${blockRun}${blockRun}"`],
  ["no start", `key = "${blockRun.slice(5)}"`],
  ["a start, cut", `key = "${blockRun.slice(0, -7)}\n`],
  ["inside a word", `key = "b${blockRun}c"`],
] as const) {
  test(`masking a long run of a random value takes no time to speak of: ${name}`, () => {
    expect(piecesAllowed(blockRun)).toBe(true);
    const b = new Boundary([blockRun]);
    const t0 = performance.now();
    const masked = b.mask(text);
    expect(performance.now() - t0).toBeLessThan(QUICK);
    if (name !== "inside a word") expect(masked).not.toContain(BLOCK);
  }, 60_000);
}

test("masking a value that repeats a short pattern takes no time to speak of, nor a tree's matcher", () => {
  const value = `Ab1-${"cD2-".repeat(25_000)}`;
  const b = new Boundary([value]);
  const t0 = performance.now();
  for (const text of [value, `${value}${value}`]) expect(b.mask(text)).not.toContain("cD2-cD2-cD2-cD2-");
  // Too little spread to be random, so a piece stays: only the time counts here.
  for (const text of [value.slice(4), value.slice(0, -4), `${"cD2-".repeat(50_000)}`]) b.mask(text);
  const matcher = standInsFor([value, ...Array.from({ length: 100 }, (_, i) => `Zq7xK2mP9vR4tY1w${i}`)]);
  matcher(`${"cD2-".repeat(50_000)}`);
  expect(performance.now() - t0).toBeLessThan(QUICK * 2);
}, 60_000);

test("the agreement found by the quick way is the plain comparison's", () => {
  let seed = 20261105;
  const next = (n: number) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) % n;
  const word = (max: number, letters: string) => Array.from({ length: next(max) + 1 }, () => letters[next(letters.length)]).join("");
  for (let round = 0; round < 20_000; round++) {
    const letters = round % 2 ? "ab" : "abc-";
    const text = word(60, letters), value = word(30, letters);
    const places = Array.from({ length: text.length }, (_, i) => i).filter(() => next(3) > 0);
    const plain = places.map((p) => {
      let k = 0;
      while (k < value.length && p + k < text.length && text[p + k] === value[k]) k++;
      return k;
    });
    const got = agreements(text, value, places);
    if (JSON.stringify(got) !== JSON.stringify(plain)) expect([text, value, got]).toEqual([text, value, plain] as never);
    const own = [...selfAgreement((i) => value.charCodeAt(i), value.length)];
    const ownPlain = Array.from({ length: value.length }, (_, i) => {
      let k = 0;
      while (i + k < value.length && value[i + k] === value[k]) k++;
      return k;
    });
    if (JSON.stringify(own) !== JSON.stringify(ownPlain)) expect([value, own]).toEqual([value, ownPlain] as never);
  }
});

const KEY_LETTERS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

test("on random text nothing of a random value is left at a word's edge", () => {
  let seed = 8;
  const next = (n: number) => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0, (seed >>> 8) % n);
  const word = (min: number, max: number, letters: string) =>
    Array.from({ length: min + next(max - min + 1) }, () => letters[next(letters.length)]).join("");
  for (let round = 0; round < 1500; round++) {
    const letters = round % 2 ? "aB" : "aB1-";
    // A random head, and a tail whose pieces overlap one another.
    const value = `Q${word(60, 60, KEY_LETTERS)}${word(13, 15, letters)}Z`;
    expect(piecesAllowed(value)).toBe(true);
    const b = new Boundary([value]);
    const cutAt = next(value.length);
    const pieces = [value, value.slice(cutAt), value.slice(0, cutAt), word(0, 10, letters), " ", "(", "\n", "x"];
    const text = Array.from({ length: 5 }, () => pieces[next(pieces.length)]).join("");
    const masked = b.mask(text);
    expect(masked).not.toContain(value);
    const edge = (at: number) => at === masked.length || !/[A-Za-z0-9]/.test(masked[at]!);
    for (let at = 0; at < masked.length; at++) {
      for (let n = 0; n < value.length && masked[at + n] === value[n]; n++) {
        if (n + 1 >= 12 && edge(at + n + 1)) throw new Error(`a start left in ${JSON.stringify(masked)} of ${value}`);
      }
      for (let n = 0; n < value.length && masked[at - n - 1] === value[value.length - n - 1]; n++) {
        if (n + 1 >= 12 && (at - n - 1 === 0 || edge(at - n - 2))) throw new Error(`an end left in ${JSON.stringify(masked)} of ${value}`);
      }
    }
  }
});

test("values of every length, sharing a start or inside one another, all go", () => {
  const b = new Boundary(["abc", "abcd", "abcdefg", "abcdefgh", "abcdefghijkl", "abcdefghijklmnop", "defghijklmnopqrs"]);
  for (const v of ["abc", "abcd", "abcdefg", "abcdefgh", "abcdefghijkl", "abcdefghijklmnop", "defghijklmnopqrs"]) {
    expect(b.mask(`[${v}]`)).not.toContain(v);
  }
  // Two that overlap in the text: nothing of either is left, and the text keeps its length.
  const masked = b.mask("[abcdefghijklmnopqrs]");
  expect(masked).not.toMatch(/abcd|defg|mnop|qrs/);
  expect(masked).toHaveLength("[abcdefghijklmnopqrs]".length);
});

test("the values of a diff: both sides, by file, hunk context too", () => {
  const diff = `diff --git a/a.py b/a.py\n--- a/a.py\n+++ b/a.py\n@@ -1,2 +1,2 @@ password = "Fn8mK3qZ6wT1xR5b"\n` +
    ` keep = 1\n-api_token = "${REMOVED}"\n+api_token = "${CANARY}"\n` +
    `diff --git a/.env.sample b/.env.sample\n--- a/.env.sample\n+++ b/.env.sample\n@@ -0,0 +1 @@\n+API_TOKEN=${UNCHANGED}\n`;
  expect(diffSuspects(diff).sort()).toEqual([CANARY, REMOVED, UNCHANGED, "Fn8mK3qZ6wT1xR5b"].sort());
  expect(diffSuspects("")).toEqual([]);
});

test("a snapshot names every suspect, also with stand-ins off, in a lockfile and in a secret file", () => {
  const repo = leakyRepo();
  writeFileSync(join(repo, "yarn.lock"), `auth_token: "${CANARY}"\n`);
  commit(repo, "lockfile");
  const off = takeSnapshot(repo, null, join(tmp(), "off"), [], { standIns: false });
  expect([...off.suspects].sort()).toEqual([CANARY, UNCHANGED, IN_SECRET_FILE].sort());
  expect([...off.secrets]).toEqual([]);
  const on = takeSnapshot(repo, null, join(tmp(), "on"), [], { standIns: true });
  expect([...on.suspects].sort()).toEqual([CANARY, UNCHANGED, IN_SECRET_FILE].sort());
  // A secret file is left out and its value's other places are masked, not rewritten.
  expect(existsSync(join(tmp(), "off", ".env"))).toBe(false);
  expect(readFileSync(join(tmp(), "off", "other.py"), "utf8")).toContain(IN_SECRET_FILE);
});

// --- files over the first scan limit ---------------------------------------------------------------------------------

/** Past SCAN_LIMIT, built when run: no file here holds a key-shaped string. */
const AWS = `AKIA${"IOSFODNN7EXAMPLE"}`;
const padding = (bytes: number) => '  "note": "some ordinary data line",\n'.repeat(Math.ceil(bytes / 37));
const bigJson = () => `{\n  "api_token": "${AWS}",\n  "db_password": "${UNCHANGED}",\n${padding(1_100_000)}  "end": 1\n}\n`;

function bigRepo(name: string, text: string, standIns = true): string {
  const repo = leakyRepo({ standIns });
  writeFileSync(join(repo, name), text);
  commit(repo, "a big file");
  // The change under review is small: a big file in a diff is refused before any of this.
  writeFileSync(join(repo, "settings.py"), `api_token = "${REMOVED}"\n`);
  return repo;
}

test("a big file's values are found: the key-shaped one gets its stand-in, a guess stays and goes through the filter", () => {
  const repo = bigRepo("big.json", bigJson());
  const snap = join(tmp(), "snap");
  const r = takeSnapshot(repo, null, snap, [], { standIns: true });
  expect(r.withheld).toEqual([{ path: ".env", line: 0, label: "named like a secret" }]);
  expect([...r.suspects]).toEqual(expect.arrayContaining([AWS, UNCHANGED]));
  const kept = readFileSync(join(snap, "big.json"), "utf8");
  expect(kept).not.toContain(AWS);
  expect(kept).toContain('"api_token": "AKIA');
  expect(r.secrets.has(AWS)).toBe(true);
});

test("a guess only a big file holds stays in it, and the filter has it", () => {
  const guess = "Tr5wE1yU7iO3pA9s";
  const repo = bigRepo("data.json", `{\n  "db_password": "${guess}",\n${padding(1_100_000)}}\n`);
  const snap = join(tmp(), "snap");
  const r = takeSnapshot(repo, null, snap, [], { standIns: true });
  expect(r.suspects.has(guess)).toBe(true);
  expect(r.secrets.has(guess)).toBe(false);
  expect(readFileSync(join(snap, "data.json"), "utf8")).toContain(guess);
});

for (const standIns of [true, false]) {
  test(`route: read_file and grep on a big file, whose values a snapshot once left unseen (stand-ins ${standIns ? "on" : "off"})`,
    async () => {
      const guess = "Tr5wE1yU7iO3pA9s";
      const repo = bigRepo("big.json", `{\n  "db_password": "${guess}",\n${padding(1_100_000)}}\n`, standIns);
      const agent = new RecordingAgent([[tool("read_file", { path: "big.json" }),
        tool("grep", { pattern: "db_password", path: "big.json" })]]);
      await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson("openai:x", VERDICT),
        sessionFactory: fakeFactory(leakyRun) });
      const sent = agent.bodies.join("\n");
      expect(sent).toContain("big.json:2:");
      expect(sent).toContain("db_password");
      expect(sent).not.toContain(guess);
    });
}

test("a private key with its body in a big text file stays, with a fake", () => {
  const header = `-----BEGIN ${"PRIVATE"} KEY-----`;
  const body = "MIIEvQIBADANBgkq" + "hkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7VJTUt9Us8cKj";
  const repo = bigRepo("dump.txt", `${header}\n${body}\n-----END ${"PRIVATE"} KEY-----\n${padding(1_100_000)}`);
  const snap = join(tmp(), "snap");
  const r = takeSnapshot(repo, null, snap, [], { standIns: true });
  expect(r.withheld).toEqual([{ path: ".env", line: 0, label: "named like a secret" }]);
  expect(r.fakedKeys).toEqual(["dump.txt"]);
  expect(readFileSync(join(snap, "dump.txt"), "utf8")).not.toContain(body);
});

test("a big file full of keys is left out: each stand-in takes a slow hash", () => {
  const keys = Array.from({ length: BIG_KEYS_MOST + 1 }, (_, i) => `"sk-${"a".repeat(32)}${String(i).padStart(8, "0")}"`).join("\n");
  const repo = bigRepo("keys.json", `${keys}\n${padding(1_100_000)}`);
  const r = takeSnapshot(repo, null, join(tmp(), "snap"), [], { standIns: true });
  expect(r.withheld).toEqual([{ path: ".env", line: 0, label: "named like a secret" }, { path: "keys.json", line: 1, label: `over ${BIG_KEYS_MOST} key-shaped strings` }]);
  expect(existsSync(join(tmp(), "snap", "keys.json"))).toBe(false);
  // Its values still count wherever else they stand.
  expect(r.suspects.size).toBeGreaterThan(BIG_KEYS_MOST);
  expect([...r.secrets].some((v) => v.startsWith("sk-"))).toBe(false);
}, 30_000);

test("a big binary file stays and is not scanned: no model can read it, and its bytes are not text", () => {
  const repo = bigRepo("data.bin", `\0binary\n"api_token": "${AWS}"\n${padding(1_100_000)}`);
  const r = takeSnapshot(repo, null, join(tmp(), "snap"), [], { standIns: true });
  expect(r.withheld).toEqual([{ path: ".env", line: 0, label: "named like a secret" }]);
  expect(existsSync(join(tmp(), "snap", "data.bin"))).toBe(true);
  expect(r.suspects.has(AWS)).toBe(false);
});

test("a text file past the higher cap is left out with a clear line; a binary one, and one beside the tree, stay", async () => {
  const saved = changeLimits.maxScanBytes;
  changeLimits.maxScanBytes = 1_200_000;
  try {
    const repo = bigRepo("huge.json", `"api_token": "${AWS}"\n${padding(1_300_000)}`);
    writeFileSync(join(repo, "huge.bin"), `\0${padding(1_300_000)}`);
    writeFileSync(join(repo, ".arnxignore"), "aside/\n");
    mkdirSync(join(repo, "aside"));
    writeFileSync(join(repo, "aside/seed.json"), padding(1_300_000));
    commit(repo, "more big files");
    const snap = join(tmp(), "snap");
    const r = takeSnapshot(repo, null, snap, [], { standIns: true, sandbox: ["aside/seed.json"] });
    expect(r.withheld).toEqual([{ path: ".env", line: 0, label: "named like a secret" }, { path: "huge.json", line: 0, label: "too large to scan" }]);
    expect(existsSync(join(snap, "huge.json"))).toBe(false);
    expect(existsSync(join(snap, "huge.bin"))).toBe(true);
    expect(r.sandboxed).toEqual(["aside/seed.json"]);
    expect(existsSync(join(`${snap}.sandbox`, "aside/seed.json"))).toBe(true);

    writeFileSync(join(repo, "settings.py"), `api_token = "${REMOVED}"\n`);
    const agent = new RecordingAgent([[tool("read_file", { path: "huge.json" })]]);
    const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson("openai:x", VERDICT),
      sessionFactory: fakeFactory(leakyRun), progress: () => {} });
    expect(review.leftOutFiles).toEqual([{ path: ".env", line: 0, label: "named like a secret" }, { path: "huge.json", line: 0, label: "too large to scan" }]);
    expect(agent.bodies[0]).toContain("`huge.json` (too large to scan)");
    expect(agent.bodies.join("\n")).not.toContain(AWS);
  } finally {
    changeLimits.maxScanBytes = saved;
  }
});

test("masking touches no code on disk", async () => {
  const repo = leakyRepo();
  const before = readFileSync(join(repo, "settings.py"), "utf8");
  const snaps: string[] = [];
  await runReview(repo, { settings: SETTINGS, agentModel: new RecordingAgent(TURNS()),
    challenger: new RecordingJson("openai:x", VERDICT),
    sessionFactory: async (_c, snap, _l, body) => {
      snaps.push(readFileSync(join(snap, "settings.py"), "utf8"));
      return body(new FakeSession(snap, leakyRun));
    } });
  expect(readFileSync(join(repo, "settings.py"), "utf8")).toBe(before);
  expect(snaps[0]).toContain(CANARY); // stand-ins off: the snapshot holds the real value, only the requests do not
});

test("a suspect's rule says whether it is certain or a guess", () => {
  expect(isCertainRule("key-shaped")).toBe(true);
  expect(isCertainRule("address-password")).toBe(true);
  expect(isCertainRule("named-strong")).toBe(false);
  expect(isCertainRule("named-weak")).toBe(false);
  expect(isCertainRule("")).toBe(false);
  const why = new Map<string, string>();
  suspects("a.py", `api_token = "${CANARY}"\n`, [], why);
  expect(isCertainRule(why.get(CANARY)!)).toBe(false);
});

test("a capitals key behind a short kind prefix is judged as its body is, whatever its draw", () => {
  const caps = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  // (A body too repetitive to look random is refused with or without a prefix: the prefix must change nothing.)
  for (const prefix of ["key-", "aws_", "tok_"]) {
    let differ = 0;
    for (let i = 0; i < 3000; i++) {
      let body = "";
      for (let j = 0; j < 16; j++) body += caps[Math.floor(Math.random() * caps.length)];
      if (piecesAllowed(prefix + body) !== piecesAllowed(body)) differ++;
    }
    expect(differ).toBe(0);
  }
});

// --- a model's stand-in meets real files (S3) ------------------------------------------------------------------------

/** A test the fake sandbox runs as a test would: it passes when the value it names is what settings.py holds, and its
 * failure quotes what the code holds. */
const VALUE_TEST = (held: string) => `from settings import api_token\n\ndef test_add():\n    assert api_token == "${held}"\n`;
const valueRun = (snap: () => string, ran: string[]) => (command: string): [string | null, string, boolean] => {
  void command;
  const test = readFileSync(join(snap(), GEN), "utf8");
  const code = readFileSync(join(snap(), "settings.py"), "utf8");
  const named = /== "([^"]*)"/.exec(test)![1]!;
  ran.push(test);
  return code.includes(`"${named}"`) ? [junitXml([[GEN, "test_add", "passed", ""]]), "1 passed\n", false]
    : [junitXml([[GEN, "test_add", "failed", `assert ${code.trim()} == "${named}"`]]), `E   ${code}\n1 failed\n`, false];
};
const valueRound = (held: string) => (): Block[][] => [[tool("read_file", { path: "settings.py" })],
  [tool("write_file", { path: GEN, content: VALUE_TEST(held) }), tool("run_tests", {})]];

test("a test holding a stand-in passes against the real value in the snapshot", async () => {
  const repo = leakyRepo({ standIns: true });
  const agent = new RecordingAgent(valueRound(FAKED)(), JSON.stringify({
    tests: [{ test: `${GEN}::test_add`, expects: "the token" }], suspected_defects: [], questions: [] }));
  const made: FakeSession[] = [];
  const ran: string[] = [];
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent,
    challenger: new RecordingJson("openai:x", VERDICT), sessionFactory: fakeFactory(valueRun(() => made[0]!.snap, ran), made) });
  // The run was on the real value, and the test said it.
  expect(ran.length).toBeGreaterThan(0);
  expect(ran.every((t) => t.includes(CANARY) && !t.includes(FAKED))).toBe(true);
  expect(review.findings).toEqual([]);
  expect(review.projectStats?.[0]?.passed ?? 1).toBeGreaterThan(0);
});

test("the saved test file keeps the stand-in", async () => {
  const repo = leakyRepo({ standIns: true });
  const agent = new RecordingAgent(valueRound(FAKED)(), JSON.stringify({
    tests: [{ test: `${GEN}::test_add`, expects: "the token" }], suspected_defects: [], questions: [] }));
  const made: FakeSession[] = [];
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent,
    challenger: new RecordingJson("openai:x", VERDICT), sessionFactory: fakeFactory(valueRun(() => made[0]!.snap, []), made) });
  const saved = (readdirSync(rdir, { recursive: true }) as string[]).filter((f) => f.endsWith(".arnx-copy"));
  expect(saved.length).toBe(1);
  const text = readFileSync(join(rdir, saved[0]!), "utf8");
  expect(text).toContain(FAKED);
  expect(text).not.toContain(CANARY);
});

test("a failure message quoting the real value is masked before a model sees it", async () => {
  const repo = leakyRepo({ standIns: true });
  // The test names something else, so it fails, and the failure quotes the code.
  const agent = new RecordingAgent(valueRound("not the value")());
  const made: FakeSession[] = [];
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson("openai:x", VERDICT),
    sessionFactory: fakeFactory(valueRun(() => made[0]!.snap, []), made) });
  const sent = agent.bodies.join("\n");
  expectClean("the failure", sent);
  expect(sent).toContain(`E   api_token = \\"${FAKED}`);
});
