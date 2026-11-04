// The one filter for what leaves arnx. Each value that looks like a secret gets its stand-in in every request to a model
// (system text, messages, tool results, the diff), in a request's every string, in telemetry and in the event log, and so
// does a piece of one that a cut left at the edge of a line or of the text. A
// wrong guess costs an odd string in a prompt: nothing on disk changes. One Boundary serves a run: it starts empty and
// is told each value before the text holding it can leave (a run's snapshots, both sides of its diff).
import type { AgentModel, JsonModel } from "./llm";
import { fake, type SecretPin, standInsFor, suspects } from "./secrets";

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

/** Whether text cut at `at` would end there: the text or its line ends, a mark of the cut follows, or the bracket that
 * closes a clipped quote (`(${message.slice(0, 200)})`). */
const endsAt = (text: string, at: number) => at === text.length || text[at] === "\n" || text[at] === "\r" ||
  text[at] === "…" || text[at] === ")" || text.startsWith("...", at);
/** Whether text cut at `at` would start there. */
const startsAt = (text: string, at: number) => at === 0 || text[at - 1] === "\n" || text[at - 1] === "…" ||
  text.startsWith("...", at - 3);

export class Boundary {
  private values = new Set<string>();
  /** Longest first, so a value inside another never breaks it. */
  private longest: string[] = [];
  private made = new Map<string, string>();
  private whole: ReturnType<typeof standInsFor> = standInsFor([]);

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
    this.whole = standInsFor(this.longest, this.made);
  }

  /** The values on both sides of a diff, a value only removed too. */
  addDiff(diff: string, allow: readonly SecretPin[] = []): void {
    this.add(diffSuspects(diff, allow));
  }

  /** `text` without any of the values, each replaced wherever it stands, inside a longer word too, and without the piece
   * of one that text cut before the filter left: FRAGMENT_MIN characters or more at its start or end, at a cut's edge. */
  mask(text: string): string {
    const here = this.longest.filter((v) => text.includes(v));
    let out = here.length ? this.whole(text).text : text;
    // What the matcher leaves: inside a longer word, after a slash, or a value `fake` cannot change.
    for (const v of here) if (out.includes(v)) out = out.replaceAll(v, this.standIn(v));
    for (const v of this.longest) {
      if (v.length <= FRAGMENT_MIN) break;
      out = this.maskTail(this.maskHead(out, v), v);
    }
    return out;
  }

  /** `text` without the start of `v` where text was cut after it (a grep line, a clipped diff). */
  private maskHead(text: string, v: string): string {
    const head = v.slice(0, FRAGMENT_MIN);
    let out = text;
    for (let at = out.indexOf(head); at >= 0; at = out.indexOf(head, at + 1)) {
      let n = FRAGMENT_MIN;
      while (n < v.length && out[at + n] === v[n]) n++;
      if (endsAt(out, at + n)) out = out.slice(0, at) + this.standIn(v).slice(0, n) + out.slice(at + n);
    }
    return out;
  }

  /** `text` without the end of `v` where text was cut before it (the tail of a run's output). */
  private maskTail(text: string, v: string): string {
    const tail = v.slice(-FRAGMENT_MIN);
    let out = text;
    for (let at = out.indexOf(tail); at >= 0; at = out.indexOf(tail, at + 1)) {
      const end = at + FRAGMENT_MIN;
      let n = FRAGMENT_MIN;
      while (n < v.length && out[end - n - 1] === v[v.length - n - 1]) n++;
      if (startsAt(out, end - n)) out = out.slice(0, end - n) + this.standIn(v).slice(-n) + out.slice(end);
    }
    return out;
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
