// Docker sandbox. The environment image is built once per approved image, workdir and install commands plus the
// dependency manifests; the build has network access, and on BuildKit its package downloads are cached across builds. Test runs get no network (or an internal network that reaches
// only declared services), no environment except declared variables, resource limits, no capabilities, the user's
// uid, and a throwaway copy of the repository at /src. Each run is a new container, except for an adapter that keeps
// its build (Rust): its session's runs share one (see Session).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { adapterFor, getAdapter, LANGUAGES } from "./adapters";
import type { CopyOnly } from "./baked";
import { digest, type ReviewConfig } from "./config";
import { ArnxError, SetupRequired } from "./errors";
import { globRegex } from "./secrets";
import { pyJson, randomHex, shQuote, sleep } from "./util";

/** The repository the running command works on (set by the command): environment images are labelled with it, so
 * `arnx env prune` can tell whose image is whose. */
export const envOwner: { repo: string | null } = { repo: null };

/** A repository's label value: a hash of its path. */
export const repoId = (repo: string) => createHash("sha256").update(repo).digest("hex").slice(0, 16);

/** Labels of an environment image: whose it is, for which project and settings, and when it was built. */
function envLabels(cfg: ReviewConfig): string[] {
  const labels = [`arnx.project=${cfg.name}`, `arnx.config=${digest(cfg).slice(0, 16)}`,
    `arnx.created=${new Date().toISOString()}`, ...(envOwner.repo ? [`arnx.repo=${repoId(envOwner.repo)}`] : [])];
  return labels.flatMap((l) => ["--label", l]);
}

/** Mutable so tests can point it at a fake. */
export const sandboxOptions: { docker: string; buildkit: boolean | null } = { docker: "docker", buildkit: null };

/** One line per Docker step (image built or reused, services started, each run) with its duration, so the time a
 * review or a setup spends in Docker can be measured. Set by the command that runs; null writes nothing. */
export const dockerSteps: { log: ((line: Record<string, unknown>) => void) | null;
  /** Told what Docker is doing when it takes long (an image build), for the progress line. */
  say: ((message: string) => void) | null } = { log: null, say: null };

/** Runs `fn` with `say` told what Docker is doing when it takes long, for a command that sets no other Docker step. */
export async function sayingDocker<T>(say: ((message: string) => void) | undefined, fn: () => Promise<T>): Promise<T> {
  dockerSteps.say = say ?? null;
  try {
    return await fn();
  } finally {
    dockerSteps.say = null;
  }
}

/** Signs in a build log that the build could not reach a package index or registry: a network problem, not a wrong
 * install step. */
export const NETWORK_TROUBLE = /Read timed out|ReadTimeoutError|Connection (?:reset|refused|broken)|connection broken|Temporary failure in name resolution|Could not resolve host|Name or service not known|Network is unreachable|ETIMEDOUT|ECONNRESET|EAI_AGAIN|ENOTFOUND|TLS handshake timeout|i\/o timeout|socket hang up/i;
/** Seconds to wait before building again after network trouble (mutable for tests). */
export const networkRetry = { waitSeconds: 20 };
const stepLog = (line: Record<string, unknown>) => dockerSteps.log?.({ at: new Date().toISOString(), ...line });
export const BUILD_TIMEOUT = 1800;
export const READY_TIMEOUT = 90;
export const OUTPUT_LIMIT = 200_000;
export const REPORT_DIR = ".arnx-run";
const MAX_BUFFER = 1 << 30;

export interface Limits { cpus: string; memory: string; pids: number; tmp: string }
export const DEFAULT_LIMITS: Limits = { cpus: "2", memory: "4g", pids: 512, tmp: "1g" };

