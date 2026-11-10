// Links that loop (`a/b -> ..`, `x -> x`) in a repository or its setup snapshot: no walk goes through them or throws.
import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { copyManifests } from "../src/sandbox";
import { entriesUnder } from "../src/safefs";
import { workspaceNames } from "../src/typecheck";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

function loopy(root: string): void {
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "pyproject.toml"), "[project]\n");
  writeFileSync(join(root, "a", "package.json"), '{"name":"pkg-a"}');
  symlinkSync("..", join(root, "a", "b"));
  symlinkSync("x", join(root, "x"));
  symlinkSync("pyproject.toml", join(root, "linked.toml"));
}

test("entriesUnder lists a link to a folder without entering it, and never throws on a loop", () => {
  loopy(tmp());
  expect(entriesUnder(tmp()).sort()).toEqual(["a", "a/b", "a/package.json", "linked.toml", "pyproject.toml", "x"]);
  expect(entriesUnder(join(tmp(), "missing"))).toEqual([]);
});

test("copyManifests copies manifests past loops; a link to a manifest file is still read as a file", () => {
  loopy(tmp());
  const dest = join(tmp(), "out");
  copyManifests(tmp(), dest);
  expect(entriesUnder(dest).sort()).toEqual(["a", "a/package.json", "pyproject.toml"]);
});

test("workspaceNames walks past loops", () => {
  loopy(tmp());
  expect(workspaceNames(tmp())).toEqual(["pkg-a"]);
});
