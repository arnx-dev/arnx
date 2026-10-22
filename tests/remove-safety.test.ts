// arnx remove never leaves the repository and never loses work: tests arnx wrote when it reviewed its own `remove`
// (review 20261022-227eb7), kept as they were accepted.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { sandboxOptions } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { gitRepo, runGit } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

const put = (path: string, text = "x\n") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

function setup() {
  const base = join(tmp(), "w");
  const repo = gitRepo(base);
  const env = { XDG_CONFIG_HOME: join(tmp(), "xdg") };
  return { base, repo, env };
}

async function withDocker<T>(path: string, f: () => Promise<T>): Promise<T> {
  const saved = sandboxOptions.docker;
  sandboxOptions.docker = path;
  try {
    return await f();
  } finally {
    sandboxOptions.docker = saved;
  }
}

const record = (files: Record<string, unknown>) => JSON.stringify({ schema_version: 1, files });

test("S1 a broken docker does not stop the files from being removed", async () => {
  const { repo, env } = setup();
  put(join(repo, ".arnx", "reviews", "r1", "review.md"));
  const bad = join(tmp(), "docker-bad");
  writeFileSync(bad, "not executable");
  chmodSync(bad, 0o644);
  const cli = new Cli({ cwd: repo, env });
  await withDocker(bad, () => cli.run("remove", "--yes"));
  expect(existsSync(join(repo, ".arnx", "reviews", "r1", "review.md"))).toBe(false);
});

test("S2 accepted-test paths escaping the repository are never deleted", async () => {
  const { base, repo, env } = setup();
  const victim = join(base, "victim.txt");
  put(victim, "keep me");
  put(join(repo, ".arnx", "accepted-tests.json"), record({ "../victim.txt": {} }));
  const cli = new Cli({ cwd: repo, env });
  await withDocker("/nonexistent/docker", () => cli.run("remove", "--yes", "--tests"));
  expect(existsSync(victim)).toBe(true);
});

test("S3 an uncommitted, edited accepted test is not silently deleted by --tests", async () => {
  const { repo, env } = setup();
  const t = "tests/arnx/r1/test_a.py";
  put(join(repo, t), "# hand edited\n");
  put(join(repo, ".arnx", "accepted-tests.json"), record({ [t]: { sha256: "different" } }));
  const cli = new Cli({ cwd: repo, env });
  await withDocker("/nonexistent/docker", () => cli.run("remove", "--yes", "--tests"));
  expect(existsSync(join(repo, t))).toBe(true);
});

test("S4 a symlinked ancestor folder does not lead to deleting files outside the repository", async () => {
  const { base, repo, env } = setup();
  const outside = join(base, "outside");
  put(join(outside, "skills", "arnx", "SKILL.md"));
  symlinkSync(outside, join(repo, ".claude"));
  const cli = new Cli({ cwd: repo, env });
  await withDocker("/nonexistent/docker", () => cli.run("remove", "--yes"));
  expect(existsSync(join(outside, "skills", "arnx", "SKILL.md"))).toBe(true);
});

test("S5 json deleted leaves out files that failed to delete", async () => {
  if (process.getuid?.() === 0) return; // root ignores permissions
  const { repo, env } = setup();
  const dir = join(repo, ".arnx", "reviews", "r1");
  put(join(dir, "review.md"));
  chmodSync(dir, 0o500);
  try {
    const cli = new Cli({ cwd: repo, env });
    await withDocker("/nonexistent/docker", () => cli.run("remove", "--yes", "--json"));
    const j = JSON.parse(cli.stdout) as { deleted: string[]; failed: { path: string }[] };
    expect(j.failed.map((f) => f.path)).toContain(".arnx/reviews/r1/review.md");
    expect(j.deleted).not.toContain(".arnx/reviews/r1/review.md");
  } finally {
    chmodSync(dir, 0o700);
  }
});

test("S6 when git cannot say what is tracked, committed files are not deleted", async () => {
  const { repo, env } = setup();
  put(join(repo, ".arnx", "config.toml"));
  runGit(repo, "add", ".arnx/config.toml");
  runGit(repo, "commit", "-q", "-m", "cfg");
  writeFileSync(join(repo, ".git", "index"), "garbage garbage garbage");
  const cli = new Cli({ cwd: repo, env });
  await withDocker("/nonexistent/docker", () => cli.run("remove", "--yes"));
  expect(existsSync(join(repo, ".arnx", "config.toml"))).toBe(true);
});

