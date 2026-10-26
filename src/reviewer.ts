// One review: resolve the change, route it to projects, run a test round on each (the brain drives the agent and the
// hunt), turn tests that fail in every run into findings with the reviewer's explanation, have the brain judge them,
// and write the report.
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { adapterFor } from "./adapters";
import { isPreExisting } from "./before";
import type { Billed, Brain, Totals } from "./brain";
import { inPool } from "./challenge";
import { shallowKind } from "./shallow";
import { clip, emit, EventLog, EVENTS_FILE, hypId, testMessage, withEvents, withRole } from "./events";
import { added, type Change, describe, describeBlanked, EMPTY_TREE, filesAt, removed, resolveChange, sliceDiff,
  someNames, untrackedLine } from "./change";
import { loadReviewFile, type ReviewConfig, reviewConfigPath, secretPinsOf } from "./config";
import { ArnxError, SetupRequired } from "./errors";
import { huntParts } from "./hunt";
import { projectIndex } from "./indexer";
import { closers } from "./interrupt";
import { addUsage, type AgentModel, allPrices, FallbackJson, type JsonModel, type ModelUse, newUse,
  type Trace, unpricedModels } from "./llm";
import { LocalBrain } from "./localbrain";
import { changeEditsPrompts, PROMPTS_EDITED, promptsFor } from "./userprompts";
import { baseName, funcOf, ownerFile } from "./outcomes";
import { type CallRecord, cloudFailure, type ProviderFailure, providerFailures, resumes, withCalls } from "./outage";
import { CONTEXT_LIMIT, contextPack } from "./context";
import type { Suspect } from "./prompts";
import { changedSources, databaseEnv, untestedFiles } from "./untested";
import { type AgentReport, type Checked, type Finding, type FixProof, parseReports, type ProjectStat, type Review,
  save, type SuspectOutcome, type Untested, adjudicate, exitCode, sameCause } from "./report";
import { dockerSteps, type SessionFactory } from "./sandbox";
import type { TypeCheck } from "./typecheck";
import type { Say } from "./progress";
import { route } from "./route";
import { isSecretPath } from "./secrets";
import { cloudModels, modelRefs, refString, type Settings } from "./settings";
import { collect, dockerSession, ownTestsInWriteDir, ownTestsProblem, type Round, testRound, typecheckRound,
  writeDirOf } from "./testround";
import { logUsage } from "./usage";
import { randomHex } from "./util";
import { buildInfo, VERSION } from "./version";

export const AGENT_SHARE = 0.85;

/** Projects tested at once: each runs its own sandbox, so two side by side roughly halve a two-project review. */
export const PROJECT_CONCURRENCY = 2;

interface SavedVerdict { verdict: string; reason: string; dependsOn: string | null; judge: string | null;
  model: string; cost: number }

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

/** The newest review of this same change (same diff) that has no report yet, or whose report a provider outage cut. */
export function resumable(repo: string, diffSha: string): string | null {
  const dir = join(repo, ".arnx", "reviews");
  if (!existsSync(dir)) return null;
  const open = readdirSync(dir).map((d) => join(dir, d)).filter((d) => existsSync(join(d, "state.json")) &&
    (!existsSync(join(d, "review.json")) || cutByOutage(d))).filter((d) => {
    try {
      return (JSON.parse(readFileSync(join(d, "state.json"), "utf8")) as { diff_sha256?: string }).diff_sha256 === diffSha;
    } catch {
      return false;
    }
  });
  return open.sort((a, b) => statSync(join(a, "state.json")).mtimeMs - statSync(join(b, "state.json")).mtimeMs)
    .at(-1) ?? null;
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
    return { ...base, outcome: "not tested" as const, tests: [],
      ...(reasons.get(s.id) ? { reason: reasons.get(s.id)! } : {}) };
  });
}

export function newReviewId(now: Date): string {
  return now.toISOString().slice(0, 10).replaceAll("-", "") + "-" + randomHex(3);
}

