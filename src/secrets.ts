// What arnx never sends to a model or copies into a sandbox: files that usually hold secrets, text that looks like a
// key, and environment variable names that look like credentials.
import { createHash, scryptSync } from "node:crypto";
import { posix } from "node:path";
import { comments, commentStyle } from "./comments";

export const SECRET_FILE_GLOBS: readonly string[] = [
  ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks", "id_rsa*", "id_ecdsa*",
  "id_ed25519*", ".netrc", ".npmrc", ".pypirc", "credentials*.json", "service-account*.json", "*.session",
  "*.session-journal"];
// A key starts a token: no letter or digit right before it, so `task-…` or `desk-…` is not an `sk-` key.
const CONTENT = new RegExp(
  "-----BEGIN [A-Z ]*PRIVATE KEY-----|(?<![A-Za-z0-9])(?:AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}" +
  "|sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}" +
  "|gh[pousr]_[A-Za-z0-9]{36,}|xox[abpr]-[A-Za-z0-9-]{10,})");
const ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE/i;

/** fnmatch.fnmatchcase for the simple globs above: * and ? only. */
export function globRegex(glob: string): RegExp {
  const body = [...glob].map((c) => c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"))
    .join("");
  return new RegExp(`^${body}$`, "s");
}
const SECRET_FILES = SECRET_FILE_GLOBS.map(globRegex);

export function isSecretPath(rel: string): boolean {
  const name = posix.basename(rel);
  return SECRET_FILES.some((r) => r.test(name));
}

export function hasSecretContent(text: string): boolean {
  return CONTENT.test(text);
}

/** A file the user allowed although it holds key-shaped text (a detector's fixtures): `matches` pins each such
 * string by a short hash, so the file stays allowed only while it holds no other. */
export interface SecretPin { path: string; matches: string[] }

const pinOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The pins of every key-shaped string in `text`, unique and sorted. */
export function secretPins(text: string): string[] {
  return [...new Set([...text.matchAll(new RegExp(CONTENT, "g"))].map((m) => pinOf(m[0])))].sort();
}

/** Names a match without repeating it: its well-known prefix. */
function label(match: string): string {
  return match.startsWith("-----") ? "a private key"
    : `${/^(sk-ant-|sk-(?:proj|svcacct|admin)-|sk-|AKIA|gh[pousr]_|xox[abpr]-)/.exec(match)![0]}…`;
}

/** The first key-shaped string in `text` that `pins` does not allow, with its line, or null. */
export function firstUnpinned(text: string, pins: readonly string[]): { line: number; label: string } | null {
  for (const m of text.matchAll(new RegExp(CONTENT, "g"))) {
    if (pins.includes(pinOf(m[0]))) continue;
    return { line: text.slice(0, m.index).split("\n").length, label: label(m[0]) };
  }
  return null;
}

/** What a snapshot does with a file's key-shaped strings that `pins` does not allow: `withhold` the file (naming the
 * first such string in code), or, when each one is inside a comment of a source file (a key in a doc example),
 * `blank` those comment lines: `text` is the file with them blanked, its line count kept. */
export type KeyScan = { withhold: { line: number; label: string } } | { blank: number[]; text: string };

/** A private key's END line. */
const KEY_END = /-----END [A-Z ]*PRIVATE KEY-----/;
/** Something like a key body anywhere: a run of 40 or more base64 characters in both cases. */
export const hasKeyBody = (text: string) => [...text.matchAll(/[A-Za-z0-9+/=]{40,}/g)]
  .some(([run]) => /[a-z]/.test(run) && /[A-Z]/.test(run));

export function scanKeys(path: string, text: string, pins: readonly string[]): KeyScan | null {
  const hits = [...text.matchAll(new RegExp(CONTENT, "g"))].filter((m) => !pins.includes(pinOf(m[0])));
  if (!hits.length) return null;
  const lineOf = (at: number) => text.slice(0, at).split("\n").length;
  const style = commentStyle(path);
  const spans = style ? comments(text, style) : [];
  const within = (a: number, b: number) => spans.find((s) => s.start <= a && b <= s.end);
  const inCode = hits.find((m) => !within(m.index, m.index + m[0].length));
  if (inCode) return { withhold: { line: lineOf(inCode.index), label: label(inCode[0]) } };
  const lines = text.split("\n");
  const starts: number[] = [];
  lines.reduce((at, l) => (starts.push(at), at + l.length + 1), 0);
  // A line holding nothing but comment: every non-blank character in a comment, each comment on it opened with only
  // blanks before it on its line. A comment after code may be a misread regex, string or JSX text, so a key on such a
  // line withholds the file.
  const opensClean = (s: { start: number }) => /^\s*$/.test(text.slice(text.lastIndexOf("\n", s.start - 1) + 1, s.start));
  const covered = (i: number) => {
    const from = starts[i]!, to = from + lines[i]!.length;
    return [...lines[i]!].every((ch, k) => /\s/.test(ch) || !!within(from + k, from + k + 1)) &&
      spans.every((s) => s.end <= from || s.start >= to || opensClean(s));
  };
  const blank = new Set<number>();
  for (const m of hits) {
    const at = lineOf(m.index) - 1;
    if (!covered(at)) return { withhold: { line: at + 1, label: label(m[0]) } };
    blank.add(at);
    if (!m[0].startsWith("-----") || KEY_END.test(lines[at]!)) continue;
    // A private key header is blanked with its block only when the block up to its END line lies in the comment.
    // With no END line, it is a placeholder (a doc example) only while the file holds no END and no key body.
    const withhold = { withhold: { line: at + 1, label: label(m[0]) } };
    let end = -1;
    for (let i = at + 1; i < lines.length && covered(i); i++) {
      if (KEY_END.test(lines[i]!)) {
        end = i;
        break;
      }
    }
    if (end < 0) {
      if (KEY_END.test(text) || hasKeyBody(text)) return withhold;
      continue;
    }
    // A block with no body in it: a body elsewhere (in code) withholds the file.
    if (!hasKeyBody(lines.slice(at, end + 1).join("\n")) && hasKeyBody(text)) return withhold;
    // A line of comment marks alone (a closing */) holds nothing to blank.
    for (let i = at + 1; i <= end; i++) if (!/^[\s*/#!]*$/.test(lines[i]!)) blank.add(i);
  }
  // A blanked line keeps its blanks and the comments' delimiters (an opening // or #, and /* and */ inside a block
  // comment, so nesting and closing stay as they were); the rest of each comment goes.
  for (const i of blank) {
    let out = "";
    const line = lines[i]!;
    for (let k = 0; k < line.length;) {
      const at = starts[i]! + k;
      const s = within(at, at + 1);
      if (!s || line[k] === "\r") {
        out += line[k++];
      } else if (at === s.start) {
        out += line.slice(k, k + s.open);
        k += s.open;
      } else if (s.block && (line.startsWith("/*", k) || line.startsWith("*/", k))) {
        out += line.slice(k, k + 2);
        k += 2;
      } else k++;
    }
    lines[i] = out;
  }
  return { blank: [...blank].sort((a, b) => a - b).map((i) => i + 1), text: lines.join("\n") };
}

/** A stand-in for `original`: its well-known prefix, then each digit, upper- and lower-case letter replaced by one of
 * its kind, other characters kept, so the shape (length, charset, separators) holds. Made from a slow hash of the
 * original, so the same key gets the same stand-in in every file and run, and the stand-in tells nothing about it. */
function fake(original: string, made: Map<string, string>): string {
  const known = made.get(original);
  if (known !== undefined) return known;
  const prefix = PREFIX.exec(original)?.[0] ?? "";
  const seed = scryptSync(original, "arnx stand-in", 32, { N: 1024 });
  const bytes: number[] = [];
  for (let i = 0; bytes.length < original.length; i++) {
    bytes.push(...createHash("sha256").update(seed).update(`${i}`).digest());
  }
  let out = prefix;
  for (let i = prefix.length; i < original.length; i++) {
    const c = original[i]!, b = bytes[i]!;
    out += /[0-9]/.test(c) ? String.fromCharCode(48 + b % 10) : /[A-Z]/.test(c) ? String.fromCharCode(65 + b % 26)
      : /[a-z]/.test(c) ? String.fromCharCode(97 + b % 26) : c;
  }
  made.set(original, out);
  return out;
}
const PREFIX = /^(sk-ant-|sk-(?:proj|svcacct|admin)-|sk-|AKIA|gh[pousr]_|xox[abpr]-)/;
/** A run that may be a key's body next to a key (an AWS secret beside its key id): 40 or more base64 characters in
 * both cases, with a digit, + or /. A long name in code has none of these. */
const BODY = /[A-Za-z0-9+/=]{40,}/g;
const isBody = (run: string) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9+/]/.test(run);

/** `text` with a stand-in for each key-shaped string `pins` does not allow, and for each run that may be a key's body
 * (BODY), or null when no stand-in can keep the real value out: a private key with a body. A private key header with
 * no body anywhere in the file is a placeholder (a form's hint, a doc example) and stays as it is. `count`: the
 * strings replaced. */
export function standIn(text: string, pins: readonly string[]): { text: string; count: number } | null {
  const all = [...text.matchAll(new RegExp(CONTENT, "g"))];
  const hits = all.filter((m) => !pins.includes(pinOf(m[0])));
  const header = (m: RegExpMatchArray) => m[0].startsWith("-----");
  if (hits.some(header)) {
    // Key-shaped strings aside, any run like a key body may be the private key's.
    let rest = text;
    for (const m of all.filter((x) => !header(x)).reverse()) {
      rest = rest.slice(0, m.index) + " " + rest.slice(m.index! + m[0].length);
    }
    if (hasKeyBody(rest)) return null;
  }
  const made = new Map<string, string>();
  const keys = hits.filter((x) => !header(x));
  let count = 0, out = text;
  for (const m of [...keys].reverse()) {
    out = out.slice(0, m.index) + fake(m[0], made) + out.slice(m.index! + m[0].length);
    count++;
  }
  // An allowed key stays as it is, and so does a run that holds one; a run within a stand-in is done.
  const kept = [...out.matchAll(new RegExp(CONTENT, "g"))].filter((m) => pins.includes(pinOf(m[0])))
    .map((m) => [m.index!, m.index! + m[0].length]);
  const done = keys.map((m) => [m.index!, m.index! + m[0].length]);
  out = out.replace(BODY, (run, at: number) => {
    const end = at + run.length;
    if (!isBody(run) || kept.some(([a, b]) => a! < end && at < b!) || done.some(([a, b]) => a! <= at && end <= b!)) {
      return run;
    }
    count++;
    return fake(run, made);
  });
  return { text: out, count };
}

/** Every key-shaped string in `text`, by line and label (never the string itself). */
export function secretHits(text: string): { line: number; label: string }[] {
  const out: { line: number; label: string }[] = [];
  let line = 1, at = 0;
  for (const m of text.matchAll(new RegExp(CONTENT, "g"))) {
    for (; at < m.index; at++) if (text.charCodeAt(at) === 10) line++;
    out.push({ line, label: label(m[0]) });
  }
  return out;
}

export function isSecretEnvName(name: string): boolean {
  return ENV_NAME.test(name);
}

/** An env value arnx makes up for a variable whose name looks like a secret, so it needs no allow_env_names:
 * `arnx:generated` is 64 hex digits, `arnx:generated:base64` 32 bytes in URL-safe base64 (a Fernet key). The same in
 * every run and project, so a service and the code using it agree; nothing real. */
export const GENERATED = /^arnx:generated(?::base64)?$/;

/** The value a run gets for `value`: a generated one for GENERATED, otherwise `value` itself. */
export function envValue(value: string): string {
  if (!GENERATED.test(value)) return value;
  const bytes = createHash("sha256").update(`arnx generated ${value}`).digest();
  return value.endsWith(":base64") ? `${bytes.toString("base64url")}=` : bytes.toString("hex");
}

/** git pathspecs that leave secret files and arnx's own directory and .arnxignore out of diffs and status. */
export function excludePathspecs(): string[] {
  return [...SECRET_FILE_GLOBS.map((g) => `:(exclude,glob)**/${g}`), ":(exclude).arnx", ":(exclude).arnxignore"];
}
