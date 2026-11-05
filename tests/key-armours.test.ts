// The armours of a private key arnx knows: PGP's block, SSH2's four dashes, a digit or a hyphen in the label, and a
// PuTTY file by its name. Each, committed in a change, never reaches the diff, the snapshot or a model. Keys are
// built at run time.
import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isSecretPath, secretHits, suspects } from "../src/secrets";
import { armour, editApp, KEY_WORDS, randomBody, setUp, whereKeyShows, wrap } from "./helpers/keyrows";
import { commit, gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const body = randomBody();
const dashes = (n: number) => "-".repeat(n);
const rows: { name: string; path: string; content: string; probes: string[] }[] = [
  { name: "PGP's block", path: "k.txt", content: armour(`${dashes(5)}BEGIN PGP ${KEY_WORDS} BLOCK${dashes(5)}`,
    `${dashes(5)}END PGP ${KEY_WORDS} BLOCK${dashes(5)}`, body), probes: wrap(body, 64) },
  { name: "SSH2's four dashes", path: "k.txt", content: armour(`${dashes(4)} BEGIN SSH2 ENCRYPTED ${KEY_WORDS} ${dashes(4)}`,
    `${dashes(4)} END SSH2 ENCRYPTED ${KEY_WORDS} ${dashes(4)}`, body), probes: wrap(body, 64) },
  { name: "a digit in the label", path: "k.txt", content: armour(`${dashes(5)}BEGIN ED25519 ${KEY_WORDS}${dashes(5)}`,
    `${dashes(5)}END ED25519 ${KEY_WORDS}${dashes(5)}`, body), probes: wrap(body, 64) },
  { name: "a hyphen in the label", path: "k.txt", content: armour(`${dashes(5)}BEGIN RSA-PSS ${KEY_WORDS}${dashes(5)}`,
    `${dashes(5)}END RSA-PSS ${KEY_WORDS}${dashes(5)}`, body), probes: wrap(body, 64) },
  { name: "a .ppk by name", path: "k.ppk", content: `PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\nPrivate-Lines: 1\n${wrap(body, 64)[0]}\n`,
    probes: [wrap(body, 64)[0]!] },
];

/** Commits `content` at `path` beside a change in app.py, and says where its lines show. */
async function shows(path: string, content: string, probes: string[], snap = "snap") {
  const repo = gitRepo(join(tmp(), snap + "-repo"));
  setUp(repo);
  editApp(repo);
  writeFileSync(join(repo, path), content);
  commit(repo, "key");
  return whereKeyShows(repo, join(tmp(), snap), path, probes);
}

for (const r of rows) {
  test(`${r.name} is a private key: not in the diff, the snapshot or the wire`, async () => {
    const where = await shows(r.path, r.content, r.probes);
    expect(where.diff === "REFUSED" || where.diff === "-").toBe(true);
    expect(where.snapshot).toBe("-");
    expect(where.wire === "n/a" || where.wire === "-").toBe(true);
  }, 60000);
}

test("each armour is named a private key by the scan, and a .ppk by its name", () => {
  for (const r of rows.filter((x) => x.path !== "k.ppk")) {
    expect(secretHits(r.content)[0]?.label).toBe("a private key");
  }
  expect(isSecretPath("deploy/key.ppk")).toBe(true);
});

test("a key made by node, in PKCS8, and one by ssh-keygen, stay out of the diff, the snapshot and the wire", async () => {
  const pem = generateKeyPairSync("ed25519").privateKey.export({ type: "pkcs8", format: "pem" }) as string;
  const lines = pem.split("\n").filter((l) => l && !l.startsWith("-"));
  const where = await shows("k.txt", pem, lines);
  expect(where.diff === "REFUSED" || where.diff === "-").toBe(true);
  expect(where.snapshot).toBe("-");
  expect(where.wire === "n/a" || where.wire === "-").toBe(true);
  const dir = mkdtempSync(join(tmp(), "ssh-"));
  const made = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "", "-f", join(dir, "id")]);
  if (made.error || made.status !== 0) return; // no ssh-keygen here: the first half stands
  const open = readFileSync(join(dir, "id"), "utf8");
  const openLines = open.split("\n").filter((l) => l && !l.startsWith("-"));
  const second = await shows("k.txt", open, openLines, "snap2");
  expect(second.diff === "REFUSED" || second.diff === "-").toBe(true);
  expect(second.snapshot).toBe("-");
});

for (const n of [4, 5]) {
  test(`a password in an address starting with ${n} dashes is still a password`, () => {
    const password = `${"-".repeat(n)}abcd1234efgh`;
    expect(suspects("a.py", `url = "scheme://user:${password}@db.acme.io/x"\n`, [])).toContain(password);
  });
}
