// The JavaScript/TypeScript adapter (`language: typescript` covers both): vitest, jest, node:test and bun test.
// Each runner writes its own built-in report: JUnit for vitest, node and bun, JSON for jest (so repositories need no
// extra reporter package).
import { mkdirSync, writeFileSync } from "node:fs";
import { join, posix } from "node:path";
import { shQuote } from "../util";
import { junitCases, MESSAGE_LIMIT } from "./junit";
import { type Adapter, DEFAULT_ACCEPTED_DIR, type TestResult, type Words } from "./types";

const RUNNERS = ["vitest", "jest", "node", "bun"];
const RUNNER_WORDS: Record<string, string> = { vitest: "vitest", jest: "jest", node: "node:test", bun: "bun test" };
const RUNS: Record<string, RegExp> = { vitest: /\bvitest\b/, jest: /\bjest\b/, node: /\bnode\b.*\s--test\b/,
  bun: /\bbun\s+test\b/ };
const SOURCE = /\.(?:c|m)?[jt]sx?$/;
const TEST_FILE = /\.(?:test|spec)\.(?:c|m)?[jt]sx?$/;
const SUPPORT = /^arnx-helpers\.(?:c|m)?[jt]sx?$/;

const pathLike = (s: string | undefined): s is string => !!s && SOURCE.test(s);

/** node:test's JUnit output names no file, so node runs use this reporter: one JSON line per test with its file and
 * full name (describe titles joined with " > "). A file that fails to load is one "error" line named after the file. */
const NODE_REPORTER_PATH = "/src/.arnx-run/arnx-node-reporter.mjs";
const NODE_REPORTER = `// Written by arnx into a throwaway copy of the repository.
export default async function* reporter(source) {
  const stacks = new Map();
  for await (const event of source) {
    const d = event.data ?? {};
    if (event.type === "test:start") {
      const stack = stacks.get(d.file) ?? [];
      stack.length = d.nesting;
      stack.push(d.name);
      stacks.set(d.file, stack);
      continue;
    }
    if (event.type !== "test:pass" && event.type !== "test:fail") continue;
    if (d.details?.type === "suite") continue;
    // node reports a file that defines no tests as one passing test named after the file: that is not a test.
    if (event.type === "test:pass" && d.nesting === 0 && String(d.file ?? "").endsWith(d.name)) continue;
    const stack = stacks.get(d.file) ?? [];
    const name = [...stack.slice(0, d.nesting), d.name].join(" > ");
    const error = d.details?.error;
    // A file that fails while loading is reported as one failing test named after the file (node sends its
    // test:start first, so the stack is not empty).
    const loadFailure = event.type === "test:fail" && d.nesting === 0 && error?.failureType === "testCodeFailure"
      && String(d.file ?? "").endsWith(d.name);
    const outcome = loadFailure ? "error" : event.type === "test:fail" ? "failed" : d.skip || d.todo ? "skipped" : "passed";
    const message = error ? String(error.cause?.message ?? error.message ?? error) : "";
    yield JSON.stringify({ name, file: d.file ?? null, outcome, message }) + "\\n";
  }
}
`;

function parseNode(text: string, root: string): TestResult[] | null {
  const out: TestResult[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
    const file = e.file ? projectPath(String(e.file), root) : "";
    const name = String(e.name ?? "");
    out.push({ testId: `${file}::${name}`, fileAttr: file, name, outcome: String(e.outcome ?? "error"),
      message: String(e.message ?? "").trim().slice(0, MESSAGE_LIMIT) });
  }
  return out;
}

/** A path the runner reported (absolute in the container, or relative), relative to the project root. */
function projectPath(path: string, root: string): string {
  let p = path.startsWith("/src/") ? path.slice("/src/".length) : path;
  if (path.startsWith("/src/") && root !== ".") p = posix.relative(root, p);
  return p;
}

