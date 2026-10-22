import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { added, changeLimits, describe as describeChange, filesAt, removed, repoRoot, resolveChange, snapshot,
  untrackedLine } from "../src/change";
import { ArnxError, ChangeTooLarge, NoChange, SetupRequired } from "../src/errors";
import { secretPins } from "../src/secrets";
import { commit, gitRepo, initRepo, runGit } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

test("uncommitted work is tracked files: an untracked file is named, and sent after git add or --untracked", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(join(repo, "new.py"), "X = 1\n");
  const plain = resolveChange(repo);
  expect([plain.kind, plain.head, plain.files, plain.untrackedLeftOut]).toEqual(["worktree", null, ["app.py"],
    ["new.py"]]);
  expect(plain.diff).not.toContain("+X = 1");
  expect([plain.withUntracked, plain.untrackedIncluded]).toEqual([undefined, undefined]);
  expect(untrackedLine(plain)).toBe("1 untracked file left out (`--untracked` includes them): new.py");
  // Opted in: as before, the untracked file is part of the change and of the snapshot.
  const c = resolveChange(repo, null, [], { untracked: true });
  expect(c.kind).toBe("worktree");
  expect(c.head).toBeNull();
  expect(c.files).toEqual(["app.py", "new.py"]);
  expect(c.diff).toContain("-    return a + b");
  expect(c.diff).toContain("+X = 1");
  expect([added(c), removed(c)]).toEqual([2, 1]);
  expect(describeChange(c).startsWith("uncommitted (base ")).toBe(true);
  expect([c.withUntracked, c.untrackedIncluded, c.untrackedLeftOut]).toEqual([true, ["new.py"], undefined]);
  expect(untrackedLine(c)).toBe("including 1 untracked file (--untracked): new.py");
  // A new file git adds is tracked: in the change without opting in.
  runGit(repo, "add", "new.py");
  const staged = resolveChange(repo);
  expect([staged.files, staged.untrackedLeftOut, untrackedLine(staged)]).toEqual([["app.py", "new.py"], undefined,
    null]);
  expect(staged.diff).toContain("+X = 1");
});

test("untracked files alone leave the tree clean: the last commit is reviewed, and they are named as left out", () => {
  const repo = gitRepo(tmp());
  for (let i = 1; i <= 12; i++) writeFileSync(join(repo, `kpi${String(i).padStart(2, "0")}.md`), "private\n");
  const c = resolveChange(repo);
  expect([c.kind, c.files]).toEqual(["commit", ["app.py"]]);
  expect(c.untrackedLeftOut).toHaveLength(12);
  expect(c.diff).not.toContain("private");
  expect(untrackedLine(c)).toBe("12 untracked files left out (`--untracked` includes them): kpi01.md, kpi02.md, " +
    "kpi03.md, kpi04.md, kpi05.md, kpi06.md, kpi07.md, kpi08.md, kpi09.md, kpi10.md (+2 more)");
  expect(resolveChange(repo, null, [], { untracked: true }).kind).toBe("worktree");
});

test("a working-tree snapshot holds tracked files only unless untracked files are opted in", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "notes.md"), "private KPI\n");
  writeFileSync(join(repo, "staged.py"), "S = 1\n");
  runGit(repo, "add", "staged.py");
  snapshot(repo, null, join(tmp(), "plain"));
  expect([existsSync(join(tmp(), "plain", "notes.md")), existsSync(join(tmp(), "plain", "staged.py"))])
    .toEqual([false, true]);
  snapshot(repo, null, join(tmp(), "opted"), [], { untracked: true });
  expect(readFileSync(join(tmp(), "opted", "notes.md"), "utf8")).toBe("private KPI\n");
  expect(filesAt(repo, null)).toEqual(["app.py", "staged.py"]);
  expect(filesAt(repo, null, true).sort()).toEqual(["app.py", "notes.md", "staged.py"]);
});

