// Batch 2: the report leads with what was and was not tested, explains findings in plain language, groups findings
// that share one cause, labels the second opinion, and records severity with the marks. Report only: finding rules,
// verdicts and exit codes are unchanged.
import { expect, test } from "bun:test";
import { defaultMarks, exitCode, neededQuestions, nextSteps, parseMarks, rankGroups, render, sameCause, summary,
  type SuspectOutcome, yourCall }
  from "../src/report";
import { finding, sampleReview, blankMarks } from "./helpers/review";

const stat = (name: string, over: Record<string, unknown> = {}) => ({ name, tests: 3, passed: 3, missingRuns: 0,
  testFiles: 1, sawResults: true, stop: "end_turn", ...over });

test("the report opens with a status: complete when every project was tested and every run reported", () => {
  const r = sampleReview({ projects: ["api", "web"], projectStats: [stat("api"), stat("web")] });
  const md = render(r);
  expect(md).toContain("## Status\n\nComplete: 2 projects tested (`api`, `web`); every run reported its tests.");
  expect(md.indexOf("## Status")).toBeLessThan(md.indexOf("## Findings"));
  // complete: no status line, the count then the findings first
  expect(summary(r, "review.md").split("\n").slice(1, 3)).toEqual(["1 issue confirmed, 1 disputed (2 findings).",
    "  ✗ 1  Any member can invite.  F1 (main)"]);
});

test("a project that produced no tests is named with the reason, such as an API outage", () => {
  const r = sampleReview({ projects: ["nft", "shared"], stop: "api_error: claude-sonnet-5-5: no reply",
    projectStats: [stat("nft", { tests: 0, passed: 0, testFiles: 0, sawResults: false,
      stop: "api_error: claude-sonnet-5-5: no reply" }), stat("shared")] });
  const md = render(r);
  expect(md).toContain("Incomplete: `nft` produced no tests: the reviewer's model call failed " +
    "(claude-sonnet-5-5: no reply). Run `arnx review` again to cover it.");
  expect(summary(r, "review.md")).toContain("Incomplete: `nft` produced no tests: the reviewer's model call " +
    "failed (claude-sonnet-5-5: no reply).");
});

test("projects over the limit are one line in the status, not one line each", () => {
  const r = sampleReview({ notReviewed: ["a", "b", "c"], uncovered: [{ path: "jsr.json", reason: "no project covers it" }] });
  const md = render(r);
  expect(md).toContain("Not reviewed: 3 more projects this change touches (`a`, `b`, `c`): over the project limit; " +
    "raise max_projects in .arnx/config.toml.");
  expect(md).toContain("Not covered by any project: `jsr.json`.");
  expect(md).not.toContain("project `a`: not reviewed");
  expect(md).not.toContain("## Not tested");
});

test("the second model's view is labelled as a second opinion", () => {
  const md = render(sampleReview());
  expect(md).toContain("### F1 · confirmed by the second opinion");
  expect(md).toContain("### F2 · disputed by the second opinion");
  expect(md).toContain("- Second opinion (openai:gpt-5.5-2026-04-23): No role check.");
  expect(md).not.toContain("- Challenger:");
});

