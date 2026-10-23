import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bakedKey, differing, findCopies, scopeFiles } from "../src/baked";
import { parseReviewConfig } from "../src/config";
import { dockerSteps } from "../src/sandbox";
import { dockerSession } from "../src/testround";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

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

test("the rebuilt image's key follows the code it holds", () => {
  const snap = write(tmp(), { "web/src/a.ts": "1", "web/b.ts": "b", "web/package.json": "{}" });
  const copies = [{ root: "/opt/web", scope: "web", files: ["b.ts", "src/a.ts"] }];
  const first = bakedKey("abc", copies, snap);
  expect(first).toMatch(/^abc-src-[0-9a-f]{12}$/);
  expect(bakedKey("abc", copies, snap)).toBe(first);
  writeFileSync(join(snap, "web/src/a.ts"), "2");
  expect(bakedKey("abc", copies, snap)).not.toBe(first);
});

// ---- Docker integration: real containers. Run with ARNX_DOCKER_TESTS=1. ----

const BAKED = `
version: 1
image: python:3.12-slim
workdir: app
install: ["mkdir -p /opt/app && cp -r . /opt/app"]
test_command: cd /opt/app && python -m pytest -q {targets}
`;

describe.skipIf(!process.env.ARNX_DOCKER_TESTS)("docker: code baked into the image", () => {
  // Each test gets its own image: a manifest no other test has keys it.
  let image = 0;
  const code = (value: number) => ({ "app/requirements.txt": `# ${image}\n`, "app/a.py": `VALUE = ${value}\n`,
    "app/b.py": "B = 1\n", "app/c.py": "C = 1\n" });
  const read = (snap: string, envFrom?: string, fill?: () => void) =>
    dockerSession(parseReviewConfig(BAKED), snap, join(tmp(), "build.log"), async (s) => {
      fill?.();
      return s.run("cat /opt/app/a.py", 60).output.trim();
    }, envFrom);

  test("a copy older than the code is built again for it; a copy that matches is used as it is", async () => {
    const said: string[] = [];
    const saved = dockerSteps.say;
    dockerSteps.say = (m) => said.push(m);
    try {
      const v = image = Date.now();
      expect(await read(write(join(tmp(), "one"), code(v)))).toBe(`VALUE = ${v}`);
      expect(said.filter((m) => m.includes("older copy"))).toEqual([]);
      expect(await read(write(join(tmp(), "two"), code(v + 1)))).toBe(`VALUE = ${v + 1}`);
      expect(said.filter((m) => m.includes("older copy"))).toEqual(
        ["main: the test image holds an older copy of the code (/opt/app); using one made from this code"]);
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
      "main: the test image holds a copy of the code at /opt/app that differs from the code to test in 1 file " +
      "(app/a.py); tests would run that copy");
    const same = join(tmp(), "same");
    expect(await dockerSession(parseReviewConfig(BAKED), same, join(tmp(), "build.log"), async (s) => {
      cpSync(head, same, { recursive: true });
      return s.run("cat /opt/app/a.py", 60).output.trim();
    }, head)).toBe(`VALUE = ${v}`);
  }, 600_000);
});
