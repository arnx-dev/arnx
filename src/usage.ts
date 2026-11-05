// A local log of what each run spent, per model, so totals can be checked against the providers' bills. Bills are
// per UTC day, so each line carries its UTC day.
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentResult } from "./agent";
import { EVENTS_FILE } from "./events";
import { type ModelUse, newUse } from "./llm";
import { callsInFlight } from "./provider";

export const USAGE_LOG = "usage.jsonl";

/** Why a review's spend was logged before it finished. */
export type PartialReason = "failed" | "interrupted" | "killed";

/** Appends a line of what `usage` spent. With an `id` (a review's), only what that id has not logged yet goes in
 * (a resumed review's usage includes what its earlier sessions logged), so no dollar is counted twice or lost. */
export function logUsage(repo: string, command: string, usage: ModelUse[], now: Date, id = "",
  partial?: PartialReason): void {
  const dir = join(repo, ".arnx");
  mkdirSync(dir, { recursive: true });
  const rows = id ? unlogged(repo, id, usage) : usage;
  const line = { at: now.toISOString(), utc_day: now.toISOString().slice(0, 10), command, ...(id ? { id } : {}),
    ...(partial ? { partial: true, reason: partial } : {}),
    usage: rows.map((u) => ({ model: u.model, calls: u.calls, unknown_calls: u.unknownCalls, input: u.input,
      output: u.output, cache_read: u.cacheRead, cache_write: u.cacheWrite, cost_usd: u.costUsd })) };
  appendFileSync(join(dir, USAGE_LOG), JSON.stringify(line) + "\n");
}

/** What a run's `model.call` events say it spent, per model (the events are appended as each call ends, so they
 * survive a run that never got to add its tallies up). A model is named as the run's usage names it. */
export function usageFromEvents(path: string): ModelUse[] {
  const uses = new Map<string, ModelUse>();
  let text = "";
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  for (const line of text.split("\n")) {
    try {
      const e = JSON.parse(line) as { type?: string; data?: Record<string, unknown> };
      if (e.type !== "model.call" || !e.data) continue;
      const d = e.data, provider = String(d.provider ?? "unknown"), model = String(d.model ?? "unknown");
      const key = provider === "arnx" ? `${model}/${String(d.role ?? "unknown")}`
        : provider === "unknown" ? model : `${provider}:${model}`;
      const u = uses.get(key) ?? newUse(key);
      uses.set(key, u);
      if (d.ok) u.calls += 1;
      u.unknownCalls += Number(d.unknown_usage) || 0;
      u.input += Number(d.input) || 0; u.output += Number(d.output) || 0;
      u.cacheRead += Number(d.cache_read) || 0; u.cacheWrite += Number(d.cache_write) || 0;
      u.costUsd = Math.round((u.costUsd + (Number(d.cost_usd) || 0)) * 1_000_000) / 1_000_000;
    } catch {
      // a torn last line (a killed run) or a line that is not an event is skipped
    }
  }
  return [...uses.values()];
}

/** Logs what a review that did not finish spent, as read from its events: only what its id has not logged yet.
 * Synchronous: it also runs while the process is leaving. `events`: the events file, when it is not the review's. */
export function logPartial(repo: string, command: string, id: string, reason: PartialReason,
  events = join(repo, ".arnx", "reviews", id, EVENTS_FILE), now = new Date()): void {
  try {
    const inFlight = reason === "killed" ? [] : callsInFlight().map(([p, n]) =>
      ({ ...newUse(`${p}:(in flight)`), unknownCalls: n }));
    const rows = unlogged(repo, id, [...usageFromEvents(events), ...inFlight]);
    if (rows.length) logUsage(repo, command, rows, now, id, reason);
  } catch {
    // keeping the books never stops the run that is ending
  }
}

/** Reviews that have events but never finished (no review.json) were killed or crashed: logs what each spent that
 * is not logged yet, as `killed`. `except`: the review being resumed, which is still going. */
export function reconcileUsage(repo: string, except = ""): void {
  const root = join(repo, ".arnx", "reviews");
  let ids: string[] = [];
  try {
    ids = readdirSync(root);
  } catch {
    return;
  }
  for (const id of ids) {
    if (id === except || existsSync(join(root, id, "review.json")) || !existsSync(join(root, id, EVENTS_FILE))) continue;
    logPartial(repo, "review", id, "killed");
  }
}

/** One agent run as a model's tally. */
export const agentUse = (model: string, a: AgentResult): ModelUse =>
  ({ ...newUse(model), ...a.usage, calls: a.calls, unknownCalls: a.unknownCalls ?? 0, costUsd: a.costUsd });

/** A model without its provider: "anthropic:claude-x" and "claude-x" are the same model's tally. */
const bare = (model: string): string => model.replace(/^[^:/]*:/, "");

/** What `usage` holds beyond what `id` already logged (a resumed review's whole usage includes what its earlier
 * sessions, or an interrupt or a reconcile, logged): per model, the calls and cost since. Empty when nothing is new. */
export function unlogged(repo: string, id: string, usage: ModelUse[]): ModelUse[] {
  const file = join(repo, ".arnx", USAGE_LOG);
  if (!existsSync(file)) return usage.filter((u) => u.calls || u.unknownCalls || u.costUsd);
  const done = new Map<string, { calls: number; unknown: number; input: number; output: number; cacheRead: number;
    cacheWrite: number; cost: number }>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const l = JSON.parse(line) as { id?: string; usage?: { model: string; calls: number; unknown_calls: number;
        input: number; output: number; cache_read: number; cache_write: number; cost_usd: number }[] };
      if (l.id !== id) continue;
      for (const u of l.usage ?? []) {
        const k = bare(u.model);
        const d = done.get(k) ?? { calls: 0, unknown: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        d.calls += u.calls; d.unknown += u.unknown_calls; d.input += u.input; d.output += u.output;
        d.cacheRead += u.cache_read; d.cacheWrite += u.cache_write; d.cost += u.cost_usd;
        done.set(k, d);
      }
    } catch {
      // a line that is not a record is skipped
    }
  }
  // What was logged is taken off the first rows of that model, so two rows of one model never both lose it.
  const take = (have: number, d: { [k: string]: number }, k: string) => {
    const t = Math.min(have, d[k]!);
    d[k] = d[k]! - t;
    return have - t;
  };
  return usage.map((u) => {
    const d = done.get(bare(u.model));
    return d ? { ...u, calls: take(u.calls, d, "calls"), unknownCalls: take(u.unknownCalls, d, "unknown"),
      input: take(u.input, d, "input"), output: take(u.output, d, "output"), cacheRead: take(u.cacheRead, d, "cacheRead"),
      cacheWrite: take(u.cacheWrite, d, "cacheWrite"),
      costUsd: Math.round(take(u.costUsd, d, "cost") * 1_000_000) / 1_000_000 } : u;
  }).filter((u) => u.calls || u.unknownCalls || u.costUsd);
}
