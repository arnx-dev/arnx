// The project's own type check (`typecheck`, TypeScript projects): once per review on the change without arnx's
// generated tests, compared with the code before the change, reported apart from the tests; never a finding, never
// "no report", never the exit code. No model or Docker: the sandbox is a fake that type checks like tsc.
import { COPY_SUFFIX } from "../src/testround";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, posix } from "node:path";
import { typescript } from "../src/adapters/typescript";
import { parseReviewConfig, parseReviewFile, reviewConfigPath, stamp, stampFile } from "../src/config";
import { ciTypeChecker, detect, typeCheckable } from "../src/detect";
import { EVENTS_FILE, type TraceEvent } from "../src/events";
import { exitCode, load, render, summary } from "../src/report";
import { runReview } from "../src/reviewer";
import { OutOfTime, type RunResult, type Runner, type SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { runSetup, runSuite, typecheckNote } from "../src/setup";
import { approvalChecks, pythonTypeGap, typecheckGaps } from "../src/setupview";
import { describeTypecheck, markNew, parseTsc, QUICK_TYPECHECK_TIMEOUT, TYPECHECK_TIMEOUT, typeGaps, workspaceNames } from "../src/typecheck";
import { FakeJson, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

const TSC = "npx tsc --noEmit -p tsconfig.json";
const YAML = `version: 1
image: node:22-bookworm-slim
language: typescript
test_command: npx vitest run {targets}
`;
const TYPED = `${YAML}typecheck: ${TSC}\n`;

describe("parseTsc", () => {
  test("plain and --pretty errors, and errors about no file; paths relative to the repository root", () => {
    const out = [
      "src/a.ts(3,7): error TS2322: Type 'string' is not assignable to type 'number'.",
      "  Continuation lines are not errors.",
      "\x1b[96msrc/b.ts\x1b[0m:\x1b[93m10\x1b[0m:\x1b[93m2\x1b[0m - \x1b[91merror\x1b[0m\x1b[90m TS2304: \x1b[0mCannot " +
        "find name 'x'.",
      "/src/web/c.ts(1,1): error TS1005: ';' expected.",
      "error TS5058: The specified path does not exist: 'tsconfig.app.json'.",
      "Found 4 errors.",
    ].join("\n");
    expect(parseTsc(out, "web")).toEqual([
      { file: "web/src/a.ts", line: 3, column: 7, code: "TS2322",
        message: "Type 'string' is not assignable to type 'number'." },
      { file: "web/src/b.ts", line: 10, column: 2, code: "TS2304", message: "Cannot find name 'x'." },
      { file: "web/c.ts", line: 1, column: 1, code: "TS1005", message: "';' expected." },
      { file: "", line: 0, column: 0, code: "TS5058",
        message: "The specified path does not exist: 'tsconfig.app.json'." },
    ]);
    expect(parseTsc("../shared/m.ts(2,3): error TS7006: Parameter 'a' implicitly has an 'any' type.", "web")[0]!.file)
      .toBe("shared/m.ts");
    expect(parseTsc("", ".")).toEqual([]);
  });

  test("an error is new unless the code before the change has the same one, line aside, matched once each", () => {
    const e = (file: string, line: number, message = "m") => ({ file, line, column: 1, code: "TS1", message });
    expect(markNew([e("a.ts", 9), e("a.ts", 12), e("b.ts", 1), e("a.ts", 3, "other")], [e("a.ts", 4)]))
      .toEqual([false, true, true, true]);
  });

  test("an error that differs only in tsc's '... N more ...' is not new", () => {
    const e = (message: string) => ({ file: "a.ts", line: 1, column: 1, code: "TS2322", message });
    const before = [e("Type '{ a: 1; ... 3 more ...; }' is not assignable to type 'T'.")];
    const after = [e("Type '{ a: 1; ... 4 more ...; }' is not assignable to type 'T'.")];
    expect(markNew(after, before)).toEqual([false]);
    expect(markNew([e("Type '{ a: 1; ... 4 more ...; }' is not assignable to type 'U'.")], before)).toEqual([true]);
  });
});

describe("review.yaml", () => {
  test("typecheck is one command, only for typescript projects; a file without it parses as before", () => {
    expect(parseReviewConfig(TYPED).typecheck).toBe(TSC);
    expect("typecheck" in parseReviewConfig(YAML)).toBe(false);
    expect(() => parseReviewConfig(`${YAML}typecheck: ""\n`)).toThrow("typecheck: must be one shell command");
    expect(() => parseReviewConfig("version: 1\nimage: python:3.12-slim\ntest_command: pytest {targets}\n" +
      "typecheck: mypy .\n")).toThrow("typecheck: only for typescript projects");
    const f = parseReviewFile(`version: 1
projects:
  web:
    root: web
    language: typescript
    image: node:22
    test_command: npx vitest run {targets}
    typecheck: ${TSC}
`);
    expect(f.projects[0]!.typecheck).toBe(TSC);
  });
});

/** Type checks like tsc: every line of a .ts file (node_modules and dot folders left out, as tsc's include does)
 * holding TYPE-ERROR is an error. */
function tsc(snap: string, workdir: string): [string, number] {
  const lines: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      if (name.startsWith(".") || name === "node_modules") continue;
      if (statSync(p).isDirectory()) walk(p);
      else if (name.endsWith(".ts")) {
        readFileSync(p, "utf8").split("\n").forEach((l, i) => {
          if (l.includes("GAP-ERROR")) {
            lines.push(`${posix.relative(join(snap, workdir), p)}(${i + 1},7): error TS2307: Cannot find module ` +
              "'@prisma/client' or its corresponding type declarations.");
          }
          if (l.includes("TYPE-ERROR")) {
            lines.push(`${posix.relative(join(snap, workdir), p)}(${i + 1},7): error TS2322: Type 'string' is not ` +
              "assignable to type 'number'.");
          }
        });
      }
    }
  };
  walk(join(snap, workdir));
  return [lines.join("\n"), lines.length ? 2 : 0];
}

