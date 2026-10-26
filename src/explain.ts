// After the challenge, one call to the second model groups findings that share a cause, explains each group in plain
// language (input, actual, expected, why it matters) and rates its severity, which orders the report. Report only:
// findings, verdicts and exit codes do not change, and a failed call leaves the report as a list of findings.
import { ModelError } from "./errors";
import { withRole } from "./events";
import { type JsonModel, type ModelUse, tally, type Trace } from "./llm";
import type { Say } from "./progress";
import { EXPLAIN_SCHEMA, EXPLAIN_SYSTEM, explainUser } from "./prompts";
import { type Finding, type Group, rankGroups, SEVERITIES } from "./report";

const FIELDS = ["title", "input", "actual", "expected", "consequence"] as const;
const MAX = { title: 160, input: 400, actual: 400, expected: 400, consequence: 400 };

/** `s` cut to `max` characters at the last word that fits, with an ellipsis; a cut mid-word read as a typo. */
function clipWords(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const at = cut.lastIndexOf(" ");
  return (at > max / 2 ? cut.slice(0, at) : cut).trimEnd() + "…";
}

export async function explain(findings: Finding[], o: { model: JsonModel; diff: string; sources: Record<string, string>;
  budgetUsd: number; use: ModelUse; trace?: Trace; progress?: Say }): Promise<Group[]> {
  if (!findings.length || o.use.costUsd >= o.budgetUsd) return [];
  o.progress?.("grouping findings");
  const started = performance.now();
  const secs = () => Math.round((performance.now() - started) / 100) / 10;
  let data: Record<string, unknown>;
  try {
    const [reply, cost, usage, unknown] = await withRole("explain",
      () => o.model.completeJson(EXPLAIN_SYSTEM, explainUser(o.diff, findings, o.sources), EXPLAIN_SCHEMA));
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
    const text = Object.fromEntries(FIELDS.map((k) => [k, clipWords(String(raw[k] ?? "").trim(), MAX[k])]));
    const severity = SEVERITIES.find((x) => x === raw.severity);
    groups.push({ findings: members, ...text, ...(severity ? { severity } : {}) } as Group);
  }
  return rankGroups(groups);
}
