import { beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { backtracks, grepLimits, runAgent, ToolError, Workspace } from "../src/agent";
import { ModelError } from "../src/errors";
import { type Attempt, billedError, PRICES, type Reply } from "../src/llm";
import { ScriptedAgent, text, tool } from "./helpers/fakes";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
let root = "";
beforeEach(() => {
  root = join(tmp(), "repo");
  mkdirSync(join(root, "pkg"), { recursive: true });
  writeFileSync(join(root, "pkg", "mod.py"), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n") + "\n");
  writeFileSync(join(root, "blob.bin"), Buffer.from(Array.from({ length: 100 }, () => [0, 1, 255]).flat()));
  writeFileSync(join(root, "latin.txt"), Buffer.from("caf\xe9 needle\n", "latin1"));
  mkdirSync(join(root, "tests", "gen"), { recursive: true });
});

test("test_read_pages_and_binary", async () => {
  const ws = new Workspace(root);
  const page = await ws.call("read_file", { path: "pkg/mod.py" });
  expect(page.startsWith("1\tline 1")).toBe(true);
  expect(page).toContain("start_line=401");
  expect((await ws.call("read_file", { path: "pkg/mod.py", start_line: 500 })).startsWith("500\tline 500")).toBe(true);
  expect(await ws.call("read_file", { path: "blob.bin" })).toContain("binary");
  expect(await ws.call("grep", { pattern: "needle" })).toContain("latin.txt:1:");
});

test("test_confinement", async () => {
  writeFileSync(join(tmp(), "outside.txt"), "x");
  writeFileSync(join(root, ".env"), "A=1");
  const ws = new Workspace(root, { writeDir: "tests/gen", runTests: (t) => `ran ${JSON.stringify(t)}` });
  for (const [name, args] of [["read_file", { path: "../outside.txt" }], ["read_file", { path: ".env" }],
    ["write_file", { path: "pkg/mod.py", content: "x" }], ["write_file", { path: "tests/gen/notes.txt", content: "x" }],
    ["run_tests", { targets: ["pkg"] }]] as const) {
    await expect(ws.call(name, args)).rejects.toThrow(ToolError);
  }
  expect((await ws.call("write_file", { path: "tests/gen/test_a.py", content: "def test_a(): pass\n" }))
    .startsWith("wrote")).toBe(true);
  expect(await ws.call("run_tests", {})).toBe('ran ["tests/gen"]');
});

test("test_tools_offered", () => {
  expect(new Workspace(".", { writeDir: null }).tools().map((t) => t.name)).toEqual(["list_dir", "read_file", "grep"]);
});

test("test_loop_runs_tools_and_logs", async () => {
  const model = new ScriptedAgent([
    [text("looking"), tool("list_dir", { path: "pkg" })],
    [tool("write_file", { path: "tests/gen/test_x.py", content: "def test_x(): assert True\n" }), tool("no_such_tool")],
    [text('{"tests": []}')],
  ]);
  const ws = new Workspace(root, { writeDir: "tests/gen", runTests: () => "ok" });
  const result = await runAgent(model, ws, { system: "s", user: "u", budgetUsd: 1.0, prices: PRICES,
    transcript: join(tmp(), "t.jsonl") });
  expect([result.stop, result.finalText, result.turns]).toEqual(["end_turn", '{"tests": []}', 3]);
  const toolResults = model.calls[2]!.messages.at(-1)!.content as Record<string, unknown>[];
  expect(toolResults[1]!.is_error).toBe(true);
  expect(String(toolResults[1]!.content)).toContain("unknown tool");
  expect(existsSync(join(root, "tests/gen/test_x.py"))).toBe(true);
  const lines = readFileSync(join(tmp(), "t.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const turns = lines.filter((l) => "stop_reason" in l);
  expect(turns).toHaveLength(3);
  expect(turns[0].tools[0].name).toBe("list_dir");
  // After each turn's tools, one line times them and sizes their results, without their contents.
  const ran = lines.filter((l) => "tools_ran" in l);
  expect(ran.map((l) => l.turn)).toEqual([1, 2]);
  expect(ran[1].tools_ran.map((t: Record<string, unknown>) => [t.name, t.error ?? false]))
    .toEqual([["write_file", false], ["no_such_tool", true]]);
  expect(ran[0].tools_ran[0].bytes).toBeGreaterThan(0);
  expect(typeof ran[0].tools_ran[0].ms).toBe("number");
  expect(JSON.stringify(ran)).not.toContain("test_x");
});

test("every priced reply adds to the running spend once", async () => {
  const { spend } = await import("../src/spend");
  const before = spend.total;
  const model = new ScriptedAgent([[tool("list_dir", { path: "pkg" })], [text("done")]]);
  const result = await runAgent(model, new Workspace(root), { system: "s", user: "u", budgetUsd: 1.0, prices: PRICES,
    transcript: join(tmp(), "t.jsonl") });
  expect(result.costUsd).toBeGreaterThan(0);
  expect(spend.total - before).toBeCloseTo(result.costUsd, 9);
});

test("test_budget_stops_the_loop", async () => {
  const model = new ScriptedAgent(Array.from({ length: 10 }, () => [tool("list_dir", { path: "." })]),
    { input: 100_000, output: 10_000, cacheRead: 0, cacheWrite: 0 });
  const result = await runAgent(model, new Workspace(root), { system: "s", user: "u", budgetUsd: 0.5, prices: PRICES,
    transcript: join(tmp(), "t.jsonl") });
  expect(result.stop).toBe("budget");
  expect(result.costUsd).toBeGreaterThanOrEqual(0.5);
  expect(model.calls).toHaveLength(2);
});

test("test_api_error_stops", async () => {
  class Failing extends ScriptedAgent {
    override async create(): Promise<Reply> {
      throw new ModelError("HTTP 529: overloaded");
    }
  }
  const result = await runAgent(new Failing([]), new Workspace(root), { system: "s", user: "u", budgetUsd: 1,
    prices: PRICES, transcript: join(tmp(), "t.jsonl") });
  expect(result.stop.startsWith("api_error")).toBe(true);
  expect(result.stop).toContain("529");
});

test("a failed call that was billed counts in the agent's cost and usage", async () => {
  class BilledThenFail extends ScriptedAgent {
    n = 0;
    override async create(r: Parameters<ScriptedAgent["create"]>[0]): Promise<Reply> {
      if (this.n++ === 0) return super.create(r);
      throw billedError("did not finish", 0.25, { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0 });
    }
  }
  const result = await runAgent(new BilledThenFail([[tool("list_files", {})]]), new Workspace(root),
    { system: "s", user: "u", budgetUsd: 5, prices: PRICES, transcript: join(tmp(), "t.jsonl") });
  expect(result.stop.startsWith("api_error")).toBe(true);
  expect(result.costUsd).toBeGreaterThanOrEqual(0.25);
  expect(result.usage.input).toBeGreaterThanOrEqual(1000);
});

test("the agent's result counts the calls whose usage never came: cut-off attempts before a reply, and a failed call", async () => {
  class CutThenFail extends ScriptedAgent {
    override async create(o: Parameters<ScriptedAgent["create"]>[0]): Promise<Reply> {
      if (this.calls.length === 1) throw Object.assign(new ModelError("stream cut"), { unknownCalls: 2 });
      return { ...await super.create(o), unknownCalls: 1 };
    }
  }
  const result = await runAgent(new CutThenFail([[tool("list_dir", { path: "pkg" })]]), new Workspace(root),
    { system: "s", user: "u", budgetUsd: 1, prices: PRICES, transcript: join(tmp(), "t.jsonl") });
  expect([result.calls, result.unknownCalls]).toEqual([1, 3]);
});

test("a model error is written to the transcript with its timeout flag and attempts", async () => {
  const attempts: Attempt[] = [{ secs: 30, firstEventSecs: null, longestGapSecs: 0, events: 0, outcome: "stalled",
    timeout: "idle" }];
  class Failing extends ScriptedAgent {
    override async create(): Promise<Reply> {
      throw Object.assign(new ModelError("no reply within 30s"), { timedOut: true, attempts });
    }
  }
  const transcript = join(tmp(), "t.jsonl");
  await runAgent(new Failing([]), new Workspace(root), { system: "s", user: "u", budgetUsd: 1, prices: PRICES,
    transcript });
  const lines = readFileSync(transcript, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const last = lines[lines.length - 1];
  expect(last).toMatchObject({ stop_reason: "api_error", error: "no reply within 30s", timed_out: true, attempts });
});

test("grep refuses a long pattern", async () => {
  await expect(new Workspace(root).call("grep", { pattern: "a".repeat(501) })).rejects.toThrow(ToolError);
});

test("grep refuses the usual backtracking shapes before matching anything", async () => {
  for (const p of ["(a+)+", "(a*)*", "(\\w+\\s?)*", "x(?:ab?)+y", "((a+)b)*", "(a+){2,}", "(a*a*)+", "a*a*a*",
    ".*.*.*", "a*\\w*a*", "\\w+\\d*", ".*\\w*", "[A-Z0-9_]+[A-Z_]*"]) {
    expect(backtracks(p)).toBe(true);
  }
  // Two in a row where the second takes all the first does are linear in practice.
  for (const p of ["needle", "def \\w+\\(", "(foo|bar)+", "\\s*\\w+", "[a-z]+[0-9]+", "(\\w+)\\s*=", "a*b*",
    "import .*", "x{2}(ab){3}", "a*ba*", "(a{2})+", "a\\*a*", "[(a+)]+", "\\(a+\\)+", "\\w+.*", "[A-Z_]+[A-Z0-9_]*",
    "a*a*", ".*.*", "a+\\w+", "\\d+\\w*\\s+\\w+"]) {
    expect(backtracks(p)).toBe(false);
  }
  writeFileSync(join(root, "slow.txt"), "a".repeat(600) + "\n");
  const started = Date.now();
  await expect(new Workspace(root).call("grep", { pattern: "a*a*a*b" })).rejects.toThrow("pattern too slow");
  expect(Date.now() - started).toBeLessThan(500);
});

test("grep stops a pattern that backtracks without end", async () => {
  // a shape the check above lets through: about 7 s unbounded under Bun, longer under Node
  writeFileSync(join(root, "slow.txt"), "a".repeat(400) + "\n");
  const started = Date.now();
  expect(backtracks("a*.?a*.?a*b")).toBe(false);
  await expect(new Workspace(root).call("grep", { pattern: "a*.?a*.?a*b" })).rejects.toThrow("pattern too slow");
  expect(Date.now() - started).toBeLessThan(4000);
  expect(await new Workspace(root).call("grep", { pattern: "needle" })).toContain("latin.txt:1:");
});

test("grep's time limit counts matching only: a literal grep over 6,000 files finds its matches", async () => {
  for (let d = 0; d < 60; d++) {
    mkdirSync(join(root, "many", `d${d}`), { recursive: true });
    for (let f = 0; f < 100; f++) {
      writeFileSync(join(root, "many", `d${d}`, `f${f}.py`), `x = ${f}\n` + (d === 59 && f === 99 ? "marker\n" : "") +
        "def handler(request):\n    return request\n".repeat(20));
    }
  }
  const ws = new Workspace(root);
  expect(await ws.call("grep", { pattern: "marker", path: "many" })).toBe("many/d59/f99.py:2: marker");
  // Walking and reading 6,000 files takes longer than this; matching a literal in them does not.
  grepLimits.ms = 300;
  try {
    expect(await ws.call("grep", { pattern: "marker", path: "many" })).toBe("many/d59/f99.py:2: marker");
  } finally {
    grepLimits.ms = 2000;
  }
}, 30_000);

test("a regex grep skips lines over 10,000 characters and says so; a literal one still searches them", async () => {
  mkdirSync(join(root, "web"), { recursive: true });
  writeFileSync(join(root, "web", "app.min.js"), "var a=1;".repeat(112_500) + "\nneedle zzz\n");
  writeFileSync(join(root, "web", "b.js"), "x".repeat(20_000) + "needle\n" + "abc zzz\n");
  const ws = new Workspace(root);
  const started = Date.now();
  expect(await ws.call("grep", { pattern: "\\w+.*zzz", path: "web" })).toBe("web/app.min.js:2: needle zzz\n" +
    "web/b.js:2: abc zzz\n2 lines over 10,000 characters skipped (minified or generated)");
  expect(Date.now() - started).toBeLessThan(1500);
  expect(await ws.call("grep", { pattern: "needle", path: "web" })).toBe("web/app.min.js:2: needle zzz\n" +
    `web/b.js:1: ${"x".repeat(200)}`);
});

test("a grep stopped by its time limit returns the matches it found, then why it stopped", async () => {
  mkdirSync(join(root, "part"), { recursive: true });
  // the first batch (over 1 MB) holds the match; the second holds a line the pattern backtracks on
  writeFileSync(join(root, "part", "a0.txt"), "b\n" + `${"x".repeat(100)}\n`.repeat(11_000));
  writeFileSync(join(root, "part", "a1.txt"), "a".repeat(400) + "\n");
  grepLimits.ms = 300;
  try {
    expect(await new Workspace(root).call("grep", { pattern: "a*.?a*.?a*b", path: "part" })).toBe("part/a0.txt:1: b\n" +
      "... stopped: pattern too slow (over 0.3 s): simplify it, e.g. no nested or stacked quantifiers like (a+)+ or a*a*a*");
  } finally {
    grepLimits.ms = 2000;
  }
});

test("grep skips files over the size limit", async () => {
  writeFileSync(join(root, "big.txt"), "needle\n" + "x".repeat(2_000_001));
  const out = await new Workspace(root).call("grep", { pattern: "needle" });
  expect(out).toContain("latin.txt:1:");
  expect(out).not.toContain("big.txt");
});

test("run_tests accepts targets sent as a JSON string or a single path", async () => {
  const seen: string[][] = [];
  const ws = new Workspace(root, { writeDir: "tests/gen", runTests: (t) => { seen.push(t); return "ok"; } });
  await ws.call("run_tests", { targets: '["tests/gen/test_a.py"]' });
  await ws.call("run_tests", { targets: "tests/gen/test_b.py" });
  expect(seen).toEqual([["tests/gen/test_a.py"], ["tests/gen/test_b.py"]]);
});
