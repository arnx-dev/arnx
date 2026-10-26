// Where a source file's comments are, for the languages arnx reviews: JavaScript and TypeScript (// and /* */), Rust
// (the same, block comments nest) and Python (#). Strings, template literals, regex literals, raw strings and char
// literals are skipped so a // or # inside one is not taken for a comment. Python docstrings are strings, not comments.

export type CommentStyle = "js" | "rust" | "python";

/** A comment: [start, end) in the text; `open` is the length of its opening delimiter. A line comment ends before
 * its newline; an unclosed block comment at the end of the text. */
export interface Comment { start: number; end: number; block: boolean; open: number }

const JS = new Set(["js", "jsx", "mjs", "cjs", "ts", "tsx", "mts", "cts"]);

/** The comment syntax of a file by its extension, or null for files whose comments arnx does not read. */
export function commentStyle(path: string): CommentStyle | null {
  const ext = /\.([a-z]+)$/.exec(path.toLowerCase())?.[1] ?? "";
  return JS.has(ext) ? "js" : ext === "rs" ? "rust" : ext === "py" || ext === "pyi" ? "python" : null;
}

export function comments(text: string, style: CommentStyle): Comment[] {
  return style === "python" ? pythonComments(text) : cComments(text, style === "rust");
}

const ident = (c: string | undefined) => !!c && /[A-Za-z0-9_$]/.test(c);
const lineEnd = (text: string, k: number) => {
  const e = text.indexOf("\n", k);
  return e < 0 ? text.length : e;
};

/** The index after a string opened by `q` at `k`; one that is not `multi` ends at the end of its line unclosed. */
function skipQuoted(text: string, k: number, q: string, multi: boolean): number {
  for (k++; k < text.length; k++) {
    const c = text[k];
    if (c === "\\") k++;
    else if (c === q) return k + 1;
    else if (c === "\n" && !multi) return k;
  }
  return text.length;
}

/** After these a / starts a regex literal, not a division. */
const BEFORE_REGEX = "(,=:[!&|?{};+-*%<>~^";
const REGEX_WORDS = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw",
  "yield", "await"]);
const RAW = /b?r(#*)"/y;

function cComments(text: string, rust: boolean): Comment[] {
  const out: Comment[] = [];
  const n = text.length;
  // JavaScript template literals: the brace depth at each open ${, so its } goes back into the template.
  const templates: number[] = [];
  let depth = 0, prev = "", word = "";
  // From inside a template literal: the index after its closing backtick, or after a ${ (pushed on `templates`).
  const template = (k: number): number => {
    for (; k < n; k++) {
      if (text[k] === "\\") k++;
      else if (text[k] === "`") return k + 1;
      else if (text[k] === "$" && text[k + 1] === "{") {
        templates.push(depth);
        return k + 2;
      }
    }
    return n;
  };
  let i = 0;
  while (i < n) {
    const c = text[i]!, d = text[i + 1];
    if (c === "/" && d === "/") {
      const e = lineEnd(text, i);
      out.push({ start: i, end: e, block: false, open: 2 });
      i = e;
      continue;
    }
    if (c === "/" && d === "*") {
      let k = i + 2, nest = 1;
      while (k < n && nest) {
        if (text.startsWith("*/", k)) {
          nest--;
          k += 2;
        } else if (rust && text.startsWith("/*", k)) {
          nest++;
          k += 2;
        } else k++;
      }
      out.push({ start: i, end: k, block: true, open: 2 });
      i = k;
      continue;
    }
    let next = i + 1;
    if (rust) {
      RAW.lastIndex = i;
      const raw = !ident(text[i - 1]) && (c === "r" || c === "b") ? RAW.exec(text) : null;
      if (raw) {
        const close = `"${raw[1]}`;
        const e = text.indexOf(close, i + raw[0].length);
        next = e < 0 ? n : e + close.length;
      } else if (c === '"') next = skipQuoted(text, i, '"', true);
      else if (c === "'") {
        // A char literal ('a', '\n', '\u{1F600}', or an astral char as two units), else a lifetime ('a).
        if (d === "\\") {
          const e = text.indexOf("'", i + 3);
          next = e < 0 || e > i + 12 ? i + 1 : e + 1;
        } else if (text[i + 2] === "'") next = i + 3;
        else if (text[i + 3] === "'" && /[\uD800-\uDBFF]/.test(d ?? "")) next = i + 4;
      }
    } else if (c === "'" || c === '"') next = skipQuoted(text, i, c, false);
    else if (c === "`") next = template(i + 1);
    else if (c === "/" && (BEFORE_REGEX.includes(prev) || REGEX_WORDS.has(word))) {
      let k = i + 1, inClass = false;
      for (; k < n && text[k] !== "\n"; k++) {
        const ch = text[k];
        if (ch === "\\") k++;
        else if (ch === "[") inClass = true;
        else if (ch === "]") inClass = false;
        else if (ch === "/" && !inClass) {
          k++;
          break;
        }
      }
      next = k;
      prev = "a";
      word = "";
      i = next;
      continue;
    } else if (c === "{") depth++;
    else if (c === "}") {
      if (templates.length && depth === templates.at(-1)) {
        templates.pop();
        next = template(i + 1);
      } else depth--;
    }
    if (!/\s/.test(c)) {
      word = ident(c) ? (ident(prev) ? word + c : c) : "";
      prev = next > i + 1 ? "a" : c;
    }
    i = next;
  }
  return out;
}

function pythonComments(text: string): Comment[] {
  const out: Comment[] = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i]!;
    if (c === "#") {
      const e = lineEnd(text, i);
      out.push({ start: i, end: e, block: false, open: 1 });
      i = e;
    } else if (c === '"' || c === "'") {
      const triple = c.repeat(3);
      if (text.startsWith(triple, i)) {
        let k = i + 3;
        while (k < n && !text.startsWith(triple, k)) k += text[k] === "\\" ? 2 : 1;
        i = Math.min(n, k + 3);
      } else i = skipQuoted(text, i, c, false);
    } else i++;
  }
  return out;
}
