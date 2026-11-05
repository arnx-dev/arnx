// A commit whose own install does not build: the project is reported not tested and the other projects finish;
// the image built for another commit stands in only when it is safe, and then the result is labelled and never
// complete.
import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { digest, parseReviewConfig, parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { EnvFailed } from "../src/errors";
import { exitCode, render } from "../src/report";
import { runReview } from "../src/reviewer";
import { ensureEnv, envOwner, repoId, sandboxOptions, timeLimit, withTimeLimit } from "../src/sandbox";
import type { Runner, SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { testRound, writeDirOf } from "../src/testround";
import { answerRound, FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-12T00:00:00Z" };
const GEN = "tests/arnx_generated/test_x.py";
const saved = { docker: sandboxOptions.docker, owner: envOwner.repo };
afterEach(() => {
  sandboxOptions.docker = saved.docker;
  envOwner.repo = saved.owner;
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** A docker that lists `images` ("tag", created, labels as k=v pairs) with their labels, and answers `run` from `run`
 * (what a listing of the image's files or a hash request prints, by whether the call reads stdin). */
function fakeDocker(images: { tag: string; labels: Record<string, string> }[],
                    run: { files?: string; hashes?: string } = {}): string[][] {
  const dir = tmp();
  const log = join(dir, "calls");
  writeFileSync(join(dir, "ls"), images.map((i) => `${i.tag}\t1GB\n`).join(""));
  writeFileSync(join(dir, "labels"), images.map((i) => `${JSON.stringify(i.labels)}\n`).join(""));
  writeFileSync(join(dir, "files"), run.files ?? "");
  writeFileSync(join(dir, "hashes"), run.hashes ?? "");
  writeFileSync(join(dir, "docker"), `#!/bin/sh
printf '%s\\037' "$@" >> '${log}'; echo >> '${log}'
case "$1 $2" in
  "image ls") cat '${join(dir, "ls")}';;
  "image inspect") cat '${join(dir, "labels")}';;
  "run --rm") case "$*" in *" -i "*) cat >/dev/null; cat '${join(dir, "hashes")}';; *) cat '${join(dir, "files")}';; esac;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  return [];
}

const PLAIN = parseReviewConfig("version: 1\nimage: i\ntest_command: pytest -q {targets}\n");
const labelsFor = (cfg: typeof PLAIN, repo: string, created: string, project = cfg.name) =>
  ({ "arnx.project": project, "arnx.repo": repoId(repo), "arnx.config": digest(cfg).slice(0, 16),
    "arnx.created": created });

const broken = (kind: "build" | "probe" = "build") =>
  new EnvFailed("the install does not build", kind, kind === "build" ? "env-build.log" : "probe.log");

function round(repo: string, cfg: typeof PLAIN, factory: SessionFactory, model = new ScriptedAgent([])) {
  return testRound(repo, null, cfg, { ...answerRound(model, cfg), writeDir: writeDirOf(cfg), budgetUsd: 1, runs: 1,
    outDir: join(tmp(), "out"), sessionFactory: factory, recordEnvFailure: true });
}

const passing = (snap: string): Runner => new FakeSession(snap, () => [junitXml([[GEN, "test_ok", "passed", ""]]), "", false]);

test("a project whose environment does not build is reported not tested and the others finish", async () => {
  fakeDocker([]);
  const repo = gitRepo(tmp());
  for (const p of ["services/pay/pay.py", "services/feed/feed.py", "services/shared/db.py"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "X = 1\n");
  }
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  commit(repo, "layout");
  writeFileSync(join(repo, "services/shared/db.py"), "X = 2\n");
  const factory: SessionFactory = async (cfg, snap, _log, body) => {
    if (cfg.name === "feed") throw broken();
    return body(passing(snap));
  };
  const agent = new ScriptedAgent([
    [tool("write_file", { path: `services/pay/${GEN}`, content: "def test_ok(): pass\n" })],
    [text('{"tests": []}')]]);
  const { review, rdir } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agent,
    challenger: new FakeJson([]), sessionFactory: factory });
  // pay was tested; feed's round made no model call
  expect(agent.calls.length).toBe(2);
  const feed = review.projectStats.find((p) => p.name === "feed")!;
  expect(feed.stop).toBe("env_failed: build");
  expect(feed.noReport).toBeUndefined();
  expect(feed.env).toEqual({ state: "failed", kind: "build", log: "projects/feed/env-build.log" });
  expect(review.projectStats.find((p) => p.name === "pay")!.env).toBeUndefined();
  expect(exitCode(review)).toBe(2);
  const md = readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " ");
  expect(md).toContain("`feed` not tested: this commit's install does not build; that is the commit, not your setup. " +
    "Review a later commit, or `arnx setup --project feed` from this one.");
  expect(md).not.toContain("the reviewer gave no report");
  expect(md).not.toContain("Complete:");
  // the review is written and says what the failed project cost: nothing
  expect(review.usage.every((u) => u.calls > 0)).toBe(true);
  expect(md).not.toContain("Run `arnx review` again");
  expect(JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")).project_stats[0].env.state).toBe("failed");
});

test("when no project builds nothing is billed and no model is called", async () => {
  fakeDocker([]);
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "services/pay"), { recursive: true });
  writeFileSync(join(repo, "services/pay/pay.py"), "X = 1\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-12"));
  commit(repo, "layout");
  writeFileSync(join(repo, "services/pay/pay.py"), "X = 2\n");
  const agent = new ScriptedAgent([]);
  const { review, rdir } = await runReview(repo, { projectConcurrency: 1, settings: SETTINGS, agentModel: agent,
    challenger: new FakeJson([]), sessionFactory: async () => { throw broken("probe"); } });
  expect(agent.calls.length).toBe(0);
  expect([review.costUsd, review.usage]).toEqual([0, []]);
  expect(review.projectStats[0]!.stop).toBe("env_failed: probe");
  expect(exitCode(review)).toBe(2);
  expect(render(review)).not.toContain("Agent stopped: env_failed");
  expect(readFileSync(join(rdir, "state.json"), "utf8")).not.toContain("env_failed");
});

test("an install that fails here uses the project's proven image and says so", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "a.py"), "X = 1\n");
  commit(repo, "one");
  envOwner.repo = repo;
  fakeDocker([
    { tag: "arnx-env:aaaaaaaaaaaaaaaa", labels: labelsFor(PLAIN, repo, "2026-10-01T00:00:00Z") },
    { tag: "arnx-env:bbbbbbbbbbbbbbbb", labels: labelsFor(PLAIN, repo, "2026-10-20T00:00:00Z") },
    // never chosen: made from the code, another project's, another repository's, another configuration's
    { tag: "arnx-env:cccccccccccccccc-src-0123456789ab", labels: labelsFor(PLAIN, repo, "2026-10-25T00:00:00Z") },
    { tag: "arnx-env:dddddddddddddddd", labels: labelsFor(PLAIN, repo, "2026-10-26T00:00:00Z", "other") },
    { tag: "arnx-env:eeeeeeeeeeeeeeee", labels: labelsFor(PLAIN, "/elsewhere", "2026-10-26T00:00:00Z") },
    { tag: "arnx-env:ffffffffffffffff", labels: { ...labelsFor(PLAIN, repo, "2026-10-26T00:00:00Z"),
      "arnx.config": "0000000000000000" } },
  ]);
  const asked: (string | undefined)[] = [];
  const factory: SessionFactory = async (_cfg, snap, _log, body, envFrom, key) => {
    asked.push(key);
    if (!key) throw broken();
    expect(envFrom).toBe(snap);
    return body(passing(snap));
  };
  const model = new ScriptedAgent([
    [tool("write_file", { path: GEN, content: "def test_ok(): pass\n" })], [text('{"tests": []}')]]);
  const r = await round(repo, PLAIN, factory, model);
  expect(asked).toEqual([undefined, "bbbbbbbbbbbbbbbb"]);
  expect(r.env).toEqual({ state: "fallback", kind: "build", log: "env-build.log" });
  expect(r.agent.stop).toBe("end_turn");
  expect(r.classified.passed.length).toBe(1);
});

test("an image holding a differing copy of the code is not used", async () => {
  const BAKED = parseReviewConfig("version: 1\nimage: i\nworkdir: app\ninstall: [\"mkdir -p /opt/app && cp -r . /opt/app\"]\n" +
    "test_command: cd /opt/app && python -m pytest -q {targets}\n");
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "app"));
  for (const f of ["a.py", "b.py", "c.py"]) writeFileSync(join(repo, "app", f), `${f} = 1\n`);
  commit(repo, "one");
  envOwner.repo = repo;
  fakeDocker([{ tag: "arnx-env:9999999999999999", labels: labelsFor(BAKED, repo, "2026-10-20T00:00:00Z") }], {
    files: "/opt/app/a.py\n/opt/app/b.py\n/opt/app/c.py\n",
    hashes: ["a.py", "b.py", "c.py"].map((f) => `${sha("an older " + f)}  /opt/app/${f}\n`).join("") });
  const asked: (string | undefined)[] = [];
  const factory: SessionFactory = async (_cfg, snap, _log, body, _from, key) => {
    asked.push(key);
    if (!key) throw broken("probe");
    return body(passing(snap));
  };
  const r = await round(repo, BAKED, factory);
  // no second try: the copy it holds is not this code
  expect(asked).toEqual([undefined]);
  expect(r.env).toEqual({ state: "failed", kind: "probe", log: "probe.log" });
  expect(r.agent).toMatchObject({ stop: "env_failed: probe", calls: 0, costUsd: 0 });
});

test("a network failure keeps its own advice", async () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "a.py"), "X = 1\n");
  commit(repo, "one");
  envOwner.repo = repo;
  fakeDocker([{ tag: "arnx-env:bbbbbbbbbbbbbbbb", labels: labelsFor(PLAIN, repo, "2026-10-20T00:00:00Z") }]);
  const asked: (string | undefined)[] = [];
  const factory: SessionFactory = async (_cfg, _snap, _log, _body, _from, key) => {
    asked.push(key);
    throw new EnvFailed("building the test environment failed because it could not reach the package index or " +
      "registry (timeouts or a broken connection, twice): a network problem, not the install steps.", "build",
    "env-build.log", true);
  };
  const err = await round(repo, PLAIN, factory).catch((e: unknown) => e);
  expect(err).toBeInstanceOf(EnvFailed);
  expect(String(err)).toContain("a network problem, not the install steps");
  expect(asked).toEqual([undefined]);
});

test("a round whose environment failed is not a cut round, and a resume does not look for it", async () => {
  const { roundCut, resumable } = await import("../src/reviewer");
  const agent = { finalText: "", costUsd: 0, turns: 0, stop: "env_failed: build", calls: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const dir = tmp();
  const round = { agent, files: {}, classified: { findings: [], flaky: [], errors: [], passed: [], missingRuns: 0,
    skipped: 0, totalRuns: 0 }, removed: [], sawResults: true, env: { state: "failed" as const, kind: "build" as const, log: "x" } };
  expect(roundCut({ round }, dir)).toBe(false);
  // a finished review with such a round has nothing to resume
  const repo = gitRepo(tmp());
  const rdir = join(repo, ".arnx", "reviews", "r1");
  mkdirSync(join(rdir, "projects", "main"), { recursive: true });
  writeFileSync(join(rdir, "state.json"), JSON.stringify({ diff_sha256: "abc" }));
  writeFileSync(join(rdir, "review.json"), JSON.stringify({ provider_failures: [] }));
  writeFileSync(join(rdir, "projects", "main", "round.json"), JSON.stringify({ round }));
  expect(resumable(repo, "abc")).toBeNull();
});

test("findings from a fallback image are shown, labelled, and do not fail the run", async () => {
  const { sampleReview } = await import("./helpers/review");
  const r = sampleReview({ projectStats: [{ name: "main", testFiles: 1, tests: 2, passed: 0, missingRuns: 0,
    sawResults: true, stop: "end_turn", env: { state: "fallback", kind: "build", log: "env-build.log" } }] });
  expect(exitCode(r)).toBe(2);
  const md = render(r).replace(/\s+/g, " ");
  expect(md).toContain("`main`: this commit's own install does not build (see .arnx/reviews/20261011-a1b2c3/env-build.log). " +
    "Tested on the image built for another commit: its dependencies may differ");
  expect(md).not.toContain("Complete:");
  // another project's findings still fail it
  const other = sampleReview({ projectStats: [{ ...r.projectStats[0]!, name: "other" }] });
  expect(exitCode(other)).toBe(1);
});

test("a build that does not finish is a failed environment with its log, not an abort", async () => {
  const fake = join(tmp(), "docker");
  writeFileSync(fake, `#!/bin/sh\ncase "$1" in image) exit 1;; build) exec sleep 5;; esac\n`);
  chmodSync(fake, 0o755);
  sandboxOptions.docker = fake;
  const [buildkit, floor] = [sandboxOptions.buildkit, timeLimit.floorSeconds];
  [sandboxOptions.buildkit, timeLimit.floorSeconds] = [false, 1];
  try {
    const log = join(tmp(), "out", "env-build.log");
    const limit = { at: performance.now() + 2000, now: () => performance.now(), minutes: 1 };
    const err = await withTimeLimit(limit, () => ensureEnv(PLAIN, tmp(), log)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvFailed);
    expect(err).toMatchObject({ kind: "build", network: false, log: "env-build.log" });
    expect(String(err)).toMatch(/docker build did not finish in [12]s/);
    expect(existsSync(log)).toBe(true);
    expect(readFileSync(log, "utf8")).toContain("did not finish");
  } finally {
    [sandboxOptions.buildkit, timeLimit.floorSeconds] = [buildkit, floor];
  }
});

test("on a fallback no verdict says the change caused it or fixed it", async () => {
  const { asFallbackBefore, asFallbackFix } = await import("../src/before");
  const reg = { status: "regression" as const, detail: "passes before", runs: ["passed"] };
  const b = asFallbackBefore(reg);
  expect(b.status).toBe("unknown");
  expect(b.detail).toContain("another commit");
  expect(b.detail).not.toContain("broke");
  expect(asFallbackBefore({ status: "pre-existing", detail: "d", runs: [] }).status).toBe("pre-existing");
  expect(asFallbackFix({ status: "fixed", detail: "f", runs: [] }).status).toBe("unknown");
  expect(asFallbackFix({ status: "unchanged", detail: "u", runs: [] }).status).toBe("unchanged");
});

test("a finding from a fallback carries the label in the report, in triage and in accept's line", async () => {
  const { sampleReview } = await import("./helpers/review");
  const { markInteractive } = await import("../src/mark");
  const { PLAIN: paint } = await import("../src/color");
  const r = sampleReview();
  r.findings[0]!.fallback = true;
  expect(render(r).replace(/\s+/g, " ")).toContain("### F1 · confirmed by the second opinion · ran on another commit's image");
  const screens: string[][] = [];
  await markInteractive(r, render(r), { paint, width: 80, draw: (l) => screens.push(l),
    keys: { async next() { return { value: "quit" as const, done: false }; } } });
  expect(screens[0]!.join("\n")).toContain("another commit's image");
});

test("a fallback is refused when a reached copy holds files this commit does not have", async () => {
  const BAKED = parseReviewConfig("version: 1\nimage: i\nworkdir: app\ninstall: [\"mkdir -p /opt/app && cp -r . /opt/app\"]\n" +
    "test_command: cd /opt/app && python -m pytest -q {targets}\n");
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "app"));
  for (const f of ["a.py", "b.py", "c.py"]) writeFileSync(join(repo, "app", f), `${f} = 1\n`);
  commit(repo, "one");
  envOwner.repo = repo;
  fakeDocker([{ tag: "arnx-env:8888888888888888", labels: labelsFor(BAKED, repo, "2026-10-20T00:00:00Z") }], {
    files: "/opt/app/a.py\n/opt/app/b.py\n/opt/app/c.py\n/opt/app/gone_old.py\n",
    hashes: ["a.py", "b.py", "c.py"].map((f) => `${sha(`${f} = 1\n`)}  /opt/app/${f}\n`).join("") });
  const asked: (string | undefined)[] = [];
  const factory: SessionFactory = async (_cfg, snap, _log, body, _from, key) => {
    asked.push(key);
    if (!key) throw broken("probe");
    return body(passing(snap));
  };
  const r = await round(repo, BAKED, factory);
  expect(asked).toEqual([undefined]);
  expect(r.env?.state).toBe("failed");
});

test("an env-failed review has its own next step and does not say to review again", async () => {
  const { sampleReview } = await import("./helpers/review");
  const { whatNext } = await import("../src/next");
  const { save } = await import("../src/report");
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"));
  writeFileSync(join(repo, "svc/a.py"), "X = 1\n");
  const YAML = "version: 1\nprojects:\n  svc:\n    root: svc\n    image: python:3.12-slim\n    test_command: pytest {targets}\n";
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(YAML), "Dev", "2026-10-14"));
  writeFileSync(join(repo, ".arnx", "config.toml"), "");
  commit(repo, "a");
  const { writeSettings } = await import("../src/settings");
  writeSettings(repo, { ...defaultSettings(), consentAt: "2026-10-14T00:00:00Z" });
  writeFileSync(join(repo, "svc/a.py"), "X = 2\n");
  const rdir = join(repo, ".arnx/reviews/20261014-abcdef");
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, "state.json"), "{}\n");
  const review = { ...sampleReview({ findings: [], questions: [], questionProjects: [], flaky: [], passed: 0,
    testsWritten: 0 }), id: "20261014-abcdef", projects: ["svc"], projectStats: [{ name: "svc", testFiles: 0, tests: 0,
    passed: 0, missingRuns: 0, sawResults: true, stop: "env_failed: build",
    env: { state: "failed" as const, kind: "build" as const, log: "projects/svc/env-build.log" } }] };
  save(review, rdir, "d");
  const next = whatNext(repo);
  expect(next.command).toBe("arnx setup --project svc");
  expect(next.where).not.toContain("waiting for your marks");
  const md = readFileSync(join(rdir, "review.md"), "utf8").replace(/\s+/g, " ");
  expect(md).not.toContain("Run `arnx review` again");
});

