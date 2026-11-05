// Real keys, built at run time, in every shape a repository holds them: no line of a body reaches a model, the sandbox, or
// what a review saves. Each row goes the whole way, through a model's place at the outermost layer.
import { afterAll, afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { changeLimits, resolveChange, takeSnapshot } from "../src/change";
import { parseReviewConfig, reviewConfigPath, stamp } from "../src/config";
import { leftOutNote } from "../src/prompts";
import { runReview } from "../src/reviewer";
import { hasSecretContent, holdsPrivateKey, secretHits, secretPins } from "../src/secrets";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { fakeFactory, type FakeSession, tool } from "./helpers/fakes";
import { commit, gitRepo, runGit } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { RecordingAgent, RecordingJson, treeText } from "./helpers/recording";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_add.py";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };
const REPORT = JSON.stringify({ tests: [{ test: `${GEN}::test_add`, expects: "add sums" }],
  suspected_defects: [{ test: `${GEN}::test_add`, explanation: "add subtracts." }], questions: [] });
const SOURCE = "from app import add\n\ndef test_add():\n    assert add(2, 3) == 5\n";

const pem = (o: object) => (o as { export(x: object): string });
const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
const ec = generateKeyPairSync("ec", { namedCurve: "P-256" });
const ed = generateKeyPairSync("ed25519");
const pk8 = pem(rsa.privateKey).export({ type: "pkcs8", format: "pem" });
const pk1 = pem(rsa.privateKey).export({ type: "pkcs1", format: "pem" });
const sec1 = pem(ec.privateKey).export({ type: "sec1", format: "pem" });
const ecp8 = pem(ec.privateKey).export({ type: "pkcs8", format: "pem" });
const edp8 = pem(ed.privateKey).export({ type: "pkcs8", format: "pem" });
const enc8 = pem(rsa.privateKey).export({ type: "pkcs8", format: "pem", cipher: "aes-256-cbc", passphrase: "x" });
const enc1 = pem(rsa.privateKey).export({ type: "pkcs1", format: "pem", cipher: "aes-256-cbc", passphrase: "x" });
const other = pem(generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey).export({ type: "pkcs8", format: "pem" });
const sshDir = mkdtempSync(join(tmpdir(), "arnx-ssh-"));
const ssh = (name: string, ...args: string[]) => {
  const made = spawnSync("ssh-keygen", ["-q", ...args, "-f", join(sshDir, name)]);
  return made.status === 0 ? readFileSync(join(sshDir, name), "utf8") : null;
};
const opensshPlain = ssh("k", "-t", "ed25519", "-N", "");
const opensshEnc = ssh("r", "-t", "rsa", "-b", "2048", "-N", "pw");
afterAll(() => rmSync(sshDir, { recursive: true, force: true }));
const KEY = "PRIVATE " + "KEY";
const armour = (begin: string, end: string, b: Buffer, w = 64) =>
  `${begin}\n\n${b.toString("base64").match(new RegExp(`.{1,${w}}`, "g"))!.join("\n")}\n${end}\n`;
const pgp = armour(`-----BEGIN PGP ${KEY} BLOCK-----`, `-----END PGP ${KEY} BLOCK-----`, randomBytes(1200));
const ssh2 = armour(`---- BEGIN SSH2 ENCRYPTED ${KEY} ----`, `---- END SSH2 ENCRYPTED ${KEY} ----`, randomBytes(1000));
const digits = armour(`-----BEGIN ED25519 ${KEY}-----`, `-----END ED25519 ${KEY}-----`, randomBytes(64)).replace("\n\n", "\n");
const ppk = "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nComment: k\nPublic-Lines: 1\n" +
  `AAAAC3NzaC1lZDI1NTE5AAAAI${"Mock".repeat(10)}\nPrivate-Lines: 1\n${randomBytes(32).toString("base64")}\n` +
  `Private-MAC: ${randomBytes(32).toString("hex")}\n`;

const lines = (text: string) => text.split("\n").filter(Boolean);
const bodyOf = (text: string) => lines(text).filter((l) => !/^-+ ?(BEGIN|END)/.test(l) && !/^[A-Za-z-]+: /.test(l));
const rewrap = (text: string, w: number) => {
  const all = lines(text);
  return [all[0]!, ...bodyOf(text).join("").match(new RegExp(`.{1,${w}}`, "g"))!, all.at(-1)!].join("\n") + "\n";
};
const esc = (text: string) => text.replace(/\n/g, "\\n");
const marked = (text: string, mark: string) => text.trimEnd().split("\n").map((l) => mark + l).join("\n") + "\n";
const big = (s: string, n: number) => `${"// padding line\n".repeat(Math.ceil(n / 16))}${s}export const z = 1;\n`;
const nul = (s: string, n = 10) => Buffer.concat([Buffer.alloc(n), Buffer.from(s)]);
const asB64 = (s: string) => Buffer.from(s).toString("base64");

/** `out`: the file leaves the change. `absent`: it never was in the change. */
type Want = "out" | "absent";
interface Row { name: string; key: string; path: string; want?: Want; content?: string | Buffer | null;
  setup?: (repo: string) => void; worktree?: boolean; untracked?: boolean; settings?: Partial<Settings> }
const wrap32 = rewrap(pk8, 32);
const ROWS: Row[] = [
  { name: "RSA PKCS8", key: pk8, path: "k.txt" },
  { name: "RSA PKCS1 in a template string", key: pk1, path: "k.ts", content: `const P = \`${pk1}\`;\n` },
  { name: "EC SEC1", key: sec1, path: "k.txt" },
  { name: "EC PKCS8", key: ecp8, path: "k.txt" },
  { name: "Ed25519 PKCS8", key: edp8, path: "k.txt" },
  { name: "encrypted PKCS8", key: enc8, path: "k.txt" },
  { name: "encrypted PKCS1, with its Proc-Type lines", key: enc1, path: "k.txt" },
  { name: "OpenSSH Ed25519", key: opensshPlain ?? "", path: "k.txt", content: opensshPlain },
  { name: "OpenSSH RSA, encrypted", key: opensshEnc ?? "", path: "k.txt", content: opensshEnc },
  { name: "wrapped at 40", key: rewrap(pk8, 40), path: "k.txt" },
  { name: "wrapped at 39", key: rewrap(pk8, 39), path: "k.txt" },
  { name: "wrapped at 32", key: wrap32, path: "k.txt" },
  { name: "wrapped at 20", key: rewrap(pk8, 20), path: "k.txt" },
  { name: "wrapped at 32 in a string array", key: rewrap(pk1, 32), path: "k.ts",
    content: `const P = [\n${lines(rewrap(pk1, 32)).map((l) => `  "${l}",`).join("\n")}\n];\n` },
  { name: "wrapped at 32 with no END line", key: wrap32, path: "k.txt", content: `${lines(wrap32).slice(0, -1).join("\n")}\n` },
  { name: "wrapped at 32 with CRLF", key: wrap32, path: "k.txt", content: wrap32.replace(/\n/g, "\r\n") },
  { name: "CRLF", key: pk8, path: "k.txt", content: pk8.replace(/\n/g, "\r\n") },
  { name: "Ed25519 wrapped at 32", key: rewrap(edp8, 32), path: "k.txt" },
  { name: "SEC1 wrapped at 32, a # comment", key: rewrap(sec1, 32), path: "k.py",
    content: `${marked(rewrap(sec1, 32), "# ")}x = 1\n` },
  { name: "JSON service account", key: pk8, path: "svc.json",
    content: `${JSON.stringify({ type: "service_account", private_key: pk8 }, null, 1)}\n` },
  { name: "JSON wrapped at 32", key: wrap32, path: "svc.json", content: `${JSON.stringify({ private_key: wrap32 }, null, 1)}\n` },
  { name: "JSON with \\r\\n", key: pk8, path: "svc.json", content: `${JSON.stringify({ private_key: pk8.replace(/\n/g, "\r\n") })}\n` },
  { name: "JSON in JSON", key: pk8, path: "svc.json",
    content: `${JSON.stringify({ wrapped: JSON.stringify({ private_key: pk8 }) })}\n` },
  { name: "JSON with spaces for line ends", key: pk8, path: "svc.json", content: `${JSON.stringify({ private_key: pk8.replace(/\n/g, " ") })}\n` },
  { name: "YAML block", key: pk8, path: "c.yaml", content: `key: |\n${marked(pk8, "  ")}` },
  { name: "YAML folded", key: pk8, path: "c.yaml", content: `key: >-\n${marked(pk8, "  ")}` },
  { name: "YAML block wrapped at 32", key: wrap32, path: "c.yaml", content: `key: |\n${marked(wrap32, "  ")}` },
  { name: "YAML escaped", key: pk8, path: "c.yaml", content: `key: "${esc(pk8)}"\n` },
  { name: "a # comment", key: pk8, path: "k.py", content: `${marked(pk8, "# ")}x = 1\n` },
  { name: "a // comment", key: pk8, path: "k.ts", content: `${marked(pk8, "// ")}export const x = 1;\n` },
  { name: "a /* */ comment", key: pk8, path: "k.ts", content: `/*\n${marked(pk8, " * ")} */\nexport const x = 1;\n` },
  { name: "a // comment wrapped at 32", key: wrap32, path: "k.ts", content: `${marked(wrap32, "// ")}export const x = 1;\n` },
  { name: "a Markdown quote", key: pk8, path: "d.md", content: marked(pk8, "> ") },
  { name: "a Markdown fence", key: pk8, path: "d.md", content: `\`\`\`\n${pk8}\`\`\`\n` },
  { name: "base64 of a whole PEM, a Kubernetes secret", key: asB64(pk8), path: "s.yaml", content: `data:\n  tls.key: ${asB64(pk8)}\n` },
  { name: "base64 of a whole PEM, a constant", key: asB64(pk8), path: "s.ts", content: `export const blob = "${asB64(pk8)}";\n` },
  { name: "URL-encoded PEM", key: encodeURIComponent(pk8), path: "s.txt", content: `x=${encodeURIComponent(pk8)}\n` },
  { name: "notebook source lines", key: pk8, path: "n.ipynb",
    content: `${JSON.stringify({ cells: [{ cell_type: "code", source: pk8.split(/(?<=\n)/) }], nbformat: 4 }, null, 1)}\n` },
  { name: "notebook wrapped at 32", key: wrap32, path: "n.ipynb",
    content: `${JSON.stringify({ cells: [{ cell_type: "code", source: wrap32.split(/(?<=\n)/) }], nbformat: 4 }, null, 1)}\n` },
  { name: "one minified line", key: pk8, path: "m.min.js", content: `!function(){var k="${esc(pk8)}",a=1;}();\n` },
  { name: "PGP block", key: pgp, path: "k.txt" },
  { name: "SSH2 block", key: ssh2, path: "k.txt" },
  { name: "a digit in the label", key: digits, path: "k.txt" },
  { name: ".ppk file", key: `Private-Lines: 1\n${lines(ppk)[6]}\n`, path: "k.ppk", want: "absent", content: ppk },
  { name: "split header, concatenated body", key: pk8, path: "s.ts", content:
    `const P = "-----BEGIN PRIV" + "ATE KEY-----\\n" + \n${bodyOf(pk8).map((l) => `  "${l}\\n" +`).join("\n")}\n  "-----END PRIV" + "ATE KEY-----";\n` },
  { name: "bare body under a name", key: pk8, path: "c.toml", content: `signing_key = "${bodyOf(pk8).join("")}"\n` },
  { name: "bare body in an array", key: pk8, path: "s.ts", content: `const parts = [\n${bodyOf(pk8).map((l) => `  "${l}",`).join("\n")}\n];\n` },
  { name: "a small binary", key: pk8, path: "k.bin", content: nul(pk8) },
  { name: "a byte that is not text, then a PEM", key: pk8, path: "k.txt", content: Buffer.concat([Buffer.from([0xe9, 0xff, 10]), Buffer.from(pk8)]) },
  { name: "UTF-16", key: pk8, path: "k.txt", content: Buffer.from(`﻿${pk8}`, "utf16le") },
  { name: "UTF-16 past git's binary check", key: pk8, path: "k.txt", content: Buffer.concat([Buffer.from("A\n".repeat(4100)), Buffer.from(pk8, "utf16le")]) },
  { name: "text, then NUL past 8000, then a PEM", key: pk8, path: "k.txt", content: Buffer.concat([Buffer.from("A\n".repeat(4100)), Buffer.alloc(3), Buffer.from(pk8)]) },
  { name: "over 1 MB", key: pk8, path: "b.ts", content: big(pk8, 1_100_000) },
  { name: "over 1 MB, wrapped at 32", key: wrap32, path: "b.ts", content: big(wrap32, 1_100_000) },
  { name: "over 1 MB, NUL first", key: pk8, path: "b.bin", content: Buffer.concat([Buffer.alloc(16), Buffer.from(big(pk8, 1_100_000))]) },
  { name: "over 1 MB, NUL first, diffed as text", key: pk8, path: "b.bin", content: Buffer.concat([Buffer.alloc(16), Buffer.from(big(pk8, 1_100_000))]),
    setup: (r) => writeFileSync(join(r, ".gitattributes"), "*.bin diff\n") },
  { name: "small NUL, diffed as text", key: pk8, path: "b.bin", content: nul(pk8), setup: (r) => writeFileSync(join(r, ".gitattributes"), "*.bin diff\n") },
  { name: ".arnxignore", key: pk8, path: "ign/k.txt", want: "absent", setup: (r) => writeFileSync(join(r, ".arnxignore"), "ign/\n") },
  { name: "untracked, not opted in", key: pk8, path: "u.txt", want: "absent", worktree: true, untracked: false },
  { name: "untracked, opted in", key: pk8, path: "u.txt", worktree: true, untracked: true },
  { name: "untracked, opted in, wrapped at 32", key: wrap32, path: "u.txt", worktree: true, untracked: true },
  { name: "staged in the working tree", key: pk8, path: "w.txt", worktree: true },
  { name: "stand-ins off, wrapped at 32", key: wrap32, path: "k.txt", settings: { standIns: false } },
];

const probesOf = (key: string) => {
  const raw = bodyOf(key).filter((l) => l.length >= 12);
  return raw.length ? raw : [key.slice(0, 60)];
};
/** What a test holds of a body, also with a NUL after each character (UTF-16). */
const leaked = (where: string, hay: string, probes: string[]) => {
  const plain = hay.replaceAll("\0", "");
  const found = probes.filter((p) => plain.includes(p)).length;
  if (found) throw new Error(`${where}: ${found} of ${probes.length} body lines`);
};

function configured(o: Partial<Settings> = {}, under = tmp()): string {
  const repo = gitRepo(under);
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), stamp(parseReviewConfig(YAML), "Dev", "2026-11-04"));
  writeSettings(repo, { ...SETTINGS, ...o });
  commit(repo, "set up");
  return repo;
}
const editApp = (repo: string) => writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a - b\n");
const put = (repo: string, path: string, content: string | Buffer) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), content);
};

