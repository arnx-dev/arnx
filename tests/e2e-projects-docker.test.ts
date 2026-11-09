// Docker end to end for projects and the new adapters: real images, real runners (node:test, cargo-nextest),
// scripted models. Run with ARNX_DOCKER_TESTS=1.
import { blankMarks } from "./helpers/review";
import { describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { accept } from "../src/accept";
import { check } from "../src/check";
import { snapshot } from "../src/change";
import { parseReviewFile, reviewConfigPath } from "../src/config";
import { runTests } from "../src/outcomes";
import { exitCode } from "../src/report";
import { runReview } from "../src/reviewer";
import { defaultSettings } from "../src/settings";
import { approveFile } from "../src/setup";
import { dockerSession } from "../src/testround";
import { FakeJson, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo, runGit } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const FIXTURES = join(import.meta.dir, "fixtures");
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-12T00:00:00Z" };
const tmp = useTmp();

function repoFrom(fixture: string, yaml: string): string {
  const repo = initRepo(join(tmp(), fixture));
  cpSync(join(FIXTURES, fixture), repo, { recursive: true });
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), yaml);
  commit(repo, "start");
  return repo;
}

function repoWith(name: string, files: Record<string, string>, yaml: string): string {
  const repo = initRepo(join(tmp(), name));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(join(repo, rel, ".."), { recursive: true });
    writeFileSync(join(repo, rel), body);
  }
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), yaml);
  commit(repo, "start");
  return repo;
}

function markReal(rdir: string): void {
  const md = join(rdir, "review.md");
  writeFileSync(md, blankMarks(readFileSync(md, "utf8")).replace("Mark: [ ] real", "Mark: [x] real"));
}

const NODE_YAML = `version: 1
projects:
  pay:
    root: services/pay
    language: typescript
    runner: node
    image: node:22-bookworm-slim
    test_command: node --test {targets}
    uses: [services/shared/]
  feed:
    root: services/feed
    language: typescript
    runner: node
    image: node:22-bookworm-slim
    test_command: node --test {targets}
    uses: [services/shared/]
`;

const PAY_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { charge } = require("../../pay");

test("charges cents exactly", () => {
  assert.strictEqual(charge(0.29).cents, 29);
});

test("charges whole amounts", () => {
  assert.strictEqual(charge(3).cents, 300);
});
`;
const FEED_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { priceTag } = require("../../feed");

test("tags whole amounts", () => {
  assert.strictEqual(priceTag(2), "200 cents");
});
`;

const RUST_YAML = `version: 1
projects:
  calc:
    root: .
    language: rust
    runner: nextest
    image: rust:1-bookworm
    install: ["curl -LsSf https://get.nexte.st/latest/linux | tar zxf - -C /usr/local/cargo/bin && cargo nextest run --no-run"]
    test_command: cargo nextest run {targets}
`;
const RUST_TEST = `#[test]
fn adds_two_numbers() {
    assert_eq!(calc::add(2, 3), 5);
}

#[test]
fn adds_zero() {
    assert_eq!(calc::add(4, 0), 4);
}
`;

// The install is the drafted one, verbatim: review.yaml's validator and the Dockerfile RUN both take it as written.
const GO_INSTALL = "go mod download && { go test -vet=off -run '^$' ./... || true; }";
const GO_YAML = `version: 1
projects:
  calc:
    root: .
    language: go
    runner: gotest
    image: golang:1.26-bookworm
    install: ["${GO_INSTALL}"]
    test_command: go test {targets}
`;
const GO_GEN = "arnx_generated/add_arnx/add_arnx_test.go";
const GO_TEST = `package arnx

import (
\t"testing"

\t"example.com/calc"
\t"example.com/calc/internal/fee"
)

func TestAddsTwoNumbers(t *testing.T) {
\tif got := calc.Add(2, 3); got != 5 {
\t\tt.Errorf("Add(2, 3) = %d, want 5", got)
\t}
}

func TestFeeIsOnePercent(t *testing.T) {
\tif got := fee.Cents(300); got != 3 {
\t\tt.Errorf("Cents(300) = %d, want 3", got)
\t}
}
`;

