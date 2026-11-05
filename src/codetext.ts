// The code of a source file without its comments and string literals, by language, from one pass over the text (no
// regular expressions, so no input makes it slow: the work is linear in the text, and a long run inside a string or a
// comment is stepped over once). Used to read which names a change adds and which a test uses.
import { posix } from "node:path";

interface Lang {
  hash?: true; // `#` starts a comment (Python, Ruby, PHP)
  slash?: true; // `//` and `/* */` comments
  nest?: true; // block comments nest (Rust, Kotlin, Swift)
  char?: true; // `'` holds one character, not a string (and is a lifetime or label in Rust)
  triple?: true; // triple-quoted strings across lines
  backtick?: "template" | "raw"; // JS template string with `${}`, Go raw string
  raw?: true; // Rust raw strings r#"..."#
  ruby?: true; // =begin ... =end
  php?: true; // `#[` is an attribute, not a comment
  regex?: true; // /.../ regular expression literals (JS)
  fstr?: true; // Python: only an f-string holds code
  interp?: Interp; // how a double-quoted string holds code
}
/** Code inside a string: "brace" `{x}` (Python f-strings, C# `$"..."`), "hash" `#{x}` (Ruby), "kt" `${x}` and `$x`,
 * "dollar" `$x` (PHP), "swift" backslash-paren, "rust" `{x}` naming a variable, "tpl" `${x}` (JS template). */
type Interp = "brace" | "hash" | "kt" | "dollar" | "swift" | "rust" | "tpl";
const JS: Lang = { slash: true, backtick: "template", regex: true, interp: "tpl" };
const C: Lang = { slash: true, char: true };
const LANGS: Record<string, Lang> = {
  py: { hash: true, triple: true, interp: "brace", fstr: true }, rb: { hash: true, ruby: true, interp: "hash" },
  php: { hash: true, slash: true, php: true, interp: "dollar" },
  js: JS, jsx: JS, mjs: JS, cjs: JS, ts: JS, tsx: JS, mts: JS, cts: JS,
  rs: { slash: true, nest: true, char: true, raw: true, interp: "rust" }, go: { ...C, backtick: "raw" },
  java: { ...C, triple: true }, kt: { ...C, nest: true, triple: true, interp: "kt" },
  cs: { ...C, triple: true, interp: "brace" }, swift: { ...C, nest: true, triple: true, interp: "swift" },
  c: C, h: C, cpp: C, hpp: C,
};
/** The languages codeText reads: every one a project's sources (untested.ts SOURCE) can be in. */
export const CODE_LANGUAGES = Object.keys(LANGS);

const NL = 10, BACKSLASH = 92, DQ = 34, SQ = 39, TICK = 96, HASH = 35, SLASH = 47, STAR = 42, LBRACE = 123, RBRACE = 125,
  LPAREN = 40, RPAREN = 41, DOLLAR = 36;
const isWord = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122) || c > 127;
const isStart = (c: number) => (c >= 65 && c <= 90) || c === 95 || (c >= 97 && c <= 122) || c > 127;
/** After these a `/` starts a regular expression; after a name, number, `)`, `]` or `}` it divides. Where it cannot be
 * told (after `)` or `}`), it is taken as a division: code is kept, so a name is never lost. */
const BEFORE_REGEX = new Set(["(", ",", "=", ":", "[", "!", "&", "|", "?", "{", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const KEYWORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "instanceof", "void", "delete", "throw",
  "new", "yield", "await"]);

/** A string being read: how it ends and how code enters it. */
interface Str { quote: number; triple: boolean; multi: boolean; mode: Interp | null }

