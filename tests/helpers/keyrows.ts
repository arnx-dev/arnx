// Rows for the tests of what a key must never reach: a key built at run time, then where it shows up (the diff, the
// snapshot, the text a model would be sent). No key text is kept in a file here.
import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveChange, takeSnapshot } from "../../src/change";
import { parseReviewConfig, reviewConfigPath, stamp } from "../../src/config";
import type { AgentModel, Block, JsonModel, JsonReply, Reply } from "../../src/llm";
import { runReview } from "../../src/reviewer";
import { defaultSettings, type Settings, writeSettings } from "../../src/settings";
import { fakeFactory, type FakeSession, text, tool } from "./fakes";
import { commit, runGit } from "./gitutil";
import { junitXml } from "./junit";

/** The words after BEGIN or END in a private key's armour (split, so no file here holds a header). */
export const KEY_WORDS = "PRIVATE " + "KEY";
export const wrap = (b: string, w: number) => b.match(new RegExp(`.{1,${w}}`, "g"))!;
/** A random body in base64: no real key, shaped like one. */
export const randomBody = () => randomBytes(1000).toString("base64");
/** An armoured block: `head` and `end` lines around `body` wrapped at `w` columns. */
export const armour = (head: string, end: string, body: string, w = 64) => `${head}\n${wrap(body, w).join("\n")}\n${end}\n`;

const GEN = "tests/arnx_generated/test_add.py";
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };
const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: [] });

class RecordingAgent implements AgentModel {
  model = "claude-sonnet-5-5";
  bodies: string[] = [];
  constructor(private steps: Block[][]) {}
  async create(a: Parameters<AgentModel["create"]>[0]): Promise<Reply> {
    this.bodies.push(JSON.stringify(a));
    const blocks = this.steps.shift() ?? [text(REPORT)];
    return { content: blocks, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, raw: blocks,
      stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
  }
}
class RecordingJson implements JsonModel {
  ref = "openai:x";
  bodies: string[] = [];
  async completeJson(system: string, user: string): Promise<JsonReply> {
    this.bodies.push(JSON.stringify({ system, user }));
    return [{ verdict: "confirmed", reason: "It subtracts.", groups: [] }, 0.01];
  }
}

/** Sets a repository up for a review: the review file, settings, and one commit. */
export function setUp(repo: string): void {
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-11-04"));
  writeSettings(repo, SETTINGS);
  commit(repo, "set up");
}
/** The change in app.py every row makes besides its own file. */
export const editApp = (repo: string) => writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");

const treeText = (d: string): string => !existsSync(d) ? "" : readdirSync(d).map((n) => {
  const p = join(d, n);
  return lstatSync(p).isDirectory() ? treeText(p) : lstatSync(p).isFile() ? readFileSync(p, "latin1") : "";
}).join("\n");
/** How many of `probes` stand in `hay`, as "n/total", or "-" for none. */
export const leak = (hay: string, probes: readonly string[]) => {
  const n = probes.filter((p) => hay.includes(p)).length;
  return n ? `${n}/${probes.length}` : "-";
};

/** Where a key shows up in the committed change of `repo` (set up already): `diff` (REFUSED when the change is
 * refused), `snapshot` of the head, and `wire`: the text a review sends to its models when it reads `readPath`. */
export async function whereKeyShows(repo: string, dest: string, readPath: string, probes: readonly string[]):
  Promise<{ diff: string; snapshot: string; wire: string }> {
  let diff = "REFUSED";
  try { diff = leak(resolveChange(repo, null, []).diff, probes); } catch { /* refused */ }
  takeSnapshot(repo, runGit(repo, "rev-parse", "HEAD").trim(), dest, [], {});
  const snapshot = leak(treeText(dest), probes);
  let wire = "n/a";
  if (diff !== "REFUSED") {
    const agent = new RecordingAgent([[tool("read_file", { path: readPath }), tool("list_dir", { path: "." })],
      [tool("write_file", { path: GEN, content: "def test_add():\n    assert 0\n" }), tool("run_tests", {})]]);
    const json = new RecordingJson();
    const seen: FakeSession[] = [];
    await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: json, progress: () => {},
      sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "failed", "x"]]), "1 failed\n", false], seen) } as never);
    wire = leak([...agent.bodies, ...json.bodies].join("\n"), probes);
  }
  return { diff, snapshot, wire };
}
