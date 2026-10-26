// What the hunter sees beyond the diff, without a model: each definition the change touches (a function, a method,
// a module-level constant such as an SQL string) and every place that refers to it by name, two levels out. A step
// list such as `for step in (fetch, evaluate, score)` refers to names without calling them, so names find it.
// Names alone also match a same-named definition elsewhere (another script's `main`, a library's `count`); with the
// project's SCIP index, references are the index's occurrences of the definition's symbol, plus the name matches the
// index does not put another symbol on (strings, step lists, code the indexer missed).
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import { DEFINITION, type ScipIndex } from "./scip";
import { isSecretPath } from "./secrets";
import { SOURCE } from "./untested";

export const CONTEXT_LIMIT = 60_000;
const MAX_FILES = 4000, MAX_FILE_BYTES = 400_000, MAX_REFS = 12, SKIP_DIRS = new Set(["node_modules", ".git",
  "target", "dist", "build", ".venv", "venv", "__pycache__", ".next", ".arnx", "vendor"]);

/** New-side line numbers each file's diff adds or removes at, by path. */
export function changedLines(diff: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  let path: string | null = null, line = 0;
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ ")) {
      const p = raw.slice(4).trim();
      path = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (path && !out.has(path)) out.set(path, []);
      continue;
    }
    if (raw.startsWith("--- ") || raw.startsWith("diff --git")) continue;
    const h = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (h) {
      line = Number(h[1]);
      continue;
    }
    // "\ No newline at end of file" follows a side's last line; it is not a line of either side.
    if (!path || raw.startsWith("\\")) continue;
    if (raw.startsWith("+")) out.get(path)!.push(line++);
    else if (raw.startsWith("-")) out.get(path)!.push(line);
    else line++;
  }
  return out;
}

export interface Def { name: string; kind: "function" | "constant"; line: number }

const FUNC = [
  /^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)/, // Python
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, // JS/TS function
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>/, // arrow
  // method; not Rust's `match (a, b) {` (a method named match has no space before its parenthesis)
  /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+|readonly\s+)*(?!match\s)([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/,
  /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?(?:unsafe\s+)?fn\s+([A-Za-z_]\w*)/, // Rust
];
const CONST = [
  /^([A-Z_][A-Z0-9_]*)\s*(?::[^=]+)?=/, // Python module constant
  /^(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=/, // TS module const
  /^(?:pub(?:\([^)]*\))?\s+)?(?:const|static)\s+([A-Z_][A-Z0-9_]*)\s*:/, // Rust
];
const KEYWORDS = new Set(["if", "for", "while", "switch", "catch", "return", "function", "constructor", "else"]);
const indent = (s: string) => s.length - s.trimStart().length;

/** The function a decorator line belongs to: the definition under its run of decorators, for the decorator line
 * itself and for the lines its arguments continue on. Null when the line is not part of a decorator. */
function decorated(lines: string[], at: number): Def | null {
  const here = lines[at - 1] ?? "";
  if (!here.trim()) return null;
  let i = at - 1;
  if (!here.trim().startsWith("@")) {
    // An argument line sits deeper than its decorator; a closing bracket sits level with it.
    const limit = /^[)\]}]/.test(here.trim()) ? indent(here) + 1 : indent(here);
    for (i = at - 2; i >= 0; i--) if (lines[i]!.trim() && indent(lines[i]!) < limit) break;
    if (i < 0 || !lines[i]!.trim().startsWith("@")) return null;
  }
  const top = indent(lines[i]!);
  for (let j = i + 1; j < lines.length; j++) {
    const l = lines[j]!;
    if (!l.trim() || indent(l) > top || /^(?:@|[)\]}]|#|\/\/)/.test(l.trim())) continue;
    if (indent(l) < top) return null;
    for (const rx of FUNC) {
      const m = rx.exec(l);
      if (m && !KEYWORDS.has(m[1]!)) return { name: m[1]!, kind: "function", line: j + 1 };
    }
    return null;
  }
  return null;
}

/** The definition a line belongs to: the function under a decorator the line is part of, the nearest function
 * above it whose body holds it, or the module-level constant it is part of (a multi-line SQL string). */
export function enclosing(lines: string[], at: number): Def | null {
  const dec = decorated(lines, at);
  if (dec) return dec;
  const here = lines[at - 1] ?? "";
  const target = here.trim() ? indent(here) : Infinity;
  for (let i = Math.min(at, lines.length) - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.trim()) continue;
    for (const rx of FUNC) {
      const m = rx.exec(l);
      if (m && !KEYWORDS.has(m[1]!) && (i === at - 1 || indent(l) < target)) return { name: m[1]!, kind: "function", line: i + 1 };
    }
    if (indent(l) === 0) {
      for (const rx of CONST) {
        const m = rx.exec(l);
        if (m) return { name: m[1]!, kind: "constant", line: i + 1 };
      }
      // Another top-level statement ends the search: the line is module code.
      if (i < at - 1 && !/^[)\]}"'`]/.test(l) && !/^(?:@|#|\/\/|\/\*|\*|import|from|use)\b/.test(l.trim())) return null;
    }
  }
  return null;
}

