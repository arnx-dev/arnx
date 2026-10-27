// --json for approve, review, triage, allow-secret, env prune and skill install: one object on stdout, its fields as
// skills/arnx/references/json.md lists them, the people's text on stderr.
import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { reviewJson } from "../src/cli";
import { isFileApproved, parseReviewFile, reviewConfigPath } from "../src/config";
import { repoId } from "../src/envprune";
import { load, save, summary } from "../src/report";
import type { SessionFactory } from "../src/sandbox";
import { sandboxOptions } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";
import { AWS_KEY } from "./helpers/fakekeys";

const tmp = useTmp();
const RID = "20261011-a1b2c3";
const json = (cli: Cli) => JSON.parse(cli.stdout) as Record<string, unknown>;

/** A docker that only answers `docker info` (approve checks Docker runs; its suites run in a fake session). */
function dockerThatRuns(): string {
  const dir = join(tmp(), "bin");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "docker"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(dir, "docker"), 0o755);
  return join(dir, "docker");
}

/** A repository with the two-project review.yaml, not approved yet. */
function projectsRepo(): string {
  const repo = gitRepo(tmp());
  for (const p of ["services/pay/a.py", "services/feed/b.py", "services/shared/db.py", "infra/main.tf"]) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "X = 1\n");
  }
  commit(repo, "layout");
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(reviewConfigPath(repo), PROJECTS);
  return repo;
}

const suite = (outcome: "passed" | "failed"): SessionFactory => async (_cfg, snap, _log, body) =>
  body(new FakeSession(snap, () => [junitXml([["tests/test_a.py", "test_a", outcome, "boom"]]),
    `1 ${outcome}`, false]));

test("approve --json asks nothing and needs no --yes: the suites run and the file is stamped", async () => {
  const saved = sandboxOptions.docker;
  try {
    sandboxOptions.docker = dockerThatRuns();
    const repo = projectsRepo();
    const cli = new Cli({ cwd: repo, approveSessions: suite("passed"), ask: async () => { throw new Error("asked"); } });
    expect(await cli.run("approve", "--json", "--quiet")).toBe(0);
    expect(json(cli)).toMatchObject({ command: "approve", result: "ok", exit_code: 0, approved: true });
    expect(cli.stderr).toContain("holds 2 projects");
    expect(isFileApproved(parseReviewFile(readFileSync(reviewConfigPath(repo), "utf8")))).toBe(true);
  } finally {
    sandboxOptions.docker = saved;
  }
});

test("approve --yes --json: each project's suite, proven or not", async () => {
  const saved = sandboxOptions.docker;
  try {
    sandboxOptions.docker = dockerThatRuns();
    const repo = projectsRepo();
    const ok = new Cli({ cwd: repo, approveSessions: suite("passed") });
    expect(await ok.run("approve", "--yes", "--json", "--quiet")).toBe(0);
    expect(json(ok)).toEqual({ schema_version: 1, command: "approve", result: "ok", exit_code: 0, approved: true,
      projects: [{ name: "pay", ok: true, summary: "1 passed", accepted_failing: 0, unexpected: [],
        baseline_failing: 0, left_baseline: [], flaky: [] },
        { name: "feed", ok: true, summary: "1 passed", accepted_failing: 0, unexpected: [],
        baseline_failing: 0, left_baseline: [], flaky: [] }],
      next: ["arnx review"] });
    expect(ok.stderr).toContain("✓ Environment proven");
    const bad = new Cli({ cwd: repo, approveSessions: suite("failed") });
    expect(await bad.run("approve", "--yes", "--json", "--quiet")).toBe(2);
    const o = json(bad);
    expect(o).toMatchObject({ result: "fail", exit_code: 2, approved: false, next: ["arnx approve"] });
    expect((o.projects as { name: string; ok: boolean; unexpected: string[] }[]).map((p) => [p.name, p.ok,
      p.unexpected])).toEqual([["pay", false, ["tests/test_a.py::test_a"]], ["feed", false, ["tests/test_a.py::test_a"]]]);
    expect(o.detail).toContain("pay: 1 failed; failing outside the baseline");
  } finally {
    sandboxOptions.docker = saved;
  }
});

