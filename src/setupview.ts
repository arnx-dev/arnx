// What setup and approve show a developer: what is about to happen and roughly what it costs, one line per project
// to judge, the points worth checking before approving, and what to do next.
import { describe, filesAt, git, leftOutUntracked, resolveChange, someNames, untrackedLine } from "./change";
import { readSecretPins, type ReviewFile, secretPinsOf } from "./config";
import { detect } from "./detect";
import { ArnxError } from "./errors";
import { refString, type Settings, untrackedSetting } from "./settings";
import { coverageMap, type ProjectProof, unexplainedFailing } from "./setup";

// Rough minutes and USD per project, for the estimate shown before setup starts.
const MIN_PER_PROJECT = [1, 3];
const USD_PER_PROJECT = [0.03, 0.1];

export const REVIEW_FILE = ".arnx/review.yaml";

/** Shown before setup starts: the steps, what is sent, and a rough estimate from the layout found without a model.
 * `untracked`: the agent reads untracked files too (--untracked; default `[review] untracked`). */
export function setupPreview(repo: string, s: Settings, untracked = s.untracked): string {
  const found = detect(repo, filesAt(repo, null, untracked)).candidates;
  const n = Math.max(found.filter((c) => !/^0 test files/.test(c.evidence[0] ?? "")).length, 1);
  const minutes = MIN_PER_PROJECT.map((m) => m * n + 1);
  return `Setup${s.cloud?.models ? " with arnx cloud" : ""}: finding how to run your tests in Docker (about ` +
    `${minutes[0]}–${minutes[1]} min, stops at $${s.setupBudgetUsd.toFixed(2)}).`;
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

/** What a developer should look at before approving: tests the environment cannot run, and shortcuts in it. */
export function approvalChecks(file: ReviewFile, proofs: ProjectProof[] = []): string[] {
  const out: string[] = [];
  for (const p of file.projects) {
    const proof = proofs.find((x) => x.name === p.name);
    if (proof?.skips.length) out.push(`${p.name}: tests skipped because ${proof.skips.join("; ")}`);
    if (p.knownFailing.length) {
      const silent = unexplainedFailing(p);
      out.push(`${p.name}: ${p.knownFailing.length} test file(s) set aside as known failing` +
        (silent.length ? ` (${silent.length} with no reason in notes)` : "") + `: ${p.knownFailing.slice(0, 6).join(", ")}` +
        (p.knownFailing.length > 6 ? ", …" : ""));
    }
    const hidden = p.install.filter((l) => /\|\|\s*true\b/.test(l)).length + (/\|\|\s*true\b|;\s*true\)/.test(p.testCommand) ? 1 : 0);
    if (hidden) out.push(`${p.name}: ${hidden} command(s) ignore their own errors (|| true)`);
  }
  return out;
}

/** Every `!` line of the approval screen: approvalChecks, and the files allowed although they look like secrets. */
export function approvalWarnings(file: ReviewFile, proofs: ProjectProof[] = []): string[] {
  const checks = approvalChecks(file, proofs);
  const allowed = secretPinsOf(file.raw);
  if (allowed.length) {
    checks.push(`${allowed.map((p) => p.path).join(", ")}: sent to the model and the sandbox although they look like ` +
      "secrets (you allowed them under allow_secret_looking): approve only if they hold test fixtures");
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

/** The screen before "Approve?": the table, the files line, the checks, what is not tested (the agent's notes go to a
 * file). `untracked`: untracked files are counted, as setup and reviews read them. */
export function approvalScreen(file: ReviewFile, repo: string, o: { proofs?: ProjectProof[]; header?: string;
  untracked?: boolean }): string {
  const lines = [...(o.header ? [o.header, ""] : []), projectTable(file, o.proofs)];
  const files = filesSummary(file, repo, !!o.untracked);
  if (files) lines.push(filesLine(files));
  const checks = approvalWarnings(file, o.proofs);
  if (checks.length) lines.push("", "Check before approving:", ...checks.map((c) => `  ! ${c}`));
  if (!file.legacy) {
    const map = coverageMap(repo, file, !!o.untracked);
    if (map.uncovered.length) {
      lines.push("", "Not tested (a change here is reported as not tested):",
        ...map.uncovered.map((u) => `  ${u.path} (${u.files} file${u.files === 1 ? "" : "s"}` +
          `${u.untracked ? `, ${u.untracked} untracked` : ""}): ${u.reason}`));
    }
    if (map.unexplained.length) lines.push(`  ${map.unexplained.length} source files no project mentions`);
  }
  return lines.join("\n");
}

/** After approval: the next command, and what it would review in this repository right now (what would be sent:
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
