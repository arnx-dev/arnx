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

/** How far a string agrees with itself from each of its places (the Z algorithm's table). */
export function selfAgreement(at: (i: number) => number, length: number): Int32Array {
  const z = new Int32Array(length);
  if (length) z[0] = length;
  for (let i = 1, left = 0, right = 0; i < length; i++) {
    let k = i < right ? Math.min(right - i, z[i - left]!) : 0;
    while (i + k < length && at(k) === at(i + k)) k++;
    z[i] = k;
    if (i + k > right) [left, right] = [i, i + k];
  }
  return z;
}

/** How far a text agrees with a string read from its start, asked for places in ascending order. Each character of the
 * text is compared once per string, however many of the string's places overlap (a long run of one letter). */
class Agreement {
  private left = 0;
  private right = 0;
  constructor(private text: (i: number) => number, private size: number, private str: (i: number) => number,
              private length: number, private self: Int32Array) {}

  from(place: number): number {
    let k = 0;
    if (place < this.right) k = Math.min(this.self[place - this.left]!, this.right - place);
    while (k < this.length && place + k < this.size && this.text(place + k) === this.str(k)) k++;
    if (place + k > this.right) [this.left, this.right] = [place, place + k];
    return k;
  }
}

/** What a place found: how many characters agree. Exported for the test against a plain comparison. */
export function agreements(text: string, value: string, places: readonly number[]): number[] {
  const a = new Agreement((i) => text.charCodeAt(i), text.length, (i) => value.charCodeAt(i), value.length,
    selfAgreement((i) => value.charCodeAt(i), value.length));
  return places.map((p) => a.from(p));
}

export class ValueIndex {
  /** Each string's table, read from its start and from its end, once it has been met. */
  private selves = new Map<string, Int32Array>();
  private backSelves = new Map<string, Int32Array>();
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

  /** Each place `text` may hold the start of a string: `length`, how many of its characters agree there. */
  eachStart(text: string, visit: (value: string, at: number, length: number) => void): void {
    const met = new Map<string, Agreement>();
    const look = (v: string, at: number) => {
      let a = met.get(v);
      if (!a) {
        let self = this.selves.get(v);
        if (!self) this.selves.set(v, self = selfAgreement((i) => v.charCodeAt(i), v.length));
        met.set(v, a = new Agreement((i) => text.charCodeAt(i), text.length, (i) => v.charCodeAt(i), v.length, self));
      }
      visit(v, at, a.from(at));
    };
    for (const t of this.starts) slide(text, t, look);
    for (const v of this.tiny) for (let at = text.indexOf(v); at >= 0; at = text.indexOf(v, at + 1)) look(v, at);
  }

  /** Each place `text` may hold the end of a longer string, read backwards from `end`: `length`, how many of its last
   * characters agree there. */
  eachEnd(text: string, visit: (value: string, end: number, length: number) => void): void {
    if (!this.ends) return;
    const places = new Map<string, number[]>();
    slide(text, this.ends, (v, at) => {
      const list = places.get(v);
      if (list) list.push(at + LONG_PIECE);
      else places.set(v, [at + LONG_PIECE]);
    });
    const size = text.length;
    for (const [v, ends] of places) {
      const last = v.length - 1;
      let self = this.backSelves.get(v);
      if (!self) this.backSelves.set(v, self = selfAgreement((i) => v.charCodeAt(last - i), v.length));
      const a = new Agreement((i) => text.charCodeAt(size - 1 - i), size, (i) => v.charCodeAt(last - i), v.length, self);
      // Read from the end of the text, so the last place comes first.
      for (let i = ends.length - 1; i >= 0; i--) visit(v, ends[i]!, a.from(size - ends[i]!));
    }
  }

  /** The strings `text` holds whole. */
  present(text: string): Set<string> {
    const out = new Set<string>();
    this.eachStart(text, (v, _at, length) => {
      if (length === v.length) out.add(v);
    });
    return out;
  }
}
