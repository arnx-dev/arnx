// Setup as a developer sees it: what happens before it starts, progress while it runs, one line per project to
// judge, the points worth checking, and what `arnx review` would test next.
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestResult } from "../src/adapters/types";
import { parseReviewFile } from "../src/config";
import { defaultSettings } from "../src/settings";
import { approveFile, describeTool, runSetup, skipReasons, unexplainedFailing } from "../src/setup";
import { approvalChecks, approvalScreen, nextStep, projectTable, setupPreview } from "../src/setupview";
import type { SessionFactory } from "../src/sandbox";
import { FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
  for (const p of ["services/pay/a.py", "services/pay/tests/test_a.py", "services/feed/b.py",
    "services/shared/db.py", "infra/main.tf"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), p.includes("test_") ? "def test_a():\n    import pytest\n" : "X = 1\n");
  }
  commit(repo, "layout");
});
const COVERED = PROJECTS.replace("uncovered:\n", "uncovered:\n  - {path: /app.py, reason: \"legacy script, no tests\"}\n");
const skipping: SessionFactory = async (_cfg, snap, _log, body) =>
  body(new FakeSession(snap, () => [junitXml([["tests/test_a.py", "test_a", "passed", ""],
    ["tests/test_pg.py", "test_pg", "skipped", "tests/test_pg.py:37: TEST_DATABASE_URL not set"],
    ["tests/test_pg.py", "test_pg2", "skipped", "tests/test_pg.py:37: TEST_DATABASE_URL not set"]]),
  "1 passed, 2 skipped", false]));
const result = (m: ScriptedAgent, call: number) =>
  (m.calls[call]!.messages.at(-1)!.content as Record<string, unknown>[]).map((r) => String(r.content)).join("\n");

test("skip reasons are grouped, without the file:line prefix", () => {
  const t = (message: string): TestResult => ({ testId: "x", fileAttr: "f", name: "n", outcome: "skipped", message });
  expect(skipReasons([t("a.py:3: needs DB"), t("b.py:9: needs DB"), t(""),
    { ...t("x"), outcome: "passed" }])).toEqual(['"needs DB" (2)', '"no reason given" (1)']);
  expect(skipReasons(null)).toEqual([]);
});

test("setup tells the agent and the developer why tests were skipped, and keeps each project's proof", async () => {
  const lines: string[] = [];
  const m = new ScriptedAgent([
    [text("I'll read the manifests."), tool("read_file", { path: "services/pay/a.py" })],
    [tool("try_project", { yaml: COVERED, project: "pay" })],
    [tool("try_project", { yaml: COVERED, project: "feed" })],
    [tool("propose", { yaml: COVERED })],
    [text("Two services.")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: skipping,
    progress: (l) => lines.push(l) });
  expect(r.ok).toBe(true);
  expect(result(m, 2)).toContain('Skipped tests and why: "TEST_DATABASE_URL not set" (2)');
  expect(result(m, 2)).toContain("provide what it asks for");
  expect(r.projects.map((p) => p.name)).toEqual(["pay", "feed"]);
  expect(r.projects[0]!.skips).toEqual(['"TEST_DATABASE_URL not set" (2)']);
  // Reading is one milestone; which files, the agent's own words and the turns stay in the logs.
  expect(lines[0]).toBe("reading the repository");
  expect(lines.filter((l) => l === "reading the repository")).toHaveLength(1);
  expect(lines.join("\n")).not.toMatch(/reads services/);
  const shown = lines.join("\n");
  expect(shown).not.toMatch(/replied|turn|I'll read the manifests|proposal accepted/);
  expect(shown).toContain("pay: running its suite (try 1)");
  expect(shown).toContain("pay: ✓");
  expect(shown).toContain("skipped because");
});

test("propose refuses known_failing files that no note explains", async () => {
  const silent = COVERED.replace("    uses: [services/shared/]\n  feed:",
    "    uses: [services/shared/]\n    known_failing: [tests/test_live.py]\n  feed:");
  const explained = silent.replace("    known_failing:", "    notes: [tests/test_live.py calls a live API]\n    known_failing:");
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: silent, project: "pay" })], [tool("try_project", { yaml: silent, project: "feed" })],
    [tool("propose", { yaml: silent })],
    [tool("try_project", { yaml: explained, project: "pay" })], [tool("propose", { yaml: explained })], [text("ok")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: skipping });
  expect(result(m, 3)).toContain("known_failing without a reason in notes: pay: tests/test_live.py");
  expect([r.ok, r.yamlText]).toEqual([true, explained]);
  expect(unexplainedFailing(parseReviewFile(explained).projects[0]!)).toEqual([]);
});

