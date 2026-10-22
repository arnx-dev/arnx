// The Rust adapter: cargo-nextest, because cargo test's own machine-readable output is nightly-only; nextest writes
// JUnit. Generated tests are integration tests (tests/arnx_generated_<name>.rs in the crate): they see the crate's
// public API only, since arnx never edits src/. The project's own tests inside src/ (#[cfg(test)] modules) are
// reported by the source file that holds them and can be targets: a file runs the tests of its module.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { shQuote } from "../util";
import { junitCases } from "./junit";
import type { Adapter, TestResult, Words } from "./types";

const GENERATED = /^arnx_generated_[a-z0-9_]+\.rs$/;
// What accept keeps: arnx_<tag>_<name>.rs in tests/, never a generated file.
const KEPT = /^arnx_(?!generated_)[a-z0-9_]+\.rs$/;
const CONFIG = "/src/.arnx-run/nextest.toml";
// nextest keeps its store (and so the JUnit file) under the workspace's target/nextest, whatever CARGO_TARGET_DIR is;
// an absolute store directory puts the report at a known place.
const PROFILE = `[store]
dir = "/src/.arnx-run/nextest"

[profile.arnx]
fail-fast = false

[profile.arnx.junit]
path = "junit.xml"
`;

/** `a/b.rs` and `a/b/mod.rs` hold module `a::b`. */
const modulePath = (rel: string) => rel.replace(/\.rs$/, "").replace(/\/mod$/, "").split("/").join("::");

/** One target's nextest filter: a src/ file runs its module's tests (the crate root, a binary's root: all of them);
 * any other file is an integration-test binary named after it. */
function filterOf(target: string): string {
  if (!target.startsWith("src/")) return `(kind(test) & binary(${posix.basename(target, ".rs")}))`;
  const rel = target.slice(4);
  if (rel === "lib.rs") return "kind(lib)";
  if (rel === "main.rs") return "kind(bin)";
  const bin = /^bin\/([^/]+?)(?:\.rs|\/(.+))$/.exec(rel);
  if (bin) {
    const inner = bin[2] && bin[2] !== "main.rs" ? ` & test(/^${modulePath(bin[2])}::/)` : "";
    return `(kind(bin) & binary(${bin[1]})${inner})`;
  }
  return `((kind(lib) | kind(bin)) & test(/^${modulePath(rel)}::/))`;
}

/** Integration-test binaries are named after their file: `tests/<stem>.rs` becomes `--test <stem>`. With a source
 * file among the targets, every target becomes one filterset. A directory target means every test. */
function targetFlags(targets: string[]): string {
  const files = targets.filter((t) => t.endsWith(".rs"));
  if (files.some((t) => t.startsWith("src/"))) return `-E ${shQuote(files.map(filterOf).join(" | "))}`;
  return files.map((t) => `--test ${shQuote(posix.basename(t, ".rs"))}`).join(" ");
}

/** The source file of a test inside a library or binary: the deepest file its module path names, else the target's
 * root file; "" when the files cannot be seen (or the target lives elsewhere). */
function sourceFile(pkg: string, bin: string | null, name: string, exists: (rel: string) => boolean): string {
  const roots = bin === null ? ["src/lib.rs"]
    : [`src/bin/${bin}.rs`, `src/bin/${bin}/main.rs`, ...(bin === pkg ? ["src/main.rs"] : [])];
  const root = roots.find(exists);
  if (!root) return "";
  const base = root.startsWith("src/bin/") ? `src/bin/${bin}` : "src";
  const mods = name.split("::").slice(0, -1);
  for (let k = mods.length; k > 0; k--) {
    const dir = `${base}/${mods.slice(0, k).join("/")}`;
    const hit = [`${dir}.rs`, `${dir}/mod.rs`].find(exists);
    if (hit) return hit;
  }
  return root;
}

function parseNextest(text: string, exists: (rel: string) => boolean): TestResult[] | null {
  const cases = junitCases(text);
  if (cases === null) return null;
  return cases.map(({ attrs, suites, outcome, message }) => {
    const binary = attrs.classname ?? suites.at(-1)?.name ?? "";
    const name = attrs.name ?? "";
    const at = binary.indexOf("::");
    const [pkg, kind] = at < 0 ? [binary, ""] : [binary.slice(0, at), binary.slice(at + 2)];
    // A library's binary id is the package; a binary's is <package>::bin/<name>; a tests/ file's <package>::<stem>.
    if (kind && !kind.startsWith("bin/")) {
      const fileAttr = `tests/${kind}.rs`;
      return { testId: `${fileAttr}::${name}`, fileAttr, name, outcome, message };
    }
    const fileAttr = sourceFile(pkg, kind ? kind.slice(4) : null, name, exists);
    return { testId: `${binary}::${name}`, fileAttr, name, outcome, message };
  });
}

