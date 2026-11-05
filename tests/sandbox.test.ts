import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { python } from "../src/adapters/python";
import { parseReviewConfig, parseReviewFile } from "../src/config";
import { ArnxError, SetupRequired } from "../src/errors";
import {
  buildContextOf, cleanupLiveSessions, DEFAULT_LIMITS, dockerfile, ensureEnv, envKey, requireDocker, runArgv,
  sandboxOptions, Session,
  dockerSteps, keptBox, NETWORK_OPEN, networkNotice, networkRetry,
} from "../src/sandbox";
import { withSandboxFiles } from "../src/change";
import { probeRun } from "../src/testround";
import { runTypecheck } from "../src/typecheck";
import { sleep } from "../src/util";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();

async function withDockerAsync<T>(path: string, body: () => Promise<T>): Promise<T> {
  const saved = sandboxOptions.docker;
  sandboxOptions.docker = path;
  try {
    return await body();
  } finally {
    sandboxOptions.docker = saved;
  }
}

function withDocker<T>(path: string, body: () => T): T {
  const saved = sandboxOptions.docker;
  sandboxOptions.docker = path;
  try {
    return body();
  } finally {
    sandboxOptions.docker = saved;
  }
}

test("test_dockerfile", () => {
  const text = dockerfile(parseReviewConfig(CFG));
  expect(text.split("\n")[0]).toBe("FROM python:3.12-slim");
  for (const part of ["COPY . /src", "WORKDIR /src/app", "RUN pip install pytest"]) expect(text).toContain(part);
});

test("on BuildKit every install step shares the language's download cache, kept out of the image", () => {
  const text = dockerfile(parseReviewConfig(CFG), { cache: true });
  expect(text).toContain("RUN --mount=type=cache,id=arnx-python,target=/arnx-cache,mode=0777 pip install pytest");
  expect(text).toContain("ARG PIP_CACHE_DIR=/arnx-cache/pip");
  expect(text).not.toContain("PIP_NO_CACHE_DIR");
  const node = dockerfile(parseReviewConfig(CFG.replace("image: python:3.12-slim", "image: node:22\nlanguage: typescript")
    .replace("pip install pytest", "npm ci").replace("python -m pytest -q {targets}", "npx vitest run {targets}")),
  { cache: true });
  expect(node).toContain("RUN --mount=type=cache,id=arnx-typescript,target=/arnx-cache,mode=0777 npm ci");
  expect(node).toContain("ARG npm_config_cache=/arnx-cache/npm");
});

test("without BuildKit the Dockerfile is the one before the cache: no mount, pip keeps no cache", () => {
  const text = dockerfile(parseReviewConfig(CFG));
  expect(text).not.toContain("--mount");
  expect(text).not.toContain("ARG ");
  expect(text).toContain("PIP_NO_CACHE_DIR=1");
});

test("ensureEnv builds with the cache mount only when Docker has BuildKit", async () => {
  const fake = join(tmp(), "docker");
  const stdin = join(tmp(), "stdin");
  // image inspect fails (no image yet); build saves the Dockerfile it was given.
  writeFileSync(fake, `#!/bin/sh\ncase "$1" in image) exit 1;; build) cat > '${stdin}';; esac\nexit 0\n`);
  chmodSync(fake, 0o755);
  const cfg = parseReviewConfig(CFG);
  const saved = sandboxOptions.buildkit;
  try {
    for (const bk of [true, false]) {
      sandboxOptions.buildkit = bk;
      await withDockerAsync(fake, () => ensureEnv(cfg, tmp(), join(tmp(), "build.log")));
      expect(readFileSync(stdin, "utf8").includes("--mount=type=cache")).toBe(bk);
    }
  } finally {
    sandboxOptions.buildkit = saved;
  }
});

test("the image is built from the build context", async () => {
  const fake = join(tmp(), "docker");
  const args = join(tmp(), "args");
  writeFileSync(fake, `#!/bin/sh\ncase "$1" in image) exit 1;; build) printf '%s\\n' "$@" > '${args}'; cat > /dev/null;; esac\nexit 0\n`);
  chmodSync(fake, 0o755);
  const snap = join(tmp(), "snap");
  mkdirSync(snap);
  writeFileSync(join(snap, "a.py"), "real");
  // With no build context of its own, the snapshot is the context: it holds no guess.
  const saved = sandboxOptions.buildkit;
  sandboxOptions.buildkit = false;
  try {
    await withDockerAsync(fake, () => ensureEnv(parseReviewConfig(CFG), snap, join(tmp(), "build.log")));
    expect(readFileSync(args, "utf8").trim().split("\n").at(-1)).toBe(snap);
    mkdirSync(`${snap}.build`);
    expect(buildContextOf(snap)).toBe(`${snap}.build`);
    await withDockerAsync(fake, () => ensureEnv(parseReviewConfig(CFG), snap, join(tmp(), "build.log")));
    expect(readFileSync(args, "utf8").trim().split("\n").at(-1)).toBe(`${snap}.build`);
  } finally {
    sandboxOptions.buildkit = saved;
  }
});

test("a build that keeps its output: the code that differs from what was built is newer than the build", async () => {
  const fake = join(tmp(), "docker");
  writeFileSync(fake, `#!/bin/sh\ncase "$1" in image) exit 1;; build) cat > /dev/null;; esac\nexit 0\n`);
  chmodSync(fake, 0o755);
  const snap = join(tmp(), "snap");
  mkdirSync(snap);
  mkdirSync(`${snap}.build`);
  const old = new Date(Date.now() - 3_600_000);
  for (const name of ["guess.rs", "same.rs"]) writeFileSync(join(snap, name), "real");
  writeFileSync(join(`${snap}.build`, "guess.rs"), "stand-in");
  linkSync(join(snap, "same.rs"), join(`${snap}.build`, "same.rs"));
  for (const name of ["guess.rs", "same.rs"]) utimesSync(join(snap, name), old, old);
  const saved = sandboxOptions.buildkit;
  sandboxOptions.buildkit = false;
  const mtime = (n: string) => statSync(join(snap, n)).mtimeMs;
  try {
    const rust = parseReviewConfig("version: 1\nimage: rust:1\nlanguage: rust\ntest_command: cargo nextest run {targets}\n");
    const python = parseReviewConfig(CFG);
    await withDockerAsync(fake, () => ensureEnv(python, snap, join(tmp(), "build.log")));
    expect(mtime("guess.rs")).toBe(old.getTime());
    await withDockerAsync(fake, () => ensureEnv(rust, snap, join(tmp(), "build.log")));
    expect(mtime("guess.rs")).toBeGreaterThan(old.getTime());
    expect(mtime("same.rs")).toBe(old.getTime());
  } finally {
    sandboxOptions.buildkit = saved;
  }
});

test("test_env_key_follows_manifests_not_notes", () => {
  mkdirSync(join(tmp(), "app"));
  writeFileSync(join(tmp(), "app", "requirements.txt"), "a\n");
  const cfg = parseReviewConfig(CFG);
  const key = envKey(cfg, tmp());
  expect(envKey(parseReviewConfig(CFG + "notes: [x]\n"), tmp())).toBe(key);
  writeFileSync(join(tmp(), "app", "requirements.txt"), "b\n");
  expect(envKey(cfg, tmp())).not.toBe(key);
});

