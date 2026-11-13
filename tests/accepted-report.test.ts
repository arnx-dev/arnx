// Every accepted test the record names must report: one the project's own configuration leaves out (a deselect, a
// collection hook, a name filter) is named and does not pass. OS and editor leftovers under .arnx/tests/ are ignored,
// and `arnx accept --move` pins every file it moves and never moves Python's byte-code cache.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type AnswerOutcome, accept } from "../src/accept";
import { ACCEPTED_RECORD, changedAccepted, localPinsPath, recordAccepted, TESTS_CHANGED } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { save } from "../src/report";
import type { RunResult, SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261001-0b0b0b";
const RUN = "tests/arnx/r20261001_0b0b0b/test_zy.py";
const KEPT = `.arnx/tests/${RUN}.arnx`;
const BODY = "def add(a, b):\n    return a - b\n\ndef test_z():\n    assert add(2, 2) == 4\n\ndef test_y():\n    assert 1\n";
type Row = [string, string, string, string];

const record = (repo: string) => JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files as
  Record<string, { sha256: string; review: string; tests?: string[]; ids?: string[] }>;
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

/** A repository with an approved environment and one kept file pinned with `tests`, each as the runner reported it
 * (undefined: an older pin, with no list). `older`: a pin by an arnx that recorded names without their parameters
 * (no `ids`), committed and never recorded on this machine. */
async function kept(rows: Row[], tests: string[] | undefined, seen: string[][] = [], older = false) {
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
  // An older pin: committed without a list (or without exact ids), never recorded on this machine.
  recordAccepted(repo, RID, { [KEPT]: tests ?? [] }, tests && !older ? localPinsPath(env, repo) : null);
  if (!tests || older) {
    const rec = JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8"));
    delete rec.files[KEPT].ids;
    if (!tests) delete rec.files[KEPT].tests;
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

// The project's configuration leaves out the one variant that fails on the bug (a deselect, a conftest, `-k` matching
// its parameter id): the other variants pass, and the accepted one is named.
test("a parametrized accepted test must report as the variant accept recorded (exit 1)", async () => {
  const { repo, cli } = await kept([[RUN, "test_z[0]", "passed", ""], [RUN, "test_y", "passed", ""]],
    ["test_z[1]", "test_y"]);
  expect(record(repo)[KEPT]).toMatchObject({ tests: ["test_z", "test_y"], ids: ["test_z[1]", "test_y"] });
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toContain("✗ 1 accepted test did not report, so not shown to pass:\n  ✗ test_z[1]");
  expect(cli.stdout).not.toContain("The accepted test passes");
  expect(cli.stdout).not.toContain("Accepted tests unchanged");
  cli.out.length = 0;
  expect(await cli.run("check", "--json", "--quiet")).toBe(1);
  expect(JSON.parse(cli.stdout).projects[0].missing_accepted).toEqual([`${RUN}::test_z[1]`]);
});

test("a variant the record does not list does not stand in for a missing listed one", async () => {
  const { cli } = await kept([[RUN, "test_z[0]", "passed", ""], [RUN, "test_z[2]", "passed", ""]], ["test_z[1]"]);
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toContain("✗ 1 accepted test did not report, so not shown to pass:\n  ✗ test_z[1]");
});

test("the listed variant reporting is enough: other variants may report or not", async () => {
  const { cli } = await kept([[RUN, "test_z[1]", "passed", ""], [RUN, "test_z[2]", "passed", ""]], ["test_z[1]"]);
  expect(await cli.run("check")).toBe(0);
  expect(cli.stdout).not.toContain("did not report");
  const red = await kept([[RUN, "test_z[1]", "failed", "assert 0 == 2"]], ["test_z[1]"]);
  expect(await red.cli.run("check")).toBe(1);
  expect(red.cli.stdout).not.toContain("did not report");
});

test("an older record without exact ids keeps the base-name rule: any variant reports for it", async () => {
  const { repo, cli } = await kept([[RUN, "test_z[1]", "passed", ""], [RUN, "test_z[2]", "passed", ""],
    [RUN, "test_y", "passed", ""]], ["test_z", "test_y"], [], true);
  expect(record(repo)[KEPT]!.ids).toBeUndefined();
  expect(await cli.run("check")).toBe(0);
  expect(cli.stdout).not.toContain("did not report");
  cli.out.length = 0;
  expect(await cli.run("check", "--json", "--quiet")).toBe(0);
  expect(JSON.parse(cli.stdout).projects[0].missing_accepted).toBeUndefined();
});

test("exact ids edited or dropped in the record are not trusted (exit 4)", async () => {
  for (const edit of [(e: Record<string, unknown>) => { delete e.ids; }, (e: Record<string, unknown>) => { e.ids = ["test_z[0]"]; }]) {
    const { repo, cli } = await kept([[RUN, "test_z[0]", "passed", ""]], ["test_z[1]"]);
    const rec = JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8"));
    edit(rec.files[KEPT]);
    writeFileSync(join(repo, ACCEPTED_RECORD), JSON.stringify(rec, null, 2) + "\n");
    expect(await cli.run("check")).toBe(TESTS_CHANGED);
  }
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
  expect(cli.stdout).toContain(`${folder} is a link; replace it with a real folder, then run the command again`);
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

// An entry with fewer lists (no `ids`, or no `tests`) than arnx pinned for its file, on this machine or in any commit,
// is trusted only when the stronger version is in a commit HEAD does not reach (a branch switch, a stash). Dropped from
// a committed record, or from one never committed (an accept discarded), it is an edit: exit 4.
const ROWS: Row[] = [[RUN, "test_z[0]", "passed", ""], [RUN, "test_z[1]", "failed", "assert 0 == 2"]];
const weaken = (repo: string, noList = false) => {
  const rp = join(repo, ACCEPTED_RECORD);
  const rec = JSON.parse(readFileSync(rp, "utf8"));
  delete rec.files[KEPT].ids;
  if (noList) delete rec.files[KEPT].tests;
  writeFileSync(rp, JSON.stringify(rec, null, 2) + "\n");
};
/** An older arnx's accept, committed: its record without ids (or with no list), and this machine's copy of what it
 * pinned. */
async function olderAccept(noList = false) {
  const k = await kept(ROWS, noList ? undefined : ["test_z"], [], true);
  const local = localPinsPath(k.env, k.repo)!;
  mkdirSync(dirname(local), { recursive: true });
  writeFileSync(local, JSON.stringify({ schema_version: 1, repo: k.repo, files: { [KEPT]: { review: RID,
    sha256: [record(k.repo)[KEPT]!.sha256], tests: [noList ? null : ["test_z"]] } } }, null, 2) + "\n");
  return { ...k, local };
}
/** check refuses the entry; `git checkout` is offered only when HEAD holds the entry arnx pinned. */
const refused = async (cli: Cli, checkout = false) => {
  cli.out.length = 0;
  expect(await cli.run("check", "--json", "--quiet")).toBe(TESTS_CHANGED);
  expect(JSON.parse(cli.stdout).changed).toEqual([{ path: KEPT, review: RID, change: "repinned" }]);
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(TESTS_CHANGED);
  expect(cli.stdout).toContain(`To restore it: arnx accept --again ${RID}`);
  expect(cli.stdout.includes(`git checkout -- ${KEPT} ${ACCEPTED_RECORD}`)).toBe(checkout);
  // Keeping the edit would record the same dropped lists again: not offered, and refused.
  expect(cli.stdout).not.toContain("--keep-edits");
  const repo = cli.deps.cwd!;
  const before = readFileSync(join(repo, ACCEPTED_RECORD), "utf8");
  cli.out.length = 0;
  cli.err.length = 0;
  expect(await cli.run("accept", "--keep-edits")).toBe(2);
  expect(cli.stderr).toContain(`arnx accept --again ${RID}`);
  expect(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).toBe(before);
};

for (const older of ["none", "a list without ids", "no list"] as const) {
  for (const committed of [false, true]) {
    test(`ids dropped from the record${committed ? " and committed" : ""}, this machine having pinned ${older} before: ` +
      "an edit (exit 4)", async () => {
      const k = older === "none" ? await kept(ROWS, ["test_z[1]"]) : await olderAccept(older === "no list");
      if (older !== "none") {
        recordAccepted(k.repo, RID, { [KEPT]: ["test_z[1]"] }, localPinsPath(k.env, k.repo));
        commit(k.repo, "accept again");
      }
      expect(await k.cli.run("check")).toBe(1);
      weaken(k.repo, older === "no list");
      if (committed) commit(k.repo, "weaken");
      await refused(k.cli, !committed);
    });
  }
}

test("ids dropped and committed: refused on a fresh clone too, where nothing was pinned on the machine", async () => {
  const k = await kept(ROWS, ["test_z[1]"]);
  weaken(k.repo);
  commit(k.repo, "weaken");
  const fresh = new Cli({ cwd: k.repo, checkSessions: reporting(ROWS), env: {} });
  await refused(fresh);
});

// A kept file once pinned by the name it runs by (an older arnx stored it so), now by its stored name: the ids its
// entry had under the other name count too.
test("ids pinned under a kept file's other name, then dropped under its stored name: an edit (exit 4)", async () => {
  const { repo } = await kept(ROWS, undefined);
  const old = `.arnx/tests/${RUN}`;
  const move = (from: string, to: string, lists: Record<string, unknown>) => {
    renameSync(join(repo, from), join(repo, to));
    const rp = join(repo, ACCEPTED_RECORD);
    const rec = JSON.parse(readFileSync(rp, "utf8"));
    rec.files[to] = { ...rec.files[from], ...lists };
    delete rec.files[from];
    writeFileSync(rp, JSON.stringify(rec, null, 2) + "\n");
    commit(repo, `${from} to ${to}`);
  };
  move(KEPT, old, { tests: ["test_z"], ids: ["test_z[1]"] });
  move(old, KEPT, { tests: ["test_z"], ids: undefined });
  expect(record(repo)[KEPT]!.ids).toBeUndefined();
  await refused(new Cli({ cwd: repo, checkSessions: reporting(ROWS), env: {} }));
});

test("a branch switch back to an older record is trusted: the ids are in a commit HEAD does not reach", async () => {
  const k = await olderAccept();
  runGit(k.repo, "checkout", "-q", "-b", "next");
  recordAccepted(k.repo, RID, { [KEPT]: ["test_z[1]"] }, k.local);
  commit(k.repo, "accept again");
  runGit(k.repo, "checkout", "-q", "-");
  expect(record(k.repo)[KEPT]!.ids).toBeUndefined();
  expect(await k.cli.run("check")).toBe(1);
  // No pins on the machine either.
  expect(await new Cli({ cwd: k.repo, checkSessions: reporting(ROWS), env: {} }).run("check")).toBe(1);
});

test("an accept stashed away is trusted; discarded, it is an edit (exit 4)", async () => {
  const k = await olderAccept();
  recordAccepted(k.repo, RID, { [KEPT]: ["test_z[1]"] }, k.local);
  runGit(k.repo, "stash", "-q");
  expect(record(k.repo)[KEPT]!.ids).toBeUndefined();
  expect(await k.cli.run("check")).toBe(1);
  runGit(k.repo, "stash", "drop", "-q");
  await refused(k.cli);
});

// vitest: a top-level title with brackets is the title's own ("adds[1]" from test.each), recorded and required whole.
test("a JavaScript title with brackets must report whole", async () => {
  const at = mkdtempSync(join(tmp(), "js-"));
  const env = { XDG_CONFIG_HOME: at };
  const repo = gitRepo(at);
  const run = "__tests__/arnx/r20261001_0b0b0b/adds.test.ts";
  const titles: [string, string][] = [["adds[0]", "passed"], ["adds[2]", "passed"]];
  // vitest's JUnit report, written where the command's --outputFile says.
  const vitest: SessionFactory = async (_c, snap, _l, body) => body({ run(command: string): RunResult {
    const out = /--outputFile='?\/src\/([^'\s]+)/.exec(command)?.[1];
    const cases = titles.map(([name, outcome]) => `<testcase classname="${run}" name="${name}" time="0.01">` +
      `${outcome === "failed" ? '<failure message="x">x</failure>' : ""}</testcase>`).join("");
    if (out) put(snap, out, `<?xml version="1.0"?><testsuites><testsuite name="${run}">${cases}</testsuite></testsuites>`);
    return { exitCode: 0, output: "", timedOut: false, seconds: 0.1 };
  } });
  const cli = new Cli({ cwd: repo, checkSessions: vitest, env });
  await cli.run("init");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  web:
    root: .
    language: typescript
    runner: vitest
    image: node:22
    test_command: npx vitest run {targets}
`), "Dev", "2026-10-12"));
  const keptJs = `.arnx/tests/${run}.arnx`;
  put(repo, keptJs, 'import { expect, test } from "vitest";\n\ntest.each([0, 1, 2])("adds[%i]", (n) => {\n  ' +
    "expect(n + 0).toBe(n);\n});\n");
  recordAccepted(repo, RID, { [keptJs]: ["adds[1]"] }, localPinsPath(env, repo));
  commit(repo, "accepted");
  expect(await cli.run("check")).toBe(1);
  expect(cli.stdout).toContain("✗ 1 accepted test did not report, so not shown to pass:\n  ✗ adds[1]");
  titles.push(["adds[1]", "passed"]);
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(0);
});

// accept records each accepted test as the runner reported it in the review: a finding's variant with its
// parameters, and an answer's failing test as its run reported it.
test("accept records the exact ids of the accepted tests beside their names", async () => {
  const repo = gitRepo(tmp());
  const wd = "tests/arnx_generated";
  const gen = `${wd}/test_add.py`;
  const rid = "20261011-a1b2c3";
  const rdir = join(repo, ".arnx", "reviews", rid);
  save(sampleReview({ id: rid, writeDir: wd, flaky: [], questions: ["Should add round?"],
    findings: [finding("F1", `${gen}::test_z[1]`, "test_z", gen, "assert 0 == 2", "add subtracts", "confirmed"),
      finding("F2", `${gen}::TestAdd::test_w[a-b]`, "test_w", gen, "assert 0 == 2", "add subtracts", "confirmed")] }),
  rdir, "diff --git a/app.py b/app.py\n");
  put(rdir, `tests/${gen}`, "import pytest\n\n@pytest.mark.parametrize('b', [0, 1])\ndef test_z(b):\n    assert b == 0\n\n" +
    "class TestAdd:\n    @pytest.mark.parametrize('s', ['a-b'])\n    def test_w(self, s):\n        assert False\n");
  const md = join(rdir, "review.md");
  writeFileSync(md, blankMarks(readFileSync(md, "utf8")).replaceAll("Mark: [ ] real", "Mark: [x] real")
    .replace(/^Answer:$/m, "Answer: no, it truncates"));
  const answers = async (qid: string): Promise<AnswerOutcome> => {
    const file = `${wd}/answers/test_${qid.toLowerCase()}.py`;
    return { qid, files: { [file]: "import pytest\n\n@pytest.mark.parametrize('x', [1])\ndef test_q(x):\n    assert False\n" },
      keep: { [file]: new Set(["test_q"]) }, skip: {}, disagree: [`${file}::test_q[1]`], costUsd: 0, stop: "end_turn",
      base: `${wd}/answers` };
  };
  await accept(repo, rdir, { ...defaultSettings(), consentAt: "2026-10-11T00:00:00Z" }, { answerRunner: answers });
  const rec = record(repo);
  const dest = ".arnx/tests/tests/arnx/r20261011_a1b2c3";
  const main = Object.keys(rec).find((p) => p.startsWith(dest) && !p.includes("/answers/"))!;
  expect([rec[main]!.tests, rec[main]!.ids]).toEqual([["test_z", "TestAdd::test_w"], ["test_z[1]", "TestAdd::test_w[a-b]"]]);
  expect([rec[`${dest}/answers/test_q1.py.arnx`]!.tests, rec[`${dest}/answers/test_q1.py.arnx`]!.ids])
    .toEqual([["test_q"], ["test_q[1]"]]);
});
