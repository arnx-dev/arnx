// A file the snapshot leaves out (secret-looking, or matched by .arnxignore) that the tests need: setup stops at the
// first run that names it, and says how to let it in, instead of the agent working around a file it cannot have.
import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { toolErrorText } from "../src/agent";
import type { Brain, RoundTools } from "../src/brain";
import { missingLeftOut } from "../src/diagnose";
import { NO_USAGE } from "../src/llm";
import { defaultSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { Cli } from "./helpers/cli";
import { fakeFactory, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, initRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const ENV = { ANTHROPIC_API_KEY: "a" };
// Built at run time, so a scan of this file finds no key.
const FIXTURE = `AWS = '${"AKIA"}IOSFODNN7EXAMPLE'\n`;
const YAML = "version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
  "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n";

test("a missing module names a left-out code file by its module name, in any language's words", () => {
  const all = ["core/src/auth/token_store.ts", "core/src/auth/oauth2.ts", "core/auth/creds.py"];
  expect(missingLeftOut(["Error: Cannot find module '/src/core/src/auth/token_store.js' imported from " +
    "/src/core/src/auth/oauth2.ts"], ["core/src/auth/token_store.ts"], all)).toEqual(["core/src/auth/token_store.ts"]);
  expect(missingLeftOut(["E   ModuleNotFoundError: No module named 'core.auth.creds'"], ["core/auth/creds.py"], all))
    .toEqual(["core/auth/creds.py"]);
});

test("a missing data file is named only by its whole name", () => {
  const left = ["server/billing/fees.csv"];
  expect(missingLeftOut(["FileNotFoundError: [Errno 2] No such file or directory: '/src/server/billing/fees.csv'"],
    left, left)).toEqual(left);
  expect(missingLeftOut(["FileNotFoundError: [Errno 2] No such file or directory: '/src/server/billing/fees'"], left,
    left)).toEqual([]);
});

test("a left-out file named outside a missing-file line, or a name other files share, is not claimed", () => {
  const left = ["a/config.py"];
  expect(missingLeftOut(["AssertionError: config was not loaded"], left, left)).toEqual([]);
  // b/config.py is in the snapshot: 'x.config' may be either, so only a path naming a/ counts.
  const all = ["a/config.py", "b/config.py"];
  expect(missingLeftOut(["ModuleNotFoundError: No module named 'x.config'"], left, all)).toEqual([]);
  expect(missingLeftOut(["ModuleNotFoundError: No module named 'a.config'"], left, all)).toEqual(left);
});

/** A Python repository whose test imports `left`, a file the snapshot leaves out. */
function shop(left: string, content: string): string {
  const repo = initRepo(join(tmp(), "shop"));
  writeFileSync(join(repo, left), content);
  writeFileSync(join(repo, "test_shop.py"), "import detect\n\ndef test_a():\n    assert detect\n");
  commit(repo, "shop");
  return repo;
}

const needing = (message: string) => fakeFactory(() =>
  [junitXml([["test_shop.py", "test_shop", "error", message]]), message, false]);

test("setup stops at the run that needs a secret-looking file: no more tries, the file and the way in named",
  async () => {
    const repo = shop("detect.py", FIXTURE);
    const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("try_project", { yaml: YAML })],
      [text("done")]]);
    const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "setup"),
      sessionFactory: needing("ModuleNotFoundError: No module named 'detect'") });
    expect([r.ok, r.stop, model.calls.length]).toEqual([false, "stopped", 1]);
    expect(r.needed).toEqual([{ path: "detect.py", secret: true }]);
    expect(r.problem).toBe("shop: the tests need detect.py, which arnx left out as secret-looking (not sent, not in " +
      "the sandbox)");
  });

test("a later try or proposal is refused once setup has stopped", async () => {
  const repo = shop("detect.py", FIXTURE);
  // A brain that runs the CLI's tools from afar (arnx cloud) gets the stop as a tool's answer and may call again.
  const answers: string[] = [];
  const brain = { label: "", agentRound: async (_kind: string, _input: unknown, tools: Promise<RoundTools>) => {
    const t = await tools;
    for (const name of ["try_project", "try_project", "propose"]) {
      try {
        answers.push(await t.call(name, { yaml: YAML }));
      } catch (e) {
        answers.push(toolErrorText(e));
      }
    }
    return { agent: { finalText: "", costUsd: 0, turns: 1, stop: "end_turn", usage: NO_USAGE, calls: 0 } };
  } } as unknown as Brain;
  const runs: string[] = [];
  const inner = needing("ModuleNotFoundError: No module named 'detect'");
  const r = await runSetup(repo, defaultSettings(), null, { outDir: join(tmp(), "setup"), brain,
    sessionFactory: (cfg, snap, log, body) => {
      runs.push(cfg.name);
      return inner(cfg, snap, log, body);
    } });
  expect([r.ok, r.stop, runs]).toEqual([false, "stopped", ["shop"]]);
  expect(answers.map((a) => a.split(":")[0])).toEqual(["stopped", "stopped", "stopped"]);
});

test("a data file .arnxignore leaves out: setup stops and says to let it back in", async () => {
  const repo = shop("fees.csv", "country,fee\n");
  writeFileSync(join(repo, ".arnxignore"), "*.csv\n");
  commit(repo, "ignore");
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [text("done")]]);
  const r = await runSetup(repo, defaultSettings(), model, { outDir: join(tmp(), "setup"),
    sessionFactory: needing("FileNotFoundError: [Errno 2] No such file or directory: '/src/fees.csv'") });
  expect([r.ok, r.needed]).toEqual([false, [{ path: "fees.csv", secret: false }]]);
  expect(r.problem).toBe("shop: the tests need fees.csv, which .arnxignore leaves out");
});

test("arnx setup says it stopped and names the command that lets the file in", async () => {
  const repo = shop("detect.py", FIXTURE);
  const cli = new Cli({ cwd: repo, env: ENV });
  expect(await cli.run("init")).toBe(0);
  expect(await cli.run("consent", "--yes")).toBe(0);
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [text("done")]]);
  const run = new Cli({ cwd: repo, env: ENV, setupModel: model,
    setupSessions: needing("ModuleNotFoundError: No module named 'detect'") });
  expect(await run.run("setup")).toBe(2);
  expect(run.out).toContain("Setup stopped: shop: the tests need detect.py, which arnx left out as secret-looking " +
    "(not sent, not in the sandbox).");
  expect(run.out.at(-1)).toBe("Next: arnx allow-secret detect.py, then arnx setup");
});
