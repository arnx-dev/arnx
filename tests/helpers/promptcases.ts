// Every prompt arnx builds, on fixed inputs: tests/prompts-frozen.test.ts holds them to the text arnx 0.1.2 built
// (tests/fixtures/prompts-0.1.2.json), whatever file the templates live in.
import { parseReviewConfig, parseReviewFile } from "../../src/config";
import { fixPrompt } from "../../src/fixprompt";
import * as P from "../../src/prompts";
import { sampleReview } from "./review";
import { GOOD, PROJECTS, ROUND_CFG } from "./yaml";

const TS = `
version: 1
projects:
  web:
    root: web
    language: typescript
    runner: vitest
    image: node:22-slim
    test_command: npx vitest run {targets}
  core:
    root: core
    language: rust
    runner: nextest
    image: rust:1-slim
    test_command: cargo nextest run {targets}
`;

const SUSPECTS: P.Suspect[] = [
  { id: "S1", file: "app/pay.py", line: 12, claim: "rounds $0.005 down", why: "uses int()", input: "0.005",
    expected: "0.01", actual: "0.00", by: "reviewer" },
  { id: "S2", file: "app/db.py", line: 3, claim: "no commit", why: "", input: "", expected: "", actual: "",
    by: "second" },
];

/** Name -> the prompt built from `p` (default: arnx's own prompts). */
export function promptCases(p: P.Prompts = P.DEFAULT_PROMPTS): Record<string, string> {
  const round = parseReviewConfig(ROUND_CFG);
  const good = parseReviewConfig(GOOD);
  const pay = parseReviewFile(PROJECTS).projects[0]!;
  const [web, core] = parseReviewFile(TS).projects as [typeof pay, typeof pay];
  const diff = "diff --git a/x b/x\n+$weird {braces} $diff\n";
  const big = "+" + "x".repeat(P.DIFF_LIMIT + 10) + "\n";
  const scope = { owned: ["services/pay/a.py"], used: ["services/shared/s.py"] };
  const out: Record<string, string> = {};
  for (const [name, cfg] of [["round", round], ["good", good], ["pay", pay], ["web", web], ["core", core]] as const) {
    out[`reviewSystem/${name}`] = p.reviewSystem(cfg);
    out[`reviewSystem/${name}/env`] = p.reviewSystem(cfg, ["tests/test_db.py"]);
    out[`reviewTask/${name}`] = p.reviewTask(cfg, diff, 5);
    out[`reviewTask/${name}/scope`] = p.reviewTask(cfg, diff, 3, scope);
    out[`huntTask/${name}`] = p.huntTask(cfg, diff, "app/x.py:3: foo()");
    out[`huntTask/${name}/scope`] = p.huntTask(cfg, diff, "", scope);
    out[`secondHuntTask/${name}`] = p.secondHuntTask(cfg, diff, "ctx", "def foo(): $x", scope);
    out[`secondHuntTask/${name}/nodefs`] = p.secondHuntTask(cfg, diff, "", "");
    out[`proveTask/${name}`] = p.proveTask(cfg, SUSPECTS, 4);
    out[`proveTask/${name}/none`] = p.proveTask(cfg, [], 4);
    out[`answerTask/${name}`] = p.answerTask(cfg, "Should X be $1?", "Yes, $answer.", diff);
  }
  out["reviewTask/big"] = p.reviewTask(round, big, 5);
  out["coverageTask/files"] = p.coverageTask(["a.py", "b.py"]);
  out["coverageTask/db"] = p.coverageTask([], { files: ["db.py"], names: ["DATABASE_URL"] });
  out["coverageTask/both"] = p.coverageTask(["a.py"], { files: ["db.py"], names: ["DATABASE_URL", "PGHOST"] });
  out["coverageTask/none"] = p.coverageTask([]);
  out["huntSystem"] = p.huntSystem();
  out["askedTask"] = p.askedTask(["Is $5 the limit?", "Q2"]);
  out["askedTask/none"] = p.askedTask([]);
  out["mergeSystem"] = p.mergeSystem();
  out["mergeTask"] = p.mergeTask(["Is it A?", "Is it really A?", "B?"]);
  out["untestedSuspectsTask"] = p.untestedSuspectsTask([{ id: "S1" }, { id: "S2", reason: "needs $NET" }]);
  out["rankSystem"] = p.rankSystem();
  out["rankTask"] = p.rankTask(SUSPECTS);
  out["setupSystem"] = p.setupSystem();
  out["setupTask"] = p.setupTask("Found: python (pyproject.toml), $HOME");
  out["challengeSystem"] = p.challengeSystem();
  out["challengeUser"] = p.challengeUser(diff, "app/t.py", "def test_1(): ...", "t.py::test_1", "assert 1 == 2", "");
  out["challengeUser/questions"] = p.challengeUser(big, "t.py", "x".repeat(50_000), "t.py::t", "y".repeat(5000),
    "off by one", ["Q one?", "Q two?"]);
  out["explainSystem"] = p.explainSystem();
  out["explainUser"] = P.explainUser(diff, [{ id: "F1", testId: "t.py::a", message: "boom", explanation: "",
    reason: "r", verdict: "confirmed", file: "t.py" }, { id: "F2", testId: "t.py::b", message: "m", explanation: "e",
    reason: "", verdict: null, file: null }], { "t.py": "def test_a(): ..." });
  // The fix prompt: what accept hands the owner's coding agent.
  const review = sampleReview({ questions: ["Should invites expire?", "Who may invite?"],
    groups: [{ findings: ["F1"], title: "Any member can invite", input: "a member invites", actual: "invited",
      expected: "refused", consequence: "anyone can add people" }] });
  out["fixPrompt"] = fixPrompt({ review, marks: { findings: { F1: "real", F2: "noise" }, severity: { F1: "high" },
    answers: { Q1: "yes, after $7 days" } },
  answers: [{ qid: "Q1", files: {}, keep: { "app/tests/g/answers/test_expiry.py": new Set(["test_expires"]) },
    skip: {}, disagree: ["tests/g/answers/test_expiry.py::test_expires"], costUsd: 0.1, stop: "end_turn", base: "" }],
  moved: { "app/tests/g/test_i.py": "app/tests/arnx/r1/g/test_1_i.py" } }, undefined, p);
  out["fixPrompt/empty"] = fixPrompt({ review: sampleReview({ findings: [], change: "uncommitted ($HOME)" }),
    marks: { findings: {}, severity: {}, answers: {} }, answers: [], moved: {} }, undefined, p);
  out["PROMPT_VERSION"] = P.PROMPT_VERSION;
  return out;
}
