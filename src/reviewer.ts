// One review: resolve the change, route it to projects, run a test round on each (the brain drives the agent and the
// hunt), turn tests that fail in every run into findings with the reviewer's explanation, have the brain judge them,
// and write the report.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { adapterFor } from "./adapters";
import { isPreExisting } from "./before";
import type { Billed, Brain, HuntRecord, Totals } from "./brain";
import { inPool } from "./challenge";
import { shallowKind } from "./shallow";
import { clip, emit, EventLog, EVENTS_FILE, hypId, testMessage, withEvents, withRole } from "./events";
import { added, type Change, describe, describeBlanked, describeWithheld, EMPTY_TREE, filesAt, removed, resolveChange, sliceDiff,
  someNames, treeSuspects, untrackedLine, commitOf, changeMessage } from "./change";
import { maskedCopy } from "./boundary";
import { configSuspects, fileDigest, loadReviewFile, parseReviewFile, type ReviewConfig, reviewConfigPath, sandboxOnlyOf, secretPinsOf } from "./config";
import { ArnxError, SetupRequired } from "./errors";
import { huntParts } from "./hunt";
import { projectIndex } from "./indexer";
import { closers, spendClosers } from "./interrupt";
import { addUsage, type AgentModel, allPrices, FallbackJson, type JsonModel, type ModelUse, newUse,
  type Trace, unpricedModels } from "./llm";
import { LocalBrain } from "./localbrain";
import { changeEditsPrompts, PROMPTS_EDITED, promptsFor } from "./userprompts";
import { changeEditsAccepted } from "./check";
import { funcOf, ownerFile, type TestResult, testKey } from "./outcomes";
import { plainQuestion } from "./questions";
import { type CallRecord, cloudFailure, type ProviderFailure, providerFailures, resumes, withCalls } from "./outage";
import { CONTEXT_LIMIT, contextPack } from "./context";
import { elsewhereNote, leftOutNote, PROMPT_VERSION, type Suspect } from "./prompts";
import { changedSources, databaseEnv, framed, framesIn, isSourcePath, loadedTests, notReached, untestedFiles } from "./untested";
import { pythonTypeGap } from "./setupview";
import { type AgentReport, type Checked, type Finding, type FixProof, hasReport, parseReports, reportedTests, type ProjectStat, type Review,
  save, type SuspectOutcome, type Untested, adjudicate, exitCode, firstLine, sameCause, summaryRows, plural } from "./report";
import { dockerSteps, type SessionFactory } from "./sandbox";
import type { TypeCheck } from "./typecheck";
import type { Say } from "./progress";
import { route } from "./route";
import { isSecretPath, suspects as secretValues } from "./secrets";
import { cloudModels, modelRefs, refString, type Settings } from "./settings";
import { collect, dockerSession, ownTestsInWriteDir, ownTestsProblem, type Round, testRound, typecheckRound,
  writeDirOf } from "./testround";
import { logPartial, logUsage, type PartialReason, reconcileUsage, usageFromEvents, withEventSpend } from "./usage";
import { randomHex } from "./util";
import { buildInfo, VERSION } from "./version";

export const AGENT_SHARE = 0.85;

/** Projects tested at once: each runs its own sandbox, and a test run does not hold the process (Session.spawnRun), so
 * two side by side roughly halve a two-project review. */
export const PROJECT_CONCURRENCY = 2;

interface SavedVerdict { verdict: string; reason: string; dependsOn: string | null; judge: string | null;
  model: string; cost: number; sameAs?: string }

/** Whether a review's report says a provider outage cut work that a resume does again. A report without one finished:
 * there is nothing to resume. Not once its findings were accepted. */
export function cutByOutage(rdir: string): boolean {
  if (existsSync(join(rdir, "accepted.json"))) return false;
  try {
    const r = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as { provider_failures?: ProviderFailure[] };
    return (r.provider_failures ?? []).some(resumes);
  } catch {
    return false;
  }
}

/** Whether a finished-looking review has a project round a failed model call cut (`roundCut`): reviews of 0.1.7 and
 * 0.1.8 recorded no outage for it. Not once its findings were accepted. */
function cutRounds(rdir: string): boolean {
  if (existsSync(join(rdir, "accepted.json"))) return false;
  const dirs = [rdir];
  try {
    dirs.push(...readdirSync(join(rdir, "projects")).map((p) => join(rdir, "projects", p)));
  } catch {
    // no project folders
  }
  return dirs.some((d) => {
    try {
      return roundCut(JSON.parse(readFileSync(join(d, "round.json"), "utf8")), d);
    } catch {
      return false;
    }
  });
}

/** The newest review of this same change (same diff) that has no report yet, or whose report a provider outage cut. */
export function resumable(repo: string, diffSha: string): string | null {
  const dir = join(repo, ".arnx", "reviews");
  if (!existsSync(dir)) return null;
  const open = readdirSync(dir).map((d) => join(dir, d)).filter((d) => existsSync(join(d, "state.json")) &&
    (!existsSync(join(d, "review.json")) || cutByOutage(d) || cutRounds(d))).filter((d) => {
    try {
      const st = JSON.parse(readFileSync(join(d, "state.json"), "utf8")) as { diff_sha256?: string; superseded?: string };
      return st.diff_sha256 === diffSha && !st.superseded;
    } catch {
      return false;
    }
  });
  return open.sort((a, b) => statSync(join(a, "state.json")).mtimeMs - statSync(join(b, "state.json")).mtimeMs)
    .at(-1) ?? null;
}

/** Whether a project round kept from a cut review (round.json's content, `outDir` its folder) was stopped by a failed
 * model call and is done again on resume: it ended on one; or a failed follow-up left a suspect with neither a test nor
 * a reason; or (reviews of 0.1.7 and 0.1.8, which wrote such a stop as a normal end) its transcript's last turn is a
 * failed call and no test was written. A round cut only while asking about files or suspects it had covered stays kept. */
export function roundCut(saved: { round: Round; hunted?: Suspect[] | null }, outDir: string): boolean {
  const agent = saved.round.agent;
  if (agent.stop.startsWith("api_error")) return true;
  if (agent.cut?.startsWith("api_error")) {
    const report = parseReports([...agent.earlierTexts ?? [], agent.finalText]);
    const tested = new Set(report.tests.filter(isObject).map((t) => text(t.suspect ?? "").trim()));
    const reasons = new Set((report.suspects_not_tested ?? []).filter(isObject)
      .filter((n) => n.reason).map((n) => text(n.suspect ?? "").trim()));
    if ((saved.hunted ?? []).some((x) => !tested.has(x.id) && !reasons.has(x.id))) return true;
  }
  if (Object.keys(saved.round.files ?? {}).length) return false;
  try {
    const lines = readFileSync(join(outDir, "transcript.jsonl"), "utf8").split("\n").filter((l) => l.trim());
    return (JSON.parse(lines.at(-1) ?? "{}") as { stop_reason?: string }).stop_reason === "api_error";
  } catch {
    return false;
  }
}

const vendor = (ref: string) => ref.split(":")[0];
const snake = (k: string) => k.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);

/** What each suspect's test showed: failed in every run (judged later, see `adjudicate`), passed (not reproduced),
 * flaky or an error (inconclusive), or no test (not tested, with the reviewer's reason). */
