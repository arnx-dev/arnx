import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../src/adapters";
import { parseReviewFile } from "../src/config";
import { runTests } from "../src/outcomes";
import type { RunResult } from "../src/sandbox";
import { useTmp } from "./helpers/tmp";

const ts = getAdapter("typescript");
const tmp = useTmp();
const R = "/src/.arnx-run/r.xml";

test("runners and their commands", () => {
  expect(ts.runners).toEqual(["vitest", "jest", "node", "bun"]);
  expect(ts.command("npx jest {targets}", ["a b.test.js"], "/src/.arnx-run/r.json", "jest"))
    .toBe("npx jest 'a b.test.js' --json --outputFile=/src/.arnx-run/r.json --testLocationInResults --forceExit");
  expect(ts.command("npx vitest run {targets}", ["x.test.ts"], R, "vitest"))
    .toBe(`npx vitest run x.test.ts --reporter=junit --outputFile=${R}`);
  expect(ts.command("node --test {targets}", ["t/x.test.js", "__tests__/arnx_generated"], R, "node"))
    .toBe("node --test --test-force-exit --test-reporter=/src/.arnx-run/arnx-node-reporter.mjs " +
      `--test-reporter-destination=${R} t/x.test.js '__tests__/arnx_generated/**/*.{test,spec}.*'`);
  expect(ts.command("bun test {targets}", ["x.test.ts"], R, "bun"))
    .toBe(`bun test x.test.ts --reporter=junit --reporter-outfile=${R}`);
});

test("test commands must call the runner directly", () => {
  expect(ts.validateCommand("npx jest {targets}", "jest")).toEqual([]);
  expect(ts.validateCommand("node --test {targets}", "node")).toEqual([]);
  expect(ts.validateCommand("npm run test {targets}", "jest")[0]).toContain("call the runner directly");
  expect(ts.validateCommand("npx vitest run {targets}", "jest")[0]).toContain("jest");
  expect(ts.validateCommand("npx jest", "jest")[0]).toContain("{targets}");
});

const JEST = JSON.stringify({ testResults: [
  { name: "/src/services/pay/__tests__/arnx_generated/pay.test.js", status: "failed", message: "",
    assertionResults: [
      { ancestorTitles: ["pay"], title: "rejects zero", status: "failed", failureMessages: ["Expected: 1\nReceived: 0"] },
      { ancestorTitles: [], title: "works", status: "passed", failureMessages: [] },
      { ancestorTitles: [], title: "later", status: "todo", failureMessages: [] }] },
  { name: "/src/services/pay/__tests__/arnx_generated/broken.test.js", status: "failed",
    message: "Cannot find module '../x'", assertionResults: [] }] });

test("jest JSON maps to results relative to the project root", () => {
  const r = ts.parseReport(JEST, "jest", "services/pay")!;
  expect(r.map((t) => [t.testId, t.outcome])).toEqual([
    ["__tests__/arnx_generated/pay.test.js::pay > rejects zero", "failed"],
    ["__tests__/arnx_generated/pay.test.js::works", "passed"],
    ["__tests__/arnx_generated/pay.test.js::later", "skipped"],
    ["__tests__/arnx_generated/broken.test.js::__tests__/arnx_generated/broken.test.js", "error"]]);
  expect(r[0]!.fileAttr).toBe("__tests__/arnx_generated/pay.test.js");
  expect(r[0]!.message).toContain("Received: 0");
  expect(r[3]!.message).toContain("Cannot find module");
  expect(ts.parseReport("{not json", "jest", ".")).toBeNull();
});

