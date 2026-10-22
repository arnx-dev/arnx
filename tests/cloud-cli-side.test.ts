// What the CLI does on its own side holds the same with arnx cloud's brain: the snapshot is the CLI's, so untracked
// files stay out of what the brain is sent (tool results, facts, the change, setup's tree and detection) unless the
// owner opts in; and the fix proof runs in Docker here, so a cloud review proves a fix exactly as a local one does.
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CloudClient, writeCredentials } from "../src/cloud";
import { CloudBrain } from "../src/cloudbrain";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings, writeSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { Cli } from "./helpers/cli";
import { type FakeCloud, fakeCloud, type StepScript, TOKEN } from "./helpers/cloudfake";
import { FakeJson, FakeSession, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
let clouds: FakeCloud[] = [];
afterEach(() => {
  for (const c of clouds) c.stop();
  clouds = [];
});
const cloudOf = (rounds: StepScript[]) => {
  const c = fakeCloud({ rounds: { "*": rounds.map((s) => ({ ...s })) } });
  clouds.push(c);
  return c;
};
const brainFor = (c: FakeCloud) => new CloudBrain({ client: new CloudClient(c.url, { token: TOKEN, delays: [0] }),
  tier: "medium" });
/** Everything the CLI sent arnx cloud, as one string. */
const sent = (c: FakeCloud) => JSON.stringify(c.seen.map((x) => x.body));

const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-20T00:00:00Z" };
const GEN = "tests/arnx_generated/test_add.py";
const SOURCE = "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n";
const MARK = "UNTRACKED-CONTENT-7f3a";
const PLAN = "notes/plan.py";

/** A tracked change to app.py, and an untracked file and manifest nobody added. */
function untrackedRepo(): string {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-20"));
  commit(repo, "review.yaml");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  mkdirSync(join(repo, "notes"));
  writeFileSync(join(repo, PLAN), `# ${MARK}\nSECRET_PLAN = 1\n`);
  mkdirSync(join(repo, "tool"));
  writeFileSync(join(repo, "tool/package.json"), JSON.stringify({ name: "tool", scripts: { test: "jest" } }) + "\n");
  return repo;
}

/** The brain reads the untracked file, looks at the tree, writes a test and runs it. */
const ROUND: StepScript[] = [
  { type: "actions", actions: [{ name: "read_file", input: { path: PLAN } }, { name: "list_dir", input: { path: "notes" } },
    { name: "grep", input: { pattern: MARK, path: "." } }] },
  { type: "actions", actions: [{ name: "write_file", input: { path: GEN, content: SOURCE } },
    { name: "run_tests", input: {} }] },
  { type: "final", report: { tests: [{ test: `${GEN}::test_add`, expects: "add sums" }], suspected_defects: [],
    questions: [] } },
  { type: "done", stop: "end_turn" },
];
const runs = (): [string | null, string, boolean] => [junitXml([[GEN, "test_add", "failed", "assert -1 == 5"]]), "",
  false];

test("a cloud review leaves untracked files out of everything it sends, unless --untracked opts in", async () => {
  const repo = untrackedRepo();
  const off = cloudOf(ROUND);
  const { review } = await runReview(repo, { settings: SETTINGS, brain: brainFor(off),
    sessionFactory: fakeFactory(runs) });
  expect(review.untrackedLeftOut).toBe(2);
  expect(review.untrackedIncluded).toBeUndefined();
  const create = off.seen.find((x) => x.path === "/v1/reviews")!.body as { change: { files_changed: string[] } };
  expect(create.change.files_changed).toEqual(["app.py"]);
  // The read is refused, the listing and the search find nothing: the file is not in the snapshot.
  const steps = off.seen.filter((x) => x.path.endsWith("/agent/steps")).map((x) => x.body as
    { results?: { output: string }[] });
  expect(steps[0]!.results!.map((r) => r.output).join("\n")).not.toContain("SECRET_PLAN");
  // The brain named the path itself in its read; nothing the CLI sent holds the files' content or the manifest.
  for (const leaked of [MARK, "SECRET_PLAN", "tool/package.json"]) expect(sent(off)).not.toContain(leaked);

  // Opted in: the same round sees the file, so the check above can see a leak.
  const on = cloudOf(ROUND);
  const opted = await runReview(repo, { settings: SETTINGS, brain: brainFor(on), sessionFactory: fakeFactory(runs),
    untracked: true });
  expect(opted.review.untrackedIncluded).toEqual([PLAN, "tool/package.json"]);
  expect(sent(on)).toContain("SECRET_PLAN");
  const files = (on.seen.find((x) => x.path === "/v1/reviews")!.body as { change: { files_changed: string[] } })
    .change.files_changed;
  expect(files).toContain(PLAN);
});

test("arnx review with arnx models: --untracked reaches the cloud review, and without it the file stays out", async () => {
  const repo = untrackedRepo();
  const home = join(tmp(), "home");
  writeSettings(repo, { ...SETTINGS, cloudConsentAt: "2026-10-20T00:00:00Z",
    cloud: { models: true, tests: false, effort: "medium" } });
  // A 402 at the create stops the review right after the change summary is sent: enough to see what it holds.
  const filesSent = async (...flags: string[]) => {
    const c = fakeCloud({ fail: { "POST /v1/reviews": [{ status: 402, body: { code: "insufficient_credits",
      message: "too low", balance_micro_usd: 0, needed_micro_usd: 1, topup_url: "https://arnx.dev/credits" } }] } });
    clouds.push(c);
    writeCredentials({ HOME: home }, { url: c.url, token: TOKEN });
    const cli = new Cli({ cwd: repo, env: { HOME: home, ARNX_CLOUD_URL: c.url }, sleep: async () => {} });
    expect(await cli.run("review", "--quiet", ...flags)).toBe(3);
    return (c.seen.find((x) => x.path === "/v1/reviews")!.body as { change: { files_changed: string[] } })
      .change.files_changed;
  };
  expect(await filesSent()).toEqual(["app.py"]);
  expect(await filesSent("--untracked")).toEqual(expect.arrayContaining(["app.py", PLAN, "tool/package.json"]));
});

test("a cloud setup's tree and detection hold untracked files only with --untracked", async () => {
  const repo = untrackedRepo();
  const setupBody = async (untracked?: boolean) => {
    const c = cloudOf([]);
    await runSetup(repo, defaultSettings(), null, { outDir: join(tmp(), `setup-${untracked}`), brain: brainFor(c),
      sessionFactory: fakeFactory(runs), ...(untracked !== undefined ? { untracked } : {}) });
    return c.seen.find((x) => x.path === "/v1/setup")!.body as { tree: string;
      detection: { candidates: { root: string }[] } };
  };
  const off = await setupBody();
  expect(off.tree.split("\n")).toContain("app.py");
  expect(off.tree).not.toContain("plan.py");
  expect(off.tree).not.toContain("tool/package.json");
  expect(off.detection.candidates.map((c) => c.root)).not.toContain("tool");
  const on = await setupBody(true);
  expect(on.tree.split("\n")).toEqual(expect.arrayContaining([PLAN, "tool/package.json"]));
  expect(on.detection.candidates.map((c) => c.root)).toContain("tool");
});

// The fix proof (fixproof.test.ts's bug fix, smaller): add() subtracted before the change and adds after it.
test("a cloud review proves a fix in Docker here, the same as the local brain", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-20"));
  commit(repo, "add subtracts");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a + b\n");
  const report = { tests: [{ test: `${GEN}::test_add`, expects: "add sums" }], suspected_defects: [], questions: [] };
  const sessions = (snaps: string[]): SessionFactory => async (_cfg, snap, _log, body) => {
    snaps.push(snap);
    const before = snap.endsWith("/before");
    return body(new FakeSession(snap, () => [junitXml([[GEN, "test_add", before ? "failed" : "passed",
      before ? "assert -1 == 5" : ""]]), "", false]));
  };
  const settings = { ...SETTINGS, beforeCheck: true };
  const c = cloudOf([{ type: "actions", actions: [{ name: "write_file", input: { path: GEN, content: SOURCE } }] },
    { type: "final", report }, { type: "done", stop: "end_turn" }]);
  const cloudSnaps: string[] = [];
  const cloud = await runReview(repo, { settings, brain: brainFor(c), sessionFactory: sessions(cloudSnaps) });
  const localSnaps: string[] = [];
  const local = await runReview(repo, { settings, sessionFactory: sessions(localSnaps),
    agentModel: new ScriptedAgent([[tool("write_file", { path: GEN, content: SOURCE })], [text(JSON.stringify(report))],
      [text(JSON.stringify(report))]]), challenger: new FakeJson([]) });
  expect(cloud.review.fixProof!.map((x) => [x.testId, x.beforeStatus])).toEqual([[`${GEN}::test_add`, "fixed"]]);
  expect(cloud.review.fixProof).toEqual(local.review.fixProof!);
  expect(cloudSnaps.length).toBe(localSnaps.length);
  expect(cloudSnaps.filter((s) => s.endsWith("/before"))).toHaveLength(1);
});
