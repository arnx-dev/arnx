// Untracked files are opt-in (owner, 2026-10-20): a plain review sends tracked changes only (staged, unstaged, new
// files `git add`ed). Untracked files reach neither the diff nor the snapshot the agent reads and the tests run in,
// unless `--untracked` or `[review] untracked = true`; the start line, the summary, review.md and review.json say
// which were sent or how many were left out. With no commits yet every file is sent, and the start line says so.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { check } from "../src/check";
import { resolveChange, snapshot } from "../src/change";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp, stampFile } from "../src/config";
import { EVENTS_FILE, type TraceEvent } from "../src/events";
import { whatNext } from "../src/next";
import { summary } from "../src/report";
import { runReview } from "../src/reviewer";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings, loadSettings, type Settings, settingsPath, writeSettings } from "../src/settings";
import { approveFile, runSetup } from "../src/setup";
import { nextStep, setupPreview } from "../src/setupview";
import { testRound } from "../src/testround";
import { Cli } from "./helpers/cli";
import { answerRound, FakeJson, FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo, initRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-20T00:00:00Z" };
const KPI = "docs/kpi.md";
const PRIVATE = "Q3 revenue: private KPI";
const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: [] });
const FAILED = junitXml([[GEN, "test_add", "failed", "assert -1 == 5"]]);

/** An approved repository with a tracked change (app.py) and an untracked private document. */
let repos = 0;
function repoWithWork(settings: Settings = SETTINGS): string {
  const repo = gitRepo(join(tmp(), `r${++repos}`));
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-20"));
  writeSettings(repo, settings);
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  mkdirSync(join(repo, "docs"));
  writeFileSync(join(repo, KPI), `${PRIVATE}\n`);
  return repo;
}

/** What the agent's tools answered to its first reply. */
const firstResults = (m: ScriptedAgent) =>
  (m.calls[1]!.messages.at(-1)!.content as { content: string }[]).map((b) => String(b.content));

/** The agent first tries to read, list and search for the private document, then writes its test. */
const agent = () => new ScriptedAgent([
  [tool("read_file", { path: KPI }), tool("list_dir", { path: "." }), tool("grep", { pattern: "revenue" })],
  [tool("write_file", { path: GEN, content: "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n" })],
  [text(REPORT)],
  [text(REPORT)],
]);

/** A fake sandbox that records whether each snapshot it ran on held `rel`. */
function holding(rel: string, held: boolean[]): SessionFactory {
  return async (_cfg, snap, _log, body) => {
    held.push(existsSync(join(snap, rel)));
    return body(new FakeSession(snap, () => [FAILED, "1 failed", false]));
  };
}

async function review(repo: string, o: { untracked?: boolean; range?: string; settings?: Settings } = {}) {
  const said: string[] = [], held: boolean[] = [];
  const model = agent();
  const { review: r, rdir } = await runReview(repo, { settings: o.settings ?? SETTINGS, agentModel: model,
    challenger: new FakeJson([{ verdict: "confirmed", reason: "add subtracts" }]), sessionFactory: holding(KPI, held),
    progress: (m) => said.push(m), ...(o.untracked !== undefined ? { untracked: o.untracked } : {}),
    ...(o.range ? { range: o.range } : {}) });
  const json = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as Record<string, unknown>;
  const md = readFileSync(join(rdir, "review.md"), "utf8");
  const sent = JSON.stringify(model.calls) + readFileSync(join(rdir, "change.diff"), "utf8");
  const started = readFileSync(join(rdir, EVENTS_FILE), "utf8").split("\n").filter(Boolean)
    .map((l) => JSON.parse(l) as TraceEvent).find((e) => e.type === "review.started")!;
  return { r, rdir, said, held, json, md, sent, started, results: firstResults(model) };
}

test("a plain review sends tracked changes only: an untracked file is in neither the diff, the agent's reads nor " +
  "the sandbox, and the start line, summary, review.md and review.json say it was left out", async () => {
  const repo = repoWithWork();
  const { r, said, held, json, md, sent, started, results } = await review(repo);
  expect(said[0]).toBe("1 untracked file left out (`--untracked` includes them): docs/kpi.md");
  expect(results).toEqual(["ToolError: not a file: docs/kpi.md", "app.py\ntests/", "(no matches)"]);
  expect(held.length).toBeGreaterThan(0);
  expect(held.every((h) => !h)).toBe(true);
  expect(sent).not.toContain(PRIVATE);
  expect(r.filesChanged).toBe(1);
  expect([r.untrackedLeftOut, r.untrackedIncluded]).toEqual([1, undefined]);
  expect(json.untracked_left_out).toBe(1);
  expect("untracked_included" in json).toBe(false);
  expect(md).toContain("- Untracked files left out (not sent): 1; `arnx review --untracked` includes them\n");
  expect(summary(r, "review.md")).toContain("\n1 untracked file left out (--untracked includes them).\n");
  expect([started.data.untracked_left_out, started.data.untracked_included]).toEqual([1, undefined]);
});

