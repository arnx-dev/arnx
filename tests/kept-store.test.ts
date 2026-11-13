// Kept files an older arnx stored under .arnx/tests/ by the names they run by, where a project's runner, type checker
// or linter can pick them up: check and accept store them under their stored names (.arnx appended), each pin moved
// with its file, and say so in one line. A tampered one is refused, never moved.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCEPTED_RECORD, changedAccepted, localPinsPath, recordAccepted, TESTS_CHANGED } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { save } from "../src/report";
import type { SessionFactory } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const RUN = "tests/arnx/r20261011_a1b2c3/test_y.py";
const OLD = `.arnx/tests/${RUN}`;
const KEPT = `${OLD}.arnx`;
/** An older review's kept file and its support file, as an older arnx stored them. */
const OTHER = ".arnx/tests/tests/arnx/r20261001_0b0b0b/test_z.py";
const OTHER_CONF = ".arnx/tests/tests/arnx/r20261001_0b0b0b/conftest.py";
const BODY = "def test_a():\n    assert False\n";

const record = (repo: string) => JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files as
  Record<string, { sha256: string; review: string; tests?: string[] }>;
const put = (repo: string, rel: string, text: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

/** A fake sandbox where every kept test fails; `seen` gets the files each run saw at RUN ("" if absent). */
function sandbox(seen: string[]): SessionFactory {
  return async (_c, snap, _l, body) => {
    seen.push(existsSync(join(snap, RUN)) ? readFileSync(join(snap, RUN), "utf8") : "");
    return body(new FakeSession(snap, () => [junitXml([[RUN, "test_a", "failed", "assert False"],
      ["tests/arnx/r20261001_0b0b0b/test_z.py", "test_z", "failed", "assert 0"]]), "2 failed", false]));
  };
}

/** A repository with review RID marked (not accepted yet) and an approved environment. */
async function repoWithReview(env: Record<string, string>, seen: string[] = []) {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, checkSessions: sandbox(seen), env });
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
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"), BODY);
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8"))
    .replace("Mark: [ ] real", "Mark: [x] real"));
  return { repo, cli, rdir };
}

/** An older review's files as an older arnx kept them in .arnx/tests/ (by the names they run by), pinned. */
function olderReview(repo: string, env: Record<string, string>): void {
  put(repo, OTHER, "def test_z():\n    assert 0\n");
  put(repo, OTHER_CONF, "import pytest\n");
  recordAccepted(repo, "20261001-0b0b0b", { [OTHER]: ["test_z"], [OTHER_CONF]: [] }, localPinsPath(env, repo));
}

test("check stores older kept files under their stored names, pins moved, and runs them", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli } = await repoWithReview(env);
  olderReview(repo, env);
  const pinned = record(repo)[OTHER]!;
  expect(await cli.run("check")).toBe(1); // red: the older review's bug is not fixed
  expect(cli.stdout).toContain("Stored 2 older kept files out of your test runs.");
  expect([existsSync(join(repo, OTHER)), existsSync(join(repo, OTHER_CONF))]).toEqual([false, false]);
  expect(readFileSync(join(repo, `${OTHER}.arnx`), "utf8")).toBe("def test_z():\n    assert 0\n");
  // The pin moved with its file: the same sha256, review and tests, under the stored name.
  expect(Object.keys(record(repo)).sort()).toEqual([`${OTHER_CONF}.arnx`, `${OTHER}.arnx`]);
  expect(record(repo)[`${OTHER}.arnx`]).toEqual(pinned);
  expect(changedAccepted(repo, localPinsPath(env, repo))).toEqual([]);
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).not.toContain("Stored");
});

test("committed older kept files are stored without a record on this machine, and check trusts the moved pins", async () => {
  // A fresh clone or CI: no record of the pins outside the repository, only the committed ones.
  const { repo, cli } = await repoWithReview({});
  olderReview(repo, {});
  commit(repo, "accepted by an older arnx");
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toContain("Stored 2 older kept files out of your test runs.");
  cli.out.length = 0;
  expect(changedAccepted(repo, null)).toEqual([]);
  expect(await cli.run("check")).toBe(1); // not refused: the moved pin is checked against the committed one
});

