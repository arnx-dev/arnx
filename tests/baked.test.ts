import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bakedKey, commandPaths, differing, findCopies, onlyInCopies, packageName, reached, scopeFiles }
  from "../src/baked";
import { parseReviewConfig } from "../src/config";
import { cacheRecords, sourceRecords } from "../src/envprune";
import { dockerSteps, envKey, sandboxOptions } from "../src/sandbox";
import { dockerSession } from "../src/testround";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

const BAKED = `
version: 1
image: python:3.12-slim
workdir: app
install: ["mkdir -p /opt/app && cp -r . /opt/app"]
test_command: cd /opt/app && python -m pytest -q {targets}
`;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function write(root: string, files: Record<string, string>): string {
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text);
  }
  return root;
}

test("a folder holding the project's files is a copy; a stray file of the same name is not", () => {
  const files = ["src/a.ts", "src/b.ts", "c.ts", "index.js"];
  const copies = findCopies(["/opt/web/src/a.ts", "/opt/web/src/b.ts", "/opt/web/c.ts", "/opt/other/index.js",
    "/root/.npm/x/index.js"], [{ scope: "web", files }]);
  expect(copies).toEqual([{ root: "/opt/web", scope: "web", files: ["c.ts", "src/a.ts", "src/b.ts"] }]);
});

test("a copy of the project's folder seen again from the repository counts once", () => {
  const scopes = [{ scope: "app", files: ["a.py", "b.py", "c.py"] }, { scope: "", files: ["app/a.py", "app/b.py",
    "app/c.py"] }];
  expect(findCopies(["/opt/app/a.py", "/opt/app/b.py", "/opt/app/c.py"], scopes)).toEqual(
    [{ root: "/opt/app", scope: "app", files: ["a.py", "b.py", "c.py"] }]);
});

test("a few matching files of a large project are not a copy of it", () => {
  const files = Array.from({ length: 100 }, (_, i) => `src/f${i}.ts`);
  expect(findCopies(["/opt/x/src/f1.ts", "/opt/x/src/f2.ts", "/opt/x/src/f3.ts"], [{ scope: "", files }])).toEqual([]);
  const many = Array.from({ length: 50 }, (_, i) => `/opt/x/src/f${i}.ts`);
  expect(findCopies(many, [{ scope: "", files }]).map((c) => c.root)).toEqual(["/opt/x"]);
});

test("the files looked for leave out manifests, dependency folders and the folders skipped", () => {
  const snap = write(tmp(), { "web/package.json": "{}", "web/package-lock.json": "{}", "web/src/a.ts": "a",
    "web/node_modules/m/index.js": "m", "web/tests/arnx_generated/t.test.mjs": "t", "web/tests/own.test.mjs": "o" });
  expect(scopeFiles(snap, "web", ["tests/arnx_generated"])).toEqual(["src/a.ts", "tests/own.test.mjs"]);
});

test("files whose copy has other contents, or no hash, differ", () => {
  const snap = write(tmp(), { "web/src/a.ts": "new", "web/src/b.ts": "same", "web/c.ts": "c" });
  const copies = [{ root: "/opt/web", scope: "web", files: ["c.ts", "src/a.ts", "src/b.ts"] }];
  const hashes = new Map([["/opt/web/src/a.ts", sha("old")], ["/opt/web/src/b.ts", sha("same")]]);
  expect(differing(copies, hashes, snap)).toEqual(["web/c.ts", "web/src/a.ts"]);
});

test("the paths runs reach are those the commands and environment name, outside /src", () => {
  expect(commandPaths({ testCommand: "cd /opt/web && node --test {targets}", typecheck: "ln -sfn " +
    "/opt/web/node_modules node_modules && npx tsc -p ./tsconfig.json", env: { PYTHONPATH: "/opt/lib:/src/app",
    DIR: "${HOME}/x" } })).toEqual(["/opt/lib", "/opt/web", "/opt/web/node_modules"]);
});

test("a copy counts only when runs reach it: by a named path, or a symlink under one", () => {
  // an app built into a copy: the tests run inside it
  expect(reached("/opt/web", ["/opt/web"], [])).toBe(true);
  expect(reached("/opt/app", ["/opt"], [])).toBe(true);
  // a copy made to install from: only its dependencies are named, its workspace links point back to /src
  const deps = ["/opt/deps/node_modules", "/opt/deps/node_modules/.bin/tsc"];
  const links: [string, string][] = [["/opt/deps/node_modules/@x/api", "/src/packages/api"],
    ["/opt/deps/packages/api/node_modules/@x/shared", "/opt/deps/packages/shared"]];
  expect(reached("/opt/deps", deps, links)).toBe(false);
  // the same install whose workspace links lead into the copy
  expect(reached("/opt/deps", deps, [["/opt/deps/node_modules/@x/api", "/opt/deps/packages/api"]])).toBe(true);
  expect(reached("/opt/deps", deps, [["/opt/deps/node_modules/.bin/tsc", "/opt/deps/node_modules/ts/tsc"]]))
    .toBe(false);
});

