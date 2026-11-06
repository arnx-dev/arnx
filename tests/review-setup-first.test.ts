// Before a review runs any suite, it decides: a part of the repository setup never covered (or whose setup stopped)
// is set up first, quickly; a change no project covers is refused at once; a file setup itself left unproven is set
// up from, not proven by its whole suite; a hand-edited one is proven within the quick limit.
import { expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { baselinePath, writeBaseline } from "../src/baseline";
import { approvalStamp, parseReviewFile, reviewConfigPath } from "../src/config";
import { NOT_SET_UP } from "../src/draft";
import { EnvFailed, SetupRequired } from "../src/errors";
import { manyServicesReason } from "../src/facts";
import { setupParts } from "../src/route";
import type { ReviewConfig } from "../src/config";
import type { RunResult, Runner, SessionFactory } from "../src/sandbox";
import { loadSettings, writeSettings } from "../src/settings";
import { approveFile, NO_TESTS, SCRIPTS, TIME_LEFT_OUT } from "../src/setup";
import { PROVEN_BASELINE, PROVEN_COPY } from "../src/setupview";
import { Cli } from "./helpers/cli";
import { ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const ENV = { ANTHROPIC_API_KEY: "a" };
const MIN = 60_000;
const TESTS = ["tests/test_a.py", "tests/test_b.py", "tests/test_c.py", "tests/test_d.py", "tests/test_e.py"];

const block = (name: string, install = "[pip install pytest]") => `  ${name}:\n    root: ${name}\n` +
  `    language: python\n    image: python:3.12-slim\n    install: ${install}\n` +
  "    test_command: python -m pytest -q {targets}\n";
const file = (projects: string[], uncovered: [string, string][] = []) => `version: 1\nprojects:\n${projects.join("")}` +
  (uncovered.length ? `uncovered:\n${uncovered.map(([p, r]) => `  - path: ${p}\n    reason: "${r}"\n`).join("")}` : "");

/** Two Python projects, api and web, each with five test files (growing from a to e), initialized and agreed to. */
async function twoProjects(more: Record<string, string> = {}): Promise<string> {
  const repo = initRepo(join(tmp(), "two"));
  const put = (path: string, body: string) => {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  };
  for (const name of ["api", "web"]) {
    put(`${name}/pyproject.toml`, `[project]\nname = "${name}"\nversion = "0.1"\n`);
    put(`${name}/${name}.py`, "def f():\n    return 1\n");
    TESTS.forEach((f, i) => put(`${name}/${f}`, "def test_x():\n    pass\n" + "# padding\n".repeat(i * 10)));
  }
  for (const [path, body] of Object.entries(more)) put(path, body);
  commit(repo, "two");
  expect(await new Cli({ cwd: repo, env: ENV }).run("init")).toBe(0);
  writeSettings(repo, { ...loadSettings(repo), consentAt: "2026-11-01T00:00:00+00:00" });
  return repo;
}

/** One run in a project's sandbox: the project, and the command. */
interface Ran { project: string; command: string }

/** Suites over each project's five test files, as pytest answers: the listing names them, arnx's one-line test is
 * listed and passes, a run of some files passes them, the whole suite passes all. A project `runs` refuses fails
 * at its listing. `clock`: each run takes `minutes`, and is cut at the limit (Docker stops a step there). */
function suites(seen: Ran[], runs: (cfg: ReviewConfig) => boolean = () => true,
                clock?: { ms: number; minutes: number }): SessionFactory {
  return async <T>(cfg: ReviewConfig, snap: string, _log: string, body: (r: Runner) => Promise<T>) => body({
    run(command: string): RunResult {
      seen.push({ project: cfg.name, command });
      if (clock) {
        clock.ms += clock.minutes * MIN;
        return { exitCode: null, output: "", timedOut: true, seconds: clock.minutes * 60 };
      }
      const done = (output: string, xml?: string, exitCode = 0): RunResult => {
        const m = /--junitxml=\/src\/(\S+)/.exec(command);
        if (xml && m) {
          mkdirSync(dirname(join(snap, m[1]!)), { recursive: true });
          writeFileSync(join(snap, m[1]!), xml);
        }
        return { exitCode, output, timedOut: false, seconds: 0.1 };
      };
      if (!runs(cfg)) return done("ImportError: No module named 'x'", undefined, 2);
      const probe = /(\S*test_arnx_probe\.py)/.exec(command)?.[1];
      const pass = (files: string[]) => junitXml(files.map((f) => [f, "test_x", "passed", ""] as [string, string, string, string]));
      if (command.includes("--collect-only")) {
        return done(probe ? `${probe}::test_arnx_probe` : TESTS.map((f) => `${f}::test_x`).join("\n") +
          "\n\n5 tests collected in 0.01s");
      }
      if (probe) return done("1 passed", pass([probe]));
      const targets = TESTS.filter((f) => command.includes(f));
      return done("passed", pass((targets.length ? targets : TESTS).map((f) => `${cfg.workdir}/${f}`)));
    } });
}

/** Whether a run is a whole suite: not a listing, not the one-line test, no file named. */
const whole = (r: Ran) => !r.command.includes("--collect-only") && !r.command.includes("test_arnx_probe") &&
  !TESTS.some((f) => r.command.includes(f));

/** `yaml` proven on this machine: stamped by a passing proof, its copy and its baseline's kept, all committed. */
async function proven(repo: string, yaml: string): Promise<void> {
  writeFileSync(reviewConfigPath(repo), yaml);
  writeBaseline(repo, new Map(parseReviewFile(yaml).projects.map((p) => [p.name, []])));
  const [ok, detail] = await approveFile(repo, { by: "Dev", at: "2026-11-01T00:00:00+00:00",
    sessionFactory: suites([]) });
  expect([ok, detail]).toEqual([true, expect.any(String)]);
  mkdirSync(dirname(join(repo, PROVEN_COPY)), { recursive: true });
  copyFileSync(reviewConfigPath(repo), join(repo, PROVEN_COPY));
  if (existsSync(baselinePath(repo))) copyFileSync(baselinePath(repo), join(repo, PROVEN_BASELINE));
  commit(repo, "proven");
}

/** A change to one file, committed: the last commit is what the review takes. */
function change(repo: string, path: string): void {
  writeFileSync(join(repo, path), "def f():\n    return 2\n");
  commit(repo, `change ${path}`);
}

/** The review itself stands in here: it notes it was reached and stops (no model is called). */
function reviewStub(reached: string[]) {
  return async (repo: string) => {
    reached.push(repo);
    throw new SetupRequired("review reached");
  };
}

test("a part left out at the time limit is set up before the review", async () => {
  const repo = await twoProjects();
  await proven(repo, file([block("api")], [["/web/", TIME_LEFT_OUT]]));
  change(repo, "web/web.py");
  const [setupRuns, proofRuns, reached]: [Ran[], Ran[], string[]] = [[], [], []];
  const model = new ScriptedAgent([]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: suites(setupRuns),
    approveSessions: suites(proofRuns), runReview: reviewStub(reached) });
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toContain("review reached");
  expect(reached).toHaveLength(1);
  // The draft ran with no model, as a quick look of web; api kept its proof.
  expect(model.calls).toHaveLength(0);
  expect(setupRuns.map((r) => r.project)).toContain("web");
  expect(setupRuns.some(whole)).toBe(false);
  expect(proofRuns).toEqual([]);
  const f = parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8"));
  expect(f.projects.map((p) => p.name).sort()).toEqual(["api", "web"]);
  expect(f.uncovered).toEqual([]);
  expect(approvalStamp(repo)?.current).toBe(true);
});

test("a change no project covers is refused before any suite runs", async () => {
  const repo = await twoProjects({ "tools/release.py": "def f():\n    return 1\n" });
  await proven(repo, file([block("api"), block("web")], [["/tools/", SCRIPTS]]));
  // Edited by hand since its proof: a review would prove it again first.
  writeFileSync(reviewConfigPath(repo), readFileSync(reviewConfigPath(repo), "utf8")
    .replace("pip install pytest", "pip install pytest requests"));
  commit(repo, "hand edit");
  change(repo, "tools/release.py");
  const [setupRuns, proofRuns, reached]: [Ran[], Ran[], string[]] = [[], [], []];
  let proofSessions = 0;
  const counted = suites(proofRuns);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: new ScriptedAgent([]), setupSessions: suites(setupRuns),
    approveSessions: (cfg, snap, log, body) => {
      proofSessions++;
      return counted(cfg, snap, log, body);
    }, runReview: reviewStub(reached) });
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toContain("no project covers this change: tools/release.py (scripts). Run `arnx setup --add` " +
    "to cover these paths. arnx works best on single-package Python and TypeScript repos; browser-only tests aren't run.");
  expect([proofSessions, setupRuns.length, reached.length]).toEqual([0, 0, 0]);
});

