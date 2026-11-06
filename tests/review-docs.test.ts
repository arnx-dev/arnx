// A change of documentation only is not reviewed unless --docs asks; a round whose hunt names no suspect ends there.
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { NoChange, OnlyDocs } from "../src/errors";
import { exitCode, render, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings, loadSettings, writeSettings } from "../src/settings";
import { reviewJson } from "../src/cli";
import { Cli } from "./helpers/cli";
import { FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" };
const GEN = "tests/arnx_generated/test_x.py";
let repo = "";
beforeEach(() => {
  repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"), { recursive: true });
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return 0\n");
  writeFileSync(join(repo, "svc/README.md"), "# svc\n");
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

const noSandbox: { runs: number } = { runs: 0 };
const session: SessionFactory = async (_cfg, snap, _log, body) => {
  noSandbox.runs++;
  return body(new FakeSession(snap, () => [junitXml([[GEN, "test_x", "passed", ""]]), "1 passed", false]));
};

test("only documentation changed: no image, no model call, and it says so", async () => {
  writeFileSync(join(repo, "svc/README.md"), "# svc\n\nmore words\n");
  const agent = new ScriptedAgent([]);
  noSandbox.runs = 0;
  let err: unknown;
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([]),
    sessionFactory: session, hunt: true }).catch((e) => { err = e; });
  expect(err).toBeInstanceOf(OnlyDocs);
  expect(err).toBeInstanceOf(NoChange);
  expect((err as Error).message).toStartWith("nothing to test: only documentation changed (svc/README.md)");
  expect((err as Error).message).toContain("--docs");
  expect([agent.calls.length, noSandbox.runs]).toEqual([0, 0]);
});

test("the Cli exits like an empty change, before any model or image", async () => {
  writeFileSync(join(repo, "svc/README.md"), "# svc\n\nmore words\n");
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  expect(await cli.run("init")).toBe(0);
  writeSettings(repo, { ...loadSettings(repo), consentAt: "2026-11-01T00:00:00+00:00" });
  expect(await cli.run("review")).toBe(2);
  expect(cli.stderr).toContain("nothing to test: only documentation changed (svc/README.md)");
});

test("--docs reviews it", async () => {
  writeFileSync(join(repo, "svc/README.md"), "# svc\n\nmore words\n");
  const agent = new ScriptedAgent([[text(JSON.stringify({ suspects: [], questions: [] }))]]);
  noSandbox.runs = 0;
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([]),
    sessionFactory: session, hunt: true, docs: true });
  expect(review.projects).toEqual(["svc"]);
  expect(agent.calls.length).toBeGreaterThan(0);
});

test("no suspects ends the round after the hunt and the report does not claim it was tested", async () => {
  writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return 1\n");
  const agent = new ScriptedAgent([[tool("read_file", { path: "svc/calc.py" })],
    [text(JSON.stringify({ suspects: [], questions: [] }))]]);
  const second = new FakeJson([{ suspects: [], questions: [] }]);
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: second,
    sessionFactory: session, hunt: true });
  // the hunt's reply was the last call: no "Now test." follow-up was sent
  expect(agent.calls.length).toBe(2);
  expect(review.testsWritten).toBe(0);
  expect(review.projectStats![0]!.noReport).toBeUndefined();
  expect(exitCode(review)).toBe(0);
  const out = summary(review, "review.md");
  expect(out).toContain("Nothing suspected in this change; no tests written.");
  expect(out).not.toContain("Complete");
  expect(out).not.toContain("Incomplete");
  expect(render(review)).toContain("Nothing suspected in this change; no tests written.");
  expect(render(review)).not.toContain("Complete:");
  const [kind, code, data] = reviewJson(review, "review.md", "review.json");
  expect([kind, code, data.status]).toEqual(["clean", 0, "not-tested"]);
  expect(data.problems).toEqual(["nothing was suspected in this change, so no test was written"]);
});
