// Setup's exec tool: one command in a project's test environment, with a fake container (no Docker).
import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, symlinkSync, utimesSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, type ReviewConfig } from "../src/config";
import { EventLog, withEvents } from "../src/events";
import { dockerSteps, type ExecFactory, type ExecRunner, type RunResult, type SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { clipOutput, EXEC_CALLS, EXEC_MAX_TIMEOUT, EXEC_TIMEOUT, Mirror, SetupExec, type TriedEnv }
  from "../src/setupexec";
import { fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

const YAML = `version: 1
projects:
  app:
    root: .
    image: python:3.12-slim
    install: [pip install pytest]
    test_command: python -m pytest -q {targets}
`;
const cfgOf = () => parseReviewFile(YAML).projects[0]!;

/** A fake container: each command answers from `answer`; what it was started with and ran is kept. */
class FakeBox implements ExecRunner {
  commands: [string, number][] = [];
  /** app.py in /src as each command saw it. */
  seen: (string | null)[] = [];
  closed = false;
  constructor(readonly image: string, readonly cfg: ReviewConfig, readonly src: string,
              readonly answer: (command: string) => Partial<RunResult> = () => ({})) {}
  exec(command: string, timeout: number): RunResult {
    this.commands.push([command, timeout]);
    const app = join(this.src, "app.py");
    this.seen.push(existsSync(app) ? readFileSync(app, "utf8") : null);
    return { exitCode: 0, output: "ok\n", timedOut: false, seconds: 0.4, ...this.answer(command) };
  }
  close(): void {
    this.closed = true;
  }
}

function boxes(answer?: (command: string) => Partial<RunResult>, missing = false) {
  const made: FakeBox[] = [];
  const factory: ExecFactory = async (image, cfg, src) => {
    if (missing) return null;
    const b = new FakeBox(image, cfg, src, answer);
    made.push(b);
    return b;
  };
  return { made, factory };
}

function tool_(o: { tried?: Map<string, TriedEnv>; factory: ExecFactory; snap?: string }) {
  const snap = o.snap ?? join(tmp(), "snap");
  mkdirSync(snap, { recursive: true });
  const said: string[] = [];
  const exec = new SetupExec({ snap, dir: join(tmp(), "exec"), outDir: join(tmp(), "out"), factory: o.factory,
    tried: o.tried ?? new Map([["app", { cfg: cfgOf(), image: "arnx-env:abc", env: "e1" }]]),
    say: (l) => said.push(l) });
  return { exec, said, snap };
}

test("the output the agent gets is its start and its end, with what was left out counted", () => {
  expect(clipOutput("short")).toBe("short");
  const long = "a".repeat(2000) + "b".repeat(5000) + "c".repeat(10_000);
  const got = clipOutput(long);
  expect(got).toBe(`${"a".repeat(2000)}\n[… 5000 characters left out …]\n${"c".repeat(10_000)}`);
});

test("the copy at /src is reset to the snapshot: changes undone, additions removed, unchanged files left alone", () => {
  const from = join(tmp(), "snap");
  const to = join(tmp(), "copy");
  mkdirSync(join(from, "pkg"), { recursive: true });
  writeFileSync(join(from, "pkg", "a.py"), "a = 1\n");
  writeFileSync(join(from, "b.py"), "b = 1\n");
  symlinkSync("pkg/a.py", join(from, "link"));
  mkdirSync(join(from, ".arnx-run"));
  writeFileSync(join(from, ".arnx-run", "suite.xml"), "<x/>");
  const m = new Mirror(from, to);
  m.sync();
  expect(readFileSync(join(to, "pkg", "a.py"), "utf8")).toBe("a = 1\n");
  expect(readlinkSync(join(to, "link"))).toBe("pkg/a.py");
  expect(existsSync(join(to, ".arnx-run"))).toBe(false);
  // A command changes a file, adds files and a folder, and replaces the link.
  const old = new Date(Date.now() - 60_000);
  utimesSync(join(to, "b.py"), old, old);
  const kept = lstatSync(join(to, "b.py")).mtimeMs;
  writeFileSync(join(to, "pkg", "a.py"), "a = 2\n");
  // A command writes well after the copy; the file system's clock may not tick within this test.
  const later = new Date(Date.now() + 5000);
  utimesSync(join(to, "pkg", "a.py"), later, later);
  writeFileSync(join(to, "new.txt"), "x");
  mkdirSync(join(to, "node_modules", "x"), { recursive: true });
  writeFileSync(join(to, "node_modules", "x", "i.js"), "");
  symlinkSync("elsewhere", join(to, "other"));
  m.sync();
  expect(readFileSync(join(to, "pkg", "a.py"), "utf8")).toBe("a = 1\n");
  expect(readdirSync(to).sort()).toEqual(["b.py", "link", "pkg"]);
  // A file left as it was keeps its mtime, so a build kept in the container stays valid.
  expect(lstatSync(join(to, "b.py")).mtimeMs).toBe(kept);
  // A file that differs in content but not in size is copied anew too.
  writeFileSync(join(to, "b.py"), "b = 2\n");
  utimesSync(join(to, "b.py"), later, later);
  m.sync();
  expect(readFileSync(join(to, "b.py"), "utf8")).toBe("b = 1\n");
});

test("exec before any try_project says to call try_project first and starts nothing", async () => {
  const { made, factory } = boxes();
  const { exec } = tool_({ tried: new Map(), factory });
  const r = await exec.call({ project: "app", command: "python --version" });
  expect(r).toContain("no image for app yet");
  expect(r).toContain("Call try_project for it first");
  expect(made).toHaveLength(0);
});

test("an image that is not there (its build failed) is said, and nothing is built", async () => {
  const { factory } = boxes(undefined, true);
  const { exec } = tool_({ factory });
  expect(await exec.call({ project: "app", command: "ls" })).toContain("is not there (its build failed)");
});

test("commands of one environment share one container, closed with the tool; another environment gets its own", async () => {
  const { made, factory } = boxes();
  const tried = new Map([["app", { cfg: cfgOf(), image: "arnx-env:abc", env: "e1" }]]);
  const { exec, said, snap } = tool_({ tried, factory });
  writeFileSync(join(snap, "app.py"), "x = 1\n");
  expect(await exec.call({ project: "app", command: "python --version" })).toBe("exit 0 after 0.4 s\nok");
  await exec.call({ project: "app", command: "ls" });
  expect(made).toHaveLength(1);
  expect(made[0]!.image).toBe("arnx-env:abc");
  expect(made[0]!.seen).toEqual(["x = 1\n", "x = 1\n"]);
  expect(made[0]!.commands).toEqual([["python --version", EXEC_TIMEOUT], ["ls", EXEC_TIMEOUT]]);
  expect(said).toEqual(["app: looking around in its test environment"]);
  // A new try changed the environment: the old container goes, the next command starts a new one.
  tried.set("app", { cfg: cfgOf(), image: "arnx-env:def", env: "e2" });
  await exec.call({ project: "app", command: "ls" });
  expect(made[0]!.closed).toBe(true);
  expect(existsSync(made[0]!.src)).toBe(false);
  expect(made.map((b) => b.image)).toEqual(["arnx-env:abc", "arnx-env:def"]);
  exec.close();
  expect(made[1]!.closed).toBe(true);
});

test("cwd runs the command there; a timeout past the most is capped, and a timed-out command says so", async () => {
  const { made, factory } = boxes((c) => c.includes("sleep") ? { exitCode: null, timedOut: true, output: "" } : {});
  const { exec } = tool_({ factory });
  await exec.call({ project: "app", command: "ls -la", cwd: "sub dir" });
  expect(made[0]!.commands[0]![0]).toBe("cd -- 'sub dir' || exit 1; ls -la");
  const r = await exec.call({ project: "app", command: "sleep 2000", timeout: 5000 });
  expect(made[0]!.commands[1]![1]).toBe(EXEC_MAX_TIMEOUT);
  expect(r).toBe(`timed out after ${EXEC_MAX_TIMEOUT} s; its processes were killed (timeout capped at ` +
    `${EXEC_MAX_TIMEOUT} s)\n(no output)`);
});

test("past the per-setup budget exec refuses and points to try_project", async () => {
  const { made, factory } = boxes();
  const { exec } = tool_({ factory });
  for (let i = 0; i < EXEC_CALLS; i++) await exec.call({ project: "app", command: "true" });
  expect(made[0]!.commands).toHaveLength(EXEC_CALLS);
  expect(await exec.call({ project: "app", command: "true" })).toContain("exec budget spent");
  expect(made[0]!.commands).toHaveLength(EXEC_CALLS);
});

test("each command is a setup.exec event: project, seconds, exit, timed_out and the output's size", async () => {
  const { factory } = boxes((c) => (c === "false" ? { exitCode: 1, output: "no\n" } : {}));
  const { exec } = tool_({ factory });
  const path = join(tmp(), "events.jsonl");
  await withEvents(new EventLog(path, "t"), async () => {
    await exec.call({ project: "app", command: "false" });
    await exec.call({ project: "web", command: "ls" });
  });
  const events = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  expect(events.map((e) => [e.type, e.data])).toEqual([
    ["setup.exec", { n: 1, project: "app", ran: true, secs: 0.4, exit: 1, timed_out: false, bytes: 3 }],
    ["setup.exec", { n: null, project: "web", ran: false, refused: "no-image" }],
  ]);
});

test("exec's container goes while try_project runs, and the next exec starts it again", async () => {
  let open: FakeBox[] = [];
  const { made, factory } = boxes();
  const counting: ExecFactory = async (image, cfg, src) => {
    const b = await factory(image, cfg, src);
    open = made.filter((x) => !x.closed);
    return b;
  };
  const during: number[] = [];
  const runs = fakeFactory(() => {
    during.push(made.filter((x) => !x.closed).length);
    return [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false];
  });
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML, project: "app" })],
    [tool("exec", { project: "app", command: "ls" })],
    [tool("try_project", { yaml: YAML.replace("-q {targets}", "-q -x {targets}"), project: "app" })],
    [tool("exec", { project: "app", command: "ls" })], [text("done")]]);
  await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir: join(tmp(), "s"), sessionFactory: runs,
    execFactory: counting });
  expect(made).toHaveLength(2);
  expect(made[0]!.closed).toBe(true);
  expect(open).toHaveLength(1);
  // No exec container is up during any suite run.
  expect(during.length).toBeGreaterThan(0);
  expect(during.every((n) => n === 0)).toBe(true);
});