test("setup's own unproven attempt is set up from, not proven by its whole suite", async () => {
  const repo = await twoProjects();
  change(repo, "api/api.py");
  // The first run: nothing runs (the network is down), and the agent's fix, an editable install, is its last try.
  const attempt = file([block("api", "[pip install pytest, pip install -e .]")], [["/web/", NOT_SET_UP]]);
  const first = new Cli({ cwd: repo, env: ENV, setupModel: new ScriptedAgent([[tool("try_project",
    { yaml: attempt, project: "api" })], [text("giving up")]]), setupSessions: suites([], () => false),
    runReview: reviewStub([]) });
  expect(await first.run("review")).toBe(2);
  expect(readFileSync(reviewConfigPath(repo), "utf8")).toContain("pip install -e .");
  expect(approvalStamp(repo)?.current ?? false).toBe(false);
  // The next review: the network is back; only the attempt's install works.
  const [setupRuns, proofRuns, reached]: [Ran[], Ran[], string[]] = [[], [], []];
  const model = new ScriptedAgent([]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model,
    setupSessions: suites(setupRuns, (cfg) => cfg.install.includes("pip install -e .")),
    approveSessions: suites(proofRuns), runReview: reviewStub(reached) });
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toContain("review reached");
  expect(model.calls).toHaveLength(0);
  expect(proofRuns).toEqual([]);
  expect(setupRuns.length).toBeGreaterThan(0);
  expect(setupRuns.some(whole)).toBe(false);
  expect(readFileSync(reviewConfigPath(repo), "utf8")).toContain("pip install -e .");
  expect(approvalStamp(repo)?.current).toBe(true);
});

