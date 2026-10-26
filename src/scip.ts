// A SCIP index (github.com/sourcegraph/scip, scip.proto), read for what the hunter's context needs: each
// occurrence's document, line, columns, symbol and roles. A few lines of protobuf decoding instead of a dependency;
// fields arnx does not read are skipped by their wire type.

/** Occurrence roles (scip.proto SymbolRole). */
export const DEFINITION = 1, WRITE = 4;

export interface Occurrence { file: string; line: number; start: number; end: number; symbol: string; roles: number }

export interface ScipIndex {
  /** Occurrences by file, then by 1-based line; locals (parameters, variables) only here, as `local <n>@<file>`. */
  byFileLine: Map<string, Map<number, Occurrence[]>>;
  bySymbol: Map<string, Occurrence[]>;
  /** Symbols defined in the indexed project (a definition occurrence in one of its documents). */
  defined: Set<string>;
}

class Reader {
  pos = 0;
  constructor(readonly buf: Uint8Array, readonly end = buf.length) {}
  varint(): number {
    let out = 0, mul = 1;
    for (;;) {
      if (this.pos >= this.end) throw new Error("SCIP index: truncated varint");
      const b = this.buf[this.pos++]!;
      out += (b & 0x7f) * mul;
      if (b < 0x80) return out;
      mul *= 128;
    }
  }
  bytes(): Reader {
    const n = this.varint();
    if (this.pos + n > this.end) throw new Error("SCIP index: field runs past its message");
    const r = new Reader(this.buf, this.pos + n);
    r.pos = this.pos;
    this.pos += n;
    return r;
  }
  skip(wire: number): void {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos = this.bytes().end;
    else if (wire === 5) this.pos += 4;
    else throw new Error(`SCIP index: unsupported wire type ${wire}`);
  }
  get done(): boolean {
    return this.pos >= this.end;
  }
}

const utf8 = new TextDecoder();
const text = (r: Reader) => utf8.decode(r.buf.subarray(r.pos, r.end));

function occurrence(r: Reader): { range: number[]; symbol: string; roles: number } {
  const range: number[] = [];
  let symbol = "", roles = 0;
  while (!r.done) {
    const key = r.varint(), field = Math.floor(key / 8), wire = key % 8;
    if (field === 1 && wire === 2) {
      const packed = r.bytes();
      while (!packed.done) range.push(packed.varint());
    } else if (field === 1 && wire === 0) range.push(r.varint());
    else if (field === 2 && wire === 2) symbol = text(r.bytes());
    else if (field === 3 && wire === 0) roles = r.varint();
    else r.skip(wire);
  }
  return { range, symbol, roles };
}

/** Reads an index; document paths get `prefix` (the project's directory, so paths are relative to the repository). */
export function readIndex(buf: Uint8Array, prefix = ""): ScipIndex {
  const ix: ScipIndex = { byFileLine: new Map(), bySymbol: new Map(), defined: new Set() };
  const r = new Reader(buf);
  while (!r.done) {
    const key = r.varint(), field = Math.floor(key / 8), wire = key % 8;
    if (field !== 2 || wire !== 2) {
      r.skip(wire);
      continue;
    }
    const doc = r.bytes();
    let file = "";
    const occs: { range: number[]; symbol: string; roles: number }[] = [];
    while (!doc.done) {
      const k = doc.varint(), f = Math.floor(k / 8), w = k % 8;
      if (f === 1 && w === 2) file = prefix + text(doc.bytes());
      else if (f === 2 && w === 2) occs.push(occurrence(doc.bytes()));
      else doc.skip(w);
    }
    const lines = new Map<number, Occurrence[]>();
    ix.byFileLine.set(file, lines);
    for (const o of occs) {
      // A range is [line, start, end] on one line or [line, start, endLine, end].
      if (!o.symbol || o.range.length < 3) continue;
      const [line, start] = o.range as [number, number];
      const end = o.range.length === 3 ? o.range[2]! : o.range[2] === line ? o.range[3]! : Number.MAX_SAFE_INTEGER;
      // Local symbols never leave their document: kept by line only, so a same-named local reads as another symbol.
      const local = o.symbol.startsWith("local ");
      const occ: Occurrence = { file, line: line + 1, start, end, symbol: local ? `${o.symbol}@${file}` : o.symbol,
        roles: o.roles };
      (lines.get(occ.line) ?? lines.set(occ.line, []).get(occ.line)!).push(occ);
      if (local) continue;
      (ix.bySymbol.get(occ.symbol) ?? ix.bySymbol.set(occ.symbol, []).get(occ.symbol)!).push(occ);
      if (occ.roles & DEFINITION) ix.defined.add(occ.symbol);
    }
  }
  return ix;
}
