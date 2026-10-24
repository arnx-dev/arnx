// Accepted tests live in .arnx/tests/, at the path each runs from, so the project's own test run never collects them;
// check puts them in place in its throwaway copy only. Tests an older arnx kept inside the project (with an
// expected-fail marker) block check until `arnx accept --move` moves them.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTED_RECORD, changedAccepted, localPinsPath, recordAccepted } from "../src/check";
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
const KEPT = `.arnx/tests/${RUN}`;
const MARKER = `@pytest.mark.xfail(strict=True, reason='arnx review ${RID}: F1 not fixed yet')\n`;

/** A fake sandbox where the accepted test fails; `seen` gets the copy's file at RUN as the run saw it ("" if absent). */
function sandbox(seen: string[]): SessionFactory {
  return async (_c, snap, _l, body) => {
    seen.push(existsSync(join(snap, RUN)) ? readFileSync(join(snap, RUN), "utf8") : "");
    return body(new FakeSession(snap, () => [junitXml([[RUN, "test_a", "failed", "assert False"]]), "1 failed",
      false]));
  };
}

async function repoWithReview(seen: string[], env: Record<string, string> = {}) {
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
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"), "def test_a():\n    assert False\n");
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8"))
    .replace("Mark: [ ] real", "Mark: [x] real"));
  return { repo, cli };
}

/** The repository as an arnx before .arnx/tests/ left it: the test in the project's tests folder, marked, pinned. */
function legacy(repo: string, env: Record<string, string>): void {
  mkdirSync(join(repo, "tests", "arnx", "r20261011_a1b2c3"), { recursive: true });
  writeFileSync(join(repo, RUN), `import pytest\n${MARKER}def test_a():\n    assert False\n`);
  writeFileSync(join(repo, "tests", "arnx", "r20261011_a1b2c3", "conftest.py"), "import pytest\n");
  recordAccepted(repo, RID, { [RUN]: ["test_a"], "tests/arnx/r20261011_a1b2c3/conftest.py": [] },
    localPinsPath(env, repo));
}

test("accept keeps the test in .arnx/tests/ as it is (no marker), and nothing in the project's own folders", async () => {
  const seen: string[] = [];
  const { repo, cli } = await repoWithReview(seen);
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(readFileSync(join(repo, KEPT), "utf8")).toBe("def test_a():\n    assert False\n");
  expect(existsSync(join(repo, "tests", "arnx"))).toBe(false);
  expect(Object.keys(JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files)).toEqual([KEPT]);
  expect(cli.stdout).toContain(`kept: ${KEPT}`);
});

test("check runs the test from its place in the copy and says it fails; the repository is left as it was", async () => {
  const seen: string[] = [];
  const { repo, cli } = await repoWithReview(seen);
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  seen.length = 0;
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(1);
  expect(seen).toEqual(["def test_a():\n    assert False\n"]);
  expect(cli.stdout).toContain("1 accepted test still fails");
  expect(existsSync(join(repo, "tests", "arnx"))).toBe(false);
  expect(readFileSync(join(repo, KEPT), "utf8")).toBe("def test_a():\n    assert False\n");
});

test("check runs nothing while an older arnx's tests are in the project's folders; accept --move moves them", async () => {
  const seen: string[] = [];
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli } = await repoWithReview(seen, env);
  legacy(repo, env);
  expect(await cli.run("check")).not.toBe(0);
  expect(cli.stderr).toMatch(/2 accepted files are in your own test folders[\s\S]*arnx accept --move/);
  expect(seen).toEqual([]);
  cli.out.length = 0;
  expect(await cli.run("accept", "--move")).toBe(0);
  expect(cli.stdout).toContain(`  ${RUN} → ${KEPT}`);
  // Without its marker (red only in check now), its folders gone, pinned where it is now: check trusts it.
  expect(readFileSync(join(repo, KEPT), "utf8")).toBe("import pytest\ndef test_a():\n    assert False\n");
  expect(existsSync(join(repo, ".arnx", "tests", "tests", "arnx", "r20261011_a1b2c3", "conftest.py"))).toBe(true);
  expect(existsSync(join(repo, "tests", "arnx"))).toBe(false);
  expect(Object.keys(JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files).sort())
    .toEqual([".arnx/tests/tests/arnx/r20261011_a1b2c3/conftest.py", KEPT]);
  expect(changedAccepted(repo, localPinsPath(env, repo))).toEqual([]);
  expect(await cli.run("check")).toBe(1);
  expect(seen.at(-1)).toBe("import pytest\ndef test_a():\n    assert False\n");
});