/** A vitest sandbox: each test file a command names reports one passing test ("works"); with no targets, the
 * project's own test. The type check is `tsc` above, or a command that cannot start. */
class FakeTs implements Runner {
  commands: string[] = [];
  constructor(readonly snap: string, readonly workdir = ".") {}
  run(command: string): RunResult {
    this.commands.push(command);
    if (command === TSC) {
      const [output, exitCode] = tsc(this.snap, this.workdir);
      return { exitCode, output, timedOut: false, seconds: 1.5 };
    }
    if (command.startsWith("no-time-tsc")) throw new OutOfTime(10);
    if (command.startsWith("gap-tsc")) {
      const out = ["a", "b", "c"].map((n, i) => `src/${n}.ts(${i + 1},9): error TS2305: Module '"@prisma/client"' has ` +
        "no exported member 'User'.").join("\n");
      return { exitCode: 2, output: out, timedOut: false, seconds: 1 };
    }
    if (command.startsWith("slow-tsc")) return { exitCode: null, output: "[timed out]", timedOut: true, seconds: 600 };
    if (command.startsWith("missing-tsc")) {
      return { exitCode: 127, output: "sh: 1: missing-tsc: not found", timedOut: false, seconds: 0.1 };
    }
    const report = /--outputFile='?\/src\/([^'\s]+)/.exec(command)?.[1];
    const args = /vitest run (.*?) --reporter/.exec(command)?.[1] ?? "";
    const targets = args.split(" ").map((a) => a.replace(/^'|'$/g, "")).filter((a) => /\.test\.[jt]s$/.test(a));
    if (report) {
      mkdirSync(dirname(join(this.snap, report)), { recursive: true });
      writeFileSync(join(this.snap, report), junitXml((targets.length ? targets : ["src/own.test.ts"])
        .map((f) => [posix.join(this.workdir, f), "works", "passed", ""])));
    }
    return { exitCode: 0, output: "", timedOut: false, seconds: 0.2 };
  }
}

interface Seen { cfg: string; services: number; snap: string; commands: string[] }
function sandbox(seen: Seen[] = []): SessionFactory {
  return async (cfg, snap, _log, body) => {
    const s = new FakeTs(snap, cfg.workdir);
    seen.push({ cfg: cfg.name, services: cfg.services.length, snap, commands: s.commands });
    return body(s);
  };
}

const SETTINGS = { ...defaultSettings(), consentAt: "2026-10-20T00:00:00Z", fixProofMax: 0 };
const GEN = "__tests__/arnx_generated/calc.test.ts";
// The generated test has a type error of its own: it must never be reported.
const GEN_SOURCE = 'import { add } from "../../src/calc";\nconst s: string = add(1, 2); // TYPE-ERROR\n' +
  'test("works", () => {});\n';
