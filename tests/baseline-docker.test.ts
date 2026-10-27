// The baseline with real runners: pytest, node --test and nextest record failing tests one by one, a proof reruns a
// flaky test, and a fixed test leaves the baseline. Run with ARNX_DOCKER_TESTS=1.
import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { readBaseline } from "../src/baseline";
import { isProven, loadReviewFile, reviewConfigPath } from "../src/config";
import { approveFile, rerecordBaseline } from "../src/setup";
import { commit, initRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();

function repoOf(name: string, files: Record<string, string>, yaml: string): string {
  const repo = initRepo(join(tmp(), name));
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, path)), { recursive: true });
    writeFileSync(join(repo, path), body);
  }
  commit(repo, name);
  mkdirSync(dirname(reviewConfigPath(repo)), { recursive: true });
  writeFileSync(reviewConfigPath(repo), yaml);
  return repo;
}

const ids = (repo: string, project: string) => (readBaseline(repo).get(project) ?? []).map((t) => t.id).sort();
const by = { by: "Dev", at: "2026-10-27" };

const PY_YAML = `version: 1
image: python:3.12-slim
install: [pip install pytest]
test_command: python -m pytest -q {targets}
known_failing: [tests/test_calc.py]
notes: [tests/test_calc.py fails]
`;
const PY_FILES = {
  "calc.py": "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a + b\n",
  "tests/test_calc.py": "import pytest\nfrom calc import add, sub\n\n\ndef test_add():\n    assert add(2, 3) == 5\n\n\n" +
    "def test_sub():\n    assert sub(5, 3) == 2\n\n\n@pytest.mark.parametrize('n', [1, 2])\ndef test_param(n):\n" +
    "    assert add(n, 0) == n\n",
  "tests/test_broken.py": "import nonexistent_mod\n\n\ndef test_never():\n    assert nonexistent_mod\n",
  "conftest.py": "",
};
// Fails the first time it runs in a copy of the repository, passes after: a flaky test.
const PY_FLAKY = "import os\n\n\ndef test_flaky():\n    mark = os.path.join(os.path.dirname(__file__), '.ran')\n" +
  "    first = not os.path.exists(mark)\n    open(mark, 'w').close()\n    assert not first\n";

const NODE_YAML = `version: 1
projects:
  calc:
    root: .
    language: typescript
    runner: node
    image: node:22-bookworm-slim
    test_command: node --test {targets}
`;
const NODE_FILES = {
  "package.json": '{"name": "calc", "private": true}\n',
  "calc.js": "exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a + b;\n",
  "__tests__/calc.test.js": 'const test = require("node:test");\nconst assert = require("node:assert");\n' +
    'const { add, sub } = require("../calc");\ntest("adds", () => assert.strictEqual(add(2, 3), 5));\n' +
    'test("subtracts", () => assert.strictEqual(sub(5, 3), 2));\n',
};

const RUST_YAML = `version: 1
projects:
  calc:
    root: .
    language: rust
    runner: nextest
    image: rust:1-bookworm
    install: ["curl -LsSf https://get.nexte.st/latest/linux | tar zxf - -C /usr/local/cargo/bin && cargo nextest run --no-run"]
    test_command: cargo nextest run {targets}
`;
// Unit tests in src/lib.rs: one failing test there used to set aside every test of the crate root.
const RUST_LIB = (sub: string) => `pub fn add(a: i64, b: i64) -> i64 { a + b }
pub fn sub(a: i64, b: i64) -> i64 { ${sub} }

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn adds() { assert_eq!(add(2, 3), 5); }
    #[test]
    fn subtracts() { assert_eq!(sub(5, 3), 2); }
    #[test]
    fn adds_zero() { assert_eq!(add(4, 0), 4); }
}
`;
const RUST_FILES = {
  "Cargo.toml": '[package]\nname = "calc"\nversion = "0.1.0"\nedition = "2021"\n',
  "src/lib.rs": RUST_LIB("a + b"),
};

