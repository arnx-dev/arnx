// arnx models: the Brain over arnx cloud's v1 API. The CLI keeps every piece of
// evidence it keeps with LocalBrain: it builds what each call sends (the diff slice, the context packs, the changed
// definitions, the project's facts), runs each tool call the brain asks for with its own confined tools exactly as
// LocalBrain's are run, sends the results by id and turn, and the facts after each final. The brain answers with
// decisions only: tool calls, reports, suspects, verdicts. What each answer billed becomes usage lines named by the
// tier and the harness (never a model) and one per role. A review opens with a budget hold (402 there is a top-up,
// exit 3) and is always closed with finish, also when it failed or was interrupted.
import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { adapterFor } from "./adapters";
import { type AgentResult, type ToolCall, toolErrorText } from "./agent";
import type { AnswerInput, Billed, Brain, Facts, Judged, JudgeOptions, ReviewInput, ReviewOpened, ReviewStart,
  RoundHunt, RoundInputs, RoundKind, RoundResult, RoundTools, SetupInput, Totals } from "./brain";
import { type CallOptions, CloudClient, CloudError, usd } from "./cloud";
import type { ReviewConfig } from "./config";
import { changedDefinitions } from "./context";
import type { Detection } from "./detect";
import { ArnxError } from "./errors";
import { clip, emit, emitModelCall, emitTurn, hypId, type Role } from "./events";
import { huntParts } from "./hunt";
import { type ModelUse, newUse, NO_USAGE } from "./llm";
import type { Say } from "./progress";
import type { Suspect } from "./prompts";
import type { Merged } from "./questions";
import { type AgentReport, bySeverity, type Finding, type Group, SEVERITIES } from "./report";
import { isSecretPath } from "./secrets";
import type { Tier } from "./settings";
import { spend } from "./spend";
import { writeDirOf } from "./testround";
import { databaseEnv } from "./untested";
import { VERSION } from "./version";

/** The largest tool output sent when the review's limits do not say. */
export const MAX_TOOL_OUTPUT = 200_000;
/** A round longer than this many steps is cut (the brain's own max_turns ends it well before). */
const MAX_STEPS = 400;
const READ_PATH_TOOLS = new Set(["read_file", "list_dir", "grep"]);
const NO_FACTS: Facts = { untestedFiles: [], dbUntested: [], generatedFiles: [] };

// arnx cloud's answers as the CLI reads them, held to the arnx cloud API's contract.
export interface RoleCost { role: string; calls: number; cost_micro_usd: number }
export interface Bill { cost_micro_usd: number; by_role: RoleCost[] }
export interface WireSuspect { id: string; file: string; line: number; claim: string; by: string; why?: string; input?: string;
  expected?: string; actual?: string }
export interface HuntDetail { lists: { source: string; suspects: WireSuspect[] }[]; tested: string[];
  merged: { source: string; index: number; into: string; duplicate: boolean }[];
  dropped: { source: string; index: number; reason: string }[]; second_late?: WireSuspect[] }
/** One step of a loop, as the brain answers it (review, answer or setup). */
export interface WireStep { type: "actions" | "final" | "done"; turn: number; tier: Tier; harness: string; billed?: Bill;
  actions?: ToolCall[]; text?: string; report?: AgentReport; suspects?: WireSuspect[]; hunt?: HuntDetail;
  summary?: string; notes?: string; reason?: "complete" | "budget"; stop?: string; turns?: number }
export interface WireReview { review_id: string; tier: Tier; harness: string; hold_micro_usd: number; balance_micro_usd: number;
  limits?: { max_tool_output_bytes?: number } }
export interface WireJudge { tier: Tier; harness: string; billed?: Bill;
  questions: { id: string; question: string; merged_from: string[] }[];
  verdicts: { finding: string; verdict: "confirmed" | "disputed" | null; reason: string; depends_on: string;
    fallback?: boolean }[];
  groups: Group[] }
export interface WireFinish { tier: Tier; harness: string; billed_micro_usd: number; by_role: RoleCost[];
  balance_micro_usd: number }