const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::works`, expects: "add adds" }], suspected_defects: [],
  questions: [] });
const agent = () => new ScriptedAgent([[tool("write_file", { path: GEN, content: GEN_SOURCE })], [text(REPORT)],
  [text(REPORT)]]);

let repo = "";
function project(yaml: string): void {
  repo = initRepo(join(tmp(), "repo"));
  mkdirSync(join(repo, "src"));
  writeFileSync(join(repo, "package.json"), '{"devDependencies": {"typescript": "5.9.3", "vitest": "3.2.4"}}\n');
  writeFileSync(join(repo, "tsconfig.json"), '{"compilerOptions": {"strict": true}}\n');
  writeFileSync(join(repo, "src", "calc.ts"), "export const add = (a: number, b: number) => a + b;\n");
  // An error already there before the change.
  writeFileSync(join(repo, "src", "old.ts"), "export const n: number = 'x'; // TYPE-ERROR\n");
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(yaml), "Dev", "2026-10-20"));
  commit(repo, "start");
  // The change brings one more, in a changed file.
  writeFileSync(join(repo, "src", "calc.ts"), "export const add = (a: number, b: number) => a + b;\n" +
    "export const label: number = 'sum'; // TYPE-ERROR\n");
}
const events = (rdir: string) => readFileSync(join(rdir, EVENTS_FILE), "utf8").split("\n").filter(Boolean)
  .map((l) => JSON.parse(l) as TraceEvent);
const review = (settings = SETTINGS, seen: Seen[] = []) => runReview(repo, { settings, agentModel: agent(),
  challenger: new FakeJson([]), sessionFactory: sandbox(seen) });

describe("a review", () => {
  beforeEach(() => project(TYPED));

  test("reports the source's type errors, new and pre-existing, without the generated test's; tests run as ever",
    async () => {
      const seen: Seen[] = [];
      const { review: r, rdir } = await review(SETTINGS, seen);
      // The tests are untouched by the type check: they ran and reported, and nothing is a finding.
      expect([r.passed, r.missingRuns, r.findings.length]).toEqual([1, 0, 0]);
      expect(exitCode(r)).toBe(0);
      const msg = "Type 'string' is not assignable to type 'number'.";
      expect(r.typecheck).toEqual([{ project: "main", command: TSC, status: "errors", errors: 2, inChangedFiles: 1,
        new: 1, preExisting: 1, before: "compared", diagnostics: [
          { file: "src/calc.ts", line: 2, column: 7, code: "TS2322", message: msg, changed: true, new: true },
          { file: "src/old.ts", line: 1, column: 7, code: "TS2322", message: msg, changed: false, new: false },
        ], secs: 3 }]);
      // Once on the change, in the round's session after its final runs; once on the code before it, without
      // services, in a session of its own.
      expect(seen.map((s) => s.commands.filter((c) => c === TSC).length)).toEqual([1, 1]);
      expect(seen[0]!.commands.at(-1)).toBe(TSC);
      expect(seen[1]!.snap.endsWith("typecheck-before")).toBe(true);
      expect(seen[1]!.services).toBe(0);
      const md = readFileSync(join(rdir, "review.md"), "utf8");
      expect(md).toContain("\nType check: 2 type errors: 1 new with this change, 1 already there before it; 1 in " +
        "changed files\n(see Type check below).\n");
      const section = md.slice(md.indexOf("## Type check"), md.indexOf("## Not findings"));
      expect(section).toBe("## Type check\n\n" +
        "The project's own type check (`typecheck` in .arnx/review.yaml) ran once on the change, without\n" +
        "arnx's generated tests. It is information only: it changes no test, finding or exit code.\n\n" +
        "- Ran `npx tsc --noEmit -p tsconfig.json`: 2 type errors: 1 new with this change, 1 already there\n" +
        "  before it; 1 in changed files.\n" +
        "  - `src/calc.ts:2:7` TS2322 (new, changed file): Type 'string' is not assignable to type 'number'.\n" +
        "  - `src/old.ts:1:7` TS2322: Type 'string' is not assignable to type 'number'.\n\n");
      expect(summary(r, "review.md")).toContain("\n  Type check: 2 type errors: 1 new with this change, 1 already " +
        "there before it; 1 in changed files\n");
      const json = JSON.parse(readFileSync(join(rdir, "review.json"), "utf8")) as Record<string, unknown>;
      expect((json.typecheck as Record<string, unknown>[])[0]).toMatchObject({ project: "main", status: "errors",
        errors: 2, in_changed_files: 1, new: 1, pre_existing: 1, before: "compared" });
      expect(json.exit_code).toBe(0);
      expect(load(rdir).typecheck).toEqual(r.typecheck!);
      const ev = events(rdir);
      expect(ev.filter((e) => e.type === "typecheck.run").map((e) => [e.data.on, e.data.status, e.data.errors]))
        .toEqual([["change", "errors", 2], ["before", "errors", 1]]);
      expect(ev.find((e) => e.type === "typecheck.done")!.data).toEqual({ project: "main", status: "errors",
        errors: 2, in_changed_files: 1, new: 1, pre_existing: 1, before: "compared", secs: 3 });
    });

  test("errors about one module the type check cannot see are kept as a gap, and the report says they are not the change's",
    async () => {
      writeFileSync(join(repo, "src", "old.ts"), "export const n = 1;\n");
      writeFileSync(join(repo, "src", "calc.ts"), "export const add = (a: number, b: number) => a + b;\n" +
        "// GAP-ERROR\n// GAP-ERROR\n// GAP-ERROR\n");
      const { review: r, rdir } = await review();
      expect(r.typecheck![0]!.gaps).toEqual([{ kind: "generated", module: "@prisma/client", errors: 3 }]);
      expect(readFileSync(join(rdir, "review.md"), "utf8")).toContain("the type check cannot see @prisma/client " +
        "(3 errors); these errors say nothing about the change");
      expect((load(rdir).typecheck![0] as { gaps?: unknown }).gaps).toEqual(r.typecheck![0]!.gaps);
    });

  test("an error only in a generated test is left out: no type errors", async () => {
    writeFileSync(join(repo, "src", "calc.ts"), "export const add = (a: number, b: number) => a + b;\n");
    writeFileSync(join(repo, "src", "old.ts"), "export const n = 1;\n");
    const seen: Seen[] = [];
    const { review: r, rdir } = await review(SETTINGS, seen);
    expect(r.typecheck!.map((t) => [t.status, t.errors, t.before])).toEqual([["clean", 0, undefined]]);
    expect(seen).toHaveLength(1); // nothing to compare: no run on the code before the change
    expect(readFileSync(join(rdir, "review.md"), "utf8")).toContain("\nType check: no type errors.\n");
    // The generated test reached the report as ever.
    expect(readFileSync(join(rdir, "tests", GEN + COPY_SUFFIX), "utf8")).toBe(GEN_SOURCE);
  });

  test("with before_check = false the errors are not compared; a check that cannot run changes nothing else",
    async () => {
      const off: Seen[] = [];
      const { review: r } = await review({ ...SETTINGS, beforeCheck: false }, off);
      expect(off).toHaveLength(1);
      expect(r.typecheck![0]).toMatchObject({ status: "errors", errors: 2, inChangedFiles: 1 });
      expect(r.typecheck![0]!.before).toBeUndefined();
      expect(r.typecheck![0]!.new).toBeUndefined();
      expect(describeTypecheck(r.typecheck![0]!)).toBe("2 type errors; 1 in changed files");

      writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(`${YAML}typecheck: missing-tsc --noEmit\n`), "Dev",
        "2026-10-20"));
      const { review: broken, rdir } = await review();
      expect(broken.typecheck![0]).toMatchObject({ status: "failed", errors: 0,
        output: "sh: 1: missing-tsc: not found" });
      expect([broken.passed, broken.missingRuns, exitCode(broken)]).toEqual([1, 0, 0]);
      const md = readFileSync(join(rdir, "review.md"), "utf8");
      expect(md).toContain("Status\n\nComplete: the change was tested; every run reported its tests.\n");
      expect(md).toContain("\nType check: did not run: the command failed without reporting a type error (see Type " +
        "check below).\n");
      expect(md).toContain("\n  The end of its output:\n\n    sh: 1: missing-tsc: not found\n");
    });

  test("a change to the dependencies is not compared", async () => {
    writeFileSync(join(repo, "package.json"), '{"devDependencies": {"typescript": "5.9.3", "vitest": "3.2.5"}}\n');
    const seen: Seen[] = [];
    const { review: r } = await review(SETTINGS, seen);
    expect(seen).toHaveLength(1);
    expect(r.typecheck![0]!.before).toBe("dependencies-changed");
    expect(describeTypecheck(r.typecheck![0]!)).toBe("2 type errors (not compared with the code before the change: " +
      "the change alters the dependencies); 1 in changed files");
  });
});

test("a project without typecheck reviews exactly as before: no type check run, nothing in the report", async () => {
  project(YAML);
  const seen: Seen[] = [];
  const { review: r, rdir } = await review(SETTINGS, seen);
  expect(seen.flatMap((s) => s.commands).some((c) => c.includes("tsc"))).toBe(false);
  expect(r.typecheck).toBeUndefined();
  expect(readFileSync(join(rdir, "review.json"), "utf8")).not.toContain("typecheck");
  expect(readFileSync(join(rdir, "review.md"), "utf8")).not.toContain("Type check");
  expect(events(rdir).some((e) => e.type.startsWith("typecheck."))).toBe(false);
});

test("several projects: each type check is named after its project", () => {
  const r = sampleReview({ projects: ["web", "api"], typecheck: [
    { project: "web", command: TSC, status: "clean", errors: 0, inChangedFiles: 0, diagnostics: [], secs: 2 },
    { project: "api", command: TSC, status: "timed-out", errors: 0, inChangedFiles: 0, diagnostics: [],
      output: "[timed out]", secs: 600 }] });
  const md = render(r);
  expect(md).toContain("\nType check in `web`: no type errors.\nType check in `api`: timed out after 600 s (see Type " +
    "check below).\n");
  expect(md).toContain("\n- `web` ran `npx tsc --noEmit -p tsconfig.json`: no type errors.\n");
  expect(summary(r, "review.md")).toContain("\n  Type check (api): timed out after 600 s\n");
});

describe("workspaceNames", () => {
  const manifest = (dir: string, name: string) => {
    mkdirSync(join(dir), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name }));
  };
  test("declared workspace folders are the siblings; examples and node_modules are not", () => {
    const root = join(tmp(), "ws");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "top", workspaces: ["packages/*"] }));
    manifest(join(root, "packages", "core"), "@acme/core");
    manifest(join(root, "examples", "demo"), "left-pad");
    manifest(join(root, "packages", "core", "node_modules", "dep"), "dep");
    expect(workspaceNames(root)).toEqual(["@acme/core"]);
    // Without a declaration, every manifest below the root outside node_modules counts.
    const bare = join(tmp(), "bare");
    manifest(join(bare, "a"), "pa");
    manifest(join(bare, "node_modules", "x"), "nx");
    expect(workspaceNames(bare)).toEqual(["pa"]);
  });
});

describe("typeGaps", () => {
  const err = (code: string, message: string, file = "src/a.ts") => ({ file, line: 1, column: 1, code, message });
  const prisma = (file: string) => err("TS2305", `Module '"@prisma/client"' has no exported member 'User'.`, file);

  test("errors about one missing module are named as a gap", () => {
    const errors = [prisma("a.ts"), prisma("b.ts"), prisma("c.ts"),
      err("TS2307", "Cannot find module '@acme/core' or its corresponding type declarations."),
      err("TS2307", "Cannot find module '@acme/core' or its corresponding type declarations.", "src/b.ts"),
      err("TS2307", "Cannot find module '@acme/core/sub' or its corresponding type declarations.", "src/c.ts"),
      err("TS2307", "Cannot find module './local' or its corresponding type declarations.", "src/d.ts"),
      err("TS2307", "Cannot find module './local' or its corresponding type declarations.", "src/e.ts"),
      err("TS2307", "Cannot find module './local' or its corresponding type declarations.", "src/f.ts"),
      err("TS2322", "Type 'string' is not assignable to type 'number'.")];
    expect(typeGaps(errors, ["@acme/core"])).toEqual([
      { kind: "generated", module: "@prisma/client", errors: 3 },
      { kind: "sibling", module: "@acme/core", errors: 3 }]);
    expect(typeGaps([...errors.slice(0, 3), ...Array.from({ length: 3 }, (_, i) =>
      err("TS2307", "Cannot find module 'left-pad' or its corresponding type declarations.", `src/${i}.ts`))], []))
      .toEqual([{ kind: "generated", module: "@prisma/client", errors: 3 },
        { kind: "missing", module: "left-pad", errors: 3 }]);
  });

  test("scattered errors are not", () => {
    const errors = [prisma("a.ts"), prisma("b.ts"),
      err("TS2307", "Cannot find module 'x' or its corresponding type declarations."),
      err("TS2307", "Cannot find module 'y' or its corresponding type declarations."),
      err("TS2307", "Cannot find module 'z' or its corresponding type declarations."),
      err("TS2322", "Type 'string' is not assignable to type 'number'.")];
    expect(typeGaps(errors, [])).toEqual([]);
  });
});

describe("setup", () => {
  beforeEach(() => {
    repo = initRepo(join(tmp(), "repo"));
    mkdirSync(join(repo, "web", "src"), { recursive: true });
    writeFileSync(join(repo, "package.json"), '{"private": true, "workspaces": ["web"], ' +
      '"devDependencies": {"typescript": "5.9.3"}}\n');
    writeFileSync(join(repo, "web", "package.json"), '{"devDependencies": {"vitest": "3.2.4"}}\n');
    writeFileSync(join(repo, "web", "tsconfig.json"), "{}\n");
    writeFileSync(join(repo, "web", "src", "a.ts"), "export const n: number = 'x'; // TYPE-ERROR\n");
    commit(repo, "start");
  });

  test("a project with a tsconfig.json and typescript (here the workspace root's) can be type checked", () => {
    const read = (rel: string) => { try { return readFileSync(join(repo, rel), "utf8"); } catch { return ""; } };
    expect(typeCheckable(read, "web")).toBe(true);
    expect(typeCheckable(read, ".")).toBe(false); // no tsconfig.json at the root
    expect(detect(repo).candidates.find((c) => c.root === "web")!.evidence)
      .toContain("tsconfig.json and typescript: give it a typecheck");
    expect(detect(repo).candidates.find((c) => c.root === ".")!.evidence.join()).not.toContain("typecheck");
    // The setup agent's advice says it once more, and keeps the type check out of test_command.
    const hint = typescript.setupHints.split("\n").find((l) => l.includes("typecheck"))!;
    expect(hint).toContain("add typecheck");
    expect(hint).toContain("Keep it out of test_command");
  });

  const web = (typecheck: string | null) => `version: 1