test("S7 git_rm names only committed files, not an uncommitted file sharing a prefix", async () => {
  const { repo, env } = setup();
  put(join(repo, "tests/a.py"));
  put(join(repo, "tests/a.py.bak"));
  put(join(repo, ".arnx", "accepted-tests.json"), record({ "tests/a.py": {}, "tests/a.py.bak": {} }));
  runGit(repo, "add", "tests/a.py.bak");
  runGit(repo, "commit", "-q", "-m", "bak");
  const cli = new Cli({ cwd: repo, env });
  await withDocker("/nonexistent/docker", () => cli.run("remove", "--tests", "--json"));
  const j = JSON.parse(cli.stdout) as { git_rm: string | null };
  expect(j.git_rm).toBe("git rm -r --quiet tests/a.py.bak");
});

test("S8 the printed git rm command works for a file name with a space", async () => {
  const { repo, env } = setup();
  const t = "tests/arnx/test addition.py";
  put(join(repo, t));
  put(join(repo, ".arnx", "accepted-tests.json"), record({ [t]: {} }));
  runGit(repo, "add", t);
  runGit(repo, "commit", "-q", "-m", "t");
  const cli = new Cli({ cwd: repo, env });
  await withDocker("/nonexistent/docker", () => cli.run("remove", "--tests", "--json"));
  const j = JSON.parse(cli.stdout) as { git_rm: string };
  expect(j.git_rm).toBeTruthy();
  const r = spawnSync("sh", ["-c", j.git_rm], { cwd: repo, encoding: "utf8" });
  expect(r.status).toBe(0);
  expect(runGit(repo, "ls-files", "--", t).trim()).toBe("");
});

test("S9 a committed test with glob characters in its name is kept", async () => {
  const { repo, env } = setup();
  const t = "tests/arnx/r1/test_[a].py";
  put(join(repo, t));
  put(join(repo, ".arnx", "accepted-tests.json"), record({ [t]: {} }));
  runGit(repo, "add", t);
  runGit(repo, "commit", "-q", "-m", "t");
  const cli = new Cli({ cwd: repo, env });
  await withDocker("/nonexistent/docker", () => cli.run("remove", "--yes", "--tests"));
  expect(existsSync(join(repo, t))).toBe(true);
});

test("a dry run deletes nothing and reports docker_checked false without docker", async () => {
  const { repo, env } = setup();
  put(join(repo, ".arnx", "reviews", "r1", "review.md"));
  const cli = new Cli({ cwd: repo, env });
  expect(await withDocker("/nonexistent/docker", () => cli.run("remove", "--json"))).toBe(0);
  const j = JSON.parse(cli.stdout) as Record<string, unknown>;
  expect(j).toMatchObject({ dry_run: true, state: "listed", docker_checked: false });
  expect(existsSync(join(repo, ".arnx", "reviews", "r1", "review.md"))).toBe(true);
});

test("an untracked symlink inside .arnx is removed without touching its target", async () => {
  const { base, repo, env } = setup();
  const target = join(base, "target");
  put(join(target, "f.txt"));
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  symlinkSync(target, join(repo, ".arnx", "link"));
  const cli = new Cli({ cwd: repo, env });
  await withDocker("/nonexistent/docker", () => cli.run("remove", "--yes"));
  expect(existsSync(join(target, "f.txt"))).toBe(true);
  expect(existsSync(join(repo, ".arnx"))).toBe(false);
});

test("empty folders arnx did not empty are left alone", async () => {
  const { repo, env } = setup();
  mkdirSync(join(repo, "keepme", "empty"), { recursive: true });
  put(join(repo, ".arnx", "reviews", "r1", "review.md"));
  const cli = new Cli({ cwd: repo, env });
  await withDocker("/nonexistent/docker", () => cli.run("remove", "--yes"));
  expect(existsSync(join(repo, "keepme", "empty"))).toBe(true);
});
