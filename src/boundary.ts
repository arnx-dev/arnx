// The one filter for what leaves arnx. Each value that looks like a secret gets its stand-in in every request to a model
// (system text, messages, tool results, the diff), in a request's every string, in telemetry and in the event log, and so
// does a piece of one at the edge of a word, as a cut leaves it, unless the value is proven word-like. A
// wrong guess costs an odd string in a prompt: nothing on disk changes. One Boundary serves a run: it starts empty and
// is told each value before the text holding it can leave (a run's snapshots, both sides of its diff).
//
// The other way, a model's text meets real files: its tests, its tool inputs and what it proposes hold the stand-ins it
// read. `swapFor` gives them back as they mean there, at the last moment and in memory only, for what runs or reads the
// real files; nothing swapped back is kept, logged or sent.
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentModel, JsonModel } from "./llm";
import { fake, hasSecretContent, isCertainRule, maskPrivateKeys, nameShaped, type SecretPin, suspects } from "./secrets";
import { DIFF_SECTION } from "./util";
import { ValueIndex } from "./valueindex";

/** The shortest piece of a value taken for that value: shorter ones are too often a piece of something else. */
const FRAGMENT_MIN = 12;

/** What may stand before a key's random part: it says what kind of key, and says nothing about how random the rest is. */
const KEY_KIND = /^(?:0x|[A-Za-z]{1,8}[-_])/i;
const HEX = /^[0-9a-fA-F-]+$/;

/** Whether `s` is spread over its characters as random text is: its characters' entropy not far from the most its length
 * and alphabet allow. This only catches repetition, so its bar is low. */
function spread(s: string): boolean {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  let alphabet = 0;
  if (/^[0-9-]+$/.test(s)) alphabet = 10;
  else if (HEX.test(s)) alphabet = 16;
  else {
    for (const c of counts.keys()) if (!/[0-9A-Za-z]/.test(c)) alphabet++;
    if (/[0-9]/.test(s)) alphabet += 10;
    if (/[a-z]/.test(s)) alphabet += 26;
    if (/[A-Z]/.test(s)) alphabet += 26;
  }
  return bits > 0 && bits >= 0.65 * Math.log2(Math.min(s.length, alphabet));
}

/** Whether a piece of `value` counts as that value. Decided from all of it, as a piece on its own can read as anything.
 * When in doubt it does: a leak costs more than an odd name. Only a value proven word-like is masked whole only, since its
 * pieces are names in code and one name with two spellings reads as a bug. So a cut piece of a passphrase of words and
 * digits leaves. An address's password keeps its `@` in the value. */
export function piecesAllowed(value: string): boolean {
  const v = value.endsWith("@") ? value.slice(0, -1) : value;
  if (hasSecretContent(v)) return true;
  const rest = v.replace(KEY_KIND, "");
  if (!spread(rest)) return false;
  // Capitals and digits (base32, cloud keys), or hex: their letters can read as anything. A constant's name holds a `_`.
  if (v.length >= 16 && (!/[a-z_]/.test(rest) || HEX.test(rest))) return true;
  return !nameShaped(v);
}

/** A value as it reads in text that was made into JSON or into a URL. */
function forms(v: string): string[] {
  try {
    return [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)];
  } catch {
    return [v, JSON.stringify(v).slice(1, -1)]; // not valid text: no URL form
  }
}

/** A value's bytes in base64, starting `lead` bytes into a group and without the padding: only the characters the value
 * alone decides, so it is found inside the base64 of a longer text (`Basic base64(user:value)`), for any text around it.
 * `last`: with the character it shares with what follows, for a value that ends that text. */
function base64Inside(v: string, lead: number, last = false): string {
  const bytes = Buffer.byteLength(v);
  const all = Buffer.concat([Buffer.alloc(lead), Buffer.from(v)]).toString("base64").replace(/=+$/, "");
  return all.slice([0, 2, 3][lead]!, last || !((lead + bytes) % 3) ? all.length : all.length - 1);
}
const urlSafe = (b64: string) => b64.replaceAll("+", "-").replaceAll("/", "_");
const plainBase64 = (v: string) => Buffer.from(v).toString("base64").replace(/=+$/, "");
const hexOf = (v: string) => Buffer.from(v).toString("hex");
/** A dump's hex column with its bytes apart: `od -tx1`, and `hexdump -C` up to its gap. Plain `hexdump` and `od -x` print
 * swapped words, which no form here reads. */
