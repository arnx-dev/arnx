// Setup's time limit (`[budget] setup_minutes`): the setting, the agent loop stopping before its next call, Docker
// steps bounded by the time left (and not started with too little), setup's result and events, and the preview.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Runner } from "../src/sandbox";
import { join } from "node:path";
import { runAgent, Workspace } from "../src/agent";
import { setupFailure } from "../src/cli";
import { parseReviewConfig, parseReviewFile } from "../src/config";
import { PRICES } from "../src/llm";
import { ensureEnv, OutOfTime, sandboxOptions, Session, stepTimeout, timeLimit, withTimeLimit } from "../src/sandbox";
import { defaultSettings, loadSettings } from "../src/settings";
import { runSetup, TIME_LEFT_OUT } from "../src/setup";
import { setupPreview } from "../src/setupview";
import { Cli } from "./helpers/cli";
import { FakeSession, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();
const MIN = 60_000;

const config = (budget: string) => {
  const dir = tmp();
  mkdirSync(join(dir, ".arnx"), { recursive: true });
  writeFileSync(join(dir, ".arnx", "config.toml"), `[budget]\n${budget}\n`);
  return dir;
};

test("setup_minutes: 40 by default, any number above 0, anything else refused", () => {
  expect(loadSettings(config("setup_usd = 3.0")).setupMinutes).toBe(40);
  expect(loadSettings(config("setup_minutes = 15")).setupMinutes).toBe(15);
  expect(loadSettings(config("setup_minutes = 2.5")).setupMinutes).toBe(2.5);
  expect(defaultSettings().setupMinutes).toBe(40);
  for (const bad of ["0", "-5"]) {
    expect(() => loadSettings(config(`setup_minutes = ${bad}`))).toThrow("budget.setup_minutes: write a number above 0");
  }
  expect(() => loadSettings(config("setup_minutes = \"soon\""))).toThrow("could not convert");
});

test("the agent loop stops before its next call once the time is up", async () => {
  let ms = 0;
  const model = new ScriptedAgent(Array.from({ length: 5 }, () => [tool("list_dir", { path: "." })]));
  const root = join(tmp(), "repo");
  mkdirSync(root, { recursive: true });
  const ws = new Workspace(root);
  const result = await runAgent(model, { tools: () => ws.tools(), call: async (n, i) => {
    ms += 4 * MIN; // each tool call takes four minutes
    return ws.call(n, i);
  } }, { system: "s", user: "u", budgetUsd: 10, prices: PRICES, deadline: { at: 10 * MIN, now: () => ms } });
  expect(result.stop).toBe("time");
  expect(model.calls).toHaveLength(3); // at 0, 4 and 8 minutes; none at 12
});

test("a Docker step gets the time left when that is less than its own timeout, and none under the floor", async () => {
  let ms = 0;
  const limit = { at: 10 * MIN, now: () => ms, minutes: 10 };
  expect(stepTimeout(1800)).toBe(1800); // no limit
  await withTimeLimit(limit, async () => {
    expect(stepTimeout(1800)).toBe(600);
    expect(stepTimeout(120)).toBe(120);
    ms = 10 * MIN - 61_000;
    expect(stepTimeout(1800)).toBe(61);
    ms = 10 * MIN - 59_000;
    expect(() => stepTimeout(1800)).toThrow(OutOfTime);
    expect(() => stepTimeout(1800)).toThrow("setup reached its 10-minute limit");
  });
  expect(timeLimit.current).toBeNull();
});

test("a run is cut short at the limit, and none starts with too little time left", async () => {
  const fake = join(tmp(), "docker");
  const log = join(tmp(), "docker.log");
  // No image yet; a run or a build takes five seconds.
  writeFileSync(fake, `#!/bin/sh\necho "$1" >> '${log}'\ncase "$1" in image) exit 1;; run|build) exec sleep 5;; esac\n`);
  chmodSync(fake, 0o755);
  const cfg = parseReviewConfig(CFG.replace("workdir: app", "workdir: ."));
  const [docker, buildkit, floor] = [sandboxOptions.docker, sandboxOptions.buildkit, timeLimit.floorSeconds];
  [sandboxOptions.docker, sandboxOptions.buildkit, timeLimit.floorSeconds] = [fake, false, 1];
  try {
    const start = performance.now();
    const limit = { at: start + 2000, now: () => performance.now(), minutes: 1 };
    const r = await withTimeLimit(limit, async () => new Session("img", cfg, tmp()).run("pytest", 1800));
    expect(r.timedOut).toBe(true);
    expect(r.seconds).toBeLessThan(4);
    // The image build too: bounded by the time left.
    const build = { at: performance.now() + 2000, now: () => performance.now(), minutes: 1 };
    await expect(withTimeLimit(build, () => ensureEnv(cfg, tmp(), join(tmp(), "build.log"))))
      .rejects.toThrow(/docker build did not finish in [12]s/);
    // Out of time: no container starts.
    writeFileSync(log, "");
    const spent = { at: performance.now(), now: () => performance.now(), minutes: 1 };
    await expect(withTimeLimit(spent, async () => new Session("img", cfg, tmp()).run("pytest", 1800)))
      .rejects.toThrow(OutOfTime);
    expect(readFileSync(log, "utf8")).toBe("");
  } finally {
    [sandboxOptions.docker, sandboxOptions.buildkit, timeLimit.floorSeconds] = [docker, buildkit, floor];
  }
}, 20_000);

const YAML = `version: 1
image: python:3.12-slim
install: [pip install pytest]
test_command: python -m pytest -q {targets}
`;

const eventsOf = (outDir: string) => {
  const id = readdirSync(outDir).find((n) => existsSync(join(outDir, n, "events.jsonl")))!;
  return readFileSync(join(outDir, id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
};

test("setup stops at its limit: stop \"time\", the last attempt kept, the project it was on named", async () => {
  let ms = 0;
  // Each suite run takes 11 minutes and fails.
  const slow = fakeFactory(() => {
    ms += 11 * MIN;
    return [junitXml([["tests/test_a.py", "test_a", "failed", "boom"]]), "", false];
  });
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("try_project", { yaml: YAML })],
    [text("done")]]);
  const outDir = join(tmp(), ".arnx", "setup");
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir, sessionFactory: slow,
    timeLimit: { at: 10 * MIN, now: () => ms, minutes: 10 } });
  expect(model.calls).toHaveLength(1);
  expect([r.ok, r.stop, r.yamlText]).toEqual([false, "time", YAML]);
  expect(r.running).toBeDefined();
  const events = eventsOf(outDir);
  expect(events[0]).toMatchObject({ type: "setup.started", data: { minutes: 10 } });
  expect(events.at(-1)).toMatchObject({ type: "setup.completed", data: { ok: false, stop: "time" } });
  const failure = setupFailure(r, 3, 10);
  expect(failure.text).toBe(`Setup reached its 10-minute limit while on ${r.running}; to give it longer, raise ` +
    "setup_minutes under [budget].");
  expect(failure.json.kind).toBe("time");
});

