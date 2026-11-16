// The Go adapter. Go compiles a directory as one package, so each generated file sits alone in its own folder as a
// test-only package: a file that does not compile loses only itself, and no name can collide with the project's. It
// sees the exported API only, since arnx never places a file in a real package.
import { posix } from "node:path";
import { comments } from "../comments";
import { shQuote } from "../util";
import { parseGoReport } from "./go-report";
import type { Adapter, Words } from "./types";

const GENERATED = /^[a-z0-9][a-z0-9_]*_arnx_test\.go$/;
const ENDING = "_arnx_test.go";
const LAYOUT = "<name>_arnx/<name>_arnx_test.go";
const FILES = `${LAYOUT}, one self-contained file per folder: package arnx, import the code under test by its module ` +
  "path (exported names only), find fixtures by walking up to go.mod";

/** Folders Go's toolchain leaves out of a module: vendored code and test data. */
/** The install line arnx drafts for Go: a deliberate warm-up compile whose `|| true` is not a hidden error. */
export const isDraftedGoInstall = (line: string) =>
  /^go mod download && \{ go test -vet=off -run '\^\$' (\.\/[\w.\/-]*)( \.\/[\w.\/-]*)* \|\| true; \}$/.test(line);
export const GO_SKIP_DIRS: ReadonlySet<string> = new Set(["vendor", "testdata"]);
/** Whether a repository path lies under one of them. */
export const goSkipped = (path: string) => path.split("/").slice(0, -1).some((d) => GO_SKIP_DIRS.has(d));

const testStem = (fileName: string) => fileName.endsWith(ENDING) ? fileName.slice(0, -ENDING.length) : fileName;

function pathProblem(rel: string): string | null {
  const parts = rel.split("/");
  const file = parts.at(-1)!;
  return parts.length === 2 && parts[0] === `${testStem(file)}_arnx` ? null : `one file per folder: write ${LAYOUT}`;
}

/** The directories to run, or null for every package: targets are files, Go runs packages. */
function packageDirs(targets: string[]): string[] | null {
  if (!targets.length || targets.some((t) => !t.endsWith(".go"))) return null;
  return [...new Set(targets.map((t) => posix.dirname(t)))];
}

// Blank line first: a run that dies in mid-line must not swallow the module line, without which every result is lost.
const MODULE = "printf '\\n#arnx-module %s\\n' \"$(go mod edit -print 2>/dev/null | awk '$1==\"module\"{print $2;exit}')\"";

/** One `<file>:func Test...` per test function in the directories (a directory's own files only; every package: all). */
function declarations(dirs: string[] | null): string {
  const where = dirs ? `${dirs.map(shQuote).join(" ")} -maxdepth 1` : ".";
  return `find ${where} -type f -name '*_test.go' -exec grep -H '^func Test[^a-z]' {} + 2>/dev/null | sed 's/^/#arnx-test /'`;
}

function command(testCommand: string, targets: string[], reportPath: string): string {
  const dirs = packageDirs(targets);
  const packages = dirs ? dirs.map((d) => shQuote(d === "." ? "." : `./${d}`)).join(" ") : "./...";
  const report = shQuote(reportPath);
  return `${testCommand.replaceAll("{targets}", `-json -count=1 -vet=off ${packages}`)} > ${report}; s=$?; ` +
    `{ ${MODULE}; ${declarations(dirs)}; } >> ${report}; exit $s`;
}

/** `t.Skip("<reason>")` as the first statement of each named test; a missing or blank parameter gets a name, one the
 * body does not already use, so the call compiles. */
