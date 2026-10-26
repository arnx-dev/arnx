// Trace events: what each stage of a review or a setup did and what each model call cost, one JSON line each, for
// evaluation runs. Behaviour-neutral: with no log open an event is dropped, and a failed write never stops arnx.
// Nothing here is sent anywhere.
import { AsyncLocalStorage } from "node:async_hooks";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { hasSecretContent } from "./secrets";

export const SCHEMA_VERSION = 1;
export const EVENTS_FILE = "events.jsonl";

export type Role = "reviewer" | "part-hunt" | "second-hunt" | "rank" | "merge-questions" | "challenge" | "explain" |
  "setup" | "jev" | "unknown";

export type EventType = "review.started" | "review.completed" | "review.failed" | "model.call" | "agent.turn" |
  "context.index" | "hunt.list" | "hunt.suspect" | "hunt.merged" | "hunt.dropped" | "test.files" | "test.written" | "test.run" |
  "test.run_missing" | "test.classified" | "before.started" | "before.run" | "before.finding" | "before.done" |
  "fix_proof.started" | "fix_proof.run" | "fix_proof.done" | "typecheck.run" | "typecheck.done" | "challenge.verdict" |
  "suspect.outcome" | "report.done" | "setup.started" | "setup.attempt" | "setup.completed" | "setup.withheld" | "setup.uses_check";

export interface TraceEvent { schema_version: number; trace_id: string; seq: number; at: string; type: EventType;
  data: Record<string, unknown> }

export class EventLog {
  private seq: number;
  private ready = false;
  /** The reopened file ended mid-line (a crash): the first new event starts on its own line. */
  private torn = false;

  /** Appends to `path`; a log reopened for a resumed review continues its numbering. */
  constructor(readonly path: string, readonly traceId: string, private now: () => Date = () => new Date()) {
    let lines = 0;
    try {
      if (existsSync(path)) {
        const old = readFileSync(path, "utf8");
        lines = old.split("\n").filter(Boolean).length;
        this.torn = old.length > 0 && !old.endsWith("\n");
      }
    } catch {
      // an unreadable log starts again at 1
    }
    this.seq = lines;
  }

  emit(type: EventType, data: Record<string, unknown>): void {
    const e: TraceEvent = { schema_version: SCHEMA_VERSION, trace_id: this.traceId, seq: ++this.seq,
      at: this.now().toISOString(), type, data };
    try {
      // the directory appears with the first event, so a run that emits nothing leaves nothing behind
      if (!this.ready) mkdirSync(dirname(this.path), { recursive: true });
      this.ready = true;
      appendFileSync(this.path, (this.torn ? "\n" : "") + JSON.stringify(e) + "\n");
      this.torn = false;
    } catch {
      // tracing never stops a review
    }
  }
}

interface Context { log: EventLog | null; role: Role; extra: Record<string, unknown> }
const context = new AsyncLocalStorage<Context>();

/** Runs `fn` with `log` open: events emitted inside it, across awaits, go to that log. */
export function withEvents<T>(log: EventLog, fn: () => T): T {
  return context.run({ log, role: "unknown", extra: {} }, fn);
}

/** Runs `fn` with model calls attributed to `role`; `extra` fields (a project, a finding) join the outer ones. */
export function withRole<T>(role: Role, fn: () => T, extra: Record<string, unknown> = {}): T {
  const outer = context.getStore();
  return context.run({ log: outer?.log ?? null, role, extra: { ...outer?.extra, ...extra } }, fn);
}

export const currentRole = (): Role => context.getStore()?.role ?? "unknown";

export function emit(type: EventType, data: Record<string, unknown>): void {
  context.getStore()?.log?.emit(type, data);
}

export interface ModelCallData { role?: Role; provider: string; model: string; ok: boolean; error?: string;
  /** Why the provider failed the call, when it was the cause (errors.ts ProviderFault). */
  fault?: "auth" | "unavailable"; input: number; output: number; cache_read: number; cache_write: number; cost_usd: number; latency_ms: number;
  attempts?: number; unknown_usage: number; timed_out: boolean; turn?: number }

/** One model call, with the current role and its context fields (`data.role` overrides the role). */
export function emitModelCall(data: ModelCallData): void {
  const ctx = context.getStore();
  if (!ctx?.log) return;
  ctx.log.emit("model.call", { ...ctx.extra, ...data, role: data.role ?? ctx.role });
}

/** One agent turn, with the current role and its context fields. */
export function emitTurn(data: Record<string, unknown>): void {
  const ctx = context.getStore();
  if (!ctx?.log) return;
  ctx.log.emit("agent.turn", { ...ctx.extra, ...data, role: (data.role as Role | undefined) ?? ctx.role });
}

/** A suspect's id across an evaluation: the trace, the project and the suspect id (S1, S2, …). */
export function hypId(project: string, sid: string): string {
  return `${context.getStore()?.log?.traceId ?? ""}:${project}:${clip(sid, 100)}`;
}

/** The provider part of a model ref ("anthropic:claude-…" → "anthropic"). */
export const providerOf = (ref: string): string => ref.includes(":") ? ref.split(":")[0]! : "unknown";

/** A test's message for an event: clipped, and withheld when it looks like a secret. */
export const testMessage = (s: string): string =>
  hasSecretContent(s) ? "(withheld: looks like a secret)" : clip(s, 500);

export const clip = (s: string, n = 2000): string => s.length <= n ? s : s.slice(0, n) + "…";
