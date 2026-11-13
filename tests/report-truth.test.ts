// The report says only what happened: a finding the second opinion never saw is not confirmed, a test that fails before
// the change and passes after it is not always a fix, and what already failed is named, not only counted.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { judgeFix, newNames, vacuousBefore, type Before, type BeforeRun } from "../src/before";
import { adjudicate, CONFIRMED_FAILS, exitCode, findingStatus, load, neededQuestions, nextSteps, render, save, summary, summaryRows, yourCall,
  type SuspectOutcome } from "../src/report";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

const f = (id: string, test: string, verdict: string | null, reason = "") =>
  ({ ...finding(id, `t.py::${test}`, test, "t.py", "assert 1 == 2", `what ${id} says`), verdict, reason });
const CUT = "not challenged: review budget reached";

test("a finding with no verdict is not confirmed: its own mark and count, and the summary says why", () => {
  const r = sampleReview({ findings: [f("F1", "test_a", "confirmed", "real"), f("F2", "test_b", null, CUT)], questions: [],
    questionProjects: [], groups: [{ title: "a", findings: ["F1"], input: "", actual: "", expected: "", consequence: "" },
    { title: "b", findings: ["F2"], input: "", actual: "", expected: "", consequence: "" }] as never });
  expect(summaryRows(r).map((row) => row.mark)).toEqual(["✗", "!"]);
  const text = summary(r, "review.md");
  expect(text).toContain("1 issue worth a look, 1 not checked (2 findings)");
  expect(text).toContain("1 finding was not checked by the second opinion: review budget reached.");
  expect(yourCall(r)).toBe("Your call: issue 2 (not checked).");
  expect(nextSteps(r)).toEqual(["arnx triage", "arnx accept"]);
});

test("a failing test with no verdict still fails the run: nothing says it passed", () => {
  const r = sampleReview({ findings: [f("F1", "test_b", null, CUT)], questions: [], questionProjects: [] });
  expect(summary(r, "review.md")).toContain("1 issue not checked (1 finding)");
  expect(exitCode(r)).toBe(1);
});

test("the cases of one test no one grouped are one row, not an issue each", () => {
  const r = sampleReview({ findings: [f("F1", "test_x[a]", null, CUT), f("F2", "test_x[b]", null, CUT),
    f("F3", "test_y", "disputed", "no")], questions: [], questionProjects: [] });
  expect(summaryRows(r).map((row) => row.ids)).toEqual([["F1", "F2"], ["F3"]]);
});

test("what already failed is named with what it says, so it can be read", () => {
  const old = { ...f("F1", "test_a", null), before: { status: "pre-existing", detail: "fails the same way", runs: [] } };
  const text = summary(sampleReview({ findings: [old as never], questions: [], questionProjects: [] }), "review.md");
  expect(text).toContain("  Already failing before the change:\n  · F1  what F1 says");
});

test("a test that fails before and passes after is reported as that, not as proof of a fix", () => {
  const r = sampleReview({ findings: [], questions: [], questionProjects: [], fixProof: [{ testId: "t.py::test_a", project: "main",
    file: "t.py", beforeStatus: "fixed", beforeRuns: ["failed"], beforeDetail: "d" }] });
  const text = summary(r, "review.md");
  expect(text).toContain("1 test fails before this change and passes with it.");
  expect(text).not.toContain("fixes");
});

test("a test using a field the old code's class does not have shows nothing about that code", () => {
  const t = { testId: "t.py::test_a", fileAttr: "t.py", name: "test_a", outcome: "passed", message: "" };
  const m = 'ValueError: "InvoiceResponse" object has no field "amount"';
  const run: BeforeRun = { results: [{ ...t, outcome: "failed", message: m }], output: "", timedOut: false };
  expect(judgeFix(t, "t.py", [run, run, run]).status).toBe("new-code");
});

const DIFF = ["diff --git a/app.py b/app.py", "--- a/app.py", "+++ b/app.py", "@@ -1 +1,3 @@", "-def pay(x): return x",
  "+from ui import toast", "+def pay(x):", "+    return toast(x)", ""].join("\n");

