// Both builds carry the default prompts: src/prompts.toml is imported as text, so the single binary and the Node bundle
// list the keys and copy a default exactly, run away from the source tree.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULTS, PROMPT_KEYS } from "../src/prompts";
import { readOverrides } from "../src/userprompts";
import { initRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const ROOT = join(import.meta.dir, "..");

function expectPrompts(cmd: string[], repo: string): void {
  const env = { PATH: process.env.PATH };
  const list = spawnSync(cmd[0]!, [...cmd.slice(1), "prompts"], { cwd: repo, encoding: "utf8", env });
  expect(list.status).toBe(0);
  expect(list.stdout.split("\n").slice(0, PROMPT_KEYS.length)).toEqual(PROMPT_KEYS);
  const copy = spawnSync(cmd[0]!, [...cmd.slice(1), "prompts", "copy", "setup.task"], { cwd: repo, encoding: "utf8",
    env });
  expect(copy.status).toBe(0);
  expect(readOverrides(repo)[0]?.text).toBe(DEFAULTS["setup.task"]);
}

test("the single binary carries the prompts", () => {
  const bin = join(tmp(), "arnx");
  const build = spawnSync("sh", [join(ROOT, "scripts", "build.sh"), "bin", "", bin], { cwd: ROOT, encoding: "utf8" });
  expect(build.status).toBe(0);
  expectPrompts([bin], initRepo(join(tmp(), "repo")));
}, 120_000);

test("the Node bundle carries the prompts", () => {
  const out = join(tmp(), "cli.js");
  const build = spawnSync("bun", ["build", "--target=node", join(ROOT, "src", "main.ts"), "--outfile", out,
    "--define", 'ARNX_BUILD="test"'], { cwd: ROOT, encoding: "utf8" });
  expect(build.status).toBe(0);
  expect(readFileSync(out, "utf8")).toContain("[setup]");
  expectPrompts(["node", out], initRepo(join(tmp(), "repo")));
}, 120_000);
