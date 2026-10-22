// Python-compatible formatting and small helpers. arnx's files and prompts were defined by the Python version;
// these keep them byte-identical where it matters (hashes, image keys, prompts, settings).
import { randomBytes } from "node:crypto";

/** Python's repr() of a float. */
export function pyFloat(n: number): string {
  if (Number.isNaN(n)) return "nan";
  if (!Number.isFinite(n)) return n > 0 ? "inf" : "-inf";
  const abs = Math.abs(n);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e16)) {
    const [mant, exp] = n.toExponential().split("e") as [string, string];
    const sign = exp.startsWith("-") ? "-" : "+";
    const digits = exp.replace(/^[+-]/, "").padStart(2, "0");
    return `${mant}e${sign}${digits}`;
  }
  const s = String(n);
  return Number.isInteger(n) ? `${s}.0` : s;
}

function jsonString(s: string): string {
  return JSON.stringify(s).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/** Python's json.dumps (ensure_ascii, default separators, indent like Python's). Integral numbers are written as
 * integers unless `floatNumbers` is set: YAML parsed with ints as bigint leaves only floats as numbers. */
export function pyJson(value: unknown, opts: { sortKeys?: boolean; indent?: number; floatNumbers?: boolean } = {})
  : string {
  const ind = opts.indent;
  const write = (v: unknown, depth: number): string => {
    if (v === null || v === undefined) return "null";
    if (typeof v === "boolean") return v ? "true" : "false";
    if (typeof v === "bigint") return v.toString();
    if (typeof v === "number") return Number.isInteger(v) && !opts.floatNumbers ? String(v) : pyFloat(v);
    if (typeof v === "string") return jsonString(v);
    const nl = ind === undefined ? "" : "\n" + " ".repeat(ind * (depth + 1));
    const end = ind === undefined ? "" : "\n" + " ".repeat(ind * depth);
    const sepr = ind === undefined ? ", " : ",";
    if (Array.isArray(v)) {
      if (v.length === 0) return "[]";
      return "[" + v.map((x) => nl + write(x, depth + 1)).join(sepr) + end + "]";
    }
    if (typeof v === "object") {
      let keys = Object.keys(v as object);
      if (keys.length === 0) return "{}";
      if (opts.sortKeys) keys = keys.sort();
      const items = keys.map((k) => nl + jsonString(k) + ": " + write((v as Record<string, unknown>)[k], depth + 1));
      return "{" + items.join(sepr) + end + "}";
    }
    throw new TypeError(`Object of type ${typeof v} is not JSON serializable`);
  };
  return write(value, 0);
}

/** Python's repr() of a str. */
export function pyRepr(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'";
  let out = "";
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (ch === "\\") out += "\\\\";
    else if (ch === quote) out += "\\" + ch;
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (code < 0x20 || code === 0x7f) out += "\\x" + code.toString(16).padStart(2, "0");
    else out += ch;
  }
  return quote + out + quote;
}

/** Python's str() of a scalar read from YAML (ints arrive as bigint, so a number is a float). */
export function pyStr(v: unknown): string {
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "number") return pyFloat(v);
  if (v === null || v === undefined) return "None";
  return String(v);
}

/** Python's shlex.quote(). */
export function shQuote(s: string): string {
  if (s === "") return "''";
  if (/^[\w@%+=:,./-]+$/.test(s)) return s;
  return "'" + s.replaceAll("'", "'\"'\"'") + "'";
}

/** datetime.isoformat(timespec="seconds") of a UTC time. */
export function isoSeconds(d: Date): string {
  return d.toISOString().slice(0, 19) + "+00:00";
}

const LINE_BREAK = new RegExp("\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85" + String.fromCharCode(0x2028, 0x2029) + "]");

/** Python's str.splitlines(). */
export function splitLines(s: string): string[] {
  if (s === "") return [];
  const parts = s.split(LINE_BREAK);
  if (LINE_BREAK.test(s.slice(-1)) || s.endsWith("\r\n")) parts.pop();
  return parts;
}

/** Python's truthiness for values read from YAML or JSON. */
export function pyTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === "" || v === 0 || v === 0n) return false;
  if (Array.isArray(v)) return v.length > 0;
  if (typeof v === "object") return Object.keys(v as object).length > 0;
  return true;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function randomHex(bytes: number): string {
  return randomBytes(bytes).toString("hex");
}

/** PurePosixPath's normalisation: drops empty and "." parts, keeps "..". */
export function purePosix(p: string): { path: string; absolute: boolean; parts: string[] } {
  const absolute = p.startsWith("/");
  const parts = p.split("/").filter((x) => x !== "" && x !== ".");
  const path = (absolute ? "/" : "") + parts.join("/");
  return { path: path || ".", absolute, parts };
}