function parseJest(text: string, root: string): TestResult[] | null {
  let data: { testResults?: unknown };
  try {
    data = JSON.parse(text) as { testResults?: unknown };
  } catch {
    return null;
  }
  if (!Array.isArray(data.testResults)) return null;
  const out: TestResult[] = [];
  for (const suite of data.testResults as Record<string, unknown>[]) {
    const file = projectPath(String(suite.name ?? ""), root);
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults as Record<string, unknown>[] : [];
    if (!assertions.length && suite.status === "failed") {
      out.push({ testId: `${file}::${file}`, fileAttr: file, name: file, outcome: "error",
        message: String(suite.message ?? "").trim().slice(0, MESSAGE_LIMIT) });
      continue;
    }
    for (const a of assertions) {
      const titles = [...(Array.isArray(a.ancestorTitles) ? a.ancestorTitles as string[] : []), String(a.title ?? "")];
      const name = titles.join(" > ");
      const outcome = a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped";
      const message = (Array.isArray(a.failureMessages) ? a.failureMessages as string[] : []).join("\n")
        .trim().slice(0, MESSAGE_LIMIT);
      out.push({ testId: `${file}::${name}`, fileAttr: file, name, outcome, message });
    }
  }
  return out;
}

/** vitest, node:test and bun JUnit: the file comes from a `file` attribute, a path-like classname, or the nearest
 * path-like suite; the name joins the describe suites with the test's own name. */
function parseJunitJs(text: string, root: string): TestResult[] | null {
  const cases = junitCases(text);
  if (cases === null) return null;
  return cases.map(({ attrs, suites, outcome, message }) => {
    const suiteFile = [...suites].reverse().map((s) => s.file ?? (pathLike(s.name) ? s.name : undefined))
      .find(pathLike);
    const raw = attrs.file ?? (pathLike(attrs.classname) ? attrs.classname : suiteFile) ?? "";
    const file = raw ? projectPath(raw, root) : "";
    const describes = suites.map((s) => s.name ?? "").filter((n) => n && !pathLike(n));
    const name = [...describes, attrs.name ?? ""].join(" > ");
    return { testId: `${file || attrs.classname || ""}::${name}`, fileAttr: file, name, outcome, message };
  });
}

const escapeRx = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Mark tests skipped: `test(`/`it(` (also `.only`) becomes `.skip(`, with the reason in a comment above. Names are
 * matched on their own title (the part after the last " > "); titles built with `${}` are left alone. */
function skip(source: string, names: Set<string>, reason: string): string {
  let out = source;
  for (const full of names) {
    const title = full.split(" > ").at(-1)!;
    if (title.includes("${")) continue;
    const rx = new RegExp(`^([ \\t]*)(.*?\\b)(test|it)(?:\\.only)?\\((\\s*)(['"\`])${escapeRx(title)}\\5`, "m");
    out = out.replace(rx, (_m, indent: string, before: string, fn: string, space: string, q: string) =>
      `${indent}// ${reason}\n${indent}${before}${fn}.skip(${space}${q}${title}${q}`);
  }
  return out;
}

