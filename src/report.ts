// review.md (for people) and review.json (for arnx). The user marks each finding in review.md with one box and may
// answer questions; `arnx accept` reads the marks back. review.json keeps the key names Python arnx wrote, so
// reviews written by either version load.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AdapterId } from "./adapters/types";
import { type Before, type FixStatus, isPreExisting } from "./before";
import { ArnxError } from "./errors";
import { type ModelUse, parseJsonObject } from "./llm";
import type { ProviderFailure } from "./outage";
import { type Shallow, SHALLOW_NOTE } from "./shallow";
import { describeDiagnostic, describeTypecheck, type TypeCheck } from "./typecheck";
import { pyTruthy, splitLines } from "./util";

/** rewrite: the bug is real but the test is wrong; the owner says why on a `Rewrite:` line after the Mark line, and
 * accept writes a new test from that (older review.md files have three boxes, and still parse). */
export const MARKS = ["real", "intended", "noise", "rewrite"] as const;
const BOX = /\[([ xX])\]\s*(real|intended|noise|rewrite)/g;
/** The owner's reason for a rewrite mark: on the line after the Mark line, running until a blank line or the next
 * Mark or Severity line (review.md wraps long lines). */
export const REWRITE = "Rewrite:";
export const SEVERITIES = ["high", "medium", "low"] as const;
export type Severity = (typeof SEVERITIES)[number];
const SEVERITY_BOX = /\[([ xX])\]\s*(high|medium|low)/g;
const HEADING = /^###\s+([FQ]\d+)\b/;
/** An issue's heading in review.md: its Mark line covers every finding its "Failing tests" line names. */
export const ISSUE_HEADING = /^###\s+((?:Issue|Problem)\s+\d+)\b/;
export const isIssue = (heading: string | null) => !!heading && /^(?:Issue|Problem) /.test(heading);
const FAILING_TESTS = "- Failing tests:";

export interface Finding {
  id: string;
  testId: string;
  func: string;
  file: string | null;
  message: string;
  explanation: string;
  verdict: string | null;
  reason: string;
  /** The project whose round found it ("main" for a file without projects). */
  project: string;
  /** The question whose answer the test assumes ("Q2"); such a finding waits for the answer. */
  dependsOn?: string | null;
  /** The hunt's suspect this test checked ("S2"), when it checked one. */
  suspect?: string;
  /** The model that gave the second opinion, when it was the fallback rather than the challenger. */
  judge?: string;
  /** What its test did on the code before the change (absent when the before/after check is off). A pre-existing
   * finding is not challenged and does not set the exit code. */
  before?: Before;
  /** Its test checks the code's text or only that something exists (shallow.ts); absent: it exercises behaviour, or
   * the review predates the check. Information only. */
  shallow?: Shallow;
}

/** A defect the hunt suspected, and what its test showed. */
export interface SuspectOutcome {
  project: string;
  id: string;
  file: string;
  line: number;
  claim: string;
  /** The model that suspected it. */
  by: string;
  /** "failed" only until the second model has judged its findings (see `adjudicate`). "not reproduced": its test
   * passed, which does not rule the suspect out (the test may not reach the interaction it describes). */
  outcome: "failed" | "proven" | "same cause" | "disputed" | "unchecked" | "pending answer" | "pre-existing"
    | "not reproduced"
    | "inconclusive" | "not tested";
  tests: string[];
  findings?: string[];
  reason?: string;
  /** "same cause": the suspect whose cause its tests failed for (see `sameCause`). */
  sameAs?: string;
}

/** One reviewed project: how many tests ran, and whether the reviewer ever saw them run. */
export interface ProjectStat {
  name: string;
  testFiles: number;
  tests: number;
  passed: number;
  missingRuns: number;
  sawResults: boolean;
  /** Why this project's reviewer stopped ("end_turn", "budget", "api_error: ..."); absent in older reviews. */
  stop?: string;
}

/** Findings that share one cause, explained in plain language by the second model (report only: verdicts, marks and
 * exit codes stay per finding). Empty fields are left out of the report. */
export interface Group {
  findings: string[];
  title: string;
  input: string;
  actual: string;
  expected: string;
  consequence: string;
  /** The grouping model's estimate, which orders the report (absent in older reviews, or when it gave none). */
  severity?: Severity;
}

const SEVERITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 3 };
/** Most severe first; a group with no estimate goes between medium and low. Stable: ties keep the model's order. */
export const bySeverity = (a: Group, b: Group) => (SEVERITY_ORDER[a.severity ?? ""] ?? 2) -
  (SEVERITY_ORDER[b.severity ?? ""] ?? 2);
export const rankGroups = (groups: Group[]) => [...groups].sort(bySeverity);

/** A test that passed in every run and what the reviewer said it checks. */
export interface Checked { project: string; test: string; expects: string }

/** A passing test run on the code before the change (the fix proof). `beforeStatus` "fixed": it fails there in every
 * run, so the change fixes what it checks; `beforeRuns`: its outcome in each run there. */
export interface FixProof { testId: string; project: string; file: string | null; beforeStatus: FixStatus;
  beforeRuns: string[]; beforeDetail: string }

export interface Review {
  id: string;
  change: string;
  filesChanged: number;
  added: number;
  removed: number;
  reviewer: string;
  challenger: string;
  promptVersion: string;
  findings: Finding[];
  questions: string[];
  flaky: string[];
  errors: string[];
  passed: number;
  testsWritten: number;
  missingRuns: number;
  notSent: string[];
  /** Changed files .arnxignore left out of the review. */
  ignoredChanged?: string[];
  /** Changed lockfiles: in the sandbox, their text not sent. */
  lockfilesChanged?: string[];
  /** Untracked files the review sent because the owner opted in (--untracked); absent when none. */
  untrackedIncluded?: string[];
  /** How many untracked files the review left out (not sent, not in the sandbox); absent when none. */
  untrackedLeftOut?: number;
  costUsd: number;
  seconds: number;
  stop: string;
  writeDir: string;
  language: AdapterId;
  /** Reviewed projects, in review order; projects routed but over the limit; changed files no project covers. */
  projects: string[];
  notReviewed: string[];
  /** Projects that got their type check only: the change reached them through a `uses` entry holding other projects,
   * and those projects (`by`) reviewed the files. */
  typecheckOnly?: { project: string; by: string[] }[];
  uncovered: { path: string; reason: string }[];
  /** The project each question came from, parallel to `questions`. */
  questionProjects: string[];
  /** Each reviewed project's generated-tests directory, relative to the repository root. */
  writeDirs: Record<string, string>;
  /** Per reviewed project, in review order (empty in reviews written before it existed). */
  projectStats: ProjectStat[];
  /** Per model: calls, tokens and cost (empty in reviews written before it existed). costUsd is their sum. */
  usage: ModelUse[];
  /** Findings grouped by cause, in report order (empty: list findings one by one). */
  groups: Group[];
  /** Passing tests and what they check. */
  checked: Checked[];
  /** Per project with changed source files: those no arnx test refers to, out of how many (absent when every
   * changed source file is named by a test, and in older reviews). */
  untested?: Untested[];
  /** What the hunt suspected and what each suspect's test showed (absent when no hunt ran). */
  suspects?: SuspectOutcome[];
  /** Time spent in stages worth measuring, in seconds: the before/after check, summed over projects (absent when it
   * is off), and the fix proof's share beside it (absent when the fix proof is off). */
  timings?: { beforeCheckSecs: number; fixProofSecs?: number };
  /** The before/after check had nothing to compare against: the change is the first commit, or the code before it
   * holds none of the changed source files (absent otherwise, and when the check is off or no test failed). */
  beforeBaseEmpty?: "first-commit" | "new-files";
  /** Passing tests run on the code before the change, by project and test id (absent when none ran there: the
   * before/after check or the fix proof is off, no test passed, or the change touches no source). */
  fixProof?: FixProof[];
  /** Each reviewed project's type check, in review order (absent when no project has one). Information only: it sets
   * no finding, status or exit code. */
  typecheck?: TypeCheck[];
  /** Calls a model provider failed because it was down or refused the key, per provider and kind (absent when none
   * did). Information only: it sets no status or exit code; the work those calls missed does. */
  providerFailures?: ProviderFailure[];
}