for (const row of ROWS) {
  const made = row.content !== null && !!row.key;
  test.skipIf(!made)(`a body reaches nothing: ${row.name}`, async () => {
    const settings = { ...SETTINGS, ...row.settings };
    const repo = configured(row.settings);
    if (row.setup) {
      row.setup(repo);
      commit(repo, "settings");
    }
    editApp(repo);
    put(repo, row.path, row.content ?? row.key);
    if (!row.worktree) commit(repo, "a key and an edit");
    else if (row.untracked === undefined) runGit(repo, "add", row.path);
    const probes = probesOf(row.key);
    const untracked = !!row.untracked;

    const c = resolveChange(repo, null, [], { untracked });
    leaked("change.diff", c.diff, probes);
    const want = row.want ?? "out";
    const state = c.withheld?.some((w) => w.path === row.path) ? "out" : c.diff.includes(row.path) ? "kept" : "absent";
    expect(state).toBe(want);

    const snap = join(tmp(), "snap");
    takeSnapshot(repo, row.worktree ? null : "HEAD", snap, [], { untracked });
    leaked("snapshot", treeText(snap), probes);

    const seen: FakeSession[] = [];
    const inSandbox: string[] = [];
    const agent = new RecordingAgent([
      [tool("read_file", { path: row.path }), tool("grep", { pattern: probes[0]!.slice(0, 12).replace(/[+/=]/g, "."), path: "." }),
        tool("list_dir", { path: "." })],
      [tool("write_file", { path: GEN, content: SOURCE }), tool("run_tests", {})]], REPORT);
    const judge = new RecordingJson();
    const { rdir } = await runReview(repo, { settings, agentModel: agent, challenger: judge, untracked, progress: () => {},
      sessionFactory: fakeFactory(() => {
        inSandbox.push(treeText(seen.at(-1)!.snap));
        return [junitXml([[GEN, "test_add", "failed", "assert 1 == 5"]]), "1 failed\n", false];
      }, seen) });
    leaked("a model's messages", [...agent.bodies, ...judge.bodies].join("\n"), probes);
    leaked("the sandbox", inSandbox.join("\n"), probes);
    leaked("the saved review", treeText(rdir), probes);
  }, 30_000);
}