test("review --json: the summary's findings, questions, status and next, from the review as saved", () => {
  const rdir = join(tmp(), "reviews", RID);
  const r = sampleReview({ id: RID, untrackedLeftOut: 2, findings: [...sampleReview().findings,
    { ...finding("F3", "tests/g/test_i.py::test_old", "test_old", "app/tests/g/test_i.py", "assert 0", "Old bug.",
      "confirmed"), before: { status: "pre-existing", detail: "fails before too", runs: [] } } as never] });
  save(r, rdir, "diff");
  const back = load(rdir);
  const [result, code, fields] = reviewJson(back, ".arnx/reviews/x/review.md", ".arnx/reviews/x/review.json");
  expect([result, code]).toEqual(["findings", 1]);
  expect(fields).toEqual({
    review_id: RID, review_md: ".arnx/reviews/x/review.md", review_json: ".arnx/reviews/x/review.json",
    change: "uncommitted (base 1a2b3c4)", files_changed: 4, added: 140, removed: 3, status: "complete",
    issues: 2, findings: [
      { ids: ["F1"], state: "confirmed", confirmed: true, regression: false, projects: ["main"],
        title: "Any member can invite.", severity: null },
      { ids: ["F2"], state: "disputed", confirmed: false, regression: false, projects: ["main"], title: "Duplicates.",
        severity: null },
    ],
    pre_existing: ["F3"],
    questions: [{ id: "Q1", question: "Should invites expire?", project: "main", optional: false }],
    tests_written: 6, cost_usd: 0.34, seconds: 171, untracked_left_out: 2, problems: [], provider_failures: [],
    not_tested: [], your_call: null, next: ["arnx triage", "arnx accept"],
  });
  // The terminal summary shows the same rows.
  const text = summary(back, "x");
  expect(text).toContain("  ✗ 1  Any member can invite.  F1\n");
  expect(text).toContain("  · 2  Duplicates.             F2 disputed");
  // Nothing confirmed and the reviewer stopped early: incomplete, with the reason; nothing at all: clean.
  const stopped = reviewJson(sampleReview({ findings: [], questions: [], stop: "budget" }), "m", "j");
  expect(stopped[0]).toBe("incomplete");
  expect(stopped[1]).toBe(2);
  expect(stopped[2]).toMatchObject({ status: "incomplete", next: [] });
  expect((stopped[2].problems as string[])[0]).toContain("the review budget ran out");
  const partly = reviewJson(sampleReview({ findings: [], questions: [],
    untested: [{ project: "main", files: ["app/x.py"], of: 3 }] }), "m", "j");
  expect(partly.slice(0, 2)).toEqual(["clean", 0]);
  expect(partly[2]).toMatchObject({ status: "partly-covered", not_tested: ["app/x.py"],
    problems: ["no test refers to 1 of 3 changed source files, so finding nothing there says nothing about them"] });
});

test("triage --json draws nothing and changes nothing: the marks and answers as review.md holds them", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  await cli.run("init");
  const rdir = join(repo, ".arnx", "reviews", RID);
  save(sampleReview({ id: RID }), rdir, "d");
  const mdPath = join(rdir, "review.md");
  const md = readFileSync(mdPath, "utf8").replace("Severity, if real: [ ] high", "Severity, if real: [x] high")
    .replace("Answer:", "Answer: after 7 days");
  writeFileSync(mdPath, md);
  const drawn: string[][] = [];
  const t = new Cli({ cwd: repo, draw: (l) => drawn.push(l), keys: () => { throw new Error("read keys"); } });
  expect(await t.run("triage", "--json")).toBe(0);
  expect(json(t)).toEqual({ schema_version: 1, command: "triage", result: "ok", exit_code: 0, review_id: RID,
    review_md: `.arnx/reviews/${RID}/review.md`,
    findings: [
      { id: "F1", status: "confirmed", mark: "real", severity: "high", rewrite: null, project: "main",
        test_id: "tests/g/test_i.py::test_member", title: "Any member can invite." },
      { id: "F2", status: "disputed", mark: null, severity: null, rewrite: null, project: "main",
        test_id: "tests/g/test_i.py::test_dup", title: "Duplicates." },
    ],
    questions: [{ id: "Q1", question: "Should invites expire?", answer: "after 7 days" }] });
  expect(drawn).toEqual([]);
  expect(readFileSync(mdPath, "utf8")).toBe(md);
  // Without --json and without a terminal it still says so.
  const plain = new Cli({ cwd: repo });
  expect(await plain.run("triage")).toBe(2);
  expect(plain.stderr).toContain("arnx triage needs a terminal");
});

