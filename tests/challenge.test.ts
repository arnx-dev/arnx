import { expect, test } from "bun:test";
import { CHALLENGE_SCHEMA, challengeUser, explainUser, orderDiff } from "../src/prompts";
import { JUDGE_PROMPT, JUDGE_SCHEMA } from "../src/judgeprompt";
import { Boundary, maskedJson } from "../src/boundary";
import { applyOrigin, challenge, CONCURRENCY, GATES, inPool, settleVerdict } from "../src/challenge";
import { confirmed, exitCode, findingStatus, notChecked, sameTest } from "../src/report";
import { ModelError } from "../src/errors";
import { billedError, FallbackJson } from "../src/llm";
import { FakeJson, ScriptedAgent } from "./helpers/fakes";
import { LocalBrain } from "../src/localbrain";
import { toJudge } from "../src/reviewer";
import { finding, sampleReview } from "./helpers/review";
import type { Before, BeforeStatus } from "../src/before";

const f = (i: number) => finding(`F${i}`, `t.py::test_${i}`, `test_${i}`, "app/t.py", "assert 1 == 2", "why");

test("test_verdicts_and_budget", async () => {
  const model = new FakeJson([{ verdict: "confirmed", reason: " real " }, { verdict: "maybe", reason: "?" }], 0.05);
  const findings = [f(1), f(2), f(3)];
  const spent = await challenge(findings, { concurrency: 1, model, diff: "d", sources: { "app/t.py": "def test_1(): ..." },
    budgetUsd: 0.1 });
  expect(spent.costUsd).toBe(0.1);
  expect(spent.calls).toBe(2);
  expect([findings[0]!.verdict, findings[0]!.reason]).toEqual(["confirmed", "real"]);
  expect(findings[1]!.verdict).toBeNull();
  expect(findings[1]!.reason).toContain("unexpected verdict");
  expect(findings[2]!.verdict).toBeNull();
  expect(findings[2]!.reason).toContain("budget");
  expect(model.calls[0]).toContain("def test_1()");
});

test("test_model_error_leaves_finding_unchallenged", async () => {
  const findings = [f(1)];
  await challenge(findings, { model: new FakeJson([new ModelError("HTTP 500")]), diff: "d", sources: {}, budgetUsd: 1 });
  expect(findings[0]!.verdict).toBeNull();
  expect(findings[0]!.reason).toContain("HTTP 500");
});

test("the challenger is shown the review's questions and may say a finding depends on one", async () => {
  const model = new FakeJson([
    { verdict: "confirmed", reason: "r", depends_on: "Q2" },
    { verdict: "confirmed", reason: "r", depends_on: "Q9" }, // not a question in this review
    { verdict: "confirmed", reason: "r", depends_on: "" },
  ]);
  const findings = [f(1), f(2), f(3)];
  await challenge(findings, { model, diff: "d", sources: {}, budgetUsd: 1,
    questions: ["Unrelated?", "Should a negative threshold turn the alert off?"] });
  expect(findings.map((x) => x.dependsOn ?? null)).toEqual(["Q2", null, null]);
  expect(model.calls[0]).toContain("Q2: Should a negative threshold turn the alert off?");
});

test("without questions the challenger prompt is unchanged", async () => {
  const model = new FakeJson([{ verdict: "confirmed", reason: "r" }]);
  await challenge([f(1)], { model, diff: "d", sources: {}, budgetUsd: 1 });
  expect(model.calls[0]).not.toContain("Questions the reviewer asked");
});

test("a challenger call that failed after it was billed counts toward the cost and the budget", async () => {
  const model = new FakeJson([billedError("incomplete response", 0.3, { input: 900, output: 50, cacheRead: 0,
    cacheWrite: 0 }, 1), { verdict: "confirmed", reason: "r" }], 0.05);
  const findings = [f(1), f(2)];
  const spent = await challenge(findings, { concurrency: 1, model, diff: "d", sources: {}, budgetUsd: 0.2 });
  expect(spent).toEqual({ model: "openai:gpt-5.5-2026-04-23", calls: 1, unknownCalls: 1, input: 900, output: 50,
    cacheRead: 0, cacheWrite: 0, costUsd: 0.3 });
  expect(findings[0]!.reason).toContain("incomplete response");
  expect(findings[1]!.reason).toContain("budget"); // 0.3 spent of 0.2: the failed call used the budget
});

