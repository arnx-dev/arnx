// The open harness behind the Brain interface, used with the user's own keys: the prompts in prompts.ts and the
// models config.toml names. It runs the agent loop (agent.ts) over the tools the CLI hands it, decides and words the
// follow-ups from the facts the CLI computes after each final reply, runs the hunt (the reviewer's own, the second
// hunter, the part hunters, the ranking) and judges findings (questions merged, second opinions, grouping).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { adapterFor } from "./adapters";
import { runAgent, type ToolCall, ToolError } from "./agent";
import { Boundary, boundaryOf, maskedAgent, maskedJson } from "./boundary";
import type { AnswerInput, Billed, Brain, Facts, HuntRecord, Judged, JudgeOptions, ReviewInput, RoundHunt,
  RoundInputs, RoundKind, RoundResult, RoundTools, SetupInput, Totals } from "./brain";
import { challenge, STALLED } from "./challenge";
import { clip, emit, hypId } from "./events";
import { explain } from "./explain";
import { partHunts, parseSuspects, rankSuspects, sameSuspect, secondHunt } from "./hunt";
import { type AgentModel, FallbackJson, type JsonModel, type ModelUse, newUse, parseJsonObject } from "./llm";
import { DEFAULT_PROMPTS, isModelKey, PROMPT_VERSION, type Prompts, scopeTold, type Suspect } from "./prompts";
import { mergeQuestions } from "./questions";
import { isPreExisting } from "./before";
import { JUDGE_PROMPT, type JudgeVariant } from "./judgeprompt";
import { standInsText } from "./standins";
import { type Finding, parseReport, parseReports, questionTexts } from "./report";
import type { Prices } from "./settings";
import { filesToAsk } from "./untested";

/** How long the tests wait for the second hunter after the reviewer's own hunt has replied. */
export const SECOND_HUNT_WAIT_MS = 90_000;
const TIMED_OUT = Symbol("timed out");

/** How long a hunter that missed its wait gets on top of it: a loop that was blocked sees its timer fire before the
 * replies and polls that arrived meanwhile (one poll is `POLL_SECONDS`, 3 s). */
export const SECOND_HUNT_GRACE_MS = 5_000;
/** How long the end of a round waits for a second hunter still out after the tests; then its request is cancelled and
 * its use counts as one unknown call. */
export const LATE_HUNT_WAIT_MS = 45_000;
/** At most this many suspects of a hunter that arrives after the tests started join them. */
const LATE_SUSPECTS = 3;

/** The promise's value, or TIMED_OUT when it takes longer than `ms` plus `graceMs` (the promise itself keeps
 * running). When the timer fires, the promise gets one more grace period before it counts as late. */
function within<T>(p: Promise<T>, ms: number, graceMs = SECOND_HUNT_GRACE_MS): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined, grace: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<typeof TIMED_OUT>((r) => {
    timer = setTimeout(() => {
      grace = setTimeout(() => r(TIMED_OUT), graceMs);
    }, ms);
  })]).finally(() => {
    clearTimeout(timer);
    clearTimeout(grace);
  });
}

/** A suspect as the hunt events show it. */
const shown = (x: Suspect) => ({ file: clip(x.file, 500), line: x.line, claim: clip(x.claim, 500), by: x.by });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
/** The coverage follow-up: files with at least `minLines` added code lines, at most `max` of them, while the round
 * has spent at most this share of its budget, and for at most this many dollars. */
const NUDGE_FILES = { minLines: 20, max: 3 };
const NUDGE_SHARE = 0.5;
const NUDGE_USD = 0.1;
const NO_FACTS: Facts = { untestedFiles: [], dbUntested: [], generatedFiles: [] };
const CLOSED = "not yet: first reply with the suspects as JSON; then you can write and run tests";
/** The tools closed while the hunt is open. */
const CLOSED_TOOLS = new Set(["write_file", "run_tests"]);
/** A round's transcript file, when it has an outDir. */
const transcriptOf = (x: { outDir?: string }) => (x.outDir ? join(x.outDir, "transcript.jsonl") : undefined);

