/** Shared by model instances and roles, so parallel projects cannot multiply the provider load. A slot covers
 * the whole call, including retry backoff. The call's timeout starts after it leaves this FIFO queue. */
export const PROVIDER_CONCURRENCY = 4;
const pools = new Map<string, { active: number; waiting: (() => void)[] }>();

export async function withProviderSlot<T>(provider: string, work: () => Promise<T>): Promise<T> {
  let pool = pools.get(provider);
  if (!pool) pools.set(provider, pool = { active: 0, waiting: [] });
  if (pool.active < PROVIDER_CONCURRENCY) pool.active++;
  else await new Promise<void>((resolve) => pool.waiting.push(resolve));
  try {
    return await work();
  } finally {
    const next = pool.waiting.shift();
    if (next) next(); // hand the occupied slot straight to the next call
    else if (--pool.active === 0) pools.delete(provider);
  }
}