const rustString = (s: string) => `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;

/** `#[ignore = "<reason>"]` above the attribute stack of each named test function. */
function skip(source: string, names: Set<string>, reason: string): string {
  if (!names.size) return source;
  const lines = source.split(/(?<=\n)/);
  const inserts: [number, string][] = [];
  lines.forEach((line, i) => {
    const m = /^(\s*)(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/.exec(line);
    if (!m || !names.has(m[2]!)) return;
    let first = i;
    for (let k = i - 1; k >= 0 && /^\s*#\[/.test(lines[k]!); k--) first = k;
    inserts.push([first, `${m[1]}#[ignore = ${rustString(reason)}]\n`]);
  });
  for (const [at, text] of inserts.sort((a, b) => b[0] - a[0])) lines.splice(at, 0, text);
  return lines.join("");
}

export const rust: Adapter = {
  id: "rust",
  runners: ["nextest"],
  defaultRunner: "nextest",
  words: (): Words => ({
    language: "Rust",
    runner: "cargo-nextest",
    testFiles: "tests/arnx_generated_<name>.rs (integration tests: the crate's public API only)",
    writableFiles: "tests/arnx_generated_<name>.rs",
    propertyLib: "proptest",
    imageExample: "rust:1-bookworm",
    installExample: "curl -LsSf https://get.nexte.st/latest/linux | tar zxf - -C /usr/local/cargo/bin && cargo nextest run --no-run",
    commandExample: "cargo nextest run {targets}",
  }),
  defaultTestsDir: "tests",
  writable: GENERATED,
  probes: () => [{ file: "arnx_generated_probe.rs", source: "#[test]\nfn arnx_probe() {}\n" }],
  isTestFile: (name) => GENERATED.test(name),
  isSupportFile: () => false,
  validateCommand: (command) =>
    typeof command === "string" && command.includes("cargo nextest run") && command.includes("{targets}")
      ? [] : ["test_command: must run cargo nextest run and contain {targets}"],
  reportSetup: (snapshot) => {
    mkdirSync(join(snapshot, ".arnx-run"), { recursive: true });
    writeFileSync(join(snapshot, ".arnx-run", "nextest.toml"), PROFILE);
  },
  command: (testCommand, targets, reportPath) =>
    `${testCommand.replaceAll("{targets}", targetFlags(targets))} --config-file ${CONFIG} --profile arnx; s=$?; ` +
    `cp /src/.arnx-run/nextest/arnx/junit.xml ${shQuote(reportPath)} 2>/dev/null; exit $s`,
  parseReport: (text, _runner, _root, exists = () => false) => parseNextest(text, exists),
  skip,
  // Cargo builds only tests/*.rs as integration tests, so no folder: the review id is the prefix (a file named after
  // the review, r<tag>, is that prefix alone).
  acceptedPath: (_original, tag, _acceptedDir, name) => posix.join("tests",
    `arnx_${tag}${name === `r${tag}` ? "" : `_${name.startsWith(`r${tag}_`) ? name.slice(tag.length + 2) : name}`}.rs`),
  kept: { dirs: ["tests"], name: KEPT },
  testStem: (fileName) => fileName.replace(/^arnx_generated_/, "").replace(/\.rs$/, ""),
  relocate: (source) => source,
  setupHints: [
    "- A Rust project is one crate (a directory with a [package] Cargo.toml); generated tests go to that crate's tests/.",
    "- In a Cargo workspace, propose one project per member crate that has tests (root: the member's directory); " +
      "give them install_root: . (the workspace root) and the same image and install, ending in cargo nextest run " +
      "--workspace --no-run, so one image holds every member's test build.",
    "- Use a rust:<version> image matching rust-toolchain or rust-version; install cargo-nextest from the prebuilt " +
      "binary (curl -LsSf https://get.nexte.st/latest/linux | tar zxf - -C /usr/local/cargo/bin).",
    "- End install with cargo nextest run --no-run so the test build is in the image; set runner: nextest and " +
      "test_command: cargo nextest run {targets}.",
    "- Tests inside src/ (#[cfg(test)] modules) are reported by the source file that holds them (src/net/http.rs, " +
      "src/lib.rs for the crate root): when one fails for a reason outside the code, list that file under " +
      "known_failing with the reason in notes; do not exclude tests with -E in test_command.",
  ].join("\n"),
  manifests: ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"],
  // Test runs mount the snapshot over /src, so builds go to a target directory outside it (reused across runs), and
  // the test user (not root) must be able to write there and to cargo's home.
  buildEnv: ["CARGO_TERM_COLOR=never", "CARGO_TARGET_DIR=/opt/arnx-target"],
  runEnv: ["CARGO_TERM_COLOR=never", "CARGO_TARGET_DIR=/opt/arnx-target"],
  postInstall: ["mkdir -p /opt/arnx-target && chmod -R a+rwX /opt/arnx-target /usr/local/cargo"],
};
