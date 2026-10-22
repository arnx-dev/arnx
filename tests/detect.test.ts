import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describeDetection, detect } from "../src/detect";
import { commit, initRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

function repoWith(files: Record<string, string>): string {
  const repo = initRepo(join(tmp(), "r"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  commit(repo, "files");
  return repo;
}
const pkg = (o: object) => JSON.stringify(o);
const short = (d: ReturnType<typeof detect>) => d.candidates.map((c) => [c.root, c.language, c.runner, c.packageManager]);

test("services with their own package.json, a shared folder, compose and CI", () => {
  const d = detect(repoWith({
    "services/pay/package.json": pkg({ scripts: { test: "jest" }, devDependencies: { jest: "29" } }),
    "services/pay/package-lock.json": "{}",
    "services/pay/__tests__/a.test.js": "",
    "services/feed/package.json": pkg({ scripts: { test: "npm run test:unit", "test:unit": "node --test __tests__/*.test.js" } }),
    "services/feed/package-lock.json": "{}",
    "services/shared/db.js": "",
    "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n  mq:\n    image: \"rabbitmq:3-management\"\n",
    ".github/workflows/ci.yml": "jobs:\n  t:\n    services:\n      redis:\n        image: redis:7\n",
  }));
  expect(short(d)).toEqual([["services/feed", "typescript", "node", "npm"], ["services/pay", "typescript", "jest", "npm"]]);
  expect(d.services).toEqual(["postgres:16", "rabbitmq:3-management", "redis:7"]);
  expect(d.ci).toEqual([".github/workflows/ci.yml"]);
  expect(d.compose).toEqual(["docker-compose.yml"]);
  expect(d.languages.typescript).toBe(2);
  expect(d.candidates[1]!.evidence).toContain("1 test file");
  expect(describeDetection(d)).toContain("services/pay: JavaScript/TypeScript, runner jest, npm");
});

test("a pnpm workspace with vitest", () => {
  const d = detect(repoWith({
    "package.json": pkg({ private: true, workspaces: ["packages/*"] }),
    "pnpm-lock.yaml": "",
    "pnpm-workspace.yaml": "packages: ['packages/*']\n",
    "packages/core/package.json": pkg({ devDependencies: { vitest: "2" }, scripts: { test: "vitest run" } }),
    "packages/core/src/a.test.ts": "",
  }));
  expect(short(d)).toEqual([[".", "typescript", null, "pnpm"], ["packages/core", "typescript", "vitest", "pnpm"]]);
  expect(d.workspaces).toEqual(["."]);
});

test("a Cargo workspace", () => {
  const d = detect(repoWith({
    "Cargo.toml": "[workspace]\nmembers = [\"crates/*\"]\n",
    "Cargo.lock": "",
    "crates/calc/Cargo.toml": "[package]\nname = \"calc\"\n",
    "crates/calc/src/lib.rs": "",
    "crates/calc/tests/add.rs": "",
  }));
  expect(short(d)).toEqual([["crates/calc", "rust", "nextest", "cargo"]]);
  expect(d.workspaces).toEqual(["."]);
  expect(d.languages.rust).toBe(2);
});

test("a Python project, and node_modules is ignored", () => {
  const d = detect(repoWith({
    "pyproject.toml": "[project]\nname='x'\n[tool.pytest.ini_options]\n",
    "tests/test_a.py": "",
    "node_modules/x/package.json": pkg({}),
  }));
  expect(short(d)).toEqual([[".", "python", "pytest", null]]);
});

test("tests in test/ folders and Rust tests inside src/ are counted", () => {
  const d = detect(repoWith({
    "package.json": pkg({ scripts: { test: "node --test" } }),
    "test/format.js": "",
    "test/fixtures/data.json": "{}",
    "rust/Cargo.toml": "[package]\nname = \"x\"\n",
    "rust/src/lib.rs": "pub fn f() {}\n#[cfg(test)]\nmod tests {\n  #[test]\n  fn t() {}\n}\n",
    "rust/src/other.rs": "pub fn g() {}\n",
  }));
  expect(d.candidates.map((c) => [c.root, c.evidence[0]])).toEqual([[".", "2 test files"], ["rust", "1 test file"]]);
});

test("fixtures are not projects, an empty image line is not a service, and long lists are capped", () => {
  const many: Record<string, string> = {};
  for (let i = 0; i < 45; i++) many[`examples/e${String(i).padStart(2, "0")}/package.json`] = pkg({});
  const d = detect(repoWith({
    "package.json": pkg({ devDependencies: { vitest: "2" } }),
    "src/a.test.ts": "",
    "packages/x/fixtures/app/package.json": pkg({}),
    "packages/x/__fixtures__/p/package.json": pkg({}),
    "packages/x/test/apps/basic/package.json": pkg({}),
    ".github/workflows/img.yml": "jobs:\n  build:\n    image:\n  concurrency:\n    group: x\n",
    ...many,
  }));
  expect(d.candidates.some((c) => /fixtures|test\//.test(c.root))).toBe(false);
  expect(d.services).toEqual([]);
  const text = describeDetection(d);
  expect(text).toContain("- .: JavaScript/TypeScript, runner vitest");
  expect(text).toContain("... 6 more candidates");
  expect(text.split("\n").filter((l) => l.startsWith("- ")).length).toBe(40);
});

test("image names built from variables use their defaults", () => {
  const d = detect(repoWith({
    "package.json": pkg({}),
    "compose.yml": "services:\n  s3:\n    image: ${MINIO_IMAGE:-quay.io/minio/minio:latest}\n" +
      "  app:\n    image: ${REG:-local}/shop/api:${TAG:-latest}\n  x:\n    image: ${ONLY_VAR}\n",
  }));
  expect(d.services).toEqual(["local/shop/api:latest", "quay.io/minio/minio:latest"]);
});

test("untracked files count as the snapshot holds them; git-ignored ones do not", () => {
  const repo = repoWith({ ".gitignore": "build/\n", "app/package.json": pkg({ scripts: { test: "vitest" } }) });
  for (const p of ["app/a.test.ts", "app/b.ts", "build/c.test.ts"]) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), "");
  }
  const d = detect(repo);
  expect(d.languages.typescript).toBe(2);
  expect(d.candidates[0]!.evidence).toContain("1 test file");
});