test("test_run_argv_is_locked_down", () => {
  const argv = runArgv({ image: "img", name: "n", network: "none", snapshot: tmp(), workdir: "app",
    env: { MODE: "test" }, command: "pytest -q", limits: DEFAULT_LIMITS, user: "1000:1000", runEnv: [] });
  const joined = argv.join(" ");
  for (const part of ["--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 512",
    "--memory 4g", "--memory-swap 4g", "--user 1000:1000", "-w /src/app", "-e MODE=test", `-v ${tmp()}:/src`]) {
    expect(joined).toContain(part);
  }
  expect(argv.slice(-4)).toEqual(["img", "sh", "-c", "pytest -q"]);
  expect(argv.some((a) => a.startsWith("--env-file"))).toBe(false);
});

test("test_pytest_command", () => {
  const cmd = python.command(parseReviewConfig(CFG).testCommand, ["tests/x y.py"], "/src/.arnx-run/final-1.xml", "pytest");
  expect(cmd.startsWith("python -m pytest -q 'tests/x y.py' ")).toBe(true);
  expect(cmd).toContain("--junitxml=/src/.arnx-run/final-1.xml");
  expect(cmd).toContain("junit_family=xunit1");
  expect(cmd).toContain("--continue-on-collection-errors");
});

test("test_no_docker_binary", () => {
  withDocker("/nonexistent/docker", () => {
    expect(() => requireDocker()).toThrow(SetupRequired);
    expect(() => requireDocker()).toThrow(/Docker is not installed/);
  });
});

test("test_docker_not_running", () => {
  const fake = join(tmp(), "docker");
  writeFileSync(fake, "#!/bin/sh\necho 'Cannot connect' >&2\nexit 1\n");
  chmodSync(fake, 0o755);
  withDocker(fake, () => expect(() => requireDocker()).toThrow(/start it/));
});

test("Docker refusing its socket is told apart from Docker not running: a coding agent's sandbox", () => {
  const fake = join(tmp(), "docker");
  writeFileSync(fake, "#!/bin/sh\necho 'permission denied while trying to connect to the Docker daemon socket at " +
    "unix:///var/run/docker.sock' >&2\nexit 1\n");
  chmodSync(fake, 0o755);
  withDocker(fake, () => expect(() => requireDocker()).toThrow("Docker is not reachable (permission denied on its " +
    "socket): if a coding agent ran arnx in its sandbox, run this command in your own terminal"));
  writeFileSync(fake, "#!/bin/sh\necho 'context deadline exceeded' >&2\nexit 1\n");
  withDocker(fake, () => expect(() => requireDocker()).toThrow("Docker is not answering: context deadline exceeded"));
});

test("cleanupLiveSessions removes registered sessions", async () => {
  const fake = join(tmp(), "docker");
  const log = join(tmp(), "log");
  writeFileSync(fake, `#!/bin/sh\necho "$*" >> '${log}'\n`);
  chmodSync(fake, 0o755);
  const cfg = parseReviewConfig(CFG + "services:\n  db: {image: postgres:16-alpine}\n");
  const saved = sandboxOptions.docker;
  sandboxOptions.docker = fake;
  try {
    const s = await new Session("img", cfg, tmp()).start();
    cleanupLiveSessions();
    cleanupLiveSessions();
    const lines = readFileSync(log, "utf8").trim().split("\n");
    expect(lines.filter((l) => l === `rm -fv arnx-${s.id}-db`)).toHaveLength(1);
    expect(lines.filter((l) => l === `network rm ${s.network}`)).toHaveLength(1);
  } finally {
    sandboxOptions.docker = saved;
  }
});

// ---- Docker integration: real containers. Run with ARNX_DOCKER_TESTS=1. ----

const SVC = `
version: 1
image: python:3.12-slim
install: []
test_command: python -m pytest -q {targets}
services:
  db:
    image: postgres:16-alpine
    env: {POSTGRES_HOST_AUTH_METHOD: trust}
    ready: pg_isready -U postgres
env: {MODE: test}
`;

