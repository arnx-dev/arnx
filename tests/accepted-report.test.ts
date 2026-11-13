// Every accepted test the record names must report: one the project's own configuration leaves out (a deselect, a
// collection hook, a name filter) is named and does not pass. OS and editor leftovers under .arnx/tests/ are ignored,
// and `arnx accept --move` pins every file it moves and never moves Python's byte-code cache.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCEPTED_RECORD, changedAccepted, localPinsPath, recordAccepted, TESTS_CHANGED } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import type { SessionFactory } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261001-0b0b0b";
const RUN = "tests/arnx/r20261001_0b0b0b/test_zy.py";
const KEPT = `.arnx/tests/${RUN}.arnx`;
const BODY = "def add(a, b):\n    return a - b\n\ndef test_z():\n    assert add(2, 2) == 4\n\ndef test_y():\n    assert 1\n";
type Row = [string, string, string, string];

const record = (repo: string) => JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files as
  Record<string, { sha256: string; review: string; tests?: string[] }>;
const put = (repo: string, rel: string, text: string) => {
  mkdirSync(dirname(join(repo, rel)), { recursive: true });
  writeFileSync(join(repo, rel), text);
};

/** A fake sandbox whose runner reports `rows`; `seen` gets each run's snapshot listing of RUN's folder. */
function reporting(rows: Row[], seen: string[][] = []): SessionFactory {
  return async (_c, snap, _l, body) => {
    const dir = join(snap, dirname(RUN));
    seen.push(existsSync(dir) ? [...new Bun.Glob("**/*").scanSync({ cwd: dir, dot: true })].sort() : []);
    return body(new FakeSession(snap, () => [junitXml(rows), "", false]));
  };
}

/** A repository with an approved environment and one kept file pinned with `tests` (undefined: an older pin). */
async function kept(rows: Row[], tests: string[] | undefined, seen: string[][] = []) {
  const at = mkdtempSync(join(tmp(), "k-"));
  const env = { XDG_CONFIG_HOME: at };
  const repo = gitRepo(at);
  const cli = new Cli({ cwd: repo, checkSessions: reporting(rows, seen), env });
  await cli.run("init");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  app:
    root: .
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  put(repo, KEPT, BODY);
  // An older pin: committed without a list, never recorded on this machine.
  recordAccepted(repo, RID, { [KEPT]: tests ?? [] }, tests ? localPinsPath(env, repo) : null);
  if (!tests) {
    const rec = JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8"));
    delete rec.files[KEPT].tests;
    writeFileSync(join(repo, ACCEPTED_RECORD), JSON.stringify(rec, null, 2) + "\n");
  }
  commit(repo, "accepted");
  return { repo, cli, env };
}

// The project's pytest.ini deselects test_z, or its conftest drops it at collection: pytest reports test_y alone.
test("an accepted test the run leaves out is named and does not pass (exit 1)", async () => {
  const { cli } = await kept([[RUN, "test_y", "passed", ""]], ["test_z", "test_y"]);
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toContain("✓ 1 accepted test passes");
  expect(cli.stdout).toContain("✗ 1 accepted test did not report, so not shown to pass:\n  ✗ test_z");
  expect(cli.stdout).toContain("An accepted test that does not report proves nothing");
  expect(cli.stdout).not.toContain("The accepted test passes");
  expect(cli.stdout).not.toContain("Accepted tests unchanged");
  cli.out.length = 0;
  expect(await cli.run("check", "--json", "--quiet")).toBe(1);
  const p = JSON.parse(cli.stdout).projects[0];
  expect([p.missing_accepted, p.passed]).toEqual([[`${RUN}::test_z`], [`${RUN}::test_y`]]);
});

test("a parametrized accepted test reports through its variants", async () => {
  const { cli } = await kept([[RUN, "test_z[1]", "passed", ""], [RUN, "test_z[2]", "passed", ""],
    [RUN, "test_y", "passed", ""]], ["test_z", "test_y"]);
  expect(await cli.run("check")).toBe(0);
  expect(cli.stdout).not.toContain("did not report");
  cli.out.length = 0;
  expect(await cli.run("check", "--json", "--quiet")).toBe(0);
  expect(JSON.parse(cli.stdout).projects[0].missing_accepted).toBeUndefined();
});

test("an older pin without a test list keeps the whole-file rule", async () => {
  const some = await kept([[RUN, "test_y", "passed", ""]], undefined);
  expect(await some.cli.run("check")).toBe(0);
  const none = await kept([["tests/other/test_q.py", "test_q", "passed", ""]], undefined);
  expect(await none.cli.run("check")).toBe(2);
  expect(none.cli.stdout).toContain("did not run, the runner leaves it out");
  expect(none.cli.stdout).not.toContain("did not report");
});

