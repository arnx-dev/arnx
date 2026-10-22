// Accepted tests are pinned: accept records each file's sha256, and check refuses to run (exit 4) when one was edited
// or deleted since, so nobody (a coding agent included) makes `arnx check` pass by changing the tests.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTED_RECORD, localPinsPath, TESTS_CHANGED } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { save } from "../src/report";
import type { SessionFactory } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const KEPT = "tests/arnx/r20261011_a1b2c3/test_y.py";

/** A fake sandbox where the accepted test fails, counting its runs. */
function failing(): { sessions: SessionFactory; runs: () => number } {
  let runs = 0;
  const sessions: SessionFactory = async (_c, snap, _l, body) => {
    runs++;
    return body(new FakeSession(snap, () => [junitXml([[KEPT, "test_a", "failed", "assert False"]]), "1 failed",
      false]));
  };
  return { sessions, runs: () => runs };
}

/** A repository with one accepted test (red: the bug is not fixed), an approved environment, and a fake sandbox.
 * `env`: the CLI's environment (a config directory there holds this machine's record of the pins). */
async function accepted(env: Record<string, string> = {}): Promise<{ repo: string; cli: Cli; runs: () => number }> {
  const repo = gitRepo(tmp());
  const { sessions, runs } = failing();
  const cli = new Cli({ cwd: repo, checkSessions: sessions, env });
  await cli.run("init");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  app:
    root: .
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(sampleReview({ id: RID, findings: [finding("F1", "tests/g/test_a.py::test_a", "test_a", "tests/g/test_a.py",
    "x", "y", "confirmed")], questions: [], projects: ["main"], writeDir: "tests/g" }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"), "def test_a():\n    assert False\n");
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8"))
    .replace("Mark: [ ] real", "Mark: [x] real"));
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  return { repo, cli, runs };
}

test("accept records the sha256 of each file it keeps", async () => {
  const { repo } = await accepted();
  const rec = JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8"));
  expect(rec.schema_version).toBe(1);
  expect(Object.keys(rec.files)).toEqual([KEPT]);
  expect(rec.files[KEPT].review).toBe(RID);
  expect(rec.files[KEPT].sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(rec.files[KEPT].tests).toEqual(["test_a"]);
});

test("check refuses an edited accepted test (exit 4) and runs nothing; --keep-edits records it", async () => {
  const { repo, cli, runs } = await accepted();
  expect(await cli.run("check")).toBe(1); // red until the bug is fixed
  expect(runs()).toBe(1);
  writeFileSync(join(repo, KEPT), "def test_a():\n    assert True\n"); // made to pass by editing the test
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(runs()).toBe(1);
  expect(cli.stdout).toBe([ // not committed: no git checkout to offer
    "✗ 1 accepted test file changed since arnx accept; nothing ran:",
    `  modified ${KEPT}`,
    `To restore it: arnx accept --again ${RID} (rewrites it from the review; your edits are lost)`,
    "To keep your edit: arnx accept --keep-edits (records it as the new accepted version; it does not re-prove the bug)",
  ].join("\n"));
  cli.out.length = 0;
  expect(await cli.run("check", "--json")).toBe(TESTS_CHANGED);
  const j = JSON.parse(cli.stdout);
  expect([j.result, j.exit_code, j.changed]).toEqual(["tests-changed", 4,
    [{ path: KEPT, review: RID, change: "modified" }]]);
  expect(await cli.run("accept", "--keep-edits", RID)).toBe(2);
  expect(await cli.run("accept", "--keep-edits")).toBe(0);
  expect(await cli.run("check")).toBe(1);
  expect(runs()).toBe(2);
});

test("check refuses a deleted accepted test; accept --again copies it back and records it", async () => {
  const { repo, cli, runs } = await accepted();
  rmSync(join(repo, KEPT));
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`deleted  ${KEPT}`);
  expect(runs()).toBe(0);
  expect(await cli.run("accept", "--again", "--no-answers", RID)).toBe(0);
  expect(existsSync(join(repo, KEPT))).toBe(true);
  expect(await cli.run("check")).toBe(1);
  expect(runs()).toBe(1);
});

test("a test file accept never recorded is still run (kept by an older arnx)", async () => {
  const { repo, cli, runs } = await accepted();
  rmSync(join(repo, ACCEPTED_RECORD));
  writeFileSync(join(repo, KEPT), "def test_a():\n    assert True\n");
  expect(await cli.run("check")).toBe(1);
  expect(runs()).toBe(1);
});

test("check --json gives each project's passed and failed tests and the overall result", async () => {
  const { cli } = await accepted();
  cli.out.length = 0;
  expect(await cli.run("check", "--json", "--quiet")).toBe(1);
  const j = JSON.parse(cli.stdout);
  expect(j).toEqual({ schema_version: 1, command: "check", result: "fail", exit_code: 1, changed: [], projects: [{ project: "app",
    files: [KEPT], no_report: false, no_report_reason: null, log: null, passed: [], skipped: 0,
    accepted: [`${KEPT}::test_a`],
    failed: [{ test_id: `${KEPT}::test_a`, outcome: "failed", message: "assert False\ntrace", accepted: true }] }] });
});

// --- the record itself: a test edited together with its pin, or its entry removed ---------------------------------------

const REVIEW_TEST = join(".arnx", "reviews", RID, "tests", "tests", "g", "test_a.py");
const WEAK = "def test_a():\n    assert True\n";
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** Edit the accepted test until it passes, and its sha256 in the record to match: what check cannot see by hashes. */
function tamper(repo: string): void {
  writeFileSync(join(repo, KEPT), WEAK);
  const rec = JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8"));
  rec.files[KEPT].sha256 = sha(WEAK);
  writeFileSync(join(repo, ACCEPTED_RECORD), JSON.stringify(rec, null, 2) + "\n");
}

const withConfig = () => ({ XDG_CONFIG_HOME: join(tmp(), "config") });

test("a test edited with its pin is refused (exit 4) when accept recorded it on this machine", async () => {
  const { repo, cli, runs } = await accepted(withConfig());
  tamper(repo);
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(runs()).toBe(0);
  expect(cli.stdout).toContain("✗ 1 accepted test file repinned since arnx accept; nothing ran:\n" +
    `  repinned ${KEPT}: its entry in ${ACCEPTED_RECORD} changed, not by arnx on this machine\n` +
    `To restore it: arnx accept --again ${RID} (rewrites it from the review; your edits are lost)\n`);
  cli.out.length = 0;
  expect(await cli.run("check", "--json")).toBe(TESTS_CHANGED);
  expect(JSON.parse(cli.stdout).changed).toEqual([{ path: KEPT, review: RID, change: "repinned" }]);
});

test("a test edited with its pin is refused against the committed pins, with no record on this machine", async () => {
  const { repo, cli, runs } = await accepted(); // no config directory: a fresh clone, CI, a teammate
  commit(repo, "accepted tests");
  expect(await cli.run("check")).toBe(1);
  tamper(repo);
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`repinned ${KEPT}`);
  // Committed: HEAD holds the accepted version and its pin, so git can restore both.
  expect(cli.stdout).toContain(`(rewrites it from the review; your edits are lost), or git checkout -- ${KEPT} ` +
    `${ACCEPTED_RECORD}\n`);
  expect(runs()).toBe(1);
});

