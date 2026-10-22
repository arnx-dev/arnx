import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveChange, snapshot } from "../src/change";
import { ArnxError } from "../src/errors";
import { DEFAULT_IGNORE, loadIgnore, matcher, proposeIgnore } from "../src/ignore";
import { isSecretPath } from "../src/secrets";
import { Cli } from "./helpers/cli";
import { commit, gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

test("test_patterns", () => {
  const ignored = matcher("# data dumps\n*.csv\n/users_*.json\ndata/\nlegacy/old.py\n\n");
  expect(ignored("report.csv") && ignored("deep/dir/report.csv")).toBe(true);
  expect(ignored("users_0313.json") && !ignored("app/users_0313.json")).toBe(true);
  expect(ignored("data/x.py") && ignored("app/data/x.py")).toBe(true);
  expect(ignored("legacy/old.py") && !ignored("app/legacy/old.py")).toBe(true);
  expect(!ignored("app/main.py") && !ignored("database/x.py")).toBe(true);
});

test("test_star_does_not_cross_directories_when_anchored", () => {
  const ignored = matcher("/*.json\n");
  expect(ignored("a.json") && !ignored("pkg/a.json")).toBe(true);
});

test("test_no_file_ignores_nothing", () => {
  expect(loadIgnore(tmp())("anything.csv")).toBe(false);
});

test("test_session_files_are_secrets", () => {
  expect(isSecretPath("session.session") && isSecretPath("bot/anon.session-journal")).toBe(true);
});

test("test_snapshot_and_diff_respect_arnxignore", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, "users.csv"), "id,name\n1,Alice\n");
  mkdirSync(join(repo, "data"));
  writeFileSync(join(repo, "data", "dump.json"), "{}");
  commit(repo, "data");
  writeFileSync(join(repo, ".arnxignore"), "*.csv\ndata/\n");
  writeFileSync(join(repo, "users.csv"), "id,name\n1,Alice\n2,Bob\n");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return b + a\n");
  const change = resolveChange(repo);
  expect(change.files).not.toContain("users.csv");
  expect(change.diff).not.toContain("Bob");
  expect(change.files).toContain("app.py");
  const dest = join(tmp(), "snap");
  snapshot(repo, null, dest);
  expect(existsSync(join(dest, "app.py")) && !existsSync(join(dest, "users.csv")) && !existsSync(join(dest, "data")))
    .toBe(true);
  const headDest = join(tmp(), "head");
  snapshot(repo, "HEAD", headDest);
  expect(!existsSync(join(headDest, "users.csv")) && !existsSync(join(headDest, "data"))).toBe(true);
});

test("test_change_entirely_ignored_is_empty", () => {
  const repo = gitRepo(tmp());
  writeFileSync(join(repo, ".arnxignore"), "*.csv\n");
  commit(repo, "ignore file");
  writeFileSync(join(repo, "users.csv"), "x\n");
  expect(() => resolveChange(repo)).toThrow(ArnxError);
  expect(() => resolveChange(repo)).toThrow(/empty/);
});

function dataRepo(name = "a"): string {
  mkdirSync(join(tmp(), name));
  const repo = gitRepo(join(tmp(), name));
  const files: Record<string, string> = { "users.csv": "id\n", "big.json": "x".repeat(150_000), "small.json": "{}",
    "db_backup.sql": "--", "data.sqlite3": "", "notes_dump.txt": "x", "app/export.py": "X = 1\n",
    "src/export.ts": "export {};\n" };
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(repo, p, ".."), { recursive: true });
    writeFileSync(join(repo, p), body);
  }
  commit(repo, "data");
  return repo;
}

test("proposeIgnore lists data-like tracked files", () => {
  const p = proposeIgnore(dataRepo());
  expect(p.files).toEqual(["big.json", "data.sqlite3", "db_backup.sql", "notes_dump.txt", "users.csv"]);
  expect(p.text).toContain("\n/users.csv\n");
  expect(matcher(p.text)("users.csv") && !matcher(p.text)("app/export.py")).toBe(true);
});

test("init always writes .arnxignore: data, dumps and images by pattern, fixtures kept, other data-like files by name; " +
  "never overwrites", async () => {
  const repo = dataRepo();
  writeFileSync(join(repo, "orders.csv"), "id\n"); // untracked: covered by its pattern, never named
  const cli = new Cli({ cwd: repo });
  expect(await cli.run("init")).toBe(0);
  expect(cli.stdout).toContain("  .arnxignore        created\n");
  const text = readFileSync(join(repo, ".arnxignore"), "utf8");
  expect(text.startsWith(DEFAULT_IGNORE)).toBe(true);
  expect(text.slice(DEFAULT_IGNORE.length)).toBe("# Other data-like files here:\n/big.json\n/db_backup.sql\n" +
    "/notes_dump.txt\n");
  const ignored = loadIgnore(repo);
  for (const rel of ["users.csv", "orders.csv", "data.sqlite3", "docs/logo.png", "big.json"]) expect(ignored(rel)).toBe(true);
  for (const rel of ["tests/fixtures/users.csv", "app/tests/logo.png", "testdata/a.db", "src/export.ts", "small.json"]) {
    expect(ignored(rel)).toBe(false);
  }
  const other = dataRepo("b");
  writeFileSync(join(other, ".arnxignore"), "keep-me\n");
  const kept = new Cli({ cwd: other });
  expect(await kept.run("init")).toBe(0);
  expect(readFileSync(join(other, ".arnxignore"), "utf8")).toBe("keep-me\n");
  expect(kept.stdout).toContain("  .arnxignore        kept\n");
  // A repository with nothing data-like gets the patterns too.
  mkdirSync(join(tmp(), "none"));
  const plain = gitRepo(join(tmp(), "none"));
  expect(await new Cli({ cwd: plain }).run("init")).toBe(0);
  expect(readFileSync(join(plain, ".arnxignore"), "utf8")).toBe(DEFAULT_IGNORE);
});

test("a ! line keeps what it matches again; the last matching line decides", () => {
  const m = matcher("*.csv\n!tests/\ntests/secret.csv\n");
  expect([m("a.csv"), m("tests/a.csv"), m("tests/secret.csv"), m("x/tests/b.csv"), m("a.py")])
    .toEqual([true, false, true, false, false]);
});
