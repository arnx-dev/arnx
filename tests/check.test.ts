// check: the accepted tests run in the approved sandbox on the working tree as it is, and say what still fails.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, checkJson, checkSummary } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { dockerSteps, type SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-12T00:00:00Z" };

function repoWithAccepted(): string {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, ".arnx/tests/svc/tests/arnx/r1"), { recursive: true });
  mkdirSync(join(repo, "svc"));
  writeFileSync(join(repo, "svc/calc.py"), "X = 1\n");
  writeFileSync(join(repo, ".arnx/tests/svc/tests/arnx/r1/test_r1_calc.py"), "def test_ok(): pass\ndef test_bug(): assert 0\n");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  return repo;
}

test("check runs the accepted tests and lists what still fails (exit 1), or says all pass (exit 0)", async () => {
  const repo = repoWithAccepted();
  const seen: string[] = [];
  const failing: SessionFactory = async (_c, snap, _l, body) => {
    const s = new FakeSession(snap, () => [junitXml([["tests/arnx/r1/test_r1_calc.py", "test_ok", "passed", ""],
      ["tests/arnx/r1/test_r1_calc.py", "test_bug", "failed", "assert 0"]]), "1 failed", false]);
    const r = await body(s);
    seen.push(...s.commands);
    return r;
  };
  const results = await check(repo, SETTINGS, { sessionFactory: failing });
  expect(results.map((r) => [r.project, r.files, r.passed.length, r.failed.length])).toEqual([
    ["svc", [".arnx/tests/svc/tests/arnx/r1/test_r1_calc.py"], 1, 1]]);
  expect(seen.join(" ")).toContain("tests/arnx/r1/test_r1_calc.py");
  const [text, code] = checkSummary(results);
  expect(code).toBe(1);
  // No review accounts for the file (none here): every test in it counts as accepted.
  expect(text).toBe(["✗ 1 accepted test still fails (bug not fixed yet)", "✓ 1 accepted test passes",
    "  ✗ test_bug  assert 0", "Fix the code, not the accepted tests. A real bug whose test is wrong: mark it rewrite in " +
      "review.md with a `Rewrite:` line saying why (noise only when there is no bug), then " +
      "accept the review that kept it again (`arnx accept --again` with its id; `ls .arnx/reviews` lists them).", "Next: arnx check"].join("\n"));
  const [ok, okCode] = checkSummary([{ ...results[0]!, failed: [], passed: ["a", "b"], accepted: ["a", "b"] }]);
  expect(okCode).toBe(0);
  expect(ok).toBe(["✓ All 2 accepted tests pass", "✓ Accepted tests unchanged since arnx accept",
    "Commit the fixes, the accepted tests and .arnx/accepted-tests.json together."].join("\n"));
});

test("check shows an image build in its progress, and leaves Docker's progress line unset after", async () => {
  const repo = repoWithAccepted();
  const said: string[] = [];
  const building: SessionFactory = async (c, snap, _l, body) => {
    dockerSteps.say?.(`${c.name}: building its test image (minutes on a first build)`);
    return body(new FakeSession(snap, () => [junitXml([["tests/arnx/r1/test_r1_calc.py", "test_ok", "passed", ""]]),
      "", false]));
  };
  await check(repo, SETTINGS, { sessionFactory: building, progress: (m) => said.push(m) });
  expect(said).toContain("svc: building its test image (minutes on a first build)");
  expect(dockerSteps.say).toBeNull();
});

test("check with nothing accepted says to accept first (exit 3)", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  const [text, code] = checkSummary(await check(repo, SETTINGS, { sessionFactory: async () => { throw new Error("no"); } }));
  expect([text, code]).toEqual(["No accepted tests yet: arnx accept keeps them after a review.", 3]);
});

test("a kept file the runner reports nothing for is named as not run, and stays in the file count", async () => {
  const repo = repoWithAccepted();
  writeFileSync(join(repo, ".arnx/tests/svc/tests/arnx/r1/test_other.py"), "def test_o(): pass\n");
  const quiet: SessionFactory = async (_c, snap, _l, body) => body(new FakeSession(snap,
    () => [junitXml([["tests/arnx/r1/test_r1_calc.py", "test_ok", "passed", ""]]), "1 passed", false]));
  const results = await check(repo, SETTINGS, { sessionFactory: quiet });
  expect(results[0]!.files.length).toBe(2);
  expect(results[0]!.notRun).toEqual([".arnx/tests/svc/tests/arnx/r1/test_other.py"]);
  expect(checkSummary(results)[0]).toContain("✗ 1 accepted test file did not run, the runner leaves it out: " +
    "svc/tests/arnx/r1/test_other.py");
  const [text, code] = checkSummary(results);
  expect(code).toBe(2);
  expect(text).not.toContain("Accepted tests unchanged");
  expect(text).not.toContain("Commit the fixes");
  expect(JSON.parse(checkJson(results, code)).result).toBe("no-report");
});

