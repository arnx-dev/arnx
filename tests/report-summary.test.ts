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
    "  1 optional question in review.md (a proven issue's mark covers the findings that assumed it)",
    "  1 file left out (review.md)",
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
    "1 issue confirmed, 1 waiting on a question, 1 disputed (5 findings); their tests pass before the change.",
    `  ✗ 1  regression: ${DISCOUNT}  F1, F2`,
    `  ? 2  ${BULK.padEnd(DISCOUNT.length + 12)}  F3 disputed; F4 depends on Q1`,
    `  · 3  ${"assert 0".padEnd(DISCOUNT.length + 12)}  F5 disputed`,
  ]);
});

const stat = (over: Record<string, unknown> = {}) => ({ name: "main", testFiles: 1, tests: 3, passed: 3, missingRuns: 0,
  sawResults: true, stop: "end_turn", ...over }) as never;
const quiet = (over: Partial<Parameters<typeof sampleReview>[0]> = {}) => sampleReview({ findings: [], groups: [],
  flaky: [], errors: [], questions: [], questionProjects: [], notSent: [], filesChanged: 1, passed: 3, testsWritten: 3,
  projectStats: [stat()], ...over });
const said = (r: ReturnType<typeof quiet>) => summary(r, "review.md");

test("with questions but no findings the summary still says no findings", () => {
  const s = said(quiet({ questions: ["Round up?"], questionProjects: ["main"] }));
  expect(s).toContain("\n  No findings.\n");
  expect(s).toContain("? Q1");
});

test("no findings says no test ran when none did, and how many fail before the change when some do", () => {
  expect(said(quiet({ passed: 0, testsWritten: 0, projectStats: [stat({ tests: 0, passed: 0 })] })))
    .toContain("\n  No findings: no test ran.\n");
  const before = { status: "pre-existing" as const, detail: "", runs: [] };
  expect(said(quiet({ findings: [f("F1", { before }), f("F2", { before })] })))
    .toContain("\n  No issue from this change; 2 already failing before it.\n");
});

test("a status line wins: Incomplete and Not tested never come with No findings", () => {
  const out = [
    said(quiet({ stop: "budget" })),
    said(quiet({ projectStats: [stat({ hungFiles: ["t.py"] })] })),
    said(quiet({ projectStats: [stat({ notRunFiles: ["t.py"] })] })),
    said(quiet({ projectStats: [stat({ env: { state: "failed", kind: "build", log: "x.log" } })] })),
    said(quiet({ projectStats: [stat({ noReport: true })] })),
    said(quiet({ missingRuns: 1 })),
    said(quiet({ untested: [{ project: "main", files: ["a.py"], of: 1 }] as never, sourceFiles: 1, passed: 0 })),
    said(quiet({ flaky: ["t.py::test_a"] })),
    said(quiet({ errors: ["t.py::test_a"] })),
    said(quiet({ uncovered: [{ path: "src/a.py", reason: "no project" }] as never })),
    said(quiet({ couldNotRun: [{ test: "t.py::test_a", needs: "a.key" }] as never })),
  ];
  for (const s of out) expect(s).not.toContain("No findings");
  expect(out[0]).toContain("Incomplete");
  expect(out[6]).toContain("Not tested");
});

test("Partly covered keeps No findings: its status line already says nothing is shown for the rest", () => {
  const s = said(quiet({ untested: [{ project: "main", files: ["a.py"], of: 2 }] as never, sourceFiles: 2 }));
  expect(s).toContain("Partly covered");
  expect(s).toContain("\n  No findings.\n");
});