test("a failing install runs once: the session reuses the indexer's verdict", async () => {
  const dir = tmp();
  const calls = join(dir, "calls");
  writeFileSync(join(dir, "docker"), `#!/bin/sh\necho "$1" >> '${calls}'\ncase "$1" in image) exit 1;; build) echo "ERROR: step failed" >&2; exit 1;; esac\n`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  const buildkit = sandboxOptions.buildkit;
  sandboxOptions.buildkit = false;
  const { projectIndex } = await import("../src/indexer");
  const { forgetFailedBuilds } = await import("../src/sandbox");
  forgetFailedBuilds();
  try {
    const snap = tmp();
    writeFileSync(join(snap, "a.py"), "X = 1\n");
    const out = join(tmp(), "out");
    const r = await projectIndex(PLAIN, snap, out);
    expect(r.index).toBeNull();
    const err = await ensureEnv(PLAIN, snap, join(out, "env-build.log")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(EnvFailed);
    expect(readFileSync(calls, "utf8").split("\n").filter((l) => l === "build").length).toBe(1);
  } finally {
    sandboxOptions.buildkit = buildkit;
    forgetFailedBuilds();
  }
});

const stat = (env: NonNullable<import("../src/report").ProjectStat["env"]>, over: object = {}) => ({ name: "svc", testFiles: 0, tests: 0, passed: 0, missingRuns: 0,
  sawResults: true, stop: "env_failed: build", env, ...over });
const failedEnv = (old?: true) => ({ state: "failed" as const, kind: "build" as const, log: "projects/svc/env-build.log",
  ...(old ? { old } : {}) });

test("setup is offered only when the failing commit is the checked-out one", async () => {
  const { sampleReview } = await import("./helpers/review");
  const say = (old?: true) => render(sampleReview({ findings: [], questions: [], questionProjects: [], flaky: [],
    passed: 0, testsWritten: 0, projects: ["svc"], projectStats: [stat(failedEnv(old))] })).replace(/\s+/g, " ");
  expect(say()).toContain("Review a later commit, or `arnx setup --project svc` from this one.");
  const old = say(true);
  expect(old).toContain("Review a later commit.");
  expect(old).not.toContain("arnx setup");
});

test("a review of an older commit records it, and next says only to review a later commit", async () => {
  const repo = gitRepo(tmp());
  for (const n of ["x", "y"]) {
    writeFileSync(join(repo, "app.py"), `V = '${n}'\n`);
    commit(repo, n);
  }
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(
    "version: 1\nprojects:\n  svc:\n    root: .\n    image: python:3.12-slim\n    test_command: pytest {targets}\n"),
  "Dev", "2026-10-12"));
  commit(repo, "config");
  const { runGit } = await import("./helpers/gitutil");
  const range = `${runGit(repo, "rev-parse", "HEAD~2").trim()}..${runGit(repo, "rev-parse", "HEAD~1").trim()}`;
  const mk = async (r: string | null) => (await runReview(repo, { range: r, settings: SETTINGS,
    agentModel: new ScriptedAgent([]), challenger: new FakeJson([]),
    sessionFactory: async () => { throw broken(); } })).review;
  expect((await mk(range)).projectStats[0]!.env).toMatchObject({ state: "failed", old: true });
  const { whatNext } = await import("../src/next");
  const { writeSettings } = await import("../src/settings");
  writeSettings(repo, SETTINGS);
  expect(whatNext(repo)).toMatchObject({ command: "arnx review" });
  expect(whatNext(repo).why).toContain("later commit");
  expect((await mk(`${runGit(repo, "rev-parse", "HEAD~2").trim()}..${runGit(repo, "rev-parse", "HEAD").trim()}`))
    .projectStats[0]!.env?.old).toBeUndefined();
});

