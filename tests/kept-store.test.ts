// Kept files an older arnx stored under .arnx/tests/ by the names they run by, where a project's runner, type checker
// or linter can pick them up: check and accept store them under their stored names (.arnx appended), each pin moved
// with its file, and say so in one line. A tampered one is refused, never moved.
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ACCEPTED_RECORD, changedAccepted, localPinsPath, recordAccepted, storedOlderText, storeOlderKept, TESTS_CHANGED }
  from "../src/check";
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

test("check --json says how many older kept files it stored", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli } = await repoWithReview(env);
  olderReview(repo, env);
  cli.out.length = 0;
  expect(await cli.run("check", "--json", "--quiet")).toBe(1);
  expect(JSON.parse(cli.stdout).stored_older).toBe(2);
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

test("an older kept file beside an identical stored one is removed; two unpinned that differ are left, and said", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli } = await repoWithReview(env);
  expect(await cli.run("accept", "--no-answers", "--no-check")).toBe(0);
  put(repo, OLD, BODY); // the same content as the stored one
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toContain("Stored 1 older kept file out of your test runs.");
  expect([existsSync(join(repo, OLD)), existsSync(join(repo, KEPT))]).toEqual([false, true]);
  expect(Object.keys(record(repo))).toEqual([KEPT]);
  // Two copies that differ and that no pin covers: left as they are, and said (one pinned: refused, below).
  put(repo, ".arnx/tests/tests/arnx/r1/test_q.py", "def test_q(): pass\n");
  put(repo, ".arnx/tests/tests/arnx/r1/test_q.py.arnx", "def test_q(): assert 0\n");
  const r = storeOlderKept(repo, localPinsPath(env, repo));
  expect(r).toEqual({ stored: [], both: [".arnx/tests/tests/arnx/r1/test_q.py"] });
  expect(storedOlderText(r)).toBe("1 older kept file differs from its stored copy; left as it is: " +
    ".arnx/tests/tests/arnx/r1/test_q.py");
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

// For every run name, the file that runs is the pinned one: two copies that differ, one pinned, are refused (exit 4),
// both named, and nothing runs.
test("a weakened copy under the stored name beside a pinned older file is refused (exit 4), both named", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const seen: string[] = [];
  const { repo, cli } = await repoWithReview(env, seen);
  olderReview(repo, env);
  commit(repo, "accepted by an older arnx");
  put(repo, `${OTHER}.arnx`, "def test_z():\n    assert 1\n"); // no pin touched, the original left as it is
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`  twice    ${OTHER}: one test stored under two names that differ`);
  expect(cli.stdout).toContain(`  twice    ${OTHER}.arnx: one test stored under two names that differ`);
  expect(cli.stdout).toContain("delete the copy you do not want");
  expect(seen).toEqual([]);
  expect([existsSync(join(repo, OTHER)), existsSync(join(repo, `${OTHER}.arnx`))]).toEqual([true, true]);
  // --keep-edits does not choose either.
  expect(await cli.run("accept", "--keep-edits")).not.toBe(0);
  expect(cli.stderr).toContain("stored under two names that differ");
});

test("an unpinned older copy beside a pinned stored file is refused (exit 4), both named", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const seen: string[] = [];
  const { repo, cli } = await repoWithReview(env, seen);
  expect(await cli.run("accept", "--no-answers", "--no-check")).toBe(0);
  put(repo, OLD, "def test_a():\n    assert True\n");
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`twice    ${OLD}:`);
  expect(cli.stdout).toContain(`twice    ${KEPT}:`);
  expect(seen).toEqual([]);
  // Deleting the unpinned copy settles it.
  rmSync(join(repo, OLD));
  expect(await cli.run("check")).toBe(1);
  expect(seen).toEqual([BODY]);
});

test("a pinned older file deleted with its entry, beside a stored copy pinned apart, is refused (exit 4)", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const seen: string[] = [];
  const { repo, cli } = await repoWithReview(env, seen);
  olderReview(repo, env);
  commit(repo, "accepted by an older arnx");
  // A weaker copy under the stored name, pinned as if accept wrote it; the pinned original and its entry gone.
  put(repo, `${OTHER}.arnx`, "def test_z():\n    assert 1\n");
  recordAccepted(repo, "20261001-0b0b0b", { [`${OTHER}.arnx`]: ["test_z"], [OTHER_CONF]: [] });
  rmSync(join(repo, OTHER));
  expect(Object.keys(record(repo))).not.toContain(OTHER);
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toMatch(new RegExp(`(unpinned|deleted ) ${OTHER.replaceAll(".", "\\.")}(:|\\n)`));
  expect(seen).toEqual([]);
});