test("--untracked sends untracked files as before and names them; [review] untracked does the same; " +
  "--no-untracked wins over it", async () => {
  const repo = repoWithWork();
  const opted = await review(repo, { untracked: true });
  expect(opted.said[0]).toBe("including 1 untracked file (--untracked): docs/kpi.md");
  expect(opted.held.every((h) => h)).toBe(true);
  expect(opted.sent).toContain(PRIVATE);
  expect(opted.results[0]).toContain(PRIVATE);
  expect([opted.r.filesChanged, opted.r.untrackedIncluded, opted.r.untrackedLeftOut]).toEqual([2, [KPI], undefined]);
  expect(opted.json.untracked_included).toEqual([KPI]);
  expect("untracked_left_out" in opted.json).toBe(false);
  expect(opted.md).toContain("- Untracked files included (--untracked): `docs/kpi.md`\n");
  expect(opted.started.data.untracked_included).toEqual([KPI]);
  expect(JSON.parse(readFileSync(join(opted.rdir, "state.json"), "utf8")).untracked).toBe(true);
  // next compares the change as the review sent it, untracked files included: it has not moved.
  expect(whatNext(repo).command).toBe(`arnx triage ${opted.r.id}`);

  const always = { ...SETTINGS, untracked: true };
  const set = await review(repoWithWork(always), { settings: always });
  expect(set.said[0]).toBe("including 1 untracked file (--untracked): docs/kpi.md");
  expect(set.held.every((h) => h)).toBe(true);
  const off = await review(repoWithWork(always), { settings: always, untracked: false });
  expect(off.said[0]).toBe("1 untracked file left out (`--untracked` includes them): docs/kpi.md");
  expect(off.held.every((h) => !h)).toBe(true);
  expect(off.sent).not.toContain(PRIVATE);
});

test("with no commits yet every file is sent, and the start line says so plainly; .arnxignore still applies",
  async () => {
    const repo = initRepo(join(tmp(), "fresh"));
    writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
    mkdirSync(join(repo, "lib"));
    writeFileSync(join(repo, "lib/util.py"), "X = 1\n");
    writeFileSync(join(repo, ".arnxignore"), "*.csv\n");
    writeFileSync(join(repo, "data.csv"), "a,b\n");
    runGit(repo, "add", "app.py");
    mkdirSync(dirname(reviewConfigPath(repo)));
    writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-10-20"));
    writeSettings(repo, SETTINGS);
    const said: string[] = [], util: boolean[] = [], data: boolean[] = [];
    await runReview(repo, { settings: SETTINGS, agentModel: agent(), challenger: new FakeJson([{ verdict: "confirmed",
      reason: "add subtracts" }]), progress: (m) => said.push(m), sessionFactory: async (_c, snap, _l, body) => {
      util.push(existsSync(join(snap, "lib/util.py")));
      data.push(existsSync(join(snap, "data.csv")));
      return body(new FakeSession(snap, () => [FAILED, "1 failed", false]));
    } });
    expect(said[0]).toBe("no commits yet: every file is sent (2 files)");
    expect(said[1]).toBe("left out (.arnxignore): data.csv");
    expect([util, data]).toEqual([[true], [false]]);
    expect(nextStep(repo)).toBe("Next: arnx review (every file: no commits yet)");
  });