const SPECIFIER = /((?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+|\b(?:jest|vi)\.mock\s*\(\s*))(['"])(\.{1,2}\/[^'"]*)\2/g;

/** Rewrite relative specifiers so they reach the same files from the kept test's new directory. arnx-helpers files
 * move with the tests, so specifiers pointing at them stay as they are. */
/** A relative path from the old place, rewritten to reach the same file from the new one. */
function moveRel(spec: string, fromDir: string, toDir: string, dotSlash: boolean): string {
  const target = posix.normalize(posix.join(fromDir, spec));
  let rel = posix.relative(toDir, target) || ".";
  if (dotSlash && !rel.startsWith(".")) rel = `./${rel}`;
  return spec.endsWith("/") && !rel.endsWith("/") ? `${rel}/` : rel;
}

// The file's own folder, written in place: __dirname, import.meta.dir (bun), import.meta.dirname (node 20.11+) and
// dirname(fileURLToPath(import.meta.url)). A variable holding it is not followed: nothing proves what it holds.
const OWN_DIR = String.raw`__dirname\b|import\.meta\.dirname\b|import\.meta\.dir\b|` +
  String.raw`(?:path\.)?dirname\(\s*(?:url\.)?fileURLToPath\(\s*import\.meta\.url\s*\)\s*\)`;
// path.join(<own folder>, "a", "../b") and path.resolve(<own folder>, ...): the string arguments that follow it.
const DIRNAME_CALL = new RegExp(String.raw`(\b(?:path\.)?(?:join|resolve)\s*\(\s*(?:${OWN_DIR})\s*,\s*)` +
  String.raw`((?:(['"])[^'"]*\3\s*,?\s*)+)`, "g");
// new URL("../x", import.meta.url)
const URL_META = /(\bnew\s+URL\s*\(\s*)(['"])(\.{1,2}\/[^'"]*|\.{1,2})\2(\s*,\s*import\.meta\.url)/g;

export function relocate(source: string, fromDir: string, toDir: string): string {
  if (posix.normalize(fromDir) === posix.normalize(toDir)) return source;
  let out = source.replace(SPECIFIER, (m, lead: string, q: string, spec: string) => {
    if (posix.basename(spec).startsWith("arnx-helpers")) return m;
    return `${lead}${q}${moveRel(spec, fromDir, toDir, true)}${q}`;
  });
  // Paths built from the file's own folder: the joined segments are rewritten as one relative path.
  out = out.replace(DIRNAME_CALL, (m, lead: string, args: string) => {
    const parts = [...args.matchAll(/(['"])([^'"]*)\1/g)].map((x) => x[2]!);
    if (!parts.length || parts.some((p) => posix.isAbsolute(p))) return m;
    const q = /^\s*(['"])/.exec(args)?.[1] ?? '"';
    const trailing = /,?\s*$/.exec(args)![0];
    return `${lead}${q}${moveRel(posix.join(...parts), fromDir, toDir, false)}${q}${trailing}`;
  });
  return out.replace(URL_META, (_m, lead: string, q: string, spec: string, meta: string) =>
    `${lead}${q}${moveRel(spec, fromDir, toDir, true)}${q}${meta}`);
}

const TEST_NAME = /^(.*)\.(?:test|spec)\.((?:c|m)?[jt]sx?)$/;
export const TS_ACCEPTED_DIR = "__tests__/arnx";

/** Accepted tests go to accepted_tests_dir; while it is the default (tests/arnx), to __tests__/arnx instead, beside
 * the generated tests in __tests__/arnx_generated, where the __tests__ patterns of jest and the like find them. */
function acceptedPath(original: string, tag: string, acceptedDir: string, name: string): string {
  const own = posix.basename(original);
  const m = TEST_NAME.exec(own);
  const dir = acceptedDir === DEFAULT_ACCEPTED_DIR ? TS_ACCEPTED_DIR : acceptedDir;
  return posix.join(dir, `r${tag}`, posix.dirname(original), m ? `${name}.test.${m[2]}` : own);
}

export const typescript: Adapter = {
  id: "typescript",
  runners: RUNNERS,
  defaultRunner: "vitest",
  words: (runner): Words => ({
    language: "JavaScript/TypeScript",
    runner: RUNNER_WORDS[runner] ?? runner,
    testFiles: "*.test.ts or *.test.js (match the project's language and module style)",
    writableFiles: "*.test.<ext>, *.spec.<ext> or arnx-helpers.<ext>",
    propertyLib: "fast-check",
    imageExample: "node:22-bookworm",
    installExample: "npm ci",
    commandExample: "npx vitest run {targets}",
  }),
  defaultTestsDir: "__tests__/arnx_generated",
  writable: /^(?:.+\.(?:test|spec)|arnx-helpers)\.(?:c|m)?[jt]sx?$/,
  probes: (runner) => {
    // .js and .ts: a project's runner configuration may match only one of them.
    const body = 'test("arnx probe", () => {});\n';
    if (runner === "node") return [{ file: "arnx-probe.test.mjs", source: `import { test } from "node:test";\n${body}` }];
    const head = runner === "jest" ? "" : `import { test } from "${runner === "bun" ? "bun:test" : "vitest"}";\n`;
    return [{ file: "arnx-probe.test.js", source: head + body }, { file: "arnx-probe.test.ts", source: head + body }];
  },
  isTestFile: (name) => TEST_FILE.test(name),
  isSupportFile: (name) => SUPPORT.test(name),
  validateCommand: (command, runner) => {
    if (typeof command !== "string" || !command.includes("{targets}")) return ["test_command: must contain {targets}"];
    if (/^\s*(?:npm|pnpm|yarn|bun)\s+run\b/.test(command)) {
      return ["test_command: call the runner directly (for example npx jest {targets}), not through npm run"];
    }
    const rx = RUNS[runner];
    if (!rx || !rx.test(command)) return [`test_command: must run ${RUNNER_WORDS[runner] ?? runner} (the runner set for this project)`];
    return [];
  },
  command: (testCommand, targets, reportPath, runner) => {
    const t = targets.map(shQuote).join(" ");
    const r = shQuote(reportPath);
    // --forceExit / --test-force-exit: code that opens a database pool at import never lets the runner exit.
    if (runner === "jest") {
      return `${testCommand.replaceAll("{targets}", t)} --json --outputFile=${r} --testLocationInResults --forceExit`;
    }
    if (runner === "vitest") return `${testCommand.replaceAll("{targets}", t)} --reporter=junit --outputFile=${r}`;
    if (runner === "bun") return `${testCommand.replaceAll("{targets}", t)} --reporter=junit --reporter-outfile=${r}`;
    // node --test runs files and globs, not directories: a directory becomes a glob of its test files.
    const nodeTargets = targets.map((x) => SOURCE.test(x) ? shQuote(x) : `'${x.replaceAll("'", "")}/**/*.{test,spec}.*'`)
      .join(" ");
    return testCommand.replace(/--test(?=\s|$)/,
      `--test --test-force-exit --test-reporter=${NODE_REPORTER_PATH} --test-reporter-destination=${r}`)
      .replaceAll("{targets}", nodeTargets);
  },
  parseReport: (text, runner, root) =>
    runner === "jest" ? parseJest(text, root) : runner === "node" ? parseNode(text, root) : parseJunitJs(text, root),
  reportSetup: (snapshot, runner) => {
    if (runner !== "node") return;
    mkdirSync(join(snapshot, ".arnx-run"), { recursive: true });
    writeFileSync(join(snapshot, ".arnx-run", "arnx-node-reporter.mjs"), NODE_REPORTER);
  },
  skip,
  acceptedPath,
  testStem: (fileName) => TEST_NAME.exec(fileName)?.[1] ?? fileName,
  relocate,
  setupHints: [
    "- Read package.json scripts and the CI configuration to find how each package runs its tests.",
    "- Pick the Node version from .nvmrc, package.json engines or CI; the node runner needs Node 22 or later.",
    "- Install with the lockfile's package manager: npm ci, pnpm install --frozen-lockfile, yarn install --immutable" +
      " or bun install.",
    "- Set runner to vitest, jest, node or bun, and write test_command so it calls that runner directly with " +
      "{targets} (npx jest {targets}, npx vitest run {targets}, node --test {targets}, bun test {targets}).",
    "- Tests run with the repository mounted over /src, which hides anything install wrote under /src (such as " +
      "node_modules). Install dependencies outside /src (for example copy package.json and the lockfile to " +
      "/opt/deps and install there) and point the tests at them: link node_modules to /opt/deps/node_modules in " +
      "test_command, or set NODE_PATH.",
    "- When a project has a tsconfig.json and typescript among its dependencies (its package.json or the workspace " +
      "root's), add typecheck: the project's type check as one command, such as npx tsc --noEmit -p tsconfig.json " +
      "(with the same node_modules link as test_command). Keep it out of test_command: arnx runs it once per review " +
      "without its generated tests and reports type errors apart from the tests. Leave it out for projects without " +
      "typescript.",
    "- A workspace is usually one project per package that has tests; when they install from one lockfile at the " +
      "repository root, give them install_root: . and the same image and install, so they share one image.",
  ].join("\n"),
  manifests: ["package.json", "package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock",
    "bun.lockb", ".nvmrc"],
  buildEnv: ["CI=1", "npm_config_update_notifier=false"],
  downloadCache: ["npm_config_cache=/arnx-cache/npm"],
  runEnv: ["CI=1"],
};
