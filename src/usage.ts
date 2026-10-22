// A local log of what each run spent, per model, so totals can be checked against the providers' bills. Bills are
// per UTC day, so each line carries its UTC day.
import { appendFileSync, mkdirSync } from "node:fs";
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
