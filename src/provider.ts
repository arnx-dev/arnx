/** Shared by model instances and roles, so parallel projects cannot multiply the provider load. A slot covers
 * the whole call, including retry backoff. The call's timeout starts after it leaves this FIFO queue. */
export const PROVIDER_CONCURRENCY = 4;
const pools = new Map<string, { active: number; waiting: (() => void)[] }>();

export async function withProviderSlot<T>(provider: string, work: () => Promise<T>,
                                          o: { signal?: AbortSignal; cancelled?: () => Error } = {}): Promise<T> {
  let pool = pools.get(provider);
  if (!pool) pools.set(provider, pool = { active: 0, waiting: [] });
  const { signal } = o;
  const gone = () => o.cancelled?.() ?? new Error("request cancelled");
  if (pool.active < PROVIDER_CONCURRENCY) pool.active++;
  else {
    if (signal?.aborted) throw gone();
    const q = pool;
    // A cancelled waiter leaves the queue and takes no slot; one that was handed a slot has dropped the listener.
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => {
        const i = q.waiting.indexOf(entry);
        if (i >= 0) q.waiting.splice(i, 1);
        reject(gone());
      };
      const entry = () => { signal?.removeEventListener("abort", onAbort); resolve(); };
      q.waiting.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
  try {
    return await work();
  } finally {
    const next = pool.waiting.shift();
    if (next) next(); // hand the occupied slot straight to the next call
    else if (--pool.active === 0) pools.delete(provider);
  }
}

/** Calls holding a slot right now, per provider: what an interrupt cuts off before its answer (billed, usage unknown). */
export function callsInFlight(): [string, number][] {
  return [...pools].filter(([, p]) => p.active > 0).map(([name, p]) => [name, p.active]);
}
