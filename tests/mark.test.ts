// arnx triage: findings and questions marked in the terminal with tick-boxes, written back into review.md.
import { expect, test } from "bun:test";
import { PLAIN } from "../src/color";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chosenInTriage, recordChosen } from "../src/accept";
import { applyMarks, type Key, markInteractive, parseKeys, terminalKeys } from "../src/mark";
import { parseMarks, render } from "../src/report";
import { finding, sampleReview } from "./helpers/review";

const keys = (ks: Key[]): AsyncIterator<Key> => {
  let i = 0;
  return { async next() { return i < ks.length ? { value: ks[i++]!, done: false } : { value: "quit", done: true }; } };
};
const typed = (s: string): Key[] => [...s].map((c) => (c === " " ? "space" : { char: c }));

test("raw terminal input becomes keys", () => {
  expect(parseKeys("\x1b[A\x1b[B\r a\x7f\x03")).toEqual(["up", "down", "enter", "space", { char: "a" }, "backspace",
    "quit"]);
});

test("marking in the terminal: boxes per finding, severity for real ones, answers typed, saved into review.md", async () => {
  const review = sampleReview(); // F1 confirmed (comes marked real), F2 disputed; Q1
  const md = render(review);
  const screens: string[][] = [];
  const result = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: (l) => screens.push(l),
    keys: keys([
      "enter", "up", "up", "space", "enter", // F1: real (pre-ticked), enter; severity from skip: up twice is medium
      "up", "up", "space", "enter", // F2: the cursor starts on its current choice (unmarked); two up is noise
      ...typed("yes after 7 days"), "enter", // Q1
      "enter", // save
    ]) });
  expect(result).not.toBeNull();
  expect(result!.findings).toEqual({ F1: "real", F2: "noise" });
  expect(result!.severity).toEqual({ F1: "medium", F2: null });
  expect(result!.answers).toEqual({ Q1: "yes after 7 days" });
  expect(screens[0]!.join("\n")).toContain("❯ [x] real: a defect");
  expect(screens[0]!.join("\n")).toContain("(1/3)");
  const saved = applyMarks(md, result!);
  const { chosen, ...marks } = result!;
  expect(parseMarks(saved, ["F1", "F2"])).toEqual(marks);
  expect(chosen).toEqual(["F1", "F2"]);
  expect(saved).toContain("Mark: [ ] real  [ ] intended  [x] noise");
  expect(saved).toContain("Severity, if real: [ ] high  [x] medium  [ ] low");
  expect(saved).toContain("Answer: yes after 7 days");
});

test("quitting without saving changes nothing; going back keeps earlier choices", async () => {
  const review = sampleReview();
  const md = render(review);
  const none = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: () => {},
    keys: keys([{ char: "q" }, { char: "q" }]) });
  expect(none).toBeNull();
  const back = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: () => {},
    keys: keys(["down", "down", "space", "enter", "left", "up", "space", "enter", "right", "right", "enter"]) });
  // F1 noise, back to F1 (the cursor is on noise), one up is intended; F2 and Q1 skipped
  expect(back!.findings).toEqual({ F1: "intended", F2: null });
});

test("an answer already in review.md is replaced as a whole", () => {
  const md = render(sampleReview()).replace("Answer:\n", "Answer: old\nsecond line\n");
  const marks = parseMarks(md, ["F1", "F2"]);
  const out = applyMarks(md, { ...marks, answers: { Q1: "new" } });
  expect(parseMarks(out, ["F1", "F2"]).answers).toEqual({ Q1: "new" });
  expect(out).not.toContain("second line");
});

test("the terminal cursor is hidden while triage reads keys, and shown again once on close", async () => {
  const stdin = Object.assign(new EventEmitter(), { raw: false,
    setRawMode(on: boolean) { this.raw = on; return this; }, resume() { return this; }, pause() { return this; } });
  const written: string[] = [];
  const k = terminalKeys(stdin as never, { write: (s: string) => written.push(s) });
  expect(written).toEqual(["\x1b[?25l"]);
  stdin.emit("data", Buffer.from("\r"));
  expect((await k.next()).value).toBe("enter");
  k.close();
  k.close();
  expect(written).toEqual(["\x1b[?25l", "\x1b[?25h"]);
  expect(stdin.raw).toBe(false);
});

