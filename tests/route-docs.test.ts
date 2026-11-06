import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewFile } from "../src/config";
import { docsFilter, isDocFile, route, uncoveredChange } from "../src/route";
import { commit, gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";
import { PROJECTS } from "./helpers/yaml";

const tmp = useTmp();

test("documentation is told by name and extension, code-like files never", () => {
  for (const p of ["README.md", "docs/guide.rst", "docs/a/b.mdx", "CHANGELOG", "LICENSE", "LICENSE-MIT", "NOTICE.txt",
    "AUTHORS", ".changeset/brave-owls.md", "docs/logo.png", "docs/notes.txt", "a/README.txt", "docs/img/a.svg"]) {
    expect([p, isDocFile(p)]).toEqual([p, true]);
  }
  for (const p of ["docs_src/tutorial.py", "docs/conf.py", "src/app.py", "requirements.txt", "docs/requirements.txt",
    "CMakeLists.txt", "tests/data/words.txt", "package.json", "docs/build.sh", "setup.cfg", "notes.txt"]) {
    expect([p, isDocFile(p)]).toEqual([p, false]);
  }
});

test("a project whose changed files are all documentation gets no round and no type check", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, ["services/pay/README.md", "services/pay/docs/guide.rst"], 4);
  expect(r.routed).toEqual([]);
  expect(r.checkOnly).toEqual([]);
  expect(r.docsOnly.map((d) => [d.project.name, d.files])).toEqual([["pay", ["services/pay/README.md",
    "services/pay/docs/guide.rst"]]]);
  expect(r.uncovered).toEqual([]);
});

test("a changeset counts as documentation, and a doc nobody covers is not uncovered", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, [".changeset/brave-owls.md", "infra/notes.md"], 4);
  expect(r.routed).toEqual([]);
  expect(r.uncovered).toEqual([]);
  expect(uncoveredChange(f, [".changeset/brave-owls.md"], 4)).toBeNull();
});

test("a project with docs and code keeps its round", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, ["services/pay/README.md", "services/pay/x.py", "services/feed/CHANGELOG.md"], 4);
  expect(r.routed.map((x) => [x.project.name, x.owned])).toEqual([["pay", ["services/pay/README.md",
    "services/pay/x.py"]]]);
  expect(r.docsOnly.map((d) => d.project.name)).toEqual(["feed"]);
});

test("with docs reviewed too (--docs), documentation routes like code", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, ["services/pay/README.md"], 4, () => false);
  expect(r.routed.map((x) => x.project.name)).toEqual(["pay"]);
  expect(r.docsOnly).toEqual([]);
});

test("a file a project's code or tests read is not documentation", () => {
  const repo = gitRepo(tmp());
  const put = (p: string, body: string) => {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), body);
  };
  put("docs/spec.md", "# spec\n");
  put("docs/guide.md", "# guide\n");
  put("tests/test_spec.py", "def test_spec():\n    assert open('docs/spec.md').read()\n");
  commit(repo, "files");
  const isDoc = docsFilter(repo, "HEAD", false);
  expect(isDoc("docs/spec.md")).toBe(false);
  expect(isDoc("docs/guide.md")).toBe(true);
  expect(docsFilter(repo, "HEAD", true)("docs/guide.md")).toBe(false);
});