test("one timed-out call leaves only its finding unchecked; after two in a row the rest are skipped", async () => {
  const late = () => Object.assign(new ModelError("openai:gpt-5.5: no reply within 300s"), { timedOut: true });
  const model = new FakeJson([late(), { verdict: "confirmed", reason: "r" }, late(), late(),
    { verdict: "confirmed", reason: "never asked" }]);
  const findings = [f(1), f(2), f(3), f(4), f(5)];
  const lines: Record<string, unknown>[] = [];
  await challenge(findings, { concurrency: 1, model, diff: "d", sources: {}, budgetUsd: 1, trace: (l) => lines.push(l) });
  expect(model.calls).toHaveLength(4);
  expect(findings.map((x) => x.verdict)).toEqual([null, "confirmed", null, null, null]);
  expect(findings[4]!.reason).toBe("not challenged: the second model did not reply in time");
  expect(lines.map((l) => [l.finding, l.outcome])).toEqual([["F1", "error"], ["F2", "ok"], ["F3", "error"],
    ["F4", "error"], ["F5", "skipped"]]);
});

test("a non-timeout error between two timeouts resets the run, so the rest are still asked", async () => {
  const late = () => Object.assign(new ModelError("openai:gpt-5.5: no reply within 300s"), { timedOut: true });
  const model = new FakeJson([late(), new ModelError("HTTP 500: boom"), late(), { verdict: "confirmed", reason: "r" }]);
  const findings = [f(1), f(2), f(3), f(4)];
  await challenge(findings, { concurrency: 1, model, diff: "d", sources: {}, budgetUsd: 1 });
  expect(model.calls).toHaveLength(4);
  expect(findings.map((x) => x.verdict)).toEqual([null, null, null, "confirmed"]);
});

test("inPool rejects a limit that is not a positive integer", async () => {
  for (const limit of [0, -1, 1.5, NaN, Infinity]) {
    await expect(inPool([1], limit, async () => {})).rejects.toThrow(RangeError);
  }
});

test("inPool never runs more than the limit at once and runs every item", async () => {
  let inFlight = 0, most = 0;
  const done: number[] = [];
  await inPool([1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    done.push(n);
  });
  expect(most).toBe(3);
  expect(done.sort()).toEqual([1, 2, 3, 4, 5, 6, 7]);
});

test("with questions, a failure that may be a deliberate change waits for the owner's answer", () => {
  const u = challengeUser("d", "t.py", "src", "t.py::test_x", "fail", "e", ["Is dropping the link intended?"]);
  expect(u).toContain("Q1: Is dropping the link intended?");
  expect(u).toContain("do not dispute it: put that question's id in depends_on, so the finding waits for the " +
    "owner's answer.");
});

test("a fallback second opinion answers the findings the first model fails, and the report says which model", async () => {
  const late = Object.assign(new ModelError("myprovider:some-model: no reply within 300s"), { timedOut: true });
  const slow = new FakeJson([{ verdict: "confirmed", reason: "a" }, late], 0.001);
  slow.ref = "myprovider:some-model";
  const gpt = new FakeJson([{ verdict: "disputed", reason: "b" }], 0.02);
  gpt.ref = "openai:gpt-6.1-sol";
  const model = new FallbackJson(slow, gpt);
  const findings = [f(1), f(2)];
  await challenge(findings, { model, diff: "d", sources: {}, budgetUsd: 1 });
  expect(findings.map((x) => [x.verdict, x.judge])).toEqual([["confirmed", undefined],
    ["disputed", "openai:gpt-6.1-sol"]]);
  expect(model.uses.map((u) => [u.model, u.calls, u.costUsd])).toEqual([["myprovider:some-model", 1, 0.001],
    ["openai:gpt-6.1-sol", 1, 0.02]]);
});

test("second opinions run several at once", async () => {
  let inFlight = 0, most = 0;
  const model = new FakeJson([]);
  model.completeJson = async () => {
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return [{ verdict: "confirmed", reason: "r" }, 0.01];
  };
  const findings = Array.from({ length: CONCURRENCY + 4 }, (_, i) => f(i + 1));
  await challenge(findings, { model, diff: "d", sources: {}, budgetUsd: 5 });
  expect(most).toBe(CONCURRENCY);
  expect(findings.every((x) => x.verdict === "confirmed")).toBe(true);
});

