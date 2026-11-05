// A test's cases keep their own verdict, reason and judge. Cases that differ only by a fixture outside the test are
// the same question: they get one call and share its answer, and say so (`sameAs`).
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { caseGroups, shareVerdict } from "../src/challenge";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import type { JsonModel } from "../src/llm";
import { render } from "../src/report";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { finding } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const SETTINGS = { ...defaultSettings(), consentAt: "2026-11-03T00:00:00Z" };
const FILE = "tests/arnx_generated/test_add.py";
const BODY = "def test_add(n):\n    assert add(1, 1) == 2\n";
const HEAD = "import pytest\nfrom app import add\n\n";
const DATA = `${HEAD}@pytest.mark.parametrize('n', ['a', 'b'])\n${BODY}`;
// `n` is a fixture of a conftest: the cases come from outside the file.
const FIXTURE = `${HEAD}${BODY}`;
const OWN_PARAMS = `${HEAD}@pytest.fixture(params=['a', 'b'])\ndef n(request):\n    return request.param\n\n${BODY}`;
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
const agent = (source: string) =>
  new ScriptedAgent([[tool("write_file", { path: FILE, content: source })], [text(report)], [text(report)]]);

/** Answers in turn; the second answer is given by another model (the fallback). */
class Turns implements JsonModel {
  ref = "openai:main-judge";
  calls: string[] = [];
  constructor(private replies: Record<string, unknown>[], private by: (string | undefined)[] = []) {}
  async completeJson(_s: string, user: string): Promise<[Record<string, unknown>, number, undefined, undefined, string?]> {
    this.calls.push(user);
    const n = this.calls.length - 1;
    return [this.replies[n] ?? { issues: [] }, 0.01, undefined, undefined, this.by[n]];
  }
}

async function run(source: string, challenger: JsonModel) {
  const lines: string[] = [];
  const { review } = await runReview(repo(), { settings: SETTINGS, agentModel: agent(source), sessionFactory: sessions,
    challenger, progress: (l: string) => { lines.push(l); } });
  return { review, lines };
}
// Every call but the last, which groups the findings by cause.
const asked = (m: { calls: string[] }) => m.calls.length - 1;

test("data cases of one test keep their own verdict, reason and judge", async () => {
  const model = new Turns([{ verdict: "disputed", reason: "a race" }, { verdict: "confirmed", reason: "a real defect" }],
    [undefined, "other:fallback-judge"]);
  const { review, lines } = await run(DATA, model);
  expect(review.findings.map((f) => f.verdict)).toEqual(["disputed", "confirmed"]);
  expect(review.findings.map((f) => f.reason).join(" ")).not.toContain("another case");
  expect(review.findings.map((f) => f.judge)).toEqual([undefined, "other:fallback-judge"]);
  expect(render(review)).toContain("Second opinion (other:fallback-judge): a real defect");
  expect(lines.filter((l) => l.startsWith("✓ proven"))).toHaveLength(1);
});

test("cases that differ only by a fixture outside the test get one call and one verdict", async () => {
  const model = new FakeJson([{ verdict: "confirmed", reason: "real", depends_on: "" }, { issues: [] }]);
  const { review } = await run(FIXTURE, model);
  expect(asked(model)).toBe(1);
  expect(review.findings.map((f) => f.verdict)).toEqual(["confirmed", "confirmed"]);
  expect(review.findings[1]!.reason).toBe(review.findings[0]!.reason);
  expect(review.findings[0]!.sameAs).toBeUndefined();
  expect(review.findings[1]!.sameAs).toBe(review.findings[0]!.id);
});

test("data cases get one call each", async () => {
  const model = new FakeJson([{ verdict: "confirmed", reason: "r1" }, { verdict: "confirmed", reason: "r2" }, { issues: [] }]);
  const { review } = await run(DATA, model);
  expect(asked(model)).toBe(2);
  expect(review.findings.map((f) => f.reason)).toEqual(["r1", "r2"]);
  expect(review.findings.every((f) => f.sameAs === undefined)).toBe(true);
});

const cases = (...ids: string[]) => ids.map((id) =>
  finding(id, `${FILE}::test_add[${id}]`, "test_add", FILE, "assert 0 == 2", "why"));
test("caseGroups: same first line only, never across a fallback image or a data decorator", () => {
  const [a, b, c] = cases("a", "b", "c");
  c!.message = "assert 1 == 2";
  expect(caseGroups([a!, b!, c!], { [FILE]: FIXTURE }).map((g) => g.map((f) => f.id))).toEqual([["a", "b"], ["c"]]);
  b!.fallback = true;
  expect(caseGroups([a!, b!], { [FILE]: FIXTURE }).map((g) => g.length)).toEqual([1, 1]);
  expect(caseGroups([a!, cases("z")[0]!], { [FILE]: DATA }).map((g) => g.length)).toEqual([1, 1]);
  expect(caseGroups(cases("a", "b"), { [FILE]: `${HEAD}# @pytest.mark.parametrize\n${BODY}` })).toHaveLength(1);
  expect(caseGroups(cases("a", "b"), { [FILE]: OWN_PARAMS })).toHaveLength(2);
  expect(caseGroups(cases("a", "b"), {})).toHaveLength(2);
});

const SHAPES: Record<string, string> = {
  "class-level parametrize": "import pytest\n@pytest.mark.parametrize('n',[1,2])\nclass TestK:\n    def test_add(self, n):\n        assert n==2\n",
  "pytestmark": "import pytest\npytestmark = pytest.mark.parametrize('n',[1,2])\ndef test_add(n):\n    assert n==2\n",
  "pytest_generate_tests": "def pytest_generate_tests(metafunc):\n    metafunc.parametrize('n',[1,2])\ndef test_add(n):\n    assert n==2\n",
  "metafunc.parametrize": "def hook(metafunc):\n    metafunc.parametrize('n',[1,2])\ndef test_add(n):\n    assert n==2\n",
  "fixture with ** params": "import pytest\n@pytest.fixture(**{'params':[1,2]})\ndef n(request): return request.param\ndef test_add(n):\n    assert n==2\n",
  "rust values": "#[rstest]\nfn test_add(#[values(1,2)] n: i32) { assert_eq!(n,2) }\n",
};
test("caseGroups: data that lives in the file, outside the test's own decorators, is not merged", () => {
  for (const [name, source] of Object.entries(SHAPES)) {
    const file = name === "rust values" ? "tests/t.rs" : FILE;
    const fs = cases("a", "b").map((f) => ({ ...f, file }));
    expect([name, caseGroups(fs, { [file]: source }).length]).toEqual([name, 2]);
  }
});

test("a case keeps its own dependsOn, and carries sameAs only with a verdict", async () => {
  const [a, b] = cases("a", "b");
  a!.verdict = "confirmed"; a!.reason = "r"; a!.dependsOn = "Q1"; b!.dependsOn = "Q2";
  shareVerdict(a!, b!);
  expect([b!.dependsOn, b!.sameAs]).toEqual(["Q2", "a"]);
  const [c, d] = cases("c", "d");
  shareVerdict(c!, d!);
  expect(d!.sameAs).toBeUndefined();
});

test("a case that took another's verdict says so in the report", async () => {
  const model = new FakeJson([{ verdict: "confirmed", reason: "real", depends_on: "" }, { issues: [] }]);
  const { review } = await run(FIXTURE, model);
  const id = review.findings[0]!.id;
  expect(render(review)).toContain(`Same call as ${id}`);
  expect(render(review).split(`Same call as ${id}`).length).toBe(2);
});
