// Experimental: JEV (typesafe.ai), a model that answers typed questions with a calibrated confidence, asked why a
// failure happened when no signature in diagnose.ts matched. Used only when .arnx/config.toml turns it on
// (`[setup] jev = true`) and JEV_API_KEY is set: the key alone does nothing. An answer counts
// only at JEV_MIN_CONFIDENCE or above, an error or a timeout gives no hint, and a message that looks like it holds a
// key is never sent. Each question and answer goes to jev.jsonl so the experiment can be judged.
import { appendFileSync } from "node:fs";
import type { ReviewConfig } from "./config";
import type { HintKind } from "./diagnose";
import { clip, emitModelCall } from "./events";
import { hasSecretContent } from "./secrets";
import type { Env, Settings } from "./settings";

export const JEV_URL = "https://api.typesafe.ai/v1/systemone";
/** On 33 labelled failures every answer at 0.8 or above was right and every wrong one was below 0.5. */
export const JEV_MIN_CONFIDENCE = 0.9;
const TIMEOUT_MS = 10_000;

export type JevKind = HintKind | "genuine-failure";
export interface JevAnswer { kind: JevKind; confidence: number }
/** Why one failure happened, or null when JEV is unsure, unreachable, or was not asked. */
export type FailureModel = (message: string, cfg: ReviewConfig, top: string[]) => Promise<JevAnswer | null>;

const CRITERIA: Record<string, string> = {
  "missing-package": "A module or package the test imports is not installed (and is not a file or folder of the " +
    "repository).",
  "import-path": "A module or file the test imports exists in the repository but cannot be imported from where the " +
    "tests run: wrong working directory, rootdir, PYTHONPATH or relative path.",
  "missing-variable": "An environment variable the code reads is not set.",
  "unresolved-host": "A host name could not be resolved (DNS failure): the test tries to reach a host that does not " +
    "exist in the sandbox, such as an internet API.",
  "connection-refused": "A connection to a server was refused: nothing is listening at that address and port.",
  "genuine-failure": "The code ran and gave a wrong result or raised an error from its own logic or data: a genuine " +
    "test failure, not a missing environment.",
  unclear: "The message does not say enough to tell which of these it is.",
};

/** The key to ask JEV with, or null when setup must not ask it: off in the config, or no key. */
export function jevKey(s: Settings, env: Env): string | null {
  return s.jev && env.JEV_API_KEY ? env.JEV_API_KEY : null;
}

/** What doctor says about JEV, or null when there is nothing to say (off, and no key). */
export function jevStatus(s: Settings, env: Env): string | null {
  if (s.jev) return env.JEV_API_KEY ? "on: setup asks it about failures no signature explains"
    : "on in .arnx/config.toml, but JEV_API_KEY is not set, so setup does not ask it";
  return env.JEV_API_KEY ? "off (`jev = true` under `[setup]` turns it on)" : null;
}

export function jevModel(key: string, log: string | null, fetcher: typeof fetch = fetch): FailureModel {
  return async (message, cfg, top) => {
    if (hasSecretContent(message)) return null;
    const services = cfg.services.map((s) => s.name);
    const state = `Language: ${cfg.language}. The tests run in an offline Docker sandbox with no internet` +
      (services.length ? `; only these services are reachable, by name: ${services.join(", ")}` : " and no services") +
      `. Top-level entries of the repository: ${top.join(", ")}.\n\nFailure message of one test:\n${message}`;
    const started = performance.now();
    let answer: JevAnswer | null = null, error = "", responded = false;
    try {
      const r = await fetcher(JEV_URL, { method: "POST", signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model: "jev-latest", state, questions: { cause: { type: "choice",
          instructions: "Why did this test fail?", criteria: CRITERIA } } }) });
      responded = true;
      const body = await r.json() as { answers?: { cause?: { choice?: string; confidence?: number } } };
      const a = body.answers?.cause;
      if (!r.ok || !a?.choice || typeof a.confidence !== "number") error = `HTTP ${r.status}`;
      else if (a.choice !== "unclear" && a.choice in CRITERIA) answer = { kind: a.choice as JevKind, confidence: a.confidence };
    } catch (e) {
      error = (e as Error).name;
    }
    // JEV bills no tokens we can see: a response that came back is counted as one call of unknown usage.
    emitModelCall({ role: "jev", provider: "typesafe", model: "jev-latest", ok: answer !== null || !error,
      ...(error ? { error: clip(error, 300) } : {}), input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: 0,
      latency_ms: Math.round(performance.now() - started), unknown_usage: responded ? 1 : 0,
      timed_out: error === "TimeoutError" });
    if (log) {
      appendFileSync(log, JSON.stringify({ at: new Date().toISOString(), project: cfg.name, message: message.slice(0, 300),
        answer, error: error || undefined, ms: Math.round(performance.now() - started) }) + "\n");
    }
    return answer && answer.confidence >= JEV_MIN_CONFIDENCE ? answer : null;
  };
}
