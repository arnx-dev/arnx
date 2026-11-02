// A first review on a repository with no test environment sets up only the projects its change touches, from the
// draft and with no model when the draft runs, each proven by a quick look (the listing, arnx's one-line test, a few
// small files) instead of its whole suite. The projects left for later wait under uncovered until a change touches
// them; a later proof runs only the projects that changed since the last one.
import { expect, test } from "bun:test";
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { writeBaseline } from "../src/baseline";
import { filesAt } from "../src/change";
import { parseReviewFile, reviewConfigPath, stampedQuick } from "../src/config";
import { detect } from "../src/detect";
import { NOT_SET_UP, quickDraft } from "../src/draft";
import type { RunResult, Runner, SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { approveFile, NOTHING_TO_TEST, runSetup } from "../src/setup";
import { ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const TESTS = ["tests/test_a.py", "tests/test_b.py", "tests/test_c.py", "tests/test_d.py", "tests/test_e.py"];

/** An answer to one command: its exit code, its output, and the JUnit report it writes (if any). */
interface Answer { exit?: number; output?: string; xml?: string }

/** A Docker session whose commands answer by what they are: a listing (`--collect-only`), or a run. */
class Session implements Runner {
  commands: string[] = [];
  constructor(readonly snap: string, readonly answer: (command: string) => Answer) {}
  run(command: string): RunResult {
    this.commands.push(command);
    const a = this.answer(command);
    const m = /--junitxml=\/src\/(\S+)/.exec(command);
    if (a.xml && m) {
      mkdirSync(dirname(join(this.snap, m[1]!)), { recursive: true });
      writeFileSync(join(this.snap, m[1]!), a.xml);
    }
    return { exitCode: a.exit ?? 0, output: a.output ?? "", timedOut: false, seconds: 0.1 };
  }
}

const passed = (files: string[]) => junitXml(files.map((f) => [f, "test_x", "passed", ""] as [string, string, string, string]));

/** Answers as a runner over `root` would: the listing names its test files, the one-line test is listed when asked,
 * a run of some files passes them, the whole suite passes everything. `list`: a listing of its own. */
function runner(root: string, list?: Answer) {
  const files = TESTS.map((f) => root === "." ? f : `${root}/${f}`);
  return (command: string): Answer => {
    const probe = /(\S*test_arnx_probe\.py)/.exec(command)?.[1];
    if (command.includes("--collect-only")) {
      if (probe) return { output: `${probe}::test_arnx_probe` };
      return list ?? { output: TESTS.map((f) => `${f}::test_x`).join("\n") + "\n\n5 tests collected in 0.01s" };
    }
    if (probe) return { xml: passed([probe]), output: "1 passed" };
    const targets = TESTS.filter((f) => command.includes(f));
    if (targets.length) return { xml: passed(targets.map((f) => files[TESTS.indexOf(f)]!)), output: "passed" };
    return { xml: passed(files), output: "5 passed" };
  };
}

function factory(answer: (command: string) => Answer, seen: Session[]): SessionFactory {
  return async (_cfg, snap, _log, body) => {
    const s = new Session(snap, answer);
    seen.push(s);
    return body(s);
  };
}

/** A repository with a Python project in svc/ (five test files, growing from a to e) and a vitest one in web/. */
function twoProjects(): string {
  const r = gitRepo(tmp());
  const put = (path: string, text: string) => {
    mkdirSync(dirname(join(r, path)), { recursive: true });
    writeFileSync(join(r, path), text);
  };
  put("svc/pyproject.toml", "[project]\nname = \"svc\"\nversion = \"0.1\"\n");
  put("svc/app.py", "def f():\n    return 1\n");
  TESTS.forEach((f, i) => put(`svc/${f}`, "def test_x():\n    pass\n" + "# padding\n".repeat(i * 10)));
  put("web/package.json", JSON.stringify({ name: "web", scripts: { test: "vitest run" },
    devDependencies: { vitest: "1.0.0" } }));
  put("web/src/a.ts", "export const a = 1;\n");
  put("web/tests/a.test.ts", "import { test } from \"vitest\";\ntest(\"x\", () => {});\n");
  commit(r, "two projects");
  return r;
}

const detected = (repo: string) => detect(repo, filesAt(repo, null, false));

test("the quick draft keeps the project a changed file is in; the others wait under uncovered", () => {
  const repo = twoProjects();
  const q = quickDraft(detected(repo), ["svc/app.py"])!;
  expect(q.names).toEqual(["svc"]);
  const f = parseReviewFile(q.yaml);
  expect(f.projects.map((p) => p.name)).toEqual(["svc"]);
  expect(f.uncovered).toEqual([{ path: "/web/", reason: NOT_SET_UP }]);
  // A change in web/ later: web joins the file (its stamp left out), svc stays as it was, the entry under uncovered
  // goes.
  const later = quickDraft(detected(repo), ["web/src/a.ts"], `${q.yaml}approved:\n  by: Dev\n`)!;
  expect(later.yaml).not.toContain("approved");
  expect(later.names).toEqual(["web"]);
  const g = parseReviewFile(later.yaml);
  expect(g.projects.map((p) => p.name)).toEqual(["svc", "web"]);
  expect([g.projects[0]!.install, g.projects[0]!.testCommand]).toEqual([f.projects[0]!.install, f.projects[0]!.testCommand]);
  expect(g.uncovered).toEqual([]);
});

test("no drafted project owns the change: no quick draft", () => {
  const repo = twoProjects();
  writeFileSync(join(repo, "README.md"), "# two\n");
  expect(quickDraft(detected(repo), ["README.md"])).toBeNull();
});

test("a quick setup runs the draft with no model: the listing, the one-line test, three small files, no whole suite",
  async () => {
  const repo = twoProjects();
  const model = new ScriptedAgent([]);
  const sessions: Session[] = [];
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "s"),
    sessionFactory: factory(runner("svc"), sessions), quick: { files: ["svc/app.py"] } });
  expect(r.ok).toBe(true);
  expect(model.calls).toHaveLength(0);
  expect(r.costUsd).toBe(0);
  expect(parseReviewFile(r.yamlText!).projects.map((p) => p.name)).toEqual(["svc"]);
  expect(r.runs.map((x) => x.name)).toEqual(["svc"]);
  expect(r.runs[0]!.summary).toStartWith("quick look: 5 tests listed, 3 small files ran: 3 passed");
  const commands = sessions.flatMap((s) => s.commands);
  // Every run named its files: the listings, the sample, the one-line test. The whole suite never ran.
  const runs = commands.filter((c) => !c.includes("--collect-only"));
  expect(runs.every((c) => c.includes("test_arnx_probe") || TESTS.slice(0, 3).some((f) => c.includes(f)))).toBe(true);
  expect(runs.some((c) => TESTS.slice(3).some((f) => c.includes(f)))).toBe(false);
});

