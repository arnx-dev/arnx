// `[review] context = "precise"`: the hunter's references by symbol from the project's SCIP index, built in its
// environment; any failure leaves the context on names.
import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import { contextPack } from "../src/context";
import { withEvents } from "../src/events";
import { INDEXERS, projectIndex } from "../src/indexer";
import { runReview } from "../src/reviewer";
import { sandboxOptions, type SessionFactory } from "../src/sandbox";
import { readIndex } from "../src/scip";
import { defaultSettings, loadSettings, settingsPath, writeSettings } from "../src/settings";
import { FakeJson, FakeSession, ScriptedAgent, text } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

// A SCIP index written by hand: Index.documents = 2; Document.relative_path = 1, occurrences = 2;
// Occurrence.range = 1 (packed), symbol = 2, symbol_roles = 3.
const varint = (n: number): number[] => {
  const out: number[] = [];
  for (; n >= 0x80; n = Math.floor(n / 128)) out.push((n % 128) | 0x80);
  return [...out, n];
};
const field = (no: number, wire: number, body: number[]) => [...varint(no * 8 + wire), ...body];
const bytes = (no: number, body: number[]) => field(no, 2, [...varint(body.length), ...body]);
const str = (no: number, s: string) => bytes(no, [...new TextEncoder().encode(s)]);
interface Occ { line: number; col: number; len: number; symbol: string; def?: boolean }
const occurrence = (o: Occ) => [...bytes(1, [o.line, o.col, o.col + o.len].flatMap(varint)), ...str(2, o.symbol),
  ...(o.def ? field(3, 0, varint(1)) : [])];
const scip = (docs: Record<string, Occ[]>) => new Uint8Array([...str(1, "metadata, skipped"),
  ...Object.entries(docs).flatMap(([path, occs]) => bytes(2, [...str(1, path), ...occs.flatMap((o) => bytes(2, occurrence(o)))]))]);

/** An occurrence of `name` on 0-based `line` of `text`. */
const at = (text: string, line: number, name: string, symbol: string, def = false): Occ =>
  ({ line, col: text.split("\n")[line]!.indexOf(name), len: name.length, symbol, def });

test("the index reader keeps each occurrence's file, line, columns, symbol and roles; locals by line only", () => {
  const buf = new Uint8Array([...scip({ "a.py": [{ line: 0, col: 4, len: 3, symbol: "py a/run().", def: true },
    { line: 2, col: 0, len: 3, symbol: "py a/run()." }, { line: 1, col: 0, len: 1, symbol: "local 0" }] }),
    // unpacked range, a four-number range over two lines, an unknown field
    ...bytes(2, [...str(1, "b.py"), ...bytes(2, [...field(1, 0, varint(5)), ...field(1, 0, varint(2)),
      ...field(1, 0, varint(5)), ...str(2, "py a/run()."), ...field(9, 0, varint(7))]),
    ...bytes(2, [...bytes(1, [1, 0, 3, 1].flatMap(varint)), ...str(2, "py b/Q.")])])]);
  const ix = readIndex(buf, "svc/");
  expect([...ix.byFileLine.keys()]).toEqual(["svc/a.py", "svc/b.py"]);
  expect(ix.bySymbol.get("py a/run().")).toEqual([
    { file: "svc/a.py", line: 1, start: 4, end: 7, symbol: "py a/run().", roles: 1 },
    { file: "svc/a.py", line: 3, start: 0, end: 3, symbol: "py a/run().", roles: 0 },
    { file: "svc/b.py", line: 6, start: 2, end: 5, symbol: "py a/run().", roles: 0 }]);
  expect(ix.bySymbol.get("py b/Q.")![0]!.end).toBe(Number.MAX_SAFE_INTEGER);
  expect(ix.bySymbol.has("local 0")).toBe(false);
  expect(ix.byFileLine.get("svc/a.py")!.get(2)!.map((o) => o.symbol)).toEqual(["local 0@svc/a.py"]);
  expect([...ix.defined]).toEqual(["py a/run()."]);
  expect(() => readIndex(new Uint8Array([0x12, 0x05, 0x0a]))).toThrow("SCIP index");
});

const JOBS = "def evaluate(pg):\n    return pg\n";
const MAIN = "import jobs\n\ndef run_once(pg):\n    for step in (jobs.evaluate, jobs.score):\n        step(pg)\n\n" +
  "def main():\n    run_once(None)\n";
const OTHER = "def evaluate(x):\n    return x\n\ndef check():\n    return evaluate(1)\n\ndef tally(evaluate):\n" +
  "    return evaluate + 1\n";
const NAMES = "STEPS = [\"evaluate\"]\n";
const DIFF = "diff --git a/app/jobs.py b/app/jobs.py\n--- a/app/jobs.py\n+++ b/app/jobs.py\n@@ -1,2 +1,2 @@\n" +
  " def evaluate(pg):\n-    return None\n+    return pg\n";

