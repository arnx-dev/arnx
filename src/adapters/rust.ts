// The Rust adapter: cargo-nextest, because cargo test's own machine-readable output is nightly-only; nextest writes
// JUnit. Generated tests are integration tests (tests/arnx_generated_<name>.rs in the crate): they see the crate's
// public API only, since arnx never edits src/. The project's own tests inside src/ (#[cfg(test)] modules) are
// reported by the source file that holds them and can be targets: a file runs the tests of its module.
import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { endOnce, shQuote } from "../util";
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

// The lock install resolved, for test runs of a repository that commits none: without it an offline run cannot
// resolve, and a fresh resolution may differ from what the image built.
const LOCK = "/opt/arnx-lock/Cargo.lock";
const WORKSPACE = 'ws=$(cargo locate-project --workspace --message-format plain 2>/dev/null); ws=${ws%/Cargo.toml}; ' +
  '[ -n "$ws" ] || ws=.;';
// Runs build what install built: the whole workspace, so features unify the same way and nothing (no build script
// that downloads) runs again. The crate's [package] name keeps the run to its own tests; none means every test.
const PACKAGE = "pkg='all()'; name=$(awk -F'\"' '/^\\[/ { p = ($0 == \"[package]\") } " +
  "p && /^name[ \\t]*=/ { print $2; exit }' Cargo.toml 2>/dev/null); [ -z \"$name\" ] || pkg=\"package(=$name)\";";

/** The crate's tests, or the targets among them: a file becomes one filter each (an integration test its binary). A
 * directory target means every test. `$pkg` is PACKAGE's filter. */
function targetFlags(targets: string[]): string {
  const files = targets.filter((t) => t.endsWith(".rs"));
  return `--workspace -E "$pkg${files.length ? ` & (${files.map(filterOf).join(" | ")})` : ""}"`;
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

const FN = /^(\s*)(?:pub\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)\s*[(<]/;

/** Each named test fn: its line, its indent and the first line of the attributes above it. */
function fnsOf(lines: string[], names: Set<string> | null) {
  const out: { at: number; first: number; indent: string; name: string }[] = [];
  lines.forEach((line, i) => {
    const m = FN.exec(line);
    if (!m || (names && !names.has(m[2]!))) return;
    let first = i;
    // Comments among the attributes (arnx's marker sits under #[test]) belong to the test.
    for (let k = i - 1; k >= 0 && /^\s*(?:#\[|\/\/)/.test(lines[k]!); k--) if (/^\s*#\[/.test(lines[k]!)) first = k;
    out.push({ at: i, first, indent: m[1]!, name: m[2]! });
  });
  return out;
}

const braces = (line: string) => [...line].reduce((n, c) => n + (c === "{" ? 1 : c === "}" ? -1 : 0), 0);

/** Remove each named test: its doc comments and attributes, the fn to its closing `}` (at the fn's indent, or on the
 * same line), and the blank lines after it. */
function drop(source: string, names: Set<string>): { text: string; left: Set<string> } {
  const lines = source.split(/(?<=\n)/);
  const fns = fnsOf(lines, names);
  const left = new Set([...names].filter((n) => !fns.some((f) => f.name === n)));
  const cuts: [number, number][] = [];
  for (const f of fns) {
    let end = -1;
    if (lines[f.at]!.includes("{") && braces(lines[f.at]!) === 0) end = f.at + 1;
    else for (let j = f.at + 1; j < lines.length && end < 0; j++) if (lines[j]!.trimEnd() === `${f.indent}}`) end = j + 1;
    if (end < 0) {
      left.add(f.name);
      continue;
    }
    let first = f.first;
    while (first > 0 && lines[first - 1]!.startsWith(`${f.indent}//`)) first -= 1;
    while (end < lines.length && !lines[end]!.trim()) end += 1;
    cuts.push([first, end]);
  }
  for (const [from, to] of cuts.sort((a, b) => b[0] - a[0])) lines.splice(from, to - from);
  return { text: cuts.length ? endOnce(lines.join("")) : source, left };
}

/** Remove an older arnx's expected-fail marker: its `// arnx` comment and the #[should_panic] under it. */
function unmark(source: string, names?: Set<string>): { text: string; names: string[] } {
  const lines = source.split(/(?<=\n)/);
  const out: string[] = [];
  for (const f of fnsOf(lines, names ?? null).reverse()) {
    const at = f.at - 2;
    if (at < 0 || !/^\s*\/\/ arnx\b/.test(lines[at]!) || lines[at + 1]!.trim() !== "#[should_panic]") continue;
    lines.splice(at, 2);
    out.unshift(f.name);
  }
  return { text: lines.join(""), names: out };
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
    `${WORKSPACE} [ -f "$ws/Cargo.lock" ] || cp ${LOCK} "$ws/Cargo.lock" 2>/dev/null; ${PACKAGE} cd "$ws" && ` +
    `${testCommand.replaceAll("{targets}", targetFlags(targets))} --config-file ${CONFIG} --profile arnx; s=$?; ` +
    `cp /src/.arnx-run/nextest/arnx/junit.xml ${shQuote(reportPath)} 2>/dev/null; exit $s`,
  parseReport: (text, _runner, _root, exists = () => false) => parseNextest(text, exists),
  skip,
  drop,
  unmark,
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
    "- End install with cargo nextest run --workspace --no-run so the test build is in the image: tests run from the " +
      "workspace root with --workspace, filtered to the project's crate. Set runner: nextest and " +
      "test_command: cargo nextest run {targets}.",
    "- Tests inside src/ (#[cfg(test)] modules) are reported by the source file that holds them (src/net/http.rs, " +
      "src/lib.rs for the crate root): when one fails for a reason outside the code, list that file under " +
      "known_failing with the reason in notes; do not exclude tests with -E in test_command.",
  ].join("\n"),
  manifests: ["Cargo.toml", "Cargo.lock", "rust-toolchain", "rust-toolchain.toml"],
  nestedManifests: true,
  // Test runs mount the snapshot over /src, so builds go to a target directory outside it (reused across runs), and
  // the test user (not root) must be able to write there and to cargo's home.
  buildEnv: ["CARGO_TERM_COLOR=never", "CARGO_TARGET_DIR=/opt/arnx-target"],
  runEnv: ["CARGO_TERM_COLOR=never", "CARGO_TARGET_DIR=/opt/arnx-target"],
  postInstall: ["mkdir -p /opt/arnx-target && chmod -R a+rwX /opt/arnx-target /usr/local/cargo",
    `${WORKSPACE} mkdir -p ${posix.dirname(LOCK)}; [ ! -f "$ws/Cargo.lock" ] || cp "$ws/Cargo.lock" ${LOCK}`],
  // Otherwise every run compiles the workspace again from the image's target. tmp/ is CARGO_TARGET_TMPDIR, where
  // integration tests put their own files.
  keepBuild: { emptied: ["/opt/arnx-target/tmp"] },
};
