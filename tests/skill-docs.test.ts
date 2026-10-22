// The JSON a coding agent reads is pinned by its documentation: skills/arnx/references/review-json.md and
// check-json.md. A documented field that review.json or `check --json` stops writing fails here, and so does a field
// they write that the page does not name.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CHANGES, type ChangedTest, checkJson, checkSummary, type ProjectCheck } from "../src/check";
import { type ReviewRecheck, recheckJson } from "../src/recheck";
import { FIX_STATUSES } from "../src/before";
import { type Review, save } from "../src/report";
import { TYPECHECK_BEFORE, TYPECHECK_STATUSES } from "../src/typecheck";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const REFS = join(import.meta.dir, "..", "skills", "arnx", "references");
const GOLDEN = join(import.meta.dir, "fixtures", "golden");

interface Field { name: string; optional: boolean }

/** The fields in the table under each `## ` heading: `| \`name\` | type | meaning |`; "Optional" opens the meaning
 * of a field that may be absent. */
function tables(page: string): Record<string, Field[]> {
  const out: Record<string, Field[]> = {};
  let section = "";
  for (const line of readFileSync(join(REFS, page), "utf8").split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3).trim();
    const m = /^\| `([a-z_]+)` \| [^|]+ \| (.*) \|$/.exec(line);
    if (m && section) (out[section] ??= []).push({ name: m[1]!, optional: m[2]!.startsWith("Optional") });
  }
  return out;
}

/** Every name the page puts in backticks: what it documents, in a table or in prose. */
const named = (page: string) => new Set([...readFileSync(join(REFS, page), "utf8").matchAll(/`([a-z_]+)`/g)]
  .map((m) => m[1]!));

const missing = (o: object, fields: Field[], all: boolean) =>
  fields.filter((f) => (all || !f.optional) && !(f.name in o)).map((f) => f.name);

/** review.json as runReview writes it: the neutral goldens (tests/neutral.test.ts holds them to a real review). */
const written = () => ["hunt", "plain"].map((n) =>
  JSON.parse(readFileSync(join(GOLDEN, `neutral-${n}.review.json`), "utf8")) as Record<string, unknown>);

/** A review with every optional field filled, saved and read back as JSON. */
function full(): Record<string, unknown> {
  const f = finding("F1", "tests/g/test_a.py::test_a", "test_a", "tests/g/test_a.py", "assert 1 == 2", "off by one",
    "confirmed", "yes");
  const r: Review = sampleReview({ findings: [{ ...f, dependsOn: "Q1", suspect: "S1", judge: "openai:x", shallow: "existence",
    before: { status: "regression", detail: "passes before", runs: ["passed", "passed", "passed"] } }],
  groups: [{ findings: ["F1"], title: "t", input: "i", actual: "a", expected: "e", consequence: "c", severity: "high" }],
  untested: [{ project: "main", files: ["a.py"], of: 2 }],
  // Never both in one review (one is opted in, the other not); here only to see each written.
  untrackedIncluded: ["notes.md"], untrackedLeftOut: 1,
  usage: [{ model: "anthropic:m", calls: 1, unknownCalls: 0, input: 1, output: 1, cacheRead: 0, cacheWrite: 0,
    costUsd: 0.1 }] as Review["usage"],
  fixProof: [{ testId: "tests/g/test_a.py::test_b", project: "main", file: "tests/g/test_a.py", beforeStatus: "fixed",
    beforeRuns: ["failed", "failed", "failed"], beforeDetail: "fails before" }],
  // `output` comes only with a check that failed or timed out; here only to see every field written.
  typecheck: [{ project: "main", command: "npx tsc --noEmit", status: "errors", errors: 1, inChangedFiles: 1, new: 1,
    preExisting: 0, before: "compared", diagnostics: [{ file: "a.ts", line: 1, column: 2, code: "TS2322",
      message: "m", changed: true, new: true }], output: "a.ts(1,2): error TS2322: m", secs: 1 }],
  // `key` comes only with a refused key; here only to see every field written.
  providerFailures: [{ provider: "myprovider", name: "myprovider (llm.example.com)", kind: "auth", detail: "HTTP 401",
    calls: 2, failed: 2, attempts: 2, roles: ["challenge"], missing: ["challenge"], key: "MY_PROVIDER_KEY" }] });
  save(r, tmp(), "");
  return JSON.parse(readFileSync(join(tmp(), "review.json"), "utf8"));
}

