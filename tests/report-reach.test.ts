// arnx adds the runner's report options after {targets}. A test_command whose runner does not get them is refused
// before any Docker work; deps_dir links node_modules so test_command needs no wrapper; a report a project's own
// configuration sends elsewhere under /src is read there; a run with no report says why.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { python } from "../src/adapters/python";
import { typescript } from "../src/adapters/typescript";
import { commandPaths } from "../src/baked";
import { parseReviewFile, targetsGoTo } from "../src/config";
import { runTests } from "../src/outcomes";
import { depsLink, type Runner, type RunResult } from "../src/sandbox";
import { noReport } from "../src/setup";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const file = (language: string, runner: string, command: string, extra = "") => "version: 1\nprojects:\n  app:\n" +
  `    root: .\n    language: ${language}\n    runner: ${runner}\n    image: img\n    test_command: ${JSON.stringify(command)}\n${extra}`;
const said = (yaml: string) => {
  try {
    parseReviewFile(yaml);
    return "";
  } catch (e) {
    return (e as Error).message;
  }
};

test("a test_command whose {targets} goes to another command than the runner is refused, naming that command", () => {
  for (const c of ["sh -c 'npx vitest run \"$@\"' _ {targets}", "npx vitest run; echo {targets}",
    "sh -c 'ln -sfn /opt/deps/node_modules node_modules && npx vitest run --project unit' _ {targets}"]) {
    expect([c, said(file("typescript", "vitest", c))]).toEqual([c, expect.stringContaining("{targets} goes to `")]);
  }
  expect(said(file("typescript", "vitest", "sh -c 'npx vitest run \"$@\"' _ {targets}"))).toBe("review.yaml: " +
    "projects.app.test_command: {targets} goes to `sh -c 'npx vitest run \"$@\"' _ {targets}`, not to vitest: arnx " +
    "adds the runner's report options after {targets}, so no report would be written. Call the runner itself with " +
    "{targets} (make build && <runner> {targets})");
  expect(said(file("python", "pytest", "bash -c 'python -m pytest \"$@\"' x {targets}"))).toContain("not to pytest");
  expect(said(file("rust", "nextest", "env A=1 sh -c 'cargo nextest run' {targets}")))
    .toContain("not to cargo-nextest");
  for (const [language, runner, c] of [["typescript", "vitest", "cd app && npx vitest run {targets}"],
    ["typescript", "vitest", "ln -sfn /opt/deps/node_modules node_modules && timeout 120 npx vitest run {targets}"],
    ["typescript", "jest", "env -u CI npx jest --runInBand {targets}"],
    ["typescript", "vitest", "/opt/link.sh; npx vitest run --config 'a b.ts' {targets}"],
    ["typescript", "node", "sh -c 'node --test' {targets}"],
    ["python", "pytest", "echo y | python -m pytest -k \"a;b\" {targets} 2>&1"],
    ["python", "pytest", "python -m pytest $(cat args) {targets}"],
    ["rust", "nextest", "cargo nextest run {targets}"]]) {
    expect([c, said(file(language!, runner!, c!))]).toEqual([c, ""]);
  }
  // One message, the first that applies; a TypeScript one that links node_modules is told of deps_dir.
  const quoted = said(file("typescript", "vitest", "sh -c 'ln -sfn /opt/deps/node_modules node_modules && " +
    "npx vitest run {targets}'"));
  expect(quoted).toContain("{targets} is inside quotes");
  expect(quoted).not.toContain("goes to");
  expect(quoted).toEndWith("; to link node_modules, set deps_dir instead");
  expect(targetsGoTo("a && b {targets} | c", /\bb\b/)).toBeNull();
  expect(targetsGoTo("b x; a {targets}", /\bb\b/)).toBe("a {targets}");
});

test("deps_dir: an absolute path outside /src, for typescript projects only", () => {
  const ok = parseReviewFile(file("typescript", "vitest", "npx vitest run {targets}", "    deps_dir: /opt/deps/\n"));
  expect(ok.projects[0]!.depsDir).toBe("/opt/deps");
  for (const d of ["opt/deps", "/src/deps", "/src", "/opt/a b"]) {
    expect(said(file("typescript", "vitest", "npx vitest run {targets}", `    deps_dir: "${d}"\n`)))
      .toContain("deps_dir: must be an absolute path in the image outside /src");
  }
  expect(said(file("python", "pytest", "python -m pytest {targets}", "    deps_dir: /opt/deps\n")))
    .toContain("deps_dir: only for typescript projects");
  expect(parseReviewFile(file("typescript", "vitest", "npx vitest run {targets}")).projects[0]!.depsDir)
    .toBeUndefined();
  expect(commandPaths({ testCommand: "npx vitest run {targets}", env: {}, depsDir: "/opt/app" }))
    .toEqual(["/opt/app/node_modules"]);
});

test("a run links each node_modules under deps_dir into the same place under the install root, once", () => {
  const root = tmp();
  for (const d of ["deps/node_modules/x", "deps/packages/a/node_modules/y", "deps/node_modules/z/node_modules",
    "deps/.git/node_modules", "src/web/packages/a", "src/web/packages/b/node_modules"]) {
    mkdirSync(join(root, d), { recursive: true });
  }
  expect(depsLink({ installRoot: "web" })).toBe("");
  const link = depsLink({ depsDir: join(root, "deps"), installRoot: "web" }).replaceAll("t=/src/web/",
    `t=${root}/src/web/`);
  for (let i = 0; i < 2; i++) expect(spawnSync("sh", ["-c", `${link}echo ran`], { encoding: "utf8" }).stdout).toBe("ran\n");
  expect(readlinkSync(join(root, "src/web/node_modules"))).toBe(join(root, "deps/node_modules"));
  expect(readlinkSync(join(root, "src/web/packages/a/node_modules"))).toBe(join(root, "deps/packages/a/node_modules"));
  expect(lstatSync(join(root, "src/web/packages/b/node_modules")).isSymbolicLink()).toBe(false);
  expect(existsSync(join(root, "src/web/.git"))).toBe(false);
  const missing = spawnSync("sh", ["-c", depsLink({ depsDir: "/nonexistent-arnx", installRoot: "." })],
    { encoding: "utf8" });
  expect(missing.stderr).toBe("arnx: deps_dir /nonexistent-arnx is not in the image\n");
});

