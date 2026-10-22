// The hunt: suspects found by reading, before tests; each is then proven, not reproduced or left untested by its test.
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { python } from "../src/adapters/python";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { changedDefinitions, changedLines, contextPack, enclosing } from "../src/context";
import { huntParts, interleave, mergeSuspects, PART_CONCURRENCY, partHunts, parseSuspects, partition,
  rankSuspects } from "../src/hunt";
import { LocalBrain } from "../src/localbrain";
import { ModelError } from "../src/errors";
import { costUsd, lastJsonObject, newUse, PRICES } from "../src/llm";
import { coverageTask, proveTask } from "../src/prompts";
import { load, render, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { databaseEnv, dbUntested } from "../src/untested";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

test("changed lines are new-side line numbers, removals included", () => {
  const diff = "diff --git a/x.py b/x.py\n--- a/x.py\n+++ b/x.py\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n@@ -10,2 +10,3 @@\n k\n+l\n m\n";
  expect(changedLines(diff).get("x.py")).toEqual([2, 2, 11]);
});

test("git's no-newline marker is not a line: a file with no final newline keeps its line numbers", () => {
  // The last line changed in a file that never ended with a newline: git adds "\\ No newline at end of file"
  // after each side's last line. Counted as a line, it pushed the new line one past the end of the file.
  const diff = "diff --git a/index.ts b/index.ts\n--- a/index.ts\n+++ b/index.ts\n@@ -1,3 +1,3 @@\n" +
    " function f() {\n   return 1;\n-}\n\\ No newline at end of file\n+} // end\n\\ No newline at end of file\n";
  expect(changedLines(diff).get("index.ts")).toEqual([3, 3]);
  const root = tmp();
  writeFileSync(join(root, "index.ts"), "function f() {\n  return 1;\n} // end");
  expect(() => contextPack(root, diff, ["index.ts"], ["."])).not.toThrow();
});

test("a line past the end of a file with no final newline reads as with the newline, not past the array", () => {
  // A removal at the end of a file is numbered one past its last line; a file that ends with a newline splits with
  // an empty last element there, one that does not has nothing to read.
  const withNewline = enclosing(["def f():", "    return 1", ""], 3);
  expect(withNewline).toEqual({ name: "f", kind: "function", line: 1 });
  expect(enclosing(["def f():", "    return 1"], 3)).toEqual(withNewline);
});

test("a line belongs to the function around it, or to the module constant it is part of", () => {
  const lines = ["import os", "", "SQL = \"\"\"", "SELECT a", "FROM t", "\"\"\"", "", "class A:", "    def m(self):",
    "        return 1", "", "def f(x):", "    if x:", "        return 2"];
  expect(enclosing(lines, 4)).toEqual({ name: "SQL", kind: "constant", line: 3 });
  expect(enclosing(lines, 10)).toEqual({ name: "m", kind: "function", line: 9 });
  expect(enclosing(lines, 14)).toEqual({ name: "f", kind: "function", line: 12 });
  expect(enclosing(lines, 1)).toBeNull();
});

test("the context pack lists where a changed function is referred to, step lists included, tests left out", () => {
  const root = tmp();
  mkdirSync(join(root, "app/tests"), { recursive: true });
  writeFileSync(join(root, "app/jobs.py"), "def evaluate(pg):\n    return pg\n\ndef score(pg):\n    return 1\n");
  writeFileSync(join(root, "app/main.py"), "import jobs\n\ndef run_once(pg):\n    for step in (jobs.evaluate, jobs.score):\n" +
    "        step(pg)\n\ndef main():\n    run_once(None)\n");
  writeFileSync(join(root, "app/tests/test_jobs.py"), "from jobs import evaluate\n");
  const diff = "diff --git a/app/jobs.py b/app/jobs.py\n--- a/app/jobs.py\n+++ b/app/jobs.py\n@@ -1,2 +1,2 @@\n def evaluate(pg):\n-    return None\n+    return pg\n";
  const pack = contextPack(root, diff, ["app/jobs.py"], ["app"]);
  expect(pack).toContain("- `app/jobs.py` function `evaluate` (line 1): 1 references");
  expect(pack).toContain("  - app/main.py:4 in run_once: for step in (jobs.evaluate, jobs.score):");
  expect(pack).toContain("    - `run_once` is used at app/main.py:8 (main)");
  expect(pack).not.toContain("test_jobs.py");
  expect(pack).not.toContain("`score`"); // unchanged
});

test("suspects are parsed, kept when they name a file and a claim, merged across hunters and numbered", () => {
  const a = parseSuspects({ suspects: [{ file: "/q.py", line: 10, claim: "Sign wrong.", why: "w", input: "i",
    expected: "e", actual: "a" }, { file: "", claim: "no file" }] }, "claude");
  const b = parseSuspects({ suspects: [{ file: "q.py", line: 10, claim: "sign wrong" },
    { file: "q.py", line: 10, claim: "another defect on the same line" }, { file: "p.py", line: 3, claim: "other" }] }, "gpt");
  expect(a.map((s) => s.file)).toEqual(["q.py"]);
  const m = mergeSuspects(a, b);
  // only the same claim about the same place is dropped: two defects can share a line
  expect(m.map((s) => [s.id, s.line, s.by])).toEqual([["S1", 10, "claude"], ["S2", 10, "gpt"], ["S3", 3, "gpt"]]);
  const cfg = parseReviewFile("version: 1\nprojects:\n  svc:\n    root: svc\n    image: python:3.12-slim\n" +
    "    test_command: python -m pytest {targets}\n").projects[0]!;
  const t = proveTask(cfg, m, 5);
  expect(t).toContain("S1 `q.py:10`: Sign wrong.\n  Why: w\n  Shown by: i. Expected: e. Actual: a.\nS2 `q.py:10`: another defect on the same line\nS3");
  expect(t).toContain('"suspects_not_tested"');
});

test("SQL files need a test that runs them against the database; only SQL services count", () => {
  expect(databaseEnv({ DB: "postgresql://u:p@tapepg:5432/x", R: "redis", OTHER: "x" },
    [{ name: "tapepg", image: "postgres:16-alpine" }, { name: "redis", image: "redis:7" }])).toEqual(["DB"]);
  expect(databaseEnv({ R: "redis" }, [{ name: "redis", image: "redis:7" }])).toEqual([]);
  const files: Record<string, string> = { "svc/queries.py": "Q = \"\"\"SELECT a FROM t\"\"\"\n", "svc/util.py": "X = 1\n" };
  const read = (p: string) => files[p] ?? null;
  const owned = ["svc/queries.py", "svc/util.py"];
  expect(dbUntested(owned, read, { "t.py": "import queries\nassert 'now()' not in queries.Q" }, python, ["DB"]))
    .toEqual(["svc/queries.py"]);
  expect(dbUntested(owned, read, { "t.py": "import os, queries\nconn = connect(os.environ['DB'])" }, python, ["DB"]))
    .toEqual([]);
  expect(dbUntested(owned, read, {}, python, [])).toEqual([]);
  expect(coverageTask([], { files: ["svc/queries.py"], names: ["DB"] }))
    .toStartWith("These changed files hold database code, and no test that connects to the database refers to them");
});

// The fakes report the same failure on any snapshot, so the before/after check would call every finding
// pre-existing; it is off here and tested in before.test.ts.
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" };
const GEN = "tests/arnx_generated/test_x.py";
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
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
});

