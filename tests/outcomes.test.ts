import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseJunit } from "../src/adapters/junit";
import { python } from "../src/adapters/python";
import type { TestResult } from "../src/adapters/types";
import { parseReviewConfig } from "../src/config";
import { classify, describeRun, funcOf, ownerFile, runTests } from "../src/outcomes";
import type { RunResult, Runner } from "../src/sandbox";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const F = "tests/arnx_generated/test_a.py";
const tmp = useTmp();

test("test_parse_junit", () => {
  const xml = junitXml([[F, "test_ok", "passed", ""], [F, "test_bad[1]", "failed", "assert 1 == 2"],
    [F, "test_err", "error", "fixture 'db' not found"]]);
  const results = python.parseReport(xml, "pytest", ".")!;
  expect(results.map((r) => [r.testId, r.outcome])).toEqual([
    [`${F}::test_ok`, "passed"], [`${F}::test_bad[1]`, "failed"], [`${F}::test_err`, "error"]]);
  expect(funcOf(results[1]!)).toBe("test_bad");
  expect(results[1]!.message.startsWith("assert 1 == 2")).toBe(true);
});

test("test_parse_junit_class", () => {
  const xml = junitXml([[F, "test_m", "passed", ""]]).replace(
    'classname="tests.arnx_generated.test_a"', 'classname="tests.arnx_generated.test_a.TestX"');
  expect(python.parseReport(xml, "pytest", ".")![0]!.testId).toBe(`${F}::TestX::test_m`);
});

const r = (name: string, outcome: string): TestResult =>
  ({ testId: `${F}::${name}`, fileAttr: F, name, outcome, message: outcome !== "passed" ? "msg" : "" });

test("test_classify", () => {
  const run1 = [r("a", "failed"), r("b", "failed"), r("c", "passed"), r("d", "error"), r("e", "skipped")];
  const run2 = [r("a", "failed"), r("b", "passed"), r("c", "passed"), r("d", "error"), r("e", "skipped")];
  const run3 = [r("a", "failed"), r("b", "failed"), r("c", "passed"), r("d", "passed"), r("e", "skipped")];
  const c = classify([run1, run2, run3]);
  expect(c.findings.map((t) => t.name)).toEqual(["a"]);
  expect(c.flaky.map((t) => t.name)).toEqual(["b"]);
  expect(c.errors.map((t) => t.name)).toEqual(["d"]);
  expect(c.passed.map((t) => t.name)).toEqual(["c"]);
  expect([c.missingRuns, c.totalRuns]).toEqual([0, 3]);
});

test("test_failure_without_every_report_is_not_a_finding", () => {
  const c = classify([[r("a", "failed")], null, [r("a", "failed")]]);
  expect(c.findings).toEqual([]);
  expect(c.flaky.map((t) => t.name)).toEqual(["a"]);
  expect(c.missingRuns).toBe(1);
});

test("test_owner_file", () => {
  const files = ["app/tests/arnx_generated/test_a.py", "app/tests/arnx_generated/conftest.py"];
  expect(ownerFile("tests/arnx_generated/test_a.py", files)).toBe("app/tests/arnx_generated/test_a.py");
  expect(ownerFile("tests/other.py", files)).toBeNull();
});

class WritingSession implements Runner {
  commands: string[] = [];
  constructor(readonly snap: string, readonly xml: string | null, readonly timedOut = false) {}
  run(command: string): RunResult {
    this.commands.push(command);
    if (this.xml !== null) {
      mkdirSync(join(this.snap, ".arnx-run"), { recursive: true });
      writeFileSync(join(this.snap, ".arnx-run", "x.xml"), this.xml);
    }
    return { exitCode: this.timedOut ? null : 1, output: "out", timedOut: this.timedOut, seconds: 0.1 };
  }
}

test("test_run_pytest", () => {
  const cfg = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest -q {targets}\n");
  const s = new WritingSession(tmp(), junitXml([[F, "test_a", "failed", "boom"]]));
  const [, results] = runTests(s, tmp(), cfg, ["tests"], "x.xml", 10);
  expect(results?.[0]?.outcome).toBe("failed");
  expect(s.commands[0]).toContain("--junitxml=/src/.arnx-run/x.xml");
});