projects:
  web:
    root: web
    language: typescript
    image: node:22
    test_command: npx vitest run {targets}
${typecheck ? `    typecheck: ${typecheck}\n` : ""}uncovered: []
`;

  test("the proof runs the type check once the suite runs: errors are information, a command that cannot run fails it",
    async () => {
      const cfg = (t: string) => parseReviewFile(web(t)).projects[0]!;
      const snap = join(tmp(), "snap");
      mkdirSync(join(snap, "web", "src"), { recursive: true });
      writeFileSync(join(snap, "web", "src", "a.ts"), "export const n: number = 'x'; // TYPE-ERROR\n");
      const [ok, summary] = await runSuite(cfg(TSC), snap, join(tmp(), "b.log"), { sessionFactory: sandbox() });
      expect([ok, summary]).toEqual([true, "1 passed; type check: 1 type error"]);
      // A command that cannot run is information too: the project's tests ran, so it stands.
      const [bad, why, tail] = await runSuite(cfg("missing-tsc"), snap, join(tmp(), "b.log"),
        { sessionFactory: sandbox() });
      expect([bad, why, tail]).toEqual([true, "1 passed; type check: failed without reporting a type error " +
        "(it could not start, or its output is not tsc's)", "sh: 1: missing-tsc: not found"]);
    });

  test("a type check with no time left does not stop a project whose tests ran", async () => {
    const snap = join(tmp(), "snap");
    mkdirSync(join(snap, "web", "src"), { recursive: true });
    writeFileSync(join(snap, "web", "src", "a.ts"), "export const n = 1;\n");
    const file = parseReviewFile(web("no-time-tsc")).projects[0]!;
    const [ok, summary] = await runSuite(file, snap, join(tmp(), "b.log"), { sessionFactory: sandbox() });
    expect(ok).toBe(true);
    expect(summary).toContain("not run");
    expect(summary).not.toContain("failed without reporting");
    // A type check that timed out stands too.
    const [slow, why] = await runSuite(parseReviewFile(web("slow-tsc")).projects[0]!, snap, join(tmp(), "b.log"),
      { sessionFactory: sandbox() });
    expect(slow).toBe(true);
    expect(why).toContain("timed out");
  });

  test("a quick setup's type check gets QUICK_TYPECHECK_TIMEOUT, a full one TYPECHECK_TIMEOUT", async () => {
    const cfg = parseReviewFile(web(TSC)).projects[0]!;
    const seen: number[] = [];
    const runner = { run: (_c: string, t: number): RunResult => {
      seen.push(t);
      return { exitCode: 0, output: "", timedOut: false, seconds: 0 };
    } };
    await typecheckNote(runner, cfg, true);
    await typecheckNote(runner, cfg, false);
    expect(seen).toEqual([QUICK_TYPECHECK_TIMEOUT, TYPECHECK_TIMEOUT]);
    expect(QUICK_TYPECHECK_TIMEOUT).toBe(180);
  });

  const twice = async (typecheck: string) => {
    const m = new ScriptedAgent([
      [tool("try_project", { yaml: web(typecheck) })],
      [tool("try_project", { yaml: web(typecheck) })],
      [tool("propose", { yaml: web(typecheck) })],
      [text("done")],
    ]);
    const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: sandbox() });
    const said = (call: number) => (m.calls[call]!.messages.at(-1)!.content as Record<string, unknown>[])
      .map((x) => String(x.content)).join("\n");
    return { r, said };
  };

  test("a gap goes back once, then is said under Worth a look", async () => {
    const { r, said } = await twice("gap-tsc");
    expect(said(1)).toContain("the type check cannot see @prisma/client (3 errors)");
    expect(said(1)).toContain("prisma generate");
    expect(said(1)).not.toContain("When every project runs, submit");
    // Tried again unchanged, the run stands and the proof keeps the gap.
    expect(said(2)).toContain("the suite of web runs");
    expect(r.ok).toBe(true);
    expect(r.projects[0]!.typeGaps).toEqual([{ kind: "generated", module: "@prisma/client", errors: 3 }]);
    expect(approvalChecks(parseReviewFile(web("gap-tsc")), r.projects)).toContain(
      "web: the type check cannot see @prisma/client (3 errors)");
  });

  test("approve says once that sibling packages are not built", () => {
    const proof = { name: "web", summary: "1 passed", skips: [],
      typeGaps: [{ kind: "sibling" as const, module: "@acme/core", errors: 5 }] };
    expect(approvalChecks(parseReviewFile(web(TSC)), [proof])).toEqual([
      "web: the type check cannot see @acme/core (5 errors)",
      "web: workspace packages are not built; arnx builds none of them (@acme/core)"]);
  });

  test("a type check that failed is proven, and approve names the problem in one short line", async () => {
    const { r, said } = await twice("missing-tsc");
    expect(said(1)).toContain("the type check of web: failed without reporting");
    expect(said(1)).toContain("sh: 1: missing-tsc: not found");
    expect(r.ok).toBe(true);
    expect(r.projects[0]!.typecheckProblem).toContain("failed without reporting a type error");
    const checks = approvalChecks(parseReviewFile(web("missing-tsc")), r.projects);
    expect(checks).toEqual(["web: type check failed without reporting a type error"]);
  });

  test("try_project tells the agent to add typecheck to a TypeScript project that can be type checked", async () => {
    const m = new ScriptedAgent([
      [tool("try_project", { yaml: web(null) })],
      [tool("try_project", { yaml: web(TSC) })],
      [tool("propose", { yaml: web(TSC) })],
      [text("done")],
    ]);
    const r = await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: sandbox() });
    const said = (call: number) => (m.calls[call]!.messages.at(-1)!.content as Record<string, unknown>[])
      .map((x) => String(x.content)).join("\n");
    expect(said(1)).toContain("web has a tsconfig.json and typescript among its dependencies: add typecheck (for " +
      "example npx tsc --noEmit -p tsconfig.json; deps_dir links node_modules for it too) and try it again.");
    expect(said(2)).toContain("the suite of web runs: 1 passed; type check: 1 type error.");
    expect(said(2)).not.toContain("add typecheck");
    expect(r.ok).toBe(true);
    expect(r.projects[0]!.summary).toBe("1 passed; type check: 1 type error");
  });
});

describe("a repository of several projects whose top-level project uses the folder holding the others", () => {
  const MONO = (check: string) => `version: 1