/** A repository whose accepted files are stored as accept stores them (`.arnx` appended), plus `extra` as given. */
function repoWithStored(extra: Record<string, string> = {}): string {
  const repo = gitRepo(tmp());
  const dir = ".arnx/tests/svc/tests/arnx/r1";
  mkdirSync(join(repo, dir), { recursive: true });
  mkdirSync(join(repo, "svc"));
  writeFileSync(join(repo, "svc/calc.py"), "X = 1\n");
  writeFileSync(join(repo, dir, "test_r1_calc.py.arnx"), "def test_bug(): assert 0\n");
  writeFileSync(join(repo, dir, "conftest.py.arnx"), "import pytest\n");
  for (const [p, text] of Object.entries(extra)) writeFileSync(join(repo, p), text);
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  return repo;
}

/** What the run saw: the copy's files under the kept folder, and the commands. */
function watching(seen: { files: string[]; commands: string[] }, report: [string, string, string, string][]): SessionFactory {
  return async (_c, snap, _l, body) => {
    const s = new FakeSession(snap, () => [junitXml(report), "", false]);
    seen.files.push(...readdirSync(join(snap, "svc/tests/arnx/r1")).sort());
    const r = await body(s);
    seen.commands.push(...s.commands);
    return r;
  };
}

test("check places suffixed files under their run names", async () => {
  const repo = repoWithStored();
  const seen = { files: [] as string[], commands: [] as string[] };
  const results = await check(repo, SETTINGS, { sessionFactory: watching(seen,
    [["tests/arnx/r1/test_r1_calc.py", "test_bug", "failed", "assert 0"]]) });
  // In the copy only: each file under the name it runs by, the support file too; nothing suffixed beside them.
  expect(seen.files).toEqual(["conftest.py", "test_r1_calc.py"]);
  expect(seen.commands.join(" ")).toContain("tests/arnx/r1/test_r1_calc.py");
  expect(seen.commands.join(" ")).not.toContain("test_r1_calc.py.arnx");
  expect(results.map((r) => [r.files, r.failed.length, r.notRun])).toEqual([
    [[".arnx/tests/svc/tests/arnx/r1/test_r1_calc.py.arnx"], 1, undefined]]);
  // The repository keeps the stored names only.
  expect(existsSync(join(repo, "svc/tests"))).toBe(false);
});

test("check also runs a kept file stored without the suffix", async () => {
  // An older arnx's file, beside one stored as accept stores them now: both run, each under its run name.
  const repo = repoWithStored({ ".arnx/tests/svc/tests/arnx/r1/test_old.py": "def test_old(): pass\n" });
  const seen = { files: [] as string[], commands: [] as string[] };
  const results = await check(repo, SETTINGS, { sessionFactory: watching(seen,
    [["tests/arnx/r1/test_r1_calc.py", "test_bug", "failed", "assert 0"], ["tests/arnx/r1/test_old.py", "test_old", "passed", ""]]) });
  expect(seen.files).toEqual(["conftest.py", "test_old.py", "test_r1_calc.py"]);
  expect(seen.commands.join(" ")).toContain("tests/arnx/r1/test_old.py");
  expect(results.map((r) => [r.files, r.passed.length, r.failed.length, r.notRun])).toEqual([
    [[".arnx/tests/svc/tests/arnx/r1/test_old.py", ".arnx/tests/svc/tests/arnx/r1/test_r1_calc.py.arnx"], 1, 1, undefined]]);
});

test("a kept file stored both ways runs once when the copies are the same; two that differ are never chosen between",
  async () => {
  // An older arnx's copy beside the one accept stores now, the same: placed once, listed once.
  const repo = repoWithStored({ ".arnx/tests/svc/tests/arnx/r1/test_r1_calc.py": "def test_bug(): assert 0\n" });
  let placed = "";
  const session: SessionFactory = async (_c, snap, _l, body) => {
    placed = readFileSync(join(snap, "svc/tests/arnx/r1/test_r1_calc.py"), "utf8");
    return body(new FakeSession(snap, () => [junitXml([["tests/arnx/r1/test_r1_calc.py", "test_bug", "failed", "assert 0"]]),
      "", false]));
  };
  const results = await check(repo, SETTINGS, { sessionFactory: session });
  expect(placed).toBe("def test_bug(): assert 0\n");
  expect(results[0]!.files).toEqual([".arnx/tests/svc/tests/arnx/r1/test_r1_calc.py.arnx"]);
  // Copies that differ: nothing runs, both are named.
  writeFileSync(join(repo, ".arnx/tests/svc/tests/arnx/r1/test_r1_calc.py"), "def test_bug(): pass\n");
  placed = "";
  await expect(check(repo, SETTINGS, { sessionFactory: session })).rejects.toThrow(
    "stored under two names that differ (.arnx/tests/svc/tests/arnx/r1/test_r1_calc.py.arnx and the same without .arnx)");
  expect(placed).toBe("");
});