test("a --range review's diff and snapshot are byte-identical to before (b838807), untracked files present or not",
  () => {
    const repo = initRepo(join(tmp(), "range"));
    const w = (p: string, t: string) => {
      mkdirSync(join(repo, p, ".."), { recursive: true });
      writeFileSync(join(repo, p), t);
    };
    w("app.py", "def add(a, b):\n    return a + b\n");
    w(".arnxignore", "data/\n");
    commit(repo, "one");
    w("app.py", "def add(a, b):\n    return a - b\n");
    w("lib/util.py", "X = 1\n");
    w("data/dump.csv", "a,b\n");
    w(".env", "T=1\n");
    commit(repo, "two");
    // Uncommitted, staged and untracked work, and an accepted test: a range never looks at the working tree.
    w("notes.md", "private KPI\n");
    w("app.py", "changed\n");
    w("staged.py", "S = 1\n");
    runGit(repo, "add", "staged.py");
    w("tests/arnx/r20261020_abcdef/test_x.py", "x\n");
    // Captured from b838807 (before untracked files were opt-in) on this same repository.
    const DIFF = "diff --git a/app.py b/app.py\nindex 4693ad3..12ee743 100644\n--- a/app.py\n+++ b/app.py\n" +
      "@@ -1,2 +1,2 @@\n def add(a, b):\n-    return a + b\n+    return a - b\ndiff --git a/lib/util.py b/lib/util.py\n" +
      "new file mode 100644\nindex 0000000..9676680\n--- /dev/null\n+++ b/lib/util.py\n@@ -0,0 +1 @@\n+X = 1\n";
    const TREE = { ".arnxignore": "data/\n", "app.py": "def add(a, b):\n    return a - b\n", "lib/util.py": "X = 1\n" };
    const head = runGit(repo, "rev-parse", "HEAD").trim(), base = runGit(repo, "rev-parse", "HEAD~1").trim();
    for (const untracked of [undefined, false, true]) {
      const c = resolveChange(repo, "HEAD~1..HEAD", [], untracked === undefined ? {} : { untracked });
      // The same Change as before: no new key (withUntracked, untrackedIncluded, untrackedLeftOut) on a range.
      expect(c).toEqual({ kind: "range", base, head, diff: DIFF, files: ["app.py", "lib/util.py"],
        ignored: ["data/dump.csv"] });
      const dest = join(tmp(), `snap-${untracked}`);
      expect(snapshot(repo, c.head, dest, [], { untracked: !!untracked })).toEqual([]);
      const tree = (rel: string): [string, string][] => {
        const full = join(dest, rel);
        return statSync(full).isDirectory()
          ? readdirSync(full).sort().flatMap((n) => tree(rel ? `${rel}/${n}` : n))
          : [[rel, readFileSync(full, "utf8")]];
      };
      expect(Object.fromEntries(tree(""))).toEqual(TREE);
    }
  });

test("a --range review says nothing about untracked files and records no untracked field", async () => {
  const repo = repoWithWork();
  commit(repo, "the change"); // commits docs/kpi.md too; a new untracked file stays in the working tree
  writeFileSync(join(repo, "scratch.md"), "scratch\n");
  const { said, json, md } = await review(repo, { range: "HEAD~1..HEAD", untracked: false });
  expect(said[0]).toBe("main (1/1): preparing the test environment");
  expect(Object.keys(json).filter((k) => k.startsWith("untracked"))).toEqual([]);
  expect(md).not.toContain("Untracked");
});

test("setup reads tracked files only unless --untracked; the preview says what is left out; approve follows " +
  "[review] untracked", async () => {
  const repo = repoWithWork();
  const s = loadSettings(repo);
  expect(setupPreview(repo, s)).not.toContain("kpi"); // one line: untracked files are not listed
  const setup = async (untracked?: boolean) => {
    const held: boolean[] = [];
    const model = new ScriptedAgent([[tool("read_file", { path: KPI }), tool("list_dir", { path: "." })],
      [tool("propose", { yaml: YAML })], [text("done")]]);
    const r = await runSetup(repo, s, model, { outDir: join(tmp(), `setup-${untracked}`),
      sessionFactory: async (_c, snap, _l, body) => {
        held.push(existsSync(join(snap, KPI)));
        return body(new FakeSession(snap, () => [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed",
          false]));
      }, ...(untracked !== undefined ? { untracked } : {}) });
    expect(r.ok).toBe(true);
    return { held, sent: JSON.stringify(model.calls), results: firstResults(model) };
  };
  const plain = await setup();
  expect(plain.held.every((h) => !h)).toBe(true);
  expect(plain.sent).not.toContain(PRIVATE);
  expect(plain.results).toEqual(["ToolError: not a file: docs/kpi.md", "app.py"]);
  const opted = await setup(true);
  expect(opted.held.every((h) => h)).toBe(true);
  expect(opted.sent).toContain(PRIVATE);
  // approve runs the suites on what reviews will see
  const approve = async (settings: Settings) => {
    writeSettings(repo, settings);
    writeFileSync(reviewConfigPath(repo), YAML);
    const held: boolean[] = [];
    const [ok] = await approveFile(repo, { by: "Dev", at: "2026-10-20", sessionFactory: async (_c, snap, _l, body) => {
      held.push(existsSync(join(snap, KPI)));
      return body(new FakeSession(snap, () => [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed",
        false]));
    } });
    expect(ok).toBe(true);
    return held;
  };
  expect(await approve(SETTINGS)).toEqual([false]);
  expect(await approve({ ...SETTINGS, untracked: true })).toEqual([true]);
});

