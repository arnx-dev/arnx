// The arnx skill for coding agents: embedded in every build, written by `arnx skill install` (repository or --user,
// never over a different skill without --force), and offered by an interactive `arnx init` (never with --yes).
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SKILL_DIRS, SKILL_FILES } from "../src/skill";
import { Cli } from "./helpers/cli";
import { gitRepo, initRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const ROOT = join(import.meta.dir, "..");
const SOURCE = join(ROOT, "skills", "arnx");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => statSync(join(dir, n)).isDirectory() ? walk(join(dir, n)).map((f) => `${n}/${f}`)
    : [n]);
}

/** The files under `dir`, as the skill folder holds them. */
const read = (dir: string) => Object.fromEntries(walk(dir).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));
/** Every copy under `root` is exactly the source skill. */
const expectSkills = (root: string) => { for (const d of SKILL_DIRS) expect(read(join(root, d))).toEqual(read(SOURCE)); };
const CLAUDE_DIR = ".claude/skills/arnx";

test("the embedded skill is exactly skills/arnx/ in this repository", () => {
  expect(Object.keys(SKILL_FILES).sort()).toEqual(walk(SOURCE).sort());
  for (const [f, text] of Object.entries(SKILL_FILES)) expect(text).toBe(readFileSync(join(SOURCE, f), "utf8"));
});

test("SKILL.md has the front matter agents load it by, stays short, and links only files it ships", () => {
  const md = SKILL_FILES["SKILL.md"]!;
  const front = /^---\nname: (.+)\ndescription: (.+)\n---\n/.exec(md);
  expect(front?.[1]).toBe("arnx");
  expect(front?.[2]).toMatch(/\.arnx\//);
  expect(front![2]!.length).toBeLessThanOrEqual(1024);
  expect(md.split("\n").length).toBeLessThanOrEqual(150);
  const links = [...md.matchAll(/\]\((references\/[^)#]+)\)/g)].map((m) => m[1]!);
  expect(links.length).toBeGreaterThan(0);
  for (const l of links) expect(Object.keys(SKILL_FILES)).toContain(l);
});

test("skill install writes the skill into the repository, and says so; again: nothing to do", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "sub"));
  const cli = new Cli({ cwd: join(repo, "sub") });
  expect(await cli.run("skill", "install")).toBe(0);
  expectSkills(repo);
  expect(cli.stdout).toContain("Wrote the arnx skill in .agents/skills/arnx/ and .claude/skills/arnx/; commit them.");
  cli.out.length = 0;
  expect(await cli.run("skill", "install")).toBe(0);
  expect(cli.stdout).toContain("already hold this arnx's skill; nothing written");
});

test("skill install --user writes under the home directory, outside any repository", async () => {
  const home = join(tmp(), "home");
  const cli = new Cli({ cwd: tmp(), env: { HOME: home } });
  expect(await cli.run("skill", "install", "--user")).toBe(0);
  expectSkills(home);
  expect(cli.stdout).toContain("~/.agents/skills/arnx/ and ~/.claude/skills/arnx/");
  expect(await new Cli({ cwd: tmp(), env: {} }).run("skill", "install", "--user")).toBe(2);
});

test("skill install refuses to overwrite a different skill without --force", async () => {
  const repo = gitRepo(tmp());
  const dir = join(repo, CLAUDE_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), "---\nname: arnx\ndescription: mine\n---\n");
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("skill", "install")).toBe(2);
  expect(cli.stderr).toContain("different skill");
  expect(readFileSync(join(dir, "SKILL.md"), "utf8")).toContain("description: mine");
  expect(existsSync(join(repo, ".agents"))).toBe(false); // nothing written while one copy is someone else's
  expect(await cli.run("skill", "install", "--force")).toBe(0);
  expectSkills(repo);
  expect(cli.stdout).toContain("Replaced the arnx skill");
  // An extra file makes it a different skill too.
  writeFileSync(join(dir, "notes.md"), "x");
  expect(await cli.run("skill", "install")).toBe(2);
  expect(await cli.run("skill", "install", "--force")).toBe(0);
  expect(existsSync(join(dir, "notes.md"))).toBe(false);
});

test("skill takes only install", async () => {
  const cli = new Cli({ cwd: gitRepo(tmp()) });
  expect(await cli.run("skill")).toBe(2);
  expect(await cli.run("skill", "remove")).toBe(2);
  expect(cli.stderr).toContain("usage: arnx skill install");
});

// --- init offers it ---------------------------------------------------------------------------------------------------

// init asks nothing (not about the skill either): an Optional line names the command while the repository lacks it.

test("init never asks about the skill; an Optional line names `arnx skill install` until the repository has it",
  async () => {
  for (const [n, interactive] of [true, false].entries()) {
    const repo = gitRepo(join(tmp(), `init${n}`));
    const asked: string[] = [];
    const cli = new Cli({ cwd: repo, interactive, ask: async (q) => (asked.push(q), "y") });
    expect(await cli.run("init")).toBe(0);
    expect(asked).toEqual([]); // init asks nothing
    expect(existsSync(join(repo, CLAUDE_DIR))).toBe(false);
    expect(cli.stdout).toMatch(/Next: arnx setup\nOptional: arnx skill install \(coding agents\)$/);
  }
  const repo = gitRepo(join(tmp(), "has"));
  expect(await new Cli({ cwd: repo }).run("skill", "install")).toBe(0);
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("init")).toBe(0);
  expect(cli.stdout).toMatch(/Next: arnx setup$/);
  // Only the older .claude copy: the command adds the other one.
  rmSync(join(repo, ".agents"), { recursive: true });
  const again = new Cli({ cwd: repo });
  expect(await again.run("init", "--force")).toBe(0);
  expect(again.stdout).toContain("Optional: arnx skill install (coding agents)");
  expect(await again.run("skill", "install")).toBe(0);
  expectSkills(repo);
});

// --- the builds carry it ------------------------------------------------------------------------------------------------

test("the single binary carries the skill: dist/arnx skill install writes it into a repository", () => {
  const bin = join(tmp(), "arnx");
  const build = spawnSync("sh", [join(ROOT, "scripts", "build.sh"), "bin", "", bin], { cwd: ROOT, encoding: "utf8" });
  expect(build.status).toBe(0);
  const repo = initRepo(join(tmp(), "repo"));
  // Run from elsewhere than the source tree, so nothing can be read from skills/ on disk.
  const r = spawnSync(bin, ["skill", "install"], { cwd: repo, encoding: "utf8", env: { PATH: process.env.PATH } });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain("Wrote the arnx skill");
  expectSkills(repo);
}, 120_000);
