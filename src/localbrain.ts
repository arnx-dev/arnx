// The open harness behind the Brain interface, used with the user's own keys: the prompts in prompts.ts and the
// models config.toml names. It runs the agent loop (agent.ts) over the tools the CLI hands it, decides and words the
// follow-ups from the facts the CLI computes after each final reply, runs the hunt (the reviewer's own, the second
// hunter, the part hunters, the ranking) and judges findings (questions merged, second opinions, grouping).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { runAgent, type ToolCall, ToolError } from "./agent";
import type { AnswerInput, Billed, Brain, Facts, HuntRecord, Judged, JudgeOptions, ReviewInput, RoundHunt,
  RoundInputs, RoundKind, RoundResult, RoundTools, SetupInput, Totals } from "./brain";
import { challenge, STALLED } from "./challenge";
import { clip, emit, hypId } from "./events";
import { explain } from "./explain";
import { partHunts, parseSuspects, rankSuspects, sameSuspect, secondHunt } from "./hunt";
import { type AgentModel, FallbackJson, type JsonModel, type ModelUse, newUse, parseJsonObject } from "./llm";
import { DEFAULT_PROMPTS, PROMPT_VERSION, type Prompts, type Suspect } from "./prompts";
import { mergeQuestions } from "./questions";
import { type Finding, parseReports, questionTexts } from "./report";
import type { Prices } from "./settings";

/** How long the tests wait for the second hunter after the reviewer's own hunt has replied. */
export const SECOND_HUNT_WAIT_MS = 90_000;
const TIMED_OUT = Symbol("timed out");

/** The promise's value, or TIMED_OUT when it takes longer than `ms` (the promise itself keeps running). */
function within<T>(p: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([p, new Promise<typeof TIMED_OUT>((r) => {
    timer = setTimeout(() => r(TIMED_OUT), ms);
  })]).finally(() => clearTimeout(timer));
}

/** A suspect as the hunt events show it. */
const shown = (x: Suspect) => ({ file: clip(x.file, 500), line: x.line, claim: clip(x.claim, 500), by: x.by });
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
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
  /** The prompts (default: arnx's own; with the user's keys, the repository's overrides: userprompts.ts). */
  prompts?: Prompts;
}

/** The hunt of one review round: started before the sandbox is up, finished when the reviewer replies to it. */
interface Hunt {
  user: string;
  afterHunt: (reply: string) => Promise<{ message: string; spent: number }>;
  /** Asked once when the tests reply: a message about suspects left without a test, or null. */
  afterTests: (reply: string) => string | null;
  state: RoundHunt;
}

export class LocalBrain implements Brain {
  readonly version = PROMPT_VERSION;
  readonly overrides?: { keys: string[]; hash: string };
  private readonly p: Prompts;