const judged = (id: string, testId: string, verdict: string | null, reason: string) =>
  ({ ...finding(id, testId, "test_x", "app/t.py", "assert 1 == 2", "why"), verdict, reason });

test("the cases of one test are one test: its parameters are left out, its project is not", () => {
  const a = judged("F1", "t.py::test_x[a]", "confirmed", ""), b = judged("F2", "t.py::test_x[b]", "confirmed", "");
  expect(sameTest(a)).toBe(sameTest(b));
  expect(sameTest(a)).not.toBe(sameTest(judged("F3", "t.py::test_y[a]", "confirmed", "")));
  expect(sameTest(a)).not.toBe(sameTest({ ...a, project: "other" }));
});

const section = (path: string, size: number, mark = path) =>
  `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n+# ${mark}\n+${"x".repeat(size)}\n`;

test("the judge sees the file the suspect is in even when the diff is long", () => {
  const diff = section("src/a.py", 16_000) + section("src/b.py", 16_000) + section("src/pay.py", 2000);
  const u = challengeUser(diff, "tests/t.py", "def test_x(): ...", "tests/t.py::test_x", "fail", "e", [], "src/pay.py");
  expect(u).toContain("# src/pay.py");
  expect(u).toContain("src/a.py");
  expect(u).not.toContain("# src/b.py");
  expect(u).toContain("[1 more file changed: src/b.py; not shown]");
});

test("a long diff is ordered: the suspect's file, files the test names, other source, tests, then docs", () => {
  const diff = section("README.md", 100) + section("tests/test_k.py", 100) + section("src/other.py", 100) +
    section("src/billing.py", 100) + section("src/pay.py", 100);
  const out = orderDiff(diff, "src/pay.py", 450, "from src.billing import total");
  const at = (m: string) => out.indexOf(`# ${m}`);
  expect([at("src/pay.py"), at("src/billing.py")].every((n) => n >= 0)).toBe(true);
  expect(at("src/pay.py")).toBeLessThan(at("src/billing.py"));
  expect(out).toContain("more files changed: ");
  const whole = orderDiff(diff, "src/pay.py", 100_000, "");
  expect(whole).toBe(diff);
  const order = orderDiff(diff, "src/pay.py", 700, "from src.billing import total");
  const seen = ["src/pay.py", "src/billing.py", "src/other.py", "tests/test_k.py", "README.md"].map((m) => order.indexOf(`# ${m}`));
  expect(seen.slice(0, 3).every((n) => n >= 0)).toBe(true);
  expect(seen[0]!).toBeLessThan(seen[1]!);
  expect(seen[1]!).toBeLessThan(seen[2]!);
  expect(seen[4]!).toBe(-1);
});

test("a suspect's file longer than the limit is cut, not left out", () => {
  const out = orderDiff(section("src/a.py", 500) + section("src/big.py", 5000), "src/big.py", 1000);
  expect(out).toContain("# src/big.py");
  expect(out).toContain("[1 more file changed: src/a.py; not shown]");
});

test("a key that straddles the cut is masked before the diff is cut", async () => {
  const body = ["MIIEvQIBADAN", "BgkqhkiG9w0B", "AQEFAASCBKcw", "ggSjAgEAAoIB", "AQC7VJTUt9Us"].join("");
  const [dashes, kind] = ["-----", "PRIVATE " + "KEY"];
  const key = `${dashes}BEGIN ${kind}${dashes}\n${(body + "\n").repeat(30)}${dashes}END ${kind}${dashes}\n`;
  const diff = `diff --git a/src/k.py b/src/k.py\n--- a/src/k.py\n+++ b/src/k.py\n@@ -1 +1 @@\n+${"y".repeat(29_900)}\n` +
    key.split("\n").map((l) => `+${l}`).join("\n") + "\n";
  const inner = new FakeJson([{ verdict: "confirmed", reason: "r" }]);
  const model = maskedJson(inner, new Boundary());
  const findings = [f(1)];
  findings[0]!.suspect = "S1";
  await challenge(findings, { model, diff, sources: {}, budgetUsd: 1, suspectFile: () => "src/k.py" });
  expect(inner.calls[0]).not.toContain(body.slice(0, 20));
  expect(inner.calls[0]).toContain("[private key]");
});