test("exec runs in the image the try's run used: one rebuilt for the code is named by its image step", async () => {
  const { made, factory } = boxes();
  const inner = fakeFactory(() => [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false]);
  const rebuilt: SessionFactory = (cfg, snap, log, body, ...rest) => {
    dockerSteps.log?.({ step: "image", project: cfg.name, tag: "arnx-env:abc", built: false });
    dockerSteps.log?.({ step: "image", project: cfg.name, tag: "arnx-env:abc-src-0123", built: true, ok: true });
    dockerSteps.log?.({ step: "image", project: "other", tag: "arnx-env:zzz", built: true, ok: true });
    return inner(cfg, snap, log, body, ...rest);
  };
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML, project: "app" })],
    [tool("exec", { project: "app", command: "ls" })], [text("done")]]);
  await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir: join(tmp(), "s"), sessionFactory: rebuilt,
    execFactory: factory });
  expect(made.map((b) => b.image)).toEqual(["arnx-env:abc-src-0123"]);
});

test("setup offers exec; it runs in the image the project's last try_project used, and goes at the end", async () => {
  const passing = (): [string | null, string, boolean] =>
    [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false];
  const model = new ScriptedAgent([[tool("exec", { project: "app", command: "python --version" })],
    [tool("try_project", { yaml: YAML, project: "app" })],
    [tool("exec", { project: "app", command: "python --version" })], [tool("propose", { yaml: YAML })],
    [text("done")]]);
  const { made, factory } = boxes((c) => ({ output: `${c}: Python 3.12.1\n` }));
  const outDir = join(tmp(), ".arnx", "setup");
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir, sessionFactory: fakeFactory(passing),
    execFactory: factory });
  expect(r.ok).toBe(true);
  expect(model.calls[0]!.tools).toContain("exec");
  const result = (call: number) =>
    String((model.calls[call]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content);
  expect(result(1)).toContain("Call try_project for it first");
  expect(result(3)).toBe("exit 0 after 0.4 s\npython --version: Python 3.12.1");
  expect(made).toHaveLength(1);
  expect(made[0]!.image).toMatch(/^arnx-env:[0-9a-f]{16}$/);
  expect(made[0]!.cfg.name).toBe("app");
  expect(made[0]!.seen[0]).toContain("def add");
  expect(made[0]!.closed).toBe(true);
  expect(readFileSync(join(outDir, "exec-1.log"), "utf8")).toBe("$ python --version\npython --version: Python 3.12.1\n");
});
