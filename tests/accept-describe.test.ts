// Tests inside describe blocks (and describe.each variants, whose names carry the block's parameter in brackets:
// "topup generated [memory] > S1: ..."): accept keeps and removes each test by its own full name, records it by that
// name, and check counts it so. Before, a JavaScript name was cut at its first "[", as pytest's parameters are, so
// every test of a describe.each block was recorded as the block ("topup generated ") and a noise finding's test there
// was neither skipped nor told apart from the real ones.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accept } from "../src/accept";
import { ACCEPTED_RECORD, check } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { baseName } from "../src/outcomes";
import { save } from "../src/report";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { gitRepo } from "./helpers/gitutil";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-22T00:00:00Z" };
const RID = "20261022-d35c01";
const TAG = "r20261022_d35c01";
const YAML = `
version: 1
projects:
  app:
    root: .
    language: typescript
    image: oven/bun:1
    runner: bun
    test_command: bun test {targets}
`;
const GEN = "__tests__/arnx_generated";

// The real case: one test body run for each store.
const EACH_SRC = [
  'import { describe, expect, test } from "bun:test";',
  "",
  'describe.each(["memory", "postgres"])("topup generated [%s]", (store) => {',
  '  test("S1: a top-up credits the balance once", () => {',
  "    expect(store.length).toBe(0);",
  "  });",
  '  test("S8/S14: a refund after a top-up", () => {',
  "    expect(store.length).toBe(0);",
  "  });",
  "});", ""].join("\n");
const PLAIN_SRC = [
  'import { describe, expect, test } from "bun:test";',
  "",
  'describe("topup generated", () => {',
  '  test("S2: a second top-up adds up", () => {',
  "    expect(1).toBe(2);",
  "  });",
  '  test("S9: a zero top-up", () => {',
  "    expect(1).toBe(2);",
  "  });",
  "});", ""].join("\n");

const EACH = `${GEN}/topup_each.test.ts`;
const PLAIN = `${GEN}/topup_plain.test.ts`;
const NAMES = {
  memS1: "topup generated [memory] > S1: a top-up credits the balance once",
  pgS1: "topup generated [postgres] > S1: a top-up credits the balance once",
  memS8: "topup generated [memory] > S8/S14: a refund after a top-up",
  pgS8: "topup generated [postgres] > S8/S14: a refund after a top-up",
  s2: "topup generated > S2: a second top-up adds up",
  s9: "topup generated > S9: a zero top-up",
};

/** A review with the six failing tests as findings; `oldFunc`: their func as an older arnx saved it (cut at "["). */
function setup(marks: Record<string, "real" | "noise">, oldFunc = false): { repo: string; rdir: string } {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(join(repo, "package.json"), '{ "name": "app" }\n');
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(YAML), "Dev", "2026-10-22"));
  const rdir = join(repo, ".arnx", "reviews", RID);
  const rows: [string, string, string][] = [["F1", EACH, NAMES.memS1], ["F2", EACH, NAMES.pgS1],
    ["F3", EACH, NAMES.memS8], ["F4", EACH, NAMES.pgS8], ["F5", PLAIN, NAMES.s2], ["F6", PLAIN, NAMES.s9]];
  const findings = rows.map(([id, file, name]) => ({ ...finding(id, `${file}::${name}`,
    oldFunc ? name.split("[")[0]! : baseName(name), file, "expected 0", file === EACH ? "topup each" : "topup plain",
    "confirmed", "y"),
  project: "app" }));
  save(sampleReview({ id: RID, findings, projects: ["app"], language: "typescript", questions: [],
    questionProjects: [], flaky: [], errors: [], notSent: [], writeDir: GEN, writeDirs: { app: GEN } }), rdir, "d");
  const dir = join(rdir, "projects", "app", "tests", GEN);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "topup_each.test.ts"), EACH_SRC);
  writeFileSync(join(dir, "topup_plain.test.ts"), PLAIN_SRC);
  // Tick each finding's mark, in review.md's order (F1 … F6).
  const parts = blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).split("Mark: [ ] real  [ ] intended  [ ] noise");
  expect(parts.length).toBe(7);
  const tick = (m: string) => m === "real" ? "Mark: [x] real  [ ] intended  [ ] noise"
    : "Mark: [ ] real  [ ] intended  [x] noise";
  writeFileSync(join(rdir, "review.md"), parts.map((p, i) => i === 0 ? p : tick(marks[`F${i}`]!) + p).join(""));
  return { repo, rdir };
}