export interface LocalModels {
  /** The reviewer: every agent round. */
  agentModel: AgentModel;
  prices: Prices;
  /** The second opinion and the grouping (needed to judge). */
  challenger?: JsonModel;
  /** Hunts each part of a big change (tool-less); also merges questions. */
  hunter?: JsonModel;
  /** Ranks the merged suspects by harm before the cut; merges questions when there is no hunter. */
  ranker?: JsonModel;
  /** The tool-less hunter from another vendor. */
  secondHunter?: JsonModel | null;
  /** How long the tests wait for the second hunter (default SECOND_HUNT_WAIT_MS). */
  secondHuntWaitMs?: number;
  /** The grace period after that wait (default SECOND_HUNT_GRACE_MS). */
  secondHuntGraceMs?: number;
  /** How long the end of a round waits for a hunter still out (default LATE_HUNT_WAIT_MS). */
  lateHuntWaitMs?: number;
  /** The prompts (default: arnx's own; with the user's keys, the repository's overrides: userprompts.ts). */
  prompts?: Prompts;
  /** What is kept from every model (default: the reviewer's own boundary, when it has one). */
  boundary?: Boundary;
  /** The second opinion's prompt variant (default JUDGE_PROMPT). */
  judge?: JudgeVariant;
}

/** The hunt of one review round: started once the sandbox has run a test, finished when the reviewer replies to it. */
interface Hunt {
  user: string;
  afterHunt: (reply: string) => Promise<{ message: string | null; spent: number }>;
  /** Asked once when the tests reply: a message about suspects left without a test, or null. */
  afterTests: (reply: string) => string | null;
  state: RoundHunt;
}

export class LocalBrain implements Brain {
  readonly version = PROMPT_VERSION;
  readonly reusesHunt = true;
  readonly overrides?: { keys: string[]; hash: string };
  private readonly p: Prompts;
  readonly m: LocalModels;
  readonly boundary: Boundary;
  /** The structured reply says where a failure is from: a failure with the same message before the change is sent. */
  readonly judgesOrigin: boolean;

  constructor(m: LocalModels) {
    // Whoever made them, every model here goes through the one filter: one boundary, filled as the run finds its values.
    const b = this.boundary = m.boundary ?? (m.agentModel && boundaryOf(m.agentModel)) ?? new Boundary();
    const json = <T extends JsonModel | null | undefined>(x: T) => (x ? maskedJson(x, b) : x);
    this.m = { ...m, agentModel: m.agentModel && maskedAgent(m.agentModel, b), challenger: json(m.challenger),
      hunter: json(m.hunter), ranker: json(m.ranker), secondHunter: json(m.secondHunter) };
    this.p = m.prompts ?? DEFAULT_PROMPTS;
    this.judgesOrigin = (m.judge ?? JUDGE_PROMPT) === "new";
    const keys = this.p.overridden.filter(isModelKey); // the fix prompt's keys are no model's
    if (keys.length) this.overrides = { keys, hash: this.p.hash };
  }

  agentRound<K extends RoundKind>(kind: K, input: RoundInputs[K], tools: Promise<RoundTools>): Promise<RoundResult> {
    if (kind === "review") return this.review(input as ReviewInput, tools);
    if (kind === "answer") return this.answer(input as AnswerInput, tools);
    return this.setup(input as SetupInput, tools);
  }

