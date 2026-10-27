// What setup and approve show a developer: what is about to happen and roughly what it costs, one line per project
// to judge, what is worth a look once the environment is proven, and what to do next.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, filesAt, git, leftOutUntracked, resolveChange, someNames, untrackedLine } from "./change";
import { type Baseline, BASELINE_FILE, describeBaselineChanges, parseBaseline, readBaseline } from "./baseline";
import { fileDigest, isProven, parseReviewFile, readSecretPins, type ReviewFile, secretPinsOf } from "./config";
import { detect } from "./detect";
import { ArnxError } from "./errors";
import { refString, type Settings, untrackedSetting } from "./settings";
import { coverageMap, type ProjectProof, unexplainedFailing } from "./setup";

// Rough minutes and USD per project, for the estimate shown before setup starts.
const MIN_PER_PROJECT = [1, 3];
const USD_PER_PROJECT = [0.03, 0.1];

export const REVIEW_FILE = ".arnx/review.yaml";
/** A copy of review.yaml as its last proof stamped it (a local file): what a changed file is compared with. */
export const PROVEN_COPY = ".arnx/setup/proven-review.yaml";
/** The baseline the last proof on this machine held, kept next to PROVEN_COPY. */
export const PROVEN_BASELINE = ".arnx/setup/proven-baseline.json";

/** Shown before setup starts: the steps, what is sent, and a rough estimate from the layout found without a model.
 * `untracked`: the agent reads untracked files too (--untracked; default `[review] untracked`). */
export function setupPreview(repo: string, s: Settings, untracked = s.untracked): string {
  const found = detect(repo, filesAt(repo, null, untracked)).candidates;
  const n = Math.max(found.filter((c) => !/^0 test files/.test(c.evidence[0] ?? "")).length, 1);
  const minutes = MIN_PER_PROJECT.map((m) => m * n + 1);
  // Said before anything runs: with no tests of its own, a project is checked with arnx's tests, not a suite.
  const bare = found.length > 0 && found.every((c) => c.language !== "rust" && /^0 test files/.test(c.evidence[0] ?? ""));
  return `Setup${s.cloud?.models ? " with arnx cloud" : ""}: finding how to run your tests in Docker (about ` +
    `${minutes[0]}–${minutes[1]} min, stops at $${s.setupBudgetUsd.toFixed(2)}).` +
    (bare ? " No tests of your own were found: arnx checks the environment with its own one-line test." : "");
}

const pad = (rows: string[][]): string[] => {
  const widths = rows[0]!.map((_, i) => Math.max(...rows.map((r) => r[i]!.length)));
  return rows.map((r) => `  ${r.map((c, i) => i === r.length - 1 ? c : c.padEnd(widths[i]!)).join("  ")}`.trimEnd());
};

/** One line per project: where it runs, with what, which services, and its suite result when known. */
export function projectTable(file: ReviewFile, proofs: ProjectProof[] = []): string {
  // The services column only when a project has services.
  const services = file.projects.some((p) => p.services.length);
  const rows = [["project", "runs in", "with", ...(services ? ["services"] : []), proofs.length ? "existing suite" : ""]];
  for (const p of file.projects) {
    const proof = proofs.find((x) => x.name === p.name);
    const failing = p.knownFailing.length ? `; ${p.knownFailing.length} known failing` : "";
    rows.push([p.name, p.workdir || ".", `${p.image} · ${p.runner}`,
      ...(services ? [p.services.map((x) => x.name).join(", ") || "-"] : []), proof ? `${proof.summary}${failing}` : ""]);
  }
  return pad(rows).join("\n");
}

/** Hosts an install line may download from without a mention: the package registries (and their subdomains). */
const REGISTRIES = ["pypi.org", "files.pythonhosted.org", "registry.npmjs.org", "registry.yarnpkg.com", "crates.io"];