test("the note on files shown elsewhere stays at the end of a long diff, after the footer", () => {
  const note = "This change also edits files not shown here (other projects): `x.py`. Their edits are not in the diff above: never conclude that something is missing.";
  const diff = section("src/a.py", 16_000) + section("src/b.py", 16_000) + section("src/pay.py", 2000) + `\n${note}\n`;
  const u = challengeUser(diff, "tests/t.py", "def test_x(): ...", "tests/t.py::test_x", "fail", "e", [], "src/pay.py");
  expect(u).toContain("not shown]\n\n" + note);
  const last = section("src/a.py", 16_000) + section("src/pay.py", 2000) + section("src/z.py", 16_000) + `\n${note}\n`;
  const v = challengeUser(last, "tests/t.py", "", "t", "fail", "e", [], "src/pay.py");
  expect(v).toContain("[1 more file changed: src/z.py; not shown]\n\n" + note);
  expect(orderDiff(section("src/a.py", 10) + `\n${note}\n`)).toBe(section("src/a.py", 10) + `\n${note}\n`);
});

test("the grouping call sees the diff ordered, with the same footer", () => {
  const diff = section("src/a.py", 20_000) + section("src/b.py", 20_000);
  const u = explainUser(diff, [{ id: "F1", testId: "t", message: "m", explanation: "", reason: "", verdict: null, file: "t.py" }],
    { "t.py": "from src.b import x" });
  expect(u).toContain("# src/b.py");
  expect(u).toContain("[1 more file changed: src/a.py; not shown]");
});

// ---- the structured reply and its gates (the "new" judge prompt, behind replay)

const PACK = (callers: string, extra = "") => ["## Commit message", "Parse dates in the importer", "",
  "## Target names", "- `parse` (function, app/p.py:3)", "", "## Callers", callers, "", "## Project tests",
  "`parse`: no project test found", "", "## Docs", "no doc found", extra].join("\n");
const NO_CALLER = PACK("`parse` (app/p.py:3): no caller found");
const P_DIFF = "diff --git a/app/p.py b/app/p.py\n--- a/app/p.py\n+++ b/app/p.py\n@@ -1 +1 @@\n-def parse(x): pass\n+def parse(x): return x\n" +
  "diff --git a/app/cli.py b/app/cli.py\n--- a/app/cli.py\n+++ b/app/cli.py\n@@ -10 +10 @@\n-    run()\n+    run(parse)\n";
const reply = (over: Record<string, unknown> = {}) => ({ caller: "none", input_from: "", intent: "", kind: "defect",
  origin: "this-change", verdict: "confirmed", reason: "it drops the year", depends_on: "", ...over });

test("a confirmation naming no findable caller becomes disputed as unreachable", () => {
  const s = settleVerdict(reply(), NO_CALLER, P_DIFF, []);
  expect([s.verdict, s.kind, s.gate]).toEqual(["disputed", "unreachable", "caller"]);
  expect(s.reason).toContain("`parse`");
});

test("a confirmation stays when the pack finds a decorator, an export, a string, a getattr or a config entry", () => {
  for (const callers of ["`parse` (app/p.py:3): no caller by name; exported",
    "`parse` (app/p.py:3): no caller by name; reached by its decorator `@app.route(\"/p\")`",
    "`parse` (app/p.py:3): no caller found\n- named in a string at app/r.py:4: REGISTRY = [\"parse\"]",
    "`parse` (app/p.py:3): no caller found\n- may be reached by `getattr` at app/r.py:9: getattr(mod, \"pa\" + x)",
    "`parse` (app/p.py:3): no caller found\n- named in setup.cfg:7: console_scripts = parse",
    "`parse` (app/p.py:3): 2 caller lines\n- app/cli.py:10 in `main`\n    run(parse)"]) {
    expect(settleVerdict(reply(), PACK(callers), P_DIFF, []).verdict).toBe("confirmed");
  }
});

