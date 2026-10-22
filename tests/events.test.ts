import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { clip, emit, emitModelCall, emitTurn, EventLog, hypId, providerOf, withEvents, withRole } from "../src/events";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const TRACE = "20261016-abc123";
const readLines = (p: string) => readFileSync(p, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const call = { provider: "anthropic", model: "m", ok: true, input: 1, output: 1, cache_read: 0, cache_write: 0,
  cost_usd: 0, latency_ms: 1, unknown_usage: 0, timed_out: false };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("emit outside any withEvents writes nothing and does not throw", () => {
  const path = join(tmp(), "events.jsonl");
  expect(() => emit("report.done", { findings: 0 })).not.toThrow();
  expect(() => emitModelCall({ ...call, role: "reviewer" })).not.toThrow();
  expect(existsSync(path)).toBe(false);
});

test("inside withEvents, two emits write two lines with the envelope fields", () => {
  const path = join(tmp(), "events.jsonl");
  let t = 0;
  const log = new EventLog(path, TRACE, () => new Date(Date.UTC(2026, 9, 16, 10, 0, t++)));
  withEvents(log, () => {
    emit("review.failed", { error: "boom", name: "Error" });
    emit("report.done", { findings: 2 });
  });
  const lines = readLines(path);
  expect(lines).toEqual([
    { schema_version: 1, trace_id: TRACE, seq: 1, at: "2026-10-16T10:00:00.000Z", type: "review.failed",
      data: { error: "boom", name: "Error" } },
    { schema_version: 1, trace_id: TRACE, seq: 2, at: "2026-10-16T10:00:01.000Z", type: "report.done",
      data: { findings: 2 } },
  ]);
});

test("a new EventLog on an existing file with 2 lines continues at seq 3", () => {
  const path = join(tmp(), "events.jsonl");
  writeFileSync(path, '{"seq":1}\n{"seq":2}\n');
  withEvents(new EventLog(path, TRACE), () => emit("report.done", {}));
  expect(readLines(path).map((e) => e.seq)).toEqual([1, 2, 3]);
  expect(readLines(path)[2].trace_id).toBe(TRACE);
});

test("withRole nests: inner role and finding, then the outer role without finding", () => {
  const path = join(tmp(), "events.jsonl");
  withEvents(new EventLog(path, TRACE), () => {
    withRole("reviewer", () => {
      withRole("challenge", () => emitModelCall({ ...call }), { finding: "F1" });
      emitModelCall({ ...call });
    }, { project: "api" });
  });
  const [inner, outer] = readLines(path).map((e) => e.data);
  expect(inner.role).toBe("challenge");
  expect(inner.project).toBe("api");
  expect(inner.finding).toBe("F1");
  expect(outer.role).toBe("reviewer");
  expect(outer.project).toBe("api");
  expect(outer.finding).toBeUndefined();
});

test("two concurrent withRole scopes keep their own roles across awaits", async () => {
  const path = join(tmp(), "events.jsonl");
  await withEvents(new EventLog(path, TRACE), () => Promise.all([
    withRole("reviewer", async () => {
      await sleep(10);
      emitModelCall({ ...call, model: "one" });
    }),
    withRole("challenge", async () => {
      await sleep(1);
      emitModelCall({ ...call, model: "two" });
    }),
  ]));
  const roles = Object.fromEntries(readLines(path).map((e) => [e.data.model, e.data.role]));
  expect(roles).toEqual({ one: "reviewer", two: "challenge" });
});

test("emitModelCall with an explicit role overrides the scope role", () => {
  const path = join(tmp(), "events.jsonl");
  withEvents(new EventLog(path, TRACE), () => {
    withRole("reviewer", () => emitModelCall({ ...call, role: "jev" }));
  });
  expect(readLines(path)[0].data.role).toBe("jev");
});

test("an explicit undefined role in model-call data keeps the scope role", () => {
  const path = join(tmp(), "events.jsonl");
  withEvents(new EventLog(path, TRACE), () => {
    withRole("reviewer", () => emitModelCall({ ...call, role: undefined }));
  });
  expect(readLines(path)[0].data.role).toBe("reviewer");
});

test("emitTurn inside nested scopes writes the inner role and the merged extra fields", () => {
  const path = join(tmp(), "events.jsonl");
  withEvents(new EventLog(path, TRACE), () => {
    withRole("reviewer", () => {
      withRole("challenge", () => emitTurn({ turn: 2, stop_reason: "end_turn", tools: ["read"] }),
        { finding: "F1" });
    }, { project: "api" });
  });
  expect(readLines(path)[0].data).toEqual({ role: "challenge", project: "api", finding: "F1", turn: 2,
    stop_reason: "end_turn", tools: ["read"] });
});

test("an EventLog whose path is a directory: emit does not throw", () => {
  const dir = join(tmp(), "events.jsonl");
  mkdirSync(dir);
  const log = new EventLog(dir, TRACE);
  expect(() => withEvents(log, () => emit("report.done", {}))).not.toThrow();
});

test("hypId is the trace, project and suspect id inside withEvents, and has an empty trace outside", () => {
  const path = join(tmp(), "events.jsonl");
  withEvents(new EventLog(path, TRACE), () => expect(hypId("api", "S2")).toBe(`${TRACE}:api:S2`));
  expect(hypId("api", "S2")).toBe(":api:S2");
});

test("hypId clips a long suspect id to 100 characters", () => {
  const path = join(tmp(), "events.jsonl");
  const want = `${TRACE}:api:${"S".repeat(100)}…`;
  withEvents(new EventLog(path, TRACE), () => expect(hypId("api", "S".repeat(300))).toBe(want));
});

test("a log reopened after a crash mid-line starts its first event on its own line", () => {
  const path = join(tmp(), "events.jsonl");
  writeFileSync(path, '{"seq":1}\n{"seq":2,"ty');
  withEvents(new EventLog(path, TRACE), () => { emit("report.done", {}); emit("report.done", {}); });
  const lines = readFileSync(path, "utf8").split("\n");
  expect(lines).toHaveLength(5);
  expect(lines[1]).toBe('{"seq":2,"ty');
  expect(lines.slice(2, 4).map((l) => JSON.parse(l).type)).toEqual(["report.done", "report.done"]);
  // a clean file gets no blank line
  const clean = join(tmp(), "clean.jsonl");
  writeFileSync(clean, '{"seq":1}\n');
  withEvents(new EventLog(clean, TRACE), () => emit("report.done", {}));
  expect(readFileSync(clean, "utf8").split("\n").filter((l) => l === "")).toHaveLength(1);
});

test("providerOf and clip", () => {
  expect(providerOf("openai:gpt-5.5")).toBe("openai");
  expect(providerOf("bare")).toBe("unknown");
  expect(clip("abcdef", 3)).toBe("abc…");
});

test("a new EventLog creates nothing; the first emit creates its directory and file", () => {
  const dir = join(tmp(), "deep", "run");
  const path = join(dir, "events.jsonl");
  const log = new EventLog(path, TRACE);
  expect(existsSync(join(tmp(), "deep"))).toBe(false);
  log.emit("report.done", {});
  expect(existsSync(path)).toBe(true);
  log.emit("report.done", {});
  expect(readFileSync(path, "utf8").trim().split("\n")).toHaveLength(2);
});
