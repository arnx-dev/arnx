import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { parseReviewFile } from "../src/config";
import { describeDetection, detect } from "../src/detect";
import { draftReview, draftYaml, quickDraft } from "../src/draft";
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

test("a package without tests under docs or examples is not drafted: the map lists it as not tested", () => {
  const d = detect(repoWith({
    "package.json": pkg({ private: true, workspaces: ["packages/*", "examples/*", "docs"] }),
    "package-lock.json": "{}",
    "packages/api/package.json": pkg({ devDependencies: { vitest: "2" } }),
    "packages/api/src/a.test.ts": "",
    "examples/basic/package.json": pkg({}),
    "examples/basic/index.ts": "",
    "docs/package.json": pkg({}),
    "docs/site.ts": "",
    "packages/demo-kit/package.json": pkg({}),
    "packages/demo-kit/src/kit.ts": "",
  }));
  expect(Object.values(projects(d)).map((p) => p.root)).toEqual(["packages/api", "packages/demo-kit"]);
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

const MANY_CI = `
on: push
jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
      redis:
        image: redis:7
      minio:
        image: minio/minio:latest
    steps:
      - run: pytest
        working-directory: server
`;

test("a backend whose tests need three or more services goes under uncovered, naming them; two still draft", () => {
  const files = { "server/pyproject.toml": "[project]\nname='server'\n", "server/tests/test_a.py": "",
    "worker/pyproject.toml": "[project]\nname='worker'\n", "worker/tests/test_w.py": "" };
  const d = detect(repoWith({ ...files, ".github/workflows/ci.yml": MANY_CI }));
  const doc = draftReview(d)!.doc as Record<string, any>;
  expect(Object.keys(doc.projects)).toEqual(["worker"]);
  expect(doc.services).toBeUndefined();
  expect(doc.uncovered).toEqual([{ path: "/server/", reason: "needs postgres, redis and minio; setup does not start " +
    "three or more services: set it up by hand, or with fewer" }]);
  expect(parseReviewFile(draftYaml(d)).uncovered.map((u) => u.path)).toEqual(["/server/"]);
  const two = detect(repoWith({ ...files, ".github/workflows/ci.yml": MANY_CI.replace(/ {6}minio:\n.*\n/, "") }));
  expect(projects(two).server.services).toEqual(["postgres", "redis"]);
});

/** Two Python projects, one at the root and one in sub/, with `steps` as the one CI job (it starts `services`). */
function twoProjects(steps: string, services = ["postgres:16", "mysql:8", "redis:7"]) {
  const ci = "on: push\njobs:\n  integration:\n    runs-on: ubuntu-latest\n    services:\n" +
    services.map((s) => `      ${s.split(":")[0]}:\n        image: ${s}\n`).join("") + `    steps:\n${steps}`;
  const d = detect(repoWith({ "pyproject.toml": "[project]\nname='x'\n", "tests/test_a.py": "",
    "sub/pyproject.toml": "[project]\nname='sub'\n", "sub/tests/test_b.py": "", ".github/workflows/ci.yml": ci }));
  const of = (root: string) => d.facts!.projects.find((p) => p.root === root)!;
  return { d, root: of("."), sub: of("sub") };
}
const CHECKOUT = "      - uses: actions/checkout@v4\n      - uses: actions/setup-python@v5\n" +
  "        with: { python-version: '3.12' }\n";

test("a job that tests only in a sub-folder is not the root project's, whatever else it runs without a folder", () => {
  const sub = "      - name: test\n        working-directory: sub\n        run: pytest\n";
  for (const steps of [`${CHECKOUT}      - run: git checkout -\n${sub}`, `${CHECKOUT}      - run: cd sub && pytest\n`,
    `${CHECKOUT}      - run: |\n          cd sub\n          pip install -e .\n          pytest\n`]) {
    const { d, root, sub: inSub } = twoProjects(steps);
    expect([root.jobs, root.services]).toEqual([[], []]);
    expect(inSub.jobs).toEqual([".github/workflows/ci.yml:integration"]);
    const doc = draftReview(d)!.doc as Record<string, any>;
    expect(Object.keys(doc.projects)).toEqual(["main"]);
    expect(doc.projects.main.services).toBeUndefined();
    expect(doc.uncovered.map((u: { path: string }) => u.path)).toEqual(["/sub/"]);
  }
});

test("a job that tests at the root and in a sub-folder is both projects'", () => {
  const { root, sub } = twoProjects(`${CHECKOUT}      - run: pytest\n      - run: pytest\n        working-directory: sub\n`,
    ["postgres:16", "redis:7"]);
  for (const p of [root, sub]) {
    expect(p.jobs).toEqual([".github/workflows/ci.yml:integration"]);
    expect(p.services.map((s) => s.value)).toEqual(["postgres", "redis"]);
  }
});

test("a job that installs and tests at the root is the root project's, with its services", () => {
  const { root, sub } = twoProjects(`${CHECKOUT}      - run: git checkout -\n      - run: pip install -e .\n` +
    "      - run: pytest\n");
  expect(root.jobs).toEqual([".github/workflows/ci.yml:integration"]);
  expect(root.services.map((s) => s.value)).toEqual(["postgres", "mysql", "redis"]);
  expect(sub.jobs).toEqual([]);
  // A job that neither installs nor tests anywhere stays where it runs.
  const other = twoProjects(`${CHECKOUT}      - run: make check\n        working-directory: sub\n`);
  expect([other.root.jobs, other.sub.jobs]).toEqual([[], [".github/workflows/ci.yml:integration"]]);
});

test("try_project refuses such a project while it lists three or more services", async () => {
  const repo = repoWith({ "server/pyproject.toml": "[project]\nname='server'\n", "server/tests/test_a.py": "",
    ".github/workflows/ci.yml": MANY_CI });
  const services = "services:\n  postgres: {image: postgres:16}\n  redis: {image: redis:7}\n" +
    "  minio: {image: minio/minio:latest}\n";
  const yaml = (names: string) => `version: 1\n${services}projects:\n  server:\n    root: server\n` +
    `    language: python\n    image: python:3.12\n    test_command: python -m pytest {targets}\n` +
    `    services: [${names}]\n`;
  const model = new ScriptedAgent([[{ type: "tool_use", id: "t1", name: "try_project",
    input: { yaml: yaml("postgres, redis, minio") } }], [text("done")]]);
  const said: string[] = [];
  let runs = 0;
  await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "out"), progress: (m) => said.push(m),
    sessionFactory: fakeFactory(() => {
      runs++;
      return [null, "", false];
    }) });
  expect(runs).toBe(0);
  const result = JSON.stringify(model.calls[1]!.messages.at(-1));
  expect(result).toContain("refused: server needs postgres, redis and minio; setup does not start three or more " +
    "services: set it up by hand, or with fewer. Do not try it: keep it under uncovered (path /server/, this reason)");
  expect(said).toContain("server: not set up: needs postgres, redis and minio; setup does not start three or more " +
    "services: set it up by hand, or with fewer");
});