const hexApart = (v: string) => [...Buffer.from(v)].map((b) => b.toString(16).padStart(2, "0")).join(" ");
/** And in pairs (xxd), the value starting at a pair's first byte or its second. */
const hexPairs = (v: string, lead: number) => {
  const hex = hexOf(v);
  return [...lead ? [hex.slice(0, lead * 2)] : [], ...hex.slice(lead * 2).match(/.{1,4}/g) ?? []].join(" ");
};
/** What a program makes of a value's bytes. Applied to a stand-in, each gives what a model reads in its place, of the same
 * length. A value in padded base64 is found by its text before the padding. */
const ENCODINGS: ((v: string) => string)[] = [plainBase64, (v) => urlSafe(plainBase64(v)),
  ...[0, 1, 2].flatMap((lead) => [(v: string) => base64Inside(v, lead), (v: string) => urlSafe(base64Inside(v, lead))]),
  ...[1, 2].flatMap((lead) => [(v: string) => base64Inside(v, lead, true),
    (v: string) => urlSafe(base64Inside(v, lead, true))]),
  hexOf, (v) => hexOf(v).toUpperCase(), hexApart, (v) => hexPairs(v, 0), (v) => hexPairs(v, 1)];
/** And what it makes of its letters. */
const CASES: ((v: string) => string)[] = [(v) => v.toUpperCase(), (v) => v.toLowerCase()];
/** The shortest encoded text taken for a value: shorter ones turn up by chance. */
const ENCODED_MIN = 8;

const alphanumeric = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
/** Whether a piece may end at `at`: the text ends, or what follows is no letter or digit of a longer word. Text is cut in
 * too many ways to list its marks (a space, a quote, a bracket, a broken character), and a wrong guess costs an odd
 * string in a prompt. */
const endsAt = (text: string, at: number) => at === text.length || !alphanumeric(text.charCodeAt(at));
/** Whether a piece may start at `at`, by what stands before it. */
const startsAt = (text: string, at: number) => at === 0 || !alphanumeric(text.charCodeAt(at - 1));

/** Where `text` holds a character that is no letter or digit. */
function signPlaces(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) if (!alphanumeric(text.charCodeAt(i))) out.push(i);
  return out;
}

