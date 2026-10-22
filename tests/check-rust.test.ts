// check on a Rust crate: accept keeps tests in tests/ as arnx_<tag>_<name>.rs (cargo builds only tests/*.rs), and
// check must find and run exactly those, not the crate's own tests nor a generated file left behind.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { rust } from "../src/adapters/rust";
import { check } from "../src/check";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import type { SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { isKeptPath } from "../src/testround";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-12T00:00:00Z" };
const CONFIG = `version: 1
projects:
  calc:
    root: calc
    language: rust
    runner: nextest
    image: rust:1-bookworm
    test_command: cargo nextest run {targets}
`;
// The names accept gives (the same function accept calls).
const KEPT = posix.join("calc", rust.acceptedPath("arnx_generated_add.rs", "20261022_30b1fe", "tests/arnx", "add"));
const KEPT_REVIEW = posix.join("calc", rust.acceptedPath("arnx_generated_r.rs", "20261022_30b1fe", "tests/arnx",
  "r20261022_30b1fe"));

test("check finds the tests accept kept in a Rust crate and runs only them", async () => {
  expect(KEPT).toBe("calc/tests/arnx_20261022_30b1fe_add.rs");
  expect(KEPT_REVIEW).toBe("calc/tests/arnx_20261022_30b1fe.rs");
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "calc/src"), { recursive: true });
  mkdirSync(join(repo, "calc/tests/common"), { recursive: true });
  writeFileSync(join(repo, "calc/Cargo.toml"), "[package]\nname = \"calc\"\nversion = \"0.1.0\"\n");
  writeFileSync(join(repo, "calc/src/lib.rs"), "pub fn add(a: i32, b: i32) -> i32 { a + b }\n");
  for (const f of [KEPT, KEPT_REVIEW]) writeFileSync(join(repo, f), "#[test]\nfn t() {}\n");
  writeFileSync(join(repo, "calc/tests/integration.rs"), "#[test]\nfn own() {}\n"); // the crate's own
  writeFileSync(join(repo, "calc/tests/arnx_generated_left.rs"), "#[test]\nfn g() {}\n"); // a round's leftover
  writeFileSync(join(repo, "calc/tests/common/arnx_helper.rs"), "pub fn h() {}\n"); // not built by cargo
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(CONFIG), "Dev", "2026-10-12"));
  commit(repo, "layout");
  const seen: string[] = [];
  const session: SessionFactory = async (_c, snap, _l, body) => {
    const s = new FakeSession(snap, () => [junitXml([["tests/arnx_20261022_30b1fe_add.rs", "t", "passed", ""],
      ["tests/arnx_20261022_30b1fe.rs", "t", "passed", ""]]), "2 passed", false]);
    const r = await body(s);
    seen.push(...s.commands);
    return r;
  };
  const results = await check(repo, SETTINGS, { sessionFactory: session });
  expect(results.map((r) => [r.project, r.files])).toEqual([["calc", [KEPT_REVIEW, KEPT]]]);
  expect(seen.join(" ")).not.toContain("integration");
  expect(seen.join(" ")).not.toContain("arnx_generated_left");
});

test("setup counts a Rust crate's kept tests as accepted, not its own tests or generated files", () => {
  const cfg = parseReviewFile(CONFIG).projects[0]!;
  expect(isKeptPath(cfg, KEPT)).toBe(true);
  expect(isKeptPath(cfg, KEPT_REVIEW)).toBe(true);
  expect(isKeptPath(cfg, "calc/tests/integration.rs")).toBe(false);
  expect(isKeptPath(cfg, "calc/tests/arnx_generated_add.rs")).toBe(false);
  expect(isKeptPath(cfg, "calc/tests/common/arnx_20261022_30b1fe_add.rs")).toBe(false);
  expect(isKeptPath(cfg, "other/tests/arnx_20261022_30b1fe_add.rs")).toBe(false);
});