test("allow-secret --json: each file's key-like strings by kind and line, never the text", async () => {
  const repo = gitRepo(tmp());
  const key = AWS_KEY;
  writeFileSync(join(repo, "detect.py"), `A = 1\nAWS = '${key}'\n`);
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("allow-secret", "detect.py", "--json")).toBe(0);
  expect(json(cli)).toEqual({ schema_version: 1, command: "allow-secret", result: "ok", exit_code: 0,
    files: [{ path: "detect.py", matches: 1, labels: [{ label: "AKIA…", line: 2 }] }],
    review_yaml: ".arnx/review.yaml", next: ["arnx setup"] });
  expect(cli.stdout).not.toContain(key);
  expect(cli.stderr).toContain("detect.py: 1 key-like string (AKIA… line 2)");
});

test("env prune --json: what it removed, what it could not, and the unlabelled count", async () => {
  const saved = sandboxOptions.docker;
  try {
    const repo = gitRepo(tmp());
    const dir = join(tmp(), "docker");
    mkdirSync(dir);
    const created = new Date(Date.now() - 30.5 * 86_400_000).toISOString();
    const labels = JSON.stringify({ "arnx.config": "abc", "arnx.created": created, "arnx.project": "main",
      "arnx.repo": repoId(repo) });
    writeFileSync(join(dir, "images"), `arnx-env:old1\t5GB\t${labels}\narnx-env:busy\t2GB\t${labels}\n` +
      "arnx-env:x\t4GB\tnull\n");
    writeFileSync(join(dir, "docker"), `#!/bin/sh
case "$1 $2" in
  "image ls") cut -f1,2 '${join(dir, "images")}';;
  "image rm") [ "$3" = "arnx-env:busy" ] && { echo "conflict: image is in use" >&2; exit 1; };;
  "image inspect")
    shift 4
    for t in "$@"; do awk -F '\\t' -v t="$t" '$1 == t { print $3 }' '${join(dir, "images")}'; done;;
esac
exit 0
`);
    chmodSync(join(dir, "docker"), 0o755);
    sandboxOptions.docker = join(dir, "docker");
    const dry = new Cli({ cwd: repo });
    expect(await dry.run("env", "prune", "--dry-run", "--json")).toBe(0);
    expect(json(dry)).toEqual({ schema_version: 1, command: "env", result: "ok", exit_code: 0, dry_run: true,
      keep_days: 7, removed: [{ tag: "arnx-env:old1", project: "main", age_days: 30, size: "5GB" },
        { tag: "arnx-env:busy", project: "main", age_days: 30, size: "2GB" }], failed: [], unlabelled: 1,
      cache_records: 0, cache_size: "0MB", cache_not_found: 0 });
    const real = new Cli({ cwd: repo });
    expect(await real.run("env", "prune", "--keep-days", "3", "--json")).toBe(2);
    expect(json(real)).toMatchObject({ result: "fail", exit_code: 2, dry_run: false, keep_days: 3,
      removed: [{ tag: "arnx-env:old1" }], failed: [{ tag: "arnx-env:busy", error: expect.stringContaining("in use") }] });
  } finally {
    sandboxOptions.docker = saved;
  }
});

test("skill install --json: written, then unchanged; --user names the folders under ~", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("skill", "install", "--json")).toBe(0);
  expect(json(cli)).toEqual({ schema_version: 1, command: "skill", result: "ok", exit_code: 0, state: "written",
    dirs: [".agents/skills/arnx", ".claude/skills/arnx"], user: false });
  const again = new Cli({ cwd: repo });
  expect(await again.run("skill", "install", "--json")).toBe(0);
  expect(json(again)).toMatchObject({ state: "unchanged" });
  const home = new Cli({ cwd: tmp(), env: { HOME: join(tmp(), "home") } });
  expect(await home.run("skill", "install", "--user", "--json")).toBe(0);
  expect(json(home)).toMatchObject({ state: "written", dirs: ["~/.agents/skills/arnx", "~/.claude/skills/arnx"],
    user: true });
});
