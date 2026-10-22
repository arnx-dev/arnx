import { expect, test } from "bun:test";
import { PROVIDER_CONCURRENCY, withProviderSlot } from "../src/provider";

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