const T = () => tables("review-json.md");

test("review-json.md documents the four tables this test reads", () => {
  expect(Object.keys(T())).toEqual(["Top level", "Each finding", "Each group", "Each usage entry", "Each fix proof",
    "Each type check", "Each provider failure"]);
  expect(T()["Top level"]!.length).toBeGreaterThan(20);
});

test("a review writes every documented field that is not optional", () => {
  for (const json of [...written(), full()]) {
    expect(missing(json, T()["Top level"]!, false)).toEqual([]);
    for (const f of json.findings as object[]) expect(missing(f, T()["Each finding"]!, false)).toEqual([]);
    for (const u of json.usage as object[]) expect(missing(u, T()["Each usage entry"]!, false)).toEqual([]);
  }
});

test("every documented field, optional ones too, is written where it applies", () => {
  const json = full();
  expect(missing(json, T()["Top level"]!, true)).toEqual([]);
  expect(missing((json.findings as object[])[0]!, T()["Each finding"]!, true)).toEqual([]);
  expect(missing((json.groups as object[])[0]!, T()["Each group"]!, true)).toEqual([]);
  expect(missing((json.usage as object[])[0]!, T()["Each usage entry"]!, true)).toEqual([]);
  expect(missing((json.fix_proof as object[])[0]!, T()["Each fix proof"]!, true)).toEqual([]);
  expect(missing((json.typecheck as object[])[0]!, T()["Each type check"]!, true)).toEqual([]);
  expect(missing((json.provider_failures as object[])[0]!, T()["Each provider failure"]!, true)).toEqual([]);
});

test("every field a review writes is named in review-json.md", () => {
  const doc = named("review-json.md");
  for (const json of [...written(), full()]) {
    expect(Object.keys(json).filter((k) => !doc.has(k))).toEqual([]);
    for (const f of json.findings as object[]) expect(Object.keys(f).filter((k) => !doc.has(k))).toEqual([]);
    for (const u of json.usage as object[]) expect(Object.keys(u).filter((k) => !doc.has(k))).toEqual([]);
    for (const x of (json.fix_proof ?? []) as object[]) expect(Object.keys(x).filter((k) => !doc.has(k))).toEqual([]);
    for (const x of (json.provider_failures ?? []) as object[]) {
      expect(Object.keys(x).filter((k) => !doc.has(k))).toEqual([]);
    }
    for (const t of (json.typecheck ?? []) as { diagnostics: object[] }[]) {
      expect(Object.keys(t).filter((k) => !doc.has(k))).toEqual([]);
      for (const d of t.diagnostics) expect(Object.keys(d).filter((k) => !doc.has(k))).toEqual([]);
    }
  }
});

test("review-json.md names each finding status review.json can write", () => {
  const doc = readFileSync(join(REFS, "review-json.md"), "utf8");
  for (const s of ["confirmed", "disputed", "waiting-on-answer", "pre-existing"]) expect(doc).toContain(`\`${s}\``);
});

test("review-json.md names each type-check status and comparison review.json can write", () => {
  const doc = readFileSync(join(REFS, "review-json.md"), "utf8");
  for (const s of [...TYPECHECK_STATUSES, ...TYPECHECK_BEFORE]) expect(doc).toContain(`\`${s}\``);
});

test("review-json.md names each fix-proof status review.json can write", () => {
  const doc = readFileSync(join(REFS, "review-json.md"), "utf8");
  for (const s of FIX_STATUSES) expect(doc).toContain(`\`${s}\``);
});

// --- check --json -----------------------------------------------------------------------------------------------------

const project: ProjectCheck = { project: "svc", files: ["svc/tests/arnx/r1/test_x.py"], passed: ["a"], skipped: 1,
  noReport: false, failed: [{ testId: "t::b", fileAttr: "", name: "b", outcome: "failed", message: "assert 0" }] };
const changed: ChangedTest[] = [{ path: "tests/arnx/r1/test_x.py", review: "r1", change: "modified" }];

