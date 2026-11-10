// The project's own type check (`typecheck` in review.yaml; TypeScript projects only). A review runs it once on the
// change, after the final runs and without arnx's generated tests, in the same sandbox; when it reports errors, once
// more on the code before the change, to tell the errors the change brought from those already there. Types are
// deterministic, so once is enough. It is information: it never changes a test's outcome, a finding, whether a run
// reported, or the exit code.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { ReviewConfig } from "./config";
import { ArnxError } from "./errors";
import { OutOfTime, type Runner } from "./sandbox";

export const TYPECHECK_TIMEOUT = 600;
/** A quick setup's type check: it has minutes, not an hour. */
export const QUICK_TYPECHECK_TIMEOUT = 180;
/** Most errors review.json lists per project (`errors` always counts them all). */
export const DIAGNOSTICS_KEPT = 100;
const OUTPUT_KEPT = 2000;

/** clean: exit code 0; errors: tsc reported type errors; failed: the command failed without reporting any (it could
 * not start, or its output is not tsc's); timed-out; skipped: not run, the project had SWAMPED_ERRORS or more errors
 * before the change when last run (`skippedFor`). */
export const TYPECHECK_STATUSES = ["clean", "errors", "failed", "timed-out", "skipped"] as const;
export type TypeCheckStatus = typeof TYPECHECK_STATUSES[number];
/** How the errors were compared with the code before the change. */
export const TYPECHECK_BEFORE = ["compared", "no-base", "dependencies-changed", "failed"] as const;
export type TypeCheckBefore = typeof TYPECHECK_BEFORE[number];

/** Errors before the change at which a type check says nothing about it: later reviews skip it for RECORD_DAYS. */
export const SWAMPED_ERRORS = 100;
export const RECORD_DAYS = 14;
/** Local state under .arnx/, never committed or sent anywhere: `{ project: { command, errors, at, inputs } }`. */
export const TYPECHECK_RECORD = "typecheck.json";

/** One error tsc reported; `file` relative to the repository root ("" for an error about no file, such as a bad
 * tsconfig). */
export interface TscError { file: string; line: number; column: number; code: string; message: string }

export interface Diagnostic extends TscError {
  /** The file is one the change touches. */
  changed: boolean;
  /** Not on the code before the change (absent when not compared). */
  new?: boolean;
}

/** One project's type check, as review.json keeps it. */
export interface TypeCheck {
  project: string;
  command: string;
  status: TypeCheckStatus;
  errors: number;
  inChangedFiles: number;
  /** Errors the code before the change does not have, and those it has too (absent when not compared). */
  new?: number;
  preExisting?: number;
  /** Absent when there was nothing to compare (no errors) or the comparison is off (`before_check = false`). */
  before?: TypeCheckBefore;
  /** The first DIAGNOSTICS_KEPT errors: new ones first, then those in changed files. */
  diagnostics: Diagnostic[];
  /** Skipped: the errors the code before the change had when last run, and when. */
  skippedFor?: { errors: number; at: string };
  /** The end of the output, when the check failed or timed out. */
  output?: string;
  /** Modules the check cannot see (a generated client, an unbuilt package) that three or more errors name: those
   * errors say nothing about the change. Absent when there are none. */
  gaps?: TypeGap[];
  secs: number;
}

export interface TypeCheckRun { status: TypeCheckStatus; errors: TscError[]; output: string; exitCode: number | null;
  timedOut: boolean; seconds: number }