function project(): string {
  const root = tmp();
  mkdirSync(join(root, "app"), { recursive: true });
  for (const [f, body] of [["jobs.py", JOBS], ["main.py", MAIN], ["other.py", OTHER], ["names.py", NAMES]]) {
    writeFileSync(join(root, "app", f!), body!);
  }
  return root;
}

/** The project's index as an indexer run in `app` writes it (paths relative to the project). */
const appIndex = () => scip({
  "jobs.py": [at(JOBS, 0, "evaluate", "py jobs/evaluate().", true)],
  "main.py": [at(MAIN, 2, "run_once", "py main/run_once().", true), at(MAIN, 3, "evaluate", "py jobs/evaluate()."),
    at(MAIN, 6, "main", "py main/main().", true), at(MAIN, 7, "run_once", "py main/run_once().")],
  "other.py": [at(OTHER, 0, "evaluate", "py other/evaluate().", true), at(OTHER, 3, "check", "py other/check().", true),
    at(OTHER, 4, "evaluate", "py other/evaluate()."), at(OTHER, 6, "tally", "py other/tally().", true),
    at(OTHER, 6, "evaluate", "local 1", true), at(OTHER, 7, "evaluate", "local 1")],
  "names.py": [at(NAMES, 0, "STEPS", "py names/STEPS.", true)] });

test("with the index, a same-named definition elsewhere drops out; uses the indexer cannot see stay", () => {
  const root = project();
  const names = contextPack(root, DIFF, ["app/jobs.py"], ["app"]);
  expect(names).toContain("app/other.py:5 in check: return evaluate(1)"); // another module's evaluate
  expect(names).toContain("app/other.py:8 in tally: return evaluate + 1"); // a parameter of that name
  const precise = contextPack(root, DIFF, ["app/jobs.py"], ["app"], 60_000, readIndex(appIndex(), "app/"));
  expect(precise).toBe([
    "- `app/jobs.py` function `evaluate` (line 1): 2 references",
    "  - app/main.py:4 in run_once: for step in (jobs.evaluate, jobs.score):",
    "    - `run_once` is used at app/main.py:8 (main)",
    "  - app/names.py:1 in STEPS: STEPS = [\"evaluate\"]"].join("\n"));
});

test("without the changed definition in the index the context is the names one, byte for byte", () => {
  const root = project();
  const names = contextPack(root, DIFF, ["app/jobs.py"], ["app"]);
  const elsewhere = readIndex(scip({ "other.py": [at(OTHER, 0, "evaluate", "py other/evaluate().", true)] }), "app/");
  expect(contextPack(root, DIFF, ["app/jobs.py"], ["app"], 60_000, elsewhere)).toBe(names);
  expect(contextPack(root, DIFF, ["app/jobs.py"], ["app"], 60_000, null)).toBe(names);
});

