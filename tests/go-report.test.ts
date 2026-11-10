import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGoReport } from "../src/adapters/go-report";
import { type BeforeRun, judgeBefore } from "../src/before";
import { parseBaseline } from "../src/baseline";

const FIX = join(import.meta.dir, "fixtures", "go-events");
const SRC = join(FIX, "src");

/** The `func Test` lines of every test file under a fixture's source directory, as the adapter's command writes them. */
function declared(rel: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(SRC, rel), { withFileTypes: true })) {
    const p = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...declared(p));
    else if (e.name.endsWith("_test.go")) {
      for (const l of readFileSync(join(SRC, p), "utf8").split("\n")) if (l.startsWith("func Test")) out.push(`#arnx-test ${p}:${l}`);
    }
  }
  return out;
}

const report = (c: string) =>
  readFileSync(join(FIX, `${c}.jsonl`), "utf8") + ["#arnx-module example.com/events", ...declared(c)].join("\n") + "\n";
const parse = (c: string) => parseGoReport(report(c))!;
const find = (c: string, name: string) => parse(c).find((t) => t.name === name);
const outcomeOf = (c: string, name: string) => find(c, name)?.outcome;
const firstLine = (c: string, name: string) => (find(c, name)?.message ?? "").split("\n")[0]!;

test("no JSON event is unreadable", () => expect(parseGoReport("go: go.mod requires go >= 1.99\n")).toBeNull());
test("a run with no end is an error", () => expect(outcomeOf("exit3", "TestCrash")).toBe("error"));
test("a timeout is an error", () => expect(outcomeOf("timeout", "TestHang")).toBe("error"));
test("a panic in another goroutine is an error", () => expect(outcomeOf("goroutine-panic", "TestGoroutinePanic")).toBe("error"));
test("a panic on the test's own goroutine is a failure", () => expect(outcomeOf("panic", "TestPanics")).toBe("failed"));
test("tests that finished before a crash keep their outcome", () => expect(outcomeOf("exit3", "TestBefore")).toBe("passed"));
test("pass, fail and skip map to their outcomes", () => {
  expect(outcomeOf("pass-fail-skip", "TestPass")).toBe("passed");
  expect(outcomeOf("pass-fail-skip", "TestFail")).toBe("failed");
  expect(outcomeOf("pass-fail-skip", "TestSkip")).toBe("skipped");
});
test("ids carry the file relative to the project root", () => {
  const t = find("pass-fail-skip", "TestFail")!;
  expect(t.fileAttr).toBe("pass-fail-skip/lib_test.go");
  expect(t.testId).toBe("pass-fail-skip/lib_test.go::TestFail");
});
test("a package that fails to compile is one failed result per declared file", () => {
  const r = parse("test-compile");
  expect(r.length).toBe(1);
  expect(r.every((t) => t.name === t.fileAttr && t.outcome === "failed")).toBe(true);
  expect(r[0]!.message).toMatch(/\.go:\d+(:\d+)?: /);
  expect(r[0]!.message).not.toMatch(/^# /);
});
test("a type error in non-test code is a build failure of the declared file", () => {
  const r = parse("code-compile");
  expect(r.map((t) => t.name)).toEqual(["code-compile/lib_test.go"]);
  expect(r[0]!.message).toMatch(/\.go:\d+(:\d+)?: /);
});
test("two files in one failing package give a result each", () =>
  expect(parse("duplicate-func").map((t) => t.name).sort()).toEqual(["duplicate-func/a_test.go", "duplicate-func/b_test.go"]));
test("importing a program is a build failure", () => {
  const r = parse("import-main");
  expect(r.length).toBe(1);
  expect(r.every((t) => t.name === t.fileAttr && t.outcome === "failed")).toBe(true);
  expect(r[0]!.message).toContain("is a program");
});
test("a name no file declares is dropped", () => expect(parse("forge").map((t) => t.name)).not.toContain("TestForged"));
test("both pass and fail reads as failed", () => expect(outcomeOf("forge", "TestReal")).toBe("failed"));
test("TestMain exiting 0 with zero tests is an error per file", () => {
  const r = parse("testmain-exit0");
  expect(r.length).toBe(1);
  expect(r.every((t) => t.outcome === "error" && t.name === t.fileAttr)).toBe(true);
});
test("a package with no tests gives nothing", () => expect(parse("no-tests")).toEqual([]));
test("subtests fold into the parent", () => expect(parse("subtests").map((t) => t.name)).toEqual(["TestTop"]));
test("a failing subtest fails the parent", () => expect(outcomeOf("subtests", "TestTop")).toBe("failed"));
test("a failing test's message drops the --- FAIL line", () => {
  expect(firstLine("pass-fail-skip", "TestFail")).not.toMatch(/^--- FAIL/);
  expect(firstLine("pass-fail-skip", "TestFail")).toContain("boom 1");
});
test("with vet off a bad format verb still runs", () => expect(outcomeOf("vet-off", "TestVetBad")).toBe("passed"));

const ev = (o: object) => JSON.stringify({ Package: "example.com/events/p", ...o });
const synth = (file: string, logged: string) =>
  [
    ev({ Action: "run", Test: "TestA" }),
    ev({ Action: "output", Test: "TestA", Output: `${logged}\n` }),
    ev({ Action: "output", Test: "TestA", Output: "    x_test.go:9: boom\n" }),
    ev({ Action: "output", Test: "TestA", Output: "--- FAIL: TestA (0.00s)\n" }),
    ev({ Action: "fail", Test: "TestA" }),
    ev({ Action: "fail" }),
    "#arnx-module example.com/events",
    `#arnx-test ${file}:func TestA(t *testing.T) {`,
  ].join("\n") + "\n";

test("a line logged before the assertion does not change the message", () => {
  const a = parseGoReport(synth("p/x_test.go", "2026/11/09 17:44:48 connecting"))![0]!;
  const b = parseGoReport(synth("p/x_test.go", "2026/11/09 17:45:02 connecting"))![0]!;
  expect(a.message).toBe(b.message);
  expect(a.message.split("\n")[0]).toBe("x_test.go:9: boom");
});
test("a leading ./ on a declared path is dropped", () => {
  const r = parseGoReport(synth("./p/x_test.go", "hi"))!;
  expect(r.map((t) => t.testId)).toEqual(["p/x_test.go::TestA"]);
});

const run = (...lines: string[]) => parseGoReport([...lines, "#arnx-module example.com/events"].join("\n") + "\n")!;
const events = (test: string, end: "pass" | "fail") => [
  ev({ Action: "run", Test: test }),
  ev({ Action: "output", Test: test, Output: "    x_test.go:5: boom\n" }),
  ev({ Action: end, Test: test }),
  ev({ Action: end }),
];

test("a test with a non-ASCII name keeps its result", () => {
  const r = run(...events("TestÜber", "fail"), '#arnx-test ./p/x_test.go:func TestÜber(t *testing.T) { t.Fatal("boom") }');
  expect(r.map((t) => [t.testId, t.outcome])).toEqual([["p/x_test.go::TestÜber", "failed"]]);
  expect(r[0]!.message).toContain("boom");
});
test("a failing package whose only test line cannot be read is a file-level failure", () => {
  const r = run(...events("TestSp", "fail"), "#arnx-test ./p/x_test.go:func TestSp (t *testing.T) {");
  expect(r.map((t) => [t.name, t.fileAttr, t.outcome])).toEqual([["p/x_test.go", "p/x_test.go", "failed"]]);
});
test("a passing package whose only test line cannot be read is a file-level error", () => {
  const r = run(...events("TestSp", "pass"), "#arnx-test ./p/x_test.go:func TestSp (t *testing.T) {");
  expect(r.map((t) => [t.name, t.outcome])).toEqual([["p/x_test.go", "error"]]);
});
test("events only for undeclared tests do not hide a failing package", () => {
  const r = run(...events("TestOther", "fail"), "#arnx-test ./p/x_test.go:func TestA(t *testing.T) {");
  expect(r.map((t) => [t.name, t.outcome])).toEqual([["p/x_test.go", "failed"]]);
});
test("a package Go names by its pattern still reports on its file", () => {
  const pkg = "./arnx_generated/_u_arnx";
  const r = run(
    JSON.stringify({ ImportPath: pkg, Action: "build-output", Output: `# ${pkg}\n` }),
    JSON.stringify({ ImportPath: pkg, Action: "build-output", Output: "no Go files in /w/arnx_generated/_u_arnx\n" }),
    JSON.stringify({ ImportPath: pkg, Action: "build-fail" }),
    JSON.stringify({ Action: "start", Package: pkg }),
    JSON.stringify({ Action: "output", Package: pkg, Output: `FAIL\t${pkg} [setup failed]\n` }),
    JSON.stringify({ Action: "fail", Package: pkg, FailedBuild: pkg }),
    "#arnx-test ./arnx_generated/_u_arnx/_u_arnx_test.go:func TestX(t *testing.T) {",
  );
  const f = "arnx_generated/_u_arnx/_u_arnx_test.go";
  expect(r.map((t) => [t.name, t.fileAttr, t.outcome])).toEqual([[f, f, "failed"]]);
  expect(r[0]!.message).toContain("no Go files");
});

// A failure's first line is what tells it apart (before.ts compares it, the baseline keeps it): real `go test -json`
// runs of tests/fixtures/go-failures, twice the same (a, b) and once with other values (variant).
const FAIL = join(import.meta.dir, "fixtures", "go-failures");
function failRun(run: "a" | "b" | "variant") {
  const decl: string[] = [];
  const walk = (rel: string) => {
    for (const e of readdirSync(join(FAIL, "src", rel), { withFileTypes: true })) {
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith("_test.go")) {
        for (const l of readFileSync(join(FAIL, "src", p), "utf8").split("\n")) if (l.startsWith("func Test")) decl.push(`#arnx-test ${p}:${l}`);
      }
    }
  };
  walk("");
  return parseGoReport(readFileSync(join(FAIL, `run-${run}.jsonl`), "utf8") +
    ["#arnx-module example.com/failures", ...decl].join("\n") + "\n")!;
}
const failOf = (run: "a" | "b" | "variant", name: string) => failRun(run).find((t) => t.name === name)!;
const headOf = (run: "a" | "b" | "variant", name: string) => failOf(run, name).message.split("\n")[0]!;

