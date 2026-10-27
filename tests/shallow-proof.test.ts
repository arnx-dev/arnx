// A test that reads the code under test as text and matches it proves nothing about behaviour: a review counted three
// such tests as fixes and labelled one a regression. Their before/after outcome is left unknown, and the report says
// why; a test that reads a fixture as its input is judged as any other.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { textBefore, textFix } from "../src/before";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { load, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const G = "tests/arnx_generated";
const FILES: Record<string, string> = {
  [`${G}/test_add.py`]: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n",
  [`${G}/test_text.py`]: "SOURCE = open('app.py').read()\n\ndef test_text():\n    assert 'a + b' in SOURCE\n",
  [`${G}/test_sample.py`]: "def test_sample():\n    assert 'x' in parse(open('tests/fixtures/sample.py').read())\n",
  [`${G}/test_reg.py`]: "def test_reg():\n    assert 'a - b' in open('app.py').read()\n",
};
const id = (name: string) => `${G}/test_${name}.py::test_${name}`;
const xml = (command: string, outcomes: Record<string, [string, string]>) => junitXml(Object.entries(outcomes)
  .filter(([name]) => command.includes(`test_${name}.py`))
  .map(([name, [outcome, message]]) => [`${G}/test_${name}.py`, `test_${name}`, outcome, message]));
/** On the change three tests pass and test_reg fails; before it, the other way round. */
const AFTER: Record<string, [string, string]> = { add: ["passed", ""], text: ["passed", ""], sample: ["passed", ""],
  reg: ["failed", "AssertionError: assert 'a - b' in 'def add'"] };
const BEFORE: Record<string, [string, string]> = { add: ["failed", "assert -1 == 5"],
  text: ["failed", "AssertionError: assert 'a + b' in 'def add'"], sample: ["failed", "AssertionError: assert 'x' in"],
  reg: ["passed", ""] };
const sessions: SessionFactory = async (_cfg, snap, _log, body) => {
  const before = snap.endsWith("/before");
  return body(new FakeSession(snap, (command) => [xml(command, before ? BEFORE : AFTER), "", false]));
};

test("a test that reads the code as text proves no fix and no regression; the report says why", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-26"));
  commit(repo, "add subtracts");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a + b\n");
  const report = JSON.stringify({ tests: [{ test: id("add"), expects: "add sums" }], suspected_defects: [],
    questions: [] });
  const agent = new ScriptedAgent([Object.entries(FILES).map(([path, content]) => tool("write_file", { path, content })),
    [text(report)], [text(report)]]);
  const { review: r, rdir } = await runReview(repo, { settings: { ...defaultSettings(),
    consentAt: "2026-10-26T00:00:00Z" }, agentModel: agent, sessionFactory: sessions,
  challenger: new FakeJson([{ verdict: "confirmed", reason: "the text changed" }]) });

  expect(r.findings.map((f) => [f.testId, f.shallow, f.before?.status, f.before?.asText])).toEqual([
    [id("reg"), "source-text", "unknown", true]]);
  expect(r.findings[0]!.before!.detail).toBe("passes on the code before the change (3 runs), but it reads the code " +
    "as text: no proof of a regression");
  expect(r.fixProof!.map((x) => [x.testId, x.beforeStatus, x.asText])).toEqual([[id("add"), "fixed", undefined],
    [id("sample"), "fixed", undefined], [id("text"), "unknown", true]]); // a fixture read as input is no text check
  expect(r.fixProof!.find((x) => x.testId === id("text"))!.beforeDetail).toBe("fails on the code before the change " +
    "(3 runs), but it reads the code as text: no proof of a fix");

  const md = readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " ");
  expect(md).not.toContain("regression ·");
  expect(md).toContain("- Before the change (unknown): passes on the code before the change (3 runs), but it reads " +
    "the code as text: no proof of a regression");
  expect(md).toContain("Not counted as fixes (it reads the code as text): " +
    "`tests/arnx_generated/test_text.py::test_text`. ## Findings");
  expect(md.slice(md.indexOf("## The change fixes"), md.indexOf("Not counted"))).not.toContain("test_text");
  const said = summary(r, "review.md");
  expect(said).toContain("\n2 tests prove the change fixes something.\n");
  expect(said).not.toContain("regression");
  const json = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as { fix_proof: Record<string, unknown>[];
    findings: { before: Record<string, unknown> }[] };
  expect(json.fix_proof.find((x) => x.test_id === id("text"))).toMatchObject({ before_status: "unknown",
    as_text: true });
  expect(json.findings[0]!.before).toMatchObject({ status: "unknown", as_text: true });
  expect(load(rdir).fixProof).toEqual(r.fixProof!);
  expect(load(rdir).findings[0]!.before).toEqual(r.findings[0]!.before!);
});

test("only a regression or a fix is set aside: other outcomes stand as they are", () => {
  const runs = ["failed", "failed", "failed"];
  expect(textBefore({ status: "pre-existing", detail: "d", runs })).toEqual({ status: "pre-existing", detail: "d",
    runs });
  expect(textFix({ status: "new-code", detail: "d", runs })).toEqual({ status: "new-code", detail: "d", runs });
  expect(textFix({ status: "fixed", detail: "d", runs, message: "m" })).toEqual({ status: "unknown",
    detail: "fails on the code before the change (3 runs), but it reads the code as text: no proof of a fix", runs,
    message: "m", asText: true });
});