test("untracked tests arnx accept wrote are left out of the change, and alone do not make the tree dirty", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return b + a\n");
  commit(repo, "swap");
  const accepted = ["tests/arnx/r20261014_3f84e8/test_20261014_3f84e8_add.py",
    "__tests__/arnx/r20261014_3f84e8/add.r20261014_3f84e8.test.js", "tests/arnx_20261014_3f84e8_add.rs",
    // named after what they protect; the review id stays in the folder (Rust: the prefix)
    "tests/arnx/r20261014_3f84e8/test_deep_json_recursion.py", "__tests__/arnx/r20261014_3f84e8/deep_json.test.js",
    "tests/arnx_20261014_3f84e8_deep_json.rs"];
  for (const p of accepted) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), "x\n");
  }
  // Only accepted tests are untracked: still the last commit, as on a clean tree.
  const clean = resolveChange(repo);
  expect([clean.kind, clean.files, clean.leftOut]).toEqual(["commit", ["app.py"], undefined]);
  writeFileSync(join(repo, "new.py"), "X = 1\n");
  // Not opted in: new.py does not make the tree dirty either; it is named, the accepted tests are not.
  const plain = resolveChange(repo);
  expect([plain.kind, plain.leftOut, plain.untrackedLeftOut]).toEqual(["commit", undefined, ["new.py"]]);
  const c = resolveChange(repo, null, [], { untracked: true });
  expect(c.kind).toBe("worktree");
  expect(c.files).toEqual(["app.py", "new.py"].filter((f) => c.files.includes(f)));
  expect(c.files).toContain("new.py");
  expect(c.leftOut!.sort()).toEqual([...accepted].sort());
  expect(c.diff).not.toContain("r20261014_3f84e8");
});

test("test_clean_tree_reviews_last_commit", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return b + a\n");
  commit(repo, "swap");
  const c = resolveChange(repo);
  expect(c.kind).toBe("commit");
  expect(c.files).toEqual(["app.py"]);
  expect(describeChange(c).startsWith("commit ")).toBe(true);
});

test("test_first_commit_diffs_against_empty_tree", () => {
  const c = resolveChange(gitRepo(tmp()));
  expect(c.kind).toBe("commit");
  expect(c.diff).toContain("+def add(a, b):");
});

test("test_range", () => {
  const repo = gitRepo(tmp());
  const first = runGit(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "b.py"), "Y = 2\n");
  commit(repo, "b");
  const c = resolveChange(repo, `${first}..HEAD`);
  expect(c.kind).toBe("range");
  expect(c.files).toEqual(["b.py"]);
  expect(() => resolveChange(repo, "HEAD")).toThrow(/A\.\.B/);
});

test("test_secret_files_never_in_diff", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, ".env"), "TOKEN=abc\n");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return 0\n");
  const c = resolveChange(repo);
  expect(c.files).not.toContain(".env");
  expect(c.diff).not.toContain("TOKEN");
});

test("test_arnx_dir_is_not_a_change", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(join(repo, ".arnx", "config.toml"), "x = 1\n");
  expect(resolveChange(repo).kind).toBe("commit");
});

test("test_secret_content_in_diff_refused", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "KEY = 'AKIAABCDEFGHIJKLMNOP'\n");
  expect(() => resolveChange(repo)).toThrow(/secret/);
});

test("a change to an allowed file passes the secret check only with its pinned strings", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "detect.py"), FIXTURE);
  runGit(repo, "add", "detect.py");
  const allow = [{ path: "detect.py", matches: secretPins(FIXTURE) }];
  expect(() => resolveChange(repo)).toThrow("detect.py (AKIA…)");
  expect(() => resolveChange(repo)).toThrow("arnx allow-secret detect.py");
  expect(resolveChange(repo, null, allow).files).toEqual(["detect.py"]);
  writeFileSync(join(repo, "app.py"), FIXTURE); // same string, another file
  expect(() => resolveChange(repo, null, allow)).toThrow("app.py (AKIA…)");
});

