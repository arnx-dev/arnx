// `.arnx/review.yaml`: the test environment setup proved. A run refuses a config that is missing, unproven, or
// changed since its proof (the stamp, kept under its old name `approved`, holds a hash of everything else in the file). The hash is the one Python
// arnx computed (json.dumps with sorted keys over the parsed YAML), so files stamped by either version stay valid.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Document, parseDocument, visit } from "yaml";
import type { ScalarTag, Tags } from "yaml";
import { getAdapter } from "./adapters";
import { baselineDigest } from "./baseline";
import { python } from "./adapters/python";
import type { Adapter, AdapterId } from "./adapters/types";
import { ArnxError, SetupRequired } from "./errors";
import { GENERATED, isSecretEnvName, type SecretPin } from "./secrets";
import { purePosix, pyJson, pyStr, pyTruthy } from "./util";

export const KEYS = new Set(["version", "image", "workdir", "install", "test_command", "services", "env", "notes",
  "known_failing", "tests_dir", "allow_env_names", "approved", "language", "allow_secret_looking", "typecheck",
  "deps_dir", "sandbox_only"]);
export const SERVICE_KEYS = new Set(["image", "env", "ready"]);
export const SERVICE_NAME = /^[a-z][a-z0-9-]{0,30}$/;

export interface Service {
  name: string;
  image: string;
  env: Record<string, string>;
  ready: string | null;
}

export interface ReviewConfig {
  raw: Record<string, unknown>;
  language: AdapterId;
  runner: string;
  image: string;
  workdir: string;
  install: string[];
  testCommand: string;
  services: Service[];
  env: Record<string, string>;
  notes: string[];
  knownFailing: string[];
  testsDir: string;
  /** The project's name ("main" for a file without projects). */
  name: string;
  /** Paths this project tests, and paths it depends on (.arnxignore-style patterns). */
  owns: string[];
  uses: string[];
  /** Where the install commands run, whose manifests key the image (default: the project's root). Projects with the
   * same image, install and install_root share one environment image. */
  installRoot: string;
  /** The project's type check (TypeScript only), run once per review apart from the tests; absent when not set. */
  typecheck?: string;
  /** Where install put the dependencies in the image, outside /src (TypeScript only): every run links each
   * node_modules under it into the same place under the install root (depsLink in sandbox.ts). */
  depsDir?: string;
}

type Raw = Record<string, unknown>;
const isMap = (v: unknown): v is Raw => typeof v === "object" && v !== null && !Array.isArray(v) &&
  !(v instanceof Date);
const without = (raw: Raw, key: string): Raw => Object.fromEntries(Object.entries(raw).filter(([k]) => k !== key));

export function digest(cfg: ReviewConfig): string {
  let body: string;
  try {
    body = pyJson(without(cfg.raw, "approved"), { sortKeys: true, floatNumbers: true });
  } catch (e) {
    throw new ArnxError(`review.yaml: ${(e as Error).message}`);
  }
  return createHash("sha256").update(body).digest("hex");
}

export function isApproved(cfg: ReviewConfig): boolean {
  const stamp_ = cfg.raw.approved;
  return isMap(stamp_) && stamp_.sha256 === digest(cfg);
}

export function reviewConfigPath(repo: string): string {
  return join(repo, ".arnx", "review.yaml");
}

function rel(value: unknown, name: string, problems: string[]): string {
  if (typeof value !== "string" || !value) {
    problems.push(`${name}: must be a relative path`);
    return ".";
  }
  const p = purePosix(value);
  if (p.absolute || p.parts.includes("..")) problems.push(`${name}: must stay inside the repository`);
  return p.path;
}

function strList(value: unknown, name: string, problems: string[]): string[] {
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value) || !value.every((v) => typeof v === "string")) {
    problems.push(`${name}: must be a list of strings`);
    return [];
  }
  return [...value] as string[];
}

const scalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "bigint" ||
  typeof v === "boolean";

function strMap(value: unknown, name: string, problems: string[]): Record<string, string> {
  if (value === null || value === undefined) return {};
  if (!isMap(value) || !Object.values(value).every(scalar)) {
    problems.push(`${name}: must map names to strings`);
    return {};
  }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, pyStr(v)]));
}