const WORKSPACE = {
  "package.json": pkg({ private: true, packageManager: "pnpm@9.12.0" }),
  "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
  "pnpm-lock.yaml": "",
  "docs/advanced.md": "# advanced\n",
  "scripts/release.ts": "",
  "packages/core/package.json": pkg({ name: "@w/core", devDependencies: { vitest: "2" } }),
  "packages/core/src/a.ts": "export const a = 1;\n",
  "packages/core/src/a.test.ts": "",
  "packages/ext/package.json": pkg({ name: "@w/ext", devDependencies: { vitest: "2" } }),
  "packages/ext/src/b.ts": "export const b = 1;\n",
  "packages/ext/src/c.ts": "export const c = 1;\n",
  "packages/ext/src/b.test.ts": "",
};

test("a doc file alone does not choose a project; chosen projects come most changed source files first", () => {
  const d = detect(repoWith(WORKSPACE));
  // The root project owns docs/, but a doc file is not what a change to code is about.
  expect(quickDraft(d, ["docs/advanced.md", "packages/core/src/a.ts"])!.names).toEqual(["core"]);
  expect(quickDraft(d, ["packages/core/src/a.ts", "packages/ext/src/b.ts", "packages/ext/src/c.ts"])!.names)
    .toEqual(["ext", "core"]);
  // With no source file among them, every changed file counts as before.
  expect(quickDraft(d, ["docs/advanced.md"])!.names).toEqual(["main"]);
});

