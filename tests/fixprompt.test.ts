// The fix prompt hands the owner's coding agent the proven bugs, the owner's answers and the rules; arnx does not
// write the fix itself.
import { expect, test } from "bun:test";
import { fixPrompt } from "../src/fixprompt";
import { wrapMarkdown } from "../src/report";
import { defaultSettings } from "../src/settings";
import { finding, sampleReview } from "./helpers/review";

const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-12T00:00:00Z" };

test("the fix prompt lists the bugs marked real, the owner's answers, open questions and the rules", () => {
  const review = sampleReview({ questions: ["Should invites expire?", "Who may invite?"],
    groups: [{ findings: ["F1"], title: "Any member can invite", input: "a member invites", actual: "invited",
      expected: "refused", consequence: "anyone can add people" }] });
  const p = fixPrompt({ review, marks: { findings: { F1: "real", F2: "noise" }, severity: { F1: "high" },
    answers: { Q1: "yes, after 7 days" } },
  answers: [{ qid: "Q1", files: {}, keep: { "app/tests/g/answers/test_expiry.py": new Set(["test_expires"]) },
    skip: {}, disagree: ["tests/g/answers/test_expiry.py::test_expires"], costUsd: 0.1, stop: "end_turn", base: "" }],
  moved: { "app/tests/g/test_i.py": "app/tests/arnx/r1/g/test_1_i.py",
    "app/tests/g/answers/test_expiry.py": "app/tests/arnx/r1/answers/test_1_expiry.py" } }, SETTINGS);
  expect(p).toContain("# Fix the bugs proven by arnx review 20261011-a1b2c3");
  expect(p).toContain("- Change the product code, not the tests. Never edit, skip, delete, weaken or copy the accepted " +
    "tests in `.arnx/tests/`. They are not part of the project's own test run: only `arnx check` runs them.");
  expect(p).toContain("Run `arnx check` after the fixes.");
  expect(p).toContain(["### 1. Any member can invite (F1)", "",
    "- Expected: refused",
    "- Actual: a member invites: invited",
    "- Why it matters: anyone can add people",
    "- Severity (owner): high",
    "- Accepted test, in `app/tests/arnx/r1/g/test_1_i.py`:",
    "  - `test_member` (F1)",
    "  It fails with `Failed: DID NOT RAISE`.", ""].join("\n"));
  expect(p).toContain('  - Owner: "yes, after 7 days"');
  expect(p).toContain("  - Fails now: `app/tests/arnx/r1/answers/test_1_expiry.py::test_expires`");
  expect(p).toContain("## Questions still open (do not decide these)\n\n- Q2: Who may invite?");
  expect(p).toContain("- F2 (noise): Duplicates.");
  expect(p).not.toContain("F2, severity");
});

const RULES = `## Rules

- Change the product code, not the tests. Never edit, skip, delete, weaken or copy the accepted
  tests in \`.arnx/tests/\`. They are not part of the project's own test run: only \`arnx check\` runs
  them.
- Fix the cause. Special-casing a test's exact input is not a fix.
- Fix the behaviour, not the test's view of it. Where an accepted test checks the code's text, only
  that something exists, or relies on a mock that behaves unlike the real service, make the
  behaviour right and say what the test cannot show. Do not shape the code to a mock or to a
  source-text match.
- Where a question below is still open, leave that behaviour as it is and say so.
- Run \`arnx check\` after the fixes. If tests still fail, investigate and fix the underlying issue.
  If you are blocked or unsure (a missing variable or service, unclear expected behaviour), stop and
  report what still fails and why.
- Also run the project's own test suite.
- Finish with a short summary per bug: what was wrong, what you changed, which tests pass, and what
  they do not prove (an upstream API contract, a real service, behaviour no test exercises). Passing
  tests are evidence for what they check, not proof that the bug is gone everywhere.
`;

const D = "tests/arnx/r20261021_5f8937";
const G = "tests/arnx_generated";
/** A review of discount(): F1 and F2 in one file (one problem), F3 and F4 in two files (another), F5 alone, F6 noise. */
function discountPrompt(): string {
  const review = sampleReview({ id: "20261021-5f8937", change: "uncommitted (base 5ba663e)", questions: [],
    findings: [
      finding("F1", `${G}/test_a.py::test_s1_discount_over_100_rejected`, "test_s1_discount_over_100_rejected",
        `${G}/test_a.py`, "Failed: DID NOT RAISE ValueError\ntrace",
        "discount only checks the lower bound. A percent above 100 returns a negative price.", "confirmed"),
      finding("F2", `${G}/test_a.py::test_s2_discount_over_100_rejected_float`,
        "test_s2_discount_over_100_rejected_float", `${G}/test_a.py`, "Failed: DID NOT RAISE ValueError",
        "This is the same defect as S1, using float inputs.", "confirmed"),
      finding("F3", `${G}/test_a.py::test_s3_total_rounds`, "test_s3_total_rounds", `${G}/test_a.py`,
        "assert 10.004 == 10.0", "total() never rounds. The sum keeps float noise.", "confirmed"),
      finding("F4", `${G}/test_b.py::TestCart::test_s4_cart_total_rounds`, "test_s4_cart_total_rounds",
        `${G}/test_b.py`, "assert 3.3000000000000003 == 3.3", "Cart.total adds raw floats.", "confirmed"),
      finding("F5", `${G}/test_b.py::test_s5_empty_cart`, "test_s5_empty_cart", `${G}/test_b.py`,
        "IndexError: list index out of range", "An empty cart crashes checkout. It reads items[0].", "confirmed"),
      finding("F6", `${G}/test_b.py::test_s6_noise`, "test_s6_noise", `${G}/test_b.py`, "assert 1 == 2", "Noise.",
        "confirmed"),
    ],
    groups: [
      { findings: ["F1", "F2"], title: "discount() accepts percentages above 100", input: "discount(100.0, 150)",
        actual: "returns -50.0", expected: "ValueError for a percent outside 0–100 (the docstring says so)",
        consequence: "a wrong (negative) price instead of an error" },
      { findings: ["F3", "F4"], title: "Totals are not rounded to cents", input: "", actual: "10.004",
        expected: "10.0", consequence: "" },
    ] });
  return wrapMarkdown(fixPrompt({ review, marks: { findings: { F1: "real", F2: "real", F3: "real", F4: "real",
    F5: "real", F6: "noise" }, severity: {}, answers: {} }, answers: [],
  moved: { [`${G}/test_a.py`]: `${D}/test_discount.py`, [`${G}/test_b.py`]: `${D}/test_cart.py` } }, SETTINGS));
}