  /** A review round: the hunt first when asked for (writing and running closed until the reviewer replies with its
   * suspects), then the tests; after each final reply, suspects left without a test and changed files no test
   * names are asked about once each. */
  private async review(x: ReviewInput, tools: Promise<RoundTools>): Promise<RoundResult> {
    const { cfg } = x;
    const say = (m: string) => x.progress?.(`${cfg.name}: ${m}`);
    // The tool-less hunters start now, beside the reviewer's own hunt.
    const hunt = x.prior ? this.prior(x, x.prior) : x.hunt ? this.hunt(x, x.hunt) : null;
    const t = await tools;
    let hunting = hunt !== null && !x.prior;
    say(hunting ? "looking for defects" : "writing tests");
    let asked = false;
    const decide = async (reply: string, turn: number): Promise<string | null> => {
      if (hunting && hunt) {
        hunting = false;
        const next = await hunt.afterHunt(reply);
        opts.budgetUsd = Math.max(0, opts.budgetUsd - next.spent);
        // No suspect: nothing to prove, so the round ends here and spends nothing more.
        if (next.message === null) {
          say("nothing suspected; no tests written");
          return null;
        }
        say("writing tests");
        return next.message;
      }
      t.onStep?.({ type: "final", turn, text: reply, report: parseReports([reply]),
        suspects: hunt?.state.suspects ?? [], ...huntOf() });
      const facts = (await t.facts?.()) ?? NO_FACTS;
      if (hunt) {
        const m = hunt.afterTests(reply);
        if (m) return m;
      }
      if (asked) return null;
      asked = true;
      const { dbUntested: db } = facts;
      // The nudge is limited: a few large files, and only while the round has spent at most half its budget.
      const spentAll = x.budgetUsd - opts.budgetUsd + opts.spent();
      const missing = spentAll <= x.budgetUsd * NUDGE_SHARE
        ? filesToAsk(facts.untestedFiles, x.diff, adapterFor(cfg), NUDGE_FILES) : [];
      if (!missing.length && !db.length) return null;
      // Its own spend limit: a follow-up cut short at it keeps the report the round ended on.
      opts.budgetUsd = Math.min(opts.budgetUsd, opts.spent() + NUDGE_USD);
      if (missing.length) {
        say(`no test yet for ${missing.map((m) => posix.basename(m)).join(", ")}; asking for one`);
      }
      if (db.length) {
        say(`no database test yet for ${db.map((m) => posix.basename(m)).join(", ")}; asking for one`);
      }
      return this.p.coverageTask(missing, { files: db, names: x.dbNames });
    };
    // The hunt's record on each final, for a caller without hunt.json.
    const huntOf = () => (hunt?.state.record ? { hunt: hunt.state.record } : {});
    const ws = { tools: () => t.tools(), call: async (name: string, args: Record<string, unknown>) => {
      // The hunt reads before it writes.
      if (hunting && CLOSED_TOOLS.has(name)) throw new ToolError(CLOSED);
      return t.call(name, args);
    } };
    // The steps list only the calls that reach the CLI: a write or a run while the hunt is open is refused here.
    const reaching = (calls: ToolCall[]) => (hunting ? calls.filter((c) => !CLOSED_TOOLS.has(c.name)) : calls);
    const opts = this.loop(t, x, this.p.reviewSystem(cfg, x.envTests),
      hunt?.user ?? this.p.reviewTask(cfg, x.diff, x.maxQuestions, scopeTold(x.scoped, x.scope)), decide, reaching);
    const agent = await runAgent(this.m.agentModel, ws, opts);
    // A report that reached the budget is asked nothing more, but it is still the round's final (a hunt reply is not).
    const end = opts.unasked();
    if (end && !hunting) {
      t.onStep?.({ type: "final", turn: end.turn, text: end.text, report: parseReports([end.text]),
        suspects: hunt?.state.suspects ?? [], ...huntOf() });
    }
    t.onStep?.({ type: "done", stop: agent.stop, turns: agent.turns });
    return { agent, ...(hunt ? { hunt: hunt.state } : {}) };
  }

  /** An answered question: one round of tests, no follow-ups. */
  private async answer(x: AnswerInput, tools: Promise<RoundTools>): Promise<RoundResult> {
    const t = await tools;
    x.progress?.(`${x.cfg.name}: the reviewer is writing tests`);
    const opts = this.loop(t, x, this.p.reviewSystem(x.cfg), this.p.answerTask(x.cfg, x.question, x.answer, x.diff),
      async (reply, turn) => {
        t.onStep?.({ type: "final", turn, text: reply, report: parseReports([reply]) });
        return null;
      });
    const agent = await runAgent(this.m.agentModel, t, opts);
    const end = opts.unasked();
    if (end) t.onStep?.({ type: "final", turn: end.turn, text: end.text, report: parseReports([end.text]) });
    t.onStep?.({ type: "done", stop: agent.stop, turns: agent.turns });
    return { agent };
  }

