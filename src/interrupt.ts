// What an interrupted arnx undoes before it exits: Ctrl-C (SIGINT, exit 130) or a supervisor's SIGTERM (exit 143),
// which an evaluation harness sends on its own timeout and budget stops.
import { cancelInFlight } from "./llm";
import { cleanupLiveSessions } from "./sandbox";

export const EXIT_CODES = { SIGINT: 130, SIGTERM: 143 } as const;

/** Longest an interrupted arnx waits for the open reviews to be closed (a remote brain's finish settles its hold). */
export const INTERRUPT_CLOSE_SECONDS = 5;

/** What an interrupt closes before exiting: each open review registers its brain's finish here while it runs. */
export const closers = new Set<() => Promise<void>>();

/** Every registered closer, within `capSeconds` overall; a failing one is ignored. */
export async function closeOpen(capSeconds = INTERRUPT_CLOSE_SECONDS): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  await Promise.race([Promise.allSettled([...closers].map((c) => c())),
    new Promise((r) => { timer = setTimeout(r, capSeconds * 1000); })]);
  clearTimeout(timer);
}

export interface InterruptDeps { cleanup: () => void; cancel: () => Promise<[string, boolean][]>;
  err: (text: string) => void; exit: (code: number) => void; close?: () => Promise<void> }

const defaults: InterruptDeps = { cleanup: cleanupLiveSessions, cancel: cancelInFlight,
  err: (t) => { process.stderr.write(t); }, exit: (c) => process.exit(c), close: closeOpen };

/** The first signal's exit code, kept so that main's normal completion cannot exit with the review's own code meanwhile. */
export interface InterruptState { code?: number; pending?: Promise<void> }
const moduleState: InterruptState = {};

/** The code main exits with: 130/143 once an interrupt has begun, otherwise the review's own code. */
export const finalExitCode = (code: number, s: InterruptState = moduleState): number => s.code ?? code;

/** Starts the first signal's handling and keeps it, so main can wait for it. */
export function startInterrupt(signal: keyof typeof EXIT_CODES, d: InterruptDeps = defaults,
  s: InterruptState = moduleState): Promise<void> {
  s.pending ??= onInterrupt(signal, d, s);
  return s.pending;
}

/** main's exit code once any interrupt in progress has finished: exiting earlier would cut off its cancel calls
 * (those responses would go on running and billing). */
export async function exitCodeAfter(code: number, s: InterruptState = moduleState): Promise<number> {
  await s.pending;
  return finalExitCode(code, s);
}

const message = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Remove service containers, cancel in-flight OpenAI background responses (they would go on billing), close the
 * open reviews, then exit. A failing step is reported on one stderr line and never changes the exit code. */
export async function onInterrupt(signal: keyof typeof EXIT_CODES, d: InterruptDeps = defaults,
  s: InterruptState = moduleState): Promise<void> {
  s.code ??= EXIT_CODES[signal];
  try {
    d.cleanup(); // service containers and the network go away even when a review is interrupted
  } catch (e) { d.err(`arnx: interrupt cleanup failed: ${message(e)}\n`); }
  d.err(signal === "SIGINT" ? "arnx: interrupted\n" : "arnx: terminated\n");
  try {
    for (const [id, ok] of await d.cancel()) {
      d.err(ok ? `arnx: cancelled background response ${id}\n` : `arnx: could not cancel background response ${id}\n`);
    }
  } catch (e) { d.err(`arnx: interrupt cleanup failed: ${message(e)}\n`); }
  try {
    await d.close?.();
  } catch (e) { d.err(`arnx: interrupt cleanup failed: ${message(e)}\n`); }
  d.exit(EXIT_CODES[signal]);
}
