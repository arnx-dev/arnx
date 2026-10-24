// accept: read the user's marks and answers from review.md. Tests behind findings marked real are copied into
// .arnx/tests/ (DOME), each at the path it runs from (accepted_tests_dir under its project's root: tests/arnx/r<review
// id>/ by default, __tests__/arnx/ for TypeScript at that default; each file named after what it protects), with every
// other test in the same file that did not pass in every run removed. The project's own test run never sees them:
// only `arnx check` puts them in place, in a throwaway copy. Answered questions become tests through one agent round on the current working
// tree, and so does each issue marked rewrite (the bug is real, its test wrong), from the owner's reason. A finding's
// test is set aside when the owner's answer to the question it assumed has a test of its own, or when it is rewritten.
// Every mark is appended to .arnx/precision.jsonl.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix, relative, sep } from "node:path";
import { getAdapter } from "./adapters";
import { type Adapter, DEFAULT_ACCEPTED_DIR } from "./adapters/types";
import { TS_ACCEPTED_DIR } from "./adapters/typescript";
import type { Brain } from "./brain";
import { loadReviewFile, type ReviewFile } from "./config";
import { ArnxError } from "./errors";
import { type AgentModel, allPrices } from "./llm";
import { baseName, funcOf, ownerFile, type TestResult } from "./outcomes";
import { fixPrompt } from "./fixprompt";
import { LocalBrain } from "./localbrain";
import { defaultMarks, firstLine, groupsOf, load, type Marks, parseMarks, type Review, wrapMarkdown } from "./report";
import { sayingDocker, type SessionFactory } from "./sandbox";
import { refString, type Settings } from "./settings";
import { agentUse, logUsage } from "./usage";
import { collect, DOME, dockerSession, readCopies, testRound, writeDirOf } from "./testround";
import { acceptedTestIds, recordAccepted, testsByFile } from "./check";
import { isoSeconds } from "./util";
import { inPool } from "./challenge";
import { sliceDiff, workingTreeFiles } from "./change";
import { route } from "./route";

/** Answer rounds at once (each a model round and three sandbox runs). */
export const ANSWER_CONCURRENCY = 3;
import type { Say } from "./progress";

export interface AnswerOutcome {
  qid: string;
  files: Record<string, string>;
  keep: Record<string, Set<string>>;
  skip: Record<string, Set<string>>;
  disagree: string[];
  costUsd: number;
  stop: string;
  base: string;
}

export type AnswerRunner = (qid: string, question: string, answer: string, diff: string, outDir: string,
  project: string) => Promise<AnswerOutcome>;

/** One rewrite round: an issue marked rewrite, asked of the answer round as a question (`question`, from the issue's
 * title and expected behaviour) with the owner's reason as the answer (`answer`: REWRITE_PREFIX, then the reason).
 * `id` is R1, R2, … in the order review.md shows the issues (never a question's Q-id). */
export interface Rewrite { id: string; findings: string[]; project: string; reason: string; question: string;
  answer: string }

/** What a rewrite round is told before the owner's reason. */
export const REWRITE_PREFIX = "The test arnx wrote for this was wrong. ";

/** The rewrite rounds of these marks: one per issue (one per finding when findings are marked one by one) with a
 * finding marked rewrite. */
export function rewritesOf(review: Review, marks: Marks): Rewrite[] {
  const out: Rewrite[] = [];
  for (const { group, findings } of groupsOf(review)) {
    const fs = findings.filter((f) => marks.findings[f.id] === "rewrite");
    if (!fs.length) continue;
    const reason = [...new Set(fs.map((f) => marks.rewrites?.[f.id]?.trim() ?? "").filter(Boolean))].join(" ");
    // The title and expected behaviour as review.md shows them.
    const title = (group?.title || findings[0]!.explanation.split("\n")[0] || firstLine(findings[0]!.message)).trim();
    const expected = group?.expected?.trim() ?? "";
    const question = (/[.!?]$/.test(title) ? title : `${title}.`) + (expected ? ` Expected: ${expected}` : "");
    out.push({ id: `R${out.length + 1}`, findings: fs.map((f) => f.id), project: fs[0]!.project, reason, question,
      answer: REWRITE_PREFIX + reason });
  }
  return out;
}