export interface Untested { project: string; files: string[]; of: number;
  /** The reviewer's reason a file could not be tested, by path. */
  reasons?: Record<string, string> }

/** Passing tests that fail on the code before the change: proof the change fixes what they check. */
export const fixed = (r: Review) => (r.fixProof ?? []).filter((x) => x.beforeStatus === "fixed");

const untestedCount = (r: Review) => (r.untested ?? []).reduce((n, u) => n + u.files.length, 0);
const untestedOf = (r: Review) => (r.untested ?? []).reduce((n, u) => n + u.of, 0);

/** More than one project, or something not tested: the report names projects and lists what was left out. */
const multi = (r: Review) => r.projects.length > 1 || r.uncovered.length > 0 || r.notReviewed.length > 0 ||
  (r.typecheckOnly ?? []).length > 0;

/** Findings the change may have caused: all but those that fail the same way before it. */
export const active = (r: Review) => r.findings.filter((f) => !isPreExisting(f));
export const confirmed = (r: Review) => active(r).filter((f) => f.verdict !== "disputed" && !f.dependsOn);
/** Suspects the hunt named when the review wrote no test at all: "nothing found" would then say nothing. */
const neverTested = (r: Review) => r.testsWritten === 0 ? (r.suspects ?? []).filter((s) => s.outcome === "not tested")
  : [];
export const incomplete = (r: Review) => r.stop !== "end_turn" || r.missingRuns > 0 || neverTested(r).length > 0;
export const exitCode = (r: Review) => (confirmed(r).length ? 1 : incomplete(r) ? 2 : 0);

export interface Marks {
  findings: Record<string, string | null>;
  /** The severity ticked for each finding (null: none ticked). */
  severity: Record<string, string | null>;
  answers: Record<string, string>;
  /** Per finding marked rewrite: the owner's reason (its own Rewrite line, else its issue's). */
  rewrites?: Record<string, string>;
}

const verdictOf = (f: Finding) => f.verdict ?? "not challenged";
/** `text` cut to `max` characters at a word, with an ellipsis ("The ba" read as a typo). */
function shorten(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[\s,.;:]+$/, "")}…`;
}
export const firstLine = (text: string) => (splitLines(text.trim())[0] ?? "").slice(0, 300);

function duration(seconds: number): string {
  const total = Math.trunc(seconds);
  const m = Math.floor(total / 60), s = total % 60;
  return m ? `${m}m${String(s).padStart(2, "0")}s` : `${s}s`;
}

/** Who reviewed: the reviewer, the second opinion and the prompts' version; with arnx cloud, only its tier (the harness
 * is arnx cloud's own business: review.json keeps it, the report does not show it). */
function modelsLine(r: Review): string {
  const c = CLOUD_MODEL.exec(r.reviewer);
  return c ? `- Models: arnx cloud ${c[1]}`
    : `- Reviewer: ${r.reviewer} · Second opinion: ${r.challenger} · Prompts: ${r.promptVersion}`;
}

/** arnx cloud's models as review.json names them: "arnx:<tier>/<harness>", and "/<role>" in usage. */
const CLOUD_MODEL = /^arnx:([^/]+)\/([^/]+)(?:\/(.+))?$/;

/** "Cost $0.47 (claude-sonnet-5-5 $0.40 · gpt-5.5 $0.07)": the total, then each model's share. With arnx cloud, the
 * total alone ("Billed $0.89 by arnx cloud"): how it splits the work is its own business. */
function costLine(r: Review): string {
  const usage = r.usage ?? [];
  if (!usage.length) return `Cost $${r.costUsd.toFixed(2)}`;
  // arnx cloud's figure is what it charged the account (its price, not the providers' cost); a call it could not
  // price is not charged, so there is no note to add.
  if (usage.every((u) => CLOUD_MODEL.test(u.model))) return `Billed $${r.costUsd.toFixed(2)} by arnx cloud`;
  const parts = usage.map((u) => `${u.model.replace(/^[^:]*:/, "")} $${u.costUsd.toFixed(2)}`).join(" · ");
  const unknown = usage.reduce((a, u) => a + u.unknownCalls, 0);
  // A call cut off mid-reply is billed, but the provider never said for how much: its cost is not in the total.
  const note = unknown ? `; ${unknown === 1 ? "1 call was" : `${unknown} calls were`} cut off mid-reply, so arnx ` +
    `could not price what the provider billed for ${unknown === 1 ? "it" : "them"}: the cost shown may be a little low`
    : "";
  return `Cost $${r.costUsd.toFixed(2)} (${parts}${note})`;
}

/** Whether arnx cloud ran the review: then its cost is what arnx cloud billed. */
export const billedByCloud = (r: Review) => CLOUD_MODEL.test(r.reviewer);

const ids = (fs: Finding[]) => fs.map((f) => f.id).join(", ");
const ticks = (items: string[]) => items.map((t) => `\`${t}\``).join(", ");

/** What the review sent beyond tracked files, or left out of them (review.md and the summary). */
function untrackedLines(r: Review): string[] {
  const out: string[] = [];
  const n = r.untrackedIncluded?.length ?? 0;
  if (n) {
    out.push(`Untracked files included (--untracked): ${ticks(r.untrackedIncluded!.slice(0, 10))}` +
      (n > 10 ? ` (+${n - 10} more)` : ""));
  }
  if (r.untrackedLeftOut) {
    out.push(`Untracked files left out (not sent): ${r.untrackedLeftOut}; \`arnx review --untracked\` includes them`);
  }
  return out;
}

const opinion = (f: Finding) => f.verdict ? `${f.verdict} by the second opinion` : "not challenged";

/** Why a project's reviewer stopped, in words. A failed call the provider is known to have caused is named in the
 * provider's own line (failureLine), not here. */
function why(stop: string, r?: Review): string {
  if (stop.startsWith("api_error") && r?.providerFailures?.some((f) => f.roles.includes("reviewer"))) {
    return "the reviewer's model call failed";
  }
  if (stop.startsWith("api_error: ")) return `the reviewer's model call failed (${stop.slice("api_error: ".length)})`;
  if (stop === "budget") {
    return "the review budget ran out before the reviewer finished (raise `review_usd` under [budget] in " +
      `.arnx/config.toml${r && billedByCloud(r) ? ", or top up: arnx credits" : ""}, then run arnx review again)`;
  }
  if (stop === "max_turns") return "the reviewer ran out of turns";
  if (stop === "refusal") return "the model refused the request";
  return `the reviewer stopped (${stop})`;
}

