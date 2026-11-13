// Docker sandbox. The environment image is built once per approved image, workdir and install commands plus the
// dependency manifests; the build has network access, and on BuildKit its package downloads are cached across builds. Test runs get no network (or an internal network that reaches
// only declared services), no environment except declared variables, resource limits, no capabilities, the user's
// uid, and a throwaway copy of the repository at /src. Each run is a new container, except for an adapter that keeps
// its build (Rust): its session's runs share one (see Session).
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync }
  from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix } from "node:path";
import { adapterFor, getAdapter, LANGUAGES } from "./adapters";
import type { CopyOnly } from "./baked";
import type { Swap } from "./boundary";
import { digest, loadReviewFile, type ReviewConfig } from "./config";
import { ArnxError, EnvFailed, SetupRequired } from "./errors";
import { entriesUnder, isFileOrLinkToFile, removeTree } from "./safefs";
import { runName } from "./kept";
import { envValue, globRegex } from "./secrets";
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

/** The running command's time limit (setup's `setup_minutes`, its proof included): `at` on the `now` clock (ms), null
 * when there is none. Set by the command for its Docker steps (withTimeLimit); `floorSeconds` is mutable for tests. */
export interface TimeLimit { at: number; now: () => number; minutes: number }
export const timeLimit: { current: TimeLimit | null; floorSeconds: number } = { current: null, floorSeconds: 60 };

/** A Docker step that would start with too little of the command's time left. */
export class OutOfTime extends ArnxError {
  override name = "OutOfTime";
  constructor(readonly minutes: number) {
    super(`setup reached its ${minutes}-minute limit`);
  }
}

/** Runs `fn` with each Docker step bounded by `limit` (none: as it is). */
export async function withTimeLimit<T>(limit: TimeLimit | null | undefined, fn: () => Promise<T>): Promise<T> {
  if (!limit) return fn();
  const saved = timeLimit.current;
  timeLimit.current = limit;
  try {
    return await fn();
  } finally {
    timeLimit.current = saved;
  }
}

/** Seconds a Docker step may take: its own timeout, or the time left when that is less. With less than the floor
 * left the step does not start (OutOfTime): it could not finish. */
export function stepTimeout(own: number): number {
  const limit = timeLimit.current;
  if (!limit) return own;
  const left = Math.floor((limit.at - limit.now()) / 1000);
  if (left < timeLimit.floorSeconds) throw new OutOfTime(limit.minutes);
  return Math.min(own, left);
}

/** Throws OutOfTime when no Docker step could start now. */
export const requireTime = (): void => void stepTimeout(Infinity);

/** Whether `limit` leaves too little time for a Docker step (a step cut short at it ends with less than that). */
export const timeIsUp = (limit: TimeLimit | null | undefined): boolean =>
  !!limit && limit.at - limit.now() < timeLimit.floorSeconds * 1000;
/** Mutable so tests can shorten it. */
export const readyWait = { seconds: 90 };
/** Said when a service network keeps its address on this machine (Session.start). */
export const NETWORK_OPEN = "Docker keeps an address on this machine for test networks: with services declared, a test can " +
  "reach what listens here. Docker 28 or later closes that.";
/** Said once per run of arnx; mutable for tests. */
export const networkNotice = { said: false };
export const OUTPUT_LIMIT = 200_000;
export const REPORT_DIR = ".arnx-run";

/** Where `arnx accept` keeps tests (testround.ts DOME); `arnx check` puts each in place from there, under its run
 * name. */
const KEPT = ".arnx/tests";
/** The file Docker reads at the root of a build context for what to leave out of it. */
const DOCKERIGNORE = ".dockerignore";

export const projectOf = (cfg: ReviewConfig) => posix.normalize(cfg.workdir).replace(/^\.$/, "").replace(/\/$/, "");

/** What in a scope is not the code under test (relative to the scope): the generated tests' folder (it changes during
 * a round), and in the repository's scope arnx's own folder, the runners' reports and the accepted tests a check put
 * in place. Neither the image key nor the image holds these: runs read tests from the mounted copy. The repository's
 * .dockerignore is left out too: Docker would apply it to arnx's build (`*` there, for a project that ships its own
 * image, leaves the image empty); what arnx keeps out is already out of the snapshot. */
export function notCode(cfg: ReviewConfig, snap: string, scope: string): string[] {
  const tests = posix.normalize(posix.join(projectOf(cfg), cfg.testsDir));
  const rel = (p: string) => (scope ? posix.relative(scope, p) : p);
  const kept = existsSync(join(snap, KEPT)) ? entriesUnder(join(snap, KEPT)).filter((p) => isFileOrLinkToFile(join(snap, KEPT, p)))
    .map(runName) : [];
  return [tests, ".arnx", REPORT_DIR, ...kept].filter((p) => !scope || p.startsWith(`${scope}/`)).map(rel)
    .concat(scope ? [] : [DOCKERIGNORE]);
}

/** A copy of `context` without the paths in `skip`, made of hard links where it can (a folder of its own, removed by
 * the caller), or `context` itself when none of them is there. */
