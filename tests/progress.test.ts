import { expect, test } from "bun:test";
import { Progress } from "../src/progress";

test("each event is one line with the elapsed time", () => {
  const lines: string[] = [];
  let now = 0;
  const p = new Progress((l) => lines.push(l), { clock: () => now });
  now = 42_000;
  p.say("api (1/4): the reviewer is writing tests");
  now = 125_000;
  p.say("api: final run 2/3");
  expect(lines).toEqual(["[0:42] api (1/4): the reviewer is writing tests", "[2:05] api: final run 2/3"]);
});

test("a long silence prints that arnx is still waiting, and on what", async () => {
  const lines: string[] = [];
  const p = new Progress((l) => lines.push(l), { silenceMs: 30, checkMs: 5 });
  p.start();
  p.say("Second opinion on F1 (1/3)");
  await new Promise((r) => setTimeout(r, 120));
  p.stop();
  const waiting = lines.filter((l) => l.includes("still waiting"));
  expect(waiting.length).toBeGreaterThan(0);
  expect(waiting[0]).toContain("Second opinion on F1 (1/3)");
  const count = lines.length;
  await new Promise((r) => setTimeout(r, 60));
  expect(lines.length).toBe(count); // stopped
});

test("quiet prints nothing", () => {
  const lines: string[] = [];
  const p = new Progress((l) => lines.push(l), { quiet: true });
  p.start();
  p.say("x");
  p.stop();
  expect(lines).toEqual([]);
});

test("the live line: one line updated in place; kept events above it; stalls kept", async () => {
  const { Progress, bouncer } = await import("../src/progress");
  expect(bouncer(0)).toHaveLength(17);
  expect(bouncer(0.3)).toContain("●");
  const raw: string[] = [], lines: string[] = [];
  let now = 0;
  const p = new Progress((l) => lines.push(l), { clock: () => now, live: { raw: (s) => raw.push(s), width: 80,
    dim: (s) => s, yellow: (s) => s } });
  p.say("billing (1/2): preparing the test environment");
  p.say("billing: turn 1 · read_file · $0.10");
  p.say("billing: turn 2 · write_file · $0.20");
  p.say("claude-sonnet-5-5: nothing received for 90s (the connection may have dropped); retrying (2/3)");
  p.say("Second opinion on F3 (3/12)");
  expect(lines.map((l) => l.replace(/^\[\d+:\d\d\] /, ""))).toEqual(["billing (1/2): preparing the test environment",
    "claude-sonnet-5-5: nothing received for 90s (the connection may have dropped); retrying (2/3)"]);
  expect(raw.at(-1)).toContain("Second opinion on F3 (3/12)");
  now = 75_000;
  (p as unknown as { draw(): void }).draw();
  expect(raw.at(-1)).toContain("75s since the last update");
  p.stop();
  expect(raw.at(-1)).toBe("\r\x1b[2K");
});

test("the live line keeps the total cost in a fixed column after the clock", async () => {
  const { costColumn } = await import("../src/progress");
  const raw: string[] = [];
  let spent = 0;
  const p = new Progress(() => {}, { clock: () => 0, cost: () => spent,
    live: { raw: (s) => raw.push(s), width: 80, dim: (s) => s, yellow: (s) => s } });
  p.say("payments: turn 1 · read_file");
  spent = 12.345;
  p.say("payments: turn 2 · grep");
  const [a, b] = raw.filter((r) => r.includes("turn")).map((r) => r.slice(r.indexOf("[0:00]")));
  expect(a).toBe("[0:00]   $0.00 payments: turn 1 · read_file");
  expect(b).toBe("[0:00]  $12.35 payments: turn 2 · grep");
  expect(a!.indexOf("payments")).toBe(b!.indexOf("payments")); // the message does not move
  expect(costColumn(0.5)).toHaveLength(7);
  // Without a cost source (check, approve) there is no column.
  const plain: string[] = [];
  new Progress(() => {}, { clock: () => 0, live: { raw: (s) => plain.push(s), width: 80, dim: (s) => s,
    yellow: (s) => s } }).say("running the accepted tests");
  expect(plain.at(-1)).toContain("[0:00] running the accepted tests");
});

test("the same line again within 3 s is printed once; later, or a different line, prints", () => {
  let now = 0;
  const lines: string[] = [];
  const p = new Progress((l) => lines.push(l), { clock: () => now });
  p.say("river: HTTP 429 (rate limit); retrying (attempt 2) in 2s");
  p.say("river: HTTP 429 (rate limit); retrying (attempt 2) in 2s");
  now = 5000;
  p.say("river: HTTP 429 (rate limit); retrying (attempt 2) in 2s");
  p.say("grouping findings");
  expect(lines).toEqual(["[0:00] river: HTTP 429 (rate limit); retrying (attempt 2) in 2s",
    "[0:05] river: HTTP 429 (rate limit); retrying (attempt 2) in 2s", "[0:05] grouping findings"]);
});

test("a display started with `since` keeps counting from that reading", () => {
  const lines: string[] = [];
  const p = new Progress((l) => lines.push(l), { clock: () => 47_000, since: 0 });
  p.say("shop: ✓ 1 passed");
  expect(lines).toEqual(["[0:47] shop: ✓ 1 passed"]);
});
