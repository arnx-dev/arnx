// arnx remove: lists what arnx put in a repository, deletes it with --yes; committed files are left for `git rm`,
// accepted tests are kept unless --tests, and only this repository's images are removed.
import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { localPinsPath } from "../src/check";
import { repoId } from "../src/envprune";
import { sandboxOptions } from "../src/sandbox";
import { Cli } from "./helpers/cli";
import { gitRepo, runGit } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

/** A docker that knows two images (this repository's and another's); `image rm` removes one and is logged. */
function fakeDocker(mine: string): () => string[] {
  const dir = tmp();
  const log = join(dir, "rm");
  const labels = (repo: string) => JSON.stringify({ "arnx.created": "2026-10-01T00:00:00Z", "arnx.project": "main",
    "arnx.repo": repo });
  writeFileSync(join(dir, "images"), `arnx-env:mine\t2GB\t${labels(mine)}\narnx-env:theirs\t3GB\t${labels("0".repeat(16))}\n`);
  writeFileSync(join(dir, "docker"), `#!/bin/sh
case "$1 $2" in
  "image ls") cut -f1,2 '${join(dir, "images")}';;
  "image rm") echo "$3" >> '${log}'; grep -v "^$3	" '${join(dir, "images")}' > '${join(dir, "left")}';
    mv '${join(dir, "left")}' '${join(dir, "images")}';;
  "image inspect") shift 4; for t in "$@"; do awk -F '\\t' -v t="$t" '$1 == t { print $3 }' '${join(dir, "images")}'; done;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  return () => existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
}

const put = (path: string, text = "x\n") => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

test("remove lists first, then deletes what git does not track; committed files are left for git rm", async () => {
  const saved = sandboxOptions.docker;
  try {
    const repo = gitRepo(tmp());
    const env = { XDG_CONFIG_HOME: tmp() };
    expect(await new Cli({ cwd: repo, env }).run("init")).toBe(0);
    const test = "tests/arnx/r20261011_a1b2c3/test_add.py";
    put(join(repo, test), "def test_add():\n    assert 0\n");
    put(join(repo, ".arnx", "accepted-tests.json"), JSON.stringify({ schema_version: 1,
      files: { [test]: { sha256: "x", review: "20261011-a1b2c3" } } }));
    runGit(repo, "add", ".arnx/config.toml", ".arnxignore", ".arnx/accepted-tests.json", test);
    runGit(repo, "commit", "-q", "-m", "arnx");
    put(join(repo, ".arnx", "reviews", "20261011-a1b2c3", "review.md"));
    put(join(repo, ".claude", "skills", "arnx", "SKILL.md"));
    const pins = localPinsPath(env, repo)!;
    put(pins, "{}");
    const removed = fakeDocker(repoId(repo));

    const dry = new Cli({ cwd: repo, env });
    expect(await dry.run("remove")).toBe(0);
    expect(dry.out).toEqual([
      "arnx remove would delete:",
      "  .arnx/                4 files, 2 committed",
      "  .arnxignore           all committed",
      "  .claude/skills/arnx/  1 file",
      "  1 environment image   2.0GB",
      `  accepted-test pins    ${pins}`,
      "Committed files are left for git, so the removal shows in a commit:",
      "  git rm -r --quiet .arnx/accepted-tests.json .arnx/config.toml .arnxignore",
      "Kept: 1 accepted test file (your tests now; --tests removes them too); your arnx cloud login (arnx logout); " +
        "the arnx program.",
      "",
      "Next: arnx remove --yes",
    ]);
    // A list deletes nothing.
    expect(existsSync(join(repo, ".arnx", "reviews"))).toBe(true);
    expect(removed()).toEqual([]);

    const go = new Cli({ cwd: repo, env });
    expect(await go.run("remove", "--yes")).toBe(0);
    expect(go.out[0]).toBe("✓ Removed arnx from this repository, except committed files.");
    expect(existsSync(join(repo, ".arnx", "reviews"))).toBe(false);
    expect(existsSync(join(repo, ".arnx", ".gitignore"))).toBe(false);
    expect(existsSync(join(repo, ".claude"))).toBe(false); // folders it emptied go too
    expect(existsSync(join(repo, ".arnx", "config.toml"))).toBe(true);
    expect(existsSync(join(repo, test))).toBe(true);
    expect(existsSync(pins)).toBe(false);
    expect(removed()).toEqual(["arnx-env:mine"]);

    // --tests takes the accepted tests too; committed, they join the git rm line.
    const all = new Cli({ cwd: repo, env });
    await all.run("remove", "--tests", "--json");
    const j = JSON.parse(all.stdout) as Record<string, unknown>;
    expect(j).toMatchObject({ command: "remove", result: "ok", dry_run: true, state: "listed", deleted: [],
      kept_tests: [], git_rm: `git rm -r --quiet .arnx .arnxignore ${test}` }); // .arnx is all committed now

    runGit(repo, "rm", "-r", "--quiet", ".arnx", ".arnxignore", test);
    const none = new Cli({ cwd: repo, env });
    expect(await none.run("remove")).toBe(0);
    expect(none.out).toEqual(["Nothing of arnx's in this repository."]);
  } finally {
    sandboxOptions.docker = saved;
  }
});
