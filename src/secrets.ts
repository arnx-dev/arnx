// What arnx never sends to a model or copies into a sandbox: files that usually hold secrets, text that looks like a
// key, and environment variable names that look like credentials.
import { createHash, scryptSync } from "node:crypto";
import { posix } from "node:path";
import { comments, commentStyle } from "./comments";
import { ValueIndex } from "./valueindex";

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
/** A password written into an address, `scheme://user:password@host`: the groups are the password and the host. A
 * template (`{password}`, `${X}`, `<password>`) holds characters a password here may not, and an example's `u:p` is
 * too short for one. */
const ADDRESS = /:\/\/[^\s:/@"'`]{0,128}:([^\s/@"'`<>{}$*\\()[\]]{4,256})@([A-Za-z0-9._-]*)/g;
/** What a doc or a form writes in place of a password; a number of up to five digits is a port. */
const NO_PASSWORD = /^(?:\d{1,5}|password|passwd|pass|pwd|secret|changeme|change_me|example|test|dummy|fake|none|null|x+|\.+)$|%[sd]/i;
/** A host no real password is for: a machine's own name, a service's one word, the names kept for examples and tests.
 * A template host (none read) may be any. */
const OWN_HOST = /^(?:[^.]+|127\..*|0\.0\.0\.0)$|(?:^|\.)(?:localhost|local|test|invalid|example|example\.(?:com|net|org))$/i;

/** A match of a secret in a text: the string, and where it starts. */
interface Hit { 0: string; index: number }

/** Each password in an address in `text`, with the @ after it. On a host of one's own (`postgres:postgres@localhost`) only
 * one that looks random counts: tests connect with the others, and a stand-in would break them. */
function addressPasswords(text: string): Hit[] {
  if (!text.includes("://")) return [];
  const out: Hit[] = [];
  for (const m of text.matchAll(ADDRESS)) {
    const [whole, password, host] = m as unknown as [string, string, string];
    if (NO_PASSWORD.test(password) || (host && OWN_HOST.test(host) && !secretValue(password, "weak"))) continue;
    // With its @: a word-like password changes only here, and the host stays (a test may compare it).
    const value = `${password}@`;
    out.push({ 0: value, index: m.index + whole.length - host.length - value.length });
  }
  return out;
}

/** Every secret-shaped string in `text`, first to last: what CONTENT matches, and passwords in addresses. */
const contentMatches = (text: string): Hit[] => [
  ...(QUICK.test(text) ? [...text.matchAll(new RegExp(CONTENT, "g"))] as Hit[] : []), ...addressPasswords(text)]
  .sort((a, b) => a.index - b.index);

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
  return CONTENT.test(text) || addressPasswords(text).length > 0;
}

/** A file the user allowed although it holds key-shaped text (a detector's fixtures): `matches` pins each such
 * string by a short hash, so the file stays allowed only while it holds no other. */
export interface SecretPin { path: string; matches: string[] }

const pinOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The pins of every key-shaped string in `text`, unique and sorted. */
export function secretPins(text: string): string[] {
  return [...new Set(contentMatches(text).map((m) => pinOf(m[0])))].sort();
}

/** Names a match without repeating it: its well-known prefix. */
function label(match: string): string {
  if (match.startsWith("-----")) return "a private key";
  const prefix = /^(sk-ant-|sk-(?:proj|svcacct|admin)-|sk-|AKIA|gh[pousr]_|xox[abpr]-)/.exec(match)?.[0];
  return prefix ? `${prefix}…` : "a password in an address";
}

/** The first key-shaped string in `text` that `pins` does not allow, with its line, or null. */
export function firstUnpinned(text: string, pins: readonly string[]): { line: number; label: string } | null {
  for (const m of contentMatches(text)) {
    if (pins.includes(pinOf(m[0]))) continue;
    return { line: text.slice(0, m.index).split("\n").length, label: label(m[0]) };
  }
  return null;
}

