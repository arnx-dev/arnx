// A key with no credits left stops the command at once with one line naming the provider, whatever the step: the
// shapes are the ones the providers sent (OpenAI's background response that failed, its 429, Anthropic's 400).
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runAgent, Workspace } from "../src/agent";
import { fatal, ModelError, NoCredits } from "../src/errors";
import { parseReviewFile } from "../src/config";
import { LocalBrain } from "../src/localbrain";
import { type AgentModel, AnthropicAgent, FallbackJson, PRICES, resetOutageWaits, ResponsesAgent, ResponsesJson } from "../src/llm";
import { parseModelRef } from "../src/settings";
import { Cli } from "./helpers/cli";
import { FakeJson, ScriptedAgent, text } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const GPT = parseModelRef("openai:gpt-5.5-2026-04-23");
const noSleep = async () => {};
const call = { system: "s", tools: [], messages: [{ role: "user" as const, content: "u" }], maxTokens: 100 };
const LINE = "OpenAI has no credits left on this key: add credits, then run again.";
/** A fetch answering each request in turn; `n` counts from 1. */
const fetching = (h: (n: number, url: string) => Response) => {
  let n = 0;
  return (async (url: unknown) => h(++n, String(url))) as unknown as typeof fetch;
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status,
  headers: { "content-type": "application/json" } });
const QUOTA = { error: { message: "You exceeded your current quota, please check your plan and billing details.",
  type: "insufficient_quota", param: null, code: "insufficient_quota" } };

test("OpenAI: a background response that failed for credits stops at once", async () => {
  for (const code of ["credit_balance_exhausted", "insufficient_quota"]) {
    let n = 0;
    const m = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
      background: true, pollSeconds: 0, fetch: fetching((i, url) => {
        n = i;
        if (url.endsWith("/responses")) return json({ id: "resp_1", status: "queued" });
        return json({ id: "resp_1", status: "failed", output: [],
          error: { code, message: "You exceeded your current quota." } });
      }) });
    const e = await new ResponsesAgent(m, "medium").create(call).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(NoCredits);
    expect([(e as NoCredits).message, (e as NoCredits).provider]).toEqual([LINE, "OpenAI"]);
    expect(n).toBe(2); // the create and one poll, never sent again
  }
  // Failed for any other reason: as before.
  const other = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    background: true, pollSeconds: 0, fetch: fetching(() => json({ id: "r", status: "failed",
      error: { code: "server_error", message: "boom" } })) });
  const e = await new ResponsesAgent(other, "medium").create(call).catch((x: unknown) => x) as ModelError;
  expect(e).not.toBeInstanceOf(NoCredits);
  expect(e.message).toContain("incomplete response (status failed)");
});

test("OpenAI: a 429 for credits is not retried; one for the rate limit still is", async () => {
  resetOutageWaits();
  let n = 0;
  const quota = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fetching((i) => {
      n = i;
      return json(QUOTA, 429);
    }) });
  await expect(quota.completeJson("s", "u", { type: "object" })).rejects.toThrow(LINE);
  expect(n).toBe(1);
  const busy = new ResponsesJson(GPT, "https://api.example/v1", "k", "medium", PRICES, { sleep: noSleep,
    fetch: fetching((i) => {
      n = i;
      return json({ error: { type: "rate_limit_exceeded", code: "rate_limit_exceeded", message: "slow down" } }, 429);
    }) });
  const e = await busy.completeJson("s", "u", { type: "object" }).catch((x: unknown) => x);
  expect(e).not.toBeInstanceOf(NoCredits);
  expect(n).toBe(7);
});

test("Anthropic: \"Your credit balance is too low\" (400) stops at once", async () => {
  let n = 0;
  const agent = new AnthropicAgent("claude-sonnet-5-5", "medium", "k", undefined, { sleep: noSleep,
    fetch: fetching((i) => {
      n = i;
      return json({ type: "error", error: { type: "invalid_request_error", message: "Your credit balance is too " +
        "low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." },
      request_id: "req_011" }, 400);
    }) });
  const e = await agent.create(call).catch((x: unknown) => x);
  expect(e).toBeInstanceOf(NoCredits);
  expect((e as Error).message).toBe("Anthropic has no credits left on this key: add credits, then run again.");
  expect(n).toBe(1);
});

/** An agent model whose every call is refused for credits. */
const broke = (): AgentModel => ({ model: "gpt-5.5-2026-04-23", provider: "openai",
  create: async () => {
    throw new NoCredits("OpenAI");
  } });