test("with too little time left, try_project starts no run: setup stops there", async () => {
  let ms = 0;
  let runs = 0;
  const factory = fakeFactory(() => {
    runs++;
    ms = 10 * MIN - 30_000; // half a minute left: under the floor
    return [junitXml([["tests/test_a.py", "test_a", "failed", "boom"]]), "", false];
  });
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("try_project", { yaml: YAML })],
    [text("done")]]);
  const outDir = join(tmp(), ".arnx", "setup");
  const said: string[] = [];
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir, sessionFactory: factory,
    progress: (m) => said.push(m), timeLimit: { at: 10 * MIN, now: () => ms, minutes: 10 } });
  expect(model.calls).toHaveLength(2); // the second call came in time; its try_project ran nothing
  expect(runs).toBeGreaterThan(0);
  expect(r.stop).toBe("time");
  expect(said).toContain("✗ setup reached its 10-minute limit");
  expect(eventsOf(outDir).filter((e) => e.type === "setup.attempt")).toHaveLength(1);
});

test("with little time left, propose still takes the file its runs proved (it starts no run)", async () => {
  let ms = 0;
  const factory = fakeFactory(() => {
    ms = 10 * MIN - 30_000;
    return [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "", false];
  });
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("propose", { yaml: YAML })],
    [text("done")]]);
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir: join(tmp(), ".arnx", "setup"),
    sessionFactory: factory, timeLimit: { at: 10 * MIN, now: () => ms, minutes: 10 } });
  expect([r.ok, r.stop]).toEqual([true, "end_turn"]);
});

test("a run cut short at the limit, then the agent's last word: setup stops for time", async () => {
  let ms = 0;
  const factory = fakeFactory(() => {
    ms = 10 * MIN - 500;
    return [null, "", true];
  });
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [text("it timed out")]]);
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir: join(tmp(), ".arnx", "setup"),
    sessionFactory: factory, timeLimit: { at: 10 * MIN, now: () => ms, minutes: 10 } });
  expect([r.ok, r.stop]).toEqual([false, "time"]);
});

// --- At the limit, the projects proven by then are kept ----------------------------------------------------------------

const TWO = `version: 1
projects:
  api:
    root: api
    language: python
    image: python:3.12-slim
    install: [pip install pytest]
    test_command: python -m pytest -q {targets}
  web:
    root: web
    language: python
    image: python:3.12-slim
    install: [pip install pytest]
    test_command: python -m pytest -q {targets}
`;

/** Two Python projects, api and web, each with a test. */
function twoProjects(): string {
  const repo = initRepo(join(tmp(), "two"));
  for (const name of ["api", "web"]) {
    mkdirSync(join(repo, name, "tests"), { recursive: true });
    writeFileSync(join(repo, name, `${name}.py`), "def f():\n    return 1\n");
    writeFileSync(join(repo, name, "tests", `test_${name}.py`), "def test_f():\n    assert True\n");
  }
  commit(repo, "two");
  return repo;
}

