// What a review spent is logged however it ends: finished, failed, interrupted or killed, and never twice.
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { newUse } from "../src/llm";
import { runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { spendClosers } from "../src/interrupt";
import { withProviderSlot } from "../src/provider";
import { logPartial, reconcileUsage, USAGE_LOG, usageFromEvents } from "../src/usage";
import { render, summary } from "../src/report";
import { sampleReview } from "./helpers/review";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" };
const GEN = "tests/arnx_generated/test_x.py";
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"), { recursive: true });
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return 0\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
});

const failing = (snap: string) => new FakeSession(snap, () => [junitXml([[GEN, "test_bad", "failed", "boom"]]),
  "1 failed", false]);
const session = async (_c: unknown, snap: string, _l: string, body: (r: FakeSession) => Promise<never>) =>
  body(failing(snap));
const steps = () => [
  [tool("write_file", { path: `svc/${GEN}`, content: "import calc\ndef test_bad(): assert 0\n" })],
  [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))]];
const EMPTY = { suspects: [], questions: [] };

interface Line { id?: string; command: string; partial?: boolean; reason?: string; usage: { model: string; cost_usd: number; unknown_calls?: number }[] }
const lines = (r: string): Line[] => !existsSync(join(r, ".arnx", USAGE_LOG)) ? []
  : readFileSync(join(r, ".arnx", USAGE_LOG), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Line);
const sum = (r: string, id: string) => lines(r).filter((l) => l.id === id)
  .reduce((a, l) => a + l.usage.reduce((b, u) => b + u.cost_usd, 0), 0);
const eventsCost = (rdir: string) => usageFromEvents(join(rdir, "events.jsonl")).reduce((a, u) => a + u.costUsd, 0);
const reviewDir = (r: string) => join(r, ".arnx/reviews", readdirSync(join(r, ".arnx/reviews"))[0]!);

/** A reviewer whose provider answers once, then the network is gone. */
function cutAfterOneCall() {
  const agent = new ScriptedAgent(steps());
  const create = agent.create.bind(agent);
  let n = 0;
  agent.create = async (a) => { if (n++ >= 1) throw new Error("network is unreachable"); return create(a); };
  return agent;
}
const cutRun = (r: string) => runReview(r, { settings: SETTINGS, agentModel: cutAfterOneCall(),
  challenger: new FakeJson([]), sessionFactory: session as never, hunt: false });

test("a review that fails keeps what it spent", async () => {
  await expect(cutRun(repo)).rejects.toThrow("network is unreachable");
  const rdir = reviewDir(repo), id = rdir.split("/").at(-1)!;
  expect(existsSync(join(rdir, "review.json"))).toBe(false);
  expect(eventsCost(rdir)).toBeGreaterThan(0);
  expect(lines(repo)).toHaveLength(1);
  expect(lines(repo)[0]).toMatchObject({ id, command: "review", partial: true, reason: "failed" });
  expect(sum(repo, id)).toBeCloseTo(eventsCost(rdir), 6);
});

/** A review killed from outside (SIGKILL): its events, no review.json, no usage line. */
function killedReview(r: string, id: string, cost: number): string {
  const rdir = join(r, ".arnx/reviews", id);
  mkdirSync(rdir, { recursive: true });
  const call = (seq: number) => JSON.stringify({ schema_version: 1, trace_id: id, seq, at: "2026-11-01T00:00:00Z",
    type: "model.call", data: { provider: "anthropic", model: "claude-sonnet-5-5", ok: true, input: 10, output: 5,
      cache_read: 0, cache_write: 0, cost_usd: cost / 2, latency_ms: 5, unknown_usage: 0, timed_out: false } });
  writeFileSync(join(rdir, "events.jsonl"), call(1) + "\n" + call(2) + "\n{\"torn");
  return rdir;
}

test("a killed review is counted on the next run, once", async () => {
  killedReview(repo, "20261101-aaaaaa", 0.4);
  reconcileUsage(repo);
  reconcileUsage(repo);
  expect(lines(repo)).toHaveLength(1);
  expect(lines(repo)[0]).toMatchObject({ id: "20261101-aaaaaa", partial: true, reason: "killed" });
  expect(sum(repo, "20261101-aaaaaa")).toBeCloseTo(0.4, 6);
  expect(lines(repo)[0]!.usage[0]).toMatchObject({ model: "anthropic:claude-sonnet-5-5", calls: 2 });
  // the next review does it too, before its own work, and does not count it again
  killedReview(repo, "20261101-bbbbbb", 0.2);
  await runReview(repo, { settings: SETTINGS, agentModel: new ScriptedAgent(steps()), challenger: new FakeJson([EMPTY]),
    sessionFactory: session as never, hunt: false });
  expect(lines(repo).filter((l) => l.reason === "killed").map((l) => l.id)).toEqual(["20261101-aaaaaa", "20261101-bbbbbb"]);
  expect(sum(repo, "20261101-bbbbbb")).toBeCloseTo(0.2, 6);
});