export function suspectOutcomes(project: string, suspects: { id: string; file: string; line: number; claim: string;
  by: string }[], rnd: Round, report: AgentReport, findings: Finding[]): SuspectOutcome[] {
  const testsOf = new Map<string, string[]>();
  for (const t of report.tests) {
    if (!isObject(t) || !t.suspect) continue;
    const id = text(t.suspect).trim();
    testsOf.set(id, [...testsOf.get(id) ?? [], funcOfId(text(t.test ?? ""))]);
  }
  const reasons = new Map<string, string>();
  for (const n of report.suspects_not_tested ?? []) {
    if (isObject(n) && n.suspect) reasons.set(text(n.suspect).trim(), text(n.reason ?? ""));
  }
  const c = rnd.classified;
  const has = (list: { testId: string }[], funcs: string[]) => list.filter((t) => funcs.includes(funcOfId(t.testId)));
  return suspects.map((s) => {
    const funcs = testsOf.get(s.id) ?? [];
    const base = { project, id: s.id, file: s.file, line: s.line, claim: s.claim, by: s.by };
    const failed = findings.filter((f) => funcs.includes(funcOfId(f.testId)));
    if (failed.length) {
      for (const f of failed) f.suspect = s.id;
      return { ...base, outcome: "failed" as const, tests: failed.map((f) => f.testId), findings: failed.map((f) => f.id) };
    }
    const unsure = [...has(c.flaky, funcs), ...has(c.errors, funcs)];
    if (unsure.length) return { ...base, outcome: "inconclusive" as const, tests: unsure.map((t) => t.testId) };
    const passed = has(c.passed, funcs);
    if (passed.length) return { ...base, outcome: "not reproduced" as const, tests: passed.map((t) => t.testId) };
    if (has(c.skippedTests ?? [], funcs).length) {
      return { ...base, outcome: "not tested" as const, tests: [], reason: "its test was skipped" };
    }
    return { ...base, outcome: "not tested" as const, tests: [],
      ...(reasons.get(s.id) ? { reason: reasons.get(s.id)! } : {}) };
  });
}

export function newReviewId(now: Date): string {
  return now.toISOString().slice(0, 10).replaceAll("-", "") + "-" + randomHex(3);
}

const funcOfId = testKey;
/** Two uses of the same model in one review, added up. */
/** Why the code before the change has nothing to compare a finding against: the change is the first commit, or its
 * base holds none of the changed source files (all new: an empty first commit, or files not committed yet). Null
 * when the base holds some of them. */
function emptyBase(repo: string, change: Change, sources: string[]): "first-commit" | "new-files" | null {
  if (change.base === EMPTY_TREE) return "first-commit";
  if (!sources.length) return null;
  const atBase = new Set(filesAt(repo, change.base));
  return sources.some((p) => atBase.has(p)) ? null : "new-files";
}

/** hunt.json of a round folder, or (without one) a record of the suspects alone. */
function readHuntRecord(outDir: string, suspects: Suspect[]): HuntRecord {
  try {
    const r = JSON.parse(readFileSync(join(outDir, "hunt.json"), "utf8")) as HuntRecord;
    if (Array.isArray(r.tested)) return r;
  } catch {
    // no record: the suspects themselves
  }
  return { reviewer: suspects, parts: [], second: null, tested: suspects };
}

function mergeUse(a: ModelUse, b: ModelUse): ModelUse {
  return { ...addUsage(a, b), model: a.model, calls: a.calls + b.calls, unknownCalls: a.unknownCalls + b.unknownCalls,
    costUsd: Math.round((a.costUsd + b.costUsd) * 1_000_000) / 1_000_000 };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));

/** Passing tests with what the reviewer's report says each one checks (matched by test id, else by name). */
export function buildChecked(rnd: Round, report: AgentReport, project: string): Checked[] {
  const byId = new Map<string, string>(), byFunc = new Map<string, string>();
  for (const t of report.tests) {
    if (!isObject(t)) continue;
    const id = text(t.test ?? ""), expects = t.expects ? text(t.expects) : "";
    byId.set(id, expects);
    if (!byFunc.has(funcOfId(id))) byFunc.set(funcOfId(id), expects);
  }
  return rnd.classified.passed.map((t) => ({ project, test: t.testId,
    expects: byId.get(t.testId) ?? byFunc.get(testKey(t.testId)) ?? "" }));
}

/** Whether the reviewer's last report names this failing test: the same test key, in the same file name (a report
 * entry without a file matches any file; a result with no file attribute starts its id with a classname, so only
 * the key counts), and the same class when both sides give one. With no report, none is named. */
export function claimed(t: TestResult, named: { file: string; name: string }[] | null): boolean {
  const key = testKey(t.testId);
  const file = t.fileAttr ? posix.basename(t.fileAttr) : null;
  const classOf = (parts: string[]) => parts.length >= 2 ? parts.at(-2) : undefined;
  const head = (id: string) => id.split("[")[0]!; // a parameter may hold "::"
  const mine = classOf(head(t.testId).split("::").slice(1));
  return !!named?.some((n) => {
    if (testKey(`${n.file || "f"}::${n.name}`) !== key) return false;
    if (n.file && file !== null && posix.basename(n.file) !== file) return false;
    const theirs = classOf(head(n.name).split("::"));
    return !(mine && theirs && mine !== theirs);
  });
}

export function buildFindings(rnd: Round, report: AgentReport): Finding[] {
  const explanations = new Map<string, string>();
  for (const t of report.tests) {
    if (!isObject(t) || !t.expects) continue;
    const func = funcOfId(text(t.test ?? ""));
    if (!explanations.has(func)) explanations.set(func, `Expected: ${text(t.expects)}`);
  }
  for (const d of report.suspected_defects) {
    if (isObject(d) && d.explanation) explanations.set(funcOfId(text(d.test ?? "")), text(d.explanation));
  }
  return rnd.classified.findings.map((t, i) => ({ id: `F${i + 1}`, testId: t.testId, func: funcOf(t),
    file: ownerFile(t.fileAttr, Object.keys(rnd.files)), message: t.message,
    explanation: explanations.get(testKey(t.testId)) ?? "", verdict: null, reason: "", project: "main",
    ...(rnd.before?.tests[t.testId] ? { before: rnd.before.tests[t.testId] } : {}) }));
}

/** The project's own test files that mention one of its environment variables, so the reviewer can copy their
 * setup (a database connection, the schema). Read from the round's snapshot (`snap`): the files the reviewer can
 * read, staged and untracked ones included when the review sends them; at most `max`. */
export function envTests(snap: string, cfg: ReviewConfig, max = 6): string[] {
  const names = Object.keys(cfg.env);
  if (!names.length || !existsSync(join(snap, cfg.workdir))) return [];
  const adapter = adapterFor(cfg);
  const files = collect(snap, cfg.workdir === "." ? "" : cfg.workdir, /./)
    .filter((p) => adapter.isTestFile(posix.basename(p)) && !isSecretPath(p));
  const out: string[] = [];
  for (const p of files) {
    let body: string;
    try {
      body = readFileSync(join(snap, p), "utf8");
    } catch {
      continue;
    }
    if (names.some((n) => body.includes(n))) out.push(posix.relative(cfg.workdir, p) || p);
    if (out.length >= max) break;
  }
  return out;
}