test("an entry removed from the record, or the record deleted, is refused while the test is there", async () => {
  const { repo, cli, runs } = await accepted(withConfig());
  writeFileSync(join(repo, ACCEPTED_RECORD), JSON.stringify({ schema_version: 1, files: {} }) + "\n");
  writeFileSync(join(repo, KEPT), WEAK);
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`  unpinned ${KEPT}: its entry in ${ACCEPTED_RECORD} was removed`);
  rmSync(join(repo, ACCEPTED_RECORD));
  cli.out.length = 0;
  expect(await cli.run("check", "--json")).toBe(TESTS_CHANGED);
  expect(JSON.parse(cli.stdout).changed).toEqual([{ path: KEPT, review: RID, change: "unpinned" }]);
  expect(runs()).toBe(0);
});

test("a record deleted after it was committed is refused, with no record on this machine", async () => {
  const { repo, cli, runs } = await accepted();
  commit(repo, "accepted tests");
  rmSync(join(repo, ACCEPTED_RECORD));
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`unpinned ${KEPT}`);
  expect(runs()).toBe(0);
});

test("an accepted test deleted with its entry is refused, committed or not", async () => {
  const { repo, cli } = await accepted(withConfig());
  rmSync(join(repo, KEPT));
  rmSync(join(repo, ACCEPTED_RECORD));
  expect(await cli.run("check")).toBe(TESTS_CHANGED); // never committed: arnx pinned it here, now it is gone
  expect(cli.stdout).toContain(`unpinned ${KEPT}`);
  expect(await cli.run("accept", "--again", "--no-answers", RID)).toBe(0);
  commit(repo, "accepted tests");
  rmSync(join(repo, KEPT));
  rmSync(join(repo, ACCEPTED_RECORD));
  commit(repo, "drop the test"); // removed by a commit on this branch
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`unpinned ${KEPT}`);
});