test("a quick setup whose change no drafted project owns stops before anything runs", async () => {
  const repo = twoProjects();
  writeFileSync(join(repo, "README.md"), "# two\n");
  const sessions: Session[] = [];
  const r = await runSetup(repo, defaultSettings(), new ScriptedAgent([]), { outDir: join(tmp(), "s"),
    sessionFactory: factory(runner("svc"), sessions), quick: { files: ["README.md"] } });
  expect([r.ok, r.stop, sessions.length]).toEqual([false, NOTHING_TO_TEST, 0]);
});

test("a draft that does not run goes to the agent, with what stopped it, and the agent's file is set up quickly",
  async () => {
  const repo = twoProjects();
  let listings = 0;
  const answer = runner("svc");
  // The first listing fails (a plugin the draft did not install); the agent's file lists and runs.
  const flaky = (command: string): Answer => command.includes("--collect-only") && !command.includes("arnx_probe") &&
    listings++ === 0 ? { exit: 4, output: "ERROR: usage: unrecognized arguments: --cov" } : answer(command);
  const fixed = "version: 1\nprojects:\n  svc:\n    root: svc\n    language: python\n    image: python:3.12\n" +
    "    install: [pip install pytest pytest-cov]\n    test_command: python -m pytest {targets}\nuncovered:\n" +
    `  - path: /web/\n    reason: "${NOT_SET_UP}"\n`;
  const model = new ScriptedAgent([[tool("propose", { yaml: fixed })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "s"),
    sessionFactory: factory(flaky, []), quick: { files: ["svc/app.py"] } });
  expect(model.calls.length).toBeGreaterThan(0);
  const prompt = JSON.stringify(model.calls[0]!.messages);
  expect(prompt).toContain("# refused: propose ran the projects");
  expect(prompt).toContain("unrecognized arguments: --cov");
  expect(r.ok).toBe(true);
  expect(r.runs[0]!.summary).toStartWith("quick look:");
});