export interface WireAnswerStarted { answer_id: string; step: WireStep }
export interface WireSetupStarted { setup_id: string; step: WireStep }

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const round6 = (x: number) => Math.round(x * 1_000_000) / 1_000_000;
const micro = (dollars: number) => Math.max(0, Math.round(dollars * 1_000_000));
const suspectOf = (s: WireSuspect): Suspect => ({ id: s.id, file: s.file, line: s.line, claim: s.claim, why: s.why ?? "",
  input: s.input ?? "", expected: s.expected ?? "", actual: s.actual ?? "", by: s.by });
/** A suspect as the hunt events show it (as LocalBrain shows it). */
const shown = (x: Suspect) => ({ file: clip(x.file, 500), line: x.line, claim: clip(x.claim, 500), by: x.by });

/** A tool's output cut to what the brain accepts. */
export function clipOutput(s: string, max: number): string {
  if (Buffer.byteLength(s) <= max) return s;
  const note = `\n... (output cut at ${max} bytes)`;
  return Buffer.from(s).subarray(0, Math.max(0, max - Buffer.byteLength(note))).toString("utf8") + note;
}

/** The finish request's stop: how the review ended (the agent's own stop labels, `end_turn` being a complete one). */
export const finishStop = (stop: string): string => (stop === "end_turn" ? "completed" : stop.split(":")[0]!.trim());

/** What the CLI knows about a project from review.yaml and its adapter: names only, no values. */
function projectFacts(cfg: ReviewConfig, envTests: string[], dbNames: string[]) {
  const w = adapterFor(cfg).words(cfg.runner);
  return { language: cfg.language, runner: cfg.runner, workdir: cfg.workdir || ".", tests_dir: cfg.testsDir,
    write_dir: writeDirOf(cfg), words: { language: w.language, runner: w.runner, test_files: w.testFiles,
      writable_files: w.writableFiles, property_lib: w.propertyLib }, notes: cfg.notes, env_names: Object.keys(cfg.env),
    service_names: cfg.services.map((s) => s.name), db_env_names: dbNames, env_test_files: envTests,
    known_failing: cfg.knownFailing };
}

const EMPTY_DETECTION: Detection = { candidates: [], workspaces: [], ci: [], compose: [], services: [], languages: {} };

export interface CloudBrainOptions {
  client: CloudClient;
  tier: Tier;
  /** Lines for the user outside a round (the review opening, the bill at finish). */
  progress?: Say;
}

/** What one loop needs besides its first step. */
interface Drive {
  first: Promise<WireStep>;
  /** The loop's step path. */
  path: string;
  tools: Promise<RoundTools>;
  /** Where transcript.jsonl goes; nothing is written without it. */
  outDir?: string;
  say: (m: string) => void;
  /** The role whose cost is the agent's own (the others go to the round's extras); null: every role. */
  agentRole: string | null;
  /** Each final step, before it is passed on (the hunt's record). */
  onFinal?: (s: WireStep) => void;
  stream: CallOptions;
}

export class CloudBrain implements Brain {
  private tier: Tier;
  private harness: string | null = null;
  private review: { id: string; maxOutput: number } | null = null;
  private closed = false;
  /** The progress lines a project round said already: arnx cloud's lines and the CLI's own say some of the same. */
  private said = new Set<string>();

  constructor(readonly o: CloudBrainOptions) {
    this.tier = o.tier;
  }

  /** The tier and harness this brain answered with ("arnx:medium/h-2026-10-19.1"); never a model name. */
  get label(): string {
    return `arnx:${this.tier}${this.harness ? `/${this.harness}` : ""}`;
  }

  /** What the terminal shows ("arnx:medium"): the tier only; the harness stays internal (review.json, events.jsonl). */
  get shown(): string {
    return `arnx:${this.tier}`;
  }

  get version(): string {
    return this.label;
  }

  private modelOf(role: string): string {
    return `${this.label}/${role}`;
  }

  /** The tier and harness a brain answer names. */
  private named(x: { tier?: Tier; harness?: string }): void {
    if (x.tier) this.tier = x.tier;
    if (x.harness) this.harness = x.harness;
  }