test("a pinned older file deleted, its entry kept, beside a stored copy, is deleted (exit 4)", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const seen: string[] = [];
  const { repo, cli } = await repoWithReview(env, seen);
  olderReview(repo, env);
  put(repo, `${OTHER}.arnx`, "def test_z():\n    assert 1\n");
  rmSync(join(repo, OTHER));
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`deleted  ${OTHER}`);
  expect(seen).toEqual([]);
});

// Every pinned path, and both entries of a kept pair, must be a regular file: a link or a folder there is an edit
// (exit 4), read and counted the same way it would be placed, and accept writes nothing through one.
test("a link at the stored name beside a pinned older file is refused (exit 4) and deletes nothing, with no record here",
  async () => {
  // CI: a fresh checkout, every run a first run, no record of the pins outside the repository.
  const seen: string[] = [];
  const { repo, cli } = await repoWithReview({}, seen);
  olderReview(repo, {});
  symlinkSync("test_z.py", join(repo, `${OTHER}.arnx`));
  commit(repo, "a link beside the accepted test");
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`modified ${OTHER}.arnx`);
  expect(cli.stdout).toContain(`Not a regular file (a link or a folder): ${OTHER}.arnx`);
  expect(cli.stdout).not.toContain("Stored");
  expect(seen).toEqual([]);
  expect(readFileSync(join(repo, OTHER), "utf8")).toBe("def test_z():\n    assert 0\n");
  expect(Object.keys(record(repo))).toContain(OTHER);
  // accept refuses too, before writing or deleting anything.
  cli.out.length = 0;
  expect(await cli.run("accept", "--no-answers", "--no-check")).not.toBe(0);
  expect(cli.stderr).toContain(`not a regular file (a link or a folder) where arnx keeps tests: ${OTHER}.arnx`);
  expect([existsSync(join(repo, OTHER)), lstatSync(join(repo, `${OTHER}.arnx`)).isSymbolicLink(), existsSync(join(repo, KEPT))])
    .toEqual([true, true, false]);
});

test("a pinned stored file replaced by a link to an identical copy elsewhere is refused (exit 4); accept refuses too",
  async () => {
  const seen: string[] = [];
  const { repo, cli } = await repoWithReview({}, seen);
  expect(await cli.run("accept", "--no-answers", "--no-check")).toBe(0);
  commit(repo, "accepted");
  writeFileSync(join(repo, "copy.py"), readFileSync(join(repo, KEPT)));
  rmSync(join(repo, KEPT));
  symlinkSync(relative(dirname(join(repo, KEPT)), join(repo, "copy.py")), join(repo, KEPT));
  expect(readFileSync(join(repo, KEPT), "utf8")).toBe(BODY); // the same bytes, through the link
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`modified ${KEPT}`);
  expect(seen).toEqual([]);
  cli.out.length = 0;
  expect(await cli.run("accept", "--again", "--no-answers", "--no-check")).not.toBe(0);
  expect(cli.stderr).toContain(`where arnx keeps tests: ${KEPT}`);
  expect(lstatSync(join(repo, KEPT)).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(repo, "copy.py"), "utf8")).toBe(BODY); // nothing written through the link
});

test("a folder at a pinned path is refused (exit 4)", async () => {
  const seen: string[] = [];
  const { repo, cli } = await repoWithReview({}, seen);
  expect(await cli.run("accept", "--no-answers", "--no-check")).toBe(0);
  rmSync(join(repo, KEPT));
  mkdirSync(join(repo, KEPT));
  writeFileSync(join(repo, KEPT, "x.py"), BODY);
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`modified ${KEPT}`);
  expect(seen).toEqual([]);
  cli.out.length = 0;
  expect(await cli.run("accept", "--again", "--no-answers", "--no-check")).not.toBe(0);
  expect(existsSync(join(repo, KEPT, "x.py"))).toBe(true);
});

test("two copies of one test are settled by deleting one, which the refusal says, not by accepting again", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli } = await repoWithReview(env);
  olderReview(repo, env);
  put(repo, `${OTHER}.arnx`, "def test_z():\n    assert 1\n");
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).not.toContain("arnx accept --again");
  expect(cli.stdout).toContain("delete the copy you do not want, then arnx check");
  rmSync(join(repo, `${OTHER}.arnx`));
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toContain("Stored 2 older kept files out of your test runs.");
});