/** What kept the review from being complete, per project where known; then notes that do not make it incomplete. */
function statusOf(r: Review): { problems: string[]; notes: string[] } {
  const problems: string[] = [], notes: string[] = [];
  const stats = r.projectStats ?? [];
  for (const p of stats) {
    // reviews written before per-project stops: a project with no tests is put down to the review's stop
    const stop = p.stop ?? (p.tests ? "end_turn" : r.stop);
    if (stop !== "end_turn") {
      problems.push(p.tests ? `\`${p.name}\`: ${why(stop, r)} before it finished; the tests it wrote ran`
        : `\`${p.name}\` produced no tests: ${why(stop, r)}`);
    } else if (p.missingRuns) {
      problems.push(`\`${p.name}\`: ${plural(p.missingRuns, "run")} gave no report (timed out or crashed)`);
    } else if (!p.tests) {
      notes.push(p.testFiles ? `\`${p.name}\`: no run reported its tests` : `\`${p.name}\`: the reviewer wrote no tests`);
    }
  }
  const untried = neverTested(r);
  if (!problems.length && untried.length && r.stop === "end_turn" && !r.missingRuns) {
    problems.push(`the hunt suspected ${plural(untried.length, "defect")} (${untried.map((s) => s.id).join(", ")}), ` +
      "but no test was written for any of them");
  } else if (!problems.length && incomplete(r)) {
    problems.push(r.stop !== "end_turn" ? why(r.stop, r) : `${plural(r.missingRuns, "run")} gave no report`);
  }
  return { problems, notes };
}

/** What the work of each role is, when all of it is missing. */
const WORK: Record<string, string> = { reviewer: "the reviewer's tests", "part-hunt": "the part hunts",
  "second-hunt": "the second hunt", rank: "the ranking of suspects", "merge-questions": "the merging of questions",
  challenge: "the second opinions", explain: "the grouping of findings" };
const ROLE: Record<string, string> = { "part-hunt": "part hunts", "second-hunt": "second hunt",
  "merge-questions": "merging questions", challenge: "second opinion", explain: "grouping findings" };

/** What one provider's failed calls mean for the review, in one sentence: who, why, how many, what is missing and
 * what to do. Never a key or a response body; arnx cloud's models and their vendor are never named. */
export function failureLine(f: ProviderFailure): string {
  const every = f.failed === f.calls;
  if (f.provider === "arnx") {
    const rounds = every ? `every project round (${f.calls})` : `${f.failed} of ${f.calls} project rounds`;
    return `arnx cloud's models unavailable: ${rounds} stopped on a failed model call. Run \`arnx review\` again later.`;
  }
  const a = f.kind === "auth" || f.attempts === undefined ? ""
    : f.failed === 1 ? plural(f.attempts, "attempt")
    : f.attempts % f.failed === 0 ? `${plural(f.attempts / f.failed, "attempt")} each` : `${f.attempts} attempts in all`;
  const roles = f.roles.map((x) => ROLE[x] ?? x).join(", ");
  const count = every ? `on every call (${plural(f.calls, "call")}${a ? `, ${a}` : ""})`
    : `on ${f.failed} of ${f.calls} calls (${roles}${a ? `; ${a}` : ""})`;
  const missing = f.missing.length ? `; missing: ${f.missing.map((x) => WORK[x] ?? x).join(", ")}`
    : every ? "; other models answered in its place" : "";
  return f.kind === "auth" ? `${f.name} refused the key: ${f.detail} ${count}${missing}. Check ${f.key ?? "its key"}.`
    : `${f.name} unavailable: ${f.detail} ${count}${missing}. Run \`arnx review\` again when it is back.`;
}

function statusLines(r: Review): string[] {
  const { problems, notes } = statusOf(r);
  const names = r.projects.length > 1 ? ` (${ticks(r.projects)})` : "";
  const out = [problems.length ? `Incomplete: ${problems.join("; ")}. Run \`arnx review\` again to cover it.`
    : untestedCount(r) ? `Partly covered: no arnx test refers to ${untestedCount(r)} of the ${untestedOf(r)} changed ` +
      "source files below, so finding nothing there says nothing about them. Check them yourself, or review them " +
      "on their own with `arnx review --range`."
    : `Complete: ${r.projects.length > 1 ? `${r.projects.length} projects tested${names}` : "the change was tested"}; ` +
      "every run reported its tests."];
  out.push(...(r.providerFailures ?? []).map(failureLine));
  for (const u of (r.untested ?? []).filter((x) => x.files.length)) {
    const why = (f: string) => u.reasons?.[f] ? ` (reviewer: ${u.reasons[f]})` : "";
    out.push(`Not tested by arnx${multi(r) ? ` in \`${u.project}\`` : ""}: ` +
      `${u.files.map((f) => `\`${f}\`${why(f)}`).join(", ")}.`);
  }
  for (const n of notes) out.push(`Note: ${n}.`);
  for (const t of r.typecheck ?? []) {
    out.push(`Type check${multi(r) ? ` in \`${t.project}\`` : ""}: ${describeTypecheck(t)}${t.status === "clean" ? ""
      : " (see Type check below)"}.`);
  }
  for (const c of r.typecheckOnly ?? []) {
    const checked = (r.typecheck ?? []).some((t) => t.project === c.project);
    out.push(`${checked ? "Type check only in" : "No round of its own for"} \`${c.project}\`: the change reaches it ` +
      `through a folder holding other projects, and ${ticks(c.by)} reviewed those files.`);
  }
  if (r.notReviewed.length) {
    out.push(`Not reviewed: ${plural(r.notReviewed.length, "more project")} this change touches ` +
      `(${ticks(r.notReviewed)}): over the project limit; raise max_projects in .arnx/config.toml.`);
  }
  if (r.uncovered.length) {
    const reasons = new Set(r.uncovered.map((u) => u.reason));
    out.push(reasons.size === 1 && reasons.has("no project covers it")
      ? `Not covered by any project: ${ticks(r.uncovered.map((u) => u.path))}.`
      : `Not covered: ${r.uncovered.map((u) => `\`${u.path}\` (${u.reason})`).join(", ")}.`);
  }
  return out;
}

/** `marked`: the finding has its own Mark line (false: its issue's Mark line covers it). */
function findingLines(r: Review, f: Finding, marked = true): string[] {
  const state = isPreExisting(f) ? "already failing before this change"
    : f.before?.status === "regression" ? `regression · ${opinion(f)}` : opinion(f);
  const out = [`### ${f.id} · ${state}`, "", `- Test: \`${f.testId}\``, `- Failure: \`${firstLine(f.message)}\``,
    `- Reviewer: ${f.explanation || "(no explanation)"}`];
  // Said once above the findings when the code before the change has nothing to compare against.
  const said = r.beforeBaseEmpty === "first-commit" ||
    (r.beforeBaseEmpty === "new-files" && f.before?.status === "new-code");
  if (f.before && !said) out.push(`- Before the change (${f.before.status}): ${f.before.detail}`);
  if (multi(r)) out.push(`- Project: ${f.project}`);
  if (f.shallow) out.push(`- Note: ${SHALLOW_NOTE[f.shallow]}.`);
  if (f.dependsOn) {
    out.push(marked ? `- Depends on: ${f.dependsOn} (the test assumes one answer; answer ${f.dependsOn} before marking)`
      : `- Depends on: ${f.dependsOn} (the test assumes one answer)`);
  }
  // arnx cloud's judge goes unnamed: its label carries the harness.
  if (f.reason) out.push(billedByCloud(r) ? `- Second opinion: ${f.reason}`
    : `- Second opinion (${f.judge ?? r.challenger}): ${f.reason}`);
  const sp = f.suspect ? (r.suspects ?? []).find((x) => x.id === f.suspect && x.project === f.project) : undefined;
  if (sp) out.push(`- Suspected before testing (${sp.id}, ${sp.by}): ${sp.claim}`);
  if (!marked) return [...out, ""];
  out.push("", ...markLines(defaultMark(f)), "");
  return out;
}

const markLines = (mark: string | null) => [`Mark: [${mark === "real" ? "x" : " "}] real  [ ] intended  [ ] noise  [ ] rewrite`,
  "Severity, if real: [ ] high  [ ] medium  [ ] low"];

/** The mark a finding comes with in review.md. A confirmed finding that waits on no question comes marked real: the
 * owner changes only what they disagree with. Every other finding comes unmarked. */
