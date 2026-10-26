// Docker sandbox. The environment image is built once per approved image, workdir and install commands plus the
// dependency manifests; the build has network access, and on BuildKit its package downloads are cached across builds. Test runs get no network (or an internal network that reaches
// only declared services), no environment except declared variables, resource limits, no capabilities, the user's
// uid, and a throwaway copy of the repository at /src.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { adapterFor, getAdapter, LANGUAGES } from "./adapters";
import { digest, type ReviewConfig } from "./config";
import { ArnxError, SetupRequired } from "./errors";
import { globRegex } from "./secrets";
import { pyJson, randomHex, sleep } from "./util";

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
export interface Runner { run(command: string, timeout: number): RunResult }
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
  env: Record<string, string>; command: string; limits: Limits; user: string; runEnv: string[] }): string[] {
  const argv = [sandboxOptions.docker, "run", "--rm", "--name", o.name, "--network", o.network,
    "--cpus", o.limits.cpus, "--memory", o.limits.memory, "--memory-swap", o.limits.memory,
    "--pids-limit", String(o.limits.pids), "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", o.user, "--tmpfs", `/tmp:rw,exec,size=${o.limits.tmp}`,
    "-v", `${o.snapshot}:/src`, "-w", workdirIn("/src", o.workdir), "-e", "HOME=/tmp"];
  for (const e of o.runEnv) argv.push("-e", e);
  for (const k of Object.keys(o.env).sort()) argv.push("-e", `${k}=${o.env[k]}`);
  return [...argv, o.image, "sh", "-c", o.command];
}

const live = new Set<Session>();

/** Tear down every running session; the interrupt handler calls this before exiting. */
export function cleanupLiveSessions(): void {
  for (const s of [...live]) s.close();
}

/** Services and network for one review; close() tears them down, including on errors and interrupts. */
export class Session implements Runner {
  readonly id = randomHex(4);
  readonly network: string;
  private started: string[] = [];
  private networkCreated = false;

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
    if (!live.delete(this)) return;
    for (const name of this.started) docker(["rm", "-f", name]);
    if (this.networkCreated) docker(["network", "rm", this.network]);
  }

  run(command: string, timeout: number): RunResult {
    const name = `arnx-${this.id}-run-${randomHex(3)}`;
    const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    const [bin, ...args] = runArgv({ image: this.image, name, network: this.network, snapshot: this.snapshot,
      workdir: this.cfg.workdir, env: this.cfg.env, command, limits: this.limits, user,
      runEnv: adapterFor(this.cfg).runEnv });
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
      docker(["kill", name]);
      return { exitCode: null, output: (r.stdout ?? "").slice(-OUTPUT_LIMIT) + "\n[timed out]", timedOut: true, seconds };
    }
    return { exitCode: r.status, output: ((r.stdout ?? "") + (r.stderr ?? "")).slice(-OUTPUT_LIMIT), timedOut: false,
      seconds };
  }
}
