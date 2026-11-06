// What the second opinion is given beside the diff and the test, without a model and the same on every run: the
// commit message, how the test ran before the change, the names the test uses that the change defines, the code that
// calls them (two levels out), the project's own tests of them, their docs, and what kind of test it is. With no tools,
// the judge can only tell intended or unreachable behaviour from a defect by what it is shown.
//
// It reads a tree and never writes one: the round's snapshot (snapshotTree), or a commit's git objects (gitTree). It
// runs no project code. A commit's objects hold the real values, so gitTree masks each file before it gives it out;
// a snapshot holds stand-ins and guesses, and what a round keeps of it is masked when the round ends (testround.ts).
import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join, posix } from "node:path";
import type { Before } from "./before";
import { Boundary } from "./boundary";
import { CODE_LANGUAGES, codeText, inTestFolder } from "./codetext";
import { changedLines, type Def, enclosing } from "./context";
import { isTestPath } from "./detect";
import { loadIgnore } from "./ignore";
import { isSecretPath, suspects } from "./secrets";
import { type Shallow, testText } from "./shallow";
import { SOURCE } from "./untested";

/** The most a pack holds, in characters. */
export const EVIDENCE_LIMIT = 12_000;

/** A tree of files to read: paths relative to its top, with `/`. `read` gives null for a file it does not hold or
 * will not give out (a secret file, a link, binary content). */
export interface TreeReader { read(path: string): string | null; files(): string[] }

/** How much of a tree one pack reads: files, bytes, and milliseconds. Reached, the pack says the search stopped. */
export interface Scan { files: number; bytes: number; ms: number }
export const EVIDENCE_SCAN: Scan = { files: 20_000, bytes: 64_000_000, ms: 8_000 };

