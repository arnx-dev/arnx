// Everything that depends on the reviewed repository's language goes behind one interface. Piece 1 implements
// Python; TypeScript, Rust and C# add adapters, not redesigns.

export type AdapterId = "python" | "typescript" | "rust" | "csharp";

/** One test in one run, from the runner's report. */
export interface TestResult {
  testId: string;
  fileAttr: string;
  name: string;
  outcome: string; // passed | failed | error | skipped
  message: string;
}

/** What a runner lists before anything runs (Adapter.listCommand). */
export interface Listing {
  /** How many tests it would run; null when the runner lists files only. */
  tests: number | null;
  /** The test files, relative to the project root (some may be missing when the output was cut). */
  files: string[];
  /** Test files it could not load (an import error while collecting). */
  broken: string[];
  /** It stopped with an error before listing (a runner that does not start, a configuration that does not load). */
  failed: boolean;
}

/** Words the prompts need. */
export interface Words {
  language: string;
  runner: string;
  testFiles: string;
  writableFiles: string;
  propertyLib: string | null;
  imageExample: string;
  installExample: string;
  commandExample: string;
}

export interface Adapter {
  id: AdapterId;
  /** Test runners this adapter can drive; review.yaml names one per project. */
  runners: string[];
  defaultRunner: string;
  /** Words the prompts need, for the project's runner. */
  words(runner: string): Words;
  /** Default directory for generated tests, relative to workdir. */
  defaultTestsDir: string;
  /** Files the agent may write under the tests directory; a round collects exactly these. */
  writable: RegExp;
  /** One-test files that prove the runner picks up files in the tests directory (any one reported passing is
   * enough; file names relative to that directory). */
  probes(runner: string): { file: string; source: string }[];
  /** True for files that hold tests (as opposed to support files). */
  isTestFile(name: string): boolean;
  /** Support files copied along with kept tests (Python: conftest.py). */
  isSupportFile(name: string): boolean;
  /** Problems with the configured test command; empty when it is usable. */
  validateCommand(command: unknown, runner: string): string[];
  /** The runner's own call in a test command (vitest: `vitest`): the command that gets {targets} must make it, since
   * arnx's report options follow {targets}. */
  runs(runner: string): RegExp;
  /** Where the runner says it wrote its report (the last such line of its output); null: it said none. Absent, or
   * undefined, for a runner that never says. */
  reportSaid?(output: string, runner: string): string | null | undefined;
  /** Shell command that runs the targets and writes a report to reportPath (inside the container). */
  command(testCommand: string, targets: string[], reportPath: string, runner: string): string;
  /** Parse the report file the command wrote; null when it is unreadable. projectRoot is the project's directory
   * relative to the repository root; `exists` tells whether a path relative to it is a file in the snapshot (Rust
   * finds the source file of a test inside src/ by its module path). */
  parseReport(text: string, runner: string, projectRoot: string, exists?: (rel: string) => boolean): TestResult[] | null;
  /** Shell command that lists the tests a run of the targets would run (all of them with none), running none; null when
   * the runner has no list form or test_command cannot be turned into one safely. A runner that writes its list to a
   * file writes it to listPath (inside the container). */
  listCommand?(testCommand: string, targets: string[], listPath: string, runner: string): string | null;
  /** What a list run shows, from its output, the file at listPath (null when none was written) and its exit code;
   * null when that cannot be read for sure (an older runner without the list form, a cut-off output). */
  parseList?(output: string, listed: string | null, exitCode: number | null, runner: string, projectRoot: string)
    : Listing | null;
  /** Files the runner needs before a run (written into the throwaway snapshot). */
  reportSetup?(snapshot: string, runner: string): void;
  /** Mark the named tests as skipped in a test file's source, with a reason. */
  skip(source: string, names: Set<string>, reason: string): string;
  /** Remove the named tests from a test file's source; `left`: the names it could not remove cleanly (accept skips
   * those instead). */
  drop(source: string, names: Set<string>): { text: string; left: Set<string> };
  /** Remove the expected-fail marker an older arnx put on the named tests (every test, without names), when they were
   * kept inside the project; `names`: those unmarked. */
  unmark(source: string, names?: Set<string>): { text: string; names: string[] };
  /** Where a kept file goes, relative to the project root (original is relative to the generated-tests directory;
   * acceptedDir is the configured accepted_tests_dir). A test file is named `name` (what it protects, as accept
   * chose it: [a-z0-9_]) in the adapter's test-file form; a support file keeps its name. The review id (`tag`) stays
   * in the path: a folder r<tag>/, or for Rust a prefix. */
  acceptedPath(original: string, tag: string, acceptedDir: string, name: string): string;
  /** Where kept test files are and how they are named, when not in the accepted folders under the generated names
   * (Rust keeps them in tests/ as arnx_<tag>_<name>.rs). dirs: relative to the project root. */
  kept?: { dirs: string[]; name: RegExp };
  /** The readable part of a generated test file's name ("add" for test_add.py): an answer test's kept name. */
  testStem(fileName: string): string;
  /** Fix relative imports when a kept file moves from fromDir to toDir (both relative to the project root). */
  relocate(source: string, fromDir: string, toDir: string): string;
  /** Language-specific rule lines for the setup agent. */
  setupHints: string;
  /** Globs in workdir whose contents key the environment image. */
  manifests: string[];
  /** The manifests anywhere under the install's directory key the image, not only those at its top: a Cargo
   * workspace's install builds every member, whose own manifests pick dependencies and features. */
  nestedManifests?: boolean;
  /** ENV entries in the environment image. */
  buildEnv: string[];
  /** Extra environment entries for test runs. */
  runEnv: string[];
  /** Build-only variables that point the package manager's download cache into /arnx-cache, a BuildKit cache shared
   * by every project of this language: a rebuild downloads only what changed. Only for caches that hold downloads,
   * never the installed result (a yarn PnP cache or a pnpm store is the install itself). */
  downloadCache?: string[];
  /** ENV entries added instead when BuildKit is not available (no cache mount). */
  noDownloadCache?: string[];
  /** Commands run after the project's install commands when building the image (part of the image key). */
  postInstall?: string[];
  /** The runs of one session share one container, so the build a run leaves there is the next run's start (see
   * `Session`); `emptied`: directories in it a run empties first, as a new container would have them. */
  keepBuild?: { emptied: string[] };
}

/** accepted_tests_dir when the config leaves it at its default. A TypeScript project then keeps its accepted tests
 * under __tests__/arnx (beside its __tests__/arnx_generated), a Rust crate in tests/ (cargo builds only tests/*.rs). */
export const DEFAULT_ACCEPTED_DIR = "tests/arnx";
