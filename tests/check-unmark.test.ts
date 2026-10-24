// A confirmed bug's accepted test is marked expected to fail, so the project's own run stays green. check runs it
// without the marker: red while the bug is open; once it passes, check removes the marker from the file and pins the
// file again, so the test locks the fix.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTED_RECORD, changedAccepted, localPinsPath } from "../src/check";
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
const KEPT = "tests/arnx/r20261011_a1b2c3/test_y.py";
const MARKER = `@pytest.mark.xfail(strict=True, reason='arnx review ${RID}: F1 not fixed yet')\n`;

/** A fake sandbox where the accepted test has `outcome`; `seen` gets the accepted file as the run saw it. */
function sandbox(outcome: () => "passed" | "failed", seen: string[]): SessionFactory {
  return async (_c, snap, _l, body) => {
    seen.push(readFileSync(join(snap, KEPT), "utf8"));
    const o = outcome();
    return body(new FakeSession(snap, () => [junitXml([[KEPT, "test_a", o, o === "failed" ? "assert False" : ""]]),
      `1 ${o}`, false]));
  };
}

/** A repository where review RID's F1 was accepted; `check`: accept runs its own check, as it does outside tests. */
async function accepted(outcome: () => "passed" | "failed", seen: string[], env: Record<string, string> = {},
  check = false) {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, checkSessions: sandbox(outcome, seen), env, check });
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
  return { repo, cli };
}

test("an open bug: check runs its test without the marker, says it fails, and leaves the file as accepted", async () => {
  const seen: string[] = [];
  const { repo, cli } = await accepted(() => "failed", seen);
  expect(readFileSync(join(repo, KEPT), "utf8")).toBe(`import pytest\n${MARKER}def test_a():\n    assert False\n`);
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(1);
  expect(seen.at(-1)).toBe("import pytest\ndef test_a():\n    assert False\n");
  expect(cli.stdout).toContain("✗ 1 accepted test still fails (bug not fixed yet)");
  expect(readFileSync(join(repo, KEPT), "utf8")).toContain(MARKER);
});

test("a fixed bug: check removes the marker from the file and pins it again; the next check runs it", async () => {
  let outcome: "passed" | "failed" = "failed";
  const seen: string[] = [];
  const env = { XDG_CONFIG_HOME: tmp() };
  const { repo, cli } = await accepted(() => outcome, seen, env);
  const before = JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files[KEPT].sha256;
  outcome = "passed";
  cli.out.length = 0;
  expect(await cli.run("check")).toBe(0);
  expect(readFileSync(join(repo, KEPT), "utf8")).toBe("import pytest\ndef test_a():\n    assert False\n");
  expect(cli.stdout).toContain("✓ Expected-fail marker removed from 1 test that passes now");
  expect(JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).files[KEPT].sha256).not.toBe(before);
  // Pinned again by arnx on this machine: not an edit.
  expect(changedAccepted(repo, localPinsPath(env, repo))).toEqual([]);
  cli.out.length = 0;
  expect(await cli.run("check", "--json")).toBe(0);
  expect(JSON.parse(cli.stdout).projects[0].unmarked).toEqual([]);
});

test("check --json lists the tests whose marker it removed", async () => {
  let outcome: "passed" | "failed" = "failed";
  const { cli } = await accepted(() => outcome, []);
  outcome = "passed";
  cli.out.length = 0;
  expect(await cli.run("check", "--json")).toBe(0);
  expect(JSON.parse(cli.stdout).projects[0].unmarked).toEqual([`${KEPT}::test_a`]);
});

test("accept's own check: a bug fixed already loses its marker at once, and accept says so", async () => {
  const { repo, cli } = await accepted(() => "passed", [], {}, true);
  expect(readFileSync(join(repo, KEPT), "utf8")).toBe("import pytest\ndef test_a():\n    assert False\n");
  expect(cli.stdout).toContain("The accepted test passes: the bug it proves looks fixed already.\n" +
    "Expected-fail marker removed from 1 test that passes now.");
});
