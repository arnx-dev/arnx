// Files that time out together are run apart: one slow pairing is not a hang, and a file that hangs alone is one
// error that costs the others nothing.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewConfig } from "../src/config";
import { classify, runBounded } from "../src/outcomes";
import type { RunResult, Runner } from "../src/sandbox";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const dir = "tests/arnx_generated";
const FILES = ["a", "b", "c", "d", "e", "f", "g", "h"].map((n) => `${dir}/test_${n}.py`);
const cfg = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest -q {targets}\n");
const LIMITS = { together: 300, file: 180, total: 600 };

/** A fake runner. `slow(files)` says whether a run over exactly these files times out; every other run writes a
 * report with a passing test per file, and a failing one for the files in `failing`. */
class Runs implements Runner {
  calls: { files: string[]; timeout: number }[] = [];
  constructor(readonly snap: string, readonly slow: (files: string[]) => boolean, readonly failing: string[] = []) {}
  run(command: string, timeout: number): RunResult {
    const files = FILES.filter((f) => command.includes(f));
    this.calls.push({ files, timeout });
    if (this.slow(files)) return { exitCode: null, output: `slow ${files.join(",")}`, timedOut: true, seconds: timeout };
    const m = /--junitxml=\/src\/(\S+)/.exec(command)!;
    const path = join(this.snap, m[1]!);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, junitXml(files.map((f) => [f, "test_x", this.failing.includes(f) ? "failed" : "passed",
      "boom"] as [string, string, string, string])));
    return { exitCode: 0, output: `ran ${files.join(",")}`, timedOut: false, seconds: 1 };
  }
}

test("files that hang together are run apart and every result is kept", async () => {
  const s = new Runs(tmp(), (f) => f.length > 1, [FILES[6]!, FILES[7]!]);
  const got = await runBounded(s, tmp(), cfg, FILES, "final-1.xml", LIMITS);
  // together once at 300 s, then each file alone
  expect(s.calls[0]).toEqual({ files: FILES, timeout: 300 });
  expect(s.calls.slice(1).map((c) => c.files)).toEqual(FILES.map((f) => [f]));
  expect(s.calls.slice(1).every((c) => c.timeout <= 180)).toBe(true);
  expect(got.apart).toBe(true);
  expect(got.hung).toEqual([]);
  expect(got.run.timedOut).toBe(false);
  const c = classify([got.results]);
  expect(c.passed.length).toBe(6);
  expect(c.findings.length).toBe(2);
  expect(c.missingRuns).toBe(0);
});

test("a file that hangs alone is one error and the others keep their results", async () => {
  const s = new Runs(tmp(), (f) => f.length > 1 || f[0] === FILES[2]);
  const got = await runBounded(s, tmp(), cfg, FILES, "final-1.xml", LIMITS);
  expect(got.hung).toEqual([FILES[2]!]);
  const errors = got.results!.filter((t) => t.outcome === "error");
  expect(errors.length).toBe(1);
  expect(errors[0]!.fileAttr).toBe(FILES[2]!);
  expect(errors[0]!.message).toBe("did not finish in 180 s; its tests have no result");
  expect(got.results!.filter((t) => t.outcome === "passed").length).toBe(7);
  const c = classify([got.results]);
  expect(c.errors.length).toBe(1);
  expect(c.findings.length).toBe(0);
});

test("a hung file is not run again", async () => {
  const s = new Runs(tmp(), (f) => f[0] === FILES[2]);
  const got = await runBounded(s, tmp(), cfg, FILES, "final-2.xml", { ...LIMITS, apart: true, hung: [FILES[2]!] });
  // file by file, no run together, and the hung file not at all
  expect(s.calls.length).toBe(7);
  expect(s.calls.every((c) => c.files.length === 1 && c.files[0] !== FILES[2])).toBe(true);
  // its error is carried so every repeat reports it
  expect(got.hung).toEqual([FILES[2]!]);
  expect(got.results!.filter((t) => t.outcome === "error").map((t) => t.fileAttr)).toEqual([FILES[2]!]);
});

test("the before check runs apart once the round did", async () => {
  const s = new Runs(tmp(), () => false);
  const got = await runBounded(s, tmp(), cfg, FILES.slice(0, 3), "before-1.xml", { ...LIMITS, apart: true });
  expect(s.calls.map((c) => c.files)).toEqual(FILES.slice(0, 3).map((f) => [f]));
  expect(got.apart).toBe(true);
  expect(got.results!.length).toBe(3);
  // without it, the usual case is one run
  const plain = new Runs(tmp(), () => false);
  const ok = await runBounded(plain, tmp(), cfg, FILES.slice(0, 3), "before-1.xml", LIMITS);
  expect(plain.calls.length).toBe(1);
  expect(ok.apart).toBe(false);
});

test("the whole repeat stays within its limit", async () => {
  const s = new Runs(tmp(), () => true);
  const got = await runBounded(s, tmp(), cfg, FILES, "final-1.xml", LIMITS);
  const asked = s.calls.reduce((sum, c) => sum + c.timeout, 0);
  expect(asked).toBeLessThanOrEqual(600);
  expect(s.calls.every((c) => c.timeout <= 300)).toBe(true);
  // every file ends as an error, none is lost, and no run overlaps another (the fake answers one at a time)
  expect(got.hung.sort()).toEqual([...FILES].sort());
  expect(got.results!.filter((t) => t.outcome === "error").length).toBe(FILES.length);
});

test("a round keeps the files that ran, names the one that hung, saves the log and does not run it twice", async () => {
  const { existsSync, readFileSync } = await import("node:fs");
  const { testRound } = await import("../src/testround");
  const { answerRound, FakeSession, ScriptedAgent, text, tool } = await import("./helpers/fakes");
  const { commit, gitRepo } = await import("./helpers/gitutil");
  const A = `${dir}/test_one.py`, B = `${dir}/test_two.py`;
  const yaml = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
  const config = parseReviewConfig(yaml);
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "x = 1\n");
  commit(repo, "init");
  const body = "def test_x():\n    assert True\n";
  const agent = new ScriptedAgent([[tool("write_file", { path: A, content: body }), tool("write_file", { path: B, content: body })],
    [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))]]);
  const commands: string[] = [];
  const out = join(tmp(), "out");
  const factory = async <T>(_c: unknown, snap: string, _l: string, run: (r: Runner) => Promise<T>) => {
    const s = new FakeSession(snap, (command) => {
      commands.push(command);
      const final = command.includes("final-");
      const both = command.includes(A) && command.includes(B);
      if (final && (both || command.includes(B))) return [null, "stuck", true];
      return [junitXml([[A, "test_x", "passed", ""]]), "ok", false];
    });
    return run(s);
  };
  const r = await testRound(repo, null, config, { ...answerRound(agent, config), writeDir: dir, budgetUsd: 1, runs: 2,
    outDir: out, sessionFactory: factory as never });
  expect(r.hungFiles).toEqual([B]);
  expect(r.classified.errors.map((t) => t.fileAttr)).toEqual([B]);
  expect(r.classified.passed.map((t) => t.fileAttr)).toEqual([A]);
  expect(r.classified.findings).toEqual([]);
  expect(r.classified.missingRuns).toBe(0);
  expect(existsSync(join(out, "final-1.log"))).toBe(true);
  expect(readFileSync(join(out, "final-1.log"), "utf8")).toContain("stuck");
  // the second repeat has nothing left to run
  expect(commands.filter((c) => c.includes("final-2"))).toEqual([]);
});