test("OS and editor leftovers under .arnx/tests/ are ignored: never placed, never added, never moved", async () => {
  const seen: string[][] = [];
  const { repo, cli, env } = await kept([[RUN, "test_z", "failed", "assert 0 == 4"], [RUN, "test_y", "passed", ""]],
    ["test_z", "test_y"], seen);
  const dir = `.arnx/tests/${dirname(RUN)}`;
  const junk = [`${dir}/.DS_Store`, `${dir}/.test_zy.py.swp`, `${dir}/.test_zy.py.arnx.swo`, `${dir}/test_zy.py~`,
    `${dir}/Thumbs.db`, `${dir}/__pycache__/test_zy.cpython-312.pyc`, `${dir}/stale.pyc`, ".arnx/tests/.DS_Store"];
  for (const p of junk) put(repo, p, "\x00junk");
  expect(changedAccepted(repo, localPinsPath(env, repo))).toEqual([]);
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).not.toContain("Stored");
  expect(seen).toEqual([["test_zy.py"]]);
  for (const p of junk) expect(existsSync(join(repo, p))).toBe(true);
  expect(existsSync(join(repo, `${dir}/.DS_Store.arnx`))).toBe(false);
  expect(Object.keys(record(repo))).toEqual([KEPT]);
});

// accept --move: files an older arnx kept inside the project, in its accepted folder.
const LEGACY = "tests/arnx/r20261011_a1b2c3/test_y.py";
const PYC = "tests/arnx/r20261011_a1b2c3/__pycache__/test_y.cpython-312-pytest-8.3.3.pyc";
const DATA = "tests/arnx/r20261011_a1b2c3/data.json";

test("accept --move pins every file it moves and leaves Python's byte-code cache where it is", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const repo = gitRepo(tmp());
  let ran = 0;
  const cli = new Cli({ cwd: repo, env, checkSessions: async (_c, snap, _l, body) => {
    ran++;
    expect(existsSync(join(snap, DATA))).toBe(true);
    return body(new FakeSession(snap, () => [junitXml([[LEGACY, "test_a", "failed", "assert False"]]), "", false]));
  } });
  await cli.run("init");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  app:
    root: .
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  put(repo, LEGACY, "def test_a():\n    assert False\n");
  put(repo, PYC, "\x00pyc");
  put(repo, DATA, "{}\n");
  recordAccepted(repo, "20261011-a1b2c3", { [LEGACY]: ["test_a"] }, localPinsPath(env, repo));
  expect(await cli.run("accept", "--move")).toBe(0);
  expect(cli.stdout).not.toContain("__pycache__");
  expect(existsSync(join(repo, PYC))).toBe(true);
  expect(existsSync(join(repo, `.arnx/tests/${PYC}.arnx`))).toBe(false);
  const rec = record(repo);
  expect(Object.keys(rec).sort()).toEqual([`.arnx/tests/${DATA}.arnx`, `.arnx/tests/${LEGACY}.arnx`]);
  expect(rec[`.arnx/tests/${DATA}.arnx`]!.review).toBe("20261011-a1b2c3");
  expect(changedAccepted(repo, localPinsPath(env, repo))).toEqual([]);
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(1);
  expect(ran).toBe(1);
});

test("a review's folder that is a link: the refusal says to delete the link, not the files through it", async () => {
  const { repo, cli } = await kept([[RUN, "test_y", "passed", ""]], ["test_y"]);
  const folder = `.arnx/tests/${dirname(RUN)}`;
  const outside = join(tmp(), "elsewhere");
  renameSync(join(repo, folder), outside);
  symlinkSync(outside, join(repo, folder));
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`A link where a folder of kept tests belongs: delete the link ${folder} (not the files ` +
    "through it), then arnx check");
  expect(cli.stdout).not.toContain("delete them");
  expect(cli.stdout).not.toContain("delete it,");
  expect(existsSync(join(outside, "test_zy.py.arnx"))).toBe(true);
});

test("a kept file with named tests that reports nothing names them too (exit 1)", async () => {
  const { cli } = await kept([["tests/other/test_q.py", "test_q", "passed", ""]], ["test_z", "test_y"]);
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toContain("✗ 2 accepted tests did not report, so not shown to pass:\n  ✗ test_z\n  ✗ test_y");
  expect(cli.stdout).toContain("did not run, the runner leaves it out");
});
