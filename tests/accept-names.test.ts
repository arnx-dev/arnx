// Kept test files are named after what they protect, inside a folder that keeps the review id.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept, slugify } from "../src/accept";
import { type Review, save } from "../src/report";
import { defaultSettings } from "../src/settings";
import { gitRepo } from "./helpers/gitutil";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const WD = "tests/arnx_generated";
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-11T00:00:00Z" };
const tmp = useTmp();
const BOXES: Record<string, string> = { none: "[ ] real  [ ] intended  [ ] noise", real: "[x] real  [ ] intended  [ ] noise",
  noise: "[ ] real  [ ] intended  [x] noise", intended: "[ ] real  [x] intended  [ ] noise" };

test("names for kept files: lowercase words joined by _, at most 50 characters, cut at a word", () => {
  expect(slugify("Deeply nested JSON crashes the whole app with an uncaught RecursionError")).toBe(
    "deeply_nested_json_crashes_the_whole_app"); // not "…_with_an"
  expect(slugify("_strip_jsonc silently accepts an unterminated block comment")).toBe(
    "strip_jsonc_silently_accepts_an_unterminated_block");
  expect(slugify("Search skips a match at the cursor; shows a spurious 'wrapped' notice", 30)).toBe(
    "search_skips_a_match");
  expect(slugify("Cancelling isn't résumé-safe")).toBe("cancelling_isnt_resume_safe");
  expect(slugify("test_s1_deep_json_does_not_kill_app")).toBe("s1_deep_json_does_not_kill_app");
  expect(slugify("parsesDeepJSON returns 42")).toBe("parses_deep_json_returns_42");
  expect(slugify("x".repeat(70))).toBe("x".repeat(50));
  expect(slugify("!!! ???")).toBe("");
  expect(slugify("test")).toBe("");
});

/** A review with two generated files: test_add.py holds F1 and F2, test_more.py holds F3. */
function twoFiles(repo: string, over: Partial<Review> = {}): string {
  const rid = "20261011-a1b2c3";
  const rdir = join(repo, ".arnx", "reviews", rid);
  save(sampleReview({ id: rid, writeDir: WD, flaky: [], errors: [], findings: [
    finding("F1", `${WD}/test_add.py::test_add`, "test_add", `${WD}/test_add.py`, "assert -1 == 5",
      "Add subtracts.\nMore detail.", "confirmed", "yes"),
    finding("F2", `${WD}/test_add.py::test_zero`, "test_zero", `${WD}/test_add.py`, "assert 1 == 0", "",
      "confirmed", "yes"),
    finding("F3", `${WD}/test_more.py::test_deep_json`, "test_deep_json", `${WD}/test_more.py`, "RecursionError", "",
      "confirmed", "yes")], ...over }), rdir, "diff --git a/app.py b/app.py\n");
  mkdirSync(join(rdir, "tests", WD), { recursive: true });
  writeFileSync(join(rdir, "tests", WD, "test_add.py"), "def test_add():\n    assert 0\n\ndef test_zero():\n    assert 0\n");
  writeFileSync(join(rdir, "tests", WD, "test_more.py"), "def test_deep_json():\n    assert 0\n");
  return rdir;
}

