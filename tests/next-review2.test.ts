// Tests arnx wrote when it reviewed its own triage and issue marks (review 20261022-183834), kept as accepted.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { applyMarks, markInteractive, type Key } from "../src/mark";
import { whatNext } from "../src/next";
import { parseMarks, render, save } from "../src/report";
import { defaultSettings, writeSettings } from "../src/settings";
import { commit, gitRepo } from "./helpers/gitutil";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = "version: 1\nprojects:\n  svc:\n    root: svc\n    image: python:3.12-slim\n    test_command: pytest {targets}\n";
const g = (findings: string[], title: string, severity: "high" | "medium" | "low" = "high") =>
  ({ findings, title, input: "", actual: "", expected: "", consequence: "", severity });
const PLAIN: any = new Proxy({}, { get: () => (s: string) => s });
const keys = (ks: Key[]): AsyncIterator<Key> => {
  let i = 0;
  return { next: async () => (i < ks.length ? { value: ks[i++]!, done: false } : { value: undefined, done: true }) } as any;
};

test("S5 per-finding override survives a save through applyMarks", () => {
  const r = sampleReview({ flaky: [], questions: [], questionProjects: [], findings: [
    finding("F1", "t::a", "a", "t.js", "x", "", "confirmed", "y"),
    finding("F2", "t::b", "b", "t.js", "x", "", "confirmed", "y")], groups: [g(["F1", "F2"], "both")] });
  const md = render(r).replace("- Test: `t::b`", "Mark: [ ] real  [ ] intended  [x] noise\n- Test: `t::b`");
  const marks = parseMarks(md, ["F1", "F2"]);
  expect(marks.findings).toEqual({ F1: "real", F2: "noise" });
  const saved = applyMarks(md, marks);
  expect(parseMarks(saved, ["F1", "F2"]).findings).toEqual({ F1: "real", F2: "noise" });
});

test("S9 triage marks every finding of a grouped review, pre-existing ones too", async () => {
  const pre = { ...finding("F3", "t::c", "c", "t.js", "x", "", "confirmed", "y"),
    before: { status: "pre-existing", detail: "d", runs: ["failed", "failed", "failed"] } } as any;
  const r = sampleReview({ flaky: [], questions: [], questionProjects: [], findings: [
    finding("F1", "t::a", "a", "t.js", "x", "", "confirmed", "y"),
    finding("F2", "t::b", "b", "t.js", "x", "", "disputed", "m"), pre],
  groups: [g(["F1", "F2", "F3"], "all")] });
  const md = render(r);
  const res = await markInteractive(r, md, { paint: PLAIN, width: 80, draw: () => {},
    keys: keys(["enter", "enter", "enter", "enter", "enter", "enter"]) });
  expect(Object.keys(res!.findings).sort()).toEqual(["F1", "F2", "F3"]);
  for (const id of ["F1", "F2", "F3"]) expect(res!.findings[id]).not.toBeUndefined();
});

function approvedWithReview(reviewJson?: string): { repo: string; rdir: string } {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc"));
  writeFileSync(join(repo, "svc/a.py"), "X = 1\n");
  commit(repo, "a");
  writeSettings(repo, { ...defaultSettings(), consentAt: "2026-10-14T00:00:00Z" });
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(YAML), "Dev", "2026-10-14"));
  writeFileSync(join(repo, "svc/a.py"), "X = 2\n");
  const rdir = join(repo, ".arnx/reviews/20261014-abcdef");
  mkdirSync(rdir, { recursive: true });
  writeFileSync(join(rdir, "state.json"), "{}\n");
  if (reviewJson !== undefined) writeFileSync(join(rdir, "review.json"), reviewJson);
  return { repo, rdir };
}

test("S8 next with an unreadable review.json still answers (triage) instead of throwing", () => {
  const { repo } = approvedWithReview("{ not json");
  let n: any;
  expect(() => { n = whatNext(repo); }).not.toThrow();
  expect(n.command).toContain("arnx triage");
});

test("next sends a settled grouped review straight to accept", () => {
  const { repo, rdir } = approvedWithReview();
  const r = sampleReview({ id: "20261014-abcdef", flaky: [], questions: [], questionProjects: [],
    findings: [finding("F1", "t::a", "a", "t.js", "x", "", "confirmed", "y")], groups: [g(["F1"], "one")] });
  save(r, rdir, "d");
  expect(whatNext(repo).command).toBe("arnx accept 20261014-abcdef");
});

test("next says when the latest review stopped at its budget", () => {
  const { repo, rdir } = approvedWithReview();
  const r = sampleReview({ id: "20261014-abcdef", flaky: [], questions: [], questionProjects: [],
    findings: [finding("F1", "t::a", "a", "t.js", "x", "", "confirmed", "y")], groups: [g(["F1"], "one")],
    projectStats: [{ name: "svc", stop: "budget" }] } as any);
  save(r, rdir, "d");
  expect(whatNext(repo).note).toContain("it stopped at its budget");
});
