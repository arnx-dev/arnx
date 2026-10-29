// The hunt's pieces outside the reviewer's conversation: suspects parsed and merged, and the second hunter, a model
// from another vendor that gets the same opening without tools, with the changed definitions whole.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { HuntPart } from "./brain";
import type { ReviewConfig } from "./config";
import { changedDefinitions, CONTEXT_LIMIT, contextPack } from "./context";
import { sliceDiff } from "./change";
import { adapterFor } from "./adapters";
import { changedSources } from "./untested";
import { survivable } from "./errors";
import { withRole } from "./events";
import { type JsonModel, type ModelUse, newUse, tally } from "./llm";
import { DEFAULT_PROMPTS, HUNT_SCHEMA, MAX_SUSPECTS, type Prompts, RANK_SCHEMA, type Scope, type Suspect }
  from "./prompts";
import type { Say } from "./progress";
import type { ScipIndex } from "./scip";
import { inPool } from "./challenge";

const str = (v: unknown) => (typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v));

/** Suspects from one reply, numbered later. Entries without a file or a claim are dropped. */
export function parseSuspects(data: Record<string, unknown> | null, by: string): Suspect[] {
  const raw = Array.isArray(data?.suspects) ? data!.suspects as unknown[] : [];
  return raw.flatMap((x) => {
    if (typeof x !== "object" || x === null) return [];
    const o = x as Record<string, unknown>;
    const s = { id: "", file: str(o.file).replace(/^\/+/, ""), line: Math.trunc(Number(o.line) || 0),
      claim: str(o.claim), why: str(o.why), input: str(o.input), expected: str(o.expected), actual: str(o.actual), by };
    return s.file && s.claim ? [s] : [];
  }).slice(0, MAX_SUSPECTS);
}

export const questionsOf = (data: Record<string, unknown> | null): string[] =>
  Array.isArray(data?.questions) ? (data!.questions as unknown[]).map(str).filter(Boolean) : [];

const norm = (c: string) => c.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** The same claim about the same place: what makes a suspect a repeat of another. */
export const sameSuspect = (a: Suspect, b: Suspect): boolean =>
  a.file === b.file && a.line === b.line && norm(a.claim) === norm(b.claim);

/** Both hunters' suspects, the reviewer's first. Two defects can share a line, so a second-hunter suspect is dropped
 * only when it makes the same claim about the same place. Numbered S1, S2, … */
export function mergeSuspects(first: Suspect[], second: Suspect[]): Suspect[] {
  const out = [...first];
  for (const s of second) {
    if (!out.some((o) => sameSuspect(o, s))) out.push(s);
  }
  return out.map((s, i) => ({ ...s, id: `S${i + 1}` }));
}

/** The second hunter's suspects and what it cost; an API error is reported and gives none. The changed definitions
 * are `o.changedDefinitions` when given, else read from the snapshot at `root` (none without either). Its attempts
 * are logged to hunt-second.jsonl in `o.outDir`, when given. */
export async function secondHunt(root: string | null, cfg: ReviewConfig, o: { model: JsonModel; diff: string;
  context: string; scope: Scope; outDir?: string; progress?: Say; changedDefinitions?: string; prompts?: Prompts })
  : Promise<{ suspects: Suspect[]; use: ModelUse }> {
  const say = (m: string) => o.progress?.(`${cfg.name}: ${m}`);
  const use = newUse(o.model.ref);
  if (o.outDir) {
    mkdirSync(o.outDir, { recursive: true });
    const log = join(o.outDir, "hunt-second.jsonl");
    o.model.trace = (line) => appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), ...line }) + "\n");
  }
  try {
    const defs = o.changedDefinitions ?? (root === null ? "" : changedDefinitions(root, o.diff, o.scope.owned));
    const p = o.prompts ?? DEFAULT_PROMPTS;
    const user = p.secondHuntTask(cfg, o.diff, o.context, defs, o.scope);
    const [reply, cost, usage, unknown] = await withRole("second-hunt",
      () => o.model.completeJson(p.huntSystem(), user, HUNT_SCHEMA));
    tally(use, cost, usage, unknown);
    return { suspects: parseSuspects(reply, o.model.ref.replace(/^[a-z]+:/, "")), use };
  } catch (e) {
    if (!survivable(e)) throw e;
    if (e.costUsd > 0 || e.usage) tally(use, e.costUsd, e.usage, e.unknownCalls);
    else use.unknownCalls += e.unknownCalls;
    say(`second hunter failed: ${e.message.slice(0, 300)}`);
    return { suspects: [], use };
  } finally {
    if (o.outDir) o.model.trace = undefined;
  }
}

/** A diff over this size is hunted in parts as well as whole. */
export const PART_LIMIT = 40_000;
export const PART_CONCURRENCY = 3;
/** At most this many suspects go to the prove step. */
export const MAX_PROVE = 16;

/** Changed files grouped so each group's diff is about `limit` characters (a file is never split; files in diff
 * order, so neighbours in the tree stay together). Empty when the whole diff is within the limit. */
