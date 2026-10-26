// The fix prompt: what an accepted review hands to the developer's own coding agent. arnx proves the bugs and writes
// the tests that define "fixed"; it does not write the fix. The prompt gives the agent the failing tests, each bug's
// expected and actual result, the reviewer's likely cause, the owner's answers as intended behaviour, the questions still open, and the
// rules: change the product code, never the accepted tests, and run `arnx check` until it passes. Its opening, the
// rules and the answers' heading are the `fix` keys of src/prompts.toml, which .arnx/prompts.toml can override.
import type { AcceptResult } from "./accept";
import { DEFAULT_PROMPTS, isModelKey, type Prompts } from "./prompts";
import { groupsOf } from "./report";
import { SHALLOW_NOTE } from "./shallow";
import type { Settings } from "./settings";

const funcOf = (testId: string) => testId.split("::").slice(1).join("::");

/** Where a generated test went, as `accepted/path.py::test_name`. */
export function placed(moved: Record<string, string>, file: string | null, testId: string): string {
  const fn = funcOf(testId);
  const generated = file ?? testId.split("::")[0]!;
  const to = moved[generated] ?? Object.entries(moved).find(([from]) => from.endsWith(generated) ||
    generated.endsWith(from))?.[1];
  return to ? `${to}::${fn}` : testId;
}

/** The first sentence of a text's first line, without its closing full stop. */
function firstSentence(text: string): string {
  return (text.split("\n")[0] ?? "").trim().split(/(?<=[.!?])\s+/)[0]!.replace(/\.$/, "");
}

/** The reviewer's likely cause for a problem: the first finding's explanation, first sentence; another finding's only
 * when it says something new (not "This is the same defect as S1…", not a repeat). */
function causesOf(fs: AcceptResult["review"]["findings"]): { id: string; text: string }[] {
  const out: { id: string; text: string }[] = [];
  for (const f of fs) {
    const text = firstSentence(f.explanation);
    if (!text || out.some((c) => c.text === text)) continue;
    if (out.length && /^(?:(?:this|it) is )?(?:the )?same\b/i.test(text)) continue;
    out.push({ id: f.id, text });
  }
  return out;
}

/** The accepted tests of a problem: each file once, its test names with their finding ids, then how they fail (one
 * line when they all fail the same way). */
function testsOf(fs: AcceptResult["review"]["findings"], moved: Record<string, string>): string[] {
  const tests = fs.map((f) => {
    const where = placed(moved, f.file, f.testId);
    const cut = where.indexOf("::");
    return { id: f.id, file: cut >= 0 ? where.slice(0, cut) : where, name: where.split("::").at(-1)!,
      message: f.message.split("\n")[0]!.slice(0, 160) };
  });
  const same = new Set(tests.map((t) => t.message)).size === 1;
  const item = (t: (typeof tests)[number]) => `\`${t.name}\` (${t.id})` + (same ? "" : ` fails with \`${t.message}\``);
  const files = [...new Set(tests.map((t) => t.file))];
  const label = tests.length === 1 ? "Accepted test" : "Accepted tests";
  const out = files.length === 1 ? [`- ${label}, in \`${files[0]}\`:`, ...tests.map((t) => `  - ${item(t)}`)]
    : [`- ${label}:`, ...files.flatMap((file) => [`  - in \`${file}\`:`,
      ...tests.filter((t) => t.file === file).map((t) => `    - ${item(t)}`)])];
  if (same) {
    const who = tests.length === 1 ? "It fails" : tests.length === 2 ? "Both fail" : `All ${tests.length} fail`;
    out.push(`  ${who} with \`${tests[0]!.message}\`.`);
  }
  return out;
}