test("triage reports which findings the owner chose a mark for, including a pre-filled mark confirmed", async () => {
  const review = sampleReview(); // F1 confirmed (comes marked real), F2 disputed
  const md = render(review);
  const confirmedOnly = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: () => {},
    keys: keys(["enter", "enter", "right", "right", "enter"]) }); // F1: real kept, no severity; F2, Q1 passed over
  expect(confirmedOnly!.findings).toEqual({ F1: "real", F2: null });
  expect(confirmedOnly!.chosen).toEqual(["F1"]);
  const skipped = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: () => {},
    keys: keys(["right", "up", "up", "space", "enter", "right", "enter"]) }); // F1 passed over; F2 noise
  expect(skipped!.findings).toEqual({ F1: "real", F2: "noise" });
  expect(skipped!.chosen).toEqual(["F2"]);
});

test("the findings chosen in triage are kept beside review.md, added to across sessions", () => {
  const dir = mkdtempSync(join(tmpdir(), "arnx-triage-"));
  try {
    expect(chosenInTriage(dir)).toEqual(new Set());
    recordChosen(dir, ["F2"]);
    recordChosen(dir, ["F1", "F2"]);
    expect(chosenInTriage(dir)).toEqual(new Set(["F1", "F2"]));
    writeFileSync(join(dir, "triage.json"), "not json");
    expect(chosenInTriage(dir)).toEqual(new Set());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("space ticks without moving on; enter moves on with what is ticked, not with the cursor", async () => {
  const review = sampleReview(); // F1 confirmed (comes marked real), F2 disputed; Q1
  const md = render(review);
  const r = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: () => {},
    keys: keys(["down", "enter", // F1: cursor on intended, nothing ticked: enter keeps real, asks severity
      "enter", // severity: nothing ticked, so none
      "down", "down", "enter", // F2: the cursor moves, nothing ticked: stays unmarked
      "enter", // Q1: no answer
      "enter"]) }); // save
  expect(r!.findings).toEqual({ F1: "real", F2: null });
  expect(r!.severity).toEqual({ F1: null, F2: null });
});

test("an issue is marked once in the terminal: its findings take the mark and the severity together", async () => {
  const review = sampleReview({ flaky: [], questions: [], questionProjects: [], findings: [
    finding("F1", "t.js::a", "a", "t.js", "500", "", "confirmed", "yes"),
    finding("F2", "t.js::b", "b", "t.js", "500", "", "disputed", "mock")],
    groups: [{ findings: ["F1", "F2"], title: "errors become 500", input: "", actual: "got 500", expected: "400",
      consequence: "", severity: "high" }] });
  const md = render(review);
  const screens: string[][] = [];
  const result = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: (l) => screens.push(l),
    keys: keys(["enter", "space", "enter", "enter"]) }); // the issue: real (pre-ticked); severity on its estimate; save
  expect(screens[0]!.join("\n")).toContain("errors become 500  (1/1)");
  expect(screens[0]!.join("\n")).toContain("proven · severity high (estimate) · 2 tests: F1, F2");
  expect(result!.findings).toEqual({ F1: "real", F2: "real" });
  expect(result!.severity).toEqual({ F1: "high", F2: "high" });
  expect(result!.chosen).toEqual(["F1", "F2"]);
  const saved = applyMarks(md, result!);
  expect(saved).toContain("Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite  (both tests)\nSeverity, if real: [x] high");
  const { chosen: _c, ...marks } = result!;
  expect(parseMarks(saved, ["F1", "F2"])).toEqual(marks);
});

// --- rewrite: the bug is real, the test is wrong -----------------------------------------------------------------------