/** Mark F1, F2, … in this order, each with a Mark line of its own under its heading (which overrides its issue's). */
const marked = (rdir: string, marks: string[]) => {
  let current = "";
  const md = readFileSync(join(rdir, "review.md"), "utf8").split("\n").flatMap((line) => {
    const f = /^### (F\d+)/.exec(line)?.[1];
    if (f) {
      current = f;
      return [line, `Mark: ${BOXES[marks[Number(f.slice(1)) - 1] ?? "none"]}`];
    }
    if (/^### /.test(line)) current = "";
    return current && line.startsWith("Mark:") ? [] : [line];
  });
  writeFileSync(join(rdir, "review.md"), md.join("\n"));
};

test("a kept file is named after its first finding marked real: its problem's title, else its explanation or test name", async () => {
  const repo = gitRepo(tmp());
  const rdir = twoFiles(repo, { groups: [
    { findings: ["F3"], title: "Deep JSON recursion crashes the app", input: "", actual: "", expected: "", consequence: "" },
    { findings: ["F1", "F2"], title: "", input: "", actual: "", expected: "", consequence: "" }] });
  marked(rdir, ["noise", "real", "real"]);
  const result = await accept(repo, rdir, SETTINGS);
  const dest = join(repo, ".arnx", "tests", "tests", "arnx", "r20261011_a1b2c3");
  // test_add.py: F1 is noise, so F2 names it; its group has no title and F2 no explanation: its test's name.
  expect(readdirSync(dest).sort()).toEqual(["test_deep_json_recursion_crashes_the_app.py", "test_zero.py"]);
  expect(result.moved).toEqual({ [`${WD}/test_add.py`]: ".arnx/tests/tests/arnx/r20261011_a1b2c3/test_zero.py",
    [`${WD}/test_more.py`]: ".arnx/tests/tests/arnx/r20261011_a1b2c3/test_deep_json_recursion_crashes_the_app.py" });
  const accepted = JSON.parse(readFileSync(join(rdir, "accepted.json"), "utf8"));
  expect(accepted.moved).toEqual(result.moved);
  expect(readFileSync(join(rdir, "fix-prompt.md"), "utf8")).toContain(
    "- Accepted test, in\n  `.arnx/tests/tests/arnx/r20261011_a1b2c3/test_deep_json_recursion_crashes_the_app.py`:\n" +
    "  - `test_deep_json` (F3)");
});

test("two kept files with one name get _2; so does a name another file in the repository has", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests", "test_add_subtracts.py"), "def test_mine():\n    pass\n");
  const rdir = twoFiles(repo, { groups: [{ findings: ["F1", "F3"], title: "Add subtracts", input: "", actual: "",
    expected: "", consequence: "" }] });
  marked(rdir, ["real", "noise", "real"]);
  await accept(repo, rdir, SETTINGS);
  // pytest imports test files by name: a second test_add_subtracts.py anywhere would clash with the owner's own.
  expect(readdirSync(join(repo, ".arnx", "tests", "tests", "arnx", "r20261011_a1b2c3")).sort()).toEqual(["test_add_subtracts_2.py",
    "test_add_subtracts_3.py"]);
});

test("accepting again names files by the new marks, leaving no copy under a file's old name", async () => {
  const repo = gitRepo(tmp());
  const rdir = twoFiles(repo);
  marked(rdir, ["real", "noise", "real"]);
  await accept(repo, rdir, SETTINGS);
  const dest = join(repo, ".arnx", "tests", "tests", "arnx", "r20261011_a1b2c3");
  expect(readdirSync(dest).sort()).toEqual(["test_add_subtracts.py", "test_deep_json.py"]);
  writeFileSync(join(repo, ".arnx", "tests", "tests", "arnx", "mine.txt"), "x\n");
  marked(rdir, ["noise", "real", "noise"]);
  const again = await accept(repo, rdir, SETTINGS, { again: true });
  // test_add.py is now named after F2; test_more.py is no longer kept, so its earlier copy is removed too: arnx check
  // must not keep running a test the marks dropped.
  expect(readdirSync(dest).sort()).toEqual(["test_zero.py"]);
  expect(again.kept).toEqual([join(dest, "test_zero.py")]);
  expect(existsSync(join(repo, ".arnx", "tests", "tests", "arnx", "mine.txt"))).toBe(true);
});

test("accepting again with nothing real left removes the review's kept files and its emptied folder", async () => {
  const repo = gitRepo(tmp());
  const rdir = twoFiles(repo);
  marked(rdir, ["real", "noise", "real"]);
  await accept(repo, rdir, SETTINGS);
  const dest = join(repo, ".arnx", "tests", "tests", "arnx", "r20261011_a1b2c3");
  expect(readdirSync(dest).length).toBe(2);
  marked(rdir, ["noise", "noise", "noise"]);
  const again = await accept(repo, rdir, SETTINGS, { again: true });
  expect(again.kept).toEqual([]);
  expect(existsSync(dest)).toBe(false);
  expect(existsSync(join(repo, ".arnx", "tests", "tests", "arnx"))).toBe(true); // the accepted-tests folder itself stays
});