test("a finding from a fallback is labelled in the summary and in the review --json rows", async () => {
  const { sampleReview } = await import("./helpers/review");
  const { summary, summaryRows } = await import("../src/report");
  const { reviewJson } = await import("../src/cli");
  const r = sampleReview();
  r.findings[0]!.fallback = true;
  expect(summaryRows(r)[0]!.fallback).toBe(true);
  expect(summary(r, "review.md")).toContain("ran on another commit's image");
  const rows = (reviewJson(r, "review.md", "review.json")[2] as { findings: { fallback?: boolean }[] }).findings;
  expect(rows[0]!.fallback).toBe(true);
  expect(rows.slice(1).every((x) => x.fallback === undefined)).toBe(true);
});

test("an environment problem beside another is not followed by 'review again'", async () => {
  const { sampleReview } = await import("./helpers/review");
  const md = render(sampleReview({ findings: [], questions: [], questionProjects: [], flaky: [], passed: 0,
    testsWritten: 0, projects: ["svc", "b"], projectStats: [stat(failedEnv()),
      { name: "b", testFiles: 2, tests: 1, passed: 1, missingRuns: 0, sawResults: true, stop: "end_turn",
        hungFiles: ["t/x.py"] }] })).replace(/\s+/g, " ");
  expect(md).toContain("did not finish");
  expect(md).not.toContain("Run `arnx review` again");
});