// --- what must stay as it is -------------------------------------------------------------------------------------------

const HDR = `-----BEGIN ${KEY}-----`, END = `-----END ${KEY}-----`;
const PLACEHOLDERS: [string, string][] = [
  ["dots", `${HDR}\n...\n${END}\n`],
  ["escaped dots", `const a = "${HDR}\\n...\\n${END}\\n";\n`],
  ["a cut body", `${HDR}\nMIIEpAIBAAKCAQEA...\n${END}\n`],
  ["a cut PKCS8 body", `${HDR}\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC...\n...\n${END}\n`],
  ["angle brackets", `${HDR}\n<private key>\n${END}\n`],
  ["not a key", `const a = "${HDR}\\nnot-a-valid-key\\n${END}";\n`],
  ["a template", `const a = \`${HDR}\n\${base64Key}\n${END}\`;\n`],
  ["a short word", `const a = "${HDR}\\nabc123\\n${END}";\n`],
  ["a 16-character run", `const a = "${HDR}\\nabcdefghABCDEFGH\\n${END}";\n`],
  ["all the same letter", `${HDR}\n${"X".repeat(64)}\n${"X".repeat(64)}\n${END}\n`],
  ["two letters over and over, wrapped", `${HDR}\n${"aA".repeat(10)}\n${"aA".repeat(10)}\n${"aA".repeat(10)}\n${END}\n`],
  ["an assertion", `assert "${HDR}" in private_pem\nassert "${END}" in private_pem\n`],
  ["a header alone", `const a = "${HDR}";\n`],
  ["no lines between", `${HDR}\n${END}\n`],
  ["prose", `Paste ${HDR} here, then the body and the\nclosing line, for example ${END} at the end.\n`],
  ["code that looks for it", `const a = pem.startsWith("${HDR}");\nconst b = pem.endsWith("${END}");\n`],
];
for (const [name, text] of PLACEHOLDERS) {
  test(`a placeholder header leaves its file out until it is allowed: ${name}`, () => {
    expect(holdsPrivateKey(text, [])).toBe(true);
    const repo = gitRepo(tmp());
    const long = "docs/Guides/AuthenticationAndSecurity/Certificates/README.md";
    put(repo, long, text);
    editApp(repo);
    commit(repo, "a doc");
    const c = resolveChange(repo);
    expect([c.files, c.withheld?.map((w) => [w.path, w.label])]).toEqual([["app.py"], [[long, "a private key"]]]);
    expect(takeSnapshot(repo, "HEAD", join(tmp(), "s"), [], { standIns: true }).withheld.map((w) => w.path)).toEqual([long]);
    const allowed = resolveChange(repo, null, [{ path: long, matches: secretPins(text) }]);
    expect([allowed.files, allowed.withheld]).toEqual([["app.py", long], undefined]);
  });
}