test("tests accepted under the old names keep their place: a later review's names do not count them", async () => {
  const repo = gitRepo(tmp());
  const old = join(repo, ".arnx", "tests", "tests", "arnx", "r20261001_000000");
  mkdirSync(old, { recursive: true });
  writeFileSync(join(old, "test_20261001_000000_add.py"), "def test_add():\n    assert 0\n");
  const rdir = twoFiles(repo);
  marked(rdir, ["real", "noise", "noise"]);
  await accept(repo, rdir, SETTINGS);
  expect(existsSync(join(old, "test_20261001_000000_add.py"))).toBe(true);
  expect(readdirSync(join(repo, ".arnx", "tests", "tests", "arnx", "r20261011_a1b2c3"))).toEqual(["test_add_subtracts.py"]);
});

test("a file holding tests of several problems is named after the review; one problem's file keeps its title", async () => {
  const repo = gitRepo(tmp());
  const g = (findings: string[], title: string) => ({ findings, title, input: "", actual: "", expected: "",
    consequence: "" });
  const rdir = twoFiles(repo, { groups: [g(["F2", "F3"], "Zero is not handled"), g(["F1"], "Deep JSON recursion")] });
  marked(rdir, ["real", "real", "real"]);
  const result = await accept(repo, rdir, SETTINGS);
  const dir = ".arnx/tests/tests/arnx/r20261011_a1b2c3";
  // test_add.py holds F1 (Deep JSON recursion) and F2 (Zero is not handled): no one title fits it.
  expect(readdirSync(join(repo, dir)).sort()).toEqual(["test_r20261011_a1b2c3.py", "test_zero_is_not_handled.py"]);
  expect(result.moved).toEqual({ [`${WD}/test_add.py`]: `${dir}/test_r20261011_a1b2c3.py`,
    [`${WD}/test_more.py`]: `${dir}/test_zero_is_not_handled.py` });
  expect(JSON.parse(readFileSync(join(repo, ".arnx", "accepted-tests.json"), "utf8")).files).toContainKey(
    `${dir}/test_r20261011_a1b2c3.py`);
  expect(readFileSync(join(rdir, "fix-prompt.md"), "utf8")).toContain(
    `  - in \`${dir}/test_r20261011_a1b2c3.py\`:\n    - \`test_zero\` (F2)`);
});

test("two files named after the review get _2; a problem's tests marked noise do not count", async () => {
  const repo = gitRepo(tmp());
  const g = (findings: string[], title: string) => ({ findings, title, input: "", actual: "", expected: "",
    consequence: "" });
  const rdir = twoFiles(repo, { groups: [g(["F1"], "Add subtracts"), g(["F2"], "Zero is not handled"),
    g(["F3"], "Deep JSON recursion"), g(["F4"], "Wide JSON")], findings: [
    finding("F1", `${WD}/test_add.py::test_add`, "test_add", `${WD}/test_add.py`, "assert -1 == 5", "", "confirmed"),
    finding("F2", `${WD}/test_add.py::test_zero`, "test_zero", `${WD}/test_add.py`, "assert 1 == 0", "", "confirmed"),
    finding("F3", `${WD}/test_more.py::test_deep_json`, "test_deep_json", `${WD}/test_more.py`, "RecursionError", "",
      "confirmed"),
    finding("F4", `${WD}/test_more.py::test_wide_json`, "test_wide_json", `${WD}/test_more.py`, "MemoryError", "",
      "confirmed")] });
  writeFileSync(join(rdir, "tests", WD, "test_more.py"),
    "def test_deep_json():\n    assert 0\n\ndef test_wide_json():\n    assert 0\n");
  marked(rdir, ["real", "real", "real", "real"]);
  await accept(repo, rdir, SETTINGS);
  expect(readdirSync(join(repo, ".arnx", "tests", "tests", "arnx", "r20261011_a1b2c3")).sort()).toEqual(["test_r20261011_a1b2c3.py",
    "test_r20261011_a1b2c3_2.py"]);
  marked(rdir, ["real", "noise", "real", "real"]);
  await accept(repo, rdir, SETTINGS, { again: true });
  expect(readdirSync(join(repo, ".arnx", "tests", "tests", "arnx", "r20261011_a1b2c3")).sort()).toEqual(["test_add_subtracts.py",
    "test_r20261011_a1b2c3.py"]);
});