test("test_empty_repo", () => {
  // no commits and no files: nothing to review (with files, every one is the change: no-commits.test.ts)
  const repo = initRepo(join(tmp(), "empty"));
  expect(() => resolveChange(repo)).toThrow("nothing to review");
});

test("test_repo_root", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "sub"));
  expect(repoRoot(join(repo, "sub"))).toBe(realpathSync(repo));
  const outside = join(tmp(), "plain");
  mkdirSync(outside);
  expect(() => repoRoot(outside)).toThrow(SetupRequired);
});

test("test_snapshot_worktree_scrubs", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, ".env"), "A=1\n");
  writeFileSync(join(repo, "conf.py"), "K = '-----BEGIN RSA PRIVATE KEY-----'\n");
  symlinkSync("/etc/hostname", join(repo, "link"));
  writeFileSync(join(repo, "app.py"), "changed = True\n");
  const dest = join(tmp(), "snap");
  const removedFiles = snapshot(repo, null, dest, [], { untracked: true });
  expect(readFileSync(join(dest, "app.py"), "utf8")).toBe("changed = True\n");
  expect(existsSync(join(dest, ".env")) || existsSync(join(dest, ".git")) || existsSync(join(dest, "link")))
    .toBe(false);
  expect(removedFiles).toEqual([{ path: "conf.py", line: 1, label: "a private key" }]);
});

const FIXTURE = "AWS = 'AKIAIOSFODNN7EXAMPLE'\n";

test("a source file with a key-shaped string is withheld, unless allowed with every such string pinned", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "src", "detect.py"), "PATTERNS = ['AKIA']\n" + FIXTURE);
  const allow = [{ path: "src/detect.py", matches: secretPins(FIXTURE) }];
  runGit(repo, "add", "src/detect.py");
  expect(snapshot(repo, null, join(tmp(), "s1"))).toEqual([{ path: "src/detect.py", line: 2, label: "AKIA…" }]);
  expect(existsSync(join(tmp(), "s1", "src", "detect.py"))).toBe(false);
  expect(snapshot(repo, null, join(tmp(), "s2"), allow)).toEqual([]);
  expect(readFileSync(join(tmp(), "s2", "src", "detect.py"), "utf8")).toContain("AKIAIOSFODNN7EXAMPLE");
  // The pin is per path: the same text elsewhere is withheld.
  writeFileSync(join(repo, "other.py"), FIXTURE);
  runGit(repo, "add", "other.py");
  expect(snapshot(repo, null, join(tmp(), "s3"), allow).map((w) => w.path)).toEqual(["other.py"]);
  // A new key-shaped string in the allowed file withholds it again.
  writeFileSync(join(repo, "src", "detect.py"), FIXTURE + "T = 'ghp_" + "b".repeat(36) + "'\n");
  expect(snapshot(repo, null, join(tmp(), "s4"), allow)).toEqual([
    { path: "other.py", line: 1, label: "AKIA…" }, { path: "src/detect.py", line: 2, label: "ghp_…" }]);
});

test("test_snapshot_commit", () => {
  const repo = gitRepo(tmp());
  const head = runGit(repo, "rev-parse", "HEAD").trim();
  writeFileSync(join(repo, "app.py"), "uncommitted\n");
  const dest = join(tmp(), "snap");
  snapshot(repo, head, dest);
  expect(readFileSync(join(dest, "app.py"), "utf8")).toContain("return a + b");
});

test("test_snapshot_commit_files_get_fresh_mtimes", () => {
  // A commit made long ago: the archive stamps its files with the commit time. Cargo compares source mtimes with
  // the build in the environment image, so an old mtime makes it run a stale binary. Extracted files must be new.
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "lib.rs"), "pub fn f() -> i32 { 2 }\n");
  runGit(repo, "add", "lib.rs");
  const old = "2001-01-01T00:00:00Z";
  Bun.spawnSync(["git", "-C", repo, "commit", "-m", "old"], { env: { ...process.env, GIT_AUTHOR_DATE: old, GIT_COMMITTER_DATE: old } });
  const head = runGit(repo, "rev-parse", "HEAD").trim();
  const before = Date.now() - 5000;
  const dest = join(tmp(), "snap");
  snapshot(repo, head, dest);
  expect(readFileSync(join(dest, "lib.rs"), "utf8")).toContain("-> i32 { 2 }");
  expect(statSync(join(dest, "lib.rs")).mtimeMs).toBeGreaterThan(before);
  expect(statSync(join(dest, "app.py")).mtimeMs).toBeGreaterThan(before);
});

