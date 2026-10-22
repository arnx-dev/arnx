import { expect, test } from "bun:test";
import { challengeUser } from "../src/prompts";
import { challenge, CONCURRENCY, inPool } from "../src/challenge";
import { ModelError } from "../src/errors";
import { billedError, FallbackJson } from "../src/llm";
import { FakeJson } from "./helpers/fakes";
import { finding } from "./helpers/review";

const f = (i: number) => finding(`F${i}`, `t.py::test_${i}`, `test_${i}`, "app/t.py", "assert 1 == 2", "why");

test("test_verdicts_and_budget", async () => {
  const model = new FakeJson([{ verdict: "confirmed", reason: " real " }, { verdict: "maybe", reason: "?" }], 0.05);
  const findings = [f(1), f(2), f(3)];
  const spent = await challenge(findings, { concurrency: 1, model, diff: "d", sources: { "app/t.py": "def test_1(): ..." },
    budgetUsd: 0.1 });
  expect(spent.costUsd).toBe(0.1);
  expect(spent.calls).toBe(2);
  expect([findings[0]!.verdict, findings[0]!.reason]).toEqual(["confirmed", "real"]);
  expect(findings[1]!.verdict).toBeNull();
  expect(findings[1]!.reason).toContain("unexpected verdict");
  expect(findings[2]!.verdict).toBeNull();
  expect(findings[2]!.reason).toContain("budget");
  expect(model.calls[0]).toContain("def test_1()");
});

test("test_model_error_leaves_finding_unchallenged", async () => {
  const findings = [f(1)];
  await challenge(findings, { model: new FakeJson([new ModelError("HTTP 500")]), diff: "d", sources: {}, budgetUsd: 1 });
  expect(findings[0]!.verdict).toBeNull();
  expect(findings[0]!.reason).toContain("HTTP 500");
});

test("the challenger is shown the review's questions and may say a finding depends on one", async () => {
  const model = new FakeJson([
    { verdict: "confirmed", reason: "r", depends_on: "Q2" },
    { verdict: "confirmed", reason: "r", depends_on: "Q9" }, // not a question in this review
    { verdict: "confirmed", reason: "r", depends_on: "" },
  ]);
  const findings = [f(1), f(2), f(3)];
  await challenge(findings, { model, diff: "d", sources: {}, budgetUsd: 1,
    questions: ["Unrelated?", "Should a negative threshold turn the alert off?"] });
  expect(findings.map((x) => x.dependsOn ?? null)).toEqual(["Q2", null, null]);
  expect(model.calls[0]).toContain("Q2: Should a negative threshold turn the alert off?");
});

test("without questions the challenger prompt is unchanged", async () => {
  const model = new FakeJson([{ verdict: "confirmed", reason: "r" }]);
  await challenge([f(1)], { model, diff: "d", sources: {}, budgetUsd: 1 });
  expect(model.calls[0]).not.toContain("Questions the reviewer asked");
});

test("a challenger call that failed after it was billed counts toward the cost and the budget", async () => {
  const model = new FakeJson([billedError("incomplete response", 0.3, { input: 900, output: 50, cacheRead: 0,
    cacheWrite: 0 }, 1), { verdict: "confirmed", reason: "r" }], 0.05);
  const findings = [f(1), f(2)];
  const spent = await challenge(findings, { concurrency: 1, model, diff: "d", sources: {}, budgetUsd: 0.2 });
  expect(spent).toEqual({ model: "openai:gpt-5.5-2026-04-23", calls: 1, unknownCalls: 1, input: 900, output: 50,
    cacheRead: 0, cacheWrite: 0, costUsd: 0.3 });
  expect(findings[0]!.reason).toContain("incomplete response");
  expect(findings[1]!.reason).toContain("budget"); // 0.3 spent of 0.2: the failed call used the budget
});