test("JUnit without file attributes: vitest and bun shapes", () => {
  const vitest = `<testsuites><testsuite name="__tests__/arnx_generated/a.test.ts"><testcase classname="__tests__/arnx_generated/a.test.ts" name="sum &gt; adds"><failure message="expected 3"/></testcase></testsuite></testsuites>`;
  expect(ts.parseReport(vitest, "vitest", ".")!.map((t) => [t.testId, t.outcome]))
    .toEqual([["__tests__/arnx_generated/a.test.ts::sum > adds", "failed"]]);
  const bun = `<testsuites><testsuite name="a.test.ts" file="a.test.ts"><testsuite name="sum"><testcase name="adds" classname="sum"/></testsuite></testsuite></testsuites>`;
  expect(ts.parseReport(bun, "bun", ".")!.map((t) => t.testId)).toEqual(["a.test.ts::sum > adds"]);
});

test("generated files, test files and support files", () => {
  for (const n of ["a.test.ts", "b.spec.js", "c.test.mjs", "d.test.tsx", "arnx-helpers.ts"]) expect(ts.writable.test(n)).toBe(true);
  for (const n of ["a.ts", "test.ts", "notes.md", "a.test.py"]) expect(ts.writable.test(n)).toBe(false);
  expect(ts.isTestFile("a.spec.js") && !ts.isTestFile("arnx-helpers.js")).toBe(true);
  expect(ts.isSupportFile("arnx-helpers.js")).toBe(true);
  expect(ts.defaultTestsDir).toBe("__tests__/arnx_generated");
});

test("skip marks the named tests, nested in describe, including .only and template titles", () => {
  const src = [
    "describe('pay', () => {",
    "  it('rejects zero', () => {});",
    "  it.only(\"keeps\", () => {});",
    "  test(`total`, () => {});",
    "  test(`with ${x}`, () => {});",
    "  it('other', () => {});",
    "});", ""].join("\n");
  const out = ts.skip(src, new Set(["pay > rejects zero", "keeps", "total", "with ${x}"]), "arnx: not confirmed");
  expect(out).toBe([
    "describe('pay', () => {",
    "  // arnx: not confirmed",
    "  it.skip('rejects zero', () => {});",
    "  // arnx: not confirmed",
    "  it.skip(\"keeps\", () => {});",
    "  // arnx: not confirmed",
    "  test.skip(`total`, () => {});",
    "  test(`with ${x}`, () => {});",
    "  it('other', () => {});",
    "});", ""].join("\n"));
  expect(ts.skip(src, new Set(), "r")).toBe(src);
});

test("accepted paths and relocated imports", () => {
  expect(ts.acceptedPath("pay.test.js", "t1", "tests/arnx", "double_charge")).toBe("__tests__/arnx/rt1/double_charge.test.js");
  expect(ts.acceptedPath("sub/pay.spec.ts", "t1", "tests/arnx", "pay")).toBe("__tests__/arnx/rt1/sub/pay.test.ts");
  expect(ts.acceptedPath("arnx-helpers.ts", "t1", "tests/arnx", "x")).toBe("__tests__/arnx/rt1/arnx-helpers.ts");
  // A configured accepted_tests_dir other than the default is where they go.
  expect(ts.acceptedPath("sub/pay.test.ts", "t1", "test/locks", "pay")).toBe("test/locks/rt1/sub/pay.test.ts");
  expect([ts.testStem("pay.spec.mts"), ts.testStem("refund.test.tsx")]).toEqual(["pay", "refund"]);
  const src = [
    "import { pay } from '../../src/pay';",
    "const db = require(\"../../lib/db\");",
    "const h = await import('./arnx-helpers');",
    "jest.mock('../../src/mailer');",
    "import express from 'express';",
    "import './setup';", ""].join("\n");
  expect(ts.relocate(src, "__tests__/arnx_generated", "__tests__/arnx/rt1")).toBe([
    "import { pay } from '../../../src/pay';",
    "const db = require(\"../../../lib/db\");",
    "const h = await import('./arnx-helpers');",
    "jest.mock('../../../src/mailer');",
    "import express from 'express';",
    "import '../../arnx_generated/setup';", ""].join("\n"));
});

