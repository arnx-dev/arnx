// A test file that does not load (pytest's collection error, a vitest or node file that fails before its tests run)
// hides every test in it, as known_failing did. Setup sends it back to the agent with its real error, and a file the
// agent keeps is recorded as one that does not load, not as a test that fails today.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TestResult } from "../src/adapters/types";
import { type Baseline, entryOf, parseBaseline } from "../src/baseline";
import { loadReviewFile, parseReviewConfig, reviewConfigPath } from "../src/config";
import { classify, describeHints, diagnose, errorLine, firstErrors, loadFailure } from "../src/diagnose";
import { causeOf, environmentFaults, type SuiteCounts } from "../src/setup";
import { baselineLines } from "../src/setupview";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();
const PY = parseReviewConfig(CFG);
const CFG_FILE = "version: 1\nprojects:\n  main:\n    root: .\n    image: python:3.12-slim\n" +
  "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n";

// What pytest 7 writes for a module that fails while it is imported (junit xunit1, message + text).
const COLLECT_LIB = "collection failure\nImportError while importing test module '/src/tests/test_score.py'.\n" +
  "Traceback:\ntests/test_score.py:3: in <module>\n    import lightgbm\n" +
  "/usr/local/lib/python3.11/site-packages/lightgbm/basic.py:9: in <module>\n    _LIB = _load_lib()\n" +
  "E   OSError: libgomp.so.1: cannot open shared object file: No such file or directory";
const COLLECT_PLAIN = "collection failure\ntests/test_orders.py:4: in <module>\n    from app import routes\n" +
  "app/routes.py:12: in <module>\n    TOKEN = settings.token[0]\nE   TypeError: 'NoneType' object is not subscriptable";
const COLLECT_MODULE = "collection failure\nTraceback:\ntests/test_collect.py:1: in <module>\n" +
  "    import not_a_real_package_arnx\nE   ModuleNotFoundError: No module named 'not_a_real_package_arnx'";

const r = (testId: string, fileAttr: string, name: string, outcome: string, message: string): TestResult =>
  ({ testId, fileAttr, name, outcome, message });
const collect = (file: string, message: string) =>
  r(`${file}::${file.replace(/\.py$/, "").replaceAll("/", ".")}`, file, file.replace(/\.py$/, "").replaceAll("/", "."),
    "error", message);
const counts = (failed: TestResult[], hints = diagnose(failed, PY, tmp()), passed = 50): SuiteCounts =>
  ({ acceptedFailing: 0, unexpected: [], baselineFailing: 0, left: [], flaky: [], failed, passed, all: failed, hints });

test("a load failure's line is the error under pytest's collection header, any other failure's its first line", () => {
  expect(errorLine(COLLECT_LIB)).toBe("OSError: libgomp.so.1: cannot open shared object file: No such file or directory");
  expect(errorLine(COLLECT_PLAIN)).toBe("TypeError: 'NoneType' object is not subscriptable");
  expect(errorLine("collection failure\nsomething odd\n")).toBe("something odd");
  expect(errorLine("\n  AssertionError: 1 != 2\nE   later")).toBe("AssertionError: 1 != 2");
});

test("results that stand for a whole file: pytest's collection error, a vitest or node file that failed loading", () => {
  expect(loadFailure(collect("tests/test_score.py", COLLECT_LIB))).toBe(true);
  expect(loadFailure(r("src/queue/client.test.ts::src/queue/client.test.ts", "src/queue/client.test.ts",
    "src/queue/client.test.ts", "failed", "spawn redis-server ENOENT"))).toBe(true);
  expect(loadFailure(r("test/a.test.mjs::/src/test/a.test.mjs", "test/a.test.mjs", "/src/test/a.test.mjs", "error",
    "SyntaxError: Unexpected token"))).toBe(true);
  expect(loadFailure(r("tests/test_a.py::test_x", "tests/test_a.py", "test_x", "failed", "AssertionError"))).toBe(false);
  expect(loadFailure(r("tests/test_a.py::tests.test_a", "tests/test_a.py", "tests.test_a", "passed", ""))).toBe(false);
});

test("a system library or a program missing from the image is the environment", () => {
  expect(classify(COLLECT_LIB, PY, tmp())).toMatchObject({ kind: "missing-library", detail: "libgomp.so.1",
    evidence: "OSError: libgomp.so.1: cannot open shared object file: No such file or directory" });
  expect(classify("Error: spawn redis-server ENOENT\n    at ChildProcess._handle.onexit", PY, tmp()))
    .toMatchObject({ kind: "missing-program", detail: "redis-server" });
  expect(classify("RuntimeError: /bin/sh: 1: ffmpeg: not found", PY, tmp()))
    .toMatchObject({ kind: "missing-program", detail: "ffmpeg" });
  expect(classify("bash: wkhtmltopdf: command not found", PY, tmp()))
    .toMatchObject({ kind: "missing-program", detail: "wkhtmltopdf" });
  expect(classify("AssertionError: expected 'not found' to be 'ok'", PY, tmp())).toBeNull();
});

