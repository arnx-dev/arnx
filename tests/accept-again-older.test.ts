import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept } from "../src/accept";
import { changedAccepted } from "../src/check";
import { type Review, save } from "../src/report";
import { defaultSettings } from "../src/settings";
import { gitRepo } from "./helpers/gitutil";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";
const WD = "tests/arnx_generated";
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-11T00:00:00Z" };
const tmp = useTmp();
const BOXES: Record<string, string> = { real: "[x] real  [ ] intended  [ ] noise", noise: "[ ] real  [ ] intended  [x] noise" };
function twoFiles(repo: string): string {
  const rid = "20261011-a1b2c3";
  const rdir = join(repo, ".arnx", "reviews", rid);
  save(sampleReview({ id: rid, writeDir: WD, flaky: [], errors: [], findings: [
    finding("F1", `${WD}/test_add.py::test_add`, "test_add", `${WD}/test_add.py`, "assert -1 == 5", "Add.", "confirmed", "yes"),
    finding("F2", `${WD}/test_add.py::test_zero`, "test_zero", `${WD}/test_add.py`, "assert 1 == 0", "", "confirmed", "yes"),
    finding("F3", `${WD}/test_more.py::test_deep_json`, "test_deep_json", `${WD}/test_more.py`, "RecursionError", "", "confirmed", "yes")] }),
    rdir, "diff --git a/app.py b/app.py\n");
  mkdirSync(join(rdir, "tests", WD), { recursive: true });
  writeFileSync(join(rdir, "tests", WD, "test_add.py"), "def test_add():\n    assert 0\n\ndef test_zero():\n    assert 0\n");
  writeFileSync(join(rdir, "tests", WD, "test_more.py"), "def test_deep_json():\n    assert 0\n");
  return rdir;
}
const marked = (rdir: string, marks: string[]) => {
  let current = "";
  const md = readFileSync(join(rdir, "review.md"), "utf8").split("\n").flatMap((line) => {
    const f = /^### (F\d+)/.exec(line)?.[1];
    if (f) { current = f; return [line, `Mark: ${BOXES[marks[Number(f.slice(1)) - 1]!]}`]; }
    if (/^### /.test(line)) current = "";
    return current && line.startsWith("Mark:") ? [] : [line];
  });
  writeFileSync(join(rdir, "review.md"), md.join("\n"));
};
test("accept --again on an older arnx's accept leaves no orphaned stored file", async () => {
  const repo = gitRepo(tmp());
  const rdir = twoFiles(repo);
  marked(rdir, ["real", "noise", "real"]);
  await accept(repo, rdir, SETTINGS);
  const dest = join(repo, ".arnx", "tests", "tests", "arnx", "r20261011_a1b2c3");
  // Make it look like an older arnx's accept: run names on disk, in the record and in accepted.json.
  for (const n of readdirSync(dest)) renameSync(join(dest, n), join(dest, n.replace(/\.arnx$/, "")));
  const strip = (s: string) => s.replaceAll(".py.arnx", ".py");
  for (const f of [join(repo, ".arnx", "accepted-tests.json"), join(rdir, "accepted.json")]) {
    writeFileSync(f, strip(readFileSync(f, "utf8")));
  }
  const rec = JSON.parse(readFileSync(join(repo, ".arnx", "accepted-tests.json"), "utf8"));
  for (const e of Object.values(rec.files) as any[]) delete e.ids;
  writeFileSync(join(repo, ".arnx", "accepted-tests.json"), JSON.stringify(rec));
  marked(rdir, ["noise", "real", "noise"]);
  await accept(repo, rdir, SETTINGS, { again: true });
  expect(readdirSync(dest)).toEqual(["test_zero.py.arnx"]); // the older-named files are gone, none left behind
  expect(readdirSync(dest).every((n) => n.endsWith(".arnx"))).toBe(true);
  expect(changedAccepted(repo, null)).toEqual([]);
});