function secretNames(env: Record<string, string>, where: string, allow: Set<string>): string[] {
  return Object.keys(env).filter((k) => isSecretEnvName(k) && !allow.has(k) && !GENERATED.test(env[k]!)).map((k) =>
    `${where}.${k}: looks like a secret; arnx passes no secrets to tests (write arnx:generated for a throwaway value ` +
    "arnx makes, or list the name under allow_env_names if it holds one)");
}

/** Python's `== 1`: 1, 1.0 and True. */
const isOne = (v: unknown) => v === 1n || v === 1 || v === true;

/** PyYAML's SafeLoader resolvers for plain scalars. The yaml library's YAML 1.1 schema reads more as numbers
 * (`.`, `1e-05`, `012`) and booleans (`y`, `n`) than PyYAML does; dates stay strings (PyYAML made dates that its
 * own hash could not serialise). Same resolution means the same hash as Python arnx. */
const PYYAML_TESTS: Record<string, RegExp> = {
  "bool:true": /^(?:yes|Yes|YES|true|True|TRUE|on|On|ON)$/,
  "bool:false": /^(?:no|No|NO|false|False|FALSE|off|Off|OFF)$/,
  "int:": /^[-+]?(?:0|[1-9][0-9_]*)$/,
  "int:TIME": /^[-+]?[1-9][0-9_]*(?::[0-5]?[0-9])+$/,
  "float:": /^(?:[-+]?[0-9][0-9_]*\.[0-9_]*(?:[eE][-+][0-9]+)?|\.[0-9][0-9_]*(?:[eE][-+][0-9]+)?)$/,
  "float:EXP": /(?!)/,
};

function pyyamlTags(tags: Tags): Tags {
  return tags.filter((t) => typeof t === "string" || t.tag !== "tag:yaml.org,2002:timestamp").map((t) => {
    if (typeof t === "string" || !("test" in t) || !t.test) return t;
    const kind = t.tag.replace("tag:yaml.org,2002:", "");
    const key = kind === "bool" ? `bool:${t.test.source.includes("rue")}`
      : t.test.source.includes("inf") ? "float:INF" : `${kind}:${t.format ?? ""}`;
    const test = PYYAML_TESTS[key];
    return test ? { ...(t as ScalarTag), test } : t;
  });
}

function parseYaml(text: string): unknown {
  const doc = parseDocument(text, { version: "1.1", customTags: pyyamlTags, intAsBigInt: true, uniqueKeys: false,
    prettyErrors: false });
  if (doc.errors.length) throw new ArnxError(`review.yaml is not valid YAML: ${doc.errors[0]!.message}`);
  return doc.toJS();
}

export const FILE_KEYS = new Set(["version", "services", "allow_env_names", "projects", "uncovered", "approved",
  "allow_secret_looking", "sandbox_only"]);
/** Files .arnxignore leaves out that the tests need: setup writes them, each run gets them in its sandbox, and no
 * model is sent them. */
export const SANDBOX_KEY = "sandbox_only";

function parseSandbox(value: unknown, problems: string[]): string[] {
  return strList(value, SANDBOX_KEY, problems).map((p) => rel(p, SANDBOX_KEY, problems));
}

/** The sandbox-only files of a parsed review.yaml (a project's `raw` is the whole file). */
export const sandboxOnlyOf = (raw: Raw): string[] => parseSandbox(raw[SANDBOX_KEY], []);
/** Files the user allowed although they hold key-shaped text; written by `arnx allow-secret`. */
const SECRET_KEY = "allow_secret_looking";
const PIN = /^[0-9a-f]{16}$/;

function parsePins(value: unknown, problems: string[]): SecretPin[] {
  if (value === null || value === undefined) return [];
  const out: SecretPin[] = [];
  const ok = Array.isArray(value) && value.every((e) => isMap(e) && typeof e.path === "string" &&
    Array.isArray(e.matches) && e.matches.length > 0 && e.matches.every((m) => typeof m === "string" && PIN.test(m)) &&
    Object.keys(e).length === 2);
  if (!ok) {
    problems.push(`${SECRET_KEY}: must be a list of {path, matches}; add files with \`arnx allow-secret PATH\``);
    return [];
  }
  for (const e of value as Raw[]) {
    out.push({ path: rel(e.path, `${SECRET_KEY}.path`, problems), matches: [...e.matches as string[]] });
  }
  return out;
}

