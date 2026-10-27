import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { python } from "../src/adapters/python";
import { parseReviewConfig, parseReviewFile } from "../src/config";
import { SetupRequired } from "../src/errors";
import {
  cleanupLiveSessions, DEFAULT_LIMITS, dockerfile, ensureEnv, envKey, requireDocker, runArgv, sandboxOptions, Session,
  dockerSteps, keptBox, networkRetry,
} from "../src/sandbox";
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
        const env = s.run("env", 60).output;
        expect(env).toContain("MODE=test");
        expect(env).not.toContain("ARNX_SENTINEL");
        expect(env).not.toContain("ANTHROPIC_API_KEY");
        expect(s.run("python -c \"import socket; socket.create_connection(('1.1.1.1', 53), 3)\"", 60).exitCode)
          .not.toBe(0);
        expect(s.run("cat /sys/fs/cgroup/pids.max", 30).output.trim()).toBe("512");
        expect(s.run("python probe.py", 30).output.trim()).toBe("hello");
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
      r = s.run("sleep 600", 5);
    } finally {
      s.close();
    }
    expect(r.timedOut).toBe(true);
    expect(r.exitCode).toBeNull();
    expect(r.seconds).toBeLessThan(60);
  }, 600_000);

  test("test_service_reachable_internet_not", async () => {
    const cfg = parseReviewConfig(SVC);
    const image = await ensureEnv(cfg, snap(), join(tmp(), "build.log"));
    const s = await new Session(image, cfg, snap()).start();
    // postgres declares a data volume; closing the session removes it with the container
    const volumes = spawnSync("docker", ["inspect", "-f", "{{range .Mounts}}{{.Name}} {{end}}", `arnx-${s.id}-db`],
      { encoding: "utf8" }).stdout.trim().split(/\s+/).filter(Boolean);
    expect(volumes.length).toBeGreaterThan(0);
    try {
      const ok = s.run("python -c \"import socket; socket.create_connection(('db', 5432), 5)\"", 60);
      expect(ok.exitCode).toBe(0);
      expect(s.run("python -c \"import socket; socket.create_connection(('1.1.1.1', 53), 3)\"", 60).exitCode)
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
      new Session(image, cfg, tmp()).run("pytest -q", 60);
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
function loggingDocker(dir: string, o: { exec?: string; entrypoint?: string; start?: string; kill?: string } = {}) {
  const path = join(dir, "docker");
  const log = join(dir, "calls");
  const count = join(dir, "execs");
  writeFileSync(path, `#!/bin/sh\nprintf '%s${SEP}' "$@" >> '${log}'\necho >> '${log}'\n` +
    `case "$1" in\n  image) echo '${o.entrypoint ?? "null"}';;\n` +
    `  run) [ "$2" = "-d" ] && { ${o.start ?? "echo cafe"}; };;\n` +
    `  exec) case "$*" in *"kill -9 -1 2>/dev/null; exit 0"*) ${o.kill ?? "exit 0"};; esac\n` +
    `    echo x >> '${count}'; n=$(wc -l < '${count}'); ${o.exec ?? "echo ran; exit 0"};;\nesac\nexit 0\n`);
  chmodSync(path, 0o755);
  const all = () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n")
    .map((l) => l.split(SEP).slice(0, -1)) : [];
  return { path, calls: () => all().filter((c) => c[0] !== "image"),
    inspections: () => all().filter((c) => c[0] === "image").length };
}

test("a Rust session's runs share one container, so the build a run leaves is there for the next", () => {
  const fake = loggingDocker(tmp());
  const s = new Session("img", rustCfg(), tmp());
  withDocker(fake.path, () => {
    expect(s.run("cargo nextest run a", 60)).toMatchObject({ exitCode: 0, output: "ran\n", timedOut: false });
    expect(s.run("cargo nextest run b", 60).exitCode).toBe(0);
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

test("a Python session still runs each command in a new container", () => {
  const fake = loggingDocker(tmp());
  const s = new Session("img", parseReviewConfig(CFG), tmp());
  withDocker(fake.path, () => {
    s.run("pytest -q a", 60);
    s.run("pytest -q b", 60);
    s.close();
  });
  const calls = fake.calls();
  expect(calls.map((c) => c.slice(0, 2))).toEqual([["run", "--rm"], ["run", "--rm"]]);
  expect(calls.map((c) => c.at(-1))).toEqual(["pytest -q a", "pytest -q b"]);
});

test("the head and the base session never share a container: each removes only its own", () => {
  const fake = loggingDocker(tmp());
  const cfg = rustCfg();
  const head = new Session("img", cfg, join(tmp(), "head"));
  const base = new Session("img", cfg, join(tmp(), "base"));
  withDocker(fake.path, () => {
    head.run("cargo nextest run", 60);
    base.run("cargo nextest run", 60);
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

test("a run that times out in the shared container has its processes killed; the container and its build stay", () => {
  const fake = loggingDocker(tmp(), { exec: 'case "$*" in *slow*) exec sleep 5;; esac; echo ran' });
  const s = new Session("img", rustCfg(), tmp());
  let slow, next;
  withDocker(fake.path, () => {
    slow = s.run("slow", 1);
    next = s.run("cargo nextest run", 60);
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

test("a shared container that went away is started again once, and the run goes on there", () => {
  const fake = loggingDocker(tmp(), { exec: '[ "$n" = 1 ] && { echo "Error response from daemon: No such ' +
    'container: x" >&2; exit 1; }; echo ran' });
  const s = new Session("img", rustCfg(), tmp());
  let r;
  withDocker(fake.path, () => {
    r = s.run("cargo nextest run", 60);
    s.close();
  });
  expect(r).toMatchObject({ exitCode: 0, output: "ran\n" });
  const calls = fake.calls();
  const boxes = calls.filter((c) => c[0] === "run").map((c) => c[c.indexOf("--name") + 1]!);
  expect(calls.map((c) => c[0])).toEqual(["run", "exec", "rm", "run", "exec", "rm"]);
  expect(calls.filter((c) => c[0] === "rm").map((c) => c[2])).toEqual(boxes);
});

test("a test that prints Docker's words is not taken for a container that went away", () => {
  const fake = loggingDocker(tmp(), { exec: 'echo "panicked: Error response from daemon: No such container: x"; exit 1' });
  const s = new Session("img", rustCfg(), tmp());
  withDocker(fake.path, () => {
    expect(s.run("cargo nextest run", 60).exitCode).toBe(1);
    s.close();
  });
  expect(fake.calls().map((c) => c[0])).toEqual(["run", "exec", "rm"]);
});

test("an image whose entrypoint stays the first process runs each command in a new container, as before", () => {
  const fake = loggingDocker(tmp(), { entrypoint: '["/usr/bin/tini","--"]' });
  const lines: Record<string, unknown>[] = [];
  dockerSteps.log = (l) => lines.push(l);
  const s = new Session("img", rustCfg(), tmp());
  try {
    withDocker(fake.path, () => {
      s.run("cargo nextest run a", 60);
      s.run("cargo nextest run b", 60);
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

test("each kept run first touches, in the container, the files written since the last run there", () => {
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
  withDocker(fake.path, () => {
    s.run("cargo nextest run", 60);
    Bun.sleepSync(20); // a run takes longer than a file system clock tick
    writeFileSync(join(snap, "tests/arnx_generated_a.rs"), "y\n"); // rewritten
    writeFileSync(join(snap, "tests/arnx_generated_b's.rs"), "z\n"); // new
    mkdirSync(join(snap, ".arnx-run"), { recursive: true });
    writeFileSync(join(snap, ".arnx-run", "final-1.xml"), "<x/>"); // a report, no source
    s.run("cargo nextest run", 60);
    s.run("cargo nextest run", 60);
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

test("a kill that Docker does not answer in time counts as the run's timeout; the container goes", () => {
  const fake = loggingDocker(tmp(), { exec: 'case "$*" in *slow*) exec sleep 5;; esac; echo ran', kill: "exec sleep 5" });
  const saved = keptBox.dockerSeconds;
  keptBox.dockerSeconds = 1;
  const s = new Session("img", rustCfg(), tmp());
  let slow, next;
  try {
    withDocker(fake.path, () => {
      slow = s.run("slow", 1);
      next = s.run("cargo nextest run", 60);
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

test("a container start Docker does not answer in time is removed by its name, and the run counts as timed out", () => {
  const fake = loggingDocker(tmp(), { start: "exec sleep 5" });
  const saved = keptBox.dockerSeconds;
  keptBox.dockerSeconds = 1;
  const s = new Session("img", rustCfg(), tmp());
  let r;
  try {
    withDocker(fake.path, () => {
      r = s.run("cargo nextest run", 60);
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

test("a run after the session closed (an interrupt) starts no shared container", () => {
  const fake = loggingDocker(tmp());
  const s = new Session("img", rustCfg(), tmp());
  withDocker(fake.path, () => {
    s.run("cargo nextest run a", 60);
    cleanupLiveSessions();
    s.run("cargo nextest run b", 60);
  });
  expect(fake.calls().map((c) => c.slice(0, 2))).toEqual([["run", "-d"], ["exec", expect.any(String)], ["rm", "-fv"],
    ["run", "--rm"]]);
});