  /** Opens the review (its budget hold); `resume_of` names the review a `--resume` continues. Returns the id arnx
   * cloud gave it (the CLI keeps it in state.json as cloud_review_id). */
  async start(x: ReviewStart): Promise<ReviewOpened> {
    const r = await this.o.client.call<WireReview>("POST", "/v1/reviews", { cli_version: VERSION, effort: this.tier,
      mode: { models: true, tests: false }, change: { files_changed: x.files.filter((p) => !isSecretPath(p)),
        added: x.added, removed: x.removed, diff_sha256: x.diffSha256, projects: x.projects },
      budget_cap_micro_usd: micro(x.budgetUsd), resume_of: x.resumeOf ?? null },
    { idempotencyKey: randomUUID(), component: "brain" });
    this.named(r);
    this.review = { id: r.review_id, maxOutput: r.limits?.max_tool_output_bytes ?? MAX_TOOL_OUTPUT };
    this.o.progress?.(`arnx cloud (${this.shown}): review opened with a hold of ${usd(r.hold_micro_usd)}; ` +
      `${usd(r.balance_micro_usd)} available besides`);
    // arnx cloud holds what the balance allows: below the cap, the review can stop early.
    if (r.hold_micro_usd < micro(x.budgetUsd)) {
      this.o.progress?.(`Your arnx cloud balance caps this review at ${usd(r.hold_micro_usd)} (your cap is ` +
        `${usd(micro(x.budgetUsd))}): it may stop early; \`arnx credits\` tops up`);
    }
    return { reviewId: r.review_id };
  }

  /** A round's progress line, with the project's name in front once (arnx cloud's lines may carry it already), and
   * said once per round. */
  private sayer(project: string, progress?: (m: string) => void): (m: string) => void {
    return (m: string) => {
      const line = m.startsWith(`${project}: `) ? m : `${project}: ${m}`;
      if (this.said.has(line)) return;
      this.said.add(line);
      progress?.(line);
    };
  }

  private reviewId(): string {
    if (!this.review) throw new ArnxError("arnx cloud: the review was not opened (CloudBrain.start was not called)");
    return this.review.id;
  }

  agentRound<K extends RoundKind>(kind: K, input: RoundInputs[K], tools: Promise<RoundTools>): Promise<RoundResult> {
    if (kind === "review") return this.reviewRound(input as ReviewInput, tools);
    if (kind === "answer") return this.answerRound(input as AnswerInput, tools);
    return this.setupRound(input as SetupInput, tools);
  }

  /** One project's round, started once the sandbox has run a test (testRound's probe). The hunt's context packs,
   * the part hunters' inputs and the changed definitions are built here on the snapshot, as LocalBrain's hunters read
   * them (hunt.ts huntParts, changedDefinitions). */
  private async reviewRound(x: ReviewInput, tools: Promise<RoundTools>): Promise<RoundResult> {
    const { cfg, diff, scope } = x;
    const id = this.reviewId();
    this.said.clear();
    const say = this.sayer(cfg.name, x.progress);
    const h = x.hunt;
    const root = h?.root;
    const parts = (h?.parts ?? (root ? huntParts(root, cfg, diff, scope.owned, h!.searchDirs) : []))
      .map((p) => ({ files: p.files, context: p.context, changed_definitions: p.changedDefinitions }));
    const stream: CallOptions = { stream: true, onProgress: (p) => say(p.message) };
    const path = `/v1/reviews/${id}/projects/${encodeURIComponent(cfg.name)}/agent`;
    say(h ? "arnx cloud is looking for defects" : "arnx cloud is writing tests");
    // A start that timed out or failed on the way (a network failure, 503) is sent once more with the same
    // Idempotency-Key: arnx cloud answers it from the round it already started instead of starting another.
    const first = this.o.client.call<WireStep>("POST", path, { diff, context_pack: h?.context ?? "",
      changed_definitions: h?.changedDefinitions ?? (root ? changedDefinitions(root, diff, scope.owned) : ""),
      scope: { owns: cfg.owns, uses: cfg.uses, changed_owned: scope.owned, changed_used: scope.used,
        scoped: x.scoped },
      facts: projectFacts(cfg, x.envTests, x.dbNames), max_questions: x.maxQuestions,
      budget_micro_usd: micro(x.budgetUsd), hunt: !!h, ...(parts.length ? { parts } : {}) },
    { ...stream, idempotencyKey: randomUUID(), retries: 1 });
    first.catch(() => {});
    let suspects: Suspect[] | null = null, recorded = false, lateRecorded = false;
    const onFinal = (s: WireStep) => {
      if (suspects === null) suspects = (s.suspects ?? []).map(suspectOf);
      if (s.hunt && !recorded) {
        recorded = true;
        this.recordHunt(x, s.hunt, suspects);
      }
      if (s.hunt?.second_late && !lateRecorded) {
        lateRecorded = true;
        this.recordLate(x, s.hunt.second_late.map(suspectOf));
      }
    };
    const { agent, uses } = await this.drive({ first, path: `${path}/steps`, tools, outDir: x.outDir, say,
      agentRole: "reviewer", onFinal, stream });
    const extras = [...uses.values()].filter((u) => u.model !== this.modelOf("reviewer"));
    const found = suspects as Suspect[] | null;
    const hunt: RoundHunt | null = x.hunt || extras.length || found?.length
      ? { suspects: found, second: null, extras, late: null } : null;
    return { agent, ...(hunt ? { hunt } : {}) };
  }