test("a new project takes the install of its neighbour", () => {
  const d = detect(repoWith(WORKSPACE));
  const first = quickDraft(d, ["packages/core/src/a.ts"])!;
  const edited = first.yaml.replace(/image: node:\S+/, "image: node:20.11")
    .replace("npx vitest run {targets}", "npx vitest run --project @w/ext {targets}")
    .replace(/(install:\n\s+- )(.*)/, "$1pnpm install --frozen-lockfile && pnpm -r build");
  const next = quickDraft(d, ["packages/ext/src/b.ts"], edited)!;
  expect(next.names).toEqual(["ext"]);
  const f = parseReviewFile(next.yaml);
  const [core, ext] = f.projects;
  expect([ext!.image, ext!.install, ext!.depsDir]).toEqual([core!.image, core!.install, core!.depsDir]);
  expect(ext!.image).toBe("node:20.11");
  // The runner's project name is not known: the neighbour's command is not copied, the draft's own stands.
  expect(ext!.testCommand).toBe("npx vitest run {targets}");
  expect(next.yaml).toContain("# unsure: image and install copied from core");
});

test("an image without corepack installs it first", () => {
  const install = (nvmrc: string, dir: string) => {
    const repo = initRepo(join(tmp(), dir));
    const files: Record<string, string> = {
      "package.json": pkg({ packageManager: "pnpm@9.12.0", devDependencies: { vitest: "2" } }),
      "pnpm-lock.yaml": "", ".nvmrc": nvmrc, "src/a.test.ts": "import { test } from 'vitest'\n" };
    for (const [p, body] of Object.entries(files)) {
      mkdirSync(dirname(join(repo, p)), { recursive: true });
      writeFileSync(join(repo, p), body);
    }
    commit(repo, "files");
    return (Object.values(projects(detect(repo)))[0] as any).install[0] as string;
  };
  expect(install("26\n", "n26")).toStartWith("npm install -g corepack && corepack enable && ");
  expect(install("22\n", "n22")).toStartWith("corepack enable && ");
  expect(install("22\n", "n22b")).not.toContain("npm install -g corepack");
});

test("a project with a prisma schema generates its client in install", () => {
  const files = (extra: Record<string, string>) => ({
    "package.json": pkg({ private: true, packageManager: "pnpm@9.12.0", workspaces: ["packages/*"] }),
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    "pnpm-lock.yaml": "",
    "packages/lib/package.json": pkg({ dependencies: { "@prisma/client": "5.0.0" }, devDependencies: { vitest: "3.0.0" } }),
    "packages/lib/src/a.test.ts": "",
    ...extra });
  const withSchema = projects(detect(repoWith(files({ "packages/lib/prisma/schema.prisma": "generator client {}\n" }))));
  const lib = Object.values(withSchema).find((p) => p.root === "packages/lib")!;
  expect(lib.install.join("\n")).toContain("pnpm install --frozen-lockfile && npx prisma@5.0.0 generate " +
    "--schema=packages/lib/prisma/schema.prisma");
});

