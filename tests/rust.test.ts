import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../src/adapters";
import { parseReviewFile } from "../src/config";
import { runTests } from "../src/outcomes";
import { dockerfile } from "../src/sandbox";
import { useTmp } from "./helpers/tmp";

const rust = getAdapter("rust");
const tmp = useTmp();
const R = "/src/.arnx-run/r.xml";

test("nextest command: files become --test flags, the report is copied out", () => {
  expect(rust.runners).toEqual(["nextest"]);
  const cmd = rust.command("cargo nextest run {targets}", ["tests/arnx_generated_calc.rs", "tests/arnx_generated_b.rs"], R,
    "nextest");
  expect(cmd.startsWith("cargo nextest run --test arnx_generated_calc --test arnx_generated_b " +
    "--config-file /src/.arnx-run/nextest.toml --profile arnx; s=$?;")).toBe(true);
  expect(cmd).toContain("cp /src/.arnx-run/nextest/arnx/junit.xml");
  expect(cmd).not.toContain("cargo metadata");
  expect(cmd).toContain(`${R}`);
  expect(cmd.endsWith("exit $s")).toBe(true);
  expect(rust.command("cargo nextest run {targets}", ["tests"], R, "nextest").startsWith("cargo nextest run  --config-file"))
    .toBe(true);
});

test("validate the command", () => {
  expect(rust.validateCommand("cargo nextest run {targets}", "nextest")).toEqual([]);
  expect(rust.validateCommand("cargo test {targets}", "nextest")[0]).toContain("cargo nextest run");
});

test("reportSetup writes the nextest profile", () => {
  rust.reportSetup!(tmp(), "nextest");
  const toml = readFileSync(join(tmp(), ".arnx-run", "nextest.toml"), "utf8");
  expect(toml).toContain("[profile.arnx.junit]");
  expect(toml).toContain('path = "junit.xml"');
  expect(toml).toContain('[store]\ndir = "/src/.arnx-run/nextest"');
});

test("nextest JUnit maps binary ids back to test files", () => {
  const xml = `<testsuites name="nextest-run"><testsuite name="my-crate::arnx_generated_calc"><testcase name="adds" classname="my-crate::arnx_generated_calc"><failure message="test failure">assertion failed</failure></testcase><testcase name="subs" classname="my-crate::arnx_generated_calc"/></testsuite><testsuite name="my-crate"><testcase name="tests::unit" classname="my-crate"/></testsuite></testsuites>`;
  const r = rust.parseReport(xml, "nextest", ".")!;
  expect(r.map((t) => [t.testId, t.fileAttr, t.outcome])).toEqual([
    ["tests/arnx_generated_calc.rs::adds", "tests/arnx_generated_calc.rs", "failed"],
    ["tests/arnx_generated_calc.rs::subs", "tests/arnx_generated_calc.rs", "passed"],
    ["my-crate::tests::unit", "", "passed"]]);
});

test("files, skip marker and accepted paths", () => {
  expect(rust.writable.test("arnx_generated_calc.rs") && !rust.writable.test("integration.rs")).toBe(true);
  expect(rust.defaultTestsDir).toBe("tests");
  const src = [
    "use calc::add;", "",
    "#[test]", "fn adds() {", "    assert_eq!(add(1, 2), 3);", "}", "",
    "#[tokio::test]", "#[should_panic]", "async fn panics() {}", "",
    "#[test]", "fn keeps() {}", ""].join("\n");
  expect(rust.skip(src, new Set(["adds", "panics"]), 'arnx: "not" confirmed')).toBe([
    "use calc::add;", "",
    '#[ignore = "arnx: \\"not\\" confirmed"]', "#[test]", "fn adds() {", "    assert_eq!(add(1, 2), 3);", "}", "",
    '#[ignore = "arnx: \\"not\\" confirmed"]', "#[tokio::test]", "#[should_panic]", "async fn panics() {}", "",
    "#[test]", "fn keeps() {}", ""].join("\n"));
  expect(rust.acceptedPath("arnx_generated_calc.rs", "20261012_ab", "tests/arnx", "overflow_on_add"))
    .toBe("tests/arnx_20261012_ab_overflow_on_add.rs");
  // Named after the review: the prefix already says which.
  expect(rust.acceptedPath("arnx_generated_calc.rs", "20261012_ab", "tests/arnx", "r20261012_ab"))
    .toBe("tests/arnx_20261012_ab.rs");
  expect(rust.acceptedPath("arnx_generated_calc.rs", "20261012_ab", "tests/arnx", "r20261012_ab_2"))
    .toBe("tests/arnx_20261012_ab_2.rs");
  expect(rust.testStem("arnx_generated_calc.rs")).toBe("calc");
  expect(rust.relocate("x", "a", "b")).toBe("x");
});

