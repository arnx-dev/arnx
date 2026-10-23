// check: the accepted tests run in the approved sandbox on the working tree as it is, and say what still fails.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { check, checkSummary } from "../src/check";
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
  mkdirSync(join(repo, "svc/tests/arnx/r1"), { recursive: true });
  writeFileSync(join(repo, "svc/calc.py"), "X = 1\n");
  writeFileSync(join(repo, "svc/tests/arnx/r1/test_r1_calc.py"), "def test_ok(): pass\ndef test_bug(): assert 0\n");
  mkdirSync(join(repo, ".arnx"));
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
    ["svc", ["svc/tests/arnx/r1/test_r1_calc.py"], 1, 1]]);
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