test("one timed-out call leaves only its finding unchecked; after two in a row the rest are skipped", async () => {
  const late = () => Object.assign(new ModelError("openai:gpt-5.5: no reply within 300s"), { timedOut: true });
  const model = new FakeJson([late(), { verdict: "confirmed", reason: "r" }, late(), late(),
    { verdict: "confirmed", reason: "never asked" }]);
  const findings = [f(1), f(2), f(3), f(4), f(5)];
  const lines: Record<string, unknown>[] = [];
  await challenge(findings, { concurrency: 1, model, diff: "d", sources: {}, budgetUsd: 1, trace: (l) => lines.push(l) });
  expect(model.calls).toHaveLength(4);
  expect(findings.map((x) => x.verdict)).toEqual([null, "confirmed", null, null, null]);
  expect(findings[4]!.reason).toBe("not challenged: the second model did not reply in time");
  expect(lines.map((l) => [l.finding, l.outcome])).toEqual([["F1", "error"], ["F2", "ok"], ["F3", "error"],
    ["F4", "error"], ["F5", "skipped"]]);
});

test("a non-timeout error between two timeouts resets the run, so the rest are still asked", async () => {
  const late = () => Object.assign(new ModelError("openai:gpt-5.5: no reply within 300s"), { timedOut: true });
  const model = new FakeJson([late(), new ModelError("HTTP 500: boom"), late(), { verdict: "confirmed", reason: "r" }]);
  const findings = [f(1), f(2), f(3), f(4)];
  await challenge(findings, { concurrency: 1, model, diff: "d", sources: {}, budgetUsd: 1 });
  expect(model.calls).toHaveLength(4);
  expect(findings.map((x) => x.verdict)).toEqual([null, null, null, "confirmed"]);
});

test("inPool rejects a limit that is not a positive integer", async () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    await expect(inPool([1], limit, async () => {})).rejects.toThrow(RangeError);
  }
});

test("inPool never runs more than the limit at once and runs every item", async () => {
  let inFlight = 0, most = 0;
  const done: number[] = [];
  await inPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    done.push(n);
  });
  expect(most).toBe(3);
  expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("with questions, a failure that may be a deliberate change waits for the owner's answer", () => {
  const u = challengeUser("d", "t.py", "src", "t.py::test_x", "fail", "e", ["Is dropping the link intended?"]);
  expect(u).toContain("Q1: Is dropping the link intended?");
  expect(u).toContain("do not dispute it: put that question's id in depends_on, so the finding waits for the " +
    "owner's answer.");
});

test("a fallback second opinion answers the findings the first model fails, and the report says which model", async () => {
  const late = Object.assign(new ModelError("myprovider:some-model: no reply within 300s"), { timedOut: true });
  const slow = new FakeJson([{ verdict: "confirmed", reason: "a" }, late], 0.001);
  slow.ref = "myprovider:some-model";
  const gpt = new FakeJson([{ verdict: "disputed", reason: "b" }], 0.02);
  gpt.ref = "openai:gpt-6.1-sol";
  const model = new FallbackJson(slow, gpt);
  const findings = [f(1), f(2)];
  await challenge(findings, { model, diff: "d", sources: {}, budgetUsd: 1 });
  expect(findings.map((x) => [x.verdict, x.judge])).toEqual([["confirmed", undefined],
    ["disputed", "openai:gpt-6.1-sol"]]);
  expect(model.uses.map((u) => [u.model, u.calls, u.costUsd])).toEqual([["myprovider:some-model", 1, 0.001],
    ["openai:gpt-6.1-sol", 1, 0.02]]);
});

test("second opinions run several at once", async () => {
  let inFlight = 0, most = 0;
  const model = new FakeJson([]);
  model.completeJson = async () => {
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return [{ verdict: "confirmed", reason: "r" }, 0.01];
  };
  const findings = Array.from({ length: CONCURRENCY + 4 }, (_, i) => f(i + 1));
  await challenge(findings, { model, diff: "d", sources: {}, budgetUsd: 5 });
  expect(most).toBe(CONCURRENCY);
  expect(findings.every((x) => x.verdict === "confirmed")).toBe(true);
});