test("the proof stamps the projects a quick look proved; proved again, they get a quick look, not the whole suite",
  async () => {
  const repo = twoProjects();
  const r = await runSetup(repo, defaultSettings(), new ScriptedAgent([]), { outDir: join(tmp(), "s"),
    sessionFactory: factory(runner("svc"), []), quick: { files: ["svc/app.py"] } });
  writeFileSync(reviewConfigPath(repo), r.yamlText!);
  writeBaseline(repo, new Map(r.projects.map((p) => [p.name, p.failed ?? []])));
  const [ok] = await approveFile(repo, { by: "Dev", at: "2026-10-30", afterSetup: r.runs, quick: ["svc"] });
  expect(ok).toBe(true);
  const stamped = parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8"));
  expect(stampedQuick(stamped)).toEqual(["svc"]);
  // The file changes: the proof runs again, as a quick look (the CLI passes the list from the proven copy), and
  // keeps the project's level.
  const text = readFileSync(reviewConfigPath(repo), "utf8").replace("pip install pytest hypothesis",
    "pip install pytest hypothesis requests");
  writeFileSync(reviewConfigPath(repo), text);
  const sessions: Session[] = [];
  const [again, , suites] = await approveFile(repo, { by: "Dev", at: "2026-10-30", quick: ["svc"],
    sessionFactory: factory(runner("svc"), sessions) });
  expect(again).toBe(true);
  expect(suites[0]!.summary).toStartWith("quick look:");
  const runs = sessions.flatMap((s) => s.commands).filter((c) => !c.includes("--collect-only"));
  expect(runs.some((c) => TESTS.slice(3).some((f) => c.includes(f)))).toBe(false);
  expect(stampedQuick(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8"))))
    .toEqual(["svc"]);
});

test("a proof after a change to one project runs only that project; the others keep their last proof", async () => {
  const repo = twoProjects();
  const yaml = "version: 1\nprojects:\n" + ["a", "b"].map((n) => `  ${n}:\n    root: svc\n    language: python\n` +
    `    image: python:3.12\n    install: [pip install pytest]\n    test_command: python -m pytest {targets}\n` +
    `    owns: [${n === "a" ? "svc/app.py" : "svc/tests/"}]\n`).join("") + "uncovered:\n  - path: /web/\n" +
    "    reason: web\n  - path: /svc/pyproject.toml\n    reason: manifest\n";
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), yaml);
  const last = parseReviewFile(yaml);
  const { projectDigest, restDigest } = await import("../src/config");
  const unchanged = { projects: Object.fromEntries(last.projects.map((p) => [p.name, projectDigest(last, p.name)])),
    rest: restDigest(last), baseline: new Map() };
  writeFileSync(reviewConfigPath(repo), yaml.replace("install: [pip install pytest]\n    test_command: python -m pytest {targets}\n    owns: [svc/app.py]",
    "install: [pip install pytest requests]\n    test_command: python -m pytest {targets}\n    owns: [svc/app.py]"));
  const lines: string[] = [];
  const sessions: Session[] = [];
  const [ok, , suites] = await approveFile(repo, { by: "Dev", at: "2026-10-30", unchanged,
    sessionFactory: factory(runner("svc"), sessions), progress: (l) => lines.push(l) });
  expect(ok).toBe(true);
  expect(suites.map((s) => [s.name, !!s.reused])).toEqual([["a", false], ["b", true]]);
  expect(lines).toContain("b: ✓ unchanged since its proof");
  expect(sessions).toHaveLength(1);
});

test("the review's last progress line says what came of the things it checked", async () => {
  const { checkedLine } = await import("../src/reviewer");
  const s = (outcome: string) => ({ project: "svc", id: "S1", outcome }) as never;
  expect(checkedLine([s("proven"), s("not reproduced"), s("not tested")])).toBe("Checked 3: 1 proven, 2 dropped");
  // One thing checked that proved two issues: the count matches the two "✓ proven" lines.
  expect(checkedLine([s("proven"), s("disputed")], 2)).toBe("Checked 2: 1 proven (2 issues), 1 dropped");
  expect(checkedLine([s("proven"), s("same cause"), s("pending answer"), s("pre-existing"), s("disputed")]))
    .toBe("Checked 5: 2 proven, 1 needs your answer, 1 failing before this change too, 1 dropped");
});