test("test_run_pytest_no_report", () => {
  const cfg = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest -q {targets}\n");
  mkdirSync(join(tmp(), ".arnx-run"));
  writeFileSync(join(tmp(), ".arnx-run", "x.xml"), junitXml([[F, "test_a", "passed", ""]]));
  let [, results] = runTests(new WritingSession(tmp(), null), tmp(), cfg, [], "x.xml", 10);
  expect(results).toBeNull(); // a report left by an earlier run never counts
  [, results] = runTests(new WritingSession(tmp(), "<garbage"), tmp(), cfg, [], "x.xml", 10);
  expect(results).toBeNull();
});

test("parseJunit decodes character references and keeps names as text", () => {
  const xml = `<testsuites><testsuite><testcase classname="t" name="1" file="t.py">` +
    `<failure message="a&#10;b &quot;c&quot; &lt;d&gt; &amp; &#x41;">  line one\n  line two</failure>` +
    `</testcase></testsuite></testsuites>`;
  const [t] = parseJunit(xml, () => "t")!;
  expect(t!.name).toBe("1");
  expect(t!.message).toBe('a\nb "c" <d> & A\n  line one\n  line two');
});

test("nested testsuites are walked in order", () => {
  const xml = `<testsuites><testsuite><testcase name="a" file="x.py"/><testsuite>` +
    `<testcase name="b" file="x.py"/></testsuite><testcase name="c" file="x.py"/></testsuite></testsuites>`;
  expect(parseJunit(xml, () => "x")!.map((t) => t.name)).toEqual(["a", "b", "c"]);
});

test("the report directory exists before the runner starts (not every runner creates it)", () => {
  const cfg = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest -q {targets}\n");
  let existed = false;
  const s: Runner = { run: () => {
    existed = existsSync(join(tmp(), ".arnx-run"));
    return { exitCode: 0, output: "", timedOut: false, seconds: 0 };
  } };
  runTests(s, tmp(), cfg, [], "x.xml", 10);
  expect(existed).toBe(true);
});

// What the agent sees after run_tests: the parsed results first, then the runner's console.
const res = (output: string, exitCode: number | null = 1, timedOut = false): RunResult =>
  ({ exitCode, output, timedOut, seconds: 1 });
const tr = (fileAttr: string, name: string, outcome: string, message = ""): TestResult =>
  ({ testId: `${fileAttr}::${name}`, fileAttr, name, outcome, message });

test("the agent sees each test's outcome and failure message even when the console is empty", () => {
  const text = describeRun(res(""), [tr("__tests__/g/a.test.js", "sends mail", "failed", "expected 1 to be 2"),
    tr("__tests__/g/a.test.js", "keeps subject", "passed")], ["svc/__tests__/g/a.test.js"]);
  expect(text).toContain("2 tests: 1 passed, 1 failed");
  expect(text).toContain("FAILED __tests__/g/a.test.js::sends mail");
  expect(text).toContain("expected 1 to be 2");
  expect(text).toContain("passed __tests__/g/a.test.js::keeps subject");
});

test("without a report the agent is told so, with the exit code and the console", () => {
  const text = describeRun(res("Error: Cannot find module '../shared/x'", 1), null, ["svc/__tests__/g/a.test.js"]);
  expect(text).toContain("no report");
  expect(text).toContain("exit code 1");
  expect(text).toContain("Cannot find module");
});

test("a report without any of the agent's tests says the runner did not pick up its files", () => {
  const text = describeRun(res("No tests found, exiting with code 1"), [], ["svc/__tests__/g/a.test.js"]);
  expect(text).toContain("did not run any of your test files");
  const other = describeRun(res(""), [tr("__tests__/unit/old.test.js", "x", "passed")], ["svc/__tests__/g/a.test.js"]);
  expect(other).toContain("did not run any of your test files");
});

test("a timed-out run says so", () => {
  expect(describeRun(res("", null, true), null, ["t/test_a.py"])).toContain("timed out");
});

test("a failure reported for the whole file is an error (it crashed while loading), never a finding", () => {
  const f = "__tests__/arnx_generated/fcm-sound.test.js";
  const crash = tr(f, f, "failed", "test failed");
  const c = classify([[crash], [crash], [crash]]);
  expect(c.findings).toEqual([]);
  expect(c.errors.map((t) => t.testId)).toEqual([`${f}::${f}`]);
  expect(c.errors[0]!.message).toContain("failed while loading");
  // node names the file relative to where it ran; the report path can be longer
  const rel = tr("svc/" + f, f, "failed", "test failed");
  expect(classify([[rel]]).errors).toHaveLength(1);
  // a real test that fails stays a finding
  expect(classify([[tr(f, "sends mail", "failed", "1 == 2")]]).findings).toHaveLength(1);
});
