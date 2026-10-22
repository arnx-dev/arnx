// Languages arnx does not review are found without a model: a repository written only in them stops at doctor's
// checks (so setup and review spend nothing), init says so, and in a mixed repository their files count as uncovered
// on their own instead of blocking setup's proposal.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getAdapter } from "../src/adapters";
import { parseReviewFile } from "../src/config";
import { notableOthers, onlyOtherLanguages, surveyLanguages } from "../src/languages";
import { coverageMap } from "../src/setup";
import { Cli } from "./helpers/cli";
import { commit, gitRepo, initRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const put = (repo: string, files: Record<string, string>) => {
  for (const [p, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), text);
  }
};

test("the survey counts languages by extension and manifest, leaving vendored code out", () => {
  const goOnly = surveyLanguages(["go.mod", "id.go", "id_test.go", "b/id.go", "vendor/x/y.go", "README.md"]);
  expect(goOnly.others).toEqual([{ name: "Go", files: 3, manifests: 1, roots: ["."] }]);
  expect(onlyOtherLanguages(goOnly, 0)).toBe(true);
  // A supported project beside it, or a real amount of supported code, is something arnx can review.
  const mixed = surveyLanguages(["backend/go.mod", "backend/main.go", "backend/api.go", "web/package.json",
    "web/src/App.tsx", "web/src/main.ts"]);
  expect(onlyOtherLanguages(mixed, 1)).toBe(false);
  expect(notableOthers(mixed).map((o) => [o.name, o.roots])).toEqual([["Go", ["backend"]]]);
  // One helper in another language is noise, not a language to name.
  const helper = surveyLanguages(["pyproject.toml", "app/main.py", "app/util.py", "tools/fast.c"]);
  expect(notableOthers(helper)).toEqual([]);
  expect(onlyOtherLanguages(helper, 1)).toBe(false);
  // A Go module with a lone JavaScript config file is still a Go repository.
  expect(onlyOtherLanguages(surveyLanguages(["go.mod", ...Array.from({ length: 30 }, (_, i) => `p/f${i}.go`),
    "eslint.config.js"]), 0)).toBe(true);
  expect(surveyLanguages(["Main.hs", "app.cabal", "lib/Server.ex", "mix.exs", "src/x.cpp", "src/x.hpp"]).others
    .map((o) => o.name).sort()).toEqual(["C/C++", "Elixir", "Haskell"]);
});

test("a repository written only in Go: init says so, doctor fails the Languages check, setup stops before sending", async () => {
  const repo = initRepo(join(tmp(), "repo"));
  put(repo, { "go.mod": "module example.com/x\n", "id.go": "package x\n", "id_test.go": "package x\n" });
  commit(repo, "go");
  const env = { ANTHROPIC_API_KEY: "a" };
  const cli = new Cli({ cwd: repo, env });
  expect(await cli.run("init")).toBe(0);
  const line = "this repository looks like Go (2 files); arnx reviews Python, JavaScript/TypeScript and Rust for " +
    "now. Tell us which language you need: https://github.com/arnx-dev/arnx/issues";
  expect(cli.stdout).toContain(`Note: ${line}`);
  expect(cli.stdout).not.toContain("Next: arnx setup");
  expect(await cli.run("doctor")).toBe(3);
  expect(cli.stdout).toContain(`✗ Languages: ${line}`);
  const setup = new Cli({ cwd: repo, env, ask: async () => { throw new Error("asked"); } });
  expect(await setup.run("setup", "--yes")).toBe(3);
  expect(setup.stderr).toBe(`✗ Languages: ${line}`);
  expect(existsSync(join(repo, ".arnx", "setup"))).toBe(false); // nothing read, sent or logged
});

test("a supported repository shows no Languages line", async () => {
  const repo = gitRepo(tmp());
  put(repo, { "pyproject.toml": "[project]\nname = \"x\"\n", "x/app.py": "X = 1\n" });
  commit(repo, "py");
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  expect(await cli.run("init")).toBe(0);
  await cli.run("doctor");
  expect(cli.stdout).not.toContain("Languages");
  expect(cli.stdout).not.toContain("Note:");
});

test("in a mixed repository, Go files count as uncovered on their own instead of unexplained", () => {
  const repo = initRepo(join(tmp(), "repo"));
  put(repo, { "backend/go.mod": "module x\n", "backend/main.go": "package main\n", "backend/api.go": "package main\n",
    "web/package.json": "{}\n", "web/src/App.tsx": "export {}\n" });
  commit(repo, "mixed");
  const file = parseReviewFile(`version: 1
projects:
  web:
    root: web
    language: typescript
    runner: vitest
    image: node:22
    test_command: npx vitest run {targets}
`);
  const map = coverageMap(repo, file);
  expect(map.unexplained).toEqual([]);
  expect(map.uncovered).toEqual([{ path: "Go files", reason: "Go: arnx does not review it yet", files: 2 }]);
});

test("an unknown language names only the languages arnx reviews", () => {
  expect(() => getAdapter("go")).toThrow('unknown language "go"; arnx reviews python, typescript, rust');
});
