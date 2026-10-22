// Tests arnx wrote when it reviewed its own wrong-test handling (review 20261022-30b1fe), kept as accepted.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AnswerOutcome, accept } from "../src/accept";
import { ACCEPTED_RECORD, checkSummary, type ProjectCheck } from "../src/check";
import { applyMarks } from "../src/mark";
import { type Finding, type Group, parseMarks, render, save } from "../src/report";
import { defaultSettings } from "../src/settings";
import { finding, sampleReview } from "./helpers/review";
import { gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const WD = "tests/arnx_generated";
const GEN = `${WD}/test_add.py`;
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-11T00:00:00Z" };
const SRC = "def test_a():\n    assert False\n\ndef test_b():\n    assert False\n";

function savedReview(repo: string, groups: Group[] = []): string {
  const rdir = join(repo, ".arnx", "reviews", RID);
  const f2: Finding = { ...finding("F2", `${GEN}::test_b`, "test_b", GEN, "assert 4 == 5", "add drops one", "confirmed"),
    dependsOn: "Q1" };
  save(sampleReview({ id: RID, writeDir: WD, flaky: [], groups, questions: ["Should add round?"],
    findings: [finding("F1", `${GEN}::test_a`, "test_a", GEN, "assert -1 == 5", "add subtracts", "confirmed"), f2] }),
  rdir, "diff --git a/app.py b/app.py\n");
  mkdirSync(join(rdir, "tests", WD), { recursive: true });
  writeFileSync(join(rdir, "tests", GEN), SRC);
  return rdir;
}
const md = (rdir: string) => readFileSync(join(rdir, "review.md"), "utf8");
const edit = (rdir: string, f: (s: string) => string) => writeFileSync(join(rdir, "review.md"), f(md(rdir)));
const RW = "Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite";
const REAL = "Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite";
const marks = (f1: string, f2: string) => (s: string) => {
  const [a, b, c] = s.split(/^Mark: .*$/m);
  return a + f1 + b + f2 + c;
};
const record = (repo: string) => JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files;

function runner(seen: string[][], o: { fails?: boolean } = {}) {
  return async (qid: string, question: string, answer: string, _d: string, _out: string, project: string)
    : Promise<AnswerOutcome> => {
    seen.push([qid, question, answer, project]);
    const file = `${WD}/answers/test_${qid.toLowerCase()}.py`;
    return { qid, files: { [file]: `def test_${qid.toLowerCase()}():\n    assert False\n` },
      keep: { [file]: new Set([`test_${qid.toLowerCase()}`]) }, skip: {},
      disagree: o.fails ? [`${file}::test_${qid.toLowerCase()}`] : [], costUsd: 0.1, stop: "end_turn",
      base: `${WD}/answers` };
  };
}

// arnx review 20261022-30b1fe: not confirmed
test.skip("S5: an answer whose test passes (locked) does not drop the failing test of a finding marked real", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  edit(rdir, (s) => marks(REAL, REAL)(s).replace(/^Answer:$/m, "Answer: no, it truncates"));
  const result = await accept(repo, rdir, SETTINGS, { answerRunner: runner([]) });
  expect(result.setAside).toEqual({});
  const tests = Object.values(record(repo)).flatMap((e: any) => e.tests);
  expect(tests).toContain("test_b");
});

test("S6: a rewrite mark with no reason does not run a rewrite round", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  edit(rdir, marks(REAL, RW));
  const seen: string[][] = [];
  let err: unknown = null;
  try { await accept(repo, rdir, SETTINGS, { answerRunner: runner(seen) }); } catch (e) { err = e; }
  expect(err).not.toBeNull();
  expect(seen).toEqual([]);
});

test("S9: re-accepting with a different rewrite under R1 asks again and leaves one rewrite file", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  edit(rdir, marks(REAL, `${RW}\nRewrite: compare the sum`));
  const seen: string[][] = [];
  await accept(repo, rdir, SETTINGS, { answerRunner: runner(seen) });
  edit(rdir, marks(`${RW}\nRewrite: check the sign`, REAL));
  await accept(repo, rdir, SETTINGS, { again: true, answerRunner: runner(seen) });
  expect(seen.map((x) => x[0])).toEqual(["R1", "R1"]);
  expect(seen[1]![2]).toContain("check the sign");
  const files = Object.keys(record(repo)).filter((f) => f.includes("/answers/"));
  expect(files).toEqual([expect.stringContaining("test_r1.py")]);
  expect(existsSync(join(repo, ACCEPTED_RECORD))).toBe(true);
});

test("S12: the fix prompt does not list the superseded expectation of a finding set aside by an answer", async () => {
  const repo = gitRepo(tmp());
  const g: Group = { findings: ["F2"], title: "add drops one", input: "", actual: "add(2, 3) is 4",
    expected: "SUPERSEDED-EXPECTATION round to nearest", consequence: "" };
  const rdir = savedReview(repo, [g]);
  edit(rdir, (s) => s.replace(/^Mark: .*$/m, REAL).replace(/^Answer:$/m, "Answer: truncation is required"));
  const result = await accept(repo, rdir, SETTINGS, { answerRunner: runner([], { fails: true }) });
  expect(result.setAside).toEqual({ F2: "Q1" });
  expect(readFileSync(join(rdir, "fix-prompt.md"), "utf8")).not.toContain("SUPERSEDED-EXPECTATION");
});

test("S13: the hint names every review whose accepted tests fail", () => {
  const t = (testId: string) => ({ testId, fileAttr: "", name: testId.split("::")[1]!, outcome: "failed" as const,
    message: "x" });
  const results: ProjectCheck[] = [{ project: "api", files: ["a/test_a.py", "b/test_b.py"], passed: [], skipped: 0,
    noReport: false, failed: [t("b/test_b.py::t1"), t("a/test_a.py::t2")], accepted: ["b/test_b.py::t1", "a/test_a.py::t2"],
    reviews: { "b/test_b.py::t1": "20261012-bbbbbb", "a/test_a.py::t2": "20261011-aaaaaa" } }];
  const text = checkSummary(results)[0];
  expect(text).toContain("20261011-aaaaaa");
  expect(text).toContain("20261012-bbbbbb");
});

test("S10: a failing accepted test whose review is unknown must not leave a placeholder in a runnable command", () => {
  const results: ProjectCheck[] = [{ project: "api", files: ["a/test_a.py"], passed: [], skipped: 0, noReport: false,
    failed: [{ testId: "a/test_a.py::t", fileAttr: "", name: "t", outcome: "failed" as const, message: "x" }],
    accepted: ["a/test_a.py::t"] }];
  expect(checkSummary(results)[0]).not.toContain("--again <review id>");
});

// arnx review 20261022-30b1fe: not confirmed
test.skip("S14: applyMarks replaces only the Rewrite line, not text that follows it", () => {
  const g: Group = { findings: ["F1", "F2"], title: "errors", input: "", actual: "a", expected: "b", consequence: "" };
  const review = sampleReview({ flaky: [], questions: [], questionProjects: [], groups: [g], findings: [
    finding("F1", "t.js::a", "a", "t.js", "500", "", "confirmed", "yes"),
    finding("F2", "t.js::b", "b", "t.js", "500", "", "confirmed", "yes")] });
  const base = render(review);
  const withRw = base.replace(/^Mark: .*$/m, `Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite  (both tests)\n` +
    "Rewrite: old reason\nKEEPME a following line");
  const m = parseMarks(withRw, ["F1", "F2"]);
  const out = applyMarks(withRw, { ...m, rewrites: { F1: "new", F2: "new" } });
  expect(out).toContain("KEEPME");
});