export const defaultMark = (f: Finding): string | null => f.verdict === "confirmed" && !f.dependsOn ? "real" : null;

/** An issue is proven when one of its findings comes marked real; its one mark then covers the others too (a disputed
 * test, or one that assumed an answer, in an issue another test proves is not a separate decision). */
export const proven = (findings: Finding[]) => findings.some((f) => defaultMark(f) === "real");

/** Whether review.md marks issues rather than findings: the findings were grouped. */
export const marksIssues = (r: Review) => (r.groups ?? []).length > 0;

/** The mark each finding comes with in review.md: its issue's when the review marks issues, else its own. */
export function defaultMarks(r: Review): Record<string, string | null> {
  const out: Record<string, string | null> = Object.fromEntries(r.findings.map((f) => [f.id, defaultMark(f)]));
  if (!marksIssues(r)) return out;
  for (const { findings } of groupsOf(r, active(r))) {
    const mark = proven(findings) ? "real" : null;
    for (const f of findings) out[f.id] = mark;
  }
  return out;
}

/** Questions an answer decides an issue for: a finding waits on it in an issue no other test proves. The rest are
 * optional: no issue waits on them, and an answer still lets \`arnx accept\` write a test for it. */
export function neededQuestions(r: Review): Set<string> {
  // Findings marked one by one: every question is asked, as before.
  if (!marksIssues(r)) return new Set(r.questions.map((_q, i) => `Q${i + 1}`));
  const out = new Set<string>();
  for (const { findings } of groupsOf(r, active(r))) {
    if (proven(findings)) continue;
    for (const f of findings) if (f.dependsOn) out.add(f.dependsOn);
  }
  return out;
}

/** The review's groups, each finding in exactly one, in report order; findings no group names come last, alone.
 * `of`: only these findings (default all). */
export function groupsOf(r: Review, of: Finding[] = r.findings): { group: Group | null; findings: Finding[] }[] {
  const byId = new Map(of.map((f) => [f.id, f]));
  const seen = new Set<string>();
  const out: { group: Group | null; findings: Finding[] }[] = [];
  for (const g of r.groups ?? []) {
    const members = g.findings.filter((id) => byId.has(id) && !seen.has(id)).map((id) => byId.get(id)!);
    members.forEach((f) => seen.add(f.id));
    if (members.length) out.push({ group: g, findings: members });
  }
  for (const f of of) if (!seen.has(f.id)) out.push({ group: null, findings: [f] });
  // Most severe first, whatever order the groups were stored in; a finding left ungrouped has no estimate, so it goes
  // with the unestimated groups, never among the minor ones.
  return out.sort((a, b) => bySeverity({ severity: a.group?.severity } as Group, { severity: b.group?.severity } as Group));
}

/** review.md is read in plain editors (nano, vim): prose and list items are wrapped at this width, continuation lines
 * indented under the item. Headings, tables and lines without a space to break at are left as they are. */
export const MD_WIDTH = 100;

export function wrapMarkdown(text: string, width = MD_WIDTH): string {
  return text.split("\n").flatMap((line) => {
    if (line.length <= width || /^(#|\||```|    )/.test(line)) return [line];
    const m = /^(\s*(?:[-*] |\d+\. )?)/.exec(line)!;
    const lead = m[1]!, pad = " ".repeat(lead.length);
    // Words, with a `code span` kept whole even when it holds spaces.
    const words = line.slice(lead.length).match(/(?:`[^`]*`|[^\s`])+/g) ?? [];
    const out: string[] = [];
    let cur = lead;
    for (const w of words) {
      if (cur.trim() && (cur + (cur.endsWith(" ") || cur === lead ? "" : " ") + w).length > width) {
        out.push(cur.trimEnd());
        cur = pad + w;
      } else {
        cur += (cur === lead || cur.endsWith(" ") ? "" : " ") + w;
      }
    }
    out.push(cur.trimEnd());
    return out;
  }).join("\n");
}

const REWRITE_HELP = "A real bug whose test is wrong: tick rewrite and add `Rewrite: <what the test should check>` " +
  "on the next line.";