test("accept stores older kept files too", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli } = await repoWithReview(env);
  olderReview(repo, env);
  expect(await cli.run("accept", "--no-answers", "--no-check")).toBe(0);
  expect(cli.stdout).toContain("Stored 2 older kept files out of your test runs.");
  expect(Object.keys(record(repo)).sort()).toEqual([`${OTHER_CONF}.arnx`, `${OTHER}.arnx`, KEPT]);
  expect(existsSync(join(repo, OTHER))).toBe(false);
  expect(changedAccepted(repo, localPinsPath(env, repo))).toEqual([]);
});

test("accept --again of a review an older arnx kept in .arnx/tests/: the old name and its pin go, the stored one is pinned",
  async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli, rdir } = await repoWithReview(env);
  // As the older arnx left it: the file by its run name, pinned there, and accepted.json naming it.
  expect(await cli.run("accept", "--no-answers", "--no-check")).toBe(0);
  const done = join(rdir, "accepted.json");
  const d = JSON.parse(readFileSync(done, "utf8"));
  writeFileSync(done, JSON.stringify({ ...d, kept: [OLD], moved: { "tests/g/test_a.py": OLD } }));
  put(repo, OLD, readFileSync(join(repo, KEPT), "utf8"));
  rmSync(join(repo, KEPT));
  recordAccepted(repo, RID, { [OLD]: ["test_a"] }, localPinsPath(env, repo));
  expect(await cli.run("accept", "--again", "--no-answers", "--no-check")).toBe(0);
  expect(existsSync(join(repo, OLD))).toBe(false);
  expect(readFileSync(join(repo, KEPT), "utf8")).toBe(BODY);
  expect(Object.keys(record(repo))).toEqual([KEPT]);
  expect(record(repo)[KEPT]!.tests).toEqual(["test_a"]);
  expect(changedAccepted(repo, localPinsPath(env, repo))).toEqual([]);
});

test("an older kept file beside an identical stored one is removed; one that differs is left, and said", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli } = await repoWithReview(env);
  expect(await cli.run("accept", "--no-answers", "--no-check")).toBe(0);
  put(repo, OLD, BODY); // the same content as the stored one
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toContain("Stored 1 older kept file out of your test runs.");
  expect([existsSync(join(repo, OLD)), existsSync(join(repo, KEPT))]).toEqual([false, true]);
  expect(Object.keys(record(repo))).toEqual([KEPT]);
  put(repo, OLD, "def test_a():\n    assert True\n"); // not the same
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toContain(`1 older kept file differs from its stored copy; left as it is: ${OLD}`);
  expect([existsSync(join(repo, OLD)), existsSync(join(repo, KEPT))]).toEqual([true, true]);
  expect(readFileSync(join(repo, KEPT), "utf8")).toBe(BODY);
});

test("an older kept file edited since accept makes check refuse (exit 4), and it is not moved", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const seen: string[] = [];
  const { repo, cli } = await repoWithReview(env, seen);
  olderReview(repo, env);
  writeFileSync(join(repo, OTHER), "def test_z():\n    assert 1\n"); // made to pass by editing the test
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`modified ${OTHER}`);
  expect(cli.stdout).not.toContain("Stored");
  expect([existsSync(join(repo, OTHER)), existsSync(join(repo, `${OTHER}.arnx`))]).toEqual([true, false]);
  expect(Object.keys(record(repo))).toContain(OTHER);
  expect(seen).toEqual([]);
  // accept does not move it either: its pin is not trusted.
  expect(await cli.run("accept", "--no-answers", "--no-check")).toBe(0);
  expect(existsSync(join(repo, OTHER))).toBe(true);
});
