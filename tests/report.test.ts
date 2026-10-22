import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ArnxError } from "../src/errors";
import { exitCode, load, MD_WIDTH, parseMarks, parseReport, render, save, summary, wrapMarkdown } from "../src/report";
import { sampleReview, blankMarks } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

test("test_exit_codes", () => {
  expect(exitCode(sampleReview())).toBe(1);
  expect(exitCode(sampleReview({ findings: [] }))).toBe(0);
  expect(exitCode(sampleReview({ findings: [], stop: "budget" }))).toBe(2);
  expect(exitCode(sampleReview({ findings: sampleReview().findings.slice(1) }))).toBe(0);
});

test("test_render_and_parse_marks", () => {
  const md = render(sampleReview());
  expect(md).toContain("### F1 · confirmed");
  expect(blankMarks(md)).toContain("Mark: [ ] real  [ ] intended  [ ] noise");
  expect(md).toContain("### Q1");
  expect(md).toContain("Should invites expire?");
  const edited = blankMarks(md).replace("Mark: [ ] real", "Mark: [x] real").replace("Answer:", "Answer: Yes, after 7 days.");
  const marks = parseMarks(edited, ["F1", "F2"]);
  expect(marks.findings).toEqual({ F1: "real", F2: null });
  expect(marks.answers).toEqual({ Q1: "Yes, after 7 days." });
});

test("test_parse_marks_multiline_answer", () => {
  const md = render(sampleReview()).replace("Answer:\n", "Answer:\nYes.\nAfter 7 days.\n");
  expect(parseMarks(md, ["F1", "F2"]).answers.Q1).toBe("Yes.\nAfter 7 days.");
});

test("test_two_boxes_refused", () => {
  const md = render(sampleReview()).replace("[x] real  [ ] intended", "[x] real  [X] intended"); // F1 comes marked real
  expect(() => parseMarks(md, ["F1", "F2"])).toThrow(ArnxError);
  expect(() => parseMarks(md, ["F1", "F2"])).toThrow(/F1/);
});

test("test_missing_mark_line_refused", () => {
  const md = render(sampleReview()).split("\n").filter((l) => !l.startsWith("Mark:")).join("\n");
  expect(() => parseMarks(md, ["F1", "F2"])).toThrow(/Mark line/);
});

test("test_save_load", () => {
  const r = sampleReview();
  save(r, tmp(), "diff text");
  expect(load(tmp())).toEqual(r);
  expect(readFileSync(join(tmp(), "change.diff"), "utf8")).toBe("diff text");
  expect(readFileSync(join(tmp(), "review.md"), "utf8")).toBe(wrapMarkdown(render(r)));
});

test("test_summary", () => {
  const s = summary(sampleReview(), ".arnx/reviews/x/review.md");
  for (const part of ["1 issue confirmed, 1 disputed", "  F1\n", "F2 disputed", "Q1", "$0.34", "arnx accept"]) expect(s).toContain(part);
});

test("test_parse_report", () => {
  const r = parseReport('{"tests": [{"test": "a::t", "expects": "x"}], "questions": ["q?"]}');
  expect(r.questions).toEqual(["q?"]);
  expect(r.suspected_defects).toEqual([]);
  expect(parseReport("not json")).toEqual({ tests: [], suspected_defects: [], questions: [] });
});

const stats = [
  { name: "nft-service", testFiles: 1, tests: 7, passed: 6, missingRuns: 0, sawResults: true },
  { name: "api-service", testFiles: 1, tests: 0, passed: 0, missingRuns: 3, sawResults: false },
];
const twoProjects = () => sampleReview({ projects: ["nft-service", "api-service"], missingRuns: 3, projectStats: stats,
  notReviewed: ["scripts"] });

test("review.md names each reviewed project and where runs went missing", () => {
  const md = render(twoProjects());
  expect(md).toContain("## Projects");
  expect(md).toContain("- `nft-service`: 7 tests, 6 passing in every run");
  expect(md).toContain("- `api-service`: 1 test file, no run reported its tests (3 runs without a report); " +
    "the reviewer never saw them run");
});

test("the terminal summary says which project had runs without a report", () => {
  const s = summary(twoProjects(), "review.md");
  expect(s).toContain("3 runs without a report (api-service)");
  expect(s).toContain("The reviewer never saw its tests run: api-service");
});

test("project stats survive review.json, and older reviews without them still load", () => {
  const dir = join(tmp(), "r");
  save(twoProjects(), dir, "diff");
  expect(JSON.parse(readFileSync(join(dir, "review.json"), "utf8")).project_stats[1].missing_runs).toBe(3);
  expect(load(dir).projectStats).toEqual(stats);
  const old = join(tmp(), "old");
  save(sampleReview(), old, "diff");
  const json = JSON.parse(readFileSync(join(old, "review.json"), "utf8"));
  delete json.project_stats;
  require("node:fs").writeFileSync(join(old, "review.json"), JSON.stringify(json));
  expect(load(old).projectStats).toEqual([]);
});

test("a finding that assumes the answer to a question waits for it: shown with the question, out of the exit code", () => {
  const [f1, f2] = sampleReview().findings;
  const r = sampleReview({ findings: [{ ...f1!, dependsOn: "Q1" }, f2!] });
  expect(exitCode(r)).toBe(0); // F2 is disputed, F1 waits for Q1
  expect(render(r)).toContain("- Depends on: Q1 (the test assumes one answer; answer Q1 before marking)");
  expect(summary(r, "review.md")).toContain("1 issue waiting on a question, 1 disputed (2 findings).");
  expect(summary(r, "review.md")).toContain("  ? 1  Any member can invite.  F1 depends on Q1");
  const dir = join(tmp(), "d");
  save(r, dir, "diff");
  expect(load(dir).findings[0]!.dependsOn).toBe("Q1");
});

