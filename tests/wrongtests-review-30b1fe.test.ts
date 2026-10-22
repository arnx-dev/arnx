// Tests arnx wrote when it reviewed its own wrong-test handling (review 20261022-30b1fe), kept as accepted.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PLAIN } from "../src/color";
import { applyMarks, type Key, markInteractive } from "../src/mark";
import { parseMarks, render, save } from "../src/report";
import { accept } from "../src/accept";
import { defaultSettings } from "../src/settings";
import { VERSION } from "../src/version";
import { finding, sampleReview } from "./helpers/review";
import { gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const keys = (ks: Key[]): AsyncIterator<Key> => {
  let i = 0;
  return { async next() { return i < ks.length ? { value: ks[i++]!, done: false } : { value: "quit", done: true }; } } as never;
};

const grouped = () => sampleReview({ flaky: [], questions: [], questionProjects: [], findings: [
  finding("F1", "t.js::a", "a", "t.js", "500", "", "confirmed", "yes"),
  finding("F2", "t.js::b", "b", "t.js", "500", "", "disputed", "mock")],
  groups: [{ findings: ["F1", "F2"], title: "errors become 500", input: "", actual: "got 500", expected: "400",
    consequence: "", severity: "high" }] });

test("S1/S7: an issue ticked rewrite without a reason is rejected by accept's parse, with the reason error", () => {
  const md = render(grouped()).replace("Mark: [x] real  [ ] intended  [ ] noise  [ ] rewrite  (both tests)",
    "Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite  (both tests)");
  expect(() => parseMarks(md, ["F1", "F2"], { reasons: true })).toThrow(/marked rewrite without a reason/);
  // Failing tests line absent: still must not silently pass as a reasonless rewrite.
  const noMembers = md.replace(/^- Failing tests:.*\n/m, "");
  let m: ReturnType<typeof parseMarks> | undefined;
  try { m = parseMarks(noMembers, ["F1", "F2"], { reasons: true }); } catch { m = undefined; }
  expect(m).toBeUndefined();
});

test("S3: triage cannot save a rewrite mark without a reason that accept then rejects", async () => {
  const review = sampleReview();
  const md = render(review);
  const r = await markInteractive(review, md, { paint: PLAIN, width: 80, draw: () => {},
    keys: keys(["down", "down", "down", "space", "right", "right", "right", "enter"]) });
  if (!r) return;
  const saved = applyMarks(md, r);
  expect(() => parseMarks(saved, ["F1", "F2"], { reasons: true })).not.toThrow();
});

test("S11: VERSION matches package.json", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  expect(pkg.version).toBe(VERSION);
});

const tmp = useTmp();
test("S2: with no answer runner, a rewrite-marked finding's test stays accepted (nothing replaced it)", async () => {
  const RID = "20261011-a1b2c3";
  const WD = "tests/arnx_generated";
  const GEN = `${WD}/test_add.py`;
  const repo = gitRepo(tmp());
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(sampleReview({ id: RID, writeDir: WD, flaky: [], questions: [], questionProjects: [],
    findings: [finding("F1", `${GEN}::test_a`, "test_a", GEN, "assert -1 == 5", "add subtracts", "confirmed")] }),
  rdir, "diff --git a/app.py b/app.py\n");
  mkdirSync(join(rdir, "tests", WD), { recursive: true });
  writeFileSync(join(rdir, "tests", GEN), "def test_a():\n    assert False\n");
  const md = readFileSync(join(rdir, "review.md"), "utf8").replace(/^Mark: .*$/m,
    "Mark: [ ] real  [ ] intended  [ ] noise  [x] rewrite\nRewrite: the expected value is wrong");
  writeFileSync(join(rdir, "review.md"), md);
  const result = await accept(repo, rdir, { ...defaultSettings(), consentAt: "2026-10-11T00:00:00Z" }, {});
  expect(result.setAside).toEqual({});
});