test("a root project in the quick draft owns what the other drafted projects leave", () => {
  const repo = twoProjects();
  writeFileSync(join(repo, "pyproject.toml"), "[project]\nname = \"top\"\nversion = \"0.1\"\n");
  mkdirSync(join(repo, "tests"), { recursive: true });
  writeFileSync(join(repo, "tests/test_top.py"), "def test_x():\n    pass\n");
  writeFileSync(join(repo, "top.py"), "X = 1\n");
  commit(repo, "root project");
  const q = quickDraft(detected(repo), ["top.py"])!;
  const f = parseReviewFile(q.yaml);
  const top = f.projects.find((p) => p.workdir === ".")!;
  expect(top.owns).toEqual(["**", "!/svc/", "!/web/"]);
  expect(f.uncovered.map((u) => u.path).sort()).toEqual(["/svc/", "/web/"]);
});

test("the projects a quick look proves come from the caller, never from the file's own stamp", async () => {
  const repo = twoProjects();
  const r = await runSetup(repo, defaultSettings(), new ScriptedAgent([]), { outDir: join(tmp(), "s"),
    sessionFactory: factory(runner("svc"), []), quick: { files: ["svc/app.py"] } });
  writeFileSync(reviewConfigPath(repo), r.yamlText!);
  writeBaseline(repo, new Map());
  expect((await approveFile(repo, { by: "Dev", at: "2026-10-30", afterSetup: r.runs, quick: ["svc"] }))[0]).toBe(true);
  // The file changes; its stamp still names svc. Without the caller's list, svc runs its whole suite.
  const text = readFileSync(reviewConfigPath(repo), "utf8").replace("pip install pytest hypothesis",
    "pip install pytest hypothesis requests");
  writeFileSync(reviewConfigPath(repo), text);
  expect(text).toContain("quick:");
  const [ok, , suites] = await approveFile(repo, { by: "Dev", at: "2026-10-30",
    sessionFactory: factory(runner("svc"), []) });
  expect(ok).toBe(true);
  expect(suites[0]!.summary).not.toStartWith("quick look");
  expect(stampedQuick(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")))).toEqual([]);
});

test("a change outside the projects (sandbox_only) proves every project again", async () => {
  const repo = twoProjects();
  const yaml = "version: 1\nprojects:\n  a:\n    root: svc\n    language: python\n    image: python:3.12\n" +
    "    install: [pip install pytest]\n    test_command: python -m pytest {targets}\n";
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), yaml);
  const { projectDigest, restDigest } = await import("../src/config");
  const last = parseReviewFile(yaml);
  const unchanged = { projects: { a: projectDigest(last, "a") }, rest: restDigest(last), baseline: new Map() };
  writeFileSync(reviewConfigPath(repo), `${yaml}sandbox_only: [svc/app.py]\n`);
  const sessions: Session[] = [];
  const [, , suites] = await approveFile(repo, { by: "Dev", at: "2026-10-30", unchanged,
    sessionFactory: factory(runner("svc"), sessions) });
  expect(suites[0]!.reused).toBeUndefined();
  expect(sessions).toHaveLength(1);
});

test("a quick look leaves in the baseline the tests it did not run", async () => {
  const { runSuite } = await import("../src/setup");
  const repo = twoProjects();
  const cfg = parseReviewFile("version: 1\nprojects:\n  svc:\n    root: svc\n    language: python\n" +
    "    image: python:3.12\n    install: [pip install pytest]\n    test_command: python -m pytest {targets}\n")
    .projects[0]!;
  const snap = join(tmp(), "snap");
  cpSync(repo, snap, { recursive: true });
  const baseline = [{ id: "svc/tests/test_e.py::test_x", file: "svc/tests/test_e.py", first: "assert 1 == 2" }];
  const [ok, , , , , , counts] = await runSuite(cfg, snap, join(tmp(), "log"), { precheck: true, quick: true,
    baseline, sessionFactory: factory(runner("svc"), []) });
  expect(ok).toBe(true);
  expect(counts.left).toEqual([]);
});

