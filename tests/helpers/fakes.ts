// Scripted stand-ins for model providers and Docker, so tests spend nothing and need no daemon.
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ReviewConfig } from "../../src/config";
import { ModelError } from "../../src/errors";
import { type AgentModel, type Block, type JsonModel, type JsonReply, type Message, PRICES, type Reply, type Tool,
  type Usage } from "../../src/llm";
import { LocalBrain } from "../../src/localbrain";
import type { RunResult, Runner, SessionFactory } from "../../src/sandbox";

let ids = 0;
export const text = (t: string): Block => ({ type: "text", text: t });
export const tool = (name: string, input: Record<string, unknown> = {}): Block =>
  ({ type: "tool_use", id: `toolu_${++ids}`, name, input });

const asParam = (b: Block) => b.type === "tool_use"
  ? { type: "tool_use", id: b.id, name: b.name, input: b.input }
  : { type: "text", text: b.text };

export interface Call { system: string; tools: string[]; messages: Message[] }

/** Replies with the given steps in order; each step is the list of blocks of one reply. */
export class ScriptedAgent implements AgentModel {
  model = "claude-sonnet-5-5";
  calls: Call[] = [];
  steps: Block[][];

  constructor(steps: Block[][], readonly usage: Usage = { input: 1000, output: 200, cacheRead: 0, cacheWrite: 0 }) {
    this.steps = [...steps];
  }

  async create({ system, tools, messages }: { system: string; tools: Tool[]; messages: Message[] }): Promise<Reply> {
    this.calls.push({ system, tools: tools.map((t) => t.name), messages: [...messages] });
    const blocks = this.steps.shift();
    if (!blocks) throw new Error("ScriptedAgent ran out of steps");
    const stop = blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn";
    return { content: blocks, stopReason: stop, usage: this.usage, raw: blocks.map(asParam) };
  }
}

export class FakeJson implements JsonModel {
  ref = "openai:gpt-5.5-2026-04-23";
  calls: string[] = [];
  replies: (Record<string, unknown> | Error)[];

  constructor(replies: (Record<string, unknown> | Error)[], readonly cost = 0.01) {
    this.replies = [...replies];
  }

  async completeJson(_system: string, user: string): Promise<JsonReply> {
    this.calls.push(user);
    const reply = this.replies.shift();
    if (reply === undefined) throw new ModelError("FakeJson ran out of replies");
    if (reply instanceof Error) throw reply;
    return [reply, this.cost];
  }
}

export type Script = (command: string, n: number) => [string | null, string, boolean];

/** How a fake runner treats arnx's probe test: "pass" reports it (the default), "ignore" runs the script as for any
 * other command, like a runner whose configuration leaves the tests folder out; "with-suite" reports it along with
 * the script's tests, like a test_command that runs a fixed folder besides {targets}. */
export interface FakeOptions { probe?: "pass" | "ignore" | "with-suite" }
const PROBE = /\S*test_arnx_probe\.py/;

/** Stands in for a Docker session. `script(command, n)` returns [junit xml or null, output, timedOut]; the xml is
 * written where the runner would write it. */
export class FakeSession implements Runner {
  commands: string[] = [];
  constructor(readonly snap: string, readonly script: Script, readonly options: FakeOptions = {}) {}

  run(command: string): RunResult {
    this.commands.push(command);
    const probe = PROBE.exec(command);
    const mode = this.options.probe ?? "pass";
    const probeCase = probe ? `<testcase classname="probe" name="test_arnx_probe" ` +
      `file="${probe[0].replace(/^'|'$/g, "")}" line="1" time="0.01"></testcase>` : "";
    let [xml, output, timedOut] = probe && mode === "pass"
      ? [`<?xml version="1.0"?><testsuites><testsuite name="pytest">${probeCase}</testsuite></testsuites>`, "1 passed",
        false]
      : this.script(command, this.commands.length);
    if (probe && mode === "with-suite" && xml !== null) xml = xml.replace("</testsuite>", `${probeCase}</testsuite>`);
    const m = /--junitxml=\/src\/(\S+)/.exec(command);
    if (xml !== null && m) {
      const path = join(this.snap, m[1]!);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, xml);
    }
    return { exitCode: timedOut ? null : 0, output, timedOut, seconds: 0.1 };
  }
}

export function fakeFactory(script: Script, seen?: FakeSession[], options: FakeOptions = {}): SessionFactory {
  return async <T>(_cfg: ReviewConfig, snap: string, _log: string, body: (r: Runner) => Promise<T>): Promise<T> => {
    const session = new FakeSession(snap, script, options);
    seen?.push(session);
    return body(session);
  };
}

/** A test round's brain and what it asks for: an answer round (no follow-ups) over a scripted model. */
export function answerRound(model: AgentModel, cfg: ReviewConfig) {
  return { brain: new LocalBrain({ agentModel: model, prices: PRICES }),
    ask: () => ({ kind: "answer" as const, input: { cfg, question: "q", answer: "a", diff: "" } }) };
}
