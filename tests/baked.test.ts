import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bakedKey, commandPaths, differing, findCopies, reached, scopeFiles } from "../src/baked";
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