describe.skipIf(!process.env.ARNX_DOCKER_TESTS)("docker", () => {
  const snap = () => {
    const d = join(tmp(), "snap");
    if (!existsSync(d)) {
      mkdirSync(d);
      writeFileSync(join(d, "probe.py"), "print('hello')\n");
    }
    return d;
  };

  test("test_env_and_network_and_limits", async () => {
    process.env.ARNX_SENTINEL = "leak";
    try {
      const cfg = parseReviewConfig(CFG.replace("workdir: app", "workdir: ."));
      const image = await ensureEnv(cfg, snap(), join(tmp(), "build.log"));
      const s = await new Session(image, cfg, snap()).start();
      try {
        const env = (await s.run("env", 60)).output;
        expect(env).toContain("MODE=test");
        expect(env).not.toContain("ARNX_SENTINEL");
        expect(env).not.toContain("ANTHROPIC_API_KEY");
        expect((await s.run("python -c \"import socket; socket.create_connection(('1.1.1.1', 53), 3)\"", 60)).exitCode)
          .not.toBe(0);
        expect((await s.run("cat /sys/fs/cgroup/pids.max", 30)).output.trim()).toBe("512");
        expect((await s.run("python probe.py", 30)).output.trim()).toBe("hello");
      } finally {
        s.close();
      }
    } finally {
      delete process.env.ARNX_SENTINEL;
    }
  }, 600_000);

  test("test_timeout_kills_the_container", async () => {
    const cfg = parseReviewConfig(CFG.replace("workdir: app", "workdir: ."));
    const image = await ensureEnv(cfg, snap(), join(tmp(), "build.log"));
    const s = await new Session(image, cfg, snap()).start();
    let r;
    try {
      r = await s.run("sleep 600", 5);
    } finally {
      s.close();
    }
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.seconds).toBeLessThan(60);
  }, 600_000);

  test("Ctrl-C during a run removes the container: a real one, and nothing of it is left", async () => {
    const repoRoot = join(import.meta.dir, "..");
    const script = join(tmp(), "interrupted.ts");
    const source = snap();
    // An arnx in a run, with the handling main.ts gives a signal.
    writeFileSync(script, `
import { parseReviewConfig } from ${JSON.stringify(join(repoRoot, "src/config"))};
import { startInterrupt } from ${JSON.stringify(join(repoRoot, "src/interrupt"))};
import { Session } from ${JSON.stringify(join(repoRoot, "src/sandbox"))};
process.on("SIGINT", () => void startInterrupt("SIGINT"));
const cfg = parseReviewConfig(${JSON.stringify(CFG.replace("workdir: app", "workdir: ."))});
const s = await new Session("python:3.12-slim", cfg, ${JSON.stringify(source)}).start();
console.log(s.id);
await s.run("echo started; sleep 300", 600);
console.log("the run answered");
`);
    const names = (id: string) => spawnSync("docker", ["ps", "-a", "--filter", `name=arnx-${id}-`, "--format", "{{.Names}}"],
      { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean);
    const child = spawn("bun", [script], { stdio: ["ignore", "pipe", "pipe"] });
    let said = "", id = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => { said += d; });
    const exited = new Promise<number | null>((r) => child.on("exit", (code) => r(code)));
    try {
      const until = Date.now() + 120_000;
      while (Date.now() < until) {
        id ||= said.split("\n")[0]!.trim();
        if (id && said.includes("\n") && names(id).length) break;
        await sleep(100);
      }
      expect(names(id)).toHaveLength(1);
      const t0 = Date.now();
      child.kill("SIGINT");
      expect(await exited).toBe(130);
      expect(Date.now() - t0).toBeLessThan(30_000);
      expect(said).not.toContain("the run answered");
      expect(names(id)).toEqual([]);
    } finally {
      child.kill("SIGKILL");
      // Only if the test failed: this run's own container, by its name.
      if (id) for (const n of names(id)) spawnSync("docker", ["rm", "-fv", n]);
    }
  }, 300_000);

  /** arnx itself (main.ts) running `args`, in a folder with no repository, after `preload` has set up what it says. No
   * keys reach it. Answers with its exit code, what it printed, and the sessions it named with `session <id>`. */
  const arnxAfter = async (preload: string, args: string[]) => {
    const repoRoot = join(import.meta.dir, "..");
    const dir = join(tmp(), `arnx-${Math.random().toString(16).slice(2)}`);
    mkdirSync(dir);
    const file = join(dir, "preload.ts");
    const source = snap();
    writeFileSync(file, `
import { spawnSync } from "node:child_process";
import { closers } from ${JSON.stringify(join(repoRoot, "src/interrupt"))};
import { inPool } from ${JSON.stringify(join(repoRoot, "src/challenge"))};
import { parseReviewConfig } from ${JSON.stringify(join(repoRoot, "src/config"))};
import { Session } from ${JSON.stringify(join(repoRoot, "src/sandbox"))};
const cfg = parseReviewConfig(${JSON.stringify(CFG.replace("workdir: app", "workdir: ."))});
const open = async () => {
  const s = await new Session("python:3.12-slim", cfg, ${JSON.stringify(source)}).start();
  console.log("session " + s.id);
  void s.run("sleep 120", 600);
  const up = () => spawnSync("docker", ["ps", "-q", "--filter", "name=arnx-" + s.id + "-"], { encoding: "utf8" }).stdout.trim();
  for (let i = 0; i < 300 && !up(); i++) await new Promise((r) => setTimeout(r, 100));
  console.log(up() ? "container up" : "container never came up");
};
void [closers, inPool, open];
${preload}
`);
    const child = spawn(process.execPath, ["--preload", file, join(repoRoot, "src/main.ts"), ...args], { cwd: dir,
      stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH, HOME: dir,
        DOCKER_CONFIG: process.env.DOCKER_CONFIG ?? join(process.env.HOME ?? "", ".docker") } });
    let said = "";
    for (const out of [child.stdout, child.stderr]) out.setEncoding("utf8").on("data", (d: string) => { said += d; });
    const code = await new Promise<number | null>((r) => child.on("close", (c) => r(c)));
    const ids = [...said.matchAll(/^session (\w+)$/gm)].map((m) => m[1]!);
    const left = ids.flatMap((id) => spawnSync("docker", ["ps", "-a", "--filter", `name=arnx-${id}-`, "--format", "{{.Names}}"],
      { encoding: "utf8" }).stdout.trim().split("\n").filter(Boolean));
    // Only if the test fails: this run's own containers, by their names.
    for (const name of left) spawnSync("docker", ["rm", "-fv", name]);
    return { code, said, ids, left };
  };

  // Up to 3 rounds side by side, as accept's answers run; a review runs 2. Any way out goes through the same exit.
  test("a project failing while others run: arnx exits and no container stays up", async () => {
    const r = await arnxAfter(`
await inPool(["run", "run", "fails"], 3, async (item) => {
  if (item === "run") return open();
  while (!(globalThis as { up?: number }).up) await new Promise((r) => setTimeout(r, 50));
  throw new Error("the other project failed");
}).catch((e) => console.log(e.message));
`.replace("return open();", "{ void (async () => { await open(); const g = globalThis as { up?: number }; g.up = (g.up ?? 0) + 1; })(); return; }"),
    ["review"]);
    expect(r.said).toContain("the other project failed");
    expect(r.said).toContain("container up");
    expect(r.ids).toHaveLength(2);
    expect(r.code).not.toBe(0);
    expect(r.left).toEqual([]);
  }, 300_000);

  test("a session opened after an interrupt's cleanup leaves no container either", async () => {
    // Opened by a closer, so after the interrupt's cleanup and before its exit, as a model's reply in that wait can.
    const r = await arnxAfter(`
closers.add(open);
const on = process.on.bind(process);
(process as { on: unknown }).on = (event: string, fn: () => void) => {
  on(event as "SIGINT", fn);
  if (event === "SIGINT") queueMicrotask(() => process.emit("SIGINT"));
  return process;
};
`, ["--version"]);
    expect(r.said).toContain("container up");
    expect(r.ids).toHaveLength(1);
    expect(r.code).toBe(130);
    expect(r.left).toEqual([]);
  }, 300_000);

  test("test_service_reachable_internet_not", async () => {
    const cfg = parseReviewConfig(SVC);
    const image = await ensureEnv(cfg, snap(), join(tmp(), "build.log"));
    const s = await new Session(image, cfg, snap()).start();
    // postgres declares a data volume; closing the session removes it with the container
    const volumes = spawnSync("docker", ["inspect", "-f", "{{range .Mounts}}{{.Name}} {{end}}", `arnx-${s.id}-db`],
      { encoding: "utf8" }).stdout.trim().split(/\s+/).filter(Boolean);
    expect(volumes.length).toBeGreaterThan(0);
    try {
      const ok = await s.run("python -c \"import socket; socket.create_connection(('db', 5432), 5)\"", 60);
      expect(ok.exitCode).toBe(0);
      expect((await s.run("python -c \"import socket; socket.create_connection(('1.1.1.1', 53), 3)\"", 60)).exitCode)
        .not.toBe(0);
    } finally {
      s.close();
    }
    const networks = spawnSync("docker", ["network", "ls", "--format", "{{.Name}}"], { encoding: "utf8" }).stdout;
    expect(networks.split("\n")).not.toContain(s.network);
    for (const v of volumes) expect(spawnSync("docker", ["volume", "inspect", v]).status).not.toBe(0);
  }, 600_000);
});

test("every Docker step is logged with its duration when a log is set", async () => {
  const fake = join(tmp(), "fake-docker");
  writeFileSync(fake, "#!/bin/sh\nexit 0\n");
  chmodSync(fake, 0o755);
  const lines: Record<string, unknown>[] = [];
  dockerSteps.log = (l) => lines.push(l);
  try {
    await withDockerAsync(fake, async () => {
      const cfg = parseReviewConfig(CFG);
      const image = await ensureEnv(cfg, tmp(), join(tmp(), "build.log")); // "image inspect" succeeds: reused
      await new Session(image, cfg, tmp()).run("pytest -q", 60);
    });
  } finally {
    dockerSteps.log = null;
  }
  expect(lines.map((l) => [l.step, l.built ?? null])).toEqual([["image", false], ["run", null]]);
  // The tag says which image was reused or built, so a rebuild can be traced to a changed environment or a removed image.
  expect(lines[0]!.tag).toMatch(/^arnx-env:[0-9a-f]{16}$/);
  expect(lines[1]).toMatchObject({ command: "pytest -q", exit: 0 });
  expect(typeof lines[1]!.secs).toBe("number");
});

