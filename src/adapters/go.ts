// The Go adapter. Go compiles a directory as one package, so each generated file sits alone in its own folder as a
// test-only package: a file that does not compile loses only itself, and no name can collide with the project's. It
// sees the exported API only, since arnx never places a file in a real package.
import { posix } from "node:path";
import { shQuote } from "../util";
import { parseGoReport } from "./go-report";
import type { Adapter, Words } from "./types";

const GENERATED = /^[a-z0-9_]+_arnx_test\.go$/;
const ENDING = "_arnx_test.go";
const LAYOUT = "<name>_arnx/<name>_arnx_test.go";
const FILES = `${LAYOUT}, one self-contained file per folder: package arnx, import the code under test by its module ` +
  "path (exported names only), find fixtures by walking up to go.mod";

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
  return `find ${where} -type f -name '*_test.go' -exec grep -H '^func Test' {} + 2>/dev/null | sed 's/^/#arnx-test /'`;
}

function command(testCommand: string, targets: string[], reportPath: string): string {
  const dirs = packageDirs(targets);
  const packages = dirs ? dirs.map((d) => shQuote(d === "." ? "." : `./${d}`)).join(" ") : "./...";
  const report = shQuote(reportPath);
  return `${testCommand.replaceAll("{targets}", `-json -count=1 -vet=off ${packages}`)} > ${report}; s=$?; ` +
    `{ ${MODULE}; ${declarations(dirs)}; } >> ${report}; exit $s`;
}

/** `t.Skip("<reason>")` as the first statement of each named test; a blank parameter gets a name so the call compiles. */
function skip(source: string, names: Set<string>, reason: string): string {
  return source.replace(/^func (Test\w*)\((\w+) \*testing\.T\) \{([^\n]*)/gm, (whole, name: string, param: string, rest: string) => {
    if (!names.has(name)) return whole;
    const t = param === "_" ? "t" : param;
    // A one-line body must not stay on the call's line: Go needs a statement end between them.
    const after = rest.trim() ? `\n\t${rest.trimStart()}` : "";
    return `func ${name}(${t} *testing.T) {\n\t${t}.Skip(${JSON.stringify(reason)})${after}`;
  });
}

const ENV = ["GOTOOLCHAIN=local", "GOFLAGS=-buildvcs=false", "GOCACHE=/opt/arnx-gocache"];

export const go: Adapter = {
  // @ts-expect-error "go" joins AdapterId when the adapter is registered.
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
    installExample: "go mod download && go test -run '^$' ./...",
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
  parseReport: (text) => parseGoReport(text),
  skip,
  // Cutting a test can leave an unused import, which does not compile: accept skips instead.
  drop: (source, names) => ({ text: source, left: names }),
  unmark: (source) => ({ text: source, names: [] }),
  acceptedPath: (_original, tag, acceptedDir, name) =>
    posix.join(acceptedDir, `r${tag}`, `${name}_arnx`, `${name}${ENDING}`),
  testStem,
  relocate: (source) => source,
  setupHints: "",
  manifests: ["go.mod", "go.sum", "go.work", "go.work.sum"],
  nestedManifests: true,
  buildEnv: ENV,
  runEnv: [...ENV, "GOPROXY=off"],
  postInstall: ["mkdir -p /opt/arnx-gocache && chmod -R a+rwX /opt/arnx-gocache /go"],
};