/** The index in `sorted` (ascending by `key`) of the last item whose key is at most `x`; -1 when none is. */
function lastAtOrBefore<T>(sorted: readonly T[], key: (item: T) => number, x: number): number {
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (key(sorted[mid]!) <= x) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
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
  const lines = text.split("\n");
  const starts: number[] = [];
  lines.reduce((at, l) => (starts.push(at), at + l.length + 1), 0);
  const lineAt = (at: number) => lastAtOrBefore(starts, (x) => x, at);
  const lineOf = (at: number) => lineAt(at) + 1;
  const style = commentStyle(path);
  const spans = style ? comments(text, style) : [];
  const within = (a: number, b: number) => {
    const s = spans[lastAtOrBefore(spans, (x) => x.start, a)];
    return s && b <= s.end ? s : undefined;
  };
  const inCode = hits.find((m) => !within(m.index, m.index + m[0].length));
  if (inCode) return { withhold: { line: lineOf(inCode.index), label: label(inCode[0]) } };
  // A line holding nothing but comment: every non-blank character in a comment, each comment on it opened with only
  // blanks before it on its line. A comment after code may be a misread regex, string or JSX text, so a key on such a
  // line withholds the file.
  const opensClean = (s: { start: number }) => /^\s*$/.test(text.slice(text.lastIndexOf("\n", s.start - 1) + 1, s.start));
  const known = new Map<number, boolean>();
  const covered = (i: number) => {
    const had = known.get(i);
    if (had !== undefined) return had;
    const from = starts[i]!, to = from + lines[i]!.length;
    let ok = [...lines[i]!].every((ch, k) => /\s/.test(ch) || !!within(from + k, from + k + 1));
    for (let s = Math.max(0, lastAtOrBefore(spans, (x) => x.start, from)); ok && s < spans.length && spans[s]!.start < to; s++) {
      if (spans[s]!.end > from && !opensClean(spans[s]!)) ok = false;
    }
    known.set(i, ok);
    return ok;
  };
  const blank = new Set<number>();
  let anyEnd: boolean | undefined, anyBody: boolean | undefined;
  /** The last walk down a comment from a header: a header inside it ends the same way. */
  let walked = { from: -1, to: -1, end: -1 };
  for (const m of hits) {
    const at = lineAt(m.index);
    if (!covered(at)) return { withhold: { line: at + 1, label: label(m[0]) } };
    blank.add(at);
    if (!m[0].startsWith("-----") || KEY_END.test(lines[at]!)) continue;
    // A private key header is blanked with its block only when the block up to its END line lies in the comment.
    // With no END line, it is a placeholder (a doc example) only while the file holds no END and no key body.
    const withhold = { withhold: { line: at + 1, label: label(m[0]) } };
    if (!(at >= walked.from && at < walked.to)) {
      let end = -1, i = at + 1;
      for (; i < lines.length && covered(i); i++) {
        if (KEY_END.test(lines[i]!)) {
          end = i;
          break;
        }
      }
      walked = { from: at, to: i, end };
    }
    const end = walked.end;
    if (end < 0) {
      anyEnd ??= KEY_END.test(text);
      anyBody ??= hasKeyBody(text);
      if (anyEnd || anyBody) return withhold;
      continue;
    }
    // A block with no body in it: a body elsewhere (in code) withholds the file.
    anyBody ??= hasKeyBody(text);
    if (anyBody && !hasKeyBody(lines.slice(at, end + 1).join("\n"))) return withhold;
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
export function fake(original: string, made: Map<string, string>): string {
  const known = made.get(original);
  if (known !== undefined) return known;
  // A token's own prefix stays too (`whsec_`, `sk_test_`): code may check it. So does a number literal's (`0x`, `0b`,
  // `0o`), whose digits stay in its base: the code around it still parses. A password in an address keeps nothing.
  const radix = /^0([xXbBoO])(?=[0-9a-fA-F_]+n?$)/.exec(original);
  const prefix = radix?.[0] ?? PREFIX.exec(original)?.[0] ??
    (original.includes("@") ? "" : /^(?:[a-z]{2,12}[_-]){1,3}(?=[^]{6})/.exec(original)?.[0] ?? "");
  const base = { b: 2, o: 8 }[radix?.[1]!.toLowerCase() ?? ""] ?? 10;
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
    // A BigInt literal's `n` stays.
    if (radix && c === "n" && i === original.length - 1) {
      out += c;
      continue;
    }
    out += /[0-9]/.test(c) ? String.fromCharCode(48 + b % base) : /[A-Z]/.test(c) ? String.fromCharCode(65 + b % letters)
      : /[a-z]/.test(c) ? String.fromCharCode(97 + b % letters) : c;
  }
  made.set(original, out);
  return out;
}
const PREFIX = /^(sk-ant-|sk-(?:proj|svcacct|admin)-|sk-|AKIA|gh[pousr]_|xox[abpr]-)/;
/** Random-looking: its characters' entropy near what random ones of its length have. A path, a long name or a URL
 * repeats letters (≈ 0.7-0.8 of the most), a key does not (≈ 0.9). */
function random(s: string): boolean {
  const counts = new Map<string, number>();
  for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
  let bits = 0;
  for (const n of counts.values()) bits -= (n / s.length) * Math.log2(n / s.length);
  return bits >= 0.84 * Math.log2(Math.min(s.length, 64));
}

/** Words that make a name a secret when the name is one (its last word: `STRIPE_SECRET`, `apiKey`, `db_password`),
 * whatever its value looks like. */
const STRONG = new Set(["token", "secret", "secrets", "password", "passwd", "pwd", "passphrase", "credential",
  "credentials", "private", "authorization", "bearer", "apikey", "privatekey", "accesskey", "secretkey", "keypair"]);
/** Words that name a secret only beside a long random-looking value (`sort_key`, `auth_method` do not). */
const WEAK = new Set(["key", "auth", "salt", "cookie"]);
/** Words that make a name something else: a hash or a signature a test compares (`token_hash`), a public key, a name,
 * a type, a label. */
const NOT = new Set(["hash", "hashed", "checksum", "digest", "sha", "sha1", "sha256", "sha512", "md5", "fingerprint",
  "etag", "integrity", "id", "ids", "url", "uri", "path", "file", "name", "type", "header", "field", "label",
  "placeholder", "prefix", "length", "len", "env", "var", "count", "expires", "expiry", "ttl", "format", "pattern",
  "regex", "kind", "mode", "method", "provider", "scope", "scopes", "http", "https", "public", "publishable",
  "signature", "sig", "pub", "pubkey"]);
/** Last words that only qualify what comes before them (`SECRET_KEY_BASE`, `password_new`, `api_key_b64`). */
const QUALIFIER = new Set(["value", "val", "base", "b64", "base64", "hex", "raw", "str", "string", "bytes", "encoded",
  "test", "live", "prod", "dev", "old", "new", "default"]);

/** How secret a name is: "strong", "weak" or null. What the name is counts: its last word, past numbers and
 * qualifiers. A secret word before it only says what kind (`tokenProgram`, `TOKEN_ACCOUNT`, `token_address` are not
 * secrets), except before a key (`secret_key`, `private_key`, `api_key`). An account's key is public. */
function secretName(name: string): "strong" | "weak" | null {
  const words = name.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.some((w) => NOT.has(w))) return null;
  while (words.length > 1 && (/^[0-9]+$/.test(words.at(-1)!) || QUALIFIER.has(words.at(-1)!))) words.pop();
  const head = words.pop() ?? "";
  if (STRONG.has(head) || (head === "pair" && words.at(-1) === "key")) return "strong";
  if (!WEAK.has(head)) return null;
  if (head === "key" && words.some((w) => w === "api" || STRONG.has(w))) return "strong";
  return head === "key" && words.includes("account") ? null : "weak";
}

