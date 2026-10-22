// What arnx never sends to a model or copies into a sandbox: files that usually hold secrets, text that looks like a
// key, and environment variable names that look like credentials.
import { createHash } from "node:crypto";
import { posix } from "node:path";

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