export function render(r: Review): string {
  const out = [`# arnx review ${r.id}`, "",
    `- Change: ${r.change}, ${r.filesChanged} files, +${r.added} −${r.removed}`,
    ...untrackedLines(r).map((l) => `- ${l}`),
    modelsLine(r),
    `- ${r.usage?.length ? costLine(r) : `Cost: $${r.costUsd.toFixed(2)}`} · ${duration(r.seconds)} · Agent stopped: ${r.stop}`, "",
    "## Status", "", ...statusLines(r), "",
    marksIssues(r)
      ? "Each issue has one mark for all its tests. Issues a confirmed test proves come marked real: change a mark " +
        "only where you disagree, add a severity if you like. An issue left unmarked is not accepted. Questions are " +
        "optional unless an issue waits on one. " + REWRITE_HELP + " `arnx triage` does this in the terminal. Then " +
        "run `arnx accept`."
      : "Confirmed findings come marked real; change a mark where you disagree (one box per finding), add a severity " +
        "if you like, and answer any question you can. A finding left unmarked is not accepted. " + REWRITE_HELP +
        " `arnx triage` does this in the terminal. Then run `arnx accept`.", ""];
  const fixes = fixed(r);
  if (fixes.length) {
    const one = fixes.length === 1;
    out.push("## The change fixes", "",
      `${one ? "This test fails" : `These ${fixes.length} tests fail`} on the code before the change in every run ` +
      `and pass${one ? "es" : ""} on the change: the change fixes what ${one ? "it checks" : "they check"}.`, "");
    for (const x of fixes) {
      const what = (r.checked ?? []).find((c) => c.project === x.project && c.test === x.testId)?.expects ?? "";
      out.push(`- \`${x.testId}\`${what ? `: ${firstLine(what)}` : ""}${multi(r) ? ` (${x.project})` : ""}`);
    }
    out.push("");
  }
  out.push("## Findings", "");
  const caused = active(r), already = r.findings.filter(isPreExisting);
  if (r.beforeBaseEmpty && r.findings.some((f) => f.before)) {
    out.push("Before/after check: nothing to compare against. " + (r.beforeBaseEmpty === "first-commit"
      ? "This change is the first commit, so there is no code before it to run the tests on; the findings below " +
        "were not checked."
      : "The code before this change does not contain the changed files (a first commit, or new files not committed " +
        "yet), so it cannot tell whether the change caused a failure: what each finding below tests is new."), "");
  }
  if (!caused.length) {
    out.push(already.length ? `No test failed because of this change; ${plural(already.length, "test")} already ` +
      "failed before it (below)." : "No test failed in every run.", "");
  }
  const grouped = (r.groups ?? []).length > 0;
  if (grouped) {
    const parts = groupsOf(r, caused);
    if (parts.length) out.push(`${plural(parts.length, "issue")} from ${plural(caused.length, "failing test")}, most severe first.`, "");
    const minor = parts.findIndex(({ group }) => group?.severity === "low");
    parts.forEach(({ group, findings }, i) => {
      if (i === minor) {
        out.push("## Also found (minor)", "", "Leftover debug output, logging, test helpers and the like: worth a look, " +
          "not urgent.", "");
      }
      const g = group ?? { findings: [], title: "", input: "", actual: "", expected: "", consequence: "" };
      const title = g.title || findings[0]!.explanation.split("\n")[0] || firstLine(findings[0]!.message);
      out.push(`### Issue ${i + 1} · ${title}`, "");
      if (g.severity) out.push(`- Severity (estimate): ${g.severity}`);
      for (const [label, value] of [["Input", g.input], ["Actual", g.actual], ["Expected", g.expected],
        ["Why it matters", g.consequence]] as const) if (value.trim()) out.push(`- ${label}: ${value.trim()}`);
      out.push(`${FAILING_TESTS} ${findings.map((f) => f.id).join(", ")}`);
      if (proven(findings)) {
        const assumed = findings.filter((f) => f.dependsOn && defaultMark(f) !== "real");
        const disputed = findings.filter((f) => !f.dependsOn && f.verdict === "disputed");
        const qs = [...new Set(assumed.map((f) => f.dependsOn!))].join(", ");
        if (assumed.length) out.push(`- ${ids(assumed)} assumed an answer to ${qs}; this issue's mark covers them.`);
        if (disputed.length) out.push(`- The second opinion disputed ${ids(disputed)}; this issue's mark covers them.`);
      }
      const n = findings.length;
      out.push("", ...markLines(proven(findings) ? "real" : null).map((l, k) =>
        k === 0 && n > 1 ? `${l}  (${n === 2 ? "both" : `all ${n}`} tests)` : l), "");
      for (const f of findings) out.push(...findingLines(r, f, false));
    });
  } else {
    for (const f of caused) out.push(...findingLines(r, f));
  }
  if (already.length) {
    out.push("## Already failing before this change", "",
      "These tests fail the same way on the code before this change, so the change did not cause them. They were " +
      "not sent to the second opinion and do not set the exit code; mark one real to keep it as a test of a bug " +
      "that was already there.", "");
    for (const f of already) out.push(...findingLines(r, f));
  }
  out.push("## Questions", "");
  if (!r.questions.length) out.push("None.", "");
  const needed = neededQuestions(r);
  r.questions.forEach((q, i) => out.push(`### Q${i + 1}`, "", ...(multi(r) ? [`Project: ${r.questionProjects[i]}`, ""] : []),
    q, "", ...(needed.has(`Q${i + 1}`) ? [] : ["Optional: no issue waits on it. An answer lets `arnx accept` write a " +
      "test for it.", ""]), "Answer:", ""));
  const sus = r.suspects ?? [];
  if (sus.length) {
    out.push("## Suspected before testing", "",
      `Before writing tests, arnx looked for defects in the change and the code around it, then tested each suspect: ` +
      `${huntCounts(sus)}. Proven means its test failed in every run and the second model confirmed it. A suspect ` +
      "not proven is still a claim worth reading; check the ones that matter to you.", "");
    for (const x of sus) {
      const where = multi(r) ? ` (${x.project})` : "";
      const fs = (x.findings ?? []).join(", ");
      const what = x.outcome === "proven" ? `proven: ${fs}`
        : x.outcome === "same cause" ? `proven only together with ${x.sameAs}: its tests fail for the same cause ` +
          `(one fix makes both pass); whatever its claim says beyond ${x.sameAs}'s is not shown: ${fs}`
        : x.outcome === "disputed" ? `its test failed, but the second model disputed it: ${fs}`
        : x.outcome === "unchecked" ? `its test failed; the second model did not judge it: ${fs}`
        : x.outcome === "pending answer" ? `its test failed; whether that is a defect depends on a question: ${fs}`
        : x.outcome === "pre-existing" ? `its test failed, but it fails the same way before the change: ${fs}`
        : x.outcome === "not reproduced" ? `not reproduced: its test passed (\`${x.tests[0]}\`), which does not ` +
          "rule it out"
        : x.outcome === "inconclusive" ? `inconclusive, flaky or errored: \`${x.tests[0]}\``
        : `not tested${x.reason ? `: ${x.reason}` : ""}`;
      out.push(`- ${x.id}${where} \`${x.file}:${x.line}\`: ${x.claim} — ${what}.`);
    }
    out.push("");
  }
  const checks = r.typecheck ?? [];
  if (checks.length) {
    out.push("## Type check", "",
      "The project's own type check (`typecheck` in .arnx/review.yaml) ran once on the change, without arnx's " +
      "generated tests. It is information only: it changes no test, finding or exit code.", "");
    for (const t of checks) {
      out.push(`- ${multi(r) ? `\`${t.project}\` ran` : "Ran"} \`${t.command}\`: ${describeTypecheck(t)}.`);
      for (const d of t.diagnostics.slice(0, DIAGNOSTICS_SHOWN)) out.push(`  - ${describeDiagnostic(d)}`);
      const more = t.errors - Math.min(t.diagnostics.length, DIAGNOSTICS_SHOWN);
      if (more > 0) {
        out.push(`  - ... and ${more} more (review.json lists ${t.errors > t.diagnostics.length
          ? `the first ${t.diagnostics.length}` : "them all"})`);
      }
      if (t.output) out.push("", "  The end of its output:", "", ...splitLines(t.output.trim()).slice(-OUTPUT_SHOWN)
        .map((l) => `    ${l}`));
    }
    out.push("");
  }
  out.push("## Not findings", "",
    `- Tests written: ${r.testsWritten}; passing in every run: ${r.passed}`,
    `- Flaky or unconfirmed (failed in some runs only): ${ticks(r.flaky) || "none"}`,
    `- Errors (the test could not run): ${ticks(r.errors) || "none"}`,
    `- Runs without a report (timed out or crashed): ${r.missingRuns}`);
  if (r.ignoredChanged?.length) out.push(`- Changed files left out by .arnxignore (not reviewed): ${ticks(r.ignoredChanged)}`);
  if (r.lockfilesChanged?.length) out.push(`- Changed lockfiles (in the sandbox, not reviewed): ${ticks(r.lockfilesChanged)}`);
  if (r.notSent.length) {
    out.push(`- Files left out because they looked like secrets: ${ticks(r.notSent)}. If one is a test fixture, not a ` +
      "secret: `arnx allow-secret PATH`, then `arnx approve`");
  }
  const stats = r.projectStats ?? [];
  if (stats.length && (multi(r) || stats.some(troubled))) {
    out.push("", "## Projects", "");
    for (const p of stats) out.push(`- \`${p.name}\`: ${projectLine(p)}`);
  }
  const checked = r.checked ?? [];
  if (checked.length) {
    out.push("", "## What the passing tests checked", "");
    for (const c of checked.slice(0, CHECKED_SHOWN)) {
      out.push(`- \`${c.test}\`${c.expects ? `: ${c.expects}` : ""}${multi(r) ? ` (${c.project})` : ""}`);
    }
    if (checked.length > CHECKED_SHOWN) out.push(`- ... and ${checked.length - CHECKED_SHOWN} more (review.json)`);
  }
  return out.join("\n") + "\n";
}

const CHECKED_SHOWN = 40;
const DIAGNOSTICS_SHOWN = 20;
const OUTPUT_SHOWN = 15;

function huntCounts(sus: SuspectOutcome[]): string {
  const n = (o: SuspectOutcome["outcome"]) => sus.filter((x) => x.outcome === o).length;
  const opt = (o: SuspectOutcome["outcome"]) => n(o) ? [`${n(o)} ${o}`] : [];
  return [`${sus.length} suspected`, `${n("proven")} proven`, ...opt("same cause"), ...opt("disputed"), ...opt("unchecked"),
    ...opt("pending answer"), ...opt("pre-existing"), `${n("not reproduced")} not reproduced`, ...opt("inconclusive"),
    `${n("not tested")} not tested`].join(" · ");
}

/** Final outcomes once the second model has judged the findings: a suspect is proven only when a finding its test
 * produced is confirmed and waits on no question. */
export function adjudicate(sus: SuspectOutcome[], findings: Finding[]): void {
  for (const x of sus) {
    if (x.outcome !== "failed") continue;
    const fs = findings.filter((f) => f.project === x.project && f.suspect === x.id);
    x.findings = fs.map((f) => f.id);
    x.outcome = fs.length && fs.every(isPreExisting) ? "pre-existing"
      : fs.some((f) => f.verdict === "confirmed" && !f.dependsOn && !isPreExisting(f)) ? "proven"
      : fs.some((f) => f.dependsOn) ? "pending answer"
      : fs.some((f) => f.verdict === "disputed") ? "disputed" : "unchecked";
  }
}

