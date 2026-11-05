import { expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { bakedKey } from "../src/baked";
import { BIG_KEYS_MOST, snapshotDigest, takeSnapshot } from "../src/change";
import { parseReviewConfig } from "../src/config";
import { buildContextOf, envKey } from "../src/sandbox";
import { isCertainRule, suspects } from "../src/secrets";
import { standIn } from "./helpers/standin";
import { defaultSettings, writeSettings } from "../src/settings";
import { AWS_KEY } from "./helpers/fakekeys";
import { commit, gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

// A value given a stand-in is replaced in every file of the tree, so a wrong pick rewrites the project's own code.
const picked = (line: string, path = "a.ts") => suspects(path, line, []);

test("an expression bound to a secret-looking name is code, not a value", () => {
  for (const line of [
    `<li :key="row[rowKeyField]">`,
    `<li :key="item[props.itemValue]">`,
    `<li :key="choice[itemValue]">`,
    `<li :key="group.date.toString()">`,
    `<li :key="idFor(candidate)">`,
    `<li :key="String(item.value)">`,
    `<li :key="item[keyFieldPath!]">`,
    `<Doc :password="pdfPassword()" />`,
    `<Doc :token="tokens[currentUser]" />`,
  ]) expect(picked(line, "a.vue")).toEqual([]);
});

test("a package spec under a name ending in a secret word is not a key", () => {
  for (const line of [
    `"some-auth": "npm:some-auth@^4.24.15",`,
    `"some-auth": "npm:some-auth@~4.24.15",`,
    `"some-auth": "npm:some-auth@>=4.24.15",`,
  ]) expect(picked(line, "package.json")).toEqual([]);
});

test("text with a key's name but a shape no key has stays", () => {
  expect(picked(`auth_key: "127.0.0.1|/get-session"`)).toEqual([]);
  expect(picked(`cache_key = "text/plain+frozenset:[NaN]"`)).toEqual([]);
  expect(picked(`password: "[Function]"`)).toEqual([]);
});

test("the code around such a name is left as it is", () => {
  const code = `<li :key="row[rowKeyField]">\nconst x = row[rowKeyField];\n`;
  expect(standIn(code, [], "a.vue")).toEqual({ text: code, count: 0 });
});

test("real values beside the same names still get stand-ins", () => {
  const weak = "Q7vX2mK9pL4zR8tB1nW6yC3f";
  expect(picked(`auth_key: "${weak}"`)).toEqual([weak]);
  const b64 = "EG47ZWjYjr+Y97abXk2Lm9Qz/w8TnVc1hR5dPqU3sJ0=";
  expect(picked(`private_key = "${b64}"`)).toEqual([b64]);
  // A password may hold any character; only a whole expression reads as code.
  for (const pw of ["x)yMQt7ZNK3k", "Pa(ss)w0rd!", "N3verSt0red!", "a[1]b2C3d4"]) {
    expect(picked(`password: "${pw}"`)).toEqual([pw]);
  }
});

test("a cookie's own separators do not hide it", () => {
  const cookie = "sid=Q7vX2mK9pL4zR8tB&t=1n6yC3f;Secure";
  expect(picked(`cookie: "${cookie}"`)).toEqual([cookie]);
});

test("the expression check is linear in the value's length", () => {
  for (const tail of ["!", ")", "]"]) {
    const value = `f()Aa1${"a".repeat(4000)}${tail}`;
    const t = performance.now();
    picked(`token: "${value}"`);
    expect(performance.now() - t).toBeLessThan(200);
  }
});

// --- who sees what: a guess stays real where tests run, and never sits next to network access ------------------------

const GUESS = "Zq7xK2mP9vR4tY1w";
const OTHER_GUESS = "Hb3nW8sL5cT2jF6g";
const ADDRESS_PASSWORD = "Xy9kLm2Pq7Rz";
/** Built at run time: no file of arnx holds a password in an address. */
const AT = "@";
const ADDRESS = `postgres://app:${ADDRESS_PASSWORD}${AT}db.corp.internal/main`;

let repos = 0;
function repoWith(files: Record<string, string>): string {
  const dir = join(tmp(), `repo-${++repos}`);
  mkdirSync(dir);
  const repo = gitRepo(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  }
  commit(repo, "files");
  return repo;
}
/** A snapshot of the working tree of a repository holding `files`: the run's folder and the build's. */
function snapped(files: Record<string, string>) {
  const snap = join(tmp(), "snap");
  const r = takeSnapshot(repoWith(files), null, snap, []);
  const run = (rel: string) => readFileSync(join(snap, rel), "utf8");
  const build = (rel: string) => readFileSync(join(buildContextOf(snap), rel), "utf8");
  return { snap, r, run, build };
}

test("a guessed value stays real in the run snapshot", () => {
  const { r, run } = snapped({ "settings.py": `db_password = "${GUESS}"\n`, "app.py": `print("${GUESS}")\n` });
  expect(run("settings.py")).toContain(GUESS);
  expect(run("app.py")).toContain(GUESS);
  expect(r.standIns).toEqual([]);
  expect(r.secrets.has(GUESS)).toBe(false);
  // The filter still has it.
  expect(r.suspects.has(GUESS)).toBe(true);
});

test("a guessed value is a stand-in in the build context", () => {
  const { snap, r, build } = snapped({ "settings.py": `db_password = "${GUESS}"\n`, "app.py": `print("${GUESS}")\n`,
    "plain.py": "x = 1\n" });
  expect(buildContextOf(snap)).not.toBe(snap);
  expect(build("settings.py")).not.toContain(GUESS);
  expect(build("app.py")).not.toContain(GUESS);
  expect(build("settings.py")).toMatch(/^db_password = "[A-Za-z0-9]{16}"\n$/);
  expect(build("plain.py")).toBe("x = 1\n");
  expect(r.guesses.has(GUESS)).toBe(true);
});

test("a key-shaped value and an address password are stand-ins in both", () => {
  const { r, run, build } = snapped({ "a.py": `k = "${AWS_KEY}"\nurl = "${ADDRESS}"\n` });
  for (const text of [run("a.py"), build("a.py")]) {
    expect(text).not.toContain(AWS_KEY);
    expect(text).not.toContain(ADDRESS_PASSWORD);
  }
  expect(run("a.py")).toBe(build("a.py"));
  expect(r.standIns).toEqual(["a.py"]);
  expect(r.secrets.has(AWS_KEY)).toBe(true);
});

test("a manifest keeps its value in both", () => {
  const manifest = `[tool.thing]\nauth_token = "${GUESS}"\n`;
  const { r, run, build } = snapped({ "pyproject.toml": manifest, "app.py": `print("${GUESS}")\n` });
  expect(run("pyproject.toml")).toBe(manifest);
  expect(build("pyproject.toml")).toBe(manifest);
  expect(r.suspects.has(GUESS)).toBe(true);
  // Only the manifest: a script an install runs reads the other files.
  expect(run("app.py")).toContain(GUESS);
  expect(build("app.py")).not.toContain(GUESS);
});

test("a lockfile keeps its value in both, and no other file does", () => {
  const lock = `auth_token = "${GUESS}"\n`;
  const { run, build } = snapped({ "composer.lock": lock, "settings.py": `db_password = "${GUESS}"\n`,
    "more.py": `db_password = "${OTHER_GUESS}"\n` });
  expect(run("composer.lock")).toBe(lock);
  expect(build("composer.lock")).toBe(lock);
  expect(build("settings.py")).not.toContain(GUESS);
  expect(build("more.py")).not.toContain(OTHER_GUESS);
});

const PROJECT_YAML = (extra = "") => `version: 1\nimage: python:3.12-slim\n${extra}test_command: python -m pytest -q {targets}\n`;
/** A snapshot with this review.yaml: the run's folder and the build's. */
function withConfig(yaml: string, files: Record<string, string>) {
  const repo = repoWith({ ...files, ".arnx/review.yaml": yaml });
  const snap = join(tmp(), `snap-${repos}`);
  takeSnapshot(repo, null, snap, []);
  return (rel: string) => readFileSync(join(buildContextOf(snap), rel), "utf8");
}

test("only the project's own manifests keep their value: an example's or another folder's get the stand-in", () => {
  const build = withConfig(PROJECT_YAML(), { "requirements.txt": `# auth_token = "${OTHER_GUESS}"\n`,
    "pyproject.toml": `[x]\nauth_token = "${GUESS}"\n`, "examples/demo/pyproject.toml": `[x]\nauth_token = "${GUESS}"\n`,
    "examples/demo/package.json": `{"auth_token": "${GUESS}"}\n`, "sub/pyproject.toml": `[x]\nauth_token = "${GUESS}"\n`,
    "package.json": `{"auth_token": "${GUESS}"}\n` });
  expect(build("pyproject.toml")).toContain(GUESS);
  for (const other of ["examples/demo/pyproject.toml", "examples/demo/package.json", "sub/pyproject.toml",
    // Another language's name, in a project this adapter installs.
    "package.json"]) {
    expect([other, build(other).includes(GUESS)]).toEqual([other, false]);
  }
});

test("a project installed from a folder keeps that folder's manifests", () => {
  const build = withConfig(PROJECT_YAML("workdir: app\n"), { "app/pyproject.toml": `[x]\nauth_token = "${GUESS}"\n`,
    "pyproject.toml": `[x]\nauth_token = "${GUESS}"\n`, "lib/pyproject.toml": `[x]\nauth_token = "${GUESS}"\n`,
    "app/a.py": `x = "${GUESS}"\n` });
  expect(build("app/pyproject.toml")).toContain(GUESS);
  expect(build("pyproject.toml")).not.toContain(GUESS);
  expect(build("lib/pyproject.toml")).not.toContain(GUESS);
  expect(build("app/a.py")).not.toContain(GUESS);
});

test("a language that installs nested manifests keeps them, build output and hidden folders aside", () => {
  const yaml = "version: 1\nimage: rust:1\nlanguage: rust\ntest_command: cargo nextest run {targets}\n";
  const cargo = `[package]\nauth_token = "${GUESS}"\n`;
  const build = withConfig(yaml, { "Cargo.toml": cargo, "crates/a/Cargo.toml": cargo, "target/pkg/Cargo.toml": cargo,
    ".hidden/Cargo.toml": cargo, "src/lib.rs": `const T: &str = "${GUESS}";\n` });
  expect(build("Cargo.toml")).toBe(cargo);
  expect(build("crates/a/Cargo.toml")).toBe(cargo);
  for (const other of ["target/pkg/Cargo.toml", ".hidden/Cargo.toml", "src/lib.rs"]) {
    expect([other, build(other).includes(GUESS)]).toEqual([other, false]);
  }
});

test("before review.yaml, manifests outside folders of examples and tests keep their value", () => {
  const { build } = snapped({ "pyproject.toml": `[x]\nauth_token = "${GUESS}"\n`, "app/package.json": `{"auth_token": "${GUESS}"}\n`,
    "examples/a/package.json": `{"auth_token": "${GUESS}"}\n`, "tests/data/pyproject.toml": `[x]\nauth_token = "${GUESS}"\n` });
  expect(build("pyproject.toml")).toContain(GUESS);
  expect(build("app/package.json")).toContain(GUESS);
  expect(build("examples/a/package.json")).not.toContain(GUESS);
  expect(build("tests/data/pyproject.toml")).not.toContain(GUESS);
});

test("a certain value in a manifest is a stand-in in both, as before", () => {
  const { run, build } = snapped({ "pyproject.toml": `[tool.thing]\nurl = "${ADDRESS}"\n` });
  expect(run("pyproject.toml")).not.toContain(ADDRESS_PASSWORD);
  expect(build("pyproject.toml")).toBe(run("pyproject.toml"));
});

test("a value certain in one file and guessed in another is a stand-in in both", () => {
  const { r, run, build } = snapped({ "a.py": `url = "${ADDRESS}"\n`, "b.py": `db_password = "${ADDRESS_PASSWORD}"\n` });
  for (const text of [run("b.py"), build("b.py")]) expect(text).not.toContain(ADDRESS_PASSWORD);
  expect(r.guesses.has(ADDRESS_PASSWORD)).toBe(false);
});

test("the build context holds the snapshot's tree: modes, links, the certain stand-ins; no sandbox-only files", () => {
  const repo = repoWith({ "settings.py": `db_password = "${GUESS}"\n`, "run.sh": "#!/bin/sh\n", "bin/tool": `t = "${AWS_KEY}"\n`,
    "x.data": "aside\n" });
  Bun.spawnSync(["chmod", "755", join(repo, "run.sh"), join(repo, "settings.py")]);
  symlinkSync("settings.py", join(repo, "link.py"));
  writeFileSync(join(repo, ".arnxignore"), "x.data\n");
  commit(repo, "link");
  const snap = join(tmp(), "snap");
  takeSnapshot(repo, null, snap, [], { sandbox: ["x.data"] });
  const ctx = buildContextOf(snap);
  expect(statSync(join(ctx, "run.sh")).mode & 0o111).not.toBe(0);
  // A file that holds the guess keeps its executable bit too.
  expect(statSync(join(ctx, "settings.py")).mode & 0o111).not.toBe(0);
  expect(lstatSync(join(ctx, "link.py")).isSymbolicLink()).toBe(true);
  expect(readFileSync(join(ctx, "link.py"), "utf8")).not.toContain(GUESS);
  expect(readFileSync(join(ctx, "bin/tool"), "utf8")).toBe(readFileSync(join(snap, "bin/tool"), "utf8"));
  expect(existsSync(join(ctx, "x.data"))).toBe(false);
  expect(existsSync(join(ctx, ".git"))).toBe(false);
});

test("what a run writes into the snapshot never gets into the build context", () => {
  const { snap, build } = snapped({ "settings.py": `db_password = "${GUESS}"\n`, "other.py": "x = 1\n" });
  writeFileSync(join(snap, "written.txt"), GUESS);
  rmFile(join(snap, "settings.py"));
  expect(existsSync(join(buildContextOf(snap), "written.txt"))).toBe(false);
  expect(build("settings.py")).not.toContain(GUESS);
});
const rmFile = (p: string) => Bun.spawnSync(["rm", "-f", p]);

test("a tree with no guess has no second copy: the snapshot is the build context", () => {
  const { snap } = snapped({ "a.py": `k = "${AWS_KEY}"\n` });
  expect(buildContextOf(snap)).toBe(snap);
});

test("a second snapshot to the same place leaves no build context of the first", () => {
  const dest = join(tmp(), "snap");
  takeSnapshot(repoWith({ "s.py": `db_password = "${GUESS}"\n` }), null, dest, []);
  expect(buildContextOf(dest)).not.toBe(dest);
  const again = repoWith({ "s.py": "x = 1\n" });
  Bun.spawnSync(["rm", "-rf", dest]);
  takeSnapshot(again, null, dest, []);
  expect(buildContextOf(dest)).toBe(dest);
});

test("with stand-ins off there are none in the build either", () => {
  const repo = repoWith({ "s.py": `db_password = "${GUESS}"\n` });
  writeSettings(repo, { ...defaultSettings(), standIns: false });
  const snap = join(tmp(), "snap");
  const r = takeSnapshot(repo, null, snap);
  expect(buildContextOf(snap)).toBe(snap);
  expect(r.suspects.has(GUESS)).toBe(true);
});

test("identical runs: the image key, the key of an image made from the code and the snapshot's digest do not move", () => {
  const cfg = parseReviewConfig(`
version: 1
image: python:3.12-slim
workdir: app
install: ["mkdir -p /opt/app && cp -a . /opt/app"]
test_command: cd /opt/app && python -m pytest -q {targets}
`);
  const repo = repoWith({ "app/requirements.txt": "pkg==1\n", "app/pyproject.toml": `[x]\nauth_token = "${OTHER_GUESS}"\n`,
    "app/settings.py": `db_password = "${GUESS}"\n`, "app/b.py": "b\n", "app/c.py": "c\n" });
  const take = () => {
    const snap = join(tmp(), `s${Math.random()}`);
    takeSnapshot(repo, null, snap, []);
    return snap;
  };
  const [one, two] = [take(), take()];
  expect(envKey(cfg, two)).toBe(envKey(cfg, one));
  const copies = [{ root: "/opt/app", scope: "app", files: ["settings.py"] }];
  expect(bakedKey("k", cfg, copies, two)).toBe(bakedKey("k", cfg, copies, one));
  expect(snapshotDigest(two)).toBe(snapshotDigest(one));
  expect(snapshotDigest(buildContextOf(two))).toBe(snapshotDigest(buildContextOf(one)));
  // It hashes what such an image holds, the build context: not what a run leaves in the snapshot.
  const first = bakedKey("k", cfg, copies, one);
  writeFileSync(join(one, "app/settings.py"), "a run wrote this\n");
  expect(bakedKey("k", cfg, copies, one)).toBe(first);
  // What the image holds is what its key hashes: another guess there is another image; none of it is the real value.
  const changed = repoWith({ "app/requirements.txt": "pkg==1\n", "app/pyproject.toml": `[x]\nauth_token = "${OTHER_GUESS}"\n`,
    "app/settings.py": `db_password = "Tr5wE1yU7iO3pA9s"\n`, "app/b.py": "b\n", "app/c.py": "c\n" });
  const three = join(tmp(), "three");
  takeSnapshot(changed, null, three, []);
  expect(envKey(cfg, three)).toBe(envKey(cfg, one));
  expect(bakedKey("k", cfg, copies, three)).not.toBe(bakedKey("k", cfg, copies, one));
});

test("a big file's guess is a stand-in in the build context too, and real in the run", () => {
  const padding = `"pad": "${"x ".repeat(600_000)}"\n`;
  const { run, build } = snapped({ "big.json": `{"db_password": "${GUESS}",\n${padding}}\n` });
  expect(run("big.json")).toContain(GUESS);
  expect(build("big.json")).not.toContain(GUESS);
});

test("a big file with too many guesses for its stand-ins stays out of the build, and in the run", () => {
  const many = Array.from({ length: BIG_KEYS_MOST + 1 }, (_, i) => `"db_password": "Zq7xK2mP9vR4tY${i}w",`).join("\n");
  const padding = `"pad": "${"x ".repeat(600_000)}"\n`;
  const { snap, r } = snapped({ "big.json": `{${many}\n${padding}}\n`, "small.py": `db_password = "${GUESS}"\n` });
  expect(existsSync(join(snap, "big.json"))).toBe(true);
  expect(existsSync(join(buildContextOf(snap), "big.json"))).toBe(false);
  expect(r.withheld).toEqual([]);
  expect(r.suspects.has("Zq7xK2mP9vR4tY7w")).toBe(true);
});

// --- a root .env: read for its values, never copied --------------------------------------------------------------------

test("a value from a root .env hard-coded into tracked code is masked and out of the build, real in the run", () => {
  const repo = repoWith({ "client.py": `HEADERS = {"x": "${GUESS}"}\n` });
  writeFileSync(join(repo, ".env"), `SERVICE_API_TOKEN=${GUESS}\nPLAIN=value\n`);
  writeFileSync(join(repo, ".env.local"), `DB_PASSWORD=${OTHER_GUESS}\n`);
  const snap = join(tmp(), "snap");
  const r = takeSnapshot(repo, null, snap, []);
  expect(r.suspects.has(GUESS)).toBe(true);
  expect(r.suspects.has(OTHER_GUESS)).toBe(true);
  expect(r.suspects.has("value")).toBe(false);
  expect(existsSync(join(snap, ".env"))).toBe(false);
  expect(readFileSync(join(snap, "client.py"), "utf8")).toContain(GUESS);
  expect(readFileSync(join(buildContextOf(snap), "client.py"), "utf8")).not.toContain(GUESS);
  expect(existsSync(join(buildContextOf(snap), ".env"))).toBe(false);
});

test("a value of a tracked secret file deeper down, hard-coded into code, is out of the build too", () => {
  const { snap, r, run, build } = snapped({ "config/.env": `SERVICE_API_TOKEN=${GUESS}\n`, "client.py": `x = "${GUESS}"\n` });
  expect(existsSync(join(snap, "config/.env"))).toBe(false);
  expect(r.suspects.has(GUESS)).toBe(true);
  expect(run("client.py")).toContain(GUESS);
  expect(build("client.py")).not.toContain(GUESS);
});

test("a root .env counts for a snapshot of a commit too; one deeper down or a link does not", () => {
  const repo = repoWith({ "client.py": "x = 1\n", "sub/keep.py": "y = 2\n" });
  writeFileSync(join(repo, ".env"), `SERVICE_API_TOKEN=${GUESS}\n`);
  writeFileSync(join(repo, "sub/.env"), `SERVICE_API_TOKEN=${OTHER_GUESS}\n`);
  const outside = join(tmp(), "outside.env");
  writeFileSync(outside, "SERVICE_API_TOKEN=Tr5wE1yU7iO3pA9s\n");
  symlinkSync(outside, join(repo, ".env.linked"));
  const r = takeSnapshot(repo, "HEAD", join(tmp(), "snap"), []);
  expect(r.suspects.has(GUESS)).toBe(true);
  expect(r.suspects.has(OTHER_GUESS)).toBe(false);
  expect(r.suspects.has("Tr5wE1yU7iO3pA9s")).toBe(false);
});

// --- what the filter is told to hide, none of which may change code that runs ----------------------------------------

const rule = (line: string, path = "a.ts") => {
  const why = new Map<string, string>();
  const found = suspects(path, line, [], why);
  return found.map((v) => [v, why.get(v)]);
};
const guessed = (value: string) => [[value, "named-strong"]];

test("every new shape is a guess, never certain", () => {
  for (const [line, path] of [[`export API_TOKEN=${GUESS}`, "deploy.sh"], [`ENV API_TOKEN=${GUESS}`, "Dockerfile"],
    [`API_TOKEN := ${GUESS}`, "Makefile"], [`curl -H "Authorization: Bearer ${GUESS}" x`, "README.md"],
    [`https://a.example/v1?api_key=${GUESS}`, "docs.md"], [`docker run -e API_TOKEN=${GUESS} img`, "run.md"]] as const) {
    for (const [, r] of rule(line, path)) expect(isCertainRule(r!)).toBe(false);
  }
});

test("export in a shell file, in any file, and a plain assignment in a shell file", () => {
  expect(rule(`export API_TOKEN=${GUESS}\n`, "deploy.sh")).toEqual(guessed(GUESS));
  expect(rule(`  export API_TOKEN=${GUESS} # for ci\n`, "ci.yml")).toEqual(guessed(GUESS));
  expect(rule(`API_TOKEN=${GUESS}\n`, "scripts/deploy.bash")).toEqual(guessed(GUESS));
  expect(rule(`API_TOKEN=${GUESS} ./run\n`, "deploy.sh")).toEqual(guessed(GUESS));
  // A plain assignment elsewhere is not a shell's.
  expect(rule(`API_TOKEN=${GUESS}\n`, "notes.md")).toEqual([]);
});

test("a shell's expansions and a name's own shape are not values", () => {
  for (const line of ["export API_TOKEN=$OTHER", "export API_TOKEN=$(cat /run/token)", "export API_TOKEN=${OTHER_TOKEN}",
    "export API_TOKEN=`cat x`", "export API_TOKEN=your-token-here", "export API_TOKEN=YOUR_TOKEN"]) {
    expect([line, rule(`${line}\n`, "deploy.sh")]).toEqual([line, []]);
  }
  expect(rule("export const token = makeToken();\nexport default token;\n", "a.ts")).toEqual([]);
});

test("ENV and ARG in a Dockerfile, in both forms", () => {
  expect(rule(`ENV API_TOKEN=${GUESS}\n`, "Dockerfile")).toEqual(guessed(GUESS));
  expect(rule(`ENV API_TOKEN ${GUESS}\n`, "docker/Dockerfile.prod")).toEqual(guessed(GUESS));
  expect(rule(`ENV MODE=test API_TOKEN=${GUESS}\n`, "app.dockerfile")).toEqual(guessed(GUESS));
  expect(rule(`ARG API_TOKEN=${GUESS}\n`, "Containerfile")).toEqual(guessed(GUESS));
  expect(rule("ENV API_TOKEN=$API_TOKEN\nARG API_TOKEN\n", "Dockerfile")).toEqual([]);
  expect(rule(`ENV API_TOKEN=${GUESS}\n`, "notes.md")).toEqual([]);
});

test("a Makefile's assignments", () => {
  for (const op of [":=", "=", "?=", "::="]) {
    expect(rule(`API_TOKEN ${op} ${GUESS}\n`, "Makefile")).toEqual(guessed(GUESS));
  }
  expect(rule(`export API_TOKEN := ${GUESS}\n`, "build/rules.mk")).toEqual(guessed(GUESS));
  expect(rule("API_TOKEN := $(shell cat token)\nAPI_TOKEN ?= $(OTHER)\n", "Makefile")).toEqual([]);
});

test("an Authorization header in text, its token only", () => {
  expect(rule(`curl -H "Authorization: Bearer ${GUESS}" https://a.example\n`, "README.md")).toEqual(guessed(GUESS));
  expect(rule(`-H 'Authorization: Basic ${GUESS}'\n`, "x.sh")).toEqual(guessed(GUESS));
  for (const line of ['f"Authorization: Bearer {apiToken}"', "`Authorization: Bearer ${apiToken}`",
    '"Authorization: Bearer <token>"', '"Authorization: Bearer YOUR_API_KEY"', '"Authorization: Bearer %s"']) {
    expect([line, rule(`${line}\n`, "a.py")]).toEqual([line, []]);
  }
});

test("a secret name in a URL's query", () => {
  expect(rule(`fetch("https://a.example/v1?api_key=${GUESS}&page=2")\n`, "a.ts")).toEqual(guessed(GUESS));
  expect(rule(`[x](https://a.example/?a=1&access_token=${GUESS})\n`, "a.md")).toEqual(guessed(GUESS));
  expect(rule(`<a href="https://a.example/?a=1&amp;access_token=${GUESS}">\n`, "a.html")).toEqual(guessed(GUESS));
  for (const line of ["`/v1?api_key=${apiKey}`", 'f"/v1?api_key={apiKey}"', '"/v1?token=" + token',
    "/v1?page_token=nextPage2", "/v1?sort_key=created&id=9"]) {
    expect([line, rule(`${line}\n`, "a.py")]).toEqual([line, []]);
  }
});

test("docker run's -e", () => {
  expect(rule(`docker run --rm -e API_TOKEN=${GUESS} img\n`, "README.md")).toEqual(guessed(GUESS));
  expect(rule(`docker run --env=API_TOKEN=${GUESS} img\n`, "ci.yml")).toEqual(guessed(GUESS));
  expect(rule("docker run -e API_TOKEN=$API_TOKEN -e MODE=test img\n", "x.sh")).toEqual([]);
});

test("a JWT with no dash under a secret name", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U".replace(/_/g, "x");
  expect(rule(`api_token = "${jwt}"\n`, "a.py")).toEqual(guessed(jwt));
  expect(rule(`signing_key = "${jwt}"\n`, "a.py")).toEqual([[jwt, "named-weak"]]);
  // A dotted name is still a name.
  expect(rule('api_token = "config.auth.token"\n', "a.py")).toEqual([]);
});

test("under a strong name, random letters and generated passwords the shape check once took for names", () => {
  for (const value of ["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", "rTxKpQmZvBnWcYdLgHsJfAeUoIiXyTqR", "xKqPzRtYbNmVcLw4",
    "bNmVcLwKqPzRtYx27"]) {
    expect([value, rule(`api_token = "${value}"\n`, "a.py")]).toEqual([value, guessed(value)]);
    // A weak name wants more.
    expect([value, rule(`sort_key = "${value}"\n`, "a.py")]).toEqual([value, []]);
  }
});

test("random letters are told from a long name by their capitals, not by how their letters happen to fall", () => {
  const letters = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let picked = 0;
  // A fixed sequence: the same 2000 values each run.
  let x = 12345;
  const next = () => (x = (x * 1103515245 + 12345) & 0x7fffffff);
  for (let i = 0; i < 2000; i++) {
    const v = Array.from({ length: 32 }, () => letters[(next() >>> 8) % 52]).join("");
    if (suspects("a.py", `api_token = "${v}"\n`, []).includes(v)) picked++;
  }
  expect(picked).toBeGreaterThan(1960);
  for (const v of ["getUserAccessTokenFromSessionCookie", "defaultAuthenticationProviderName", "hf_someLongDescriptiveNameOfThing"]) {
    expect([v, rule(`api_token = "${v}"\n`, "a.py")]).toEqual([v, []]);
  }
});

test("a word and a year under a strong name is a guess the tree can overrule", () => {
  expect(rule('db_password = "Summer2024"\n', "a.py")).toEqual([["Summer2024", "named-word"]]);
  expect(rule('sort_key = "Summer2024"\n', "a.py")).toEqual([]);
  // Named in this file's code: a name, not a password.
  expect(rule('db_password = "Summer2024"\nclass Summer2024:\n    pass\n', "a.py")).toEqual([]);
  // In a comment or a string it is still one.
  expect(rule('db_password = "Summer2024"\n# Summer2024 is it\nx = "Summer2024"\n', "a.py"))
    .toEqual([["Summer2024", "named-word"]]);
  // A word that says what it stands for is a placeholder.
  for (const v of ["Password123", "Secret2024", "Example2024", "Token2024", "Changeme123", "Test1234"]) {
    expect([v, rule(`db_password = "${v}"\n`, "a.py")]).toEqual([v, []]);
  }
});

test("a word and a year used as a name in another file's code is not masked", () => {
  const repo = repoWith({ "s.py": 'db_password = "Summer2024"\nother_password = "Winter2024"\n',
    "models.py": "class Summer2024:\n    pass\n", "notes.md": "Winter2024 is the password\n" });
  const snap = join(tmp(), "snap");
  const r = takeSnapshot(repo, null, snap, []);
  expect(r.suspects.has("Summer2024")).toBe(false);
  expect(r.guesses.has("Summer2024")).toBe(false);
  expect(readFileSync(join(buildContextOf(snap), "s.py"), "utf8")).toContain("Summer2024");
  expect(r.suspects.has("Winter2024")).toBe(true);
  expect(readFileSync(join(buildContextOf(snap), "s.py"), "utf8")).not.toContain("Winter2024");
});

test("what ends in dots is a doc's shortened example", () => {
  expect(rule('client_secret = "abc123def..."\n', "a.py")).toEqual([]);
  expect(rule('client_secret = "abc123def…"\n', "a.py")).toEqual([]);
});

test("ordinary names under strong names stay out", () => {
  for (const v of ["accessToken", "AccessToken", "OnePassword", "useAuthStore", "password123",
    "my_secret_value", "XMLHttpRequest", "getUserToken", "clientSecretValue", "refresh-token-name",
    "Bearer", "PublicKey", "userPassword1", "sessionTokenCookieName"]) {
    expect([v, rule(`token = "${v}"\n`, "a.py")]).toEqual([v, []]);
  }
});

// --- a password that reads as a bare name, in a comment ----------------------------------------------------------------

test("a password that reads as a bare name in a comment is a guess; in code it stays certain", () => {
  const comment = `/**\n * f"db://sample:access_token${AT}sample.com"\n */\nconst x = 1;\n`;
  expect(rule(comment)).toEqual([["access_token@", "named-address"]]);
  const hunter = "hunter22";
  expect(rule(`const url = "mysql://root:${hunter}${AT}db.corp.internal/x";\n`))
    .toEqual([[`${hunter}@`, "address-password"]]);
});

test("a random password in a comment stays certain, and code beside the comment wins", () => {
  expect(rule(`// postgres://app:${ADDRESS_PASSWORD}${AT}db.corp.internal/x\n`).map(([, r]) => r))
    .toEqual(["address-password", "address-password"]);
  const both = `// db://u:access_token${AT}db.corp.internal\nconst u = "db://u:access_token${AT}db.corp.internal";\n`;
  expect(rule(both)).toEqual([["access_token@", "address-password"]]);
});

test("a file whose comments no reader knows keeps the address certain", () => {
  expect(rule(`# db://sample:access_token${AT}sample.com\n`, "notes.txt")).toEqual([["access_token@", "address-password"]]);
});

test("a sed in install whose search text no file holds is named as stale", async () => {
  const { staleRewrites } = await import("../src/standins");
  const install = ["grep -rl 'oldhost.example' . | xargs sed -i 's/oldhost.example/newhost.example/g'",
    "pip install pytest"];
  expect(staleRewrites(install, () => false)).toEqual(["oldhost.example"]);
});

test("one whose text exists is left alone", async () => {
  const { staleRewrites } = await import("../src/standins");
  const install = ["sed -i 's|oldhost.example|newhost.example|' cfg.txt", "sed -i 's/a.*b/c/' x"];
  expect(staleRewrites(install, (t) => t === "oldhost.example")).toEqual([]);
});

test("the approval checks name a stale sed with the command that fixes it", async () => {
  const { approvalChecks } = await import("../src/setupview");
  const { parseReviewFile } = await import("../src/config");
  const file = parseReviewFile("version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
    "    install: [\"sed -i 's/oldhost.example/new/' cfg.txt\"]\n    test_command: python -m pytest -q {targets}\n");
  expect(approvalChecks(file, [], () => false).join("\n")).toContain("arnx setup --project shop");
  expect(approvalChecks(file, [], () => true).join("\n")).not.toContain("setup --project");
});

test("a stand-in inside a longer word is not named", async () => {
  const { namesStandIn } = await import("../src/standins");
  expect(namesStandIn("env: {A: xtokenAbCdEf12y}", ["tokenAbCdEf12"])).toBe(false);
  expect(namesStandIn("env: {A: tokenAbCdEf12}", ["tokenAbCdEf12"])).toBe(true);
  expect(namesStandIn("x tokenAbCdEf12y tokenAbCdEf12", ["tokenAbCdEf12"])).toBe(true);
});

test("the approval warnings of a real repository name a stale sed from the build context", async () => {
  const { withRepoHolds } = await import("../src/standins");
  const { approvalWarnings } = await import("../src/setupview");
  const { parseReviewFile } = await import("../src/config");
  const { initRepo, commit: commitIn } = await import("./helpers/gitutil");
  const { useTmp: _u } = await import("./helpers/tmp");
  void _u;
  const { mkdtempSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const repo = initRepo(join(mkdtempSync(join(tmpdir(), "arnx-t-")), "r"));
  write(join(repo, "cfg.txt"), "host=livehost.example\n");
  commitIn(repo, "c");
  const yaml = (s: string) => parseReviewFile("version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n" +
    `    image: python:3.12\n    install: ["sed -i 's/${s}/new/' cfg.txt"]\n    test_command: pytest {targets}\n`);
  const warn = (s: string) => { const f = yaml(s); return withRepoHolds(repo, f, undefined, (h) => approvalWarnings(f, [], h)); };
  expect(warn("gonehost.example").join("\n")).toContain("arnx setup --project shop");
  expect(warn("livehost.example").join("\n")).not.toContain("setup --project");
});

test("an address password's stand-in is named though the host follows it; a longer word or a + before it is not", async () => {
  const { namesStandIn } = await import("../src/standins");
  const { fakeAll, suspects } = await import("../src/secrets");
  const url = "postgres://user:" + "qT7vN2xK9mRw4Zs8" + "@db.example/x";
  const values = suspects("a.py", `URL = '${url}'`, []);
  const made = fakeAll(url, values).text;
  const standIn = made.slice(made.indexOf(":", 11) + 1, made.indexOf("@") + 1);
  expect(standIn.endsWith("@")).toBe(true);
  expect(standIn).not.toContain("qT7vN2");
  expect(namesStandIn(`DB: ${made}`, [standIn])).toBe(true);
  expect(namesStandIn(`DB: x${standIn}host`, [standIn])).toBe(false);
  expect(namesStandIn(`DB: +${standIn}host`, [standIn])).toBe(false);
});

test("a snapshot that fails gives no stale warning and does not throw", async () => {
  const { withRepoHolds } = await import("../src/standins");
  const { approvalWarnings } = await import("../src/setupview");
  const { parseReviewFile } = await import("../src/config");
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const notRepo = mkdtempSync(join(tmpdir(), "arnx-nr-"));
  const f = parseReviewFile("version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
    "    install: [\"sed -i 's/gone.example/new/' cfg.txt\"]\n    test_command: pytest {targets}\n");
  const warnings = withRepoHolds(notRepo, f, undefined, (h) => approvalWarnings(f, [], h));
  expect(warnings.join("\n")).not.toContain("setup --project");
});

test("with untracked files on, a sed text found only in an untracked file is not stale", async () => {
  const { withRepoHolds } = await import("../src/standins");
  const { approvalWarnings } = await import("../src/setupview");
  const { parseReviewFile } = await import("../src/config");
  const { initRepo, commit: commitIn } = await import("./helpers/gitutil");
  const { mkdtempSync, writeFileSync: write } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const repo = initRepo(join(mkdtempSync(join(tmpdir(), "arnx-u-")), "r"));
  write(join(repo, "a.txt"), "x\n");
  commitIn(repo, "c");
  write(join(repo, "new.txt"), "host=freshhost.example\n");
  const f = parseReviewFile("version: 1\nprojects:\n  shop:\n    root: .\n    language: python\n    image: python:3.12\n" +
    "    install: [\"sed -i 's/freshhost.example/new/' new.txt\"]\n    test_command: pytest {targets}\n");
  const warn = (u: boolean) => withRepoHolds(repo, f, u, (h) => approvalWarnings(f, [], h)).join("\n");
  expect(warn(true)).not.toContain("setup --project");
  expect(warn(false)).toContain("setup --project");
});