test("an uncovered reason split by a comma is refused, not read as a shorter reason", () => {
  const bad = COVERED.replace("reason: Terraform; no adapter}", "reason: infrastructure (compose, other) only}");
  expect(() => parseReviewFile(bad)).toThrow("quote a reason that holds a comma");
});

test("the approval screen names the file, one line per project, and what to check", () => {
  const file = parseReviewFile(COVERED.replace("install: [pip install pytest]",
    "install: [\"pip install pytest || true\"]\n    known_failing: [tests/test_live.py]"));
  const proofs = [{ name: "pay", summary: "1 passed, 2 skipped", skips: ['"needs DB" (2)'] },
    { name: "feed", summary: "1 passed", skips: [] }];
  const table = projectTable(file, proofs).split("\n");
  expect(table[0]).toMatch(/^ {2}project +runs in +with +services +existing suite$/);
  expect(table[1]).toMatch(/^ {2}pay +services\/pay +python:3\.12-slim · pytest +db +1 passed, 2 skipped; 1 known failing$/);
  expect(approvalChecks(file, proofs)).toEqual([
    'pay: tests skipped because "needs DB" (2)',
    "pay: 1 test file(s) set aside as known failing (1 with no reason in notes): tests/test_live.py",
    "pay: 1 command(s) ignore their own errors (|| true)",
  ]);
  const screen = approvalScreen(file, repo, { proofs });
  expect(screen.startsWith("  project")).toBe(true);
  expect(screen).toContain("Not tested (a change here is reported as not tested):\n  /app.py");
  expect(screen).not.toMatch(/setup agent's notes|The full file/);
  // No project has services: no services column.
  const plain = { ...file, projects: file.projects.map((p) => ({ ...p, services: [] })) };
  expect(projectTable(plain, proofs).split("\n")[0]).toMatch(/^ {2}project +runs in +with +existing suite$/);
  expect(screen).not.toContain("version: 1"); // the YAML itself is not dumped
});

test("the preview says what setup does and gives an estimate before anything is spent", () => {
  writeFileSync(join(repo, "services/pay/requirements.txt"), "pytest\n");
  commit(repo, "manifest");
  expect(setupPreview(repo, defaultSettings())).toMatch(
    /^Setup: finding how to run your tests in Docker \(about \d+–\d+ min, stops at \$3\.00\)\.$/);
});

test("the next step says which change a review would test now", () => {
  expect(nextStep(repo)).toMatch(/^Next: arnx review \(the last commit: [0-9a-f]+ layout\)$/);
  writeFileSync(join(repo, "services/pay/a.py"), "X = 2\n");
  expect(nextStep(repo)).toBe("Next: arnx review (your uncommitted work: services/pay/a.py)");
});

test("approve reports each project as it runs", async () => {
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(join(repo, ".arnx", "review.yaml"), COVERED);
  const lines: string[] = [];
  const [ok] = await approveFile(repo, { by: "Dev", at: "x", sessionFactory: skipping, progress: (l) => lines.push(l) });
  expect(ok).toBe(true);
  expect(lines[0]).toContain('pay: ✓ 1 passed, 2 skipped · skipped because "TEST_DATABASE_URL not set" (2)');
  expect(lines[1]).toContain("feed: ✓");
});

test("tools are described in a few words", () => {
  expect(describeTool("grep", { pattern: "DATABASE_URL", path: "billing" })).toBe('searches billing for "DATABASE_URL"');
  expect(describeTool("list_dir", { path: "" })).toBe("lists .");
  expect(describeTool("try_project", {})).toBeNull();
});