test("node:test results come from arnx's reporter, with the file of every test", () => {
  ts.reportSetup!(tmp(), "node");
  const reporter = readFileSync(join(tmp(), ".arnx-run", "arnx-node-reporter.mjs"), "utf8");
  expect(reporter).toContain("export default async function*");
  const lines = [
    { name: "__tests__/arnx_generated/bad.test.js", file: "/src/svc/__tests__/arnx_generated/bad.test.js",
      outcome: "error", message: "SyntaxError" },
    { name: "sum > adds", file: "/src/svc/__tests__/arnx_generated/a.test.js", outcome: "failed", message: "28 !== 29" },
    { name: "sum > later", file: "/src/svc/__tests__/arnx_generated/a.test.js", outcome: "skipped", message: "" },
  ].map((l) => JSON.stringify(l)).join("\n");
  expect(ts.parseReport(lines, "node", "svc")!.map((t) => [t.testId, t.fileAttr, t.outcome])).toEqual([
    ["__tests__/arnx_generated/bad.test.js::__tests__/arnx_generated/bad.test.js", "__tests__/arnx_generated/bad.test.js", "error"],
    ["__tests__/arnx_generated/a.test.js::sum > adds", "__tests__/arnx_generated/a.test.js", "failed"],
    ["__tests__/arnx_generated/a.test.js::sum > later", "__tests__/arnx_generated/a.test.js", "skipped"]]);
  expect(ts.parseReport("not json", "node", ".")).toBeNull();
});

test("setup hints say dependencies under /src are hidden at test time", () => {
  expect(ts.setupHints).toContain("mounted over /src");
  expect(ts.setupHints).toContain("set deps_dir");
});