export interface RunResult { exitCode: number | null; output: string; timedOut: boolean; seconds: number }
export interface Runner {
  run(command: string, timeout: number): RunResult;
  /** Set when the image holds a copy of the code that runs reach (baked.ts): where, and the files only it holds. */
  copies?(output: string): CopyOnly;
}
/** Runs `body` with a ready session for the config's environment and tears it down afterwards. `envFrom`: the
 * snapshot whose manifests pick the image, when it is not `snap` (the before/after check runs the code before the
 * change in the change's image); `key`: that image's key, taken before runs could change those manifests (cargo
 * writes a missing Cargo.lock). */
export type SessionFactory = <T>(cfg: ReviewConfig, snap: string, buildLog: string,
                                 body: (runner: Runner) => Promise<T>, envFrom?: string, key?: string) => Promise<T>;

export function docker(args: string[], { timeout = 120, stdin }: { timeout?: number; stdin?: string } = {}) {
  const r = spawnSync(sandboxOptions.docker, args, { encoding: "utf8", timeout: timeout * 1000, input: stdin,
    maxBuffer: MAX_BUFFER, killSignal: "SIGKILL" });
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "ENOENT") throw new SetupRequired("Docker is not installed; arnx runs tests only inside Docker");
  if (code === "ETIMEDOUT") throw new ArnxError(`docker ${args[0]} did not finish in ${timeout}s`);
  if (r.error) throw new ArnxError(`docker ${args[0]} failed: ${r.error.message}`);
  return { status: r.status ?? -1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** docker() without blocking: an image build takes minutes, and the progress line keeps moving meanwhile (a blocking
 * call stops every timer, so the spinner and the clock froze for the whole build). Same answer and errors as docker(). */
export function dockerAsync(args: string[], { timeout = 120, stdin }: { timeout?: number; stdin?: string } = {})
  : Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(sandboxOptions.docker, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "", timedOut = false, size = 0;
    const take = (add: (s: string) => void) => (b: Buffer) => {
      size += b.length;
      if (size <= MAX_BUFFER) add(b.toString("utf8"));
    };
    child.stdout.on("data", take((s) => { stdout += s; }));
    child.stderr.on("data", take((s) => { stderr += s; }));
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout * 1000);
    child.on("error", (e: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      reject(e.code === "ENOENT" ? new SetupRequired("Docker is not installed; arnx runs tests only inside Docker")
        : new ArnxError(`docker ${args[0]} failed: ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) reject(new ArnxError(`docker ${args[0]} did not finish in ${timeout}s`));
      else resolve({ status: code ?? -1, stdout, stderr });
    });
    child.stdin.on("error", () => {}); // a docker that exits before reading its input
    child.stdin.end(stdin ?? "");
  });
}

const secsSince = (t0: number) => Math.round((performance.now() - t0) / 100) / 10;

/** Docker's own words when it cannot be asked: refused access to its socket (a coding agent's sandbox, or a user
 * outside the docker group) is not the same as a daemon that is down. */
export const DOCKER_DENIED = /permission denied|operation not permitted|access is denied/i;
const DOCKER_DOWN = /cannot connect|is the docker daemon running|error during connect|connection refused|no such file or directory/i;

export function requireDocker(): void {
  const r = docker(["info", "--format", "{{.ServerVersion}}"], { timeout: 30 });
  if (r.status === 0) return;
  const said = `${r.stderr ?? ""}\n${r.stdout ?? ""}`;
  if (DOCKER_DENIED.test(said)) {
    throw new SetupRequired("Docker is not reachable (permission denied on its socket): if a coding agent ran arnx " +
      "in its sandbox, run this command in your own terminal; otherwise give your user access to Docker (the docker " +
      "group)");
  }
  if (DOCKER_DOWN.test(said) || !said.trim()) throw new SetupRequired("Docker is not running; start it and try again");
  throw new SetupRequired(`Docker is not answering: ${said.trim().split("\n")[0]!.slice(0, 200)}`);
}

const workdirIn = (root: string, workdir: string) => posix.normalize(posix.join(root, workdir));

/** Copies every file that can key an image (any language's manifests, at any depth) from `snapshot` to `dest`:
 * keys computed there stay as the snapshot was before runs wrote into it (cargo writes a missing Cargo.lock). */
export function copyManifests(snapshot: string, dest: string): void {
  const globs = LANGUAGES.flatMap((l) => {
    try {
      return getAdapter(l).manifests.map(globRegex);
    } catch {
      return []; // a language without an adapter yet
    }
  });
  for (const rel of readdirSync(snapshot, { recursive: true }) as string[]) {
    const name = posix.basename(rel.split("\\").join("/"));
    if (!globs.some((g) => g.test(name)) || !statSync(join(snapshot, rel), { throwIfNoEntry: false })?.isFile()) continue;
    mkdirSync(dirname(join(dest, rel)), { recursive: true });
    copyFileSync(join(snapshot, rel), join(dest, rel));
  }
}

export function envKey(cfg: ReviewConfig, snapshot: string): string {
  const post = adapterFor(cfg).postInstall ?? [];
  // Adapters without post-install steps keep the key the first version computed, so its images are reused.
  // The install's directory, not the project's: projects that install the same way there share the image.
  const root = cfg.installRoot;
  const h = createHash("sha256").update(pyJson(post.length ? [cfg.image, root, cfg.install, post]
    : [cfg.image, root, cfg.install]));
  const work = join(snapshot, root);
  const adapter = adapterFor(cfg);
  const entries = !existsSync(work) ? [] : adapter.nestedManifests ? nestedFiles(work) : readdirSync(work).sort();
  for (const pattern of adapter.manifests) {
    const rx = globRegex(pattern);
    for (const rel of entries) {
      const p = join(work, rel);
      if (!rx.test(posix.basename(rel)) || !statSync(p).isFile()) continue;
      h.update(Buffer.concat([Buffer.from(rel + "\0"), readFileSync(p)]));
    }
  }
  return h.digest("hex").slice(0, 16);
}

/** Files under `dir` (sorted POSIX paths relative to it), without build output, dependencies and hidden folders
 * (a repository's own target/ can hold packaged copies of its manifests). Symlinked folders are not followed. */
function nestedFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (!e.name.startsWith(".") && e.name !== "target" && e.name !== "node_modules") out.push(...nestedFiles(dir, rel));
    } else out.push(rel);
  }
  return out.sort();
}

/** Whether `docker build` runs on BuildKit, which cache mounts need (null in sandboxOptions: ask Docker once). */
function buildkit(): boolean {
  if (sandboxOptions.buildkit === null) {
    sandboxOptions.buildkit = process.env.DOCKER_BUILDKIT !== "0" &&
      docker(["buildx", "version"], { timeout: 30 }).status === 0;
  }
  return sandboxOptions.buildkit;
}

/** cache: install steps share the language's download cache (a BuildKit cache mount, kept out of the image). The
 * Dockerfile is not part of the image key: the cache changes how fast an image builds, not what it holds. mark: an
 * image made from the code under test (baked.ts) names its tag in a step of its own, so `arnx env prune` can find the
 * build cache records that build left (they hold the layers after the image is gone). */
export function dockerfile(cfg: ReviewConfig, { cache = false, mark }: { cache?: boolean; mark?: string } = {})
  : string {
  const adapter = adapterFor(cfg);
  const lines = [`FROM ${cfg.image}`];
  // ARG, not ENV: the cache location is set while installing and gone from the image the tests run in.
  const env = [...adapter.buildEnv, ...(cache ? [] : adapter.noDownloadCache ?? [])];
  if (env.length) lines.push(`ENV ${env.join(" ")}`);
  if (cache) for (const a of adapter.downloadCache ?? []) lines.push(`ARG ${a}`);
  const mount = cache && adapter.downloadCache?.length
    ? `--mount=type=cache,id=arnx-${cfg.language},target=/arnx-cache,mode=0777 ` : "";
  const post = adapter.postInstall ?? [];
  lines.push("COPY . /src", ...(mark ? [`RUN : ${mark}`] : []), `WORKDIR ${workdirIn("/src", cfg.installRoot)}`,
    ...[...cfg.install, ...post].map((c) => `RUN ${mount}${c}`));
  return lines.join("\n") + "\n";
}

/** `mark`: the image is made from the code under test (baked.ts); its build is marked with its tag. */
export async function ensureEnv(cfg: ReviewConfig, snapshot: string, logPath: string, key?: string,
                                { mark = false }: { mark?: boolean } = {}): Promise<string> {
  const tag = `arnx-env:${key ?? envKey(cfg, snapshot)}`;
  const t0 = performance.now();
  if (docker(["image", "inspect", tag]).status === 0) {
    stepLog({ step: "image", project: cfg.name, tag, built: false, secs: secsSince(t0) });
    return tag;
  }
  dockerSteps.say?.(`${cfg.name}: building its test image (minutes on a first build)`);
  const text = dockerfile(cfg, { cache: buildkit(), ...(mark ? { mark: tag } : {}) });
  const labels = envLabels(cfg);
  let r = await dockerAsync(["build", "-t", tag, ...labels, "-f", "-", snapshot], { timeout: BUILD_TIMEOUT, stdin: text });
  stepLog({ step: "image", project: cfg.name, tag, built: true, ok: r.status === 0, secs: secsSince(t0) });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, r.stdout + r.stderr);
  // A build that failed because the package index could not be reached is tried once more: a dropped connection is
  // not a wrong install step.
  if (r.status !== 0 && NETWORK_TROUBLE.test(r.stdout + r.stderr)) {
    dockerSteps.say?.(`${cfg.name}: the package index did not answer; trying again in ${networkRetry.waitSeconds}s`);
    await sleep(networkRetry.waitSeconds * 1000);
    const t1 = performance.now();
    r = await dockerAsync(["build", "-t", tag, ...labels, "-f", "-", snapshot], { timeout: BUILD_TIMEOUT, stdin: text });
    stepLog({ step: "image", project: cfg.name, tag, built: true, ok: r.status === 0, retry: "network", secs: secsSince(t1) });
    writeFileSync(logPath, r.stdout + r.stderr);
  }
  if (r.status !== 0) {
    if (NETWORK_TROUBLE.test(r.stdout + r.stderr)) {
      throw new ArnxError("building the test environment failed because it could not reach the package index or " +
        "registry (timeouts or a broken connection, twice): a network problem, not the install steps. Keep the " +
        `configuration as it is and try again when the connection is stable; see ${logPath}`);
    }
    throw new ArnxError(`building the test environment failed; see ${logPath}`);
  }
  return tag;
}

export function runArgv(o: { image: string; name: string; network: string; snapshot: string; workdir: string;
  env: Record<string, string>; command: string; limits: Limits; user: string; runEnv: string[];
  /** Extra bind mounts, "host:container" (the code indexer's output folder). */
  mounts?: string[] }): string[] {
  const argv = [sandboxOptions.docker, "run", "--rm", "--name", o.name, "--network", o.network,
    "--cpus", o.limits.cpus, "--memory", o.limits.memory, "--memory-swap", o.limits.memory,
    "--pids-limit", String(o.limits.pids), "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", o.user, "--tmpfs", `/tmp:rw,exec,size=${o.limits.tmp}`,
    "-v", `${o.snapshot}:/src`, "-w", workdirIn("/src", o.workdir), "-e", "HOME=/tmp"];
  for (const m of o.mounts ?? []) argv.push("-v", m);
  for (const e of o.runEnv) argv.push("-e", e);
  for (const k of Object.keys(o.env).sort()) argv.push("-e", `${k}=${o.env[k]}`);
  return [...argv, o.image, "sh", "-c", o.command];
}

const live = new Set<Session>();

/** Tear down every running session; the interrupt handler calls this before exiting. */
export function cleanupLiveSessions(): void {
  for (const s of [...live]) s.close();
}

// The first process of a container that runs share: it sleeps, reaps what runs leave behind (a shell waits for its
// children), and ends after a day, so a container left by an arnx that was killed stops on its own (--rm removes it).
const KEEPALIVE = 'end=$(($(date +%s)+86400)); while :; do sleep 60; now=$(date +%s) || continue; ' +
  '[ "${now:-0}" -lt "$end" ] || exit 0; done';
// Every process in the container but its first and this shell.
const KILL_ALL = "kill -9 -1 2>/dev/null; exit 0";
// All Docker says when the container is no longer there.
const GONE = /^Error response from daemon: (?:No such container|container \S+ is not running)[^\n]*$/i;
// Past this many characters of paths to touch, a run touches every file of the snapshot instead.
const TOUCH_LIMIT = 64_000;
/** Seconds Docker gets to start, or kill the processes in, a shared container (mutable for tests). */
export const keptBox = { dockerSeconds: 60 };

/** Files under `root` (POSIX paths relative to it) changed after `since` (ms, host clock), the reports left out. */
function changedSince(root: string, since: number, prefix = ""): string[] {
  const out: string[] = [];
  let entries;
  try {
    entries = readdirSync(join(root, prefix), { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      if (rel !== REPORT_DIR) out.push(...changedSince(root, since, rel));
    } else if (e.isFile() && (statSync(join(root, rel), { throwIfNoEntry: false })?.mtimeMs ?? 0) > since) out.push(rel);
  }
  return out;
}

/** Services and network for one review; close() tears them down, including on errors and interrupts.
 *
 * An adapter with `keepBuild` (Rust) runs every command of the session in one container, started at the first run,
 * so the build a run left (cargo's target directory) is where the next run starts; a new container per run started
 * from the image's prebuilt target and compiled the whole workspace again each time (minutes on a large one).
 * Why cargo stays right: it trusts a build of a workspace crate when no source file that build read is newer than it
 * (mtimes; registry dependencies are keyed by version, not by files). A session has one snapshot, so one version of
 * the code (the change's, or the base's in the before/after check, never both), and each later change to it is a
 * file arnx writes between runs (a run is synchronous: nothing writes during one). Each run first touches, inside the
 * container, the files changed since the last run there (found by their mtimes against the host's clock at that
 * run's start), so they are newer than every build before by the clock cargo's builds use, even when Docker's clock
 * is ahead of the host's (Docker Desktop's VM): cargo rebuilds what changed. The first run starts from the image's
 * target as every run did before: the snapshot is extracted with fresh mtimes (`tar -m`), newer than that build, so an
 * image built from other code is never taken for this code. A kept target never moves to another session (another
 * snapshot, whose files may be older than its build), and the container is removed with its session, by its exact
 * name. Before each run the container's /tmp, /dev/shm and the adapter's `emptied` directories are emptied, and after
 * it every process the run left is killed, as a new container would have them; other files a run writes in the
 * container stay for the session's next runs. An image with an entrypoint runs each command in a new container, as
 * other languages do: its entrypoint stays the first process, and the kill after each run would end it. */
export class Session implements Runner {
  readonly id = randomHex(4);
  readonly network: string;
  private started: string[] = [];
  private networkCreated = false;
  private closed = false;
  /** Whether the runs may share a container (the image has no entrypoint); null until the first run asks. */
  private shared: boolean | null = null;
  /** The container the runs share (keepBuild), once the first run started it. */
  private box: string | null = null;
  /** Every shared container started and not yet removed, by name: close removes them. */
  private boxes = new Set<string>();
  /** When the last run in the shared container started (host clock, ms); 0 before its first. */
  private lastRun = 0;

  constructor(readonly image: string, readonly cfg: ReviewConfig, readonly snapshot: string,
              readonly limits: Limits = DEFAULT_LIMITS) {
    this.network = cfg.services.length ? `arnx-${this.id}` : "none";
  }

  async start(): Promise<this> {
    live.add(this);
    const t0 = performance.now();
    try {
      if (this.cfg.services.length) {
        let r = docker(["network", "create", "--internal", this.network]);
        if (r.status !== 0) throw new ArnxError(`docker network create failed: ${r.stderr.trim().slice(0, 200)}`);
        this.networkCreated = true;
        for (const svc of this.cfg.services) {
          const name = `arnx-${this.id}-${svc.name}`;
          const args = ["run", "-d", "--rm", "--name", name, "--network", this.network, "--network-alias", svc.name,
            "--cpus", "1", "--memory", "1g"];
          for (const k of Object.keys(svc.env).sort()) args.push("-e", `${k}=${svc.env[k]}`);
          r = docker([...args, svc.image], { timeout: 900 });
          if (r.status !== 0) throw new ArnxError(`service ${svc.name} did not start: ${r.stderr.trim().slice(0, 300)}`);
          this.started.push(name);
          if (svc.ready) await this.waitReady(name, svc.name, svc.ready);
        }
        stepLog({ step: "services", project: this.cfg.name, services: this.cfg.services.map((x) => x.name),
          secs: secsSince(t0) });
      }
      return this;
    } catch (e) {
      this.close();
      throw e;
    }
  }

  private async waitReady(container: string, service: string, ready: string): Promise<void> {
    const deadline = performance.now() + READY_TIMEOUT * 1000;
    while (performance.now() < deadline) {
      if (docker(["exec", container, "sh", "-c", ready], { timeout: 30 }).status === 0) return;
      await sleep(1000);
    }
    throw new ArnxError(`service ${service} was not ready after ${READY_TIMEOUT}s (ready: ${ready})`);
  }

  close(): void {
    this.closed = true;
    if (!live.delete(this)) return;
    this.dropBox();
    for (const name of this.boxes) docker(["rm", "-f", name]);
    this.boxes.clear();
    for (const name of this.started) docker(["rm", "-f", name]);
    if (this.networkCreated) docker(["network", "rm", this.network]);
  }

  run(command: string, timeout: number): RunResult {
    const keep = adapterFor(this.cfg).keepBuild;
    // A closed session (an interrupt) starts no container that nothing would remove.
    if (!keep || this.closed || !this.mayShare()) {
      const name = `arnx-${this.id}-run-${randomHex(3)}`;
      return this.spawnRun(this.argv(name, command), command, timeout, () => docker(["kill", name]));
    }
    let r = this.keptRun(command, timeout, keep.emptied);
    // A container that went away (Docker restarted, removed by hand) is started again once; its build starts over.
    if (r.exitCode !== 0 && !r.timedOut && GONE.test(r.output.trim())) {
      this.dropBox();
      r = this.keptRun(command, timeout, keep.emptied);
    }
    return r;
  }

  private mayShare(): boolean {
    if (this.shared === null) {
      let entrypoint = "";
      try {
        const r = docker(["image", "inspect", "-f", "{{json .Config.Entrypoint}}", this.image]);
        entrypoint = r.status === 0 ? r.stdout.trim() : "unknown";
      } catch {
        entrypoint = "unknown";
      }
      this.shared = entrypoint === "null" || entrypoint === "[]";
      if (!this.shared) {
        stepLog({ step: "container", project: this.cfg.name, kept: false,
          reason: entrypoint === "unknown" ? "inspect-failed" : "entrypoint" });
      }
    }
    return this.shared;
  }

  private argv(name: string, command: string): string[] {
    const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    return runArgv({ image: this.image, name, network: this.network, snapshot: this.snapshot,
      workdir: this.cfg.workdir, env: this.cfg.env, command, limits: this.limits, user,
      runEnv: adapterFor(this.cfg).runEnv });
  }

  /** One run in the session's shared container (started on first use, with every limit a run has). */
  private keptRun(command: string, timeout: number, emptied: string[]): RunResult {
    if (!this.box) {
      const name = `arnx-${this.id}-build-${randomHex(3)}`;
      const [, run, ...rest] = this.argv(name, KEEPALIVE);
      // Named before it starts: a start Docker answers too late can still have made it, and close removes it.
      [this.box, this.lastRun] = [name, 0];
      this.boxes.add(name);
      live.add(this);
      const t0 = performance.now();
      const seconds = () => (performance.now() - t0) / 1000;
      let r;
      try {
        r = docker([run!, "-d", ...rest], { timeout: keptBox.dockerSeconds });
      } catch (e) {
        if (e instanceof SetupRequired) throw e;
        this.dropBox();
        return { exitCode: null, output: `${e instanceof Error ? e.message : String(e)}\n[timed out]`, timedOut: true,
          seconds: seconds() };
      }
      stepLog({ step: "container", project: this.cfg.name, ok: r.status === 0, secs: secsSince(t0) });
      if (r.status !== 0) {
        this.dropBox();
        return { exitCode: r.status, output: (r.stdout + r.stderr).slice(-OUTPUT_LIMIT), timedOut: false,
          seconds: seconds() };
      }
    }
    const box = this.box!;
    const empty = ["/tmp", "/dev/shm", ...emptied].flatMap((d) => [`${d}/*`, `${d}/.[!.]*`, `${d}/..?*`]).join(" ");
    const changed = this.lastRun ? changedSince(this.snapshot, this.lastRun).sort().map((p) => shQuote(`/src/${p}`))
      : [];
    const touch = !changed.length ? ""
      : changed.join(" ").length > TOUCH_LIMIT
        ? `find /src -path /src/${REPORT_DIR} -prune -o -type f -exec touch -c {} + 2>/dev/null; `
        : `touch -c -- ${changed.join(" ")}; `;
    const wrapped = `rm -rf ${empty} 2>/dev/null; ${touch}sh -c ${shQuote(command)}; s=$?; kill -9 -1 2>/dev/null; ` +
      "exit $s";
    this.lastRun = Date.now();
    return this.spawnRun([sandboxOptions.docker, "exec", box, "sh", "-c", wrapped], command, timeout, () => {
      // Killing docker exec leaves the run going inside: its processes go, the container and its build stay. A
      // container Docker cannot reach in time goes too: the run counts as timed out either way.
      try {
        if (docker(["exec", box, "sh", "-c", KILL_ALL], { timeout: keptBox.dockerSeconds }).status === 0) return;
      } catch {
        // not answered in time
      }
      this.dropBox();
    });
  }

  /** Removes the shared container, best effort: one Docker does not remove now is removed again at close. */
  private dropBox(): void {
    const box = this.box;
    this.box = null;
    if (!box) return;
    try {
      if (docker(["rm", "-f", box], { timeout: keptBox.dockerSeconds }).status === 0) this.boxes.delete(box);
    } catch {
      // close tries again
    }
  }

  private spawnRun(argv: string[], command: string, timeout: number, onTimeout: () => void): RunResult {
    const [bin, ...args] = argv;
    const started = performance.now();
    const r = spawnSync(bin!, args, { encoding: "utf8", timeout: timeout * 1000, killSignal: "SIGKILL",
      maxBuffer: MAX_BUFFER });
    const seconds = (performance.now() - started) / 1000;
    stepLog({ step: "run", project: this.cfg.name, secs: Math.round(seconds * 10) / 10,
      timed_out: (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT", exit: r.status,
      command: command.slice(0, 160) });
    const code = (r.error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT") throw new SetupRequired("Docker is not installed; arnx runs tests only inside Docker");
    if (code === "ETIMEDOUT") {
      onTimeout();
      return { exitCode: null, output: (r.stdout ?? "").slice(-OUTPUT_LIMIT) + "\n[timed out]", timedOut: true, seconds };
    }
    return { exitCode: r.status, output: ((r.stdout ?? "") + (r.stderr ?? "")).slice(-OUTPUT_LIMIT), timedOut: false,
      seconds };
  }
}
