import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { parseReviewFile } from "../src/config";
import { describeDetection, detect } from "../src/detect";
import { draftReview, draftYaml } from "../src/draft";
import { satisfies } from "../src/facts";
import { defaultSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { fakeFactory, ScriptedAgent, text } from "./helpers/fakes";
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
const projects = (d: ReturnType<typeof detect>) => (draftReview(d)!.doc.projects ?? {}) as Record<string, any>;
const unsure = (d: ReturnType<typeof detect>) => draftReview(d)!.marks.map((m) => `${m.path.join(".")}: ${m.why}`);

const CI = `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_PASSWORD: ci
          POSTGRES_DB: shop
    env:
      DATABASE_URL: postgres://postgres:ci@localhost:5432/shop
      PLAIN: "1"
    strategy:
      matrix:
        node: [18, 20]
    steps:
      - uses: actions/setup-node@v4
        with:
          node-version: \${{ matrix.node }}
      - run: pnpm install --frozen-lockfile
      - run: pnpm vitest run
        working-directory: packages/api
`;

test("a pnpm workspace: CI's Node version, one install at the workspace root, CI's database", () => {
  const d = detect(repoWith({
    "package.json": pkg({ private: true, packageManager: "pnpm@9.12.0" }),
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    "pnpm-lock.yaml": "",
    "packages/api/package.json": pkg({ devDependencies: { vitest: "2" }, dependencies: { pg: "8" } }),
    "packages/api/package-lock.json": "{}",
    "packages/api/src/a.test.ts": "import { test } from 'vitest'\n",
    ".github/workflows/ci.yml": CI,
  }));
  const api = projects(d).api;
  expect(api).toMatchObject({ root: "packages/api", language: "typescript", runner: "vitest", image: "node:20",
    install_root: ".", services: ["postgres"], env: { DATABASE_URL: "postgres://postgres:ci@postgres:5432/shop" } });
  // The member's own lockfile is stale: the workspace's decides.
  expect(api.install[0]).toBe("corepack enable && mkdir -p /opt/ws && cp -a . /opt/ws/ && cd /opt/ws && " +
    "pnpm install --frozen-lockfile");
  expect([api.deps_dir, api.test_command]).toEqual(["/opt/ws", "npx vitest run {targets}"]);
  const doc = draftReview(d)!.doc as Record<string, any>;
  expect(doc.services.postgres).toEqual({ image: "postgres:16", env: { POSTGRES_PASSWORD: "ci", POSTGRES_DB: "shop" },
    ready: "pg_isready -U postgres" });
  expect(doc.allow_env_names).toEqual(["POSTGRES_PASSWORD"]);
  expect(describeDetection(d)).toContain("CI test commands: pnpm vitest run (.github/workflows/ci.yml:test)");
  // The draft is a review.yaml setup can take as it is.
  const text = draftYaml(d);
  expect(text).toContain("pnpm install --frozen-lockfile # unsure: one install for the workspace");
  expect(parseReviewFile(text).projects.map((p) => p.name)).toEqual(["api"]);
});

test("Python with uv: the pinned version, uv sync into the system Python, pytest", () => {
  const d = detect(repoWith({
    "pyproject.toml": "[project]\nname='x'\nrequires-python='>=3.9'\n[dependency-groups]\ndev=['pytest']\n" +
      "test=['hypothesis']\n",
    "uv.lock": "",
    ".python-version": "3.11\n",
    "tests/test_a.py": "",
  }));
  expect(projects(d).main).toEqual({ root: ".", language: "python", runner: "pytest", image: "python:3.11",
    install: ["pip install uv && UV_PROJECT_ENVIRONMENT=/usr/local uv sync --frozen --group test",
      "pip install pytest hypothesis"], test_command: "python -m pytest {targets}" });
  expect(unsure(d)).toEqual([]);
});

test("Python with pip: a version picked from the range is unsure, requirement files and test extras install", () => {
  const d = detect(repoWith({
    "svc/pyproject.toml": "[project]\nname='svc'\nrequires-python='>=3.8,<3.12'\n[project.optional-dependencies]\n" +
      "test=['pytest']\ndocs=['sphinx']\n[build-system]\nrequires=['setuptools']\n",
    "svc/requirements.txt": "psycopg2-binary==2.9\n",
    "svc/requirements-dev.txt": "",
    "svc/requirements-docs.txt": "",
    "svc/tests/conftest.py": "URL = os.environ['DATABASE_URL']\n",
    "svc/tests/test_a.py": "",
  }));
  const svc = projects(d).svc;
  expect(svc.image).toBe("python:3.11");
  expect(svc.install).toEqual(["pip install -r requirements.txt -r requirements-dev.txt -e '.[test]'",
    "pip install pytest hypothesis"]);
  // No file defines a database; the tests connect to one, so a stock image of it.
  expect(svc.services).toEqual(["postgres"]);
  expect((draftReview(d)!.doc as Record<string, any>).services.postgres.image).toBe("postgres:16");
  expect(unsure(d)).toEqual(["projects.svc.image: picked from svc/pyproject.toml python range >=3.8,<3.12",
    "projects.svc.services.0: its tests connect to postgres"]);
});

test("a Cargo workspace: rust-toolchain's channel, one test build, system packages the lockfile needs", () => {
  const d = detect(repoWith({
    "Cargo.toml": "[workspace]\nmembers = [\"crates/*\"]\nexclude = [\"crates/old\"]\n",
    "Cargo.lock": "[[package]]\nname = \"prost-build\"\nversion = \"0.12.0\"\n",
    "rust-toolchain.toml": "[toolchain]\nchannel = \"1.80.0\"\n",
    "crates/calc/Cargo.toml": "[package]\nname = \"calc\"\n",
    "crates/calc/tests/add.rs": "",
    "crates/old/Cargo.toml": "[package]\nname = \"old\"\n[workspace]\n",
    "crates/old/tests/a.rs": "",
  }));
  expect(projects(d).calc).toEqual({ root: "crates/calc", language: "rust", runner: "nextest", image: "rust:1.80.0",
    install_root: ".", install: ["apt-get update && apt-get install -y --no-install-recommends protobuf-compiler && " +
      "rm -rf /var/lib/apt/lists/*", "curl -LsSf https://get.nexte.st/latest/linux | tar zxf - -C /usr/local/cargo/bin",
    "cargo nextest run --workspace --no-run"], test_command: "cargo nextest run {targets}" });
  // An excluded crate is a workspace of its own.
  expect(projects(d).old.install_root).toBeUndefined();
  expect(unsure(d)).toEqual(["projects.calc.install.0: system packages Cargo.lock suggests"]);
});

test("the runner the test files import wins over the one package.json lists; mocha runs under node --test", () => {
  const d = detect(repoWith({
    "svc/package.json": pkg({ devDependencies: { jest: "29", "ts-node": "10" }, scripts: { test: "jest" } }),
    "svc/package-lock.json": "{}",
    "svc/test/a.test.ts": "import { test } from 'node:test'\n",
    "svc/test/b.test.ts": "const { test } = require(\"node:test\")\n",
    "old/package.json": pkg({ devDependencies: { mocha: "10" }, scripts: { test: "mocha" } }),
    "old/test/a.test.js": "describe('x', () => {})\n",
  }));
  expect(d.candidates.map((c) => [c.root, c.runner])).toEqual([["old", "mocha"], ["svc", "node"]]);
  const p = projects(d);
  expect([p.svc.deps_dir, p.svc.test_command]).toEqual(["/opt/deps",
    "node --test --require ts-node/register/transpile-only {targets}"]);
  expect([p.old.runner, p.old.image, p.old.install]).toEqual(["node", "node:22",
    ["mkdir -p /opt/deps && cp package.json /opt/deps/ && cd /opt/deps && npm install"]]);
  expect(unsure(d)).toEqual(["projects.old.runner: the tests are mocha's; node --test runs them once describe and it " +
    "are global", "projects.old.image: no Node version found", "projects.old.install: no lockfile found",
  "projects.svc.image: no Node version found"]);
});

test("compose: a service the code depends on is named in the hints, not put in the draft", () => {
  const d = detect(repoWith({
    "api/package.json": pkg({ dependencies: { ioredis: "5" }, devDependencies: { vitest: "2" } }),
    "api/package-lock.json": "{}",
    "api/a.test.ts": "",
    "api/Dockerfile": "ARG NODE=18\nFROM node:${NODE}-alpine AS build\n",
    ".nvmrc": "lts/*\n",
    "docker-compose.yml": "services:\n  cache:\n    image: redis:7\n  api:\n    build: ./api\n    depends_on: [cache]\n" +
      "    environment:\n      - REDIS_URL=redis://cache:6379\n",
    ".env.example": "",
    "api/.env.example": "REDIS_URL=\nexport API_KEY=x\n",
  }));
  const api = projects(d).api;
  expect(api.services).toBeUndefined();
  expect(api.image).toBe("node:18");
  expect(unsure(d)).toContain("projects.api.image: picked from api/Dockerfile (the image it ships in)");
  const hints = describeDetection(d);
  expect(hints).toContain("Services the code may use, left out of the draft: api: cache " +
    "(docker-compose.yml:api depends on it)");
  expect(hints).toContain("Example env files name: api: REDIS_URL, API_KEY");
});

test("no draft without candidates; with no tests or sources anywhere, the outermost candidate", () => {
  expect(draftYaml(detect(repoWith({ "README.md": "" })))).toBe("");
  const d = detect(repoWith({ "package.json": pkg({}), "web/package.json": pkg({}) }));
  expect(Object.keys(projects(d))).toEqual(["main"]);
  expect(unsure(d)).toContain("projects.main.root: no test files found here");
});

test("a package without tests is drafted only when it holds sources no drafted project owns", () => {
  const d = detect(repoWith({
    "package.json": pkg({ private: true, workspaces: ["packages/*"] }),
    "package-lock.json": "{}",
    "scripts/release.ts": "",
    "packages/api/package.json": pkg({ devDependencies: { vitest: "2" } }),
    "packages/api/src/a.ts": "",
    "packages/api/src/a.test.ts": "",
    "packages/api/tools/package.json": pkg({}),
    "packages/api/tools/gen.ts": "",
    "packages/ui/package.json": pkg({}),
    "packages/ui/src/button.tsx": "",
    "packages/config/package.json": pkg({}),
    "packages/config/README.md": "",
  }));
  expect(Object.values(projects(d)).map((p) => p.root)).toEqual([".", "packages/api", "packages/ui"]);
  expect(unsure(d)).toContain("projects.ui.root: no test files found here");
});

test("version ranges", () => {
  expect(satisfies("3.12", ">=3.9")).toBe(true);
  expect(satisfies("3.12", ">=3.9,<3.12")).toBe(false);
  expect(satisfies("3.11", "^3.10")).toBe(true);
  expect(satisfies("3.11", "~3.10")).toBe(false);
  expect(satisfies("22", ">=18 <21 || >=22")).toBe(true);
  expect(satisfies("20", "20.x")).toBe(true);
  expect(satisfies("22", "^18.17.0")).toBe(false);
  expect(satisfies("3.12", "~=3.11")).toBe(true);
});

test("setup sends the draft with the task", async () => {
  const repo = repoWith({ "pyproject.toml": "[project]\nname='x'\n", "tests/test_a.py": "def test_a(): pass\n" });
  const model = new ScriptedAgent([[text("done")]]);
  await runSetup(repo, defaultSettings(), model, { outDir: `${tmp()}/s`, sessionFactory: fakeFactory(() => ["", "", true]) });
  const first = String(model.calls[0]!.messages[0]!.content);
  expect(first).toContain("A draft review.yaml, written from the repository's files without a model");
  expect(first).toContain("<draft>\nversion: 1\nprojects:\n  main:\n    root: .\n");
  expect(parse(first.split("<draft>\n")[1]!.split("</draft>")[0]!).projects.main.test_command)
    .toBe("python -m pytest {targets}");
});