test("the rebuilt image's key follows the code it holds, not the tests or reports beside it", () => {
  const cfg = parseReviewConfig(BAKED);
  const snap = write(tmp(), { "app/a.py": "1", "app/b.py": "b", "app/requirements.txt": "x" });
  const copies = [{ root: "/opt/app", scope: "app", files: ["a.py", "b.py"] }];
  const first = bakedKey("abc", cfg, copies, snap);
  expect(first).toMatch(/^abc-src-[0-9a-f]{12}$/);
  // generated tests, an accepted test put in place from .arnx/tests, the runners' reports: same code, same image
  write(snap, { [`app/${cfg.testsDir}/test_gen.py`]: "g", "app/tests/arnx/r1/test_k.py": "k",
    ".arnx/tests/app/tests/arnx/r1/test_k.py": "k", ".arnx-run/final-1.xml": "<x/>" });
  expect(bakedKey("abc", cfg, copies, snap)).toBe(first);
  writeFileSync(join(snap, "app/a.py"), "2");
  expect(bakedKey("abc", cfg, copies, snap)).not.toBe(first);
});

/** A docker holding `images` that lists /opt/app/{a,b,c}.py in every image, each hashed as `old`, and builds by
 * saving the Dockerfile and adding the tag. */
function bakedDocker(images: string[]): { builds: () => string[] } {
  const dir = tmp();
  writeFileSync(join(dir, "images"), images.map((t) => `${t}\n`).join(""));
  const old = sha("old");
  writeFileSync(join(dir, "docker"), `#!/bin/sh
case "$1" in
  info) echo 27;;
  image) grep -qxF "$3" '${join(dir, "images")}' || exit 1;;
  build) n=$(ls '${dir}' | grep -c '^build-'); cat > '${dir}'/build-$n; echo "$3" >> '${join(dir, "images")}';;
  run) case "$*" in
    *sha256sum*) cat > /dev/null; for f in a b c; do echo "${old}  /opt/app/$f.py"; done;;
    *) printf '/opt/app/a.py\n/opt/app/b.py\n/opt/app/c.py\n';;
  esac;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  return { builds: () => readdirSync(dir).filter((f) => f.startsWith("build-")).sort()
    .map((f) => readFileSync(join(dir, f), "utf8")) };
}

test("an image made from the code is marked with its tag and reused for the same code", async () => {
  const saved = { docker: sandboxOptions.docker, buildkit: sandboxOptions.buildkit };
  try {
    sandboxOptions.buildkit = false;
    const cfg = parseReviewConfig(BAKED);
    const code = { "app/requirements.txt": `# ${Date.now()}\n`, "app/a.py": "new", "app/b.py": "B", "app/c.py": "C" };
    const one = write(join(tmp(), "one"), code);
    const docker = bakedDocker([`arnx-env:${envKey(cfg, one)}`]);
    const open = (snap: string) => dockerSession(cfg, snap, join(tmp(), "build.log"), async () => null);
    await open(one);
    expect(docker.builds()).toHaveLength(1);
    const tag = `arnx-env:${bakedKey(envKey(cfg, one), cfg, [{ root: "/opt/app", scope: "app", files: ["a.py"] }],
      one)}`;
    expect(docker.builds()[0]).toContain(`COPY . /src\nRUN : ${tag}\n`);
    // The same code in a later session (the generated tests now in place) uses that image.
    await open(write(join(tmp(), "two"), { ...code, [`app/${cfg.testsDir}/test_gen.py`]: "g" }));
    expect(docker.builds()).toHaveLength(1);
    await open(write(join(tmp(), "three"), { ...code, "app/a.py": "newer" }));
    expect(docker.builds()).toHaveLength(2);
  } finally {
    Object.assign(sandboxOptions, saved);
  }
});

