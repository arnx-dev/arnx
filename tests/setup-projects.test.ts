import { beforeEach, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isFileApproved, parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { approveFile, coverageMap, describeCoverage, runSetup } from "../src/setup";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
let repo = "";
let ran: string[] = [];
beforeEach(() => {
  repo = gitRepo(tmp()); // holds app.py at the root
  for (const p of ["services/pay/a.py", "services/feed/b.py", "services/shared/db.py", "infra/main.tf"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "X = 1\n");
  }
  commit(repo, "layout");
  ran = [];
});
const passing: SessionFactory = async (cfg, snap, _log, body) => {
  ran.push(cfg.name);
  return body(new FakeSession(snap, () => [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false]));
};
const result = (m: ScriptedAgent, call: number) =>
  (m.calls[call]!.messages.at(-1)!.content as Record<string, unknown>[]).map((r) => String(r.content)).join("\n");
const COVERED = PROJECTS.replace("uncovered:\n", "uncovered:\n  - {path: /app.py, reason: \"legacy script, no tests\"}\n");

test("propose checks the file first, then runs the projects not yet proven itself", async () => {
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: PROJECTS, project: "pay" })],
    [tool("propose", { yaml: PROJECTS })],
    [tool("propose", { yaml: COVERED })],
    [text("Two services.")],
  ]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: passing });
  expect(result(m, 2)).toContain("source files outside every project, by folder");
  expect(result(m, 2)).toContain("- /app.py (1 file): no tests");
  expect(result(m, 2)).toContain("not proven yet: feed");
  expect(ran).toEqual(["pay", "feed"]); // the refused propose ran nothing; the second ran feed, never pay again
  expect(result(m, 3)).toContain("accepted");
  expect([r.ok, r.yamlText]).toEqual([true, COVERED]);
});

test("trying a project again in the same form returns its proof without running it", async () => {
  const otherFeed = COVERED.replace("services: [db, mq]", "services: [db]");
  const m = new ScriptedAgent([
    [tool("try_project", { yaml: COVERED, project: "pay" })],
    [tool("try_project", { yaml: otherFeed, project: "pay" })], // only feed's part changed
    [tool("propose", { yaml: otherFeed })],
    [text("done")],
  ]);
  await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: passing });
  expect(result(m, 2)).toContain("not run again");
  expect(ran).toEqual(["pay", "feed"]);
});

test("propose refuses with the output of a project that does not run when it runs it", async () => {
  const failing: SessionFactory = async (cfg, snap, _log, body) => {
    ran.push(cfg.name);
    const outcome = cfg.name === "feed" ? "failed" : "passed";
    return body(new FakeSession(snap, () => [junitXml([["tests/test_a.py", "test_a", outcome, "boom"]]), "", false]));
  };
  const m = new ScriptedAgent([[tool("try_project", { yaml: COVERED, project: "pay" })],
    [tool("propose", { yaml: COVERED })], [text("x")]]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: failing });
  expect(result(m, 2)).toContain("the suite of feed does not run yet");
  expect(r.ok).toBe(false);
});

test("owned paths may not overlap", async () => {
  const overlap = COVERED.replace("    uses: [services/shared/]\n  feed:", "    owns: [services/]\n  feed:");
  const m = new ScriptedAgent([[tool("try_project", { yaml: overlap, project: "pay" })],
    [tool("try_project", { yaml: overlap, project: "feed" })], [tool("propose", { yaml: overlap })], [text("x")]]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: passing });
  expect(result(m, 3)).toContain("owned by more than one project: services/feed/b.py (feed, pay)");
  expect(r.ok).toBe(false);
});

test("a single-project file owns everything", async () => {
  const yaml = "version: 1\nimage: i\ntest_command: pytest {targets}\n";
  const m = new ScriptedAgent([[tool("try_project", { yaml })], [tool("propose", { yaml })], [text("ok")]]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: passing });
  expect(r.ok).toBe(true);
});

function approved(text: string): void {
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(text), "Dev", "2026-10-12"));
}

test("setup --project re-proves one project and keeps the others as approved", async () => {
  approved(COVERED);
  const newPay = COVERED.replace("install: [pip install pytest]", "install: [pip install pytest hypothesis]");
  const badFeed = newPay.replace("services: [db, mq]", "services: [db]");
  const m = new ScriptedAgent([[tool("try_project", { yaml: newPay, project: "pay" })],
    [tool("propose", { yaml: badFeed })], [tool("propose", { yaml: newPay })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: passing,
    project: "pay" });
  expect(String(m.calls[0]!.messages[0]!.content)).toContain("Re-prove only the project `pay`");
  expect(result(m, 2)).toContain("must stay as approved: feed");
  expect([r.ok, r.yamlText]).toEqual([true, newPay]);
  expect(ran).toEqual(["pay"]);
});

test("setup --project: try_project takes the project's settings alone, over the approved file", async () => {
  approved(COVERED);
  const newPay = COVERED.replace("install: [pip install pytest]", "install: [pip install pytest hypothesis]");
  const pay = "root: services/pay\nlanguage: python\nimage: python:3.12-slim\ninstall: [pip install pytest hypothesis]\n" +
    "test_command: python -m pytest -q {targets}\nservices: [db]\n" +
    "env: {DATABASE_URL: postgresql://postgres@db:5432/postgres}\nuses: [services/shared/]\n";
  const m = new ScriptedAgent([[tool("try_project", { project: "pay", project_yaml: pay })],
    [tool("propose", { yaml: newPay })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: passing,
    project: "pay" });
  expect(result(m, 1)).toContain("the suite of pay runs");
  // propose finds pay unchanged since it ran: the settings alone made the same project.
  expect([r.ok, r.yamlText]).toEqual([true, newPay]);
  expect(ran).toEqual(["pay"]);
});

test("setup --add has the agent try every uncovered entry again and drop the ones it covers", async () => {
  approved(COVERED);
  const m = new ScriptedAgent([[text("nothing to add")]]);
  await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: passing, add: true });
  const task = String(m.calls[0]!.messages[0]!.content);
  expect(task).toContain("Try every entry under uncovered again, whatever its reason says: the user may have fixed " +
    "the cause since setup wrote it, so the reason may be stale. Remove an entry once a project owns or uses its " +
    "files, and update the reason of one that still cannot be tested.");
  expect(task).toContain("reason: Terraform; no adapter");
});