test("rust images build outside /src and stay writable for the non-root test user", () => {
  const cfg = parseReviewFile(`version: 1
projects:
  calc:
    root: .
    language: rust
    image: rust:1-bookworm
    install: [cargo fetch]
    test_command: cargo nextest run {targets}
`).projects[0]!;
  const df = dockerfile(cfg);
  expect(df).toContain("ENV CARGO_TERM_COLOR=never CARGO_TARGET_DIR=/opt/arnx-target");
  expect(df.trim().split("\n").at(-1)).toBe("RUN mkdir -p /opt/arnx-target && chmod -R a+rwX /opt/arnx-target /usr/local/cargo");
  expect(rust.runEnv).toContain("CARGO_TARGET_DIR=/opt/arnx-target");
});

// A real cargo-nextest 0.9 report (tests/fixtures/rust-inline) of a crate with tests in the library (crate root,
// an inline module, a mod.rs and a nested file), in the main binary, in a src/bin binary and in tests/.
const CRATE = ["Cargo.toml", "src/lib.rs", "src/main.rs", "src/net/mod.rs", "src/net/http.rs", "src/bin/tool.rs",
  "tests/integ.rs"];
const INLINE = readFileSync(join(import.meta.dir, "fixtures", "rust-inline", "junit.xml"), "utf8");

test("tests inside source files are reported by the file that holds them; their ids do not change", () => {
  const r = rust.parseReport(INLINE, "nextest", ".", (p) => CRATE.includes(p))!;
  expect(r.map((t) => [t.testId, t.fileAttr, t.outcome])).toEqual([
    ["my-crate::util::tests::inline_mod", "src/lib.rs", "passed"], // an inline module of lib.rs
    ["my-crate::tests::root_test", "src/lib.rs", "passed"],
    ["my-crate::net::net_tests::in_mod_rs", "src/net/mod.rs", "passed"],
    ["my-crate::net::http::tests::deep", "src/net/http.rs", "passed"],
    ["my-crate::tests::root_fail", "src/lib.rs", "failed"],
    ["my-crate::bin/my-crate::tests::main_bin", "src/main.rs", "passed"],
    ["tests/integ.rs::integ", "tests/integ.rs", "passed"],
    ["my-crate::bin/tool::tests::tool_bin", "src/bin/tool.rs", "passed"]]);
  // Without a look at the files (or a library at a custom path), nothing is guessed.
  expect(rust.parseReport(INLINE, "nextest", ".")!.filter((t) => t.fileAttr).map((t) => t.fileAttr))
    .toEqual(["tests/integ.rs"]);
  expect(rust.parseReport(INLINE, "nextest", ".", (p) => p === "src/bin/tool/main.rs")!.at(-1)!.fileAttr)
    .toBe("src/bin/tool/main.rs");
});

test("a source file as a target runs the tests of its module; integration targets alone keep --test", () => {
  const cmd = (targets: string[]) => rust.command("cargo nextest run {targets}", targets, R, "nextest")
    .split(" --config-file")[0];
  expect(cmd(["tests/integ.rs"])).toBe("cargo nextest run --test integ");
  expect(cmd(["src/net/http.rs", "tests/integ.rs", "src/net/mod.rs", "src/lib.rs", "src/main.rs", "src/bin/tool.rs",
    "src/bin/tool/args.rs"])).toBe("cargo nextest run -E '" + [
    "((kind(lib) | kind(bin)) & test(/^net::http::/))", "(kind(test) & binary(integ))",
    "((kind(lib) | kind(bin)) & test(/^net::/))", "kind(lib)", "kind(bin)", "(kind(bin) & binary(tool))",
    "(kind(bin) & binary(tool) & test(/^args::/))"].join(" | ") + "'");
});

test("runTests lets the report see the project's files, so inline tests name their file", () => {
  const snap = tmp();
  for (const p of CRATE) {
    mkdirSync(join(snap, "crates", "my", p, ".."), { recursive: true });
    writeFileSync(join(snap, "crates", "my", p), "");
  }
  const runner = { run: (command: string) => {
    const to = /cp \S+ '?\/src\/([^' ]+)'? 2>/.exec(command)![1]!;
    writeFileSync(join(snap, to), INLINE);
    return { exitCode: 1, output: "", timedOut: false, seconds: 1 };
  } };
  const cfg = parseReviewFile(`version: 1
projects:
  my:
    root: crates/my
    language: rust
    image: rust:1-bookworm
    test_command: cargo nextest run {targets}
`).projects[0]!;
  const [, results] = runTests(runner, snap, cfg, [], "suite.xml", 60);
  expect(results!.find((t) => t.outcome === "failed")!.fileAttr).toBe("src/lib.rs");
});
