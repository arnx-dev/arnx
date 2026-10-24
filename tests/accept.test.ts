import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AnswerOutcome, accept, findReview, precisionOf } from "../src/accept";
import { python } from "../src/adapters/python";
import { ArnxError } from "../src/errors";
import { save } from "../src/report";
import { dockerSteps } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { gitRepo } from "./helpers/gitutil";
import { finding, sampleReview, blankMarks } from "./helpers/review";
import { useTmp } from "./helpers/tmp";
import { golden } from "./helpers/golden";

const WD = "tests/arnx_generated";
const SRC = golden("add-skip-src.py");
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-11T00:00:00Z" };
const tmp = useTmp();

test("test_add_skip", () => {
  const out = python.skip(SRC, new Set(["test_neg", "test_zero"]), "arnx: not confirmed");
  expect(out.split("\n")[1]).toBe("from __future__ import annotations");
  expect(out.split("\n")[2]).toBe("import pytest");
  expect(out).toContain("    @pytest.mark.skip(reason='arnx: not confirmed')\n    @staticmethod\n    def test_neg");
  expect(out).toContain("@pytest.mark.skip(reason='arnx: not confirmed')\ndef test_zero");
  expect(out).not.toContain("skip(reason='arnx: not confirmed')\ndef test_add");
  expect(out).toBe(golden("add-skip.py")); // Python's ast-based output, byte for byte
  expect(python.skip(SRC, new Set(), "r")).toBe(SRC);
});

function savedReview(repo: string, rid = "20261011-a1b2c3"): string {
  const rdir = join(repo, ".arnx", "reviews", rid);
  save(sampleReview({ id: rid, change: "uncommitted (base 1a2b3c4)", filesChanged: 1, added: 1, removed: 1,
    reviewer: "r", challenger: "c", promptVersion: "v",
    findings: [finding("F1", `${WD}/test_add.py::test_add`, "test_add", `${WD}/test_add.py`, "assert -1 == 5",
      "add subtracts", "confirmed", "yes"),
    finding("F2", `${WD}/test_add.py::TestMore::test_neg`, "test_neg", `${WD}/test_add.py`, "assert -2 == 0", "?",
      "disputed", "no")],
    questions: ["Should add accept strings?", "Should add be commutative?"], flaky: [`${WD}/test_add.py::test_zero`],
    errors: [], passed: 0, testsWritten: 3, missingRuns: 0, notSent: [], costUsd: 0.3, seconds: 10, stop: "end_turn",
    writeDir: WD }), rdir, "diff --git a/app.py b/app.py\n");
  mkdirSync(join(rdir, "tests", WD), { recursive: true });
  writeFileSync(join(rdir, "tests", WD, "test_add.py"), SRC);
  writeFileSync(join(rdir, "tests", WD, "conftest.py"), "import pytest\n");
  return rdir;
}

const BOXES: Record<string, string> = { none: "[ ] real  [ ] intended  [ ] noise", real: "[x] real  [ ] intended  [ ] noise",
  noise: "[ ] real  [ ] intended  [x] noise", intended: "[ ] real  [x] intended  [ ] noise" };

function mark(rdir: string, f1: string | null, f2: string | null, answer?: string): void {
  let md = readFileSync(join(rdir, "review.md"), "utf8");
  const parts = blankMarks(md).split("Mark: [ ] real  [ ] intended  [ ] noise");
  md = parts[0] + "Mark: " + BOXES[f1 ?? "none"] + parts[1] + "Mark: " + BOXES[f2 ?? "none"] + parts[2];
  if (answer) md = md.replace("Answer:", `Answer: ${answer}`);
  writeFileSync(join(rdir, "review.md"), md);
}