export interface AcceptResult {
  review: Review;
  marks: Marks;
  kept: string[];
  /** Findings marked real: their tests were copied and fail on the code as it is, until the bug is fixed. */
  red: { id: string; testId: string; project: string; explanation: string }[];
  /** Generated test file → where accept put it (repository-relative). */
  moved: Record<string, string>;
  /** Question rounds (qid Q1, …) and rewrite rounds (qid R1, …, described in `rewrites`). */
  answers: AnswerOutcome[];
  rewrites: Rewrite[];
  /** Findings whose own test was set aside → the round whose test replaces it: the answer to the question it assumed
   * (Q2), or its rewrite (R1). */
  setAside: Record<string, string>;
  dest: string;
  /** Per finding: "chosen" by the owner, or the "default" review.md came with and nobody changed (see markSource). */
  sources: Record<string, MarkSource>;
  /** Over every review in precision.jsonl, after this one was recorded (see precisionOf). */
  precision: Precision;
}

export type MarkSource = "default" | "chosen";

/** How a finding's mark was made. "chosen": the owner chose it in `arnx triage` (even the pre-filled mark, confirmed
 * there), or it differs from the mark review.md came with (`defaultMarks`), so someone changed it. "default": it is the
 * pre-filled mark, never touched in triage; a mark changed by hand and changed back looks the same and counts here. */
export function markSource(mark: string | null, pre: string | null, inTriage: boolean): MarkSource {
  return inTriage || mark !== pre ? "chosen" : "default";
}

/** Findings whose mark the owner chose in triage, in any session, kept beside review.md in triage.json: a mark equal
 * to the pre-filled one is a choice only when made there (review.md cannot tell). Unreadable: none. */
export function chosenInTriage(rdir: string): Set<string> {
  const path = join(rdir, "triage.json");
  if (!existsSync(path)) return new Set();
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as { chosen?: unknown };
    return new Set(Array.isArray(d.chosen) ? d.chosen.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

/** Precision over the log: of the marked findings whose mark the owner chose, how many are real. Pre-filled marks left
 * as they came ("default") and lines written before mark_source existed (unknown) are counted apart, never in the
 * ratio: neither says whether the owner agrees. An unmarked finding is no verdict and counts nowhere. */
export interface Precision {
  real: number;
  chosen: number;
  defaulted: number;
  unknown: number;
}

/** Adds a line to .arnx/.gitignore when it is missing, so repositories set up before arnx ignored `name` still
 * ignore it. Without a .gitignore (init never ran) nothing is written. */
function ignoreLocal(repo: string, name: string): void {
  const path = join(repo, ".arnx", ".gitignore");
  if (!existsSync(path)) return;
  const text = readFileSync(path, "utf8");
  if (text.split("\n").some((l) => l.trim() === name)) return;
  appendFileSync(path, (text === "" || text.endsWith("\n") ? "" : "\n") + name + "\n");
}

export function precisionOf(lines: string[]): Precision {
  const p: Precision = { real: 0, chosen: 0, defaulted: 0, unknown: 0 };
  for (const l of lines) {
    let d: { kind?: unknown; mark?: unknown; mark_source?: unknown } | null;
    try {
      d = JSON.parse(l);
    } catch {
      continue;
    }
    if (!d || d.kind !== "finding" || typeof d.mark !== "string") continue;
    if (d.mark_source === "chosen") {
      p.chosen++;
      // A rewrite mark says the bug is real (only its test was wrong).
      if (d.mark === "real" || d.mark === "rewrite") p.real++;
    } else if (d.mark_source === "default") {
      p.defaulted++;
    } else {
      p.unknown++;
    }
  }
  return p;
}

/** Add these findings to the ones chosen in triage. */
export function recordChosen(rdir: string, ids: string[]): void {
  const all = new Set([...chosenInTriage(rdir), ...ids]);
  const chosen = [...all].sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)));
  writeFileSync(join(rdir, "triage.json"), JSON.stringify({ chosen }) + "\n");
}