test("a test edited with its pin and committed is refused where accept recorded it; --keep-edits records it", async () => {
  const { repo, cli, runs } = await accepted(withConfig());
  commit(repo, "accepted tests");
  tamper(repo);
  commit(repo, "make it pass");
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`repinned ${KEPT}`);
  expect(runs()).toBe(0);
  cli.out.length = 0;
  expect(await cli.run("accept", "--keep-edits")).toBe(0); // a teammate changed it on purpose: the owner says so
  expect(cli.stdout).toContain(`repinned ${KEPT}`);
  expect(await cli.run("check")).toBe(1);
  expect(runs()).toBe(1);
});

test("--keep-edits records an edited committed test, and an entry removed with the test still there", async () => {
  const { repo, cli, runs } = await accepted(withConfig());
  commit(repo, "accepted tests");
  writeFileSync(join(repo, KEPT), "def test_a():\n    assert 1 == 2\n");
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(await cli.run("accept", "--keep-edits")).toBe(0);
  expect(await cli.run("check")).toBe(1); // the new pin differs from HEAD's, but arnx wrote it here
  rmSync(join(repo, ACCEPTED_RECORD));
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(await cli.run("accept", "--keep-edits")).toBe(0);
  expect(JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files[KEPT].review).toBe(RID);
  expect(await cli.run("check")).toBe(1);
  expect(runs()).toBe(2);
});

test("accept --again re-pins a committed test without an alarm", async () => {
  const { repo, cli, runs } = await accepted(withConfig());
  commit(repo, "accepted tests");
  writeFileSync(join(repo, REVIEW_TEST), "def test_a():\n    assert 0\n"); // the review's test, not the accepted one
  expect(await cli.run("accept", "--again", "--no-answers", RID)).toBe(0);
  expect(readFileSync(join(repo, KEPT), "utf8")).toContain("assert 0");
  expect(await cli.run("check")).toBe(1);
  expect(runs()).toBe(1);
});

test("committed pins pass on a fresh clone, and nothing changed is no alarm", async () => {
  const { repo, cli, runs } = await accepted(withConfig());
  commit(repo, "accepted tests");
  expect(await cli.run("check")).toBe(1);
  expect(await cli.run("check")).toBe(1);
  expect(runs()).toBe(2);
  const clone = join(tmp(), "clone");
  runGit(repo, "clone", "-q", repo, clone);
  const other = failing();
  for (const env of [{}, { XDG_CONFIG_HOME: join(tmp(), "teammate") }]) {
    const fresh = new Cli({ cwd: clone, checkSessions: other.sessions, env });
    expect(await fresh.run("check")).toBe(1);
  }
  expect(other.runs()).toBe(2);
});

test("a branch without the accepted tests is no alarm", async () => {
  const { repo, cli } = await accepted(withConfig());
  runGit(repo, "checkout", "-q", "-b", "fix");
  commit(repo, "accepted tests");
  runGit(repo, "checkout", "-q", "main");
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(3);
  runGit(repo, "checkout", "-q", "fix");
  expect(await cli.run("check")).toBe(1);
});

test("--keep-edits that cannot write this machine's record changes nothing (a sandboxed agent cannot run it)", async () => {
  const { repo, cli } = await accepted(withConfig());
  tamper(repo);
  const before = readFileSync(join(repo, ACCEPTED_RECORD), "utf8");
  const blocked = join(tmp(), "blocked");
  writeFileSync(blocked, ""); // a file where the config directory would be: nothing can be written under it
  const sandboxed = new Cli({ cwd: repo, env: { XDG_CONFIG_HOME: blocked } });
  writeFileSync(join(repo, KEPT), "def test_a():\n    assert 1 == 1\n");
  expect(await sandboxed.run("accept", "--keep-edits")).toBe(2);
  expect(sandboxed.stderr).toContain("cannot record the accepted tests in");
  expect(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).toBe(before);
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
});

