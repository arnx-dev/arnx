// Tests made from the owner's answer to Q1 of review 20261022-30b1fe (a Rewrite: reason's continuation lines).
// The owner's answer: lines directly after a Rewrite: line, up to a blank line or the next Mark or Severity line, are
// the reason continuing. Saving replaces them; text meant to stay goes after a blank line.
import { expect, test } from "bun:test";
import { applyMarks } from "../src/mark";
import { parseMarks } from "../src/report";
import { render } from "../src/report";
import { finding, sampleReview } from "./helpers/review";

const BLANK_MARKS = "Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite";
const WRAPPED = "Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite\nRewrite: check that a member gets 403,\nnot the log text";

test("a line directly after a Rewrite line is the reason continuing, and a save replaces it", () => {
  const md = render(sampleReview()).replace(BLANK_MARKS, WRAPPED);
  const parsed = parseMarks(md, ["F1", "F2"], { reasons: true });
  expect(parsed.rewrites).toEqual({ F1: "check that a member gets 403, not the log text" });
  const saved = applyMarks(md, { ...parsed, rewrites: { F1: "a new reason" } });
  expect(saved).toContain("Rewrite: a new reason");
  expect(saved).not.toContain("not the log text");
});

test("text after a blank line following a Rewrite line is not part of the reason and survives a save", () => {
  const md = render(sampleReview()).replace(BLANK_MARKS,
    "Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite\nRewrite: check that a member gets 403\n\nKept note stays here.");
  const parsed = parseMarks(md, ["F1", "F2"], { reasons: true });
  expect(parsed.rewrites).toEqual({ F1: "check that a member gets 403" });
  const saved = applyMarks(md, { ...parsed, rewrites: { F1: "a new reason" } });
  expect(saved).toContain("Kept note stays here.");
  expect(saved).toContain("Rewrite: a new reason");
});