  /** The setup agent: it proves projects with try_project and submits the file with propose. */
  private async setup(x: SetupInput, tools: Promise<RoundTools>): Promise<RoundResult> {
    const t = await tools;
    let user = this.p.setupTask(x.hints, x.draft ?? "");
    if (x.withheld) {
      user += `\n\nThese files are left out of the copy you see and of the sandbox, because they hold text that looks ` +
        `like a key: ${x.withheld}. Code that needs them cannot build or run here; do not recreate ` +
        "them. If a suite cannot run without them, say so in your summary: only the user can allow them.";
    }
    if (x.standIns?.length) user += `\n\n${standInsText(x.standIns)}`;
    if (x.project) {
      user += `\n\nRe-prove only the project \`${x.project}\`. The current review.yaml is below; keep every other ` +
        `project exactly as it is.\n<review.yaml>\n${x.current}</review.yaml>`;
    } else if (x.add) {
      user += "\n\nThe current review.yaml is below. Cover what is listed under uncovered where a project can test it; " +
        "keep every existing project exactly as it is. Try every entry under uncovered again, whatever its reason " +
        "says: the user may have fixed the cause since setup wrote it, so the reason may be stale. Remove an entry " +
        "once a project owns or uses its files, and update the reason of one that still cannot be tested. Browser tests " +
        "are the exception: arnx never sets them up." +
        `\n<review.yaml>\n${x.current}</review.yaml>`;
    }
    let last = 0, unasked: { text: string; turn: number } | null = null;
    const agent = await runAgent(this.m.agentModel, t, { system: this.p.setupSystem(), user, budgetUsd: x.budgetUsd,
      prices: this.m.prices, transcript: transcriptOf(x), ...(x.deadline ? { deadline: x.deadline } : {}),
      onTurn: (turn, names, cost, said, calls) => {
        last = turn;
        t.onTurn?.(turn, names, cost, said);
        if (calls.length) t.onStep?.({ type: "actions", turn, actions: calls, text: said });
      },
      onTool: (name, input) => t.onTool?.(name, input),
      onFinal: (reply, turn) => { unasked = { text: reply, turn }; },
      followUp: (reply) => {
        unasked = null;
        t.onStep?.({ type: "final", turn: last, text: reply });
        return null;
      } });
    // A closing reply that reached the budget is still the round's final.
    const end = unasked as { text: string; turn: number } | null;
    if (end) t.onStep?.({ type: "final", turn: end.turn, text: end.text });
    t.onStep?.({ type: "done", stop: agent.stop, turns: agent.turns });
    return { agent };
  }

  /** The agent loop's options for a review or an answer: each follow-up asks for the JSON again and says which
   * questions were asked, so they are not asked again. `unasked`: the reply the round ended on when the budget left
   * no follow-up to ask (null when every reply was asked about). */
  private loop(t: RoundTools, x: ReviewInput | AnswerInput, system: string, user: string,
               decide: (reply: string, turn: number) => Promise<string | null>,
               reaching: (calls: ToolCall[]) => ToolCall[] = (calls) => calls) {
    const replies: string[] = [];
    let last = 0, spent = 0, unasked: { text: string; turn: number } | null = null;
    // Tests written since the last report: the budget running out asks for one more report (review.last_word).
    let wrote = false;
    return { system, user, budgetUsd: x.budgetUsd, prices: this.m.prices, transcript: transcriptOf(x),
      unasked: () => unasked,
      /** What this conversation's replies have cost so far (the agent's own count, as `budgetUsd` is compared with). */
      spent: () => spent,
      // A follow-up cut short leaves a finished round only when the reply before it is a report, not the hunt's.
      isReport: (reply: string) => parseReport(reply).tests.length > 0,
      onFinal: (reply: string, turn: number) => {
        unasked = { text: reply, turn };
        wrote = false;
      },
      lastWord: () => (wrote ? this.p.lastWordTask() : null),
      followUp: async (reply: string) => {
        unasked = null;
        replies.push(reply);
        const next = await decide(reply, last);
        return next === null ? null : next + this.p.askedTask(questionTexts(replies));
      },
      onTurn: (turn: number, names: string[], cost: number, said: string, calls: ToolCall[]) => {
        last = turn;
        spent = cost;
        t.onTurn?.(turn, names, cost, said);
        const sent = reaching(calls);
        if (sent.some((c) => c.name === "write_file")) wrote = true;
        if (sent.length) t.onStep?.({ type: "actions", turn, actions: sent, text: said });
      } };
  }