  /** hunt.json and the hunt.* events, as LocalBrain writes them, from the hunt's record on the first final. */
  private recordHunt(x: ReviewInput, h: HuntDetail, tested: Suspect[]): void {
    const outDir = x.outDir;
    const project = x.cfg.name;
    const lists = h.lists.map((l) => ({ source: l.source, list: l.suspects.map(suspectOf) }));
    for (const { source, list } of lists) emit("hunt.list", { project, source, suspects: list.map(shown) });
    tested.forEach((s, k) => emit("hunt.suspect", { project, hyp_id: hypId(project, s.id), sid: s.id, rank: k + 1,
      ...shown(s) }));
    for (const { source, list } of lists) {
      list.forEach((_s, index) => {
        const m = h.merged.find((e) => e.source === source && e.index === index);
        if (m) {
          emit("hunt.merged", { project, source, index, into: hypId(project, m.into), duplicate: m.duplicate });
          return;
        }
        const d = h.dropped.find((e) => e.source === source && e.index === index);
        emit("hunt.dropped", { project, source, index, reason: d?.reason ?? "over-limit" });
      });
    }
    const of = (source: string) => lists.find((l) => l.source === source)?.list;
    if (outDir) {
      writeFileSync(join(outDir, "hunt.json"), JSON.stringify({ reviewer: of("reviewer") ?? [],
        parts: lists.filter((l) => /^part-\d+$/.test(l.source)).map((l) => l.list), second: of("second") ?? null,
        tested }, null, 2) + "\n");
    }
    this.sayer(project, x.progress)(`${tested.length} suspect${tested.length === 1 ? "" : "s"} to test`);
  }

  /** The second hunter's list, arrived after the tests started: kept in hunt.json, not tested. */
  private recordLate(x: ReviewInput, late: Suspect[]): void {
    emit("hunt.list", { project: x.cfg.name, source: "second-late", suspects: late.map(shown) });
    if (!x.outDir) return;
    const huntFile = join(x.outDir, "hunt.json");
    if (!existsSync(huntFile)) return;
    const h = JSON.parse(readFileSync(huntFile, "utf8")) as Record<string, unknown>;
    writeFileSync(huntFile, JSON.stringify({ ...h, second_late: late }, null, 2) + "\n");
  }

