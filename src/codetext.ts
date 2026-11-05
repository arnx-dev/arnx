// The code of a source file without its comments and string literals, by language, from one pass over the text (no
// regular expressions, so no input makes it slow: the work is linear in the text, and a long run inside a string or a
// comment is stepped over once). Used to read which names a change adds and which a test uses.
import { posix } from "node:path";

interface Lang {
  hash?: true; // `#` starts a comment (Python, Ruby, PHP)
  slash?: true; // `//` and `/* */` comments
  nest?: true; // block comments nest (Rust, Kotlin, Swift)
  char?: true; // `'` holds one character, not a string (and is a lifetime or label in Rust)
  triple?: true; // `"""` or `'''` strings across lines
  backtick?: "template" | "raw"; // JS template string with `${}`, Go raw string
  raw?: true; // Rust raw strings r#"…"#
  ruby?: true; // =begin … =end
  php?: true; // `#[` is an attribute, not a comment
}
const JS: Lang = { slash: true, backtick: "template" };
const C: Lang = { slash: true, char: true };
const LANGS: Record<string, Lang> = {
  py: { hash: true, triple: true }, rb: { hash: true, ruby: true }, php: { hash: true, slash: true, php: true },
  js: JS, jsx: JS, mjs: JS, cjs: JS, ts: JS, tsx: JS, mts: JS, cts: JS,
  rs: { slash: true, nest: true, char: true, raw: true }, go: { ...C, backtick: "raw" },
  java: { ...C, triple: true }, kt: { ...C, nest: true, triple: true }, cs: { ...C, triple: true },
  swift: { ...C, nest: true, triple: true }, c: C, h: C, cpp: C, hpp: C,
};
/** The languages codeText reads: every one a project's sources (untested.ts SOURCE) can be in. */
export const CODE_LANGUAGES = Object.keys(LANGS);

const NL = 10, BACKSLASH = 92, DQ = 34, SQ = 39, TICK = 96, HASH = 35, SLASH = 47, STAR = 42, LBRACE = 123, RBRACE = 125;
const isWord = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122) || c > 127;

/** `source` without comments and string contents, in the language of `path` (its extension). Lines stay where they are:
 * what is cut leaves its line breaks, so line n of the result is line n of the source. Quotes stay, empty. A file of a
 * type not listed in CODE_LANGUAGES is returned unchanged: nothing is known about what is code in it. `strings`, when
 * given, receives each string's text. */
