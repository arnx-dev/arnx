// Tests arnx wrote when it reviewed its own triage and issue marks (review 20261022-183834), kept as accepted (S6
// reworded: see there).
import { expect, test } from "bun:test";
import { applyMarks, markInteractive, type Key } from "../src/mark";
import { defaultMarks, neededQuestions, nextSteps, parseMarks, render, summary, yourCall } from "../src/report";
import { finding, sampleReview } from "./helpers/review";

const g = (findings: string[], title: string, severity?: "high" | "medium" | "low") =>
  ({ findings, title, input: "", actual: "", expected: "", consequence: "", ...(severity ? { severity } : {}) });
const base = (over: any = {}) => sampleReview({ flaky: [], questions: [], questionProjects: [], findings: [
  finding("F1", "t::a", "a", "t.js", "x", "", "confirmed", "y"),
  finding("F2", "t::b", "b", "t.js", "x", "", "confirmed", "y")], ...over });

test("S1 unsorted groups: high issue not listed under minor", () => {
  const r = base({ groups: [g(["F1"], "lowone", "low"), g(["F2"], "highone", "high")] });
  const md = render(r);
  const minorAt = md.indexOf("## Also found (minor)");
  if (minorAt >= 0) expect(md.indexOf("highone")).toBeLessThan(minorAt);
  const s = summary(r, "x");
  const m = s.indexOf("Minor:");
  if (m >= 0) expect(s.indexOf("highone")).toBeLessThan(m);
});

test("S2 skipping an issue in triage preserves F1 override", async () => {
  const r = base({ groups: [g(["F1", "F2"], "both", "high")] });
  let md = render(r);
  md = md.replace("- Test: `t::a`", "Mark: [ ] real  [ ] intended  [x] noise\n- Test: `t::a`");
  const before = parseMarks(md, ["F1", "F2"]);
  let i = 0;
  const ks: Key[] = ["right", "enter"];
  const res = await markInteractive(r, md, { paint: { dim: (s: string) => s, red: (s: string) => s, yellow: (s: string) => s,
    cyan: (s: string) => s, bold: (s: string) => s, green: (s: string) => s } as any, width: 80, draw: () => {},
    keys: { next: async () => (i < ks.length ? { value: ks[i++]!, done: false } : { value: undefined, done: true }) } as any } as any);
  const saved = applyMarks(md, res!);
  const after = parseMarks(saved, ["F1", "F2"]);
  expect(after.findings.F2).toBe(before.findings.F2);
  expect(after.findings.F1).toBe(before.findings.F1);
});

test("S3 issue Mark placed after Failing tests applies; missing members not silently dropped", () => {
  const r = base({ groups: [g(["F1", "F2"], "both", "high")] });
  const md = render(r);
  const cleared = md.replace(/^Mark: \[x\] real(.*)$/m, "Mark: [ ] real  [ ] intended  [x] noise");
  expect(parseMarks(cleared, ["F1", "F2"]).findings).toEqual({ F1: "noise", F2: "noise" });
});

// arnx review 20261022-183834: not confirmed
test.skip("S4 untouched older grouped review: F2 mark default", () => {
  const r = base({ findings: [finding("F1", "t::a", "a", "t.js", "x", "", "confirmed", "y"),
    finding("F2", "t::b", "b", "t.js", "x", "", "disputed", "m")], groups: [g(["F1", "F2"], "both")] });
  // review.md of pilot.10: F1 real, F2 unmarked
  expect(defaultMarks(r).F2).toBe(null);
});

// S6 as accepted read "### Issue 2" as the ungrouped finding; ranked, that finding is Issue 1 and Issue 2 is the low
// group. What it meant: the ungrouped finding comes before the minor heading.
test("S6 ungrouped singleton not shown as minor (by the finding, not the issue number)", () => {
  const r = base({ groups: [g(["F1"], "lowone", "low")] });
  const md = render(r);
  const minorAt = md.indexOf("## Also found (minor)");
  const f2 = md.indexOf("### F2");
  expect(f2).toBeGreaterThan(-1);
  if (minorAt >= 0) expect(f2).toBeLessThan(minorAt);
});

// arnx review 20261022-183834: not confirmed
test.skip("S7 question no finding references with proven issue", () => {
  const r = base({ questions: ["Is it ok?"], questionProjects: ["main"], groups: [g(["F1", "F2"], "both", "high")] });
  expect(neededQuestions(r).has("Q1")).toBe(true);
  expect(nextSteps(r)).toEqual(["arnx triage", "arnx accept"]);
});

test("S10 yourCall and nextSteps agree with a pre-existing finding", () => {
  const pre = { ...finding("F3", "t::c", "c", "t.js", "x", "", "confirmed", "y"),
    before: { status: "pre-existing", detail: "d", runs: ["failed", "failed", "failed"] } } as any;
  const r = base({ findings: [finding("F1", "t::a", "a", "t.js", "x", "", "confirmed", "y"), pre],
    groups: [g(["F1"], "one", "high")] });
  const nothing = yourCall(r).includes("nothing to do");
  expect(nothing && nextSteps(r).length === 2).toBe(false);
});

test("render/parse: grouped marks round trip and default marks match parse", () => {
  const r = base({ groups: [g(["F1", "F2"], "both", "high")] });
  const md = render(r);
  expect(parseMarks(md, ["F1", "F2"]).findings).toEqual(defaultMarks(r) as any);
});