/** The allowed files of a parsed review.yaml (a project's `raw` is the whole file). */
export const secretPinsOf = (raw: Raw): SecretPin[] => parsePins(raw[SECRET_KEY], []);

/** A file that so far only allows secret-looking files (written by `arnx allow-secret` before setup). */
export const isSeed = (raw: Raw) => SECRET_KEY in raw && Object.keys(raw).every((k) => k === "version" || k === SECRET_KEY);

/** `.arnx/review.yaml` exists and is a seed: the test environment is not set up yet. */
export function isSeedFile(repo: string): boolean {
  const path = reviewConfigPath(repo);
  if (!existsSync(path)) return false;
  const raw = parseYaml(readFileSync(path, "utf8"));
  return isMap(raw) && isSeed(raw);
}

/** The approval stamp of `.arnx/review.yaml` when it has one: who, when (the date), and whether the file is unchanged
 * since. Null when there is no file, it does not read, or it was never approved (a seed, a failed setup's attempt). */
export function approvalStamp(repo: string): { by: string; at: string; current: boolean } | null {
  const path = reviewConfigPath(repo);
  if (!existsSync(path)) return null;
  const text = readFileSync(path, "utf8");
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return null;
  }
  if (!isMap(raw) || !isMap(raw.approved)) return null;
  let current = false;
  try {
    current = isProven(repo, parseReviewFile(text));
  } catch (e) {
    if (!(e instanceof ArnxError)) throw e;
  }
  return { by: String(raw.approved.by ?? "unknown"), at: String(raw.approved.at ?? "").slice(0, 10), current };
}

/** The allowed files in `.arnx/review.yaml`, read without the rest of it (setup runs before the file is complete). */
export function readSecretPins(repo: string): SecretPin[] {
  const path = reviewConfigPath(repo);
  if (!existsSync(path)) return [];
  const raw = parseYaml(readFileSync(path, "utf8"));
  const problems: string[] = [];
  const pins = isMap(raw) ? parsePins(raw[SECRET_KEY], problems) : [];
  if (problems.length) throw new ArnxError("review.yaml: " + problems.join("; "));
  return pins;
}

/** `text` (null: a new seed file) with `pins` replacing the allowed files of the same paths. */
export function withSecretPins(text: string | null, pins: SecretPin[]): string {
  const raw = text === null ? { version: 1n } : parseYaml(text);
  if (!isMap(raw)) throw new ArnxError("review.yaml must be a mapping");
  const problems: string[] = [];
  const kept = parsePins(raw[SECRET_KEY], problems).filter((p) => !pins.some((n) => n.path === p.path));
  if (problems.length) throw new ArnxError("review.yaml: " + problems.join("; "));
  const all = [...kept, ...pins].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  if (!all.length) return toYaml(without(raw, SECRET_KEY));
  return toYaml({ ...raw, [SECRET_KEY]: all.map((p) => ({ path: p.path, matches: [...p.matches] })) });
}

/** review.yaml's text without the pins of `paths`, each of which it must allow (`arnx allow-secret --remove`). */
export function withoutSecretPins(text: string, paths: string[]): string {
  const raw = parseYaml(text);
  if (!isMap(raw)) throw new ArnxError("review.yaml must be a mapping");
  const problems: string[] = [];
  const pins = parsePins(raw[SECRET_KEY], problems);
  if (problems.length) throw new ArnxError("review.yaml: " + problems.join("; "));
  const missing = paths.find((p) => !pins.some((x) => x.path === p));
  if (missing !== undefined) throw new ArnxError(`${missing} is not allowed in .arnx/review.yaml; nothing to remove`);
  const kept = pins.filter((p) => !paths.includes(p.path));
  if (!kept.length) return toYaml(without(raw, SECRET_KEY));
  return toYaml({ ...raw, [SECRET_KEY]: kept.map((p) => ({ path: p.path, matches: [...p.matches] })) });
}

/** The allow-list as YAML to append to a file that has none (setup adds the user's to the agent's file). */
export const secretPinsYaml = (pins: SecretPin[]) =>
  toYaml({ [SECRET_KEY]: pins.map((p) => ({ path: p.path, matches: [...p.matches] })) });