test("the agent loop and a fallback pass it on instead of going on without the call", async () => {
  const root = join(tmp(), "repo");
  mkdirSync(root, { recursive: true });
  const ws = new Workspace(root);
  await expect(runAgent(broke(), { tools: () => ws.tools(), call: (n, i) => ws.call(n, i) },
    { system: "s", user: "u", budgetUsd: 1, prices: PRICES })).rejects.toThrow(LINE);
  const second = new FakeJson([{ verdict: "confirmed" }]);
  await expect(new FallbackJson(new FakeJson([new NoCredits("OpenAI")]), second).completeJson("s", "u", {}))
    .rejects.toThrow(LINE);
  expect(second.calls).toHaveLength(0);
});

test("setup stops with the one line, exit 2, not as an environment it could not build", async () => {
  const repo = initRepo(join(tmp(), "shop"));
  writeFileSync(join(repo, "pricing.py"), "def total(xs):\n    return sum(xs)\n");
  commit(repo, "shop");
  const env = { ANTHROPIC_API_KEY: "a" };
  expect(await new Cli({ cwd: repo, env }).run("init")).toBe(0);
  const cli = new Cli({ cwd: repo, env, setupModel: broke() });
  expect(await cli.run("setup", "--yes")).toBe(2);
  expect(cli.stderr).toContain(`arnx: ${LINE}`);
  expect(cli.stdout + cli.stderr).not.toContain("could not build a working environment");
  const j = new Cli({ cwd: repo, env, setupModel: broke() });
  expect(await j.run("setup", "--yes", "--json")).toBe(2);
  expect(JSON.parse(j.stdout).error).toBe(LINE);
});

test("what escapes every handler (a stray promise) prints an ArnxError's own line: NoCredits exits 2, never as a bug", () => {
  expect(fatal(new NoCredits("OpenAI"), {})).toEqual({ lines: [`arnx: ${LINE}`], code: 2 });
  const bug = fatal(new TypeError("x is undefined"), {});
  expect([bug.lines[0]!.startsWith("arnx: internal error (TypeError: x is undefined)"), bug.code]).toEqual([true, 2]);
});

test("a second hunter with no credits is skipped, said once, and the round goes on", async () => {
  const cfg = parseReviewFile("version: 1\nimage: python:3.12-slim\ntest_command: pytest {targets}\n").projects[0]!;
  const said: string[] = [];
  // One second hunter and one brain for the run, as a review makes them; each round has its reviewer.
  const second = new FakeJson([new NoCredits("OpenAI"), new NoCredits("OpenAI")]);
  const reviewers: AgentModel[] = [];
  const brain = new LocalBrain({ agentModel: { model: "claude-sonnet-5-5", create: (a) => reviewers[0]!.create(a) },
    prices: PRICES, secondHunter: second });
  const round = async () => {
    // The reviewer answers after the second hunter has failed: its rejection must not go unhandled meanwhile.
    const report = JSON.stringify({ tests: [], suspected_defects: [], questions: [] });
    const reviewer = new ScriptedAgent([[text(JSON.stringify({ suspects: [], questions: [] }))], [text(report)],
      [text(report)]]);
    reviewers[0] = { model: reviewer.model, create: async (a) => {
      await new Promise((r) => setTimeout(r, 20));
      return reviewer.create(a);
    } };
    const r = await brain.agentRound("review",
      { cfg, diff: "diff --git a/a.py b/a.py\n+x = 1\n", scope: { owned: ["a.py"], used: [] }, scoped: true,
        envTests: [], maxQuestions: 3, dbNames: [], budgetUsd: 5, hunt: { context: "", searchDirs: [] },
        progress: (m) => said.push(m) }, Promise.resolve({ tools: () => [], call: async () => "" }));
    return r;
  };
  expect((await round()).agent.stop).toBe("end_turn");
  expect((await round()).agent.stop).toBe("end_turn"); // a second project in the same run: not asked again
  expect(second.calls).toHaveLength(1);
  expect(said.filter((m) => m.includes("second hunter skipped: OpenAI has no credits left on this key"))).toHaveLength(1);
});

test("a challenger fallback with no credits is skipped, said once; the challenger's own stays fatal", async () => {
  const notices: string[] = [];
  const first = new FakeJson([new ModelError("first: HTTP 503"), new ModelError("first: HTTP 503")]);
  const fallback = new FakeJson([new NoCredits("OpenAI")]);
  const m = new FallbackJson(first, fallback);
  m.notice = (x) => notices.push(x);
  for (let i = 0; i < 2; i++) {
    const e = await m.completeJson("s", "u", {}).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ModelError);
    expect(e).not.toBeInstanceOf(NoCredits);
  }
  expect(fallback.calls).toHaveLength(1); // the second verdict does not ask it again
  expect(notices.filter((x) => x === "challenger fallback skipped: OpenAI has no credits left on this key"))
    .toHaveLength(1);
});