test("files only the image's copy holds: those the output names first, then those beside the code", () => {
  const snap = write(tmp(), { "packages/core/index.js": "i", "packages/core/a.js": "a", "app/tests/gen/t.js": "t" });
  const copies = [{ root: "/opt/app", scope: "", files: ["packages/core/a.js", "packages/core/index.js"] }];
  const image = ["/opt/app/packages/core/index.js", "/opt/app/packages/core/a.js", "/opt/app/packages/core/z.bin",
    "/opt/app/packages/core/default.db", "/opt/app/dist/bundle.js", "/opt/app/dist/named.js", "/opt/other/x.db",
    "/opt/app/app/tests/gen/old.js"];
  const output = "Error: ENOENT: open '/src/packages/core/default.db'\nat dist/named.js:1 (not dist/bundle.jsx)";
  expect(onlyInCopies(copies, image, snap, output, "app/tests/gen")).toEqual(["dist/named.js",
    "packages/core/default.db", "packages/core/z.bin"]);
});

test("a session on an image holding a copy of the code can say what only that copy holds", async () => {
  const saved = sandboxOptions.docker;
  try {
    const cfg = parseReviewConfig(BAKED);
    const snap = write(tmp(), { "app/requirements.txt": `# ${Date.now()}\n`, "app/a.py": "A", "app/b.py": "B",
      "app/c.py": "C" });
    const dir = tmp();
    // The image's copy matches the code (no rebuild) and also holds the database its install made.
    writeFileSync(join(dir, "docker"), `#!/bin/sh
case "$1" in
  info) echo 27;;
  image) [ "$3" = 'arnx-env:${envKey(cfg, snap)}' ] || exit 1;;
  run) case "$*" in
    *sha256sum*) cat > /dev/null; for f in A B C; do l=$(echo $f | tr A-C a-c);
      echo "$(printf $f | sha256sum | cut -d' ' -f1)  /opt/app/$l.py"; done;;
    *) printf '/opt/app/a.py\n/opt/app/b.py\n/opt/app/c.py\n/opt/app/data/gen.db\n/opt/app/x.db\n';;
  esac;;
esac
exit 0
`);
    chmodSync(join(dir, "docker"), 0o755);
    sandboxOptions.docker = join(dir, "docker");
    mkdirSync(join(snap, "app", "data"));
    const said = await dockerSession(cfg, snap, join(tmp(), "build.log"),
      async (s) => s.copies?.("Error: ENOENT: no such file or directory, open '/src/app/data/gen.db'"));
    expect(said).toEqual({ roots: ["/opt/app"], files: ["app/data/gen.db", "app/x.db"] });
  } finally {
    sandboxOptions.docker = saved;
  }
});

const INSTALLED = `
version: 1
image: python:3.12-slim
workdir: app
install: ["pip install ."]
test_command: python -m pytest -q {targets}
env:
  APP_MODE: test
`;

test("the project's package name: pyproject's [project] name, else setup.cfg's [metadata] name, - as _", () => {
  const cfg = parseReviewConfig(INSTALLED);
  let n = 0;
  const dir = (files: Record<string, string>) => write(join(tmp(), `s${n++}`), files);
  expect(packageName(cfg, dir({ "app/pyproject.toml": '[project]\nname = "my-app"\nversion = "1"\n' })))
    .toBe("my_app");
  expect(packageName(cfg, dir({ "app/setup.cfg": "[metadata]\nname = old-app\n\n[options]\nname = x\n" })))
    .toBe("old_app");
  // A pyproject without [project] name (poetry, a tool's config only) falls back to setup.cfg; neither: none.
  expect(packageName(cfg, dir({ "app/pyproject.toml": "[tool.pytest.ini_options]\n",
    "app/setup.cfg": "[metadata]\nname = cfg-app\n" }))).toBe("cfg_app");
  expect(packageName(cfg, dir({ "app/pyproject.toml": "not toml [" }))).toBeNull();
  expect(packageName(cfg, dir({ "app/a.py": "" }))).toBeNull();
});

const randomName = () => Math.random().toString(36).slice(2);

/** A docker whose image holds the environment, answers the package probe with `origin` (exit `status`), hashes
 * `hashed` (image path → contents) and builds by adding the tag; every run's arguments are logged. */
