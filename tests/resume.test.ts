// A review cut off halfway (a dropped connection) continues with --resume: finished project rounds and verdicts are
// kept, not paid for again.
import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { ModelError } from "../src/errors";
import { resumable, runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
// The fakes report the same failure on any snapshot, so the before/after check would call every finding
// pre-existing; it is off here and tested in before.test.ts.
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" };
const GEN = "tests/arnx_generated/test_x.py";
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
  for (const p of ["services/pay/pay.py", "services/feed/feed.py", "services/shared/db.py", "infra/main.tf"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "X = 1\n");
  }
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  commit(repo, "layout");
  writeFileSync(join(repo, "services/shared/db.py"), "X = 2\n"); // reviewed by feed and pay
});

const steps = (p: string) => [
  [tool("write_file", { path: `services/${p}/${GEN}`, content: `import ${p}\ndef test_bad(): assert 0\n` })],
  [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))]];
const failing = (snap: string) => new FakeSession(snap, () => [junitXml([[GEN, "test_bad", "failed", "boom"]]),
  "1 failed", false]);

test("an interrupted review resumes: the finished project and its cost are kept, the rest is done", async () => {
  // first attempt: feed finishes, then the connection drops while pay is being set up
  const cut: SessionFactory = async (cfg, snap, _log, body) => {
    if (cfg.name === "pay") throw new Error("network is unreachable");
    return body(failing(snap));
  };
  const first = new ScriptedAgent(steps("feed"));
  await expect(runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: first, challenger: new FakeJson([]),
    sessionFactory: cut })).rejects.toThrow("network is unreachable");
  const [rid] = readdirSync(join(repo, ".arnx/reviews"));
  expect(existsSync(join(repo, ".arnx/reviews", rid!, "projects/feed/round.json"))).toBe(true);
  expect(existsSync(join(repo, ".arnx/reviews", rid!, "review.json"))).toBe(false);
  // resume: only pay runs; feed's round and cost are kept
  const second = new ScriptedAgent(steps("pay"));
  const judge = new FakeJson([{ verdict: "confirmed", reason: "a" }, { verdict: "confirmed", reason: "b" }]);
  const { review } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: second, challenger: judge,
    sessionFactory: async (_c, snap, _l, body) => body(failing(snap)), resume: true });
  expect(review.id).toBe(rid!);
  expect(second.calls).toHaveLength(2);
  expect(review.findings.map((f) => f.project)).toEqual(["feed", "pay"]);
  expect(review.usage[0]!.calls).toBe(4); // feed's 2 calls from before, pay's 2 now
});

test("verdicts given before an interruption are not asked again", async () => {
  const agent = () => new ScriptedAgent([...steps("feed"), ...steps("pay")]);
  const session: SessionFactory = async (_c, snap, _l, body) => body(failing(snap));
  // the second model answers F1, then the run dies (not a model error: the process stops)
  const dying = new FakeJson([{ verdict: "confirmed", reason: "a" }]);
  const orig = dying.completeJson.bind(dying);
  let n = 0;
  dying.completeJson = async (...args: Parameters<typeof orig>) => {
    if (++n === 2) throw new Error("connection reset");
    return orig(...args);
  };
  await expect(runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agent(), challenger: dying,
    sessionFactory: session })).rejects.toThrow("connection reset");
  const judge = new FakeJson([{ verdict: "disputed", reason: "b" }]);
  const { review } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: new ScriptedAgent([]),
    challenger: judge, sessionFactory: session, resume: true });
  // only F2 is judged again (the second call is the grouping step every review ends with)
  expect(judge.calls.filter((c) => c.includes("The failing test:"))).toHaveLength(1);
  expect(judge.calls[0]).toContain("services/pay/");
  expect(review.findings.map((f) => f.verdict)).toEqual(["confirmed", "disputed"]);
});

test("--resume with nothing unfinished says so", async () => {
  await expect(runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: new ScriptedAgent([]), challenger: new FakeJson([]),
    resume: true })).rejects.toThrow("nothing to resume");
});

/** An agent that answers `steps`, then fails every call as a provider that is down. */
function downAfter(steps: ReturnType<typeof text>[][]): ScriptedAgent {
  const agent = new ScriptedAgent(steps);
  const answer = agent.create.bind(agent);
  agent.create = async (x) => {
    if (agent.steps.length) return answer(x);
    agent.calls.push({ system: x.system, tools: x.tools.map((t) => t.name), messages: [...x.messages] });
    const e = new ModelError("HTTP 503");
    e.fault = { kind: "unavailable", detail: "HTTP 503" };
    throw e;
  };
  return agent;
}

test("a review an outage cut resumes: the round it stopped runs again, the finished one is kept", async () => {
  const session: SessionFactory = async (_c, snap, _l, body) => body(failing(snap));
  // feed finishes; the reviewer's provider is down by the time pay starts
  const first = downAfter(steps("feed"));
  const cut = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: first,
    challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }]), sessionFactory: session });
  expect(cut.review.providerFailures?.[0]).toMatchObject({ kind: "unavailable", roles: ["reviewer"] });
  expect(cut.review.projectStats!.map((p) => p.stop)).toEqual(["end_turn", "api_error: HTTP 503"]);
  const diffSha = JSON.parse(readFileSync(join(cut.rdir, "state.json"), "utf8")).diff_sha256 as string;
  expect(resumable(repo, diffSha)).toBe(cut.rdir);
  const second = new ScriptedAgent(steps("pay"));
  const { review } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: second,
    challenger: new FakeJson([{ verdict: "confirmed", reason: "b" }]), sessionFactory: session, resume: true });
  expect(review.id).toBe(cut.review.id);
  expect(second.calls).toHaveLength(2);
  expect(review.findings.map((f) => [f.project, f.verdict])).toEqual([["feed", "confirmed"], ["pay", "confirmed"]]);
  expect(review.providerFailures).toBeUndefined();
  expect(resumable(repo, diffSha)).toBeNull();
});

test("a review that finished is not resumed, nor one whose outage left nothing a resume does again", async () => {
  const session: SessionFactory = async (_c, snap, _l, body) => body(failing(snap));
  const done = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS,
    agentModel: new ScriptedAgent([...steps("feed"), ...steps("pay")]),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "a" }, { verdict: "confirmed", reason: "b" }]),
    sessionFactory: session });
  const diffSha = JSON.parse(readFileSync(join(done.rdir, "state.json"), "utf8")).diff_sha256 as string;
  expect(resumable(repo, diffSha)).toBeNull();
  await expect(runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: new ScriptedAgent([]),
    challenger: new FakeJson([]), resume: true })).rejects.toThrow("nothing to resume");
  // Only the second hunter was down: the rounds finished, and a resume keeps them as they are.
  const file = join(done.rdir, "review.json");
  writeFileSync(file, JSON.stringify({ ...JSON.parse(readFileSync(file, "utf8")), provider_failures: [{
    provider: "other", name: "Other", kind: "unavailable", detail: "HTTP 503", calls: 2, failed: 2, attempts: 8,
    roles: ["second-hunt"], missing: ["second-hunt"] }] }));
  expect(resumable(repo, diffSha)).toBeNull();
});