test("setup's own attempt that fails again in a review is left to arnx setup", async () => {
  const repo = await twoProjects();
  change(repo, "api/api.py");
  const attempt = file([block("api", "[pip install pytest, pip install -e .]")], [["/web/", NOT_SET_UP]]);
  const fails = () => new Cli({ cwd: repo, env: ENV, setupModel: new ScriptedAgent([[tool("try_project",
    { yaml: attempt, project: "api" })], [text("giving up")]]), setupSessions: suites([], () => false),
    runReview: reviewStub([]) });
  expect(await fails().run("review")).toBe(2); // the first run
  expect(await fails().run("review")).toBe(2); // the review's try from its attempt
  const runs: Ran[] = [];
  const model = new ScriptedAgent([]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: suites(runs),
    approveSessions: suites(runs), runReview: reviewStub([]) });
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toContain("/api/ could not be set up for a review (tried twice). Next: arnx setup");
  expect([runs.length, model.calls.length]).toEqual([0, 0]);
});

test("a hand-edited unproven file is proven within the limit, then names arnx approve", async () => {
  const repo = await twoProjects();
  await proven(repo, file([block("api"), block("web")]));
  writeFileSync(reviewConfigPath(repo), readFileSync(reviewConfigPath(repo), "utf8")
    .replace("pip install pytest", "pip install pytest requests"));
  commit(repo, "hand edit");
  change(repo, "api/api.py");
  // Each run of the proof would take eleven minutes.
  const clock = { ms: 0, minutes: 11 };
  const [proofRuns, reached]: [Ran[], string[]] = [[], []];
  const cli = new Cli({ cwd: repo, env: ENV, now: () => clock.ms, setupModel: new ScriptedAgent([]),
    setupSessions: suites([]), approveSessions: suites(proofRuns, () => true, clock), runReview: reviewStub(reached) });
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toContain(".arnx/review.yaml changed since its proof: its suites did not finish in 10 min.\n" +
    "Next: arnx approve (runs it without a limit)");
  expect(cli.stderr.split("arnx approve")).toHaveLength(2); // named once
  expect(reached).toEqual([]);
  expect(proofRuns.length).toBeGreaterThan(0);
  expect(approvalStamp(repo)?.current).toBe(false);
});