test("what is not a private key stays: a certificate, a public key, their base64, an unrelated long value", () => {
  const spki = pem(rsa.publicKey).export({ type: "spki", format: "pem" });
  const rows = [spki, asB64(spki), bodyOf(spki).join(""), `MIIDdzCCAl+gAwIBAgI${randomBytes(90).toString("base64")}`,
    asB64(`-----BEGIN CERTIFICATE-----\n${randomBytes(300).toString("base64")}\n-----END CERTIFICATE-----\n`),
    randomBytes(60).toString("base64")];
  for (const text of rows) expect(holdsPrivateKey(text, [])).toBe(false);
});

test("every kind of key is known by how its encoding starts, whole or wrapped", () => {
  const der = (k: { privateKey: object }, ...kinds: object[]) => kinds.map((kind) => pem(k.privateKey).export({ format: "pem", ...kind }));
  const kinds = [
    ...der(generateKeyPairSync("rsa", { modulusLength: 1024 }), { type: "pkcs1" }, { type: "pkcs8" }),
    ...der(rsa, { type: "pkcs1" }, { type: "pkcs8" }, { type: "pkcs8", cipher: "aes-256-cbc", passphrase: "x" }),
    ...["prime256v1", "secp384r1", "secp521r1"].flatMap((namedCurve) =>
      der(generateKeyPairSync("ec", { namedCurve }), { type: "sec1" }, { type: "pkcs8" })),
    ...der(ed, { type: "pkcs8" }), ...der(generateKeyPairSync("x25519"), { type: "pkcs8" }),
    ...(opensshPlain ? [opensshPlain] : []),
  ];
  const known = (bare: string) => {
    expect(holdsPrivateKey(bare, [])).toBe(true);
    expect(secretHits(bare)[0]?.label).toBe("a private key");
    expect(hasSecretContent(bare)).toBe(true);
    if (bare.length > 100) expect(holdsPrivateKey(bare.match(/.{1,32}/g)!.join("\n"), [])).toBe(true);
  };
  for (const key of kinds) {
    known(bodyOf(key).join(""));
    expect(holdsPrivateKey(asB64(key), [])).toBe(true);
  }
  // How those this runtime cannot make start: Ed448, secp256k1 SEC1, DSA PKCS8, a P-256 PKCS8 that is encrypted.
  for (const start of ["MEcCAQAwBQYDK2Vx", "MHQCAQEEI", "MIIBWwIBADCCATQGByqGSM44", "MIHsMFcGCSqGSIb3DQEF"]) {
    known(`${start}${randomBytes(90).toString("base64")}`);
  }
});