  private async answerRound(x: AnswerInput, tools: Promise<RoundTools>): Promise<RoundResult> {
    const { cfg } = x;
    const say = this.sayer(cfg.name, x.progress);
    const stream: CallOptions = { stream: true, onProgress: (p) => say(p.message) };
    say("arnx cloud is writing tests");
    const started = this.o.client.call<WireAnswerStarted>("POST", "/v1/answers", {
      cli_version: VERSION, effort: this.tier, project: cfg.name, question: x.question, answer: x.answer, diff: x.diff,
      scope: { owns: cfg.owns, uses: cfg.uses }, facts: projectFacts(cfg, [], databaseEnv(cfg.env, cfg.services)),
      budget_cap_micro_usd: micro(x.budgetUsd) }, { ...stream, idempotencyKey: randomUUID() });
    const first = started.then((r) => r.step);
    first.catch(() => {});
    const loop = await started.catch(() => null);
    if (!loop) await first; // the start's own error
    const { agent } = await this.drive({ first, path: `/v1/answers/${loop!.answer_id}/steps`, tools, outDir: x.outDir,
      say, agentRole: null, stream });
    return { agent };
  }

  private async setupRound(x: SetupInput, tools: Promise<RoundTools>): Promise<RoundResult> {
    const say = (m: string) => x.progress?.(m);
    const stream: CallOptions = { stream: true, onProgress: (p) => say(p.message) };
    const d = x.detection ?? EMPTY_DETECTION;
    const withheld = x.withheldFiles ?? [];
    const started = await this.o.client.call<WireSetupStarted>("POST", "/v1/setup", {
      cli_version: VERSION, effort: this.tier, detection: { candidates: d.candidates.map((c) => ({ root: c.root,
        language: c.language, manifest: c.manifest, runner: c.runner, package_manager: c.packageManager,
        evidence: c.evidence })), workspaces: d.workspaces, ci: d.ci, compose: d.compose, services: d.services,
      languages: d.languages }, tree: x.tree ?? "", existing_yaml: x.current || null,
      withheld: withheld.map((w) => w.path), withheld_files: withheld.map((w) => ({ path: w.path, label: w.label,
        line: w.line })),
      project: x.project ?? null, add: !!x.add, budget_cap_micro_usd: micro(x.budgetUsd) },
    { ...stream, idempotencyKey: randomUUID() });
    const { agent } = await this.drive({ first: Promise.resolve(started.step), path: `/v1/setup/${started.setup_id}/steps`,
      tools, outDir: x.outDir, say, agentRole: null, stream });
    return { agent };
  }