projects:
  top:
    root: .
    language: typescript
    image: node:22
    test_command: npx vitest run {targets}
    typecheck: ${check}
    owns: [scripts/, /tsconfig.json]
    uses: [packages/]
  api:
    root: packages/api
    language: typescript
    image: node:22
    test_command: npx vitest run {targets}
    owns: [packages/api/]
uncovered: []
`;
  function mono(check: string): void {
    repo = initRepo(join(tmp(), "mono"));
    mkdirSync(join(repo, "packages", "api", "src"), { recursive: true });
    writeFileSync(join(repo, "tsconfig.json"), '{"compilerOptions": {"strict": true}}\n');
    writeFileSync(join(repo, "packages", "api", "src", "calc.ts"), "export const add = (a: number, b: number) => a + b;\n");
    mkdirSync(dirname(reviewConfigPath(repo)));
    writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(MONO(check)), "Dev", "2026-10-20"));
    commit(repo, "start");
    writeFileSync(join(repo, "packages", "api", "src", "calc.ts"), "export const add = (a: number, b: number) => " +
      "a + b;\nexport const label: number = 'sum'; // TYPE-ERROR\n");
  }

  test("only the owner gets an agent round; top's type check still runs, finds the error, and the report says so",
    async () => {
      mono(TSC);
      const seen: Seen[] = [];
      const said: string[] = [];
      const { review: r, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent(),
        challenger: new FakeJson([]), sessionFactory: sandbox(seen), progress: (m) => said.push(m) });
      expect(r.projects).toEqual(["api"]);
      expect(r.typecheckOnly).toEqual([{ project: "top", by: ["api"] }]);
      // top's session: no services, the type check and nothing else (no agent, no test run).
      const tops = seen.filter((s) => s.cfg === "top");
      expect(tops.length).toBeGreaterThan(0);
      expect(tops.every((s) => s.services === 0)).toBe(true);
      expect(tops.flatMap((s) => s.commands).every((c) => c === TSC)).toBe(true);
      // The error api's change brings is in top's type check, as when top had its own round.
      const t = r.typecheck!.find((x) => x.project === "top")!;
      expect(t).toMatchObject({ status: "errors", inChangedFiles: 1 });
      expect(said).toContain("top: only its type check: its changed files are reviewed by api");
      const s = summary(r, "review.md");
      expect(s).toContain("  Type check only (top): its changed files reviewed by api");
      expect(s).toContain("Type check (top):");
      expect(render(r)).toContain("Type check only in `top`: the change reaches it through a folder holding other " +
        "projects, and `api` reviewed those files.");
      expect(load(rdir).typecheckOnly).toEqual([{ project: "top", by: ["api"] }]);
    });

  test("a type check that cannot run is reported as failed; the review completes", async () => {
    mono("missing-tsc --noEmit");
    const { review: r } = await runReview(repo, { settings: SETTINGS, agentModel: agent(),
      challenger: new FakeJson([]), sessionFactory: sandbox() });
    expect(r.projects).toEqual(["api"]);
    expect(r.typecheck!.find((x) => x.project === "top")).toMatchObject({ status: "failed" });
    expect(summary(r, "review.md")).toContain("Type check only (top)");
  });

  test("a docker failure on top's type check is the type check's: reported failed, the review completes", async () => {
    mono(TSC);
    const failing: SessionFactory = async (cfg, snap, log, body) => {
      if (cfg.name === "top") throw new Error("docker build failed");
      return sandbox()(cfg, snap, log, body);
    };
    const { review: r } = await runReview(repo, { settings: SETTINGS, agentModel: agent(),
      challenger: new FakeJson([]), sessionFactory: failing });
    expect(r.projects).toEqual(["api"]);
    expect(r.typecheck!.find((x) => x.project === "top")).toMatchObject({ status: "failed" });
  });
});

test("a project with no type check that routing passes over is named as having no round of its own", () => {
  const r = sampleReview({ projects: ["api"], typecheckOnly: [{ project: "shared", by: ["api"] }] });
  expect(summary(r, "review.md")).toContain("  No round of its own (shared): its changed files reviewed by api");
  expect(render(r)).toContain("No round of its own for `shared`: the change reaches it through a folder holding " +
    "other projects, and `api` reviewed those files.");
});

test("a web UI app whose tests run is no lost cause: a type check that cannot run does not stop it", async () => {
  const repo = initRepo(join(tmp(), "ui"));
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "package.json"), JSON.stringify({ dependencies: { "react-dom": "18.3.1" }, devDependencies: { vitest: "2" } }));
  writeFileSync(join(repo, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(repo, "src/own.test.ts"), "test('works', () => {});\n");
  commit(repo, "app");
  const yaml = (typecheck: string) => `version: 1\nprojects:\n  ui:\n    root: .\n    language: typescript\n    image: node:22\n` +
    `    test_command: npx vitest run {targets}\n${typecheck}`;
  const m = new ScriptedAgent([[tool("try_project", { yaml: yaml("    typecheck: missing-tsc\n"), project: "ui" })],
    [tool("try_project", { yaml: yaml(""), project: "ui" })], [text("done")]]);
  await runSetup(repo, defaultSettings(), m, { outDir: join(tmp(), "s"), sessionFactory: sandbox() });
  const said = (call: number) => (m.calls[call]!.messages.at(-1)!.content as Record<string, unknown>[])
    .map((r) => String(r.content)).join("\n");
  expect(said(1)).toContain("type check: failed without reporting");
  expect(said(1)).not.toContain("does not run yet");
  expect(said(1)).not.toContain("web UI");
});

describe("python type checks", () => {
  const pyFile = () => parseReviewFile(`version: 1
