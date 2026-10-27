// A change that edits accepted tests or their pins is named by the review that covers it (progress, review.md,
// review.json): check trusts the committed pins on a fresh clone or in CI, so only a review of the change shows it
// there. Tests and entries a change only adds (what accept writes) are not named.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ACCEPTED_RECORD, changeEditsAccepted, recordAccepted } from "../src/check";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { FakeJson, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const KEPT = ".arnx/tests/tests/arnx/r20261011_a1b2c3/test_total.py";
const OTHER = ".arnx/tests/tests/arnx/r20261012_d4e5f6/test_more.py";

const write = (repo: string, path: string, body: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), body);
};

/** An approved repository with one accepted test, pinned and committed. */
function acceptedRepo(): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(
    "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n"), "Dev", "2026-10-11"));
  write(repo, KEPT, "from app import add\n\ndef test_total():\n    assert add(2, 3) == 5\n");
  recordAccepted(repo, RID, { [KEPT]: ["test_total"] });
  commit(repo, "accepted tests");
  return repo;
}

const change = (repo: string, head: string | null = "HEAD") =>
  ({ base: runGit(repo, "rev-parse", head ? "HEAD~1" : "HEAD").trim(), head });

test("an edited or deleted accepted test, or a changed pin, is named; only added ones are not", () => {
  const repo = acceptedRepo();
  // accept's own output: a new test and its entry
  write(repo, OTHER, "def test_more():\n    assert True\n");
  recordAccepted(repo, "20261012-d4e5f6", { [OTHER]: ["test_more"] });
  commit(repo, "more accepted tests");
  expect(changeEditsAccepted(repo, change(repo))).toEqual([]);

  // the test weakened and its pin forged with it
  write(repo, KEPT, "def test_total():\n    assert True\n");
  recordAccepted(repo, RID, { [KEPT]: ["test_total"] });
  expect(changeEditsAccepted(repo, change(repo, null))).toEqual([ACCEPTED_RECORD, KEPT]);
  commit(repo, "weaken");
  expect(changeEditsAccepted(repo, change(repo))).toEqual([ACCEPTED_RECORD, KEPT]);

  // a deleted test whose entry stays
  rmSync(join(repo, OTHER));
  expect(changeEditsAccepted(repo, change(repo, null))).toEqual([OTHER]);
});

const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-11T00:00:00Z" };
const GEN = "tests/arnx_generated/test_add.py";
const REPORT = '{"tests": [{"test": "tests/arnx_generated/test_add.py::test_add", "expects": "add sums"}],' +
  ' "suspected_defects": [], "questions": []}';
const writer = () => new ScriptedAgent([
  [tool("write_file", { path: GEN, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" })],
  [text(REPORT)],
]);

async function review(repo: string, range: string | null = null) {
  const said: string[] = [];
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: writer(), challenger: new FakeJson([]),
    sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "passed", ""]]), "", false]),
    progress: (m) => said.push(m), range });
  return { said, json: JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as Record<string, unknown>,
    md: readFileSync(join(rdir, "review.md"), "utf8") };
}

test("a review of a commit that edits an accepted test says so: progress, review.md, review.json", async () => {
  const repo = acceptedRepo();
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const plain = await review(repo);
  expect("accepted_tests_edited" in plain.json).toBe(false);
  expect(plain.md).not.toContain("accepted tests");

  write(repo, KEPT, "def test_total():\n    assert True\n");
  commit(repo, "break add, weaken its test");
  const edited = await review(repo, "HEAD~1..HEAD");
  expect(edited.said).toContain(`this change edits accepted tests: ${KEPT}`);
  expect(edited.json.accepted_tests_edited).toEqual([KEPT]);
  expect(edited.md).toContain(`- This change edits accepted tests: ${KEPT}.`);
});
