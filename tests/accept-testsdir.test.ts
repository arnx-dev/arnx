// A kept test of a project whose runner collects only some folders and names stays where that runner collects it: beside
// the project's tests_dir, named by its test_files. Kept elsewhere (__tests__/arnx at the project's root, or a name the
// runner does not collect), `arnx check` would put it in place and its runner would never run it.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { accept } from "../src/accept";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { save } from "../src/report";
import { defaultSettings } from "../src/settings";
import { acceptedRoots, isKeptPath, keptTestFiles } from "../src/testround";
import { gitRepo } from "./helpers/gitutil";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-22T00:00:00Z" };
const RID = "20261022-0a1b2c";
const GEN = "src/js/__tests__/arnx_generated";
const YAML = `
version: 1
projects:
  app:
    root: .
    language: typescript
    image: node:22
    runner: jest
    test_command: npx jest {targets}
    tests_dir: ${GEN}
    test_files: "*Spec.tsx"
`;
const SRC = 'test("the bug", () => {\n  expect(1).toBe(2);\n});\n';

test("a kept test of a project with its own tests folder stays where the runner collects it", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, ".arnx"));
  const file = parseReviewFile(YAML);
  writeFileSync(reviewConfigPath(repo), stampFile(file, "Dev", "2026-10-22"));
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(sampleReview({ id: RID, findings: [{ ...finding("F1", `${GEN}/pkgSpec.tsx::the bug`, "the bug",
    `${GEN}/pkgSpec.tsx`, "expected 2", "pkg wrong", "confirmed", "y"), project: "app" }], projects: ["app"],
  language: "typescript", questions: [], questionProjects: [], flaky: [], errors: [], notSent: [], writeDir: GEN,
  writeDirs: { app: GEN } }), rdir, "d");
  mkdirSync(join(rdir, "projects", "app", "tests", GEN), { recursive: true });
  writeFileSync(join(rdir, "projects", "app", "tests", GEN, "pkgSpec.tsx"), SRC);
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8"))
    .replace("Mark: [ ] real", "Mark: [x] real"));
  const result = await accept(repo, rdir, SETTINGS);
  const kept = join(repo, ".arnx", "tests", "src", "js", "__tests__", "arnx", "r20261022_0a1b2c", "pkg_wrongSpec.tsx");
  expect(result.kept).toEqual([kept]);
  // Found again as the project's kept file, by the folder and the name.
  const cfg = file.projects[0]!;
  expect(acceptedRoots(cfg)).toContain("src/js/__tests__/arnx");
  expect(keptTestFiles(repo, cfg)).toEqual([".arnx/tests/src/js/__tests__/arnx/r20261022_0a1b2c/pkg_wrongSpec.tsx"]);
  expect(isKeptPath(cfg, "src/js/__tests__/arnx/r20261022_0a1b2c/pkg_wrongSpec.tsx")).toBe(true);
  // A project that keeps its default folder, or sets accepted_tests_dir itself, is unchanged.
  const plain = parseReviewFile(YAML.replace(/    tests_dir:.*\n    test_files:.*\n/, "")).projects[0]!;
  expect(acceptedRoots(plain)).toEqual(["tests/arnx", "__tests__/arnx"]);
  expect(acceptedRoots(cfg, "custom/kept")).toContain("custom/kept");
  expect(acceptedRoots(cfg, "custom/kept")).not.toContain("src/js/__tests__/arnx");
});

test("kept tests are still collected after test_files or tests_dir change", () => {
  const repo = gitRepo(tmp());
  const put = (p: string) => { mkdirSync(join(repo, ".arnx", "tests", p, ".."), { recursive: true }); writeFileSync(join(repo, ".arnx", "tests", p), "x\n"); };
  // Kept before test_files existed (usual names, default folder), and kept beside an earlier tests_dir.
  put("__tests__/arnx/r20261001_aaaaaa/old.test.ts");
  put("lib/__tests__/arnx/r20261002_bbbbbb/older.spec.ts");
  put("src/js/__tests__/arnx/r20261003_cccccc/new_wrongSpec.tsx");
  const cfg = parseReviewFile(YAML).projects[0]!;
  expect(keptTestFiles(repo, cfg)).toEqual([
    ".arnx/tests/__tests__/arnx/r20261001_aaaaaa/old.test.ts",
    ".arnx/tests/lib/__tests__/arnx/r20261002_bbbbbb/older.spec.ts",
    ".arnx/tests/src/js/__tests__/arnx/r20261003_cccccc/new_wrongSpec.tsx"]);
});