/** A hand-edited install, proven again: its image build takes eleven minutes and Docker cuts it. */
async function slowBuild(): Promise<{ repo: string; clock: { ms: number }; builds: SessionFactory }> {
  const repo = await twoProjects();
  await proven(repo, file([block("api"), block("web")]));
  writeFileSync(reviewConfigPath(repo), readFileSync(reviewConfigPath(repo), "utf8")
    .replace("pip install pytest", "pip install pytest requests"));
  commit(repo, "hand edit");
  change(repo, "api/api.py");
  const clock = { ms: 0 };
  const builds: SessionFactory = async () => {
    clock.ms += 11 * MIN;
    throw new EnvFailed("docker build did not finish in 600s; see .arnx/run/approve-build-api.log", "build",
      "approve-build-api.log");
  };
  return { repo, clock, builds };
}

test("a proof before a review whose image build runs out of time says so", async () => {
  const { repo, clock, builds } = await slowBuild();
  const reached: string[] = [];
  const cli = new Cli({ cwd: repo, env: ENV, now: () => clock.ms, setupModel: new ScriptedAgent([]),
    setupSessions: suites([]), approveSessions: builds, runReview: reviewStub(reached) });
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toContain(".arnx/review.yaml changed since its proof: the image build did not finish in 10 min.\n" +
    "Next: arnx approve (runs it without a limit)");
  expect(reached).toEqual([]);
});

test("the 10-minute limit is the review's: arnx check proves a changed file as before", async () => {
  const repo = await twoProjects();
  await proven(repo, file([block("api"), block("web")]));
  writeFileSync(reviewConfigPath(repo), readFileSync(reviewConfigPath(repo), "utf8")
    .replace("pip install pytest", "pip install pytest requests"));
  const clock = { ms: 0, minutes: 11 };
  const cli = new Cli({ cwd: repo, env: ENV, now: () => clock.ms, approveSessions: suites([], () => true, clock) });
  expect(await cli.run("check")).toBe(3);
  expect(cli.stderr).not.toContain("did not finish in 10 min");
  expect(cli.stderr).toContain(".arnx/review.yaml changed since its proof, and its suites fail:");
  expect(cli.stderr).toContain("Next: fix the ✗ above, then arnx check");
});

test("a change that cannot be reviewed is said before the proof runs", async () => {
  const repo = await twoProjects();
  await proven(repo, file([block("api"), block("web")]));
  writeFileSync(reviewConfigPath(repo), readFileSync(reviewConfigPath(repo), "utf8")
    .replace("pip install pytest", "pip install pytest requests"));
  commit(repo, "hand edit");
  const [proofRuns, reached]: [Ran[], string[]] = [[], []];
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: new ScriptedAgent([]), setupSessions: suites([]),
    approveSessions: suites(proofRuns), runReview: reviewStub(reached) });
  expect(await cli.run("review", "--range", "HEAD..HEAD")).not.toBe(0);
  expect(cli.stderr).toContain("nothing to review");
  expect([proofRuns.length, reached.length]).toEqual([0, 0]);
});

