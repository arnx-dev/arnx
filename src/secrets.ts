// What arnx sends and copies only as stand-ins or not at all: files that usually hold secrets, text that looks like a key, and
// environment variable names that look like credentials.
import { createHash, scryptSync } from "node:crypto";
import { posix } from "node:path";
import { type Comment, comments, commentStyle } from "./comments";
import { ValueIndex } from "./valueindex";

export const SECRET_FILE_GLOBS: readonly string[] = [
  ".env", ".env.*", "*.pem", "*.key", "*.p12", "*.pfx", "*.keystore", "*.jks", "id_rsa*", "id_ecdsa*",
  "id_ed25519*", "*.ppk", ".netrc", ".npmrc", ".pypirc", "credentials*.json", "service-account*.json", "*.session",
  "*.session-journal"];
/** The names of those that hold a key and nothing else: one holding a key stays in, the key replaced. */
const KEY_FILES = ["*.pem", "*.key", "id_rsa*", "id_ecdsa*", "id_ed25519*"];
/** What follows BEGIN or END in a private key's armour (PEM, PGP's block, SSH2's four dashes), plain or URL-encoded, a label
 * of any words up to PRIVATE KEY. A label's length is bounded, so a failed match stays quick. */
const ARMOUR = "( |%20|\\+)[A-Z0-9 %+-]{0,64}PRIVATE( |%20|\\+)KEY(( |%20|\\+)BLOCK)?( |%20)?-{4,5}";
/** A private key's header, as a pattern. */
export const KEY_HEADER = `-{4,5}( |%20)?BEGIN${ARMOUR}`;
const isHeader = (s: string) => s.startsWith("----");
/** Base64 in either alphabet. */
const B64 = "[A-Za-z0-9+/_-]";
/** What a private key's base64 must start with when no header says so, as a pattern: a whole PEM's base64, an OpenSSH
 * body, and the DER of PKCS1 (a version, then the modulus), PKCS8 (a version, then an algorithm), SEC1, encrypted PKCS8. A
 * certificate or a public key starts otherwise. */
const KEY_START = [
  `LS0tLS[1B]CRUdJTi${B64}{0,40}(UFJJVkFURSBLRVk|BSSVZBVEUgS0VZ|QUklWQVRFIEtFW)`,
  "b3BlbnNzaC1rZXktdjE",
  `MII${B64}{2}[AQgw]IBAA[JK]`,
  `MII${B64}{2}[AQgw]IBAD(A${B64}Bgkq|CC)`,
  `M${B64}{2}CAQEE`,
  `MI[GH]${B64}AgEBB`,
  `MI[GH]${B64}AgEAMB[AM]GByqGSM49`,
  `M${B64}{2}CAQAwBQYDK2V`,
  `MII${B64}{5}BgkqhkiG9w0BBQ`,
  `MI[GH]${B64}M${B64}{3}CSqGSIb3DQEF`,
].join("|");
/** What a text holding any key-shaped string must hold, as a pattern (QUICK, a key's start, an address's `://`), also with
 * a NUL after each character (UTF-16). */
export const MAY_HOLD_KEY = `-[^B]?[^B]?[^B]?B[^B]?E[^E]?G[^G]?I[^I]?N|AKIA|sk-|gh[pousr]_|xox[abpr]-|://|${KEY_START}`;
/** Whether a diff may show a private key at all, cheaply. */
export const mayShowPrivateKey = (text: string) => text.includes("PRIVATE") || KEY_START_GATE.test(text);
const KEY_START_GATE = new RegExp(KEY_START);
const KEY_START_AT = new RegExp(`^(?:${KEY_START})`);
// A key starts a token: no letter or digit right before it, so `task-…` or `desk-…` is not an `sk-` key.
const CONTENT = new RegExp(
  `${KEY_HEADER}|` + "(?<![A-Za-z0-9])(?:AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}" +
  "|sk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|sk-[A-Za-z0-9]{32,}" +
  "|gh[pousr]_[A-Za-z0-9]{36,}|xox[abpr]-[A-Za-z0-9-]{10,})");
const ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE/i;
/** What every CONTENT match holds: a fast test first, since CONTENT's look-behind is slow on a large tree. */
const QUICK = /-{4,5}(?: |%20)?BEGIN|AKIA|sk-|gh[pousr]_|xox[abpr]-/;
/** A password written into an address, `scheme://user:password@host`: the groups are the password and the host. A
 * template (`{password}`, `${X}`, `<password>`) holds characters a password here may not, and an example's `u:p` is
 * too short for one. */