/** How many of `sorted` are below `x`. */
function countBelow(sorted: readonly number[], x: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (sorted[mid]! < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** A place in a text to replace: a whole value, or a piece from its start or its end. */
interface Edit { at: number; length: number; value: string; kind: "start" | "end" }

/** `text` with `edits` made, the first and longest at each place; one that overlaps an earlier one still replaces the
 * rest of what it covers. */
function apply(text: string, edits: Edit[], withText: (e: Edit) => string): string {
  edits.sort((a, b) => a.at - b.at || b.length - a.length);
  const parts: string[] = [];
  let from = 0;
  for (const e of edits) {
    if (e.at + e.length <= from) continue;
    parts.push(text.slice(from, Math.max(from, e.at)), withText(e).slice(Math.max(0, from - e.at)));
    from = e.at + e.length;
  }
  parts.push(text.slice(from));
  return parts.join("");
}

/** What a model's text means where real files are (Boundary.swapFor). */
export interface Swap {
  /** Text used as it is: a test, a path, a command. */
  text(t: string): string;
  /** A regular expression: a stand-in written bare or escaped, back as its value escaped. */
  pattern(p: string): string;
}

/** A stand-in is made letter for letter (secrets.ts fake), so this is the same for it and its value, and a text's windows
 * of a value's shape are the only places its stand-in can be: no other value's slow hash need be taken. */
const shapeOf = (s: string) => s.replace(/[0-9]/g, "0").replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a");

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** Files past this are not read for a stand-in: a snapshot keeps no text this large. */
const HELD_MOST = 32_000_000;

/** Whether a file under `root`, by its name or its bytes, holds `text`; `notReal` (paths relative to it) are not looked at. */
function heldUnder(root: string, text: string, notReal: (rel: string) => boolean): boolean {
  const bytes = Buffer.from(text);
  const look = (rel: string): boolean => {
    for (const name of readdirSync(join(root, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (notReal(r)) continue;
      if (name.includes(text)) return true;
      try {
        const st = lstatSync(join(root, r));
        if (st.isDirectory() ? look(r) : st.isFile() && st.size <= HELD_MOST && readFileSync(join(root, r)).includes(bytes)) {
          return true;
        }
      } catch {
        // a run took it away
      }
    }
    return false;
  };
  return look("");
}

export class Boundary {
  private values = new Set<string>();
  /** The values as written, and their JSON and URL forms: what a stand-in comes back to (`unmask`). `values` adds the
   * encoded forms, which never do: a run encodes the plain form it holds, and text holding an encoded stand-in stays. */
  private plain = new Set<string>();
  /** Longest first, so a value inside another never breaks it. */
  private longest: string[] = [];
  private made = new Map<string, string>();
  /** Made when first asked, and again after values are added. */
  private index: ValueIndex | null = null;
  /** The value a JSON or URL form was made from. */
  private formOf = new Map<string, string>();
  /** What `piecesAllowed` said, for each value or form a text has held a piece of. */
  private judged = new Map<string, boolean>();
  /** An encoded form, and how it was made from the value `formOf` names. */
  private encodingOf = new Map<string, (v: string) => string>();
  /** The values and forms that have stand-ins where tests run: a test's stand-in of one is what the code holds. */
  private faked = new Set<string>();
  /** The plain forms by shape, and an index of the shapes: made when first asked, and again after values are added. */
  private shapes: { of: Map<string, string[]>; index: ValueIndex } | null = null;

  constructor(values: Iterable<string> = []) {
    this.add(values);
  }

  /** From now on these values never leave. */
  add(values: Iterable<string>): void {
    const before = this.values.size;
    for (const v of values) {
      if (!v) continue;
      for (const form of forms(v)) {
        this.values.add(form);
        this.encodingOf.delete(form);
        if (form !== v) this.formOf.set(form, v);
      }
      this.plain.add(v);
      for (const form of forms(v)) this.plain.add(form);
      this.addEncoded(v);
    }
    if (this.values.size === before) return;
    this.longest = [...this.plain].sort((a, b) => b.length - a.length);
    this.index = null;
    this.shapes = null;
  }

  /** A snapshot's values: `secrets` got stand-ins in it, and the rest are real there. */
  addScrubbed(taken: { suspects: Iterable<string>; secrets: Iterable<string> }): void {
    this.add(taken.suspects);
    this.add(taken.secrets);
    this.keepFaked(taken.secrets);
  }

  private keepFaked(values: Iterable<string>): void {
    for (const v of values) for (const form of forms(v)) this.faked.add(form);
  }

  /** The forms a test can turn a real value into on its way to its output. An address's `pw@` is encoded as `pw` and keeps
   * its case: alone it reads like a name, and `ACCESS_TOKEN` is a constant. */
  private addEncoded(v: string): void {
    const inAddress = v.endsWith("@");
    const bare = inAddress ? v.slice(0, -1) : v;
    const made = [...ENCODINGS, ...(inAddress ? [] : CASES)];
    for (const encode of made) {
      const form = encode(bare);
      if (form.length < ENCODED_MIN || form === bare || this.values.has(form)) continue;
      this.values.add(form);
      this.formOf.set(form, v);
      this.encodingOf.set(form, encode);
    }
  }

  /** The values on both sides of a diff, a value only removed too. */
  addDiff(diff: string, allow: readonly SecretPin[] = []): void {
    const why = new Map<string, string>();
    this.add(diffSuspects(diff, allow, why));
    this.keepFaked([...why].filter(([, rule]) => isCertainRule(rule)).map(([v]) => v));
  }

  /** `text` without private-key text, known or not (secrets.ts maskPrivateKeys), and without any of the values, each
   * replaced wherever it stands, inside a longer word too, and without the piece of one (`piecesAllowed`) that text cut
   * before the filter left: FRAGMENT_MIN characters or more of its start that end a word, or of its end that start one. */
  mask(raw: string): string {
    const text = maskPrivateKeys(raw);
    const edits = this.editsOf(text);
    if (!edits.length) return text;
    return apply(text, edits, (e) => {
      const s = this.standIn(e.value);
      return e.kind === "end" ? s.slice(-e.length) : s.slice(0, e.length);
    });
  }

  /** Where `text` holds a value, whole or as a piece a cut left. */
  private editsOf(text: string): Edit[] {
    const edits: Edit[] = [];
    this.index ??= new ValueIndex(this.values);
    // A piece runs up to the last sign it holds when what follows it is a letter: the part before that sign is still
    // the value's, at a word's edge.
    let signs: number[] | null = null;
    const signsOf = () => signs ??= signPlaces(text);
    this.index.eachStart(text, (v, at, n) => {
      if (n === v.length) edits.push({ at, length: n, value: v, kind: "start" });
      else if (n >= FRAGMENT_MIN && this.piecesCount(v)) {
        const end = endsAt(text, at + n) ? at + n : signsOf()[countBelow(signsOf(), at + n) - 1] ?? -1;
        if (end - at >= FRAGMENT_MIN) edits.push({ at, length: end - at, value: v, kind: "start" });
      }
    });
    this.index.eachEnd(text, (v, end, n) => {
      if (n < FRAGMENT_MIN || n >= v.length || !this.piecesCount(v)) return;
      const sign = startsAt(text, end - n) ? end - n - 1 : signsOf()[countBelow(signsOf(), end - n)] ?? end;
      if (end - sign - 1 >= FRAGMENT_MIN) edits.push({ at: sign + 1, length: end - sign - 1, value: v, kind: "end" });
    });
    return edits;
  }

  /** `piecesAllowed` for a value or a form of one, which is judged as the value. */
  private piecesCount(form: string): boolean {
    let yes = this.judged.get(form);
    if (yes === undefined) this.judged.set(form, yes = piecesAllowed(this.formOf.get(form) ?? form));
    return yes;
  }

  /** A copy of `value` with `mask` applied to every string in it, keys too; the same object when that changes nothing. */
  maskValue<T>(value: T): T {
    return this.walk(value) as T;
  }

  private walk(v: unknown): unknown {
    if (typeof v === "string") return this.mask(v);
    if (Array.isArray(v)) {
      const items = v.map((x) => this.walk(x));
      return items.every((x, i) => x === v[i]) ? v : items;
    }
    if (typeof v !== "object" || v === null) return v;
    const json = (v as { toJSON?: () => unknown }).toJSON;
    if (typeof json === "function") {
      const plain = json.call(v);
      const walked = this.walk(plain);
      return walked === plain ? v : walked;
    }
    const entries = Object.entries(v);
    const out = entries.map(([k, x]) => [this.mask(k), this.walk(x)] as const);
    return out.every(([k, x], i) => k === entries[i]![0] && x === entries[i]![1]) ? v : Object.fromEntries(out);
  }

  /** Where `text` holds the stand-in of a value real where tests run, longest first at each place. A value's slow hash is
   * taken only when the text has a window of its shape, so text with none costs a slide over it; a run of values of one shape
   * (all digits, one length) costs one hash each, once, if the text has such a window. `held`: a stand-in that means
   * itself, as real text holds it. */
  private standInsIn(text: string, held?: (standIn: string) => boolean): { at: number; length: number; value: string }[] {
    if (!this.plain.size) return [];
    if (!this.shapes) {
      const of = new Map<string, string[]>();
      for (const v of this.plain) {
        const shape = shapeOf(v);
        const same = of.get(shape);
        if (same) same.push(v);
        else of.set(shape, [v]);
      }
      this.shapes = { of, index: new ValueIndex(of.keys()) };
    }
    const { of, index } = this.shapes;
    const found: { at: number; length: number; value: string }[] = [];
    index.eachStart(shapeOf(text), (shape, at, n) => {
      if (n !== shape.length) return;
      const same = of.get(shape)!;
      // What a model read was hashed when it was masked: those first, and one match is enough.
      for (const hashed of [true, false]) {
        for (const v of same) {
          if (this.made.has(v) !== hashed || this.faked.has(v)) continue;
          const s = fake(v, this.made);
          if (s === v || !text.startsWith(s, at)) continue;
          if (!held?.(s)) found.push({ at, length: n, value: v });
          return;
        }
      }
    });
    found.sort((a, b) => a.at - b.at || b.length - a.length);
    let from = 0;
    return found.filter((e) => e.at >= from && (from = e.at + e.length, true));
  }

  /** `text` with each stand-in of a value real where tests run back as its value. */
  unmask(text: string, held?: (standIn: string) => boolean): string {
    const parts: string[] = [];
    let from = 0;
    for (const e of this.standInsIn(text, held)) {
      parts.push(text.slice(from, e.at), e.value);
      from = e.at + e.length;
    }
    return from ? parts.join("") + text.slice(from) : text;
  }

  /** The regular expression `pattern` with each stand-in, bare or escaped, back as its value, which it then matches as
   * plain text. A stand-in holds the signs its value does. */
  private unmaskPattern(pattern: string, held?: (standIn: string) => boolean): string {
    const bare: string[] = [];
    const places: number[] = [];
    for (let i = 0; i < pattern.length; i++) {
      places.push(i);
      if (pattern[i] === "\\" && i + 1 < pattern.length && !/[0-9A-Za-z\s]/.test(pattern[i + 1]!)) i++;
      bare.push(pattern[i]!);
    }
    const parts: string[] = [];
    let from = 0;
    for (const e of this.standInsIn(bare.join(""), held)) {
      parts.push(pattern.slice(from, places[e.at]!), escapeRegExp(e.value));
      from = places[e.at + e.length] ?? pattern.length;
    }
    return from ? parts.join("") + pattern.slice(from) : pattern;
  }

  /** How a model's text reads where the files under `root` are real. A stand-in those files hold stays as written: there it
   * means itself, and a wrong swap would change what the text says. `notReal` (paths relative to `root`): files that do
   * not count, as a model's own tests. Looked at when a stand-in is first met, so a run with none reads nothing. */
  swapFor(root: string, notReal: (rel: string) => boolean = () => false): Swap {
    const known = new Map<string, boolean>();
    const held = (s: string) => {
      let yes = known.get(s);
      if (yes === undefined) known.set(s, yes = heldUnder(root, s, notReal));
      return yes;
    };
    return { text: (t) => this.unmask(t, held), pattern: (p) => this.unmaskPattern(p, held) };
  }

  /** A value of signs alone keeps its shape, so `fake` leaves it as it is. An encoded form's stand-in is its value's
   * stand-in, encoded the same way: no further slow hash, and a model that decodes it finds the stand-in. */
  private standIn(v: string): string {
    const encode = this.encodingOf.get(v);
    if (encode) {
      const of = this.standIn(this.formOf.get(v)!);
      return encode(of.endsWith("@") ? of.slice(0, -1) : of);
    }
    const s = fake(v, this.made);
    return s === v ? "x".repeat(v.length) : s;
  }
}

/** `value` masked, and whether that replaced anything. */
export function maskedCopy<T>(b: Boundary, value: T): { value: T; shown: boolean } {
  const masked = b.maskValue(value);
  return { value: masked, shown: masked !== value && JSON.stringify(masked) !== JSON.stringify(value) };
}

/** Said beside text a developer or a coding agent reads, when it holds a stand-in. */
export const STAND_INS_NOTE = "Values that look like secrets show as stand-ins: the test's file and line show the real code.";

/** The values on both sides of a diff, each side read as the file's own text so a file's kind counts. */
export function diffSuspects(diff: string, allow: readonly SecretPin[] = [], why?: Map<string, string>): string[] {
  const out = new Set<string>();
  const scan = (path: string, text: string) => {
    for (const v of suspects(path, text, allow.find((a) => a.path === path)?.matches ?? [], why)) out.add(v);
  };
  for (const section of diff.split(DIFF_SECTION)) {
    const path = /^\+\+\+ b\/(.*)$/m.exec(section)?.[1] ?? /^--- a\/(.*)$/m.exec(section)?.[1] ?? "";
    const before: string[] = [], after: string[] = [];
    let hunks = false;
    for (const line of section.split("\n")) {
      const hunk = /^@@ [^@]* @@ ?(.*)$/.exec(line);
      if (hunk) {
        hunks = true;
        // git's function context is a line of the file.
        before.push(hunk[1]!);
        after.push(hunk[1]!);
      } else if (!hunks) continue;
      else if (line[0] === "-") before.push(line.slice(1));
      else if (line[0] === "+") after.push(line.slice(1));
      else if (line[0] === " ") {
        before.push(line.slice(1));
        after.push(line.slice(1));
      }
    }
    if (!hunks) scan(path, section);
    else {
      scan(path, before.join("\n"));
      scan(path, after.join("\n"));
    }
  }
  return [...out];
}

/** Each wrapped model, and the boundary it answers to. */
const wrapped = new WeakMap<object, Boundary>();

/** `model`, all of it as it was (`instanceof`, its fields, what is set on it), with `name` going through `call`. */
function wrap<T extends object>(model: T, b: Boundary, name: keyof T, call: unknown): T {
  const proxy = new Proxy(model, {
    get: (target, key) => (key === name ? call : Reflect.get(target, key, target)),
    set: (target, key, value) => Reflect.set(target, key, value, target),
  });
  wrapped.set(proxy, b);
  return proxy;
}

/** `model` asked with everything it is sent masked. */
export function maskedAgent(model: AgentModel, b: Boundary): AgentModel {
  if (wrapped.get(model) === b) return model;
  const create: AgentModel["create"] = (a) => model.create(b.maskValue(a));
  return wrap(model, b, "create", create);
}

/** `model` asked with everything it is sent masked. */
export function maskedJson(model: JsonModel, b: Boundary): JsonModel {
  if (wrapped.get(model) === b) return model;
  const completeJson: JsonModel["completeJson"] = (system, user, schema) =>
    model.completeJson(b.mask(system), b.mask(user), b.maskValue(schema));
  return wrap(model, b, "completeJson", completeJson);
}

/** Whether `model` goes through a boundary. */
export const isMasked = (model: object): boolean => wrapped.has(model);

/** The boundary `model` goes through. */
export const boundaryOf = (model: object): Boundary | undefined => wrapped.get(model);