test("accept --move leaves an older arnx's test edited since accept where it is, and says how to settle it", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli } = await repoWithReview([], env);
  legacy(repo, env);
  writeFileSync(join(repo, RUN), "def test_a():\n    assert True\n");
  expect(await cli.run("accept", "--move")).not.toBe(0);
  expect(cli.stderr).toMatch(/changed since arnx accept[\s\S]*--keep-edits/);
  expect(readFileSync(join(repo, RUN), "utf8")).toBe("def test_a():\n    assert True\n");
  expect(existsSync(join(repo, KEPT))).toBe(false);
});

test("accept --again of a review an older arnx accepted moves its files out of the project's folders", async () => {
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli } = await repoWithReview([], env);
  expect(await cli.run("accept", "--no-answers", "--no-check")).toBe(0);
  // As the older arnx wrote accepted.json: the file at its old place.
  const done = join(repo, ".arnx", "reviews", RID, "accepted.json");
  const d = JSON.parse(readFileSync(done, "utf8"));
  writeFileSync(done, JSON.stringify({ ...d, kept: [RUN], moved: { "tests/g/test_a.py": RUN } }));
  legacy(repo, env);
  expect(await cli.run("accept", "--again", "--no-answers", "--no-check")).toBe(0);
  expect(existsSync(join(repo, RUN))).toBe(false);
  expect(readFileSync(join(repo, KEPT), "utf8")).toBe("def test_a():\n    assert False\n");
  expect(changedAccepted(repo, localPinsPath(env, repo)).filter((c) => c.path === RUN)).toEqual([]);
});

// setup proves the place: its whole-suite run carries a one-line test in .arnx/tests/, which must not run.
const SUITE_YAML = "version: 1\nprojects:\n  app:\n    root: .\n    image: python:3.12\n" +
  "    test_command: python -m pytest -q {targets}\n";

test("setup refuses a project whose own test run collects .arnx/ (a canary placed there ran), and passes otherwise",
  async () => {
  const { parseReviewFile: parse } = await import("../src/config");
  const { runSuite } = await import("../src/setup");
  const { fakeFactory } = await import("./helpers/fakes");
  const cfg = parse(SUITE_YAML).projects[0]!;
  for (const collects of [false, true]) {
    const snap = gitRepo(tmp());
    mkdirSync(join(snap, "tests"), { recursive: true });
    writeFileSync(join(snap, "tests", "test_own.py"), "def test_own():\n    pass\n");
    // A whole-suite run reports the project's own test, and the canary too when the runner collects hidden folders.
    const canary = join(snap, ".arnx", "tests", "tests", "arnx_generated", "test_arnx_probe.py");
    const script = (command: string): [string, string, boolean] => {
      const cases: [string, string, string, string][] = [["tests/test_own.py", "test_own", "passed", ""]];
      if (collects && !command.includes("{targets}") && existsSync(canary)) {
        cases.push([".arnx/tests/tests/arnx_generated/test_arnx_probe.py", "test_arnx_probe", "passed", ""]);
      }
      return [junitXml(cases), "", false];
    };
    const [ok, summary] = await runSuite(cfg, snap, join(tmp(), "b.log"), { sessionFactory: fakeFactory(script) });
    expect(existsSync(canary)).toBe(false); // removed after the run
    if (collects) {
      expect(ok).toBe(false);
      expect(summary).toStartWith("the project's test run collects files under .arnx/");
    } else {
      expect(ok).toBe(true);
    }
  }
});
