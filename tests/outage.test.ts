// A provider that is down or refuses the key is named in the review's status, terminal summary and review.json,
// instead of a bare "incomplete": which provider, why, how many calls, and what is missing. A call that recovers on a
// retry is not an outage. arnx cloud's models are never named.
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CloudClient } from "../src/cloud";
import { CloudBrain } from "../src/cloudbrain";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { ModelError } from "../src/errors";
import { AnthropicAgent, PRICES, ResponsesAgent, ResponsesJson } from "../src/llm";
import { exitCode, failureLine, load, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import { defaultSettings, parseModelRef } from "../src/settings";
import { type FakeCloud, fakeCloud, TOKEN } from "./helpers/cloudfake";
import { FakeJson, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

/** A generic table, as a user writes it for an endpoint that copies the OpenAI Responses API. */
const TABLES = { myprovider: { api: "responses" as const, url: "https://llm.example.com/v1", key_env: "MY_PROVIDER_KEY" } };
const MODEL = parseModelRef("myprovider:some-model", TABLES);
const PRICED = { ...PRICES, "some-model": [0.12, 0.40, 0.024, 0.0] as [number, number, number, number] };
const KEY = "rk-live-0123456789abcdef";
const noSleep = async () => {};
type Handler = (n: number, body: string) => Response;
/** A fetch answering each request in turn; `n` counts from 1. */
const fetching = (h: Handler) => {
  let n = 0;
  return (async (_url: unknown, init?: RequestInit) => h(++n, String(init?.body ?? ""))) as unknown as typeof fetch;
};
const status = (code: number, body = "No ready deployment") => new Response(body, { status: code });
const remote = (h: Handler) => new ResponsesJson(MODEL, "https://llm.example.com/v1", KEY, "high", PRICED,
  { fetch: fetching(h), sleep: noSleep, store: false });
const SCHEMA = { type: "object" };

const VERDICT = { status: "completed", output: [{ type: "message", content: [{ type: "output_text",
  text: '{"verdict": "confirmed", "reason": "add subtracts."}' }] }],
  usage: { input_tokens: 100, output_tokens: 10, input_tokens_details: { cached_tokens: 0 } } };
const completed = () => new Response(`data: ${JSON.stringify({ type: "response.completed", response: VERDICT })}\n\n`,
  { status: 200, headers: { "content-type": "text/event-stream" } });

test("a call answered 503 on every attempt is the provider's outage; a refused key is auth", async () => {
  const down = await remote(() => status(503)).completeJson("s", "u", SCHEMA).catch((e: unknown) => e);
  expect(down).toBeInstanceOf(ModelError);
  expect((down as ModelError).fault).toEqual({ kind: "unavailable", detail: "HTTP 503" });
  expect((down as ModelError).tries).toBe(4);
  const auth = await remote(() => status(401, "bad key")).completeJson("s", "u", SCHEMA).catch((e: unknown) => e);
  expect((auth as ModelError).fault).toEqual({ kind: "auth", detail: "HTTP 401" });
  // A 400 is the request's fault, a 503 then a 400 no outage: neither is the provider's.
  expect(((await remote(() => status(400)).completeJson("s", "u", SCHEMA).catch((e: unknown) => e)) as ModelError).fault)
    .toBeUndefined();
  const mixed = remote((n) => status(n === 1 ? 503 : 400));
  expect(((await mixed.completeJson("s", "u", SCHEMA).catch((e: unknown) => e)) as ModelError).fault).toBeUndefined();
  // A few 503s, then a reply: no fault at all.
  const [reply] = await remote((n) => n < 3 ? status(503) : completed()).completeJson("s", "u", SCHEMA);
  expect(reply.verdict).toBe("confirmed");
});

test("an unreachable provider (nothing listens there) is an outage with no connection", async () => {
  // A real fetch to a closed local port: the same path a DNS failure or a refused connection takes.
  const m = new ResponsesJson(MODEL, "http://127.0.0.1:9/v1", KEY, "high", PRICED, { sleep: noSleep, store: false });
  const e = await m.completeJson("s", "u", SCHEMA).catch((x: unknown) => x) as ModelError;
  expect(e.fault?.kind).toBe("unavailable");
  expect(e.fault?.detail).toMatch(/^no connection \(.+\)$/);
});

test("Anthropic: 529 on every attempt is an outage, 401 a refused key", async () => {
  const overloaded = () => new Response(JSON.stringify({ type: "error", error: { type: "overloaded_error",
    message: "Overloaded" } }), { status: 529, headers: { "content-type": "application/json" } });
  const agent = (h: Handler) => new AnthropicAgent("claude-sonnet-5-5", "medium", KEY, undefined,
    { fetch: fetching(h), sleep: noSleep });
  const call = { system: "s", tools: [], messages: [{ role: "user" as const, content: "u" }], maxTokens: 100 };
  const down = await agent(overloaded).create(call).catch((e: unknown) => e) as ModelError;
  expect(down.fault).toEqual({ kind: "unavailable", detail: "HTTP 529" });
  const refused = () => new Response(JSON.stringify({ type: "error", error: { type: "authentication_error",
    message: "invalid x-api-key" } }), { status: 401, headers: { "content-type": "application/json" } });
  expect((await agent(refused).create(call).catch((e: unknown) => e) as ModelError).fault)
    .toEqual({ kind: "auth", detail: "HTTP 401" });
});

// --- in a review ------------------------------------------------------------------------------------------------------

const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";
const REPORT = '{"tests": [{"test": "tests/arnx_generated/test_add.py::test_add", "expects": "add sums"}],' +
  ' "suspected_defects": [], "questions": []}';
const SETTINGS = { ...defaultSettings(), providers: TABLES, beforeCheck: false, consentAt: "2026-10-20T00:00:00Z" };
const tmp = useTmp();
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-20"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
});
const agent = () => new ScriptedAgent([
  [tool("write_file", { path: GEN, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" })],
  [text(REPORT)],
]);
const runs = (): [string | null, string, boolean] => [junitXml([[GEN, "test_add", "failed", "assert -1 == 5"]]), "",
  false];
const reviewWith = (challenger: ResponsesJson | FakeJson) => runReview(repo, { settings: SETTINGS, agentModel: agent(),
  challenger, sessionFactory: fakeFactory(runs) });
const VENDORS = /myprovider|openai|anthropic|claude|gpt/i;

test("the challenger down on every call: the status names the provider, the outage and the missing second opinions", async () => {
  const { review, rdir } = await reviewWith(remote(() => status(503)));
  const line = summary(review, "review.md").split("\n")[1]!;
  // The second opinion, then the grouping of the findings: both calls fail, so both are missing.
  expect(line).toBe("myprovider (llm.example.com) unavailable: HTTP 503 on every call (2 calls, 4 attempts each); " +
    "missing: the second opinions, the grouping of findings. Run `arnx review --resume` when it is back.");
  expect(readFileSync(join(rdir, "review.md"), "utf8")).toContain("myprovider (llm.example.com) unavailable: HTTP 503 on every call");
  const json = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8"));
  expect(json.provider_failures).toEqual([{ provider: "myprovider", name: "myprovider (llm.example.com)", kind: "unavailable", detail: "HTTP 503",
    calls: 2, failed: 2, attempts: 8, roles: ["challenge", "explain"], missing: ["challenge", "explain"] }]);
  expect(load(rdir).providerFailures).toEqual(review.providerFailures!);
  // The exit code is what it was: an unchallenged finding counts as confirmed.
  const plain = await reviewWith(new FakeJson([new ModelError("no reply")]));
  expect(exitCode(review)).toBe(exitCode(plain.review));
  expect(plain.review.providerFailures).toBeUndefined();
  // Never the key, never the body the provider sent.
  const all = summary(review, "") + readFileSync(join(rdir, "review.md"), "utf8") + readFileSync(join(rdir,
    "review.json"), "utf8");
  expect(all).not.toContain(KEY);
  expect(summary(review, "")).not.toContain("No ready deployment");
});

test("an outage of the hunt only: a resume does not redo the hunt, so the line says run the review again", () => {
  const f = { provider: "myprovider", name: "myprovider (llm.example.com)", kind: "unavailable" as const,
    detail: "HTTP 503", calls: 1, failed: 1, attempts: 4, roles: ["part-hunt"], missing: ["part-hunt"] };
  expect(failureLine(f)).toBe("myprovider (llm.example.com) unavailable: HTTP 503 on every call (1 call, 4 attempts); " +
    "missing: the part hunts. Run `arnx review` again when it is back.");
});

test("a refused key names the variable to check", async () => {
  const { review } = await reviewWith(remote(() => status(401, "invalid api key")));
  expect(summary(review, "")).toContain("myprovider (llm.example.com) refused the key: HTTP 401 on every call (2 calls); missing: the " +
    "second opinions, the grouping of findings. Check MY_PROVIDER_KEY.");
  expect(review.providerFailures![0]).toMatchObject({ kind: "auth", key: "MY_PROVIDER_KEY" });
});

test("a few 503s, then replies: no outage line", async () => {
  const { review } = await reviewWith(remote((n) => n < 3 ? status(503) : completed()));
  expect(review.findings[0]!.verdict).toBe("confirmed");
  expect(review.providerFailures).toBeUndefined();
  expect(summary(review, "")).not.toMatch(/unavailable|refused/);
});

test("the reviewer's provider down: incomplete, and the reviewer's tests are what is missing", async () => {
  const reviewer = new ResponsesAgent(remote(() => status(503)), "high", { store: false });
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: reviewer, challenger: new FakeJson([]),
    sessionFactory: fakeFactory(runs) });
  expect(exitCode(review)).toBe(2);
  // review.md names the resume once, in the outage line, not a fresh review in the Incomplete line.
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  expect(md).toContain("Incomplete: `main` produced no tests: the reviewer's model call failed.\n");
  expect(md).not.toContain("again to cover it");
  expect(md.match(/arnx review --resume/g)).toHaveLength(1);
  expect(summary(review, "").split("\n")[1]).toBe("Incomplete: `main` produced no tests: the reviewer's model " +
    "call failed. myprovider (llm.example.com) unavailable: HTTP 503 on every call (1 call, 4 attempts); missing: the reviewer's tests. Run " +
    "`arnx review --resume` when it is back.");
});

test("some calls failed: how many of how many, and which role", async () => {
  const two = await runReview(repo, { settings: SETTINGS, agentModel: new ScriptedAgent([
    [tool("write_file", { path: GEN, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" +
      "\ndef test_more():\n    assert add(1, 1) == 2\n" })], [text(REPORT)]]),
  // Every call that sends test_more's failure is answered 503: its second opinion, and the grouping if it runs.
  challenger: remote((_n, body) => body.includes("assert 0 == 2") ? status(503) : completed()),
  sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "failed", "assert -1 == 5"],
    [GEN, "test_more", "failed", "assert 0 == 2"]]), "", false]) });
  const r = two.review;
  expect(r.findings.map((f) => f.verdict)).toEqual(["confirmed", null]);
  const f = r.providerFailures![0]!;
  expect(f.failed).toBeLessThan(f.calls);
  expect(f.roles[0]).toBe("challenge");
  expect(f.missing).not.toContain("challenge");
  expect(summary(r, "")).toContain(`myprovider (llm.example.com) unavailable: HTTP 503 on ${f.failed} of ${f.calls} calls (second opinion`);
});