  /** The hunt is the first phase of the reviewer's conversation, on the snapshot the tests run on. The second hunter
   * and the part hunters run meanwhile; their suspects join the reviewer's before any test is written. */
  private hunt(x: ReviewInput, h: NonNullable<ReviewInput["hunt"]>): Hunt {
    const { cfg, diff, scope } = x;
    const m = this.m;
    const state: RoundHunt = { suspects: null, second: null, extras: [], late: null };
    // What the tool-less hunters read: given (a brain without the snapshot), or read from the snapshot.
    const root = h.root ?? null;
    const prompts = this.p;
    const cancel = new AbortController();
    const other = m.secondHunter ? secondHunt(root, cfg, { model: m.secondHunter, diff, context: h.context, scope,
      outDir: x.outDir, progress: x.progress, prompts, signal: cancel.signal,
      ...(h.changedDefinitions === undefined ? {} : { changedDefinitions: h.changedDefinitions }) }) : null;
    const parts = m.hunter ? partHunts(root, cfg, { model: m.hunter, diff, owned: scope.owned,
      searchDirs: h.searchDirs, scope, outDir: x.outDir, progress: x.progress, prompts,
      ...(h.parts ? { parts: h.parts } : {}) })
      : null;
    // They may fail (a key with no credits) before the reviewer's hunt reply awaits them: that await sees it, so the
    // command ends with the error's own line, never as an unhandled rejection.
    other?.catch(() => {});
    parts?.catch(() => {});
    let arrived: { suspects: Suspect[]; use: ModelUse } | null = null;
    const folded = { done: false };
    /** The second hunter's suspects that came after the hunt but before the first report: new ones, at most
     * LATE_SUSPECTS, numbered after the others. */
    const fold = (): Suspect[] => {
      if (!arrived || folded.done || !state.suspects) return [];
      folded.done = true;
      const have = state.suspects;
      const fresh = arrived.suspects.filter((s) => !have.some((o) => sameSuspect(o, s))).slice(0, LATE_SUSPECTS)
        .map((s, k) => ({ ...s, id: `S${have.length + k + 1}` }));
      if (!fresh.length) return [];
      state.suspects = [...have, ...fresh];
      fresh.forEach((s, k) => emit("hunt.suspect", { project: cfg.name, hyp_id: hypId(cfg.name, s.id), sid: s.id,
        rank: have.length + k + 1, ...shown(s) }));
      if (state.record) state.record.tested = state.suspects;
      return fresh;
    };
    let stage = 0;
    const afterHunt = async (reply: string) => {
      const data = parseJsonObject(reply);
      const mine = parseSuspects(data, m.agentModel.model);
      // The second hunter gets SECOND_HUNT_WAIT after the reviewer's own hunt; if it is still out (a slow model, a
      // dropped connection) the tests start without it, and its cost is counted when it returns.
      const [early, split] = await Promise.all([other ? within(other, m.secondHuntWaitMs ?? SECOND_HUNT_WAIT_MS,
        m.secondHuntGraceMs) : null, parts]);
      const theirs = early === TIMED_OUT ? null : early;
      if (early === TIMED_OUT) {
        // Its suspects join the tests when they arrive before the reviewer's first report (see `fold`).
        other!.then((r) => { arrived = r; }, () => {});
        state.late = () => this.lateSecond(x, other!, state, folded, cancel, m.secondHunter!.ref);
        x.progress?.(`${cfg.name}: the second hunter is still out; testing without it`);
      }
      if (theirs) state.second = theirs.use;
      if (split) state.extras.push(split.use);
      const lists = [mine, ...split?.lists ?? [], theirs?.suspects ?? []];
      const rankUse = newUse(m.ranker?.ref ?? "");
      const hunted = await rankSuspects(lists, { model: m.ranker ?? null, use: rankUse, prompts,
        progress: (msg) => x.progress?.(`${cfg.name}: ${msg}`) });
      state.suspects = hunted;
      const named = [{ source: "reviewer", list: mine },
        ...(split?.lists ?? []).map((list, k) => ({ source: `part-${k + 1}`, list })),
        ...theirs ? [{ source: "second", list: theirs.suspects }] : []];
      for (const { source, list } of named) {
        emit("hunt.list", { project: cfg.name, source, suspects: list.map(shown) });
      }
      hunted.forEach((s, k) => emit("hunt.suspect", { project: cfg.name, hyp_id: hypId(cfg.name, s.id),
        sid: s.id, rank: k + 1, ...shown(s) }));
      const seen = new Set<string>();
      for (const { source, list } of named) {
        list.forEach((s, index) => {
          const into = hunted.find((h) => sameSuspect(h, s));
          if (!into) {
            emit("hunt.dropped", { project: cfg.name, source, index, reason: "over-limit" });
            return;
          }
          emit("hunt.merged", { project: cfg.name, source, index, into: hypId(cfg.name, into.id),
            duplicate: seen.has(into.id) });
          seen.add(into.id);
        });
      }
      if (rankUse.calls || rankUse.unknownCalls) state.extras.push(rankUse);
      // Every hunter's whole list, so what was found can be told apart from what was tested.
      const record: HuntRecord = { reviewer: mine, parts: split?.lists ?? [], second: theirs?.suspects ?? null,
        tested: hunted };
      state.record = record;
      if (x.outDir) writeFileSync(join(x.outDir, "hunt.json"), JSON.stringify(record, null, 2) + "\n");
      // Nothing suspected is a hunt that answered with an empty list and had no hunter fail or run out of time; a hunt
      // that failed somewhere goes on to the tests as before.
      const clean = Array.isArray(data?.suspects) && early !== TIMED_OUT && !theirs?.failed && !split?.failed;
      if (!hunted.length && clean) state.ended = true;
      if (hunted.length || !clean) {
        x.progress?.(`${cfg.name}: checking ${hunted.length} thing${hunted.length === 1 ? "" : "s"} in this change`);
      }
      return { message: hunted.length || !clean ? prompts.proveTask(cfg, hunted, x.maxQuestions) : null,
        spent: (theirs?.use.costUsd ?? 0) + (split?.use.costUsd ?? 0) + rankUse.costUsd };
    };
    // After the first report: the suspects that came late are asked for, then the ones left without a test.
    const afterTests = (reply: string): string | null => {
      if (stage === 0) {
        stage = 1;
        const fresh = fold();
        if (fresh.length) {
          x.progress?.(`${cfg.name}: the second hunter answered; checking ${fresh.length} more`);
          return prompts.proveTask(cfg, fresh, x.maxQuestions);
        }
      }
      if (stage === 1) {
        stage = 2;
        return this.untestedAsk(x, state.suspects ?? [], reply);
      }
      return null;
    };
    return { user: prompts.huntTask(cfg, diff, h.context, scopeTold(x.scoped, scope)), afterHunt, afterTests, state };
  }

