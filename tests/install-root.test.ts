// install_root: projects that install the same way share one environment image (a Rust workspace of
// 14 crates, 2 install recipes: 14 full workspace builds before).
import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAdapter } from "../src/adapters";
import { parseReviewFile, reviewConfigPath } from "../src/config";
import { dockerfile, envKey, type SessionFactory } from "../src/sandbox";
import { approveFile, envDigest } from "../src/setup";
import { FakeSession } from "./helpers/fakes";
import { gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
const WORKSPACE = (installRoot: string) => `version: 1
projects:
  server:
    root: crates/server
    language: rust
    image: rust:1.95
    install: [cargo nextest run --workspace --no-run]
    test_command: cargo nextest run {targets}
${installRoot ? `    install_root: ${installRoot}\n` : ""}  utils:
    root: crates/utils
    language: rust
    image: rust:1.95
    install: [cargo nextest run --workspace --no-run]
    test_command: cargo nextest run --no-fail-fast {targets}
${installRoot ? `    install_root: ${installRoot}\n` : ""}`;

function workspace(): string {
  const snap = tmp();
  for (const [p, text] of [["Cargo.toml", "[workspace]\n"], ["Cargo.lock", "# lock\n"],
    ["crates/server/Cargo.toml", "[package]\nname = \"server\"\n"], ["crates/utils/Cargo.toml", "[package]\nname = \"utils\"\n"]] as
    [string, string][]) {
    mkdirSync(join(snap, p, ".."), { recursive: true });
    writeFileSync(join(snap, p), text);
  }
  return snap;
}

test("projects with the same image, install and install_root share one image; without it each has its own", () => {
  const snap = workspace();
  const [server, utils] = parseReviewFile(WORKSPACE(".")).projects;
  expect(server!.installRoot).toBe(".");
  expect(envKey(server!, snap)).toBe(envKey(utils!, snap));
  const [ownServer, ownUtils] = parseReviewFile(WORKSPACE("")).projects;
  expect(ownServer!.installRoot).toBe("crates/server");
  expect(envKey(ownServer!, snap)).not.toBe(envKey(ownUtils!, snap));
  // install_root equal to root is the same as leaving it out: approved files keep their images.
  const same = parseReviewFile(WORKSPACE("").replace("    test_command: cargo nextest run {targets}\n",
    "    test_command: cargo nextest run {targets}\n    install_root: crates/server\n")).projects[0]!;
  expect(envKey(same, snap)).toBe(envKey(ownServer!, snap));
});

test("install runs in install_root and its manifests key the image; tests still run in the project's root", () => {
  const snap = workspace();
  const server = parseReviewFile(WORKSPACE(".")).projects[0]!;
  expect(dockerfile(server)).toContain("WORKDIR /src\n");
  expect(server.workdir).toBe("crates/server");
  const before = envKey(server, snap);
  writeFileSync(join(snap, "Cargo.lock"), "# lock 2\n");
  expect(envKey(server, snap)).not.toBe(before);
  expect(envDigest(server)).not.toBe(envDigest(parseReviewFile(WORKSPACE("")).projects[0]!));
});

// A member's dependencies and features build into the image too: reviewing an older commit whose member manifest
// differs (a feature added since) in the newer image rebuilt build scripts offline.
test("a Rust workspace member's manifest keys the image; a build directory's does not", () => {
  const snap = workspace();
  const server = parseReviewFile(WORKSPACE(".")).projects[0]!;
  const before = envKey(server, snap);
  mkdirSync(join(snap, "target/package/server"), { recursive: true });
  writeFileSync(join(snap, "target/package/server/Cargo.toml"), "[package]\nname = \"server\"\n");
  expect(envKey(server, snap)).toBe(before);
  writeFileSync(join(snap, "crates/server/Cargo.toml"), "[package]\nname = \"server\"\n[dev-dependencies]\n" +
    "dep = { version = \"1\", features = [\"extra\"] }\n");
  expect(envKey(server, snap)).not.toBe(before);
});

test("install_root stays inside the repository and belongs to files with projects", () => {
  expect(() => parseReviewFile(WORKSPACE("../x"))).toThrow(/install_root: must stay inside the repository/);
  expect(() => parseReviewFile("version: 1\nimage: python:3.12\ntest_command: python -m pytest {targets}\n" +
    "install_root: .\n")).toThrow(/unknown keys: install_root/);
});

test("the setup agent is told how projects share an image", () => {
  const rust = getAdapter("rust"), ts = getAdapter("typescript");
  expect(rust.setupHints).toContain("install_root: . (the workspace root)");
  expect(ts.setupHints).toContain("install_root: .");
});

test("approve keys every project's image from the snapshot as it was before any run", async () => {
  // Runs can write a manifest into the shared snapshot (cargo writes a missing Cargo.lock): a later project would
  // then get a key of its own, and an image of its own, although it shares the first one's.
  const repo = gitRepo(tmp());
  mkdirSync(join(repo, "a", "tests"), { recursive: true });
  mkdirSync(join(repo, "b", "tests"), { recursive: true });
  writeFileSync(join(repo, "a", "tests", "test_a.py"), "def test_a():\n    pass\n");
  writeFileSync(join(repo, "b", "tests", "test_b.py"), "def test_b():\n    pass\n");
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  const project = (name: string) => `  ${name}:\n    root: ${name}\n    image: python:3.12-slim\n` +
    "    install: [pip install pytest]\n    test_command: python -m pytest -q {targets}\n    install_root: .\n";
  writeFileSync(reviewConfigPath(repo), `version: 1\nprojects:\n${project("a")}${project("b")}`);
  const keys: string[] = [];
  let pristine = "";
  const factory: SessionFactory = async (cfg, snap, _log, body, _envFrom, key) => {
    if (!pristine) pristine = envKey(cfg, snap);
    keys.push(key ?? envKey(cfg, snap));
    const s = new FakeSession(snap, () => {
      writeFileSync(join(snap, "uv.lock"), "# written by a run\n");
      return [junitXml([[`${cfg.workdir}/tests/test_${cfg.name}.py`, `test_${cfg.name}`, "passed", ""]]), "", false];
    });
    return body(s);
  };
  const [ok, detail] = await approveFile(repo, { by: "u", at: "t", sessionFactory: factory });
  expect([ok, detail]).toEqual([true, expect.any(String)]);
  expect(keys).toEqual([pristine, pristine]);
});