  /** The step loop: run each step's tool calls with the CLI's tools and send their results by id, send the facts
   * after each final, until done. */
  private async drive(d: Drive): Promise<{ agent: AgentResult; uses: Map<string, ModelUse> }> {
    const transcript = d.outDir ? join(d.outDir, "transcript.jsonl") : null;
    if (d.outDir) mkdirSync(d.outDir, { recursive: true });
    const log = (line: Record<string, unknown>) => {
      if (transcript) appendFileSync(transcript, JSON.stringify(line) + "\n");
    };
    const maxOutput = this.review?.maxOutput ?? MAX_TOOL_OUTPUT;
    const uses = new Map<string, ModelUse>();
    const finals: string[] = [];
    let t0 = performance.now();
    let step = await d.first;
    const t = await d.tools;
    let cost = 0, agentCost = 0, agentCalls = 0;
    for (let n = 0; ; n++) {
      this.named(step);
      for (const r of this.bill(step.billed, uses, step.turn, Math.round(performance.now() - t0))) {
        cost += r.usd;
        if (d.agentRole === null || r.role === d.agentRole) [agentCost, agentCalls] = [agentCost + r.usd, agentCalls + r.calls];
      }
      if (step.type === "done" || n >= MAX_STEPS) {
        // arnx cloud's own stop wins over an earlier final: a follow-up the budget cut is a budget stop.
        const ended = step.type === "done" ? step.stop ?? (step.reason === "budget" ? "budget" : undefined) : undefined;
        const stop = ended && ended !== "end_turn" ? ended : finals.length ? "end_turn" : ended ?? "max_turns";
        const turns = step.turns ?? step.turn;
        log({ turn: step.turn, type: "done", reason: step.reason ?? null, stop: step.stop ?? null });
        t.onStep?.({ type: "done", stop, turns });
        return { uses, agent: { finalText: finals.at(-1) ?? "", costUsd: round6(agentCost), turns, stop,
          usage: NO_USAGE, calls: agentCalls, ...(finals.length > 1 ? { earlierTexts: finals.slice(0, -1) } : {}) } };
      }
      if (step.type === "final") {
        const text = step.summary !== undefined ? step.summary + (step.notes ? `\n\n${step.notes}` : "")
          : JSON.stringify(step.report ?? {});
        finals.push(text);
        log({ turn: step.turn, type: "final", cost_usd: round6(cost), text });
        t.onTurn?.(step.turn, [], cost, text);
        emitTurn({ turn: step.turn, stop_reason: "end_turn", tools: [], paths: [], tool_errors: 0, writes: 0,
          test_runs: 0 });
        d.onFinal?.(step);
        t.onStep?.({ type: "final", turn: step.turn, text, ...(step.report ? { report: step.report } : {}),
          ...(step.suspects ? { suspects: step.suspects.map(suspectOf) } : {}) });
        const f = t.facts ? (await t.facts()) ?? NO_FACTS : null;
        t0 = performance.now();
        step = await this.step(d.path, { turn: step.turn, results: [], ...(f ? { facts: { untested_files: f.untestedFiles,
          db_untested: f.dbUntested, generated_files: f.generatedFiles } } : {}), cost_so_far_micro_usd: micro(cost) },
        d.stream, d.say);
        continue;
      }
      const actions = step.actions ?? [];
      const said = step.text ?? "";
      log({ turn: step.turn, type: "actions", cost_usd: round6(cost), text: said,
        tools: actions.map((a) => ({ name: a.name, input: isObject(a.input) ? Object.fromEntries(Object.entries(a.input)
          .map(([k, v]) => [k, clip(typeof v === "string" ? v : JSON.stringify(v), 2000)])) : a.input })) });
      t.onTurn?.(step.turn, [...new Set(actions.map((a) => a.name))], cost, said);
      t.onStep?.({ type: "actions", turn: step.turn, actions, text: said });
      const results: { id: string; output: string; is_error: boolean }[] = [];
      const timed: Record<string, unknown>[] = [];
      for (const a of actions) {
        const started = performance.now();
        let output: string, error = false;
        try {
          // The brain may ask only for what the CLI's tools take; anything else is answered as an error.
          if (!isObject(a.input)) throw new Error("input: an object is required");
          t.onTool?.(a.name, { ...a.input });
          output = (await t.call(a.name, { ...a.input })) || "(empty)";
        } catch (e) {
          // Worded as LocalBrain's loop words it for the model (agent.ts toolErrorText): the brain passes it on as is.
          output = toolErrorText(e);
          error = true;
        }
        results.push({ id: a.id, output: clipOutput(output, maxOutput), is_error: error });
        timed.push({ name: a.name, ms: Math.round(performance.now() - started), bytes: Buffer.byteLength(output),
          ...(error ? { error: true } : {}) });
      }
      log({ turn: step.turn, tools_ran: timed });
      emitTurn({ turn: step.turn, stop_reason: "tool_use", tools: actions.map((a) => a.name),
        paths: actions.filter((a) => READ_PATH_TOOLS.has(a.name)).flatMap((a) => {
          const p = isObject(a.input) ? a.input.path : undefined;
          return typeof p === "string" ? [clip(p, 300)] : p === undefined && a.name === "grep" ? ["."] : [];
        }), tool_errors: timed.filter((x) => x.error).length,
        writes: actions.filter((a) => a.name === "write_file").length,
        test_runs: actions.filter((a) => a.name === "run_tests").length });
      t0 = performance.now();
      step = await this.step(d.path, { turn: step.turn, results, cost_so_far_micro_usd: micro(cost) }, d.stream, d.say);
    }
  }