test("a resume logs only what it spent itself", async () => {
  await expect(cutRun(repo)).rejects.toThrow("network is unreachable");
  const rdir = reviewDir(repo), id = rdir.split("/").at(-1)!;
  const cutCost = sum(repo, id);
  expect(cutCost).toBeGreaterThan(0);
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: new ScriptedAgent(steps()),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "x" }, { groups: [] }]), sessionFactory: session as never,
    hunt: false, resume: true });
  expect(review.id).toBe(id);
  // the cut attempt is paid once: the lines of this review add up to its cost, none counted twice or lost
  expect(sum(repo, id)).toBeCloseTo(review.costUsd, 4);
  expect(sum(repo, id)).toBeGreaterThan(cutCost);
  expect(lines(repo).map((l) => l.partial ?? false)).toEqual([true, false]);
});

test("a model whose calls were all given up on with unknown usage reads cost unknown, not $0", () => {
  const usage = [{ ...newUse("anthropic:claude-sonnet-5-5"), calls: 2, costUsd: 0.4 },
    { ...newUse("openai:gpt-5.5-2026-04-23"), unknownCalls: 1 }];
  expect(render(sampleReview({ costUsd: 0.4, usage }))).toContain("- Cost $0.40 (claude-sonnet-5-5 $0.40 · " +
    "gpt-5.5-2026-04-23 cost unknown");
});

test("Ctrl-C during a test run logs what was spent", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "helpers/interrupt-run.ts"), repo],
    { env: { PATH: process.env.PATH ?? "", HOME: tmp() }, stdout: "pipe", stderr: "pipe" });
  const reader = proc.stdout.getReader();
  let out = "";
  while (!out.includes("RUNNING")) {
    const { value, done } = await reader.read();
    if (done) break;
    out += new TextDecoder().decode(value);
  }
  expect(out).toContain("RUNNING");
  proc.kill("SIGINT");
  expect(await proc.exited).toBe(130);
  const rdir = reviewDir(repo), id = rdir.split("/").at(-1)!;
  expect(eventsCost(rdir)).toBeGreaterThan(0);
  expect(lines(repo).filter((l) => l.id === id)).toHaveLength(1);
  expect(lines(repo)[0]).toMatchObject({ partial: true, reason: "interrupted" });
  expect(sum(repo, id)).toBeCloseTo(eventsCost(rdir), 6);
  // the next run does not count it again
  reconcileUsage(repo);
  expect(lines(repo)).toHaveLength(1);
}, 30_000);

// --- the books agree with the events, however the review was cut ---------------------------------------------------------

const AGENT = "claude-sonnet-5-5";
/** What the reviewer model spent per the events, and per the lines logged for the review. */
const agentEvents = (rdir: string) => usageFromEvents(join(rdir, "events.jsonl"))
  .filter((u) => u.model.endsWith(AGENT)).reduce((a, u) => a + u.costUsd, 0);
const agentLogged = (id: string) => lines(repo).filter((l) => l.id === id)
  .reduce((a, l) => a + l.usage.filter((u) => u.model.endsWith(AGENT)).reduce((b, u) => b + u.cost_usd, 0), 0);
const resumeRun = (agent: ScriptedAgent) => runReview(repo, { settings: SETTINGS, agentModel: agent,
  challenger: new FakeJson([{ verdict: "confirmed", reason: "x" }, { groups: [] }]), sessionFactory: session as never,
  hunt: false, resume: true });
const cutAgain = () => runReview(repo, { settings: SETTINGS, agentModel: cutAfterOneCall(), challenger: new FakeJson([]),
  sessionFactory: session as never, hunt: false, resume: true });
/** The round the cut attempt saved is lost, as when the process died before saving it. */
function loseRound(rdir: string) {
  for (const p of readdirSync(join(rdir, "projects"), { recursive: true }) as string[]) {
    if (p.endsWith("round.json")) rmSync(join(rdir, "projects", p));
  }
}

test("cut twice then resume: the lines hold exactly what the events say was spent", async () => {
  await expect(cutRun(repo)).rejects.toThrow("network is unreachable");
  const rdir = reviewDir(repo), id = rdir.split("/").at(-1)!;
  await expect(cutAgain()).rejects.toThrow("network is unreachable");
  expect(agentEvents(rdir)).toBeGreaterThan(0);
  expect(agentLogged(id)).toBeCloseTo(agentEvents(rdir), 6); // the second cut's spend is not lost
  const { review } = await resumeRun(new ScriptedAgent(steps()));
  expect(agentLogged(id)).toBeCloseTo(agentEvents(rdir), 6);
  expect(sum(repo, id)).toBeCloseTo(review.costUsd, 4);
});

