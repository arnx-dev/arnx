// Questions that ask the same thing in other words become one, before the second opinion links findings to them.
import { expect, test } from "bun:test";
import { ModelError } from "../src/errors";
import { newUse } from "../src/llm";
import { askedTask, mergeTask } from "../src/prompts";
import { mergeBy, mergeQuestions } from "../src/questions";
import { questionTexts } from "../src/report";
import { FakeJson } from "./helpers/fakes";

const [A, B, C, D] = ["Should the config mention JEV?", "Should the cursor be hidden on a pipe?",
  "Should config.toml mention the experimental JEV?", "Should the cursor come back on SIGTERM?"] as const;
const QS: string[] = [A, B, C, D];

test("sets the model names as the same become one question, worded as first asked, and every id is remapped", () => {
  expect(mergeBy(QS, [["Q1", "Q3"]])).toEqual({ questions: [A, B, D], into: [0, 1, 0, 2] });
  // overlapping sets join; the earliest question of the set is kept
  expect(mergeBy(QS, [["Q4", "Q2"], ["Q3", "Q4"]])).toEqual({ questions: [A, B], into: [0, 1, 1, 1] });
});

test("unknown ids, sets of one and malformed entries change nothing", () => {
  const same = mergeBy(QS, [["Q1"], ["Q9", "Q2"], "Q1 Q3", [" q3", "Q0"], null]);
  expect(same).toEqual({ questions: QS, into: [0, 1, 2, 3] });
});

test("one call to the model, its cost counted; the questions are sent with ids", async () => {
  const model = new FakeJson([{ same: [["Q1", "Q3"], ["Q2", "Q4"]] }], 0.003);
  const use = newUse(model.ref);
  const merged = await mergeQuestions(QS, { model, use });
  expect(merged).toEqual({ questions: [A, B], into: [0, 1, 0, 1] });
  expect(model.calls).toHaveLength(1);
  expect(model.calls[0]).toContain(`Q3: ${C}`);
  expect([use.calls, use.costUsd]).toEqual([1, 0.003]);
});

test("one question, no model, or a failed call: every question is kept", async () => {
  const use = newUse("m");
  expect(await mergeQuestions([A], { model: new FakeJson([]), use })).toEqual({ questions: [A], into: [0] });
  expect(await mergeQuestions(QS, { model: null, use })).toEqual({ questions: QS, into: [0, 1, 2, 3] });
  const said: string[] = [];
  const failing = new FakeJson([new ModelError("timed out")]);
  expect(await mergeQuestions(QS, { model: failing, use, progress: (m) => said.push(m) }))
    .toEqual({ questions: QS, into: [0, 1, 2, 3] });
  expect(said[0]).toContain("every question kept");
});

test("a follow-up lists the questions already asked and asks for new ones only", () => {
  const replies = [JSON.stringify({ questions: [A] }),
    JSON.stringify({ questions: [{ question: B, tests: ["t.ts::a"] }, A] })];
  expect(questionTexts(replies)).toEqual([A, B]);
  const note = askedTask(questionTexts(replies));
  expect(note).toContain(`The questions you have asked so far:\n- ${A}\n- ${B}\n`);
  expect(note).toContain("list only questions you have not asked yet");
  expect(askedTask([])).toBe("");
  expect(mergeTask(QS)).toContain("one answer would settle both");
});
