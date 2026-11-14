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
import { DiskFull, diskFullMessage, ensureEnv, OutOfTime, sandboxOptions, Session, stepTimeout, timeLimit, withTimeLimit } from "../src/sandbox";
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

test("at the limit, a project proven earlier keeps its proven block when a later try changed it", async () => {
  const clock = { ms: 0 };
  const repo = twoProjects();
  const changed = TWO.replace("    root: api\n", "    root: api\n    uses: [web/web.py]\n");
  expect(changed).not.toBe(TWO);
  const model = new ScriptedAgent([[tool("try_project", { yaml: TWO, project: "api" })],
    [tool("try_project", { yaml: changed, project: "web" })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(repo, ".arnx", "setup"),
    sessionFactory: apiThenSlowWeb(clock), timeLimit: { at: 10 * MIN, now: () => clock.ms, minutes: 10 } });
  expect([r.ok, r.stop, r.setAside]).toEqual([true, "time", ["web"]]);
  const f = parseReviewFile(r.yamlText!);
  expect(f.projects.map((p) => [p.name, p.uses])).toEqual([["api", []]]);
  expect(f.uncovered).toEqual([{ path: "/web/", reason: TIME_LEFT_OUT }]);
});

/** api and lib pass at once; web's suite runs eleven minutes and fails. */
const apiLibThenSlowWeb = (clock: { ms: number }) =>
  async <T>(cfg: { name: string }, snap: string, _log: string, body: (r: Runner) => Promise<T>) =>
    body(new FakeSession(snap, () => {
      if (cfg.name === "web") {
        clock.ms += 11 * MIN;
        return [junitXml([["web/tests/test_web.py", "test_f", "failed", "boom"]]), "1 failed", false];
      }
      const dir = cfg.name === "lib" ? "lib" : "api";
      return [junitXml([[`${dir}/tests/test_${dir}.py`, "test_f", "passed", ""]]), "1 passed", false];
    }));

/** The last file changes api's block so that it overlaps another project; lib passed too. */
async function overlapAtLimit(last: (three: string) => string) {
  const clock = { ms: 0 };
  const repo = initRepo(join(tmp(), "three"));
  for (const name of ["api", "lib", "web"]) {
    mkdirSync(join(repo, name, "tests"), { recursive: true });
    writeFileSync(join(repo, name, `${name}.py`), "def f():\n    return 1\n");
    writeFileSync(join(repo, name, "tests", `test_${name}.py`), "def test_f():\n    assert True\n");
  }
  commit(repo, "three");
  const three = TWO + TWO.slice(TWO.indexOf("  api:"), TWO.indexOf("  web:")).replace("api", "lib").replace("root: api", "root: lib");
  const model = new ScriptedAgent([[tool("try_project", { yaml: three, project: "api" })],
    [tool("try_project", { yaml: three, project: "lib" })], [tool("try_project", { yaml: last(three), project: "web" })],
    [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(repo, ".arnx", "setup"),
    sessionFactory: apiLibThenSlowWeb(clock), timeLimit: { at: 10 * MIN, now: () => clock.ms, minutes: 10 } });
  return { r, f: parseReviewFile(r.yamlText!) };
}

test("at the limit, a proven block that overlaps a project in the last file gives way", async () => {
  // The last file gives api's folder to another project: api is not in it, and its proven block would overlap.
  const { r, f } = await overlapAtLimit((t) => t.replace("  api:\n    root: api\n", "  core:\n    root: api\n"));
  expect([r.ok, r.stop]).toEqual([true, "time"]);
  expect(f.projects.map((p) => p.name)).toEqual(["lib"]);
  expect([...r.setAside!].sort()).toEqual(["core", "web"]);
});

test("at the limit, a proven project whose changed block overlaps another gives way to the file", async () => {
  // api is in the last file with a changed block, and web's root moved onto api's folder: putting api's proven block
  // back would overlap web, so the file's api stays.
  const { r, f } = await overlapAtLimit((t) => t.replace("    root: api\n", "    root: api\n    uses: [lib/lib.py]\n")
    .replace("    root: web\n", "    root: api\n"));
  expect([r.ok, r.stop]).toEqual([true, "time"]);
  expect(f.projects.map((p) => p.name)).toEqual(["lib"]);
  expect([...r.setAside!].sort()).toEqual(["api", "web"]);
});

test("at the limit, a held try and a project proven after it are both kept: the file that keeps the most is taken",
  async () => {
  // web alone is tried first: it runs, but test_command leaves most of its tests out, so it goes back to the agent.
  // Then a file of both projects: api is proven, and web's changed try runs into the limit. The last file keeps only
  // api; the held try's file, with api put back as proven, keeps both.
  const clock = { ms: 0 };
  const repo = initRepo(join(tmp(), "two-held"));
  for (const name of ["api", "web"]) {
    mkdirSync(join(repo, name, "tests"), { recursive: true });
    writeFileSync(join(repo, name, `${name}.py`), "def f():\n    return 1\n");
    writeFileSync(join(repo, name, "tests", `test_${name}.py`), "def test_f():\n    assert True\n");
  }
  mkdirSync(join(repo, "web", "tests", "slow"), { recursive: true });
  for (let i = 0; i < 25; i++) writeFileSync(join(repo, "web", "tests", "slow", `test_s${i}.py`), "def test_s():\n    pass\n");
  commit(repo, "two");
  const block = (name: string, image = "python:3.12-slim", only = "") => `  ${name}:
    root: ${name}
    language: python
    image: ${image}
    install: [pip install pytest]
    test_command: python -m pytest -q ${only}{targets}
`;
  const held = `version: 1\nprojects:\n${block("web", undefined, "tests/test_web.py ")}`;
  const both = `version: 1\nprojects:\n${block("api")}${block("web", "python:3.13-slim")}`;
  const factory = async <T>(cfg: { name: string; image: string }, snap: string, _log: string,
    body: (r: Runner) => Promise<T>) => {
    if (cfg.image === "python:3.13-slim") {
      clock.ms = 10 * MIN + 1;
      throw new OutOfTime(10);
    }
    clock.ms += MIN;
    return body(new FakeSession(snap, () =>
      [junitXml([[`${cfg.name}/tests/test_${cfg.name}.py`, "test_f", "passed", ""]]), "1 passed", false]));
  };
  const model = new ScriptedAgent([[tool("try_project", { yaml: held, project: "web" })],
    [tool("try_project", { yaml: both, project: "api" })], [tool("try_project", { yaml: both, project: "web" })],
    [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(repo, ".arnx", "setup"),
    sessionFactory: factory, timeLimit: { at: 10 * MIN, now: () => clock.ms, minutes: 10 } });
  const first = String((model.calls[1]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content);
  expect(first).toContain("never ran");
  expect([r.ok, r.stop, r.setAside]).toEqual([true, "time", []]);
  const f = parseReviewFile(r.yamlText!);
  expect(f.projects.map((p) => [p.name, p.image]).sort()).toEqual([["api", "python:3.12-slim"],
    ["web", "python:3.12-slim"]]);
  expect(r.projects.find((p) => p.name === "web")!.gap).toContain("never ran");
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

test("a first review's quick setup stops at 10 minutes, whatever setup_minutes says, and points to arnx setup",
  async () => {
  const clock = { ms: 0 };
  const repo = twoProjects();
  const env = { ANTHROPIC_API_KEY: "a" };
  writeFileSync(join(repo, "api", "pyproject.toml"), "[project]\nname = \"api\"\nversion = \"0.1\"\n");
  expect(await new Cli({ cwd: repo, env }).run("init")).toBe(0);
  commit(repo, "init");
  writeFileSync(join(repo, "api", "api.py"), "def f():\n    return 2\n");
  commit(repo, "api change");
  const slow = async <T>(_cfg: { name: string }, snap: string, _log: string, body: (r: Runner) => Promise<T>) =>
    body(new FakeSession(snap, () => {
      clock.ms += 11 * MIN;
      return [null, "", true];
    }));
  const cli = new Cli({ cwd: repo, env, now: () => clock.ms, setupModel: new ScriptedAgent([[text("done")]]),
    setupSessions: slow });
  expect(await cli.run("consent", "--yes")).toBe(0);
  expect(await cli.run("review")).toBe(2);
  expect(cli.stdout).toContain("stops at 10 min).");
  expect(cli.stdout).toContain("Could not set this up within 10 min while on api; `arnx setup` takes longer");
  expect(cli.stdout.trimEnd()).toEndWith("Next: arnx setup");
});

test("setup stopped by a refused key says so, not that the environment does not work", () => {
  const r = { ok: false, stop: "api_error: claude-sonnet-5-5: HTTP 401: 401 {\"error\":\"invalid x-api-key\"} (1 attempts)",
    problem: "", summary: "sync-server: the suite ran no tests", yamlText: "version: 1\n", failing: [] } as never;
  const failure = setupFailure(r, 3, 40);
  expect(failure.text).toBe("Setup stopped: the model provider refused the key (HTTP 401, claude-sonnet-5-5). " +
    "Check the key, then run again.");
  expect(failure.json.reason).toStartWith("setup's model call failed: claude-sonnet-5-5: HTTP 401");
});

test("a run that passes at the limit is kept, its doubt said", async () => {
  const repo = initRepo(join(tmp(), "late"));
  mkdirSync(join(repo, "tests", "slow"), { recursive: true });
  for (let i = 0; i < 25; i++) writeFileSync(join(repo, "tests", "slow", `test_s${i}.py`), "def test_s():\n    pass\n");
  writeFileSync(join(repo, "tests", "test_fast.py"), "def test_f():\n    pass\n");
  commit(repo, "tests");
  const narrow = TWO.split("  web:")[0]!.replace("root: api", "root: .").replace("{targets}", "tests/test_fast.py {targets}");
  let ms = 0;
  const factory = fakeFactory(() => {
    ms = 10 * MIN + 1; // the run ends at the limit
    return [junitXml([["tests/test_fast.py", "test_f", "passed", ""]]), "", false];
  });
  const model = new ScriptedAgent([[tool("try_project", { yaml: narrow })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "s"), sessionFactory: factory,
    timeLimit: { at: 10 * MIN, now: () => ms, minutes: 10 } });
  // The doubt is not sent back to the agent (no time to answer it): the project is proven and the doubt is kept.
  expect(r.ok).toBe(true);
  expect(r.projects.map((p) => p.name)).toEqual(["api"]);
  expect(r.projects[0]!.gap).toBe("25 of 26 files that look like tests never ran (tests/slow 25)");
  expect(r.yamlText).toContain("test_command");
});

test("a project proven earlier survives the time limit when the last file leaves it out", async () => {
  const clock = { ms: 0 };
  const repo = twoProjects();
  const webOnly = `version: 1
projects:
  web:
    root: web
    language: python
    image: python:3.12-slim
    install: [pip install pytest]
    test_command: python -m pytest -q {targets}
uncovered:
  - {path: /api/, reason: "not needed"}
`;
  const model = new ScriptedAgent([[tool("try_project", { yaml: TWO, project: "api" })],
    [tool("try_project", { yaml: webOnly, project: "web" })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(repo, ".arnx", "setup"),
    sessionFactory: apiThenSlowWeb(clock), timeLimit: { at: 10 * MIN, now: () => clock.ms, minutes: 10 } });
  expect([r.ok, r.stop, r.setAside]).toEqual([true, "time", ["web"]]);
  const f = parseReviewFile(r.yamlText!);
  expect(f.projects.map((p) => p.name)).toEqual(["api"]);
  expect(f.uncovered).toEqual([{ path: "/web/", reason: TIME_LEFT_OUT }]);
});

const fastExceptWeb = (clock: { ms: number }) =>
  async <T>(cfg: { name: string }, snap: string, _log: string, body: (r: Runner) => Promise<T>) =>
    body(new FakeSession(snap, () => {
      if (cfg.name !== "web") return [junitXml([["api/tests/test_api.py", "test_f", "passed", ""]]), "1 passed", false];
      clock.ms += 11 * MIN;
      return [junitXml([["web/tests/test_web.py", "test_f", "failed", "boom"]]), "1 failed", false];
    }));

test("at the limit, a proven project that overlaps the last file's projects is not put back: the file is still accepted", async () => {
  const clock = { ms: 0 };
  const repo = twoProjects();
  mkdirSync(join(repo, "api", "lib"), { recursive: true });
  writeFileSync(join(repo, "api", "lib", "lib.py"), "X = 1\n");
  commit(repo, "lib");
  const second = `version: 1
projects:
  lib:
    root: api/lib
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
  const model = new ScriptedAgent([[tool("try_project", { yaml: TWO, project: "api" })],
    [tool("try_project", { yaml: second, project: "lib" })], [tool("try_project", { yaml: second, project: "web" })],
    [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(repo, ".arnx", "setup"),
    sessionFactory: fastExceptWeb(clock), timeLimit: { at: 10 * MIN, now: () => clock.ms, minutes: 10 } });
  expect([r.ok, r.stop]).toEqual([true, "time"]);
  expect(parseReviewFile(r.yamlText!).projects.map((p) => p.name)).toEqual(["lib"]);
});

test("a full Docker disk ends setup at once: no further tries, no more model calls", async () => {
  const repo = twoProjects();
  let builds = 0;
  const factory = async <T>(_cfg: { name: string }, _snap: string, _log: string, _body: (r: Runner) => Promise<T>) => {
    builds++;
    throw new DiskFull();
  };
  const model = new ScriptedAgent([[tool("try_project", { yaml: TWO, project: "api" })],
    [tool("try_project", { yaml: TWO, project: "web" })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(repo, ".arnx", "setup"), sessionFactory: factory });
  expect([r.ok, r.stop, builds, model.calls.length]).toEqual([false, "disk-full", 1, 1]);
  expect(r.problem).toBe(diskFullMessage());
  expect(setupFailure(r, 3, 40).text).toBe(diskFullMessage());
});

test("a full disk in the middle of a suite run ends setup the same way", async () => {
  const repo = twoProjects();
  const factory = async <T>(_cfg: { name: string }, snap: string, _log: string, body: (r: Runner) => Promise<T>) =>
    body(new FakeSession(snap, (command) => {
      if (!command.includes("test_arnx_probe")) throw new DiskFull();
      return [null, "", false];
    }));
  const model = new ScriptedAgent([[tool("try_project", { yaml: TWO, project: "api" })],
    [tool("try_project", { yaml: TWO, project: "web" })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(repo, ".arnx", "setup"), sessionFactory: factory });
  expect([r.ok, r.stop, model.calls.length]).toEqual([false, "disk-full", 1]);
  expect(r.problem).toBe(diskFullMessage());
});

test("a full disk met by the agent's exec tool ends setup: no further model call", async () => {
  const repo = twoProjects();
  const pass = fakeFactory(() => [junitXml([["api/tests/test_api.py", "test_f", "passed", ""]]), "1 passed", false]);
  const model = new ScriptedAgent([[tool("try_project", { yaml: TWO, project: "api" })],
    [tool("exec", { project: "api", command: "ls" })], [tool("exec", { project: "api", command: "ls" })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(repo, ".arnx", "setup"), sessionFactory: pass,
    execFactory: async () => {
      throw new DiskFull();
    } });
  expect([r.ok, r.stop, model.calls.length]).toEqual([false, "disk-full", 2]);
});

test("arnx setup --json after a full disk: environment failure naming the disk, nothing to run next", async () => {
  const repo = twoProjects();
  const env = { ANTHROPIC_API_KEY: "a" };
  expect(await new Cli({ cwd: repo, env }).run("init")).toBe(0);
  const cli = new Cli({ cwd: repo, env,
    setupModel: new ScriptedAgent([[tool("try_project", { yaml: TWO, project: "api" })], [text("done")]]),
    setupSessions: async () => {
      throw new DiskFull();
    } });
  expect(await cli.run("setup", "--yes", "--json")).toBe(2);
  const out = JSON.parse(cli.stdout);
  expect(out.failure).toMatchObject({ kind: "environment" });
  expect(out.failure.reason).toContain("Docker is out of disk space");
  expect(out.next).toEqual([]);
  expect(out.stop).toBe("disk-full");
});