function probeDocker(image: string, origin: string, hashed: Record<string, string>, status = 0)
  : { builds: () => number; runs: () => string[] } {
  const dir = join(tmp(), `docker-${randomName()}`);
  mkdirSync(dir);
  writeFileSync(join(dir, "images"), `${image}\n`);
  writeFileSync(join(dir, "hashes"), Object.entries(hashed).map(([p, text]) => `${sha(text)}  ${p}\n`).join(""));
  writeFileSync(join(dir, "docker"), `#!/bin/sh
case "$1" in
  info) echo 27;;
  image) grep -qxF "$3" '${join(dir, "images")}' || exit 1;;
  build) echo "$3" >> '${join(dir, "images")}'; echo b >> '${join(dir, "builds")}';;
  run) echo "$*" | tr '\\n' ' ' >> '${join(dir, "runs")}'; echo >> '${join(dir, "runs")}'; case "$*" in
    *arnx-package*) echo 'arnx-package: ${origin}'; exit ${status};;
    *sha256sum*) cat > /dev/null; cat '${join(dir, "hashes")}';;
  esac;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  const lines = (f: string) => existsSync(join(dir, f)) ? readFileSync(join(dir, f), "utf8").trim().split("\n") : [];
  return { builds: () => lines("builds").length, runs: () => lines("runs") };
}

describe("the project's package installed outside /src", () => {
  const SITE = "/usr/local/lib/python3.12/site-packages";
  const code = () => ({ "app/pyproject.toml": `[project]\nname = "my-app"\n# ${Date.now()}${Math.random()}\n`,
    "app/src/my_app/__init__.py": "", "app/src/my_app/core.py": "NEW = 1\n", "app/src/my_app/data.json": "{}",
    "app/tests/test_core.py": "def test_x(): pass\n" });
  const open = async (origin: string, hashed: Record<string, string>, status = 0) => {
    const saved = { docker: sandboxOptions.docker, buildkit: sandboxOptions.buildkit, log: dockerSteps.log };
    const logs: Record<string, unknown>[] = [];
    try {
      sandboxOptions.buildkit = false;
      dockerSteps.log = (l) => logs.push(l);
      const cfg = parseReviewConfig(INSTALLED);
      const snap = write(join(tmp(), `snap-${randomName()}`), code());
      const docker = probeDocker(`arnx-env:${envKey(cfg, snap)}`, origin, hashed, status);
      await dockerSession(cfg, snap, join(tmp(), "build.log"), async () => null);
      return { builds: docker.builds(), runs: docker.runs(), snap, probe: logs.filter((l) => l.step === "package") };
    } finally {
      Object.assign(sandboxOptions, { docker: saved.docker, buildkit: saved.buildkit });
      dockerSteps.log = saved.log;
    }
  };

  test("an older copy in site-packages that the project's Python imports: an image made from this code", async () => {
    const r = await open(`${SITE}/my_app/__init__.py`, { [`${SITE}/my_app/__init__.py`]: "",
      [`${SITE}/my_app/core.py`]: "OLD = 1\n" });
    expect(r.builds).toBe(1);
    // The probe runs as a test run does: the code under test at /src, the project's folder, its env, no network.
    const probe = r.runs.find((l) => l.includes("arnx-package"))!;
    expect(probe).toContain("--network none");
    expect(probe).toContain(`-v ${r.snap}:/src -w /src/app`);
    expect(probe).toContain("APP_MODE=test");
    expect(probe).toContain("my_app");
    expect(r.runs.filter((l) => l.includes("arnx-package"))).toHaveLength(1);
    expect(r.probe).toEqual([expect.objectContaining({ project: "main", package: "my_app",
      origin: `${SITE}/my_app/__init__.py`, copy: `${SITE}/my_app`, differ: 1 })]);
  });

  test("a copy that matches the code, or a package imported from /src, builds nothing", async () => {
    const same = await open(`${SITE}/my_app/__init__.py`, { [`${SITE}/my_app/__init__.py`]: "",
      [`${SITE}/my_app/core.py`]: "NEW = 1\n" });
    expect(same.builds).toBe(0);
    expect(same.probe[0]).toMatchObject({ copy: `${SITE}/my_app`, differ: 0 });
    const mounted = await open("/src/app/src/my_app/__init__.py", {});
    expect(mounted.builds).toBe(0);
    expect(mounted.probe[0]).toMatchObject({ origin: "/src/app/src/my_app/__init__.py", copy: null });
    expect(mounted.runs.filter((l) => l.includes("sha256sum"))).toEqual([]);
  });

  test("an editable install of a copy outside /src counts too; a probe that fails or finds nothing changes nothing",
    async () => {
      const editable = await open("/opt/app/src/my_app/__init__.py", { "/opt/app/src/my_app/core.py": "OLD = 1\n" });
      expect(editable.builds).toBe(1);
      expect(editable.probe[0]).toMatchObject({ copy: "/opt/app/src/my_app", differ: 1 });
      const failed = await open(`${SITE}/my_app/__init__.py`, { [`${SITE}/my_app/core.py`]: "OLD = 1\n" }, 1);
      expect(failed.builds).toBe(0);
      expect(failed.probe[0]).toMatchObject({ origin: null, copy: null });
      const none = await open("", {});
      expect(none.builds).toBe(0);
      expect(none.probe[0]).toMatchObject({ origin: null, copy: null });
    });
});

