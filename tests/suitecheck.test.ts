// Accepted tests run in the project's own runner, in one process with its other tests, and can break them: on a real
// review an accepted conftest swapped a module in sys.modules for the whole pytest run and 12 of the project's own tests
// failed, while every arnx step passed. accept now runs the project's suite with the kept files and, when tests
// outside them fail, again without them; tests that pass then are broken by the accepted tests, and accept refuses.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept } from "../src/accept";
import { ACCEPTED_RECORD } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { ArnxError } from "../src/errors";
import { save } from "../src/report";
import { defaultSettings } from "../src/settings";
import { suiteBreaks } from "../src/suitecheck";
import { fakeFactory, type FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-23T00:00:00Z" };
const KEPT = ["tests/arnx/r1/conftest.py", "tests/arnx/r1/test_deliver_bug.py"];
const OWN = "tests/test_deliver.py";

function repoWithKept(): string {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  bot:
    root: .
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-23"));
  mkdirSync(join(repo, "tests", "arnx", "r1"), { recursive: true });
  writeFileSync(join(repo, OWN), "def test_send():\n    pass\n");
  for (const f of KEPT) writeFileSync(join(repo, f), "x = 1\n");
  return repo;
}

test("tests that fail with the accepted files and pass without them are broken by them", async () => {
  const repo = repoWithKept();
  const seen: FakeSession[] = [];
  const breaks = await suiteBreaks(repo, KEPT, { sessionFactory: fakeFactory((_c, n) => {
    const s = seen[0]!.snap;
    // The second run is the suite without the accepted files.
    if (n === 2) expect(KEPT.some((f) => existsSync(join(s, f)))).toBe(false);
    return [junitXml([[OWN, "test_send", n === 1 ? "failed" : "passed", "AttributeError: MagicMock"],
      [KEPT[1]!, "test_bug", "passed", ""]]), "", false];
  }, seen) });
  expect(seen[0]!.commands.length).toBe(2);
  expect(breaks.map((b) => [b.project, b.broken.map((t) => t.testId), b.files])).toEqual([
    ["bot", [`${OWN}::test_send`], KEPT]]);
});

test("a test failing either way is not the accepted tests' doing; all passing takes one run", async () => {
  const repo = repoWithKept();
  const seen: FakeSession[] = [];
  const red = await suiteBreaks(repo, KEPT, { sessionFactory: fakeFactory(() =>
    [junitXml([[OWN, "test_send", "failed", "boom"]]), "", false], seen) });
  expect(red.flatMap((b) => b.broken)).toEqual([]);
  expect(seen[0]!.commands.length).toBe(2);
  const green: FakeSession[] = [];
  expect(await suiteBreaks(repo, KEPT, { sessionFactory: fakeFactory(() =>
    [junitXml([[OWN, "test_send", "passed", ""]]), "", false], green) })).toEqual([]);
  expect(green[0]!.commands.length).toBe(1);
});

/** A repository with review RID (F1, marked real), its test and a conftest that patches at import. */
function reviewed(): { repo: string; rdir: string } {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  bot:
    root: .
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-23"));
  commit(repo, "layout");
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(sampleReview({ id: RID, findings: [{ ...finding("F1", "tests/g/test_a.py::test_a", "test_a", "tests/g/test_a.py",
    "x", "deliver drops", "confirmed"), project: "bot" }], questions: [], projects: ["bot"], writeDir: "tests/g",
  writeDirs: { bot: "tests/g" } }), rdir, "d");
  mkdirSync(join(rdir, "projects", "bot", "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "projects", "bot", "tests", "tests", "g", "test_a.py"), "def test_a():\n    assert False\n");
  writeFileSync(join(rdir, "projects", "bot", "tests", "tests", "g", "conftest.py"), "import sys\n");
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8"))
    .replace("Mark: [ ] real", "Mark: [x] real"));
  return { repo, rdir };
}

const RID = "20261023-b84ee2";
const breaking = async (files: string[]) => [{ project: "bot", files, broken: [{ testId: `${OWN}::test_send`,
  fileAttr: OWN, name: "test_send", outcome: "failed" as const, message: "AttributeError: MagicMock" }] }];

test("accept refuses tests that break the project's own, and leaves the repository as it was", async () => {
  const { repo, rdir } = reviewed();
  let checked: string[] = [];
  const err = await accept(repo, rdir, SETTINGS, { suiteCheck: async (files) => {
    checked = files;
    return breaking(files);
  } }).catch((e) => e);
  expect(err).toBeInstanceOf(ArnxError);
  expect(checked).toEqual(["tests/arnx/r20261023_b84ee2/conftest.py", "tests/arnx/r20261023_b84ee2/test_deliver_drops.py"]);
  expect((err as Error).message).toBe([
    "Not accepted: the accepted tests break 1 of bot's own tests, which pass without them:",
    `  ✗ ${OWN}::test_send  AttributeError: MagicMock`,
    "Accepted files: tests/arnx/r20261023_b84ee2/conftest.py, tests/arnx/r20261023_b84ee2/test_deliver_drops.py",
    "A test that patches a module or global at import time breaks the tests run after it. Mark its issue rewrite " +
      `(Rewrite: patch in a fixture) or noise, then: arnx accept ${RID}`,
  ].join("\n"));
  expect(existsSync(join(repo, "tests", "arnx"))).toBe(false);
  expect(existsSync(join(rdir, "accepted.json"))).toBe(false);
  expect(existsSync(join(repo, ACCEPTED_RECORD))).toBe(false);
});

test("accept --again refused puts back the files and pins of the earlier accept", async () => {
  const { repo, rdir } = reviewed();
  await accept(repo, rdir, SETTINGS);
  const kept = join(repo, "tests", "arnx", "r20261023_b84ee2", "test_deliver_drops.py");
  const was = readFileSync(kept, "utf8");
  const record = readFileSync(join(repo, ACCEPTED_RECORD), "utf8");
  const done = readFileSync(join(rdir, "accepted.json"), "utf8");
  writeFileSync(join(rdir, "projects", "bot", "tests", "tests", "g", "test_a.py"), "def test_a():\n    assert 1 == 2\n");
  const err = await accept(repo, rdir, SETTINGS, { again: true, suiteCheck: breaking }).catch((e) => e);
  expect((err as Error).message).toEndWith(`then: arnx accept --again ${RID}`);
  expect(readFileSync(kept, "utf8")).toBe(was);
  expect(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")).toBe(record);
  expect(readFileSync(join(rdir, "accepted.json"), "utf8")).toBe(done);
});

test("a repository without review.yaml (a review from before projects) has no suite to run", async () => {
  const repo = gitRepo(tmp());
  expect(await suiteBreaks(repo, ["tests/arnx/r1/test_x.py"], { sessionFactory: fakeFactory(() => {
    throw new Error("ran");
  }) })).toEqual([]);
});