describe("a Go failure's first line", () => {
  test("a location chain takes its message from the lines under it", () => {
    const h = headOf("a", "TestListing");
    expect(h.startsWith("check.go:19: chain_test.go:18:")).toBe(true);
    expect(h).toContain('-["docs/","lib/"]');
    expect(h).toContain('+["docs/"]');
    expect(h).not.toContain("\u001b"); // colour codes
  });
  test("a bare location with testify's block takes Error and Messages", () => {
    expect(headOf("a", "TestReadsOutput")).toBe("testify_test.go:20: Received unexpected error: open testdata/missing.txt: " +
      "no such file or directory (reading the output)");
    const eq = headOf("a", "TestEqualValue");
    expect(eq.startsWith('testify_test.go:25: Not equal: expected: "alpha" actual : "beta"')).toBe(true);
    expect(eq).not.toContain("Error Trace");
    expect(eq).not.toContain("comparing the value"); // the t.Log before it
  });
  test("a line logged before the error is not the failure", () =>
    expect(headOf("a", "TestUpload")).toBe("upload_test.go:18: Error occurred [open testdata/picture.png: no such file or directory]"));
  test("a plain message stays as it is; of a log and an error, the line nearest the end is the failure", () => {
    expect(headOf("a", "TestIsLocal")).toBe("plain_test.go:7: expected true, received false");
    expect(headOf("a", "TestDecode")).toBe("plain_test.go:13: bad json");
  });
  test("failing subtests each give their failure, in name order; passing ones and the parent's log do not", () =>
    expect(headOf("a", "TestTable")).toBe("table_test.go:17: Not equal: expected: 1 actual : 2 | table_test.go:22: wrong count: 3"));
  test("addresses, durations, temporary paths and local ports are evened out", () => {
    const h = headOf("a", "TestSlowHandler");
    expect(h).toBe("volatile_test.go:17: request to http://127.0.0.1:<port> for /tmp/<tmp>/001 failed: handler 0x… after <duration>");
    expect(headOf("b", "TestSlowHandler")).toBe(h);
    expect(failOf("a", "TestSlowHandler").message).toMatch(/after \d+\.\d+ms/); // the output itself is kept as it was
  });
  test("a panic is the failure, whatever the test logged before", () =>
    expect(firstLine("panic", "TestPanics")).toBe("panic: kaboom [recovered, repanicked]"));
  test("the first line is one bounded line", () => {
    for (const t of failRun("a")) {
      const h = t.message.split("\n")[0]!;
      expect(h.length).toBeLessThanOrEqual(500);
    }
  });
});

