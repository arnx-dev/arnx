// What arnx never sends to a model or copies into a sandbox: files that usually hold secrets, text that looks like a
// key, and environment variable names that look like credentials.
import { createHash } from "node:crypto";
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

/** git pathspecs that leave secret files and arnx's own directory and .arnxignore out of diffs and status. */
export function excludePathspecs(): string[] {
  return [...SECRET_FILE_GLOBS.map((g) => `:(exclude,glob)**/${g}`), ":(exclude).arnx", ":(exclude).arnxignore"];
}
