// A second model, from another vendor when keys allow, marks each finding confirmed or disputed. Nothing is
// deleted: a disputed finding stays in the report with the reason.
import { boundaryOf } from "./boundary";
import { survivable } from "./errors";
import { clip, emit, hypId, withRole } from "./events";
import { type JsonModel, type ModelUse, newUse, tally, type Trace } from "./llm";
import type { SentInput } from "./brain";
import type { Say } from "./progress";
import { CHALLENGE_SCHEMA, DEFAULT_PROMPTS, isTestPath, type Prompts } from "./prompts";
import { codeText } from "./codetext";
import { DISPUTE_KINDS, JUDGE_PROMPT, JUDGE_SCHEMA, type JudgeVariant, NEW_SYSTEM, newJudgeUser, ORIGINS } from "./judgeprompt";
import { type DisputeKind, type Finding, firstLine, type Origin, sameTest } from "./report";
import { testDecorators } from "./shallow";
import { pyRepr } from "./util";

/** Why the findings after a timed-out call were not sent; the reviewer then skips the explain call too. */
export const STALLED = "the second model did not reply in time";

/** Keep verdict batches small enough to avoid provider overload and excessive in-flight budget overshoot. */
export const CONCURRENCY = 4;

/** Runs `work` over `items` with at most `limit` running at once, in order of start. */
export async function inPool<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError("concurrency must be a positive integer");
  let next = 0;
  const lane = async () => {
    while (next < items.length) await work(items[next++]!);
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, lane));
}

/** Cases of one test that differ only by something outside it share one judgment; cases it receives as data do not. */
const DATA_CASES = /parametrize|\.each\b|#\[\s*case\b|\btest_case\b/;
const FIXTURE_PARAMS = /\bfixture\s*\([^)]*\bparams\s*=/;
/** Data that lives in the file, outside the test's own decorators: a module mark, a hook, a class-level parametrize,
 * a fixture given its params in a mapping, Rust's `#[values]`. */
const FILE_DATA = /\bpytestmark\b|\bpytest_generate_tests\b|\bmetafunc\s*\.\s*parametrize\b|#\[\s*values\b|\bfixture\s*\(\s*\*\*|\bparametrize\b(?:(?!\bdef\s)[\s\S])*?\n\s*class\b/;
const fileData = (code: string) => FIXTURE_PARAMS.test(code) || FILE_DATA.test(code);

/** The findings split into groups judged once: the first of a group is judged, the others take its verdict. Findings
 * are grouped only when they are cases of one test (same project, file, image and first failure line) whose own
 * decorators bring no data, and whose file has no fixture with params (the cases differ by a fixture, not by what the
 * test checks). Order is kept. */
export function caseGroups(findings: Finding[], sources: Record<string, string>): Finding[][] {
  const groups: Finding[][] = [], at = new Map<string, Finding[]>();
  for (const f of findings) {
    const source = f.file ? sources[f.file] : undefined;
    let key: string | null = null;
    if (source !== undefined && !fileData(codeText(source, f.file!))) {
      const decorators = testDecorators(source, f.func, f.file!);
      if (decorators !== null && !DATA_CASES.test(decorators)) {
        key = [sameTest(f), f.file, f.fallback ? "fallback" : "", firstLine(f.message)].join("\u0000");
      }
    }
    const group = key === null ? undefined : at.get(key);
    if (group) group.push(f);
    else {
      const made = [f];
      groups.push(made);
      if (key !== null) at.set(key, made);
    }
  }
  return groups;
}

/** The verdict of `from` onto `to`, a case judged by the same call. */
export function shareVerdict(from: Finding, to: Finding): void {
  [to.verdict, to.reason] = [from.verdict, from.reason];
  if (from.dependsOn && !to.dependsOn) to.dependsOn = from.dependsOn;
  if (from.judge) to.judge = from.judge;
  if (from.disputeKind) to.disputeKind = from.disputeKind;
  if (from.origin) {
    to.origin = from.origin;
    applyOrigin(to, from.origin, from.reason);
  }
  if (from.verdict !== null) to.sameAs = from.id;
}