  /** A resumed round: the hunt is over, its suspects are given with the task, and the tests are asked for at once. */
  private prior(x: ReviewInput, p: NonNullable<ReviewInput["prior"]>): Hunt {
    const state: RoundHunt = { suspects: p.suspects, second: null, extras: [], late: null, record: p.record };
    return { user: `${this.p.reviewTask(x.cfg, x.diff, x.maxQuestions, scopeTold(x.scoped, x.scope))}\n\n` +
      this.p.proveTask(x.cfg, p.suspects, x.maxQuestions),
    afterHunt: () => Promise.reject(new Error("a resumed round has no hunt")),
    afterTests: ((done = false) => (reply: string) => done ? null : (done = true, this.untestedAsk(x, p.suspects, reply)))(),
    state };
  }

  /** The message about suspects the reply left without a test or a reason, or null when none is left. */
  private untestedAsk(x: ReviewInput, suspects: Suspect[], reply: string): string | null {
    const r = parseReports([reply]);
    const tested = new Set(r.tests.filter(isObject).map((t) => text(t.suspect ?? "").trim()).filter(Boolean));
    const reasons = new Map((r.suspects_not_tested ?? []).filter(isObject)
      .map((n) => [text(n.suspect ?? "").trim(), text(n.reason ?? "")] as const));
    const left = suspects.filter((s) => !tested.has(s.id))
      .map((s) => ({ id: s.id, ...(reasons.get(s.id) ? { reason: reasons.get(s.id)! } : {}) }));
    if (!left.length) return null;
    x.progress?.(`${x.cfg.name}: ${left.length} suspect${left.length === 1 ? "" : "s"} without a test; ` +
      "asking the reviewer to test them or say why they cannot run here");
    return this.p.untestedSuspectsTask(left);
  }