test("a missed caller does not turn a confirmation into a dispute", () => {
  // The search stopped, some caller entries were left out, the test uses none of the changed definitions, or the
  // pack is missing: none of these says no caller exists.
  const stopped = PACK("`parse` (app/p.py:3): no caller found in the files read before the search stopped");
  const cut = PACK("`parse` (app/p.py:3): no caller found\n[2 more not shown]");
  const other = NO_CALLER.replace("## Target names\n", "## Target names\n(the test uses none of the changed definitions: these are the changed definitions of app/p.py)\n");
  const late = NO_CALLER + "\n\n(the search stopped at its time limit after 900 files: callers, tests and docs farther from the change may be missing)";
  for (const pack of [stopped, cut, other, late, ""]) expect(settleVerdict(reply(), pack, P_DIFF, []).verdict).toBe("confirmed");
  // The second opinion names a caller the diff shows, which the search by name did not find.
  expect(settleVerdict(reply({ caller: "app/cli.py:10 passes it to run()" }), NO_CALLER, P_DIFF, []).verdict).toBe("confirmed");
  // Naming the definition itself, or a test, is no caller.
  expect(settleVerdict(reply({ caller: "app/p.py:3" }), NO_CALLER, P_DIFF, []).verdict).toBe("disputed");
  expect(settleVerdict(reply({ caller: "tests/test_p.py:5" }), NO_CALLER, P_DIFF + "diff --git a/tests/test_p.py b/tests/test_p.py\n", []).verdict).toBe("disputed");
});

test("a confirmation citing documented intent becomes disputed as intended", () => {
  const s = settleVerdict(reply({ caller: "app/cli.py:10", intent: "docs/import.md:12 says two-digit years are kept as written" }),
    PACK("`parse` (app/p.py:3): 1 caller line"), P_DIFF, []);
  expect([s.verdict, s.kind, s.gate]).toEqual(["disputed", "intended", "intent"]);
  expect(s.reason).toContain("docs/import.md:12");
  for (const empty of ["", " ", "none", "None.", "n/a", "no evidence of intent", "not stated"]) {
    expect(settleVerdict(reply({ caller: "app/cli.py:10", intent: empty }), PACK("`parse` (app/p.py:3): 1 caller line"), P_DIFF, []).verdict)
      .toBe("confirmed");
  }
});

test("a confirmation that depends on a question is open and sets no exit code", () => {
  const s = settleVerdict(reply({ caller: "app/cli.py:10", depends_on: "Q1" }), PACK("`parse` (app/p.py:3): 1 caller line"),
    P_DIFF, ["Should a two-digit year be kept?"]);
  expect([s.verdict, s.dependsOn, s.gate]).toEqual(["open", "Q1", "question"]);
  const r = sampleReview({ findings: [{ ...f(1), verdict: s.verdict, dependsOn: s.dependsOn, reason: s.reason }] });
  expect(confirmed(r)).toHaveLength(0);
  expect(notChecked(r)).toHaveLength(0);
  expect(exitCode(r)).toBe(0);
  expect(findingStatus(r.findings[0]!)).toBe("waiting-on-answer");
});

test("open with no such question is disputed", () => {
  for (const dep of ["", "Q9", "maybe"]) {
    const s = settleVerdict(reply({ verdict: "open", depends_on: dep }), NO_CALLER, P_DIFF, ["One?"]);
    expect([s.verdict, s.kind, s.dependsOn ?? null]).toEqual(["disputed", "open-question", null]);
  }
  expect(settleVerdict(reply({ verdict: "open", depends_on: "Q1" }), NO_CALLER, P_DIFF, ["One?"]).verdict).toBe("open");
});

test("each gate has a replay switch", () => {
  const all = reply({ intent: "the docstring says so", depends_on: "Q1" });
  expect(settleVerdict(all, NO_CALLER, P_DIFF, ["One?"], new Set()).verdict).toBe("confirmed");
  expect(settleVerdict(all, NO_CALLER, P_DIFF, ["One?"], new Set(["intent"])).kind).toBe("intended");
  expect(settleVerdict(all, NO_CALLER, P_DIFF, ["One?"], new Set(["question"])).verdict).toBe("open");
  expect(settleVerdict(all, NO_CALLER, P_DIFF, ["One?"], new Set(["caller"])).kind).toBe("unreachable");
  expect([...GATES]).toEqual(["caller", "intent", "question"]);
});