test("a review hunts first in the same conversation, tests each suspect, and reports what each test showed",
  async () => {
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
  const session: SessionFactory = async (_cfg, snap, _log, body) =>
    body(new FakeSession(snap, () => [junitXml([[GEN, "test_spread_positive", "failed", "assert -0.5 >= 0"],
      [GEN, "test_empty", "passed", ""]]), "1 failed, 1 passed", false]));
  const hunter = JSON.stringify({ suspects: [
    { file: "svc/calc.py", line: 2, claim: "spread is negative", why: "returns -0.5", input: "[1, 3]", expected: "0.5",
      actual: "-0.5" },
    { file: "svc/calc.py", line: 1, claim: "empty input crashes", why: "w", input: "[]", expected: "0", actual: "error" }],
    questions: ["Should an empty list count as equal?"] });
  const agent = new ScriptedAgent([
    [tool("write_file", { path: `svc/${GEN}`, content: "x" })], // refused during the hunt
    [tool("read_file", { path: "svc/calc.py" })], [text(hunter)],
    [tool("write_file", { path: `svc/${GEN}`, content: "import calc\ndef test_spread_positive(): pass\ndef test_empty(): pass\n" })],
    [text(JSON.stringify({ tests: [{ test: `${GEN}::test_spread_positive`, expects: "non-negative", suspect: "S1" },
      { test: `${GEN}::test_empty`, expects: "0", suspect: "S3" }], suspected_defects: [], questions: [],
      suspects_not_tested: [{ suspect: "S2", reason: "needs the network" }] }))],
    // asked once about S2 and S4: the reviewer keeps its answer
    [text(JSON.stringify({ tests: [{ test: `${GEN}::test_spread_positive`, expects: "non-negative", suspect: "S1" },
      { test: `${GEN}::test_empty`, expects: "0", suspect: "S3" }], suspected_defects: [], questions: [],
      suspects_not_tested: [{ suspect: "S2", reason: "needs the network" }] }))],
  ]);
  const second = new FakeJson([{ suspects: [{ file: "svc/calc.py", line: 2, claim: "dup", why: "", input: "",
    expected: "", actual: "" }, { file: "svc/calc.py", line: 40, claim: "far away", why: "", input: "", expected: "",
    actual: "" }], questions: [] }, { verdict: "confirmed", reason: "sign" }]);
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: second,
    sessionFactory: session, hunt: true });
  // one conversation: the hunt opens it with the change and its context; writing waits for the hunt's reply
  expect(String(agent.calls[0]!.messages[0]!.content)).toContain("- `svc/calc.py` function `spread` (line 1)");
  expect(String(agent.calls[0]!.messages[0]!.content)).toContain("Do not write or run tests yet");
  expect(JSON.stringify(agent.calls[1]!.messages.at(-1)!.content)).toContain("not yet: first reply with the suspects");
  const prove = String(agent.calls[3]!.messages.at(-1)!.content);
  expect(prove).toStartWith("Now test.");
  expect(prove).toContain("S1 `svc/calc.py:2`: spread is negative");
  // the hunters' lists are taken in turn: the reviewer's first, then the second hunter's first, …
  expect(prove).toContain("S2 `svc/calc.py:2`: dup\nS3 `svc/calc.py:1`: empty input crashes");
  expect(prove).toContain("S4 `svc/calc.py:40`: far away");
  const asked = String(agent.calls[5]!.messages.at(-1)!.content);
  expect(asked).toStartWith("These suspects have no test yet: S2 (you said: needs the network), S4.");
  // the second hunter got the changed definitions whole, not the files
  expect(second.calls[0]).toContain('<definition file="svc/calc.py" lines="1-2">');
  expect(review.suspects!.map((s) => [s.id, s.outcome, s.by])).toEqual([["S1", "proven", "claude-sonnet-5-5"],
    ["S2", "not tested", "gpt-5.5-2026-04-23"], ["S3", "not reproduced", "claude-sonnet-5-5"],
    ["S4", "not tested", "gpt-5.5-2026-04-23"]]);
  expect(review.suspects![0]!.findings).toEqual(["F1"]);
  expect(review.suspects![1]!.reason).toBe("needs the network");
  expect(review.findings[0]!.suspect).toBe("S1");
  expect(review.questions).toEqual(["Should an empty list count as equal?"]);
  const md = render(review);
  expect(md).toContain("## Suspected before testing");
  expect(md).toContain("4 suspected · 1 proven · 1 not reproduced · 2 not tested");
  expect(md).toContain("- S3 `svc/calc.py:1`: empty input crashes — not reproduced: its test passed (`" + GEN +
    "::test_empty`), which does not rule it out.");
  expect(md).toContain("- Suspected before testing (S1, claude-sonnet-5-5): spread is negative");
  expect(summary(review, "review.md")).not.toContain("Suspected before testing"); // review.md has it
  // the second hunter's cost is counted with its second-opinion calls, as one model
  expect(review.usage.map((u) => [u.model, u.calls])).toEqual([["anthropic:claude-sonnet-5-5", 6],
    ["openai:gpt-5.5-2026-04-23", 2]]);
  expect(load(rdir)).toEqual(review);
});