projects:
  api:
    root: .
    language: python
    image: python:3.12-slim
    test_command: python -m pytest -q {targets}
uncovered: []
`);
  const reader = (r: string) => (rel: string) => { try { return readFileSync(join(r, rel), "utf8"); } catch { return ""; } };

  test("a Python project whose CI runs a type checker says types are not checked", () => {
    const r = initRepo(join(tmp(), "py"));
    mkdirSync(join(r, ".github", "workflows"), { recursive: true });
    writeFileSync(join(r, ".github", "workflows", "main.yml"), "jobs:\n  t:\n    steps:\n      - run: mypy src\n");
    commit(r, "ci");
    expect(ciTypeChecker(r)).toEqual({ tool: "mypy", from: "main.yml" });
    expect(typecheckGaps(pyFile(), reader(r), r)).toEqual([
      "CI type checks with mypy (main.yml); arnx does not, so types are not checked for: api"]);
  });

  test("one whose CI runs none says nothing", () => {
    const r = initRepo(join(tmp(), "py"));
    mkdirSync(join(r, ".github", "workflows"), { recursive: true });
    writeFileSync(join(r, ".github", "workflows", "main.yml"), "jobs:\n  t:\n    steps:\n      - run: pytest\n");
    commit(r, "ci");
    expect(ciTypeChecker(r)).toBeNull();
    expect(typecheckGaps(pyFile(), reader(r), r)).toEqual([]);
  });

  const multiFile = () => parseReviewFile(`version: 1
