// After the challenge, one call to the second model groups findings that share a cause, explains each group in plain
// language (input, actual, expected, why it matters) and rates its severity, which orders the report. Report only:
// findings, verdicts and exit codes do not change, and a failed call leaves the report as a list of findings.
import { ModelError } from "./errors";
import { withRole } from "./events";
import { type JsonModel, type ModelUse, tally, type Trace } from "./llm";
import type { Say } from "./progress";
import { DEFAULT_PROMPTS, EXPLAIN_SCHEMA, explainUser, type Prompts } from "./prompts";
import { type Finding, type Group, rankGroups, SEVERITIES } from "./report";

const FIELDS = ["title", "input", "actual", "expected", "consequence"] as const;
const MAX = { title: 160, input: 400, actual: 400, expected: 400, consequence: 400 };

export async function explain(findings: Finding[], o: { model: JsonModel; diff: string; sources: Record<string, string>;
  budgetUsd: number; use: ModelUse; trace?: Trace; progress?: Say; prompts?: Prompts }): Promise<Group[]> {
  if (!findings.length || o.use.costUsd >= o.budgetUsd) return [];
  o.progress?.("grouping findings");
  const started = performance.now();
  const secs = () => Math.round((performance.now() - started) / 100) / 10;
  let data: Record<string, unknown>;
  try {
    const system = (o.prompts ?? DEFAULT_PROMPTS).explainSystem();
    const [reply, cost, usage, unknown] = await withRole("explain",
      () => o.model.completeJson(system, explainUser(o.diff, findings, o.sources), EXPLAIN_SCHEMA));
    tally(o.use, cost, usage, unknown);
    data = reply;
    o.trace?.({ step: "explain", outcome: "ok", secs: secs(), cost_usd: cost });
  } catch (e) {
    if (!(e instanceof ModelError)) throw e;
    o.trace?.({ step: "explain", outcome: "error", secs: secs(), error: e.message });
    if (e.costUsd > 0 || e.usage) tally(o.use, e.costUsd, e.usage, e.unknownCalls);
    else o.use.unknownCalls += e.unknownCalls;
    return [];
  }
  const ids = new Set(findings.map((f) => f.id));
  const seen = new Set<string>();
  const groups: Group[] = [];
  for (const g of Array.isArray(data.groups) ? data.groups : []) {
    if (typeof g !== "object" || g === null) continue;
    const raw = g as Record<string, unknown>;
    const members = (Array.isArray(raw.findings) ? raw.findings : []).map(String)
      .filter((id) => ids.has(id) && !seen.has(id));
    members.forEach((id) => seen.add(id));
    if (!members.length) continue;
    const text = Object.fromEntries(FIELDS.map((k) => [k, String(raw[k] ?? "").trim().slice(0, MAX[k])]));
    const severity = SEVERITIES.find((x) => x === raw.severity);
    groups.push({ findings: members, ...text, ...(severity ? { severity } : {}) } as Group);
  }
  return rankGroups(groups);
}