test("test_snapshot_refuses_huge_trees", () => {
  const repo = gitRepo(tmp());
  const saved = changeLimits.maxSnapshotFiles;
  changeLimits.maxSnapshotFiles = 3;
  try {
    for (let i = 0; i < 5; i++) writeFileSync(join(repo, `f${i}.txt`), "x");
    expect(snapshot(repo, null, join(tmp(), "tracked"))).toEqual([]); // the untracked files are not copied
    expect(() => snapshot(repo, null, join(tmp(), "snap"), [], { untracked: true })).toThrow(ArnxError);
    expect(() => snapshot(repo, null, join(tmp(), "snap2"), [], { untracked: true })).toThrow(/files/);
  } finally {
    changeLimits.maxSnapshotFiles = saved;
  }
  expect(changeLimits.maxSnapshotFiles).toBe(20_000);
});

test("snapshot removes a symlinked directory that leaves the tree", () => {
  const repo = gitRepo(tmp());
  symlinkSync("/etc", join(repo, "etcdir"));
  mkdirSync(join(repo, "pkg"));
  symlinkSync("../app.py", join(repo, "pkg", "inside.py"));
  const dest = join(tmp(), "snap");
  snapshot(repo, null, dest, [], { untracked: true });
  expect(existsSync(join(dest, "etcdir"))).toBe(false);
  expect(readFileSync(join(dest, "pkg", "inside.py"), "utf8")).toContain("def add");
});

test("on a branch, a review covers every commit since main, then uncommitted work too", () => {
  const repo = gitRepo(tmp());
  const fork = runGit(repo, "rev-parse", "HEAD").trim();
  runGit(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "one.py"), "A = 1\n");
  commit(repo, "one");
  writeFileSync(join(repo, "two.py"), "B = 2\n");
  commit(repo, "two");
  runGit(repo, "checkout", "-q", "main"); // main moves on after the branch left it
  writeFileSync(join(repo, "later.py"), "C = 3\n");
  commit(repo, "later on main");
  runGit(repo, "checkout", "-q", "feature");
  let c = resolveChange(repo);
  expect([c.kind, c.base, c.files]).toEqual(["branch", fork, ["one.py", "two.py"]]);
  expect(c.head).toBe(runGit(repo, "rev-parse", "HEAD").trim());
  expect(describeChange(c)).toBe(`branch feature: 2 commits since main (${fork.slice(0, 7)})`);
  writeFileSync(join(repo, "three.py"), "D = 4\n");
  c = resolveChange(repo); // untracked: still the commits, three.py named as left out
  expect([c.kind, c.head === null, c.files, c.untrackedLeftOut]).toEqual(["branch", false, ["one.py", "two.py"],
    ["three.py"]]);
  runGit(repo, "add", "three.py");
  c = resolveChange(repo);
  expect([c.kind, c.head, c.files]).toEqual(["branch", null, ["one.py", "three.py", "two.py"]]);
  expect(describeChange(c)).toEndWith(" and uncommitted work");
  expect(resolveChange(repo, "HEAD~1..HEAD").kind).toBe("range"); // --range still wins
});