/** The sandbox-only files as YAML to append to a file that has none (setup adds them to the agent's file). */
export const sandboxYaml = (paths: string[]) => toYaml({ [SANDBOX_KEY]: [...paths].sort() });
export const PROJECT_KEYS = new Set(["root", "language", "runner", "image", "install", "test_command", "services", "env",
  "owns", "uses", "notes", "known_failing", "tests_dir", "install_root", "typecheck", "deps_dir"]);

export interface Uncovered { path: string; reason: string }

/** The whole review.yaml: one or more projects. A file without `projects` is one project named `main`. */
export interface ReviewFile {
  raw: Raw;
  legacy: boolean;
  projects: ReviewConfig[];
  services: Service[];
  uncovered: Uncovered[];
}

function parseServices(value: unknown, allow: Set<string>, problems: string[]): Service[] {
  const services: Service[] = [];
  let servicesRaw: unknown = pyTruthy(value) ? value : {};
  if (!isMap(servicesRaw)) {
    problems.push("services: must be a mapping");
    servicesRaw = {};
  }
  for (const [name, spec] of Object.entries(servicesRaw as Raw)) {
    const where = `services.${name}`;
    if (!SERVICE_NAME.test(name)) {
      problems.push(`${where}: names are lowercase letters, digits and dashes`);
      continue;
    }
    if (!isMap(spec) || typeof spec.image !== "string") {
      problems.push(`${where}: needs an image`);
      continue;
    }
    const extra = Object.keys(spec).filter((k) => !SERVICE_KEYS.has(k)).sort();
    if (extra.length) problems.push(`${where}: unknown keys: ${extra.join(", ")}`);
    let ready = spec.ready ?? null;
    if (ready !== null && typeof ready !== "string") {
      problems.push(`${where}.ready: must be a shell command`);
      ready = null;
    }
    const serviceEnv = strMap(spec.env, `${where}.env`, problems);
    problems.push(...secretNames(serviceEnv, `${where}.env`, allow));
    services.push({ name, image: spec.image, env: serviceEnv, ready: ready as string | null });
  }
  return services;
}

