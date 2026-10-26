// Questions that ask the same thing in other words (from one reviewer's follow-ups, or from reviewers of different
// projects) are merged into one before the second opinion, which links findings to questions by id. One call; the
// first wording is kept. A failed call keeps every question.
import { ModelError } from "./errors";
import { withRole } from "./events";
import { type JsonModel, type ModelUse, tally } from "./llm";
import { DEFAULT_PROMPTS, MERGE_SCHEMA, type Prompts } from "./prompts";

/** The questions kept, and for each question given the index of the one it became. */
export interface Merged { questions: string[]; into: number[] }

export async function mergeQuestions(questions: string[], o: { model: JsonModel | null; use: ModelUse;
  progress?: (m: string) => void; prompts?: Prompts }): Promise<Merged> {
  const unchanged = { questions, into: questions.map((_q, i) => i) };
  const model = o.model;
  if (questions.length < 2 || !model) return unchanged;
  const p = o.prompts ?? DEFAULT_PROMPTS;
  let reply: Record<string, unknown>;
  try {
    const [data, cost, usage, unknown] = await withRole("merge-questions",
      () => model.completeJson(p.mergeSystem(), p.mergeTask(questions), MERGE_SCHEMA));
    tally(o.use, cost, usage, unknown);
    reply = data;
  } catch (e) {
    if (!(e instanceof ModelError)) throw e;
    if (e.costUsd > 0 || e.usage) tally(o.use, e.costUsd, e.usage, e.unknownCalls);
    o.progress?.(`merging repeated questions failed (${e.message.slice(0, 120)}); every question kept`);
    return unchanged;
  }
  return mergeBy(questions, Array.isArray(reply.same) ? reply.same : []);
}

/** Merge the sets of question ids ("Q1", ...) the model named as the same; unknown ids and sets of one are ignored. */
export function mergeBy(questions: string[], same: unknown[]): Merged {
  const root = questions.map((_q, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i]!)));
  for (const set of same) {
    const ids = (Array.isArray(set) ? set : []).map((x) => /^Q(\d+)$/.exec(String(x).trim()))
      .map((m) => (m ? Number(m[1]) - 1 : -1)).filter((i) => i >= 0 && i < questions.length);
    for (const i of ids.slice(1)) {
      const [a, b] = [find(ids[0]!), find(i)];
      if (a !== b) root[Math.max(a, b)] = Math.min(a, b);
    }
  }
  const kept = questions.map((_q, i) => i).filter((i) => find(i) === i);
  const index = new Map(kept.map((k, n) => [k, n]));
  return { questions: kept.map((k) => questions[k]!), into: questions.map((_q, i) => index.get(find(i))!) };
}