test("a suspect whose test failed is proven only once the second model confirms it", async () => {
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
  const session: SessionFactory = async (_cfg, snap, _log, body) =>
    body(new FakeSession(snap, () => [junitXml([[GEN, "test_spread_positive", "failed", "assert -0.5 >= 0"]]),
      "1 failed", false]));
  const agent = new ScriptedAgent([
    [text(JSON.stringify({ suspects: [{ file: "svc/calc.py", line: 2, claim: "spread is negative", why: "", input: "",
      expected: "", actual: "" }], questions: [] }))], // the hunt, then the tests in the same conversation
    [tool("write_file", { path: `svc/${GEN}`, content: "import calc\ndef test_spread_positive(): pass\n" })],
    [text(JSON.stringify({ tests: [{ test: `${GEN}::test_spread_positive`, expects: "x", suspect: "S1" }],
      suspected_defects: [], questions: [] }))]]);
  const judge = new FakeJson([{ suspects: [], questions: [] }, { verdict: "disputed", reason: "the test is wrong" }]);
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge,
    sessionFactory: session, hunt: true });
  expect(review.suspects!.map((s) => [s.id, s.outcome, s.findings])).toEqual([["S1", "disputed", ["F1"]]]);
  expect(render(review)).toContain("its test failed, but the second model disputed it: F1");
});