// ---- the structured reply's gates

/** The gates a structured reply passes, each with its own switch for replay: `caller` (a confirmation the evidence
 * finds no caller for), `intent` (a confirmation that cites intent), `question` (a confirmation or open verdict
 * that waits on a question). */
export const GATES = ["caller", "intent", "question"] as const;
export type Gate = (typeof GATES)[number];
const ALL_GATES: ReadonlySet<Gate> = new Set(GATES);

/** A structured reply once its gates ran. `said`: the verdict the model gave; `gate`: the gate that changed it. */
export interface Settled { verdict: "confirmed" | "disputed" | "open" | null; reason: string; said: string | null;
  kind?: DisputeKind; origin?: Origin; dependsOn?: string; gate?: Gate }

/** An intent field that says there is none. */
const NO_INTENT = /^(?:none|n\/?a|no|null|nil|nothing|-+|—|not stated|(?:no|none)\b.*\b(?:evidence|intent|statement|stated|found|given|doc\w*)\b.*)[.!]?$/i;
const str = (v: unknown) => typeof v === "string" ? v.trim() : "";
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");

/** What an evidence pack says of callers, when it says for certain that none exists: every changed definition the test
 * uses was searched for, the search ran to its end and found no caller, and nothing (a decorator, an export, a string
 * that names it, a `getattr`, a config entry) may reach it otherwise. Null whenever it says anything less. */