export function partition(diff: string, files: string[], limit = PART_LIMIT): string[][] {
  if (diff.length <= limit) return [];
  const groups: string[][] = [];
  let cur: string[] = [], size = 0;
  for (const f of files) {
    const n = sliceDiff(diff, [f]).length;
    if (!n) continue;
    if (cur.length && size + n > limit) {
      groups.push(cur);
      [cur, size] = [[], 0];
    }
    cur.push(f);
    size += n;
  }
  if (cur.length) groups.push(cur);
  return groups.length > 1 ? groups : [];
}

/** The parts a big change is hunted in, each with what its hunter reads from the snapshot at `root`: its context
 * pack (by symbol when the project's code index is given) and its changed definitions. Empty when the change is
 * small enough to hunt whole. */
export function huntParts(root: string, cfg: ReviewConfig, diff: string, owned: string[], searchDirs: string[],
                          index: ScipIndex | null = null): HuntPart[] {
  // Product code only: the project's own tests and helpers are not what a change is reviewed for.
  return partition(diff, changedSources(owned, adapterFor(cfg))).map((files) => {
    const d = sliceDiff(diff, files);
    return { files, context: contextPack(root, d, files, searchDirs, CONTEXT_LIMIT, index),
      changedDefinitions: changedDefinitions(root, d, files) };
  });
}

/** One tool-less hunter per part of a big change, in parallel; each part's suspects in its own list. The parts are
 * `o.parts` when given, else built from the snapshot at `root` (huntParts; none without either). */
export async function partHunts(root: string | null, cfg: ReviewConfig, o: { model: JsonModel; diff: string;
  owned: string[]; searchDirs: string[]; scope: Scope; outDir?: string; progress?: Say; parts?: HuntPart[];
  prompts?: Prompts })
  : Promise<{ lists: Suspect[][]; use: ModelUse }> {
  const use = newUse(o.model.ref);
  const parts = o.parts ?? (root === null ? [] : huntParts(root, cfg, o.diff, o.owned, o.searchDirs));
  if (!parts.length) return { lists: [], use };
  o.progress?.(`${cfg.name}: hunting the change in ${parts.length} parts`);
  const by = o.model.ref.replace(/^[a-z]+:/, "");
  const p = o.prompts ?? DEFAULT_PROMPTS;
  const lists: Suspect[][] = parts.map(() => []);
  await inPool(parts.map((part, index) => ({ part, index })), PART_CONCURRENCY, async ({ part, index }) => {
    const diff = sliceDiff(o.diff, part.files);
    const user = p.secondHuntTask(cfg, diff, part.context, part.changedDefinitions, o.scope);
    try {
      const [reply, cost, usage, unknown] = await withRole("part-hunt",
        () => o.model.completeJson(p.huntSystem(), user, HUNT_SCHEMA), { part: index + 1 });
      tally(use, cost, usage, unknown);
      lists[index] = parseSuspects(reply, by);
    } catch (e) {
      if (!survivable(e)) throw e;
      if (e.costUsd > 0 || e.usage) tally(use, e.costUsd, e.usage, e.unknownCalls);
      else use.unknownCalls += e.unknownCalls;
      o.progress?.(`${cfg.name}: a part hunter failed: ${e.message.slice(0, 200)}`);
    }
  });
  return { lists, use };
}

/** Lists merged in turn (the first of each list, then the second of each, …), the same claim at the same place kept
 * once, at most `max`. Each list is most harmful first. */
export function interleave(lists: Suspect[][], max = MAX_PROVE): Suspect[] {
  const flat: Suspect[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) flat.push(l[i]!);
  const merged = flat.reduce<Suspect[]>((acc, s) => mergeSuspects(acc, [s]), []);
  return merged.slice(0, max).map((s, i) => ({ ...s, id: `S${i + 1}` }));
}

/** All hunters' suspects, repeats (same claim, same place) removed, ranked by the reviewer model by harm if real; at
 * most `max`. Without a ranker, or when ranking fails, the lists are taken in turn. Renumbered S1, S2, … */
export async function rankSuspects(lists: Suspect[][], o: { model: JsonModel | null; use: ModelUse; max?: number;
  progress?: (m: string) => void; prompts?: Prompts }): Promise<Suspect[]> {
  const max = o.max ?? MAX_PROVE;
  const all = interleave(lists, Infinity);
  const model = o.model;
  if (all.length <= max || !model) return all.slice(0, max);
  const p = o.prompts ?? DEFAULT_PROMPTS;
  try {
    const [reply, cost, usage, unknown] = await withRole("rank",
      () => model.completeJson(p.rankSystem(), p.rankTask(all), RANK_SCHEMA));
    tally(o.use, cost, usage, unknown);
    const byId = new Map(all.map((s) => [s.id, s]));
    const order = (Array.isArray(reply.order) ? reply.order : []).map((x) => byId.get(String(x).trim()))
      .filter((s): s is Suspect => !!s);
    const ranked = [...new Set([...order, ...all])];
    return ranked.slice(0, max).map((s, i) => ({ ...s, id: `S${i + 1}` }));
  } catch (e) {
    if (!survivable(e)) throw e;
    if (e.costUsd > 0 || e.usage) tally(o.use, e.costUsd, e.usage, e.unknownCalls);
    o.progress?.(`ranking failed (${e.message.slice(0, 120)}); suspects taken in turn`);
    return all.slice(0, max);
  }
}