test("a folder no project can be drafted for is tried once, then refused at once", async () => {
  const repo = await twoProjects();
  await proven(repo, file([block("api"), block("web")]));
  mkdirSync(join(repo, "misc"), { recursive: true });
  writeFileSync(join(repo, "misc", "thing.py"), "X = 1\n");
  commit(repo, "misc");
  const review = () => new Cli({ cwd: repo, env: ENV, setupModel: new ScriptedAgent([]), setupSessions: suites([]),
    approveSessions: suites([]), runReview: reviewStub([]) });
  const first = review();
  expect(await first.run("review")).toBe(3);
  expect(first.stdout).toContain("Nothing here arnx can test: no project it can set up owns a file /misc/ touches.");
  // One next step, the refusal's, at the end.
  expect(first.stdout).not.toContain("Next:");
  expect(first.stdout).not.toContain("Reviewing the rest");
  expect(first.stderr).toContain("no project covers this change: misc/thing.py (no project covers it)");
  const again = review();
  expect(await again.run("review")).toBe(3);
  expect(again.stdout).not.toContain("Setting up");
  expect(again.stdout).not.toContain("Nothing here arnx can test");
  expect(again.stderr).toContain("no project covers this change: misc/thing.py (no project covers it)");
});

test("a part that failed is not tried again by the next review", async () => {
  const repo = await twoProjects();
  await proven(repo, file([block("api")], [["/web/", TIME_LEFT_OUT]]));
  change(repo, "web/web.py");
  const before = readFileSync(reviewConfigPath(repo), "utf8");
  // web does not run: the draft fails at its listing, and the agent gives up.
  const [setupRuns, proofRuns]: [Ran[], Ran[]] = [[], []];
  const first = new Cli({ cwd: repo, env: ENV, setupModel: new ScriptedAgent([[text("giving up")]]),
    setupSessions: suites(setupRuns, (cfg) => cfg.name !== "web"), approveSessions: suites(proofRuns),
    runReview: reviewStub([]) });
  expect(await first.run("review")).toBe(3);
  expect(setupRuns.map((r) => r.project)).toContain("web");
  // Nothing else in the change is covered: no "reviewing the rest", only the refusal.
  expect(first.stdout).not.toContain("Reviewing the rest");
  expect(first.stderr).toContain("no project covers this change: web/web.py (setup reached its time limit)");
  expect(readFileSync(reviewConfigPath(repo), "utf8")).toBe(before);
  // The next review of the same part: refused at once, nothing set up, nothing asked.
  const [again, proofAgain]: [Ran[], Ran[]] = [[], []];
  const model = new ScriptedAgent([]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: suites(again),
    approveSessions: suites(proofAgain), runReview: reviewStub([]) });
  expect(await cli.run("review")).toBe(3);
  expect(cli.stderr).toContain("no project covers this change: web/web.py (setup reached its time limit)");
  expect([again.length, proofAgain.length, proofRuns.length, model.calls.length]).toEqual([0, 0, 0, 0]);
});

test("setupParts: which changed files a review sets up first, by the reason their part is left out", () => {
  const f = parseReviewFile(file([block("api")], [
    ["/web/", TIME_LEFT_OUT],
    ["/later/", NOT_SET_UP],
    ["/e2e/", "browser tests (playwright)"],
    ["/ui/", "web UI"],
    ["/tools/", SCRIPTS],
    ["/stack/", manyServicesReason(["postgres", "redis", "minio"])],
    ["/gen/", NO_TESTS],
    ["/lib/", NO_TESTS],
    ["/legacy/", "flaky on the old CI, left out by hand"],
    ["/failed/", NOT_SET_UP],
    ["/plugins/*/", NOT_SET_UP],
  ]));
  const hasTests = (path: string) => path === "/lib/";
  const changed = ["api/api.py", "web/web.py", "web/README.md", "later/a.ts", "e2e/login.spec.ts", "ui/app.tsx",
    "tools/release.py", "stack/svc.py", "gen/out.py", "lib/util.py", "legacy/old.py", "failed/x.py",
    "plugins/one/main.py", "extra/new.py", "cmd/main.go"];
  expect(setupParts(f, changed, new Set(["/failed/"]), hasTests)).toEqual({
    files: ["web/web.py", "later/a.ts", "lib/util.py", "legacy/old.py", "plugins/one/main.py", "extra/new.py"],
    parts: ["/web/", "/later/", "/lib/", "/legacy/", "/plugins/*/", "/extra/"],
  });
  // Nothing outside a project: nothing to set up.
  expect(setupParts(f, ["api/api.py", "web/README.md"], new Set(), hasTests)).toEqual({ files: [], parts: [] });
});
