// A change of documentation only is not reviewed unless --docs asks; a round whose hunt names no suspect ends there.
import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { ModelError, NoChange, OnlyDocs } from "../src/errors";
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
  mkdirSync(join(repo, "svc/docs"), { recursive: true });
  writeFileSync(join(repo, "svc/docs/guide.md"), "# svc\n");
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
  writeFileSync(join(repo, "svc/docs/guide.md"), "# svc\n\nmore words\n");
  const agent = new ScriptedAgent([]);
  noSandbox.runs = 0;
  let err: unknown;
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([]),
    sessionFactory: session, hunt: true }).catch((e) => { err = e; });
  expect(err).toBeInstanceOf(OnlyDocs);
  expect(err).toBeInstanceOf(NoChange);
  expect((err as Error).message).toStartWith("nothing to test: only documentation changed (svc/docs/guide.md)");
  expect((err as Error).message).toContain("--docs");
  expect([agent.calls.length, noSandbox.runs]).toEqual([0, 0]);
});

test("the Cli exits 0, saying so, before any model or image", async () => {
  writeFileSync(join(repo, "svc/docs/guide.md"), "# svc\n\nmore words\n");
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  expect(await cli.run("init")).toBe(0);
  writeSettings(repo, { ...loadSettings(repo), consentAt: "2026-11-01T00:00:00+00:00" });
  expect(await cli.run("review")).toBe(0);
  expect(cli.stderr).toContain("nothing to test: only documentation changed (svc/docs/guide.md)");
});

test("--docs reviews it", async () => {
  writeFileSync(join(repo, "svc/docs/guide.md"), "# svc\n\nmore words\n");
  const agent = new ScriptedAgent([[text(JSON.stringify({ suspects: [], questions: [] }))]]);
  noSandbox.runs = 0;
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([{ suspects: [], questions: [] }]),
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

// A hunt that failed is not a hunt that found nothing: the round goes on as before.
const code = () => writeFileSync(join(repo, "svc/calc.py"), "def spread(xs):\n    return 1\n");
const goesOn = () => [text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }))];
const finishes = (review: Awaited<ReturnType<typeof runReview>>["review"]) => {
  expect(summary(review, "review.md")).not.toContain("Nothing suspected");
  expect(render(review)).not.toContain("Nothing suspected");
  expect(review.projectStats![0]!.noSuspects).toBeUndefined();
  const [, , data] = reviewJson(review, "review.md", "review.json");
  expect(JSON.stringify(data.problems)).not.toContain("nothing was suspected");
};

test("a reply to the hunt that is not the suspect list does not read as nothing suspected", async () => {
  code();
  const agent = new ScriptedAgent([[text("I read it and it looks fine to me.")], goesOn(),
    goesOn()]);
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([]),
    sessionFactory: session, hunt: true });
  expect(agent.calls.length).toBeGreaterThan(1);
  finishes(review);
});

test("a second hunter that failed does not let an empty hunt read as nothing suspected", async () => {
  code();
  const agent = new ScriptedAgent([[text(JSON.stringify({ suspects: [], questions: [] }))],
    goesOn(), goesOn()]);
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent,
    challenger: new FakeJson([new ModelError("down")]), sessionFactory: session, hunt: true });
  expect(agent.calls.length).toBeGreaterThan(1);
  finishes(review);
});

test("a second hunter still out when the hunt ends does not let an empty hunt read as nothing suspected", async () => {
  code();
  const agent = new ScriptedAgent([[text(JSON.stringify({ suspects: [], questions: [] }))],
    goesOn(), goesOn()]);
  const slow = new FakeJson([]);
  slow.completeJson = async () => {
    await new Promise((r) => setTimeout(r, 60));
    return [{ suspects: [], questions: [] }, 0.01];
  };
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: slow,
    sessionFactory: session, hunt: true, secondHuntWaitMs: 5, secondHuntGraceMs: 5 });
  expect(agent.calls.length).toBeGreaterThan(1);
  finishes(review);
});

test("documentation left out of a mixed change is said in one line", async () => {
  mkdirSync(join(repo, "web/docs"), { recursive: true });
  writeFileSync(join(repo, "web/docs/a.md"), "# web\n");
  commit(repo, "web docs");
  writeFileSync(join(repo, "web/docs/a.md"), "# web\n\nmore\n");
  code();
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
  web:
    root: web
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  const agent = new ScriptedAgent([[text(JSON.stringify({ suspects: [], questions: [] }))]]);
  const { review } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new FakeJson([{ suspects: [], questions: [] }]),
    sessionFactory: session, hunt: true });
  expect(review.projects).toEqual(["svc"]);
  expect(render(review)).toContain("1 documentation file not reviewed; `arnx review --docs` includes it.");
  expect(summary(review, "review.md")).not.toContain("documentation file");
});

test("OnlyDocs exits 0", () => {
  expect(new OnlyDocs(["docs/a.md"]).exitCode).toBe(0);
});

// One rule: nothing to review exits 0 and runs no review. The JSON status word tells the cases apart.
async function reviewCli(): Promise<Cli> {
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  expect(await cli.run("init")).toBe(0);
  writeSettings(repo, { ...loadSettings(repo), consentAt: "2026-11-01T00:00:00+00:00" });
  return new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
}

test("an empty change exits 0", async () => {
  const cli = await reviewCli();
  expect(await cli.run("review", "--range", "HEAD..HEAD")).toBe(0);
  expect(cli.stderr).toContain("nothing to review");
  const json = await reviewCli();
  expect(await json.run("review", "--range", "HEAD..HEAD", "--json")).toBe(0);
  expect(JSON.parse(json.stdout)).toMatchObject({ result: "clean", exit_code: 0, status: "nothing-to-review" });
});

test("a lockfile-only change exits 0 with the same status", async () => {
  writeFileSync(join(repo, "svc/package-lock.json"), `{"lockfileVersion": 3}\n`);
  commit(repo, "lock");
  const cli = await reviewCli();
  expect(await cli.run("review", "--json")).toBe(0);
  expect(JSON.parse(cli.stdout)).toMatchObject({ result: "clean", exit_code: 0, status: "nothing-to-review" });
});

test("documentation alone still reads docs-only", async () => {
  writeFileSync(join(repo, "svc/docs/guide.md"), "# svc\n\nmore words\n");
  const cli = await reviewCli();
  expect(await cli.run("review", "--json")).toBe(0);
  expect(JSON.parse(cli.stdout)).toMatchObject({ result: "clean", exit_code: 0, status: "docs-only" });
});

test("NoChange exits 0", () => {
  expect(new NoChange("x").exitCode).toBe(0);
});

test("a first-run review with nothing to set up writes a review-shaped JSON line", async () => {
  rmSync(reviewConfigPath(repo), { force: true });
  writeFileSync(join(repo, "notes.txt"), "plain text\n");
  commit(repo, "text");
  const cli = await reviewCli();
  expect(await cli.run("review", "--json")).toBe(0);
  expect(JSON.parse(cli.stdout)).toMatchObject({ command: "review", result: "clean", exit_code: 0,
    status: "nothing-to-review" });
});