  /** One step; a turn the brain did not expect (409 turn_conflict) is sent once more as it was. */
  private async step(path: string, body: Record<string, unknown>, c: CallOptions, say: (m: string) => void)
    : Promise<WireStep> {
    try {
      return await this.o.client.call<WireStep>("POST", path, body, c);
    } catch (e) {
      if (!(e instanceof CloudError) || e.body?.code !== "turn_conflict") throw e;
      say(`arnx cloud expected turn ${e.body.expected_turn ?? "?"}, not ${String(body.turn)}; sending it again`);
      return this.o.client.call<WireStep>("POST", path, body, c);
    }
  }

  /** What an answer billed, as usage per role (named by tier and harness) and model.call events; each role's cost. */
  private bill(b: Bill | undefined, uses: Map<string, ModelUse>, turn: number | undefined, latency: number)
    : { role: string; usd: number; calls: number }[] {
    return (b?.by_role ?? []).map((r) => {
      const model = this.modelOf(r.role);
      const u = uses.get(model) ?? newUse(model);
      uses.set(model, u);
      const dollars = r.cost_micro_usd / 1_000_000;
      u.calls += r.calls;
      u.costUsd = round6(u.costUsd + dollars);
      spend.add(dollars);
      emitModelCall({ role: r.role as Role, provider: "arnx", model: this.label, ok: true, input: 0, output: 0,
        cache_read: 0, cache_write: 0, cost_usd: dollars, latency_ms: latency, unknown_usage: 0, timed_out: false,
        ...(turn === undefined ? {} : { turn }) });
      return { role: r.role, usd: dollars, calls: r.calls };
    });
  }

  async judge(findings: Finding[], questions: string[], diffs: Record<string, string>, o: JudgeOptions)
    : Promise<Judged> {
    const id = this.reviewId();
    const skip = o.resumed?.() ?? new Set<string>();
    // Nothing to judge and nothing to merge: no call, nothing billed.
    if (!findings.length && questions.length < 2) return { questions: null, groups: [], uses: [] };
    const qids = questions.map((_q, i) => `Q${i + 1}`);
    const files = [...new Set(findings.map((f) => f.file).filter((p): p is string => !!p && o.sources[p] !== undefined))];
    const body = {
      findings: findings.map((f) => ({ id: f.id, project: f.project, test_id: f.testId,
        test_file: f.file && o.sources[f.file] !== undefined ? f.file : null, failure: f.message,
        explanation: f.explanation, ...(f.suspect ? { suspect: f.suspect } : {}),
        before: f.before && f.before.status !== "pre-existing" ? f.before.status : null,
        // The question the finding's test assumes an answer to (the reviewer linked them), as sent in `questions`.
        depends_on: f.dependsOn && qids.includes(f.dependsOn) ? f.dependsOn : null })),
      ...(skip.size ? { judged: findings.filter((f) => skip.has(f.id)).map((f) => ({ finding_id: f.id,
        verdict: f.verdict === "confirmed" || f.verdict === "disputed" ? f.verdict : null, reason: f.reason,
        depends_on: f.dependsOn && qids.includes(f.dependsOn) ? f.dependsOn : "" })) } : {}),
      test_sources: Object.fromEntries(files.map((p) => [p, o.sources[p]!])),
      questions: questions.map((q, i) => ({ id: qids[i]!, project: o.questionProjects?.[i] ?? findings[0]?.project ??
        "main", question: q })),
      diffs,
      // The whole change (a finding's project diff is in `diffs`).
      diff: o.diff,
    };
    const started = performance.now();
    o.progress?.(`arnx cloud is judging ${findings.length} finding${findings.length === 1 ? "" : "s"}`);
    const r = await this.o.client.call<WireJudge>("POST", `/v1/reviews/${id}/judge`, body,
      { stream: true, onProgress: (p) => o.progress?.(p.message) });
    this.named(r);
    const uses = new Map<string, ModelUse>();
    const billed = this.bill(r.billed, uses, undefined, Math.round(performance.now() - started));
    const total = billed.reduce((n, x) => n + x.usd, 0);
    o.trace({ step: "judge", outcome: "ok", cost_usd: round6(total), verdicts: r.verdicts.length, by: this.label });
    // Merged questions: what each question sent became.
    let merged: Merged | null = null;
    if (questions.length) {
      const into = qids.map((q) => r.questions.findIndex((m) => m.merged_from.includes(q)));
      merged = into.every((k) => k >= 0) ? { questions: r.questions.map((m) => m.question), into }
        : { questions, into: questions.map((_q, i) => i) };
      o.merged?.(merged, uses.get(this.modelOf("merge-questions")) ?? newUse(this.modelOf("merge-questions")));
    }
    const mergedIds = merged === null ? [] : merged.questions.map((_q, i) => `Q${i + 1}`);
    const depOf = (dep: string) => {
      const k = r.questions.findIndex((m) => m.id === dep.trim());
      return k >= 0 && k < mergedIds.length ? mergedIds[k]! : null;
    };
    const judgedNow = r.verdicts.filter((v) => !skip.has(v.finding));
    const each = (billed.find((x) => x.role === "challenge")?.usd ?? 0) / Math.max(1, judgedNow.length);
    for (const f of findings) {
      if (skip.has(f.id)) continue;
      const v = r.verdicts.find((x) => x.finding === f.id);
      if (!v) {
        [f.verdict, f.reason] = [null, "not challenged: arnx cloud gave no verdict"];
        continue;
      }
      const reason = String(v.reason ?? "").trim();
      [f.verdict, f.reason] = v.verdict === "confirmed" || v.verdict === "disputed" ? [v.verdict, reason]
        : [null, reason.startsWith("not challenged") ? reason : `not challenged: ${reason || "no verdict"}`];
      const dep = v.depends_on ? depOf(v.depends_on) : null;
      if (!f.dependsOn && dep) f.dependsOn = dep;
      if (v.fallback) f.judge = `${this.label} (fallback judge)`;
      emit("challenge.verdict", { project: f.project, finding: f.id, test_id: f.testId,
        hyp_id: f.suspect ? hypId(f.project, f.suspect) : null, outcome: f.verdict ? "ok" : "error",
        verdict: f.verdict, reason: clip(f.reason), depends_on: f.dependsOn ?? null, judge: this.label,
        cost_usd: round6(each), timed_out: false });
      o.judged?.(f, round6(each));
    }
    const ids = new Set(findings.map((f) => f.id));
    const groups = (r.groups ?? []).map((g) => ({ findings: g.findings.filter((x) => ids.has(x)), title: g.title,
      input: g.input, actual: g.actual, expected: g.expected, consequence: g.consequence,
      ...(SEVERITIES.includes(g.severity as never) ? { severity: g.severity } : {}) }))
      .sort(bySeverity)
      .filter((g) => g.findings.length);
    return { questions: merged, groups,
      uses: [...uses.values()].filter((u) => u.model !== this.modelOf("merge-questions")) };
  }

