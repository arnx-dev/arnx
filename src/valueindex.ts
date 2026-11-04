// Finds which of many strings a text holds, at a cost that does not grow with how many there are: each string is filed
// under a piece of its text (a few characters of its start, and for a long one of its end), and a rolling hash looks each
// place in the text up once. Nothing is left out for being one of too many.

/** The longest piece a string is filed under: strings at least this long may also be found by their end. */
export const LONG_PIECE = 12;
const SHORTER_PIECES = [8, 4];
/** Filed under no piece: too short to have one, and searched for one by one. */
const TINY = 4;
const BASE = 257;

type Files = Map<number, string | string[]>;
interface Table { size: number; power: number; files: Files; filter: Uint8Array; bits: number }

const hashOf = (s: string, from: number, size: number): number => {
  let h = 0;
  for (let i = from; i < from + size; i++) h = (Math.imul(h, BASE) + s.charCodeAt(i)) | 0;
  return h;
};
/** Most places in a text hash to nothing filed: this answers them without asking the Map. */
const slot = (h: number, bits: number) => (h ^ (h >>> 15)) & (bits - 1);

function tableOf(size: number, pieces: [string, number][]): Table {
  let bits = 1 << 10;
  while (bits < pieces.length * 16) bits *= 2;
  const filter = new Uint8Array(bits >>> 3);
  const files: Files = new Map();
  for (const [value, from] of pieces) {
    const h = hashOf(value, from, size);
    const had = files.get(h);
    files.set(h, had === undefined ? value : typeof had === "string" ? [had, value] : (had.push(value), had));
    const at = slot(h, bits);
    filter[at >>> 3]! |= 1 << (at & 7);
  }
  let power = 1;
  for (let i = 1; i < size; i++) power = Math.imul(power, BASE);
  return { size, power, files, filter, bits };
}

/** Calls `visit` with each filed string whose piece's hash matches at a place in `text`; `visit` compares. */
function slide(text: string, t: Table, visit: (value: string, at: number) => void): void {
  if (text.length < t.size) return;
  const { size, power, files, filter, bits } = t;
  let h = hashOf(text, 0, size);
  for (let at = 0; ; at++) {
    const s = slot(h, bits);
    if (filter[s >>> 3]! & (1 << (s & 7))) {
      const found = files.get(h);
      if (found !== undefined) {
        if (typeof found === "string") visit(found, at);
        else for (const value of found) visit(value, at);
      }
    }
    if (at + size >= text.length) return;
    h = (Math.imul((h - Math.imul(text.charCodeAt(at), power)) | 0, BASE) + text.charCodeAt(at + size)) | 0;
  }
}

export class ValueIndex {
  private starts: Table[] = [];
  private ends: Table | null = null;
  private tiny: string[] = [];

  constructor(values: Iterable<string>) {
    const bySize = new Map<number, [string, number][]>();
    const ends: [string, number][] = [];
    for (const v of values) {
      const size = v.length >= LONG_PIECE ? LONG_PIECE : SHORTER_PIECES.find((n) => v.length >= n);
      if (size === undefined || v.length < TINY) {
        if (v) this.tiny.push(v);
        continue;
      }
      (bySize.get(size) ?? bySize.set(size, []).get(size)!).push([v, 0]);
      if (v.length > LONG_PIECE) ends.push([v, v.length - LONG_PIECE]);
    }
    this.starts = [...bySize].map(([size, pieces]) => tableOf(size, pieces));
    if (ends.length) this.ends = tableOf(LONG_PIECE, ends);
  }

  /** Each place `text` may hold the start of a string (`at`: where), as many characters of it as the piece holds: the
   * caller compares. */
  eachStart(text: string, visit: (value: string, at: number) => void): void {
    for (const t of this.starts) slide(text, t, visit);
    for (const v of this.tiny) for (let at = text.indexOf(v); at >= 0; at = text.indexOf(v, at + 1)) visit(v, at);
  }

  /** Each place `text` may hold the last LONG_PIECE characters of a longer string (`at`: where they start). */
  eachEnd(text: string, visit: (value: string, at: number) => void): void {
    if (this.ends) slide(text, this.ends, visit);
  }

  /** The strings `text` holds whole. */
  present(text: string): Set<string> {
    const out = new Set<string>();
    this.eachStart(text, (v, at) => {
      if (!out.has(v) && text.startsWith(v, at)) out.add(v);
    });
    return out;
  }
}