const ADDRESS = /:\/\/([^\s:/@"'`]{0,128}):([^\s/@"'`<>{}$*\\()[\]]{4,256})@([A-Za-z0-9._-]*)/g;
/** What a doc or a form writes in place of a password. */
const NO_PASSWORD = /^(?:password|passwd|pass|pwd|secret|changeme|change_me|example|test|dummy|fake|none|null|x+|\.+)$|%[sd]/i;
/** What stands before `:digits@` when the digits are a port: a host's name (a dot, or the machine itself) or nothing; a
 * word with a number after it is a user and a password. */
const HOST_NAME = /^$|\.|^(?:localhost|local)$/i;
/** A host no real password is for: a machine's own name, a service's one word, the names kept for examples and tests.
 * A template host (none read) may be any. */
const OWN_HOST = /^(?:[^.]+|127\..*|0\.0\.0\.0)$|(?:^|\.)(?:localhost|local|test|invalid|example|example\.(?:com|net|org))$/i;

/** A match of a secret in a text: the string, and where it starts. `start`: a private key known by how it starts. */
interface Hit { 0: string; index: number; start?: true }

/** Each password in an address in `text`, with the @ after it. On a host of one's own (`postgres:postgres@localhost`) only
 * one that looks random counts: tests connect with the others, and a stand-in would break them. */
function addressPasswords(text: string): Hit[] {
  if (!text.includes("://")) return [];
  const out: Hit[] = [];
  for (const m of text.matchAll(ADDRESS)) {
    const [whole, user, password, host] = m as unknown as [string, string, string, string];
    if (NO_PASSWORD.test(password) || (/^\d{1,5}$/.test(password) && HOST_NAME.test(user)) || (host && OWN_HOST.test(host) && !secretValue(password, "weak"))) continue;
    // With its @: a word-like password changes only here, and the host stays (a test may compare it).
    const value = `${password}@`;
    out.push({ 0: value, index: m.index + whole.length - host.length - value.length });
  }
  return out;
}

/** Every secret-shaped string in `text`, first to last: what CONTENT matches, and passwords in addresses. */
const contentMatches = (text: string): Hit[] => {
  const found = QUICK.test(text) ? [...text.matchAll(new RegExp(CONTENT, "g"))] as Hit[] : [];
  return [...found, ...headerlessKeys(text), ...addressPasswords(text)].sort((a, b) => a.index - b.index);
};

/** The shortest run taken for a key known by how it starts. */
const KEY_RUN_MIN = 64;
/** The shortest later piece of such a run, padding aside. */
const RUN_PIECE_MIN = 16;
const isRunChar = (c: number) => (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 43 || c === 47 ||
  c === 61 || c === 45 || c === 95;
const CLOSING = "\"'`,;+)] \t";
const OPENING = "\"'`,;+[( \t#*>|%!";

/** Past a line end at `from` (real or escaped) with the marks a language, a comment or a diff puts around it; -1 when no line
 * end stands there. */
function pastLineEnd(text: string, from: number): number {
  let i = from, eol = false;
  for (let n = 0; n < 128 && i < text.length; n++) {
    const c = text[i]!;
    if (c === "\n" || c === "\r") {
      eol = true;
      i++;
    } else if (c === "\\") {
      let k = i + 1;
      while (text[k] === "\\" && k - i < 16) k++;
      const next = text[k];
      if (next !== "n" && next !== "r" && next !== '"' && next !== "'") break;
      eol ||= next === "n" || next === "r";
      i = k + 1;
    } else if (eol ? OPENING.includes(c) : CLOSING.includes(c) || (c === "." && !isRunChar(text.charCodeAt(i - 1)) && text[i - 1] !== ".")) {
      i++;
    } else break;
  }
  return eol ? i : -1;
}

/** The run of base64 at `at`, across line ends and `\/`: how many characters it holds, and where its last one ends. A later
 * line counts only when it is all run, so a word starting the next line of code does not. Each character is passed a
 * bounded number of times, as no later start in a run can hold more than the run. */
function runAt(text: string, at: number): { end: number; count: number } {
  let i = at, end = at, count = 0;
  for (let first = true; ; first = false) {
    let j = i, held = 0;
    while (j < text.length) {
      if (isRunChar(text.charCodeAt(j))) {
        held++;
        j++;
      } else if (text[j] === "\\" && text[j + 1] === "/") j++;
      else break;
    }
    // A short piece after a key's first line is a name or an option, unless padding closes it.
    if (!first && held && held < RUN_PIECE_MIN && text[j - 1] !== "=") break;
    const next = j < text.length ? pastLineEnd(text, j) : -1;
    // Or a closing quote: the string's last line.
    if (!first && j < text.length && next < 0 && !/^\\?["'`]/.test(text.slice(j, j + 2))) break;
    count += held;
    if (held) end = j;
    if (next < 0 || text.startsWith("diff --git ", next)) break;
    i = next;
  }
  return { end, count };
}

/** Whether a text may hold private-key text: what the filter looks for first, as it runs on every string of every request.
 * A few plain searches, then the starts themselves: "MI" alone is in too many files to run the whole pattern on. */
const hasKeySign = (text: string) => text.includes("PRIVATE") ||
  ((text.includes("MI") || text.includes("CAQ") || text.includes("LS0tLS") || text.includes("b3Blbn")) && KEY_START_GATE.test(text));
const KEY_END_PATTERN = `-{4,5}( |%20)?END${ARMOUR}`;
/** A key's start stands alone, or right after a line end or tab written out (`\n`, `%0A`). */
const KEY_ANY = new RegExp(`${KEY_HEADER}|${KEY_END_PATTERN}|(?:(?<![A-Za-z0-9])|(?<=\\\\[nrt])|(?<=%0[ADad]))(?:${KEY_START})`, "g");
const KEY_END = new RegExp(KEY_END_PATTERN, "g");
const isEnd = (armour: string) => /^-{4,5}(?: |%20)?E/.test(armour);
/** A line that starts the next file of a diff, in what goes out: a header's END lies before it. */
const DIFF_LINE = /(?<=\n)diff --git /g;
/** The shortest piece of a key's text taken for a token: below this, one is too likely to be something else. */
const KEY_TOKEN_MIN = 8;

/** The longest token taken for a name when it holds no digit, `+` or `/`: a key's token of that shape is a matter of chance. */
const NAME_MOST = 32;
/** Whether a token reads as an identifier or a word, so it is no key's text: it keeps its text and ends a no-END run. */
export const looksLikeName = (token: string) => token.length <= NAME_MOST && !/[0-9+/]/.test(token);

/** How many base64 characters stand at `at`; `\/` is a slash a JSON text escaped. */
function tokenLength(text: string, at: number): number {
  let i = at, n = 0;
  for (; i < text.length; i++) {
    if (isRunChar(text.charCodeAt(i))) n++;
    else if (text[i] === "\\" && text[i + 1] === "/") i++;
    else break;
  }
  return n;
}

/** Past what may stand between a key's tokens: blanks, line ends (real or written out), quotes, commas, a lone `+` or `.`.
 * `closed`: a line end or a quote lies among them, so what follows no longer shares the token's line or string. */
function pastSeparators(text: string, from: number): { at: number; closed: boolean } {
  let i = from, closed = false;
  while (i < text.length) {
    const c = text[i]!;
    if (c === "\n" || c === "\r" || c === '"' || c === "'" || c === "`") {
      closed = true;
      i++;
    } else if (c === " " || c === "\t" || c === "," || c === "." || (c === "+" && !isRunChar(text.charCodeAt(i + 1)))) {
      i++;
    } else if (c === "\\") {
      let k = i + 1;
      while (text[k] === "\\" && k - i < 16) k++;
      const next = text[k];
      if (next !== "n" && next !== "r" && next !== '"' && next !== "'") break;
      closed = true;
      i = k + 1;
    } else break;
  }
  return { at: i, closed };
}

/** Past the token at `at`. */
function pastToken(text: string, at: number): number {
  let past = at;
  while (past < text.length && (isRunChar(text.charCodeAt(past)) || (text[past] === "\\" && text[past + 1] === "/"))) past++;
  return past;
}

/** The end of the tokens of KEY_TOKEN_MIN or more after `from`, with only separators among them; `from` when none stands
 * there. It stops at a name (looksLikeName) unless a token of 8 or more with a digit, `+` or `/` follows it, which makes it a wrapped
 * key's line by chance. Tokens sharing a line with anything else (a name assigned or called) are no key's. */
function tokenRun(text: string, from: number, noHeader = false): number {
  let end = from, at = pastSeparators(text, from).at;
  for (;;) {
    const n = tokenLength(text, at);
    if (n < KEY_TOKEN_MIN) return end;
    const past = pastToken(text, at);
    if (noHeader && n < RUN_PIECE_MIN && text[past - 1] !== "=") return end;
    const next = pastSeparators(text, past);
    if (looksLikeName(text.slice(at, past))) {
      const following = text.slice(next.at, pastToken(text, next.at));
      if (tokenLength(following, 0) < KEY_TOKEN_MIN || !/[0-9+/]/.test(following)) return end;
    }
    if (next.at >= text.length || next.closed) end = past;
    else if (tokenLength(text, next.at) < KEY_TOKEN_MIN) return end;
    at = next.at;
  }
}

/** Whether a line holds only base64, in the marks a language, a comment or a diff puts around it. */
function base64Only(line: string): boolean {
  const pieces = line.split(/\\[nr]/).map((p) => p.replace(/^[\s"'`,;#*>|+.]+/, "").replace(/[\s"'`,;+.]+$/, ""));
  return pieces.some(Boolean) && pieces.every((p) => !p || /^[A-Za-z0-9+/=_-]+$/.test(p));
}

/** Where a key that a stray END at `end` closes starts, no further back than `floor`: the base64-only lines before it. What
 * shares the END's line goes only when it is itself base64 (a cut that keeps written line ends). */
function strayStart(text: string, end: number, floor: number): number {
  const lineAt = Math.max(text.lastIndexOf("\n", end - 1) + 1, floor);
  const before = text.slice(lineAt, end);
  if (before.trim() && !base64Only(before)) {
    let at = end;
    for (;;) {
      let k = at;
      while (k > lineAt && "\"'`, \t+.".includes(text[k - 1]!)) k--;
      if (k - 2 < lineAt || text[k - 2] !== "\\" || (text[k - 1] !== "n" && text[k - 1] !== "r")) return at;
      k -= 2;
      const piece = k;
      while (k > lineAt && isRunChar(text.charCodeAt(k - 1))) k--;
      if (k === piece) return at;
      at = k;
    }
  }
  let at = lineAt;
  while (at > floor) {
    const from = Math.max(text.lastIndexOf("\n", at - 2) + 1, floor);
    if (!base64Only(text.slice(from, at - 1))) break;
    at = from;
  }
  return at;
}

/** Private-key text in a text. `body` to `bodyEnd`: what may hold its tokens. `end`: a stray END, and what it closes. `closed`: a
 * header with its END, where code may lie between; anywhere else every token the run took is the key's. */
interface KeySpan { from: number; to: number; kind: "header" | "start" | "end"; body: number; bodyEnd: number; closed?: boolean }

/** Where `text` holds private-key text, first to last: from a header to its END line, or with no END to the end of its run of
 * tokens (tokenRun); a run of KEY_RUN_MIN or more that starts as a key, with such a run after it; an END with no header, and
 * the base64-only lines before it. `sections`: an END past the next `diff --git` line is another file's. Linear in `text`. */
function privateKeySpans(text: string, sections = false): KeySpan[] {
  if (!hasKeySign(text)) return [];
  const out: KeySpan[] = [];
  KEY_ANY.lastIndex = 0;
  /** The next END and the next file of a diff, each kept while it lies ahead; null once there is none. */
  let end: RegExpExecArray | null | undefined;
  let file: RegExpExecArray | null | undefined;
  let floor = 0;
  for (let m = KEY_ANY.exec(text); m; m = KEY_ANY.exec(text)) {
    let span: KeySpan;
    const stop = m.index + m[0].length;
    if (isHeader(m[0]) && isEnd(m[0])) {
      span = { from: strayStart(text, m.index, floor), to: stop, kind: "end", body: stop, bodyEnd: stop };
    } else if (isHeader(m[0])) {
      if (end === undefined || (end !== null && end.index < stop)) {
        KEY_END.lastIndex = stop;
        end = KEY_END.exec(text);
      }
      if (sections && end && (file === undefined || (file !== null && file.index < stop))) {
        DIFF_LINE.lastIndex = stop;
        file = DIFF_LINE.exec(text);
      }
      const closed = end && (!file || end.index < file.index);
      const to = closed ? end!.index + end![0].length : tokenRun(text, stop);
      span = { from: m.index, to, kind: "header", body: stop, bodyEnd: closed ? end!.index : to, closed: !!closed };
    } else {
      const run = runAt(text, m.index);
      if (run.count < KEY_RUN_MIN) {
        KEY_ANY.lastIndex = Math.max(run.end, m.index + 1);
        continue;
      }
      const to = tokenRun(text, run.end, true);
      span = { from: m.index, to, kind: "start", body: m.index, bodyEnd: to };
    }
    out.push(span);
    floor = span.to;
    KEY_ANY.lastIndex = Math.max(span.to, m.index + 1);
  }
  return out;
}

/** What a model reads in place of a private key. */
export const KEY_SHOWN = "[private key]";
/** What it means, for a model and for what a model wrote. */
export const KEY_SHOWN_MEANS = `\`${KEY_SHOWN}\` stands where arnx hides a private key from you, and only that key; it is no value. The ` +
  "sandbox holds a fake of it, unless its file is allowed: a test that needs the key must read the file at run time.";

/** `text` with its private-key text replaced, for all that leaves arnx: what a person or a model reads holds no header and no
 * END, however often it passes here. NULs go first when there is any to replace (UTF-16). */
export function maskPrivateKeys(text: string): string {
  const plain = text.includes("\0") ? text.replaceAll("\0", "") : text;
  const spans = privateKeySpans(plain, true);
  if (!spans.length) return text;
  const parts: string[] = [];
  let from = 0;
  for (const s of spans) {
    // Keys with only blanks between them read as one.
    if (!parts.length || plain.slice(from, s.from).trim()) parts.push(plain.slice(from, s.from), KEY_SHOWN);
    from = s.to;
  }
  parts.push(plain.slice(from));
  return parts.join("");
}

/** In a key's text, what is no token: a header inside it, a written escape, and what a template fills in. */
const KEY_TOKEN = new RegExp(`(${KEY_HEADER}|\\\\+[^]|%[0-9A-Fa-f]{2}|\\$?\\{[^{}\\n]{0,200}\\}|<[^<>\\n]{0,200}>)|[A-Za-z0-9+/=_-]{${KEY_TOKEN_MIN},}`, "g");
/** For what is only read: every token of any length or shape, between an intact header and END. */
const VIEW_TOKEN = new RegExp(`(${KEY_HEADER}|\\\\+[^]|%[0-9A-Fa-f]{2})|[A-Za-z0-9+/=_-]+`, "g");
/** Past this many tokens a file with an unallowed key is left out: each fake takes a slow hash. */
export const BIG_KEYS_MOST = 2000;
/** Each token's fake, for the life of this process. A fake is its own fake, so a text that holds fakes reads the same. */
const KEY_FAKES = new Map<string, string>();
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
/** A token's fake: of its length, each letter or digit a base64 character from a slow hash of the token, its other characters
 * kept. Unlike `fake`, it keeps no character's kind, which tells about a key's encoding. */
function keyFake(token: string): string {
  const known = KEY_FAKES.get(token);
  if (known !== undefined) return known;
  const seed = scryptSync(token, "arnx key fake", 32, { N: 1024 });
  const bytes: number[] = [];
  for (let i = 0; bytes.length < token.length; i++) bytes.push(...createHash("sha256").update(seed).update(`${i}`).digest());
  const out = [...token].map((c, i) => /[A-Za-z0-9]/.test(c) ? BASE64[bytes[i]! % 64]! : c).join("");
  KEY_FAKES.set(token, out);
  KEY_FAKES.set(out, out);
  return out;
}

/** The different tokens of `text`'s private keys. */
export const keyTokens = (text: string) => tokensIn(text, privateKeySpans(text));
function tokensIn(text: string, spans: readonly KeySpan[]): Set<string> {
  const out = new Set<string>();
  for (const s of spans) {
    for (const m of text.slice(s.body, s.bodyEnd).matchAll(KEY_TOKEN)) if (m[1] === undefined && !(s.closed && looksLikeName(m[0]))) out.add(m[0]);
  }
  return out;
}

/** `text` with each token of its private keys given a fake of the same length: all else stays, names, a header and an END too, so it
 * still reads as a key and its lines do not move. `count`: the tokens replaced. The same token gets the same fake anywhere.
 * `view`, for what is only read and never runs: between an intact header and END every token goes, of any length or shape, so
 * a page or a search of the result shows no key whatever its wrap. Take it on the whole file, before any page or search.
 * Past BIG_KEYS_MOST, in an allowed file that only a tool shows, letters do for a fake. */
export function fakeKeys(text: string, o: { view?: boolean } = {}): { text: string; count: number } {
  const spans = privateKeySpans(text).filter((s) => s.kind !== "end");
  if (!spans.length) return { text, count: 0 };
  const all = (s: KeySpan) => !!o.view && !!s.closed;
  const distinct = new Set<string>(tokensIn(text, spans));
  for (const s of spans.filter(all)) {
    for (const m of text.slice(s.body, s.bodyEnd).matchAll(VIEW_TOKEN)) if (m[1] === undefined) distinct.add(m[0]);
  }
  const many = distinct.size > BIG_KEYS_MOST;
  const parts: string[] = [];
  let from = 0, count = 0;
  for (const s of spans) {
    parts.push(text.slice(from, s.body), text.slice(s.body, s.bodyEnd).replace(all(s) ? VIEW_TOKEN : KEY_TOKEN, (m: string, skip: string | undefined) => {
      if (skip !== undefined || (s.closed && !all(s) && looksLikeName(m))) return m;
      const out = many ? m.replace(/[A-Za-z0-9]/g, "x") : keyFake(m);
      if (out !== m) count++;
      return out;
    }));
    from = s.bodyEnd;
  }
  parts.push(text.slice(from));
  return { text: parts.join(""), count };
}

/** The keys known by how they start, on a run of KEY_RUN_MIN or more, whole or wrapped, outside a header's text. */
const headerlessKeys = (text: string): Hit[] => privateKeySpans(text).filter((s) => s.kind === "start")
  .map((s) => ({ 0: /^[A-Za-z0-9+/=]+/.exec(text.slice(s.from, s.to))![0], index: s.from, start: true }));

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

const KEY_FILE_NAMES = KEY_FILES.map(globRegex);
export const isKeyFileName = (rel: string) => KEY_FILE_NAMES.some((r) => r.test(posix.basename(rel)));
/** The armour labels of what a `.pem` holds that is no secret. */
const PUBLIC_BLOCK = /^(?:(?:TRUSTED |X509 |ATTRIBUTE )?CERTIFICATE|X509 CRL|(?:NEW )?CERTIFICATE REQUEST|(?:RSA )?PUBLIC KEY|(?:DH|DSA|EC|X9\.42 DH) PARAMETERS|PKCS7|CMS)$/;
/** A `.pem` whose blocks are all known, and none a private key. */
export function holdsOnlyPublicPem(rel: string, text: string): boolean {
  if (!rel.endsWith(".pem")) return false;
  const blocks = [...text.matchAll(/-----BEGIN ([^-\n]{1,64})-----/g)].map((m) => m[1]!);
  return blocks.length > 0 && blocks.every((b) => PUBLIC_BLOCK.test(b)) && !holdsPrivateKey(text, []);
}

export function hasSecretContent(text: string): boolean {
  return CONTENT.test(text) || addressPasswords(text).length > 0 || headerlessKeys(text).length > 0;
}

/** A file the user allowed although it holds key-shaped text (a detector's fixtures): `matches` pins each such string by a
 * short hash, and a file holding a private key by the hash of its whole text, so the file stays allowed only while it holds
 * no other string, or, with a private key, only while it is exactly that text. */
export interface SecretPin { path: string; matches: string[] }

const pinOf = (s: string) => createHash("sha256").update(s).digest("hex").slice(0, 16);
/** The pin of a whole file. */
export const filePin = pinOf;
const isKey = (m: Hit) => isHeader(m[0]) || !!m.start;

/** The pins of every key-shaped string in `text`, and of the whole text when it holds a private key, unique and sorted. */
export function secretPins(text: string): string[] {
  const all = contentMatches(text.replaceAll("\0", ""));
  return [...new Set([...all.filter((m) => !isKey(m)).map((m) => m[0]), ...all.some(isKey) ? [text] : []].map(pinOf))].sort();
}

/** The key-shaped strings of a whole file that `pins` does not allow. A private key is allowed only by the pin of the file's
 * whole text. */
function unpinned(text: string, all: readonly Hit[], pins: readonly string[]): Hit[] {
  if (!pins.length) return [...all];
  const whole = pins.includes(pinOf(text));
  return all.filter((m) => !(isKey(m) ? whole : pins.includes(pinOf(m[0]))));
}

/** Names a match without repeating it: its well-known prefix. */
function label(match: string): string {
  if (isHeader(match) || KEY_START_AT.test(match)) return "a private key";
  const prefix = /^(sk-ant-|sk-(?:proj|svcacct|admin)-|sk-|AKIA|gh[pousr]_|xox[abpr]-)/.exec(match)?.[0];
  return prefix ? `${prefix}…` : "a password in an address";
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

/** What a file's key-shaped strings that `pins` does not allow come to: `withhold` names one not in a comment (a private key
 * first, wherever it stands), which leaves the file out only where no stand-in or fake may go (leftOutReason); or, when each one
 * is inside a comment of a source file (a key in a doc example), `blank` those comment lines: `text` is the file with them
 * blanked, its line count kept. */
export type KeyScan = { withhold: { line: number; label: string } } | { blank: number[]; text: string };

export function scanKeys(path: string, text: string, pins: readonly string[]): KeyScan | null {
  const hits = unpinned(text, contentMatches(text), pins);
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
  const inCode = hits.find(isKey) ?? hits.find((m) => !within(m.index, m.index + m[0].length));
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
  for (const m of hits) {
    const at = lineAt(m.index);
    if (!covered(at)) return { withhold: { line: at + 1, label: label(m[0]) } };
    blank.add(at);
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

/** A word or an abbreviation by its letters. A long unbroken run of letters proves nothing. */
function readsAsWord(w: string): boolean {
  if (w.length <= 5) return true;
  if (w.length > 20 || /[^aeiouy]{5,}/i.test(w)) return false;
  return w.length < 12 || (w.match(/[aeiouy]/gi)?.length ?? 0) * 4 >= w.length;
}

/** Whether `s` is proven a name or words: words joined by signs or case (`primaryKeyField]`, `old-signing-key`,
 * `oauth2Client`, `_v402_is_retry`). Random text breaks that: scraps of a letter or two beside digits and other letters,
 * digits inside words, a long run of letters no word has. */
export function nameShaped(s: string): boolean {
  // Signs a password has and a name does not, past a mark at its end (`Password1!`).
  if ((s.replace(/[^A-Za-z0-9]+$/, "").match(/[!#$%^&*]/g)?.length ?? 0) > 1) return false;
  const parts = s.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[0-9]+|[^A-Za-z0-9]+/g) ?? [];
  const isWord = (p: string | undefined) => p !== undefined && /^[A-Za-z]/.test(p);
  const isNumber = (p: string | undefined) => p !== undefined && /^[0-9]/.test(p);
  let letters = 0, scraps = 0, inner = 0;
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!, before = parts[i - 1], after = parts[i + 1];
    if (isWord(p)) {
      if (!readsAsWord(p)) return false;
      letters += p.length;
      if (p.length < 3 && (isWord(before) || isNumber(before) || isWord(after) || isNumber(after))) scraps += p.length;
    } else if (isNumber(p) && isWord(before) && isWord(after)) inner++;
  }
  return letters > 0 && scraps * 6 <= letters && inner <= 1;
}

/** Each part letters and digits, one run each: words or a name, or now and then a random string of that shape. */
const NAME_PARTS = /^(?:[A-Za-z]+[0-9]*|[0-9]+[A-Za-z]*)(?:[-_.:@](?:[A-Za-z]+[0-9]*|[0-9]+[A-Za-z]*))*$/;
/** A JSON web token: it reads as a dotted name when no part holds a `-`. */
const JWT = /^eyJ[\w-]{4,}\.[\w-]{4,}\.[\w-]*$/;
/** Words a placeholder or a name is made of, whatever it stands for. */
const STANDS_FOR = /passw|secret|token|key|auth|example|test|demo|sample|admin|change|default|version|user/i;

/** Whether a value NAME_PARTS turned down is a secret after all, under a strong name: "random" (no word reads in it: `hf_`
 * and random letters, a generated password), "word" (a capitalised word and a number, as people choose:
 * only while no code uses it as a name, usedAsName) or null. The cost of a wrong yes is an odd string in a prompt. */
function wordyValue(value: string): "random" | "word" | null {
  if (value.length < 8 || value.length > 4096 || !NAME_PARTS.test(value)) return null;
  if ([/[a-z]/, /[A-Z]/, /[0-9]/].filter((r) => r.test(value)).length < 2) return null;
  // A long name's capitals start its words, a few among many; random letters are about half capitals.
  const body = value.replace(/^[a-z]{1,8}[-_]/, "");
  const capitals = (body.match(/[A-Z]/g)?.length ?? 0) / body.length;
  if (/^[A-Za-z]{24,}$/.test(body) && capitals >= 0.25 && capitals <= 0.75) return "random";
  if (value.length >= 12 && random(value) && !nameShaped(value)) return "random";
  return /^[A-Z][a-z]{3,}[0-9]{2,}$/.test(value) && !STANDS_FOR.test(value) ? "word" : null;
}

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;
/** Where code is written, for telling a name from a string: what a comment reader knows, and other languages' sources. */
const SOURCE = /\.(?:go|java|kt|rb|php|cs|c|h|cc|cpp|hpp|swift|scala|vue|svelte|sh)$/i;

export const isCodePath = (path: string) => commentStyle(path) !== null || SOURCE.test(path);

/** The rule of a guess that is an ordinary word (`wordyValue`): the tree may overrule it (usedAsName). */
export const WORD_RULE = "named-word";

/** Whether `text`, the file at `path`, uses `value` as a name in its code: outside comments and strings (an even count of
 * quotes before it on its line, which misreads a multi-line string as code; a real password that is also a name there is
 * the rare case). */
export function usedAsName(value: string, text: string, path: string): boolean {
  if (!IDENTIFIER.test(value) || !isCodePath(path) || !text.includes(value)) return false;
  const style = commentStyle(path);
  const spans = style ? comments(text, style) : [];
  const edge = (c: string | undefined) => c === undefined || !/[\w$]/.test(c);
  for (let at = text.indexOf(value); at >= 0; at = text.indexOf(value, at + 1)) {
    if (!edge(text[at - 1]) || !edge(text[at + value.length])) continue;
    const s = spans[lastAtOrBefore(spans, (x) => x.start, at)];
    if (s && at < s.end) continue;
    const before = text.slice(text.lastIndexOf("\n", at) + 1, at).replace(/\\./g, "");
    if ((before.match(/["'`]/g)?.length ?? 0) % 2 === 0) return true;
  }
  return false;
}

/** A literal that may be a secret: 8 printable ASCII characters or more, no blanks, two of lower case, upper case and
 * digits; not cut short with dots (a token's start may be real); not words or a name (`PublicKey`, `password123`,
 * `count_3mo`: each part letters and digits, one run each), a placeholder, a URL, a path or a dotted name. Beside a weak
 * name, or holding a /, it must also look random: 16 characters or more for a weak name, and hold nothing a key does not
 * (brackets, a version range). A value replaced everywhere it appears must never be a name in code. */
function secretValue(value: string, strength: "strong" | "weak"): boolean {
  if (value.length < (strength === "strong" ? 8 : 16) || value.length > 4096 || !/^[\x21-\x7e]+$/.test(value)) {
    return false;
  }
  if (JWT.test(value)) return true;
  if (NAME_PARTS.test(value) || (/(?:\.\.\.|…)$/.test(value) && !value.startsWith("eyJ"))) return false;
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

/** What may hold an unquoted value in a command line: it ends where the shell's next word does. */
const ARG = "[^\\s\"'`;&|#]{1,4096}";
/** `export NAME=v`, in any file: a script, a CI step, a how-to. */
const EXPORTED = new RegExp(`(?:^|[\\s;&(])export[ \\t]+([A-Za-z_]\\w*)=(${ARG})`, "gm");
const SHELL_FILE = /\.(?:sh|bash|zsh|ksh)$|(?:^|\/)\.envrc$/i;
/** `NAME=v` at the start of a line of a shell file, alone or before a command. */
const SHELL_SET = new RegExp(
  `^[ \\t]*(?:(?:readonly|local|declare(?:[ \\t]+-\\w+)*)[ \\t]+)?([A-Za-z_]\\w*)=(${ARG})`, "gm");
const DOCKER_FILE = /(?:^|\/)(?:Dockerfile|Containerfile)[^/]*$|\.dockerfile$/i;
const DOCKER_SET = /^[ \t]*(?:ENV|ARG)[ \t]+([^\n]{1,8192})$/gim;
const MAKE_FILE = /(?:^|\/)(?:GNU)?[Mm]akefile[^/]*$|\.mk$/;
const MAKE_SET =
  /^[ \t]*(?:(?:export|override)[ \t]+)?([A-Za-z_]\w*)[ \t]*(?:::?=|\?=|\+=|=)[ \t]*([^\s"'#$]\S{0,4095})[ \t]*(?:#.*)?$/gm;
/** `curl -H "Authorization: Bearer v"`: the token. */
const AUTH_HEADER = /\bAuthorization:[ \t]*(?:Bearer|Basic|Token)[ \t]+([^\s"'`]{1,4096})/gi;
/** `?api_key=v` in a URL. */
const URL_PARAM = /(?:[?&]|&amp;)([A-Za-z_][\w-]{0,64})=([^\s&#"'`]{1,4096})/g;
/** `docker run -e NAME=v`. */
const DOCKER_E = new RegExp(`(?:^|\\s)(?:-e|--env)[ \\t=]+([A-Za-z_]\\w*)=(${ARG})`, "g");
/** What a value on a command line or in a URL does not hold: it is an expansion or a template there, and no literal. */
const NOT_LITERAL = /[{}()<>[\]$\\`]/;

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

/** Whether a suspect's rule (`why` in suspects) is certain: the string's own shape says it is a secret, and it is replaced
 * wherever tests run. The other rules guess from a name beside it: what a wrong guess may change is what a model reads
 * (boundary.ts) and what an image is built from, never the code tests run. */
export const isCertainRule = (rule: string): boolean => rule === "key-shaped" || rule === "address-password";

/** The strings of `text` (the file at `path`) that may be secrets, `pins` aside: key-shaped strings (private key headers
 * aside) and literal values given to secret-looking names (a `Bearer`/`Basic` value: its token), in code, in config, on a
 * command line or in a URL. A random-looking string, hex or base64, is a key only where a name says so: unnamed, it is a
 * hash, a commit id, an address or a signature that tests compare. */
export function suspects(path: string, text: string, pins: readonly string[], why?: Map<string, string>): string[] {
  const out = new Set<string>();
  const add = (v: string, rule: string) => {
    out.add(v);
    if (why && (!why.has(v) || isCertainRule(rule))) why.set(v, rule);
  };
  const allowed = (s: string) => pins.includes(pinOf(s));
  let spans: Comment[] | undefined;
  const inComment = (at: number) => {
    const style = commentStyle(path);
    if (!style) return false;
    spans ??= comments(text, style);
    const s = spans[lastAtOrBefore(spans, (x) => x.start, at)];
    return !!s && at < s.end;
  };
  for (const m of contentMatches(text)) {
    // A pinned file keeps its key for its tests: the filter hides it in all that leaves.
    if (isHeader(m[0]) || allowed(m[0]) || (m.start && allowed(text))) continue;
    const password = m[0].endsWith("@") ? m[0].slice(0, -1) : null;
    if (password === null) {
      add(m[0], "key-shaped");
    } else if (secretValue(password, "strong")) {
      add(m[0], "address-password");
      add(password, "address-password");
    } else {
      // It reads like a name: alone it stays. And in a comment it is more often a doc's example than a password.
      add(m[0], inComment(m.index) ? "named-address" : "address-password");
    }
  }
  const named = (name: string, raw: string) => {
    const strength = secretName(name);
    if (!strength) return;
    const value = /^(?:Bearer|Basic|Token|token)\s+(\S+)$/.exec(raw)?.[1] ?? raw;
    if (allowed(value)) return;
    if (secretValue(value, strength)) return add(value, `named-${strength}`);
    if (strength !== "strong") return;
    const wordy = wordyValue(value);
    if (wordy === "random") add(value, "named-strong");
    else if (wordy === "word" && !usedAsName(value, text, path)) add(value, WORD_RULE);
  };
  const near = namedLines(text);
  for (const [name, value] of assignedPairs(near)) named(name, value);
  for (const m of near.matchAll(PAIR)) named(m[2]!, m[4]!);
  if (CONFIG.test(path)) for (const m of near.matchAll(UNQUOTED)) named(m[1]!, m[2]!);
  /** On a command line or in a URL: what is there unquoted is a value only when it holds nothing a template does. */
  const literal = (name: string, value: string) => {
    if (!NOT_LITERAL.test(value)) named(name, value);
  };
  for (const m of near.matchAll(EXPORTED)) literal(m[1]!, m[2]!);
  for (const m of near.matchAll(DOCKER_E)) literal(m[1]!, m[2]!);
  for (const m of near.matchAll(URL_PARAM)) literal(m[1]!, m[2]!.replace(/[),.;:]+$/, ""));
  for (const m of near.matchAll(AUTH_HEADER)) literal("authorization", m[1]!);
  if (SHELL_FILE.test(path)) for (const m of near.matchAll(SHELL_SET)) literal(m[1]!, m[2]!);
  if (MAKE_FILE.test(path)) for (const m of near.matchAll(MAKE_SET)) literal(m[1]!, m[2]!);
  if (DOCKER_FILE.test(path)) {
    for (const [, rest] of near.matchAll(DOCKER_SET)) {
      const pairs = [...rest!.matchAll(/([A-Za-z_]\w*)=([^\s"']+)/g)];
      for (const m of pairs) literal(m[1]!, m[2]!);
      const old = pairs.length ? null : /^([A-Za-z_]\w*)[ \t]+([^\s"']+)[ \t]*$/.exec(rest!);
      if (old) literal(old[1]!, old[2]!);
    }
  }
  return [...out];
}

/** Every value a file secret by its name holds (secret file globs), under any key name: `KEY=v` and `key: v` lines,
 * and a JSON file's string values. Not a number, a boolean or a word with spaces, and 8 characters or more. These are
 * guesses: they hide text that leaves arnx, and no code that tests run is rewritten for them. */
export function secretFileValues(path: string, text: string): string[] {
  const out = new Set<string>();
  const take = (raw: string) => {
    const v = raw.trim().replace(/^(["'`])(.*)\1$/, "$2");
    if (v.length >= 8 && v.length <= 4096 && !/\s/.test(v) && !/^(?:true|false|null|none|yes|no|on|off)$/i.test(v) &&
      !/^[-+]?\d+(?:\.\d+)?$/.test(v)) out.add(v);
  };
  if (/\.json$/i.test(path)) {
    const walk = (x: unknown, depth: number): void => {
      if (out.size > 10_000 || depth > 32) return;
      if (typeof x === "string") take(x);
      else if (Array.isArray(x)) x.forEach((y) => walk(y, depth + 1));
      else if (x && typeof x === "object") Object.values(x).forEach((y) => walk(y, depth + 1));
    };
    try {
      walk(JSON.parse(text), 0);
    } catch {
      for (const m of text.matchAll(/:\s*"([^"\\\n]{1,4096})"/g)) take(m[1]!);
    }
  }
  for (const line of text.split("\n")) {
    if (line.length > 4200) continue;
    const m = /^[ \t]*(?:export[ \t]+)?[A-Za-z_][\w.-]*[ \t]*[:=][ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[1]!.trim();
    // A quoted value is whole; an unquoted one ends at a comment.
    take(/^["'`]/.test(value) ? value : value.replace(/[ \t]+#.*$/, ""));
  }
  return [...out];
}

const MANY_VALUES = 64;

/** Whether `v` stands whole at `at` in `text`, by the rule of matcherOf: no word character, `+` or `/` before it, and none after
 * it unless it ends in `@`. */
export function wholeAt(text: string, at: number, v: string): boolean {
  if (/[A-Za-z0-9+/]/.test(text[at - 1] ?? "")) return false;
  return v.endsWith("@") || !/[A-Za-z0-9]/.test(text[at + v.length] ?? "");
}

/** Whole occurrences of `values`, longest first. A password with its @ has a host right after it; anything else ends where
 * a word would. */
function matcherOf(values: readonly string[]): RegExp {
  const escaped = values.map((v) => v.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&") + (v.endsWith("@") ? "" : "(?![A-Za-z0-9])"));
  return new RegExp(`(?<![A-Za-z0-9+/])(?:${escaped.join("|")})`, "g");
}

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
      matcher = matcherOf(here);
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

/** A private key in `text` that `pins` does not allow: a header, whatever is under it, or a run that starts as a key. */
export function holdsPrivateKey(text: string, pins: readonly string[]): boolean {
  return unpinned(text, contentMatches(text), pins).some(isKey);
}

/** Where a piece of a file holds private-key text; -1 when it holds none. */
export const privateKeyIn = (text: string) => privateKeySpans(text).find((s) => s.kind !== "end")?.from ?? -1;

/** Every key-shaped string in `text`, by line and label (never the string itself). */
export function secretHits(text: string): { line: number; label: string }[] {
  const out: { line: number; label: string }[] = [];
  let line = 1, at = 0;
  const plain = text.replaceAll("\0", "");
  for (const m of contentMatches(plain)) {
    for (; at < m.index; at++) if (plain.charCodeAt(at) === 10) line++;
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