test("a test written for a suspect a question names waits on that question, though the question lists no test",
  async () => {
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
  const session: SessionFactory = async (_cfg, snap, _log, body) =>
    body(new FakeSession(snap, () => [junitXml([[GEN, "test_spread_positive", "failed", "assert -0.5 >= 0"]]),
      "1 failed", false]));
  const agent = new ScriptedAgent([
    [text(JSON.stringify({ suspects: [{ file: "svc/calc.py", line: 2, claim: "spread is negative", why: "", input: "",
      expected: "", actual: "" }], questions: [] }))],
    [tool("write_file", { path: `svc/${GEN}`, content: "import calc\ndef test_spread_positive(): pass\n" })],
    [text(JSON.stringify({ tests: [{ test: `${GEN}::test_spread_positive`, expects: "x", suspect: "S1" }],
      suspected_defects: [], questions: ["Should spread ever be negative? (S1)"] }))]]);
  const judge = new FakeJson([{ suspects: [], questions: [] }, { verdict: "confirmed", reason: "negative" }]);
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge,
    sessionFactory: session, hunt: true });
  expect(review.findings.map((f) => [f.id, f.verdict, f.dependsOn])).toEqual([["F1", "confirmed", "Q1"]]);
  expect(review.suspects!.map((x) => x.outcome)).toEqual(["pending answer"]);
});

test("a reply of several messages is read as its last JSON object", () => {
  expect(lastJsonObject(['{"suspects":[]}', '{"suspects":[{"file":"a"}]}'])).toEqual({ suspects: [{ file: "a" }] });
  expect(lastJsonObject(['{"a":1}', "not json"])).toEqual({ a: 1 });
  expect(() => lastJsonObject(["nope"])).toThrow();
});

test("the changed definitions are cut whole, constants with their closing quotes", () => {
  const root = tmp();
  writeFileSync(join(root, "q.py"), 'A = 1\n\nSQL = """\nSELECT 1\nFROM t\n"""\n\ndef f(x):\n    y = x\n    return y\n\ndef g():\n    pass\n');
  const diff = "diff --git a/q.py b/q.py\n--- a/q.py\n+++ b/q.py\n@@ -4,1 +4,1 @@\n-SELECT 2\n+SELECT 1\n@@ -10,1 +10,1 @@\n-    return x\n+    return y\n";
  const d = changedDefinitions(root, diff, ["q.py"]);
  expect(d).toContain('<definition file="q.py" lines="3-6">\nSQL = """\nSELECT 1\nFROM t\n"""\n</definition>');
  expect(d).toContain('<definition file="q.py" lines="8-10">\ndef f(x):\n    y = x\n    return y\n</definition>');
  expect(d).not.toContain("def g");
});