test("test_accept_copies_real_tests_marks_their_bugs_and_removes_the_rest", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  mark(rdir, "real", "noise");
  const result = await accept(repo, rdir, SETTINGS);
  const dest = join(repo, "tests", "arnx", "r20261011_a1b2c3");
  const testFile = join(dest, "test_add_subtracts.py");
  expect(readdirSync(dest).sort()).toEqual(["conftest.py", "test_add_subtracts.py"]);
  // The confirmed bug's test is expected to fail, so the project's own run stays green; the noise (F2) and the flaky
  // test are not in the repository at all (they stay in the review), and neither is the class F2's test left empty.
  expect(readFileSync(testFile, "utf8")).toBe('"""Generated."""\nfrom __future__ import annotations\nimport pytest\n\n' +
    "from app import add\n\n\n@pytest.mark.xfail(strict=True, reason='arnx review 20261011-a1b2c3: F1 not fixed yet')\n" +
    "def test_add():\n    assert add(2, 3) == 5\n");
  const lines = readFileSync(join(repo, ".arnx", "precision.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => [l.item, l.mark ?? null])).toEqual([["F1", "real"], ["F2", "noise"], ["Q1", null], ["Q2", null]]);
  expect(lines[0].verdict).toBe("confirmed");
  expect(lines[2].answered).toBe(false);
  expect(result.kept).toEqual([join(dest, "conftest.py"), testFile]);
  await expect(accept(repo, rdir, SETTINGS)).rejects.toThrow(/--again/);
});

test("test_nothing_real_copies_nothing", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  mark(rdir, "intended", null);
  const result = await accept(repo, rdir, SETTINGS);
  expect(result.kept).toEqual([]);
  expect(existsSync(join(repo, "tests", "arnx"))).toBe(false);
});

test("test_answers_become_tests", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  mark(rdir, null, null, "No, numbers only.");
  const seen: string[][] = [];
  const runner = async (qid: string, question: string, answer: string, diff: string): Promise<AnswerOutcome> => {
    seen.push([qid, question, answer, diff]);
    const file = `${WD}/answers/test_strings.py`;
    // As the answer runner returns them: kept, the tests that pass and those the code disagrees with; skip, flaky ones.
    return { qid, files: { [file]: "def test_rejects_strings():\n    pass\n\ndef test_other():\n    pass\n\n" +
      "def test_flaky():\n    pass\n" }, keep: { [file]: new Set(["test_rejects_strings", "test_other"]) },
      skip: { [file]: new Set(["test_flaky"]) }, disagree: [`${file}::test_other`], costUsd: 0.2, stop: "end_turn",
      base: `${WD}/answers` };
  };
  const result = await accept(repo, rdir, SETTINGS, { answerRunner: runner });
  expect(seen).toEqual([["Q1", "Should add accept strings?", "No, numbers only.", "diff --git a/app.py b/app.py\n"]]);
  const kept = join(repo, "tests", "arnx", "r20261011_a1b2c3", "answers", "test_strings.py");
  expect(existsSync(kept)).toBe(true);
  expect(readFileSync(kept, "utf8")).toBe("import pytest\ndef test_rejects_strings():\n    pass\n\n" +
    "@pytest.mark.xfail(strict=True, reason='arnx review 20261011-a1b2c3: Q1 not done yet')\ndef test_other():\n    pass\n");
  expect(result.answers[0]!.disagree).toEqual([`${WD}/answers/test_strings.py::test_other`]);
});

test("answer rounds show an image build in accept's progress", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  mark(rdir, null, null, "No, numbers only.");
  const said: string[] = [];
  const runner = async (qid: string): Promise<AnswerOutcome> => {
    dockerSteps.say?.("main: building its test image (minutes on a first build)");
    return { qid, files: {}, keep: {}, skip: {}, disagree: [], costUsd: 0, stop: "end_turn", base: `${WD}/answers` };
  };
  await accept(repo, rdir, SETTINGS, { answerRunner: runner, progress: (m) => said.push(m) });
  expect(said).toContain("main: building its test image (minutes on a first build)");
  expect(dockerSteps.say).toBeNull();
});

test("test_find_review", () => {
  const repo = gitRepo(tmp());
  expect(() => findReview(repo, null)).toThrow(/arnx review/);
  const old = savedReview(repo, "20261011-ffffff");
  const recent = savedReview(repo, "20261011-000000");
  utimesSync(join(old, "review.json"), 1, 1);
  expect(findReview(repo, null)).toBe(recent);
  expect(findReview(repo, "20261011-ffffff")).toBe(old);
  expect(() => findReview(repo, "nope")).toThrow(ArnxError);
});