/** One project's settings. `at` prefixes problem names ("" for a legacy file, "projects.<name>." otherwise). */
function parseProject(spec: Raw, name: string, at: string, fileRaw: Raw, services: Service[] | null,
                      allow: Set<string>, problems: string[]): ReviewConfig {
  let adapter: Adapter = python;
  if ("language" in spec) {
    try {
      if (typeof spec.language !== "string") throw new ArnxError("must name a language");
      adapter = getAdapter(spec.language);
    } catch (e) {
      problems.push(`${at}language: ${(e as Error).message}`);
    }
  }
  let runner = adapter.defaultRunner;
  if ("runner" in spec) {
    if (typeof spec.runner === "string" && adapter.runners.includes(spec.runner)) runner = spec.runner;
    else problems.push(`${at}runner: must be one of ${adapter.runners.join(", ")}`);
  }
  let image = spec.image;
  if (typeof image !== "string" || !image) {
    problems.push(`${at}image: required`);
    image = "";
  }
  const rootKey = services === null ? "workdir" : "root";
  const workdir = rel(rootKey in spec ? spec[rootKey] : ".", `${at}${rootKey}`, problems);
  const testsDir = rel("tests_dir" in spec ? spec.tests_dir : adapter.defaultTestsDir, `${at}tests_dir`, problems);
  const installRoot = services !== null && "install_root" in spec
    ? rel(spec.install_root, `${at}install_root`, problems) : workdir;
  const install = strList(spec.install, `${at}install`, problems);
  if (install.some((c) => c.includes("\n"))) problems.push(`${at}install: one command per line; use && to chain`);
  const commandProblems = [...adapter.validateCommand(spec.test_command, runner),
    ...typeof spec.test_command === "string" && fileWrite(spec.test_command) !== null
      ? [writes(fileWrite(spec.test_command)!)] : [],
    ...typeof spec.test_command === "string" && runner !== "node" ? reportProblems(spec.test_command, adapter, runner)
      : []].map((p) => at + p);
  problems.push(...commandProblems);
  const command = commandProblems.length ? "" : spec.test_command as string;
  let typecheck: string | undefined;
  if ("typecheck" in spec) {
    if (typeof spec.typecheck !== "string" || !spec.typecheck.trim() || spec.typecheck.includes("\n")) {
      problems.push(`${at}typecheck: must be one shell command (use && to chain)`);
    } else if (adapter.id !== "typescript") problems.push(`${at}typecheck: only for typescript projects`);
    else typecheck = spec.typecheck;
  }
  let depsDir: string | undefined;
  if ("deps_dir" in spec) {
    if (typeof spec.deps_dir !== "string" || !/^\/[\w.@+/-]+$/.test(spec.deps_dir) ||
      /^\/src(?:\/|$)/.test(spec.deps_dir)) {
      problems.push(`${at}deps_dir: must be an absolute path in the image outside /src, such as /opt/deps`);
    } else if (adapter.id !== "typescript") problems.push(`${at}deps_dir: only for typescript projects`);
    else depsDir = spec.deps_dir.replace(/\/+$/, "");
  }
  const env = strMap(spec.env, `${at}env`, problems);
  problems.push(...secretNames(env, `${at}env`, allow));
  let own: Service[];
  if (services === null) {
    own = parseServices(spec.services, allow, problems);
  } else {
    const names = strList(spec.services, `${at}services`, problems);
    const missing = names.filter((n) => !services.some((s) => s.name === n));
    if (missing.length) problems.push(`${at}services: ${missing.join(", ")} not defined under services`);
    own = services.filter((s) => names.includes(s.name));
  }
  const defaultOwns = workdir === "." ? ["**"] : [`/${workdir}/`];
  const owns = services === null ? ["**"] : "owns" in spec ? strList(spec.owns, `${at}owns`, problems) : defaultOwns;
  const uses = services === null ? [] : strList(spec.uses, `${at}uses`, problems);
  const notes = strList(spec.notes, `${at}notes`, problems);
  const knownFailing = strList(spec.known_failing, `${at}known_failing`, problems);
  return { raw: fileRaw, name, language: adapter.id, runner, image: image as string, workdir, install,
    testCommand: command, services: own, env, notes, knownFailing, testsDir, owns, uses, installRoot,
    ...(typecheck === undefined ? {} : { typecheck }), ...(depsDir === undefined ? {} : { depsDir }) };
}

export function parseReviewFile(text: string): ReviewFile {
  const raw = parseYaml(text);
  if (!isMap(raw)) throw new ArnxError("review.yaml must be a mapping");
  const problems: string[] = [];
  if (!isOne(raw.version)) problems.push("version: must be 1");
  if (isSeed(raw)) {
    throw new SetupRequired(".arnx/review.yaml only lists files allowed as secret-looking so far; run `arnx setup`");
  }
  const allow = new Set(strList(raw.allow_env_names, "allow_env_names", problems));
  parsePins(raw[SECRET_KEY], problems);
  parseSandbox(raw[SANDBOX_KEY], problems);
  if (!("projects" in raw)) {
    const unknown = Object.keys(raw).filter((k) => !KEYS.has(k)).sort();
    if (unknown.length) problems.push(`unknown keys: ${unknown.join(", ")}`);
    const project = parseProject(raw, "main", "", raw, null, allow, problems);
    if (problems.length) throw new ArnxError("review.yaml: " + problems.join("; "));
    return { raw, legacy: true, projects: [project], services: project.services, uncovered: [] };
  }
  const unknown = Object.keys(raw).filter((k) => !FILE_KEYS.has(k)).sort();
  if (unknown.length) problems.push(`unknown keys: ${unknown.join(", ")}`);
  const services = parseServices(raw.services, allow, problems);
  const projects: ReviewConfig[] = [];
  if (!isMap(raw.projects) || !Object.keys(raw.projects).length) {
    problems.push("projects: at least one project is required");
  } else {
    for (const [name, spec] of Object.entries(raw.projects)) {
      const at = `projects.${name}`;
      if (!SERVICE_NAME.test(name)) {
        problems.push(`${at}: names are lowercase letters, digits and dashes`);
        continue;
      }
      if (!isMap(spec)) {
        problems.push(`${at}: must be a mapping`);
        continue;
      }
      const extra = Object.keys(spec).filter((k) => !PROJECT_KEYS.has(k)).sort();
      if (extra.length) problems.push(`${at}: unknown keys: ${extra.join(", ")}`);
      projects.push(parseProject(spec, name, `${at}.`, raw, services, allow, problems));
    }
  }
  const uncovered: Uncovered[] = [];
  const list = raw.uncovered ?? [];
  if (!Array.isArray(list)) problems.push("uncovered: must be a list of {path, reason}");
  else for (const u of list) {
    if (isMap(u) && typeof u.path === "string" && typeof u.reason === "string" && Object.keys(u).length === 2) {
      uncovered.push({ path: u.path, reason: u.reason });
    } else if (isMap(u) && typeof u.path === "string" && typeof u.reason === "string") {
      // {path: a, reason: x (b, c)} parses "c)" as a key: a comma in an unquoted flow value ends it.
      problems.push(`uncovered: ${u.path} has keys other than path and reason (${Object.keys(u).filter((k) =>
        k !== "path" && k !== "reason").join(", ")}); quote a reason that holds a comma`);
    } else problems.push("uncovered: each entry needs a path and a reason");
  }
  if (problems.length) throw new ArnxError("review.yaml: " + problems.join("; "));
  return { raw, legacy: false, projects, services, uncovered };
}