// --- arnx cloud ---------------------------------------------------------------------------------------------------------

let clouds: FakeCloud[] = [];
afterEach(() => {
  for (const c of clouds) c.stop();
  clouds = [];
});

test("arnx cloud's models down: the status says so without naming a vendor", async () => {
  const c = fakeCloud({ rounds: { "*": [{ type: "done", stop: "api_error" }] } });
  clouds.push(c);
  const brain = new CloudBrain({ client: new CloudClient(c.url, { token: TOKEN, delays: [0] }), tier: "medium" });
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, brain, sessionFactory: fakeFactory(runs) });
  const said = summary(review, "");
  expect(said.split("\n")[1]).toBe("Incomplete: `main` produced no tests: the reviewer's model call failed. " +
    "arnx cloud's models unavailable: every project round (1) stopped on a failed model call. Run " +
    "`arnx review --resume` later.");
  const all = said + readFileSync(join(rdir, "review.md"), "utf8") + readFileSync(join(rdir, "review.json"), "utf8");
  expect(all).not.toMatch(VENDORS);
  expect(review.providerFailures).toEqual([{ provider: "arnx", name: "arnx cloud", kind: "unavailable",
    detail: "a model call failed on arnx cloud", calls: 1, failed: 1, roles: ["reviewer"], missing: ["reviewer"] }]);
});