test("a build that cannot reach the package index is tried once more, then reported as network trouble", async () => {
  const fake = join(tmp(), "fake-docker-net");
  const count = join(tmp(), "builds");
  writeFileSync(fake, `#!/bin/sh\ncase "$1" in\n  image) exit 1;;\n  build) echo x >> ${count}; ` +
    `echo "WARNING: Retrying after connection broken by 'ReadTimeoutError(\\"HTTPSConnectionPool(host='pypi.org', port=443): Read timed out.\\")'"; ` +
    `echo "ERROR: No matching distribution found for aioredis==2.0.1"; exit 1;;\nesac\nexit 0\n`);
  chmodSync(fake, 0o755);
  const said: string[] = [];
  dockerSteps.say = (m) => said.push(m);
  const saved = networkRetry.waitSeconds;
  networkRetry.waitSeconds = 0;
  try {
    await expect(withDockerAsync(fake, () => ensureEnv(parseReviewConfig(CFG), tmp(), join(tmp(), "build.log"))))
      .rejects.toThrow(/network problem, not the install steps/);
  } finally {
    dockerSteps.say = null;
    networkRetry.waitSeconds = saved;
  }
  expect(readFileSync(count, "utf8").trim().split("\n")).toHaveLength(2);
  expect(said.some((m) => m.includes("trying again"))).toBe(true);
});

test("an image build does not block: timers (the progress spinner and clock) keep running during it", async () => {
  const fake = join(tmp(), "slow-docker");
  // image inspect fails (no image yet); the build takes 0.6 s.
  writeFileSync(fake, `#!/bin/sh\ncase "$1" in image) exit 1;; build) cat > /dev/null; sleep 0.6;; esac\nexit 0\n`);
  chmodSync(fake, 0o755);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 50);
  try {
    await withDockerAsync(fake, () => ensureEnv(parseReviewConfig(CFG), tmp(), join(tmp(), "build.log")));
  } finally {
    clearInterval(timer);
  }
  expect(ticks).toBeGreaterThanOrEqual(5);
});

// ---- A run does not hold the process: other projects' timers, polls and streams, and a signal's handler, go on. ----

test("a test run does not stop the clock for other work", async () => {
  const fake = join(tmp(), "docker");
  writeFileSync(fake, "#!/bin/sh\nsleep 1\necho ran\n");
  chmodSync(fake, 0o755);
  const s = new Session("img", parseReviewConfig(CFG), tmp());
  let ticks = 0;
  const timer = setInterval(() => ticks++, 50);
  try {
    const r = await withDockerAsync(fake, async () => s.run("pytest -q", 60));
    expect(r).toMatchObject({ exitCode: 0, output: "ran\n", timedOut: false });
  } finally {
    clearInterval(timer);
  }
  expect(ticks).toBeGreaterThanOrEqual(5);
});

/** Waits for a fake docker to have written `path` (its pid). */
async function pidIn(path: string): Promise<number> {
  for (let i = 0; i < 200 && !(existsSync(path) && readFileSync(path, "utf8").includes("\n")); i++) await sleep(20);
  return Number(readFileSync(path, "utf8").trim());
}
const isGone = (pid: number) => {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
};

test("Ctrl-C during a run removes the container: docker is killed and the container goes by its name", async () => {
  const pid = join(tmp(), "pid");
  const fake = loggingDocker(tmp(), { run: `echo $$ > '${pid}'; exec sleep 3` });
  await withDockerAsync(fake.path, async () => {
    const s = await new Session("img", parseReviewConfig(CFG), tmp()).start();
    let answered = false;
    const run = Promise.resolve(s.run("pytest -q", 600)).finally(() => { answered = true; });
    run.catch(() => {});
    const client = await pidIn(pid);
    cleanupLiveSessions();
    const calls = fake.calls();
    const name = calls[0]![calls[0]!.indexOf("--name") + 1]!;
    expect(name).toMatch(new RegExp(`^arnx-${s.id}-run-`));
    expect(calls.slice(1)).toEqual([["rm", "-fv", name]]);
    await sleep(100);
    expect(isGone(client)).toBe(true);
    // What waits on it does not go on: the process is exiting, and the run's result would read as the code's.
    expect(answered).toBe(false);
    // Nor does a later run start a container that nothing would remove.
    let later = false;
    void Promise.resolve(s.run("pytest -q again", 600)).finally(() => { later = true; }).catch(() => {});
    await sleep(100);
    expect(later).toBe(false);
    expect(fake.calls()).toHaveLength(2);
  });
});

test("Ctrl-C just as a run starts: a container Docker makes moments later still goes", async () => {
  const pid = join(tmp(), "pid");
  const removals = join(tmp(), "removals");
  const fake = join(tmp(), "docker");
  // The first two removals find nothing yet, as one Docker says it and as another does.
  writeFileSync(fake, `#!/bin/sh\ncase "$1" in\n  run) echo $$ > '${pid}'; exec sleep 3;;\n` +
    `  rm) echo x >> '${removals}'; n=$(wc -l < '${removals}'); [ "$n" -eq 1 ] && exit 1; [ "$n" -eq 2 ] && exit 0; echo "$3";;\n` +
    "esac\nexit 0\n");
  chmodSync(fake, 0o755);
  await withDockerAsync(fake, async () => {
    const s = await new Session("img", parseReviewConfig(CFG), tmp()).start();
    void s.run("pytest -q", 600);
    await pidIn(pid);
    cleanupLiveSessions();
  });
  expect(readFileSync(removals, "utf8").trim().split("\n")).toHaveLength(3);
});

test("Ctrl-C during a command in the shared container removes it and kills docker exec", async () => {
  const pid = join(tmp(), "pid");
  const fake = loggingDocker(tmp(), { exec: `echo $$ > '${pid}'; exec sleep 3` });
  await withDockerAsync(fake.path, async () => {
    const s = await new Session("img", parseReviewConfig(CFG), tmp()).start();
    void Promise.resolve(s.exec("python --version", 600)).catch(() => {});
    const client = await pidIn(pid);
    cleanupLiveSessions();
    const calls = fake.calls();
    const box = calls[0]![calls[0]!.indexOf("--name") + 1]!;
    expect(calls.map((c) => c[0])).toEqual(["run", "exec", "rm"]);
    expect(calls[2]).toEqual(["rm", "-fv", box]);
    await sleep(100);
    expect(isGone(client)).toBe(true);
  });
});

test("a session closed with a run in flight, outside an interrupt, answers that run with an error", async () => {
  const pid = join(tmp(), "pid");
  const fake = loggingDocker(tmp(), { run: `echo $$ > '${pid}'; exec sleep 3` });
  await withDockerAsync(fake.path, async () => {
    const s = new Session("img", parseReviewConfig(CFG), tmp());
    const run = Promise.resolve(s.run("pytest -q", 600));
    await pidIn(pid);
    s.close();
    await expect(run).rejects.toThrow("closed");
    expect(fake.calls().map((c) => c[0])).toEqual(["run", "rm"]);
    await expect(Promise.resolve(s.run("pytest -q", 600))).rejects.toThrow("closed");
    expect(fake.calls()).toHaveLength(2);
  });
});