/** A literal that may be a secret: 8 printable ASCII characters or more, no blanks, two of lower case, upper case and
 * digits; not words or a name (`PublicKey`, `password123`, `count_3mo`: each part letters and digits, one run each),
 * a placeholder, a URL, a path or a dotted name. Beside a weak name, or holding a /, it must also look random: 16
 * characters or more for a weak name, and hold nothing a key does not (brackets, a version range). A value replaced
 * everywhere it appears must never be a name in code. */
function secretValue(value: string, strength: "strong" | "weak"): boolean {
  if (value.length < (strength === "strong" ? 8 : 16) || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) {
    return false;
  }
  if (/^(?:[A-Za-z]+[0-9]*|[0-9]+[A-Za-z]*)(?:[-_.:@](?:[A-Za-z]+[0-9]*|[0-9]+[A-Za-z]*))*$/.test(value)) return false;
  if ([/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(value)).length < 2) return false;
  if (/\$\{|\{\{|^\$|^<.*>$|%[(sd]/.test(value) || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return false;
  if (/^[.~]?\//.test(value) || (value.includes("/") && /\.[A-Za-z0-9]{1,5}$/.test(value))) return false;
  if (/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)+$/.test(value) || /^[0-9._:-]+$/.test(value)) return false;
  if (CODE.test(value) || /^\[[A-Za-z ]+\]$/.test(value)) return false;
  if (strength === "weak" && (/[[\](){}<>^|]/.test(value) || /@[~^<>=]*[0-9]+\.[0-9]/.test(value))) return false;
  return (strength === "strong" && !value.includes("/")) || random(value);
}

/** An expression, whole: a name with an index or a call (`row[keyField]`, `user.toString()`, `idFor(item)`), as a template
 * binds to an attribute. */
const CODE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*(?:\[[A-Za-z_$][^\]]*\]|\([^()]*\))(?:\.[A-Za-z_$][\w$]*|\[[A-Za-z_$][^\]]*\]|\([^()]*\))*$/;

/** Files whose unquoted `name = value` lines hold values (env files, YAML, TOML, INI, properties). */
const CONFIG = /\.(ya?ml|toml|ini|cfg|conf|properties|env)$|(^|\/)\.env[^/]*$|(^|\/)[^/.]*\.env\.[^/]*$/i;
/** What follows a name given a quoted value: `= "v"`, `: 'v'`, `=> 'v'`, `== "v"`, `:= "v"`. */
const GIVEN = /(?::=|=>|==?|:)\s*(["'`])([^"'`\n\\]{1,4096})\1/g;
/** A pair (`setdefault("SECRET_KEY", "v")`). */
const PAIR = /\(\s*(["'])([A-Za-z_][\w.-]*)\1\s*,\s*(["'])([^"'\n\\]{1,4096})\3/g;
const SPACE = /\s/;
/** Characters of a name past its first: letters, digits, `_`, `$`, `.`, `-`. */
const inName = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || (c >= 48 && c <= 57) || c === 95 ||
  c === 36 || c === 46 || c === 45;
const startsName = (c: number) => (c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c === 95 || c === 36;
const isQuote = (c: number) => c === 34 || c === 39 || c === 96;

/** The [name, value] pairs of `text` where a quoted value is given to a name: `name = "v"`, `"name": "v"`, a keyword
 * argument (`api_key="v"`), `row["name"] = "v"`. Each `=` or `:` is found first and its name read backwards from it, so
 * the time grows with the text alone: from the name's side, a long run of `a.b-c.` makes every `.` and `-` a new start. */
export function assignedPairs(text: string): [string, string][] {
  const out: [string, string][] = [];
  const given = new RegExp(GIVEN);
  let floor = 0;
  for (let m = given.exec(text); m; m = given.exec(text)) {
    let at = m.index;
    while (at > floor && SPACE.test(text[at - 1]!)) at--;
    if (at > floor && text.charCodeAt(at - 1) === 93) at--; // ]
    const end = at > floor && isQuote(text.charCodeAt(at - 1)) ? --at : at;
    const quote = end < m.index && isQuote(text.charCodeAt(end)) ? text.charCodeAt(end) : 0;
    let start = end;
    while (start > floor && inName(text.charCodeAt(start - 1))) start--;
    let name = -1;
    if (quote) {
      // The same quote opens it, with no word right before: nothing else can stand between them.
      const opens = start > floor && text.charCodeAt(start - 1) === quote;
      const before = start - 2 >= floor ? text.charCodeAt(start - 2) : -1;
      const word = before >= 0 && inName(before) && before !== 46 && before !== 45;
      if (opens && !word && start < end && startsName(text.charCodeAt(start))) name = start;
    } else {
      // The first place in the run that can start a name: its first character, or just past a `.` or a `-`.
      for (let i = start; i < end; i++) {
        const after = i === start || text.charCodeAt(i - 1) === 46 || text.charCodeAt(i - 1) === 45;
        if (after && startsName(text.charCodeAt(i))) {
          name = i;
          break;
        }
      }
    }
    if (name < 0) {
      given.lastIndex = m.index + 1;
      continue;
    }
    out.push([text.slice(name, end), m[2]!]);
    floor = given.lastIndex;
  }
  return out;
}

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

/** Whether a suspect's rule (`why` in suspects) is certain: the string's own shape says it is a secret. The other rules
 * guess from a name beside it. */
export const isCertainRule = (rule: string): boolean => rule === "key-shaped" || rule === "address-password";

/** The strings of `text` (the file at `path`) that get stand-ins, `pins` aside: key-shaped strings (private key headers
 * aside) and literal values given to secret-looking names (a `Bearer`/`Basic` value: its token). A random-looking
 * string, hex or base64, is a key only where a name says so: unnamed, it is a hash, a commit id, an address or a
 * signature that tests compare. */
export function suspects(path: string, text: string, pins: readonly string[], why?: Map<string, string>): string[] {
  const out = new Set<string>();
  const add = (v: string, rule: string) => {
    out.add(v);
    if (why && !why.has(v)) why.set(v, rule);
  };
  const allowed = (s: string) => pins.includes(pinOf(s));
  for (const m of contentMatches(text)) {
    if (m[0].startsWith("-----") || allowed(m[0])) continue;
    const password = m[0].endsWith("@") ? m[0].slice(0, -1) : null;
    add(m[0], password === null ? "key-shaped" : "address-password");
    // Alone it goes too, unless it reads like a name: a value replaced everywhere must never be a name in code.
    if (password !== null && secretValue(password, "strong")) add(password, "address-password");
  }
  const named = (name: string, raw: string) => {
    const strength = secretName(name);
    if (!strength) return;
    const value = /^(?:Bearer|Basic|Token|token)\s+(\S+)$/.exec(raw)?.[1] ?? raw;
    if (secretValue(value, strength) && !allowed(value)) add(value, `named-${strength}`);
  };
  const near = namedLines(text);
  for (const [name, value] of assignedPairs(near)) named(name, value);
  for (const m of near.matchAll(PAIR)) named(m[2]!, m[4]!);
  if (CONFIG.test(path)) for (const m of near.matchAll(UNQUOTED)) named(m[1]!, m[2]!);
  return [...out];
}

const MANY_VALUES = 64;

/** Replaces every whole occurrence of `values` (not inside a longer word) in a text with its stand-in, a value a file
 * allows (pinned) aside. `count`: the strings replaced. One matcher for a whole tree. */
export function standInsFor(values: Iterable<string>, made = new Map<string, string>())
  : (text: string, pins?: readonly string[]) => { text: string; count: number } {
  const all = [...new Set(values)].filter(Boolean).sort((a, b) => b.length - a.length);
  const matchers = new Map<string, RegExp>();
  // A plain search for each is quickest for a few values; past that the search grows with their number and an index doesn't.
  const index = all.length > MANY_VALUES ? new ValueIndex(all) : null;
  return (text, pins = []) => {
    // Only the values the text holds go into its pattern: a plain search is much faster than the pattern.
    const held = index?.present(text);
    const here = held ? [...held].sort((a, b) => b.length - a.length) : all.filter((v) => text.includes(v));
    if (!here.length) return { text, count: 0 };
    const key = here.join("\0");
    let matcher = matchers.get(key);
    if (!matcher) {
      // A password with its @ has a host right after it; anything else ends where a word would.
      const escaped = here.map((v) => v.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + (v.endsWith("@") ? "" : "(?![A-Za-z0-9])"));
      matcher = new RegExp(`(?<![A-Za-z0-9+/])(?:${escaped.join("|")})`, "g");
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
  const header = (m: Hit) => m[0].startsWith("-----");
  if (!all.some((m) => header(m) && !pins.includes(pinOf(m[0])))) return false;
  // Key-shaped strings aside, any run like a key body may be the private key's.
  const parts: string[] = [];
  let from = 0;
  for (const m of all.filter((x) => !header(x))) {
    parts.push(text.slice(from, m.index), " ");
    from = m.index + m[0].length;
  }
  parts.push(text.slice(from));
  return hasKeyBody(parts.join(""));
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
  for (const m of contentMatches(text)) {
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