test("the names a change adds: not in the old file, not language words", () => {
  const names = newNames(DIFF, () => false, () => "def pay(x): return x\nimport ui\n");
  expect([...names].sort()).toEqual(["toast"]);
  expect([...newNames(DIFF, () => false, () => null)]).toContain("toast"); // a new file: all of it is new
  expect([...newNames(DIFF, (n) => n === "app.py", () => null)]).toEqual([]);
});

test("failing the same way says nothing when the test uses what the change adds", () => {
  const same: Before = { status: "pre-existing", detail: "fails the same way", runs: ["failed"], message: "x" };
  const b = vacuousBefore(same, "def test_a():\n    assert toast.called\n", "test_a", new Set(["toast"]));
  expect(b.status).toBe("unknown");
  expect(b.detail).toBe("fails with the same message on the code before the change, but the test uses `toast`, which the change " +
    "adds, so that says nothing about the code before it");
  expect(vacuousBefore(same, "def test_a():\n    assert pay(1)\n", "test_a", new Set(["toast"]))).toBe(same);
  // Another test in the file using it does not count.
  expect(vacuousBefore(same, "def test_a():\n    assert pay(1)\n\ndef test_b():\n    assert toast.called\n", "test_a",
    new Set(["toast"]))).toBe(same);
  const other: Before = { status: "regression", detail: "d", runs: [] };
  expect(vacuousBefore(other, "toast", "test_a", new Set(["toast"]))).toBe(other);
});

// A dispute outranks a question the test also depended on: the second opinion's no is the verdict.
const disputedWithQuestion = () => sampleReview({
  findings: [{ ...f("F1", "test_a", "disputed", "no"), dependsOn: "Q1" }, f("F2", "test_b", "confirmed", "real")],
  questions: ["Round up?"], questionProjects: ["main"],
  groups: [{ title: "a", findings: ["F1"], input: "", actual: "", expected: "", consequence: "" },
    { title: "b", findings: ["F2"], input: "", actual: "", expected: "", consequence: "" }] as never });

test("a disputed finding with a question is disputed in status, row and summary count", () => {
  const r = disputedWithQuestion();
  expect(findingStatus(r.findings[0]!)).toBe("disputed");
  expect(summaryRows(r).map((row) => row.mark)).toEqual(["·", "✗"]);
  expect(summaryRows(r)[0]!.said).not.toContain("depends on");
  expect(summary(r, "review.md")).toContain("1 issue worth a look");
  expect(summary(r, "review.md")).not.toContain("waits on a question");
  const sus: SuspectOutcome[] = [{ id: "S1", project: "main", outcome: "failed" } as never];
  adjudicate(sus, [{ ...r.findings[0]!, suspect: "S1" }]);
  expect(sus[0]!.outcome).toBe("disputed");
});

test("a disputed finding does not make its question needed", () => {
  const r = disputedWithQuestion();
  expect([...neededQuestions(r)]).toEqual([]);
});

test("an optional question says which assumed finding the mark covers", () => {
  const r = sampleReview({
    findings: [f("F1", "test_a", "confirmed", "real"), { ...f("F2", "test_b", "confirmed", "real"), dependsOn: "Q1" }],
    questions: ["Round up?"], questionProjects: ["main"],
    groups: [{ findings: ["F1", "F2"], title: "a", input: "", actual: "", expected: "", consequence: "" }] as never });
  const md = render(r);
  expect(md).toContain("Optional: Issue 1's mark covers F2, which assumed an answer.");
  expect(md).not.toContain("no issue waits on it");
});

test("a disputed finding that had a question says nothing of depending on it", () => {
  const md = render(disputedWithQuestion());
  expect(md).not.toContain("Depends on");
});