test("accept records the severity ticked with each mark", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  mark(rdir, "real", "noise");
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  writeFileSync(join(rdir, "review.md"), md.replace("Severity, if real: [ ] high  [ ] medium  [ ] low",
    "Severity, if real: [ ] high  [ ] medium  [x] low"));
  await accept(repo, rdir, SETTINGS);
  const lines = readFileSync(join(repo, ".arnx", "precision.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.slice(0, 2).map((l) => [l.item, l.mark, l.severity])).toEqual([["F1", "real", "low"], ["F2", "noise", null]]);
});

const precisionLines = (repo: string) => readFileSync(join(repo, ".arnx", "precision.jsonl"), "utf8").trim().split("\n")
  .map((l) => JSON.parse(l));

test("precision.jsonl says whether each mark was left as it came or chosen by the owner", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  // F1 (confirmed) came marked real and was left; F2 (disputed) came unmarked and was marked noise.
  mark(rdir, "real", "noise");
  await accept(repo, rdir, SETTINGS);
  const lines = precisionLines(repo);
  expect(lines.map((l) => [l.item, l.mark ?? null, l.mark_source ?? null])).toEqual([["F1", "real", "default"],
    ["F2", "noise", "chosen"], ["Q1", null, null], ["Q2", null, null]]);
});

test("a pre-filled mark changed by hand is chosen; an unmarked finding left unmarked is a default", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  mark(rdir, "noise", null);
  await accept(repo, rdir, SETTINGS);
  expect(precisionLines(repo).slice(0, 2).map((l) => [l.item, l.mark, l.mark_source]))
    .toEqual([["F1", "noise", "chosen"], ["F2", null, "default"]]);
});

test("a mark confirmed in triage is chosen even when it equals the pre-filled one", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  mark(rdir, "real", null);
  writeFileSync(join(rdir, "triage.json"), JSON.stringify({ chosen: ["F1"] }) + "\n");
  await accept(repo, rdir, SETTINGS);
  expect(precisionLines(repo).slice(0, 2).map((l) => [l.item, l.mark_source])).toEqual([["F1", "chosen"],
    ["F2", "default"]]);
});

test("accepting again keeps older lines of other reviews readable, without a mark source", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  mark(rdir, "real", "noise");
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  const old = JSON.stringify({ review: "20261001-000000", item: "F1", kind: "finding", verdict: "confirmed",
    mark: "real", severity: null, reviewer: "r", challenger: "c", at: "2026-10-01T00:00:00+00:00" });
  writeFileSync(join(repo, ".arnx", "precision.jsonl"), old + "\n");
  await accept(repo, rdir, SETTINGS);
  const lines = precisionLines(repo);
  expect(lines[0]).toEqual(JSON.parse(old));
  expect(lines[0].mark_source).toBeUndefined();
});

const entry = (item: string, mark: string | null, source?: string) => JSON.stringify({ review: "r", item,
  kind: "finding", verdict: "confirmed", mark, ...(source ? { mark_source: source } : {}) });

test("precision counts only chosen marks: real among them, over every review", () => {
  expect(precisionOf([entry("F1", "real", "chosen"), entry("F2", "noise", "chosen"), entry("F3", "intended", "chosen"),
    entry("F4", "real", "chosen")])).toEqual({ real: 2, chosen: 4, defaulted: 0, unknown: 0 });
});

test("pre-filled marks left as they came are not counted, only said how many", () => {
  expect(precisionOf([entry("F1", "real", "default"), entry("F2", "real", "default"), entry("F3", "noise", "chosen")]))
    .toEqual({ real: 0, chosen: 1, defaulted: 2, unknown: 0 });
});

test("lines from before mark_source are unknown: not counted, said apart; unmarked findings and questions count nowhere",
  () => {
    expect(precisionOf([entry("F1", "real"), entry("F2", "noise"), entry("F3", null, "chosen"), entry("F4", null, "default"),
      JSON.stringify({ review: "r", item: "Q1", kind: "question", answered: true }), "not json", "null",
      entry("F5", "real", "chosen")])).toEqual({ real: 1, chosen: 1, defaulted: 0, unknown: 2 });
  });

test("accept reports precision over the whole log, this review's lines included", async () => {
  const repo = gitRepo(tmp());
  const rdir = savedReview(repo);
  // F1 came marked real and was left (default); F2 came unmarked and was marked noise (chosen).
  mark(rdir, "real", "noise");
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(join(repo, ".arnx", "precision.jsonl"), [entry("F1", "real"), entry("F2", "real", "chosen")]
    .map((l) => l.replace('"review":"r"', '"review":"20261001-000000"')).join("\n") + "\n");
  const r = await accept(repo, rdir, SETTINGS);
  expect(r.precision).toEqual({ real: 1, chosen: 2, defaulted: 1, unknown: 1 });
});
