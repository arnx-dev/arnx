// Experimental JEV hints: what counts as an answer, what is never sent, and that it is asked only about failures
// nothing else explains.
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewConfig } from "../src/config";
import { JEV_MIN_CONFIDENCE, jevKey, jevModel, jevStatus } from "../src/jev";
import { defaultSettings, loadSettings } from "../src/settings";
import { Cli } from "./helpers/cli";
import { gitRepo } from "./helpers/gitutil";
import { runSuite } from "../src/setup";
import { fakeFactory } from "./helpers/fakes";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { CFG } from "./helpers/yaml";

const tmp = useTmp();
const cfg = parseReviewConfig(CFG);

function fakeFetch(choice: string, confidence: number, sent: string[] = [], status = 200): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    sent.push(String(init.body));
    return new Response(JSON.stringify({ model: "jev-1.13.0", answers: { cause: { type: "choice", choice, confidence } } }),
      { status });
  }) as unknown as typeof fetch;
}

test("an answer counts only at the minimum confidence, and unclear never does", async () => {
  const at = (choice: string, c: number) => jevModel("k", null, fakeFetch(choice, c))("boom", cfg, ["app/"]);
  expect(await at("genuine-failure", JEV_MIN_CONFIDENCE)).toEqual({ kind: "genuine-failure", confidence: JEV_MIN_CONFIDENCE });
  expect(await at("genuine-failure", JEV_MIN_CONFIDENCE - 0.01)).toBeNull();
  expect(await at("unclear", 1)).toBeNull();
  expect(await at("something-else", 1)).toBeNull();
});

test("errors give no hint, are logged, and a message that looks like it holds a key is never sent", async () => {
  const log = join(tmp(), "jev.jsonl");
  const sent: string[] = [];
  expect(await jevModel("k", log, fakeFetch("x", 1, sent, 500))("boom", cfg, [])).toBeNull();
  const failing = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  expect(await jevModel("k", log, failing)("boom", cfg, [])).toBeNull();
  expect(await jevModel("k", log, fakeFetch("genuine-failure", 1, sent))(
    `token = ${"sk-ant-" + "x".repeat(40)}`, cfg, [])).toBeNull();
  expect(sent).toHaveLength(1); // only the first call went out
  expect(readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l).error)).toEqual(["HTTP 500", "Error"]);
});

test("JEV is asked only about failing files nothing else explains, and its hint names it", async () => {
  const asked: string[] = [];
  const model = async (message: string) => {
    asked.push(message);
    return { kind: "genuine-failure" as const, confidence: 0.97 };
  };
  const script = (command: string): [string | null, string, boolean] => command.includes("apart.xml")
    ? [junitXml([["tests/test_b.py", "test_b", "passed", ""], ["tests/test_d.py", "test_d", "failed", "assert 1 == 2"]]),
      "", false]
    : [junitXml([["tests/test_a.py", "test_a", "passed", ""], ["tests/test_b.py", "test_b", "failed", "x"],
      ["tests/test_c.py", "test_c", "error", "ModuleNotFoundError: No module named 'fancyfmt'"],
      ["tests/test_d.py", "test_d", "failed", "assert 1 == 2"]]), "", false];
  const [ok, , , , , hints] = await runSuite(cfg, tmp(), join(tmp(), "b.log"), { sessionFactory: fakeFactory(script),
    failureModel: model });
  expect(ok).toBe(false);
  // test_c has a signature and test_b passes apart: only test_d is asked.
  expect(asked).toEqual(["assert 1 == 2\ntrace"]);
  expect(hints).toContain("the code runs and fails on its own result or data, not on the environment (judged by JEV " +
    "(experimental), confidence 0.97). Files: tests/test_d.py.");
});

test("a top-level link that dangles on the host (node_modules linked in test_command) does not stop the hints", async () => {
  const snap = join(tmp(), "snap");
  mkdirSync(join(snap, "src"), { recursive: true });
  writeFileSync(join(snap, "package.json"), "{}");
  symlinkSync("/opt/deps/node_modules", join(snap, "node_modules"));
  const tops: string[][] = [];
  const model = async (_message: string, _cfg: unknown, top: string[]) => {
    tops.push(top);
    return { kind: "genuine-failure" as const, confidence: 0.97 };
  };
  const script = (): [string | null, string, boolean] =>
    [junitXml([["tests/test_a.py", "test_a", "passed", ""], ["tests/test_d.py", "test_d", "failed", "assert 1 == 2"]]),
      "", false];
  const [ok, , , , , hints] = await runSuite(cfg, snap, join(tmp(), "b.log"), { sessionFactory: fakeFactory(script),
    failureModel: model });
  expect(ok).toBe(false);
  expect(tops).toEqual([["node_modules", "package.json", "src/"]]);
  expect(hints).toContain("Files: tests/test_d.py.");
});

test("JEV is asked only when the config turns it on and the key is set; the key alone does nothing", () => {
  const s = defaultSettings();
  expect(jevKey(s, { JEV_API_KEY: "k" })).toBeNull();
  expect(jevKey({ ...s, jev: true }, {})).toBeNull();
  expect(jevKey({ ...s, jev: true }, { JEV_API_KEY: "" })).toBeNull();
  expect(jevKey({ ...s, jev: true }, { JEV_API_KEY: "k" })).toBe("k");
  expect(jevStatus(s, {})).toBeNull(); // nothing to say: no key, not on
  expect(jevStatus(s, { JEV_API_KEY: "k" })).toBe("off (`jev = true` under `[setup]` turns it on)");
  expect(jevStatus({ ...s, jev: true }, { JEV_API_KEY: "k" })).toBe("on: setup asks it about failures no signature " +
    "explains");
  expect(jevStatus({ ...s, jev: true }, {})).toBe("on in .arnx/config.toml, but JEV_API_KEY is not set, so setup " +
    "does not ask it");
});

test("doctor says JEV is available but off when only its key is set, and how to turn it on", async () => {
  const repo = gitRepo(tmp());
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a" } });
  await cli.run("init");
  await cli.run("doctor");
  expect(cli.stdout).not.toContain("JEV");
  const keyed = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a", JEV_API_KEY: "j" } });
  await keyed.run("doctor");
  expect(keyed.stdout).toContain("JEV (experimental): off (`jev = true` under `[setup]` turns it on)");
  const config = join(repo, ".arnx", "config.toml");
  writeFileSync(config, readFileSync(config, "utf8") + "\n[setup]\njev = true\n");
  const on = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a", JEV_API_KEY: "j" } });
  await on.run("doctor");
  expect(on.stdout).toContain("JEV (experimental): on: setup asks it about failures no signature explains");
});

test("init does not ask about JEV, with its key set or not", async () => {
  const repo = gitRepo(tmp());
  const asked: string[] = [];
  const cli = new Cli({ cwd: repo, env: { ANTHROPIC_API_KEY: "a", JEV_API_KEY: "j" },
    ask: async (q: string) => (asked.push(q), "y") });
  expect(await cli.run("init")).toBe(0);
  expect(asked.join("\n")).not.toContain("JEV");
  expect(loadSettings(repo).jev).toBe(false);
});