const ANSI = /\x1b\[[0-9;]*m/g;
const PLAIN = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/;
const PRETTY = /^(.+?):(\d+):(\d+) - error (TS\d+): (.*)$/;
const GLOBAL = /^error (TS\d+): (.*)$/;

/** A path tsc printed (relative to where it ran, `workdir`, or absolute in the container), relative to the
 * repository root. */
function repoPath(path: string, workdir: string): string {
  if (path.startsWith("/src/")) return path.slice("/src/".length);
  if (posix.isAbsolute(path)) return path;
  return posix.normalize(posix.join(workdir, path));
}

/** The errors in tsc's output, plain or --pretty (vue-tsc prints the same). */
export function parseTsc(output: string, workdir: string): TscError[] {
  const out: TscError[] = [];
  for (const raw of output.split("\n")) {
    const line = raw.replace(ANSI, "").trimEnd();
    const m = PLAIN.exec(line) ?? PRETTY.exec(line);
    if (m) {
      out.push({ file: repoPath(m[1]!.trim(), workdir), line: Number(m[2]), column: Number(m[3]), code: m[4]!,
        message: m[5]!.trim() });
      continue;
    }
    const g = GLOBAL.exec(line);
    if (g) out.push({ file: "", line: 0, column: 0, code: g[1]!, message: g[2]!.trim() });
  }
  return out;
}

/** The project's type check, once, in `session` on its snapshot as it is now. A Docker error is a failed check; no
 * time left (OutOfTime) is not a result: the check never started, and it is thrown. */
export async function runTypecheck(session: Runner, cfg: ReviewConfig, timeout = TYPECHECK_TIMEOUT): Promise<TypeCheckRun> {
  try {
    const r = await session.run(cfg.typecheck!, timeout);
    const errors = r.timedOut ? [] : parseTsc(r.output, cfg.workdir);
    const status: TypeCheckStatus = r.timedOut ? "timed-out" : errors.length ? "errors"
      : r.exitCode === 0 ? "clean" : "failed";
    return { status, errors, output: r.output, exitCode: r.exitCode, timedOut: r.timedOut, seconds: r.seconds };
  } catch (e) {
    if (e instanceof OutOfTime || !(e instanceof ArnxError)) throw e;
    return { status: "failed", errors: [], output: e.message, exitCode: null, timedOut: false, seconds: 0 };
  }
}

/** tsc elides a long type with "... N more ..." where N moves with the change; the count is not part of the error. */
const keyOf = (e: TscError) => `${e.file}\0${e.code}\0${e.message.replace(/\.\.\. \d+ more \.\.\./g, "... N more ...")}`;

/** Which errors on the change are new: an error is not when the code before the change has the same one (same file,
 * code and message; its line may have moved), matched once each. */
export function markNew(after: TscError[], before: TscError[]): boolean[] {
  const left = new Map<string, number>();
  for (const e of before) left.set(keyOf(e), (left.get(keyOf(e)) ?? 0) + 1);
  return after.map((e) => {
    const n = left.get(keyOf(e)) ?? 0;
    if (n) left.set(keyOf(e), n - 1);
    return n === 0;
  });
}

/** The project's result. `changed`: the change's files (repository paths); `before`: the comparison with the code
 * before the change, with its errors when it ran (absent: not compared). */
export function typeCheckOf(cfg: ReviewConfig, run: TypeCheckRun, changed: Iterable<string>, secs: number,
                            before?: { status: TypeCheckBefore; errors?: TscError[] }, workspace: string[] = []): TypeCheck {
  const touched = new Set(changed);
  const fresh = before?.errors ? markNew(run.errors, before.errors) : null;
  // A module no package or generator explains (`missing`) is a gap only when most of its errors were there before the
  // change (not new; with no comparison, not in a changed file): if the change brings them, they are its errors.
  const bringing = (e: TscError, i: number) => (fresh ? fresh[i]! : touched.has(e.file));
  const gaps = typeGaps(run.errors, workspace).filter((g) => {
    if (g.kind !== "missing") return true;
    const own = run.errors.map((e, i) => [e, i] as const).filter(([e]) => missingModule(e) === g.module);
    return own.filter(([e, i]) => bringing(e, i)).length * 2 <= own.length;
  });
  const all: Diagnostic[] = run.errors.map((e, i) => ({ ...e, changed: touched.has(e.file),
    ...(fresh ? { new: fresh[i]! } : {}) }));
  const rank = (d: Diagnostic) => (d.new ? 0 : 2) + (d.changed ? 0 : 1);
  const diagnostics = all.map((d, i) => [d, i] as const).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1])
    .map(([d]) => d).slice(0, DIAGNOSTICS_KEPT);
  const newCount = fresh ? fresh.filter(Boolean).length : 0;
  return { project: cfg.name, command: cfg.typecheck!, status: run.status, errors: all.length,
    inChangedFiles: all.filter((d) => d.changed).length,
    ...(fresh ? { new: newCount, preExisting: all.length - newCount } : {}),
    ...(before ? { before: before.status } : {}), diagnostics,
    ...(run.status === "failed" || run.status === "timed-out" ? { output: run.output.slice(-OUTPUT_KEPT) } : {}),
    ...(gaps.length ? { gaps } : {}),
    secs: Math.round(secs * 10) / 10 };
}

/** What a type check depends on besides code: the tsconfigs, manifests, lockfiles and pyproject of the repository root
 * and of the project's folder, hashed; a record made under other contents is stale. */
const INPUT_FILE = /^(tsconfig[^/]*\.json|package\.json|package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|pyproject\.toml)$/;
export function typecheckInputs(repo: string, cfg: ReviewConfig): string {
  const h = createHash("sha256");
  // The project's own steps (install, test, image, env...): a fix there changes what the check can see.
  h.update(JSON.stringify({ ...cfg, raw: undefined }));
  for (const dir of new Set([".", cfg.workdir || "."])) {
    let names: string[] = [];
    try { names = readdirSync(join(repo, dir)).filter((n) => INPUT_FILE.test(n)).sort(); } catch { /* no folder */ }
    for (const n of names) {
      try { h.update(`${posix.join(dir, n)}\0${readFileSync(join(repo, dir, n))}\0`); } catch { /* unreadable */ }
    }
  }
  return h.digest("hex");
}