test("failed with an unsaved round, then resume: the resume's own spend is logged", async () => {
  await expect(cutRun(repo)).rejects.toThrow("network is unreachable");
  const rdir = reviewDir(repo), id = rdir.split("/").at(-1)!;
  loseRound(rdir);
  const { review } = await resumeRun(new ScriptedAgent(steps()));
  expect(agentLogged(id)).toBeCloseTo(agentEvents(rdir), 6);
  expect(review.usage.filter((u) => u.model.endsWith(AGENT)).reduce((a, u) => a + u.costUsd, 0))
    .toBeCloseTo(agentEvents(rdir), 6); // and the review's own cost says so too
  expect(sum(repo, id)).toBeCloseTo(review.costUsd, 4);
});

test("SIGKILL then --resume: the killed session's spend is logged too", async () => {
  await expect(cutRun(repo)).rejects.toThrow("network is unreachable");
  const rdir = reviewDir(repo), id = rdir.split("/").at(-1)!;
  writeFileSync(join(repo, ".arnx", USAGE_LOG), ""); // a kill: nothing was logged
  loseRound(rdir);
  const { review } = await resumeRun(new ScriptedAgent(steps()));
  expect(agentLogged(id)).toBeCloseTo(agentEvents(rdir), 6);
  expect(sum(repo, id)).toBeCloseTo(review.costUsd, 4);
});

// --- each piece of the bookkeeping has a test that fails without it ------------------------------------------------------

test("reconcile leaves the review being resumed alone, and one that finished", () => {
  killedReview(repo, "20261101-cccccc", 0.4);
  reconcileUsage(repo, "20261101-cccccc");
  expect(lines(repo)).toHaveLength(0);
  const done = killedReview(repo, "20261101-dddddd", 0.4);
  writeFileSync(join(done, "review.json"), "{}\n");
  reconcileUsage(repo);
  expect(lines(repo).map((l) => l.id)).toEqual(["20261101-cccccc"]);
});

test("logging the same spend again writes nothing, not even a line of zeros", () => {
  killedReview(repo, "20261101-eeeeee", 0.4);
  logPartial(repo, "review", "20261101-eeeeee", "failed");
  logPartial(repo, "review", "20261101-eeeeee", "interrupted");
  logPartial(repo, "review", "20261101-eeeeee", "failed");
  expect(lines(repo)).toHaveLength(1);
});

test("calls in flight at a signal are logged as unknown calls", async () => {
  killedReview(repo, "20261101-ffffff", 0.4);
  let release = () => {};
  const held = withProviderSlot("anthropic", () => new Promise<void>((r) => { release = r; }));
  logPartial(repo, "review", "20261101-ffffff", "interrupted");
  logPartial(repo, "review", "20261101-ffffff", "interrupted"); // the exit handler after it: nothing new
  release();
  await held;
  const rows = lines(repo).flatMap((l) => l.usage) ;
  expect(rows.filter((u) => u.model === "anthropic:(in flight)").map((u) => u.unknown_calls)).toEqual([1]);
  expect(lines(repo)).toHaveLength(1);
});

test("a review leaves nothing registered to run at exit, finished or failed", async () => {
  await runReview(repo, { settings: SETTINGS, agentModel: new ScriptedAgent(steps()), challenger: new FakeJson([
    { verdict: "confirmed", reason: "x" }, { groups: [] }]), sessionFactory: session as never, hunt: false });
  expect(spendClosers.size).toBe(0);
  await expect(cutAgain()).rejects.toThrow();
  expect(spendClosers.size).toBe(0);
});

test("a process that exits (not by a signal) with a review running logs what it spent", async () => {
  const proc = Bun.spawn(["bun", join(import.meta.dir, "helpers/interrupt-run.ts"), repo, "exit"],
    { env: { PATH: process.env.PATH ?? "", HOME: tmp() }, stdout: "pipe", stderr: "pipe" });
  expect(await proc.exited).toBe(2);
  const rdir = reviewDir(repo), id = rdir.split("/").at(-1)!;
  expect(lines(repo).filter((l) => l.id === id)).toHaveLength(1);
  expect(lines(repo)[0]).toMatchObject({ partial: true, reason: "failed" });
  expect(sum(repo, id)).toBeCloseTo(eventsCost(rdir), 6);
}, 30_000);

test("the summary line says cost unknown for a model whose calls all ended unpriced", () => {
  const usage = [{ ...newUse("anthropic:claude-sonnet-5-5"), calls: 2, costUsd: 0.4 },
    { ...newUse("openai:gpt-5.5-2026-04-23"), unknownCalls: 1 }];
  const md = summary(sampleReview({ costUsd: 0.4, usage }), "review.md");
  expect(md).toContain("gpt-5.5-2026-04-23: cost unknown");
  expect(md).not.toContain("a little more");
});
