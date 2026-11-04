// The one filter for what leaves arnx. Each value that looks like a secret gets its stand-in in every request to a model
// (system text, messages, tool results, the diff), in a request's every string, in telemetry and in the event log, and so
// does a piece of one at the edge of a word, as a cut leaves it. A
// wrong guess costs an odd string in a prompt: nothing on disk changes. One Boundary serves a run: it starts empty and
// is told each value before the text holding it can leave (a run's snapshots, both sides of its diff).
import type { AgentModel, JsonModel } from "./llm";
import { fake, type SecretPin, suspects } from "./secrets";
import { ValueIndex } from "./valueindex";

/** The shortest piece of a value taken for that value: shorter ones are too often a piece of something else. */
const FRAGMENT_MIN = 12;

/** A value as it reads in text that was made into JSON or into a URL. */
function forms(v: string): string[] {
  try {
    return [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)];
  } catch {
    return [v, JSON.stringify(v).slice(1, -1)]; // not valid text: no URL form
  }
}

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
  /** Longest first, so a value inside another never breaks it. */
  private longest: string[] = [];
  private made = new Map<string, string>();
  /** Made when first asked, and again after values are added. */
  private index: ValueIndex | null = null;

  constructor(values: Iterable<string> = []) {
    this.add(values);
  }

  /** From now on these values never leave. */
  add(values: Iterable<string>): void {
    const before = this.values.size;
    for (const v of values) {
      if (v) for (const form of forms(v)) this.values.add(form);
    }
    if (this.values.size === before) return;
    this.longest = [...this.values].sort((a, b) => b.length - a.length);
    this.index = null;
  }

  /** The values on both sides of a diff, a value only removed too. */
  addDiff(diff: string, allow: readonly SecretPin[] = []): void {
    this.add(diffSuspects(diff, allow));
  }

  /** `text` without any of the values, each replaced wherever it stands, inside a longer word too, and without the piece
   * of one that text cut before the filter left: FRAGMENT_MIN characters or more of its start that end a word, or of its
   * end that start one. */
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
      else if (n >= FRAGMENT_MIN) {
        const end = endsAt(text, at + n) ? at + n : signsOf()[countBelow(signsOf(), at + n) - 1] ?? -1;
        if (end - at >= FRAGMENT_MIN) edits.push({ at, length: end - at, value: v, kind: "start" });
      }
    });
    this.index.eachEnd(text, (v, end, n) => {
      if (n < FRAGMENT_MIN || n >= v.length) return;
      const sign = startsAt(text, end - n) ? end - n - 1 : signsOf()[countBelow(signsOf(), end - n)] ?? end;
      if (end - sign - 1 >= FRAGMENT_MIN) edits.push({ at: sign + 1, length: end - sign - 1, value: v, kind: "end" });
    });
    return edits;
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

  /** A value of signs alone keeps its shape, so `fake` leaves it as it is. */
  private standIn(v: string): string {
    const s = fake(v, this.made);
    return s === v ? "x".repeat(v.length) : s;
  }
}

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