test("the fork point is the closest of main and origin/main", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "up.py"), "U = 1\n");
  commit(repo, "upstream work");
  const upstream = runGit(repo, "rev-parse", "HEAD").trim();
  runGit(repo, "update-ref", "refs/remotes/origin/main", upstream);
  runGit(repo, "reset", "-q", "--hard", "HEAD~1"); // local main is behind origin/main
  runGit(repo, "checkout", "-q", "-b", "feature", upstream);
  writeFileSync(join(repo, "f.py"), "F = 1\n");
  commit(repo, "feature");
  const c = resolveChange(repo);
  expect([c.kind, c.base, c.files, c.branch?.onto]).toEqual(["branch", upstream, ["f.py"], "origin/main"]);
});

test("on main, or on a branch with no commits of its own, nothing changes", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return b + a\n");
  commit(repo, "swap");
  expect(resolveChange(repo).kind).toBe("commit");
  runGit(repo, "checkout", "-q", "-b", "empty");
  expect(resolveChange(repo).kind).toBe("commit");
});

test("origin/HEAD naming the branch itself does not hide main", () => {
  const repo = gitRepo(tmp());
  runGit(repo, "checkout", "-q", "-b", "feature");
  writeFileSync(join(repo, "f.py"), "F = 1\n");
  commit(repo, "feature");
  runGit(repo, "update-ref", "refs/remotes/origin/feature", "HEAD");
  runGit(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/feature");
  expect(resolveChange(repo).branch?.onto).toBe("main");
});

test("changed files .arnxignore leaves out are named, and .arnxignore itself is not the developer's change", () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "data"));
  writeFileSync(join(repo, ".arnxignore"), "data/\n");
  // Only arnx's own file and ignored data changed: nothing of the developer's is uncommitted, so the last commit.
  writeFileSync(join(repo, "data", "dump.csv"), "a,b\n");
  const c = resolveChange(repo);
  expect(c.kind).toBe("commit");
  expect(c.files).not.toContain(".arnxignore");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  // Untracked, the dump is not part of the change at all; opted in, it is a changed file .arnxignore leaves out.
  const w = resolveChange(repo);
  expect([w.kind, w.files, w.ignored, w.untrackedLeftOut]).toEqual(["worktree", ["app.py"], undefined, undefined]);
  const opted = resolveChange(repo, null, [], { untracked: true });
  expect([opted.kind, opted.files, opted.ignored]).toEqual(["worktree", ["app.py"], ["data/dump.csv"]]);
  expect(opted.diff).not.toContain("dump.csv");
  commit(repo, "data and a change");
  const last = resolveChange(repo);
  expect([last.kind, last.files, last.ignored]).toEqual(["commit", ["app.py"], ["data/dump.csv"]]);
});

test("a changed lockfile stays in the snapshot but its text is not sent; only a lockfile changed is no change", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "package-lock.json"), `{"lockfileVersion": 3}\n`);
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
  commit(repo, "lock and a change");
  const c = resolveChange(repo);
  expect([c.files, c.lockfiles]).toEqual([["app.py"], ["package-lock.json"]]);
  expect(c.diff).not.toContain("lockfileVersion");
  const dest = join(tmp(), "snap");
  snapshot(repo, null, dest);
  expect(existsSync(join(dest, "package-lock.json"))).toBe(true);
  writeFileSync(join(repo, "package-lock.json"), `{"lockfileVersion": 4}\n`);
  commit(repo, "bump");
  expect(() => resolveChange(repo)).toThrow(NoChange);
  expect(() => resolveChange(repo)).toThrow("only lockfiles changed: package-lock.json");
});

test("a first commit over the limit names its largest files and says --range cannot split it", () => {
  const repo = initRepo(join(tmp(), "repo"));
  writeFileSync(join(repo, "big.py"), "X = 1\n".repeat(50_000));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a + b\n");
  commit(repo, "everything");
  let err: unknown;
  try { resolveChange(repo); } catch (e) { err = e; }
  expect(err).toBeInstanceOf(ChangeTooLarge);
  expect((err as ChangeTooLarge).root).toBe(true);
  expect((err as Error).message).toContain("(largest: big.py 350 KB, app.py 1 KB)");
  expect((err as Error).message).toContain("first commit, so it holds every file");
});
