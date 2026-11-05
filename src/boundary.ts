// The one filter for what leaves arnx. Each value that looks like a secret gets its stand-in in every request to a model
// (system text, messages, tool results, the diff), in a request's every string, in telemetry and in the event log, and so
// does a piece of one at the edge of a word, as a cut leaves it, unless the value is proven word-like. A
// wrong guess costs an odd string in a prompt: nothing on disk changes. One Boundary serves a run: it starts empty and
// is told each value before the text holding it can leave (a run's snapshots, both sides of its diff).
import type { AgentModel, JsonModel } from "./llm";
import { fake, hasSecretContent, nameShaped, type SecretPin, suspects } from "./secrets";
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
/** What a program makes of a value's bytes. Applied to a stand-in, each gives what a model reads in its place, of the same
 * length. A value in padded base64 is found by its text before the padding. */
const ENCODINGS: ((v: string) => string)[] = [plainBase64, (v) => urlSafe(plainBase64(v)),
  ...[0, 1, 2].flatMap((lead) => [(v: string) => base64Inside(v, lead), (v: string) => urlSafe(base64Inside(v, lead))]),
  ...[1, 2].flatMap((lead) => [(v: string) => base64Inside(v, lead, true),
    (v: string) => urlSafe(base64Inside(v, lead, true))]),
  hexOf, (v) => hexOf(v).toUpperCase()];
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

export class Boundary {
  private values = new Set<string>();
  /** The values as written, and their JSON and URL forms: what a stand-in comes back to (`unmask`). `values` adds the
   * encoded forms. */
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
    this.add(diffSuspects(diff, allow));
  }

  /** `text` without any of the values, each replaced wherever it stands, inside a longer word too, and without the piece
   * of one (`piecesAllowed`) that text cut before the filter left: FRAGMENT_MIN characters or more of its start that end
   * a word, or of its end that start one. */
  mask(text: string): string {
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

  /** A copy of `value` with `mask` applied to every string in it, keys too; the same object when there are no values. */
  maskValue<T>(value: T): T {
    return this.longest.length ? this.walk(value) as T : value;
  }

  private walk(v: unknown): unknown {
    if (typeof v === "string") return this.mask(v);
    if (Array.isArray(v)) return v.map((x) => this.walk(x));
    if (typeof v !== "object" || v === null) return v;
    const json = (v as { toJSON?: () => unknown }).toJSON;
    if (typeof json === "function") return this.walk(json.call(v));
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [this.mask(k), this.walk(x)]));
  }

  /** `text` with each stand-in back as its value. */
  unmask(text: string): string {
    let out = text;
    for (const v of this.longest) {
      const s = fake(v, this.made);
      if (s !== v) out = out.replaceAll(s, v);
    }
    return out;
  }

  /** The stand-ins of every value. */
  standIns(): string[] {
    return this.longest.map((v) => this.standIn(v));
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
export function diffSuspects(diff: string, allow: readonly SecretPin[] = []): string[] {
  const out = new Set<string>();
  const scan = (path: string, text: string) => {
    for (const v of suspects(path, text, allow.find((a) => a.path === path)?.matches ?? [])) out.add(v);
  };
  for (const section of diff.split(/^(?=diff --git )/m)) {
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
