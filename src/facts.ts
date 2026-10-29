// Facts a repository's files settle without a model, for the setup draft (draft.ts): tool versions, package
// managers, the workspace a project installs from, CI jobs (GitHub Actions; GitLab CI best effort), compose and CI
// services, Dockerfile base images and example env files. Each fact names the file it came from.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import { parse as parseYaml } from "yaml";
import type { Candidate } from "./detect";

export interface Fact { value: string; from: string }
export type Tool = "node" | "python" | "rust" | "bun";

/** A database or broker the tests can reach by name. */
export interface ServiceFact { name: string; image: string; kind: string | null; env: Record<string, string>;
  from: string }

export interface CiJob {
  /** <file>:<job id> */
  id: string;
  /** Directories its steps run in, relative to the repository root ("." when none is named). */
  dirs: string[];
  versions: Partial<Record<Tool, string>>;
  services: ServiceFact[];
  env: Record<string, string>;
  install: string[];
  test: string[];
  apt: string[];
  /** The languages it sets up or tests (none named: any). */
  languages: string[];
  /** Text of its commands, to find the projects it names. */
  text: string;
}

export interface ProjectFacts {
  root: string;
  language: string;
  versions: Partial<Record<Tool, Fact>>;
  manager: Fact | null;
  /** Where install runs: the directory of the lockfile or workspace the project installs from. */
  installRoot: string;
  /** The lockfile, relative to installRoot. */
  lockfile: string | null;
  /** Python: requirement files under root, relative to it; extras and dependency groups for tests. */
  requirements: string[];
  extras: string[];
  groups: string[];
  /** Python: root itself installs (a build system or setup.py). */
  installable: boolean;
  /** JavaScript: install scripts or patches that need more than package.json and the lockfile. */
  needsTree: boolean;
  /** JavaScript: package manager settings next to the lockfile that install needs too. */
  copy: string[];
  /** The ids of the CI jobs that run in root or name it. */
  jobs: string[];
  /** Names from Facts.services this project's tests need (a CI test job or a test compose file starts them), and ones
   * its code may use (its dependencies, a compose file for running it), each with why. */
  services: Fact[];
  maybeServices: Fact[];
  /** Test variables from CI or compose that point at those services. */
  env: Record<string, string>;
  /** Variable names in example env files under root. */
  envNames: string[];
  /** System packages CI installs for it, and ones its Cargo.lock suggests. */
  apt: string[];
  lockApt: string[];
  /** Dependency names that hint at the test setup (ts-node, tsx). */
  deps: string[];
}

export interface Facts { projects: ProjectFacts[]; jobs: CiJob[]; services: ServiceFact[] }

/** Setup sets up no project whose tests need this many services or more (databases, caches, object stores, queues):
 * such a backend does not run within setup's time. Counted on what the files say its tests need, not on what an
 * agent lists: a project its files gave two proved with a third. */
export const MANY_SERVICES = 3;

/** The services `f`'s tests need when they reach MANY_SERVICES, else null. A project at the repository root is left
 * out: a CI job there may test another folder. */
export function manyServices(f: ProjectFacts): string[] | null {
  return f.root !== "." && f.services.length >= MANY_SERVICES ? f.services.map((s) => s.value) : null;
}

/** Why such a project is under uncovered: "needs postgres, redis and minio; setup does not start three or more
 * services: set it up by hand, or with fewer". */
export function manyServicesReason(names: string[]): string {
  const all = names.length > 1 ? `${names.slice(0, -1).join(", ")} and ${names.at(-1)}` : names.join("");
  return `needs ${all}; setup does not start three or more services: set it up by hand, or with fewer`;
}