// --- what a change shows, across its sections -------------------------------------------------------------------------

test("a header removed from one file and the body added to another leave nothing of the body", () => {
  const repo = gitRepo(tmp());
  put(repo, "x.txt", `old\n${HDR}\nend\n`);
  put(repo, "y.txt", "z\n");
  commit(repo, "a header");
  put(repo, "x.txt", "old\nend\n");
  put(repo, "y.txt", `${bodyOf(pk8).join("\n")}\n`);
  editApp(repo);
  commit(repo, "the body elsewhere");
  const c = resolveChange(repo);
  expect(c.withheld?.map((w) => w.path)).toEqual(["x.txt", "y.txt"]);
  leaked("the diff", c.diff, probesOf(pk8));
  const same = gitRepo(join(tmp(), "same"));
  put(same, "x.txt", `old\n${HDR}\nend\n`);
  commit(same, "a header");
  put(same, "x.txt", `old\n${bodyOf(pk8).join("\n")}\nend\n`);
  editApp(same);
  commit(same, "the body in its place");
  const one = resolveChange(same);
  expect(one.withheld?.map((w) => w.path)).toEqual(["x.txt"]);
  leaked("the diff", one.diff, probesOf(pk8));
});

test("wrapped at 32 on the removed side, or in a 3 MB file with a small hunk: the section goes", () => {
  const repo = gitRepo(tmp());
  put(repo, "x.txt", wrap32);
  commit(repo, "a key");
  put(repo, "x.txt", "gone\n");
  editApp(repo);
  commit(repo, "the key goes");
  const c = resolveChange(repo);
  expect(c.withheld?.map((w) => w.path)).toEqual(["x.txt"]);
  leaked("the diff", c.diff, probesOf(wrap32));

  const pad = "// padding line\n".repeat(200_000);
  const big3 = gitRepo(join(tmp(), "big"));
  put(big3, "b.ts", `${pad}end\n`);
  commit(big3, "large");
  put(big3, "b.ts", `${pad}${wrap32}end\n`);
  editApp(big3);
  commit(big3, "a key in it");
  const d = resolveChange(big3);
  expect(d.withheld?.map((w) => w.path)).toEqual(["b.ts"]);
  leaked("the diff", d.diff, probesOf(wrap32));
});

