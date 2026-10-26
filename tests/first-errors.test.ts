// The setup agent sees the first error of each failing file: vitest and bun write results only to arnx's report, so
// the console tail it gets can hold no failure at all, and an agent that pipes the output to read it loses the report.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestResult } from "../src/adapters/types";
import { parseReviewConfig } from "../src/config";
import { classify, firstErrors } from "../src/diagnose";
import { runSuite } from "../src/setup";
import { fakeFactory } from "./helpers/fakes";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();
const PY = parseReviewConfig(CFG);
const r = (fileAttr: string, outcome: string, message: string) =>
  ({ testId: `${fileAttr}::t`, fileAttr, name: "t", outcome, message }) as TestResult;

test("one line per failing file, its first failure's first line, files in order", () => {
  expect(firstErrors([r("tests/test_b.py", "failed", "\n  AssertionError: 1 != 2\nmore"),
    r("tests/test_a.py", "error", "Error: Cannot find module './gen.js'"), r("tests/test_b.py", "failed", "later"),
    r("tests/test_c.py", "passed", "")], PY)).toBe("First error in each failing file:\n" +
    "- tests/test_a.py: Error: Cannot find module './gen.js'\n- tests/test_b.py: AssertionError: 1 != 2");
});

test("known_failing files and failures with no message are left out; nothing to show is empty", () => {
  const cfg = parseReviewConfig(CFG + "known_failing: [tests/test_net.py]\nnotes: [\"tests/test_net.py: needs the internet\"]\n");
  expect(firstErrors([r("tests/test_net.py", "failed", "ConnectionError"), r("tests/test_x.py", "failed", "")], cfg))
    .toBe("");
});

test("at most ten files, and the count of the rest", () => {
  const many = Array.from({ length: 12 }, (_, i) => r(`tests/test_${String(i).padStart(2, "0")}.py`, "failed", "boom"));
  const text = firstErrors(many, PY);
  expect(text.split("\n")[0]).toBe("First error in each failing file (10 of 12):");
  expect(text.split("\n").length).toBe(11);
});

test("a suite that does not run yet gives the setup agent those lines", async () => {
  const snap = tmp();
  mkdirSync(join(snap, "tests"), { recursive: true });
  writeFileSync(join(snap, "tests", "test_a.py"), "def test_a():\n    pass\n");
  const [ok, , , , , hints] = await runSuite(PY, snap, join(tmp(), "b.log"), { sessionFactory: fakeFactory(() =>
    [junitXml([["tests/test_a.py", "test_a", "failed", "AssertionError: totals differ"]]), "", false]) });
  expect(ok).toBe(false);
  expect(hints).toContain("First error in each failing file:\n- tests/test_a.py: AssertionError: totals differ");
});

test("pytest's E mark is dropped from a line, the E of a word that starts one is not", () => {
  expect(firstErrors([r("tests/test_a.py", "failed", "E   AssertionError: no")], PY)).toEndWith(": AssertionError: no");
  expect(classify("Error: Cannot find module 'left-pad'\n    at x", PY, tmp())?.evidence)
    .toBe("Error: Cannot find module 'left-pad'");
});