test("a quick look over many test files is not taken for a test_command that leaves most of them out", async () => {
  const r0 = gitRepo(tmp());
  const many = Array.from({ length: 25 }, (_, i) => `tests/test_${String(i).padStart(2, "0")}.py`);
  writeFileSync(join(r0, "pyproject.toml"), "[project]\nname = \"big\"\nversion = \"0.1\"\n");
  writeFileSync(join(r0, "app.py"), "X = 1\n");
  mkdirSync(join(r0, "tests"), { recursive: true });
  many.forEach((f, i) => writeFileSync(join(r0, f), "def test_x():\n    pass\n" + "#\n".repeat(i)));
  commit(r0, "big");
  const answer = (command: string): Answer => {
    const probe = /(\S*test_arnx_probe\.py)/.exec(command)?.[1];
    if (command.includes("--collect-only")) {
      return { output: probe ? `${probe}::test_arnx_probe`
        : many.map((f) => `${f}::test_x`).join("\n") + `\n\n${many.length} tests collected in 0.01s` };
    }
    const ran = probe ? [probe] : many.filter((f) => command.includes(f));
    return { xml: passed(ran), output: `${ran.length} passed` };
  };
  const model = new ScriptedAgent([]);
  const r = await runSetup(r0, defaultSettings(), model, { outDir: join(tmp(), "s"),
    sessionFactory: factory(answer, []), quick: { files: ["app.py"] } });
  expect(model.calls).toHaveLength(0);
  expect(r.ok).toBe(true);
  expect(r.runs[0]!.summary).toStartWith("quick look: 25 tests listed, 3 small files ran");
});

test("in a quick setup the agent's file keeps only the projects the change touches; the others wait, never tried",
  async () => {
  const repo = twoProjects();
  let listings = 0;
  const answer = runner("svc");
  const flaky = (command: string): Answer => command.includes("--collect-only") && !command.includes("arnx_probe") &&
    listings++ === 0 ? { exit: 4, output: "ERROR: usage: unrecognized arguments: --cov" } : answer(command);
  const both = "version: 1\nprojects:\n  svc:\n    root: svc\n    language: python\n    image: python:3.12\n" +
    "    install: [pip install pytest pytest-cov]\n    test_command: python -m pytest {targets}\n  web:\n" +
    "    root: web\n    language: typescript\n    image: node:22\n    install: [npm install]\n" +
    "    test_command: npx vitest run {targets}\n";
  const model = new ScriptedAgent([[tool("try_project", { yaml: both, project: "web" })],
    [tool("propose", { yaml: both })], [text("done")]]);
  const sessions: Session[] = [];
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "s"),
    sessionFactory: factory(flaky, sessions), quick: { files: ["svc/app.py"] } });
  expect(JSON.stringify(model.calls[1]!.messages.at(-1))).toContain("refused: this setup is for a first review");
  expect(r.ok).toBe(true);
  const f = parseReviewFile(r.yamlText!);
  expect(f.projects.map((p) => p.name)).toEqual(["svc"]);
  expect(f.uncovered).toContainEqual({ path: "/web/", reason: NOT_SET_UP });
  expect(sessions.flatMap((s) => s.commands).some((c) => c.includes("vitest"))).toBe(false);
  expect(r.waiting).toBeUndefined();
});

test("a project that only uses a changed file waits in a quick setup; only the file's owner is set up", async () => {
  const repo = twoProjects();
  let listings = 0;
  const answer = runner("svc");
  const both = "version: 1\nprojects:\n  svc:\n    root: svc\n    language: python\n    image: python:3.12\n" +
    "    install: [pip install pytest]\n    test_command: python -m pytest {targets}\n  web:\n" +
    "    root: web\n    language: typescript\n    image: node:22\n    install: [npm install]\n" +
    "    test_command: npx vitest run {targets}\n    uses: [svc/]\n";
  const model = new ScriptedAgent([[tool("propose", { yaml: both })], [text("done")]]);
  const sessions: Session[] = [];
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "s"),
    sessionFactory: factory((c) => c.includes("--collect-only") && !c.includes("arnx_probe") && listings++ === 0
      ? { exit: 4, output: "ERROR: usage: unrecognized arguments: --cov" } : answer(c), sessions),
    quick: { files: ["svc/app.py"] } });
  expect(model.calls.length).toBeGreaterThan(0);
  expect(r.ok).toBe(true);
  const f = parseReviewFile(r.yamlText!);
  expect(f.projects.map((p) => p.name)).toEqual(["svc"]);
  expect(f.uncovered).toContainEqual({ path: "/web/", reason: NOT_SET_UP });
  expect(sessions.flatMap((s) => s.commands).some((c) => c.includes("vitest"))).toBe(false);
  // Its tests do not run in the review: setup names it, so the review can say so.
  expect(r.waiting).toEqual(["web"]);
});