// ---- Docker integration: real containers. Run with ARNX_DOCKER_TESTS=1. ----

describe.skipIf(!process.env.ARNX_DOCKER_TESTS)("docker: code baked into the image", () => {
  // Each test gets its own image: a manifest no other test has keys it.
  let image = 0;
  const code = (value: number) => ({ "app/requirements.txt": `# ${image}\n`, "app/a.py": `VALUE = ${value}\n`,
    "app/b.py": "B = 1\n", "app/c.py": "C = 1\n" });
  const read = (snap: string, envFrom?: string, fill?: () => void, config = BAKED, file = "/opt/app/a.py") =>
    dockerSession(parseReviewConfig(config), snap, join(tmp(), "build.log"), async (s) => {
      fill?.();
      return s.run(`cat ${file}`, 60).output.trim();
    }, envFrom);

  test("a copy older than the code is built again for it; a copy that matches is used as it is", async () => {
    const said: string[] = [];
    const saved = dockerSteps.say;
    dockerSteps.say = (m) => said.push(m);
    try {
      const v = image = Date.now();
      expect(await read(write(join(tmp(), "one"), code(v)))).toBe(`VALUE = ${v}`);
      expect(said.filter((m) => m.includes("older copy"))).toEqual([]);
      const two = write(join(tmp(), "two"), code(v + 1));
      expect(await read(two)).toBe(`VALUE = ${v + 1}`);
      expect(said.filter((m) => m.includes("older copy"))).toEqual(
        ["main: the test image holds an older copy of the code (/opt/app); using one made from this code"]);
      // Its build cache records are found from its marked step (read only: nothing is pruned here).
      const cfg = parseReviewConfig(BAKED);
      const tag = `arnx-env:${bakedKey(envKey(cfg, two), cfg, [{ root: "/opt/app", scope: "app", files: [] }], two)}`;
      if (sandboxOptions.buildkit) {
        const found = sourceRecords(cacheRecords(), [tag]).map((r) => r.description);
        expect(found.some((d) => d.endsWith(`/bin/sh -c : ${tag}`))).toBe(true);
        expect(found.some((d) => d.includes("cp -r . /opt/app"))).toBe(true);
      }
    } finally {
      dockerSteps.say = saved;
    }
  }, 600_000);

  test("code copied in after the session starts is refused when the image's copy differs", async () => {
    const v = image = Date.now();
    const head = write(join(tmp(), "head"), code(v));
    expect(await read(head)).toBe(`VALUE = ${v}`);
    const before = join(tmp(), "before");
    const fill = (value: number) => () => {
      cpSync(write(join(tmp(), `src-${value}`), code(value)), before, { recursive: true });
    };
    await expect(read(before, head, fill(v - 1))).rejects.toThrow(
      "main: the tests run the image's own copy of the code at /opt/app, which differs from this code in 1 file");
    const same = join(tmp(), "same");
    expect(await dockerSession(parseReviewConfig(BAKED), same, join(tmp(), "build.log"), async (s) => {
      cpSync(head, same, { recursive: true });
      return s.run("cat /opt/app/a.py", 60).output.trim();
    }, head)).toBe(`VALUE = ${v}`);
  }, 600_000);

  test("a copy the runs do not reach is left alone", async () => {
    const said: string[] = [];
    const saved = dockerSteps.say;
    dockerSteps.say = (m) => said.push(m);
    try {
      const unused = BAKED.replace("cd /opt/app && ", "");
      const v = image = Date.now();
      const head = write(join(tmp(), "head"), code(v));
      expect(await read(head, undefined, undefined, unused, "/src/app/a.py")).toBe(`VALUE = ${v}`);
      expect(await read(write(join(tmp(), "next"), code(v + 1)), undefined, undefined, unused, "/src/app/a.py"))
        .toBe(`VALUE = ${v + 1}`);
      const before = join(tmp(), "before");
      const fill = () => cpSync(write(join(tmp(), "old"), code(v - 1)), before, { recursive: true });
      expect(await read(before, head, fill, unused, "/src/app/a.py")).toBe(`VALUE = ${v - 1}`);
      expect(said.filter((m) => m.includes("older copy"))).toEqual([]);
    } finally {
      dockerSteps.say = saved;
    }
  }, 600_000);
});