export function noCaller(evidence: string): { names: string[]; defs: string[] } | null {
  if (!evidence.trim() || /\(the search stopped at its /.test(evidence)) return null;
  const sectionOf = (title: string) => new RegExp(`^## ${title}\n([\\s\\S]*?)(?=\n\n## |\n\n\\(the search|(?![\\s\\S]))`, "m")
    .exec(evidence)?.[1] ?? null;
  const targets = sectionOf("Target names"), callers = sectionOf("Callers");
  if (!targets || !callers || /^\(the test uses none of the changed definitions/m.test(targets)) return null;
  const names: string[] = [], defs: string[] = [];
  for (const line of callers.split("\n")) {
    if (!line.trim()) continue;
    const m = /^`([^`]+)` \(([^)]+)\): (.*)$/.exec(line);
    // A caller found, a place that may reach it, entries left out: no certainty.
    if (!m || m[3] !== "no caller found") return null;
    names.push(m[1]!);
    defs.push(m[2]!);
  }
  return names.length ? { names, defs } : null;
}

/** Whether a reply's `caller` names a place the evidence or the diff shows that is no test and no definition the
 * evidence searched for: a caller the search by name may have missed. */
function namesCaller(caller: string, evidence: string, diff: string, defs: string[]): boolean {
  const shown = (path: string) => diff.includes(`b/${path}`) || diff.includes(`a/${path}`) || evidence.includes(path);
  const defFiles = new Set(defs.map((d) => d.replace(/:\d+$/, "")));
  for (const m of caller.matchAll(/([\w$@.+-]+(?:\/[\w$@.+-]+)*\.[A-Za-z0-9]+)(?::(\d+))?/g)) {
    const [path, line] = [m[1]!, m[2]];
    if (isTestPath(path) || !shown(path)) continue;
    if (line ? defs.includes(`${path}:${line}`) : defFiles.has(path)) continue;
    return true;
  }
  return false;
}

/** A structured reply settled by deterministic gates. A confirmation whose evidence finds no caller (`noCaller`) and
 * whose `caller` names none the evidence or the diff shows is disputed as unreachable; one that cites intent is
 * disputed as intended; one that waits on a question of this review is open. An open verdict on no question of this
 * review is disputed. `gates` turns each off for replay. */
export function settleVerdict(data: Record<string, unknown>, evidence: string, diff: string, questions: string[],
  gates: ReadonlySet<Gate> = ALL_GATES): Settled {
  const said = typeof data.verdict === "string" ? data.verdict : null;
  const reason = str(data.reason);
  const origin = (ORIGINS as readonly string[]).includes(str(data.origin)) ? str(data.origin) as Origin : undefined;
  const kind = (DISPUTE_KINDS as readonly string[]).includes(str(data.kind)) ? str(data.kind) as DisputeKind : undefined;
  const dep = str(data.depends_on);
  const asked = /^Q\d+$/.test(dep) && Number(dep.slice(1)) >= 1 && Number(dep.slice(1)) <= questions.length;
  const base = { said, ...(origin ? { origin } : {}) };
  const disputed = (k: DisputeKind, why: string, gate?: Gate): Settled =>
    ({ ...base, verdict: "disputed", reason: why, kind: k, ...(gate ? { gate } : {}) });
  if (said === "disputed") return { ...base, verdict: "disputed", reason, ...(kind ? { kind } : {}) };
  if (said === "open") {
    if (asked) return { ...base, verdict: "open", reason, dependsOn: dep };
    return gates.has("question") ? disputed("open-question", `open on no question of this review: ${reason}`, "question")
      : { ...base, verdict: "open", reason };
  }
  if (said !== "confirmed") return { ...base, verdict: null, reason };
  const intent = str(data.intent);
  if (gates.has("intent") && intent && !NO_INTENT.test(intent)) return disputed("intended", `intended: ${cut(intent, 300)}`, "intent");
  const none = gates.has("caller") ? noCaller(evidence) : null;
  if (none && !namesCaller(str(data.caller), evidence, diff, none.defs)) {
    return disputed("unreachable", `no caller: nothing calls ${none.names.map((n) => `\`${n}\``).join(", ")}, and no ` +
      "decorator, export, string or config entry reaches it", "caller");
  }
  if (asked && gates.has("question")) return { ...base, verdict: "open", reason, dependsOn: dep, gate: "question" };
  return { ...base, verdict: "confirmed", reason, ...(asked ? { dependsOn: dep } : {}) };
}

/** Where the second opinion puts a failure, applied to what the code before the change showed (the structured reply
 * only). A pass there is no regression when the failure is older or in what the change adds; a failure with the same
 * message there is this change's when the second opinion says so, and its verdict then counts. */
export function applyOrigin(f: Finding, origin: Origin | undefined, reason: string): void {
  const b = f.before;
  if (!b || !origin) return;
  const why = cut(reason, 300);
  if (b.status === "regression" && (origin === "older" || origin === "new-feature")) {
    f.before = { ...b, status: "unknown", detail: `${b.detail}; the second opinion finds the failure ` +
      `${origin === "older" ? "older than the change" : "in what the change adds"}: ${why}` };
  } else if (b.status === "pre-existing" && (origin === "this-change" || origin === "new-feature")) {
    f.before = { ...b, status: origin === "this-change" ? "changed" : "new-code", detail: "fails with the same message " +
      `there, but the second opinion puts the failure ${origin === "this-change" ? "in this change" : "in what the change adds"}: ${why}` };
  }
}

/** What the second opinion is sent for `f`. The diff passes the outgoing filter before it is ordered and cut, so a cut
 * never splits a masked span; the rest is masked as the call is made. */
export function judgeUser(p: Prompts, model: object, diff: string, f: Finding, source: string,
  suspectFile: string | undefined, questions: string[], boundary = boundaryOf(model)): string {
  return p.challengeUser(boundary ? boundary.mask(diff) : diff, f.file || "(unknown file)", source, f.testId,
    f.message, f.explanation, questions, suspectFile ?? "");
}

/** What the "new" variant sends for `f`: as `judgeUser`, with the finding's evidence pack. */
export function newJudgeInput(model: object, diff: string, f: Finding, source: string, suspectFile: string | undefined,
  questions: string[], evidence: string, boundary = boundaryOf(model)): string {
  const mask = (t: string) => boundary ? boundary.mask(t) : t;
  return newJudgeUser({ diff: mask(diff), testFile: f.file || "(unknown file)", testSource: source, testId: f.testId,
    failure: f.message, explanation: f.explanation, questions, suspectFile: suspectFile ?? "", evidence: mask(evidence) });
}

export async function challenge(findings: Finding[], o: { model: JsonModel; diff: string;
  /** The part of the change a finding's project was given, when it differs from `diff`. */
  diffOf?: (f: Finding) => string;
  /** The file the finding's suspect is in: its diff is shown first when the change is long. */
  suspectFile?: (f: Finding) => string | undefined;
  /** The finding's evidence pack, when its round built one. */
  evidence?: (f: Finding) => string | undefined;
  /** Before each call, what it is sent, masked as it leaves, and the evidence pack. */
  sent?: (f: Finding, input: SentInput) => void;
  sources: Record<string, string>; budgetUsd: number; questions?: string[]; trace?: Trace;
  progress?: Say;
  /** Findings judged before (a resumed review): not sent again. */
  skip?: Set<string>;
  /** Called after each finding's call, with what that call cost. */
  onJudged?: (f: Finding, costUsd: number) => void;
  /** Second opinions at once (default CONCURRENCY). */
  concurrency?: number;
  /** Filled with the ids of findings whose call ran out of time (any timeout kind). */
  timedOut?: Set<string>;
  prompts?: Prompts;
  /** The prompt variant (default JUDGE_PROMPT): "new" sends the evidence pack, asks for the structured reply and
   * settles it by `gates` (default all). */
  variant?: JudgeVariant;
  gates?: ReadonlySet<Gate> }): Promise<ModelUse> {
  const structured = (o.variant ?? JUDGE_PROMPT) === "new";
  const questions = o.questions ?? [];
  const p = o.prompts ?? DEFAULT_PROMPTS;
  const use = newUse(o.model.ref);
  const trace = (line: Record<string, unknown>) => o.trace?.({ step: "challenge", ...line });
  // Findings are judged CONCURRENCY at a time. One timed-out call leaves only its finding unchecked; after two
  // timeouts in a row the model is taken to be down, and findings not yet sent are skipped rather than waited for.
  let timeouts = 0, started = 0;
  const groups = caseGroups(findings.filter((f) => !o.skip?.has(f.id)), o.sources);
  const pending = groups.map((g) => g[0]!);
  const verdictEvent = (f: Finding, outcome: string, cost: number, timedOut = false) => emit("challenge.verdict", {
    project: f.project, finding: f.id, test_id: f.testId, hyp_id: f.suspect ? hypId(f.project, f.suspect) : null,
    outcome, verdict: f.verdict, reason: clip(f.reason), depends_on: f.dependsOn ?? null,
    judge: outcome === "ok" ? f.judge ?? o.model.ref : null, cost_usd: cost,
    timed_out: timedOut });
  const judge = async (f: Finding) => {
    if (timeouts >= 2) {
      [f.verdict, f.reason] = [null, `not challenged: ${STALLED}`];
      trace({ finding: f.id, outcome: "skipped" });
      verdictEvent(f, "skipped", 0);
      return;
    }
    if (use.costUsd >= o.budgetUsd) {
      [f.verdict, f.reason] = [null, "not challenged: review budget reached"];
      verdictEvent(f, "budget", 0);
      return;
    }
    o.progress?.(`second opinion on ${f.id} (${++started}/${pending.length})`);
    const t0 = performance.now();
    const secs = () => Math.round((performance.now() - t0) / 100) / 10;
    const diff = o.diffOf?.(f) ?? o.diff, evidence = o.evidence?.(f) ?? "";
    const user = structured
      ? newJudgeInput(o.model, diff, f, o.sources[f.file ?? ""] ?? "", o.suspectFile?.(f), questions, evidence)
      : judgeUser(p, o.model, diff, f, o.sources[f.file ?? ""] ?? "", o.suspectFile?.(f), questions);
    const system = structured ? NEW_SYSTEM : p.challengeSystem();
    if (o.sent) {
      const b = boundaryOf(o.model);
      o.sent(f, b ? { system: b.mask(system), user: b.mask(user), evidence: b.mask(evidence) } : { system, user, evidence });
    }
    let data: Record<string, unknown>, callCost = 0, by: string | undefined;
    try {
      const [reply, cost, usage, unknown, model] = await withRole("challenge",
        () => o.model.completeJson(system, user, structured ? JUDGE_SCHEMA : CHALLENGE_SCHEMA), { finding: f.id, project: f.project });
      tally(use, cost, usage, unknown);
      [data, callCost, by] = [reply, cost, model];
      trace({ finding: f.id, outcome: "ok", secs: secs(), cost_usd: cost });
      timeouts = 0; // two timeouts in a row, not two in all
    } catch (e) {
      if (!survivable(e)) throw e;
      if (e.costUsd > 0 || e.usage) tally(use, e.costUsd, e.usage, e.unknownCalls);
      else use.unknownCalls += e.unknownCalls;
      [f.verdict, f.reason] = [null, `not challenged: ${e.message}`];
      trace({ finding: f.id, outcome: "error", secs: secs(), error: e.message });
      timeouts = e.timedOut ? timeouts + 1 : 0;
      if (e.timedOut) o.timedOut?.add(f.id);
      verdictEvent(f, "error", e.costUsd, e.timedOut);
      return;
    }
    if (by && by !== o.model.ref) f.judge = by;
    if (structured) {
      const s = settleVerdict(data, evidence, diff, questions, o.gates);
      if (s.verdict === null) {
        [f.verdict, f.reason] = [null, `not challenged: unexpected verdict ${s.said !== null ? pyRepr(s.said) : JSON.stringify(data.verdict ?? null)}`];
      } else {
        [f.verdict, f.reason] = [s.verdict, s.reason];
        if (s.kind) f.disputeKind = s.kind;
        if (s.dependsOn && !f.dependsOn) f.dependsOn = s.dependsOn;
        if (s.origin) {
          f.origin = s.origin;
          applyOrigin(f, s.origin, s.reason);
        }
      }
      verdictEvent(f, "ok", callCost);
      o.onJudged?.(f, callCost);
      return;
    }
    const verdict = data.verdict;
    const reason = String(data.reason ?? "").trim();
    if (verdict === "confirmed" || verdict === "disputed") [f.verdict, f.reason] = [verdict, reason];
    else [f.verdict, f.reason] = [null, `not challenged: unexpected verdict ${typeof verdict === "string" ? pyRepr(verdict) : JSON.stringify(verdict ?? null)}`];
    const dep = String(data.depends_on ?? "").trim();
    if (!f.dependsOn && /^Q\d+$/.test(dep) && Number(dep.slice(1)) <= questions.length) f.dependsOn = dep;
    verdictEvent(f, "ok", callCost);
    o.onJudged?.(f, callCost);
  };
  // The others of a group take the verdict of the one judged, without a call of their own.
  const judgeGroup = async (leader: Finding) => {
    await judge(leader);
    for (const f of groups.find((g) => g[0] === leader)!.slice(1)) {
      shareVerdict(leader, f);
      if (o.timedOut?.has(leader.id)) o.timedOut.add(f.id);
      if (leader.verdict === null) continue;
      verdictEvent(f, "ok", 0);
      o.onJudged?.(f, 0);
    }
  };
  await inPool(pending, o.concurrency ?? CONCURRENCY, judgeGroup);
  return use;
}
