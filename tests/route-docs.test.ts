import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseReviewFile } from "../src/config";
import { docsFilter, isDocFile, route, uncoveredChange } from "../src/route";
import { commit, gitRepo } from "./helpers/gitutil";
import { useTmp } from "./helpers/tmp";
import { GOOD, PROJECTS } from "./helpers/yaml";

const tmp = useTmp();

test("documentation is a docs folder, a top-level README-like file or .github markdown, never code", () => {
  for (const p of ["README.md", "docs/guide.rst", "a/docs/b.mdx", "CHANGELOG", "LICENSE", "LICENSE-MIT", "AUTHORS",
    "CONTRIBUTING.md", ".changeset/brave-owls.md", "docs/logo.png", "doc/notes.txt", "svc/documentation/a.md",
    ".github/PULL_REQUEST_TEMPLATE.md", "README.rst"]) {
    expect([p, isDocFile(p)]).toEqual([p, true]);
  }
  for (const p of ["docs_src/tutorial.py", "docs/conf.py", "src/app.py", "requirements.txt", "docs/requirements.txt",
    "CMakeLists.txt", "tests/data/words.txt", "package.json", "docs/build.sh", "prompts/system.md", "templates/x.md",
    "svc/README.md", "notes.md", "src/help.rst", "notes.txt", "img/logo.png"]) {
    expect([p, isDocFile(p)]).toEqual([p, false]);
  }
});

test("a project whose changed files are all documentation gets no round and no type check", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, ["services/pay/docs/intro.md", "services/pay/docs/guide.rst"], 4);
  expect(r.routed).toEqual([]);
  expect(r.checkOnly).toEqual([]);
  expect(r.docsOnly.map((d) => [d.project.name, d.files])).toEqual([["pay", ["services/pay/docs/intro.md",
    "services/pay/docs/guide.rst"]]]);
  expect(r.uncovered).toEqual([]);
});

test("a changeset counts as documentation, and a doc nobody covers is not uncovered", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, [".changeset/brave-owls.md", "infra/docs/notes.md"], 4);
  expect(r.routed).toEqual([]);
  expect(r.uncovered).toEqual([]);
  expect(uncoveredChange(f, [".changeset/brave-owls.md"], 4)).toBeNull();
});

test("a project with docs and code keeps its round", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, ["services/pay/docs/a.md", "services/pay/x.py", "services/feed/docs/b.md"], 4);
  expect(r.routed.map((x) => [x.project.name, x.owned])).toEqual([["pay", ["services/pay/docs/a.md",
    "services/pay/x.py"]]]);
  expect(r.docsOnly.map((d) => d.project.name)).toEqual(["feed"]);
});

test("with docs reviewed too (--docs), documentation routes like code", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, ["services/pay/docs/a.md"], 4, () => false);
  expect(r.routed.map((x) => x.project.name)).toEqual(["pay"]);
  expect(r.docsOnly).toEqual([]);
});

test("a doc some file names is not documentation, in any kind of file, but one nobody names is", () => {
  const repo = gitRepo(tmp());
  const put = (p: string, body: string) => {
    mkdirSync(dirname(join(repo, p)), { recursive: true });
    writeFileSync(join(repo, p), body);
  };
  put("docs/spec.md", "# spec\n");
  put("docs/guide.md", "# guide\n");
  put("docs/site.md", "# site\n");
  put("tests/test_spec.py", "def test_spec():\n    assert open('docs/spec.md').read()\n");
  put("Dockerfile", "FROM scratch\nCOPY docs/site.md /app/\n");
  commit(repo, "files");
  const isDoc = docsFilter(repo, "HEAD", false);
  expect(isDoc("docs/spec.md")).toBe(false);
  expect(isDoc("docs/site.md")).toBe(false);
  expect(isDoc("docs/guide.md")).toBe(true);
  expect(docsFilter(repo, "HEAD", true)("docs/guide.md")).toBe(false);
});

test("a prompt file changed alone is reviewed; a docs file changed alone is docs only", () => {
  const f = parseReviewFile(GOOD);
  expect(route(f, ["prompts/system.md"], 4).routed.map((r) => r.project.name)).toEqual(["main"]);
  const r = route(f, ["docs/guide.md"], 4);
  expect(r.routed).toEqual([]);
  expect(r.docsOnly.map((d) => d.files)).toEqual([["docs/guide.md"]]);
});