test("the cost line splits the total per model and says a cut-off call it could not price may make it low", () => {
  const usage = [
    { model: "anthropic:claude-sonnet-5-5", calls: 9, unknownCalls: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
      costUsd: 0.4012 },
    { model: "openai:gpt-5.5-2026-04-23", calls: 2, unknownCalls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
      costUsd: 0.07 },
  ];
  const r = sampleReview({ costUsd: 0.4712, usage });
  const line = "Cost $0.47 (claude-sonnet-5-5 $0.40 · gpt-5.5-2026-04-23 $0.07; 1 call was cut off mid-reply, so arnx " +
    "could not price what the provider billed for it: the cost shown may be a little low)";
  // The terminal gives the total and a word on the unpriced call; review.md the split per model.
  expect(summary(r, "review.md")).toContain(" · $0.47 (a little more: some calls were cut off mid-reply) · ");
  expect(render(r)).toContain(`- ${line} · `);
  usage[0]!.unknownCalls = 2;
  expect(render(sampleReview({ costUsd: 0.4712, usage }))).toContain("; 3 calls were cut off mid-reply, " +
    "so arnx could not price what the provider billed for them: the cost shown may be a little low)");
  expect(summary(sampleReview(), "review.md")).toContain(" · $0.34 · "); // reviews written before the split
});

test("review.md on disk is wrapped for plain editors; marks and answers still read back", () => {
  const long = "word ".repeat(60).trim();
  const r = sampleReview({ questions: [`Should ${long}?`] });
  r.findings[0]!.explanation = `Because ${long}.`;
  save(r, tmp(), "d");
  const md = readFileSync(join(tmp(), "review.md"), "utf8");
  for (const line of md.split("\n")) {
    if (line.length > MD_WIDTH) expect(line.includes(" ") && !/^(#|\|)/.test(line)).toBe(false);
  }
  expect(md).toContain("- Reviewer: Because word"); // a list item keeps its marker
  expect(md).toMatch(/\n  word word/); // and its continuation lines are indented under it
  const marked = blankMarks(md).replace("Mark: [ ] real", "Mark: [x] real").replace("Answer:", "Answer: yes, keep it");
  expect(parseMarks(marked, r.findings.map((f) => f.id)).answers).toEqual({ Q1: "yes, keep it" });
});

test("wrapping leaves headings, tables, code and unbreakable lines alone", () => {
  const long = "x".repeat(130);
  const md = `# ${"h ".repeat(70)}\n| ${"a ".repeat(70)}|\n    ${"c ".repeat(70)}\n${long}\n`;
  expect(wrapMarkdown(md)).toBe(md);
});

test("wrapping never breaks inside a code span", () => {
  const line = `- Test: ${"word ".repeat(15)}\`tests/x.py::test_kind[ edge]\` and more words after it`;
  const out = wrapMarkdown(line, 60);
  expect(out).toContain("`tests/x.py::test_kind[ edge]`");
  expect(out.split("\n").every((l) => l.length <= 60 || !l.trim().includes(" "))).toBe(false === false);
});

test("terminal colours: marks and status coloured on a terminal, plain otherwise", async () => {
  const { colorFor, colorLines, paint } = await import("../src/color");
  expect(colorFor({ isTTY: true }, {})).toBe(true);
  expect(colorFor({ isTTY: true }, { NO_COLOR: "" })).toBe(false);
  expect(colorFor({ isTTY: false }, { FORCE_COLOR: "1" })).toBe(true);
  expect(colorFor({ isTTY: false }, {})).toBe(false);
  const text = "Status: complete.\n  ✗ F1 confirmed\n  ? Q1 x\n  · F2 disputed";
  expect(colorLines(text, paint(false))).toBe(text);
  const on = colorLines(text, paint(true));
  expect(on).toContain("\x1b[31m✗\x1b[0m");
  expect(on).toContain("\x1b[33m?\x1b[0m");
  expect(on).toContain("\x1b[32mStatus: complete.\x1b[0m");
});

test("confirmed findings come marked real; disputed and question-bound ones do not", () => {
  const r = sampleReview();
  r.findings.push({ ...r.findings[0]!, id: "F3", dependsOn: "Q1" });
  const marks = parseMarks(render(r), ["F1", "F2", "F3"]).findings;
  expect(marks).toEqual({ F1: "real", F2: null, F3: null });
});

test("review.json carries schema_version, each finding's status and the exit code; load drops them", () => {
  const f = sampleReview().findings;
  const r = sampleReview({ findings: [f[0]!, f[1]!, { ...f[0]!, id: "F3", dependsOn: "Q1" },
    { ...f[0]!, id: "F4", verdict: null },
    { ...f[0]!, id: "F5", before: { status: "pre-existing", detail: "fails the same way", runs: [] } }] });
  save(r, tmp(), "");
  const json = JSON.parse(readFileSync(join(tmp(), "review.json"), "utf8"));
  expect(json.schema_version).toBe(1);
  expect(json.exit_code).toBe(1);
  expect(json.findings.map((x: { id: string; status: string }) => [x.id, x.status])).toEqual([["F1", "confirmed"],
    ["F2", "disputed"], ["F3", "waiting-on-answer"], ["F4", "confirmed"], ["F5", "pre-existing"]]);
  expect(load(tmp())).toEqual(r);
  save(sampleReview({ findings: [] }), tmp(), "");
  expect(JSON.parse(readFileSync(join(tmp(), "review.json"), "utf8")).exit_code).toBe(0);
});
