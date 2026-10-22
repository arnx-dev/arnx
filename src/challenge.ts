// A second model, from another vendor when keys allow, marks each finding confirmed or disputed. Nothing is
// deleted: a disputed finding stays in the report with the reason.
import { ModelError } from "./errors";
import { clip, emit, hypId, withRole } from "./events";
import { type JsonModel, type ModelUse, newUse, tally, type Trace } from "./llm";
import type { Say } from "./progress";
import { CHALLENGE_SCHEMA, CHALLENGE_SYSTEM, challengeUser } from "./prompts";
import type { Finding } from "./report";
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

export async function challenge(findings: Finding[], o: { model: JsonModel; diff: string;
  /** The part of the change a finding's project was given, when it differs from `diff`. */
  diffOf?: (f: Finding) => string;
  sources: Record<string, string>; budgetUsd: number; questions?: string[]; trace?: Trace;
  progress?: Say;
  /** Findings judged before (a resumed review): not sent again. */
  skip?: Set<string>;
  /** Called after each finding's call, with what that call cost. */
  onJudged?: (f: Finding, costUsd: number) => void;
  /** Second opinions at once (default CONCURRENCY). */
  concurrency?: number;
  /** Filled with the ids of findings whose call ran out of time (any timeout kind). */
  timedOut?: Set<string> }): Promise<ModelUse> {
  const questions = o.questions ?? [];
  const use = newUse(o.model.ref);
  const trace = (line: Record<string, unknown>) => o.trace?.({ step: "challenge", ...line });
  // Findings are judged CONCURRENCY at a time. One timed-out call leaves only its finding unchecked; after two
  // timeouts in a row the model is taken to be down, and findings not yet sent are skipped rather than waited for.
  let timeouts = 0, started = 0;
  const pending = findings.filter((f) => !o.skip?.has(f.id));
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
    const user = challengeUser(o.diffOf?.(f) ?? o.diff, f.file || "(unknown file)", o.sources[f.file ?? ""] ?? "",
      f.testId, f.message, f.explanation, questions);
    let data: Record<string, unknown>, callCost = 0, by: string | undefined;
    try {
      const [reply, cost, usage, unknown, model] = await withRole("challenge",
        () => o.model.completeJson(CHALLENGE_SYSTEM, user, CHALLENGE_SCHEMA), { finding: f.id, project: f.project });
      tally(use, cost, usage, unknown);
      [data, callCost, by] = [reply, cost, model];
      trace({ finding: f.id, outcome: "ok", secs: secs(), cost_usd: cost });
      timeouts = 0; // two timeouts in a row, not two in all
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
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
    const verdict = data.verdict;
    const reason = String(data.reason ?? "").trim();
    if (verdict === "confirmed" || verdict === "disputed") [f.verdict, f.reason] = [verdict, reason];
    else [f.verdict, f.reason] = [null, `not challenged: unexpected verdict ${typeof verdict === "string" ? pyRepr(verdict) : JSON.stringify(verdict ?? null)}`];
    const dep = String(data.depends_on ?? "").trim();
    if (!f.dependsOn && /^Q\d+$/.test(dep) && Number(dep.slice(1)) <= questions.length) f.dependsOn = dep;
    verdictEvent(f, "ok", callCost);
    o.onJudged?.(f, callCost);
  };
  await inPool(pending, o.concurrency ?? CONCURRENCY, judge);
  return use;
}