test("check --json writes every field check-json.md documents, and nothing it does not", () => {
  const C = tables("check-json.md");
  expect(Object.keys(C)).toEqual(["Fields", "Each project", "Each failed test", "Each changed file", "Results",
    "With --review", "Each rechecked finding", "Results with --review"]);
  const doc = named("check-json.md");
  const undocumented = (o: object) => Object.keys(o).filter((k) => !doc.has(k));
  for (const json of [checkJson([project], checkSummary([project])[1]), checkJson([], 4, changed)]) {
    const j = JSON.parse(json);
    expect(missing(j, C.Fields!, true)).toEqual([]);
    expect(undocumented(j)).toEqual([]);
    for (const p of j.projects) {
      expect(missing(p, C["Each project"]!, true)).toEqual([]);
      expect(undocumented(p)).toEqual([]);
      for (const t of p.failed) {
        expect(missing(t, C["Each failed test"]!, true)).toEqual([]);
        expect(undocumented(t)).toEqual([]);
      }
    }
    for (const c of j.changed) {
      expect(missing(c, C["Each changed file"]!, true)).toEqual([]);
      expect(undocumented(c)).toEqual([]);
    }
  }
  expect(JSON.parse(checkJson([project], 1)).projects).toHaveLength(1);
  // Every kind of change check reports is named in the `change` row.
  const row = readFileSync(join(REFS, "check-json.md"), "utf8").split("\n").find((l) => l.startsWith("| `change` |"))!;
  expect(CHANGES.filter((c) => !row.includes(`\`${c}\``))).toEqual([]);
});

test("check --json results match exit codes as check-json.md says", () => {
  const doc = readFileSync(join(REFS, "check-json.md"), "utf8");
  const part = doc.slice(doc.indexOf("## Results\n"), doc.indexOf("## With --review"));
  const rows = [...part.matchAll(/^\| `([a-z-]+)` \| (\d) \|/gm)].map((m) => [m[1], Number(m[2])]);
  expect(rows).toEqual([["pass", 0], ["fail", 1], ["no-report", 2], ["nothing-accepted", 3], ["tests-changed", 4]]);
  for (const [result, code] of rows) {
    expect(JSON.parse(checkJson([], code as number, code === 4 ? changed : [])).result).toBe(result);
  }
  expect(checkSummary([])[1]).toBe(3);
  expect(checkSummary([{ ...project, failed: [] }])[1]).toBe(0);
  expect(checkSummary([{ ...project, noReport: true }])[1]).toBe(2);
});

// --- check --review --json --------------------------------------------------------------------------------------------

const rechecked: ReviewRecheck = { review: "r1", findings: [
  { id: "F1", project: "svc", testId: "t::a", status: "fixed", runs: ["passed", "passed", "passed"], message: "" },
  { id: "F2", project: "svc", testId: "t::b", status: "still-failing", runs: ["failed"], message: "assert 0" }] };

test("check --review --json writes every field check-json.md documents for it, and nothing it does not", () => {
  const C = tables("check-json.md");
  const doc = named("check-json.md");
  const undocumented = (o: object) => Object.keys(o).filter((k) => !doc.has(k));
  for (const r of [rechecked, { review: "r1", findings: [] }]) {
    const j = JSON.parse(recheckJson(r));
    expect(missing(j, C["With --review"]!, true)).toEqual([]);
    expect(undocumented(j)).toEqual([]);
    for (const f of j.findings) {
      expect(missing(f, C["Each rechecked finding"]!, true)).toEqual([]);
      expect(undocumented(f)).toEqual([]);
    }
  }
});

test("check --review --json results match exit codes as check-json.md says", () => {
  const doc = readFileSync(join(REFS, "check-json.md"), "utf8");
  const part = doc.slice(doc.indexOf("## Results with --review"));
  const rows = [...part.matchAll(/^\| `([a-z-]+)` \| (\d) \|/gm)].map((m) => [m[1], Number(m[2])]);
  expect(rows).toEqual([["pass", 0], ["fail", 1], ["no-report", 2], ["nothing-confirmed", 0]]);
  const one = (status: "fixed" | "still-failing" | "no-report") =>
    JSON.parse(recheckJson({ review: "r", findings: [{ ...rechecked.findings[0]!, status }] }));
  expect([one("fixed"), one("still-failing"), one("no-report"), JSON.parse(recheckJson({ review: "r", findings: [] }))]
    .map((j) => [j.result, j.exit_code])).toEqual(rows);
  for (const s of ["fixed", "still-failing", "no-report"]) expect(doc).toContain(`\`${s}\``);
});