/** The hosts an install line downloads from with curl, wget or git clone, other than the package registries. */
export function downloadHosts(line: string): string[] {
  if (!/\b(curl|wget)\b|\bgit\s+clone\b/.test(line)) return [];
  const hosts = [...line.matchAll(/\b(?:https?|git|ssh|ftp):\/\/(?:[^@/\s'"]+@)?([\w.-]+)|\bgit@([\w.-]+):/g)]
    .map((m) => (m[1] ?? m[2])!.toLowerCase());
  return hosts.filter((h) => !REGISTRIES.some((r) => h === r || h.endsWith(`.${r}`)));
}

/** What a developer should look at once the environment is proven: tests it cannot run, shortcuts in it, and
 * downloads from outside the package registries. */
export function approvalChecks(file: ReviewFile, proofs: ProjectProof[] = []): string[] {
  const out: string[] = [];
  for (const p of file.projects) {
    const proof = proofs.find((x) => x.name === p.name);
    if (proof?.skips.length) out.push(`${p.name}: tests skipped because ${proof.skips.join("; ")}`);
    if (proof?.gap) out.push(`${p.name}: ${proof.gap}; test_command leaves them out`);
    if (p.knownFailing.length) {
      const silent = unexplainedFailing(p);
      out.push(`${p.name}: ${p.knownFailing.length} test file(s) set aside as known failing` +
        (silent.length ? ` (${silent.length} with no reason in notes)` : "") + `: ${p.knownFailing.slice(0, 6).join(", ")}` +
        (p.knownFailing.length > 6 ? ", …" : ""));
    }
    const hidden = p.install.filter((l) => /\|\|\s*true\b/.test(l)).length + (/\|\|\s*true\b|;\s*true\)/.test(p.testCommand) ? 1 : 0);
    if (hidden) out.push(`${p.name}: ${hidden} command(s) ignore their own errors (|| true)`);
    const hosts = [...new Set(p.install.flatMap(downloadHosts))];
    if (hosts.length) out.push(`${p.name}: install downloads from ${hosts.join(", ")} (not a package registry)`);
  }
  return out;
}

/** Every warning recorded with a proof: approvalChecks, and the files allowed although they look like secrets. */
export function approvalWarnings(file: ReviewFile, proofs: ProjectProof[] = []): string[] {
  const checks = approvalChecks(file, proofs);
  const allowed = secretPinsOf(file.raw);
  if (allowed.length) {
    checks.push(`${allowed.map((p) => p.path).join(", ")}: allowed although secret-looking; sent to the model and the ` +
      "sandbox");
  }
  return checks;
}

/** What the files line counts: each project's owned and used files, what no project tests, and the untracked files
 * left out (only when untracked files are not read). Null for a one-project file of the old form. */
export interface FilesSummary { projects: { name: string; owned: number; used: number }[]; notTested: string[];
  untrackedLeftOut: string[] }

export function filesSummary(file: ReviewFile, repo: string, untracked = false): FilesSummary | null {
  if (file.legacy) return null;
  const map = coverageMap(repo, file, untracked);
  return { projects: map.projects.map((p) => ({ name: p.name, owned: p.owned, used: p.used })),
    notTested: map.uncovered.map((u) => u.path), untrackedLeftOut: untracked ? [] : leftOutUntracked(repo) };
}

/** One line under the table: `Files: shop owns 3, uses 0 · not tested: none · 1 untracked left out (notes.md)`. Which
 * files a project owns says nothing about whether its tests cover them. */
export function filesLine(f: FilesSummary): string {
  const left = f.untrackedLeftOut;
  return `  Files: ${f.projects.map((p) => `${p.name} owns ${p.owned}, uses ${p.used}`).join("; ")} · not tested: ` +
    `${f.notTested.length ? f.notTested.join(", ") : "none"}` +
    (left.length ? ` · ${left.length} untracked left out (${left.slice(0, 3).join(", ")}${left.length > 3 ? ", …" : ""})`
      : "");
}

/** The screen before the proof runs: the table and the files line (the agent's notes go to a file). `untracked`:
 * untracked files are counted, as setup and reviews read them. */
export function approvalScreen(file: ReviewFile, repo: string, o: { proofs?: ProjectProof[]; header?: string;
  untracked?: boolean }): string {
  const lines = [...(o.header ? [o.header, ""] : []), projectTable(file, o.proofs)];
  const files = filesSummary(file, repo, !!o.untracked);
  if (files) lines.push(filesLine(files));
  return lines.join("\n");
}

/** The lines of "Worth a look" after a proof, only what applies: the warnings, then what no project tests (a change
 * there is reported as not tested) and source files no project mentions. */
export function worthALook(file: ReviewFile, repo: string, o: { proofs?: ProjectProof[]; untracked?: boolean })
  : string[] {
  const lines = [...baselineLines(file, currentBaseline(repo) ?? new Map()), ...approvalWarnings(file, o.proofs)];
  if (!file.legacy) {
    const map = coverageMap(repo, file, !!o.untracked);
    lines.push(...map.uncovered.map((u) => `not tested: ${u.path} (${u.files} file${u.files === 1 ? "" : "s"}` +
      `${u.untracked ? `, ${u.untracked} untracked` : ""}): ${u.reason}`));
    if (map.unexplained.length) lines.push(`${map.unexplained.length} source files no project mentions`);
  }
  return lines;
}

/** One line per project with tests in the baseline: how many fail today, and the causes and flaky tests among them
 * (the rest fail on the code as it is). */
export function baselineLines(file: ReviewFile, base: Baseline): string[] {
  const out: string[] = [];
  for (const p of file.projects) {
    const tests = base.get(p.name) ?? [];
    if (!tests.length) continue;
    const groups = new Map<string, number>();
    for (const t of tests) {
      const k = t.flaky ? "flaky" : t.cause;
      if (k) groups.set(k, (groups.get(k) ?? 0) + 1);
    }
    const why = [...groups].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${n} ${k}`);
    if (groups.size > 3) why.push("…");
    out.push(`${p.name}: ${tests.length} test${tests.length === 1 ? " fails" : "s fail"} today, recorded in ` +
      `${BASELINE_FILE}${why.length ? ` (${why.join("; ")})` : ""}`);
  }
  return out;
}

/** After the proof: the next command, and what it would review in this repository right now (what would be sent:
 * tracked changes, and untracked files only with `untracked`, default `[review] untracked`). */
export function nextStep(repo: string, untracked = untrackedSetting(repo)): string {
  try {
    const c = resolveChange(repo, null, readSecretPins(repo), { untracked });
    const some = `${c.files.slice(0, 3).join(", ")}${c.files.length > 3 ? `, … (${c.files.length} files)` : ""}`;
    const what = c.kind === "branch" ? describe(c)
      : c.kind === "worktree" ? `your uncommitted work: ${some}`
      : c.kind === "no-commits" ? "every file: no commits yet"
      : `the last commit: ${git(repo, ["log", "-1", "--format=%h %s"]).trim()}`;
    return `Next: arnx review (${what})`;
  } catch (e) {
    if (!(e instanceof ArnxError)) throw e;
    return `Next: arnx review, once there is a change (${e.message})`;
  }
}

/** The copy of review.yaml the last proof on this machine kept; null when there is none or it does not read. */
function provenCopy(repo: string): ReviewFile | null {
  const path = join(repo, PROVEN_COPY);
  if (!existsSync(path)) return null;
  try {
    return parseReviewFile(readFileSync(path, "utf8"));
  } catch (e) {
    if (e instanceof ArnxError) return null;
    throw e;
  }
}

/** The baseline the last proof on this machine held: empty when that proof held none (a copy of review.yaml and no
 * baseline copy), null when there is no copy at all or it does not read. */
function provenBaseline(repo: string): Baseline | null {
  const path = join(repo, PROVEN_BASELINE);
  if (!existsSync(path)) return existsSync(join(repo, PROVEN_COPY)) ? new Map() : null;
  try {
    return parseBaseline(readFileSync(path, "utf8"));
  } catch (e) {
    if (e instanceof ArnxError) return null;
    throw e;
  }
}

/** The baseline as it is now; null when it does not read (then nothing is proven). */
function currentBaseline(repo: string): Baseline | null {
  try {
    return readBaseline(repo);
  } catch (e) {
    if (e instanceof ArnxError) return null;
    throw e;
  }
}

/** Where review.yaml stands against its last proof on this machine. `proven`: its stamp holds (over review.yaml and
 * the baseline) and they hold what the proof's copies hold (or there is no copy: a proof by an older arnx, a fresh
 * clone). Otherwise `changes`: what changed since the copies, stamp or not (null without a copy). `stamped`: it
 * carries a stamp, current or not. */
export function proofState(repo: string, file: ReviewFile): { proven: boolean; stamped: boolean;
  changes: string[] | null } {
  const copy = provenCopy(repo);
  const oldBase = provenBaseline(repo);
  const base = currentBaseline(repo);
  const baseChanges = oldBase && base ? describeBaselineChanges(oldBase, base) : [];
  // A stamp that holds over content this machine did not prove (recomputed by hand) is no proof.
  const proven = base !== null && isProven(repo, file) && (!copy || fileDigest(copy) === fileDigest(file)) &&
    !baseChanges.length;
  const stamped = typeof file.raw.approved === "object" && file.raw.approved !== null;
  return { proven, stamped, changes: !proven && copy ? [...describeChanges(copy, file), ...baseChanges] : null };
}

type Raw = Record<string, unknown>;
/** Equal as data (the YAML's whole numbers are bigints). */
const same = (a: unknown, b: unknown) => {
  const text = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => typeof x === "bigint" ? `${x}n` : x);
  return text(a) === text(b);
};
const clipped = (s: string) => s.length > 80 ? `${s.slice(0, 79)}…` : s;
/** The keys a change is described by; any other key that changed is named as it is. */
const NAMED = new Set(["test_command", "install", "known_failing", "env", "services", "owns", "uses", "approved"]);

/** Projects added or removed, then per project: test_command (old → new), install, known_failing (added and
 * removed files), env, services, owns, uses, and any other key by name; then the file's own keys. */
export function describeChanges(old: ReviewFile, now: ReviewFile): string[] {
  const out: string[] = [];
  for (const p of old.projects) if (!now.projects.some((q) => q.name === p.name)) out.push(`project ${p.name} removed`);
  for (const p of now.projects) if (!old.projects.some((q) => q.name === p.name)) out.push(`project ${p.name} added`);
  const spec = (f: ReviewFile, name: string): Raw => (f.legacy ? f.raw : (f.raw.projects as Record<string, Raw>)[name]) ?? {};
  for (const p of now.projects) {
    const o = old.projects.find((q) => q.name === p.name);
    if (!o) continue;
    const who = now.legacy ? "" : `${p.name}: `;
    if (o.testCommand !== p.testCommand) {
      out.push(`${who}test_command \`${clipped(o.testCommand)}\` → \`${clipped(p.testCommand)}\``);
    }
    if (!same(o.install, p.install)) out.push(`${who}install changed`);
    const added = p.knownFailing.filter((k) => !o.knownFailing.includes(k));
    const removed = o.knownFailing.filter((k) => !p.knownFailing.includes(k));
    if (added.length) out.push(`${who}known_failing added ${added.join(", ")}`);
    if (removed.length) out.push(`${who}known_failing removed ${removed.join(", ")}`);
    for (const [key, a, b] of [["env", o.env, p.env], ["services", o.services, p.services], ["owns", o.owns, p.owns],
      ["uses", o.uses, p.uses]] as const) {
      if (!same(a, b)) out.push(`${who}${key} changed`);
    }
    const before = spec(old, p.name), after = spec(now, p.name);
    const other = [...new Set([...Object.keys(before), ...Object.keys(after)])]
      .filter((k) => !NAMED.has(k) && !same(before[k], after[k])).sort();
    if (other.length) out.push(`${who}${other.join(", ")} changed`);
  }
  if (!now.legacy) {
    // Services are told per project, where they are used.
    const keys = ["version", "allow_env_names", "uncovered", "allow_secret_looking"]
      .filter((k) => !same(old.raw[k], now.raw[k]));
    if (keys.length) out.push(`${keys.join(", ")} changed`);
  }
  return out;
}