// Does not compile: a bad file in Go loses its whole folder, which is why each generated file has its own.
const GO_BROKEN_GEN = "arnx_generated/bad_arnx/bad_arnx_test.go";
const GO_BROKEN = `package arnx

import (
\t"testing"

\t"example.com/calc"
)

func TestBroken(t *testing.T) {
\tcalc.NoSuchFunction()
}
`;
// A project with a real third-party module: downloaded by the install, read offline by the test user.
const GO_DEP_FILES: Record<string, string> = {
  "go.mod": "module example.com/withdep\n\ngo 1.24\n\nrequire github.com/google/go-cmp v0.6.0\n",
  "go.sum": "github.com/google/go-cmp v0.6.0 h1:ofyhxvXcZhMsU5ulbFiLKl/XBFqE1GSq7atu8tAmTRI=\n" +
    "github.com/google/go-cmp v0.6.0/go.mod h1:17dUlkBOakJ0+DkrSSNjCkIjxS6bF9zb3elmeNGIjoY=\n",
  "same.go": "package withdep\n\nimport \"github.com/google/go-cmp/cmp\"\n\n// Same says whether two lists are equal.\n" +
    "func Same(a, b []int) bool {\n\treturn cmp.Equal(a, b)\n}\n",
  "same_test.go": "package withdep\n\nimport \"testing\"\n\nfunc TestSame(t *testing.T) {\n" +
    "\tif !Same([]int{1}, []int{1}) {\n\t\tt.Fatal(\"equal lists\")\n\t}\n}\n",
};
const GO_DEP_YAML = GO_YAML.replace("calc:", "withdep:");
// A go.work with two members: a imports its sibling b, resolved from the workspace.
const GO_WORK_FILES: Record<string, string> = {
  "go.work": "go 1.24\n\nuse (\n\t./a\n\t./b\n)\n",
  "a/go.mod": "module example.com/a\n\ngo 1.24\n",
  "a/a.go": "package a\n\nimport \"example.com/b\"\n\n// Next is one more than b's base.\nfunc Next() int {\n\treturn b.Base() + 1\n}\n",
  "a/a_test.go": "package a\n\nimport \"testing\"\n\nfunc TestNext(t *testing.T) {\n\tif Next() != 2 {\n\t\tt.Fatal(Next())\n\t}\n}\n",
  "b/go.mod": "module example.com/b\n\ngo 1.24\n",
  "b/b.go": "package b\n\n// Base is the starting value.\nfunc Base() int {\n\treturn 1\n}\n",
  "b/b_test.go": "package b\n\nimport \"testing\"\n\nfunc TestBase(t *testing.T) {\n\tif Base() != 1 {\n\t\tt.Fatal(Base())\n\t}\n}\n",
};
const GO_WORK_INSTALL = "go mod download && { go test -vet=off -run '^$' ./a/... ./b/... || true; }";
const goWorkProject = (name: string) => `  ${name}:
    root: ${name}
    install_root: .
    language: go
    runner: gotest
    image: golang:1.26-bookworm
    install: ["${GO_WORK_INSTALL}"]
    test_command: go test {targets}
`;
const GO_WORK_YAML = `version: 1\nprojects:\n${goWorkProject("a")}${goWorkProject("b")}`;
const GO_WORK_GEN = "a/arnx_generated/next_arnx/next_arnx_test.go";
const GO_WORK_TEST = `package arnx

import (
\t"testing"

\t"example.com/a"
)

func TestNextIsTwo(t *testing.T) {
\tif got := a.Next(); got != 2 {
\t\tt.Errorf("Next() = %d, want 2", got)
\t}
}
`;

// A JavaScript project type checked by a real tsc (checkJs): src/old.js holds an error from before the change.
const TS_YAML = `version: 1
projects:
  calc:
    root: .
    language: typescript
    runner: node
    image: node:22-bookworm-slim
    install: ["mkdir -p /opt/deps && cd /opt/deps && npm init -y >/dev/null && npm install --no-audit --no-fund typescript@5.9.3"]
    test_command: node --test {targets}
    typecheck: /opt/deps/node_modules/.bin/tsc --noEmit -p tsconfig.json
`;
const TS_FILES: Record<string, string> = {
  "package.json": '{"name": "calc", "private": true, "devDependencies": {"typescript": "5.9.3"}}\n',
  "tsconfig.json": '{"compilerOptions": {"allowJs": true, "checkJs": true, "noEmit": true, "strict": true, "types": []}}\n',
  "src/calc.js": "/** @param {number} a @param {number} b */\nfunction add(a, b) { return a + b; }\nmodule.exports = { add };\n",
  "src/old.js": '/** @type {number} */\nconst n = "x";\nmodule.exports = { n };\n',
  // The project's own test, kept out of the type check's way.
  "__tests__/own.test.js": '// @ts-nocheck\nconst test = require("node:test");\ntest("own", () => {});\n',
};
// The generated test has type errors of its own (node:test has no types here; add returns a number).
const TS_TEST = `const test = require("node:test");
const assert = require("node:assert");
const { add } = require("../../src/calc");
/** @type {string} */
const s = add(1, 2);
test("adds", () => { assert.strictEqual(s, 3); });
`;