test("a character split across two reads of a run's output arrives whole", async () => {
  const fake = join(tmp(), "docker");
  writeFileSync(fake, "#!/bin/sh\nprintf '\\303'\nsleep 0.2\nprintf '\\251\\n'\n");
  chmodSync(fake, 0o755);
  const s = new Session("img", parseReviewConfig(CFG), tmp());
  const r = await withDockerAsync(fake, async () => s.run("pytest -q", 60));
  expect(r.output).toBe("\u00e9\n");
});

test("a run keeps the end of its output, stdout then stderr, up to the limit", async () => {
  const fake = join(tmp(), "docker");
  writeFileSync(fake, "#!/bin/sh\ni=0\nwhile [ $i -lt 30 ]; do head -c 10000 /dev/zero | tr '\\0' a; i=$((i+1)); done\n" +
    "printf end-of-out\nprintf end-of-err >&2\n");
  chmodSync(fake, 0o755);
  const s = new Session("img", parseReviewConfig(CFG), tmp());
  const r = await withDockerAsync(fake, async () => s.run("pytest -q", 60));
  expect(r.output).toHaveLength(200_000);
  expect(r.output.endsWith("aend-of-outend-of-err")).toBe(true);
});

test("a run past its time comes back even when a process still holds its output open", async () => {
  const fake = join(tmp(), "docker");
  // A shell that waits on its sleep: killing the shell leaves the sleep holding the pipes.
  writeFileSync(fake, '#!/bin/sh\ncase "$1" in run) echo partial; sleep 8;; esac\nexit 0\n');
  chmodSync(fake, 0o755);
  const s = new Session("img", parseReviewConfig(CFG), tmp());
  const t0 = performance.now();
  const r = await withDockerAsync(fake, async () => s.run("pytest -q", 1));
  expect(r).toMatchObject({ exitCode: null, timedOut: true, output: "partial\n\n[timed out]" });
  expect(performance.now() - t0).toBeLessThan(5000);
});

test("a run with no Docker binary says so, as before", async () => {
  const s = new Session("img", parseReviewConfig(CFG), tmp());
  await withDockerAsync(join(tmp(), "no-such-docker"), async () => {
    await expect(Promise.resolve().then(() => s.run("pytest -q", 60))).rejects.toThrow(SetupRequired);
  });
});

test("every session is closed even when closing one fails, and the first failure is still told", async () => {
  const fake = loggingDocker(tmp());
  const cfg = parseReviewConfig(`${CFG}services:\n  db: {image: postgres:16-alpine}\n`);
  await withDockerAsync(fake.path, async () => {
    const first = await new Session("img", cfg, tmp()).start();
    const second = await new Session("img", cfg, tmp()).start();
    first.close = () => { throw new Error("docker did not answer"); };
    expect(() => cleanupLiveSessions()).toThrow("docker did not answer");
    expect(fake.calls().map((c) => c.join(" "))).toContain(`network rm ${second.network}`);
    delete (first as { close?: unknown }).close;
    first.close();
  });
});

/** What a run answers with a fake docker doing `body`, limit 1 s, the process blocked `blockMs` right after it starts: run by
 * `runtime`, Bun as the binary is and Node as the npm package is. */
