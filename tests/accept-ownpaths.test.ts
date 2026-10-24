// A kept test that builds a path from its own folder (import.meta.dir, import.meta.dirname, __dirname,
// dirname(fileURLToPath(import.meta.url))) still reaches the same file after accept moves it from
// __tests__/arnx_generated/ to __tests__/arnx/r<id>/. Seen on a real review: a passing test read
// join(import.meta.dir, "..", "..", "package.json") and failed in arnx check with ENOENT on /src/__tests__/package.json.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accept } from "../src/accept";
import { relocate } from "../src/adapters/typescript";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { save } from "../src/report";
import { defaultSettings } from "../src/settings";
import { gitRepo } from "./helpers/gitutil";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-22T00:00:00Z" };
const RID = "20261022-0a1b2c";
const GEN = "__tests__/arnx_generated";
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
const SRC = [
  'import { expect, test } from "bun:test";',
  'import { readFileSync } from "node:fs";',
  'import { join } from "node:path";',
  "",
  'test("the package is named", () => {',
  '  const pkg = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "package.json"), "utf8"));',
  '  expect(pkg.name).toBe("app");',
  "});",
  'test("the bug", () => {',
  "  expect(1).toBe(2);",
  "});", ""].join("\n");

test("a kept test reading package.json through import.meta.dir still finds it after the move", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(join(repo, "package.json"), '{ "name": "app" }\n');
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(YAML), "Dev", "2026-10-22"));
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(sampleReview({ id: RID, findings: [{ ...finding("F1", `${GEN}/pkg.test.ts::the bug`, "the bug",
    `${GEN}/pkg.test.ts`, "expected 2", "pkg wrong", "confirmed", "y"), project: "app" }], projects: ["app"],
  language: "typescript", questions: [], questionProjects: [], flaky: [], errors: [], notSent: [], writeDir: GEN,
  writeDirs: { app: GEN } }), rdir, "d");
  mkdirSync(join(rdir, "projects", "app", "tests", GEN), { recursive: true });
  writeFileSync(join(rdir, "projects", "app", "tests", GEN, "pkg.test.ts"), SRC);
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8"))
    .replace("Mark: [ ] real", "Mark: [x] real"));
  const result = await accept(repo, rdir, SETTINGS);
  const kept = join(repo, ".arnx", "tests", "__tests__", "arnx", "r20261022_0a1b2c", "pkg_wrong.test.ts");
  expect(result.kept).toEqual([kept]);
  expect(readFileSync(kept, "utf8")).toContain('join(import.meta.dir, "../../../package.json")');
  // Run from the path it runs from (where check puts it): the helper test passes, and the bug's test fails until it is
  // fixed.
  const at = join(repo, "__tests__", "arnx", "r20261022_0a1b2c", "pkg_wrong.test.ts");
  mkdirSync(dirname(at), { recursive: true });
  copyFileSync(kept, at);
  const run = spawnSync(process.execPath, ["test", at], { cwd: repo, encoding: "utf8" });
  const out = run.stdout + run.stderr;
  expect(out).toContain(" 1 pass\n 1 fail\n");
  expect(out).not.toContain("ENOENT");
});

test("paths from the file's own folder, in each spelling, move with it; anything else is left alone", () => {
  const from = "__tests__/arnx_generated", to = "__tests__/arnx/r1";
  const moved = [
    'join(import.meta.dir, "..", "..", "package.json")',
    'path.join(import.meta.dirname, "../schema.sql")',
    'resolve(__dirname, "..", "..", "package.json")',
    'path.resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json")',
    'join(path.dirname(url.fileURLToPath(import.meta.url)), "..", name)',
  ];
  expect(moved.map((s) => relocate(s, from, to))).toEqual([
    'join(import.meta.dir, "../../../package.json")',
    'path.join(import.meta.dirname, "../../schema.sql")',
    'resolve(__dirname, "../../../package.json")',
    'path.resolve(dirname(fileURLToPath(import.meta.url)), "../../../package.json")',
    'join(path.dirname(url.fileURLToPath(import.meta.url)), "../..", name)',
  ]);
  // Not provably the file's own folder (a variable, the working directory, another file's folder, a template
  // segment), or an absolute path: untouched.
  const kept = [
    'const here = import.meta.dir;\njoin(here, "..", "package.json")',
    'join(process.cwd(), "..", "package.json")',
    'join(dirname(other), "..", "package.json")',
    'join(import.meta.dir, `../${x}`)',
    'join(import.meta.dir, "/etc/hosts")',
    'join(import.meta.directory, "..")',
  ];
  for (const s of kept) expect(relocate(s, from, to)).toBe(s);
  // Not moved (the same folder): unchanged.
  expect(relocate(moved[0]!, from, from)).toBe(moved[0]!);
});