/** Source files under `dirs` (relative to `root`), skipping vendored and build folders and files that hold secrets. */
export function sourceFiles(root: string, dirs: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const visit = (rel: string) => {
    if (out.size >= MAX_FILES) return;
    let names: string[];
    try {
      names = readdirSync(join(root, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel && rel !== "." ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(root, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name) && !name.startsWith(".")) visit(r);
      } else if (st.isFile() && SOURCE.test(name) && st.size <= MAX_FILE_BYTES && !isSecretPath(name)) {
        out.set(r, readFileSync(join(root, r), "utf8"));
      }
    }
  };
  for (const d of [...new Set(dirs.map((d) => posix.normalize(d).replace(/\/$/, "") || "."))]) visit(d);
  return out;
}

interface Ref { file: string; line: number; text: string; in: Def | null }

const TEST_PATH = /(^|\/)(tests?|__tests__|spec)\/|(^|\/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$/;
const COMMENT = /^(#|\/\/|\/\*|\*|"""|''')/;

function references(files: Map<string, string>, name: string, skip: { file: string; line: number }): Ref[] {
  const rx = new RegExp(`(?<![\\w$])${name.replace(/\$/g, "\\$")}(?![\\w$])`);
  const out: Ref[] = [];
  for (const [file, body] of files) {
    // The project's own tests are not part of the flow the hunter follows; they are one grep away.
    if (TEST_PATH.test(file) || !body.includes(name)) continue;
    const lines = body.split("\n");
    lines.forEach((l, i) => {
      if (out.length > MAX_REFS || (file === skip.file && i + 1 === skip.line) || !rx.test(l)) return;
      if (COMMENT.test(l.trim())) return;
      out.push({ file, line: i + 1, text: l.trim().slice(0, 120), in: enclosing(lines, i + 1) });
    });
  }
  return out;
}

/** The symbol a definition line declares: the index's definition occurrence on that line that spells the name. */
function symbolOf(index: ScipIndex, lines: string[], file: string, d: Def): string | null {
  const text = lines[d.line - 1] ?? "";
  for (const o of index.byFileLine.get(file)?.get(d.line) ?? []) {
    if (o.roles & DEFINITION && text.slice(o.start, o.end) === d.name) return o.symbol;
  }
  return null;
}

/** The index's references to `symbol`, then the name matches it does not resolve to another symbol. */
function indexedReferences(files: Map<string, string>, linesOf: (file: string) => string[] | null, index: ScipIndex,
                           symbol: string, name: string, skip: { file: string; line: number }): Ref[] {
  const out: Ref[] = [];
  const at = new Set<string>();
  for (const o of index.bySymbol.get(symbol) ?? []) {
    if (o.roles & DEFINITION || TEST_PATH.test(o.file) || (o.file === skip.file && o.line === skip.line)) continue;
    const lines = linesOf(o.file);
    if (!lines || at.has(`${o.file}:${o.line}`)) continue;
    at.add(`${o.file}:${o.line}`);
    out.push({ file: o.file, line: o.line, text: (lines[o.line - 1] ?? "").trim().slice(0, 120), in: enclosing(lines, o.line) });
  }
  out.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  for (const r of references(files, name, skip)) {
    if (at.has(`${r.file}:${r.line}`)) continue;
    const here = index.byFileLine.get(r.file)?.get(r.line) ?? [];
    const lines = linesOf(r.file);
    const other = here.some((o) => o.symbol !== symbol && lines?.[r.line - 1]?.slice(o.start, o.end) === name);
    if (other && !here.some((o) => o.symbol === symbol)) continue;
    out.push(r);
  }
  return out;
}

/** The context pack: changed definitions in `owned` files, with references two levels out, as text for a prompt.
 * `index`: the project's SCIP index at the change, for references by symbol (paths relative to `root`). */
export function contextPack(root: string, diff: string, owned: string[], searchDirs: string[],
                            limit = CONTEXT_LIMIT, index: ScipIndex | null = null): string {
  const files = sourceFiles(root, searchDirs);
  const changed = changedLines(diff);
  const parts: string[] = [];
  const seen = new Set<string>();
  const split = new Map<string, string[] | null>();
  const linesOf = (file: string): string[] | null => {
    if (!split.has(file)) {
      let body = files.get(file) ?? null;
      if (body === null && SOURCE.test(file) && !isSecretPath(file)) {
        try {
          body = readFileSync(join(root, file), "utf8");
        } catch {
          body = null;
        }
      }
      split.set(file, body === null ? null : body.split("\n"));
    }
    return split.get(file)!;
  };
  const refsOf = (file: string, lines: string[], d: Def): Ref[] => {
    const symbol = index && symbolOf(index, lines, file, d);
    return symbol ? indexedReferences(files, linesOf, index!, symbol, d.name, { file, line: d.line })
      : references(files, d.name, { file, line: d.line });
  };
  for (const path of owned) {
    if (!SOURCE.test(path)) continue;
    const body = files.get(path) ?? (() => {
      try {
        return readFileSync(join(root, path), "utf8");
      } catch {
        return null;
      }
    })();
    if (body === null) continue;
    files.set(path, body);
    const lines = body.split("\n");
    const defs = new Map<string, Def>();
    for (const at of changed.get(path) ?? []) {
      const d = enclosing(lines, at);
      if (d && !defs.has(d.name)) defs.set(d.name, d);
    }
    for (const d of defs.values()) {
      const key = `${path}:${d.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const refs = refsOf(path, lines, d);
      const lines1 = [`- \`${path}\` ${d.kind} \`${d.name}\` (line ${d.line}): ` +
        (refs.length ? `${refs.length > MAX_REFS ? `more than ${MAX_REFS}` : refs.length} references` : "no references found")];
      for (const r of refs.slice(0, MAX_REFS)) {
        lines1.push(`  - ${r.file}:${r.line}${r.in ? ` in ${r.in.name}` : ""}: ${r.text}`);
        if (!r.in || r.in.name === d.name) continue;
        const k2 = `${r.file}:${r.in.name}`;
        if (seen.has(k2)) continue;
        seen.add(k2);
        // Second level: where the referring definition is used, by location only. A name used in many places
        // (main, run) says little, so it is left out.
        const r2s = refsOf(r.file, linesOf(r.file) ?? [], r.in);
        if (r2s.length && r2s.length <= MAX_REFS) {
          lines1.push(`    - \`${r.in.name}\` is used at ` +
            r2s.map((r2) => `${r2.file}:${r2.line}${r2.in ? ` (${r2.in.name})` : ""}`).join(", "));
        }
      }
      parts.push(lines1.join("\n"));
    }
  }
  let text = parts.join("\n");
  if (text.length > limit) text = text.slice(0, limit) + "\n[context truncated; use grep for more]";
  return text;
}

export const DEFINITIONS_LIMIT = 80_000;

/** The definitions the change touches, whole, after the change: from the definition line to the next line indented
 * no deeper (a closing brace stays with its block). For a tool-less reader in place of the whole files. */
export function changedDefinitions(root: string, diff: string, owned: string[], limit = DEFINITIONS_LIMIT): string {
  const changed = changedLines(diff);
  // A new file is whole in the diff already.
  const added = new Set([...diff.matchAll(/^--- \/dev\/null\n\+\+\+ b\/(.+)$/gm)].map((m) => m[1]!));
  const parts: string[] = [];
  let size = 0;
  for (const path of owned) {
    if (!SOURCE.test(path) || isSecretPath(path) || added.has(path)) continue;
    let body: string;
    try {
      body = readFileSync(join(root, path), "utf8");
    } catch {
      continue;
    }
    const lines = body.split("\n");
    const seen = new Set<number>();
    for (const at of changed.get(path) ?? []) {
      const d = enclosing(lines, at);
      if (!d || seen.has(d.line)) continue;
      seen.add(d.line);
      const top = indent(lines[d.line - 1]!);
      // A function ends at the next line indented no deeper (its closing brace stays); a constant, which may be a
      // multi-line string at column 0, ends at the next top-level statement.
      const startsStatement = (l: string) => [...FUNC, ...CONST].some((rx) => rx.test(l)) ||
        /^(?:class|import|from|export|use|pub|impl|struct|enum|type|interface|if|for|while|try|with|async|@)\b/.test(l);
      let end = d.line;
      while (end < lines.length) {
        const l = lines[end]!;
        if (d.kind === "constant" ? indent(l) === 0 && startsStatement(l)
          : l.trim() && indent(l) <= top && !/^[)\]}]/.test(l.trim())) break;
        end++;
      }
      while (end > d.line && !lines[end - 1]!.trim()) end--;
      const text = `<definition file="${path}" lines="${d.line}-${end}">\n${lines.slice(d.line - 1, end).join("\n")}\n</definition>`;
      if (size + text.length > limit) return parts.join("\n") + "\n[more definitions left out; the diff has the rest]";
      parts.push(text);
      size += text.length;
    }
  }
  return parts.join("\n");
}