test("findings that share one cause are grouped and explained as input, actual, expected and consequence", () => {
  const r = sampleReview({
    findings: [
      finding("F1", "m.test.ts::param", "param", "m.test.ts", "expected '/45/profile' to be '/profile'", "", "confirmed", "r1"),
      finding("F2", "m.test.ts::regex", "regex", "m.test.ts", "expected '/' to be '/foo'", "", "confirmed", "r2"),
      finding("F3", "m.test.ts::wild", "wild", "m.test.ts", "expected '/g/y/z' to be '/z'", "", "disputed", "r3"),
    ],
    groups: [
      { findings: ["F1", "F2"], title: "mount() strips the wrong number of characters when the path has a parameter",
        input: "a request to /users/12345/profile under mount('/users/:id', app)", actual: "the app sees /45/profile",
        expected: "the app sees /profile", consequence: "routes under a parameterised mount get the wrong path" },
      { findings: ["F3"], title: "wildcard in the middle of a mount path", input: "", actual: "", expected: "",
        consequence: "" },
    ],
  });
  const md = render(r);
  expect(md).toContain("2 issues from 3 failing tests, most severe first.");
  expect(md).toContain("### Issue 1 · mount() strips the wrong number of characters when the path has a parameter\n\n" +
    "- Input: a request to /users/12345/profile under mount('/users/:id', app)\n- Actual: the app sees /45/profile\n" +
    "- Expected: the app sees /profile\n- Why it matters: routes under a parameterised mount get the wrong path\n" +
    "- Failing tests: F1, F2\n\nMark: [x] real  [ ] intended  [ ] noise  [ ] rewrite  (both tests)\n");
  expect(md).not.toContain("- Input: \n"); // empty fields are left out
  // one Mark line per issue covers its findings: a proven issue comes marked real, the others unmarked
  expect(md.match(/^Mark:/gm)).toHaveLength(2);
  expect(parseMarks(md, ["F1", "F2", "F3"]).findings).toEqual({ F1: "real", F2: "real", F3: null });
  expect(parseMarks(blankMarks(md), ["F1", "F2", "F3"]).findings).toEqual({ F1: null, F2: null, F3: null });
  expect(md.indexOf("### Issue 1")).toBeLessThan(md.indexOf("### F1"));
  expect(md.indexOf("### F2")).toBeLessThan(md.indexOf("### Issue 2"));
  expect(exitCode(r)).toBe(1); // exit code still counts findings, not issues
  const s = summary(r, "review.md");
  expect(s).toContain("  ✗ 1  mount() strips the wrong number of characters when the path has a parameter  F1, F2");
  expect(s).toContain("  · 2  wildcard in the middle of a mount path                                       F3 disputed");
  expect(s).toContain("Your call: issue 2 (disputed).");
});

test("an issue's one mark covers its disputed tests and those that assumed an answer; its question becomes optional",
  () => {
  const r = sampleReview({
    findings: [finding("F1", "t.js::a", "a", "t.js", "500", "", "confirmed", "yes"),
      { ...finding("F2", "t.js::b", "b", "t.js", "500", "", "disputed", "mock"), dependsOn: null },
      { ...finding("F3", "t.js::c", "c", "t.js", "500", "", "confirmed", "yes"), dependsOn: "Q1" },
      { ...finding("F4", "t.js::d", "d", "t.js", "x", "", "confirmed", "yes"), dependsOn: "Q2" }],
    questions: ["400 or 500?", "Should d hold?"], questionProjects: ["main", "main"], flaky: [],
    groups: [
      { findings: ["F4"], title: "debug log left in", input: "", actual: "", expected: "", consequence: "",
        severity: "low" },
      { findings: ["F1", "F2", "F3"], title: "errors become 500", input: "", actual: "", expected: "", consequence: "",
        severity: "high" }],
  });
  r.groups = rankGroups(r.groups);
  const md = render(r);
  expect(md).toContain("- F3 assumed an answer to Q1; this issue's mark covers them.");
  expect(md).toContain("- The second opinion disputed F2; this issue's mark covers them.");
  expect(md).toContain("Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite  (all 3 tests)");
  // most severe first; the low one under its own heading
  expect(md.indexOf("### Issue 1 · errors become 500")).toBeLessThan(md.indexOf("## Also found (minor)"));
  expect(md.indexOf("## Also found (minor)")).toBeLessThan(md.indexOf("### Issue 2 · debug log left in"));
  expect(parseMarks(md, ["F1", "F2", "F3", "F4"]).findings).toEqual({ F1: "real", F2: "real", F3: "real", F4: null });
  // a Mark line under one test's own heading overrides its issue's
  const one = md.replace("- Test: `t.js::b`", "Mark: [ ] real  [ ] intended  [x] noise\n- Test: `t.js::b`");
  expect(parseMarks(one, ["F1", "F2", "F3", "F4"]).findings.F2).toBe("noise");
  expect([...neededQuestions(r)]).toEqual(["Q2"]);
  expect(md).toContain("400 or 500?\n\nOptional: no issue waits on it.");
  expect(md).not.toContain("Should d hold?\n\nOptional");
  expect(defaultMarks(r)).toEqual({ F1: "real", F2: "real", F3: "real", F4: null });
  const s = summary(r, "review.md");
  expect(s).toContain("  ✗ 1  errors become 500  F1, F2, F3\n  Minor:\n  ? 2  debug log left in  ");
  expect(s).toContain("  ? Q2  Should d hold?\n  1 optional question in review.md (no issue waits on it)");
  expect(s).toContain("Your call: issue 2 (waits on a question), Q2.");
  expect(nextSteps(r)).toEqual(["arnx triage", "arnx accept"]);
  // every issue proven and no question an issue waits on: straight to accept
  const settled = { ...r, findings: r.findings.slice(0, 3), groups: [r.groups[0]!] };
  expect(yourCall(settled)).toBe("The issue comes marked real: nothing to do unless you disagree.");
  expect(nextSteps(settled)).toEqual(["arnx accept"]);
});