/** A docker that has every image except the indexer layer until it is built, and whose `run` writes `index`. */
function fakeDocker(index: Uint8Array | null, runExit = 0): { calls: () => string[]; dockerfile: () => string } {
  const dir = tmp();
  writeFileSync(join(dir, "index.scip"), index ?? new Uint8Array());
  writeFileSync(join(dir, "docker"), `#!/bin/sh
echo "$*" >> '${dir}/calls'
case "$1" in
  info) echo 27.0; exit 0;;
  image) case "$3" in *-scip1) [ -f '${dir}/built' ] && exit 0; exit 1;; esac; exit 0;;
  build) cat > '${dir}/Dockerfile'; touch '${dir}/built'; exit 0;;
  run) [ ${runExit} -ne 0 ] && { echo "indexer crashed" >&2; exit ${runExit}; }
    for a in "$@"; do case "$a" in *:/arnx-index) ${index ? `cp '${dir}/index.scip' "\${a%:/arnx-index}/index.scip"` : "true"};; esac; done; exit 0;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  return { calls: () => readFileSync(join(dir, "calls"), "utf8").trim().split("\n"),
    dockerfile: () => existsSync(join(dir, "Dockerfile")) ? readFileSync(join(dir, "Dockerfile"), "utf8") : "" };
}

const saved = sandboxOptions.docker;
afterEach(() => {
  sandboxOptions.docker = saved;
});

const CFG = parseReviewFile(`version: 1
projects:
  app:
    root: app
    image: node:22
    language: typescript
    runner: vitest
    test_command: ln -sfn /opt/deps/node_modules /src/node_modules; vitest run {targets}
`).projects[0]!;

test("the indexer runs like a test run: no network, the project's links, its own output folder", async () => {
  const docker = fakeDocker(appIndex());
  const out = tmp();
  const events: Record<string, unknown>[] = [];
  const r = await withEvents({ emit: (type: string, data: Record<string, unknown>) => events.push({ type, ...data }) } as never,
    () => projectIndex(CFG, project(), out));
  expect(r.reason).toBeUndefined();
  expect(r.index!.bySymbol.get("py jobs/evaluate().")![0]!.file).toBe("app/jobs.py");
  expect(docker.dockerfile()).toContain("@sourcegraph/scip-typescript@0.4.0");
  const run = docker.calls().find((c) => c.startsWith("run "))!;
  expect(run).toContain("--network none");
  expect(run).toContain(`${join(out, "index")}:/arnx-index`);
  expect(run).toContain("ln -sfn /opt/deps/node_modules /src/node_modules; scip-typescript index --output /arnx-index/index.scip");
  expect(run).not.toContain("vitest");
  expect(events).toEqual([expect.objectContaining({ type: "context.index", project: "app", ok: true, files: 4 })]);
  // Built once: a second index reuses the layer.
  await projectIndex(CFG, project(), tmp());
  expect(docker.calls().filter((c) => c.startsWith("build ")).length).toBe(1);
});

test("a failing indexer, an empty index, or a language without one leaves the context on names, with the reason", async () => {
  fakeDocker(appIndex(), 3);
  const crashed = await projectIndex(CFG, project(), tmp());
  expect([crashed.index, crashed.reason]).toEqual([null, "the indexer exited with 3: indexer crashed"]);
  fakeDocker(null);
  expect((await projectIndex(CFG, project(), tmp())).reason).toContain("ENOENT");
  fakeDocker(scip({}));
  expect((await projectIndex(CFG, project(), tmp())).reason).toBe("the index holds no files");
  expect(INDEXERS.csharp).toBeUndefined();
  expect((await projectIndex({ ...CFG, language: "csharp" }, project(), tmp())).reason).toBe("no indexer for csharp");
});

test("context is names unless the config says precise, and nothing else is accepted", () => {
  const repo = tmp();
  const s = { ...defaultSettings(), consentAt: "2026-10-25T00:00:00Z" };
  writeSettings(repo, s);
  expect(readFileSync(settingsPath(repo), "utf8")).not.toContain("context");
  expect(loadSettings(repo).context).toBe("names");
  writeSettings(repo, { ...s, context: "precise" });
  expect(readFileSync(settingsPath(repo), "utf8")).toContain("context = \"precise\"");
  expect(loadSettings(repo)).toEqual({ ...s, context: "precise" });
  writeFileSync(settingsPath(repo), readFileSync(settingsPath(repo), "utf8").replace("\"precise\"", "\"graph\""));
  expect(() => loadSettings(repo)).toThrow("review.context: write \"names\" or \"precise\"");
});

test("a review with context = precise hunts on the indexed context; without an index it says so and uses names",
  async () => {
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "app"), { recursive: true });
  for (const [f, body] of [["jobs.py", "def evaluate(pg):\n    return None\n"], ["main.py", MAIN], ["other.py", OTHER],
    ["names.py", NAMES]]) writeFileSync(join(repo, "app", f!), body!);
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile("version: 1\nprojects:\n  app:\n    root: app\n" +
    "    image: python:3.12-slim\n    test_command: python -m pytest {targets}\n"), "Dev", "2026-10-25"));
  commit(repo, "layout");
  writeFileSync(join(repo, "app/jobs.py"), JOBS);
  const session: SessionFactory = async (_cfg, snap, _log, body) =>
    body(new FakeSession(snap, () => [junitXml([]), "no tests ran", false]));
  const settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-10-25T00:00:00Z", context: "precise" as const };
  const reply = text(JSON.stringify({ suspects: [], questions: [] }));
  const done = text(JSON.stringify({ tests: [], suspected_defects: [], questions: [] }));
  const hunted = async (indexer: typeof projectIndex) => {
    const agent = new ScriptedAgent([[reply], [done], [done]]);
    const progress: string[] = [];
    await runReview(repo, { settings, agentModel: agent, challenger: new FakeJson([{ suspects: [] }]),
      sessionFactory: session, hunt: true, indexer, progress: (m) => progress.push(m) });
    return { first: String(agent.calls[0]!.messages[0]!.content), progress };
  };
  const indexed = await hunted(async () => ({ index: readIndex(appIndex(), "app/"), secs: 1 }));
  expect(indexed.first).toContain("app/names.py:1");
  expect(indexed.first).not.toContain("app/other.py:5");
  expect(indexed.progress).toContain("app (1/1): indexing the code");
  const none = await hunted(async () => ({ index: null, secs: 0, reason: "the indexer exited with 1" }));
  expect(none.first).toContain("app/other.py:5 in check");
  expect(none.progress).toContain("app (1/1): no code index (the indexer exited with 1); context by names");
});