test("next and the after-approval hint count only what would be sent, and name untracked files left out", async () => {
  const repo = repoWithWork();
  const n = whatNext(repo);
  expect(n.command).toBe("arnx review");
  expect(n.where).toMatch(/^uncommitted \(base [0-9a-f]{7}\), not reviewed yet$/);
  expect(n.note).toBe("1 untracked file left out (`--untracked` includes them): docs/kpi.md");
  expect(nextStep(repo)).toBe("Next: arnx review (your uncommitted work: app.py)");
  expect(nextStep(repo, true)).toBe("Next: arnx review (your uncommitted work: app.py, docs/kpi.md)");
  runGit(repo, "checkout", "--", "app.py"); // only the untracked file is left: the last commit, as on a clean tree
  expect(nextStep(repo)).toMatch(/^Next: arnx review \(the last commit: [0-9a-f]+ initial\)$/);
  writeSettings(repo, { ...SETTINGS, untracked: true }); // [review] untracked: next follows it
  expect(whatNext(repo).where).toMatch(/^uncommitted \(base [0-9a-f]{7}\), not reviewed yet$/);
  expect(whatNext(repo).note).toMatch(/^including 1 untracked/);
});

test("[review] untracked: config.toml reads and writes it; the flags parse, and both at once are refused", async () => {
  const repo = gitRepo(tmp());
  writeSettings(repo, { ...SETTINGS, untracked: true });
  expect(readFileSync(settingsPath(repo), "utf8")).toContain("\nuntracked = true ");
  expect(loadSettings(repo).untracked).toBe(true);
  writeSettings(repo, SETTINGS);
  expect(readFileSync(settingsPath(repo), "utf8")).not.toContain("untracked"); // the default is not written
  expect(loadSettings(repo).untracked).toBe(false);
  writeFileSync(settingsPath(repo), "[review]\nuntracked = \"yes\"\n");
  expect(() => loadSettings(repo)).toThrow("review.untracked: write true or false");
  const bare = gitRepo(join(tmp(), "bare"));
  const cli = new Cli({ cwd: bare });
  expect(await cli.run("review", "--untracked", "--no-untracked")).toBe(2);
  expect(cli.stderr + cli.stdout).toContain("--untracked and --no-untracked cannot be used together");
  expect(await cli.run("review", "--untracked")).toBe(3); // parsed: reached the missing config
  expect(await cli.run("review", "--no-untracked")).toBe(3);
  expect(await cli.run("setup", "--untracked")).toBe(3);
});

test("check runs on the working tree with its untracked files (accepted tests are untracked); an answer round, " +
  "which a model writes, sees tracked files only", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "svc/tests/arnx/r1"), { recursive: true });
  writeFileSync(join(repo, "svc/calc.py"), "X = 1\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile("version: 1\nprojects:\n  svc:\n    root: svc\n" +
    "    image: python:3.12-slim\n    test_command: python -m pytest {targets}\n"), "Dev", "2026-10-20"));
  commit(repo, "layout");
  writeFileSync(join(repo, "svc/tests/arnx/r1/test_r1_calc.py"), "def test_ok(): pass\n"); // accepted, uncommitted
  const held: boolean[] = [];
  await check(repo, SETTINGS, { sessionFactory: async (_c, snap, _l, body) => {
    held.push(existsSync(join(snap, "svc/tests/arnx/r1/test_r1_calc.py")));
    return body(new FakeSession(snap, () => [junitXml([["tests/arnx/r1/test_r1_calc.py", "test_ok", "passed", ""]]),
      "1 passed", false]));
  } });
  expect(held).toEqual([true]);
  const round = async (untracked?: boolean) => {
    const seen: boolean[] = [];
    await testRound(repo, null, parseReviewConfig(YAML), {
      ...answerRound(new ScriptedAgent([[text("{\"tests\": []}")]]), parseReviewConfig(YAML)),
      writeDir: "tests/arnx_generated", budgetUsd: 1, runs: 1,
      outDir: join(tmp(), `round-${untracked}`), sessionFactory: async (_c, snap, _l, body) => {
        seen.push(existsSync(join(snap, "svc/tests/arnx/r1/test_r1_calc.py")));
        return body(new FakeSession(snap, () => [null, "", false]));
      }, ...(untracked !== undefined ? { untracked } : {}) });
    return seen;
  };
  expect(await round()).toEqual([false]);
  expect(await round(true)).toEqual([true]);
});

test("accepted tests not committed yet stay in a tracked-only snapshot: they are arnx's own, not the owner's files", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "tests/arnx/r20261020_abcdef"), { recursive: true });
  writeFileSync(join(repo, "tests/arnx/r20261020_abcdef/test_kept.py"), "def test_kept():\n    assert True\n");
  writeFileSync(join(repo, "notes.md"), "private\n");
  const dest = join(tmp(), "snap");
  snapshot(repo, null, dest, [], { untracked: false });
  expect(existsSync(join(dest, "tests/arnx/r20261020_abcdef/test_kept.py"))).toBe(true);
  expect(existsSync(join(dest, "notes.md"))).toBe(false);
});