  constructor(readonly m: LocalModels) {
    this.p = m.prompts ?? DEFAULT_PROMPTS;
    if (this.p.overridden.length) this.overrides = { keys: [...this.p.overridden], hash: this.p.hash };
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
    // The tool-less hunters start now, while the sandbox is being built.
    const hunt = x.hunt ? this.hunt(x, x.hunt) : null;
    const t = await tools;
    let hunting = hunt !== null;
    say(hunting ? "looking for defects" : "writing tests");
    let asked = false, askedSuspects = false;
    const decide = async (reply: string, turn: number): Promise<string | null> => {
      if (hunting && hunt) {
        hunting = false;
        const next = await hunt.afterHunt(reply);
        opts.budgetUsd = Math.max(0, opts.budgetUsd - next.spent);
        say("writing tests");
        return next.message;
      }
      t.onStep?.({ type: "final", turn, text: reply, report: parseReports([reply]),
        suspects: hunt?.state.suspects ?? [], ...huntOf() });
      const facts = (await t.facts?.()) ?? NO_FACTS;
      if (hunt && !askedSuspects) {
        askedSuspects = true;
        const m = hunt.afterTests(reply);
        if (m) return m;
      }
      if (asked) return null;
      asked = true;
      const { untestedFiles: missing, dbUntested: db } = facts;
      if (!missing.length && !db.length) return null;
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
      hunt?.user ?? this.p.reviewTask(cfg, x.diff, x.maxQuestions, x.scoped ? x.scope : undefined), decide, reaching);
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
    let user = this.p.setupTask(x.hints);
    if (x.withheld) {
      user += `\n\nThese files are left out of the copy you see and of the sandbox, because they hold text that looks ` +
        `like a key: ${x.withheld}. Code that needs them cannot build or run here; do not recreate ` +
        "them. If a suite cannot run without them, say so in your summary: only the user can allow them.";
    }
    if (x.project) {
      user += `\n\nRe-prove only the project \`${x.project}\`. The current review.yaml is below; keep every other ` +
        `project exactly as it is.\n<review.yaml>\n${x.current}</review.yaml>`;
    } else if (x.add) {
      user += "\n\nThe current review.yaml is below. Cover what is listed under uncovered where a project can test it; " +
        `keep every existing project exactly as it is.\n<review.yaml>\n${x.current}</review.yaml>`;
    }
    let last = 0, unasked: { text: string; turn: number } | null = null;
    const agent = await runAgent(this.m.agentModel, t, { system: this.p.setupSystem(), user, budgetUsd: x.budgetUsd,
      prices: this.m.prices, transcript: transcriptOf(x),
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
    let last = 0, unasked: { text: string; turn: number } | null = null;
    return { system, user, budgetUsd: x.budgetUsd, prices: this.m.prices, transcript: transcriptOf(x),
      unasked: () => unasked,
      onFinal: (reply: string, turn: number) => { unasked = { text: reply, turn }; },
      followUp: async (reply: string) => {
        unasked = null;
        replies.push(reply);
        const next = await decide(reply, last);
        return next === null ? null : next + this.p.askedTask(questionTexts(replies));
      },
      onTurn: (turn: number, names: string[], cost: number, said: string, calls: ToolCall[]) => {
        last = turn;
        t.onTurn?.(turn, names, cost, said);
        const sent = reaching(calls);
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
    const other = m.secondHunter ? secondHunt(root, cfg, { model: m.secondHunter, diff, context: h.context, scope,
      outDir: x.outDir, progress: x.progress, prompts,
      ...(h.changedDefinitions === undefined ? {} : { changedDefinitions: h.changedDefinitions }) }) : null;
    const parts = m.hunter ? partHunts(root, cfg, { model: m.hunter, diff, owned: scope.owned,
      searchDirs: h.searchDirs, scope, outDir: x.outDir, progress: x.progress, prompts,
      ...(h.parts ? { parts: h.parts } : {}) })
      : null;
    const afterHunt = async (reply: string) => {
      const mine = parseSuspects(parseJsonObject(reply), m.agentModel.model);
      // The second hunter gets SECOND_HUNT_WAIT after the reviewer's own hunt; if it is still out (a slow model, a
      // dropped connection) the tests start without it, and its cost is counted when it returns.
      const [early, split] = await Promise.all([other ? within(other, m.secondHuntWaitMs ?? SECOND_HUNT_WAIT_MS)
        : null, parts]);
      const theirs = early === TIMED_OUT ? null : early;
      if (early === TIMED_OUT) {
        state.late = () => this.lateSecond(x, other!, state);
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
      x.progress?.(`${cfg.name}: ${hunted.length} suspect${hunted.length === 1 ? "" : "s"} to test`);
      return { message: prompts.proveTask(cfg, hunted, x.maxQuestions),
        spent: (theirs?.use.costUsd ?? 0) + (split?.use.costUsd ?? 0) + rankUse.costUsd };
    };
    const afterTests = (reply: string) => {
      const r = parseReports([reply]);
      const tested = new Set(r.tests.filter(isObject).map((t) => text(t.suspect ?? "").trim()).filter(Boolean));
      const reasons = new Map((r.suspects_not_tested ?? []).filter(isObject)
        .map((n) => [text(n.suspect ?? "").trim(), text(n.reason ?? "")] as const));
      const left = (state.suspects ?? []).filter((s) => !tested.has(s.id))
        .map((s) => ({ id: s.id, ...(reasons.get(s.id) ? { reason: reasons.get(s.id)! } : {}) }));
      if (!left.length) return null;
      x.progress?.(`${cfg.name}: ${left.length} suspect${left.length === 1 ? "" : "s"} without a test; ` +
        "asking the reviewer to test them or say why they cannot run here");
      return prompts.untestedSuspectsTask(left);
    };
    return { user: prompts.huntTask(cfg, diff, h.context, x.scoped ? scope : undefined), afterHunt, afterTests, state };
  }

  /** The second hunter, arrived after the tests started: its cost counts; its suspects are kept in hunt.json, not
   * tested. */
  private async lateSecond(x: ReviewInput, late: Promise<{ suspects: Suspect[]; use: ModelUse }>,
    state: RoundHunt): Promise<ModelUse> {
    const r = await late;
    emit("hunt.list", { project: x.cfg.name, source: "second-late", suspects: r.suspects.map(shown) });
    if (state.record) state.record.second_late = r.suspects;
    if (!x.outDir) return r.use;
    const huntFile = join(x.outDir, "hunt.json");
    if (existsSync(huntFile)) {
      const h = JSON.parse(readFileSync(huntFile, "utf8")) as Record<string, unknown>;
      writeFileSync(huntFile, JSON.stringify({ ...h, second_late: r.suspects }, null, 2) + "\n");
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
      diffOf: (f) => diffs[f.project] ?? o.diff, sources: o.sources, budgetUsd: remaining, questions: asked,
      trace: o.trace, progress: o.progress, skip, onJudged: (f, cost) => o.judged?.(f, cost), prompts: this.p }) : null;
    // The grouping call is skipped only when the second model answered none of the findings in time (any timeout
    // kind, by the error's flag; the older message test is kept).
    const stalled = findings.length > 0 && findings.every((f) => f.reason === `not challenged: ${STALLED}` ||
      timedOut.has(f.id) || f.reason.includes("no reply within"));
    if (spent && stalled) o.trace({ step: "explain", outcome: "skipped", reason: STALLED });
    const groups = spent && !stalled ? await explain(findings, { model: challenger, diff: o.diff, sources: o.sources,
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