/** A suspect "proven" only by tests the grouping put in another suspect's issue (one fix makes them all pass) failed
 * for that suspect's cause: its own claim is not shown apart from it (a test labelled for "amount 0 is rejected" that
 * fails because every 400 becomes a 500). An issue belongs to the suspect with the most of its tests, the first on a
 * tie. A suspect that owns an issue anywhere stays proven. */
export function sameCause(sus: SuspectOutcome[], groups: Group[], findings: Finding[]): void {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const key = (project: string, id: string) => `${project}\0${id}`;
  const owner = new Map<string, string>(); // group index → owning suspect key
  const inGroups = new Map<string, number[]>(); // suspect key → groups holding its tests
  groups.forEach((g, i) => {
    const counts = new Map<string, number>();
    for (const f of g.findings.map((id) => byId.get(id)).filter((f): f is Finding => !!f?.suspect)) {
      const k = key(f.project, f.suspect!);
      counts.set(k, (counts.get(k) ?? 0) + 1);
      inGroups.set(k, [...new Set([...(inGroups.get(k) ?? []), i])]);
    }
    const top = [...counts.entries()].reduce<[string, number] | null>((a, b) => (!a || b[1] > a[1] ? b : a), null);
    if (top) owner.set(String(i), top[0]);
  });
  for (const x of sus.filter((s) => s.outcome === "proven")) {
    const k = key(x.project, x.id);
    const gs = inGroups.get(k) ?? [];
    if (!gs.length || gs.some((i) => owner.get(String(i)) === k)) continue;
    x.outcome = "same cause";
    x.sameAs = owner.get(String(gs[0]))!.split("\0")[1]!;
  }
}

const troubled = (p: ProjectStat) => p.missingRuns > 0 || !p.sawResults;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function projectLine(p: ProjectStat): string {
  const ran = p.tests ? `${plural(p.tests, "test")}, ${p.passed} passing in every run`
    : `${plural(p.testFiles, "test file")}, no run reported its tests`;
  const missing = p.missingRuns ? ` (${plural(p.missingRuns, "run")} without a report)` : "";
  return ran + missing + (p.sawResults ? "" : "; the reviewer never saw them run");
}

/** `reasons`: a rewrite mark without its Rewrite line is an error (accept needs the reason; triage does not). */
export function parseMarks(md: string, findingIds: string[], o: { reasons?: boolean } = {}): Marks {
  const marks: Record<string, string | null> = {};
  const severity: Record<string, string | null> = {};
  const answers: Record<string, string> = {};
  const rewrites: Record<string, string> = {};
  let current: string | null = null;
  let answerLines: string[] | null = null;
  // The Rewrite line being read (it may wrap), the findings it is for, and whether this heading's mark needs one.
  let reasonLines: string[] | null = null;
  let reasonFor: string[] = [];
  let needsReason = false;
  // Under an issue's heading: the findings its Mark line covers.
  let members: string[] = [];
  const closeReason = () => {
    const text = (reasonLines ?? []).join(" ").replace(/\s+/g, " ").trim();
    if (reasonLines !== null && text) for (const id of reasonFor) rewrites[id] = text;
    reasonLines = null;
  };
  const closeAnswer = () => {
    closeReason();
    if (current?.startsWith("Q") && answerLines !== null) {
      const text = answerLines.join("\n").trim();
      if (text) answers[current] = text;
    }
    // A finding's own rewrite mark may lean on its issue's reason.
    const covered = isIssue(current) ? members.every((id) => rewrites[id]) : !!current && !!rewrites[current];
    if (o.reasons && needsReason && !covered) {
      throw new ArnxError(`${current}: marked rewrite without a reason; add a line \`${REWRITE} <what the test ` +
        "should check>` right after its Mark line");
    }
    needsReason = false;
  };
  const ticks = (line: string, box: RegExp) =>
    [...line.matchAll(box)].filter((m) => m[1] === "x" || m[1] === "X").map((m) => m[2]!);
  for (const line of splitLines(md)) {
    const heading = HEADING.exec(line) ?? ISSUE_HEADING.exec(line);
    if (heading || line.startsWith("## ")) {
      closeAnswer();
      [current, answerLines, members] = [heading ? heading[1]!.replace(/\s+/, " ") : null, null, []];
      continue;
    }
    if (reasonLines !== null) {
      if (!line.trim() || line.startsWith("Mark:") || line.startsWith("Severity")) closeReason();
      else {
        reasonLines.push(line);
        continue;
      }
    }
    if (isIssue(current) && line.startsWith(FAILING_TESTS)) {
      members = line.match(/\bF\d+\b/g) ?? [];
    } else if (isIssue(current) && line.startsWith("Mark:")) {
      const ticked = ticks(line, BOX);
      if (ticked.length > 1) throw new ArnxError(`${current}: tick one box, not ${ticked.length}`);
      for (const id of members) [marks[id], severity[id]] = [ticked[0] ?? null, severity[id] ?? null];
      needsReason = ticked[0] === "rewrite";
    } else if (isIssue(current) && line.startsWith("Severity")) {
      const ticked = ticks(line, SEVERITY_BOX);
      if (ticked.length > 1) throw new ArnxError(`${current}: tick one severity, not ${ticked.length}`);
      for (const id of members) severity[id] = ticked[0] ?? null;
    } else if ((isIssue(current) || current?.startsWith("F")) && line.startsWith(REWRITE)) {
      [reasonLines, reasonFor] = [[line.slice(REWRITE.length)], isIssue(current) ? members : [current!]];
    } else if (current?.startsWith("F") && line.startsWith("Mark:")) {
      const ticked = ticks(line, BOX);
      if (ticked.length > 1) throw new ArnxError(`${current}: tick one box, not ${ticked.length}`);
      marks[current] = ticked[0] ?? null;
      severity[current] ??= null;
      needsReason = ticked[0] === "rewrite";
    } else if (current?.startsWith("F") && line.startsWith("Severity")) {
      const ticked = ticks(line, SEVERITY_BOX);
      if (ticked.length > 1) throw new ArnxError(`${current}: tick one severity, not ${ticked.length}`);
      severity[current] = ticked[0] ?? null;
    } else if (current?.startsWith("Q")) {
      if (answerLines === null && line.startsWith("Answer:")) answerLines = [line.slice("Answer:".length).trim()];
      else if (answerLines !== null) answerLines.push(line);
    }
  }
  closeAnswer();
  const missing = findingIds.filter((f) => !(f in marks));
  if (missing.length) throw new ArnxError(`${missing.join(", ")}: the Mark line is missing from review.md`);
  // A reason counts only for a finding marked rewrite (one left from an earlier mark is not read).
  for (const id of Object.keys(rewrites)) if (marks[id] !== "rewrite") delete rewrites[id];
  return { findings: marks, severity, answers, rewrites };
}

/** One row of the summary: a group of findings the change may have caused (or one finding alone). `mark` is ✗ for a
 * confirmed one, ? for one waiting on an answer, · otherwise; `state` the verdicts in words; `title` the problem;
 * `said` the ids as the summary shows them, each finding's state after it unless it is confirmed ("F3; F4 depends on
 * Q1"). */
export interface SummaryRow { mark: "✗" | "?" | "·"; ids: string[]; projects: string[]; state: string;
  regression: boolean; title: string; said: string; severity?: Severity }