type Raw = Record<string, unknown>;
const isMap = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown) => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null);
const dirOf = (p: string) => posix.dirname(p);
const at = (dir: string, name: string) => (dir === "." ? name : `${dir}/${name}`);
const ancestors = (dir: string): string[] => {
  const out = [dir];
  while (dir !== ".") {
    dir = dirOf(dir);
    out.push(dir);
  }
  return out;
};
const EXPR = /\$\{\{|\$\{?[A-Za-z_]/;

/** Service kinds by image name, with the client libraries that use them (npm, PyPI and crates names). */
const KINDS: [string, RegExp, RegExp][] = [
  ["postgres", /(^|\/)(postgres|postgis|timescaledb|pgvector)[^/]*$/,
    /^(pg|postgres|pg-promise|psycopg2?(-binary)?|asyncpg|tokio-postgres|postgres-types|pgvector|sqlx-postgres)$/],
  ["mysql", /(^|\/)(mysql|mariadb)[^/]*$/, /^(mysql|mysql2|pymysql|mysqlclient|aiomysql|mysql_async)$/],
  ["redis", /(^|\/)(redis|valkey)[^/]*$/, /^(redis|ioredis|aioredis|bullmq|bull|fakeredis|redis-om)$/],
  ["mongo", /(^|\/)mongo[^/]*$/, /^(mongodb|mongoose|pymongo|motor|mongoengine)$/],
  ["rabbitmq", /(^|\/)rabbitmq[^/]*$/, /^(amqplib|amqp-connection-manager|pika|aio-pika|aio_pika|lapin|kombu)$/],
  ["elasticsearch", /(^|\/)(elasticsearch|opensearch)[^/]*$/, /^(@elastic\/elasticsearch|elasticsearch|opensearch-py)$/],
  ["minio", /(^|\/)minio[^/]*$/, /^(minio)$/],
  ["memcached", /(^|\/)memcached[^/]*$/, /^(memjs|pymemcache|python-memcached)$/],
  ["nats", /(^|\/)nats[^/]*$/, /^(nats|nats-py|async-nats)$/],
  ["kafka", /(^|\/)(kafka|cp-kafka|redpanda)[^/]*$/, /^(kafkajs|kafka-python|aiokafka|confluent-kafka|rdkafka)$/],
  ["clickhouse", /(^|\/)clickhouse[^/]*$/, /^(@clickhouse\/client|clickhouse-connect|clickhouse-driver)$/],
  ["localstack", /(^|\/)localstack[^/]*$/, /^$/],
];
export const kindOf = (image: string) =>
  KINDS.find(([, rx]) => rx.test(image.split(":")[0]!.split("@")[0]!))?.[0] ?? null;

/** Version ranges to the version a project most likely runs on: the preferred one when the range allows it, else the
 * highest allowed. */
const NODE_PREFERRED = ["22", "24", "20", "18", "16", "14"];
const PYTHON_PREFERRED = ["3.12", "3.13", "3.11", "3.10", "3.14", "3.9", "3.8"];

/** Whether version `v` (dotted) satisfies a simple range: comparators (>=, >, <=, <, ==, ~=, ^, ~, x wildcards) joined
 * by spaces or commas, alternatives by ||. Unknown syntax satisfies. */
export function satisfies(v: string, range: string): boolean {
  const num = (s: string) => s.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const cmp = (a: string, b: string) => {
    const x = num(a), y = num(b);
    for (let i = 0; i < Math.max(x.length, y.length); i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) - (y[i] ?? 0);
    return 0;
  };
  const prefix = (a: string, b: string) => num(b).every((n, i) => (num(a)[i] ?? 0) === n);
  return range.split("||").some((alt) => alt.trim().split(/[\s,]+/).filter(Boolean).every((c) => {
    const m = /^(>=|<=|==|~=|!=|>|<|=|\^|~)?\s*v?([\d.x*]+)/.exec(c);
    if (!m) return true;
    const op = m[1] ?? "", w = m[2]!.replace(/\.?[x*].*$/, "");
    if (!w) return true;
    switch (op) {
      case ">=": return cmp(v, w) >= 0;
      case ">": return cmp(v, w) > 0 && !prefix(v, w);
      case "<=": return cmp(v, w) <= 0 || prefix(v, w);
      case "<": return cmp(v, w) < 0;
      case "!=": return !prefix(v, w);
      case "^": return num(v)[0] === num(w)[0] && (cmp(v, w) >= 0 || prefix(w, v));
      case "~": case "~=": {
        const keep = op === "~=" ? Math.max(1, num(w).length - 1) : Math.min(2, num(w).length);
        return num(v).slice(0, keep).every((n, i) => n === num(w)[i]) || prefix(w, v);
      }
      default: return prefix(v, w);
    }
  }));
}
const pickIn = (range: string, preferred: string[]) => preferred.find((v) => satisfies(v, range)) ?? null;

/** A version as an image tag: node majors, python and rust major.minor (patch kept when given). */
function cleanVersion(tool: Tool, raw: string): string | null {
  const v = raw.trim().replace(/^v/, "").replace(/^python-?/, "");
  if (tool === "node") {
    const m = /^(\d+)(\.\d+){0,2}$/.exec(v) ?? /^(\d+)\.x$/.exec(v);
    return m ? m[1]! : null;
  }
  if (tool === "python") return /^3\.\d+(\.\d+)?$/.test(v) ? v : /^3\.\d+\.x$/.test(v) ? v.slice(0, -2) : null;
  if (tool === "rust") return /^1\.\d+(\.\d+)?$/.test(v) ? v : null;
  return /^\d+(\.\d+){0,2}$/.test(v) ? v : null;
}

/** Parsers that never throw: a file that does not read gives nothing. */
function parsed<T>(f: () => T): T | null {
  try {
    return f();
  } catch {
    return null;
  }
}

/** What test code says when it talks to a service. */
const TEST_USES: [string, RegExp][] = [
  ["postgres", /postgres(ql)?(\+\w+)?:\/\/|\bpsycopg|\basyncpg\b|\bPG(HOST|DATABASE|USER)\b|DATABASE_URL/],
  ["mysql", /\bmysql(\+\w+)?:\/\/|\bpymysql\b/],
  ["redis", /\brediss?:\/\/|\bREDIS_(URL|HOST)\b/],
  ["mongo", /\bmongodb(\+srv)?:\/\//],
  ["rabbitmq", /\bamqps?:\/\//],
];
/** Images for a service the tests use that no file names. */
const DEFAULT_IMAGES: Record<string, string> = { postgres: "postgres:16", mysql: "mysql:8", redis: "redis:7",
  mongo: "mongo:7", rabbitmq: "rabbitmq:3" };

interface Files {
  set: Set<string>;
  read: (rel: string) => string;
  json: (rel: string) => unknown;
  toml: (rel: string) => Raw | null;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const TOOLS: Tool[] = ["node", "python", "rust", "bun"];

/** Facts for every candidate, read from the files a snapshot holds (`paths`); `tests`: each candidate's own test
 * files. */
export function readFacts(repo: string, paths: string[], candidates: Candidate[],
                          tests: Map<Candidate, string[]> = new Map()): Facts {
  const set = new Set(paths);
  const cache = new Map<string, string>();
  const read = (rel: string) => {
    if (!set.has(rel)) return "";
    if (!cache.has(rel)) {
      let text = "";
      try {
        text = readFileSync(join(repo, rel), "utf8");
      } catch {
        // unreadable: no facts from it
      }
      cache.set(rel, text);
    }
    return cache.get(rel)!;
  };
  const files: Files = { set, read, json: (rel) => parsed(() => JSON.parse(read(rel) || "null") as unknown),
    toml: (rel) => (read(rel) ? parsed(() => parseToml(read(rel)) as Raw) : null) };
  const yaml = (rel: string) =>
    read(rel) ? parsed(() => parseYaml(read(rel), { uniqueKeys: false, logLevel: "silent" }) as unknown) : null;

  const jobs = [...githubJobs(paths, yaml, read), ...gitlabJobs(set, yaml)];
  const compose = composeFacts(paths, yaml);
  // Every service a CI job starts is one its tests use; of compose's, only databases and brokers.
  const services: ServiceFact[] = [];
  for (const s of [...jobs.flatMap((j) => j.services), ...compose.services.filter((x) => x.kind)]) {
    if (!services.some((x) => x.name === s.name)) services.push(s);
  }
  const docker = dockerImages(paths, read);

  const projects = candidates.map((c): ProjectFacts => {
    const ups = ancestors(c.root);
    const named = new RegExp(`(^|[\\s/'"=])${escape(c.root)}(/|\\s|$|['"])`);
    const fits = (j: CiJob) => !j.languages.length || j.languages.includes(c.language);
    // Jobs that run tests first: their versions are the ones tests run on.
    const testsFirst = (js: CiJob[]) => [...js.filter((j) => j.test.length), ...js.filter((j) => !j.test.length)];
    const tied = testsFirst(jobs.filter((j) => fits(j) &&
      (j.dirs.includes(c.root) || (c.root !== "." && named.test(j.text)))));
    const above = testsFirst(jobs.filter((j) => fits(j) && !tied.includes(j) && j.dirs.some((d) => ups.includes(d))));
    const f: ProjectFacts = { root: c.root, language: c.language,
      versions: versionsOf(ups, [...tied, ...above], jobs, docker.get(c.root) ?? [], files), manager: null,
      installRoot: c.root, lockfile: null, requirements: [], extras: [], groups: [], installable: false,
      needsTree: false, copy: [], jobs: tied.map((j) => j.id), services: [], maybeServices: [], env: {}, envNames: [],
      apt: [...new Set(tied.flatMap((j) => j.apt))], lockApt: [], deps: [] };
    if (c.language === "typescript") jsFacts(f, ups, paths, files);
    else if (c.language === "python") pythonFacts(f, ups, paths, files);
    else if (c.language === "rust") rustFacts(f, ups, files);
    const deps = dependencyNames(f, c, files);
    f.deps = deps.filter((d) => /^(ts-node|tsx|@swc\/register|esbuild-register)$/.test(d));
    const testText = [...(tests.get(c) ?? []).slice(0, 40), at(c.root, "conftest.py"), at(c.root, "tests/conftest.py")]
      .map(read).join("\n");
    servicesOf(f, deps, testText, tied, compose.apps.filter((a) => a.dir === c.root), services);
    for (const name of [".env.example", ".env.sample", ".env.template", ".env.test", ".env.dist", "env.example"]) {
      for (const m of read(at(c.root, name)).matchAll(/^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=/gm)) {
        if (!f.envNames.includes(m[1]!)) f.envNames.push(m[1]!);
      }
    }
    return f;
  });
  return { projects, jobs, services };
}

/** The versions a project runs on: pins next to it or above it first, then the CI jobs that run it, the image it
 * ships in, the ranges its manifests declare, and versions every CI job agrees on. */
function versionsOf(ups: string[], ownJobs: CiJob[], jobs: CiJob[], images: Fact[], { read, json, toml }: Files)
  : Partial<Record<Tool, Fact>> {
  const versions: Partial<Record<Tool, Fact>> = {};
  const set1 = (tool: Tool, raw: string | null | undefined, from: string) => {
    if (versions[tool] || !raw) return;
    const v = cleanVersion(tool, raw);
    if (v) versions[tool] = { value: v, from };
  };
  for (const d of ups) {
    for (const file of [".nvmrc", ".node-version"]) set1("node", read(at(d, file)), at(d, file));
    set1("python", read(at(d, ".python-version")).split("\n")[0], at(d, ".python-version"));
    set1("python", read(at(d, "runtime.txt")), at(d, "runtime.txt"));
    const tv = Object.fromEntries(read(at(d, ".tool-versions")).split("\n").map((l) => l.trim().split(/\s+/))
      .filter((p) => p.length >= 2).map((p) => [p[0], p[1]]));
    for (const [tool, name] of [["node", tv.nodejs ?? tv.node], ["python", tv.python], ["rust", tv.rust],
      ["bun", tv.bun]] as [Tool, string | undefined][]) set1(tool, name, at(d, ".tool-versions"));
    for (const file of ["rust-toolchain.toml", "rust-toolchain"]) {
      const text = read(at(d, file));
      set1("rust", text ? (/channel\s*=\s*"([^"]+)"/.exec(text)?.[1] ?? text.trim().split("\n")[0]) : null, at(d, file));
    }
    const pkg = json(at(d, "package.json"));
    if (isMap(pkg)) {
      if (isMap(pkg.volta)) set1("node", str(pkg.volta.node), at(d, "package.json"));
      const pm = str(pkg.packageManager);
      if (pm?.startsWith("bun@")) set1("bun", pm.slice(4).split("+")[0]!, at(d, "package.json"));
    }
  }
  for (const j of ownJobs) for (const t of TOOLS) set1(t, j.versions[t], j.id);
  for (const img of images) {
    const m = /^(?:docker\.io\/)?(?:library\/)?(node|python|rust|oven\/bun):v?([\d.]+)/.exec(img.value);
    if (m) set1(m[1] === "oven/bun" ? "bun" : m[1] as Tool, m[2]!, `${img.from} (the image it ships in)`);
  }
  for (const d of ups) {
    const pkg = json(at(d, "package.json"));
    const engines = isMap(pkg) && isMap(pkg.engines) ? str(pkg.engines.node) : null;
    if (engines) set1("node", pickIn(engines, NODE_PREFERRED), `${at(d, "package.json")} engines`);
    const py = toml(at(d, "pyproject.toml"));
    const project = isMap(py?.project) ? py.project : {};
    const poetry = isMap(py?.tool) && isMap(py.tool.poetry) ? py.tool.poetry : {};
    const range = str(project["requires-python"]) ??
      (isMap(poetry.dependencies) ? str(poetry.dependencies.python) : null);
    if (range) set1("python", pickIn(range, PYTHON_PREFERRED), `${at(d, "pyproject.toml")} python range ${range}`);
    set1("python", /python_version\s*=\s*"([\d.]+)"/.exec(read(at(d, "Pipfile")))?.[1], at(d, "Pipfile"));
    const setup = /python_requires\s*=\s*["']([^"']+)/.exec(read(at(d, "setup.py")) + read(at(d, "setup.cfg")))?.[1];
    if (setup) set1("python", pickIn(setup, PYTHON_PREFERRED), `${at(d, "setup.py")} python range ${setup}`);
  }
  for (const t of TOOLS) {
    const all = [...new Set(jobs.map((j) => j.versions[t]).filter((v): v is string => !!v))];
    if (all.length === 1) set1(t, all[0], jobs.find((j) => j.versions[t])!.id);
  }
  return versions;
}

/** The services a project's tests need: the ones the CI jobs that test it start, and the kind its test code connects
 * to when it depends on a client of it (the one the files define, else a stock image, added to `services`). The ones
 * its code may use (a compose file for running it, its dependencies) go to maybeServices. Then the test variables
 * that point at them, host names moved from localhost to the service's name. */
function servicesOf(f: ProjectFacts, deps: string[], testText: string, tied: CiJob[], apps: ComposeApp[],
                    services: ServiceFact[]) {
  const kind = (name: string) => services.find((s) => s.name === name)?.kind;
  const add = (name: string, why: string) => {
    if (!f.services.some((s) => s.value === name)) f.services.push({ value: name, from: why });
  };
  const maybe = (name: string, why: string) => {
    if (![...f.services, ...f.maybeServices].some((s) => s.value === name)) f.maybeServices.push({ value: name, from: why });
  };
  const client = (k: string) => deps.some((d) => KINDS.find(([x]) => x === k)![2].test(d));
  for (const j of tied.filter((x) => x.test.length)) for (const s of j.services) add(s.name, `${j.id} starts it`);
  for (const [k, rx] of TEST_USES) {
    if (!rx.test(testText) || !client(k) || f.services.some((x) => kind(x.value) === k)) continue;
    let s = services.find((x) => x.kind === k);
    if (!s) {
      s = { name: k, image: DEFAULT_IMAGES[k]!, kind: k, env: {}, from: "its tests" };
      services.push(s);
    }
    add(s.name, `its tests connect to ${k}`);
  }
  for (const app of apps) {
    for (const n of app.dependsOn) if (services.some((s) => s.name === n)) maybe(n, `${app.from} depends on it`);
  }
  for (const s of services) {
    const known = [...f.services, ...f.maybeServices].some((x) => kind(x.value) === s.kind);
    if (!known && s.kind && client(s.kind)) maybe(s.name, `its dependencies use ${s.kind}`);
  }
  const mine = services.filter((s) => f.services.some((x) => x.value === s.name));
  const point = (v: string) => {
    for (const s of mine) {
      const port = PORTS[s.kind ?? ""];
      const local = new RegExp(`(localhost|127\\.0\\.0\\.1):${port}\\b`);
      if (port && local.test(v)) return v.replace(local, `${s.name}:${port}`);
    }
    return mine.some((s) => v === s.name || new RegExp(`(@|//)${escape(s.name)}(:\\d+)?(/|$)`).test(v)) ? v : null;
  };
  for (const env of [...tied.map((j) => j.env), ...apps.map((a) => a.env)]) {
    for (const [k, v] of Object.entries(env)) {
      const pointed = point(v);
      if (pointed !== null && !(k in f.env) && !EXPR.test(pointed)) f.env[k] = pointed;
    }
  }
}

const PORTS: Record<string, string> = { postgres: "5432", mysql: "3306", redis: "6379", mongo: "27017",
  rabbitmq: "5672", elasticsearch: "9200", minio: "9000", memcached: "11211", nats: "4222", kafka: "9092",
  clickhouse: "8123", localstack: "4566" };

const JS_LOCKS: [string, string][] = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"],
  ["bun.lockb", "bun"], ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"]];

function jsFacts(f: ProjectFacts, ups: string[], paths: string[], { set, json, read: readText }: Files) {
  // The nearest lockfile decides where install runs and with what, unless a workspace above lists the project: then
  // the workspace's own lockfile does (one inside a member is usually stale).
  const member = ups.slice(1).find((d) => {
    const pkg = json(at(d, "package.json"));
    const globs = isMap(pkg) ? (Array.isArray(pkg.workspaces) ? pkg.workspaces
      : isMap(pkg.workspaces) && Array.isArray(pkg.workspaces.packages) ? pkg.workspaces.packages : []) : [];
    const pnpm = /packages:\s*((?:\n\s*-\s*.*)+|\[[^\]]*\])/.exec(set.has(at(d, "pnpm-workspace.yaml"))
      ? readText(at(d, "pnpm-workspace.yaml")) : "")?.[1] ?? "";
    const all = [...globs.map(String), ...[...pnpm.matchAll(/['"]?([^\s'",\[\]-][^\s'",\]]*)['"]?/g)].map((m) => m[1]!)];
    const rel = d === "." ? f.root : f.root.slice(d.length + 1);
    return all.some((g) => !g.startsWith("!") && globDir(g.replace(/^\.\//, "").replace(/\/$/, "")).test(rel)) &&
      JS_LOCKS.some(([file]) => set.has(at(d, file)));
  });
  for (const d of member ? [member] : ups) {
    const lock = JS_LOCKS.find(([file]) => set.has(at(d, file)));
    if (lock) {
      f.installRoot = d;
      f.lockfile = lock[0];
      f.manager = { value: lock[1], from: at(d, lock[0]) };
      break;
    }
  }
  if (!f.lockfile) {
    for (const d of ups.slice(1)) {
      const pkg = json(at(d, "package.json"));
      if ((isMap(pkg) && pkg.workspaces) || set.has(at(d, "pnpm-workspace.yaml"))) {
        f.installRoot = d;
        break;
      }
    }
  }
  const top = json(at(f.installRoot, "package.json"));
  const pm = isMap(top) ? str(top.packageManager) : null;
  if (pm && /^(npm|pnpm|yarn|bun)@/.test(pm)) {
    const [name, version] = pm.split("@") as [string, string];
    const berry = name === "yarn" && !version.startsWith("1.");
    f.manager = { value: berry ? "yarn-berry" : name, from: `${at(f.installRoot, "package.json")} packageManager` };
  } else if (f.manager?.value === "yarn" && set.has(at(f.installRoot, ".yarnrc.yml"))) {
    f.manager = { value: "yarn-berry", from: at(f.installRoot, ".yarnrc.yml") };
  }
  if (!f.manager) f.manager = { value: "npm", from: "no lockfile" };
  f.copy = [".npmrc", ".yarnrc", ".yarnrc.yml", ".pnpmfile.cjs"].filter((x) => set.has(at(f.installRoot, x)));
  if (paths.some((p) => p.startsWith(at(f.installRoot, ".yarn/")))) f.copy.push(".yarn");
  if (isMap(top)) {
    const scripts = isMap(top.scripts) ? top.scripts : {};
    f.needsTree = f.installRoot !== f.root || ["preinstall", "install", "postinstall", "prepare"].some((k) => k in scripts) ||
      "patchedDependencies" in top || (isMap(top.pnpm) && "patchedDependencies" in top.pnpm);
  }
}

const PY_LOCKS: [string, string][] = [["uv.lock", "uv"], ["poetry.lock", "poetry"], ["pdm.lock", "pdm"],
  ["Pipfile.lock", "pipenv"], ["Pipfile", "pipenv"]];
const TEST_EXTRA = /^(test|tests|testing|dev|develop|development|all-tests)$/;

function pythonFacts(f: ProjectFacts, ups: string[], paths: string[], { set, toml, read }: Files) {
  for (const d of ups) {
    const lock = PY_LOCKS.find(([file]) => set.has(at(d, file)));
    if (lock) {
      f.installRoot = d;
      f.lockfile = lock[0];
      f.manager = { value: lock[1], from: at(d, lock[0]) };
      break;
    }
  }
  const py = toml(at(f.root, "pyproject.toml"));
  const tool = isMap(py?.tool) ? py.tool : {};
  if (!f.manager && isMap(tool.poetry)) f.manager = { value: "poetry", from: at(f.root, "pyproject.toml") };
  if (!f.manager && isMap(tool.uv)) f.manager = { value: "uv", from: at(f.root, "pyproject.toml") };
  if (!f.manager) f.manager = { value: "pip", from: "no lockfile" };
  if (f.manager.value !== "uv" && f.manager.value !== "poetry") f.installRoot = f.root;
  const project = isMap(py?.project) ? py.project : {};
  const extras = isMap(project["optional-dependencies"]) ? Object.keys(project["optional-dependencies"]) : [];
  f.extras = extras.filter((e) => TEST_EXTRA.test(e));
  const groups = [...isMap(py?.["dependency-groups"]) ? Object.keys(py["dependency-groups"]) : [],
    ...isMap(tool.poetry) && isMap(tool.poetry.group) ? Object.keys(tool.poetry.group) : []];
  f.groups = groups.filter((g) => TEST_EXTRA.test(g));
  f.installable = (!!py && (isMap(py["build-system"]) || isMap(tool.poetry))) || set.has(at(f.root, "setup.py")) ||
    (set.has(at(f.root, "setup.cfg")) && /\[metadata\]/.test(read(at(f.root, "setup.cfg"))));
  const reqs = paths.filter((p) => dirOf(p) === f.root || dirOf(p) === at(f.root, "requirements"))
    .map((p) => (f.root === "." ? p : p.slice(f.root.length + 1)))
    .filter((p) => /^(requirements\/)?[^/]*requirements[^/]*\.txt$|^requirements\/[^/]+\.txt$/.test(p))
    .filter((p) => !/doc|lint|typ|mypy|release|publish|build|prod/i.test(p));
  const base = reqs.filter((p) => /^requirements\.txt$|^requirements\/(base|common|main)\.txt$/.test(p));
  const tests = reqs.filter((p) => /test|dev/i.test(p));
  f.requirements = [...base, ...tests.filter((p) => !base.includes(p))];
}

/** Crates whose build needs a system tool, by the package that needs it. */
const RUST_APT: [RegExp, string[]][] = [[/^name = "prost-build"$/m, ["protobuf-compiler"]],
  [/^name = "bindgen"$/m, ["clang", "libclang-dev"]], [/^name = "cmake"$/m, ["cmake"]]];

function rustFacts(f: ProjectFacts, ups: string[], { set, toml, read }: Files) {
  f.manager = { value: "cargo", from: at(f.root, "Cargo.toml") };
  // The workspace whose members include this crate (the crate itself when it is the workspace root).
  for (const d of ups) {
    const ws = toml(at(d, "Cargo.toml"))?.workspace;
    if (!isMap(ws)) continue;
    const members = Array.isArray(ws.members) ? ws.members.map(String) : [];
    const exclude = Array.isArray(ws.exclude) ? ws.exclude.map(String) : [];
    const rel = d === "." ? f.root : f.root.slice(d.length + 1);
    const match = (g: string) => globDir(g.replace(/\/$/, "")).test(rel);
    if (d === f.root || (members.some(match) && !exclude.some(match))) {
      f.installRoot = d;
      break;
    }
  }
  if (set.has(at(f.installRoot, "Cargo.lock"))) f.lockfile = "Cargo.lock";
  const lock = read(at(f.installRoot, "Cargo.lock"));
  f.lockApt = RUST_APT.filter(([rx]) => rx.test(lock)).flatMap(([, p]) => p)
    .filter((p) => p !== "protobuf-compiler" || !/^name = "protobuf-src"$/m.test(lock));
}

/** A Cargo or package.json workspace member pattern as a regex over directories. */
const globDir = (g: string) => new RegExp(`^${g.split("/").map((s) => s === "**" ? ".*" :
  s.replace(/[.+^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]")).join("/")}$`);

/** Names the project depends on, for telling which services its tests use. */
function dependencyNames(f: ProjectFacts, c: Candidate, { read, json, toml }: Files): string[] {
  const out = new Set<string>();
  if (c.language === "typescript") {
    const pkg = json(c.manifest);
    if (isMap(pkg)) {
      for (const k of ["dependencies", "devDependencies", "optionalDependencies"]) {
        if (isMap(pkg[k])) for (const n of Object.keys(pkg[k])) out.add(n);
      }
    }
  } else if (c.language === "python") {
    const lines = [...f.requirements.map((r) => read(at(c.root, r))), read(at(c.root, "pyproject.toml")),
      read(at(c.root, "setup.py")), read(at(c.root, "setup.cfg")), read(at(c.root, "Pipfile"))].join("\n");
    for (const m of lines.matchAll(/^[\s"']*([A-Za-z0-9][A-Za-z0-9._-]*)/gm)) out.add(m[1]!.toLowerCase());
    for (const m of lines.matchAll(/["']([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:[<>=!~;]|["'])/g)) {
      out.add(m[1]!.toLowerCase());
    }
  } else if (c.language === "rust") {
    const cargo = toml(c.manifest);
    for (const k of ["dependencies", "dev-dependencies"]) {
      const deps = cargo?.[k];
      if (!isMap(deps)) continue;
      for (const [n, spec] of Object.entries(deps)) {
        out.add(n);
        if (n === "sqlx" && isMap(spec) && Array.isArray(spec.features) && spec.features.includes("postgres")) {
          out.add("sqlx-postgres");
        }
      }
    }
  }
  return [...out];
}

const INSTALL = /\b(npm (ci|install|i)\b|pnpm (i|install)\b|yarn( install)?\s*($|--)|bun install|pip3? install|uv (sync|pip install)|poetry install|pipenv install|pdm (install|sync)|cargo (install|fetch|build))/;
const TEST = /\b(pytest|vitest|jest|mocha|node --test|bun test|cargo (test|nextest)|(npm|pnpm|yarn|bun)( run)? test\b|tox\b|nox\b|make test)/;

/** GitHub Actions jobs: their versions, services, env and commands. */
function githubJobs(paths: string[], yaml: (rel: string) => unknown, read: (rel: string) => string): CiJob[] {
  const out: CiJob[] = [];
  for (const file of paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p))) {
    const wf = yaml(file);
    if (!isMap(wf) || !isMap(wf.jobs)) continue;
    const wfEnv = strEnv(wf.env);
    const wfDir = isMap(wf.defaults) && isMap(wf.defaults.run) ? str(wf.defaults.run["working-directory"]) : null;
    for (const [id, job] of Object.entries(wf.jobs)) {
      if (!isMap(job)) continue;
      const matrix = isMap(job.strategy) && isMap(job.strategy.matrix) ? job.strategy.matrix : {};
      const env = { ...wfEnv, ...strEnv(job.env) };
      const resolve = (v: string | null): string | null => {
        if (!v) return null;
        const r = v.replace(/\$\{\{\s*(matrix|env)\.([\w-]+)\s*\}\}/g, (_, scope: string, key: string) => {
          if (scope === "env") return env[key] ?? "";
          const vals = Array.isArray(matrix[key]) ? (matrix[key] as unknown[]).map(str).filter((x): x is string => !!x)
            : [];
          // The newest version the matrix tries.
          return vals.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1) ?? "";
        });
        return /\$\{\{/.test(r) || !r ? null : r;
      };
      const jobDir = isMap(job.defaults) && isMap(job.defaults.run) ? str(job.defaults.run["working-directory"]) : wfDir;
      const j: CiJob = { id: `${file}:${id}`, dirs: [], versions: {}, services: [], env, install: [], test: [],
        apt: [], languages: [], text: "" };
      const dirs = new Set<string>();
      const norm = (d: string | null) => (d ? posix.normalize(d.replace(/^\.\//, "")).replace(/\/$/, "") || "." : ".");
      for (const step of Array.isArray(job.steps) ? job.steps : []) {
        if (!isMap(step)) continue;
        const uses = str(step.uses) ?? "";
        const w = isMap(step.with) ? step.with : {};
        const wv = (k: string) => resolve(str(w[k]));
        const fileVersion = (k: string) => (wv(k) ? read(norm(wv(k))).trim().split("\n")[0] ?? null : null);
        if (uses.startsWith("actions/setup-node")) j.versions.node ??= wv("node-version") ?? fileVersion("node-version-file") ?? undefined;
        if (uses.startsWith("actions/setup-python")) j.versions.python ??= wv("python-version") ?? fileVersion("python-version-file") ?? undefined;
        if (uses.startsWith("oven-sh/setup-bun")) j.versions.bun ??= wv("bun-version") ?? undefined;
        if (/^(dtolnay\/rust-toolchain|actions-rs\/toolchain|actions-rust-lang\/setup-rust-toolchain)/.test(uses)) {
          const ref = uses.split("@")[1] ?? "";
          j.versions.rust ??= wv("toolchain") ?? (/^1\.\d+/.test(ref) ? ref : undefined);
        }
        if (uses.startsWith("astral-sh/setup-uv") && wv("python-version")) j.versions.python ??= wv("python-version")!;
        Object.assign(j.env, strEnv(step.env));
        const run = str(step.run);
        if (!run) continue;
        const stepDir = resolve(str(step["working-directory"])) ?? jobDir;
        dirs.add(norm(stepDir));
        for (const line of commands(run)) {
          const cd = /^cd\s+([^\s&;]+)/.exec(line)?.[1];
          if (cd && !cd.startsWith("$") && !cd.startsWith("/") && !cd.startsWith("~")) {
            dirs.add(norm(posix.join(norm(stepDir), cd)));
          }
          const cmd = resolve(line) ?? line;
          j.text += cmd + "\n";
          if (TEST.test(cmd)) j.test.push(cmd);
          else if (INSTALL.test(cmd)) j.install.push(cmd);
          const apt = /apt(-get)?\s+install\s+(.*)/.exec(cmd);
          if (apt) j.apt.push(...apt[2]!.split(/\s+/).filter((p) => /^[a-z0-9][a-z0-9.+-]+$/.test(p)));
        }
      }
      j.dirs = [...dirs].length ? [...dirs] : ["."];
      if (isMap(job.services)) {
        for (const [name, spec] of Object.entries(job.services)) {
          const image = resolve(isMap(spec) ? str(spec.image) : str(spec));
          if (!image) continue;
          j.services.push({ name: serviceName(name), image, kind: kindOf(image),
            env: isMap(spec) ? resolvedEnv(strEnv(spec.env), resolve) : {}, from: `${file}:${id}` });
        }
      }
      for (const [k, v] of Object.entries(j.env)) {
        const r = resolve(v);
        if (r === null) delete j.env[k];
        else j.env[k] = r;
      }
      j.languages = jobLanguages(j);
      out.push(j);
    }
  }
  return out;
}

/** The languages a job sets up or runs tests of. */
function jobLanguages(j: CiJob): string[] {
  const out = new Set<string>();
  if (j.versions.node || j.versions.bun || /\b(vitest|jest|mocha|node --test|bun test|(npm|pnpm|yarn)( run)? test)\b/.test(j.text)) {
    out.add("typescript");
  }
  if (j.versions.python || /\b(pytest|tox|nox|python -m)\b/.test(j.text)) out.add("python");
  if (j.versions.rust || /\bcargo\b/.test(j.text)) out.add("rust");
  return [...out];
}

/** GitLab CI, best effort: the image's version, services and variables of each job. */
function gitlabJobs(set: Set<string>, yaml: (rel: string) => unknown): CiJob[] {
  const file = ".gitlab-ci.yml";
  const doc = set.has(file) ? yaml(file) : null;
  if (!isMap(doc)) return [];
  const out: CiJob[] = [];
  const top = isMap(doc.default) ? doc.default : doc;
  const vars = strEnv(doc.variables);
  for (const [id, job] of Object.entries(doc)) {
    if (!isMap(job) || !("script" in job) || id.startsWith(".")) continue;
    const image = imageName(job.image ?? top.image);
    const env = { ...vars, ...strEnv(job.variables) };
    const j: CiJob = { id: `${file}:${id}`, dirs: ["."], versions: {}, services: [], env, install: [], test: [], apt: [],
      languages: [], text: "" };
    const m = image ? /^(node|python|rust):v?([\d.]+)/.exec(image) : null;
    if (m) j.versions[m[1] as Tool] = m[2]!;
    for (const s of Array.isArray(job.services ?? top.services) ? (job.services ?? top.services) as unknown[] : []) {
      const img = imageName(s);
      if (!img || EXPR.test(img)) continue;
      const alias = isMap(s) ? str(s.alias) : null;
      j.services.push({ name: serviceName(alias ?? img.split(":")[0]!.split("/").at(-1)!), image: img, kind: kindOf(img),
        env: resolvedEnv(env, (v) => v), from: j.id });
    }
    const script = [job.before_script, job.script].flatMap((s) => (Array.isArray(s) ? s : [s])).map(str)
      .filter((s): s is string => !!s);
    for (const line of script.flatMap(commands)) {
      j.text += line + "\n";
      if (TEST.test(line)) j.test.push(line);
      else if (INSTALL.test(line)) j.install.push(line);
    }
    j.languages = jobLanguages(j);
    out.push(j);
  }
  return out;
}

interface ComposeApp { dir: string; dependsOn: string[]; env: Record<string, string>; from: string }

/** Compose files: services with an image (databases, brokers) and services built from a directory (the code). */
function composeFacts(paths: string[], yaml: (rel: string) => unknown): { services: ServiceFact[]; apps: ComposeApp[] } {
  const services: ServiceFact[] = [];
  const apps: ComposeApp[] = [];
  // Test compose files first: their settings are the ones meant for tests.
  const files = paths.filter((p) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(p))
    .sort((a, b) => Number(/test/.test(b)) - Number(/test/.test(a)) || a.length - b.length);
  for (const file of files) {
    const doc = yaml(file);
    if (!isMap(doc) || !isMap(doc.services)) continue;
    for (const [name, spec] of Object.entries(doc.services)) {
      if (!isMap(spec)) continue;
      const env = resolvedEnv(listEnv(spec.environment), (v) => v);
      const image = str(spec.image)?.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}$]*)\}/g, "$1") ?? null;
      const build = isMap(spec.build) ? str(spec.build.context) : str(spec.build);
      if (build !== null) {
        const dir = posix.normalize(posix.join(dirOf(file), build)).replace(/\/$/, "") || ".";
        const deps = Array.isArray(spec.depends_on) ? spec.depends_on.map(String)
          : isMap(spec.depends_on) ? Object.keys(spec.depends_on) : [];
        apps.push({ dir: dir === "" ? "." : dir, dependsOn: deps.map(serviceName), env, from: `${file}:${name}` });
      } else if (image && !EXPR.test(image) && !image.endsWith(":")) {
        services.push({ name: serviceName(name), image, kind: kindOf(image), env, from: `${file}:${name}` });
      }
    }
  }
  return { services, apps };
}

/** Base images of Dockerfiles, by directory, with ARG defaults filled in. */
function dockerImages(paths: string[], read: (rel: string) => string): Map<string, Fact[]> {
  const out = new Map<string, Fact[]>();
  for (const p of paths.filter((x) => /(^|\/)(Dockerfile[^/]*|[^/]+\.Dockerfile)$/.test(x))) {
    const args: Record<string, string> = {};
    for (const line of read(p).split("\n")) {
      const arg = /^\s*ARG\s+([A-Za-z_][A-Za-z0-9_]*)=["']?([^\s"']+)/i.exec(line);
      if (arg) args[arg[1]!] = arg[2]!;
      const from = /^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)/i.exec(line);
      if (!from) continue;
      const image = from[1]!.replace(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/g, (_, k: string) => args[k] ?? "$");
      if (image.includes("$")) continue;
      const list = out.get(dirOf(p)) ?? [];
      list.push({ value: image, from: p });
      out.set(dirOf(p), list);
    }
  }
  return out;
}

/** The commands of a shell script, continuation lines joined and comments left out. */
function commands(script: string): string[] {
  return script.replace(/\\\n\s*/g, " ").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
}

const serviceName = (name: string) => name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "db";
const imageName = (v: unknown) => (isMap(v) ? str(v.name) : str(v));

function strEnv(v: unknown): Record<string, string> {
  if (!isMap(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, x] of Object.entries(v)) {
    const s = typeof x === "boolean" ? String(x) : str(x);
    if (s !== null) out[k] = s;
  }
  return out;
}

const listEnv = (v: unknown): Record<string, string> => Array.isArray(v)
  ? Object.fromEntries(v.map(String).filter((x) => x.includes("=")).map((x) => [x.slice(0, x.indexOf("=")),
    x.slice(x.indexOf("=") + 1)]))
  : strEnv(v);

/** Variables with their `${NAME:-default}` defaults filled in; ones that still need a value from elsewhere dropped. */
function resolvedEnv(env: Record<string, string>, resolve: (v: string) => string | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    const r = resolve(v.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:?-([^}$]*)\}/g, "$1"));
    if (r !== null && !EXPR.test(r)) out[k] = r;
  }
  return out;
}
