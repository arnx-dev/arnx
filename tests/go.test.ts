import { afterEach, expect, spyOn, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { go } from "../src/adapters/go";
import { Workspace } from "../src/agent";
import { python } from "../src/adapters/python";
import { reviewGroup } from "../src/check";
import { parseReviewConfig } from "../src/config";
import { probeListed } from "../src/precheck";
import { probeRun } from "../src/testround";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();
afterEach(() => { spyOn(python, "probes").mockRestore(); });

test("a generated file sits alone in a folder named after it", () => {
  expect(go.pathProblem!("a_arnx/a_arnx_test.go")).toBeNull();
  expect(go.pathProblem!("a_arnx_test.go")).not.toBeNull();
  expect(go.pathProblem!("a_arnx/b_arnx_test.go")).not.toBeNull();
  expect(go.pathProblem!("x/a_arnx/a_arnx_test.go")).not.toBeNull();
});

test("an accepted file keeps the review id and its own folder", () => {
  const path = go.acceptedPath("x", "20261109_abc123", "tests/arnx", "pays");
  expect(path).toBe("tests/arnx/r20261109_abc123/pays_arnx/pays_arnx_test.go");
  expect(reviewGroup(`.arnx/tests/${path}`)).toBe("r20261109_abc123");
  expect(go.testStem("pays_arnx_test.go")).toBe("pays");
  expect(go.kept).toBeUndefined();
});

test("only the fixed ending is writable, so a stem cannot pick a build constraint", () => {
  expect(go.writable.test("foo_windows_test.go")).toBe(false);
  expect(go.writable.test("foo_windows_arnx_test.go")).toBe(true);
  expect(go.isTestFile("foo_arnx_test.go")).toBe(true);
  expect(go.isTestFile("foo_test.go")).toBe(false);
  expect(go.isSupportFile("foo_arnx_test.go")).toBe(false);
});

test("a stem Go would ignore is not writable", () => {
  for (const name of ["_u_arnx_test.go", "__arnx_test.go", "_arnx_test.go"]) {
    expect(go.writable.test(name)).toBe(false);
    expect(go.isTestFile(name)).toBe(false);
  }
  for (const name of ["u_arnx_test.go", "a_b_arnx_test.go", "0a_arnx_test.go"]) expect(go.writable.test(name)).toBe(true);
});

test("the table's fixed values", () => {
  expect(go.id as string).toBe("go");
  expect(go.runners).toEqual(["gotest"]);
  expect(go.defaultRunner).toBe("gotest");
  expect(go.defaultTestsDir).toBe("arnx_generated");
  expect(go.manifests).toEqual(["go.mod", "go.sum", "go.work", "go.work.sum"]);
  expect(go.nestedManifests).toBe(true);
  expect(go.buildEnv).toEqual(["GOTOOLCHAIN=local", "GOFLAGS=-buildvcs=false", "GOCACHE=/opt/arnx-gocache"]);
  expect(go.runEnv).toEqual([...go.buildEnv, "GOPROXY=off"]);
  expect(go.postInstall).toEqual(["mkdir -p /opt/arnx-gocache && chmod -R a+rwX /opt/arnx-gocache /go"]);
  expect(go.downloadCache).toBeUndefined();
  const w = go.words("gotest");
  expect(w.propertyLib).toBe("testing/quick");
  expect(w.imageExample).toBe("golang:1.26-bookworm");
  expect(w.installExample).toBe("go mod download && { go test -vet=off -run '^$' ./... || true; }");
  expect(w.commandExample).toBe("go test {targets}");
});

test("the model is told the rules of a generated file", () => {
  const w = go.words("gotest");
  for (const text of [w.testFiles, w.writableFiles]) {
    for (const rule of ["<name>_arnx/<name>_arnx_test.go", "package arnx", "module path", "exported names", "go.mod"]) {
      expect(text).toContain(rule);
    }
  }
});

test("the probe is its own test-only package in its own folder", () => {
  const [probe, ...rest] = go.probes("gotest");
  expect(rest).toEqual([]);
  expect(probe!.file).toBe("arnx_probe_arnx/arnx_probe_arnx_test.go");
  expect(go.pathProblem!(probe!.file)).toBeNull();
  expect(probe!.source).toContain("package arnx");
  expect(probe!.source).toMatch(/func Test\w+\(t \*testing\.T\) \{\}/);
});

test("drop removes nothing, so accept falls back to skip", () => {
  expect(go.drop("src", new Set(["TestA"]))).toEqual({ text: "src", left: new Set(["TestA"]) });
});

test("skip goes first in each named test and leaves the others", () => {
  expect(go.skip("func TestA(t *testing.T) {\n}\n", new Set(["TestA"]), "why")).toContain('t.Skip("why")');
  const out = go.skip("func TestA(t *testing.T) {\n\tf()\n}\n\nfunc TestB(t *testing.T) {\n\tg()\n}\n", new Set(["TestA"]), 'a "b"');
  expect(out).toBe('func TestA(t *testing.T) {\n\tt.Skip("a \\"b\\"")\n\tf()\n}\n\nfunc TestB(t *testing.T) {\n\tg()\n}\n');
});

test("skip uses the test's own parameter, and gives a blank one a name", () => {
  expect(go.skip("func TestA(tt *testing.T) {\n}\n", new Set(["TestA"]), "why")).toContain('tt.Skip("why")');
  expect(go.skip("func TestA(_ *testing.T) {\n}\n", new Set(["TestA"]), "why"))
    .toBe('func TestA(t *testing.T) {\n\tt.Skip("why")\n}\n');
});

test("skip reaches a test with a non-ASCII name", () => {
  expect(go.skip("func TestÜber(t *testing.T) {\n\tf()\n}\n", new Set(["TestÜber"]), "why"))
    .toBe('func TestÜber(t *testing.T) {\n\tt.Skip("why")\n\tf()\n}\n');
});

test("skip keeps what followed the brace on a line of its own", () => {
  const skipA = (source: string) => go.skip(source, new Set(["TestA"]), "why");
  expect(skipA("func TestA(t *testing.T) { f() }\n")).toBe('func TestA(t *testing.T) {\n\tt.Skip("why")\n\tf() }\n');
  expect(skipA("func TestA(t *testing.T) {}\n")).toBe('func TestA(t *testing.T) {\n\tt.Skip("why")\n\t}\n');
  expect(skipA("func TestA(t *testing.T) { // note\n\tf()\n}\n"))
    .toBe('func TestA(t *testing.T) {\n\tt.Skip("why")\n\t// note\n\tf()\n}\n');
});

const gofmtOk = (source: string): boolean => {
  const r = spawnSync("gofmt", ["-e"], { input: source, encoding: "utf8" });
  return r.error ? true : r.status === 0;
};

test("skip handles a brace with no space", () => {
  const out = go.skip("package a\n\nfunc TestA(t *testing.T){\n\tf()\n}\n", new Set(["TestA"]), "why");
  expect(out).toBe('package a\n\nfunc TestA(t *testing.T) {\n\tt.Skip("why")\n\tf()\n}\n');
  expect(gofmtOk(out)).toBe(true);
  expect(go.skip("func TestA(t *testing.T){}\n", new Set(["TestA"]), "why")).toBe('func TestA(t *testing.T) {\n\tt.Skip("why")\n\t}\n');
});

test("skip handles an unnamed parameter", () => {
  const skipA = (source: string) => go.skip(source, new Set(["TestA"]), "why");
  const out = skipA("package a\n\nfunc TestA(*testing.T) {\n\tf()\n}\n");
  expect(out).toBe('package a\n\nfunc TestA(t *testing.T) {\n\tt.Skip("why")\n\tf()\n}\n');
  expect(gofmtOk(out)).toBe(true);
  expect(skipA("func TestA(*testing.T){\n}\n")).toBe('func TestA(t *testing.T) {\n\tt.Skip("why")\n}\n');
});

test("skip gives an unnamed or blank parameter a name the body does not use", () => {
  const skipA = (source: string) => go.skip(source, new Set(["TestA"]), "why");
  for (const sig of ["*testing.T", "_ *testing.T"]) {
    const out = skipA(`package a\n\nfunc TestA(${sig}) {\n\tt := 1\n\t_ = t\n}\n`);
    expect(out).toContain('func TestA(arnxT *testing.T) {\n\tarnxT.Skip("why")\n\tt := 1');
    expect(gofmtOk(out)).toBe(true);
  }
  // A `t` in another test does not matter.
  expect(skipA("func TestA(*testing.T) {\n}\n\nfunc TestB(t *testing.T) {\n\tt.Log()\n}\n")).toContain("func TestA(t *testing.T)");
});

test("CRLF sources are skipped the same way", () => {
  const skipA = (source: string) => go.skip(source, new Set(["TestA"]), "why");
  expect(skipA("func TestA(t *testing.T) {\r\n\tf()\r\n}\r\n")).toBe('func TestA(t *testing.T) {\n\tt.Skip("why")\r\n\tf()\r\n}\r\n');
  expect(skipA("func TestA(*testing.T){\r\n}\r\n")).toBe('func TestA(t *testing.T) {\n\tt.Skip("why")\r\n}\r\n');
  expect(gofmtOk(skipA("package a\r\n\r\nfunc TestA(t *testing.T){\r\n\tf()\r\n}\r\n"))).toBe(true);
});

test("a test command needs go test and {targets}", () => {
  expect(go.validateCommand("go test ./...", "gotest").length).toBeGreaterThan(0);
  expect(go.validateCommand("pytest {targets}", "gotest").length).toBeGreaterThan(0);
  expect(go.validateCommand("go test {targets}", "gotest")).toEqual([]);
  expect(go.runs("gotest").test("cd a && go test {targets}")).toBe(true);
});

test("files become their packages, once each", () => {
  const cmd = go.command("go test {targets}", ["arnx_generated/a_arnx/a_arnx_test.go", "arnx_generated/a_arnx/a_arnx_test.go"], "/r.json", "gotest");
  expect(cmd).toContain("-json -count=1 -vet=off");
  expect(cmd.match(/\.\/arnx_generated\/a_arnx/g)!.length).toBe(1);
  expect(cmd).not.toContain("{targets}");
  expect(go.command("go test {targets}", ["a_arnx_test.go"], "/r.json", "gotest")).toContain("-vet=off . >");
});

test("no target, or a directory target, runs every package", () => {
  expect(go.command("go test {targets}", [], "/r.json", "gotest")).toContain("./...");
  expect(go.command("go test {targets}", ["arnx_generated"], "/r.json", "gotest")).toContain("-vet=off ./... >");
  expect(go.command("go test {targets}", ["arnx_generated", "b/x_test.go"], "/r.json", "gotest")).toContain("-vet=off ./... >");
});

// A stand-in for go: the shell the command builds runs for real, and what it writes goes through the parser.
const EVENTS = [
  { Action: "run", Package: "example.com/m/arnx_generated/a_arnx", Test: "TestA" },
  { Action: "fail", Package: "example.com/m/arnx_generated/a_arnx", Test: "TestA" },
  { Action: "fail", Package: "example.com/m/arnx_generated/a_arnx" },
  { Action: "run", Package: "example.com/m", Test: "TestRoot" },
  { Action: "pass", Package: "example.com/m", Test: "TestRoot" },
  { Action: "pass", Package: "example.com/m" },
];

function project(goOutput: string, status: number) {
  const repo = join(tmp(), "repo"), bin = join(tmp(), "bin");
  const files: Record<string, string> = {
    "arnx_generated/a_arnx/a_arnx_test.go": "package arnx\n\nfunc TestA(t *testing.T) {}\n",
    "root_test.go": "package m\n\nfunc TestRoot(t *testing.T) {}\n",
  };
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
  mkdirSync(bin);
  writeFileSync(join(tmp(), "events"), goOutput);
  writeFileSync(join(bin, "go"), `#!/bin/bash
if [ "$1" = mod ]; then printf 'module example.com/m\\n\\ngo 1.24\\n'; exit 0; fi
cat ${join(tmp(), "events")}
exit ${status}
`);
  chmodSync(join(bin, "go"), 0o755);
  return { repo, bin };
}

function run(targets: string[], goOutput: string, status: number) {
  const { repo, bin } = project(goOutput, status);
  const report = join(tmp(), "report.json");
  const done = Bun.spawnSync(["bash", "-c", go.command("go test {targets}", targets, report, "gotest")],
    { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  return { status: done.exitCode, text: readFileSync(report, "utf8") };
}

const lines = EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n";

test("a package run's declarations reach the parser, and the run's status is kept", () => {
  const { status, text } = run(["arnx_generated/a_arnx/a_arnx_test.go"], lines, 1);
  expect(status).toBe(1);
  expect(text).toContain("#arnx-module example.com/m");
  const a = go.parseReport(text, "gotest", ".")!.find((r) => r.name === "TestA")!;
  expect([a.fileAttr, a.outcome]).toEqual(["arnx_generated/a_arnx/a_arnx_test.go", "failed"]);
});

test("a run of every package declares them all, the module's root too", () => {
  const { status, text } = run([], lines, 0);
  expect(status).toBe(0);
  const seen = go.parseReport(text, "gotest", ".")!.map((r) => [r.fileAttr, r.name, r.outcome]);
  expect(seen).toContainEqual(["arnx_generated/a_arnx/a_arnx_test.go", "TestA", "failed"]);
  expect(seen).toContainEqual(["root_test.go", "TestRoot", "passed"]);
});

test("a report cut in mid-line keeps its module line", () => {
  const { text } = run(["arnx_generated/a_arnx/a_arnx_test.go"], `${lines}{"Action":"ou`, 2);
  expect(text.split("\n")).toContain("#arnx-module example.com/m");
  expect(go.parseReport(text, "gotest", ".")!.some((r) => r.name === "TestA")).toBe(true);
});

const nested = [{ file: "sub_arnx/test_probe.py", source: "def test_probe(): pass\n" }];
const lookingAt = (snap: string, seen: boolean[]) => ({ run: async () => {
  seen.push(existsSync(join(snap, "gen/sub_arnx/test_probe.py")));
  return { exitCode: 0, output: "", timedOut: false, seconds: 0 };
} });
const cfgDot = () => parseReviewConfig(CFG.replace("workdir: app", "workdir: ."));

test("probeRun writes a probe whose file holds a subfolder, and removes it", async () => {
  spyOn(python, "probes").mockReturnValue(nested);
  const snap = join(tmp(), "repo");
  mkdirSync(snap);
  const seen: boolean[] = [];
  await probeRun(lookingAt(snap, seen), snap, cfgDot(), "gen", "probe.xml", 60);
  expect(seen).toEqual([true]);
  expect(existsSync(join(snap, "gen/sub_arnx/test_probe.py"))).toBe(false);
});

test("probeListed writes a probe whose file holds a subfolder, and removes it", async () => {
  spyOn(python, "probes").mockReturnValue(nested);
  const snap = join(tmp(), "repo");
  mkdirSync(snap);
  const seen: boolean[] = [];
  await probeListed(lookingAt(snap, seen), snap, { ...cfgDot(), testsDir: "gen" });
  expect(seen).toEqual([true]);
  expect(existsSync(join(snap, "gen/sub_arnx/test_probe.py"))).toBe(false);
});

test("the #arnx-test listing follows Go's rule for what is a test", () => {
  const dir = tmp();
  writeFileSync(join(dir, "a_test.go"), "func Testdata() string { return \"\" }\nfunc TestA(t *testing.T) {}\nfunc Test_b(t *testing.T) {}\n");
  const listing = /find .*?sed 's[^']*'/.exec(go.command("go test {targets}", [], "/dev/null", "gotest"))![0];
  const out = spawnSync("sh", ["-c", listing], { cwd: dir, encoding: "utf8" }).stdout;
  expect(out).toContain("func TestA(");
  expect(out).toContain("func Test_b(");
  expect(out).not.toContain("Testdata");
});

test("the agent's listings skip vendor/ for Go only and keep testdata/ visible", async () => {
  const root = tmp();
  for (const f of ["vendor/x/a.go", "testdata/b.go", "lib/c.go"]) {
    mkdirSync(join(root, dirname(f)), { recursive: true });
    writeFileSync(join(root, f), "package x // needle\n");
  }
  const goWs = new Workspace(root, { adapter: go, runner: "gotest" });
  expect(await goWs.call("list_dir", { path: "." })).toBe("lib/\ntestdata/");
  const found = await goWs.call("grep", { pattern: "needle" });
  expect(found).toContain("lib/c.go");
  expect(found).toContain("testdata/b.go");
  expect(found).not.toContain("vendor");
  const pyWs = new Workspace(root);
  expect(await pyWs.call("list_dir", { path: "." })).toBe("lib/\ntestdata/\nvendor/");
  expect(await pyWs.call("grep", { pattern: "needle" })).toContain("vendor/x/a.go");
});

