// Errors reported to the user as one line. The exit code says what kind of failure it was.
import type { Attempt } from "./llm";

/** The run could not finish (exit code 2). */
export class ArnxError extends Error {
  exitCode = 2;
  override name = "ArnxError";
}

/** The test environment of this commit cannot be had: its image does not build (`build`, `log` the build's output) or
 * runs no test (`probe`). `network`: the build failed on the connection, which is no verdict on the commit. `log` is a
 * file name in the project's folder of the review. */
export class EnvFailed extends ArnxError {
  override name = "EnvFailed";
  constructor(message: string, readonly kind: "build" | "probe", readonly log: string, readonly network = false) {
    super(message);
  }
}

/** What the user sees for an error arnx did not expect (exit code 2): one line naming it as a bug in arnx, never the
 * bundled source a runtime prints for an uncaught error. The stack follows only with ARNX_DEBUG=1. */
export function internalError(e: unknown, env: Record<string, string | undefined>): string[] {
  const name = e instanceof Error ? e.name || "Error" : "Error";
  const first = (e instanceof Error ? e.message : String(e)).split("\n")[0]!.trim();
  const line = `arnx: internal error (${first ? `${name}: ${first}` : name}). This is a bug in arnx, not in your ` +
    "code: please report it with the command you ran and `arnx --version`.";
  return env.ARNX_DEBUG === "1" && e instanceof Error && e.stack ? [line, e.stack] : [line];
}

/** An error that escaped every handler (a callback, a stray promise): an ArnxError says its own line with its exit
 * code (NoCredits: exit 2), anything else is internalError's bug line (exit 2). */
export function fatal(e: unknown, env: Record<string, string | undefined>): { lines: string[]; code: number } {
  return e instanceof ArnxError ? { lines: [`arnx: ${e.message}`], code: e.exitCode } : { lines: internalError(e, env), code: 2 };
}

/** There is no change to review: the diff is empty. `arnx next` tells this apart from a change it cannot review. */
export class NoChange extends ArnxError {
  override name = "NoChange";
}

/** The change holds documentation only: nothing to test unless `--docs` asks. Not a failure: exit code 0. */
export class OnlyDocs extends NoChange {
  override name = "OnlyDocs";
  override exitCode = 0;
  constructor(files: readonly string[]) {
    const shown = files.slice(0, 3).join(", ") + (files.length > 3 ? `, +${files.length - 3} more` : "");
    super(`nothing to test: only documentation changed (${shown}). \`arnx review --docs\` reviews it anyway.`);
  }
}

/** The change is over the size a review reads; a smaller --range fixes it, except for the first commit (`root`). */
export class ChangeTooLarge extends ArnxError {
  override name = "ChangeTooLarge";
  constructor(message: string, readonly root = false) {
    super(message);
  }
}

/** Configuration, consent, keys or Docker are missing (exit code 3). */
export class SetupRequired extends ArnxError {
  override exitCode = 3;
  override name = "SetupRequired";
}

/** The model provider failed after retries, or refused the request. A reply the provider produced is billed even when
 * arnx cannot use it: costUsd and usage say what this call cost (zero when nothing was billed), and unknownCalls counts
 * attempts that were accepted but cut off before the provider reported usage. */
export class ModelError extends ArnxError {
  override name = "ModelError";
  costUsd = 0;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number } | null = null;
  unknownCalls = 0;
  /** The call exhausted a connection, idle, attempt or total timeout. */
  timedOut = false;
  attempts?: Attempt[];
  /** Requests sent before a Responses call failed, for trace events only. */
  tries?: number;
  /** Set when the provider is why the call failed: see ProviderFault. */
  fault?: ProviderFault;
}

/** The provider refused the call for billing: the key has no credits left. No retry or other model fixes it, so
 * every command stops at once (exit 2) with this one line; `provider` is how messages name it ("OpenAI"). */
export class NoCredits extends ModelError {
  override name = "NoCredits";
  constructor(readonly provider: string) {
    super(`${provider} has no credits left on this key: add credits, then run again.`);
  }
}

/** A failed call a step may go on without: any ModelError but NoCredits, which stops the command. */
export const survivable = (e: unknown): e is ModelError => e instanceof ModelError && !(e instanceof NoCredits);

/** The provider's side of a failed call: "auth" when it refused the key (HTTP 401 or 403), "unavailable" when every
 * attempt was answered 5xx or 429 or found no connection. `detail` is that status or network error ("HTTP 503"),
 * never a response body. Timeouts and unreadable replies are neither. */
export interface ProviderFault { kind: "auth" | "unavailable"; detail: string }