test("a Mark line has a fourth box, rewrite; its reason is the Rewrite line after it, wrapped or not", () => {
  const md = render(sampleReview());
  expect(md).toContain("Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite\nSeverity");
  const marked = md.replace("Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite",
    "Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite\nRewrite: check that a member gets 403,\nnot the log text");
  const m = parseMarks(marked, ["F1", "F2"], { reasons: true });
  expect(m.findings).toEqual({ F1: "rewrite", F2: null });
  expect(m.rewrites).toEqual({ F1: "check that a member gets 403, not the log text" });
  expect(m.severity).toEqual({ F1: null, F2: null });
});

test("a review.md with three boxes (before rewrite) reads as before", () => {
  const old = render(sampleReview()).replaceAll("  [ ] rewrite", "")
    .replace("Mark: [ ] real  [ ] intended  [ ] noise\nSeverity", "Mark: [ ] real  [ ] intended  [x] noise\nSeverity");
  expect(old).not.toContain("] rewrite");
  // The first finding comes marked real; the last Mark line (F2) ticked noise.
  expect(parseMarks(old, ["F1", "F2"], { reasons: true })).toEqual({ findings: { F1: "real", F2: "noise" },
    severity: { F1: null, F2: null }, answers: {}, rewrites: {} });
  // Written back, it gains the fourth box and keeps its marks.
  const saved = applyMarks(old, parseMarks(old, ["F1", "F2"]));
  expect(saved).toContain("Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite\n");
  expect(parseMarks(saved, ["F1", "F2"]).findings).toEqual({ F1: "real", F2: "noise" });
});

test("a rewrite mark without its reason is an error only when the reason is needed (accept)", () => {
  const md = render(sampleReview()).replace("Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite",
    "Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite");
  expect(parseMarks(md, ["F1", "F2"]).findings.F1).toBe("rewrite");
  expect(() => parseMarks(md, ["F1", "F2"], { reasons: true })).toThrow("F1: marked rewrite without a reason; add a " +
    "line `Rewrite: <what the test should check>` right after its Mark line");
  // An empty Rewrite line is no reason either.
  expect(() => parseMarks(md.replace("[x] rewrite", "[x] rewrite\nRewrite:"), ["F1", "F2"], { reasons: true }))
    .toThrow(/F1: marked rewrite without a reason/);
});

const grouped = () => sampleReview({ flaky: [], questions: [], questionProjects: [], findings: [
  finding("F1", "t.js::a", "a", "t.js", "500", "", "confirmed", "yes"),
  finding("F2", "t.js::b", "b", "t.js", "500", "", "disputed", "mock")],
  groups: [{ findings: ["F1", "F2"], title: "errors become 500", input: "", actual: "got 500", expected: "400",
    consequence: "", severity: "high" }] });

test("an issue's Rewrite line covers its findings; a finding's own Mark and Rewrite lines override it", () => {
  const md = render(grouped()).replace("Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite  (both tests)",
    "Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite  (both tests)\nRewrite: check the status code");
  expect(parseMarks(md, ["F1", "F2"], { reasons: true }).rewrites).toEqual({ F1: "check the status code",
    F2: "check the status code" });
  const own = md.replace("- Second opinion (openai:gpt-5.5-2026-04-23): mock\n",
    "- Second opinion (openai:gpt-5.5-2026-04-23): mock\n\nMark: [ ] real  [ ] intended  [ ] noise  [x] rewrite\n" +
    "Rewrite: check the body too\n");
  const m = parseMarks(own, ["F1", "F2"], { reasons: true });
  expect(m.findings).toEqual({ F1: "rewrite", F2: "rewrite" });
  expect(m.rewrites).toEqual({ F1: "check the status code", F2: "check the body too" });
  // The issue marked rewrite without a reason names the issue.
  expect(() => parseMarks(md.replace("Rewrite: check the status code\n", ""), ["F1", "F2"], { reasons: true }))
    .toThrow(/^Issue 1: marked rewrite without a reason/);
});

