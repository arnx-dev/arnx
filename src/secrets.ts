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
/** What every CONTENT match holds: a fast test first, since CONTENT's look-behind is slow on a large tree. */
const QUICK = /-----BEGIN|AKIA|sk-|gh[pousr]_|xox[abpr]-/;
/** Every CONTENT match in `text`. */
const contentMatches = (text: string) => QUICK.test(text) ? [...text.matchAll(new RegExp(CONTENT, "g"))] : [];

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
  const hits = contentMatches(text).filter((m) => !pins.includes(pinOf(m[0])));
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
 * its kind (a hex digit by a hex digit, in a value of hex digits and dashes: a hex key, a UUID), other characters
 * kept, so the shape (length, charset, separators) holds. Made from a slow hash of the original, so the same value
 * gets the same stand-in in every file and run, and the stand-in tells nothing about it. */
function fake(original: string, made: Map<string, string>): string {
  const known = made.get(original);
  if (known !== undefined) return known;
  // A token's own prefix stays too (`whsec_`, `sk_test_`): code may check it.
  const prefix = PREFIX.exec(original)?.[0] ?? (/^(?:[a-z]{2,12}[_-]){1,3}(?=[^]{6})/.exec(original)?.[0] ?? "");
  const hex = /^[0-9a-fA-F-]+$/.test(original.slice(prefix.length));
  const seed = scryptSync(original, "arnx stand-in", 32, { N: 1024 });
  const bytes: number[] = [];
  for (let i = 0; bytes.length < original.length; i++) {
    bytes.push(...createHash("sha256").update(seed).update(`${i}`).digest());
  }
  const letters = hex ? 6 : 26;
  let out = prefix;
  for (let i = prefix.length; i < original.length; i++) {
    const c = original[i]!, b = bytes[i]!;
    out += /[0-9]/.test(c) ? String.fromCharCode(48 + b % 10) : /[A-Z]/.test(c) ? String.fromCharCode(65 + b % letters)
      : /[a-z]/.test(c) ? String.fromCharCode(97 + b % letters) : c;
  }
  made.set(original, out);
  return out;
}
const PREFIX = /^(sk-ant-|sk-(?:proj|svcacct|admin)-|sk-|AKIA|gh[pousr]_|xox[abpr]-)/;
/** A run like a key's body: 40 or more base64 characters in both cases, with a digit, + or /. A long name in code has
 * none of these; a hash in hex has one case. */
const BODY = /[A-Za-z0-9+/=]{40,}/g;
const isBody = (run: string) => /[a-z]/.test(run) && /[A-Z]/.test(run) && /[0-9+/]/.test(run) && random(run) &&
  !IDENTIFIER.test(run);
/** A long name in code: words, then digits (a migration's class, `AlterExifExposureTimeToString1674757936889`). */
const IDENTIFIER = /^[A-Za-z]+[0-9]*$/;
/** Random-looking: its characters' entropy near what random ones of its length have. A path, a long name or a URL
 * repeats letters (≈ 0.7-0.8 of the most), a key does not (≈ 0.9). */
function random(s: string): boolean {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits >= 0.84 * Math.log2(Math.min(s.length, 64));
}
/** Where such a run is data, not a key: an inline file (`base64,`), a subresource or lockfile hash (`sha512-`,
 * `h1:`), a value named as a hash (`checksum_sha256_base64="…"`), or a part of a JWT (claims a test decodes). */
const DATA_BEFORE = new RegExp("(?:base64,|sha(?:1|256|384|512)-|h1:|" +
  "(?:hash|checksum|digest|integrity|etag|sha\\d*|md5)\\w*[\"'`]?\\s*[:=]\\s*[\"'`]?)$", "i");
const JWT = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/** Words of a name that make its value a secret, whatever it looks like (`STRIPE_SECRET`, `apiKey`, `db_password`). */
const STRONG = new Set(["token", "secret", "secrets", "password", "passwd", "pwd", "passphrase", "credential",
  "credentials", "private", "authorization", "bearer", "apikey", "privatekey", "accesskey", "secretkey"]);
/** Words that name a secret only beside a long random-looking value (`sort_key`, `auth_method` do not). */
const WEAK = new Set(["key", "auth", "salt", "cookie"]);
/** Words that make a name something else: a hash or a signature a test compares (`token_hash`), a public key, a name,
 * a type, a label. */
