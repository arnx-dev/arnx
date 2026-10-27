// `.arnx/baseline.json`: the tests each project's suite fails today, recorded one by one when setup proves it. A proof
// passes while every failing test is in it; a test that passes again leaves it at that proof. It grows only when
// setup records it (`arnx setup`, `arnx setup --baseline`), never at a proof. It is committed next to review.yaml and
// its hash is part of review.yaml's stamp, so a hand edit is proved again like an edit of review.yaml.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestResult } from "./adapters/types";
import { errorLine, loadFailure } from "./diagnose";
import { ArnxError } from "./errors";

export const BASELINE_FILE = ".arnx/baseline.json";

/** One test the suite fails today. `first`: the first line of its failure. `cause`: what the failure points to when it
 * looks like the environment, not the code (the setup agent saw it and could not fix it in the sandbox). `flaky`: it
 * failed in one run and passed in another; like any entry, it leaves once it passes. `load`: the entry is a whole test
 * file that does not load, so none of its tests run. */
export interface BaselineTest { id: string; file: string; first: string; cause?: string; flaky?: true; load?: true }

/** Each project's tests, by project name. */
export type Baseline = Map<string, BaselineTest[]>;

export const baselinePath = (repo: string) => join(repo, BASELINE_FILE);

/** A test's id as the baseline compares it: memory addresses in parameter ids (`<Foo object at 0x7f3a…>`) differ from
 * run to run, so they are left out. */
export const testKey = (id: string) => id.replace(/ at 0x[0-9a-f]+/gi, " at 0x");

/** The keys (testKey) of `tests`. */
export const keysOf = (tests: BaselineTest[]) => new Set(tests.map((t) => testKey(t.id)));

const FIRST_MAX = 160;

/** The line of a failure that says what went wrong (errorLine), clipped. */
export function firstOf(message: string): string {
  const line = errorLine(message);
  return line.length > FIRST_MAX ? `${line.slice(0, FIRST_MAX - 1)}…` : line;
}

/** A failing result as a baseline entry. */
export const entryOf = (t: TestResult, cause?: string): BaselineTest =>
  ({ id: t.testId, file: t.fileAttr, first: firstOf(t.message), ...(cause ? { cause } : {}),
    ...(loadFailure(t) ? { load: true as const } : {}) });

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** The baseline in `.arnx/baseline.json`; empty when there is none. */
export function readBaseline(repo: string): Baseline {
  const path = baselinePath(repo);
  if (!existsSync(path)) return new Map();
  return parseBaseline(readFileSync(path, "utf8"));
}

export function parseBaseline(text: string): Baseline {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ArnxError(`${BASELINE_FILE} is not valid JSON: ${(e as Error).message}; run \`arnx setup --baseline\` ` +
      "to record it again");
  }
  const bad = (why: string) => new ArnxError(`${BASELINE_FILE}: ${why}; run \`arnx setup --baseline\` to record it again`);
  if (!isMap(raw) || raw.version !== 1 || !isMap(raw.projects)) throw bad("must be {version: 1, projects: {...}}");
  const out: Baseline = new Map();
  for (const [name, tests] of Object.entries(raw.projects)) {
    if (!Array.isArray(tests)) throw bad(`projects.${name} must be a list of tests`);
    out.set(name, tests.map((t, i) => {
      if (!isMap(t) || typeof t.id !== "string" || !t.id || typeof t.file !== "string" || typeof t.first !== "string" ||
          (t.cause !== undefined && typeof t.cause !== "string") || (t.flaky !== undefined && t.flaky !== true) ||
          (t.load !== undefined && t.load !== true)) {
        throw bad(`projects.${name}[${i}] must have id, file and first (and may have cause, flaky: true and load: true)`);
      }
      return { id: t.id, file: t.file, first: t.first, ...(t.cause ? { cause: t.cause } : {}),
        ...(t.flaky ? { flaky: true as const } : {}), ...(t.load ? { load: true as const } : {}) };
    }));
  }
  return out;
}

/** The file's text: projects and tests in order, one test per line, so a diff shows the tests that came and went.
 * Projects with no test are left out; null when no project has one (then there is no file). */
export function baselineText(b: Baseline): string | null {
  const names = [...b.keys()].filter((n) => b.get(n)!.length).sort();
  if (!names.length) return null;
  const projects = names.map((n) => {
    const tests = [...b.get(n)!].sort((x, y) => x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    return `    ${JSON.stringify(n)}: [\n${tests.map((t) => `      ${JSON.stringify(t)}`).join(",\n")}\n    ]`;
  });
  return `{\n  "version": 1,\n  "projects": {\n${projects.join(",\n")}\n  }\n}\n`;
}

/** Writes the baseline, or removes the file when it holds no test. */
export function writeBaseline(repo: string, b: Baseline): void {
  const text = baselineText(b);
  if (text === null) rmSync(baselinePath(repo), { force: true });
  else writeFileSync(baselinePath(repo), text);
}

/** The hash review.yaml's stamp keeps of the baseline file; null when there is none. */
export function baselineDigest(repo: string): string | null {
  const path = baselinePath(repo);
  if (!existsSync(path)) return null;
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

/** What changed from `old` to `now`, per project, in a few words: "api: 3 tests added, 2 left". */
export function describeBaselineChanges(old: Baseline, now: Baseline): string[] {
  const out: string[] = [];
  for (const name of [...new Set([...old.keys(), ...now.keys()])].sort()) {
    const before = keysOf(old.get(name) ?? []);
    const after = keysOf(now.get(name) ?? []);
    const added = [...after].filter((k) => !before.has(k)).length;
    const left = [...before].filter((k) => !after.has(k)).length;
    const parts = [added ? `${added} test${added === 1 ? "" : "s"} added` : "", left ? `${left} left` : ""]
      .filter(Boolean);
    if (parts.length) out.push(`baseline ${name}: ${parts.join(", ")}`);
  }
  return out;
}
