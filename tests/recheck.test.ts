// check --review: a review's confirmed tests run again on the working tree, before anything is accepted, and say per
// finding whether the bug is fixed. Nothing is copied into the repository and nothing is recorded.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ACCEPTED_RECORD } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { recheckJson, recheckSummary } from "../src/recheck";
import { save } from "../src/report";
import type { SessionFactory } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261020-c0ffee";
const GEN = "tests/arnx_generated/test_x.py";
const BUGGY = "def add(a, b):\n    return a - b\n";
const FIXED = "def add(a, b):\n    return a + b\n";

/** A repository whose add() has the bug, an approved environment, and a review with two confirmed findings (F1, F2),
 * one disputed (F3) and one waiting on an answer (F4), all in one generated file. */
function reviewed(): { repo: string; rdir: string; cli: Cli; seen: string[][];
  snaps: string[] } {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), BUGGY);
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  app:
    root: .
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "buggy add");
  const rdir = join(repo, ".arnx", "reviews", RID);
  const f = (id: string, func: string, verdict: string, over = {}) =>
    ({ ...finding(id, `${GEN}::${func}`, func, GEN, "assert -1 == 5", "add subtracts", verdict), project: "app", ...over });
  save(sampleReview({ id: RID, projects: ["app"], writeDir: "tests/arnx_generated",
    writeDirs: { app: "tests/arnx_generated" }, questions: ["Q?"], questionProjects: ["app"],
    findings: [f("F1", "test_add", "confirmed"), f("F2", "test_add_neg", "confirmed"), f("F3", "test_odd", "disputed"),
      f("F4", "test_maybe", "confirmed", { dependsOn: "Q1" })] }), rdir, "d");
  mkdirSync(join(rdir, "projects", "app", "tests", "tests", "arnx_generated"), { recursive: true });
  writeFileSync(join(rdir, "projects", "app", "tests", GEN), "from app import add\ndef test_add(): assert add(2, 3) == 5\n");
  const seen: string[][] = [], snaps: string[] = [];
  // The fake runner reads the snapshot: the tests pass once app.py adds.
  const sessions: SessionFactory = async (_c, snap, _l, body) => {
    snaps.push(readFileSync(join(snap, GEN), "utf8"));
    const s = new FakeSession(snap, () => {
      const ok = readFileSync(join(snap, "app.py"), "utf8") === FIXED;
      return [junitXml(["test_add", "test_add_neg", "test_odd", "test_maybe"].map((n) =>
        [GEN, n, ok ? "passed" : "failed", "assert -1 == 5"] as [string, string, string, string])),
      ok ? "4 passed" : "4 failed", false];
    });
    const r = await body(s);
    seen.push(s.commands);
    return r;
  };
  const cli = new Cli({ cwd: repo, checkSessions: sessions });
  return { repo, rdir, cli, seen, snaps };
}

test("unfixed: check --review exits 1 and names the confirmed findings still failing, after one run", async () => {
  const { cli, seen, snaps } = reviewed();
  expect(await cli.run("init")).toBe(0);
  cli.out.length = 0;
  expect(await cli.run("check", "--review", RID)).toBe(1);
  expect(cli.stdout).toContain("0 fixed, 2 still failing");
  expect(cli.stdout).toContain(`✗ F1 ${GEN}::test_add: assert -1 == 5`);
  expect(cli.stdout).toContain("✗ F2");
  expect(cli.stdout).not.toContain("F3"); // disputed, and F4 waits on an answer: not the agent's to fix
  expect(cli.stdout).not.toContain("F4");
  expect(seen).toHaveLength(1);
  expect(seen[0]!.filter((c) => c.includes("pytest"))).toHaveLength(1); // one failing run decides it
  expect(snaps[0]).toContain("def test_add"); // the review's generated test, in the snapshot only
});