// --- the accepted tests' ids in the record: edited, they would turn a red accepted test into an "other" one ----------

/** Name no test of the kept file as accepted: its red test would read as another test in the file. */
function untest(repo: string): void {
  const rec = JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8"));
  rec.files[KEPT].tests = [];
  writeFileSync(join(repo, ACCEPTED_RECORD), JSON.stringify(rec, null, 2) + "\n");
}

async function untested(env: Record<string, string>): Promise<void> {
  const { repo, cli, runs } = await accepted(env);
  commit(repo, "accepted tests");
  untest(repo);
  cli.out.length = 0;
  expect(await cli.run("check", "--json")).toBe(TESTS_CHANGED);
  expect(JSON.parse(cli.stdout).changed).toEqual([{ path: KEPT, review: RID, change: "repinned" }]);
  expect(runs()).toBe(0);
}

test("the accepted tests edited in the record are refused (exit 4) where accept recorded them", () =>
  untested(withConfig()));

test("the accepted tests edited in the record are refused against the committed pins", () => untested({}));

test("a record of an older arnx (no accepted tests) is no alarm; accept --again adds them", async () => {
  const env = withConfig();
  const { repo, cli, runs } = await accepted(env);
  const pins = localPinsPath(env, realpathSync(repo))!;
  for (const [path, entries] of [[join(repo, ACCEPTED_RECORD), "files"], [pins, "files"]] as const) {
    const d = JSON.parse(readFileSync(path, "utf8"));
    delete d[entries][KEPT].tests;
    writeFileSync(path, JSON.stringify(d, null, 2) + "\n");
  }
  commit(repo, "accepted tests, recorded by an older arnx");
  const fresh = new Cli({ cwd: repo, checkSessions: failing().sessions, env: {} });
  expect(await fresh.run("check")).toBe(1);
  expect(await cli.run("accept", "--again", "--no-answers", RID)).toBe(0);
  expect(JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files[KEPT].tests).toEqual(["test_a"]);
  expect(await cli.run("check")).toBe(1);
  runGit(repo, "checkout", "-q", "--", ACCEPTED_RECORD); // back to the older record: arnx wrote it here too
  expect(await cli.run("check")).toBe(1);
  expect(runs()).toBe(2);
});

test("--keep-edits keeps the accepted tests of the files it records again", async () => {
  const { repo, cli } = await accepted(withConfig());
  writeFileSync(join(repo, KEPT), "def test_a():\n    assert 1 == 2\n");
  expect(await cli.run("accept", "--keep-edits")).toBe(0);
  expect(JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files[KEPT].tests).toEqual(["test_a"]);
  rmSync(join(repo, ACCEPTED_RECORD));
  expect(await cli.run("accept", "--keep-edits")).toBe(0); // its entry removed: the tests come from this machine's pins
  expect(JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files[KEPT].tests).toEqual(["test_a"]);
  expect(await cli.run("check")).toBe(1);
});

/** A test edited and its accepted-test list emptied: --keep-edits records the edit, never the list. */
async function keptWithList(env: Record<string, string>): Promise<void> {
  const { repo, cli } = await accepted(env);
  commit(repo, "accepted tests");
  const edited = "def test_a():\n    assert 1 == 2\n";
  writeFileSync(join(repo, KEPT), edited);
  untest(repo);
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  cli.out.length = 0;
  expect(await cli.run("accept", "--keep-edits")).toBe(0);
  expect(cli.stdout).toContain(`  kept the accepted test list arnx wrote for ${KEPT} (its edit in ${ACCEPTED_RECORD} ` +
    "is not trusted)");
  const e = JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files[KEPT];
  expect([e.tests, e.sha256]).toEqual([["test_a"], sha(edited)]);
  if (!env.XDG_CONFIG_HOME) commit(repo, "kept edits"); // no record here: only the committed pins are trusted
  cli.out.length = 0;
  expect(await cli.run("check", "--json")).toBe(1);
  expect(JSON.parse(cli.stdout).projects[0].failed[0].accepted).toBe(true);
}

test("--keep-edits restores an edited accepted-test list (this machine's) and records the edited test", () =>
  keptWithList(withConfig()));

test("--keep-edits restores an edited accepted-test list from HEAD, with no record on this machine", () =>
  keptWithList({}));
