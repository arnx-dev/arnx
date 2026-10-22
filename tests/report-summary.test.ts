// The review summary: a count of the issues, then one row per issue (numbered, the title, its findings at the
// right), each finding's state said only when it is not confirmed.
import { expect, test } from "bun:test";
import type { Finding } from "../src/report";
import { summary } from "../src/report";
import { finding, sampleReview } from "./helpers/review";

const newCode = { status: "new-code" as const, detail: "", runs: [] };
const f = (id: string, over: Partial<Finding> = {}): Finding =>
  ({ ...finding(id, `t.py::test_${id}`, `test_${id}`, "t.py", "assert 0", "", "confirmed"), before: newCode, ...over });
const DISCOUNT = "discount() accepts percent values above 100 instead of raising ValueError";
const BULK = "bulk_price() applies the 10% discount only above 10 items, not from 10 items on";
const shop = (over: Partial<Parameters<typeof sampleReview>[0]> = {}) => sampleReview({
  id: "20261021-54347c", change: "uncommitted (base 5ba663e)", filesChanged: 1, added: 14, removed: 0,
  findings: [f("F1"), f("F2"), f("F3"), f("F4", { dependsOn: "Q1" })],
  groups: [{ findings: ["F1", "F2"], title: DISCOUNT, input: "", actual: "", expected: "", consequence: "" },
    { findings: ["F3", "F4"], title: BULK, input: "", actual: "", expected: "", consequence: "" }],
  questions: ["Should bulk_price give the discount at exactly 10 items?"], flaky: [], testsWritten: 9, costUsd: 0.04,
  seconds: 64, ...over });

test("the owner's example: a count line, numbered issues, the findings at the right", () => {
  expect(summary(shop(), ".arnx/reviews/20261021-54347c/review.md")).toBe([
    "arnx review 20261021-54347c · uncommitted (base 5ba663e) · 1 file, +14 −0",
    "2 issues confirmed (4 findings); both in new code.",
    `  ✗ 1  ${DISCOUNT.padEnd(BULK.length)}  F1, F2`,
    // F4 assumed an answer to Q1, but F3 proves the issue: its mark covers F4 and Q1 is optional.
    `  ✗ 2  ${BULK}  F3, F4`,
    "  1 optional question in review.md (no issue waits on it)",
    "All 2 issues come marked real: nothing to do unless you disagree.",
    "9 tests · $0.04 · 1m04s · .arnx/reviews/20261021-54347c/review.md",
    "Next: arnx accept",
  ].join("\n"));
});

test("rows not confirmed are counted apart and their findings carry their state", () => {
  const regression = { status: "regression" as const, detail: "", runs: [] };
  const s = summary(shop({ findings: [f("F1", { before: regression }), f("F2", { before: regression }),
    f("F3", { verdict: "disputed" }), f("F4", { dependsOn: "Q1" }), f("F5", { verdict: "disputed" })],
  groups: [{ findings: ["F1", "F2"], title: DISCOUNT, input: "", actual: "", expected: "", consequence: "" },
    { findings: ["F3", "F4"], title: BULK, input: "", actual: "", expected: "", consequence: "" }] }), "m");
  expect(s.split("\n").slice(1, 5)).toEqual([
    "1 issue confirmed, 1 waiting on a question, 1 disputed (5 findings); caused by the change.",
    `  ✗ 1  regression: ${DISCOUNT}  F1, F2`,
    `  ? 2  ${BULK.padEnd(DISCOUNT.length + 12)}  F3 disputed; F4 depends on Q1`,
    `  · 3  ${"assert 0".padEnd(DISCOUNT.length + 12)}  F5 disputed`,
  ]);
});