test("a dispute keeps the kind the second opinion gave, and a reply outside the schema is not a verdict", () => {
  const s = settleVerdict(reply({ verdict: "disputed", kind: "bad-test", reason: "the test mocks the parser" }), NO_CALLER, P_DIFF, []);
  expect([s.verdict, s.kind, s.reason]).toEqual(["disputed", "bad-test", "the test mocks the parser"]);
  expect(settleVerdict(reply({ verdict: "disputed", kind: "defect" }), NO_CALLER, P_DIFF, []).kind).toBeUndefined();
  expect(settleVerdict(reply({ verdict: "maybe" }), NO_CALLER, P_DIFF, []).verdict).toBeNull();
  expect(settleVerdict(reply({ origin: "older" }), PACK("`parse` (app/p.py:3): 1 caller line"), P_DIFF, []).origin).toBe("older");
  expect(settleVerdict(reply({ origin: "sometime" }), NO_CALLER, P_DIFF, []).origin).toBeUndefined();
});

const before = (status: BeforeStatus, detail = "d"): Before => ({ status, detail, runs: ["failed"] });

test("the second opinion's origin demotes a regression it calls older or a new feature", () => {
  for (const origin of ["older", "new-feature"] as const) {
    const x = { ...f(1), before: before("regression", "passes on the code before the change (1 run), fails with it") };
    applyOrigin(x, origin, "the cap was there before");
    expect(x.before!.status).toBe("unknown");
    expect(x.before!.detail).toContain("the cap was there before");
  }
  for (const origin of ["this-change", "unclear", undefined] as const) {
    const x = { ...f(1), before: before("regression") };
    applyOrigin(x, origin, "r");
    expect(x.before!.status).toBe("regression");
  }
});

test("the second opinion can move a same-message failure to this change", async () => {
  const moved = { ...f(1), before: before("pre-existing", "fails with the same message on the code before the change (1 run)") };
  const kept = { ...f(2), before: before("pre-existing") };
  const added = { ...f(3), before: before("pre-existing") };
  const model = new FakeJson([reply({ caller: "app/cli.py:10" }), reply({ caller: "app/cli.py:10", origin: "older" }),
    reply({ caller: "app/cli.py:10", origin: "new-feature" })]);
  await challenge([moved, kept, added], { concurrency: 1, model, diff: P_DIFF, sources: {}, budgetUsd: 1, variant: "new",
    evidence: () => PACK("`parse` (app/p.py:3): 1 caller line") });
  expect([moved.before!.status, kept.before!.status, added.before!.status]).toEqual(["changed", "pre-existing", "new-code"]);
  expect(moved.before!.detail).toContain("fails with the same message there");
  expect(moved.before!.detail).not.toContain("did not cause");
  expect(exitCode(sampleReview({ findings: [moved] }), true)).toBe(1);
  expect(exitCode(sampleReview({ findings: [kept] }))).toBe(0);
});

test("no reply leaves a same-message failure pre-existing and exit code 0", async () => {
  const x = { ...f(1), before: before("pre-existing") };
  await challenge([x], { model: new FakeJson([new ModelError("HTTP 500")]), diff: P_DIFF, sources: {}, budgetUsd: 1, variant: "new" });
  expect(x.before!.status).toBe("pre-existing");
  expect(exitCode(sampleReview({ findings: [x] }))).toBe(0);
  // The current prompt asks no origin: a same-message failure is not moved by it.
  const y = { ...f(2), before: before("pre-existing") };
  await challenge([y], { model: new FakeJson([{ verdict: "confirmed", reason: "r", origin: "this-change" }]), diff: P_DIFF,
    sources: {}, budgetUsd: 1 });
  expect(y.before!.status).toBe("pre-existing");
});