test("a file that does not load and matches no signature is a doubt of its own, named by its error", () => {
  const failed = [collect("tests/test_orders.py", COLLECT_PLAIN), collect("tests/test_billing.py", COLLECT_PLAIN),
    collect("tests/test_collect.py", COLLECT_MODULE),
    r("tests/test_a.py::test_x", "tests/test_a.py", "test_x", "failed", "AssertionError: 1 != 2")];
  const hints = diagnose(failed, PY, tmp());
  expect(hints).toHaveLength(2);
  expect(hints).toContainEqual({ kind: "does-not-load", detail: "TypeError: 'NoneType' object is not subscriptable",
    files: ["tests/test_orders.py", "tests/test_billing.py"], evidence: "" });
  expect(hints).toContainEqual({ kind: "missing-package", detail: "not_a_real_package_arnx",
    files: ["tests/test_collect.py"], evidence: "ModuleNotFoundError: No module named 'not_a_real_package_arnx'" });
  expect(describeHints(hints, PY)).toContain("test files do not load (`TypeError: 'NoneType' object is not " +
    "subscriptable`), so none of their tests run");
});

test("files that do not load go back to the agent even when most of the suite passes", () => {
  const failed = [collect("tests/test_orders.py", COLLECT_PLAIN), collect("tests/test_score.py", COLLECT_LIB)];
  const faults = environmentFaults(counts(failed), PY)!;
  expect(faults).not.toBeNull();
  expect(faults.count).toBe(2);
  expect(faults.text).toContain("do not load");
  expect(faults.text).toContain("libgomp.so.1");
});

test("the agent sees the real error of a file that does not load, not the collection header", () => {
  expect(firstErrors([collect("tests/test_score.py", COLLECT_LIB)], PY)).toBe("First error in each failing file:\n" +
    "- tests/test_score.py: OSError: libgomp.so.1: cannot open shared object file: No such file or directory");
});

test("a file the agent keeps is recorded as one that does not load, with its error as the first line", () => {
  const snap = tmp();
  mkdirSync(join(snap, "tests"));
  const plain = collect("tests/test_orders.py", COLLECT_PLAIN);
  const hints = diagnose([plain], PY, snap);
  const e = entryOf(plain, causeOf(plain, PY, snap, hints) ?? undefined);
  expect(e).toEqual({ id: plain.testId, file: "tests/test_orders.py",
    first: "TypeError: 'NoneType' object is not subscriptable", cause: "does-not-load", load: true });
  const lib = collect("tests/test_score.py", COLLECT_LIB);
  expect(entryOf(lib, causeOf(lib, PY, snap) ?? undefined)).toMatchObject({ cause: "missing-library: libgomp.so.1",
    load: true });
  const ordinary = r("tests/test_a.py::test_x", "tests/test_a.py", "test_x", "failed", "AssertionError: 1 != 2");
  expect(entryOf(ordinary)).toEqual({ id: "tests/test_a.py::test_x", file: "tests/test_a.py",
    first: "AssertionError: 1 != 2" });
  const text = JSON.stringify({ version: 1, projects: { main: [e] } });
  expect(parseBaseline(text).get("main")).toEqual([e]);
  expect(() => parseBaseline(JSON.stringify({ version: 1, projects: { main: [{ ...e, load: "yes" }] } }))).toThrow();
});

test("worth a look: files that do not load are named apart from the tests that fail today", () => {
  const repo = tmp();
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), CFG_FILE);
  const file = loadReviewFile(repo, { requireApproved: false });
  const base: Baseline = new Map([["main", [
    { id: "tests/test_a.py::test_x", file: "tests/test_a.py", first: "AssertionError" },
    { id: "tests/test_s.py::tests.test_s", file: "tests/test_s.py", first: "OSError: libgomp.so.1",
      cause: "missing-library: libgomp.so.1", load: true },
    { id: "tests/test_p.py::tests.test_p", file: "tests/test_p.py", first: "TypeError", cause: "does-not-load",
      load: true },
  ]]]);
  expect(baselineLines(file, base)).toEqual([
    "main: 1 test fails today, recorded in .arnx/baseline.json",
    "main: 2 test files do not load, so none of their tests run: tests/test_p.py, tests/test_s.py " +
      "(1 missing-library: libgomp.so.1); recorded in .arnx/baseline.json",
  ]);
});