const NOT = new Set(["hash", "hashed", "checksum", "digest", "sha", "sha1", "sha256", "sha512", "md5", "fingerprint",
  "etag", "integrity", "id", "ids", "url", "uri", "path", "file", "name", "type", "header", "field", "label",
  "placeholder", "prefix", "length", "len", "env", "var", "count", "expires", "expiry", "ttl", "format", "pattern",
  "regex", "kind", "mode", "method", "provider", "scope", "scopes", "http", "https", "public", "publishable",
  "signature", "sig"]);

/** How secret a name is: "strong", "weak" or null. */
function secretName(name: string): "strong" | "weak" | null {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => NOT.has(w))) return null;
  if (words.some((w) => STRONG.has(w)) || (words.includes("api") && words.includes("key"))) return "strong";
  return words.some((w) => WEAK.has(w)) ? "weak" : null;
}

/** A literal that may be a secret: 8 printable ASCII characters or more, no blanks, two of lower case, upper case and
 * digits; not words or a name (`PublicKey`, `password123`, `count_3mo`: each part letters and digits, one run each),
 * a placeholder, a URL, a path or a dotted name. Beside a weak name, or holding a /, it must also look random: 16
 * characters or more for a weak name. A value replaced everywhere it appears must never be a name in code. */
function secretValue(value: string, strength: "strong" | "weak"): boolean {
  if (value.length < (strength === "strong" ? 8 : 16) || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) {
    return false;
  }
  if (/^(?:[A-Za-z]+[0-9]*|[0-9]+[A-Za-z]*)(?:[-_.:@](?:[A-Za-z]+[0-9]*|[0-9]+[A-Za-z]*))*$/.test(value)) return false;
  if ([/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(value)).length < 2) return false;
  if (/\$\{|\{\{|^\$|^<.*>$|%[(sd]/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (/^[.~]?\//.test(value) || (value.includes("/") && /\.[A-Za-z0-9]{1,5}$/.test(value))) return false;
  if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(value) || /^[0-9._:-]+$/.test(value)) return false;
  return (strength === "strong" && !value.includes("/")) || random(value);
}

/** Files whose unquoted `name = value` lines hold values (env files, YAML, TOML, INI, properties). */
const CONFIG = /\.(ya?ml|toml|ini|cfg|conf|properties|env)$|(^|\/)\.env[^/]*$|(^|\/)[^/.]*\.env\.[^/]*$/i;
/** A quoted value given to a name: `name = "v"`, `name: 'v'`, `"name": "v"`, `name => 'v'`, `name == "v"`, a keyword
 * argument (`api_key="v"`), and a pair (`setdefault("SECRET_KEY", "v")`). */
const ASSIGNED = /(?<![\w$])(["'`]?)([A-Za-z_$][\w$.-]*)\1\]?\s*(?::=|=>|==?|:)\s*(["'`])([^"'`\n\\]{1,4096})\3/g;
const PAIR = /\(\s*(["'])([A-Za-z_][\w.-]*)\1\s*,\s*(["'])([^"'\n\\]{1,4096})\3/g;
const UNQUOTED = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][\w.-]*)[ \t]*[:=][ \t]*([^\s"'#][^\s#]*)[ \t]*(?:#.*)?$/gm;

/** A word of a secret-looking name, anywhere in a line. */
const WORD = /key|token|secret|passw|pwd|passphrase|credential|private|auth|bearer|salt|signature|cookie/i;

/** The lines of `text` that may give a secret-looking name a value, each with the next (a value on its own line): the
 * rest of the file never needs the slower patterns. Runs apart are kept apart by a line no pattern crosses. */
function namedLines(text: string): string {
  const lines = text.split("\n");
  const out: string[] = [];
  let last = -2;
  for (let i = 0; i < lines.length; i++) {
    if (!WORD.test(lines[i]!)) continue;
    if (i > last + 1) out.push("\0");
    if (i > last) out.push(lines[i]!);
    if (i + 1 < lines.length) out.push(lines[i + 1]!);
    last = i + 1;
  }
  return out.join("\n");
}

/** The strings of `text` (the file at `path`) that get stand-ins, `pins` aside: key-shaped strings (private key headers
 * aside), literal values given to secret-looking names (a `Bearer`/`Basic` value: its token), and runs like a key's
 * body that are not data. Hex digits are a key only where a name says so: unnamed, they are hashes and commit ids
 * that tests compare. */
export function suspects(path: string, text: string, pins: readonly string[], why?: Map<string, string>): string[] {
  const out = new Set<string>();
  const add = (v: string, rule: string) => {
    out.add(v);
    if (why && !why.has(v)) why.set(v, rule);
  };
  const allowed = (s: string) => pins.includes(pinOf(s));
  for (const m of contentMatches(text)) {
    if (!m[0].startsWith("-----") && !allowed(m[0])) add(m[0], "key-shaped");
  }
  const named = (name: string, raw: string) => {
    const strength = secretName(name);
    if (!strength) return;
    const value = /^(?:Bearer|Basic|Token|token)\s+(\S+)$/.exec(raw)?.[1] ?? raw;
    if (secretValue(value, strength) && !allowed(value)) add(value, `named-${strength}`);
  };
  const near = namedLines(text);
  for (const m of near.matchAll(ASSIGNED)) named(m[2]!, m[4]!);
  for (const m of near.matchAll(PAIR)) named(m[2]!, m[4]!);
  if (CONFIG.test(path)) for (const m of near.matchAll(UNQUOTED)) named(m[1]!, m[2]!);
  const jwts = [...text.matchAll(JWT)].map((m) => [m.index!, m.index! + m[0].length]);
  for (const m of text.matchAll(BODY)) {
    const [at, end] = [m.index!, m.index! + m[0].length];
    if (!isBody(m[0]) || allowed(m[0]) || DATA_BEFORE.test(text.slice(Math.max(0, at - 80), at)) ||
      jwts.some(([a, b]) => a! < end && at < b!)) continue;
    add(m[0], "key-body");
  }
  return [...out];
}

/** Replaces every whole occurrence of `values` (not inside a longer word) in a text with its stand-in, a value a file
 * allows (pinned) aside. `count`: the strings replaced. One matcher for a whole tree. */
export function standInsFor(values: Iterable<string>, made = new Map<string, string>())
  : (text: string, pins?: readonly string[]) => { text: string; count: number } {
  const all = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
  const matchers = new Map<string, RegExp>();
  return (text, pins = []) => {
    // Only the values the text holds go into its pattern: a plain search is much faster than the pattern.
    const here = all.filter((v) => text.includes(v));
    if (!here.length) return { text, count: 0 };
    const key = here.join("\0");
    let matcher = matchers.get(key);
    if (!matcher) {
      const escaped = here.map((v) => v.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"));
      matcher = new RegExp(`(?<![A-Za-z0-9+/])(?:${escaped.join("|")})(?![A-Za-z0-9])`, "g");
      matchers.set(key, matcher);
    }
    let count = 0;
    const out = text.replace(matcher, (v) => {
      if (pins.length && pins.includes(pinOf(v))) return v;
      count++;
      return fake(v, made);
    });
    return { text: out, count };
  };
}

/** `text` with every whole occurrence of `values` given its stand-in (standInsFor). */
export function fakeAll(text: string, values: Iterable<string>, pins: readonly string[] = [],
                        made = new Map<string, string>()): { text: string; count: number } {
  return standInsFor(values, made)(text, pins);
}

/** A private key whose body may be in `text` (beside its header): no stand-in can keep it out. */
export function privateKeyBody(text: string, pins: readonly string[]): boolean {
  const all = contentMatches(text);
  const header = (m: RegExpMatchArray) => m[0].startsWith("-----");
  if (!all.some((m) => header(m) && !pins.includes(pinOf(m[0])))) return false;
  // Key-shaped strings aside, any run like a key body may be the private key's.
  let rest = text;
  for (const m of all.filter((x) => !header(x)).reverse()) {
    rest = rest.slice(0, m.index) + " " + rest.slice(m.index! + m[0].length);
  }
  return hasKeyBody(rest);
}

/** `text` (the file at `path`) with a stand-in for each of its suspects, or null when no stand-in can keep the real
 * value out: a private key with a body. A private key header with no body anywhere in the file is a placeholder (a
 * form's hint, a doc example) and stays as it is. `count`: the strings replaced. */
export function standIn(text: string, pins: readonly string[], path = ""): { text: string; count: number } | null {
  if (privateKeyBody(text, pins)) return null;
  return fakeAll(text, suspects(path, text, pins), pins);
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