const MARKS = { F1: "real", F2: "real", F3: "noise", F4: "noise", F5: "real", F6: "noise" } as const;
const keptEach = `__tests__/arnx/${TAG}/topup_each.test.ts`;
const keptPlain = `__tests__/arnx/${TAG}/topup_plain.test.ts`;

for (const oldFunc of [false, true]) {
  test(`accept removes a noise finding's test inside a describe block and records each kept test by its name${
    oldFunc ? " (a review saved by an older arnx)" : ""}`, async () => {
    const { repo, rdir } = setup(MARKS, oldFunc);
    const result = await accept(repo, rdir, SETTINGS);
    expect(result.kept.map((p) => p.slice(repo.length + 1)).sort()).toEqual([keptEach, keptPlain]);
    const each = readFileSync(join(repo, keptEach), "utf8");
    expect(each).not.toContain("S8/S14");
    // One line runs both variants, so the real bug's test there carries no expected-fail marker.
    expect(each).toContain('(store) => {\n  test("S1: a top-up credits the balance once"');
    const plain = readFileSync(join(repo, keptPlain), "utf8");
    expect(plain).not.toContain("S9");
    expect(plain).toContain(`  // arnx review ${RID}: F5 not fixed yet\n  test.todo("S2: a second top-up adds up"`);
    const rec = JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8"));
    expect(rec.files[keptEach].tests).toEqual([NAMES.memS1, NAMES.pgS1]);
    expect(rec.files[keptPlain].tests).toEqual([NAMES.s2]);
  });
}

test("a describe.each test kept for one variant is not skipped for the other", async () => {
  // [memory] S8 real, [postgres] S8 noise: the one source test runs both, and a real bug keeps its test.
  const { repo, rdir } = setup({ ...MARKS, F3: "real" });
  await accept(repo, rdir, SETTINGS);
  const each = readFileSync(join(repo, keptEach), "utf8");
  expect(each).not.toContain("test.skip(");
});

/** A fake bun run: the kept files' tests as bun's JUnit report names them, those still in the files. */
const bunRun = (repo: string): SessionFactory => async (_c, snap, _l, body) => body({
  run(command: string) {
    const out = /--reporter-outfile='?\/src\/([^\s']+)/.exec(command)![1]!;
    const suite = (file: string, cases: [string, string, boolean][]) => `<testsuite name="${file}" file="${file}">${
      cases.map(([d, t, skipped]) => `<testsuite name="${d}"><testcase name="${t}">${
        skipped ? "<skipped/>" : '<failure message="expected 0"/>'}</testcase></testsuite>`).join("")}</testsuite>`;
    const there = (file: string, cases: [string, string][]) => {
      const src = readFileSync(join(snap, file), "utf8");
      return cases.filter(([, t]) => src.includes(t)).map(([d, t]): [string, string, boolean] =>
        [d, t, src.includes(`test.skip("${t}"`)]);
    };
    const xml = `<testsuites>${suite(keptEach, there(keptEach, [
      ["topup generated [memory]", "S1: a top-up credits the balance once"],
      ["topup generated [memory]", "S8/S14: a refund after a top-up"],
      ["topup generated [postgres]", "S1: a top-up credits the balance once"],
      ["topup generated [postgres]", "S8/S14: a refund after a top-up"]]))}${suite(keptPlain, there(keptPlain, [
      ["topup generated", "S2: a second top-up adds up"],
      ["topup generated", "S9: a zero top-up"]]))}</testsuites>`;
    mkdirSync(dirname(join(snap, out)), { recursive: true });
    writeFileSync(join(snap, out), xml);
    return { exitCode: 1, output: "", timedOut: false, seconds: 0.1 };
  },
});

test("check counts the kept describe tests as accepted and the noise ones not at all", async () => {
  const { repo, rdir } = setup(MARKS);
  await accept(repo, rdir, SETTINGS);
  const [r] = await check(repo, SETTINGS, { sessionFactory: bunRun(repo) });
  expect(r!.skipped).toBe(0);
  expect(r!.accepted!.sort()).toEqual([`${keptEach}::${NAMES.memS1}`, `${keptEach}::${NAMES.pgS1}`,
    `${keptPlain}::${NAMES.s2}`]);
});

test("a test's parameters: pytest's are dropped, a bracket in a JavaScript title is kept", () => {
  expect(baseName("test_pay[0-1]")).toBe("test_pay");
  expect(baseName("test_pay[a[b]]")).toBe("test_pay");
  expect(baseName("TestPay::test_x[1]")).toBe("TestPay::test_x");
  expect(baseName("topup generated [memory] > S1: pays")).toBe("topup generated [memory] > S1: pays");
  expect(baseName("handles [x]")).toBe("handles [x]");
  expect(baseName("plain")).toBe("plain");
});