/** api's suite passes at once; web's runs eleven minutes and fails. */
const apiThenSlowWeb = (clock: { ms: number }) =>
  async <T>(cfg: { name: string }, snap: string, _log: string, body: (r: Runner) => Promise<T>) =>
    body(new FakeSession(snap, () => {
      if (cfg.name === "api") return [junitXml([["api/tests/test_api.py", "test_f", "passed", ""]]), "1 passed", false];
      clock.ms += 11 * MIN;
      return [junitXml([["web/tests/test_web.py", "test_f", "failed", "boom"]]), "1 failed", false];
    }));

test("at the limit with no file accepted, the projects proven so far are kept, the others listed under uncovered",
  async () => {
  const clock = { ms: 0 };
  const repo = twoProjects();
  const model = new ScriptedAgent([[tool("try_project", { yaml: TWO, project: "api" })],
    [tool("try_project", { yaml: TWO, project: "web" })], [text("done")]]);
  const outDir = join(repo, ".arnx", "setup");
  const r = await runSetup(repo, defaultSettings(), model, { outDir, sessionFactory: apiThenSlowWeb(clock),
    timeLimit: { at: 10 * MIN, now: () => clock.ms, minutes: 10 } });
  expect([r.ok, r.stop, r.setAside, r.running]).toEqual([true, "time", ["web"], undefined]);
  const f = parseReviewFile(r.yamlText!);
  expect(f.projects.map((p) => p.name)).toEqual(["api"]);
  expect(f.uncovered).toEqual([{ path: "/web/", reason: TIME_LEFT_OUT }]);
  expect([r.projects.map((p) => p.name), r.runs.map((x) => x.name)]).toEqual([["api"], ["api"]]);
  expect(eventsOf(outDir).at(-1)).toMatchObject({ type: "setup.completed",
    data: { ok: true, stop: "time", projects: ["api"], uncovered_projects: ["web"] } });
});

test("at the limit with nothing proven, setup fails as before", async () => {
  const clock = { ms: 0 };
  const repo = twoProjects();
  const model = new ScriptedAgent([[tool("try_project", { yaml: TWO, project: "web" })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(repo, ".arnx", "setup"),
    sessionFactory: apiThenSlowWeb(clock), timeLimit: { at: 10 * MIN, now: () => clock.ms, minutes: 10 } });
  expect([r.ok, r.stop, r.setAside, r.running]).toEqual([false, "time", undefined, "web"]);
});

test("setup at its limit writes the proven projects, proves them from its own runs and names --add", async () => {
  const clock = { ms: 0 };
  const repo = twoProjects();
  const env = { ANTHROPIC_API_KEY: "a" };
  expect(await new Cli({ cwd: repo, env }).run("init")).toBe(0);
  writeFileSync(join(repo, ".arnx", "config.toml"), readFileSync(join(repo, ".arnx", "config.toml"), "utf8")
    .replace("setup_minutes = 40", "setup_minutes = 10"));
  const script = () => new ScriptedAgent([[tool("try_project", { yaml: TWO, project: "api" })],
    [tool("try_project", { yaml: TWO, project: "web" })], [text("done")]]);
  const proofs: string[] = [];
  const cli = new Cli({ cwd: repo, env, now: () => clock.ms, setupModel: script(),
    setupSessions: apiThenSlowWeb(clock),
    approveSessions: async (cfg, snap, _log, body) => {
      proofs.push(cfg.name);
      return body(new FakeSession(snap, () => [null, "", false]));
    } });
  expect(await cli.run("setup", "--yes", "--json")).toBe(0);
  expect(proofs).toEqual([]); // api's run stands
  const out = JSON.parse(cli.stdout);
  expect([out.result, out.stop, out.approved, out.uncovered_projects, out.next])
    .toEqual(["ok", "time", true, ["web"], ["arnx setup --add"]]);
  expect(out.projects.map((p: { name: string }) => p.name)).toEqual(["api"]);
  expect(cli.stderr).toContain("Setup reached its 10-minute limit: kept api (proven); web is listed under " +
    "uncovered.\nNext: arnx setup --add");
  expect(parseReviewFile(readFileSync(join(repo, ".arnx", "review.yaml"), "utf8")).uncovered)
    .toEqual([{ path: "/web/", reason: TIME_LEFT_OUT }]);
});

test("the preview never promises more than the limit", () => {
  const repo = gitRepo(tmp());
  expect(setupPreview(repo, defaultSettings())).toBe("Setup: finding how to run your tests in Docker (about 2–4 " +
    "min, stops at 40 min or $3.00).");
  expect(setupPreview(repo, { ...defaultSettings(), setupMinutes: 3 })).toBe("Setup: finding how to run your " +
    "tests in Docker (up to 3 min, stops at $3.00).");
});
