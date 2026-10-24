// A repository with no commits yet (owner, 2026-10-20): the change is every file git does not ignore, less what
// .arnxignore and the secrets filter leave out, reviewed against the empty tree. init, doctor, setup, approve, next,
// review, --resume and accept all work there.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { accept } from "../src/accept";
import { describe as describeChange, EMPTY_TREE, resolveChange } from "../src/change";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp, stampFile } from "../src/config";
import { ChangeTooLarge, NoChange } from "../src/errors";
import { EVENTS_FILE, type TraceEvent } from "../src/events";
import { whatNext } from "../src/next";
import { exitCode } from "../src/report";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings, writeSettings } from "../src/settings";
import { approveFile, coverageMap, runSetup } from "../src/setup";
import { nextStep } from "../src/setupview";
import { Cli } from "./helpers/cli";
import { FakeJson, FakeSession, fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { initRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { blankMarks } from "./helpers/review";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-20T00:00:00Z" };
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";

/** A repository with files and no commit: app.py staged, lib/util.py untracked, and files every rule leaves out. */
function fresh(): string {
  const repo = initRepo(join(tmp(), "fresh"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  mkdirSync(join(repo, "lib"));
  writeFileSync(join(repo, "lib/util.py"), "X = 1\n");
  writeFileSync(join(repo, ".gitignore"), "build/\n");
  mkdirSync(join(repo, "build"));
  writeFileSync(join(repo, "build/out.py"), "Y = 2\n"); // git-ignored
  writeFileSync(join(repo, ".arnxignore"), "*.csv\n");
  writeFileSync(join(repo, "data.csv"), "a,b\n"); // .arnxignore
  writeFileSync(join(repo, ".env"), "TOKEN=x\n"); // a secret file
  runGit(repo, "add", "app.py");
  return repo;
}

test("the change is every file not ignored, against the empty tree, staged or not", () => {
  const repo = fresh();
  const c = resolveChange(repo);
  expect([c.kind, c.base, c.head]).toEqual(["no-commits", EMPTY_TREE, null]);
  expect(c.files).toEqual([".gitignore", "app.py", "lib/util.py"]);
  expect(c.ignored).toEqual(["data.csv"]);
  expect(c.diff).toContain("+++ b/app.py");
  expect(c.diff).toContain("+X = 1");
  expect(c.diff).not.toContain("out.py");
  expect(c.diff).not.toContain("TOKEN");
  expect(describeChange(c)).toBe("all files (no commits yet)");
});

test("no commits and no files: nothing to review; --range has nothing to name", () => {
  const repo = initRepo(join(tmp(), "empty"));
  expect(() => resolveChange(repo)).toThrow(NoChange);
  writeFileSync(join(repo, "app.py"), "X = 1\n");
  expect(() => resolveChange(repo, "a..b")).toThrow("the repository has no commits yet, so --range has nothing to " +
    "name; commit first");
});

/** fresh(), with consent and an approved environment. */
function approved(yaml = YAML): string {
  const repo = fresh();
  writeSettings(repo, SETTINGS);
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(yaml), "Dev", "2026-10-20"));
  return repo;
}

test("too large with no commits: the message and next say to commit part of it, since --range cannot help", () => {
  const repo = approved();
  writeFileSync(join(repo, "big.py"), "X = 1\n".repeat(50_000));
  expect(() => resolveChange(repo)).toThrow(ChangeTooLarge);
  expect(() => resolveChange(repo)).toThrow("arnx reviews up to 200 KB (largest: big.py 350 KB, ");
  expect(() => resolveChange(repo)).toThrow(". With no commits yet --range has nothing to name: commit part of the " +
    "files first");
  const n = whatNext(repo);
  expect(n.where).toContain("arnx reviews up to 200 KB");
  expect(n.command).toBe("git commit");
  expect(n.why).toContain("arnx review");
  expect(n.phase).toBe("2. Review");
});

test("next walks a repository with no commits to review; after setup it says what review would look at", () => {
  const repo = fresh();
  expect(whatNext(repo).command).toBe("arnx init");
  writeSettings(repo, SETTINGS);
  expect(whatNext(repo).command).toBe("arnx setup");
  writeFileSync(reviewConfigPath(repo), YAML);
  expect(whatNext(repo).command).toBe("arnx approve");
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(YAML), "Dev", "2026-10-20"));
  expect(whatNext(repo)).toMatchObject({ command: "arnx review",
    where: "all files (no commits yet), not reviewed yet" });
  expect(nextStep(repo)).toBe("Next: arnx review (every file: no commits yet)");
});

test("init, doctor and next run in a repository with no commits", async () => {
  const repo = fresh();
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  expect(await cli.run("init")).toBe(0);
  expect(await cli.run("consent", "--yes")).toBe(0);
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(PROJECTS), "Dev", "2026-10-20"));
  expect(await cli.run("doctor")).toBe(0);
  // app.py and lib/util.py are the repository's files, not scratch: no project explains them
  expect(cli.stdout).toContain("- not explained: 2 source files");
  expect(await cli.run("next")).toBe(0);
  expect(cli.stdout).toContain("arnx review");
});