test("the rules: product code not tests, fix the cause, open questions stay, check then stop when blocked", () => {
  expect(discountPrompt()).toContain(RULES);
});

test("a problem whose tests share one file and one failure: the file once, the failure once", () => {
  expect(discountPrompt()).toContain(`### 1. discount() accepts percentages above 100 (F1, F2)

- Expected: ValueError for a percent outside 0–100 (the docstring says so)
- Actual: discount(100.0, 150): returns -50.0
- Likely cause (reviewer): discount only checks the lower bound
- Why it matters: a wrong (negative) price instead of an error
- Accepted tests, in \`${D}/test_discount.py\`:
  - \`test_s1_discount_over_100_rejected\` (F1)
  - \`test_s2_discount_over_100_rejected_float\` (F2)
  Both fail with \`Failed: DID NOT RAISE ValueError\`.
`);
});

test("a problem across two files with differing failures: one block per file, one failure per test", () => {
  expect(discountPrompt()).toContain(`### 2. Totals are not rounded to cents (F3, F4)

- Expected: 10.0
- Actual: 10.004
- Likely cause (reviewer): total() never rounds (F3); Cart.total adds raw floats (F4)
- Accepted tests:
  - in \`${D}/test_discount.py\`:
    - \`test_s3_total_rounds\` (F3) fails with \`assert 10.004 == 10.0\`
  - in \`${D}/test_cart.py\`:
    - \`test_s4_cart_total_rounds\` (F4) fails with \`assert 3.3000000000000003 == 3.3\`
`);
});

test("a finding in no problem gets its own section; its cause is not repeated when it starts the title", () => {
  const p = discountPrompt();
  expect(p).toContain(`### 3. An empty cart crashes checkout. It reads items[0]. (F5)

- Accepted test, in \`${D}/test_cart.py\`:
  - \`test_s5_empty_cart\` (F5)
  It fails with \`IndexError: list index out of range\`.
`);
  expect(p).not.toContain("same defect");
  expect(p).not.toContain("Reviewer:");
  expect(p).toContain("- F6 (noise): Noise.");
});

test("three tests failing the same way: All 3 fail", () => {
  const review = sampleReview({ findings: ["F1", "F2", "F3"].map((id, i) => finding(id, `${G}/t.py::test_${i}`,
    `test_${i}`, `${G}/t.py`, "boom", i ? "Same as F1." : "It breaks.")),
    groups: [{ findings: ["F1", "F2", "F3"], title: "Boom", input: "", actual: "", expected: "", consequence: "" }] });
  const p = fixPrompt({ review, marks: { findings: { F1: "real", F2: "real", F3: "real" }, severity: {}, answers: {} },
    answers: [], moved: {} }, SETTINGS);
  expect(p).toContain("  All 3 fail with `boom`.");
  expect(p).toContain("- Likely cause (reviewer): It breaks\n- Accepted tests, in `tests/arnx_generated/t.py`:");
});

test("no failure text from the runner: the test is listed without an empty 'fails with'", () => {
  const one = (msgs: string[]) => {
    const ids = msgs.map((_, i) => `F${i + 1}`);
    const review = sampleReview({ findings: msgs.map((m, i) => finding(ids[i]!, `${G}/t.py::test_${i}`, `test_${i}`,
      `${G}/t.py`, m, "It breaks.")),
    groups: [{ findings: ids, title: "Boom", input: "", actual: "", expected: "", consequence: "" }] });
    return fixPrompt({ review, marks: { findings: Object.fromEntries(ids.map((id) => [id, "real" as const])),
      severity: {}, answers: {} }, answers: [], moved: {} }, SETTINGS);
  };
  expect(one([""])).toContain("  - `test_0` (F1)\n\n");
  expect(one([""])).not.toContain("fails with");
  const two = one(["", "assert 1 == 2"]);
  expect(two).toContain("  - `test_0` (F1)\n  - `test_1` (F2) fails with `assert 1 == 2`\n");
  expect(one(["", ""])).not.toContain("fail with");
});