test("applyMarks writes the Rewrite line after a rewrite mark and replaces an old one, wrapped or not", () => {
  const md = render(grouped());
  const marks = parseMarks(md, ["F1", "F2"]);
  const once = applyMarks(md, { ...marks, findings: { F1: "rewrite", F2: "rewrite" },
    rewrites: { F1: "check the status code", F2: "check the status code" } });
  expect(once).toContain("Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite  (both tests)\n" +
    "Rewrite: check the status code\nSeverity, if real:");
  const wrapped = once.replace("Rewrite: check the status code", "Rewrite: check the\nstatus code");
  const twice = applyMarks(wrapped, { ...parseMarks(wrapped, ["F1", "F2"]), rewrites: { F1: "only 400", F2: "only 400" } });
  expect(twice).toContain("[x] rewrite  (both tests)\nRewrite: only 400\nSeverity, if real:");
  expect(twice).not.toContain("status code");
  // Marked real again: the Rewrite line goes.
  const real = applyMarks(twice, { ...parseMarks(twice, ["F1", "F2"]), findings: { F1: "real", F2: "real" } });
  expect(real).not.toContain("\nRewrite:");
  expect(real).toContain("Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite  (both tests)\nSeverity");
});

test("triage: rewrite asks why the test is wrong, typed like an answer, then the severity", async () => {
  const review = sampleReview(); // F1 confirmed (comes marked real), F2 disputed; Q1
  const md = render(review);
  const screens: string[][] = [];
  const result = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: (l) => screens.push(l),
    keys: keys([
      "down", "down", "down", "space", "enter", // F1: rewrite
      ...typed("check the 403"), "enter", // its reason
      "enter", // severity: skip
      "right", "right", "enter"]) }); // F2 and Q1 passed over; save
  expect(screens[0]!.join("\n")).toContain("[ ] rewrite: the bug is real, the test is wrong");
  expect(screens[0]!.join("\n")).toContain("[ ] noise: no bug here, the test is wrong");
  const reason = screens.find((s) => s.join("\n").includes("Why is the test wrong?"))!.join("\n");
  expect(reason).toContain("Rewrite: ▏");
  expect(result!.findings).toEqual({ F1: "rewrite", F2: null });
  expect(result!.rewrites).toEqual({ F1: "check the 403" });
  expect(result!.chosen).toEqual(["F1"]);
  const saved = applyMarks(md, result!);
  expect(saved).toContain("Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite\nRewrite: check the 403\nSeverity");
  expect(parseMarks(saved, ["F1", "F2"], { reasons: true }).rewrites).toEqual({ F1: "check the 403" });
});

test("triage: an empty reason goes back to the marks, where another mark can be chosen", async () => {
  const review = sampleReview();
  const md = render(review);
  const screens: string[][] = [];
  const result = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: (l) => screens.push(l),
    keys: keys([
      "down", "down", "down", "space", "enter", // F1: rewrite
      "space", "backspace", "enter", // a blank reason: back to the marks, the cursor on rewrite
      "up", "space", "enter", // noise instead
      "right", "right", "enter"]) });
  const back = screens.findLastIndex((l) => l.join("\n").includes("Why is the test wrong?")) + 1;
  expect(screens[back]!.join("\n")).toContain("❯ [x] rewrite");
  expect(result!.findings).toEqual({ F1: "noise", F2: null });
  expect(applyMarks(md, result!)).not.toContain("\nRewrite:");
});

test("triage: a rewrite ticked with space asks its reason before moving on or saving; nothing saves without it", async () => {
  const review = sampleReview();
  const md = render(review);
  const screens: string[][] = [];
  // Tick rewrite, try to move on: the reason screen comes up. Leave it empty, finish, and press enter to save:
  // triage goes back to that reason instead of saving; typed, the save goes through and parses as accept reads it.
  const result = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: (l) => screens.push(l),
    keys: keys(["down", "down", "down", "space", "right", "enter", { char: "q" }, "enter",
      ...typed("check the 403"), "enter", "enter", { char: "q" }, "enter"]) });
  expect(screens.filter((s) => s.join("\n").includes("Why is the test wrong?")).length).toBeGreaterThanOrEqual(2);
  expect(result!.rewrites).toEqual({ F1: "check the 403" });
  const saved = applyMarks(md, result!);
  expect(() => parseMarks(saved, ["F1", "F2"], { reasons: true })).not.toThrow();
});