const MAX_FILE_BYTES = 400_000;
const SKIP_DIRS = new Set(["node_modules", ".git", "target", "dist", "build", ".venv", "venv", "__pycache__", ".next",
  ".nuxt", ".svelte-kit", ".turbo", ".arnx", ".arnx-run", "vendor", ".tox", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", "coverage", "site-packages", ".cache"]);
const skipped = (path: string) => path.split("/").slice(0, -1).some((d) => SKIP_DIRS.has(d));

const MAX_NAMES = 5, CALLERS_PER_NAME = 6, CALLERS_COUNTED = 24, TESTS_PER_NAME = 4, TESTS_PER_FILE = 2,
  TESTS_COUNTED = 200, DOC_HITS = 6;
/** A caller used in more places than this says little about how the code is reached: only the count is given. */
const SECOND_LEVEL_MOST = 12, SECOND_LEVEL_SHOWN = 3;
const MESSAGE_CAP = 1_500, BEFORE_CAP = 300, LINE_CAP = 160;

const TEMPLATE = /\.(?:html?|vue|svelte|astro|jinja2?|j2|njk|hbs|erb)$/i;
const DOC = /\.(?:md|mdx|rst)$|(?:^|\/)CHANGELOG[^/]*$|(?:^|\/)\.changeset\//i;
const CODE_EXT = new Set(CODE_LANGUAGES);
const TEST_FILE = /(?:^|\/)conftest\.py$|_test\.(?:go|rb|py)$|_spec\.rb$|Tests?\.(?:java|kt|cs|swift)$/;
type Kind = "source" | "test" | "doc" | "template";

function kindOf(path: string): Kind | null {
  if (DOC.test(path)) return "doc";
  const code = SOURCE.test(path);
  if (code && (isTestPath(path) || inTestFolder(path) || TEST_FILE.test(path))) return "test";
  if (code) return "source";
  if (TEMPLATE.test(path)) return inTestFolder(path) ? null : "template";
  return null;
}

/** The files of the round's snapshot at `root`, read as they are there. Links are not followed. */
export function snapshotTree(root: string): TreeReader {
  const top = realpathSync(root);
  let listed: string[] | null = null;
  const texts = new Map<string, string | null>();
  const walk = (rel: string, out: string[]) => {
    let names: string[];
    try {
      names = readdirSync(rel ? join(top, rel) : top).sort();
    } catch {
      return;
    }
    for (const name of names) {
      const r = rel ? `${rel}/${name}` : name;
      let st;
      try {
        st = lstatSync(join(top, r));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(r, out);
      } else if (st.isFile() && st.size <= MAX_FILE_BYTES && !isSecretPath(r) && kindOf(r)) out.push(r);
    }
  };
  return {
    files: () => listed ??= (() => {
      const out: string[] = [];
      walk("", out);
      return out;
    })(),
    read(path) {
      if (texts.has(path)) return texts.get(path)!;
      let text: string | null = null;
      const rel = posix.normalize(path);
      if (!isAbsolute(rel) && !rel.startsWith("..") && !isSecretPath(rel)) {
        try {
          const full = join(top, rel);
          // A link anywhere on the way may lead out of the snapshot: only a plain file inside it is read.
          const st = lstatSync(full);
          if (st.isFile() && st.size <= MAX_FILE_BYTES && realpathSync(full) === full) {
            const raw = readFileSync(full, "utf8");
            text = raw.includes("\0") ? null : raw;
          }
        } catch {
          text = null;
        }
      }
      texts.set(path, text);
      return text;
    },
  };
}

/** Git as gitTree runs it: reading objects only, and never fetching one a partial clone lacks. */
function gitRead(repo: string, args: string[], input?: string): Buffer | null {
  const r = spawnSync("git", ["-C", repo, ...args], { input, maxBuffer: 1 << 30,
    env: { ...process.env, GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" } });
  return r.status === 0 && !r.error ? r.stdout : null;
}

/** The files of `commit` in `repo`, read from its git objects: nothing is checked out or written. Each file is masked
 * before it is given out, as all that leaves arnx is (boundary.ts): its private keys, and every value any file of the
 * tree holds that looks like a secret, the boundary's own values too. Secret files, files .arnxignore leaves out,
 * links and submodules are not given out. */
export function gitTree(repo: string, commit: string, boundary = new Boundary()): TreeReader {
  const ignored = loadIgnore(repo);
  let listed: { path: string; oid: string }[] | null = null;
  const list = () => listed ??= (() => {
    const out = gitRead(repo, ["ls-tree", "-r", "-z", "-l", commit]);
    if (!out) return [];
    const entries: { path: string; oid: string }[] = [];
    for (const rec of out.toString("utf8").split("\0")) {
      const m = /^(\d+) (\w+) ([0-9a-f]+)\s+(-|\d+)\t(.+)$/s.exec(rec);
      if (!m || m[2] !== "blob" || m[1] === "120000" || m[4] === "-" || Number(m[4]) > MAX_FILE_BYTES) continue;
      const path = m[5]!;
      if (isSecretPath(path) || ignored(path) || skipped(path) || !kindOf(path)) continue;
      entries.push({ path, oid: m[3]! });
    }
    return entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  })();
  let raw: Map<string, string> | null = null;
  // Every file's values are known before any file is given out, so a value one file names is masked in all.
  const load = () => raw ??= (() => {
    const texts = new Map<string, string>();
    const entries = list();
    const out = entries.length ? gitRead(repo, ["cat-file", "--batch"], entries.map((e) => e.oid).join("\n") + "\n") : null;
    if (!out) return texts;
    const byOid = new Map<string, string[]>();
    for (const e of entries) byOid.set(e.oid, [...byOid.get(e.oid) ?? [], e.path]);
    let at = 0;
    while (at < out.length) {
      const nl = out.indexOf(10, at);
      if (nl < 0) break;
      const head = out.toString("utf8", at, nl).split(" ");
      at = nl + 1;
      if (head.length < 3) continue; // "<oid> missing"
      const size = Number(head[2]);
      const body = out.subarray(at, at + size);
      at += size + 1;
      if (body.includes(0)) continue;
      const text = body.toString("utf8");
      for (const path of byOid.get(head[0]!) ?? []) texts.set(path, text);
    }
    const values: string[] = [];
    for (const [path, text] of texts) values.push(...suspects(path, text, []));
    boundary.add(values);
    return texts;
  })();
  const shown = new Map<string, string>();
  return {
    files: () => list().map((e) => e.path),
    read(path) {
      const known = shown.get(path);
      if (known !== undefined) return known;
      const text = load().get(path);
      if (text === undefined) return null;
      const masked = boundary.mask(text);
      shown.set(path, masked);
      return masked;
    },
  };
}

// ---- the pack

export interface EvidenceInput {
  tree: TreeReader;
  /** The part of the change the finding's project was given. */
  diff: string;
  /** The generated test file, and the test's name in it. */
  testSource: string; func: string;
  /** The test file's path: its language says what in it is code. */
  testFile?: string;
  /** The file the finding's suspect is in, when it has one. */
  suspectFile?: string;
  commitMessage: string;
  before?: Before;
  shallow?: Shallow;
  /** Where the generated tests are: none of them is a project test or a caller. */
  writeDir: string;
  limit?: number;
  scan?: Partial<Scan>;
}

interface Hit { file: string; line: number }
/** A name the pack follows: a definition (a function, a constant, a class), or a name a changed line holds. */
interface Target { name: string; kind: Def["kind"] | "class" | "name"; line: number; file: string; notes: string[] }

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const wordRx = (name: string) => new RegExp(`(?<![\\w$])${esc(name)}(?![\\w$])`);
const cut = (s: string, n: number) => (s.length <= n ? s : s.slice(0, n - 1) + "…");
const inDir = (path: string, dir: string) => !!dir && (path === dir || path.startsWith(`${dir.replace(/\/$/, "")}/`));
const IMPORT = /^\s*(?:import\b|from\s+\S+\s+import\b|export\s*\{|export\s+\*|(?:const|let|var)\s+[^=]*=\s*require\s*\(|use\s)/;
/** A name looked for in prose as a plain word; a short plain one (`add`, `total`) counts there only as code. */
const distinctive = (name: string) => /[_$\d]|[a-z][A-Z]/.test(name) || name.length >= 12;

/** What a pack reads of its tree: each file's lines and its code lines (no comments or strings), within its bound. */
class Reading {
  private lines = new Map<string, string[] | null>();
  private code = new Map<string, string[]>();
  private kinds = new Map<string, Kind | null>();
  read = 0;
  bytes = 0;
  stopped: "files" | "bytes" | "time" | null = null;
  private readonly until: number;
  constructor(readonly tree: TreeReader, readonly order: string[], private readonly scan: Scan) {
    this.until = performance.now() + scan.ms;
  }

  kind(path: string): Kind | null {
    if (!this.kinds.has(path)) this.kinds.set(path, kindOf(path));
    return this.kinds.get(path)!;
  }

  linesOf(path: string): string[] | null {
    if (!this.lines.has(path)) {
      const text = this.tree.read(path);
      this.lines.set(path, text === null ? null : text.split("\n"));
      this.read++;
      this.bytes += text?.length ?? 0;
    }
    return this.lines.get(path)!;
  }

  codeOf(path: string): string[] | null {
    const known = this.code.get(path);
    if (known) return known;
    const lines = this.linesOf(path);
    if (!lines) return null;
    const ext = posix.extname(path).slice(1).toLowerCase();
    const code = CODE_EXT.has(ext) ? codeText(lines.join("\n"), path).split("\n") : lines;
    this.code.set(path, code);
    return code;
  }

  /** The files to search, in order: those read already, and new ones while the bound allows. */
  *each(): Generator<string> {
    for (const path of this.order) {
      if (!this.lines.has(path)) {
        const over = this.read >= this.scan.files ? "files" : this.bytes >= this.scan.bytes ? "bytes"
          : performance.now() >= this.until ? "time" : null;
        if (over) {
          this.stopped ??= over;
          continue;
        }
      }
      yield path;
    }
  }
}

/** Where `name` is used in files of `kinds`: in code, not in a comment, a string or an import (a template's text
 * counts). At most `most` + 1. */
function uses(r: Reading, name: string, kinds: Set<Kind>, skip: (h: Hit) => boolean, most: number): Hit[] {
  const rx = wordRx(name);
  const out: Hit[] = [];
  for (const file of r.each()) {
    if (!kinds.has(r.kind(file)!)) continue;
    const lines = r.linesOf(file);
    if (!lines || !lines.some((l) => l.includes(name))) continue;
    const code = r.codeOf(file)!;
    for (let i = 0; i < code.length; i++) {
      if (!code[i]!.includes(name) || !rx.test(code[i]!) || IMPORT.test(lines[i]!)) continue;
      const hit = { file, line: i + 1 };
      if (skip(hit)) continue;
      // A definition of the same name is no use of it.
      const d = enclosing(lines, i + 1);
      if ((d && d.line === i + 1 && d.name === name) || classAt(lines[i]!) === name) continue;
      out.push(hit);
      if (out.length > most) return out;
    }
  }
  return out;
}

const around = (lines: string[], at: number, n: number) => {
  const out: string[] = [];
  // A file's last newline ends its last line: no empty line after it.
  const last = lines.length - (lines.at(-1) === "" ? 1 : 0);
  for (let i = Math.max(1, at - n); i <= Math.min(last, at + n); i++) {
    out.push(`    ${i} | ${cut(lines[i - 1]!, LINE_CAP)}`);
  }
  return out.join("\n");
};

/** The identifiers `source` uses in its code. */
const namesIn = (source: string, path: string) => new Set(codeText(source, path).match(/[A-Za-z_$][\w$]*/g) ?? []);

const CLASS = /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:class|struct|enum|impl)\s+([A-Za-z_$][\w$]*)/;
const classAt = (line: string) => CLASS.exec(line)?.[1] ?? null;
const indent = (s: string) => s.length - s.trimStart().length;

/** A line that may define a function, for enclosing to say. */
const MAY_DEFINE = /\b(?:def|function|fn)\b|=>|\)\s*(?::[^{]+)?\{\s*$/;

/** The function that holds line `at`: the nearest definition above it that every code line between is indented
 * deeper than, so a nested function that ended above does not count; read on the code lines (`code`, strings
 * blanked), so a string's text at the margin ends nothing. Else what enclosing says when it is a constant. */
function holder(lines: string[], code: string[], at: number): Def | null {
  const here = code[at - 1] ?? "";
  let deepest = here.trim() ? indent(here) : Infinity;
  for (let i = at - 2; i >= 0; i--) {
    const c = code[i] ?? "";
    // A blanked string's quotes, and a line a closing bracket starts (a signature's `) -> T:`), say nothing of the
    // code's depth.
    if (/^[\s'"`;,]*$/.test(c) || /^\s*[)\]}]/.test(c)) continue;
    const l = lines[i]!;
    if (indent(c) < deepest && MAY_DEFINE.test(l)) {
      const d = enclosing(lines, i + 1);
      if (d && d.line === i + 1 && d.kind === "function") return d;
    }
    if (/^\s*@/.test(c)) continue;
    deepest = Math.min(deepest, indent(c));
    if (deepest === 0) break;
  }
  const d = enclosing(lines, at);
  return d?.kind === "constant" ? d : null;
}

/** The class a line is in when no function or constant holds it (a class attribute). */
function classOf(lines: string[], at: number): Target | null {
  const here = lines[at - 1] ?? "";
  let depth = here.trim() ? indent(here) : Infinity;
  for (let i = at - 1; i >= 0; i--) {
    const l = lines[i]!;
    if (!l.trim() || (i < at - 1 && indent(l) >= depth)) continue;
    const name = classAt(l);
    if (name) return { name, kind: "class", line: i + 1, file: "", notes: [] };
    if (indent(l) === 0 && i < at - 1 && !/^[)\]}"'`@#]/.test(l)) return null;
    depth = Math.min(depth, indent(l));
  }
  return null;
}

/** Words no pack follows: keywords, and what tests and imports say in every language. */
const COMMON = new Set(["import", "from", "export", "default", "const", "let", "var", "function", "return", "async",
  "await", "class", "def", "self", "this", "new", "true", "false", "null", "undefined", "None", "True", "False", "type",
  "interface", "extends", "implements", "public", "private", "static", "readonly", "for", "while", "if", "else", "try",
  "catch", "with", "yield", "pass", "lambda", "not", "and", "the", "use", "mod", "pub", "impl", "struct", "enum", "mut",
  "string", "number", "boolean", "object", "any", "never", "unknown", "void", "expect", "assert", "describe", "test",
  "require", "module", "exports"]);

/** Names on the diff's changed lines of source files that are no definition (`export { A } from`, a list entry), by
 * the line that holds them. */
function changedNames(r: Reading, diff: string, writeDir: string): Target[] {
  const out: Target[] = [];
  for (const [file, at] of changedLines(diff)) {
    const kind = r.kind(file);
    if ((kind !== "source" && kind !== "template") || inDir(file, writeDir)) continue;
    const lines = r.linesOf(file);
    if (!lines) continue;
    const code = r.codeOf(file)!;
    for (const n of new Set(at)) {
      for (const name of code[n - 1]?.match(/[A-Za-z_$][\w$]*/g) ?? []) {
        if (name.length >= 3 && !COMMON.has(name)) out.push({ name, kind: "name", line: n, file, notes: [] });
      }
    }
  }
  return out;
}

/** Definitions the diff changes or adds, by file in the diff's order, with what their own lines say of them. */
function changedDefs(r: Reading, diff: string, writeDir: string): Target[] {
  const out: Target[] = [];
  for (const [file, at] of changedLines(diff)) {
    const kind = r.kind(file);
    if ((kind !== "source" && kind !== "template") || inDir(file, writeDir)) continue;
    const lines = r.linesOf(file);
    if (!lines) continue;
    const seen = new Set<string>();
    for (const n of at) {
      const d = holder(lines, r.codeOf(file)!, n) ?? classOf(lines, n);
      if (!d || seen.has(d.name) || d.name.length < 3 || /^__\w+__$/.test(d.name)) continue;
      seen.add(d.name);
      const notes: string[] = [];
      if (/^\s*export\b/.test(lines[d.line - 1]!)) notes.push("exported");
      const decorators: string[] = [];
      for (let i = d.line - 2; i >= 0 && /^\s*@/.test(lines[i]!); i--) decorators.unshift(cut(lines[i]!.trim(), 60));
      if (decorators.length) notes.push(`decorated ${decorators.map((x) => `\`${x}\``).join(", ")}`);
      out.push({ ...d, file, notes });
    }
  }
  return out;
}

function dedupe(list: Target[]): Target[] {
  const seen = new Set<string>();
  return list.filter((d) => !seen.has(d.name) && (seen.add(d.name), true));
}

/** The names of the pack: the changed definitions the test uses (its own lines first, then its file's), else the
 * names on changed lines it uses, the suspect's file first; when it uses none, the changed definitions of the suspect's
 * file, else of the first file that has any. */
function targetsOf(defs: Target[], names: Target[], o: EvidenceInput): { targets: Target[]; used: boolean } {
  const path = o.testFile ?? "test.py";
  const order = (list: Target[]) => [...list.filter((d) => d.file === o.suspectFile),
    ...list.filter((d) => d.file !== o.suspectFile)];
  const own = namesIn(testText(o.testSource, o.func), path), all = namesIn(o.testSource, path);
  for (const list of [defs, names]) {
    const used = dedupe([...order(list.filter((d) => own.has(d.name))), ...order(list.filter((d) => all.has(d.name)))]);
    if (used.length) return { targets: used.slice(0, MAX_NAMES), used: true };
  }
  const file = defs.some((d) => d.file === o.suspectFile) ? o.suspectFile : defs[0]?.file;
  return { targets: dedupe(defs.filter((d) => d.file === file)).slice(0, MAX_NAMES), used: false };
}

/** The docstring under a Python definition, or the comment right above a definition. */
function ownDoc(lines: string[], d: Target): { line: number; text: string } | null {
  let sig = d.line;
  // A signature may run over lines.
  while (sig < lines.length && sig < d.line + 6 && !/[:{]\s*(?:#.*)?$/.test(lines[sig - 1]!)) sig++;
  const first = lines[sig]?.trim() ?? "";
  const q = /^[rubf]*("""|''')/i.exec(first)?.[1];
  if (q) {
    const body: string[] = [];
    for (let i = sig; i < Math.min(lines.length, sig + 8); i++) {
      const l = i === sig ? first.replace(/^[rubf]*("""|''')/i, "") : lines[i]!.trim();
      body.push(l);
      if (l.includes(q)) break;
    }
    const text = body.join(" ").replace(q, "").replace(/\s+/g, " ").trim();
    return text ? { line: sig + 1, text } : null;
  }
  const above: string[] = [];
  let i = d.line - 2;
  while (i >= 0 && /^\s*@/.test(lines[i]!)) i--;
  for (; i >= 0 && above.length < 8; i--) {
    const l = lines[i]!.trim();
    if (!/^(?:\/\/|\/\*|\*|#(?!\[)|--)/.test(l)) break;
    above.unshift(l.replace(/^(?:\/\/\/?|\/\*\*?|\*\/|\*|#|--)\s?/, "").replace(/\*\/$/, ""));
  }
  const text = above.join(" ").replace(/\s+/g, " ").trim();
  return text ? { line: i + 2, text } : null;
}

/** How the test is written, where that bears on whether it shows a real defect: private names it reaches, type
 * checks it switches off, what it patches, and whether it checks the code's text. Facts only. */
function testShape(o: EvidenceInput): string[] {
  const raw = testText(o.testSource, o.func);
  const code = codeText(raw, o.testFile ?? "test.py");
  const out: string[] = [];
  const priv = new Set<string>();
  for (const m of code.matchAll(/(?:^|[^\w$])\.?(_[A-Za-z][\w$]*)/g)) priv.add(m[1]!);
  for (const m of raw.matchAll(/\[\s*['"](_[A-Za-z][\w$]*)['"]\s*\]/g)) priv.add(m[1]!);
  if (priv.size) out.push(`uses private names: ${[...priv].slice(0, 5).map((n) => `\`${n}\``).join(", ")}`);
  const marks: [RegExp, string][] = [[/\bas\s+never\b/, "`as never`"], [/\bas\s+any\b/, "`as any`"],
    [/@ts-ignore\b/, "`@ts-ignore`"], [/@ts-expect-error\b/, "`@ts-expect-error`"],
    [/#\s*type:\s*ignore\b/, "`# type: ignore`"]];
  for (const [rx, label] of marks) if (rx.test(raw)) out.push(label);
  const patches: [RegExp, string][] = [[/\bmonkeypatch\b/, "monkeypatch"],
    [/(?<![\w$])(?:mock\.)?patch(?:\.object|\.dict)?\s*\(|@patch\b/, "patch"],
    [/\b(?:jest|vi)\.(?:mock|spyOn)\s*\(/, "a module or function mock"], [/\bsetattr\b/, "setattr"],
    [/\bbuiltins\b/, "builtins"]];
  for (const [rx, label] of patches) if (rx.test(code)) out.push(`uses ${label}`);
  if (o.shallow === "source-text") out.push("reads the code as text");
  if (o.shallow === "existence") out.push("checks only that something exists");
  return out;
}

interface Section { title: string; body: string[]; fixed?: true }

/** The evidence pack for one finding: plain text, at most `limit` characters, the same for the same tree and input. */
export function judgeEvidence(o: EvidenceInput): string {
  const limit = o.limit ?? EVIDENCE_LIMIT;
  const changed = [...changedLines(o.diff).keys()];
  const near = new Set(changed.map((p) => posix.dirname(p)));
  // The change's own files first, then their folders', then the rest: a bound leaves out the farthest.
  const rank = (p: string) => (changed.includes(p) ? 0 : near.has(posix.dirname(p)) ? 1 : 2);
  const order = o.tree.files().filter((p) => !inDir(p, o.writeDir) && kindOf(p)).map((p, i) => [rank(p), i, p] as const)
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]).map((x) => x[2]);
  const r = new Reading(o.tree, order, { ...EVIDENCE_SCAN, ...o.scan });

  const sections: Section[] = [];
  const message = o.commitMessage.trim();
  sections.push({ title: "Commit message", fixed: true,
    body: [message ? cut(message, MESSAGE_CAP) : "(none: the change is not committed)"] });
  if (o.before) {
    const b = o.before;
    const first = (b.message ?? "").trim().split("\n")[0] ?? "";
    sections.push({ title: "Before the change", fixed: true, body: [cut(`${b.status}; runs: ${b.runs.join(", ") || "none"}` +
      (first ? `; failure: ${first}` : ""), BEFORE_CAP)] });
  }
  const { targets, used } = targetsOf(changedDefs(r, o.diff, o.writeDir), changedNames(r, o.diff, o.writeDir), o);
  sections.push({ title: "Target names", fixed: true, body: !targets.length
    ? ["none found: the diff changes no definition by a name"]
    : [...used ? [] : [`(the test uses none of the changed definitions: these are the changed definitions of ${targets[0]!.file})`],
      ...targets.map((t) => `- \`${t.name}\` (${t.kind}, ${t.file}:${t.line}${t.notes.length ? `, ${t.notes.join(", ")}` : ""})`)] });

  const callers: string[] = [], tests: string[] = [], docs: string[] = [];
  const sourceKinds = new Set<Kind>(["source", "template"]), testKinds = new Set<Kind>(["test"]);
  const changedFirst = (hits: Hit[]) => [...hits.filter((h) => changed.includes(h.file)),
    ...hits.filter((h) => !changed.includes(h.file))];
  const count = (n: number, most: number, one: string, many: string) => n > most ? `more than ${most} ${many}`
    : `${n} ${n === 1 ? one : many}`;
  for (const t of targets) {
    const found = uses(r, t.name, sourceKinds, (h) => h.file === t.file && h.line === t.line, CALLERS_COUNTED);
    if (!found.length) callers.push(`\`${t.name}\` (${t.file}:${t.line}): no caller found`);
    else {
      callers.push(`\`${t.name}\` (${t.file}:${t.line}): ${count(found.length, CALLERS_COUNTED, "caller line", "caller lines")}`);
      const upDone = new Set<string>();
      for (const h of changedFirst(found).slice(0, CALLERS_PER_NAME)) {
        const lines = r.linesOf(h.file)!;
        const d = holder(lines, r.codeOf(h.file)!, h.line);
        const entry = [`- ${h.file}:${h.line}${d ? ` in \`${d.name}\`` : ""}`, around(lines, h.line, 1)];
        // Second level: where the calling definition is used, by place only.
        if (d && d.name !== t.name && !/^__\w+__$/.test(d.name) && !upDone.has(`${h.file}:${d.name}`)) {
          upDone.add(`${h.file}:${d.name}`);
          const up = uses(r, d.name, sourceKinds, (x) => x.file === h.file && x.line === d.line, SECOND_LEVEL_MOST);
          entry.push(!up.length ? `  \`${d.name}\`: no caller found`
            : up.length > SECOND_LEVEL_MOST ? `  \`${d.name}\` is used in more than ${SECOND_LEVEL_MOST} places`
              : `  \`${d.name}\` is used at ${up.slice(0, SECOND_LEVEL_SHOWN).map((x) => `${x.file}:${x.line}`).join(", ")}` +
                (up.length > SECOND_LEVEL_SHOWN ? ` and ${up.length - SECOND_LEVEL_SHOWN} more` : ""));
        }
        callers.push(entry.join("\n"));
      }
    }
    const inTests = uses(r, t.name, testKinds, () => false, TESTS_COUNTED);
    if (!inTests.length) tests.push(`\`${t.name}\`: no project test found`);
    else {
      tests.push(`\`${t.name}\`: ${count(inTests.length, TESTS_COUNTED, "line", "lines")} in the project's tests`);
      const perFile = new Map<string, number>();
      const picked = changedFirst(inTests).filter((h) => {
        const n = perFile.get(h.file) ?? 0;
        perFile.set(h.file, n + 1);
        return n < TESTS_PER_FILE;
      }).slice(0, TESTS_PER_NAME);
      for (const h of picked) tests.push(`- ${h.file}:${h.line}\n${around(r.linesOf(h.file)!, h.line, 3)}`);
    }
  }
  // Docs: each target's own docstring or comment, then the project's docs, changed ones first.
  for (const t of targets) {
    const own = t.kind === "name" ? null : ownDoc(r.linesOf(t.file) ?? [], t);
    if (own && docs.length < DOC_HITS) docs.push(`- ${t.file}:${own.line} (on \`${t.name}\`): ${cut(own.text, 400)}`);
  }
  if (targets.length && docs.length < DOC_HITS) {
    const looks = targets.map((t) => {
      const n = esc(t.name);
      const word = wordRx(t.name), quoted = new RegExp(`\`[^\`]*(?<![\\w$])${n}(?![\\w$])[^\`]*\``),
        called = new RegExp(`(?<![\\w$])${n}\\s*\\(|\\.${n}(?![\\w$])`);
      const plain = distinctive(t.name);
      return (l: string, fenced: boolean) => l.includes(t.name) && word.test(l) && (plain || fenced || quoted.test(l) ||
        called.test(l));
    });
    const docFiles = [...r.each()].filter((p) => r.kind(p) === "doc");
    for (const file of changedFirst(docFiles.map((f) => ({ file: f, line: 0 }))).map((h) => h.file)) {
      const lines = r.linesOf(file);
      if (!lines) continue;
      let fenced = false;
      for (let i = 0; i < lines.length && docs.length < DOC_HITS; i++) {
        const l = lines[i]!;
        if (/^\s*(?:```|~~~)/.test(l)) fenced = !fenced;
        if (looks.some((look) => look(l, fenced))) docs.push(`- ${file}:${i + 1}: ${cut(l.trim(), 200)}`);
      }
      if (docs.length >= DOC_HITS) break;
    }
  }
  if (targets.length) {
    sections.push({ title: "Callers", body: callers });
    sections.push({ title: "Project tests", body: tests });
    sections.push({ title: "Docs", body: docs.length ? docs : ["no doc found"] });
  }
  const shape = testShape(o);
  if (shape.length) sections.push({ title: "Test shape", fixed: true, body: shape.map((s) => `- ${s}`) });
  const stop = r.stopped ? `(the search stopped at its ${{ time: "time", bytes: "size", files: "file" }[r.stopped]} ` +
    `limit after ${r.read} files: callers, tests and docs farther from the change may be missing)` : "";
  return fit(sections, stop, limit);
}

/** The sections in order, each entry whole: the fixed ones as they are, then callers, tests and docs, each given a
 * share of what is left (half, then most of the rest, then all); entries that do not fit are counted. */
function fit(sections: Section[], stop: string, limit: number): string {
  const head = (s: Section) => `## ${s.title}\n`;
  const MORE = 40; // room for the line counting what is left out
  let left = limit - (stop ? stop.length + 2 : 0);
  for (const s of sections) if (s.fixed) left -= head(s).length + s.body.join("\n").length + 2;
  const flexible = sections.filter((s) => !s.fixed);
  const shares = [0.5, 0.6, 1].slice(3 - flexible.length);
  const kept = new Map<Section, string[]>();
  flexible.forEach((s, i) => {
    let budget = Math.floor(Math.max(0, left - head(s).length - 2) * shares[i]!) - MORE;
    const out: string[] = [];
    let dropped = 0;
    for (const e of s.body) {
      if (e.length + 1 <= budget) {
        out.push(e);
        budget -= e.length + 1;
      } else dropped++;
    }
    if (dropped) out.push(`[${dropped} more not shown]`);
    kept.set(s, out);
    left -= head(s).length + out.join("\n").length + 2;
  });
  let text = sections.map((s) => head(s) + (kept.get(s) ?? s.body).join("\n")).join("\n\n") + (stop ? `\n\n${stop}` : "");
  if (text.length > limit) {
    // Only a limit smaller than the fixed sections gets here: cut at a line.
    const mark = "\n[evidence cut]";
    text = text.slice(0, Math.max(0, limit - mark.length));
    text = text.slice(0, Math.max(0, text.lastIndexOf("\n"))) + mark;
  }
  return text;
}
