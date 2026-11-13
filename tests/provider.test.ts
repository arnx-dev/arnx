import { expect, test } from "bun:test";
import { PROVIDER_CONCURRENCY, callsInFlight, withProviderSlot } from "../src/provider";
import { sleep } from "../src/util";

/** A work function that stays pending until released, so a test controls when each slot frees. */
function gate() {
  let release = () => {};
  const open = new Promise<void>((r) => { release = r; });
  return { open, release };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

test("withProviderSlot: at most PROVIDER_CONCURRENCY works run at once per key", async () => {
  const g = gate();
  let running = 0, peak = 0;
  const work = async () => {
    peak = Math.max(peak, ++running);
    await g.open;
    running--;
  };
  const calls = Array.from({ length: PROVIDER_CONCURRENCY + 3 }, () => withProviderSlot("p-limit", work));
  await tick();
  expect(running).toBe(PROVIDER_CONCURRENCY);
  g.release();
  await Promise.all(calls);
  expect(peak).toBe(PROVIDER_CONCURRENCY);
});

test("withProviderSlot: waiting calls start in FIFO order", async () => {
  const g = gate();
  const started: number[] = [];
  const calls = Array.from({ length: PROVIDER_CONCURRENCY + 3 }, (_, i) => withProviderSlot("p-fifo", async () => {
    started.push(i);
    await g.open;
  }));
  await tick();
  expect(started).toEqual(Array.from({ length: PROVIDER_CONCURRENCY }, (_, i) => i));
  g.release();
  await Promise.all(calls);
  expect(started).toEqual(Array.from({ length: PROVIDER_CONCURRENCY + 3 }, (_, i) => i));
});

test("withProviderSlot: separate keys do not share a pool", async () => {
  const g = gate();
  const held = Array.from({ length: PROVIDER_CONCURRENCY }, () => withProviderSlot("p-a", () => g.open));
  await tick();
  let ran = false;
  await withProviderSlot("p-b", async () => { ran = true; });
  expect(ran).toBe(true);
  g.release();
  await Promise.all(held);
});

test("withProviderSlot: a throwing work releases its slot", async () => {
  const g = gate();
  const held = Array.from({ length: PROVIDER_CONCURRENCY }, () => withProviderSlot("p-throw", () => g.open));
  await tick();
  let ran = false;
  const waiting = withProviderSlot("p-throw", async () => { ran = true; });
  await tick();
  expect(ran).toBe(false);
  g.release();
  await Promise.all([...held, waiting]);
  expect(ran).toBe(true);
  await expect(withProviderSlot("p-throw", async () => { throw new Error("boom"); })).rejects.toThrow("boom");
  // all slots are free again: PROVIDER_CONCURRENCY more works run together
  const g2 = gate();
  let running = 0;
  const more = Array.from({ length: PROVIDER_CONCURRENCY }, () => withProviderSlot("p-throw", async () => {
    running++;
    await g2.open;
  }));
  await tick();
  expect(running).toBe(PROVIDER_CONCURRENCY);
  g2.release();
  await Promise.all(more);
});

test("a cancelled waiter rejects at once and takes no slot", async () => {
  const g = gate();
  const holders = Array.from({ length: PROVIDER_CONCURRENCY }, () => withProviderSlot("p-cancel", () => g.open));
  await tick();
  const ac = new AbortController();
  let ran = false;
  const waiter = withProviderSlot("p-cancel", async () => { ran = true; }, { signal: ac.signal, cancelled: () => new Error("gone") });
  const outcome = waiter.then(() => "ok", (e: Error) => e.message);
  await tick();
  ac.abort();
  expect(await outcome).toBe("gone");
  expect(ran).toBe(false);
  expect(callsInFlight()).toEqual([["p-cancel", PROVIDER_CONCURRENCY]]);
  g.release();
  await Promise.all(holders);
  expect(callsInFlight()).toEqual([]);
});

test("a waiter already cancelled never queues", async () => {
  const g = gate();
  const holders = Array.from({ length: PROVIDER_CONCURRENCY }, () => withProviderSlot("p-pre", () => g.open));
  const ac = new AbortController();
  ac.abort();
  await expect(withProviderSlot("p-pre", async () => 1, { signal: ac.signal })).rejects.toBeDefined();
  g.release();
  await Promise.all(holders);
  expect(callsInFlight()).toEqual([]);
});

test("the next waiter still runs after a cancelled one", async () => {
  const g = gate();
  const holders = Array.from({ length: PROVIDER_CONCURRENCY }, () => withProviderSlot("p-next", () => g.open));
  await tick();
  const ac = new AbortController();
  const a = withProviderSlot("p-next", async () => "a", { signal: ac.signal }).catch(() => "cancelled");
  const b = withProviderSlot("p-next", async () => "b");
  await tick();
  ac.abort();
  g.release();
  expect(await a).toBe("cancelled");
  expect(await b).toBe("b");
  await Promise.all(holders);
  expect(callsInFlight()).toEqual([]);
});

test("sleep ends on abort", async () => {
  const ac = new AbortController();
  const t0 = performance.now();
  const p = sleep(10_000, ac.signal);
  ac.abort();
  await p;
  expect(performance.now() - t0).toBeLessThan(1000);
  await sleep(10_000, ac.signal); // already aborted: returns at once
});
