// What a review sends, recorded at the outermost layer: a model's place in a test, and what a run leaves on disk.
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentModel, Block, JsonModel, JsonReply, Reply } from "../../src/llm";
import { text } from "./fakes";

export class RecordingAgent implements AgentModel {
  model = "claude-sonnet-5-5";
  bodies: string[] = [];
  constructor(private steps: Block[][], private last: string) {}
  async create(a: Parameters<AgentModel["create"]>[0]): Promise<Reply> {
    this.bodies.push(JSON.stringify(a));
    const blocks = this.steps.shift() ?? [text(this.last)];
    return { content: blocks, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, raw: blocks,
      stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
  }
}

export class RecordingJson implements JsonModel {
  ref = "openai:x";
  bodies: string[] = [];
  async completeJson(system: string, user: string): Promise<JsonReply> {
    this.bodies.push(JSON.stringify({ system, user }));
    return [{ verdict: "confirmed", reason: "It subtracts.", groups: [] }, 0.01];
  }
}

/** Every file under `dir` as text. */
export function treeText(dir: string): string {
  if (!existsSync(dir)) return "";
  return readdirSync(dir).map((name) => {
    const p = join(dir, name);
    return lstatSync(p).isDirectory() ? treeText(p) : lstatSync(p).isFile() ? readFileSync(p, "latin1") : "";
  }).join("\n");
}
