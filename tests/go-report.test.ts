import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseGoReport } from "../src/adapters/go-report";

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