/** A legacy (single-project) file as one ReviewConfig. */
export function parseReviewConfig(text: string): ReviewConfig {
  const f = parseReviewFile(text);
  if (!f.legacy) throw new ArnxError("review.yaml has projects; read it with parseReviewFile");
  return f.projects[0]!;
}

export const fileDigest = (f: ReviewFile) => digest(f.projects[0]!);
export const isFileApproved = (f: ReviewFile) => isApproved(f.projects[0]!);

/** The baseline hash review.yaml's stamp holds (`approved.baseline`); null when it holds none. */
export function stampedBaseline(f: ReviewFile): string | null {
  const a = f.raw.approved;
  return isMap(a) && typeof a.baseline === "string" ? a.baseline : null;
}

/** The file is proven, and so is `.arnx/baseline.json` as it is now (none, when the stamp holds no hash). */
export const isProven = (repo: string, f: ReviewFile) => isFileApproved(f) && stampedBaseline(f) === baselineDigest(repo);

function hash(value: unknown): string {
  return createHash("sha256").update(pyJson(value, { sortKeys: true, floatNumbers: true })).digest("hex");
}

/** Hash of one project's settings and the services it lists: `approve --project` reruns only what changed. */
export function projectDigest(f: ReviewFile, name: string): string {
  const project = f.projects.find((p) => p.name === name);
  if (!project) throw new ArnxError(`no project ${name} in review.yaml`);
  const spec = f.legacy ? without(f.raw, "approved") : (f.raw.projects as Raw)[name];
  const services = isMap(f.raw.services)
    ? Object.fromEntries(Object.entries(f.raw.services).filter(([k]) => project.services.some((s) => s.name === k)))
    : {};
  // Every project's snapshot holds the allowed files. Files without the key keep the hash they had before it.
  return hash(!f.legacy && SECRET_KEY in f.raw ? { project: spec, services, [SECRET_KEY]: f.raw[SECRET_KEY] }
    : { project: spec, services });
}

/** Commands that delete, move or overwrite files, at the start of a command (after ;, &&, ||, |, `(`, sudo or xargs,
 * by name or by path: /bin/rm). `pytest -k rm` names no command. */
const AT_COMMAND = String.raw`(?:^|[;&|(])\s*(?:(?:sudo|xargs|command|env)\s+)*(?:\S*\/)?`;
const WRITER = new RegExp(`${AT_COMMAND}(?:rm|rmdir|unlink|shred|truncate|mv|cp|tee|dd)(?=[\\s;&|)]|$)|` +
  String.raw`${AT_COMMAND}sed\s+(?:\S+\s+)*-[a-zA-Z]*i|\s-delete\b`);

/** A test command that deletes files or writes them: each run then tests a different repository (dexdash's setup
 * wrote `rm -rf tests && echo "test(...)" > smoke/smoke.test.ts; npx vitest run {targets}`). Every redirect must go
 * to another descriptor (2>&1) or to /dev/null; a symlink (ln) is fine. Fails closed: a `>` inside quotes counts. */