function skip(source: string, names: Set<string>, reason: string): string {
  return source.replace(/^func (Test[^\s(]*)\((?:(\w+) )?\*testing\.T\)\s*\{([^\r\n]*)/gm, (whole, name: string, param: string | undefined, rest: string, at: number) => {
    if (!names.has(name)) return whole;
    let t = param && param !== "_" ? param : "t";
    if (t !== param) {
      const end = source.slice(at + whole.length).search(/^}/m);
      const body = end < 0 ? source.slice(at) : source.slice(at, at + whole.length + end);
      if (/\bt\b/.test(body.slice(whole.length - rest.length))) t = "arnxT";
    }
    // A one-line body must not stay on the call's line: Go needs a statement end between them.
    const after = rest.trim() ? `\n\t${rest.trimStart()}` : "";
    return `func ${name}(${t} *testing.T) {\n\t${t}.Skip(${JSON.stringify(reason)})${after}`;
  });
}

/** The import paths of a Go file, read from its header: comments and everything after the first declaration left out. */
function imports(source: string): string[] {
  let bare = "", at = 0;
  for (const c of comments(source, "go")) {
    bare += source.slice(at, c.start);
    at = c.end;
  }
  bare += source.slice(at);
  const first = /^(?:func|type|var|const)\b/m.exec(bare);
  const header = first ? bare.slice(0, first.index) : bare;
  const out: string[] = [];
  for (const m of header.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    for (const q of m[1]!.matchAll(/["`]([^"`\n]+)["`]/g)) out.push(q[1]!);
  }
  for (const m of header.matchAll(/\bimport\s+(?:[\w.]+\s+)?["`]([^"`\n]+)["`]/g)) out.push(m[1]!);
  return out;
}

/** A Go test names a package, not a file: it refers to a file by importing a path whose last element is the file's
 * directory, with a `/` in it, since a bare path is the standard library. A file in the module root counts once a test
 * exists, since the module path is not known here; vendored code, test data and the project's own _test.go files are
 * no source to cover. */
function refersTo(path: string, tests: Record<string, string>): boolean {
  if (goSkipped(path) || path.endsWith("_test.go")) return true;
  const texts = Object.values(tests).filter((t) => t.trim());
  if (!texts.length) return false;
  const dir = posix.dirname(path);
  if (dir === ".") return true;
  const last = posix.basename(dir);
  return texts.some((t) => imports(t).some((i) => i.includes("/") && posix.basename(i) === last));
}

const ENV = ["GOTOOLCHAIN=local", "GOFLAGS=-buildvcs=false", "GOCACHE=/opt/arnx-gocache"];

export const go: Adapter = {
  id: "go",
  runners: ["gotest"],
  defaultRunner: "gotest",
  words: (): Words => ({
    language: "Go",
    runner: "go test",
    testFiles: FILES,
    writableFiles: FILES,
    propertyLib: "testing/quick",
    imageExample: "golang:1.26-bookworm",
    installExample: "go mod download && { go test -vet=off -run '^$' ./... || true; }",
    commandExample: "go test {targets}",
  }),
  defaultTestsDir: "arnx_generated",
  writable: GENERATED,
  pathProblem,
  probes: () => [{
    file: "arnx_probe_arnx/arnx_probe_arnx_test.go",
    source: 'package arnx\n\nimport "testing"\n\nfunc TestArnxProbe(t *testing.T) {}\n',
  }],
  isTestFile: (name) => GENERATED.test(name),
  isSupportFile: () => false,
  validateCommand: (cmd) => typeof cmd === "string" && cmd.includes("go test") && cmd.includes("{targets}")
    ? [] : ["test_command: must run go test and contain {targets}"],
  runs: () => /\bgo\s+test\b/,
  command,
  parseReport: (text, _runner, _root, _exists, sourceLine) => parseGoReport(text, { sourceLine }),
  skip,
  // Cutting a test can leave an unused import, which does not compile: accept skips instead.
  drop: (source, names) => ({ text: source, left: names }),
  unmark: (source) => ({ text: source, names: [] }),
  acceptedPath: (_original, tag, acceptedDir, name) =>
    posix.join(acceptedDir, `r${tag}`, `${name}_arnx`, `${name}${ENDING}`),
  testStem,
  refersTo,
  relocate: (source) => source,
  setupHints: [
    "- A Go project is a directory with a go.mod; under a go.work, one project per `use` member, each with " +
      "install_root: . (the workspace root) and the same image and install. Tests run from inside the member.",
    "- Use golang:<major.minor>-bookworm: the go line of go.mod, or 1.24 if that is older (arnx runs no older " +
      "toolchain), and 1.26 when there is no go line. Under a go.work use the higher of the member's go line and the " +
      "go.work line, so every member shares one image. Never pin a patch: a toolchain newer than the image fails.",
    "- Modules must be in the image: install is go mod download && { go test -vet=off -run '^$' ./... || true; } " +
      "(the warm-up fills the build cache and may fail without failing the build). Under a go.work, ./... fails at " +
      "the workspace root: list the members instead, ./a/... ./b/..., the same install for every member. Tests run " +
      "offline.",
    "- Set runner: gotest and test_command: go test {targets}. Do not add -run, -v or -json: arnx adds its own flags.",
    "- Generated tests are one folder per file, each a test-only package arnx, so they see exported names only.",
  ].join("\n"),
  manifests: ["go.mod", "go.sum", "go.work", "go.work.sum"],
  nestedManifests: true,
  buildEnv: ENV,
  runEnv: [...ENV, "GOPROXY=off"],
  postInstall: ["mkdir -p /opt/arnx-gocache && chmod -R a+rwX /opt/arnx-gocache /go"],
};