test("setup: the snapshot holds the files, and coverage counts them as the repository's own", async () => {
  const repo = fresh();
  mkdirSync(join(repo, "services/pay"), { recursive: true });
  writeFileSync(join(repo, "services/pay/a.py"), "X = 1\n");
  const map = coverageMap(repo, parseReviewFile(PROJECTS));
  expect(map.unexplained).toEqual(["app.py", "lib/util.py"]);
  expect(map.projects[0]).toEqual({ name: "pay", owned: 1, used: 0 });
  const held: string[][] = [];
  const passing: SessionFactory = async (_cfg, snap, _log, body) => {
    held.push(readdirSync(snap).sort());
    return body(new FakeSession(snap, () => [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed",
      false]));
  };
  const m = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("propose", { yaml: YAML })],
    [text("One project.")]]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: passing });
  expect(r.ok).toBe(true);
  expect(held[0]).toEqual([".arnxignore", ".gitignore", "app.py", "lib", "services"]);
  // approve runs the suite on the same kind of snapshot
  writeFileSync(reviewConfigPath(repo), YAML);
  const [ok] = await approveFile(repo, { by: "Dev", at: "2026-10-20", sessionFactory: passing });
  expect(ok).toBe(true);
});

const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: [] });
const agent = () => new ScriptedAgent([
  [tool("write_file", { path: GEN, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" })],
  [text(REPORT)],
  [text(REPORT)], // the follow-up about lib/util.py, which no test refers to
]);
const FAILED = junitXml([[GEN, "test_add", "failed", "assert -1 == 5"]]);
const events = (rdir: string) => readFileSync(join(rdir, EVENTS_FILE), "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as TraceEvent);

test("review: findings against the empty tree, the before/after note said once; accept keeps the test", async () => {
  const repo = fresh();
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-20"));
  writeSettings(repo, SETTINGS);
  const held: string[][] = [];
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent(),
    challenger: new FakeJson([{ verdict: "confirmed", reason: "add subtracts" }]),
    sessionFactory: async (_cfg, snap, _log, body) => {
      held.push(readdirSync(snap).sort());
      return body(new FakeSession(snap, () => [FAILED, "1 failed", false]));
    } });
  // the working tree (and the round's tests folder); one session only: no base to run the before/after check on
  expect(held).toEqual([[".arnxignore", ".gitignore", "app.py", "lib", "tests"]]);
  expect(review.change).toBe("all files (no commits yet)");
  expect(review.findings.map((f) => [f.func, f.before?.status])).toEqual([["test_add", "unknown"]]);
  expect(exitCode(review)).toBe(1);
  expect(review.beforeBaseEmpty).toBe("first-commit");
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  const findings = md.slice(md.indexOf("## Findings"), md.indexOf("## Questions")).replace(/\s+/g, " ");
  expect(findings.split("nothing to compare").length - 1).toBe(1);
  expect(findings).not.toContain("- Before the change");
  const started = events(rdir).find((e) => e.type === "review.started")!;
  expect([started.data.change_kind, started.data.base, started.data.head]).toEqual(["no-commits", EMPTY_TREE, null]);
  const state = JSON.parse(readFileSync(join(rdir, "state.json"), "utf8")) as { diff_sha256: string };
  expect(state.diff_sha256).toBe(createHash("sha256").update(resolveChange(repo).diff).digest("hex"));
  expect(whatNext(repo).command).toBe(`arnx triage ${review.id}`);
  writeFileSync(join(rdir, "review.md"), blankMarks(md).replace("Mark: [ ] real", "Mark: [x] real"));
  const result = await accept(repo, rdir, SETTINGS);
  expect(result.kept).toHaveLength(1);
  expect(result.kept[0]!.startsWith(join(repo, ".arnx/tests/tests/arnx/r"))).toBe(true);
  expect(existsSync(result.kept[0]!)).toBe(true);
});

test("an interrupted review of a repository with no commits resumes", async () => {
  const repo = fresh();
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-20"));
  const settings = { ...SETTINGS, beforeCheck: false };
  writeSettings(repo, settings);
  await expect(runReview(repo, { settings, agentModel: agent(), challenger: new FakeJson([]),
    sessionFactory: async () => { throw new Error("network is unreachable"); } })).rejects.toThrow("unreachable");
  const [rid] = readdirSync(join(repo, ".arnx/reviews"));
  expect(whatNext(repo).command).toBe("arnx review --resume");
  const { review } = await runReview(repo, { settings, agentModel: agent(), resume: true,
    challenger: new FakeJson([{ verdict: "confirmed", reason: "add subtracts" }]),
    sessionFactory: fakeFactory(() => [FAILED, "1 failed", false]) });
  expect(review.id).toBe(rid!);
  expect(review.findings).toHaveLength(1);
});
