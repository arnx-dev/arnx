// Neutrality goldens: two fixture reviews whose review.json and review.md must keep the same content (after
// normalising) as tracing is added.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp, stampFile } from "../src/config";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, fakeFactory, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const NOW = new Date("2026-10-16T12:00:00Z");
const GOLDEN = join(import.meta.dir, "fixtures/golden");
const GEN = "tests/arnx_generated/test_x.py";

/** Replace what differs between runs: the review id, the duration, the temp directory, the base commit (its time). */
function normalise(rdir: string, root: string): { json: string; md: string; files: string[] } {
  const rid = rdir.split("/").at(-1)!;
  const clean = (s: string) => s.replaceAll(rid, "<ID>").replaceAll(root, "<TMP>")
    .replace(/\(base [0-9a-f]{7,40}\)/g, "(base <SHA>)");
  const review = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as Record<string, unknown>;
  review.seconds = 0;
  const json = clean(JSON.stringify(review, null, 2)) + "\n";
  const md = clean(readFileSync(join(rdir, "review.md"), "utf8"))
    .replace(/ · (\d+m\d{2}s|\d+s) · Agent stopped/, " · <S> · Agent stopped");
  return { json, md, files: readdirSync(rdir).filter((f) => f !== "events.jsonl").sort() };
}

function check(name: string, rdir: string, files: string[]): void {
  const got = normalise(rdir, tmp());
  const path = (ext: string) => join(GOLDEN, `neutral-${name}.review.${ext}`);
  expect(got.files).toEqual(files);
  expect(got.json).toBe(readFileSync(path("json"), "utf8"));
  expect(got.md).toBe(readFileSync(path("md"), "utf8"));
}

test("a hunting review writes the same review.json and review.md", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"), { recursive: true });
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return 0\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
  const session: SessionFactory = async (_cfg, snap, _log, body) =>
    body(new FakeSession(snap, () => [junitXml([[GEN, "test_spread_positive", "failed", "assert -0.5 >= 0"],
      [GEN, "test_empty", "passed", ""]]), "1 failed, 1 passed", false]));
  const hunter = JSON.stringify({ suspects: [
    { file: "svc/calc.py", line: 2, claim: "spread is negative", why: "returns -0.5", input: "[1, 3]", expected: "0.5",
      actual: "-0.5" },
    { file: "svc/calc.py", line: 1, claim: "empty input crashes", why: "w", input: "[]", expected: "0",
      actual: "error" }],
    questions: ["Should an empty list count as equal?"] });
  const proved = JSON.stringify({ tests: [
    { test: `${GEN}::test_spread_positive`, expects: "non-negative", suspect: "S1" },
    { test: `${GEN}::test_empty`, expects: "0", suspect: "S3" }], suspected_defects: [], questions: [],
    suspects_not_tested: [{ suspect: "S2", reason: "needs the network" }] });
  const agent = new ScriptedAgent([
    [tool("write_file", { path: `svc/${GEN}`, content: "x" })], // refused during the hunt
    [tool("read_file", { path: "svc/calc.py" })], [text(hunter)],
    [tool("write_file", { path: `svc/${GEN}`,
      content: "import calc\ndef test_spread_positive(): pass\ndef test_empty(): pass\n" })],
    [text(proved)],
    [text(proved)], // asked once about S2 and S4: the reviewer keeps its answer
  ]);
  const second = new FakeJson([{ suspects: [{ file: "svc/calc.py", line: 2, claim: "dup", why: "", input: "",
    expected: "", actual: "" }, { file: "svc/calc.py", line: 40, claim: "far away", why: "", input: "", expected: "",
    actual: "" }], questions: [] }, { verdict: "confirmed", reason: "sign" }]);
  // Off: these goldens pin what a review writes without the before/after check (today's output).
  const settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" };
  const { rdir } = await runReview(repo, { settings, agentModel: agent, challenger: second, sessionFactory: session,
    hunt: true, now: NOW });
  check("hunt", rdir, ["change.diff", "projects", "review.json", "review.md", "second-opinion.jsonl", "state.json",
    "verdicts.json"]);
});

test("a plain review writes the same review.json and review.md", async () => {
  const repo = gitRepo(tmp());
  const path = reviewConfigPath(repo);
  mkdirSync(dirname(path));
  writeFileSync(path, stamp(parseReviewConfig("version: 1\nimage: python:3.12-slim\n" +
    "test_command: python -m pytest -q {targets}\n"), "Dev", "2026-10-11"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  const gen = "tests/arnx_generated/test_add.py";
  const report = '{"tests": [{"test": "tests/arnx_generated/test_add.py::test_add", "expects": "add sums"},' +
    ' {"test": "tests/arnx_generated/test_add.py::test_zero", "expects": "zero is neutral"}],' +
    ' "suspected_defects": [{"test": "tests/arnx_generated/test_add.py::test_add",' +
    ' "explanation": "add subtracts instead of adding."}],' +
    ' "questions": ["Should add accept strings?"]}';
  const agent = new ScriptedAgent([
    [tool("write_file", { path: gen, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" +
      "\ndef test_zero():\n    assert add(0, 0) == 0\n" })],
    [text(report)],
  ]);
  const runs = (): [string | null, string, boolean] =>
    [junitXml([[gen, "test_add", "failed", "assert -1 == 5"], [gen, "test_zero", "passed", ""]]), "", false];
  const judge = new FakeJson([{ verdict: "confirmed", reason: "add subtracts." }]);
  // Off: these goldens pin what a review writes without the before/after check (today's output).
  const settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-11T00:00:00Z" };
  const { rdir } = await runReview(repo, { settings, agentModel: agent, challenger: judge,
    sessionFactory: fakeFactory(runs), now: NOW });
  check("plain", rdir, ["change.diff", "review.json", "review.md", "round.json", "second-opinion.jsonl", "state.json",
    "tests", "transcript.jsonl", "verdicts.json"]);
  expect(existsSync(join(rdir, "review.md"))).toBe(true);
});