test("severity is asked for with each finding and read with the marks", () => {
  const md = render(sampleReview());
  expect(blankMarks(md)).toContain("Mark: [ ] real  [ ] intended  [ ] noise  [ ] rewrite\nSeverity, if real: [ ] high  [ ] medium  [ ] low");
  const marked = blankMarks(md).replace("Mark: [ ] real", "Mark: [x] real").replace("[ ] high", "[x] high");
  const marks = parseMarks(marked, ["F1", "F2"]);
  expect(marks.findings).toEqual({ F1: "real", F2: null });
  expect(marks.severity).toEqual({ F1: "high", F2: null });
  // review.md files written before severity existed still parse
  expect(parseMarks("### F1 · confirmed\n\nMark: [x] noise\n", ["F1"]).severity).toEqual({ F1: null });
});

test("the report lists what the passing tests checked", () => {
  const r = sampleReview({ checked: [{ project: "main", test: "tests/g/test_i.py::test_owner", expects: "owners can invite" },
    { project: "main", test: "tests/g/test_i.py::test_expired", expects: "" }] });
  expect(render(r)).toContain("## What the passing tests checked\n\n" +
    "- `tests/g/test_i.py::test_owner`: owners can invite\n- `tests/g/test_i.py::test_expired`");
});

test("in a review written before per-project stops, a project with no tests is put down to the review's stop", () => {
  const legacy = { name: "nft", tests: 0, passed: 0, missingRuns: 0, testFiles: 0, sawResults: false };
  const r = sampleReview({ projects: ["nft", "shared"], stop: "api_error: no reply",
    projectStats: [legacy, { ...legacy, name: "shared", tests: 2, passed: 2, testFiles: 1, sawResults: true }] });
  expect(render(r)).toContain("Incomplete: `nft` produced no tests: the reviewer's model call failed (no reply).");
  expect(summary(r, "review.md")).toContain("Incomplete: `nft` produced no tests");
  expect(summary(r, "review.md")).not.toContain("Review incomplete:");
});

test("the report names changed files .arnxignore left out", () => {
  expect(render(sampleReview({ ignoredChanged: ["data/dump.csv"] })))
    .toContain("- Changed files left out by .arnxignore (not reviewed): `data/dump.csv`");
  expect(render(sampleReview())).not.toContain("left out by .arnxignore");
});

test("the terminal summary shortens a long finding at a word, with an ellipsis", () => {
  const long = "The balance check accepts a negative minimum, which disables the low-balance alert for every operator";
  const text = summary(sampleReview({ findings: [finding("F1", "t.py::t", "t", "t.py", "assert 1 == 2", long, "confirmed", "r")] }),
    "review.md");
  const line = text.split("\n").find((l) => l.includes("The balance"))!;
  expect(line).toContain("The balance check accepts a negative minimum, which disables the low-balance alert for every…");
  expect(line).not.toContain("operator");
});

