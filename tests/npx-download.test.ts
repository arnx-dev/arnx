// A JavaScript runner that is not installed where test_command runs: npx tries to download it, the sandbox has no
// network, and the run ends with no report. Setup says which package and why, instead of a bare "no report".
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewConfig } from "../src/config";
import { npxDownload } from "../src/diagnose";
import { runSuite } from "../src/setup";
import { fakeFactory } from "./helpers/fakes";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();
// What `npx vitest run` printed in node:22 with no network (it gave up after about 70 s, exit 1).
const NPX = ["npm error code EAI_AGAIN", "npm error syscall getaddrinfo", "npm error errno EAI_AGAIN",
  "npm error request to https://registry.npmjs.org/vitest failed, reason: getaddrinfo EAI_AGAIN registry.npmjs.org",
  "npm error A complete log of this run can be found in: /root/.npm/_logs/debug-0.log"].join("\n");
const NODE = parseReviewConfig(CFG.replace("image: python:3.12-slim", "image: node:22\nlanguage: typescript")
  .replace("python -m pytest -q {targets}", "npx vitest run {targets}"));

test("the package npx tried to download, scoped ones decoded; none without that line", () => {
  expect(npxDownload(NPX)).toBe("vitest");
  expect(npxDownload("npm error request to https://registry.npmjs.org/@vitest%2fui failed, reason: getaddrinfo " +
    "ENOTFOUND registry.npmjs.org")).toBe("@vitest/ui");
  expect(npxDownload("Error: Cannot find module 'vitest'")).toBeNull();
});

test("a suite that gives no report because npx went to the network says which package is not installed", async () => {
  const snap = tmp();
  mkdirSync(join(snap, NODE.workdir), { recursive: true });
  writeFileSync(join(snap, NODE.workdir, "price.test.ts"), "test('total', () => {});\n");
  const [ok, summary] = await runSuite(NODE, snap, join(tmp(), "b.log"),
    { sessionFactory: fakeFactory(() => [null, NPX, false]) });
  expect(ok).toBe(false);
  expect(summary).toBe("the suite produced no report: `vitest` is not installed where test_command runs it, so npx " +
    "tried to download it (the sandbox has no network). Install it in install, or link install's node_modules into " +
    "the repository, which is mounted over /src");
});