/** The summary's rows, in its order (summary() and `arnx review --json` show the same). */
export function summaryRows(r: Review): SummaryRow[] {
  const isConfirmed = new Set(confirmed(r).map((f) => f.id));
  return groupsOf(r, active(r)).map(({ group, findings }) => {
    const mark = findings.some((f) => isConfirmed.has(f.id)) ? "✗" : findings.some((f) => f.dependsOn) ? "?" : "·";
    const states = findings.map((f) => f.dependsOn ? `depends on ${f.dependsOn}` : verdictOf(f));
    const counts = [...new Set(states)].map((st) => `${states.filter((x) => x === st).length} ${st}`);
    const f0 = findings[0]!;
    // Confirmed findings plainly, first; the others by state.
    const others = findings.map((f, i) => [f, states[i]!] as const).filter(([f]) => !isConfirmed.has(f.id));
    // An issue marked as one names its tests briefly: the others' states are covered by its mark.
    const brief = marksIssues(r) && mark === "✗";
    const said = brief ? (findings.length <= 3 ? ids(findings) : `${ids(findings.slice(0, 2))} +${findings.length - 2} more`)
      : [findings.filter((f) => isConfirmed.has(f.id)).map((f) => f.id).join(", "),
        ...[...new Set(others.map(([, st]) => st))].map((st) =>
          `${others.filter(([, x]) => x === st).map(([f]) => f.id).join(", ")} ${st}`)].filter(Boolean).join("; ");
    return { mark, ids: findings.map((f) => f.id), projects: [...new Set(findings.map((f) => f.project))],
      state: counts.length === 1 ? states[0]! : counts.join(", "),
      regression: findings.some((f) => f.before?.status === "regression"),
      title: group?.title || f0.explanation || firstLine(f0.message), said,
      ...(group?.severity ? { severity: group.severity } : {}) };
  });
}

/** What the summary's status says: why the review is incomplete (`problems`), or, with none, how many of the changed
 * source files no test refers to (`untested` of `of`: partly covered when above 0). */
export function summaryStatus(r: Review): { problems: string[]; untested: number; of: number } {
  return { problems: statusOf(r).problems, untested: untestedCount(r), of: untestedOf(r) };
}

export function summary(r: Review, reviewMd: string): string {
  const { problems } = statusOf(r);
  const said = problems.join("; ");
  const status = problems.length ? `Incomplete: ${said}.`
    : untestedCount(r) ? `Partly covered: no test refers to ${untestedCount(r)} of ${untestedOf(r)} changed source ` +
      "files, so finding nothing there says nothing about them." : "";
  const down = (r.providerFailures ?? []).map(failureLine).join(" ");
  const out = [`arnx review ${r.id} · ${r.change} · ${plural(r.filesChanged, "file")}, +${r.added} −${r.removed}`];
  const head = [status, down].filter(Boolean).join(" ");
  if (head) out.push(head);
  // With --quiet this is the only place that says part of the change was not sent.
  if (r.untrackedLeftOut) out.push(`${plural(r.untrackedLeftOut, "untracked file")} left out (--untracked includes them).`);
  const issues = summaryRows(r);
  if (issues.length) out.push(issuesLine(r, issues));
  const fixes = fixed(r).length;
  if (fixes) out.push(`${plural(fixes, "test")} prove${fixes === 1 ? "s" : ""} the change fixes something.`);
  const num = String(issues.length).length;
  const rows = issues.map((row, i) => {
    const where = multi(r) ? ` (${row.projects.join(", ")})` : "";
    return [`  ${row.mark} ${String(i + 1).padStart(num)}`,
      shorten((row.regression ? "regression: " : "") + row.title, 100), row.said + where] as const;
  });
  // The findings in a column at the right, after the longest title; minor issues after a line of their own.
  const width = Math.max(0, ...rows.map(([, title]) => title.length));
  const minor = issues.findIndex((row) => row.severity === "low");
  rows.forEach(([head, title, ids], i) => {
    if (i === minor) out.push("  Minor:");
    out.push(`${head}  ${title.padEnd(width)}  ${ids}`);
  });
  const already = r.findings.filter(isPreExisting);
  if (already.length) out.push(`  Already failing before the change: ${already.map((f) => f.id).join(", ")}`);
  const needed = neededQuestions(r);
  const optional = r.questions.length - needed.size;
  r.questions.forEach((q, i) => {
    if (needed.has(`Q${i + 1}`)) out.push(`  ? Q${i + 1}  ${q}`);
  });
  if (optional) out.push(`  ${optional === 1 ? "1 optional question" : `${optional} optional questions`} in review.md ` +
    `(no issue waits on ${optional === 1 ? "it" : "them"})`);
  if (!r.findings.length && !r.questions.length) out.push("  No findings and no questions.");
  for (const u of (r.untested ?? []).filter((x) => x.files.length)) {
    const shown = u.files.slice(0, 8).join(", ") + (u.files.length > 8 ? `, … (${u.files.length - 8} more)` : "");
    out.push(`  Not tested${multi(r) ? ` (${u.project})` : ""}: ${shown}`);
  }
  if (r.uncovered.length) out.push(`  Not tested: ${r.uncovered.map((u) => u.path).join(", ")}`);
  for (const t of r.typecheck ?? []) out.push(`  Type check${multi(r) ? ` (${t.project})` : ""}: ${describeTypecheck(t)}`);
  for (const c of r.typecheckOnly ?? []) {
    const checked = (r.typecheck ?? []).some((t) => t.project === c.project);
    out.push(`  ${checked ? "Type check only" : "No round of its own"} (${c.project}): its changed files reviewed by ` +
      c.by.join(", "));
  }
  if (r.notReviewed.length) out.push(`  Not reviewed (over max_projects): ${r.notReviewed.join(", ")}`);
  const stats = r.projectStats ?? [];
  const where = (ps: ProjectStat[]) => multi(r) && ps.length ? ` (${ps.map((p) => p.name).join(", ")})` : "";
  const trouble = [r.flaky.length ? `${r.flaky.length} flaky` : "", r.errors.length ? plural(r.errors.length, "error") : "",
    r.missingRuns ? `${plural(r.missingRuns, "run")} without a report${where(stats.filter((p) => p.missingRuns > 0))}`
      : ""].filter(Boolean);
  if (trouble.length) out.push(`  ${trouble.join(" · ")}`);
  const blind = stats.filter((p) => !p.sawResults);
  if (blind.length) out.push(`  The reviewer never saw its tests run: ${blind.map((p) => p.name).join(", ")}`);
  const yours = yourCall(r, issues);
  if (yours) out.push(yours);
  out.push(`${plural(r.testsWritten, "test")} · ${costShort(r)} · ${duration(r.seconds)} · ${reviewMd}`);
  out.push(...nextSteps(r, issues).map((c, i) => `${i ? "Then" : "Next"}: ${c}`));
  return out.join("\n");
}

/** What only the developer can decide, in one line: issues not proven (disputed or waiting on an answer) and the
 * questions an issue waits on. Empty when the review asks nothing of them, and when it marks findings one by one. */
export function yourCall(r: Review, rows: SummaryRow[] = summaryRows(r)): string {
  if (!marksIssues(r) || !rows.length) return "";
  const open = rows.map((row, i) => [row, i + 1] as const).filter(([row]) => row.mark !== "✗");
  const needed = [...neededQuestions(r)];
  if (!open.length && !needed.length) {
    return `${rows.length === 1 ? "The issue comes" : `All ${rows.length} issues come`} marked real: nothing to do ` +
      "unless you disagree.";
  }
  const what = open.map(([row, n]) => `issue ${n} (${row.mark === "?" ? "waits on a question" : "disputed"})`);
  return `Your call: ${[...what, ...needed].join(", ")}.`;
}

