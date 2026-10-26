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
    const agent = new ScriptedAgent([
      [tool("write_file", { path: gen("feed"), content: FEED_TEST })], [tool("run_tests")],
      [text('{"tests": [], "suspected_defects": [], "questions": []}')],
      [tool("write_file", { path: gen("pay"), content: PAY_TEST })], [tool("run_tests")],
      [text(`{"tests": [], "suspected_defects": [{"test": "${gen("pay")}::charges cents exactly", ` +
        '"explanation": "floor drops a cent"}], "questions": []}')],
    ]);
    const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent,
      challenger: new FakeJson([{ verdict: "confirmed", reason: "0.29 becomes 28" }]) });
    expect(review.projects).toEqual(["feed", "pay"]);
    expect(review.missingRuns).toBe(0);
    expect(review.findings.map((f) => [f.project, f.func, f.file])).toEqual([
      ["pay", "charges cents exactly", gen("pay")]]);
    expect(review.passed).toBe(2);
    expect(exitCode(review)).toBe(1);
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
        async (s) => runTests(s, snap, cfg, [], "own.xml", 300)[1]);
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
        const first = s.run("cargo nextest run", 600);
        const second = s.run("cargo nextest run", 600);
        const lib = join(head, "src/lib.rs");
        writeFileSync(lib, readFileSync(lib, "utf8").replace("a + b", "a - b"));
        return [first, second, s.run("cargo nextest run", 600)];
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
});