test("suspects the hunt named but no test reached make the review incomplete (exit 2); questions alone do not", () => {
  const suspect = (id: string, outcome: "not tested" | "not reproduced") => ({ project: "main", id, file: "s.ts",
    line: 1, claim: "c", by: "m", outcome, tests: [] });
  const base = { findings: [], testsWritten: 0, passed: 0, stop: "end_turn", missingRuns: 0, questions: ["Q?"] };
  const untested = sampleReview({ ...base, suspects: [suspect("S1", "not tested"), suspect("S2", "not tested")] });
  expect(exitCode(untested)).toBe(2);
  expect(render(untested)).toContain("Incomplete: the hunt suspected 2 defects (S1, S2), but no test was written " +
    "for any of them. Run `arnx review` again to cover it.");
  expect(summary(untested, "review.md")).toContain("Incomplete: the hunt suspected 2 defects");
  expect(exitCode(sampleReview({ ...base, suspects: [] }))).toBe(0); // nothing suspected: questions only
  expect(exitCode(sampleReview({ ...base }))).toBe(0); // no hunt
  expect(exitCode(sampleReview({ ...base, testsWritten: 2, passed: 2,
    suspects: [suspect("S1", "not reproduced"), suspect("S2", "not tested")] }))).toBe(0); // tests ran
});

test("an arnx cloud review names its tier and what it billed in total; the harness and roles stay out", () => {
  const use = (role: string, costUsd: number) => ({ model: `arnx:medium/h-2026-10-20.1/${role}`, calls: 1,
    input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd, unknownCalls: 0 });
  const md = render(sampleReview({ reviewer: "arnx:medium/h-2026-10-20.1", challenger: "arnx:medium/h-2026-10-20.1",
    promptVersion: "arnx:medium/h-2026-10-20.1", costUsd: 0.89,
    usage: [use("challenge", 0.012), use("explain", 0.001), use("reviewer", 0.76), use("second-hunt", 0.088)] }));
  expect(md).toContain("- Models: arnx cloud medium\n");
  // What arnx cloud charged, its price: "Billed", not the models' cost.
  const r = sampleReview({ reviewer: "arnx:medium/h-2026-10-20.1", costUsd: 0.89 });
  expect(summary(r, "review.md")).toContain(" · $0.89 billed · ");
  expect(summary(sampleReview(), "review.md")).not.toContain("billed");
  expect(md).toContain("- Billed $0.89 by arnx cloud · ");
  expect(md).not.toMatch(/h-2026|harness|reviewer \$|second hunt \$/);
});

test("a suspect proven only by tests grouped under another suspect's cause is 'same cause', not proven", () => {
  const f = (id: string, suspect: string) => ({ ...finding(id, `t.js::${id}`, id, "t.js", "500", "", "confirmed", "y"),
    suspect });
  const findings = [f("F1", "S3"), f("F2", "S3"), f("F3", "S12"), f("F4", "S5"), f("F5", "S9"), f("F6", "S9")];
  const sus: SuspectOutcome[] = ["S3", "S12", "S5", "S9"].map((id) => ({ project: "main", id, file: "a.js", line: 1,
    claim: id, by: "m", outcome: "proven", tests: [], findings: findings.filter((x) => x.suspect === id).map((x) => x.id) }));
  const groups = [{ findings: ["F1", "F2", "F3", "F5"], title: "every 4xx becomes 500", input: "", actual: "",
    expected: "", consequence: "" }, { findings: ["F4"], title: "x", input: "", actual: "", expected: "", consequence: "" },
  { findings: ["F6"], title: "y", input: "", actual: "", expected: "", consequence: "" }];
  sameCause(sus, groups, findings);
  // S12's only test sits in S3's issue; S9 has a test in S3's issue too, but owns another issue: still proven.
  expect(sus.map((x) => [x.id, x.outcome, x.sameAs])).toEqual([["S3", "proven", undefined],
    ["S12", "same cause", "S3"], ["S5", "proven", undefined], ["S9", "proven", undefined]]);
  const md = render(sampleReview({ findings, groups, suspects: sus }));
  expect(md).toContain("proven only together with S3: its tests fail for the same cause (one fix makes both pass)");
  expect(md).toContain("4 suspected · 3 proven · 1 same cause");
});