test("the new prompt sends the evidence pack and asks for the structured reply, gated", async () => {
  const schemas: unknown[] = [];
  const model = new FakeJson([reply(), reply({ caller: "app/cli.py:10", verdict: "disputed", kind: "bad-test" }),
    reply({ caller: "app/cli.py:10", depends_on: "Q1" })]);
  const spy = { ref: model.ref, completeJson: (s: string, u: string, schema: Record<string, unknown>) => {
    schemas.push(schema);
    return model.completeJson(s, u);
  } };
  const findings = [f(1), f(2), f(3)];
  await challenge(findings, { concurrency: 1, model: spy, diff: P_DIFF, sources: {}, budgetUsd: 1, variant: "new",
    questions: ["Keep two-digit years?"], evidence: (x) => x.id === "F1" ? NO_CALLER : PACK("`parse` (app/p.py:3): 1 caller line") });
  expect(model.calls[0]).toContain("<evidence>\n" + NO_CALLER);
  expect(model.calls[0]).toContain("If you cannot name a caller, do not confirm.");
  expect(model.calls[0]).not.toContain("do not dispute it");
  expect(model.calls[2]).toContain("Q1: Keep two-digit years?");
  expect(schemas[0]).toBe(JUDGE_SCHEMA);
  expect(Object.keys((JUDGE_SCHEMA as { properties: object }).properties)).toEqual(["caller", "input_from", "intent", "kind",
    "origin", "verdict", "reason", "depends_on"]);
  expect(findings.map((x) => [x.verdict, x.disputeKind ?? null, x.dependsOn ?? null])).toEqual([["disputed", "unreachable", null],
    ["disputed", "bad-test", null], ["open", null, "Q1"]]);
  // Without a pack the prompt says none was built, and no gate reads one.
  const lone = new FakeJson([reply()]);
  const y = [f(4)];
  await challenge(y, { model: lone, diff: P_DIFF, sources: {}, budgetUsd: 1, variant: "new" });
  expect(lone.calls[0]).toContain("(no evidence pack");
  expect(y[0]!.verdict).toBe("confirmed");
});

test("the current prompt is today's: same text, same schema, two verdicts", async () => {
  const schemas: unknown[] = [];
  const model = new FakeJson([{ verdict: "confirmed", reason: "r", depends_on: "Q1" }]);
  const spy = { ref: model.ref, completeJson: (s: string, u: string, schema: Record<string, unknown>) => {
    schemas.push(schema);
    return model.completeJson(s, u);
  } };
  const x = [f(1)];
  await challenge(x, { model: spy, diff: "d", sources: {}, budgetUsd: 1, questions: ["One?"], evidence: () => NO_CALLER });
  expect(schemas[0]).toBe(CHALLENGE_SCHEMA);
  expect(model.calls[0]).not.toContain("<evidence>");
  expect([x[0]!.verdict, x[0]!.dependsOn]).toEqual(["confirmed", "Q1"]);
  expect(JUDGE_PROMPT).toBe("current");
});

test("same-message failures go to a local judge that asks their origin, and the rest of judging is as before", async () => {
  const same = { ...f(1), before: before("pre-existing") };
  const other = { ...f(2), before: before("regression") };
  const brain = (judge?: "current" | "new") => new LocalBrain({ agentModel: new ScriptedAgent([]), prices: {},
    challenger: new FakeJson([]), ...(judge ? { judge } : {}) });
  expect(brain().judgesOrigin).toBe(false);
  expect(brain("new").judgesOrigin).toBe(true);
  expect(toJudge([same, other], brain()).map((x) => x.id)).toEqual(["F2"]);
  expect(toJudge([same, other], brain("new")).map((x) => x.id)).toEqual(["F1", "F2"]);
  // A same-message failure the judge leaves older is not grouped with the change's findings.
  const model = new FakeJson([reply({ caller: "app/cli.py:10", origin: "older" }), reply({ caller: "app/cli.py:10" }),
    { groups: [{ findings: ["F2"], title: "t", input: "", actual: "", expected: "", consequence: "", severity: "low" }] }]);
  const local = new LocalBrain({ agentModel: new ScriptedAgent([]), prices: {}, challenger: model, judge: "new" });
  await local.judge([same, other], [], {}, { diff: P_DIFF, sources: {}, maxQuestions: 3, budgetLeft: () => 1, trace: () => {},
    evidence: () => PACK("`parse` (app/p.py:3): 1 caller line"), suspectFile: () => undefined });
  expect(same.before!.status).toBe("pre-existing");
  expect(model.calls[2]).not.toContain(`<finding id="F1">`);
  expect(model.calls[2]).toContain(`<finding id="F2">`);
});