/** `p`: the prompts with the repository's overrides (default: arnx's own). */
export function fixPrompt(r: Pick<AcceptResult, "review" | "marks" | "answers" | "moved"> &
  Partial<Pick<AcceptResult, "rewrites" | "setAside">>, _settings?: Settings, p: Prompts = DEFAULT_PROMPTS): string {
  const { review, marks, moved } = r;
  const setAside = r.setAside ?? {};
  const rewrites = r.rewrites ?? [];
  const out: string[] = [p.fixIntro(review.id, review.change), "", p.fixRules(), ""];

  // A finding marked rewrite is a real bug too; its test was set aside, and its rewrite's tests stand in for it.
  const real = new Set(review.findings.filter((f) => marks.findings[f.id] === "real" || marks.findings[f.id] === "rewrite")
    .map((f) => f.id));
  const groups = groupsOf(review).filter(({ findings }) => findings.some((f) => real.has(f.id)));
  if (groups.length) {
    out.push("## Bugs to fix", "");
    groups.forEach(({ group, findings }, i) => {
      const fs = findings.filter((f) => real.has(f.id));
      const title = group?.title || fs[0]!.explanation.split("\n")[0] || fs[0]!.testId;
      out.push(`### ${i + 1}. ${title} (${fs.map((f) => f.id).join(", ")})`, "");
      const v = (s: string | undefined) => s?.trim() ?? "";
      // Every test of this issue replaced (an answer or a rewrite): the expectation and the reviewer's cause came from
      // those tests, so they are left out; the owner's decision below says what is required.
      const replaced = fs.every((f) => setAside[f.id]);
      if (replaced) {
        out.push(`- Expected: as the owner decided (${[...new Set(fs.map((f) => setAside[f.id]!))].join(", ")}, ` +
          "below); the reviewer's first expectation was replaced.");
      } else {
        const actual = v(group?.actual) && v(group?.input) ? `${v(group?.input)}: ${v(group?.actual)}` : v(group?.actual);
        for (const [label, value] of [["Expected", v(group?.expected)], ["Actual", actual],
          ["Input", actual ? "" : v(group?.input)]] as const) if (value) out.push(`- ${label}: ${value}`);
      }
      const causes = replaced ? [] : causesOf(fs).filter((c) => c.text !== firstSentence(title));
      if (causes.length) {
        out.push(`- Likely cause (reviewer): ${causes.length === 1 ? causes[0]!.text
          : causes.map((c) => `${c.text} (${c.id})`).join("; ")}`);
      }
      if (v(group?.consequence)) out.push(`- Why it matters: ${v(group?.consequence)}`);
      const sev = fs.filter((f) => marks.severity[f.id]);
      if (sev.length) {
        const one = new Set(sev.map((f) => marks.severity[f.id])).size === 1 && sev.length === fs.length;
        out.push(`- Severity (owner): ${one ? marks.severity[sev[0]!.id]
          : sev.map((f) => `${marks.severity[f.id]} (${f.id})`).join(", ")}`);
      } else if (group?.severity) {
        out.push(`- Severity (estimate): ${group.severity}`);
      }
      const tested = fs.filter((f) => !setAside[f.id]);
      if (tested.length) out.push(...testsOf(tested, moved));
      for (const f of tested.filter((x) => x.shallow)) {
        out.push(`- Note on ${f.id}: ${SHALLOW_NOTE[f.shallow!]}. Fix the behaviour; say what this test cannot show.`);
      }
      for (const f of fs) {
        const by = setAside[f.id];
        if (by?.startsWith("R")) {
          out.push(`- ${f.id}: its test was wrong; the owner's rewrite (${by}, below) replaces it.`);
        } else if (by) {
          out.push(`- ${f.id}: its test assumed an answer the owner gave differently (${by}); the answer's test ` +
            "replaces it.");
        } else if (f.dependsOn) {
          out.push(`- ${f.id} assumed an answer to ${f.dependsOn}; see the owner's answer below.`);
        }
      }
      out.push("");
    });
  }

  const answered = Object.entries(marks.answers).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1)))
    .map(([qid, answer]) => [qid, review.questions[Number(qid.slice(1)) - 1] ?? "", answer] as const);
  // A rewrite reads like an answer: the issue as the question, the owner's reason as the answer.
  const decided = [...answered, ...rewrites.map((w) => [w.id, `${w.question} (rewrite of ${w.findings.join(", ")})`,
    w.reason] as const)];
  if (decided.length) {
    out.push(p.fixDecided(), "");
    for (const [qid, q, answer] of decided) {
      out.push(`- ${qid}: ${q}`, `  - Owner: "${answer.trim()}"`);
      const a = r.answers.find((x) => x.qid === qid);
      if (a?.disagree.length) {
        out.push(`  - Fails now: ${a.disagree.map((t) => `\`${placed(moved, null, t)}\``).join(", ")}`);
      } else if (qid.startsWith("R") && !(a && Object.values(a.keep).some((v) => v.size))) {
        out.push("  - No test was written for this rewrite; fix the bug as described and say that no test shows it.");
      } else if (a && !Object.values(a.keep).some((v) => v.size)) {
        out.push("  - No test was written for this answer (it does not settle the behaviour); do not change it.");
      }
    }
    out.push("");
  }

  const open = review.questions.map((q, i) => [`Q${i + 1}`, q] as const).filter(([qid]) => !(qid in marks.answers));
  if (open.length) {
    out.push("## Questions still open (do not decide these)", "");
    for (const [qid, q] of open) out.push(`- ${qid}: ${q}`);
    out.push("");
  }

  const leave = review.findings.filter((f) => marks.findings[f.id] === "intended" || marks.findings[f.id] === "noise");
  if (leave.length) {
    out.push("## Not bugs (leave the behaviour as it is)", "");
    for (const f of leave) out.push(`- ${f.id} (${marks.findings[f.id]}): ${f.explanation.split("\n")[0] || f.testId}`);
    out.push("");
  }
  // The repository's own text, named, so whoever reads the prompt knows it is not arnx's.
  const yours = p.overridden.filter((k) => !isModelKey(k));
  if (yours.length) out.push(`Taken from .arnx/prompts.toml instead of arnx's defaults: ${yours.join(", ")}.`, "");
  return out.join("\n");
}