type Records = Record<string, { command: string; errors: number; at: string; inputs: string }>;
function readRecords(repo: string): Records {
  try {
    const d = JSON.parse(readFileSync(join(repo, ".arnx", TYPECHECK_RECORD), "utf8")) as unknown;
    return d && typeof d === "object" && !Array.isArray(d) ? d as Records : {};
  } catch {
    return {};
  }
}

/** Remember what the code before the change had: SWAMPED_ERRORS or more is kept (with the command and the inputs it
 * ran under) so reviews skip the check; fewer clears the project's entry. Never throws: it is a convenience. */
export function recordTypecheck(repo: string, cfg: ReviewConfig, errors: number, now = new Date()): void {
  try {
    const all = readRecords(repo);
    if (errors >= SWAMPED_ERRORS) {
      all[cfg.name] = { command: cfg.typecheck!, errors, at: now.toISOString(), inputs: typecheckInputs(repo, cfg) };
    } else if (all[cfg.name]) delete all[cfg.name];
    else return;
    mkdirSync(join(repo, ".arnx"), { recursive: true });
    // Local state: git must not see it, so the ignore line comes first (a repository set up before it lacks it).
    const ignore = join(repo, ".arnx", ".gitignore");
    if (existsSync(ignore)) {
      const text = readFileSync(ignore, "utf8");
      if (!text.split("\n").some((l) => l.trim() === TYPECHECK_RECORD)) {
        appendFileSync(ignore, (text === "" || text.endsWith("\n") ? "" : "\n") + `${TYPECHECK_RECORD}\n`);
      }
    }
    writeFileSync(join(repo, ".arnx", TYPECHECK_RECORD), `${JSON.stringify(all, null, 2)}\n`);
  } catch { /* the check just runs next time */ }
}

/** The skipped result for a project whose record is current: swamped, the same command, under 14 days old, the same
 * config and dependencies, and the change touches none of them. Null: run the check. */
export function skippedTypecheck(repo: string, cfg: ReviewConfig, changed: Iterable<string>, now = new Date())
  : TypeCheck | null {
  const rec = readRecords(repo)[cfg.name];
  if (!rec || rec.errors < SWAMPED_ERRORS || rec.command !== cfg.typecheck) return null;
  const age = now.getTime() - Date.parse(rec.at);
  if (!(age >= -60_000 && age < RECORD_DAYS * 86_400_000)) return null;
  if (rec.inputs !== typecheckInputs(repo, cfg)) return null;
  for (const f of changed) if (INPUT_FILE.test(posix.basename(f))) return null;
  return { project: cfg.name, command: cfg.typecheck!, status: "skipped", errors: 0, inChangedFiles: 0, diagnostics: [],
    skippedFor: { errors: rec.errors, at: rec.at }, secs: 0 };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

/** The gaps of a type check in a few words: "the type check cannot see @prisma/client (312 errors)". */
export function gapsLine(gaps: TypeGap[]): string {
  return `the type check cannot see ${gaps.map((g) => `${g.module} (${plural(g.errors, "error")})`).join(", ")}`;
}

const NOT_COMPARED: Record<Exclude<TypeCheckBefore, "compared">, string> = {
  "no-base": "the change has no code before it",
  "dependencies-changed": "the change alters the dependencies",
  failed: "the type check did not run there",
};

/** The result in a few words, for review.md, the summary and setup ("3 type errors: 1 new with this change, …"). */
export function describeTypecheck(t: Pick<TypeCheck, "status" | "errors" | "inChangedFiles" | "new" | "preExisting"
  | "before"> & Partial<Pick<TypeCheck, "skippedFor" | "project">>): string {
  if (t.status === "clean") return "no type errors";
  if (t.status === "skipped") {
    return `skipped: the code had ${t.skippedFor?.errors ?? SWAMPED_ERRORS} errors when last run, so errors this change ` +
      `adds are not checked; \`arnx setup --project ${t.project}\` runs it again`;
  }
  if (t.status === "timed-out") return `timed out after ${TYPECHECK_TIMEOUT} s`;
  if (t.status === "failed") return "did not run: the command failed without reporting a type error";
  const compared = t.before === "compared" ? `: ${t.new} new with this change, ${t.preExisting} already there before it`
    : t.before ? ` (not compared with the code before the change: ${NOT_COMPARED[t.before]})` : "";
  return `${plural(t.errors, "type error")}${compared}; ${t.inChangedFiles} in changed files`;
}

/** One error on one line: "`src/a.ts:3:7` TS2322 (new, changed file): Type 'string' is not …". */
export function describeDiagnostic(d: Diagnostic): string {
  const where = d.file ? `\`${d.file}:${d.line}:${d.column}\` ` : "";
  const tags = [...(d.new ? ["new"] : []), ...(d.changed ? ["changed file"] : [])];
  return `${where}${d.code}${tags.length ? ` (${tags.join(", ")})` : ""}: ${d.message}`;
}

/** A module the type check cannot see, named by several errors: `generated` (a client a generator writes, here
 * Prisma's), `sibling` (a package of the workspace, not built), `missing` (any other package). */
export interface TypeGap { kind: "generated" | "sibling" | "missing"; module: string; errors: number }

/** Errors that name one module this many times or more are a gap; fewer are the project's own. */
export const GAP_ERRORS = 3;
const GENERATED = /^(@prisma|\.prisma)\/client(\/|$)/;

/** The module a "cannot find module" or "no exported member" error names. */
export function missingModule(e: TscError): string | undefined {
  const m = e.code === "TS2307" ? /^Cannot find module '([^']+)'/.exec(e.message)
    : e.code === "TS2305" ? /^Module '"([^"]+)"' has no exported member/.exec(e.message) : null;
  return m?.[1];
}

