// What each model call of a review did, kept so the review can say when a provider was down or refused the key
// instead of a bare "incomplete". Only the outcome is kept: the provider, the role, the fault's kind and its short
// detail ("HTTP 503"), never a key or a response body.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ProviderFault } from "./errors";
import { currentRole, type Role } from "./events";
import { providerName, providerOfRef, type Settings } from "./settings";

export interface CallRecord { provider: string; role: Role; ok: boolean; fault?: ProviderFault; attempts?: number }

/** One provider's failed calls of one kind, as review.json keeps them (`provider_failures`). */
export interface ProviderFailure {
  /** The provider part of the model refs ("anthropic"); "arnx" for arnx cloud, whose vendors are never named. */
  provider: string;
  /** How the report names it ("Anthropic", "arnx cloud"). */
  name: string;
  kind: ProviderFault["kind"];
  /** The status or network error, as each failed call ended ("HTTP 503"). */
  detail: string;
  /** Calls arnx made to this provider in the review (for arnx cloud: project rounds). */
  calls: number;
  /** Calls that failed this way. */
  failed: number;
  /** Requests sent for the failed calls (absent for arnx cloud, which retries on its side). */
  attempts?: number;
  /** The roles whose calls failed, in the order they first did. */
  roles: string[];
  /** The roles no call of which succeeded: their work is missing from the review. */
  missing: string[];
  /** The environment variable holding the key, for a refused key. */
  key?: string;
}

const calls = new AsyncLocalStorage<CallRecord[]>();

/** Runs `fn` keeping the outcome of each model call made inside it, across awaits, in `into`. */
export function withCalls<T>(into: CallRecord[], fn: () => T): T {
  return calls.run(into, fn);
}

/** One model call's outcome, with the current role (dropped outside `withCalls`). */
export function recordCall(c: { provider: string; ok: boolean; fault?: ProviderFault; attempts?: number }): void {
  calls.getStore()?.push({ role: currentRole(), ...c });
}

/** Per provider and kind, the calls that failed because of the provider; empty when none did. `s` holds the user's
 * provider tables, for how a custom provider is named and which variable holds its key. */
export function providerFailures(outcomes: CallRecord[], s?: Pick<Settings, "providers">): ProviderFailure[] {
  const out: ProviderFailure[] = [];
  for (const c of outcomes) {
    if (!c.fault) continue;
    let f = out.find((x) => x.provider === c.provider && x.kind === c.fault!.kind);
    if (!f) {
      const key = c.fault.kind === "auth" ? providerOfRef(s, { provider: c.provider, model: "" })?.key_env : undefined;
      out.push(f = { provider: c.provider, name: providerName(s, c.provider), kind: c.fault.kind, detail: "",
        calls: outcomes.filter((x) => x.provider === c.provider).length, failed: 0, attempts: 0, roles: [], missing: [],
        ...(key ? { key } : {}) });
    }
    const details = new Set(f.detail ? f.detail.split(", ") : []);
    c.fault.detail.split(", ").forEach((d) => details.add(d));
    f.detail = [...details].join(", ");
    f.failed += 1;
    f.attempts! += c.attempts ?? 1;
    if (!f.roles.includes(c.role)) f.roles.push(c.role);
  }
  for (const f of out) f.missing = f.roles.filter((r) => !outcomes.some((x) => x.role === r && x.ok));
  return out;
}

/** arnx cloud's side: project rounds that ended on a failed model call there (stop `api_error`). Its models and
 * their vendor stay unnamed. */
export function cloudFailure(stops: string[]): ProviderFailure | null {
  const failed = stops.filter((s) => s.startsWith("api_error")).length;
  if (!failed) return null;
  return { provider: "arnx", name: "arnx cloud", kind: "unavailable", detail: "a model call failed on arnx cloud",
    calls: stops.length, failed, roles: ["reviewer"], missing: failed === stops.length ? ["reviewer"] : [] };
}