function afterBlock(runtime: "bun" | "node", body: string, blockMs: number) {
  const repoRoot = join(import.meta.dir, "..");
  const dir = join(tmp(), `${runtime}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir);
  const fake = join(dir, "docker");
  writeFileSync(fake, `#!/bin/sh\n${body}\n`);
  chmodSync(fake, 0o755);
  const script = join(dir, "run.ts");
  writeFileSync(script, `
import { parseReviewConfig } from ${JSON.stringify(join(repoRoot, "src/config"))};
import { sandboxOptions, Session } from ${JSON.stringify(join(repoRoot, "src/sandbox"))};
sandboxOptions.docker = ${JSON.stringify(fake)};
const cfg = parseReviewConfig("version: 1\\nimage: i\\ntest_command: pytest -q {targets}\\n");
const t0 = Date.now();
const run = new Session("img", cfg, ${JSON.stringify(dir)}).run("pytest -q", 1);
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${blockMs});
const r = await run;
console.log(JSON.stringify({ timedOut: r.timedOut, exitCode: r.exitCode, output: r.output, ms: Date.now() - t0 }));
process.exit(0);
`);
  let argv = [process.execPath, script];
  if (runtime === "node") {
    const built = join(dir, "run.mjs");
    const b = spawnSync(process.execPath, ["build", "--target=node", script, "--outfile", built], { encoding: "utf8" });
    expect(b.status).toBe(0);
    argv = ["node", built];
  }
  const r = spawnSync(argv[0]!, argv.slice(1), { encoding: "utf8", timeout: 25_000 });
  expect(r.stderr).toBe("");
  return JSON.parse(r.stdout) as { timedOut: boolean; exitCode: number | null; output: string; ms: number };
}
const hasNode = spawnSync("node", ["--version"]).status === 0;

for (const runtime of ["bun", "node"] as const) {
  describe.skipIf(runtime === "node" && !hasNode)(`limits, on ${runtime}`, () => {
    test("a run that ended inside its limit does not read as timed out after the process was blocked", () => {
      expect(afterBlock(runtime, 'case "$1" in run) sleep 0.2; echo ran; exit 3;; esac\nexit 0', 3000))
        .toMatchObject({ timedOut: false, exitCode: 3, output: "ran\n" });
    }, 30_000);

    test("a run still going at its limit after the process was blocked is timed out", () => {
      expect(afterBlock(runtime, 'case "$1" in run) echo partial; exec sleep 20;; esac\nexit 0', 2000))
        .toMatchObject({ timedOut: true, exitCode: null, output: "partial\n\n[timed out]" });
    }, 30_000);

    test("a run that ended, with something it started holding its output open, comes back soon after its limit", () => {
      const r = afterBlock(runtime, 'case "$1" in run) echo ran; sleep 15 & exit 3;; esac\nexit 0', 0);
      expect(r).toMatchObject({ timedOut: false, exitCode: 3, output: "ran\n" });
      expect(r.ms).toBeLessThan(8000);
    }, 30_000);
  });
}

/** A runner that answers later, as Session does, and records what the snapshot held when its run ended. */
const lateRunner = (seen: (command: string) => void, output = "ok") => ({ run: async (command: string) => {
  await sleep(30);
  seen(command);
  return { exitCode: 0, output, timedOut: false, seconds: 0.03 };
} });

test("sandbox-only files stay in place until a run that answers later has ended, and go after it", async () => {
  const snap = join(tmp(), "repo");
  mkdirSync(snap);
  mkdirSync(`${snap}.sandbox/conf`, { recursive: true });
  writeFileSync(`${snap}.sandbox/conf/only.txt`, "only-in-the-sandbox-text\n");
  let during = false;
  const r = await withSandboxFiles(lateRunner(() => { during = existsSync(join(snap, "conf/only.txt")); },
    "before only-in-the-sandbox-text after"), snap).run("x", 60);
  expect(during).toBe(true);
  expect(existsSync(join(snap, "conf"))).toBe(false);
  expect(r.output).not.toContain("only-in-the-sandbox-text");
});

test("a probe's files stay until a run that answers later has ended, and go when it fails", async () => {
  const snap = join(tmp(), "repo");
  mkdirSync(snap);
  const cfg = parseReviewConfig(CFG.replace("workdir: app", "workdir: ."));
  let during = false;
  const p = await probeRun(lateRunner(() => { during = existsSync(join(snap, "tests_arnx/test_arnx_probe.py")); }), snap, cfg,
    "tests_arnx", "probe.xml", 60);
  expect(during).toBe(true);
  expect(p.seen).toBe(false);
  expect(existsSync(join(snap, "tests_arnx/test_arnx_probe.py"))).toBe(false);
  await expect(probeRun({ run: async () => {
    await sleep(10);
    throw new Error("the run failed");
  } }, snap, cfg, "tests_arnx", "probe.xml", 60)).rejects.toThrow("the run failed");
  expect(existsSync(join(snap, "tests_arnx/test_arnx_probe.py"))).toBe(false);
});

test("a Docker error in a run that answers later is still a failed type check", async () => {
  const cfg = { ...parseReviewConfig(CFG), typecheck: "tsc --noEmit" };
  const t = await runTypecheck({ run: async () => {
    await sleep(10);
    throw new ArnxError("docker went away");
  } }, cfg);
  expect(t).toMatchObject({ status: "failed", output: "docker went away", exitCode: null });
});

// ---- Rust keeps its build: the runs of one session share one container. Fake Docker only: it logs each call and
// never runs the command it is given. ----

const RUST = `version: 1
projects:
  calc:
    root: .
    language: rust
    runner: nextest
    image: rust:1-bookworm
    install: [cargo nextest run --no-run]
    test_command: cargo nextest run {targets}
`;
const rustCfg = () => parseReviewFile(RUST).projects[0]!;
const SEP = "\x1f";

/** A fake docker that logs its arguments (one call per line) and answers `exec` from `exec` (sh, run with the call's
 * number in $n), `image inspect` with `entrypoint`, `run -d` from `start` and the kill after a timeout from `kill`.
 * `calls` leaves out the image inspections; `inspections` counts them. */
function loggingDocker(dir: string, o: { exec?: string; entrypoint?: string; start?: string; kill?: string; run?: string } = {}) {
  const path = join(dir, "docker");
  const log = join(dir, "calls");
  const count = join(dir, "execs");
  writeFileSync(path, `#!/bin/sh\nprintf '%s${SEP}' "$@" >> '${log}'\necho >> '${log}'\n` +
    `case "$1" in\n  image) echo '${o.entrypoint ?? "null"}';;\n` +
    `  run) if [ "$2" = "-d" ]; then ${o.start ?? "echo cafe"}; else ${o.run ?? ":"}; fi;;\n` +
    '  rm) echo "$3";;\n' +
    `  exec) case "$*" in *"kill -9 -1 2>/dev/null; exit 0"*) ${o.kill ?? "exit 0"};; esac\n` +
    `    echo x >> '${count}'; n=$(wc -l < '${count}'); ${o.exec ?? "echo ran; exit 0"};;\nesac\nexit 0\n`);
  chmodSync(path, 0o755);
  const all = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n")
    .map((l) => l.split(SEP).slice(0, -1)) : [];
  return { path, calls: () => all().filter((c) => c[0] !== "image"),
    inspections: () => all().filter((c) => c[0] === "image").length };
}

test("a Rust session's runs share one container, so the build a run leaves is there for the next", async () => {
  const fake = loggingDocker(tmp());
  const s = new Session("img", rustCfg(), tmp());
  await withDockerAsync(fake.path, async () => {
    expect(await s.run("cargo nextest run a", 60)).toMatchObject({ exitCode: 0, output: "ran\n", timedOut: false });
    expect((await s.run("cargo nextest run b", 60)).exitCode).toBe(0);
    s.close();
  });
  const calls = fake.calls();
  expect(calls.map((c) => c[0])).toEqual(["run", "exec", "exec", "rm"]);
  const [start, first, second, removed] = calls as [string[], string[], string[], string[]];
  // Started once, detached, with every limit a run has; removed at the end by its exact name.
  const box = start[start.indexOf("--name") + 1]!;
  expect(box).toMatch(new RegExp(`^arnx-${s.id}-build-[0-9a-f]{6}$`));
  expect(start.slice(0, 3)).toEqual(["run", "-d", "--rm"]);
  const joined = start.join(" ");
  for (const part of ["--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 512",
    "--memory 4g", "--memory-swap 4g", "--tmpfs /tmp:rw,exec,size=1g", `-v ${tmp()}:/src`,
    "-e CARGO_TARGET_DIR=/opt/arnx-target"]) expect(joined).toContain(part);
  expect(removed).toEqual(["rm", "-fv", box]);
  // Each run is the command in that container: what it left is cleared first (temporary files, the target's tmp/
  // that tests write to), and its leftover processes are killed after.
  for (const [call, cmd] of [[first, "cargo nextest run a"], [second, "cargo nextest run b"]] as const) {
    expect(call.slice(0, 4)).toEqual(["exec", box, "sh", "-c"]);
    expect(call[4]).toContain("rm -rf /tmp/* /tmp/.[!.]* /tmp/..?* /dev/shm/*");
    expect(call[4]).toContain("/opt/arnx-target/tmp/*");
    expect(call[4]).toContain(`sh -c '${cmd}'; s=$?; kill -9 -1 2>/dev/null; exit $s`);
  }
});

test("a Python session still runs each command in a new container", async () => {
  const fake = loggingDocker(tmp());
  const s = new Session("img", parseReviewConfig(CFG), tmp());
  await withDockerAsync(fake.path, async () => {
    await s.run("pytest -q a", 60);
    await s.run("pytest -q b", 60);
    s.close();
  });
  const calls = fake.calls();
  expect(calls.map((c) => c.slice(0, 2))).toEqual([["run", "--rm"], ["run", "--rm"]]);
  expect(calls.map((c) => c.at(-1))).toEqual(["pytest -q a", "pytest -q b"]);
});

test("the head and the base session never share a container: each removes only its own", async () => {
  const fake = loggingDocker(tmp());
  const cfg = rustCfg();
  const head = new Session("img", cfg, join(tmp(), "head"));
  const base = new Session("img", cfg, join(tmp(), "base"));
  await withDockerAsync(fake.path, async () => {
    await head.run("cargo nextest run", 60);
    await base.run("cargo nextest run", 60);
    head.close();
    cleanupLiveSessions(); // an interrupt: the base session is still live
    cleanupLiveSessions();
  });
  const calls = fake.calls();
  const boxes = calls.filter((c) => c[0] === "run").map((c) => c[c.indexOf("--name") + 1]!);
  expect(boxes).toHaveLength(2);
  expect(boxes[0]).not.toBe(boxes[1]);
  expect(calls.filter((c) => c[0] === "run").map((c) => c[c.indexOf("-v") + 1]))
    .toEqual([`${join(tmp(), "head")}:/src`, `${join(tmp(), "base")}:/src`]);
  expect(calls.filter((c) => c[0] === "exec").map((c) => c[1])).toEqual(boxes);
  expect(calls.filter((c) => c[0] === "rm")).toEqual([["rm", "-fv", boxes[0]!], ["rm", "-fv", boxes[1]!]]);
});

test("a run that times out in the shared container has its processes killed; the container and its build stay", async () => {
  const fake = loggingDocker(tmp(), { exec: 'case "$*" in *slow*) exec sleep 5;; esac; echo ran' });
  const s = new Session("img", rustCfg(), tmp());
  let slow, next;
  await withDockerAsync(fake.path, async () => {
    slow = await s.run("slow", 1);
    next = await s.run("cargo nextest run", 60);
    s.close();
  });
  expect(slow).toMatchObject({ exitCode: null, timedOut: true });
  expect(next).toMatchObject({ exitCode: 0, output: "ran\n" });
  const calls = fake.calls();
  const box = calls[0]![calls[0]!.indexOf("--name") + 1]!;
  expect(calls.map((c) => c.slice(0, 2))).toEqual([["run", "-d"], ["exec", box], ["exec", box], ["exec", box],
    ["rm", "-fv"]]);
  expect(calls[2]).toEqual(["exec", box, "sh", "-c", "kill -9 -1 2>/dev/null; exit 0"]);
});

test("a shared container that went away is started again once, and the run goes on there", async () => {
  const fake = loggingDocker(tmp(), { exec: '[ "$n" = 1 ] && { echo "Error response from daemon: No such ' +
    'container: x" >&2; exit 1; }; echo ran' });
  const s = new Session("img", rustCfg(), tmp());
  let r;
  await withDockerAsync(fake.path, async () => {
    r = await s.run("cargo nextest run", 60);
    s.close();
  });
  expect(r).toMatchObject({ exitCode: 0, output: "ran\n" });
  const calls = fake.calls();
  const boxes = calls.filter((c) => c[0] === "run").map((c) => c[c.indexOf("--name") + 1]!);
  expect(calls.map((c) => c[0])).toEqual(["run", "exec", "rm", "run", "exec", "rm"]);
  expect(calls.filter((c) => c[0] === "rm").map((c) => c[2])).toEqual(boxes);
});

test("a test that prints Docker's words is not taken for a container that went away", async () => {
  const fake = loggingDocker(tmp(), { exec: 'echo "panicked: Error response from daemon: No such container: x"; exit 1' });
  const s = new Session("img", rustCfg(), tmp());
  await withDockerAsync(fake.path, async () => {
    expect((await s.run("cargo nextest run", 60)).exitCode).toBe(1);
    s.close();
  });
  expect(fake.calls().map((c) => c[0])).toEqual(["run", "exec", "rm"]);
});

test("an image whose entrypoint stays the first process runs each command in a new container, as before", async () => {
  const fake = loggingDocker(tmp(), { entrypoint: '["/usr/bin/tini","--"]' });
  const lines: Record<string, unknown>[] = [];
  dockerSteps.log = (l) => lines.push(l);
  const s = new Session("img", rustCfg(), tmp());
  try {
    await withDockerAsync(fake.path, async () => {
      await s.run("cargo nextest run a", 60);
      await s.run("cargo nextest run b", 60);
      s.close();
    });
  } finally {
    dockerSteps.log = null;
  }
  // The runs' kill would end that first process and the container with it.
  expect(fake.inspections()).toBe(1);
  expect(fake.calls().map((c) => c.slice(0, 2))).toEqual([["run", "--rm"], ["run", "--rm"]]);
  expect(lines.filter((l) => l.step === "container")).toEqual([expect.objectContaining({ kept: false,
    reason: "entrypoint" })]);
});

test("each kept run first touches, in the container, the files written since the last run there", async () => {
  const snap = join(tmp(), "snap");
  mkdirSync(join(snap, "src"), { recursive: true });
  mkdirSync(join(snap, "tests"), { recursive: true });
  const old = new Date("2020-01-01T00:00:00Z");
  for (const f of ["src/lib.rs", "tests/arnx_generated_a.rs"]) {
    writeFileSync(join(snap, f), "x\n");
    utimesSync(join(snap, f), old, old);
  }
  const fake = loggingDocker(tmp());
  const s = new Session("img", rustCfg(), snap);
  await withDockerAsync(fake.path, async () => {
    await s.run("cargo nextest run", 60);
    Bun.sleepSync(20); // a run takes longer than a file system clock tick
    writeFileSync(join(snap, "tests/arnx_generated_a.rs"), "y\n"); // rewritten
    writeFileSync(join(snap, "tests/arnx_generated_b's.rs"), "z\n"); // new
    mkdirSync(join(snap, ".arnx-run"), { recursive: true });
    writeFileSync(join(snap, ".arnx-run", "final-1.xml"), "<x/>"); // a report, no source
    await s.run("cargo nextest run", 60);
    await s.run("cargo nextest run", 60);
    s.close();
  });
  const execs = fake.calls().filter((c) => c[0] === "exec").map((c) => c[4]!);
  expect(execs).toHaveLength(3);
  // The first run starts from the image's build, older than the snapshot: nothing to touch.
  expect(execs[0]).not.toContain("touch");
  expect(execs[1]).toContain("touch -c -- /src/tests/arnx_generated_a.rs '/src/tests/arnx_generated_b'\"'\"'s.rs';");
  expect(execs[1]).not.toContain("lib.rs");
  expect(execs[1]).not.toContain(".arnx-run");
  expect(execs[2]).not.toContain("touch");
});

test("a kill that Docker does not answer in time counts as the run's timeout; the container goes", async () => {
  const fake = loggingDocker(tmp(), { exec: 'case "$*" in *slow*) exec sleep 5;; esac; echo ran', kill: "exec sleep 5" });
  const saved = keptBox.dockerSeconds;
  keptBox.dockerSeconds = 1;
  const s = new Session("img", rustCfg(), tmp());
  let slow, next;
  try {
    await withDockerAsync(fake.path, async () => {
      slow = await s.run("slow", 1);
      next = await s.run("cargo nextest run", 60);
      s.close();
    });
  } finally {
    keptBox.dockerSeconds = saved;
  }
  expect(slow).toMatchObject({ exitCode: null, timedOut: true });
  expect(next).toMatchObject({ exitCode: 0, output: "ran\n" });
  const calls = fake.calls();
  const boxes = calls.filter((c) => c[0] === "run").map((c) => c[c.indexOf("--name") + 1]!);
  expect(boxes).toHaveLength(2);
  expect(calls.filter((c) => c[0] === "rm").map((c) => c[2])).toEqual(boxes);
});

test("a container start Docker does not answer in time is removed by its name, and the run counts as timed out", async () => {
  const fake = loggingDocker(tmp(), { start: "exec sleep 5" });
  const saved = keptBox.dockerSeconds;
  keptBox.dockerSeconds = 1;
  const s = new Session("img", rustCfg(), tmp());
  let r;
  try {
    await withDockerAsync(fake.path, async () => {
      r = await s.run("cargo nextest run", 60);
    });
  } finally {
    keptBox.dockerSeconds = saved;
  }
  expect(r).toMatchObject({ exitCode: null, timedOut: true });
  const calls = fake.calls();
  const name = calls[0]![calls[0]!.indexOf("--name") + 1]!;
  expect(calls.map((c) => c.slice(0, 2))).toEqual([["run", "-d"], ["rm", "-fv"]]);
  expect(calls[1]).toEqual(["rm", "-fv", name]);
});

test("a run after the session closed (an interrupt) starts no container", async () => {
  const fake = loggingDocker(tmp());
  const s = new Session("img", rustCfg(), tmp());
  await withDockerAsync(fake.path, async () => {
    await s.run("cargo nextest run a", 60);
    cleanupLiveSessions();
    void s.run("cargo nextest run b", 60);
    await sleep(50);
  });
  expect(fake.calls().map((c) => c.slice(0, 2))).toEqual([["run", "-d"], ["exec", expect.any(String)], ["rm", "-fv"]]);
});

// ---- Setup's exec tool: its commands share one container, whatever the language. ----

test("exec commands share one container with every limit a run has; an interrupt removes it by its name", async () => {
  const fake = loggingDocker(tmp());
  const lines: Record<string, unknown>[] = [];
  dockerSteps.log = (l) => lines.push(l);
  const s = new Session("img", parseReviewConfig(CFG), tmp());
  try {
    await withDockerAsync(fake.path, async () => {
      expect(await s.exec("python --version", 60)).toMatchObject({ exitCode: 0, output: "ran\n", timedOut: false });
      await s.exec("ls", 60);
      cleanupLiveSessions();
    });
  } finally {
    dockerSteps.log = null;
  }
  const calls = fake.calls();
  expect(calls.map((c) => c[0])).toEqual(["run", "exec", "exec", "rm"]);
  const [start, first, , removed] = calls as [string[], string[], string[], string[]];
  const box = start[start.indexOf("--name") + 1]!;
  expect(box).toMatch(new RegExp(`^arnx-${s.id}-exec-[0-9a-f]{6}$`));
  const joined = start.join(" ");
  const user = `${process.getuid!()}:${process.getgid!()}`;
  for (const part of ["--network none", "--cap-drop ALL", "--security-opt no-new-privileges", "--pids-limit 512",
    "--memory 4g", "--memory-swap 4g", `--user ${user}`, `-v ${tmp()}:/src`]) expect(joined).toContain(part);
  expect(first.slice(0, 4)).toEqual(["exec", box, "sh", "-c"]);
  expect(first[4]).toContain("sh -c 'python --version'; s=$?; kill -9 -1 2>/dev/null; exit $s");
  expect(removed).toEqual(["rm", "-fv", box]);
  // Logged apart from test runs.
  expect(lines.filter((l) => l.step === "exec")).toHaveLength(2);
  expect(lines.filter((l) => l.step === "run")).toHaveLength(0);
});

test("a project's runs still each get a new container while exec keeps its own", async () => {
  const fake = loggingDocker(tmp());
  const s = new Session("img", parseReviewConfig(CFG), tmp());
  await withDockerAsync(fake.path, async () => {
    await s.exec("ls", 60);
    await s.run("pytest -q a", 60);
    s.close();
  });
  expect(fake.calls().map((c) => c.slice(0, 2))).toEqual([["run", "-d"], ["exec", expect.any(String)],
    ["run", "--rm"], ["rm", "-fv"]]);
});

// --- a service network reaches its services and nothing else ----------------------------------------------------------

const ISOLATED = "com.docker.network.bridge.gateway_mode_ipv4=isolated";
const WITH_DB = parseReviewFile(`version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest {targets}\n` +
  "services:\n  db:\n    image: postgres:16-alpine\n").projects[0]!;

/** What Docker 29.9.2 says of a network. Asked for one gateway's text, a network with none prints the zero address's. */
const ISOLATED_CONFIG = '[{"Subnet":"172.22.0.0/16"}]';
const OPEN_CONFIG = '[{"Subnet":"172.22.0.0/16","Gateway":"172.22.0.1"}]';
const OPEN_V6_CONFIG = '[{"Subnet":"fd00:dead:beef::/64","Gateway":"fd00:dead:beef::1"},{"Subnet":"172.22.0.0/16"}]';

/** A docker that keeps its calls. `create`: the shell for `network create`; `inspect`: the shell for `network inspect`
 * asked for the IPAM config as JSON. */
function networkDocker(create: string, inspect: string): { calls: () => string[] } {
  const dir = tmp();
  const log = join(dir, "calls");
  writeFileSync(join(dir, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
case "$1 $2" in
  "network create") ${create};;
  "network inspect") case "$*" in *json*) ${inspect};; *) echo 'invalid IP';; esac;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  return { calls: () => readFileSync(log, "utf8").split("\n") };
}
const prints = (config: string) => `printf '%s\\n' '${config}'`;