/** The modules the type check cannot find (TS2307 "Cannot find module", TS2305 "has no exported member") that three
 * or more errors name: a generated client or an unbuilt package, not a mistake of the change. `workspace`: the
 * package names of the workspace. Relative imports are the project's own. */
export function typeGaps(errors: TscError[], workspace: string[]): TypeGap[] {
  const count = new Map<string, number>();
  for (const e of errors) {
    const name = missingModule(e);
    if (!name || name.startsWith(".") && !name.startsWith(".prisma/") || name.startsWith("/")) continue;
    count.set(name, (count.get(name) ?? 0) + 1);
  }
  // A subpath ("@acme/core/sub") is its package's.
  const pkgOf = (n: string) => workspace.find((w) => n === w || n.startsWith(`${w}/`));
  const gaps = new Map<string, TypeGap>();
  for (const [name, n] of count) {
    const generated = GENERATED.test(name);
    const module = generated ? "@prisma/client" : pkgOf(name) ?? name;
    const kind = generated ? "generated" : pkgOf(name) ? "sibling" : "missing";
    const g = gaps.get(module) ?? { kind, module, errors: 0 };
    g.errors += n;
    gaps.set(module, g);
  }
  return [...gaps.values()].filter((g) => g.errors >= GAP_ERRORS);
}

/** The package names of the workspace under `snap`: the manifests in the folders the root declares (package.json
 * `workspaces`, pnpm-workspace.yaml `packages`) or, with no declaration, every manifest below the root; never
 * node_modules; four folders deep at most. */
export function workspaceNames(snap: string): string[] {
  const read = (f: string) => { try { return readFileSync(join(snap, f), "utf8"); } catch { return ""; } };
  let globs: string[] = [];
  try {
    const w = (JSON.parse(read("package.json") || "{}") as { workspaces?: unknown }).workspaces;
    const list = Array.isArray(w) ? w : (w as { packages?: unknown } | undefined)?.packages;
    if (Array.isArray(list)) globs = list.filter((g): g is string => typeof g === "string");
  } catch { /* no manifest */ }
  globs.push(...[...read("pnpm-workspace.yaml").matchAll(/^\s*-\s*['"]?([^'"\s#]+)['"]?/gm)].map((m) => m[1]!));
  const asRegex = (g: string) => new RegExp(`^${g.replace(/^\.\//, "").replace(/\/$/, "")
    .replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\0").replace(/\*/g, "[^/]+").replaceAll("\0", ".*")}$`);
  const wanted = globs.filter((g) => !g.startsWith("!")).map(asRegex);
  const unwanted = globs.filter((g) => g.startsWith("!")).map((g) => asRegex(g.slice(1)));
  const out: string[] = [];
  const walk = (rel: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(join(snap, rel));
    } catch {
      return;
    }
    for (const n of names) {
      if (n === "node_modules" || n.startsWith(".")) continue;
      const at = rel ? `${rel}/${n}` : n;
      if (n === "package.json") {
        if (!rel || (wanted.length && !(wanted.some((r) => r.test(rel)) && !unwanted.some((r) => r.test(rel))))) continue;
        try {
          const name = (JSON.parse(read(at)) as { name?: unknown }).name;
          if (typeof name === "string") out.push(name);
        } catch { /* not a manifest */ }
      } else if (depth < 4 && lstatSync(join(snap, at), { throwIfNoEntry: false })?.isDirectory()) walk(at, depth + 1);
    }
  };
  walk("", 0);
  return out;
}
