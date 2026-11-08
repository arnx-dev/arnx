// The diff arnx reads is git's plain text form: a textconv driver, an external diff tool and a submodule shown as a
// diff each print what the repository does not hold as text, and a key printed there would reach a model.
import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveChange } from "../src/change";
import { armour, editApp, KEY_WORDS, leak, randomBody, setUp, whereKeyShows, wrap } from "./helpers/keyrows";
import { commit, gitRepo, runGit } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const script = (dir: string, name: string, out: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ncat <<'X'\n${out}X\n`, { mode: 0o755 });
  return path;
};

/** Each row sets the repository's configuration so that git itself would print `probes`, then commits a change. */
const rows: { name: string; text: (b: string) => string; arrange: (repo: string, dir: string, printed: string) => void }[] = [
  { name: "a textconv driver that decrypts a file into an armoured block",
    text: (b) => armour("-----BEGIN PGP " + KEY_WORDS + " BLOCK-----", "-----END PGP " + KEY_WORDS + " BLOCK-----", b),
    arrange: (repo, dir, printed) => {
      writeFileSync(join(repo, ".gitattributes"), "*.sec diff=dec\n");
      runGit(repo, "config", "diff.dec.textconv", script(dir, "dec.sh", printed));
      commit(repo, "driver");
      writeFileSync(join(repo, "v.sec"), "ciphertext\n");
      editApp(repo);
    } },
  { name: "a textconv driver that prints bare lines",
    text: (b) => wrap(b, 64).join("\n") + "\n",
    arrange: (repo, dir, printed) => {
      writeFileSync(join(repo, ".gitattributes"), "*.sec diff=dec\n");
      runGit(repo, "config", "diff.dec.textconv", script(dir, "dec.sh", printed));
      commit(repo, "driver");
      writeFileSync(join(repo, "v.sec"), "ciphertext\n");
      editApp(repo);
    } },
  { name: "diff.external prints the lines",
    text: (b) => wrap(b, 64).join("\n") + "\n",
    arrange: (repo, dir, printed) => {
      runGit(repo, "config", "diff.external", script(dir, "ext.sh", printed));
      editApp(repo);
    } },
  { name: "diff.submodule=diff shows a file inside the submodule",
    text: (b) => wrap(b, 64).join("\n") + "\n",
    arrange: (repo, dir, printed) => {
      const sub = mkdtempSync(join(dir, "sub-"));
      runGit(sub, "init", "-q", "-b", "main");
      runGit(sub, "config", "user.email", "dev@example.com");
      runGit(sub, "config", "user.name", "Dev");
      runGit(sub, "config", "commit.gpgsign", "false");
      writeFileSync(join(sub, "x.txt"), "x\n");
      commit(sub, "x");
      const allow = ["-c", "protocol.file.allow=always"];
      spawnSync("git", ["-C", repo, ...allow, "submodule", "--quiet", "add", sub, "sm"]);
      commit(repo, "sm");
      writeFileSync(join(sub, "k.txt"), printed);
      commit(sub, "k");
      spawnSync("git", ["-C", join(repo, "sm"), ...allow, "pull", "--quiet", "origin", "main"]);
      runGit(repo, "config", "diff.submodule", "diff");
      editApp(repo);
      runGit(repo, "add", "sm", "app.py");
    } },
];

for (const r of rows) {
  test(`${r.name}: no key text in the diff, the snapshot or the wire`, async () => {
    const body = randomBody();
    const probes = wrap(body, 64);
    const repo = gitRepo(tmp());
    setUp(repo);
    r.arrange(repo, tmp(), r.text(body));
    commit(repo, "change");
    const where = await whereKeyShows(repo, join(tmp(), "snap"), "app.py", probes);
    expect(where.diff === "REFUSED" || where.diff === "-").toBe(true);
    expect(where.wire === "n/a" || where.wire === "-").toBe(true);
    expect(where.snapshot).toBe("-");
  }, 60000);
}

test("the diff of an uncommitted change is the plain form too", () => {
  const repo = gitRepo(tmp());
  const probes = wrap(randomBody(), 64);
  runGit(repo, "config", "diff.external", script(tmp(), "ext.sh", probes.join("\n") + "\n"));
  editApp(repo);
  expect(leak(resolveChange(repo, null, []).diff, probes)).toBe("-");
});