async function openingSession(create: string, inspect: string) {
  const saved = { docker: sandboxOptions.docker, say: dockerSteps.say, said: networkNotice.said };
  const said: string[] = [];
  try {
    const docker = networkDocker(create, inspect);
    networkNotice.said = false;
    dockerSteps.say = (m) => void said.push(m);
    const s = await new Session("img", WITH_DB, tmp()).start();
    s.close();
    const again = await new Session("img", WITH_DB, tmp()).start();
    again.close();
    return { said, calls: docker.calls() };
  } finally {
    sandboxOptions.docker = saved.docker;
    dockerSteps.say = saved.say;
    networkNotice.said = saved.said;
  }
}

test("a service network has no address on this machine, and nothing need be said", async () => {
  const { said, calls } = await openingSession(":", prints(ISOLATED_CONFIG));
  expect(calls.some((c) => c.startsWith("network create --internal -o") && c.includes(ISOLATED))).toBe(true);
  expect(said).toEqual([]);
});

test("a Docker that refuses the option still gets an internal network, and it says so once", async () => {
  const { said, calls } = await openingSession(`case "$*" in *isolated*) echo unknown gateway mode >&2; exit 1;; esac`, prints(ISOLATED_CONFIG));
  expect(calls.filter((c) => c.startsWith("network create")).at(-1)).toMatch(/^network create --internal arnx-/);
  expect(said).toEqual([NETWORK_OPEN]);
  expect(said[0]).toContain("Docker 28");
});

test("a Docker that ignores the option leaves a gateway, IPv4 or IPv6, and it says so once", async () => {
  for (const config of [OPEN_CONFIG, OPEN_V6_CONFIG]) {
    expect((await openingSession(":", prints(config))).said).toEqual([NETWORK_OPEN]);
  }
});

test("a network Docker will not describe counts as open: no answer, a failed one, or one that does not read", async () => {
  for (const inspect of ["exit 1", ":", "echo not json", "echo null", `echo '[]'`, `echo '{"Subnet":"x"}'`, `echo '["x"]'`]) {
    expect([inspect, (await openingSession(":", inspect)).said]).toEqual([inspect, [NETWORK_OPEN]]);
  }
});

test("a network Docker cannot make at all stops the session, naming why", async () => {
  await expect(openingSession(`echo no addresses left >&2; exit 1`, prints(ISOLATED_CONFIG))).rejects.toThrow("no addresses left");
});