describe.skipIf(!process.env.ARNX_DOCKER_TESTS)("docker: baseline", () => {
  test("pytest: known_failing becomes the failing tests, a flaky test is rerun, a fixed test leaves", async () => {
    const repo = repoOf("py", PY_FILES, PY_YAML);
    const [ok, detail, suites, changes] = await rerecordBaseline(repo, by);
    expect([ok, detail]).toEqual([true, expect.any(String)]);
    const recorded = readBaseline(repo).get("main")!;
    expect(recorded.map((t) => t.file).sort()).toEqual(["tests/test_broken.py", "tests/test_calc.py"]);
    expect(recorded.find((t) => t.file === "tests/test_calc.py")!.id).toBe("tests/test_calc.py::test_sub");
    // A file that does not load is recorded as one, named by the import's error, not pytest's collection header.
    expect(recorded.find((t) => t.file === "tests/test_broken.py")).toMatchObject({
      cause: "missing-package: nonexistent_mod", load: true, first: "ModuleNotFoundError: No module named 'nonexistent_mod'" });
    expect(recorded.find((t) => t.file === "tests/test_calc.py")!.load).toBeUndefined();
    expect(suites[0]!.guarded).toBe(3); // test_add and both test_param cases count again
    expect(changes).toContain("known_failing removed (1 file): 3 of its tests pass and count again");
    expect(loadReviewFile(repo).projects[0]!.knownFailing).toEqual([]);

    writeFileSync(join(repo, "tests", "test_flaky.py"), PY_FLAKY);
    commit(repo, "a flaky test");
    const [flakyOk, , flaky] = await approveFile(repo, by);
    expect(flakyOk).toBe(true);
    expect(flaky[0]!.flaky).toEqual(["tests/test_flaky.py::test_flaky"]);
    expect(ids(repo, "main")).toHaveLength(2); // a proof never adds to the baseline

    writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n");
    commit(repo, "fix sub");
    const [fixedOk, , fixed] = await approveFile(repo, by);
    expect(fixedOk).toBe(true);
    expect(fixed[0]!.left).toEqual(["tests/test_calc.py::test_sub"]);
    expect(ids(repo, "main")).toHaveLength(1);
    expect(isProven(repo, loadReviewFile(repo))).toBe(true);
  }, 600_000);

  test("node --test: the failing test is recorded, the passing one next to it counts", async () => {
    const repo = repoOf("node", NODE_FILES, NODE_YAML);
    const [ok, detail] = await rerecordBaseline(repo, by);
    expect([ok, detail]).toEqual([true, expect.stringContaining("1 passed")]);
    expect(ids(repo, "calc")).toEqual([expect.stringContaining("subtracts")]);
    writeFileSync(join(repo, "calc.js"), "exports.add = (a, b) => a + b;\nexports.sub = (a, b) => a - b;\n");
    commit(repo, "fix sub");
    const [fixedOk] = await approveFile(repo, by);
    expect(fixedOk).toBe(true);
    expect(ids(repo, "calc")).toEqual([]);
    // A test that breaks now fails the proof: it is outside the baseline and fails again when rerun.
    writeFileSync(join(repo, "calc.js"), "exports.add = (a, b) => a * b;\nexports.sub = (a, b) => a - b;\n");
    commit(repo, "break add");
    const [brokenOk, why] = await approveFile(repo, by);
    expect(brokenOk).toBe(false);
    expect(why).toContain("failing outside the baseline");
  }, 600_000);

  test("node --test: a file that does not load is recorded as one, by its error", async () => {
    const repo = repoOf("node-load", { ...NODE_FILES, "__tests__/calc.test.js": NODE_FILES["__tests__/calc.test.js"]
      .replace("sub(5, 3), 2", "sub(5, 0), 5"), "__tests__/broken.test.js": 'require("./not-there-arnx");\n' +
      'require("node:test")("never", () => {});\n' }, NODE_YAML);
    const [ok, detail] = await rerecordBaseline(repo, by);
    expect([ok, detail]).toEqual([true, expect.stringContaining("2 passed")]);
    expect(readBaseline(repo).get("calc")).toEqual([expect.objectContaining({ file: "__tests__/broken.test.js",
      load: true, first: expect.stringContaining("Cannot find module './not-there-arnx'") })]);
  }, 600_000);

  test("nextest: one failing unit test in src/lib.rs is recorded alone; the crate root's other tests count", async () => {
    const repo = repoOf("rust", RUST_FILES, RUST_YAML);
    const [ok, detail] = await rerecordBaseline(repo, by);
    expect([ok, detail]).toEqual([true, expect.stringContaining("2 passed")]);
    expect(ids(repo, "calc")).toEqual([expect.stringMatching(/tests::subtracts$/)]);
    writeFileSync(join(repo, "src", "lib.rs"), RUST_LIB("a - b"));
    commit(repo, "fix sub");
    const [fixedOk, , fixed] = await approveFile(repo, by);
    expect(fixedOk).toBe(true);
    expect(fixed[0]!.left).toEqual([expect.stringMatching(/tests::subtracts$/)]);
    expect(ids(repo, "calc")).toEqual([]);
  }, 1_200_000);
});
