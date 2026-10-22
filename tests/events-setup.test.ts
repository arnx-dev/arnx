import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reviewConfigPath } from "../src/config";
import { defaultSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const YAML = `version: 1
image: python:3.12-slim
install: [pip install pytest]
test_command: python -m pytest -q {targets}
known_failing: [tests/test_net.py]
notes: [tests/test_net.py calls a public API]
`;
const tmp = useTmp();
const passing = (): [string | null, string, boolean] =>
  [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false];
const failing = (): [string | null, string, boolean] =>
  [junitXml([["tests/test_a.py", "test_a", "failed", "boom"]]), "", false];

const eventsOf = (outDir: string) => {
  const ids = readdirSync(outDir).filter((n) => existsSync(join(outDir, n, "events.jsonl")));
  expect(ids).toHaveLength(1);
  const lines = readFileSync(join(outDir, ids[0]!, "events.jsonl"), "utf8").trim().split("\n");
  return { id: ids[0]!, events: lines.map((l) => JSON.parse(l)) };
};

test("a setup records its start, each attempt and its end, and its model calls carry the setup role", async () => {
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("propose", { yaml: YAML })],
    [text("done")]]);
  const outDir = join(tmp(), ".arnx", "setup");
  const r = await runSetup(gitRepo(tmp()), defaultSettings(), model,
    { outDir, sessionFactory: fakeFactory(passing) });
  expect(r.ok).toBe(true);
  const { id, events } = eventsOf(outDir);
  expect(id).toMatch(/^\d{8}-[0-9a-f]{6}$/);
  expect(events.every((e) => e.trace_id === id)).toBe(true);
  const types = events.map((e) => e.type as string);
  expect(types[0]).toBe("setup.started");
  expect(types.at(-1)).toBe("setup.completed");
  expect(types.filter((t) => t === "setup.attempt")).toHaveLength(1);
  expect(events[0].data).toMatchObject({ project: null, add: false });
  const attempt = events.find((e) => e.type === "setup.attempt").data;
  expect(attempt).toMatchObject({ n: 1, ok: true, reused: false, failing: 0, skips: 0, hints: "" });
  expect(attempt.summary).toContain("1 passed");
  expect(typeof attempt.secs).toBe("number");
  const done = events.at(-1).data;
  expect(done).toMatchObject({ ok: true, stop: "end_turn", attempts: 1 });
  expect(done.projects).toEqual(r.projects.map((p) => p.name));
  const calls = events.filter((e) => e.type === "model.call");
  expect(calls.length).toBe(3);
  expect(calls.every((e) => e.data.role === "setup")).toBe(true);
  // the files setup always wrote stay where they were
  expect(readdirSync(outDir).filter((n) => n !== id).sort()).toEqual(["transcript.jsonl"]);
});

test("a failing first try and a passing second are two attempts, false then true", async () => {
  let runs = 0;
  const script = () => (++runs === 1 ? failing() : passing());
  const again = YAML + "# again\n";
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("try_project", { yaml: again })],
    [tool("propose", { yaml: again })], [text("done")]]);
  const outDir = join(tmp(), ".arnx", "setup");
  await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir, sessionFactory: fakeFactory(script) });
  const attempts = eventsOf(outDir).events.filter((e) => e.type === "setup.attempt").map((e) => e.data);
  expect(attempts.map((a) => [a.n, a.ok])).toEqual([[1, false], [2, true]]);
  expect(attempts[0].failing).toBe(1);
});

test("a try with a file that does not validate emits no attempt", async () => {
  const model = new ScriptedAgent([[tool("try_project", { yaml: "version: 2\n" })], [text("done")]]);
  const outDir = join(tmp(), ".arnx", "setup");
  await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir, sessionFactory: fakeFactory(passing) });
  const types = eventsOf(outDir).events.map((e) => e.type as string);
  expect(types).not.toContain("setup.attempt");
  expect(types.at(-1)).toBe("setup.completed");
});

test("trying a project again in the same form is an attempt marked reused, and still counts", async () => {
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("try_project", { yaml: YAML })],
    [tool("propose", { yaml: YAML })], [text("done")]]);
  const outDir = join(tmp(), ".arnx", "setup");
  await runSetup(gitRepo(tmp()), defaultSettings(), model, { outDir, sessionFactory: fakeFactory(passing) });
  const events = eventsOf(outDir).events;
  const attempts = events.filter((e) => e.type === "setup.attempt").map((e) => e.data);
  expect(attempts.map((a) => [a.n, a.ok, a.reused])).toEqual([[1, true, false], [2, true, true]]);
  expect(events.at(-1).data.attempts).toBe(2);
});

test("a setup refused for an unknown project leaves no run directory behind", async () => {
  const repo = gitRepo(tmp());
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), YAML);
  const outDir = join(tmp(), ".arnx", "setup");
  const model = new ScriptedAgent([]);
  await expect(runSetup(repo, defaultSettings(), model, { outDir, project: "nope",
    sessionFactory: fakeFactory(passing) })).rejects.toThrow("no project nope");
  expect(readdirSync(outDir, { withFileTypes: true }).filter((d) => d.isDirectory())).toEqual([]);
});
