import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AnswerOutcome, accept } from "../src/accept";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { save } from "../src/report";
import { defaultSettings } from "../src/settings";
import { Cli } from "./helpers/cli";
import { gitRepo } from "./helpers/gitutil";
import { finding, sampleReview, blankMarks } from "./helpers/review";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-12T00:00:00Z" };
const RID = "20261012-abcdef";
const GEN = "tests/arnx_generated/test_x.py";
const SRC = "def test_bad():\n    assert 0\n\ndef test_ok():\n    pass\n";

function setup(): { repo: string; rdir: string } {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  const rdir = join(repo, ".arnx", "reviews", RID);
  const f = (id: string, p: string) => ({ ...finding(id, `${GEN}::test_bad`, "test_bad", `services/${p}/${GEN}`, "boom",
    `${p} wrong`, "confirmed", "yes"), project: p });
  save(sampleReview({ id: RID, findings: [f("F1", "feed"), f("F2", "pay")], projects: ["feed", "pay"],
    questions: ["Q about pay?"], questionProjects: ["pay"], flaky: [], errors: [], notSent: [],
    writeDir: "services/feed/tests/arnx_generated",
    writeDirs: { feed: "services/feed/tests/arnx_generated", pay: "services/pay/tests/arnx_generated" } }), rdir, "d");
  for (const p of ["feed", "pay"]) {
    const dir = join(rdir, "projects", p, "tests", "services", p, "tests", "arnx_generated");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "test_x.py"), SRC);
  }
  return { repo, rdir };
}

test("accept keeps each project's tests under that project's root", async () => {
  const { repo, rdir } = setup();
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  const parts = blankMarks(md).split("Mark: [ ] real  [ ] intended  [ ] noise");
  writeFileSync(join(rdir, "review.md"), parts[0] + "Mark: [ ] real  [ ] intended  [x] noise" + parts[1] +
    "Mark: [x] real  [ ] intended  [ ] noise" + parts[2]);
  const result = await accept(repo, rdir, SETTINGS);
  const kept = join(repo, "services", "pay", "tests", "arnx", "r20261012_abcdef", "test_pay_wrong.py");
  expect(result.kept).toEqual([kept]);
  expect(readFileSync(kept, "utf8")).toBe("import pytest\n@pytest.mark.xfail(strict=True, reason='arnx review " +
    `20261012-abcdef: F2 not fixed yet')\n${SRC}`);
  expect(existsSync(join(repo, "services", "feed", "tests", "arnx"))).toBe(false);
});

test("answers run in the project the question came from", async () => {
  const { repo, rdir } = setup();
  writeFileSync(join(rdir, "review.md"), readFileSync(join(rdir, "review.md"), "utf8").replace("Answer:", "Answer: yes"));
  const seen: string[] = [];
  const runner = async (qid: string, _q: string, _a: string, _d: string, outDir: string, project: string)
    : Promise<AnswerOutcome> => {
    seen.push(`${qid}:${project}:${outDir.endsWith(join("answers", qid))}`);
    return { qid, files: {}, keep: {}, skip: {}, disagree: [], costUsd: 0, stop: "end_turn", base: "" };
  };
  await accept(repo, rdir, SETTINGS, { answerRunner: runner });
  expect(seen).toEqual(["Q1:pay:true"]);
});

// A repository like a pilot's: a Python service, and a TypeScript project (an Express app in index.ts) with its own
// __tests__/. Accepted tests go under each project's root, in accepted_tests_dir.
const MIXED = `
version: 1
projects:
  pay:
    root: services/pay
    language: python
    image: python:3.12-slim
    test_command: python -m pytest -q {targets}
  parser:
    root: solana-parser
    language: typescript
    image: node:22-slim
    runner: node
    test_command: node --test {targets}
`;
const TS_GEN = "__tests__/arnx_generated/app.test.ts";
const TS_SRC = "const { app } = require('../../index');\ntest('bad', () => {});\n";

function mixed(): { repo: string; rdir: string } {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, ".arnx"));
  mkdirSync(join(repo, "solana-parser", "__tests__"), { recursive: true });
  writeFileSync(join(repo, "solana-parser", "__tests__", "own.test.ts"), "test('own', () => {});\n");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(MIXED), "Dev", "2026-10-12"));
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(sampleReview({ id: RID, projects: ["pay", "parser"], questions: [], questionProjects: [], flaky: [], errors: [],
    notSent: [], writeDir: "services/pay/tests/arnx_generated", findings: [
      { ...finding("F1", `${GEN}::test_bad`, "test_bad", `services/pay/${GEN}`, "boom", "pay wrong", "confirmed", "y"),
        project: "pay" },
      { ...finding("F2", `${TS_GEN}::bad`, "bad", `solana-parser/${TS_GEN}`, "boom", "parser wrong", "confirmed", "y"),
        project: "parser" }],
    writeDirs: { pay: "services/pay/tests/arnx_generated", parser: "solana-parser/__tests__/arnx_generated" } }),
  rdir, "d");
  const py = join(rdir, "projects", "pay", "tests", "services", "pay", "tests", "arnx_generated");
  mkdirSync(py, { recursive: true });
  writeFileSync(join(py, "test_x.py"), SRC);
  const ts = join(rdir, "projects", "parser", "tests", "solana-parser", "__tests__", "arnx_generated");
  mkdirSync(ts, { recursive: true });
  writeFileSync(join(ts, "app.test.ts"), TS_SRC);
  return { repo, rdir };
}

test("a configured accepted_tests_dir holds every project's accepted tests, a TypeScript one's too", async () => {
  const { repo, rdir } = mixed();
  const result = await accept(repo, rdir, { ...SETTINGS, acceptedTestsDir: "test/locks" });
  const rel = result.kept.map((p) => p.slice(repo.length + 1)).sort();
  expect(rel).toEqual(["services/pay/test/locks/r20261012_abcdef/test_pay_wrong.py",
    "solana-parser/test/locks/r20261012_abcdef/parser_wrong.test.ts"]);
  // Its import is moved with it.
  expect(readFileSync(join(repo, rel[1]!), "utf8")).toContain("require('../../../index')");
});

test("with the default accepted_tests_dir, a TypeScript project keeps them under __tests__/arnx/", async () => {
  const { repo, rdir } = mixed();
  const result = await accept(repo, rdir, SETTINGS);
  expect(result.kept.map((p) => p.slice(repo.length + 1)).sort()).toEqual([
    "services/pay/tests/arnx/r20261012_abcdef/test_pay_wrong.py",
    "solana-parser/__tests__/arnx/r20261012_abcdef/parser_wrong.test.ts"]);
});

test("accept lists where each accepted test went, under its project's root", async () => {
  const { repo, rdir } = mixed();
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  expect(await cli.run("accept", RID, "--no-answers")).toBe(0);
  expect(cli.stdout).toContain("  kept: solana-parser/__tests__/arnx/r20261012_abcdef/parser_wrong.test.ts");
  expect(cli.stdout).not.toContain("accepted_tests_dir"); // the path says it
});