projects:
  api:
    root: services/api
    language: python
    image: python:3.12-slim
    test_command: python -m pytest -q {targets}
  worker:
    root: services/worker
    language: python
    image: python:3.12-slim
    test_command: python -m pytest -q {targets}
  web:
    root: web
    language: typescript
    image: node:22
    test_command: npx vitest run {targets}
uncovered: []
`);
  const ciWith = (run: string) => {
    const r = initRepo(join(tmp(), "py"));
    mkdirSync(join(r, ".github", "workflows"), { recursive: true });
    writeFileSync(join(r, ".github", "workflows", "main.yml"), `jobs:\n  t:\n    steps:\n${run}`);
    commit(r, "ci");
    return r;
  };

  test("a repo with several Python projects gets one line naming them all", () => {
    const r = ciWith("      - run: mypy .\n");
    const gaps = typecheckGaps(multiFile(), reader(r), r);
    expect(gaps).toEqual(["CI type checks with mypy (main.yml); arnx does not, so types are not checked for: api, worker"]);
    expect(pythonTypeGap(multiFile(), r)).toEqual({ tool: "mypy", from: "main.yml", projects: ["api", "worker"] });
    expect(pythonTypeGap(multiFile(), r, ["worker"])).toEqual({ tool: "mypy", from: "main.yml", projects: ["worker"] });
    expect(pythonTypeGap(multiFile(), r, ["web"])).toBeNull();
  });

  test("review.md says which Python projects' types were not checked", () => {
    const r = sampleReview({ typesUnchecked: { tool: "mypy", from: "main.yml", projects: ["api", "worker"] } });
    expect(render(r)).toContain("- CI type checks with mypy (main.yml); arnx does not, so types are not checked for: `api`, `worker`");
    expect(render(sampleReview())).not.toContain("types are not checked");
  });

  test("a comment or an install line is not a type check", () => {
    const r = ciWith("      # TODO: add mypy later\n      - run: pip install mypy\n      - run: uv add --dev pyright # tools\n" +
      "      - run: pytest\n");
    expect(ciTypeChecker(r)).toBeNull();
    const r2 = ciWith("      - run: pip install mypy && mypy src\n");
    expect(ciTypeChecker(r2)).toEqual({ tool: "mypy", from: "main.yml" });
  });
});