test("a fallback is refused for a removed whole folder but not for build output alone", async () => {
  const BAKED = parseReviewConfig("version: 1\nimage: i\nworkdir: app\ninstall: [\"mkdir -p /opt/app && cp -r . /opt/app\"]\n" +
    "test_command: cd /opt/app && python -m pytest -q {targets}\n");
  const run = async (tag: string, extra: string) => {
    mkdirSync(join(tmp(), tag));
    const repo = gitRepo(join(tmp(), tag));
    mkdirSync(join(repo, "app"));
    for (const f of ["a.py", "b.py", "c.py"]) writeFileSync(join(repo, "app", f), `${f} = 1\n`);
    commit(repo, "one");
    envOwner.repo = repo;
    fakeDocker([{ tag: `arnx-env:${tag}`, labels: labelsFor(BAKED, repo, "2026-10-20T00:00:00Z") }], {
      files: `/opt/app/a.py\n/opt/app/b.py\n/opt/app/c.py\n${extra}`,
      hashes: ["a.py", "b.py", "c.py"].map((f) => `${sha(`${f} = 1\n`)}  /opt/app/${f}\n`).join("") });
    const asked: (string | undefined)[] = [];
    await round(repo, BAKED, async (_c, snap, _l, body, _f, key) => {
      asked.push(key);
      if (!key) throw broken("probe");
      return body(passing(snap));
    }, new ScriptedAgent([[text('{"tests": []}')]]));
    return asked;
  };
  expect(await run("7777777777777777", "/opt/app/old/mod.py\n")).toEqual([undefined]);
  expect(await run("6666666666666666", "/opt/app/__pycache__/a.cpython-312.pyc\n/opt/app/build/lib/x.py\n" +
    "/opt/app/pkg.egg-info/PKG-INFO\n/opt/app/dist/p.whl\n/opt/app/.pytest_cache/v/c\n")).toEqual([undefined, "6666666666666666"]);
});