export function findReview(repo: string, rid: string | null): string {
  const base = join(repo, ".arnx", "reviews");
  if (rid) {
    const path = join(base, rid);
    if (!existsSync(join(path, "review.json"))) throw new ArnxError(`no review ${rid} under .arnx/reviews`);
    return path;
  }
  const found = existsSync(base)
    ? readdirSync(base).map((n) => join(base, n)).filter((p) => existsSync(join(p, "review.json"))) : [];
  if (!found.length) throw new ArnxError("no reviews yet; run `arnx review`");
  return found.reduce((a, b) => (startedAt(b) > startedAt(a) ? b : a));
}

/** When a review started: state.json is written once at the start (review.json is rewritten, by a re-wrap or an
 * edit, so its time says nothing about which review is the latest). Older reviews have no state.json. */
export function startedAt(rdir: string): number {
  const state = join(rdir, "state.json");
  return statSync(existsSync(state) ? state : join(rdir, "review.json")).mtimeMs;
}

/** The latest accepted review (the one whose fix prompt is wanted), by when accept ran. */
export function findAccepted(repo: string): string {
  const base = join(repo, ".arnx", "reviews");
  const found = existsSync(base)
    ? readdirSync(base).map((n) => join(base, n)).filter((p) => existsSync(join(p, "fix-prompt.md"))) : [];
  if (!found.length) throw new ArnxError("no accepted review yet: mark a review and run `arnx accept <id>`");
  const at = (p: string) => statSync(join(p, "accepted.json")).mtimeMs;
  return found.reduce((a, b) => (at(b) > at(a) ? b : a));
}

const funcOfId = (testId: string) => baseName(testId.split("::").at(-1) ?? "");
/** A finding's test as the adapter's skip names it: its func, read again from its test id, since an older arnx cut a
 * JavaScript name at its first "[" ("topup generated [memory] > S1: pays" saved as "topup generated "). */
function funcOfFinding(f: { testId: string; func: string }): string {
  const at = f.testId.lastIndexOf(`::${f.func}`);
  return at < 0 ? f.func : baseName(f.testId.slice(at + 2));
}
const add = (m: Record<string, Set<string>>, k: string, v: string) => (m[k] ??= new Set()).add(v);

function group(results: TestResult[], files: Record<string, string>): Record<string, Set<string>> {
  const out: Record<string, Set<string>> = {};
  for (const t of results) {
    const f = ownerFile(t.fileAttr, Object.keys(files));
    if (f) add(out, f, funcOf(t));
  }
  return out;
}

const toLists = (m: Record<string, Set<string>>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, [...v]]));
const toSets = (m: Record<string, string[]>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, new Set(v)]));

function writeOutcome(path: string, answer: string, o: AnswerOutcome): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ answer, ...o, keep: toLists(o.keep), skip: toLists(o.skip) }) + "\n");
}

/** The saved outcome of an answer round, when the answer is the same. */
function readOutcome(path: string, answer: string): AnswerOutcome | null {
  if (!existsSync(path)) return null;
  try {
    const d = JSON.parse(readFileSync(path, "utf8")) as AnswerOutcome & { answer: string; keep: Record<string, string[]>;
      skip: Record<string, string[]> };
    if (d.answer.trim() !== answer.trim()) return null;
    return { ...d, keep: toSets(d.keep), skip: toSets(d.skip), costUsd: 0 };
  } catch {
    return null;
  }
}

/** Where kept files go: the project's root under DOME (absolute), the project's root (relative to the repository)
 * and the configured directory for accepted tests; `sub` places answer tests apart ("answers"). */
interface Destination { root: string; rootRel: string; acceptedDir: string; sub: string }

export const NAME_MAX = 50;

/** Words a name cut short should not end on. */
const DANGLING = new Set(["a", "an", "and", "as", "at", "by", "for", "from", "in", "into", "is", "of", "on", "or",
  "the", "to", "with"]);

