import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function runGit(repo: string, ...args: string[]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

export function commit(repo: string, message: string): void {
  runGit(repo, "add", "-A");
  runGit(repo, "commit", "-q", "-m", message);
}

export function initRepo(path: string): string {
  mkdirSync(path, { recursive: true });
  runGit(path, "init", "-q", "-b", "main");
  runGit(path, "config", "user.email", "dev@example.com");
  runGit(path, "config", "user.name", "Dev");
  runGit(path, "config", "commit.gpgsign", "false");
  return path;
}

/** pytest's git_repo fixture: app.py with add(), committed as "initial". */
export function gitRepo(tmp: string): string {
  const repo = initRepo(join(tmp, "repo"));
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a + b\n");
  commit(repo, "initial");
  return repo;
}
