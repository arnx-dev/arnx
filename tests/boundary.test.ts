// The outbound filter: a value under a secret-looking name never leaves arnx by any route, whatever the snapshot holds.
// One test per route, each recording at the outermost layer a request passes. A route added later belongs here, and the
// last test fails until it is named.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeAnswerRunner } from "../src/accept";
import { Boundary, boundaryOf, diffSuspects, isMasked, maskedAgent, maskedJson } from "../src/boundary";
import { CloudClient } from "../src/cloud";
import { CloudBrain } from "../src/cloudbrain";
import { loadReviewFile, parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { takeSnapshot } from "../src/change";
import { ModelError } from "../src/errors";
import { EventLog } from "../src/events";
import { jevModel } from "../src/jev";
import { AnthropicJson, FallbackJson, type AgentModel, type Block, type JsonModel, type JsonReply, makeAgentModel,
  makeChallenger, makeJsonModel, makeSecondHunter, PRICES, type Reply, ResponsesJson } from "../src/llm";
import { LocalBrain } from "../src/localbrain";
import { runReview } from "../src/reviewer";
import { Boundary as FromSecrets, isCertainRule, suspects } from "../src/secrets";
import { defaultSettings, parseModelRef, type Settings, writeSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { checkData, reportTelemetry } from "../src/telemetry";
import { Cli } from "./helpers/cli";
import { type FakeCloud, fakeCloud, type StepScript, TOKEN } from "./helpers/cloudfake";
import { fakeFactory, FakeSession, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

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
  const agent = new RecordingAgent([[tool("read_file", { path: "other.py" }), tool("grep", { pattern: "db_password", path: "." })]],
    "done");
  const r = await runSetup(repo, SETTINGS, agent, { outDir: join(tmp(), "setup"), sessionFactory: fakeFactory(leakyRun) });
  expect(r).toBeDefined();
  const sent = agent.bodies.join("\n");
  expectClean("setup", sent);
  expect(sent).toContain("db_password");
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
  expect(b.standIns().sort()).toEqual([b.mask(CANARY), b.mask(REMOVED)].sort());
  expect(b.unmask(masked)).toBe(text);
});

test("no values: the same string and the same object come back", () => {
  const b = new Boundary();
  const msg = { role: "user", content: [{ type: "text", text: "x" }] };
  expect(b.mask("anything")).toBe("anything");
  expect(b.maskValue(msg)).toBe(msg);
  expect(b.unmask("anything")).toBe("anything");
  expect(b.standIns()).toEqual([]);
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

test("the rules a later step needs: certain or a guess, and what the scorecard imports", () => {
  expect(isCertainRule("key-shaped")).toBe(true);
  expect(isCertainRule("address-password")).toBe(true);
  expect(isCertainRule("named-strong")).toBe(false);
  expect(isCertainRule("named-weak")).toBe(false);
  expect(isCertainRule("")).toBe(false);
  expect(FromSecrets).toBe(Boundary);
  const why = new Map<string, string>();
  suspects("a.py", `api_token = "${CANARY}"\n`, [], why);
  expect(isCertainRule(why.get(CANARY)!)).toBe(false);
});