  /** The second hunter, back after the round: its cost counts. Its suspects that were not folded into the tests
   * (arrived after the first report, repeats aside) are named as too late to test, and kept in hunt.json. */
  private async lateSecond(x: ReviewInput, late: Promise<{ suspects: Suspect[]; use: ModelUse }>,
    state: RoundHunt, folded: { done: boolean }, cancel: AbortController, ref: string): Promise<ModelUse> {
    const r = await within(late, this.m.lateHuntWaitMs ?? LATE_HUNT_WAIT_MS, 0);
    if (r === TIMED_OUT) {
      // Still out: its request is cancelled, nothing of it is named, and its cost is unknown (a call that ended in
      // time is in the events, which count it).
      cancel.abort();
      x.progress?.(`${x.cfg.name}: the second hunter never answered; its call was cancelled`);
      state.lateLeft = [];
      return { ...newUse(ref), unknownCalls: 1 };
    }
    emit("hunt.list", { project: x.cfg.name, source: "second-late", suspects: r.suspects.map(shown) });
    const have = state.suspects ?? [];
    state.lateLeft = r.suspects.filter((s) => !have.some((o) => sameSuspect(o, s)))
      .map((s, k) => ({ ...s, id: `S${have.length + k + 1}` }));
    if (state.record) state.record.second_late = r.suspects;
    if (!x.outDir) return r.use;
    const huntFile = join(x.outDir, "hunt.json");
    if (existsSync(huntFile)) {
      const h = JSON.parse(readFileSync(huntFile, "utf8")) as Record<string, unknown>;
      writeFileSync(huntFile, JSON.stringify({ ...h, ...folded.done ? { tested: state.suspects } : {},
        second_late: r.suspects }, null, 2) + "\n");
    }
    return r.use;
  }

  async judge(findings: Finding[], questions: string[], diffs: Record<string, string>, o: JudgeOptions)
    : Promise<Judged> {
    const challenger = this.m.challenger;
    if (!challenger) throw new Error("LocalBrain: judging needs a challenger");
    // Questions that ask the same thing become one, before the second opinion links findings to them by id.
    const merger = this.m.hunter ?? this.m.ranker ?? null;
    let merged: Judged["questions"] = null;
    if (questions.length > 1 && merger && o.budgetLeft() > 0) {
      const use = newUse(merger.ref);
      merged = await mergeQuestions(questions, { model: merger, use, progress: o.progress, prompts: this.p });
      if (merged.questions.length < questions.length) {
        o.progress?.(`${questions.length - merged.questions.length} repeated question` +
          `${questions.length - merged.questions.length === 1 ? "" : "s"} merged`);
      }
      o.merged?.(merged, use);
    }
    const asked = (merged?.questions ?? questions).slice(0, o.maxQuestions);
    const remaining = o.budgetLeft();
    challenger.trace = (line) => o.trace({ step: "attempt", ...line });
    const skip = o.resumed?.() ?? new Set<string>();
    const timedOut = new Set<string>();
    const spent = findings.length ? await challenge(findings, { model: challenger, diff: o.diff, timedOut,
      diffOf: (f) => diffs[f.project] ?? o.diff, suspectFile: o.suspectFile,
      ...(o.evidence ? { evidence: o.evidence } : {}), ...(o.sent ? { sent: o.sent } : {}), sources: o.sources, budgetUsd: remaining, questions: asked,
      trace: o.trace, progress: o.progress, skip, onJudged: (f, cost) => o.judged?.(f, cost), prompts: this.p,
      variant: this.m.judge ?? JUDGE_PROMPT }) : null;
    // The grouping call is skipped only when the second model answered none of the findings in time (any timeout
    // kind, by the error's flag; the older message test is kept).
    const stalled = findings.length > 0 && findings.every((f) => f.reason === `not challenged: ${STALLED}` ||
      timedOut.has(f.id) || f.reason.includes("no reply within"));
    if (spent && stalled) o.trace({ step: "explain", outcome: "skipped", reason: STALLED });
    // A failure with the same message before the change that its origin left there is not the change's: not grouped.
    const groups = spent && !stalled ? await explain(findings.filter((f) => !isPreExisting(f)), { model: challenger, diff: o.diff, sources: o.sources,
      budgetUsd: remaining, use: spent, trace: o.trace, progress: o.progress, prompts: this.p }) : [];
    // A challenger with a fallback keeps its own per-model use (second opinions and grouping, both models).
    const uses = challenger instanceof FallbackJson ? challenger.uses : spent ? [spent] : [];
    return { questions: merged, groups, uses };
  }

  /** Nothing is billed here: the user's keys pay the providers. */
  async finish(_totals: Totals): Promise<Billed | null> {
    return null;
  }
}