test("approve --project reruns one project, and only when the others are unchanged", async () => {
  approved(COVERED);
  // the owner edits the approved file: the approved block stays, as it would in an editor
  const stampBlock = (() => { const s = readFileSync(reviewConfigPath(repo), "utf8"); return s.slice(s.indexOf("approved:")); })();
  const newPay = COVERED.replace("install: [pip install pytest]", "install: [pip install pytest hypothesis]") + stampBlock;
  writeFileSync(reviewConfigPath(repo), newPay);
  let [ok, detail] = await approveFile(repo, { by: "Dev", at: "x", project: "pay", sessionFactory: passing });
  expect(ok).toBe(true);
  expect(ran).toEqual(["pay"]);
  expect(isFileApproved(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")))).toBe(true);
  writeFileSync(reviewConfigPath(repo), newPay.replace("services: [db, mq]", "services: [db]"));
  [ok, detail] = await approveFile(repo, { by: "Dev", at: "x", project: "pay", sessionFactory: passing });
  expect(ok).toBe(false);
  expect(detail).toContain("feed changed since its proof");
  ran = [];
  [ok] = await approveFile(repo, { by: "Dev", at: "x", sessionFactory: passing });
  expect(ok).toBe(true);
  expect(ran).toEqual(["pay", "feed"]);
});

test("the coverage map counts files per project and what is left out", () => {
  const map = coverageMap(repo, parseReviewFile(COVERED));
  expect(map.projects).toEqual([{ name: "pay", owned: 1, used: 1 }, { name: "feed", owned: 1, used: 1 }]);
  expect(map.uncovered).toEqual([{ path: "/app.py", reason: "legacy script, no tests", files: 1 },
    { path: "infra/", reason: "Terraform; no adapter", files: 1 }]);
  expect(map.unexplained).toEqual([]);
  expect(map.overlaps).toEqual([]);
});

test("the coverage map counts what the snapshot holds: tracked files, and untracked ones (named as such) only when " +
  "they are read", () => {
  writeFileSync(join(repo, ".gitignore"), "build/\n");
  commit(repo, "gitignore");
  for (const p of ["services/pay/c.py", "infra/extra.tf", "build/out.tf"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "X = 1\n");
  }
  const file = parseReviewFile(COVERED.replace("infra/", "/**/*.tf"));
  // By default setup and reviews read tracked files only: the untracked ones are not counted.
  const plain = coverageMap(repo, file);
  expect(plain.projects[0]).toEqual({ name: "pay", owned: 1, used: 1 });
  expect(plain.uncovered[1]).toEqual({ path: "/**/*.tf", reason: "Terraform; no adapter", files: 1 });
  const map = coverageMap(repo, file, true);
  expect(map.projects[0]).toEqual({ name: "pay", owned: 2, used: 1, untracked: { owned: 1, used: 0 } });
  expect(map.projects[1]).toEqual({ name: "feed", owned: 1, used: 1 });
  expect(map.uncovered[1]).toEqual({ path: "/**/*.tf", reason: "Terraform; no adapter", files: 2, untracked: 1 });
  const text = describeCoverage(map);
  expect(text).toContain("- pay: owns 2 files (1 untracked), uses 1\n- feed: owns 1 files, uses 1\n");
  expect(text).toContain("- not tested: /**/*.tf (2 files, 1 untracked): Terraform; no adapter");
});

test("an untracked scratch file no project mentions does not refuse a file accepted without it", () => {
  writeFileSync(join(repo, "scratch.py"), "X = 1\n");
  expect(coverageMap(repo, parseReviewFile(COVERED), true).unexplained).toEqual([]);
  expect(coverageMap(repo, parseReviewFile(PROJECTS)).unexplained).toEqual(["app.py"]);
});

test("approve checks every project and names each one that fails, with both possible fixes", async () => {
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(reviewConfigPath(repo), COVERED);
  const ignoring: SessionFactory = async (cfg, snap, _log, body) => {
    ran.push(cfg.name);
    return body(new FakeSession(snap, () => [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false],
      { probe: "ignore" }));
  };
  const [ok, detail] = await approveFile(repo, { by: "Dev", at: "x", sessionFactory: ignoring });
  expect(ok).toBe(false);
  expect(ran).toEqual(["pay", "feed"]);
  expect(detail).toContain("pay: 1 passed; but a one-line test");
  expect(detail).toContain("feed: 1 passed; but a one-line test");
  expect(detail).toContain("set tests_dir");
  expect(detail).toContain("test_command");
});