/** A kept file's name from text: lowercase ASCII words joined by _, at most `max` characters, cut at a word and
 * never ending on a word like "the" or "with"; a leading "test" word is dropped (the adapter adds its own). Empty
 * when no word is left. */
export function slugify(text: string, max = NAME_MAX): string {
  const words = text.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/['’`]/g, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2").replace(/([A-Z])([A-Z][a-z])/g, "$1_$2").toLowerCase()
    .split(/[^a-z0-9]+/).filter(Boolean);
  if (words[0] === "test") words.shift();
  const kept: string[] = [];
  for (const w of words) {
    if ([...kept, w].join("_").length > max) break;
    kept.push(w);
  }
  while (kept.length > 1 && DANGLING.has(kept.at(-1)!)) kept.pop();
  return kept.join("_") || (words[0] ?? "").slice(0, max);
}

/** What each generated file of a project protects, as a name: its findings marked real (F1, F2, … order) — the
 * title of their problem (their group), else the first one's explanation (first line), else its test's name. A file
 * protecting several problems is named after the review (r<tag>): no one title fits it. */
function namesOf(review: Review, marks: Marks, project: string, tag: string): Record<string, string> {
  // The first group naming a finding, as review.md shows it.
  const groupOf = new Map<string, Review["groups"][number]>();
  for (const g of review.groups ?? []) for (const id of g.findings) if (!groupOf.has(id)) groupOf.set(id, g);
  const out: Record<string, string> = {};
  // A finding outside any group is a problem of its own, told apart by its name.
  const problems: Record<string, Set<unknown>> = {};
  for (const f of review.findings) {
    if (f.project !== project || !f.file || marks.findings[f.id] !== "real") continue;
    const name = slugify(groupOf.get(f.id)?.title || f.explanation.split("\n")[0] || "") || slugify(f.func);
    out[f.file] ??= name;
    (problems[f.file] ??= new Set()).add(groupOf.get(f.id) ?? name);
  }
  for (const [file, set] of Object.entries(problems)) if (set.size > 1) out[file] = `r${tag}`;
  return out;
}

/** Copy the kept files. Tests not kept are removed from them (skipped, with `reason`, when one cannot be cut out
 * cleanly); a kept test that fails today stays as it is: check runs it, red until the bug is fixed. A test file is
 * named from `names` (an answer's file: its generated name, without the test-file affixes); a name whose file name is
 * `taken` gets _2, _3, and is then taken itself. */
function exportTests(adapter: Adapter, files: Record<string, string>, base: string, d: Destination, tag: string,
                     keep: Record<string, Set<string>>, skip: Record<string, Set<string>>,
                     reason: string | ((path: string, name: string) => string),
                     names: Record<string, string>, taken: Set<string>, moved?: Record<string, string>): string[] {
  if (!Object.keys(files).some((f) => keep[f]?.size)) return [];
  const written: string[] = [];
  for (const path of Object.keys(files).sort()) {
    const source = files[path]!;
    const name = posix.basename(path);
    const rel = posix.join(d.sub, posix.relative(base, path));
    let text: string;
    if (adapter.isSupportFile(name)) {
      text = source;
    } else if (adapter.isTestFile(name) && keep[path]?.size) {
      // A kept test is never skipped, nor is a test the same source line runs as a kept one (one test of a
      // describe.each or test.each, run once per variant: "topup [memory] > S1" kept, "topup [postgres] > S1" not).
      const marked = (n: string) => adapter.skip(source, new Set([n]), "");
      const keptLines = new Set([...keep[path]!].map(marked).filter((t) => t !== source));
      const names = [...(skip[path] ?? [])].filter((n) => !keep[path]!.has(n) && !keptLines.has(marked(n)));
      const dropped = adapter.drop(source, new Set(names));
      text = dropped.text;
      // What could not be cut out is skipped, once per reason: a test set aside says why, apart from those not confirmed.
      const left = names.filter((n) => dropped.left.has(n));
      const why = (n: string) => typeof reason === "string" ? reason : reason(path, n);
      for (const r of new Set(left.map(why))) text = adapter.skip(text, new Set(left.filter((n) => why(n) === r)), r);
    } else {
      continue;
    }
    let target = adapter.acceptedPath(rel, tag, d.acceptedDir, "");
    if (!adapter.isSupportFile(name)) {
      const stem = names[path] || slugify(adapter.testStem(name)) || "unnamed";
      target = adapter.acceptedPath(rel, tag, d.acceptedDir, stem);
      for (let n = 2; taken.has(posix.basename(target)); n++) {
        target = adapter.acceptedPath(rel, tag, d.acceptedDir, `${stem}_${n}`);
      }
      taken.add(posix.basename(target));
    }
    text = adapter.relocate(text, posix.dirname(posix.relative(d.rootRel, path)), posix.dirname(target));
    const out = join(d.root, target);
    mkdirSync(dirname(out), { recursive: true });
    writeFileSync(out, text);
    written.push(out);
    if (moved) moved[path] = posix.join(DOME, d.rootRel, target);
  }
  return written;
}

/** The projects of a review: language and root of each. A review of a file without projects needs no review.yaml. */
interface ProjectInfo { name: string; adapter: Adapter; root: string; rootRel: string;
                        acceptedDir: string; files: Record<string, string>; writeDir: string }

function projectsOf(repo: string, rdir: string, review: Review, settings: Settings): ProjectInfo[] {
  const legacy = review.projects.length === 1 && review.projects[0] === "main";
  const file = legacy ? null : loadReviewFile(repo, { requireApproved: false });
  return review.projects.map((name) => {
    const cfg = file?.projects.find((p) => p.name === name);
    if (file && !cfg) throw new ArnxError(`review ${review.id} names project ${name}, which review.yaml no longer has`);
    const adapter = getAdapter(cfg?.language ?? review.language);
    const testsRoot = legacy ? join(rdir, "tests") : join(rdir, "projects", name, "tests");
    const files = readCopies(testsRoot, adapter.writable);
    const rootRel = cfg ? cfg.workdir : ".";
    return { name, adapter, root: join(repo, DOME, rootRel), rootRel,
      acceptedDir: settings.acceptedTestsDir, files,
      writeDir: review.writeDirs[name] ?? review.writeDir };
  });
}

/** Answer rounds run against the current working tree, in the project the question came from. `brain` (default:
 * LocalBrain over `agentModel`) turns each answer into tests. */
export function makeAnswerRunner(repo: string, file: ReviewFile, settings: Settings, agentModel: AgentModel | null,
                                 sessionFactory: SessionFactory = dockerSession, progress?: Say,
                                 brain: Brain = new LocalBrain({ agentModel: agentModel!, prices: allPrices(settings) }))
  : AnswerRunner {
  return async (qid, question, answer, diff, outDir, project) => {
    const cfg = file.projects.find((p) => p.name === project) ?? file.projects[0]!;
    const base = writeDirOf(cfg, "answers");
    // Only the project's part of the change: an answer is about one project, and a big change's whole diff made
    // every answer round pay for the other projects' code.
    const changed = [...diff.matchAll(/^diff --git a\/(\S+) b\//gm)].map((m) => m[1]!);
    const mine = route(file, changed, file.projects.length).routed.find((r) => r.project.name === cfg.name);
    const part = mine ? sliceDiff(diff, [...mine.owned, ...mine.used]) || diff : diff;
    // Untracked files only when the config sends them (a one-off --untracked review leaves them out here).
    const rnd = await testRound(repo, null, cfg, { brain,
      ask: () => ({ kind: "answer", input: { cfg, question, answer, diff: part } }), writeDir: base,
      budgetUsd: settings.answerBudgetUsd, runs: settings.runs, outDir, sessionFactory, untracked: settings.untracked,
      ...(progress ? { progress: (m: string) => progress(`${qid} · ${m}`) } : {}) });
    // A remote brain's cost goes by its tier and harness, never a model name.
    logUsage(repo, "accept", [agentUse(brain.label ? `${brain.label}/answer` : `anthropic:${agentModel!.model}`,
      rnd.agent)], new Date(), qid);
    const c = rnd.classified;
    // A test that fails in every run says the code does not do what the owner answered: it is kept, red, like a
    // finding marked real. Flaky or erroring tests are skipped.
    return { qid, files: rnd.files, keep: group([...c.passed, ...c.findings], rnd.files),
      skip: group([...c.flaky, ...c.errors], rnd.files), disagree: c.findings.map((t) => t.testId),
      costUsd: rnd.agent.costUsd, stop: rnd.agent.stop, base };
  };
}

export async function accept(repo: string, rdir: string, settings: Settings,
                             o: { again?: boolean; answerRunner?: AnswerRunner | null; now?: Date; progress?: Say;
                                  pins?: string | null } = {})
  : Promise<AcceptResult> {
  const review = load(rdir);
  const done = join(rdir, "accepted.json");
  if (existsSync(done) && !o.again) {
    throw new ArnxError(`review ${review.id} was already accepted; pass --again to apply edited marks`);
  }
  const say = (m: string) => o.progress?.(m);
  const marks = parseMarks(readFileSync(join(rdir, "review.md"), "utf8"), review.findings.map((f) => f.id),
    { reasons: true });
  const projects = projectsOf(repo, rdir, review, settings);
  const tag = review.id.replaceAll("-", "_");
  // This review's own kept files: in its r<tag>/ folder, or (Rust) named arnx_<tag>_* or arnx_<tag>.rs.
  const own = (p: string) => p.split("/").includes(`r${tag}`) || posix.basename(p).startsWith(`arnx_${tag}_`) ||
    posix.basename(p) === `arnx_${tag}.rs`;
  // File names already used in the repository: pytest imports test files by name, so a kept file must not share
  // one with the owner's tests or an earlier review's (this review's own are replaced, so they keep their names).
  const taken = new Set(workingTreeFiles(repo).files.filter((p) => (!p.startsWith(".arnx/") ||
    p.startsWith(`${DOME}/`)) && !own(p)).map((p) => posix.basename(p)));
  const before = existsSync(done)
    ? JSON.parse(readFileSync(done, "utf8")) as { moved?: Record<string, string>; kept?: string[] } : {};
  const earlier = before.moved ?? {};
  const kept: string[] = [];
  /** This review's own folders left empty, removed up to the first that is not its own. */
  const removeEmpty = (from: string) => {
    for (let d = from; d !== "." && own(d + "/x"); d = dirname(d)) {
      try {
        if (existsSync(join(repo, d)) && !readdirSync(join(repo, d)).length) rmdirSync(join(repo, d));
      } catch {
        break;
      }
    }
  };
  /** Generated test file → where accept put it (repository-relative). */
  const moved: Record<string, string> = {};
  const diff = existsSync(join(rdir, "change.diff")) ? readFileSync(join(rdir, "change.diff"), "utf8") : "";
  const rewrites = rewritesOf(review, marks);
  // The rounds: answered questions in order, then the rewrites. They run first: an answer's test can set aside the
  // test of a finding that assumed another answer.
  const rounds: { id: string; question: string; answer: string; project: string; key: string; rewrite: boolean }[] = [
    ...Object.entries(marks.answers).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
      .filter(([qid]) => Number(qid.slice(1)) - 1 >= 0 && Number(qid.slice(1)) - 1 < review.questions.length)
      .map(([qid, answer]) => {
        const index = Number(qid.slice(1)) - 1;
        return { id: qid, question: review.questions[index]!, answer, key: answer, rewrite: false,
          project: review.questionProjects[index] ?? projects[0]!.name };
      }),
    // A rewrite's saved outcome is reused only for the same issue and the same reason.
    ...rewrites.map((w) => ({ id: w.id, question: w.question, answer: w.answer, project: w.project,
      key: `${w.question}\n${w.answer}`, rewrite: true }))];
  const answers: AnswerOutcome[] = [];
  const outcomes: (AnswerOutcome | undefined)[] = [];
  if (o.answerRunner) {
    // Answer rounds run ANSWER_CONCURRENCY at a time, each in its own sandbox copy; tests are copied in round order.
    await sayingDocker(o.progress, () => inPool(rounds.map((_x, k) => k), ANSWER_CONCURRENCY, async (k) => {
      const { id, question, answer, project, key, rewrite } = rounds[k]!;
      // An answer already turned into tests (an earlier accept, same answer) is reused, not paid for again.
      const cache = join(rdir, "answers", id, "outcome.json");
      let outcome = readOutcome(cache, key);
      if (outcome) {
        say(`${id}: same ${rewrite ? "reason" : "answer"} as last time; reusing its tests`);
      } else {
        say(`${id}: writing tests for your ${rewrite ? "reason" : "answer"}`);
        outcome = await o.answerRunner!(id, question, answer, diff, join(rdir, "answers", id), project);
        writeOutcome(cache, key, outcome);
      }
      say(`${id}: done${outcome.disagree.length ? ` · the code does not do what ` +
        `${rewrite ? "your reason says" : "you answered"} (${outcome.disagree.length} failing)` : ""}`);
      outcomes[k] = outcome;
    }));
  }
  // Set aside: a finding marked real that assumed an answer to a question the owner answered, when that answer kept a
  // test (one that kept none settled nothing, so the finding's test stays); and a finding marked rewrite, when its
  // rewrite kept a test. A rewrite that did not run (--no-answers) or kept none leaves the finding's own test kept, as
  // real: a real bug is never left without a test.
  const keptSome = (x: AnswerOutcome | undefined) => !!x && Object.values(x.keep).some((v) => v.size);
  const setAside: Record<string, string> = {};
  for (const f of review.findings) {
    const k = rounds.findIndex((x) => !x.rewrite && x.id === f.dependsOn);
    if (marks.findings[f.id] === "real" && k >= 0 && keptSome(outcomes[k])) setAside[f.id] = f.dependsOn!;
  }
  for (const w of rewrites) {
    const k = rounds.findIndex((x) => x.rewrite && x.id === w.id);
    if (k >= 0 && keptSome(outcomes[k])) for (const id of w.findings) setAside[id] = w.id;
  }
  /** The marks that keep a finding's own test: real (or a rewrite nothing replaced), and not set aside. */
  const keeps = { ...marks, findings: Object.fromEntries(Object.entries(marks.findings)
    .map(([id, m]) => [id, setAside[id] ? null : m === "rewrite" ? "real" : m])) };
  const why = (id: string) => !setAside[id] ? "not confirmed" : setAside[id]!.startsWith("R")
    ? "rewritten from your reason" : `set aside: your answer to ${setAside[id]} has its own test`;
  for (const p of projects) {
    const keep: Record<string, Set<string>> = {};
    const skip: Record<string, Set<string>> = {};
    const reasons: Record<string, string> = {};
    for (const f of review.findings) {
      if (!f.file || f.project !== p.name) continue;
      const func = funcOfFinding(f);
      add(keeps.findings[f.id] === "real" ? keep : skip, f.file, func);
      if (setAside[f.id]) reasons[`${f.file}::${func}`] = why(f.id);
    }
    for (const testId of [...review.flaky, ...review.errors]) {
      const owner = ownerFile(testId.split("::")[0]!, Object.keys(p.files));
      if (owner) add(skip, owner, funcOfId(testId));
    }
    const written = exportTests(p.adapter, p.files, p.writeDir, { root: p.root, rootRel: p.rootRel,
      acceptedDir: p.acceptedDir, sub: "" }, tag, keep, skip,
      (path, name) => `arnx review ${review.id}: ${reasons[`${path}::${name}`] ?? "not confirmed"}`,
      namesOf(review, keeps, p.name, tag), taken, moved);
    kept.push(...written);
  }
  rounds.forEach(({ id, project, rewrite }, k) => {
    const outcome = outcomes[k];
    if (!outcome) return;
    const p = projects.find((x) => x.name === project) ?? projects[0]!;
    answers.push(outcome);
    // A test the code disagrees with is kept as it is: it fails until the code does what the answer (or reason) says.
    kept.push(...exportTests(p.adapter, outcome.files, outcome.base, { root: p.root, rootRel: p.rootRel,
      acceptedDir: p.acceptedDir, sub: "answers" }, tag, outcome.keep, outcome.skip,
      `arnx review ${review.id}: flaky or erroring while checking ${rewrite ? "the rewrite" : "the answer to"} ${id}`,
      {}, taken, moved));
  });
  // Accepting again: a file this review kept before and keeps no longer (its findings are no longer marked real, or
  // it is now kept under another name) is removed, so arnx check stops running it; then the folders it leaves empty.
  const rel = (p: string) => relative(repo, p).split(sep).join("/");
  const now = new Set(kept.map(rel));
  for (const was of new Set([...(before.kept ?? []), ...Object.values(earlier)])) {
    const full = join(repo, was);
    if (!own(was) || now.has(was) || !existsSync(full)) continue;
    rmSync(full, { force: true });
    removeEmpty(dirname(was));
  }
  // Where the kept files went: the deepest directory they share (the repository when nothing was kept).
  const dest = kept.length ? kept.map(dirname).reduce((a, b) => {
    while (a !== b && !b.startsWith(a + sep)) a = dirname(a);
    return a;
  }) : repo;
  const at = isoSeconds(o.now ?? new Date());
  const triaged = chosenInTriage(rdir);
  const pre = defaultMarks(review);
  const sources: Record<string, MarkSource> = Object.fromEntries(review.findings.map((f) =>
    [f.id, markSource(marks.findings[f.id] ?? null, pre[f.id] ?? null, triaged.has(f.id))]));
  // mark_source: lines written before it existed have none (unknown).
  const lines: Record<string, unknown>[] = review.findings.map((f) => ({ review: review.id, item: f.id,
    kind: "finding", verdict: f.verdict, mark: marks.findings[f.id] ?? null, mark_source: sources[f.id],
    severity: marks.severity[f.id] ?? null, reviewer: review.reviewer, challenger: review.challenger, at }));
  review.questions.forEach((_q, i) => lines.push({ review: review.id, item: `Q${i + 1}`, kind: "question",
    answered: `Q${i + 1}` in marks.answers, at }));
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  // Accepting again replaces this review's earlier marks rather than counting them twice.
  const precision = join(repo, ".arnx", "precision.jsonl");
  const others = existsSync(precision) ? readFileSync(precision, "utf8").split("\n").filter((l) => {
    if (!l.trim()) return false;
    try {
      return (JSON.parse(l) as { review?: string }).review !== review.id;
    } catch {
      return true;
    }
  }) : [];
  const log = [...others, ...lines.map((l) => JSON.stringify(l))];
  writeFileSync(precision, log.join("\n") + "\n");
  ignoreLocal(repo, "precision.jsonl");
  const keptRel = kept.map((p) => relative(repo, p).split(sep).join("/"));
  // Pinned: arnx check refuses to run these files once they change (accept --again records them anew). `pins`: this
  // machine's record of what arnx pinned (localPinsPath), so a pin edited in the repository is told apart.
  const disagree = Object.fromEntries(answers.map((a) => [a.qid, a.disagree]));
  recordAccepted(repo, review.id, testsByFile(keptRel, acceptedTestIds(review.findings, keeps.findings, moved, disagree)),
    o.pins ?? null);
  writeFileSync(done, JSON.stringify({ at, marks: marks.findings, answers: marks.answers,
    kept: keptRel, disagree, moved, set_aside: setAside,
    rewrites: Object.fromEntries(rewrites.map((w) => [w.id, { findings: w.findings, reason: w.reason }])) },
  null, 2) + "\n");
  const red = review.findings.filter((f) => keeps.findings[f.id] === "real")
    .map((f) => ({ id: f.id, testId: f.testId, project: f.project, explanation: f.explanation }));
  const result = { review, marks, kept, answers, rewrites, setAside, dest, red, moved, sources,
    precision: precisionOf(log) };
  writeFileSync(join(rdir, "fix-prompt.md"), wrapMarkdown(fixPrompt(result, settings)));
  return result;
}