export function writesFiles(command: string): boolean {
  return fileWrite(command) !== null;
}

/** The part of a command that deletes or writes a file (`rm`, `> out.log`), as writesFiles finds it; null: none. */
export function fileWrite(command: string): string | null {
  const w = WRITER.exec(command);
  if (w) return w[0].trim().replace(/^[;&|(\s]+/, "");
  for (const m of command.matchAll(/(?:\d|&)?>>?\|?\s*(&?[^\s;&|)]*)/g)) {
    const target = m[1]!;
    if (!(target === "/dev/null" || /^&\d?-?$/.test(target) && m[0].includes(">&"))) return m[0].trim();
  }
  return null;
}

/** What follows the last {targets} in a test command and starts another command (`| tail`, `; echo`): arnx appends
 * its report options to the end of the command (node's go in at --test), which would then go to that command, and the
 * runner writes no report. Redirects (2>&1, &>/dev/null) are not commands; null: nothing follows. */
export function afterTargets(command: string): string | null {
  const i = command.lastIndexOf("{targets}");
  if (i < 0) return null;
  const rest = command.slice(i + "{targets}".length);
  const m = /\|\|?|;|&&?/.exec(rest.replace(/\d?>&\d?-?|&>>?/g, (r) => " ".repeat(r.length)));
  return m ? rest.slice(m.index).trim() : null;
}

/** Where the last {targets} in a test command sits: inside which quote ("" for none), and how many parentheses deep
 * outside quotes (a subshell or `$(...)`). */
function atTargets(command: string): { quote: string; depth: number } {
  const end = command.lastIndexOf("{targets}");
  let quote = "", depth = 0;
  for (let i = 0; i < end; i++) {
    const c = command[i]!;
    if (quote === "'") {
      if (c === "'") quote = "";
    } else if (c === "\\") i++;
    else if (quote === "\"") {
      if (c === "\"") quote = "";
    } else if (c === "'" || c === "\"") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
  }
  return { quote, depth };
}

/** Whether the last {targets} in a test command sits inside quotes (`sh -c "make; pytest {targets}"`): the report
 * options arnx appends would follow the closing quote and go to the shell, not the runner. */
export const quotedTargets = (command: string) => atTargets(command).quote !== "";

/** Whether the last {targets} sits inside parentheses outside quotes (`(cd app && pytest {targets})`): the report
 * options arnx appends would follow the `)`, as with quotes. */
export const subshellTargets = (command: string) => {
  const at = atTargets(command);
  return at.quote === "" && at.depth > 0;
};

/** The simple command that gets the last {targets} (cut at ;, &, | and newlines outside quotes and parentheses),
 * when it does not call the runner itself outside quotes (`sh -c 'npx vitest run "$@"' _ {targets}`, `echo
 * {targets}`): arnx's report options follow {targets}, so they would go to that command. null: the runner gets them. */
export function targetsGoTo(command: string, runs: RegExp): string | null {
  const end = command.lastIndexOf("{targets}");
  if (end < 0) return null;
  // Redirects to another descriptor (2>&1, &>) cut nothing.
  const text = command.replace(/\d?>&\d?-?|&>>?/g, (r) => " ".repeat(r.length));
  const bare = [...text]; // the command outside quotes and parentheses; the rest blanked
  const cuts: number[] = [];
  let quote = "", depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    const outside = quote === "" && depth === 0;
    if (quote === "'") {
      if (c === "'") quote = "";
    } else if (c === "\\") {
      bare[i] = " ";
      if (i + 1 < bare.length) bare[i + 1] = " ";
      i++;
      continue;
    } else if (quote === "\"") {
      if (c === "\"") quote = "";
    } else if (c === "'" || c === "\"") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && depth > 0) depth--;
    else if (outside && /[;&|\n]/.test(c)) cuts.push(i);
    if (!outside || quote !== "" || depth > 0) bare[i] = " ";
  }
  const from = Math.max(-1, ...cuts.filter((i) => i < end)) + 1;
  const to = Math.min(text.length, ...cuts.filter((i) => i > end));
  return runs.test(bare.slice(from, to).join("")) ? null : command.slice(from, to).trim();
}

