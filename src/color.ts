// Terminal colours: on when the output is a terminal (NO_COLOR turns them off, FORCE_COLOR on), off in files, pipes
// and tests, so captured output and golden files stay plain.
export interface Paint { on: boolean; red(s: string): string; green(s: string): string; yellow(s: string): string;
  cyan(s: string): string; bold(s: string): string; dim(s: string): string }

const wrap = (on: boolean, code: string) => (s: string) => (on ? `\x1b[${code}m${s}\x1b[0m` : s);

export function paint(on: boolean): Paint {
  return { on, red: wrap(on, "31"), green: wrap(on, "32"), yellow: wrap(on, "33"), cyan: wrap(on, "36"),
    bold: wrap(on, "1"), dim: wrap(on, "2") };
}

export const PLAIN = paint(false);

/** Whether to colour a stream: a terminal, unless NO_COLOR is set; FORCE_COLOR forces it. */
export function colorFor(stream: { isTTY?: boolean }, env: Record<string, string | undefined>): boolean {
  if (env.FORCE_COLOR && env.FORCE_COLOR !== "0") return true;
  if (env.NO_COLOR !== undefined || env.TERM === "dumb") return false;
  return !!stream.isTTY;
}

/** Colours the marks at the start of summary lines: ✗ red, ? yellow, ✓ green, · dim; headings bold. */
export function colorLines(text: string, p: Paint): string {
  if (!p.on) return text;
  return text.split("\n").map((l) => {
    if (/^\s*✗/.test(l)) return l.replace("✗", p.red("✗"));
    if (/^\s*\?/.test(l)) return l.replace("?", p.yellow("?"));
    if (/^\s*✓/.test(l)) return l.replace("✓", p.green("✓"));
    if (/^\s*·/.test(l)) return p.dim(l);
    if (/^(arnx review |Next:|Then:|All accepted tests pass)/.test(l)) return p.bold(l);
    if (/^Status: complete/.test(l)) return p.green(l);
    if (/^Status: (partly|incomplete)/.test(l)) return p.yellow(l);
    if (/^\S[^:]*: \d+ passed, 0 failing/.test(l)) return p.green(l);
    if (/^\S[^:]*: \d+ passed, \d+ failing/.test(l)) return p.red(l);
    return l;
  }).join("\n");
}