/** The commands after a review: accept straight away when nothing needs the developer, else triage first. */
export function nextSteps(r: Review, rows: SummaryRow[] = summaryRows(r)): string[] {
  if (!r.findings.length && !r.questions.length) return [];
  // Findings that already failed before the change are not the change's issues: they need no mark to accept.
  const settled = marksIssues(r) && rows.length > 0 && rows.every((row) => row.mark === "✗") &&
    neededQuestions(r).size === 0;
  return settled ? ["arnx accept"] : ["arnx triage", "arnx accept"];
}

/** The summary's count: issues (rows) by where they stand, the findings in them, and what the code before the change
 * settles when it says the same of every confirmed finding. */
function issuesLine(r: Review, rows: SummaryRow[]): string {
  const kinds = ([["✗", "confirmed"], ["?", "waiting on a question"], ["·", "disputed"]] as const)
    .map(([mark, word]) => [rows.filter((row) => row.mark === mark).length, word] as const).filter(([n]) => n);
  const counted = kinds.map(([n, word], i) => `${i ? n : plural(n, "issue")} ${word}`).join(", ");
  const findings = rows.reduce((a, row) => a + row.ids.length, 0);
  const sure = rows.filter((row) => row.mark === "✗").length;
  const before = [...new Set(confirmed(r).map((f) => f.before?.status))];
  const settled = before.length !== 1 ? ""
    : before[0] === "new-code" ? `${sure === 1 ? "" : sure === 2 ? "both " : "all "}in new code`
    : before[0] === "regression" ? "caused by the change"
    : before[0] === "pre-existing" ? "already failing before the change" : "";
  return `${counted} (${plural(findings, "finding")})${settled ? `; ${settled}` : ""}.`;
}

/** The cost in one word, and a note when calls cut off mid-reply could not be priced. */
function costShort(r: Review): string {
  if (billedByCloud(r)) return `$${r.costUsd.toFixed(2)} billed`;
  const unknown = (r.usage ?? []).reduce((a, u) => a + u.unknownCalls, 0);
  return `$${r.costUsd.toFixed(2)}${unknown ? " (a little more: some calls were cut off mid-reply)" : ""}`;
}

const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const camel = (k: string) => k.replace(/_([a-z])/g, (_m, c: string) => c.toUpperCase());
const rekey = (o: object, f: (k: string) => string) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [f(k), v]));

/** review.json's shape; documented in skills/arnx/references/review-json.md, which coding agents read. A field
 * removed or renamed there is a new version. */
export const REVIEW_SCHEMA_VERSION = 1;

/** Where a finding stands, in one word for whoever reads review.json: "confirmed" findings set exit code 1 and come
 * marked real; the others wait on an answer, were disputed by the second opinion, or failed before the change too. */
export type FindingStatus = "confirmed" | "waiting-on-answer" | "disputed" | "pre-existing";
export const findingStatus = (f: Finding): FindingStatus => isPreExisting(f) ? "pre-existing"
  : f.dependsOn ? "waiting-on-answer" : f.verdict === "disputed" ? "disputed" : "confirmed";

export function save(r: Review, rdir: string, diff: string): void {
  mkdirSync(rdir, { recursive: true });
  // schema_version, each finding's status and exit_code are derived for readers; load() drops them.
  const json = { schema_version: REVIEW_SCHEMA_VERSION, ...rekey(r, snake),
    findings: r.findings.map((f) => ({ ...rekey(f, snake), status: findingStatus(f) })),
    project_stats: (r.projectStats ?? []).map((p) => rekey(p, snake)),
    usage: (r.usage ?? []).map((u) => rekey(u, snake)), ...(r.timings ? { timings: rekey(r.timings, snake) } : {}),
    ...(r.fixProof ? { fix_proof: r.fixProof.map((x) => rekey(x, snake)) } : {}),
    ...(r.typecheck ? { typecheck: r.typecheck.map((t) => rekey(t, snake)) } : {}),
    ...(r.providerFailures ? { provider_failures: r.providerFailures } : {}),
    exit_code: exitCode(r) };
  writeFileSync(join(rdir, "review.json"), JSON.stringify(json, null, 2) + "\n");
  writeFileSync(join(rdir, "review.md"), wrapMarkdown(render(r)));
  writeFileSync(join(rdir, "change.diff"), diff);
}

export function load(rdir: string): Review {
  const path = join(rdir, "review.json");
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  } catch (e) {
    throw new ArnxError(`cannot read ${path}: ${(e as Error).message}`);
  }
  const findings = (data.findings as object[]).map((f) => {
    const { status: _status, ...rest } = f as Record<string, unknown>;
    return { project: "main", ...rekey(rest, camel) } as unknown as Finding;
  });
  const { schema_version: _version, exit_code: _code, ...fields } = data;
  const r = { language: "python", projects: ["main"], notReviewed: [], uncovered: [], ...rekey(fields, camel),
    findings } as unknown as Review;
  r.questionProjects ??= r.questions.map(() => r.projects[0] ?? "main");
  r.writeDirs ??= { [r.projects[0] ?? "main"]: r.writeDir };
  r.projectStats = ((data.project_stats ?? []) as object[]).map((p) => rekey(p, camel) as unknown as ProjectStat);
  r.usage = ((data.usage ?? []) as object[]).map((u) => rekey(u, camel) as unknown as ModelUse);
  r.groups = (data.groups ?? []) as Group[];
  r.checked = (data.checked ?? []) as Checked[];
  if (data.timings) r.timings = rekey(data.timings as object, camel) as Review["timings"];
  if (data.fix_proof) r.fixProof = (data.fix_proof as object[]).map((x) => rekey(x, camel) as unknown as FixProof);
  if (data.typecheck) r.typecheck = (data.typecheck as object[]).map((t) => rekey(t, camel) as unknown as TypeCheck);
  return r;
}

export interface AgentReport { tests: unknown[]; suspected_defects: unknown[]; questions: unknown[];
  not_tested?: unknown[]; suspects_not_tested?: unknown[] }

export function parseReport(finalText: string): AgentReport {
  const data = parseJsonObject(finalText) ?? {};
  const list = (k: string) => Array.isArray(data[k]) ? (data[k] as unknown[]).filter(pyTruthy) : [];
  const out: AgentReport = { tests: list("tests"), suspected_defects: list("suspected_defects"),
    questions: list("questions") };
  if (Array.isArray(data.not_tested)) out.not_tested = list("not_tested");
  if (Array.isArray(data.suspects_not_tested)) out.suspects_not_tested = list("suspects_not_tested");
  return out;
}

/** The text of each question in these replies, once each (a question is a string, or an object with a question). */
export function questionTexts(texts: string[]): string[] {
  return [...new Set(parseReports(texts).questions.map((q) => {
    const o = q as { question?: unknown };
    return typeof o === "object" && o !== null && typeof o.question === "string" ? o.question
      : typeof q === "string" ? q : JSON.stringify(q);
  }))];
}

/** The reports of one round's replies (a follow-up repeats and extends the first), oldest first: entries are kept
 * once each, and "not_tested" comes from the latest reply that gives it. */
export function parseReports(texts: string[]): AgentReport {
  const reports = texts.map(parseReport);
  const once = (xs: unknown[]) => {
    const seen = new Set<string>();
    return xs.filter((x) => {
      const k = JSON.stringify(x);
      return seen.has(k) ? false : (seen.add(k), true);
    });
  };
  const out: AgentReport = { tests: once(reports.flatMap((r) => r.tests)),
    suspected_defects: once(reports.flatMap((r) => r.suspected_defects)),
    questions: once(reports.flatMap((r) => r.questions)) };
  const last = reports.filter((r) => r.not_tested).at(-1);
  if (last) out.not_tested = last.not_tested;
  const sus = once(reports.flatMap((r) => r.suspects_not_tested ?? []));
  if (sus.length) out.suspects_not_tested = sus;
  return out;
}