test("a big change is hunted in parts of about 40K characters, whole files, lists taken in turn", () => {
  const file = (p: string, n: number) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n+${"x".repeat(n)}\n`;
  const diff = file("a.py", 30_000) + file("b.py", 15_000) + file("c.py", 20_000);
  expect(partition(diff, ["a.py", "b.py", "c.py"])).toEqual([["a.py"], ["b.py", "c.py"]]);
  expect(partition(file("a.py", 100), ["a.py"])).toEqual([]);
  const s = (file: string, claim: string) => ({ id: "", file, line: 1, claim, why: "", input: "", expected: "",
    actual: "", by: "m" });
  const out = interleave([[s("a", "1"), s("a", "2")], [s("b", "1")], [s("a", "1"), s("c", "1")]], 4);
  expect(out.map((x) => `${x.id} ${x.file}${x.claim}`)).toEqual(["S1 a1", "S2 b1", "S3 a2", "S4 c1"]);
});

test("merged suspects are ranked by the ranker before the cut; a failed ranking takes them in turn", async () => {
  const s = (file: string) => ({ id: "", file, line: 1, claim: file, why: "", input: "", expected: "", actual: "",
    by: "m" });
  const lists = [[s("a"), s("b")], [s("c")]];
  const ranker = new FakeJson([{ order: ["S3", "S1"] }]);
  const use = newUse("x");
  const out = await rankSuspects(lists, { model: ranker, use, max: 2 });
  expect(out.map((x) => `${x.id} ${x.file}`)).toEqual(["S1 b", "S2 a"]); // interleaved a, c, b → ranked b, a
  expect(ranker.calls[0]).toContain("S2 `c:1`: c");
  expect(use.costUsd).toBe(0.01);
  const failed = await rankSuspects(lists, { model: new FakeJson([]), use: newUse("x"), max: 2 });
  expect(failed.map((x) => x.file)).toEqual(["a", "c"]);
  expect((await rankSuspects(lists, { model: null, use: newUse("x") })).map((x) => x.file)).toEqual(["a", "c", "b"]);
});

test("without --hunt nothing changes: no hunt call, no suspects", async () => {
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
  const session: SessionFactory = async (_cfg, snap, _log, body) =>
    body(new FakeSession(snap, () => [junitXml([[GEN, "test_ok", "passed", ""]]), "1 passed", false]));
  const agent = new ScriptedAgent([
    [tool("write_file", { path: `svc/${GEN}`, content: "import calc\ndef test_ok(): pass\n" })],
    [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))]]);
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([]),
    sessionFactory: session });
  expect(review.suspects).toBeUndefined();
  expect(agent.calls).toHaveLength(2);
});

test("a tiered price bills a prompt over its size at the second rate", () => {
  const u = (input: number) => ({ input, output: 1_000_000, cacheRead: 0, cacheWrite: 0 });
  expect(costUsd("claude-haiku-5-5", u(1_000), PRICES)).toBeCloseTo(0.5001, 6);
  expect(costUsd("claude-haiku-5-5", u(200_000), PRICES)).toBeCloseTo(0.1 + 2.5, 6);
});

test("a slow second hunter does not hold up the tests; its late suspects are kept, untested, and paid for", async () => {
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return -0.5\n");
  const session: SessionFactory = async (_cfg, snap, _log, body) =>
    body(new FakeSession(snap, () => [junitXml([[GEN, "test_ok", "passed", ""]]), "1 passed", false]));
  const agent = new ScriptedAgent([
    [text(JSON.stringify({ suspects: [{ file: "svc/calc.py", line: 2, claim: "mine", why: "", input: "", expected: "",
      actual: "" }], questions: [] }))],
    [tool("write_file", { path: `svc/${GEN}`, content: "import calc\ndef test_ok(): pass\n" })],
    [text(JSON.stringify({ tests: [{ test: `${GEN}::test_ok`, expects: "x", suspect: "S1" }], suspected_defects: [],
      questions: [] }))]]);
  const slow = new FakeJson([]);
  slow.completeJson = async () => {
    await new Promise((r) => setTimeout(r, 80));
    return [{ suspects: [{ file: "svc/calc.py", line: 9, claim: "late one", why: "", input: "", expected: "",
      actual: "" }], questions: [] }, 0.05];
  };
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: slow,
    sessionFactory: session, hunt: true, secondHuntWaitMs: 5 });
  expect(String(agent.calls[1]!.messages.at(-1)!.content)).not.toContain("late one");
  const hunt = JSON.parse(readFileSync(join(rdir, "projects/svc/hunt.json"), "utf8"));
  expect(hunt.second_late.map((s: { claim: string }) => s.claim)).toEqual(["late one"]);
  expect(review.usage.find((u) => u.model.startsWith("openai:"))!.costUsd).toBe(0.05);
});

test("part hunts keep each part's suspects at its index, at most PART_CONCURRENCY at once, a failed part empty", async () => {
  const names = ["a", "b", "c", "d", "e", "f"].map((n) => `${n}.py`);
  const diff = names.map((p) => `diff --git a/${p} b/${p}\n--- a/${p}\n+++ b/${p}\n@@ -1 +1 @@\n+${"x".repeat(30_000)}\n`).join("");
  const cfg = parseReviewFile("version: 1\nprojects:\n  svc:\n    root: svc\n    image: python:3.12-slim\n" +
    "    test_command: python -m pytest {targets}\n").projects[0]!;
  let inFlight = 0, most = 0;
  const model = new FakeJson([]);
  model.completeJson = async (_system: string, user: string) => {
    const i = names.findIndex((p) => user.includes(`diff --git a/${p} `));
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, (names.length - i) * 10)); // earlier parts finish last
    inFlight--;
    if (names[i] === "c.py") throw new ModelError("HTTP 529: overloaded");
    return [{ suspects: [{ file: names[i], line: 1, claim: `claim ${i}` }] }, 0.01];
  };
  const progress: string[] = [];
  const { lists, use } = await partHunts(tmp(), cfg, { model, diff, owned: names, searchDirs: [], scope: { owned: names,
    used: [] }, outDir: tmp(), progress: (m) => progress.push(m) });
  expect(lists.map((l) => l.map((s) => s.claim))).toEqual([["claim 0"], ["claim 1"], [], ["claim 3"], ["claim 4"],
    ["claim 5"]]);
  expect(most).toBe(PART_CONCURRENCY);
  expect(use.costUsd).toBeCloseTo(0.05);
  expect(progress.some((m) => m.includes("a part hunter failed"))).toBe(true);
});

test("hunters given the changed definitions and the parts ask exactly what they ask reading the snapshot", async () => {
  // A change big enough to be hunted in parts, with callers for the context packs.
  const root = tmp();
  const names = ["a", "b", "c"];
  const N = 400;
  const step = (sign: string) => Array.from({ length: N }, (_v, i) => `    y${i} = x ${sign} ${i}`);
  for (const n of names) writeFileSync(join(root, `${n}.py`), `def f_${n}(x):\n${step("+").join("\n")}\n    return x\n`);
  writeFileSync(join(root, "main.py"), "import a, b, c\n\ndef run(x):\n    return a.f_a(x) + b.f_b(x) + c.f_c(x)\n");
  // Every line of each function's body changed from - to +.
  const diff = names.map((n) => `diff --git a/${n}.py b/${n}.py\n--- a/${n}.py\n+++ b/${n}.py\n@@ -2,${N} +2,${N} @@\n` +
    `${step("-").map((l) => `-${l}`).join("\n")}\n${step("+").map((l) => `+${l}`).join("\n")}\n`).join("");
  const owned = names.map((n) => `${n}.py`);
  const cfg = parseReviewFile("version: 1\nimage: python:3.12-slim\ntest_command: pytest {targets}\n").projects[0]!;
  const searchDirs = ["."];
  const round = async (hunt: { context: string; root?: string; searchDirs: string[]; changedDefinitions?: string;
    parts?: ReturnType<typeof huntParts> }) => {
    const second = new FakeJson([{ suspects: [] }]);
    const hunter = new FakeJson([{ suspects: [] }, { suspects: [] }, { suspects: [] }, { suspects: [] }]);
    await new LocalBrain({ agentModel: new ScriptedAgent([[text(JSON.stringify({ suspects: [], questions: [] }))],
      [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))]]), prices: PRICES, secondHunter: second,
    hunter }).agentRound("review", { cfg, diff, scope: { owned, used: [] }, scoped: true, envTests: [], maxQuestions: 3,
      dbNames: [], budgetUsd: 5, hunt }, Promise.resolve({ tools: () => [], call: async () => "" }));
    return { second: second.calls, parts: hunter.calls };
  };
  const context = contextPack(root, diff, owned, searchDirs);
  const fromSnapshot = await round({ context, root, searchDirs });
  // A brain without the snapshot gets what the CLI builds on it (as CloudBrain sends it) and no root.
  const given = await round({ context, searchDirs, changedDefinitions: changedDefinitions(root, diff, owned),
    parts: huntParts(root, cfg, diff, owned, searchDirs) });
  expect(given).toEqual(fromSnapshot);
  // Not vacuous: two parts and the second hunter, with definitions and callers in their prompts.
  expect([fromSnapshot.second.length, fromSnapshot.parts.length]).toEqual([1, 2]);
  expect(fromSnapshot.second[0]).toContain('<definition file="a.py"');
  for (const p of fromSnapshot.parts) expect(p).toContain("<definition file=");
  expect(fromSnapshot.parts.join("\n")).toContain("main.py:4");
});