describe("before and after on Go failures", () => {
  const runOf = (r: "a" | "b" | "variant"): BeforeRun => ({ results: failRun(r), output: "", timedOut: false });
  const file = (name: string) => failOf("a", name).fileAttr;
  test("two testify failures at the same line do not compare the same", () => {
    for (const name of ["TestEqualValue", "TestListing"]) {
      expect(judgeBefore(failOf("variant", name), file(name), [runOf("a"), runOf("a")]).status).toBe("changed");
    }
  });
  test("the same failure in two runs with other addresses, ports, paths and timings compares the same", () => {
    for (const name of ["TestSlowHandler", "TestEqualValue", "TestUpload", "TestTable"]) {
      expect(judgeBefore(failOf("b", name), file(name), [runOf("a"), runOf("a")]).status).toBe("pre-existing");
    }
  });
  test("a baseline recorded with the old first lines still loads", () => {
    const old = `{"version":1,"projects":{"main":[{"id":"p/x_test.go::TestA","file":"p/x_test.go","first":"x_test.go:438:"},` +
      `{"id":"p/x_test.go::TestB","file":"p/x_test.go","first":"helper.go:36: x_test.go:120:"}]}}`;
    expect(parseBaseline(old).get("main")!.map((t) => t.first)).toEqual(["x_test.go:438:", "helper.go:36: x_test.go:120:"]);
  });
});

test("a failing test with a long output is read in linear time", () => {
  const ev = (o: object) => JSON.stringify({ Package: "example.com/events", ...o });
  const lines = [ev({ Action: "start" }), ev({ Action: "run", Test: "TestLong" })];
  for (let i = 0; i < 50000; i++) lines.push(ev({ Action: "output", Test: "TestLong", Output: `    long_test.go:${i}: line ${i}\n` }));
  lines.push(ev({ Action: "fail", Test: "TestLong" }), ev({ Action: "fail" }));
  lines.push("#arnx-module example.com/events", "#arnx-test long_test.go:func TestLong(t *testing.T) {");
  const t = performance.now();
  const r = parseGoReport(lines.join("\n") + "\n")!;
  expect(performance.now() - t).toBeLessThan(5000);
  expect(r[0]!.message.split("\n")[0]).toBe("long_test.go:49999: line 49999");
});