test("a project that uses prisma but holds no schema adds no generate step", () => {
  const files = (extra: Record<string, string>) => ({
    "package.json": pkg({ private: true, packageManager: "pnpm@9.12.0", workspaces: ["packages/*"] }),
    "pnpm-workspace.yaml": "packages:\n  - 'packages/*'\n",
    "pnpm-lock.yaml": "",
    "packages/lib/package.json": pkg({ dependencies: { "@prisma/client": "5.0.0" }, devDependencies: { vitest: "3.0.0" } }),
    "packages/lib/src/a.test.ts": "",
    ...extra });
  const none = Object.values(projects(detect(repoWith(files({})))));
  expect(none.map((p) => p.install.join("\n")).join("\n")).not.toContain("prisma");
});

// Runs a drafted install line in a scratch folder with the package manager and npx stood in by functions: what it
// copies, and what npx was given.
function runInstall(repo: string, line: string): { deps: string; npx: string; status: number | null } {
  const deps = join(tmp(), "deps");
  const out = join(tmp(), "npx.out");
  const script = `corepack() { :; }\npnpm() { :; }\nnpx() { printf '%s\\n' "$@" > '${out}'; }\n` +
    line.replaceAll("/opt/deps", deps);
  const r = spawnSync("bash", ["-c", script], { cwd: repo, encoding: "utf8", env: { ...process.env, HOME: "/nonexistent" } });
  return { deps, npx: existsSync(out) ? readFileSync(out, "utf8") : "", status: r.status };
}

test("a prisma schema path with a space and a $ is quoted: the right file is installed and nothing else runs", () => {
  const path = "my app/pri$ma/schema.prisma";
  const repo = repoWith({
    "package.json": pkg({ packageManager: "pnpm@9.12.0", dependencies: { "@prisma/client": "5.0.0" },
      devDependencies: { vitest: "3" } }),
    "pnpm-lock.yaml": "", "src/a.test.ts": "", [path]: "generator client {}\n" });
  const lib = Object.values(projects(detect(repo)))[0]!;
  const line = lib.install.join("\n");
  expect(line).toContain("--schema='my app/pri$ma/schema.prisma'");
  const r = runInstall(repo, line);
  expect(r.status).toBe(0);
  expect(readFileSync(join(r.deps, path), "utf8")).toBe("generator client {}\n");
  expect(r.npx).toBe(`prisma@5.0.0\ngenerate\n--schema=${path}\n`);
});

test("a project outside a workspace copies its schema next to its manifests and generates there", () => {
  const repo = repoWith({
    "package.json": pkg({ packageManager: "pnpm@9.12.0", dependencies: { prisma: "5.0.0" }, devDependencies: { vitest: "3" } }),
    "pnpm-lock.yaml": "", "src/a.test.ts": "", "prisma/schema.prisma": "generator client {}\n" });
  const lib = Object.values(projects(detect(repo)))[0]!;
  expect(lib.install[0]).toContain("cp --parents prisma/schema.prisma /opt/deps/");
  const r = runInstall(repo, lib.install.join("\n"));
  expect(r.status).toBe(0);
  expect(readFileSync(join(r.deps, "prisma/schema.prisma"), "utf8")).toBe("generator client {}\n");
  expect(r.npx).toBe("prisma\ngenerate\n--schema=prisma/schema.prisma\n");
});

