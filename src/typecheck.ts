// The project's own type check (`typecheck` in review.yaml; TypeScript projects only). A review runs it once on the
// change, after the final runs and without arnx's generated tests, in the same sandbox; when it reports errors, once
// more on the code before the change, to tell the errors the change brought from those already there. Types are
// deterministic, so once is enough. It is information: it never changes a test's outcome, a finding, whether a run
// reported, or the exit code.
import { posix } from "node:path";
import type { ReviewConfig } from "./config";
import { ArnxError } from "./errors";
import type { Runner } from "./sandbox";

export const TYPECHECK_TIMEOUT = 600;
/** Most errors review.json lists per project (`errors` always counts them all). */
export const DIAGNOSTICS_KEPT = 100;
const OUTPUT_KEPT = 2000;

/** clean: exit code 0; errors: tsc reported type errors; failed: the command failed without reporting any (it could
 * not start, or its output is not tsc's); timed-out. */
export const TYPECHECK_STATUSES = ["clean", "errors", "failed", "timed-out"] as const;
export type TypeCheckStatus = typeof TYPECHECK_STATUSES[number];
/** How the errors were compared with the code before the change. */
export const TYPECHECK_BEFORE = ["compared", "no-base", "dependencies-changed", "failed"] as const;
export type TypeCheckBefore = typeof TYPECHECK_BEFORE[number];

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
  /** The end of the output, when the check failed or timed out. */
  output?: string;
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

/** The project's type check, once, in `session` on its snapshot as it is now. Never throws: a Docker error is a
 * failed check. */
export function runTypecheck(session: Runner, cfg: ReviewConfig): TypeCheckRun {
  try {
    const r = session.run(cfg.typecheck!, TYPECHECK_TIMEOUT);
    const errors = r.timedOut ? [] : parseTsc(r.output, cfg.workdir);
    const status: TypeCheckStatus = r.timedOut ? "timed-out" : errors.length ? "errors"
      : r.exitCode === 0 ? "clean" : "failed";
    return { status, errors, output: r.output, exitCode: r.exitCode, timedOut: r.timedOut, seconds: r.seconds };
  } catch (e) {
    if (!(e instanceof ArnxError)) throw e;
    return { status: "failed", errors: [], output: e.message, exitCode: null, timedOut: false, seconds: 0 };
  }
}

const keyOf = (e: TscError) => `${e.file}\0${e.code}\0${e.message}`;

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
                            before?: { status: TypeCheckBefore; errors?: TscError[] }): TypeCheck {
  const touched = new Set(changed);
  const fresh = before?.errors ? markNew(run.errors, before.errors) : null;
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
    secs: Math.round(secs * 10) / 10 };
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;

const NOT_COMPARED: Record<Exclude<TypeCheckBefore, "compared">, string> = {
  "no-base": "the change has no code before it",
  "dependencies-changed": "the change alters the dependencies",
  failed: "the type check did not run there",
};

/** The result in a few words, for review.md, the summary and setup ("3 type errors: 1 new with this change, …"). */
export function describeTypecheck(t: Pick<TypeCheck, "status" | "errors" | "inChangedFiles" | "new" | "preExisting"
  | "before">): string {
  if (t.status === "clean") return "no type errors";
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