describe.skipIf(!process.env.ARNX_DOCKER_TESTS)("docker: projects", () => {
  test("TypeScript: tsc reports the change's new type error and the old one, not the generated test's; the tests " +
    "still run", async () => {
    const repo = initRepo(join(tmp(), "ts-calc"));
    for (const [rel, body] of Object.entries(TS_FILES)) {
      mkdirSync(join(repo, rel, ".."), { recursive: true });
      writeFileSync(join(repo, rel), body);
    }
    mkdirSync(join(repo, ".arnx"));
    writeFileSync(reviewConfigPath(repo), TS_YAML);
    commit(repo, "start");
    const [ok, detail] = await approveFile(repo, { by: "Dev", at: "2026-10-20" });
    expect([ok, detail]).toEqual([true, "calc: 1 passed; type check: 1 type error"]);
    writeFileSync(join(repo, "src/calc.js"), TS_FILES["src/calc.js"]!.replace("module.exports",
      '/** @type {number} */\nconst label = "sum";\nmodule.exports'));
    const gen = "__tests__/arnx_generated/calc.test.js";
    const agent = new ScriptedAgent([[tool("write_file", { path: gen, content: TS_TEST })], [tool("run_tests")],
      [text(`{"tests": [{"test": "${gen}::adds", "expects": "add adds"}], "suspected_defects": [], "questions": []}`)],
      [text(`{"tests": [{"test": "${gen}::adds", "expects": "add adds"}], "suspected_defects": [], "questions": []}`)]]);
    const { review, rdir } = await runReview(repo, { settings: { ...SETTINGS, fixProofMax: 0 }, agentModel: agent,
      challenger: new FakeJson([]) });
    expect([review.passed, review.missingRuns, review.findings.length, exitCode(review)]).toEqual([1, 0, 0, 0]);
    const t = review.typecheck![0]!;
    expect([t.status, t.errors, t.new, t.preExisting, t.inChangedFiles, t.before])
      .toEqual(["errors", 2, 1, 1, 1, "compared"]);
    expect(t.diagnostics.map((d) => [d.file, d.line, d.code, d.new])).toEqual([["src/calc.js", 4, "TS2322", true],
      ["src/old.js", 2, "TS2322", false]]);
    const md = readFileSync(join(rdir, "review.md"), "utf8");
    expect(md).toContain("Type check: 2 type errors: 1 new with this change, 1 already there before it; 1 in changed " +
      "files\n(see Type check below).");
    expect(md).not.toMatch(/arnx_generated\/calc\.test\.js:\d/); // its own type errors are not reported
  }, 900_000);


  test("Node: a shared change reviews both services; the kept test still fails from its new place", async () => {
    const repo = repoFrom("node-shop", NODE_YAML);
    const [ok, detail] = await approveFile(repo, { by: "Dev", at: "2026-10-12" });
    expect(detail).toContain("pay:");
    expect(ok).toBe(true);
    const money = join(repo, "services/shared/money.js");
    writeFileSync(money, readFileSync(money, "utf8").replace("Math.round(amount * 100)", "Math.floor(amount * 100)"));
    commit(repo, "floor cents");
    const gen = (p: string) => `services/${p}/__tests__/arnx_generated/${p}.test.js`;
    // One script each: the two rounds run side by side, and read in turn one would hand a project the other's reply.
    const feedScript = new ScriptedAgent([
      [tool("write_file", { path: gen("feed"), content: FEED_TEST })], [tool("run_tests")],
      [text('{"tests": [], "suspected_defects": [], "questions": []}')],
    ]);
    const payScript = new ScriptedAgent([
      [tool("write_file", { path: gen("pay"), content: PAY_TEST })], [tool("run_tests")],
      [text(`{"tests": [], "suspected_defects": [{"test": "${gen("pay")}::charges cents exactly", ` +
        '"explanation": "floor drops a cent"}], "questions": []}')],
    ]);
    const agent = new ScriptedAgent([]);
    agent.create = (q) => (JSON.stringify(q.messages[0]).includes("services/pay/__tests__") ? payScript : feedScript).create(q);
    const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "0.29 becomes 28" }]) });
    expect(review.projects).toEqual(["feed", "pay"]);
    expect(review.missingRuns).toBe(0);
    expect(review.findings.map((f) => [f.project, f.func, f.file])).toEqual([
      ["pay", "charges cents exactly", gen("pay")]]);
    expect(review.passed).toBe(2);
    expect(exitCode(review)).toBe(0);
    expect(review.findings[0]!.before!.status).toBe("regression"); // Math.round charged 29 cents before the change

    markReal(rdir);
    const result = await accept(repo, rdir, SETTINGS);
    const kept = result.kept.find((p) => basename(p).endsWith(".test.js"))!;
    // Kept in .arnx/tests/ at the path it runs from, as written: no marker.
    expect(relative(repo, kept)).toMatch(
      /^\.arnx\/tests\/services\/pay\/__tests__\/arnx\/r[0-9_a-f]+\/floor_drops_a_cent\.test\.js$/);
    expect(readFileSync(kept, "utf8")).toContain('require("../../../pay")');
    expect(readFileSync(kept, "utf8")).not.toContain("// arnx review");
    const cfg = parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")).projects.find((p) => p.name === "pay")!;
    // The project's own run, with .arnx/tests/ there as in the repository: node --test never runs it.
    const snap = join(mkdtempSync(join(tmpdir(), "arnx-kept-")), "repo");
    try {
      snapshot(repo, null, snap, [], { untracked: true });
      cpSync(join(repo, ".arnx", "tests"), join(snap, ".arnx", "tests"), { recursive: true });
      const own = await dockerSession(cfg, snap, join(tmp(), "build.log"),
        async (s) => (await runTests(s, snap, cfg, [], "own.xml", 300))[1]);
      expect(own?.length).toBeGreaterThan(0);
      expect(own!.filter((t) => t.testId.includes(".arnx"))).toEqual([]);
    } finally {
      rmSync(join(snap, ".."), { recursive: true, force: true });
    }
    // arnx check puts it in place and runs it: it still fails on the defect, and nothing fails to load.
    const pay = (await check(repo, SETTINGS)).find((r) => r.project === "pay")!;
    expect(pay.failed.map((t) => t.testId.split("::").at(-1))).toContain("charges cents exactly");
    expect(pay.failed.map((t) => t.message).join("\n")).not.toContain("Cannot find module");
  }, 900_000);

  test("Rust: nextest runs a generated integration test; a failing one is kept as tests/arnx_<tag>_<name>.rs", async () => {
    const repo = repoFrom("rust-calc", RUST_YAML);
    const [ok, detail] = await approveFile(repo, { by: "Dev", at: "2026-10-12" });
    expect(detail).toContain("1 passed");
    expect(ok).toBe(true);
    const lib = join(repo, "src/lib.rs");
    writeFileSync(lib, readFileSync(lib, "utf8").replace("a + b", "a - b"));
    commit(repo, "subtract");
    const agent = new ScriptedAgent([
      [tool("write_file", { path: "tests/arnx_generated_calc.rs", content: RUST_TEST })], [tool("run_tests")],
      [text('{"tests": [], "suspected_defects": [{"test": "tests/arnx_generated_calc.rs::adds_two_numbers", ' +
        '"explanation": "add subtracts"}], "questions": []}')],
    ]);
    const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "a - b" }]) });
    expect(review.missingRuns).toBe(0);
    expect(review.findings.map((f) => [f.func, f.file])).toEqual([["adds_two_numbers", "tests/arnx_generated_calc.rs"]]);
    expect(review.passed).toBe(1);
    // the crate is rebuilt from the code before the change (a + b), where the test passes
    expect(review.findings[0]!.before).toMatchObject({ status: "regression" });
    console.log(`Rust before/after check: ${review.timings!.beforeCheckSecs} s of a ${review.seconds} s review`);
    markReal(rdir);
    const result = await accept(repo, rdir, SETTINGS);
    expect(result.kept.map((p) => relative(repo, p))).toEqual([
      expect.stringMatching(/^\.arnx\/tests\/tests\/arnx_\d{8}_[0-9a-f]{6}_add_subtracts\.rs$/)]);
    // adds_zero passed in every run, so nothing is cut out, and nothing is added: cargo never builds it there.
    expect(readFileSync(result.kept[0]!, "utf8")).toBe(RUST_TEST);
    // arnx check puts it in tests/ of its copy and runs it: the bug's test fails, the other passes.
    const [calc] = await check(repo, SETTINGS);
    expect(calc!.failed.map((t) => t.testId.split("::").at(-1))).toEqual(["adds_two_numbers"]);
    expect(calc!.passed.map((t) => t.split("::").at(-1))).toEqual(["adds_zero"]);
  }, 1_800_000);

  test("Rust: a change committed before the image was built is tested as changed, not as the image's prebuilt binary", async () => {
    const repo = repoFrom("rust-calc", RUST_YAML);
    const [ok] = await approveFile(repo, { by: "Dev", at: "2026-10-12" }); // the image is built (and the crate with it) now
    expect(ok).toBe(true);
    const lib = join(repo, "src/lib.rs");
    writeFileSync(lib, readFileSync(lib, "utf8").replace("a + b", "a - b"));
    runGit(repo, "add", "src/lib.rs");
    const past = "2001-01-01T00:00:00Z"; // older than the image build, so the archive stamps lib.rs with an old mtime
    Bun.spawnSync(["git", "-C", repo, "commit", "-q", "-m", "subtract"],
      { env: { ...process.env, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past } });
    const head = runGit(repo, "rev-parse", "HEAD").trim();
    const cfg = parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")).projects.find((p) => p.name === "calc")!;
    const snap = join(mkdtempSync(join(tmpdir(), "arnx-stale-")), "repo");
    try {
      snapshot(repo, head, snap);
      writeFileSync(join(snap, "tests/arnx_stale.rs"), RUST_TEST);
      const run = await dockerSession(cfg, snap, join(tmp(), "build.log"),
        async (s) => s.run("cargo nextest run", 600));
      expect(run.exitCode).not.toBe(0); // RUST_TEST asserts add(2, 3) == 5; the changed code returns -1
      expect(run.output).toContain("adds_two_numbers");
    } finally {
      rmSync(join(snap, ".."), { recursive: true, force: true });
    }
  }, 1_800_000);

  test("Rust: a session's runs keep the build; a changed file is rebuilt; another session starts from the image", async () => {
    const repo = repoFrom("rust-calc", RUST_YAML);
    const [ok] = await approveFile(repo, { by: "Dev", at: "2026-10-12" });
    expect(ok).toBe(true);
    const cfg = parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")).projects.find((p) => p.name === "calc")!;
    const fresh = () => {
      const snap = join(mkdtempSync(join(tmpdir(), "arnx-kept-")), "repo");
      snapshot(repo, null, snap);
      writeFileSync(join(snap, "tests/arnx_kept.rs"), RUST_TEST);
      return snap;
    };
    const head = fresh();
    try {
      const runs = await dockerSession(cfg, head, join(tmp(), "build.log"), async (s) => {
        const first = await s.run("cargo nextest run", 600);
        const second = await s.run("cargo nextest run", 600);
        const lib = join(head, "src/lib.rs");
        writeFileSync(lib, readFileSync(lib, "utf8").replace("a + b", "a - b"));
        return [first, second, await s.run("cargo nextest run", 600)];
      });
      expect(runs[0]!.output).toContain("Compiling rust-calc");
      expect(runs[1]!.exitCode).toBe(0);
      expect(runs[1]!.output).not.toContain("Compiling rust-calc"); // the first run's build was kept
      expect(runs[2]!.output).toContain("Compiling rust-calc");
      expect(runs[2]!.exitCode).not.toBe(0); // the changed add is what runs
    } finally {
      rmSync(join(head, ".."), { recursive: true, force: true });
    }
    const other = fresh();
    try {
      const run = await dockerSession(cfg, other, join(tmp(), "build.log"), async (s) => s.run("cargo nextest run", 600));
      expect(run.exitCode).toBe(0); // the other session's subtracting build is not here
    } finally {
      rmSync(join(other, ".."), { recursive: true, force: true });
    }
  }, 1_800_000);

  test("Go: approve runs the project's test; a failing generated test is kept under .arnx and check runs it", async () => {
    const repo = repoFrom("go-calc", GO_YAML);
    const [ok, detail] = await approveFile(repo, { by: "Dev", at: "2026-11-09" });
    expect(detail).toContain("1 passed");
    expect(ok).toBe(true);
    const calc = join(repo, "calc.go");
    writeFileSync(calc, readFileSync(calc, "utf8").replace("a + b", "a - b"));
    commit(repo, "subtract");
    const agent = new ScriptedAgent([
      [tool("write_file", { path: GO_GEN, content: GO_TEST })], [tool("run_tests")],
      [text(`{"tests": [], "suspected_defects": [{"test": "${GO_GEN}::TestAddsTwoNumbers", ` +
        '"explanation": "add subtracts"}], "questions": []}')],
    ]);
    const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "a - b" }]) });
    expect(review.missingRuns).toBe(0);
    expect(review.findings.map((f) => [f.func, f.file])).toEqual([["TestAddsTwoNumbers", GO_GEN]]);
    expect(review.passed).toBe(1);
    expect(review.findings[0]!.before).toMatchObject({ status: "regression" });
    markReal(rdir);
    const result = await accept(repo, rdir, SETTINGS);
    expect(result.kept.map((p) => relative(repo, p))).toEqual([
      expect.stringMatching(/^\.arnx\/tests\/tests\/arnx\/r\d{8}_[0-9a-f]{6}\/add_subtracts_arnx\/add_subtracts_arnx_test\.go$/)]);
    expect(readFileSync(result.kept[0]!, "utf8")).toBe(GO_TEST);
    // Nothing outside .arnx/ changed in the repository.
    expect(runGit(repo, "status", "--porcelain", "--untracked-files=all").trim().split("\n")
      .filter((l) => !l.slice(3).startsWith(".arnx/"))).toEqual([]);
    // The project's own go test ./..., with .arnx/tests/ there as in the repository: only its own test runs.
    const cfg = parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")).projects.find((p) => p.name === "calc")!;
    const snap = join(mkdtempSync(join(tmpdir(), "arnx-kept-")), "repo");
    try {
      snapshot(repo, null, snap, [], { untracked: true });
      cpSync(join(repo, ".arnx", "tests"), join(snap, ".arnx", "tests"), { recursive: true });
      const own = await dockerSession(cfg, snap, join(tmp(), "build.log"),
        async (s) => (await runTests(s, snap, cfg, [], "own.xml", 300))[1]);
      expect(own!.map((t) => [t.fileAttr, t.name, t.outcome])).toEqual([["calc_test.go", "TestAddsZero", "passed"]]);
    } finally {
      rmSync(join(snap, ".."), { recursive: true, force: true });
    }
    // arnx check puts it in place and runs it: the bug's test fails, the other passes, nothing fails to build.
    const [checked] = await check(repo, SETTINGS);
    expect(checked!.noReport).toBe(false);
    expect(checked!.failed.map((t) => t.testId.split("::").at(-1))).toEqual(["TestAddsTwoNumbers"]);
    expect(checked!.passed.map((t) => t.split("::").at(-1))).toEqual(["TestFeeIsOnePercent"]);
  }, 1_800_000);

  test("Go: a generated file that does not compile loses only itself; a write outside its own folder is refused", async () => {
    const repo = repoFrom("go-calc", GO_YAML);
    expect((await approveFile(repo, { by: "Dev", at: "2026-11-09" }))[0]).toBe(true);
    const calc = join(repo, "calc.go");
    writeFileSync(calc, readFileSync(calc, "utf8").replace("a + b", "a - b"));
    commit(repo, "subtract");
    const agent = new ScriptedAgent([
      [tool("write_file", { path: "arnx_generated/add_arnx_test.go", content: GO_TEST })],
      [tool("write_file", { path: GO_GEN, content: GO_TEST }), tool("write_file", { path: GO_BROKEN_GEN, content: GO_BROKEN })],
      [tool("run_tests")],
      [text(`{"tests": [], "suspected_defects": [{"test": "${GO_GEN}::TestAddsTwoNumbers", ` +
        '"explanation": "add subtracts"}], "questions": []}')],
    ]);
    const { review } = await runReview(repo, { settings: { ...SETTINGS, fixProofMax: 0 }, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "a - b" }]) });
    expect(JSON.stringify(agent.calls)).toContain("one file per folder");
    expect(review.findings.map((f) => [f.func, f.file])).toEqual([["TestAddsTwoNumbers", GO_GEN]]);
    expect(review.passed).toBe(1); // TestFeeIsOnePercent, in the file that compiled
    expect(review.missingRuns).toBe(0);
    expect(review.errors).toEqual([`${GO_BROKEN_GEN}::${GO_BROKEN_GEN}`]); // an error of the run, never a finding
  }, 900_000);

  test("Go: code that stops compiling is an error of the run, never a finding", async () => {
    const repo = repoFrom("go-calc", GO_YAML);
    expect((await approveFile(repo, { by: "Dev", at: "2026-11-09" }))[0]).toBe(true);
    const calc = join(repo, "calc.go");
    writeFileSync(calc, readFileSync(calc, "utf8").replace("a + b", "a + undefinedName"));
    commit(repo, "typo");
    const agent = new ScriptedAgent([
      [tool("write_file", { path: GO_GEN, content: GO_TEST })], [tool("run_tests")],
      [text(`{"tests": [], "suspected_defects": [{"test": "${GO_GEN}::TestAddsTwoNumbers", ` +
        '"explanation": "the call does not work"}], "questions": []}')],
    ]);
    const { review } = await runReview(repo, { settings: { ...SETTINGS, fixProofMax: 0 }, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "broken" }]) });
    expect(review.findings).toEqual([]);
    expect(review.passed).toBe(0);
    expect(review.errors).toEqual([`${GO_GEN}::${GO_GEN}`]);
  }, 900_000);

  test("Go: a test marked noise is skipped in the kept file, which still builds; check counts it as skipped", async () => {
    const repo = repoFrom("go-calc", GO_YAML);
    expect((await approveFile(repo, { by: "Dev", at: "2026-11-09" }))[0]).toBe(true);
    const calc = join(repo, "calc.go");
    writeFileSync(calc, readFileSync(calc, "utf8").replace("a + b", "a - b"));
    commit(repo, "subtract");
    const source = GO_TEST.replace("got != 3", "got != 4").replace("want 3", "want 4");
    const agent = new ScriptedAgent([
      [tool("write_file", { path: GO_GEN, content: source })], [tool("run_tests")],
      [text(`{"tests": [], "suspected_defects": [{"test": "${GO_GEN}::TestAddsTwoNumbers", "explanation": "add subtracts"}, ` +
        `{"test": "${GO_GEN}::TestFeeIsOnePercent", "explanation": "fee is off"}], "questions": []}`)],
    ]);
    const { review, rdir } = await runReview(repo, { settings: { ...SETTINGS, fixProofMax: 0 }, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "a - b" }, { verdict: "confirmed", reason: "fee" }]) });
    expect(review.findings.map((f) => f.func).sort()).toEqual(["TestAddsTwoNumbers", "TestFeeIsOnePercent"]);
    const md = join(rdir, "review.md");
    const marks = blankMarks(readFileSync(md, "utf8")).split("\n");
    const blocks = marks.map((l, i) => [l, i] as const).filter(([l]) => l.startsWith("Mark: "));
    const feeFirst = review.findings[0]!.func === "TestFeeIsOnePercent";
    const tick = (i: number, what: string) => { marks[i] = marks[i]!.replace(`[ ] ${what}`, `[x] ${what}`); };
    tick(blocks[feeFirst ? 1 : 0]![1], "real");
    tick(blocks[feeFirst ? 0 : 1]![1], "noise");
    writeFileSync(md, marks.join("\n"));
    const result = await accept(repo, rdir, SETTINGS);
    expect(result.kept).toHaveLength(1);
    const kept = readFileSync(result.kept[0]!, "utf8");
    expect(kept).toMatch(/func TestFeeIsOnePercent\(t \*testing\.T\) \{\n\tt\.Skip\(/);
    expect(kept).not.toMatch(/func TestAddsTwoNumbers\(t \*testing\.T\) \{\n\tt\.Skip\(/);
    const [checked] = await check(repo, SETTINGS);
    expect(checked!.failed.map((t) => t.testId.split("::").at(-1))).toEqual(["TestAddsTwoNumbers"]);
    expect(checked!.skipped).toBe(1);
  }, 900_000);

  test("Go: a change committed before the image was built is tested as changed; runs in a session see edits; another " +
    "session starts from the image", async () => {
    const repo = repoFrom("go-calc", GO_YAML);
    expect((await approveFile(repo, { by: "Dev", at: "2026-11-09" }))[0]).toBe(true);
    const calc = join(repo, "calc.go");
    const cfg = parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")).projects.find((p) => p.name === "calc")!;
    const gen = "arnx_generated/add_arnx";
    const run = "go test -count=1 -vet=off ./...";
    const place = (head: string | null) => {
      const snap = join(mkdtempSync(join(tmpdir(), "arnx-go-")), "repo");
      snapshot(repo, head, snap);
      mkdirSync(join(snap, gen), { recursive: true });
      writeFileSync(join(snap, gen, "add_arnx_test.go"), GO_TEST);
      return snap;
    };
    const head = place(null);
    try {
      const runs = await dockerSession(cfg, head, join(tmp(), "build.log"), async (s) => {
        const first = await s.run(run, 600);
        writeFileSync(join(head, "calc.go"), readFileSync(join(head, "calc.go"), "utf8").replace("a + b", "a - b"));
        return [first, await s.run(run, 600)];
      });
      expect(runs[0]!.exitCode).toBe(0);
      expect(runs[1]!.exitCode).not.toBe(0); // the edit is what runs, not an earlier build
      expect(runs[1]!.output).toContain("Add(2, 3) = -1");
    } finally {
      rmSync(join(head, ".."), { recursive: true, force: true });
    }
    // The edit above went to that session's copy only: this one sees the committed code.
    const clean = place(null);
    try {
      const other = await dockerSession(cfg, clean, join(tmp(), "build.log"), async (s) => s.run(run, 600));
      expect(other.exitCode).toBe(0);
    } finally {
      rmSync(join(clean, ".."), { recursive: true, force: true });
    }
    writeFileSync(calc, readFileSync(calc, "utf8").replace("a + b", "a - b"));
    runGit(repo, "add", "calc.go");
    const past = "2001-01-01T00:00:00Z"; // older than the image build, so the archive stamps calc.go with an old time
    Bun.spawnSync(["git", "-C", repo, "commit", "-q", "-m", "subtract"],
      { env: { ...process.env, GIT_AUTHOR_DATE: past, GIT_COMMITTER_DATE: past } });
    const stale = place(runGit(repo, "rev-parse", "HEAD").trim());
    try {
      const result = await dockerSession(cfg, stale, join(tmp(), "build.log"), async (s) => s.run(run, 600));
      expect(result.exitCode).not.toBe(0); // the image's build cache holds a + b; the changed code is what runs
      expect(result.output).toContain("Add(2, 3) = -1");
    } finally {
      rmSync(join(stale, ".."), { recursive: true, force: true });
    }
  }, 1_800_000);

  test("Go: the test user reads the module cache and writes the build cache, offline; the report carries the module and " +
    "test lines", async () => {
    const repo = repoWith("go-withdep", GO_DEP_FILES, GO_DEP_YAML);
    const [ok, detail] = await approveFile(repo, { by: "Dev", at: "2026-11-09" });
    expect([ok, detail]).toEqual([true, expect.stringContaining("1 passed")]);
    const cfg = parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")).projects.find((p) => p.name === "withdep")!;
    expect(cfg.install).toEqual([GO_INSTALL]); // through the validator and approve's rewrite of review.yaml, verbatim
    const snap = join(mkdtempSync(join(tmpdir(), "arnx-go-")), "repo");
    try {
      snapshot(repo, null, snap);
      const [env, results, cold, warm] = await dockerSession(cfg, snap, join(tmp(), "build.log"), async (s) => {
        const e = await s.run("id -u; go env GOPROXY GOTOOLCHAIN GOCACHE GOFLAGS; touch /opt/arnx-gocache/w /go/w && echo writable", 120);
        const [, r] = await runTests(s, snap, cfg, ["same_test.go"], "own.xml", 300);
        // A module not in the image is an error of the run, not a network fetch.
        const c = await s.run("go mod download golang.org/x/text@v0.3.0", 120);
        const w = await s.run("find /opt/arnx-gocache -type f | wc -l", 120);
        return [e, r, c, w] as const;
      });
      const lines = env.output.trim().split("\n");
      expect(Number(lines[0])).toBeGreaterThan(0);
      expect(lines.slice(1, 5)).toEqual(["off", "local", "/opt/arnx-gocache", "-buildvcs=false"]);
      expect(lines.at(-1)).toBe("writable");
      expect(results!.map((t) => [t.fileAttr, t.name, t.outcome])).toEqual([["same_test.go", "TestSame", "passed"]]);
      const report = readFileSync(join(snap, ".arnx-run", "own.xml"), "utf8");
      expect(report).toContain("#arnx-module example.com/withdep");
      expect(report).toMatch(/^#arnx-test (\.\/)?same_test\.go:func TestSame\(/m);
      expect(cold.exitCode).not.toBe(0);
      expect(Number(warm.output.trim())).toBeGreaterThan(0); // the install's warm-up ran and filled the build cache
    } finally {
      rmSync(join(snap, ".."), { recursive: true, force: true });
    }
  }, 900_000);

  test("Go: the install's warm-up is best-effort: a package that does not compile loses only itself", async () => {
    const repo = repoWith("go-badpkg", { "go.mod": "module example.com/badpkg\n\ngo 1.24\n",
      "calc.go": "package calc\n\n// Add adds.\nfunc Add(a, b int) int {\n\treturn a + b\n}\n",
      "calc_test.go": "package calc\n\nimport \"testing\"\n\nfunc TestAddsZero(t *testing.T) {\n\tif Add(2, 0) != 2 {\n\t\tt.Fatal()\n\t}\n}\n",
      "broken/broken.go": "package broken\n\nfunc Bad() int {\n\treturn undefinedName\n}\n" }, GO_YAML);
    const cfg = parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")).projects.find((p) => p.name === "calc")!;
    const snap = join(mkdtempSync(join(tmpdir(), "arnx-go-")), "repo");
    try {
      snapshot(repo, null, snap);
      const results = await dockerSession(cfg, snap, join(tmp(), "build.log"),
        async (s) => (await runTests(s, snap, cfg, [], "own.xml", 300))[1]);
      expect(results!.map((t) => [t.fileAttr, t.name, t.outcome])).toEqual([["calc_test.go", "TestAddsZero", "passed"]]);
    } finally {
      rmSync(join(snap, ".."), { recursive: true, force: true });
    }
  }, 900_000);

  test("Go: a go.work member tests from inside itself, resolves its sibling, and check runs its accepted test", async () => {
    const repo = repoWith("go-work", GO_WORK_FILES, GO_WORK_YAML);
    const [ok, detail] = await approveFile(repo, { by: "Dev", at: "2026-11-09" });
    expect([ok, detail]).toEqual([true, expect.stringContaining("1 passed")]);
    const a = join(repo, "a/a.go");
    writeFileSync(a, readFileSync(a, "utf8").replace("b.Base() + 1", "b.Base() + 2"));
    commit(repo, "off by one");
    const agent = new ScriptedAgent([
      [tool("write_file", { path: GO_WORK_GEN, content: GO_WORK_TEST })], [tool("run_tests")],
      [text(`{"tests": [], "suspected_defects": [{"test": "${GO_WORK_GEN}::TestNextIsTwo", ` +
        '"explanation": "next is off by one"}], "questions": []}')],
    ]);
    const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "+ 2" }]) });
    expect(review.missingRuns).toBe(0);
    expect(review.findings.map((f) => [f.project, f.func, f.file])).toEqual([["a", "TestNextIsTwo", GO_WORK_GEN]]);
    expect(review.findings[0]!.before).toMatchObject({ status: "regression" });
    markReal(rdir);
    const result = await accept(repo, rdir, SETTINGS);
    expect(result.kept.map((p) => relative(repo, p))).toEqual([
      expect.stringMatching(/^\.arnx\/tests\/a\/tests\/arnx\/r\d{8}_[0-9a-f]{6}\/next_is_off_by_one_arnx\/next_is_off_by_one_arnx_test\.go$/)]);
    const checked = (await check(repo, SETTINGS)).find((r) => r.project === "a")!;
    expect(checked.failed.map((t) => t.testId.split("::").at(-1))).toEqual(["TestNextIsTwo"]);
  }, 1_800_000);
});