export async function runReview(repo: string, o: { settings: Settings;
  /** The reviewer and the second opinion of the local brain (not needed when `brain` is given). */
  agentModel?: AgentModel; challenger?: JsonModel;
  range?: string | null; sessionFactory?: SessionFactory; now?: Date; progress?: Say;
  /** Builds a project's code index for `context = "precise"` (default: in its Docker environment). */
  indexer?: typeof projectIndex;
  /** Look for defects before writing tests (default on). */
  hunt?: boolean;
  /** Hunts each part of a big change (tool-less); without it only the reviewer and the second hunter hunt. */
  hunter?: JsonModel;
  /** Ranks the merged suspects by harm before the cut (the reviewer model); without it they are taken in turn. */
  ranker?: JsonModel;
  /** The tool-less hunter from another vendor (default: the challenger, when it is a single model from another
   * vendor). */
  secondHunter?: JsonModel;
  /** Continue the latest unfinished review of this same change. */
  resume?: boolean;
  /** Projects tested at once (default PROJECT_CONCURRENCY). */
  projectConcurrency?: number;
  /** How long the tests wait for the second hunter (default localbrain.ts SECOND_HUNT_WAIT_MS). */
  secondHuntWaitMs?: number;
  /** Send untracked files too (--untracked / --no-untracked; default: `[review] untracked`). */
  untracked?: boolean;
  /** The judgement side (default: LocalBrain over the models above). */
  brain?: Brain })
  : Promise<{ review: Review; rdir: string }> {
  const s = o.settings;
  if (cloudModels(s) && !s.cloudConsentAt) {
    throw new SetupRequired("sending code to arnx cloud has not been agreed to; nothing sent: run `arnx consent --cloud`");
  }
  const file = loadReviewFile(repo);
  const change = resolveChange(repo, o.range ?? null, secretPinsOf(file.raw),
    { untracked: o.untracked ?? s.untracked });
  // What is sent beyond tracked changes, or left out of them, comes first: the owner can stop before anything is sent.
  const sent = untrackedLine(change);
  if (sent) o.progress?.(sent);
  if (change.ignored) {
    o.progress?.(`left out (.arnxignore): ${change.ignored.slice(0, 5).join(", ")}` +
      `${change.ignored.length > 5 ? ", …" : ""}`);
  }
  if (change.lockfiles) {
    o.progress?.(`lockfile changes not sent (the sandbox keeps them): ${someNames(change.lockfiles, 5)}`);
  }
  if (change.leftOut) {
    o.progress?.(`left out ${change.leftOut.length} accepted test file(s) not committed yet`);
  }
  if (change.blanked) o.progress?.(`comment lines blanked as secret-looking: ${describeBlanked(change.blanked)}`);
  if (change.withheld) {
    o.progress?.(`left out as secret-looking: ${describeWithheld(change.withheld)}; if one is a test fixture, allow it ` +
      "with `arnx allow-secret PATH`");
  }
  // The local brain reads .arnx/prompts.toml from the working tree: a change that edits it is reviewed with its own.
  const promptsEdited = !o.brain && changeEditsPrompts(repo, change);
  if (promptsEdited) o.progress?.(PROMPTS_EDITED);
  // Elsewhere (a fresh clone, CI) check trusts the committed pins: an edit of accepted tests shows only here.
  const acceptedEdited = changeEditsAccepted(repo, change);
  if (acceptedEdited.length) o.progress?.(`this change edits accepted tests: ${someNames(acceptedEdited, 5)}`);
  const routing = route(file, change.files, s.maxProjects);
  if (!routing.routed.length) {
    const paths = routing.uncovered.map((u) => `${u.path} (${u.reason})`).join(", ");
    throw new SetupRequired(`no project covers this change: ${paths}. Run \`arnx setup --add\` to cover these paths`);
  }
  // A round clears the writable files in tests_dir: one holding the project's own tests would drop them unseen.
  const tree = filesAt(repo, change.head, !!change.withUntracked);
  const crowded = routing.routed.flatMap(({ project: cfg }) => {
    const own = ownTestsInWriteDir(cfg, tree, s.acceptedTestsDir);
    return own.length ? [`${file.legacy ? "" : `${cfg.name}: `}${ownTestsProblem(cfg, own)}`] : [];
  });
  if (crowded.length) {
    throw new SetupRequired(`${crowded.join("\n")}\nChange tests_dir in .arnx/review.yaml (or run \`arnx setup\`), ` +
      "then `arnx review` again");
  }
  const started = performance.now();
  // A review saves each finished project round and each verdict as it goes, so `--resume` continues one that was cut
  // off (a dropped connection, a closed laptop) without paying again for what was done.
  const diffSha = createHash("sha256").update(change.diff).digest("hex");
  // What decides the work a resume would reuse: what the project file says (not its comments, line ends or approval),
  // the models and the prompts. A review cut under others is not continued.
  const stamp = createHash("sha256").update(JSON.stringify([
    (() => { try { return fileDigest(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8"))); } catch { return ""; } })(),
    o.brain ? [o.brain.label ?? "", o.brain.version] : [refString(s.reviewer), o.challenger?.ref ?? "", o.hunter?.ref ?? "",
      o.ranker?.ref ?? "", o.secondHunter?.ref ?? "", PROMPT_VERSION, o.agentModel ? promptsFor(repo).hash : ""]])).digest("hex");
  const found = o.resume ? resumable(repo, diffSha) : null;
  if (o.resume && !found) throw new ArnxError("nothing to resume: no unfinished review of this change");
  const was = found ? (() => { try { return (JSON.parse(readFileSync(join(found, "state.json"), "utf8")) as { stamp?: string }).stamp; } catch { return undefined; } })() : undefined;
  const changed = !!found && typeof was === "string" && was !== stamp;
  const resumed = changed ? null : found;
  if (changed) o.progress?.("review.yaml, models or prompts changed since that review: running it fresh");
  const rid = resumed ? posix.basename(resumed) : newReviewId(o.now ?? new Date());
  const rdir = join(repo, ".arnx", "reviews", rid);
  reconcileUsage(repo, rid); // reviews an earlier run never finished (killed) are counted now
  if (resumed) o.progress?.(`resuming review ${rid}`);
  else {
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(rdir, "state.json"), JSON.stringify({ change: describe(change), diff_sha256: diffSha, stamp,
      ...(change.untrackedIncluded ? { untracked: true } : {}) }) + "\n");
    // The review it replaces is not offered again.
    if (found) {
      try {
        const old = join(found, "state.json");
        writeFileSync(old, JSON.stringify({ ...JSON.parse(readFileSync(old, "utf8")), superseded: rid }) + "\n");
      } catch {
        // it stays as it was
      }
    }
  }
  const log = new EventLog(join(rdir, EVENTS_FILE), rid);
  const stateFile = join(rdir, "state.json");
  const state = (): Record<string, unknown> => {
    try {
      return JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
    } catch {
      return {};
    }
  };
  // The time of the sessions before this one: a resumed review counts them.
  const earlier = Number(state().seconds) || 0;
  const elapsed = () => Math.round(earlier * 10 + (performance.now() - started) / 100) / 10;
  // The brain hears how the review ended whatever ends it (a remote brain settles its hold then): completed, failed,
  // or interrupted (interrupt.ts closes it). The totals count the project rounds that finished.
  const soFar: Totals = { stop: "", projectsReviewed: 0, testsWritten: 0, passed: 0, findings: 0, flaky: 0, seconds: 0 };
  let finish: ((stop: string, totals?: Totals) => Promise<Billed | null>) | null = null;
  // Each model call's outcome, so the report can say when a provider was down or refused the key.
  const calls: CallRecord[] = [];
  const run = async (): Promise<{ review: Review; rdir: string }> => {
    // Docker steps of this review, with their durations.
    dockerSteps.log = (line) => {
      mkdirSync(rdir, { recursive: true });
      appendFileSync(join(rdir, "docker.jsonl"), JSON.stringify(line) + "\n");
    };
    dockerSteps.say = o.progress ?? null;
    const n = routing.routed.length;
    const findings: Finding[] = [];
    const questions: string[] = [];
    const questionProjects: string[] = [];
    const sources: Record<string, string> = {};
    const writeDirs: Record<string, string> = {};
    const flaky: string[] = [], errors: string[] = [], notSent = new Set(change.withheld?.map((w) => w.path));
    const leftOutFiles = new Map((change.withheld ?? []).map((w) => [w.path, w]));
    const couldNotRun: { test: string; needs: string; faked?: boolean }[] = [];
    const unclaimed: NonNullable<Review["unclaimed"]> = [];
    const typesUnchecked = pythonTypeGap(file, repo, routing.routed.map((x) => x.project.name));
    const fakedKeys = new Set<string>();
    let skippedTests = 0;
    const projectStats: ProjectStat[] = [];
    const checked: Checked[] = [];
    const untested: Untested[] = [];
    const sourceSet = new Set<string>();
    const declaredPaths = new Set(routing.declared.map((d) => d.path));
    const diffs: Record<string, string> = {};
    // Each finding's evidence pack, by project and test id, built in its round (not for arnx cloud, which builds its own
    // prompts); the change's commit message goes in each.
    const evidence: Record<string, Record<string, string>> = {};
    const suspects: SuspectOutcome[] = [];
    const local = (): LocalBrain => {
      if (!o.agentModel || !o.challenger) throw new Error("runReview: the local brain needs agentModel and challenger");
      return new LocalBrain({ agentModel: o.agentModel, prices: allPrices(s), challenger: o.challenger,
        prompts: promptsFor(repo),
        ...(o.hunter ? { hunter: o.hunter } : {}), ...(o.ranker ? { ranker: o.ranker } : {}), secondHunter,
        ...(o.secondHuntWaitMs === undefined ? {} : { secondHuntWaitMs: o.secondHuntWaitMs }) });
    };
    const secondHunter = o.secondHunter ?? (o.challenger && vendor(o.challenger.ref) !== vendor(refString(s.reviewer)) &&
      !(o.challenger instanceof FallbackJson) ? o.challenger : null);
    const brain: Brain = o.brain ?? local();
    // Nothing has left yet: the filter knows the diff before the first request, and the tree before each round's. A
    // resumed review may have no round left to tell it, and it still judges.
    const boundary = brain.boundary;
    const message = brain.label ? "" : changeMessage(repo, change);
    if (boundary) {
      log.filter = boundary;
      const pins = secretPinsOf(file.raw);
      boundary.addDiff(change.diff, pins);
      boundary.add(configSuspects(repo));
      boundary.add(secretValues("", message, []));
      if (resumed) {
        boundary.add(treeSuspects(repo, change.head, pins, { untracked: !!change.withUntracked,
          sandbox: sandboxOnlyOf(file.raw) }));
      }
    }
    let finished = false;
    const interrupted = async () => { await finish?.("interrupted"); };
    finish = async (end, totals) => {
      if (finished) return null;
      finished = true;
      closers.delete(interrupted);
      // However the review ended, its time is kept for a resume.
      try {
        writeFileSync(stateFile, JSON.stringify({ ...state(), seconds: totals?.seconds ?? elapsed() }) + "\n");
      } catch {
        // the time is a courtesy
      }
      return brain.finish(totals ?? { ...soFar, stop: end, seconds: elapsed() });
    };
    closers.add(interrupted);
    // A remote brain opens the review here (its budget hold; 402 stops before any work, exit 3). Its id there is kept
    // in state.json, so a `--resume` names the review it continues.
    const resumeOf = resumed && brain.start ? state().cloud_review_id : undefined;
    const opened = await brain.start?.({ files: change.files, added: added(change), removed: removed(change),
      diffSha256: diffSha, budgetUsd: s.reviewBudgetUsd,
      projects: routing.routed.map(({ project: p }) => ({ name: p.name, language: p.language, runner: p.runner })),
      ...(typeof resumeOf === "string" ? { resumeOf } : {}) });
    if (opened) writeFileSync(stateFile, JSON.stringify({ ...state(), cloud_review_id: opened.reviewId }) + "\n");
    // A remote brain's work goes by its tier and harness; the local brain's by each model's name.
    const label = brain.label;
    const reviewerRef = label ?? refString(s.reviewer);
    const challengerRef = label ?? o.challenger?.ref ?? "";
    let configSha: string | null = null;
    try {
      configSha = createHash("sha256").update(readFileSync(reviewConfigPath(repo))).digest("hex");
    } catch {
      // an unreadable config is recorded as null
    }
    emit("review.started", { arnx_version: VERSION, build: buildInfo(), prompt_version: brain.version,
      change: describe(change), change_kind: change.kind, base: change.base, head: change.head, diff_sha256: diffSha,
      files_changed: change.files.length, config_sha256: configSha,
      ...(change.untrackedIncluded ? { untracked_included: change.untrackedIncluded } : {}),
      ...(change.untrackedLeftOut ? { untracked_left_out: change.untrackedLeftOut.length } : {}),
      models: label ? { reviewer: label, challenger: label, hunter: null, ranker: null, second_hunter: null }
        : { reviewer: reviewerRef, challenger: challengerRef, hunter: o.hunter?.ref ?? null,
          ranker: o.ranker?.ref ?? null, second_hunter: secondHunter?.ref ?? null },
      projects: routing.routed.map((r) => r.project.name), resumed: !!resumed,
      settings: { runs: s.runs, review_budget_usd: s.reviewBudgetUsd, max_questions: s.maxQuestions,
        max_projects: s.maxProjects, hunt: !!o.hunt, before_check: s.beforeCheck,
        ...(s.beforeCheck ? { fix_proof_max: s.fixProofMax } : {}) } });
    let huntSecond = null as ModelUse | null; // set inside the hunt callbacks
    const extraUses: ModelUse[] = [];
    let passed = 0, written = 0, missingRuns = 0, agentCost = 0, stop = "end_turn";
    const agentUse = newUse(label ? `${label}/reviewer` : reviewerRef);
    // Projects are tested PROJECT_CONCURRENCY at a time (each in its own sandbox); their results are then gathered in
    // review order, so ids, questions and the report do not depend on which finished first.
    interface Done { i: number; rnd: Round; hunted: Suspect[] | null; second: ModelUse | null; extras: ModelUse[];
      resumed: boolean }
    // Projects whose kept round a failed model call stopped: tested again on resume.
    const redone = new Set<string>();
    const runProject = async (i: number): Promise<Done> => {
      const { project: cfg, owned, used } = routing.routed[i]!;
      o.progress?.(`${cfg.name} (${i + 1}/${n}): preparing the test environment`);
      const writeDir = writeDirOf(cfg);
      writeDirs[cfg.name] = writeDir;
      // Each project gets the part of the change it owns or uses, so a big change is not cut short by other projects'.
      const diff = file.legacy ? change.diff : sliceDiff(change.diff, [...owned, ...used]) || change.diff;
      // The change's other files are named to the round and the second opinion: a part they cannot see is never
      // taken for missing from the change.
      const seen = new Set([...owned, ...used]);
      const elsewhere = file.legacy || diff === change.diff ? [] : change.files.filter((f) => !seen.has(f));
      const others = [elsewhereNote(elsewhere), leftOutNote(change.withheld ?? [])].filter(Boolean).join(" ");
      diffs[cfg.name] = others ? `${diff}\n\n${others}\n` : diff;
      const outDir = file.legacy ? rdir : join(rdir, "projects", cfg.name);
      const leftOut = change.withheld ? { leftOut: change.withheld } : {};
      const scope = file.legacy ? { owned: change.files, used: [], ...leftOut } : { owned, used, elsewhere, ...leftOut };
      const projectBudget = s.reviewBudgetUsd * AGENT_SHARE / n;
      const roundFile = join(outDir, "round.json");
      type SavedRound = { round: Round; hunted: Suspect[] | null; second: ModelUse | null; extras: ModelUse[] };
      const saved = resumed && existsSync(roundFile) ? JSON.parse(readFileSync(roundFile, "utf8")) as SavedRound : null;
      // A round a failed model call stopped (a provider outage) is tested again; its verdicts are dropped below.
      const cutRound = !!saved && roundCut(saved, outDir);
      if (cutRound) redone.add(cfg.name);
      // What the cut attempt cost is spent: it counts in the review, and the new attempt has that much less.
      const cutUse: ModelUse | null = cutRound && saved!.round.agent.costUsd + saved!.round.agent.calls +
        (saved!.round.agent.unknownCalls ?? 0) > 0 ? { ...newUse(agentUse.model), ...saved!.round.agent.usage,
          calls: saved!.round.agent.calls, unknownCalls: saved!.round.agent.unknownCalls ?? 0,
          costUsd: saved!.round.agent.costUsd } : null;
      // The hunt of the cut attempt, when its reply came: its suspects and what the hunters cost are not paid for again.
      const prior = cutRound && saved!.hunted && brain.reusesHunt ? saved! : null;
      if (cutRound && saved!.hunted && !prior) {
        o.progress?.(`${cfg.name}: the hunt cannot be reused here; hunting again, which costs a new hunt`);
      }
      const reusedCost = !prior ? 0 : (prior.second?.costUsd ?? 0) + prior.extras.reduce((a, u) => a + u.costUsd, 0);
      const opts = { brain, budgetUsd: Math.max(0, projectBudget - (cutUse?.costUsd ?? 0) - reusedCost), writeDir, runs: s.runs, outDir,
        sessionFactory: o.sessionFactory ?? dockerSession, progress: o.progress, coverage: scope.owned,
        untracked: !!change.withUntracked, recordEnvFailure: true, ...(brain.label ? {} : { evidence: { diff, message } }),
        // The code before the change: its base (HEAD for uncommitted work); a first commit has none, nor has a
        // repository with no commits yet. Without one, or for a change to tests or docs only, there is no fix proof.
        ...(s.beforeCheck ? { before: { base: change.base === EMPTY_TREE ? null : change.base, diff: change.diff,
          fixProofMax: change.base !== EMPTY_TREE && changedSources(scope.owned, adapterFor(cfg)).length
            ? s.fixProofMax : 0 } } : {}),
        // The project's type check, once; its errors are compared with the code before the change when the
        // before/after check is on.
        ...(cfg.typecheck ? { typecheck: { changed: change.files,
          ...(s.beforeCheck ? { base: change.base === EMPTY_TREE ? null : change.base } : {}) } } : {}),
        // The hunt reads the snapshot the tests run on: the context pack is built on it here, the hunters run in the
        // brain.
        ask: async (snap: string) => {
          const searchDirs = [cfg.workdir, ...new Set(used.map((u) => posix.dirname(u)))];
          let index = null;
          if (prior) {
            // From the saved hunt, masked as the model sees this snapshot (the filter knows its values by now).
            const record = readHuntRecord(outDir, prior.hunted!);
            const reused = boundary ? boundary.maskValue({ suspects: prior.hunted!, record }) : { suspects: prior.hunted!, record };
            return { kind: "review" as const, input: { cfg, diff, scope, scoped: !file.legacy,
              envTests: envTests(snap, cfg), maxQuestions: s.maxQuestions, dbNames: databaseEnv(cfg.env, cfg.services),
              prior: reused } };
          }
          if (o.hunt && s.context === "precise") {
            o.progress?.(`${cfg.name} (${i + 1}/${n}): indexing the code`);
            const r = await (o.indexer ?? projectIndex)(cfg, snap, outDir);
            if (!r.index) o.progress?.(`${cfg.name} (${i + 1}/${n}): no code index (${clip(r.reason ?? "", 80)}); context by names`);
            index = r.index;
          }
          return { kind: "review" as const, input: { cfg, diff, scope, scoped: !file.legacy,
            envTests: envTests(snap, cfg), maxQuestions: s.maxQuestions, dbNames: databaseEnv(cfg.env, cfg.services),
            // Part hunters build their context packs from the snapshot; with an index they get them built here.
            ...(o.hunt ? { hunt: { context: contextPack(snap, diff, scope.owned, searchDirs, CONTEXT_LIMIT, index),
              root: snap, searchDirs, ...(index ? { parts: huntParts(snap, cfg, diff, scope.owned, searchDirs, index) }
                : {}) } } : {}) } };
        } };
      let rnd: Round, kept = false, hunted: Suspect[] | null = null, projSecond: ModelUse | null = null;
      const projExtras: ModelUse[] = [];
      if (saved && !cutRound) {
        kept = true;
        [rnd, hunted, projSecond] = [saved.round, saved.hunted, saved.second];
        projExtras.push(...saved.extras);
        o.progress?.(`${cfg.name} (${i + 1}/${n}): ${rnd.env?.state === "failed" ? "not tested before the interruption (its environment failed); kept"
          : "already tested before the interruption; kept"}`);
      } else {
        const { hunt, ...tested } = await withRole("reviewer", () => testRound(repo, change.head, cfg, opts),
          { project: cfg.name });
        rnd = tested;
        if (hunt) {
          [hunted, projSecond] = [hunt.suspects, hunt.second];
          projExtras.push(...hunt.extras);
          // A hunter still out when the tests started: its cost counts once it returns.
          if (hunt.late) projSecond = await hunt.late();
        }
        if (cutUse) projExtras.push(cutUse);
        // A hunt done again was paid for before: that cost stays in the review.
        if (cutRound && saved && !prior) projExtras.push(...saved.second ? [saved.second] : [], ...saved.extras);
        if (prior) {
          projSecond = prior.second;
          projExtras.push(...prior.extras);
        }
        writeFileSync(roundFile, JSON.stringify({ round: rnd, hunted, second: projSecond, extras: projExtras }) + "\n");
      }
      const c = rnd.classified;
      if (!rnd.env || rnd.env.state === "fallback") soFar.projectsReviewed += 1;
      soFar.testsWritten += c.findings.length + c.flaky.length + c.errors.length + c.passed.length;
      soFar.passed += c.passed.length;
      const named0 = reportedTests([...rnd.agent.earlierTexts ?? [], rnd.agent.finalText]);
      soFar.findings += c.findings.filter((t) => claimed(t, named0)).length;
      soFar.flaky += c.flaky.length;
      return { i, rnd, hunted, second: projSecond, extras: projExtras, resumed: kept };
    };
    // A range ending anywhere but the checked-out commit tests an older tree: setup (which proves this one) cannot mend it.
    const atCheckedOut = change.kind !== "range" || change.head === commitOf(repo, "HEAD");
    const done: Done[] = [];
    await inPool(routing.routed.map((_r, i) => i), o.projectConcurrency ?? PROJECT_CONCURRENCY, async (i) => {
      done[i] = await runProject(i);
    });
    let beforeSecs = 0, fixProofSecs = 0;
    const fixProof: FixProof[] = [];
    const typecheck: TypeCheck[] = [];
    // Projects routing gave no agent round: their changed files are reviewed by their owners above; their type check
    // still runs (no model), so the report says what it found and who reviewed their files.
    for (const c of file.legacy ? [] : routing.checkOnly) {
      o.progress?.(`${c.project.name}: ${c.project.typecheck ? "only its type check" : "no round of its own"}: its ` +
        `changed files are reviewed by ${c.by.join(", ")}`);
      const t = await typecheckRound(repo, change.head, c.project, { changed: change.files,
        ...(s.beforeCheck ? { base: change.base === EMPTY_TREE ? null : change.base } : {}),
        outDir: join(rdir, "projects", c.project.name), sessionFactory: o.sessionFactory ?? dockerSession,
        ...(o.progress ? { progress: o.progress } : {}), untracked: !!change.withUntracked,
        ...(boundary ? { boundary } : {}) });
      if (t) typecheck.push(t);
    }
    const keptRound = new Set<string>();
    for (const { i, rnd, hunted, second: projSecond, extras: projExtras, resumed: kept } of done) {
      const { project: cfg, owned } = routing.routed[i]!;
      const ps = projSecond as ModelUse | null;
      if (ps) huntSecond = huntSecond ? mergeUse(huntSecond, ps) : ps;
      extraUses.push(...projExtras);
      const h = hunted as Suspect[] | null;
      const report = parseReports([...rnd.agent.earlierTexts ?? [], rnd.agent.finalText]);
      for (const t of report.tests.filter(isObject)) {
        emit("test.written", { project: cfg.name, test_id: clip(text(t.test ?? ""), 500),
          func: funcOfId(text(t.test ?? "")),
          hyp_id: t.suspect ? hypId(cfg.name, text(t.suspect).trim()) : null,
          expects: clip(text(t.expects ?? ""), 500) });
      }
      // A failing test the reviewer's last report leaves out (a scratch probe, one a newer file replaced) is no finding.
      const named = reportedTests([...rnd.agent.earlierTexts ?? [], rnd.agent.finalText]);
      const failing = rnd.classified.findings;
      const isClaimed = failing.filter((t) => claimed(t, named));
      for (const t of failing) {
        if (!isClaimed.includes(t)) unclaimed.push({ project: cfg.name, testId: t.testId, message: t.message });
      }
      const projectFindings = buildFindings({ ...rnd, classified: { ...rnd.classified, findings: isClaimed } }, report).map((f) => {
        const shallow = shallowKind(f.file ? rnd.files[f.file] : undefined, f.func);
        return { ...f, project: cfg.name, ...(shallow ? { shallow } : {}), ...(rnd.env?.state === "fallback" ? { fallback: true as const } : {}) };
      });
      findings.push(...projectFindings);
      if (h?.length) suspects.push(...suspectOutcomes(cfg.name, h, rnd, report, projectFindings));
      checked.push(...buildChecked(rnd, report, cfg.name));
      for (const q of report.questions) {
        const asked = plainQuestion(isObject(q) && typeof q.question === "string" ? q.question : text(q));
        if (!asked) continue;
        questions.push(asked);
        questionProjects.push(cfg.name);
        if (questions.length > s.maxQuestions) continue;
        // A test the question names, or one written for a suspect it names ("… (S9)"), assumes one answer: it waits
        // on the question rather than asserting what the owner has not decided.
        const linked = new Set(isObject(q) && Array.isArray(q.tests) ? q.tests.map((t) => funcOfId(text(t))) : []);
        const named = new Set(questions.at(-1)!.match(/\bS\d+\b/g) ?? []);
        for (const f of projectFindings) {
          if (!f.dependsOn && (linked.has(testKey(f.testId)) || (f.suspect && named.has(f.suspect)))) {
            f.dependsOn = `Q${questions.length}`;
          }
        }
      }
      Object.assign(sources, rnd.files);
      if (rnd.evidence) evidence[cfg.name] = rnd.evidence;
      const ownedNow = file.legacy ? change.files : owned;
      const ownSources = changedSources(ownedNow, adapterFor(cfg));
      const of = ownSources.length;
      for (const f of ownSources) sourceSet.add(f);
      if (of) {
        const adapter = adapterFor(cfg);
        // What a test is shown to reach: its stack frames, the names its code uses, and what the runs executed (the
        // runner's own notes, Python only). A file whose tests did not load, or did not finish, shows nothing.
        const frames = [...rnd.classified.findings, ...rnd.classified.flaky].filter((t) => !t.needs && !t.fakedKey)
          .flatMap((t) => framesIn(t.message));
        const loaded = loadedTests(rnd.files, rnd.classified, [...rnd.hungFiles ?? [], ...rnd.notRunFiles ?? []]);
        const byText = new Set(untestedFiles(ownedNow, rnd.files, adapter));
        const missed = notReached(ownedNow, { tests: loaded, frames, ...(rnd.reached ? { ran: rnd.reached } : {}) }, adapter);
        const reasons: Record<string, string> = {};
        for (const f of missed) if (!byText.has(f)) reasons[f] = "a test only mentions it as text";
        // A file the reviewer named stays listed, unless a failing test's frame goes through it.
        const sources = changedSources(ownedNow, adapter);
        const named = (report.not_tested ?? []).flatMap((n) => !isObject(n) ? [] :
          sources.filter((x) => x === text(n.file) || x.endsWith(`/${text(n.file)}`)));
        const shown = new Set(framed(sources, frames));
        // A file review.yaml lists as uncovered is reported there, once.
        const files = [...new Set([...missed, ...named.filter((f) => !shown.has(f)), ...(rnd.dbUntested ?? []).filter((f) => !shown.has(f))])]
          .filter((f) => !declaredPaths.has(f));
        for (const f of files) if ((rnd.dbUntested ?? []).includes(f)) reasons[f] = "it holds SQL, and no test that connects to the database was seen reaching it (arnx checks names, not what ran)";
        for (const n of report.not_tested ?? []) {
          if (!isObject(n)) continue;
          const f = files.find((x) => x === text(n.file) || x.endsWith(`/${text(n.file)}`));
          if (f && n.reason) reasons[f] = text(n.reason);
        }
        untested.push({ project: cfg.name, files, of, ...(Object.keys(reasons).length ? { reasons } : {}) });
      }
      // A round kept from before an interruption keeps its before/after check too: it is not run again.
      beforeSecs += rnd.before?.secs ?? 0;
      fixProofSecs += rnd.fixProof?.secs ?? 0;
      // Passing tests on the code before the change, by test id (the order they were chosen in).
      const passedById = new Map(rnd.classified.passed.map((t) => [t.testId, t]));
      for (const [testId, fx] of Object.entries(rnd.fixProof?.tests ?? {})) {
        const t = passedById.get(testId);
        fixProof.push({ testId, project: cfg.name, file: t ? ownerFile(t.fileAttr, Object.keys(rnd.files)) : null,
          beforeStatus: fx.status, beforeRuns: fx.runs, beforeDetail: fx.detail,
          ...(fx.asText ? { asText: true as const } : {}) });
      }
      if (rnd.typecheck) typecheck.push(rnd.typecheck);
      if (kept) keptRound.add(cfg.name);
      const c = rnd.classified;
      flaky.push(...c.flaky.map((t) => t.testId));
      errors.push(...c.errors.map((t) => t.testId));
      passed += c.passed.length;
      written += c.findings.length + c.flaky.length + c.errors.length + c.passed.length;
      missingRuns += c.missingRuns;
      const tests = c.findings.length + c.flaky.length + c.errors.length + c.passed.length;
      projectStats.push({ name: cfg.name, tests, passed: c.passed.length, missingRuns: c.missingRuns,
        testFiles: Object.keys(rnd.files).filter((p) => adapterFor(cfg).isTestFile(posix.basename(p))).length,
        ...(rnd.hungFiles?.length ? { hungFiles: rnd.hungFiles } : {}),
        ...(rnd.notRunFiles?.length ? { notRunFiles: rnd.notRunFiles } : {}), sawResults: rnd.sawResults, stop: rnd.agent.stop,
        // A round whose environment could not be had made no model call: it gave no report because it was never asked.
        ...(rnd.env ? { env: { ...rnd.env, log: file.legacy ? rnd.env.log : `projects/${cfg.name}/${rnd.env.log}`,
          ...(atCheckedOut ? {} : { old: true as const }) } } : {}),
        // A round with no report and no test that ran is not a finished one (tests that ran speak for themselves).
        // Failing tests with no report to claim them are unreported as well.
        // A report that claims no test while one fails is no report of that test either.
        ...(!rnd.env && ((tests === 0 && !hasReport([...rnd.agent.earlierTexts ?? [], rnd.agent.finalText])) ||
          (c.findings.length > 0 && reportedTests([...rnd.agent.earlierTexts ?? [], rnd.agent.finalText]) === null)) ? { noReport: true } : {}) });
      agentCost += rnd.agent.costUsd;
      Object.assign(agentUse, addUsage(agentUse, rnd.agent.usage));
      agentUse.calls += rnd.agent.calls;
      agentUse.unknownCalls += rnd.agent.unknownCalls ?? 0;
      agentUse.costUsd = Math.round((agentUse.costUsd + rnd.agent.costUsd) * 1_000_000) / 1_000_000;
      rnd.removed.forEach((p) => notSent.add(p));
      // The second opinion hears what this round's code lacked, as the round did.
      const lacked = (rnd.leftOut ?? []).filter((w) => !change.withheld?.some((x) => x.path === w.path));
      if (lacked.length) diffs[cfg.name] = `${diffs[cfg.name]}\n\n${leftOutNote(lacked)}\n`;
      for (const w of rnd.leftOut ?? []) leftOutFiles.set(w.path, w);
      for (const t of c.errors) if (t.needs) couldNotRun.push({ test: t.testId, needs: t.needs, ...(t.fakedKey ? { faked: true } : {}) });
      rnd.fakedKeys?.forEach((p) => fakedKeys.add(p));
      skippedTests += c.skipped;
      // An environment that could not be had is said per project (stats), not as why the reviewer stopped.
      if (stop === "end_turn" && rnd.agent.stop !== "end_turn" && !rnd.env) stop = rnd.agent.stop;
    }
    findings.forEach((f, i) => { f.id = `F${i + 1}`; });
    for (const f of findings) {
      if (!f.before) continue;
      emit("before.finding", { project: f.project, finding: f.id, test_id: f.testId, status: f.before.status,
        detail: testMessage(f.before.detail), ...(keptRound.has(f.project) ? { resumed: true } : {}) });
    }
    // Findings that fail the same way before the change are not the change's: they are not challenged or grouped.
    const challenged = findings.filter((f) => !isPreExisting(f));
    const left = () => Math.max(0, s.reviewBudgetUsd - agentCost - (huntSecond?.costUsd ?? 0) -
      extraUses.reduce((n, u) => n + u.costUsd, 0));
    // Every second-model attempt and call goes to second-opinion.jsonl, so a slow or failed call can be traced.
    const opinions = join(rdir, "second-opinion.jsonl");
    const trace: Trace = (line) => {
      mkdirSync(rdir, { recursive: true });
      appendFileSync(opinions, JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n");
    };
    // Verdicts given before an interruption are kept, with their cost.
    const verdictsFile = join(rdir, "verdicts.json");
    const verdicts: Record<string, SavedVerdict> = resumed && existsSync(verdictsFile)
      ? JSON.parse(readFileSync(verdictsFile, "utf8")) : {};
    for (const k of Object.keys(verdicts)) if (redone.has(k.split("::")[0]!)) delete verdicts[k];
    const priorUses: ModelUse[] = [];
    let shown = 0;
    const justJudged = new Set<string>(), revealed = new Set<string>();
    // Shown as it is proven: its test failed on every run, not before the change, and the second opinion agrees.
    // A suspect is proven by just this (adjudicate).
    const reveal = (f: Finding) => {
      if (f.verdict !== "confirmed" || f.dependsOn || !justJudged.has(f.id) || revealed.has(f.id)) return;
      revealed.add(f.id);
      shown++;
      o.progress?.(`✓ proven: ${clip(f.explanation || firstLine(f.message), 140)} (${f.id}, failing test ` +
        `${f.file ?? f.testId})`);
    };
    // What each second opinion is sent, saved as sent, so a replay of it is exact.
    const inputs = join(rdir, "second-opinion-input.jsonl");
    const j = await brain.judge(challenged, questions, diffs, { diff: change.diff, sources,
      suspectFile: (f) => suspects.find((x) => x.id === f.suspect && x.project === f.project)?.file,
      evidence: (f) => evidence[f.project]?.[f.testId],
      sent: brain.label ? undefined : (f, input) => {
        const line = { finding: f.id, project: f.project, test_id: f.testId, ...input };
        mkdirSync(rdir, { recursive: true });
        appendFileSync(inputs, JSON.stringify(boundary ? boundary.maskValue(line) : line) + "\n");
      },
      maxQuestions: s.maxQuestions, budgetLeft: left, trace, progress: o.progress, questionProjects,
      // Questions that ask the same thing became one: what referred to them is renumbered.
      merged: (merged, use) => {
        extraUses.push(use);
        if (merged.questions.length >= questions.length) return;
        const projects = merged.questions.map((_q, n) => questionProjects[merged.into.indexOf(n)]!);
        for (const f of findings) {
          const m = f.dependsOn ? /^Q(\d+)$/.exec(f.dependsOn) : null;
          const kept = m ? merged.into[Number(m[1]) - 1] : undefined;
          if (kept !== undefined) f.dependsOn = `Q${kept + 1}`;
        }
        questions.splice(0, questions.length, ...merged.questions);
        questionProjects.splice(0, questionProjects.length, ...projects);
      },
      resumed: () => {
        for (const f of findings) {
          const v = verdicts[`${f.project}::${f.testId}`];
          if (!v) continue;
          [f.verdict, f.reason] = [v.verdict, v.reason];
          if (v.dependsOn) f.dependsOn = v.dependsOn;
          if (v.judge) f.judge = v.judge;
          if (v.sameAs) f.sameAs = v.sameAs;
          emit("challenge.verdict", { project: f.project, finding: f.id, test_id: f.testId,
            hyp_id: f.suspect ? hypId(f.project, f.suspect) : null, outcome: "ok", verdict: v.verdict,
            reason: clip(v.reason), depends_on: v.dependsOn, judge: v.model, cost_usd: v.cost, resumed: true });
          let u = priorUses.find((x) => x.model === v.model);
          if (!u) priorUses.push(u = newUse(v.model));
          if (!v.sameAs) u.calls += 1;
          u.costUsd = Math.round((u.costUsd + v.cost) * 1_000_000) / 1_000_000;
        }
        return new Set(challenged.filter((f) => verdicts[`${f.project}::${f.testId}`]).map((f) => f.id));
      },
      judged: (f, cost) => {
        if (f.verdict === null) return;
        verdicts[`${f.project}::${f.testId}`] = { verdict: f.verdict, reason: f.reason, dependsOn: f.dependsOn ?? null,
          judge: f.judge ?? null, model: label ? `${label}/challenge` : f.judge ?? challengerRef, cost,
          ...f.sameAs ? { sameAs: f.sameAs } : {} };
        writeFileSync(verdictsFile, JSON.stringify(verdicts) + "\n");
        justJudged.add(f.id);
        reveal(f);
      } });
    challenged.forEach(reveal);
    const [groups, judged] = [j.groups, j.uses];
    const second = huntSecond;
    adjudicate(suspects, findings);
    sameCause(suspects, groups, findings);
    // arnx cloud's models fail on its side: only a round's stop says so, and its vendor is never named.
    const failures = label ? [cloudFailure(projectStats.map((p) => p.stop ?? "end_turn"))].filter((f) => f !== null)
      : providerFailures(calls, s);
    const outage = failures.find(resumes);
    for (const x of suspects) {
      emit("suspect.outcome", { project: x.project, hyp_id: hypId(x.project, x.id), outcome: x.outcome, tests: x.tests,
        findings: x.findings, ...x.reason ? { reason: clip(x.reason) } : {} });
    }
    // Uses of the same model (a part hunter that is the reviewer or the challenger) are added up into one line.
    const usage: ModelUse[] = [agentUse];
    for (const u of [second, ...judged, ...extraUses, ...priorUses]) {
      if (!u || !(u.calls || u.unknownCalls)) continue;
      const i = usage.findIndex((x) => x.model === u.model);
      if (i >= 0) usage[i] = mergeUse(usage[i]!, u);
      else usage.push(u);
    }
    // The events hold every call that ended, saved round or not: a round lost to a cut or a kill is still paid for.
    usage.splice(0, usage.length, ...withEventSpend(usage, usageFromEvents(join(rdir, EVENTS_FILE))));
    // Nothing was asked of a model that has no call, no unpriced call and no cost (a review whose environments failed).
    usage.splice(0, usage.length, ...usage.filter((u) => u.calls || u.unknownCalls || u.costUsd));
    // A model arnx has no price for ran with its cost unknown: its entry says so.
    if (!label) {
      const unpriced = new Set(unpricedModels(s, modelRefs(s)).map((m) => m.ref));
      for (const u of usage) if (unpriced.has(u.model)) u.unpriced = true;
    }
    const first = routing.routed[0]!.project;
    const baseEmpty = findings.some((f) => f.before) ? emptyBase(repo, change, routing.routed.flatMap(
      ({ project: cfg, owned }) => changedSources(file.legacy ? change.files : owned, adapterFor(cfg)))) : null;
    const review: Review = {
      id: rid, change: describe(change), filesChanged: change.files.length, added: added(change),
      removed: removed(change), reviewer: reviewerRef, challenger: challengerRef,
      promptVersion: brain.version,
      ...(brain.overrides ? { promptOverrides: brain.overrides.keys, promptsHash: brain.overrides.hash } : {}),
      ...(promptsEdited ? { promptsFileEdited: true as const } : {}),
      ...(acceptedEdited.length ? { acceptedTestsEdited: acceptedEdited } : {}),
      findings, questions: questions.slice(0, s.maxQuestions),
      flaky, errors, passed, testsWritten: written, missingRuns, notSent: [...notSent].sort(),
      ...(change.ignored ? { ignoredChanged: change.ignored } : {}),
      ...(change.lockfiles ? { lockfilesChanged: change.lockfiles } : {}),
      ...(change.blanked ? { blankedLines: change.blanked } : {}),
      ...(leftOutFiles.size ? { leftOutFiles: [...leftOutFiles.values()].sort((a, b) => a.path < b.path ? -1 : 1) } : {}),
      ...(unclaimed.length ? { unclaimed } : {}),
      ...(typesUnchecked ? { typesUnchecked } : {}),
      ...(couldNotRun.length ? { couldNotRun } : {}), ...(fakedKeys.size ? { fakedKeys: [...fakedKeys].sort(), ...(skippedTests ? { skippedTests } : {}) } : {}),
      ...(change.withheld?.length || change.namedOut?.length ? { leftOutTouched: [...change.withheld?.map((w) => w.path) ?? [], ...change.namedOut ?? []].sort() } : {}),
      ...(change.untrackedIncluded ? { untrackedIncluded: change.untrackedIncluded } : {}),
      ...(change.untrackedLeftOut ? { untrackedLeftOut: change.untrackedLeftOut.length } : {}),
      costUsd: Math.round(usage.reduce((a, u) => a + u.costUsd, 0) * 10_000) / 10_000, usage,
      seconds: elapsed(), stop, writeDir: writeDirs[first.name]!,
      language: first.language, projects: routing.routed.map((r) => r.project.name), notReviewed: routing.notReviewed,
      ...(routing.checkOnly.length && !file.legacy ? { typecheckOnly: routing.checkOnly.map((c) => ({
        project: c.project.name, by: c.by })) } : {}),
      uncovered: [...routing.uncovered, ...routing.declared],
      sourceFiles: new Set(change.files.filter(isSourcePath)).size, questionProjects: questionProjects.slice(0, s.maxQuestions), writeDirs,
      projectStats,
      groups, checked, ...(untested.some((u) => u.files.length) ? { untested } : {}),
      ...(suspects.length ? { suspects } : {}),
      ...(s.beforeCheck ? { timings: { beforeCheckSecs: Math.round(beforeSecs * 10) / 10,
        ...(s.fixProofMax > 0 ? { fixProofSecs: Math.round(fixProofSecs * 10) / 10 } : {}) } } : {}),
      ...(fixProof.length ? { fixProof } : {}),
      ...(typecheck.length ? { typecheck } : {}),
      ...(baseEmpty ? { beforeBaseEmpty: baseEmpty } : {}),
      ...(failures.length ? { providerFailures: failures } : {}),
    };
    // Issues are the confirmed rows the summary shows; tests are the "proven" lines above.
    if (suspects.length) {
      o.progress?.(checkedLine(suspects, { tests: shown, issues: summaryRows(review).filter((x) => x.mark === "✗").length,
        down: outage ? `${outage.name} unavailable` : undefined }));
    }
    // The local brain bills nothing (the user's keys pay the providers), so its answer changes nothing here.
    await finish(stop, { stop, projectsReviewed: done.filter((d) => d.rnd.env?.state !== "failed").length, testsWritten: written, passed, findings: findings.length,
      flaky: flaky.length, seconds: review.seconds });
    dockerSteps.log = null;
    dockerSteps.say = null;
    // What a coding agent reads next holds no value a model may not: review.json, review.md, the summary.
    const masked = boundary ? maskedCopy(boundary, review) : { value: review, shown: false };
    const toSave: Review = masked.shown || done.some((d) => d.rnd.standInsShown)
      ? { ...masked.value, standInsShown: true } : masked.value;
    save(toSave, rdir, change.diff);
    logUsage(repo, "review", usage, o.now ?? new Date(), rid);
    const byOutcome: Record<string, number> = {};
    for (const x of suspects) byOutcome[x.outcome] = (byOutcome[x.outcome] ?? 0) + 1;
    emit("report.done", { findings: findings.length, questions: review.questions.length, checked: checked.length,
      untested_files: untested.reduce((n, u) => n + u.files.length, 0), suspects: byOutcome });
    const count = (v: string | null) => findings.filter((f) => f.verdict === v).length;
    emit("review.completed", { rc: exitCode(review), findings: findings.length, confirmed: count("confirmed"),
      disputed: count("disputed"), unchallenged: count(null), questions: review.questions.length,
      tests_written: written, passed, flaky: flaky.length, errors: errors.length, missing_runs: missingRuns,
      cost_usd: review.costUsd, seconds: review.seconds, stop,
      usage: usage.map((u) => Object.fromEntries(Object.entries(u).map(([k, v]) => [snake(k), v]))) });
    return { review: toSave, rdir };
  };
  // Whatever stops the review is recorded, then thrown again unchanged.
  // What was spent is logged however the review ends. An interrupt or an exit does it synchronously, before the process
  // goes (the run's promise never settles then); a failure does it here. Only what is not yet logged goes in.
  const keepBooks = (reason: PartialReason) => logPartial(repo, "review", rid, reason);
  spendClosers.add(keepBooks);
  return withEvents(log, () => withCalls(calls, run).catch(async (e: unknown) => {
    emit("review.failed", { error: clip(e instanceof Error ? e.message : String(e)),
      name: e instanceof Error ? e.name : typeof e });
    keepBooks("failed");
    // Closing is best effort: what stopped the review is what the user is told.
    await finish?.("failed").catch(() => null);
    throw e;
  })).finally(() => { spendClosers.delete(keepBooks); });
}

/** What came of the things a review checked, said once they are judged: proven, waiting on an answer, failing the same
 * way before the change, and the rest dropped (a test that passed, did not run, or the second opinion disputed). */
export function checkedLine(sus: SuspectOutcome[], o: { tests?: number; issues?: number; down?: string } = {}): string {
  const { tests, issues: issueCount, down } = o;
  const n = (...o: SuspectOutcome["outcome"][]) => sus.filter((x) => o.includes(x.outcome)).length;
  const proven = n("proven", "same cause");
  const answer = n("pending answer");
  const before = n("pre-existing");
  const disputed = n("disputed");
  // With a provider down, the suspects that got no test were not tested: that is no verdict on the code.
  const untested = down ? n("not tested") : 0;
  const dropped = sus.length - proven - answer - before - disputed - untested;
  // One thing checked can prove several tests (the "✓ proven" lines) and several tests make one issue: the bracket
  // says so, only when a number differs from the proven count.
  const units = [...tests ? [plural(tests, "test")] : [], ...issueCount !== undefined ? [plural(issueCount, "issue")] : []];
  const differs = (!!tests && tests !== proven) || (issueCount !== undefined && issueCount !== proven);
  const issues = differs ? ` (${units.join(", ")})` : "";
  return [`Checked ${sus.length}: ${proven} proven${issues}`, ...answer ? [`${answer} need${answer === 1 ? "s" : ""} your answer`]
    : [], ...before ? [`${before} failing before this change too`] : [], ...disputed ? [`${disputed} disputed`] : [],
    ...untested ? [`${untested} not tested: ${down}`] : [], ...dropped ? [`${dropped} dropped`] : []].join(", ");
}
