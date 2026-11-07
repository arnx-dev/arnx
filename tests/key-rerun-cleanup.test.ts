// When the copy a real-key rerun used cannot be removed: what puts its fakes back never writes through a link the test made,
// and what it says promises nothing. Removal is made to fail here; keys are generated at run time.
import { expect, mock, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import * as safefs from "../src/safefs";

const real = { ...safefs };
let failRemoval = false;
mock.module("../src/safefs", () => ({ ...real, removeTree: (dir: string) => failRemoval ? false : real.removeTree(dir) }));

const { parseReviewConfig } = await import("../src/config");
const { takeSnapshot } = await import("../src/change");
const { keyReruns, rerunWithRealKeys } = await import("../src/realkey");
const { realKeyCopies } = await import("../src/sandbox");
const { commit, gitRepo } = await import("./helpers/gitutil");
const { junitXml } = await import("./helpers/junit");
const { useTmp } = await import("./helpers/tmp");

const tmp = useTmp();
const pem = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const PEM_PATH = "tests/data/server.pem", GEN = "tests/arnx_generated/test_key.py";

test("a copy that cannot be removed: a folder link the test made is not followed, and the line promises no fakes", async () => {
  const repo = gitRepo(mkdtempSync(join(tmp(), "r-")));
  mkdirSync(join(repo, "tests/data"), { recursive: true });
  writeFileSync(join(repo, PEM_PATH), pem);
  commit(repo, "key");
  const root = mkdtempSync(join(tmp(), "arnx-"));
  const snap = join(root, "repo");
  takeSnapshot(repo, null, snap, [], {});
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "server.pem"), "OUTSIDE");
  let copy = "";
  const runner = { run: () => ({ exitCode: 0, output: "", timedOut: false, seconds: 0 }), sealed: (command: string, _t: number, src: string) => {
    copy = src;
    // The test moves the folder holding the key and leaves a link out in its place.
    renameSync(join(src, "tests/data"), join(src, "moved"));
    symlinkSync("../../outside", join(src, "tests/data"));
    const m = /--junitxml=\/src\/(\S+)/.exec(command)!;
    mkdirSync(dirname(join(src, m[1]!)), { recursive: true });
    writeFileSync(join(src, m[1]!), junitXml([[GEN, "test_add", "passed", ""]]));
    failRemoval = true;
    return { exitCode: 0, timedOut: false };
  } };
  const said: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((t: string) => { said.push(String(t)); return true; }) as typeof process.stderr.write;
  const failing = { testId: `${GEN}::test_add`, fileAttr: GEN, name: "test_add", outcome: "failed", message: "x" };
  try {
    await rerunWithRealKeys(runner, snap, parseReviewConfig("version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n"),
      { source: { repo, head: null }, fakedKeys: [PEM_PATH], tests: [failing], all: [[failing]], target: () => GEN, budget: keyReruns(), timeout: 5 });
  } finally {
    process.stderr.write = write;
    failRemoval = false;
  }
  expect(readFileSync(join(outside, "server.pem"), "utf8")).toBe("OUTSIDE");
  const line = said.join("");
  expect(line).toContain(copy);
  expect(line).toContain("may still hold a real key");
  expect(line).not.toContain("fakes again");
  expect(line).not.toContain(pem.split("\n")[1]!);
  // The copy stays listed for the exit's sweep; removed here.
  expect(realKeyCopies.has(copy)).toBe(true);
  expect(real.removeTree(copy)).toBe(true);
  realKeyCopies.delete(copy);
  expect(existsSync(copy)).toBe(false);
});