export function codeText(source: string, path: string, strings?: (text: string) => void): string {
  const lang = LANGS[posix.extname(path).slice(1).toLowerCase()];
  if (!lang) return source;
  const s = source, n = s.length;
  const out: string[] = [];
  let run = 0; // where the code not yet written starts
  const newlines = (a: number, b: number) => {
    let k = 0;
    for (let j = a; j < b; j++) if (s.charCodeAt(j) === NL) k++;
    return k;
  };
  // Cuts [a, b): the code before a is written, the cut keeps its line breaks, the code goes on at b.
  const cut = (a: number, b: number, keep = "") => {
    if (a > run) out.push(s.slice(run, a));
    const k = newlines(a, b);
    out.push(keep + (k ? "\n".repeat(k) : ""));
    run = b;
  };
  // Ends of strings: each returns the index of the closing delimiter (n when there is none).
  const upTo = (from: number, quote: number, multi: boolean) => {
    let j = from;
    for (; j < n; j++) {
      const c = s.charCodeAt(j);
      if (c === BACKSLASH) j++;
      else if (c === quote) return j;
      else if (c === NL && !multi) return j;
    }
    return n;
  };
  const tripleEnd = (from: number, quote: number) => {
    for (let j = from; j < n; j++) {
      const c = s.charCodeAt(j);
      if (c === BACKSLASH) j++;
      else if (c === quote && s.charCodeAt(j + 1) === quote && s.charCodeAt(j + 2) === quote) return j;
    }
    return n;
  };
  const take = (a: number, b: number) => {
    if (strings) strings(s.slice(a, Math.min(b, n)));
  };
  const braces: number[] = []; // JS: the brace depth at each open `${`
  let depth = 0;
  // A template's text from `from`: to the closing backtick (returned, run resumes there), or to a `${` (returned after
  // it, with the brace depth pushed so that its `}` brings the text back).
  const template = (from: number): number => {
    let j = from;
    for (; j < n; j++) {
      const c = s.charCodeAt(j);
      if (c === BACKSLASH) j++;
      else if (c === TICK) {
        take(from, j);
        cut(from, j);
        return j + 1;
      } else if (c === 36 && s.charCodeAt(j + 1) === LBRACE) {
        take(from, j);
        cut(from, j + 2);
        braces.push(depth);
        return j + 2;
      }
    }
    take(from, n);
    cut(from, n);
    return n;
  };
  let i = 0;
  while (i < n) {
    const c = s.charCodeAt(i), d = s.charCodeAt(i + 1);
    if (lang.slash && c === SLASH && d === SLASH) {
      let e = s.indexOf("\n", i);
      if (e < 0) e = n;
      cut(i, e, " ");
      i = e;
    } else if (lang.slash && c === SLASH && d === STAR) {
      let j = i + 2, level = 1;
      for (; j < n && level > 0; j++) {
        const x = s.charCodeAt(j), y = s.charCodeAt(j + 1);
        if (x === STAR && y === SLASH) {
          level--;
          j++;
        } else if (lang.nest && x === SLASH && y === STAR) {
          level++;
          j++;
        }
      }
      cut(i, Math.min(j, n), " ");
      i = Math.min(j, n);
    } else if (lang.hash && c === HASH && !(lang.php && d === 91)) {
      let e = s.indexOf("\n", i);
      if (e < 0) e = n;
      cut(i, e, " ");
      i = e;
    } else if (lang.ruby && c === 61 && (i === 0 || s.charCodeAt(i - 1) === NL) && s.startsWith("=begin", i)) {
      const e = s.indexOf("\n=end", i);
      let end = e < 0 ? n : s.indexOf("\n", e + 1);
      if (end < 0) end = n;
      cut(i, end, " ");
      i = end;
    } else if (c === DQ || (c === SQ && !lang.char)) {
      if (lang.triple && s.charCodeAt(i + 1) === c && s.charCodeAt(i + 2) === c) {
        const e = tripleEnd(i + 3, c);
        take(i + 3, e);
        cut(i + 3, e);
        i = Math.min(e + 3, n);
      } else {
        const e = upTo(i + 1, c, false);
        take(i + 1, e);
        cut(i + 1, e);
        i = s.charCodeAt(e) === c ? e + 1 : e;
      }
    } else if (c === SQ) {
      // A character, `'a'` or `'\n'`; else a lifetime or label (`'a`), which is code.
      let e = -1;
      if (d === BACKSLASH) {
        for (let j = i + 3; j < Math.min(n, i + 14); j++) if (s.charCodeAt(j) === SQ) { e = j; break; }
      } else if (d !== NL && d !== SQ && s.charCodeAt(i + 2) === SQ) e = i + 2;
      if (e < 0) i++;
      else {
        cut(i + 1, e);
        i = e + 1;
      }
    } else if (c === TICK && lang.backtick) {
      if (lang.backtick === "template") i = template(i + 1);
      else {
        const e = s.indexOf("`", i + 1);
        const end = e < 0 ? n : e;
        take(i + 1, end);
        cut(i + 1, end);
        i = e < 0 ? n : e + 1;
      }
    } else if (lang.raw && (c === 114 || (c === 98 && d === 114)) && (i === 0 || !isWord(s.charCodeAt(i - 1)))) {
      // Rust: r"…", r#"…"#, br"…"
      let j = i + (c === 98 ? 2 : 1), hashes = 0;
      while (s.charCodeAt(j) === HASH) { hashes++; j++; }
      if (s.charCodeAt(j) !== DQ) i++;
      else {
        const close = "\"" + "#".repeat(hashes);
        const e = s.indexOf(close, j + 1);
        const end = e < 0 ? n : e;
        take(j + 1, end);
        cut(j + 1, end);
        i = e < 0 ? n : e + close.length;
      }
    } else {
      if (lang.backtick === "template") {
        if (c === LBRACE) depth++;
        else if (c === RBRACE) {
          if (braces.length && braces[braces.length - 1] === depth) {
            braces.pop();
            // The expression ends: the `}` goes with the template's text.
            if (i > run) out.push(s.slice(run, i));
            run = i + 1;
            i = template(i + 1);
            continue;
          }
          depth--;
        }
      }
      i++;
    }
  }
  if (run < n) out.push(s.slice(run));
  return out.join("");
}

/** Whether `path` is under a folder that holds tests or their data. */
export const inTestFolder = (path: string) => posix.dirname(path).split("/").some((d) =>
  /^(?:tests?|__tests__|specs?|e2e|testing|__mocks__|__fixtures__|__testfixtures__|fixtures?|testdata|test[-_]data|snapshots?|__snapshots__)$/i.test(d));
