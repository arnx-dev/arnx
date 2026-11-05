// A local log of what each run spent, per model, so totals can be checked against the providers' bills. Bills are
// per UTC day, so each line carries its UTC day.
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentResult } from "./agent";
import { type ModelUse, newUse } from "./llm";

export const USAGE_LOG = "usage.jsonl";

export function logUsage(repo: string, command: string, usage: ModelUse[], now: Date, id = ""): void {
  const dir = join(repo, ".arnx");
  mkdirSync(dir, { recursive: true });
  const line = { at: now.toISOString(), utc_day: now.toISOString().slice(0, 10), command, ...(id ? { id } : {}),
    usage: usage.map((u) => ({ model: u.model, calls: u.calls, unknown_calls: u.unknownCalls, input: u.input,
      output: u.output, cache_read: u.cacheRead, cache_write: u.cacheWrite, cost_usd: u.costUsd })) };
  appendFileSync(join(dir, USAGE_LOG), JSON.stringify(line) + "\n");
}

/** One agent run as a model's tally. */
export const agentUse = (model: string, a: AgentResult): ModelUse =>
  ({ ...newUse(model), ...a.usage, calls: a.calls, unknownCalls: a.unknownCalls ?? 0, costUsd: a.costUsd });

/** What a review's `usage` holds beyond what its earlier sessions already logged under `id` (a resumed review's whole
 * usage includes them): per model, the calls and cost since. Empty when nothing is new. */
export function unlogged(repo: string, id: string, usage: ModelUse[]): ModelUse[] {
  const file = join(repo, ".arnx", USAGE_LOG);
  if (!existsSync(file)) return usage;
  const done = new Map<string, { calls: number; unknown: number; input: number; output: number; cacheRead: number;
    cacheWrite: number; cost: number }>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    try {
      const l = JSON.parse(line) as { id?: string; usage?: { model: string; calls: number; unknown_calls: number;
        input: number; output: number; cache_read: number; cache_write: number; cost_usd: number }[] };
      if (l.id !== id) continue;
      for (const u of l.usage ?? []) {
        const d = done.get(u.model) ?? { calls: 0, unknown: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
        d.calls += u.calls; d.unknown += u.unknown_calls; d.input += u.input; d.output += u.output;
        d.cacheRead += u.cache_read; d.cacheWrite += u.cache_write; d.cost += u.cost_usd;
        done.set(u.model, d);
      }
    } catch {
      // a line that is not a record is skipped
    }
  }
  const left = (a: number, b: number) => Math.max(0, a - b);
  return usage.map((u) => {
    const d = done.get(u.model);
    return d ? { ...u, calls: left(u.calls, d.calls), unknownCalls: left(u.unknownCalls, d.unknown),
      input: left(u.input, d.input), output: left(u.output, d.output), cacheRead: left(u.cacheRead, d.cacheRead),
      cacheWrite: left(u.cacheWrite, d.cacheWrite), costUsd: Math.round(left(u.costUsd, d.cost) * 1_000_000) / 1_000_000 } : u;
  }).filter((u) => u.calls || u.unknownCalls || u.costUsd);
}
