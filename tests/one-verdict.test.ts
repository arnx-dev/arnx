// One test's cases get one verdict: a case the second opinion confirmed waits for the others, so nothing shown as proven
// is taken back when another case is disputed.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const SETTINGS = { ...defaultSettings(), consentAt: "2026-11-03T00:00:00Z" };
const FILE = "tests/arnx_generated/test_add.py";
const SOURCE = "import pytest\nfrom app import add\n\n@pytest.mark.parametrize('n', ['a', 'b'])\ndef test_add(n):\n    assert add(1, 1) == 2\n";
const FAILING = junitXml([[FILE, "test_add[a]", "failed", "assert 0 == 2"], [FILE, "test_add[b]", "failed", "assert 0 == 2"]]);
const PASSING = junitXml([[FILE, "test_add[a]", "passed", ""], [FILE, "test_add[b]", "passed", ""]]);
const sessions: SessionFactory = async (_cfg, snap, _log, body) =>
  body(new FakeSession(snap, () => [snap.endsWith("/before") ? PASSING : FAILING, "", false]));

function repo(): string {
  const r = gitRepo(tmp());
  writeFileSync(join(r, "app.py"), "def add(a, b):\n    return a + b\n");
  mkdirSync(dirname(reviewConfigPath(r)));
  writeFileSync(reviewConfigPath(r), stamp(parseReviewConfig(YAML), "Dev", "2026-11-03"));
  commit(r, "add");
  writeFileSync(join(r, "app.py"), "def add(a, b):\n    return a - b\n");
  return r;
}
const report = JSON.stringify({ tests: [{ test: `${FILE}::test_add[a]`, expects: "adds" }, { test: `${FILE}::test_add[b]`,
  expects: "adds" }], suspected_defects: [{ id: "S1", file: "app.py", line: 2, claim: "add subtracts" }], questions: [] });
const agent = () => new ScriptedAgent([[tool("write_file", { path: FILE, content: SOURCE })], [text(report)], [text(report)]]);

async function run(verdicts: { verdict: string; reason: string }[]) {
  const lines: string[] = [];
  const { review } = await runReview(repo(), { settings: SETTINGS, agentModel: agent(), sessionFactory: sessions,
    challenger: new FakeJson([...verdicts, { issues: [] }]), progress: (l: string) => { lines.push(l); } });
  return { review, lines };
}

test("cases that disagree: both disputed, none shown as proven", async () => {
  const { review, lines } = await run([{ verdict: "confirmed", reason: "real" }, { verdict: "disputed", reason: "a race" }]);
  expect(review.findings.map((f) => f.verdict)).toEqual(["disputed", "disputed"]);
  expect(review.findings.map((f) => f.reason).join(" ")).toContain("another case of this test was disputed: a race");
  expect(lines.filter((l) => l.startsWith("✓ proven"))).toEqual([]);
});

test("cases that agree: each shown as proven", async () => {
  const { review, lines } = await run([{ verdict: "confirmed", reason: "real" }, { verdict: "confirmed", reason: "real" }]);
  expect(review.findings.map((f) => f.verdict)).toEqual(["confirmed", "confirmed"]);
  expect(lines.filter((l) => l.startsWith("✓ proven"))).toHaveLength(2);
});
