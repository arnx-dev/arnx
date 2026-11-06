// A runner configured in code (its configuration cannot be read) may collect arnx's one-line test nowhere in the
// default folder. The runner's own listing says where it collects tests and how they are named, so setup derives the
// place from that, tries it once in the same session, and writes it into review.yaml without asking the agent.
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewFile } from "../src/config";
import { look } from "../src/precheck";
import type { RunResult, Runner, SessionFactory } from "../src/sandbox";
import { defaultSettings } from "../src/settings";
import { runSetup } from "../src/setup";
import { ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = `version: 1
projects:
  app:
    root: .
    language: typescript
    runner: jest
    image: node:22
    install: [npm ci]
    test_command: npx jest {targets}
`;
const OWN = ["Footer", "Header", "Menu", "Page", "Table"].map((n) => `src/js/__tests__/${n}Spec.tsx`);
const PROBE = "src/js/__tests__/arnx_generated/arnx-probeSpec.tsx";

/** A jest run in a sandbox: the listing names the project's own tests, and the one-line test only where the runner
 * collects it (tests named *Spec.tsx under __tests__). */
class Jest implements Runner {
  commands: string[] = [];
  constructor(readonly snap: string) {}
  run(command: string): RunResult {
    this.commands.push(command);
    const done = (output: string): RunResult => ({ exitCode: 0, output, timedOut: false, seconds: 0.1 });
    const targets = [...OWN, PROBE].filter((f) => command.includes(f));
    if (command.includes("--listTests")) {
      const names = !command.includes("arnx-probe") ? OWN : targets.includes(PROBE) ? [PROBE] : [];
      return done(JSON.stringify(names.map((f) => `/src/${f}`)));
    }
    const out = /--outputFile=(\S+)/.exec(command)?.[1];
    const files = targets.length ? targets : OWN;
    if (out) {
      const path = join(this.snap, out.replace(/^'?\/src\//, "").replace(/'$/, ""));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, JSON.stringify({ testResults: files.map((f) => ({ name: `/src/${f}`, status: "passed",
        assertionResults: [{ title: "x", ancestorTitles: [], status: "passed", failureMessages: [] }] })) }));
    }
    return done("passed");
  }
}

function repo(): string {
  const r = gitRepo(tmp());
  writeFileSync(join(r, "jest.config.js"), "module.exports = require('./shared/jest')();\n");
  OWN.forEach((f, i) => {
    mkdirSync(dirname(join(r, f)), { recursive: true });
    writeFileSync(join(r, f), "test('x', () => {});\n" + "// padding\n".repeat(i * 10));
  });
  commit(r, "tests");
  return r;
}

test("a project whose config is code gets its place from what the runner lists", async () => {
  const r = repo();
  const cfg = parseReviewFile(YAML).projects[0]!;
  const session = new Jest(r);
  const seen = await look(session, r, cfg);
  expect(seen.early).toBeNull();
  expect(seen.placement).toEqual({ testsDir: "src/js/__tests__/arnx_generated", testFiles: "*Spec.tsx" });
  // The first probe was the default one and was not listed; the second is the derived one, once.
  const probes = session.commands.filter((c) => c.includes("--listTests") && c.includes("arnx-probe"));
  expect(probes.length).toBe(2);
  expect(probes[0]).toContain("__tests__/arnx_generated/arnx-probe.test.js");
  expect(probes[1]).toContain(PROBE);
});

test("setup writes the derived place into review.yaml and does not go back to the agent", async () => {
  const r = repo();
  const model = new ScriptedAgent([[tool("try_project", { yaml: YAML })], [tool("propose", { yaml: YAML })], [text("done")]]);
  const factory: SessionFactory = async (_cfg, snap, _log, body) => body(new Jest(snap));
  const done = await runSetup(r, defaultSettings(), model, { outDir: join(tmp(), "s"), sessionFactory: factory });
  expect(done.ok).toBe(true);
  const yaml = done.yamlText;
  expect(yaml).toContain("tests_dir: src/js/__tests__/arnx_generated");
  expect(yaml).toContain('test_files: "*Spec.tsx"');
  // One try_project, one propose, one end: the placement did not cost the agent a turn, and it was told.
  expect(model.calls.length).toBe(3);
  const told = String((model.calls[1]!.messages.at(-1)!.content as Record<string, unknown>[])[0]!.content);
  expect(told).toContain("runs: 5 passed");
  expect(told).toContain("tests_dir of app set to src/js/__tests__/arnx_generated and test_files to *Spec.tsx");
});
