// The hunt fixture's whole events.jsonl, pinned: a change in what is traced shows up as a diff of this file.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { EVENTS_FILE, type TraceEvent } from "../src/events";
import { AnthropicJson, PRICES } from "../src/llm";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const NOW = new Date("2026-10-16T12:00:00Z");
const GEN = "tests/arnx_generated/test_x.py";
const GOLDEN = join(import.meta.dir, "fixtures/golden/events-hunt.jsonl");

/** Replace what differs between runs: times, durations, the review id, the temp directory, commit ids, the build. */
function normalise(raw: string, rid: string, root: string): string {
  const zero = new Set(["latency_ms", "secs", "seconds", "run_seconds"]);
  const walk = (v: unknown, key = ""): unknown => {
    if (Array.isArray(v)) return v.map((x) => walk(x));
    if (v && typeof v === "object") {
      return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x, k)]));
    }
    if (zero.has(key) && typeof v === "number") return 0;
    if (key === "at") return "<AT>";
    if (key === "build" || key === "arnx_version" || key === "prompt_version") return `<${key.toUpperCase()}>`;
    if (key === "base" && typeof v === "string") return "<SHA>";
    return v;
  };
  return raw.split("\n").filter(Boolean).map((l) => {
    const e = walk(JSON.parse(l.replaceAll(rid, "<ID>").replaceAll(root, "<TMP>"))) as Record<string, unknown>;
    return JSON.stringify(e).replace(/\(base [0-9a-f]{7,40}\)/g, "(base <SHA>)");
  }).join("\n") + "\n";
}

test("the hunting review's events.jsonl matches the golden and its costs add up", async () => {
  const repo = gitRepo(tmp());
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
  const session: SessionFactory = async (_cfg, snap, _log, body) =>
    body(new FakeSession(snap, () => [junitXml([[GEN, "test_spread_positive", "failed", "assert -0.5 >= 0"],
      [GEN, "test_empty", "passed", ""]]), "1 failed, 1 passed", false]));
  const hunter = JSON.stringify({ suspects: [
    { file: "svc/calc.py", line: 2, claim: "spread is negative", why: "returns -0.5", input: "[1, 3]", expected: "0.5",
      actual: "-0.5" },
    { file: "svc/calc.py", line: 1, claim: "empty input crashes", why: "w", input: "[]", expected: "0",
      actual: "error" }],
    questions: ["Should an empty list count as equal?"] });
  const proved = JSON.stringify({ tests: [
    { test: `${GEN}::test_spread_positive`, expects: "non-negative", suspect: "S1" },
    { test: `${GEN}::test_empty`, expects: "0", suspect: "S3" }], suspected_defects: [], questions: [],
    suspects_not_tested: [{ suspect: "S2", reason: "needs the network" }] });
  const agent = new ScriptedAgent([
    [tool("write_file", { path: `svc/${GEN}`, content: "x" })], // refused during the hunt
    [tool("read_file", { path: "svc/calc.py" })], [text(hunter)],
    [tool("write_file", { path: `svc/${GEN}`,
      content: "import calc\ndef test_spread_positive(): pass\ndef test_empty(): pass\n" })],
    [text(proved)],
    [text(proved)], // asked once about S2 and S4: the reviewer keeps its answer
  ]);
  // Real JSON clients over scripted agents: the same code that traces a JSON call in production.
  const json = (model: string, ...replies: unknown[]) => {
    const agent = new ScriptedAgent(replies.map((r) => [text(JSON.stringify(r))]));
    agent.model = model;
    return new AnthropicJson({ provider: "anthropic", model }, agent, PRICES);
  };
  // the second hunter's call lands at seq 2 because the hunters run concurrently with the reviewer's first turn
  // (if that ordering ever flakes, compare the events sorted by type and content instead)
  const secondHunter = json("claude-haiku-5-5", { suspects: [{ file: "svc/calc.py", line: 2, claim: "dup", why: "",
    input: "", expected: "", actual: "" }, { file: "svc/calc.py", line: 40, claim: "far away", why: "", input: "",
    expected: "", actual: "" }], questions: [] });
  // the challenger answers twice: the verdict, then the grouping call (role explain)
  const challenger = json("claude-opus-5-5", { verdict: "confirmed", reason: "sign" }, { groups: [{ findings: ["F1"],
    title: "spread is negative", input: "[1, 3]", actual: "-0.5", expected: "0.5", consequence: "wrong sign" }] });
  // Off: these goldens pin what a review writes without the before/after check (today's output).
  const settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" };
  const { review, rdir } = await runReview(repo, { settings, agentModel: agent, challenger, secondHunter,
    sessionFactory: session, hunt: true, now: NOW });

  const raw = readFileSync(join(rdir, EVENTS_FILE), "utf8");
  const got = normalise(raw, rdir.split("/").at(-1)!, tmp());
  expect(got).toBe(readFileSync(GOLDEN, "utf8"));

  const calls = raw.split("\n").filter(Boolean).map((l) => JSON.parse(l) as TraceEvent)
    .filter((e) => e.type === "model.call");
  const roles = new Set(calls.map((e) => e.data.role));
  expect(calls.every((e) => e.data.role !== "unknown")).toBe(true);
  for (const r of ["reviewer", "second-hunt", "challenge", "explain"]) expect(roles.has(r)).toBe(true);
  // review.json rounds cost_usd to 4 decimals
  const sum = calls.reduce((s, e) => s + (e.data.cost_usd as number), 0);
  const saved = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as { cost_usd: number };
  expect(Math.abs(sum - saved.cost_usd)).toBeLessThan(1e-4);
  expect(Math.abs(sum - review.costUsd)).toBeLessThan(1e-4);
});