test("an optional question names each issue that covers a finding assuming it, and the summary agrees", () => {
  const dep = (id: string, t: string) => ({ ...f(id, t, "confirmed", "real"), dependsOn: "Q1" });
  const g = (title: string, ids: string[]) => ({ findings: ids, title, input: "", actual: "", expected: "", consequence: "" });
  const r = sampleReview({
    findings: [f("F1", "test_a", "confirmed", "r"), dep("F2", "test_b"), f("F3", "test_c", "confirmed", "r"), dep("F4", "test_d")],
    questions: ["Round up?"], questionProjects: ["main"],
    groups: [g("a", ["F1", "F2"]), g("b", ["F3", "F4"])] as never });
  expect(render(r)).toContain("Optional: Issue 1's mark covers F2; Issue 2's mark covers F4, which assumed an answer.");
  expect(summary(r, "review.md")).toContain("in review.md (a proven issue's mark covers the findings that assumed it)");
});

test("an unproven pass has no regression prefix", () => {
  const old = { ...f("F1", "test_a", "confirmed", "real"), before: { status: "unknown", vacuous: "new-name",
    detail: "passes on the code before the change (3 runs), but the test uses `toast`, which the change adds: no proof of a regression",
    runs: ["passed", "passed", "passed"] } };
  const r = sampleReview({ findings: [old as never], questions: [], questionProjects: [],
    groups: [{ title: "a", findings: ["F1"], input: "", actual: "", expected: "", consequence: "" }] as never });
  const text = summary(r, "review.md");
  expect(text).not.toContain("regression");
  expect(text).not.toContain("caused by the change");
  expect(render(r)).not.toContain("regression ·");
});

test("by default a confirmed finding is worth a look and exits 0; with the switch on it fails the run", () => {
  const r = sampleReview({ findings: [f("F1", "test_a", "confirmed", "real")], questions: [], questionProjects: [] });
  expect(CONFIRMED_FAILS).toBe(false);
  expect(exitCode(r)).toBe(0);
  const text = summary(r, "review.md");
  expect(text).toContain("1 issue worth a look (1 finding)");
  expect(text).not.toContain("confirmed");
  expect(exitCode(r, true)).toBe(1);
  expect(summary(r, "review.md", true)).toContain("1 issue confirmed (1 finding)");
  // A finding no second opinion saw still fails the run, either way.
  const unseen = sampleReview({ findings: [f("F1", "test_a", "confirmed", "real"), f("F2", "test_b", null, CUT)], questions: [],
    questionProjects: [] });
  expect(exitCode(unseen)).toBe(1);
  expect(exitCode(unseen, false)).toBe(1);
});

test("review --json: a confirmed finding that does not fail the run is still result findings, exit_code 0", async () => {
  const { reviewJson } = await import("../src/cli");
  const r = sampleReview({ findings: [f("F1", "test_a", "confirmed", "real")], questions: [], questionProjects: [] });
  const [result, code] = reviewJson(r, "m", "j");
  expect([result, code]).toEqual(["findings", 0]);
});

test("review --json result: findings whenever a confirmed finding exists, clean when all are disputed", async () => {
  const { reviewJson } = await import("../src/cli");
  const cut = sampleReview({ findings: [f("F1", "test_a", "confirmed", "real")], questions: [], questionProjects: [], stop: "budget" });
  const [r1, c1] = reviewJson(cut, "m", "j");
  expect([r1, c1]).toEqual(["findings", 2]);
  const disputed = sampleReview({ findings: [f("F1", "test_a", "disputed", "no")], questions: [], questionProjects: [] });
  const [r2, c2] = reviewJson(disputed, "m", "j");
  expect([r2, c2]).toEqual(["clean", 0]);
});

test("a saved review with no source_files does not read Complete", () => {
  const r = sampleReview({ findings: [], passed: 3, sourceFiles: 2 });
  save(r, tmp(), "diff text");
  expect(render(load(tmp()))).toContain("Complete:");
  const file = join(tmp(), "review.json");
  const json = JSON.parse(readFileSync(file, "utf8"));
  delete json.source_files;
  writeFileSync(file, JSON.stringify(json));
  const text = render(load(tmp()));
  expect(text).toContain("Older review: this arnx did not record which files its tests reached.");
  expect(text).not.toContain("Complete");
});