const XML = '<?xml version="1.0"?><testsuites><testsuite name="a.test.ts"><testcase classname="a.test.ts" ' +
  'name="adds" file="a.test.ts"></testcase></testsuite></testsuites>';

/** A run that writes the report where `writeTo` says (a path under /src) and prints `output`. */
function oneRun(snap: string, writeTo: string | null, output: string): Runner {
  return {
    run: (): RunResult => {
      if (writeTo) {
        mkdirSync(join(snap, writeTo, ".."), { recursive: true });
        writeFileSync(join(snap, writeTo), XML);
      }
      return { exitCode: 0, output, timedOut: false, seconds: 1 };
    },
  };
}

test("vitest keeps a configuration's own junit outputFile: the report is read where vitest says it wrote it", () => {
  const snap = tmp();
  const cfg = parseReviewFile(file("typescript", "vitest", "npx vitest run {targets}")).projects[0]!;
  const elsewhere = "test-results/junit.xml";
  const [, results] = runTests(oneRun(snap, elsewhere, `JUNIT report written to /src/${elsewhere}\n`), snap, cfg, [],
    "suite.xml", 60);
  expect(results!.map((t) => t.testId)).toEqual(["a.test.ts::adds"]);
  expect(existsSync(join(snap, elsewhere))).toBe(false);
  // Outside the code under test, or not said: no report.
  expect(runTests(oneRun(snap, null, "JUNIT report written to /tmp/junit.xml\n"), snap, cfg, [], "suite.xml", 60)[1])
    .toBeNull();
  expect(runTests(oneRun(snap, elsewhere, "done\n"), snap, cfg, [], "suite.xml", 60)[1]).toBeNull();
});

test("a report written elsewhere is cleaned like arnx's own: what it quotes of sandbox-only files goes", () => {
  const snap = tmp();
  const cfg = parseReviewFile(file("typescript", "vitest", "npx vitest run {targets}")).projects[0]!;
  const elsewhere = "test-results/junit.xml";
  const xml = '<testsuites><testsuite name="a.test.ts"><testcase classname="a.test.ts" name="reads" file="a.test.ts">' +
    '<failure message="expected token=fixture-only-value">token=fixture-only-value</failure></testcase></testsuite>' +
    "</testsuites>";
  const runner: Runner = {
    run: (): RunResult => {
      mkdirSync(join(snap, "test-results"), { recursive: true });
      writeFileSync(join(snap, elsewhere), xml);
      return { exitCode: 1, output: `JUNIT report written to /src/${elsewhere}\n`, timedOut: false, seconds: 1 };
    },
    clean: (report) => report.replaceAll("token=fixture-only-value", "[sandbox-only file content]"),
  };
  const [, results] = runTests(runner, snap, cfg, [], "suite.xml", 60);
  expect(results![0]!.message).not.toContain("fixture-only-value");
});

test("a run with no report says its exit, whether the runner got arnx's report option, and its last lines", () => {
  const cfg = (language: string, runner: string, c: string) => parseReviewFile(file(language, runner, c)).projects[0]!;
  const vitest = cfg("typescript", "vitest", "npx vitest run {targets}");
  const run = (output: string, timedOut = false): RunResult => ({ exitCode: timedOut ? null : 0, output, timedOut,
    seconds: 600.2 });
  expect(noReport(run("a\n\n b \nc\nd\n"), vitest)).toBe("the suite produced no report (exit 0; vitest never said it " +
    "wrote one, so it stopped first or missed arnx's report option); last lines: b | c | d");
  expect(noReport(run("JUNIT report written to /tmp/j.xml"), vitest)).toBe("the suite produced no report (exit 0; " +
    "vitest got arnx's report option but wrote /tmp/j.xml, which arnx could not read); last lines: JUNIT report " +
    "written to /tmp/j.xml");
  expect(noReport(run("", true), vitest)).toBe("the suite produced no report (timed out after 600 s)");
  // Runners that never say where they wrote: no word on it.
  expect(noReport(run("x"), cfg("rust", "nextest", "cargo nextest run {targets}")))
    .toBe("the suite produced no report (exit 0); last lines: x");
  expect(noReport(run("x"), cfg("typescript", "bun", "bun test {targets}")))
    .toBe("the suite produced no report (exit 0); last lines: x");
});

test("where each runner says it wrote its report", () => {
  expect(typescript.reportSaid!("JUNIT report written to /src/a.xml\nJUNIT report written to /src/b.xml \n", "vitest"))
    .toBe("/src/b.xml");
  expect(typescript.reportSaid!("Test results written to: ../.arnx-run/suite.xml\n", "jest"))
    .toBe("../.arnx-run/suite.xml");
  expect(typescript.reportSaid!("ok", "vitest")).toBeNull();
  expect(typescript.reportSaid!("ok", "node")).toBeUndefined();
  expect(python.reportSaid!("---- generated xml file: /src/.arnx-run/suite.xml ----\n", "pytest"))
    .toBe("/src/.arnx-run/suite.xml");
});