/** `source` without comments and string contents, in the language of `path` (its extension). Lines stay where they are:
 * what is cut leaves its line breaks, so line n of the result is line n of the source. Quotes stay, empty. Code inside
 * a string (an f-string's `{x}`, a template's `${x}`, Ruby's `#{x}`) stays. A file of a type not listed in
 * CODE_LANGUAGES is returned unchanged: nothing is known about what is code in it. `strings`, when given, receives each
 * string's text. */
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
    if (keep || k) out.push(keep + (k ? "\n".repeat(k) : ""));
    run = b;
  };
  const take = (a: number, b: number) => {
    if (strings) strings(s.slice(a, Math.min(b, n)));
  };
  const stack: Str[] = []; // strings whose code we are in
  const depths: number[] = []; // and the open brackets of that code
  let skip = 0; // after body(): the closing quote's length, 0 when the string ended otherwise or code starts
  // A string's text from `from`: returns where reading goes on. At the string's end (skip is the quote's length) or at
  // code inside it (`st` is then on the stack, unless the code is one name, which is left in the run).
  const body = (from: number, st: Str): number => {
    let j = from, seg = from;
    skip = 0;
    const code = (at: number, resume: number) => { // the text [seg, at) is cut, the code goes on at `resume`
      take(seg, at);
      cut(seg, resume);
    };
    const name = (at: number) => { // `$x` or `{x}`: the name is code, the text goes on after it
      code(at, at + 1);
      let e = at + 2;
      while (e < n && isWord(s.charCodeAt(e))) e++;
      seg = e;
      j = e - 1;
    };
    for (; j < n; j++) {
      const c = s.charCodeAt(j), d = s.charCodeAt(j + 1);
      if (c === BACKSLASH) {
        if (st.mode === "swift" && d === LPAREN) {
          code(j, j + 2);
          stack.push(st), depths.push(0);
          return j + 2;
        }
        j++;
      } else if (c === st.quote && (!st.triple || (d === c && s.charCodeAt(j + 2) === c))) {
        take(seg, j);
        cut(seg, j);
        skip = st.triple ? 3 : 1;
        return j;
      } else if (c === NL && !st.multi) {
        take(seg, j);
        cut(seg, j);
        return j;
      } else if ((st.mode === "tpl" || st.mode === "kt") && c === DOLLAR && d === LBRACE) {
        code(j, j + 2);
        stack.push(st), depths.push(0);
        return j + 2;
      } else if ((st.mode === "kt" || st.mode === "dollar") && c === DOLLAR && isStart(d)) name(j);
      else if (st.mode === "hash" && c === HASH && d === LBRACE) {
        code(j, j + 2);
        stack.push(st), depths.push(0);
        return j + 2;
      } else if ((st.mode === "brace" || st.mode === "rust") && c === LBRACE) {
        if (d === LBRACE) j++;
        else if (st.mode === "brace") {
          code(j, j + 1);
          stack.push(st), depths.push(0);
          return j + 1;
        } else if (isStart(d)) name(j);
      }
    }
    take(seg, n);
    cut(seg, n);
    return n;
  };
  const modeOf = (i: number, c: number): Interp | null => {
    const m = lang.interp;
    if (!m) return null;
    if (c === TICK) return lang.backtick === "template" ? "tpl" : null;
    if (c === DQ && m === "tpl") return null;
    if (c !== DQ && !(lang.fstr && c === SQ)) return null;
    if (lang.fstr) { // Python: an f among the prefix letters, at a word's start
      let k = i - 1, f = false;
      for (; k >= 0 && i - k <= 2 && "fFrRbBuU".includes(s[k]!); k--) if (s[k] === "f" || s[k] === "F") f = true;
      return f && (k < 0 || !isWord(s.charCodeAt(k))) ? "brace" : null;
    }
    if (m === "brace") { // C#: $"..." or $@"..." or @$"..."
      return s.charCodeAt(i - 1) === DOLLAR || (s.charCodeAt(i - 1) === 64 && s.charCodeAt(i - 2) === DOLLAR) ? "brace" : null;
    }
    return m;
  };
  const regexOk = (i: number): boolean => {
    let k = i - 1;
    while (k >= 0 && [32, 9, 10, 13].includes(s.charCodeAt(k))) k--;
    if (k < 0 || BEFORE_REGEX.has(s[k]!)) return true;
    if (!isWord(s.charCodeAt(k))) return false;
    let w = k;
    while (w >= 0 && k - w < 12 && isWord(s.charCodeAt(w))) w--;
    return KEYWORDS.has(s.slice(w + 1, k + 1));
  };
  let noRegexTo = -1; // a regex with no end on this line leaves the rest of the line as code
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
    } else if (c === DQ || (c === SQ && !lang.char) || (c === TICK && lang.backtick === "template")) {
      const triple = !!lang.triple && c !== TICK && d === c && s.charCodeAt(i + 2) === c;
      const st: Str = { quote: c, triple, multi: triple || c === TICK, mode: modeOf(i, c) };
      i = body(i + (triple ? 3 : 1), st);
      i = Math.min(i + skip, n);
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
    } else if (c === TICK && lang.backtick === "raw") {
      const e = s.indexOf("`", i + 1);
      const end = e < 0 ? n : e;
      take(i + 1, end);
      cut(i + 1, end);
      i = e < 0 ? n : e + 1;
    } else if (lang.raw && (c === 114 || (c === 98 && d === 114)) && (i === 0 || !isWord(s.charCodeAt(i - 1)))) {
      // Rust: r"...", r#"..."#, br"..."
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
    } else if (lang.regex && c === SLASH && i >= noRegexTo && regexOk(i)) {
      // A regular expression literal: to its closing `/` on this line, past classes and escapes; no end: code.
      let j = i + 1, cls = false, end = -1;
      for (; j < n; j++) {
        const x = s.charCodeAt(j);
        if (x === NL) break;
        if (x === BACKSLASH) j++;
        else if (x === 91) cls = true;
        else if (x === 93) cls = false;
        else if (x === SLASH && !cls) {
          end = j;
          break;
        }
      }
      if (end < 0 || end === i + 1) {
        noRegexTo = j;
        i++;
      } else {
        cut(i + 1, end);
        i = end + 1;
      }
    } else {
      const top = stack.at(-1);
      if (top) {
        const [open, close] = top.mode === "swift" ? [LPAREN, RPAREN] : [LBRACE, RBRACE];
        if (c === open) depths[depths.length - 1]!++;
        else if (c === close) {
          if (depths[depths.length - 1] === 0) {
            // The code inside the string ends: the bracket goes with its text.
            stack.pop();
            depths.pop();
            if (i > run) out.push(s.slice(run, i));
            run = i + 1;
            i = Math.min(body(i + 1, top) + skip, n);
            continue;
          }
          depths[depths.length - 1]!--;
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