test("fixed: every confirmed test passes in every run (3), exit 0; nothing copied, marked or recorded", async () => {
  const { repo, rdir, cli, seen } = reviewed();
  expect(await cli.run("init")).toBe(0);
  writeFileSync(join(repo, "app.py"), FIXED);
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  cli.out.length = 0;
  expect(await cli.run("check", "--review")).toBe(0); // no id: the latest review
  expect(cli.stdout).toContain("2 fixed, 0 still failing");
  expect(cli.stdout).toContain("✓ F1");
  expect(seen[0]!.filter((c) => c.includes("pytest"))).toHaveLength(3);
  expect(existsSync(join(repo, GEN))).toBe(false);
  expect(existsSync(join(repo, "tests", "arnx"))).toBe(false);
  expect(existsSync(join(repo, ACCEPTED_RECORD))).toBe(false);
  expect(existsSync(join(rdir, "accepted.json"))).toBe(false);
  expect(readFileSync(join(rdir, "review.md"), "utf8")).toBe(md);
});

test("check --review --json: the review, the result, and each confirmed finding's status and runs", async () => {
  const { repo, cli } = reviewed();
  expect(await cli.run("init")).toBe(0);
  cli.out.length = 0;
  expect(await cli.run("check", "--review", RID, "--json", "--quiet")).toBe(1);
  const j = JSON.parse(cli.stdout);
  expect(j).toEqual({ schema_version: 1, command: "check", review: RID, result: "fail", exit_code: 1, findings: [
    { id: "F1", project: "app", test_id: `${GEN}::test_add`, status: "still-failing", runs: ["failed"],
      message: "assert -1 == 5\ntrace" },
    { id: "F2", project: "app", test_id: `${GEN}::test_add_neg`, status: "still-failing", runs: ["failed"],
      message: "assert -1 == 5\ntrace" }] });
  writeFileSync(join(repo, "app.py"), FIXED);
  cli.out.length = 0;
  expect(await cli.run("check", "--review", "--json")).toBe(0);
  const k = JSON.parse(cli.stdout);
  expect([k.result, k.findings.map((f: { status: string; runs: string[] }) => [f.status, f.runs.length])])
    .toEqual(["pass", [["fixed", 3], ["fixed", 3]]]);
});

test("a run without a report is no-report (exit 2); a test that passes and then fails is still failing", async () => {
  const { repo, rdir } = reviewed();
  const settings = { ...(await import("../src/settings")).defaultSettings(), consentAt: "x" };
  const { recheckReview } = await import("../src/recheck");
  let calls = 0;
  const flaky: SessionFactory = async (_c, snap, _l, body) => body(new FakeSession(snap, () => {
    calls++;
    return [junitXml([[GEN, "test_add", calls === 2 ? "failed" : "passed", "boom"],
      [GEN, "test_add_neg", "passed", ""]]), "", false];
  }));
  const r = await recheckReview(repo, rdir, settings, { sessionFactory: flaky });
  expect(r.findings.map((f) => [f.id, f.status, f.runs])).toEqual([["F1", "still-failing", ["passed", "failed"]],
    ["F2", "fixed", ["passed", "passed", "passed"]]]);
  expect(recheckSummary(r)[1]).toBe(1);
  const silent: SessionFactory = async (_c, snap, _l, body) => body(new FakeSession(snap, () => [null, "crash", true]));
  const s = await recheckReview(repo, rdir, settings, { sessionFactory: silent });
  expect(s.findings.map((f) => [f.status, f.runs])).toEqual([["no-report", ["missing"]], ["no-report", ["missing"]]]);
  expect(recheckSummary(s)[1]).toBe(2);
  expect(JSON.parse(recheckJson(s)).result).toBe("no-report");
});

test("check --review with no such review, or no review yet, is setup needed (exit 3)", async () => {
  const { cli, rdir } = reviewed();
  expect(await cli.run("init")).toBe(0);
  expect(await cli.run("check", "--review", "nope")).toBe(3);
  expect(cli.stderr).toContain("no review nope");
  const { rmSync } = await import("node:fs");
  rmSync(rdir, { recursive: true });
  expect(await cli.run("check", "--review")).toBe(3);
  expect(await cli.run("check", RID)).toBe(2); // an id without --review is a usage error
});

test("a review with no confirmed findings has nothing to run (exit 0)", () => {
  const [text, code] = recheckSummary({ review: RID, findings: [] });
  expect([text, code]).toEqual([`Review ${RID} has no confirmed findings: nothing to run.`, 0]);
  expect(JSON.parse(recheckJson({ review: RID, findings: [] }))).toEqual({ schema_version: 1, command: "check", review: RID,
    result: "nothing-confirmed", exit_code: 0, findings: [] });
});
