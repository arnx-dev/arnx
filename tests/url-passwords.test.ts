// A password written into a connection address is a secret like a key: the snapshot gives it a stand-in, a diff showing
// it stops the review, logs leave it out. Addresses that hold no real password stay as they are, or tests would stop
// working. Addresses here are built from parts.
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveChange, takeSnapshot } from "../src/change";
import { hasSecretContent, secretHits, secretPins, standIn, suspects } from "../src/secrets";
import { commit, gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const PASSWORD = "kT9" + "vQ2xLm7Rz4WpY";
const HOST = "cluster0.ab1cd." + "mongodb.net";
const at = (user: string, password: string, host: string, scheme = "mongodb+srv") => `${scheme}://${user}:${password}@${host}`;
const REAL = at("app", PASSWORD, HOST);

const put = (repo: string, path: string, text: string) => {
  mkdirSync(dirname(join(repo, path)), { recursive: true });
  writeFileSync(join(repo, path), text);
};
const allText = (dir: string) => readdirSync(dir, { recursive: true }).map((p) => join(dir, String(p)))
  .filter((p) => statSync(p).isFile()).map((p) => readFileSync(p, "utf8")).join("\n");

test("a password in an address on a real host gets a stand-in, and the host stays: a test may compare it", () => {
  const r = standIn(`uri = "${REAL}/?retryWrites=true"\nclient = connect(uri)\n`, [], "scripts/job.py")!;
  expect(r.text).not.toContain(PASSWORD);
  expect(r.text).toContain(`@${HOST}/?retryWrites=true`);
  // The shape holds: the file still parses, the line keeps its length.
  expect(r.text).toContain('uri = "mongodb+srv://app:');
  expect(r.text.split("\n")[0]!.length).toBe(`uri = "${REAL}/?retryWrites=true"`.length);
  expect(r.text.split("\n")[1]).toBe("client = connect(uri)");
});

test("a redaction test still holds: the address it expects keeps its host", () => {
  const given = at("app", "s3cr3t", HOST);
  const wanted = at("app", "***", HOST);
  const r = standIn(`assert redact("${given}") == "${wanted}"\n`, [], "tests/test_redact.py")!;
  expect(r.text).not.toContain("s3cr3t");
  expect(r.text).toContain(wanted);
  expect(r.text.match(new RegExp(`@${HOST.replaceAll(".", "\\.")}`, "g"))!.length).toBe(2);
});

test("the same password standing alone elsewhere goes too", () => {
  const r = standIn(`a = "${REAL}"\nb = ["${PASSWORD}"]\n`, [], "job.py")!;
  expect(r.text).not.toContain(PASSWORD);
});

test("a password that reads like a word changes only in the address: the same word in code is a name", () => {
  const word = "Summer2024";
  const r = standIn(`a = "${at("admin", word, HOST)}"\ndef ${word}(): pass\n`, [], "job.py")!;
  expect(r.text.split("\n")[0]).not.toContain(word);
  expect(r.text.split("\n")[1]).toBe(`def ${word}(): pass`);
});

test("a password of dashed words keeps none of them", () => {
  const words = "correct-horse-battery-staple";
  const r = standIn(`a = "${at("admin", words, HOST)}"\n`, [], "job.py")!;
  for (const w of words.split("-")) expect(r.text).not.toContain(w);
});

test("a random password on a service's one-word host is a secret too", () => {
  expect(hasSecretContent(at("app", PASSWORD, "redis", "redis"))).toBe(true);
  expect(standIn(`u = "${at("app", PASSWORD, "redis", "redis")}"\n`, [], "a.py")!.text).not.toContain(PASSWORD);
});

test("what holds no real password stays as it is", () => {
  const stay = [
    at("postgres", "postgres", "localhost:5432/db", "postgres"),
    at("test", "test", "mongo:27017", "mongodb"),
    at("app", "Summer2024", "db:5432/app", "postgres"),
    at("app", "s3cret1", "127.0.0.1", "postgres"),
    at("app", "Summer2024", "db.example.net", "postgres"),
    at("app", "Summer2024", "db.invalid", "postgres"),
    at("user", "password", HOST),
    at("user", "pass", HOST),
    at("u", "p", HOST),
    at("u", "p", "{host}"),
    at("ab", "abc", HOST),
    at("app", "changeme", HOST),
    at("app", "<password>", HOST),
    at("app", "{self.db_password}", "{self.db_url}"),
    at("app", "${DB_PASSWORD}", HOST),
    at("app", "$DB_PASSWORD", HOST),
    at("app", "{{ password }}", HOST),
    at("app", "%s", "%s"),
    at("app", "%(password)s", HOST),
    at("app", "***", HOST),
    at("app", "xxxxxxxx", HOST),
    "https://example.org:8080/a@b",
    "ssh://git@github.com/org/repo.git",
    "contact: someone@example.org",
  ];
  for (const text of stay) {
    expect([text, hasSecretContent(text), suspects("a.py", `u = "${text}"\n`, [])]).toEqual([text, false, []]);
  }
});

test("a template password with a real user and host is not the secret, but a real one with a template host is", () => {
  expect(hasSecretContent(at("app", "{password}", HOST))).toBe(false);
  expect(standIn(`u = f"${at("app", PASSWORD, "{host}")}"\n`, [], "a.py")!.text).not.toContain(PASSWORD);
});

test("the snapshot keeps the file, and none of the password", () => {
  const repo = gitRepo(tmp());
  put(repo, "scripts/job.py", `uri = "${REAL}"\n`);
  commit(repo, "job");
  const snap = join(tmp(), "snap");
  const r = takeSnapshot(repo, null, snap);
  expect(existsSync(join(snap, "scripts/job.py"))).toBe(true);
  expect(r.standIns).toEqual(["scripts/job.py"]);
  expect(allText(snap)).not.toContain(PASSWORD);
});

test("a change that shows the password stops the review, naming the kind and never the value", () => {
  const repo = gitRepo(tmp());
  put(repo, "app.py", "X = 1\n");
  commit(repo, "app");
  put(repo, "app.py", `X = 1\nuri = "${REAL}"\n`);
  commit(repo, "address");
  let said = "";
  try {
    resolveChange(repo, null, []);
  } catch (e) {
    said = (e as Error).message;
  }
  expect(said).toContain("app.py");
  expect(said).toContain("a password in an address");
  expect(said).not.toContain(PASSWORD);
});

test("hits name the line and the kind, and a pinned address stays", () => {
  const text = `# first\nuri = "${REAL}"\n`;
  expect(secretHits(text)).toEqual([{ line: 2, label: "a password in an address" }]);
  expect(standIn(text, secretPins(text), "a.py")!.text).toBe(text);
});