test("a comment with a wrapped key and no END line: the file leaves the change", () => {
  const repo = gitRepo(tmp());
  put(repo, "k.py", `${lines(wrap32).slice(0, -1).map((l) => `# ${l}`).join("\n")}\nx = 1\n`);
  editApp(repo);
  commit(repo, "a key in a comment");
  const c = resolveChange(repo);
  expect(c.withheld?.map((w) => w.path)).toEqual(["k.py"]);
  leaked("the diff", c.diff, probesOf(wrap32));
});

test("a big binary holding a key is out of the sandbox; one without stays", async () => {
  const held = Buffer.concat([Buffer.alloc(16), Buffer.from("x\n".repeat(600_000)), Buffer.from(pk8)]);
  const repo = configured();
  put(repo, "b.bin", held);
  put(repo, "plain.bin", Buffer.concat([Buffer.alloc(16), Buffer.from("x\n".repeat(600_000))]));
  editApp(repo);
  commit(repo, "binaries");
  const c = resolveChange(repo);
  expect(c.withheld?.map((w) => [w.path, w.label])).toEqual([["b.bin", "a private key"]]);
  expect(c.files).toEqual(["app.py", "plain.bin"]);
  const snap = join(tmp(), "snap");
  const taken = takeSnapshot(repo, "HEAD", snap, [], { standIns: true });
  expect(taken.withheld.map((w) => w.path)).toEqual(["b.bin"]);
  expect([existsSync(join(snap, "b.bin")), existsSync(join(snap, "plain.bin"))]).toEqual([false, true]);
  const worktree = join(tmp(), "wt");
  takeSnapshot(repo, null, worktree, [], { standIns: true });
  expect(existsSync(join(worktree, "b.bin"))).toBe(false);
  // New in the working tree: its own side is all there is.
  const fresh = gitRepo(join(tmp(), "fresh"));
  put(fresh, "b.bin", held);
  editApp(fresh);
  runGit(fresh, "add", "b.bin");
  expect(resolveChange(fresh).withheld?.map((w) => w.path)).toEqual(["b.bin"]);
  // Over the largest scan, from the working tree and from a commit.
  changeLimits.maxScanBytes = 1000;
  expect(resolveChange(repo).withheld?.map((w) => w.path)).toEqual(["b.bin"]);
  put(repo, "b.bin", Buffer.concat([held, Buffer.from("more")]));
  put(repo, "app.py", "def add(a, b):\n    return a * b\n");
  expect(resolveChange(repo).withheld?.map((w) => w.path)).toEqual(["b.bin"]);
});

test("a file over every limit: a key leaves it out, pinned or not, and so does a bare body", () => {
  const repo = gitRepo(tmp());
  const pad = "// padding line\n".repeat(2000);
  put(repo, "keyed.ts", `${pad}end\n`);
  put(repo, "bare.ts", `${pad}end\n`);
  put(repo, "clean.ts", `${pad}end\n`);
  commit(repo, "large");
  changeLimits.maxScanBytes = 1000;
  put(repo, "keyed.ts", `${pad}${pk8}end\n`);
  put(repo, "bare.ts", `${pad}${bodyOf(pk8).join("\n")}\nend\n`);
  put(repo, "clean.ts", `${pad}more\nend\n`);
  const check = (allow: { path: string; matches: string[] }[]) => {
    const c = resolveChange(repo, null, allow);
    expect(c.withheld?.map((w) => [w.path, w.label])).toEqual([["bare.ts", "a private key"], ["keyed.ts", "a private key"]]);
    expect(c.files).toEqual(["clean.ts"]);
    leaked("the diff", c.diff, probesOf(pk8));
  };
  check([]);
  check([{ path: "keyed.ts", matches: secretPins(pk8) }]);
  commit(repo, "edit");
  check([]);
  check([{ path: "keyed.ts", matches: secretPins(pk8) }]);
});

// --- a search that fails counts as a hit -------------------------------------------------------------------------------

/** Runs `body` with a `git` that fails where `when` (a line of shell) says. */
function withBroken(when: string, body: () => void): void {
  const bin = mkdtempSync(join(tmpdir(), "arnx-git-"));
  const real = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
  writeFileSync(join(bin, "git"), `#!/bin/sh\n${when}\nexec ${real} "$@"\n`);
  chmodSync(join(bin, "git"), 0o755);
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  try {
    body();
  } finally {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  }
}

test("a failed search of a commit's files reads every file: the key is still found", () => {
  const repo = gitRepo(tmp());
  put(repo, "keys.ts", `const P = \`${pk8}\`;\n`);
  editApp(repo);
  commit(repo, "a key");
  withBroken('for a in "$@"; do [ "$a" = grep ] && exit 2; done', () => {
    const c = resolveChange(repo);
    expect(c.withheld?.map((w) => w.path)).toEqual(["keys.ts"]);
    expect(c.files).toEqual(["app.py"]);
  });
});

test("a failed read of a file too large to hold leaves it out", () => {
  const repo = gitRepo(tmp());
  put(repo, "big.txt", `one\n${"text ".repeat(2000)}\n`);
  editApp(repo);
  commit(repo, "large");
  changeLimits.maxScanBytes = 1000;
  withBroken('for a in "$@"; do [ "$a" = grep ] && exit 2; done\n[ -f /dev/stdout ] && [ "$3" = show ] && exit 2', () => {
    const c = resolveChange(repo);
    expect(c.withheld).toEqual([{ path: "big.txt", line: 1, label: "could not be read" }]);
    expect(c.files).toEqual(["app.py"]);
  });
});

// --- what is said --------------------------------------------------------------------------------------------------------

test("a change whose only key is on its removed side points to --range, not to allow-secret", () => {
  const repo = gitRepo(tmp());
  put(repo, "k.txt", pk8);
  commit(repo, "a key");
  put(repo, "k.txt", "clean\n");
  commit(repo, "the key goes");
  let said = "";
  try {
    resolveChange(repo);
  } catch (e) {
    said = (e as Error).message;
  }
  expect(said).toContain("k.txt (a private key)");
  expect(said).toContain("--range");
  expect(said).toContain("arnx allow-secret k.txt");
  // With one on the side it adds, allow-secret can help.
  put(repo, "m.txt", other);
  commit(repo, "another");
  expect(() => resolveChange(repo)).toThrow("arnx allow-secret m.txt");
});

test("the note does not say a file left out is unreadable when a clean copy is there to read", async () => {
  const note = leftOutNote([{ path: "k.txt", line: 1, label: "a private key" }]);
  expect(note).toContain("neither this diff");
  expect(note).toContain("a copy holding the secret is in neither");
  const repo = configured();
  put(repo, "k.txt", pk8);
  commit(repo, "a key");
  put(repo, "k.txt", "clean head version\n");
  editApp(repo);
  commit(repo, "the key goes");
  const agent = new RecordingAgent([[tool("read_file", { path: "k.txt" })]], REPORT);
  await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: new RecordingJson(), progress: () => {},
    sessionFactory: fakeFactory(() => [junitXml([[GEN, "test_add", "passed", ""]]), "1 passed\n", false]) });
  const sent = agent.bodies.join("\n");
  expect(sent).toContain("clean head version");
  leaked("a model's messages", sent, probesOf(pk8));
});

afterEach(() => {
  changeLimits.maxScanBytes = 32_000_000;
});