  /** Closes the review (completed, failed or interrupted) and settles its hold. A close that cannot reach arnx cloud
   * does not stop the review: the review expires there and its unused hold is released then. */
  async finish(totals: Totals): Promise<Billed | null> {
    if (!this.review || this.closed) return null;
    this.closed = true;
    const id = this.review.id;
    try {
      const r = await this.o.client.call<WireFinish>("POST", `/v1/reviews/${id}/finish`, { stop: finishStop(totals.stop),
        projects_reviewed: totals.projectsReviewed, tests_written: totals.testsWritten, passed: totals.passed,
        findings: totals.findings, flaky: totals.flaky, seconds: Math.max(0, totals.seconds) });
      this.named(r);
      this.o.progress?.(`arnx cloud (${this.shown}) billed ${usd(r.billed_micro_usd)} for this review; ` +
        `${usd(r.balance_micro_usd)} available now`);
      return { costUsd: r.billed_micro_usd / 1_000_000,
        byRole: Object.fromEntries(r.by_role.map((x) => [x.role, x.cost_micro_usd / 1_000_000])) };
    } catch (e) {
      if (e instanceof CloudError && e.body?.code === "review_finished") return null;
      if (!(e instanceof ArnxError)) throw e;
      this.o.progress?.(`could not close the review on arnx cloud (${e.message}); it expires there on its own and ` +
        "its unused hold is released then");
      return null;
    }
  }
}
