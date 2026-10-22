// Live progress on stderr while a review runs, so a developer can tell work from a hang: one line per event, and a
// "still waiting" line when nothing has happened for a while (model calls are where reviews have stalled). Docker
// runs block the process, so the waiting line only appears while arnx waits on a model.

export type Say = (message: string) => void;

/** The ping-pong dot of the live line at `t` seconds: head ●, body •, tail · trailing behind (eased at the ends). */
export function bouncer(t: number, width = 15, speed = 0.8): string {
  const phase = (t * speed) % 2;
  const tri = Math.abs(phase - 1);
  const pos = 3 * tri ** 2 - 2 * tri ** 3;
  const v = pos * (width - 1);
  const dir = phase >= 1 ? 1 : -1;
  const stretch = 1 + (1 - Math.abs(pos - 0.5) * 2) * 2.8;
  const bar = Array<string>(width).fill(" ");
  for (const [p, ch] of [[v - dir * stretch * 1.8, "·"], [v - dir * stretch, "•"], [v, "●"]] as const) {
    const i = Math.round(p);
    if (i >= 0 && i < width) bar[i] = ch;
  }
  return `[${bar.join("")}]`;
}

/** Steps that only update the live line (a model turn, a tool call, one of several runs or verdicts). Everything
 * else, and anything about a stall, a retry or a failure, is kept as a line of its own. */
export const TRANSIENT = /(?:turn \d+ ·|final run \d+\/\d+|^Second opinion on F\d+ \(|^ {2}(?:reads|lists|searches|writes|runs) |claude-[a-z0-9-]+ replied \(turn)/;
const KEEP = /retry|trying again|network|still out|gave no verdict|failed|connection|error|✗/i;
/** Within this many ms, the same progress line again is not printed (parallel calls hitting the same rate limit). */
const DUPLICATE_MS = 3000;

/** The cost column: always 7 wide, so the message after it does not move as the total grows. */
export const costColumn = (usd: number) => `$${usd.toFixed(2)}`.padStart(7);

export interface Live {
  /** Writes to the terminal without a newline. */
  raw(s: string): void;
  width: number;
  dim(s: string): string;
  yellow(s: string): string;
}

export class Progress {
  private started: number;
  private last: number;
  private lastMessage = "starting";
  private timer: ReturnType<typeof setInterval> | undefined;
  private clock: () => number;
  private silenceMs: number;
  private checkMs: number;
  private quiet: boolean;

  private live: Live | null;
  private frame: ReturnType<typeof setInterval> | undefined;
  private current = "";
  /** The last line written and when: the same line again within DUPLICATE_MS (two calls retrying together) is not. */
  private written = { line: "", at: -Infinity };
  /** What models cost since this display started, shown in a fixed column of the live line (absent: no column). */
  private cost: (() => number) | null;

  constructor(private write: (line: string) => void,
              o: { clock?: () => number; silenceMs?: number; checkMs?: number; quiet?: boolean; live?: Live | null;
                   cost?: () => number; since?: number } = {}) {
    this.live = o.live ?? null;
    this.cost = o.cost ?? null;
    this.clock = o.clock ?? (() => performance.now());
    this.silenceMs = o.silenceMs ?? 60_000;
    this.checkMs = o.checkMs ?? 5_000;
    this.quiet = o.quiet ?? false;
    // `since`: a clock reading from an earlier display, so a later phase (setup's approval) keeps counting from it.
    this.last = this.clock();
    this.started = o.since ?? this.last;
  }

  private stamp(): string {
    const s = Math.floor((this.clock() - this.started) / 1000);
    return `[${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}]`;
  }

  say: Say = (message) => {
    this.last = this.clock();
    this.lastMessage = message;
    if (this.quiet) return;
    if (message === this.written.line && this.last - this.written.at < DUPLICATE_MS) return;
    this.written = { line: message, at: this.last };
    if (!this.live) {
      this.write(`${this.stamp()} ${message}`);
      return;
    }
    // On a terminal: kept lines go above the live line; the live line shows the latest step.
    this.current = message;
    if (!TRANSIENT.test(message) || KEEP.test(message)) {
      this.live.raw("\r\x1b[2K");
      this.write(`${this.stamp()} ${message}`);
    }
    this.draw();
  };

  private draw(): void {
    const l = this.live;
    if (!l || this.quiet) return;
    const secs = (this.clock() - this.started) / 1000;
    const idle = Math.round((this.clock() - this.last) / 1000);
    const late = idle * 1000 >= this.silenceMs ? l.yellow(` · ${idle}s since the last update`) : "";
    const cost = this.cost ? `${costColumn(this.cost())} ` : "";
    const room = Math.max(10, l.width - 25 - cost.length - (late ? 32 : 0));
    const msg = this.current.length > room ? `${this.current.slice(0, room - 1)}…` : this.current;
    l.raw(`\r\x1b[2K${bouncer(secs)} ${l.dim(this.stamp())} ${cost}${msg}${late}`);
  }

  start(): void {
    if (this.quiet) return;
    if (this.live) {
      // The live line redraws itself; the moving dot and the clock replace "still waiting" lines.
      this.frame = setInterval(() => this.draw(), 66);
      (this.frame as { unref?: () => void }).unref?.();
      this.draw();
      return;
    }
    this.timer = setInterval(() => {
      if (this.clock() - this.last < this.silenceMs) return;
      const waited = Math.round((this.clock() - this.last) / 1000);
      this.write(`${this.stamp()} still waiting (${waited}s since: ${this.lastMessage})`);
      this.last = this.clock();
    }, this.checkMs);
    (this.timer as { unref?: () => void }).unref?.();
  }

  stop(): void {
    clearInterval(this.timer);
    clearInterval(this.frame);
    if (this.live && !this.quiet) this.live.raw("\r\x1b[2K");
  }
}