describe("the prisma CLI that generates the client", () => {
  const install = (deps: object) => {
    const repo = repoWith({
      "package.json": pkg({ packageManager: "pnpm@9.12.0", ...deps }),
      "pnpm-lock.yaml": "", "src/a.test.ts": "", "prisma/schema.prisma": "generator client {}\n" });
    return Object.values(projects(detect(repo)))[0]!.install.join("\n");
  };
  const vitest = { vitest: "3" };

  test("a client without the CLI pins the CLI to the client's version", () => {
    expect(install({ dependencies: { "@prisma/client": "^5.10.2" }, devDependencies: vitest }))
      .toContain("npx prisma@5.10.2 generate --schema=prisma/schema.prisma");
    expect(install({ dependencies: { "@prisma/client": "~5.10.2" }, devDependencies: vitest }))
      .toContain("npx prisma@5.10.2 generate");
    expect(install({ dependencies: { "@prisma/client": "5.10.2" }, devDependencies: vitest }))
      .toContain("npx prisma@5.10.2 generate");
  });

  test("a version that cannot be pinned adds no step", () => {
    for (const v of ["*", "latest", "workspace:*", "https://example.com/c.tgz", ">=5"]) {
      expect(install({ dependencies: { "@prisma/client": v }, devDependencies: vitest })).not.toContain("prisma");
    }
  });

  test("the CLI among the dependencies or devDependencies runs as installed", () => {
    expect(install({ dependencies: { "@prisma/client": "^5.10.2" }, devDependencies: { ...vitest, prisma: "^5.10.2" } }))
      .toContain("npx prisma generate --schema=prisma/schema.prisma");
    expect(install({ dependencies: { prisma: "*" }, devDependencies: vitest })).toContain("npx prisma generate");
  });
});

test("a project with compiled extensions brings them back at run", () => {
  const files = (extra: Record<string, string>) => ({
    "pkg/setup.py": "from setuptools import setup\nsetup(name='pkg')\n",
    "pkg/requirements.txt": "cython\n",
    "pkg/tests/test_a.py": "def test_a():\n    pass\n", ...extra });
  let n = 0;
  const repoOf = (extra: Record<string, string>) => {
    const repo = initRepo(join(tmp(), `r${n++}`));
    for (const [p, body] of Object.entries(files(extra))) {
      mkdirSync(dirname(join(repo, p)), { recursive: true });
      writeFileSync(join(repo, p), body);
    }
    commit(repo, "files");
    return repo;
  };
  const native = (extra: Record<string, string>) => Object.values(projects(detect(repoOf(extra))))[0]!;
  // .pyx files, or ext_modules in setup.py, mean the install builds them and test runs have no compiler or network.
  for (const extra of <Record<string, string>[]>[{ "pkg/setup.py": "from setuptools import setup\nfrom Cython.Build import cythonize\nsetup(name='pkg', ext_modules=cythonize('fast.pyx'))\n" },
    { "pkg/setup.py": "from setuptools import setup, Extension\nsetup(name='pkg', ext_modules=[Extension('a', ['a.c'])])\n" }]) {
    const p = native(extra);
    expect(p.install.join("\n")).toContain("python setup.py build_ext --inplace && find . -name '*.so' | tar czf /opt/ext.tgz -T -");
    expect(p.test_command).toBe("tar xzf /opt/ext.tgz && python -m pytest {targets}");
  }
  const plain = native({});
  expect(plain.install.join("\n")).not.toContain("build_ext");
  expect(plain.test_command).toBe("python -m pytest {targets}");
  expect(native({ "pkg/setup.py": "from setuptools import setup, Extension\nsetup(name='pkg', ext_modules=[Extension('a', ['a.c'])])\n" })
    .notes.join(" ")).toContain("not rebuilt");
  expect(plain.notes).toBeUndefined();
});

test("a .pyx file with no setup.py adds no build_ext: the project's own install builds it", () => {
  const repo = initRepo(join(tmp(), "pyx"));
  for (const [p, body] of Object.entries({ "pkg/pyproject.toml": "[build-system]\nrequires=['meson-python']\n[project]\nname='pkg'\nversion='1'\n",
    "pkg/fast.pyx": "def f(): pass\n", "pkg/tests/test_a.py": "def test_a():\n    pass\n" })) {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  commit(repo, "files");
  const p = Object.values(projects(detect(repo)))[0]!;
  expect(p.install.join("\n")).not.toContain("build_ext");
  expect(p.test_command).toBe("python -m pytest {targets}");
});