function withoutPaths(context: string, skip: string[]): string {
  if (!skip.some((p) => existsSync(join(context, p)))) return context;
  const out = mkdtempSync(join(tmpdir(), "arnx-context-"));
  const visit = (rel: string) => {
    for (const e of readdirSync(join(context, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (skip.includes(r)) continue;
      const from = join(context, r), to = join(out, r);
      if (e.isDirectory()) {
        mkdirSync(to, { recursive: true });
        visit(r);
      } else if (e.isSymbolicLink()) symlinkSync(readlinkSync(from), to);
      else if (e.isFile()) {
        try {
          linkSync(from, to);
        } catch {
          copyFileSync(from, to);
        }
      }
    }
  };
  visit("");
  return out;
}
const MAX_BUFFER = 1 << 30;

export interface Limits { cpus: string; memory: string; pids: number; tmp: string }
export const DEFAULT_LIMITS: Limits = { cpus: "2", memory: "4g", pids: 512, tmp: "1g" };

export interface RunResult { exitCode: number | null; output: string; timedOut: boolean; seconds: number;
  /** The output was longer than OUTPUT_LIMIT: only its end is here. */
  truncated?: boolean }
/** The end of `text` that fits OUTPUT_LIMIT, and whether anything was cut. */
const kept = (text: string, trimmed = false): { output: string; truncated?: true } =>
  text.length > OUTPUT_LIMIT || trimmed ? { output: text.slice(-OUTPUT_LIMIT), truncated: true } : { output: text };
export interface Runner {
  /** Sessions answer later, and a run then does not hold the process; only a test's fake answers at once. */
  run(command: string, timeout: number): RunResult | Promise<RunResult>;
  /** Set when the image holds a copy of the code that runs reach (baked.ts): where, and the files only it holds. */
  copies?(output: string): CopyOnly;
  /** Set when sandbox-only files are placed for each run (withSandboxFiles): a report's text with what it quotes of
   * them taken out, for a report the runner wrote outside arnx's own report folder. */
  clean?(report: string): string;
  /** One run that keeps nothing it prints, for the rerun with a real key (realkey.ts): `src` mounted at /src, no network
   * whatever the services, its output never read. Absent where runs reach a copy of the code in the image (baked.ts). */
  sealed?(command: string, timeout: number, src: string): SealedRun | Promise<SealedRun>;
}
/** All a sealed run gives back: how it ended. */
export interface SealedRun { exitCode: number | null; timedOut: boolean }
/** Throwaway copies that hold a real key while a sealed run reads them (realkey.ts): removed on any exit, an interrupt too. */
export const realKeyCopies = new Set<string>();
/** Runs `body` with a ready session for the config's environment and tears it down afterwards. `envFrom`: the
 * snapshot whose manifests pick the image, when it is not `snap` (the before/after check runs the code before the
 * change in the change's image); `key`: that image's key, taken before runs could change those manifests (cargo
 * writes a missing Cargo.lock); `swap`: what the file's env and commands mean where they run (Session), unless runs read a
 * baked copy of the code. */
export type SessionFactory = <T>(cfg: ReviewConfig, snap: string, buildLog: string,
                                 body: (runner: Runner) => Promise<T>, envFrom?: string, key?: string, swap?: Swap)
  => Promise<T>;

export function docker(args: string[], { timeout = 120, stdin }: { timeout?: number; stdin?: string } = {}) {
  const r = spawnSync(sandboxOptions.docker, args, { encoding: "utf8", timeout: Math.ceil(timeout * 1000), input: stdin,
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

/** What Docker says when its disk is full. */
export const DISK_FULL = /no space left on device|not enough space on the disk|disk quota exceeded/i;
export const diskFullMessage = (): string =>
  "Docker is out of disk space. arnx env prune removes arnx's old images; docker system df shows what else is there.";

/** Docker's disk is full: no retry or other try helps, so setup and reviews stop on it with this one line. */
export class DiskFull extends ArnxError {
  override name = "DiskFull";
  constructor() {
    super(diskFullMessage());
  }
}

/** Throws DiskFull when `output`, from a failed Docker build or start, says the disk is full. */
export function failIfDiskFull(output: string): void {
  if (DISK_FULL.test(output)) throw new DiskFull();
}

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

/** The Docker VM's CPUs and memory (`docker info`), or null when it cannot be read. For tests, an override is read
 * first. */
export function dockerCapacity(): { cpus: number; memoryBytes: number } | null {
  const parse = (text: string) => {
    const m = /^\s*(\d+)\s+(\d+)\s*$/.exec(text);
    const cpus = m ? Number(m[1]) : 0, memoryBytes = m ? Number(m[2]) : 0;
    return cpus > 0 && memoryBytes > 0 ? { cpus, memoryBytes } : null;
  };
  const given = process.env.ARNX_DOCKER_CAPACITY;
  if (given) return parse(given);
  try {
    const r = docker(["info", "--format", "{{.NCPU}} {{.MemTotal}}"], { timeout: 30 });
    return r.status === 0 ? parse(r.stdout) : null;
  } catch {
    return null;
  }
}

/** Sandboxes of `limits` the Docker VM holds at once, at most `max` and at least 1: each takes its CPUs and memory,
 * plus half a GB for Docker itself. An unreadable VM holds one (slower, never out of memory). */
export function sandboxesFit(cap: { cpus: number; memoryBytes: number } | null, max: number, limits: Limits = DEFAULT_LIMITS)
  : number {
  if (!cap) return 1;
  const unit = { k: 2 ** 10, m: 2 ** 20, g: 2 ** 30 }[/[kmg]$/i.exec(limits.memory)?.[0].toLowerCase() as "k" | "m" | "g"] ?? 1;
  const memory = parseFloat(limits.memory) * unit;
  return Math.max(1, Math.min(max, Math.floor(cap.cpus / Number(limits.cpus)), Math.floor(cap.memoryBytes / (memory + 2 ** 29))));
}

const workdirIn = (root: string, workdir: string) => posix.normalize(posix.join(root, workdir));

/** What a run does first for a project with deps_dir: link each node_modules under it into the same place under the
 * install root, since the code mounted over /src hides what install wrote there. A link already there is replaced, a
 * real folder left alone; a deps_dir the image lacks is said in the run's output. */
export function depsLink(cfg: Pick<ReviewConfig, "depsDir" | "installRoot">): string {
  if (!cfg.depsDir) return "";
  const dir = shQuote(cfg.depsDir);
  const root = shQuote(workdirIn("/src", cfg.installRoot));
  return `if [ -d ${dir} ]; then (cd ${dir} && find . -name .git -prune -o -name node_modules -prune -type d -print) | ` +
    `while read -r d; do t=${root}/"\${d#./}"; [ -d "$t" ] && [ ! -L "$t" ] || ln -sfn ${dir}/"\${d#./}" "$t" ` +
    `2>/dev/null; done; else echo "arnx: deps_dir ${cfg.depsDir} is not in the image" >&2; fi; `;
}

let manifestGlobs: RegExp[] | undefined;
/** Whether `path` names a file that can key an image: any language's manifests. */
export function isManifest(path: string): boolean {
  manifestGlobs ??= LANGUAGES.flatMap((l) => {
    try {
      return getAdapter(l).manifests.map(globRegex);
    } catch {
      return []; // a language without an adapter yet
    }
  });
  const name = posix.basename(path);
  return manifestGlobs.some((g) => g.test(name));
}

/** Whether `rel` (repository path) is a file that keys `cfg`'s image: its adapter's manifests, where the build context keeps their real values (a nested manifest still counts for envKey, which reads the snapshot, but
 * the context holds its stand-in). */
function keysImage(cfg: ReviewConfig, rel: string): boolean {
  const root = posix.normalize(cfg.installRoot).replace(/^\.$/, "").replace(/\/$/, "");
  if (root && !rel.startsWith(`${root}/`)) return false;
  const inner = root ? rel.slice(root.length + 1) : rel;
  const adapter = adapterFor(cfg);
  const dirs = inner.split("/").slice(0, -1);
  if (adapter.nestedManifests ? dirs.some((d) => d.startsWith(".") || d === "target" || d === "node_modules") : dirs.length) {
    return false;
  }
  const name = posix.basename(inner);
  return adapter.manifests.some((m) => globRegex(m).test(name));
}

/** Folders whose manifests are not the project's own, before any review.yaml says what the project is. */
const NOT_THE_PROJECT = /(?:^|\/)(?:examples?|samples?|demos?|fixtures?|tests?|__tests__|testdata|docs?|vendor|third_party|node_modules)\//;

/** Which files of `repo` an install of its projects reads for what to install: what keys their images. Before review.yaml
 * exists, or reads, any language's manifests outside folders of examples, tests and the like. */
export function manifestRule(repo: string): (rel: string) => boolean {
  let projects: ReviewConfig[] = [];
  try {
    projects = loadReviewFile(repo, { requireApproved: false }).projects;
  } catch {
    // none yet, or one that does not read
  }
  if (projects.length) return (rel) => projects.some((cfg) => keysImage(cfg, rel));
  return (rel) => isManifest(rel) && !NOT_THE_PROJECT.test(rel);
}

/** Where a snapshot's build context is kept when it has one of its own: beside the snapshot, so nothing that reads the
 * snapshot sees it. */
export const buildContextDir = (snapshot: string) => `${snapshot}.build`;

/** What an image of `snapshot` is built from. Builds have network and tests do not, so the snapshot's guesses (secrets.ts
 * isCertainRule) are real there and stand-ins here; with no guess to keep out it has no folder of its own (change.ts
 * scrub). */
export const buildContextOf = (snapshot: string) => {
  const own = buildContextDir(snapshot);
  return existsSync(own) ? own : snapshot;
};

/** Makes the snapshot's files that differ from the build context newer than the build just made. Cargo trusts a build when
 * no source file is newer: without this, tests would run a build of the context's stand-ins, and only on the run
 * that built the image. Hard links are the files the two share. */
function newerThanBuild(snapshot: string, context: string, rel = ""): void {
  const now = new Date();
  for (const e of readdirSync(join(context, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) newerThanBuild(snapshot, context, r);
    else if (e.isFile() && statSync(join(context, r)).nlink === 1) {
      try {
        utimesSync(join(snapshot, r), now, now);
      } catch {
        // a run took it away
      }
    }
  }
}

/** An image holds the code of the context it was built from, maybe another session's: the snapshot's own files count as
 * newer than it (newerThanBuild), for the languages whose builds trust their age. */
function newerThanImage(cfg: ReviewConfig, snapshot: string): void {
  const context = buildContextOf(snapshot);
  if (adapterFor(cfg).keepBuild && context !== snapshot) newerThanBuild(snapshot, context);
}

/** Copies every file that can key an image (any language's manifests, at any depth) from `snapshot` to `dest`:
 * keys computed there stay as the snapshot was before runs wrote into it (cargo writes a missing Cargo.lock). */
export function copyManifests(snapshot: string, dest: string): void {
  for (const rel of entriesUnder(snapshot)) {
    if (!isManifest(rel)) continue;
    if (!isFileOrLinkToFile(join(snapshot, rel))) continue;
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
  const rxs = adapter.manifests.map(globRegex);
  for (const rx of rxs) {
    for (const rel of manifestFiles(work, (name) => rx.test(name))) {
      h.update(Buffer.concat([Buffer.from(rel + "\0"), readFileSync(join(work, rel))]));
    }
  }
  return h.digest("hex").slice(0, 16);
}

/** The manifests and lockfiles (files whose name `match` accepts) at any depth under `dir`, sorted POSIX paths relative to
 * it, outside the folders nestedFiles leaves out. The one reading of "what an install reads" for the environment's key
 * (envKey) and the key of an image made from the code (baked.ts bakedKey). */
export function manifestFiles(dir: string, match: (name: string) => boolean): string[] {
  return existsSync(dir) ? nestedFiles(dir).filter((rel) => match(posix.basename(rel))) : [];
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

/** The tag of the environment image with key `key` (envKey). */
export const envTag = (key: string) => `arnx-env:${key}`;

/** Installs the code indexer found failing in this run (by image tag): the review's session reuses the verdict instead of
 * running the same failing install again. */
const failedBuilds = new Map<string, EnvFailed>();
export const forgetFailedBuilds = () => failedBuilds.clear();

/** `mark`: the image is made from the code under test (baked.ts); its build is marked with its tag. `built`: it must be there
 * already; nothing is built. */
export async function ensureEnv(cfg: ReviewConfig, snapshot: string, logPath: string, key?: string,
                                { mark = false, built = false, remember = false }:
                                { mark?: boolean; built?: boolean; remember?: boolean } = {}): Promise<string> {
  const tag = envTag(key ?? envKey(cfg, snapshot));
  if (!remember && failedBuilds.has(tag) && docker(["image", "inspect", tag]).status !== 0) throw failedBuilds.get(tag)!;
  try {
    return await sharedBuild(cfg, snapshot, logPath, tag, { mark, built });
  } catch (e) {
    if (remember && e instanceof EnvFailed && !e.network) failedBuilds.set(tag, e);
    throw e;
  }
}

/** Builds in progress, by tag: a second ask for a tag being built waits for that build, whoever asks (another project,
 * another session of the same review). A build that fails fails for every one waiting; nothing is kept once it ends. */
const building = new Map<string, { done: Promise<string>; logPath: string }>();

async function sharedBuild(cfg: ReviewConfig, snapshot: string, logPath: string, tag: string,
                           opts: { mark: boolean; built: boolean }): Promise<string> {
  if (opts.built) return ensureBuilt(cfg, snapshot, logPath, tag, opts);
  const running = building.get(tag);
  if (running) {
    dockerSteps.say?.(`${cfg.name}: waiting for the build of its test image`);
    try {
      const built = await running.done;
      // The build holds the builder's code: this snapshot's own files must count as newer than it.
      newerThanImage(cfg, snapshot);
      return built;
    } finally {
      // Whoever waited reads the same build log from its own place.
      if (running.logPath !== logPath && existsSync(running.logPath)) {
        try {
          mkdirSync(dirname(logPath), { recursive: true });
          copyFileSync(running.logPath, logPath);
        } catch {
          // the log is a convenience; the build's result stands
        }
      }
    }
  }
  const done = ensureBuilt(cfg, snapshot, logPath, tag, opts).finally(() => building.delete(tag));
  building.set(tag, { done, logPath });
  return done;
}

async function ensureBuilt(cfg: ReviewConfig, snapshot: string, logPath: string, tag: string,
                           { mark, built }: { mark: boolean; built: boolean }): Promise<string> {
  const t0 = performance.now();
  if (docker(["image", "inspect", tag]).status === 0) {
    stepLog({ step: "image", project: cfg.name, tag, built: false, secs: secsSince(t0) });
    newerThanImage(cfg, snapshot);
    return tag;
  }
  if (built) throw new ArnxError(`${cfg.name}: its test image is gone`);
  dockerSteps.say?.(`${cfg.name}: building its test image (minutes on a first build)`);
  const text = dockerfile(cfg, { cache: buildkit(), ...(mark ? { mark: tag } : {}) });
  const labels = envLabels(cfg);
  const context = buildContextOf(snapshot);
  // A build that does not finish is a failed environment like one that fails: its log says so, and the review goes on.
  const build = async () => {
    // What the image key leaves out (arnx's own folder, generated and kept tests, reports) is not built in either.
    const staged = withoutPaths(context, notCode(cfg, snapshot, ""));
    try {
      return await dockerAsync(["build", "-t", tag, ...labels, "-f", "-", staged], { timeout: stepTimeout(BUILD_TIMEOUT),
        stdin: text });
    } catch (e) {
      if (!(e instanceof ArnxError) || e instanceof SetupRequired || !/^docker build did not finish in /.test(e.message)) throw e;
      mkdirSync(dirname(logPath), { recursive: true });
      writeFileSync(logPath, `${e.message}\n`);
      stepLog({ step: "image", project: cfg.name, tag, built: true, ok: false, timeout: true, secs: secsSince(t0) });
      throw new EnvFailed(`${e.message}; see ${logPath}`, "build", basename(logPath));
    } finally {
      if (staged !== context) rmSync(staged, { recursive: true, force: true });
    }
  };
  let r = await build();
  stepLog({ step: "image", project: cfg.name, tag, built: true, ok: r.status === 0, secs: secsSince(t0) });
  mkdirSync(dirname(logPath), { recursive: true });
  writeFileSync(logPath, r.stdout + r.stderr);
  if (r.status !== 0) failIfDiskFull(r.stdout + r.stderr);
  // A build that failed because the package index could not be reached is tried once more: a dropped connection is
  // not a wrong install step.
  if (r.status !== 0 && NETWORK_TROUBLE.test(r.stdout + r.stderr)) {
    dockerSteps.say?.(`${cfg.name}: the package index did not answer; trying again in ${networkRetry.waitSeconds}s`);
    await sleep(networkRetry.waitSeconds * 1000);
    const t1 = performance.now();
    r = await build();
    stepLog({ step: "image", project: cfg.name, tag, built: true, ok: r.status === 0, retry: "network", secs: secsSince(t1) });
    writeFileSync(logPath, r.stdout + r.stderr);
  }
  if (r.status !== 0) {
    failIfDiskFull(r.stdout + r.stderr);
    if (NETWORK_TROUBLE.test(r.stdout + r.stderr)) {
      throw new EnvFailed("building the test environment failed because it could not reach the package index or " +
        "registry (timeouts or a broken connection, twice): a network problem, not the install steps. Keep the " +
        `configuration as it is and try again when the connection is stable; see ${logPath}`, "build",
      basename(logPath), true);
    }
    throw new EnvFailed(`building the test environment failed; see ${logPath}`, "build", basename(logPath));
  }
  if (adapterFor(cfg).keepBuild && context !== snapshot) newerThanBuild(snapshot, context);
  return tag;
}

export function runArgv(o: { image: string; name: string; network: string; snapshot: string; workdir: string;
  env: Record<string, string>; command: string; limits: Limits; user: string; runEnv: string[];
  /** Extra bind mounts, "host:container" (the code indexer's output folder). */
  mounts?: string[];
  /** Docker keeps no log of what it prints (a sealed run's): its log driver could keep or ship it. */
  noLog?: boolean }): string[] {
  const argv = [sandboxOptions.docker, "run", "--rm", "--name", o.name, "--network", o.network, ...o.noLog ? ["--log-driver", "none"] : [],
    "--cpus", o.limits.cpus, "--memory", o.limits.memory, "--memory-swap", o.limits.memory,
    "--pids-limit", String(o.limits.pids), "--cap-drop", "ALL", "--security-opt", "no-new-privileges",
    "--user", o.user, "--tmpfs", `/tmp:rw,exec,size=${o.limits.tmp}`,
    "-v", `${o.snapshot}:/src`, "-w", workdirIn("/src", o.workdir), "-e", "HOME=/tmp"];
  for (const m of o.mounts ?? []) argv.push("-v", m);
  for (const e of o.runEnv) argv.push("-e", e);
  for (const k of Object.keys(o.env).sort()) argv.push("-e", `${k}=${envValue(o.env[k]!)}`);
  return [...argv, o.image, "sh", "-c", o.command];
}

/** Whether a network's IPAM config (as JSON: as text, a missing gateway prints `invalid IP`) says it has no gateway. What
 * does not say so counts as having one. */
function hasNoGateway(config: string): boolean {
  try {
    const list: unknown = JSON.parse(config);
    return Array.isArray(list) && list.length > 0 &&
      list.every((c) => typeof c === "object" && c !== null && !(c as { Gateway?: unknown }).Gateway);
  } catch {
    return false;
  }
}

const live = new Set<Session>();

/** What a close may still ask of Docker while the process is going: `until` (performance.now() ms) ends it all, and `left`
 * gathers what Docker was not heard removing. */
interface Leaving { until: number; left: string[] }
/** Seconds for one Docker call while the process is going, and for all of them. A stalled client must not hold it: this
 * runs synchronously, and at exit no signal can stop it. */
const LEAVING_CALL = 3;
const LEAVING_TOTAL = 10;

/** One Docker call of a close, for `name`. While the process is going it is bounded, and one that gets no answer leaves
 * `name` named and null. */
function closing(args: string[], name: string, leaving?: Leaving): ReturnType<typeof docker> | null {
  if (!leaving) return docker(args);
  const seconds = (leaving.until - performance.now()) / 1000;
  try {
    if (seconds > 0) return docker(args, { timeout: Math.min(LEAVING_CALL, seconds) });
  } catch {
    // named below
  }
  leaving.left.push(name);
  return null;
}

/** Tear down every running session, for an interrupt and for any exit (main.ts): the process is going. Each is closed
 * whatever another's close does, within LEAVING_TOTAL; what may be left is said, and the first failure is thrown after. */
export function cleanupLiveSessions(): void {
  const leaving: Leaving = { until: performance.now() + LEAVING_TOTAL * 1000, left: [] };
  const failed: unknown[] = [];
  for (const s of [...live]) {
    try {
      s.close(leaving);
    } catch (e) {
      failed.push(e);
    }
  }
  // After the sessions: no run reads a copy any more.
  for (const dir of [...realKeyCopies]) if (removeTree(dir)) realKeyCopies.delete(dir);
  const { left } = leaving;
  if (left.length) {
    try {
      process.stderr.write(`arnx: Docker did not answer; these may still be there: ${left.slice(0, 3).join(", ")}` +
        `${left.length > 3 ? ` and ${left.length - 3} more` : ""}\n`);
    } catch {
      // no terminal left to tell
    }
  }
  if (failed.length) throw failed[0];
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
 * file arnx writes between runs (whoever holds a session waits for each run: nothing writes during one, and no two
 * runs overlap). Each run first touches, inside the
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
  /** Each run in flight: how to stop it, and its own container's name (none for a run in the shared one). */
  private running = new Set<{ stop: () => void; container: string | null }>();
  /** Closed by an interrupt: the process is exiting. */
  private exiting = false;

  /** `swap`: what a model's text means where this session runs. review.yaml and the commands keep their stand-ins, and so
   * do the logs; only what Docker gets, with this session's network, holds real values. An image's build has network and
   * never gets them. */
  constructor(readonly image: string, readonly cfg: ReviewConfig, readonly snapshot: string,
              readonly limits: Limits = DEFAULT_LIMITS, private readonly swap?: Swap) {
    this.network = cfg.services.length ? `arnx-${this.id}` : "none";
  }

  private real(text: string): string {
    return this.swap ? this.swap.text(text) : text;
  }

  private realEnv(env: Record<string, string>): Record<string, string> {
    return Object.fromEntries(Object.entries(env).map(([k, v]) => [k, this.real(v)]));
  }

  async start(): Promise<this> {
    live.add(this);
    const t0 = performance.now();
    try {
      if (this.cfg.services.length) {
        let r = this.createNetwork();
        if (r.status !== 0) throw new ArnxError(`docker network create failed: ${r.stderr.trim().slice(0, 200)}`);
        this.networkCreated = true;
        for (const svc of this.cfg.services) {
          const name = `arnx-${this.id}-${svc.name}`;
          const args = ["run", "-d", "--rm", "--name", name, "--network", this.network, "--network-alias", svc.name,
            "--cpus", "1", "--memory", "1g"];
          const env = this.realEnv(svc.env);
          for (const k of Object.keys(env).sort()) args.push("-e", `${k}=${envValue(env[k]!)}`);
          r = docker([...args, svc.image], { timeout: stepTimeout(900) });
          if (r.status !== 0) failIfDiskFull(r.stderr);
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

  /** The services' network: internal has no route out, and isolated gives it no address on this machine, so a test cannot
   * reach what listens here through a gateway (a database on 0.0.0.0). A Docker before 28 refuses or ignores that, which is
   * told plainly: the run goes on, as internal still keeps the outside away. */
  private createNetwork(): ReturnType<typeof docker> {
    let r = docker(["network", "create", "--internal", "-o", "com.docker.network.bridge.gateway_mode_ipv4=isolated",
      this.network]);
    let open = r.status !== 0;
    if (open) r = docker(["network", "create", "--internal", this.network]);
    if (r.status !== 0) return r;
    if (!open) {
      const seen = docker(["network", "inspect", this.network, "-f", "{{json .IPAM.Config}}"]);
      open = seen.status !== 0 || !hasNoGateway(seen.stdout);
    }
    if (open && !networkNotice.said) {
      networkNotice.said = true;
      stepLog({ step: "network", project: this.cfg.name, isolated: false });
      (dockerSteps.say ?? ((m: string) => void process.stderr.write(`${m}\n`)))(NETWORK_OPEN);
    }
    return r;
  }

  private async waitReady(container: string, service: string, ready: string): Promise<void> {
    const deadline = performance.now() + readyWait.seconds * 1000;
    while (performance.now() < deadline) {
      if (docker(["exec", container, "sh", "-c", this.real(ready)], { timeout: 30 }).status === 0) return;
      await sleep(1000);
    }
    throw new ArnxError(`service ${service} was not ready after ${readyWait.seconds}s (ready: ${ready})`);
  }

  /** `leaving`: the process goes next (an interrupt, an exit), and Docker gets only that long. A run in flight stops here:
   * Docker's client goes, and its container with it, since a client killed leaves its container running. */
  close(leaving?: Leaving): void {
    this.closed = true;
    this.exiting ||= !!leaving;
    const running = [...this.running];
    this.running.clear();
    for (const r of running) r.stop();
    if (!live.delete(this) && !running.length) return;
    for (const { container } of running) if (container) removeStarting(container, leaving);
    // Leaving, the shared container goes with the others below, under the same bound.
    if (leaving) this.box = null;
    else this.dropBox();
    for (const name of this.boxes) closing(["rm", "-fv", name], name, leaving);
    this.boxes.clear();
    for (const name of this.started) closing(["rm", "-fv", name], name, leaving);
    if (this.networkCreated) closing(["network", "rm", this.network], this.network, leaving);
  }

  run(command: string, timeout: number): Promise<RunResult> {
    return this.runIn(command, timeout, adapterFor(this.cfg).keepBuild?.emptied ?? null, "run");
  }

  /** One command of setup's exec tool: in the session's shared container whatever the language, so a build or a cache
   * one command leaves outside /src is there for the next (an image with an entrypoint: a new container each time). */
  exec(command: string, timeout: number): Promise<RunResult> {
    return this.runIn(command, timeout, adapterFor(this.cfg).keepBuild?.emptied ?? [], "exec");
  }

  /** One run in a container of its own with `src` at /src, `--network none` whatever the services, and stdout and stderr
   * never read: Docker's client writes them nowhere (realkey.ts). The command and the env are as a run's. */
  async sealed(command: string, timeout: number, src: string): Promise<SealedRun> {
    if (this.closed) return this.closedAnswer().then(() => ({ exitCode: null, timedOut: false }));
    timeout = stepTimeout(timeout);
    const name = `arnx-${this.id}-sealed-${randomHex(3)}`;
    const user = `${process.getuid?.() ?? 0}:${process.getgid?.() ?? 0}`;
    const argv = runArgv({ image: this.image, name, network: "none", snapshot: src, workdir: this.cfg.workdir,
      env: this.realEnv(this.cfg.env), command: this.real(depsLink(this.cfg) + command), limits: this.limits, user,
      runEnv: adapterFor(this.cfg).runEnv, noLog: true });
    const [bin, ...args] = argv;
    const started = performance.now();
    let entry: { stop: () => void; container: string | null } | undefined;
    const r = await spawned(bin!, args, timeout * 1000, (stop) => {
      entry = { stop, container: name };
      this.running.add(entry);
    }, { quiet: true });
    try {
      if (r.stopped) {
        await this.closedAnswer();
        return { exitCode: null, timedOut: false };
      }
      stepLog({ step: "sealed", project: this.cfg.name, secs: Math.round((performance.now() - started) / 100) / 10,
        timed_out: r.timedOut });
      if (r.notFound) throw new SetupRequired("Docker is not installed; arnx runs tests only inside Docker");
      if (r.timedOut) {
        try {
          await dockerAsync(["kill", name]);
        } catch {
          // close removes it
        }
        return { exitCode: null, timedOut: true };
      }
      return { exitCode: r.status, timedOut: false };
    } finally {
      this.running.delete(entry!);
    }
  }

  /** What a run gets when its session is closed. During an interrupt, no answer: what waits on it stops where it is, as
   * with a model call in flight, so no failed run reads as the code's, no review closes as failed and no model is asked
   * again before the exit. Otherwise an error, so nothing waits for ever. */
  private closedAnswer(): Promise<RunResult> {
    return this.exiting ? new Promise(() => {}) : Promise.reject(new ArnxError("the test session is closed"));
  }

  /** `emptied`: null runs the command in a new container; otherwise in the shared one, these directories emptied
   * first. */
  private async runIn(command: string, timeout: number, emptied: string[] | null, step: "run" | "exec")
    : Promise<RunResult> {
    // A closed session (an interrupt) starts no container that nothing would remove.
    if (this.closed) return this.closedAnswer();
    timeout = stepTimeout(timeout);
    command = depsLink(this.cfg) + command;
    if (!emptied || !this.mayShare()) {
      const name = `arnx-${this.id}-${step}-${randomHex(3)}`;
      return this.spawnRun(this.argv(name, this.real(command)), command, timeout, step, async () => {
        await dockerAsync(["kill", name]);
      }, name);
    }
    let r = await this.keptRun(command, timeout, emptied, step);
    // A container that went away (Docker restarted, removed by hand) is started again once; its build starts over.
    if (r.exitCode !== 0 && !r.timedOut && GONE.test(r.output.trim())) {
      if (this.closed) return this.closedAnswer();
      this.dropBox();
      r = await this.keptRun(command, timeout, emptied, step);
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
      workdir: this.cfg.workdir, env: this.realEnv(this.cfg.env), command, limits: this.limits, user,
      runEnv: adapterFor(this.cfg).runEnv });
  }

  /** One run in the session's shared container (started on first use, with every limit a run has). */
  private async keptRun(command: string, timeout: number, emptied: string[], step: "run" | "exec"): Promise<RunResult> {
    if (!this.box) {
      const name = `arnx-${this.id}-${step === "run" ? "build" : "exec"}-${randomHex(3)}`;
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
        failIfDiskFull(r.stderr);
        return { exitCode: r.status, ...kept(r.stdout + r.stderr), timedOut: false, seconds: seconds() };
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
    const wrapped = `rm -rf ${empty} 2>/dev/null; ${touch}sh -c ${shQuote(this.real(command))}; s=$?; kill -9 -1 2>/dev/null; ` +
      "exit $s";
    this.lastRun = Date.now();
    return this.spawnRun([sandboxOptions.docker, "exec", box, "sh", "-c", wrapped], command, timeout, step, async () => {
      // Killing docker exec leaves the run going inside: its processes go, the container and its build stay. A
      // container Docker cannot reach in time goes too: the run counts as timed out either way.
      try {
        const killed = await dockerAsync(["exec", box, "sh", "-c", KILL_ALL], { timeout: keptBox.dockerSeconds });
        if (killed.status === 0) return;
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
      if (docker(["rm", "-fv", box], { timeout: keptBox.dockerSeconds }).status === 0) this.boxes.delete(box);
    } catch {
      // close tries again
    }
  }

  /** `container`: the run's own container, removed if the session closes during the run. */
  private async spawnRun(argv: string[], command: string, timeout: number, step: "run" | "exec",
                         onTimeout: () => Promise<void>, container: string | null = null): Promise<RunResult> {
    const [bin, ...args] = argv;
    const started = performance.now();
    let entry: { stop: () => void; container: string | null } | undefined;
    const r = await spawned(bin!, args, timeout * 1000, (stop) => {
      entry = { stop, container };
      this.running.add(entry);
    });
    try {
      if (r.stopped) return await this.closedAnswer();
      const seconds = (performance.now() - started) / 1000;
      stepLog({ step, project: this.cfg.name, secs: Math.round(seconds * 10) / 10,
        timed_out: r.timedOut, exit: r.status, command: command.slice(0, 160) });
      if (r.notFound) throw new SetupRequired("Docker is not installed; arnx runs tests only inside Docker");
      if (r.timedOut) {
        // Still listed meanwhile: a signal now removes the container this kill may not reach.
        await onTimeout();
        if (this.closed) return await this.closedAnswer();
        const cut = kept(r.stdout, r.trimmed);
        return { exitCode: null, output: cut.output + "\n[timed out]", timedOut: true, seconds,
          ...(cut.truncated ? { truncated: true } : {}) };
      }
      // 125: Docker itself failed to start the container; a test's own exit code is not its to judge.
      if (r.status === 125) failIfDiskFull(r.stderr);
      return { exitCode: r.status, ...kept(r.stdout + r.stderr, r.trimmed), timedOut: false, seconds };
    } finally {
      this.running.delete(entry!);
    }
  }
}

/** Removes a run's container whose client was just killed. A start the client had already sent still makes it, moments
 * later and left "Created" for good, so until Docker says it removed one (it names it; with none there it says nothing, or
 * fails) it is asked again, for a little over a second. */
function removeStarting(name: string, leaving?: Leaving): void {
  for (const wait of [100, 200, 400, 800, 0]) {
    const r = closing(["rm", "-fv", name], name, leaving);
    if (!r || (r.status === 0 && r.stdout.trim()) || !wait) return;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, wait);
  }
}

/** How long a command that has exited gets to finish its output at its limit, ms. */
const EXITED_GRACE = 1000;

/** A command's exit and the ends of its output, without blocking; `started` gets what stops it at once. Output is read
 * as text across reads, so a character split between two stays whole, and each stream keeps at least OUTPUT_LIMIT
 * characters, all a run's answer uses, however much it prints. Past `ms` the command is killed. A killed command answers
 * as soon as it has gone, even if something it started still holds its output open.
 *
 * After the process was blocked (another project's step), a timer fires before what happened meanwhile is seen. So the
 * limit is judged one turn later: a command that had exited by then is not timed out, and its output has been read. */
export function spawned(bin: string, args: string[], ms: number, started: (stop: () => void) => void,
                        o: { quiet?: boolean } = {})
  : Promise<{ status: number | null; stdout: string; stderr: string; timedOut: boolean; stopped: boolean; notFound: boolean;
    trimmed: boolean }> {
  return new Promise((resolve) => {
    // `quiet`: the command's output goes nowhere, never read into this process.
    const child = spawn(bin, args, { stdio: o.quiet ? "ignore" : ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = "", status: number | null = null, exited = false, cut = false, timedOut = false,
      stopped = false, notFound = false, done = false, trimmed = false;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const tail = (s: string) => {
      if (s.length <= 2 * OUTPUT_LIMIT) return s;
      trimmed = true;
      return s.slice(-OUTPUT_LIMIT);
    };
    child.stdout?.setEncoding("utf8").on("data", (t: string) => { stdout = tail(stdout + t); });
    child.stderr?.setEncoding("utf8").on("data", (t: string) => { stderr = tail(stderr + t); });
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearTimeout(grace);
      resolve({ status, stdout, stderr, timedOut, stopped, notFound, trimmed });
    };
    const kill = () => {
      cut = true;
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      if (exited) finish();
    };
    const timer = setTimeout(() => setImmediate(() => {
      if (done) return;
      if (exited) {
        grace = setTimeout(kill, EXITED_GRACE);
        return;
      }
      timedOut = true;
      kill();
    }), ms);
    child.on("error", (e: NodeJS.ErrnoException) => {
      notFound = e.code === "ENOENT";
      finish();
    });
    child.on("exit", (code) => {
      exited = true;
      status = code;
      if (cut) finish();
    });
    child.on("close", (code) => {
      if (!exited) status = code;
      finish();
    });
    started(() => {
      stopped = true;
      kill();
      finish();
    });
  });
}

/** What setup's exec tool runs its commands in (Session.exec), closed at the end of setup. */
export interface ExecRunner { exec(command: string, timeout: number): RunResult | Promise<RunResult>; close(): void }
/** A started ExecRunner on `image` with `cfg`'s services and environment, `src` mounted at /src; null when the image
 * is not there: exec builds no image. */
export type ExecFactory = (image: string, cfg: ReviewConfig, src: string, swap?: Swap) => Promise<ExecRunner | null>;

export const dockerExec: ExecFactory = async (image, cfg, src, swap) => {
  requireDocker();
  if (docker(["image", "inspect", image]).status !== 0) return null;
  return new Session(image, cfg, src, DEFAULT_LIMITS, swap).start();
};
