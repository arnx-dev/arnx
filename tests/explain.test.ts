import { expect, test } from "bun:test";
import { ModelError } from "../src/errors";
import { explain } from "../src/explain";
import { newUse } from "../src/llm";
import { FakeJson } from "./helpers/fakes";
import { finding } from "./helpers/review";

const f = (i: number) => finding(`F${i}`, `m.test.ts::t${i}`, `t${i}`, "m.test.ts", `expected ${i}`, `why ${i}`, "confirmed", "r");
const group = (ids: string[], title: string, more: Record<string, string> = {}) =>
  ({ findings: ids, title, input: "", actual: "", expected: "", consequence: "", ...more });

test("one call to the second model groups the findings and explains each group in plain language", async () => {
  const model = new FakeJson([{ groups: [group(["F1", "F3"], "prefix length taken from the pattern",
    { input: "GET /users/12345/profile", actual: "/45/profile", expected: "/profile", consequence: "wrong route" }),
  group(["F2"], "regex param")] }], 0.02);
  const use = newUse(model.ref);
  const groups = await explain([f(1), f(2), f(3)], { model, diff: "the diff", sources: { "m.test.ts": "test source" },
    budgetUsd: 1, use });
  expect(groups).toEqual([group(["F1", "F3"], "prefix length taken from the pattern",
    { input: "GET /users/12345/profile", actual: "/45/profile", expected: "/profile", consequence: "wrong route" }),
  group(["F2"], "regex param")]);
  expect(model.calls).toHaveLength(1);
  for (const part of ["the diff", "test source", "F1", "m.test.ts::t1", "expected 1", "why 1", "r"]) {
    expect(model.calls[0]).toContain(part);
  }
  expect([use.calls, use.costUsd]).toEqual([1, 0.02]);
});

test("ids the review does not have are dropped, and a finding is kept in its first group only", async () => {
  const model = new FakeJson([{ groups: [group(["F1", "F9"], "a"), group(["F1", "F2"], "b"), group(["F7"], "c")] }]);
  const groups = await explain([f(1), f(2)], { model, diff: "d", sources: {}, budgetUsd: 1, use: newUse(model.ref) });
  expect(groups).toEqual([group(["F1"], "a"), group(["F2"], "b")]);
});

test("a field over its length ends at a word with an ellipsis, never mid-word", async () => {
  // A 400-character cut used to end "whether the finding is real i".
  const long = "word ".repeat(79) + "whether the finding is real is yours to decide.";
  const model = new FakeJson([{ groups: [group(["F1"], "t", { consequence: long, input: "short" })] }]);
  const [g] = await explain([f(1)], { model, diff: "d", sources: {}, budgetUsd: 1, use: newUse(model.ref) });
  expect(g!.consequence.length).toBeLessThanOrEqual(400);
  expect(g!.consequence.endsWith("…")).toBe(true);
  expect(long.startsWith(g!.consequence.slice(0, -1))).toBe(true);
  expect(long[g!.consequence.length - 1]).toBe(" ");
  expect(g!.input).toBe("short");
});

test("a failed call or no budget leaves the findings ungrouped; a billed failure still counts", async () => {
  const use = newUse("openai:gpt-5.5-2026-04-23");
  const failed = new ModelError("HTTP 500");
  failed.costUsd = 0.01;
  expect(await explain([f(1)], { model: new FakeJson([failed]), diff: "d", sources: {}, budgetUsd: 1, use })).toEqual([]);
  expect(use.costUsd).toBe(0.01);
  const unused = new FakeJson([{ groups: [] }]);
  expect(await explain([f(1)], { model: unused, diff: "d", sources: {}, budgetUsd: 0, use })).toEqual([]);
  expect(unused.calls).toHaveLength(0);
});