test("node reporter: a file that defines no tests is not a passing test", () => {
  const dir = join(tmp(), "proj");
  mkdirSync(join(dir, ".arnx-run"), { recursive: true });
  ts.reportSetup!(dir, "node");
  writeFileSync(join(dir, "empty.test.mjs"), "export default { name: 'htest-style', tests: [] };\n");
  writeFileSync(join(dir, "real.test.mjs"), "import test from 'node:test';\ntest('adds', () => {});\n");
  const r = spawnSync("node", ["--test", `--test-reporter=${join(dir, ".arnx-run", "arnx-node-reporter.mjs")}`,
    `--test-reporter-destination=${join(dir, "out.jsonl")}`, "empty.test.mjs", "real.test.mjs"], { cwd: dir, encoding: "utf8" });
  expect(r.status).toBe(0);
  const lines = readFileSync(join(dir, "out.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => [l.name, l.outcome])).toEqual([["adds", "passed"]]);
});

test("node reporter: a file that crashes while loading is an error, a failing test is a failure", () => {
  const dir = join(tmp(), "proj");
  mkdirSync(join(dir, ".arnx-run"), { recursive: true });
  ts.reportSetup!(dir, "node");
  writeFileSync(join(dir, "crash.test.cjs"), "const { test } = require('node:test');\nrequire('./missing.js');\n" +
    "test('never', () => {});\n");
  writeFileSync(join(dir, "real.test.cjs"), "const { test } = require('node:test');\nconst assert = require('node:assert');\n" +
    "test('fails', () => { assert.equal(1, 2); });\n");
  spawnSync("node", ["--test", `--test-reporter=${join(dir, ".arnx-run", "arnx-node-reporter.mjs")}`,
    `--test-reporter-destination=${join(dir, "out.jsonl")}`, "crash.test.cjs", "real.test.cjs"], { cwd: dir, encoding: "utf8" });
  const lines = readFileSync(join(dir, "out.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(lines.map((l) => [l.name, l.outcome])).toEqual([["crash.test.cjs", "error"], ["fails", "failed"]]);
});

// bun 1.3's JUnit report and console output, as a run of one generated file writes them (the report holds no failure
// text: only `<failure type="AssertionError" />`).
const BUN_JUNIT = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="bun test" tests="4" assertions="3" failures="3" skipped="0" time="0.018">
  <testsuite name="__tests__/gen/calc.test.ts" file="__tests__/gen/calc.test.ts" tests="4" assertions="3" failures="3" skipped="0" time="0" hostname="box">
    <testcase name="adds" classname="" time="0" file="__tests__/gen/calc.test.ts" line="2" assertions="1" />
    <testsuite name="group" file="__tests__/gen/calc.test.ts" line="3" tests="1" assertions="1" failures="1" skipped="0" time="0" hostname="box">
      <testcase name="length" classname="group" time="0.001" file="__tests__/gen/calc.test.ts" line="4" assertions="1">
        <failure type="AssertionError" />
      </testcase>
    </testsuite>
    <testcase name="equal" classname="" time="0" file="__tests__/gen/calc.test.ts" line="6" assertions="1">
      <failure type="AssertionError" />
    </testcase>
    <testcase name="throws" classname="" time="0" file="__tests__/gen/calc.test.ts" line="7" assertions="0">
      <failure type="AssertionError" />
    </testcase>
  </testsuite>
</testsuites>
`;
const BUN_OUTPUT = `bun test v1.3.9 (cf6cdbbb)

__tests__/gen/calc.test.ts:
(pass) adds [0.20ms]
3 | describe("group", () => {
4 |   test("length", () => { expect([] as number[]).toHaveLength(1); });
                                                    ^
error: expect(received).toHaveLength(expected)

Expected length: 1
Received length: 0

      at <anonymous> (/src/web/__tests__/gen/calc.test.ts:4:49)
(fail) group > length [1.00ms]
5 | });
6 | test("equal", () => { expect({ a: 1 }).toEqual({ a: 2 }); });
                                           ^
error: expect(received).toEqual(expected)

  {
-   "a": 2,
+   "a": 1,
  }

- Expected  - 1
+ Received  + 1

      at <anonymous> (/src/web/__tests__/gen/calc.test.ts:6:40)
(fail) equal
7 | test("throws", () => { throw new Error("boom here"); });
                                                      ^
error: boom here
      at <anonymous> (/src/web/__tests__/gen/calc.test.ts:7:51)
(fail) throws

 1 pass
 3 fail
 3 expect() calls
Ran 4 tests across 1 file. [18.00ms]
`;

test("bun: a failing test's message comes from the run's output, which its JUnit report leaves out", async () => {
  const cfg = parseReviewFile(`version: 1
projects:
  web:
    root: web
    language: typescript
    runner: bun
    image: oven/bun:1
    test_command: bun test {targets}
`).projects[0]!;
  const snap = tmp();
  const session = { run: (command: string): RunResult => {
    const out = /--reporter-outfile=\/src\/(\S+)/.exec(command)![1]!;
    mkdirSync(join(snap, out, ".."), { recursive: true });
    writeFileSync(join(snap, out), BUN_JUNIT);
    return { exitCode: 1, output: BUN_OUTPUT, timedOut: false, seconds: 0.1 };
  } };
  const [, results] = await runTests(session, snap, cfg, ["__tests__/gen/calc.test.ts"], "r.xml", 60);
  const by = Object.fromEntries(results!.map((t) => [t.name, t]));
  expect(by.adds!.message).toBe("");
  expect(by["group > length"]!.message.split("\n")[0]).toBe("error: expect(received).toHaveLength(expected)");
  expect(by["group > length"]!.message).toContain("Received length: 0");
  expect(by["group > length"]!.message).toContain("at <anonymous> (/src/web/__tests__/gen/calc.test.ts:4:49)");
  expect(by["group > length"]!.message).not.toContain("toHaveLength(1); });"); // the source excerpt is not the failure
  expect(by.equal!.message.split("\n")[0]).toBe("error: expect(received).toEqual(expected)");
  expect(by.throws!.message.split("\n")[0]).toBe("error: boom here");
});