const funcOfId = (test: string) => baseName(test.split("::").at(-1) ?? "").trim();
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
    expects: byId.get(t.testId) ?? byFunc.get(funcOf(t)) ?? "" }));
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
    explanation: explanations.get(funcOf(t)) ?? "", verdict: null, reason: "", project: "main",
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
  if (!(cloudModels(s) ? s.cloudConsentAt : s.consentAt)) {
    throw new SetupRequired("sending code to a model has not been agreed to; nothing sent: run `arnx consent`");
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
  // The local brain reads .arnx/prompts.toml from the working tree: a change that edits it is reviewed with its own.
  const promptsEdited = !o.brain && changeEditsPrompts(repo, change);
  if (promptsEdited) o.progress?.(PROMPTS_EDITED);
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
  const resumed = o.resume ? resumable(repo, diffSha) : null;
  if (o.resume && !resumed) throw new ArnxError("nothing to resume: no unfinished review of this change");
  const rid = resumed ? posix.basename(resumed) : newReviewId(o.now ?? new Date());
  const rdir = join(repo, ".arnx", "reviews", rid);
  if (resumed) o.progress?.(`resuming review ${rid}`);
  else {
    mkdirSync(rdir, { recursive: true });
    writeFileSync(join(rdir, "state.json"), JSON.stringify({ change: describe(change), diff_sha256: diffSha,
      ...(change.untrackedIncluded ? { untracked: true } : {}) }) + "\n");
  }
  const log = new EventLog(join(rdir, EVENTS_FILE), rid);
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
    const flaky: string[] = [], errors: string[] = [], notSent = new Set<string>();
    const projectStats: ProjectStat[] = [];
    const checked: Checked[] = [];
    const untested: Untested[] = [];
    const diffs: Record<string, string> = {};
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
    let finished = false;
    const interrupted = async () => { await finish?.("interrupted"); };
    finish = async (end, totals) => {
      if (finished) return null;
      finished = true;
      closers.delete(interrupted);
      return brain.finish(totals ?? { ...soFar, stop: end, seconds: Math.round((performance.now() - started) / 100) / 10 });
    };
    closers.add(interrupted);
    // A remote brain opens the review here (its budget hold; 402 stops before any work, exit 3). Its id there is kept
    // in state.json, so a `--resume` names the review it continues.
    const stateFile = join(rdir, "state.json");
    const state = (): Record<string, unknown> => {
      try {
        return JSON.parse(readFileSync(stateFile, "utf8")) as Record<string, unknown>;
      } catch {
        return {};
      }
    };
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
      diffs[cfg.name] = diff;
      const outDir = file.legacy ? rdir : join(rdir, "projects", cfg.name);
      const scope = file.legacy ? { owned: change.files, used: [] } : { owned, used };
      const projectBudget = s.reviewBudgetUsd * AGENT_SHARE / n;
      const opts = { brain, budgetUsd: projectBudget, writeDir, runs: s.runs, outDir,
        sessionFactory: o.sessionFactory ?? dockerSession, progress: o.progress, coverage: scope.owned,
        untracked: !!change.withUntracked,
        // The code before the change: its base (HEAD for uncommitted work); a first commit has none, nor has a
        // repository with no commits yet. Without one, or for a change to tests or docs only, there is no fix proof.
        ...(s.beforeCheck ? { before: { base: change.base === EMPTY_TREE ? null : change.base,
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
      const roundFile = join(outDir, "round.json");
      let rnd: Round, kept = false, hunted: Suspect[] | null = null, projSecond: ModelUse | null = null;
      const projExtras: ModelUse[] = [];
      const saved = resumed && existsSync(roundFile) ? JSON.parse(readFileSync(roundFile, "utf8")) as { round: Round;
        hunted: Suspect[] | null; second: ModelUse | null; extras: ModelUse[] } : null;
      // A round a failed model call stopped (a provider outage) is tested again; its verdicts are dropped below.
      if (saved?.round.agent.stop.startsWith("api_error")) redone.add(cfg.name);
      if (saved && !redone.has(cfg.name)) {
        kept = true;
        [rnd, hunted, projSecond] = [saved.round, saved.hunted, saved.second];
        projExtras.push(...saved.extras);
        o.progress?.(`${cfg.name} (${i + 1}/${n}): already tested before the interruption; kept`);
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
        writeFileSync(roundFile, JSON.stringify({ round: rnd, hunted, second: projSecond, extras: projExtras }) + "\n");
      }
      const c = rnd.classified;
      soFar.projectsReviewed += 1;
      soFar.testsWritten += c.findings.length + c.flaky.length + c.errors.length + c.passed.length;
      soFar.passed += c.passed.length;
      soFar.findings += c.findings.length;
      soFar.flaky += c.flaky.length;
      return { i, rnd, hunted, second: projSecond, extras: projExtras, resumed: kept };
    };
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
        ...(o.progress ? { progress: o.progress } : {}), untracked: !!change.withUntracked });
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
      const projectFindings = buildFindings(rnd, report).map((f) => {
        const shallow = shallowKind(f.file ? rnd.files[f.file] : undefined, f.func);
        return { ...f, project: cfg.name, ...(shallow ? { shallow } : {}) };
      });
      findings.push(...projectFindings);
      if (h?.length) suspects.push(...suspectOutcomes(cfg.name, h, rnd, report, projectFindings));
      checked.push(...buildChecked(rnd, report, cfg.name));
      for (const q of report.questions) {
        questions.push(isObject(q) && typeof q.question === "string" ? q.question : text(q));
        questionProjects.push(cfg.name);
        if (questions.length > s.maxQuestions) continue;
        // A test the question names, or one written for a suspect it names ("… (S9)"), assumes one answer: it waits
        // on the question rather than asserting what the owner has not decided.
        const linked = new Set(isObject(q) && Array.isArray(q.tests) ? q.tests.map((t) => funcOfId(text(t))) : []);
        const named = new Set(questions.at(-1)!.match(/\bS\d+\b/g) ?? []);
        for (const f of projectFindings) {
          if (!f.dependsOn && (linked.has(f.func) || (f.suspect && named.has(f.suspect)))) {
            f.dependsOn = `Q${questions.length}`;
          }
        }
      }
      Object.assign(sources, rnd.files);
      const ownedNow = file.legacy ? change.files : owned;
      const of = changedSources(ownedNow, adapterFor(cfg)).length;
      if (of) {
        const files = [...new Set([...untestedFiles(ownedNow, rnd.files, adapterFor(cfg)), ...rnd.dbUntested ?? []])];
        const reasons: Record<string, string> = {};
        for (const f of rnd.dbUntested ?? []) reasons[f] = "it holds SQL, and no test that connects to the database refers to it (arnx checks names, not what ran)";
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
        sawResults: rnd.sawResults, stop: rnd.agent.stop });
      agentCost += rnd.agent.costUsd;
      Object.assign(agentUse, addUsage(agentUse, rnd.agent.usage));
      agentUse.calls += rnd.agent.calls;
      agentUse.unknownCalls += rnd.agent.unknownCalls ?? 0;
      agentUse.costUsd = Math.round((agentUse.costUsd + rnd.agent.costUsd) * 1_000_000) / 1_000_000;
      rnd.removed.forEach((p) => notSent.add(p));
      if (stop === "end_turn" && rnd.agent.stop !== "end_turn") stop = rnd.agent.stop;
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
    const log = join(rdir, "second-opinion.jsonl");
    const trace: Trace = (line) => {
      mkdirSync(rdir, { recursive: true });
      appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n");
    };
    // Verdicts given before an interruption are kept, with their cost.
    const verdictsFile = join(rdir, "verdicts.json");
    const verdicts: Record<string, SavedVerdict> = resumed && existsSync(verdictsFile)
      ? JSON.parse(readFileSync(verdictsFile, "utf8")) : {};
    for (const k of Object.keys(verdicts)) if (redone.has(k.split("::")[0]!)) delete verdicts[k];
    const priorUses: ModelUse[] = [];
    const j = await brain.judge(challenged, questions, diffs, { diff: change.diff, sources,
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
          emit("challenge.verdict", { project: f.project, finding: f.id, test_id: f.testId,
            hyp_id: f.suspect ? hypId(f.project, f.suspect) : null, outcome: "ok", verdict: v.verdict,
            reason: clip(v.reason), depends_on: v.dependsOn, judge: v.model, cost_usd: v.cost, resumed: true });
          let u = priorUses.find((x) => x.model === v.model);
          if (!u) priorUses.push(u = newUse(v.model));
          u.calls += 1;
          u.costUsd = Math.round((u.costUsd + v.cost) * 1_000_000) / 1_000_000;
        }
        return new Set(challenged.filter((f) => verdicts[`${f.project}::${f.testId}`]).map((f) => f.id));
      },
      judged: (f, cost) => {
        if (f.verdict === null) return;
        verdicts[`${f.project}::${f.testId}`] = { verdict: f.verdict, reason: f.reason, dependsOn: f.dependsOn ?? null,
          judge: f.judge ?? null, model: label ? `${label}/challenge` : f.judge ?? challengerRef, cost };
        writeFileSync(verdictsFile, JSON.stringify(verdicts) + "\n");
      } });
    const [groups, judged] = [j.groups, j.uses];
    const second = huntSecond;
    adjudicate(suspects, findings);
    sameCause(suspects, groups, findings);
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
    // A model arnx has no price for ran with its cost unknown: its entry says so.
    if (!label) {
      const unpriced = new Set(unpricedModels(s, modelRefs(s)).map((m) => m.ref));
      for (const u of usage) if (unpriced.has(u.model)) u.unpriced = true;
    }
    const first = routing.routed[0]!.project;
    // arnx cloud's models fail on its side: only a round's stop says so, and its vendor is never named.
    const failures = label ? [cloudFailure(projectStats.map((p) => p.stop ?? "end_turn"))].filter((f) => f !== null)
      : providerFailures(calls, s);
    const baseEmpty = findings.some((f) => f.before) ? emptyBase(repo, change, routing.routed.flatMap(
      ({ project: cfg, owned }) => changedSources(file.legacy ? change.files : owned, adapterFor(cfg)))) : null;
    const review: Review = {
      id: rid, change: describe(change), filesChanged: change.files.length, added: added(change),
      removed: removed(change), reviewer: reviewerRef, challenger: challengerRef,
      promptVersion: brain.version,
      ...(brain.overrides ? { promptOverrides: brain.overrides.keys, promptsHash: brain.overrides.hash } : {}),
      ...(promptsEdited ? { promptsFileEdited: true as const } : {}),
      findings, questions: questions.slice(0, s.maxQuestions),
      flaky, errors, passed, testsWritten: written, missingRuns, notSent: [...notSent].sort(),
      ...(change.ignored ? { ignoredChanged: change.ignored } : {}),
      ...(change.lockfiles ? { lockfilesChanged: change.lockfiles } : {}),
      ...(change.blanked ? { blankedLines: change.blanked } : {}),
      ...(change.untrackedIncluded ? { untrackedIncluded: change.untrackedIncluded } : {}),
      ...(change.untrackedLeftOut ? { untrackedLeftOut: change.untrackedLeftOut.length } : {}),
      costUsd: Math.round(usage.reduce((a, u) => a + u.costUsd, 0) * 10_000) / 10_000, usage,
      seconds: Math.round((performance.now() - started) / 100) / 10, stop, writeDir: writeDirs[first.name]!,
      language: first.language, projects: routing.routed.map((r) => r.project.name), notReviewed: routing.notReviewed,
      ...(routing.checkOnly.length && !file.legacy ? { typecheckOnly: routing.checkOnly.map((c) => ({
        project: c.project.name, by: c.by })) } : {}),
      uncovered: routing.uncovered, questionProjects: questionProjects.slice(0, s.maxQuestions), writeDirs,
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
    // The local brain bills nothing (the user's keys pay the providers), so its answer changes nothing here.
    await finish(stop, { stop, projectsReviewed: done.length, testsWritten: written, passed, findings: findings.length,
      flaky: flaky.length, seconds: review.seconds });
    dockerSteps.log = null;
    dockerSteps.say = null;
    save(review, rdir, change.diff);
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
    return { review, rdir };
  };
  // Whatever stops the review is recorded, then thrown again unchanged.
  return withEvents(log, () => withCalls(calls, run).catch(async (e: unknown) => {
    emit("review.failed", { error: clip(e instanceof Error ? e.message : String(e)),
      name: e instanceof Error ? e.name : typeof e });
    // Closing is best effort: what stopped the review is what the user is told.
    await finish?.("failed").catch(() => null);
    throw e;
  }));
}