/** Why arnx's report options would not reach the runner in this test command (they follow {targets}): one problem,
 * the first that applies. A TypeScript command that links node_modules is told of deps_dir, which does it instead. */
function reportProblems(command: string, adapter: Adapter, runner: string): string[] {
  const link = adapter.id === "typescript" && command.includes("node_modules")
    ? "; to link node_modules, set deps_dir instead" : "";
  const after = afterTargets(command);
  if (after !== null) {
    return [`test_command: \`${after}\` comes after {targets}: arnx adds the runner's report options at the end, so ` +
      "they would go to that command and no report is written. End test_command with the runner's own options"];
  }
  if (quotedTargets(command)) {
    return ["test_command: {targets} is inside quotes: arnx adds the runner's report options at the end, after the " +
      "closing quote, so no report is written. Leave the runner and {targets} outside the quotes (make build && " +
      `<runner> {targets})${link}`];
  }
  if (subshellTargets(command)) {
    return ["test_command: {targets} is inside parentheses: the report options arnx adds at the end would follow the " +
      `\`)\`, so no report is written. Leave the runner and {targets} outside them (cd app && <runner> {targets})${link}`];
  }
  const to = targetsGoTo(command, adapter.runs(runner));
  if (to !== null) {
    const shown = to.length > 60 ? `${to.slice(0, 57)}...` : to;
    return [`test_command: {targets} goes to \`${shown}\`, not to ${adapter.words(runner).runner}: arnx adds the ` +
      "runner's report options after {targets}, so no report would be written. Call the runner itself with {targets} " +
      `(make build && <runner> {targets})${link}`];
  }
  return [];
}

/** Why a test_command that writes is refused, naming what writes. A setup approved before the rule fails here on any
 * command after an upgrade, so it says how to fix it. */
const writes = (part: string) => `test_command: must not delete or write files (rm, mv, cp, sed -i, tee, > file): ` +
  `\`${part}\` writes. Every run must see the repository as it is: move it to install (arnx writes its own tests), ` +
  "then run `arnx approve`";

export function loadReviewFile(repo: string, { requireApproved = true } = {}): ReviewFile {
  const path = reviewConfigPath(repo);
  if (!existsSync(path)) throw new SetupRequired("no .arnx/review.yaml; run `arnx setup`");
  const f = parseReviewFile(readFileSync(path, "utf8"));
  if (requireApproved && !isProven(repo, f)) {
    throw new SetupRequired(".arnx/review.yaml is not proven, or changed since its proof; run `arnx approve` to prove " +
      "it");
  }
  return f;
}

export function loadReviewConfig(repo: string, { requireApproved = true } = {}): ReviewConfig {
  const f = loadReviewFile(repo, { requireApproved });
  if (!f.legacy) throw new ArnxError("review.yaml has projects; this command reads one project");
  return f.projects[0]!;
}

function toYaml(raw: Raw): string {
  const doc = new Document(raw, { version: "1.1", customTags: pyyamlTags });
  visit(doc, {
    Scalar(_key, node) {
      if (typeof node.value === "number" && Number.isInteger(node.value)) node.minFractionDigits = 1;
    },
  });
  return doc.toString({ lineWidth: 0 });
}

/** The file with an approval stamp. Floats keep a fraction so they read back as floats and the hash holds. A file
 * with projects also records each project's digest. `baseline`: the hash of `.arnx/baseline.json` (baselineDigest),
 * null when there is none. */
export function stampFile(f: ReviewFile, by: string, at: string, baseline: string | null = null): string {
  const approved: Raw = { by, at, sha256: fileDigest(f) };
  if (!f.legacy) approved.projects = Object.fromEntries(f.projects.map((p) => [p.name, projectDigest(f, p.name)]));
  if (baseline) approved.baseline = baseline;
  return toYaml({ ...without(f.raw, "approved"), approved });
}

export function stamp(cfg: ReviewConfig, by: string, at: string, baseline: string | null = null): string {
  return toYaml({ ...without(cfg.raw, "approved"),
    approved: { by, at, sha256: digest(cfg), ...(baseline ? { baseline } : {}) } });
}
