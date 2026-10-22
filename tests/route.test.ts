import { expect, test } from "bun:test";
import { parseReviewFile } from "../src/config";
import { route } from "../src/route";
import { defaultSettings, loadSettings, writeSettings } from "../src/settings";
import { useTmp } from "./helpers/tmp";
import { GOOD, PROJECTS } from "./helpers/yaml";

const tmp = useTmp();
const names = (r: ReturnType<typeof route>) => r.routed.map((x) => [x.project.name, x.owned, x.used]);

test("a shared path reviews every project that uses it, and no other", () => {
  const extra = "  extra:\n    root: tools\n    image: i\n    test_command: pytest {targets}\n";
  const f = parseReviewFile(PROJECTS.replace("uncovered:", extra + "uncovered:"));
  const r = route(f, ["services/shared/db.py"], 4);
  expect(names(r)).toEqual([["feed", [], ["services/shared/db.py"]], ["pay", [], ["services/shared/db.py"]]]);
  expect(r.uncovered).toEqual([]);
});

test("owned files go to their owner, most-changed project first", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, ["services/feed/a.py", "services/pay/x.py", "services/pay/y.py"], 4);
  expect(names(r)).toEqual([["pay", ["services/pay/x.py", "services/pay/y.py"], []], ["feed", ["services/feed/a.py"], []]]);
});

test("files no project covers are listed with the recorded reason", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, ["infra/main.tf", "README.md", "services/pay/x.py"], 4);
  expect(r.uncovered).toEqual([{ path: "infra/main.tf", reason: "Terraform; no adapter" },
    { path: "README.md", reason: "no project covers it" }]);
  expect(names(r)).toEqual([["pay", ["services/pay/x.py"], []]]);
});

test("projects beyond the limit are listed as not reviewed", () => {
  const f = parseReviewFile(PROJECTS);
  const r = route(f, ["services/shared/a.py"], 1);
  expect(r.routed.map((x) => x.project.name)).toEqual(["feed"]);
  expect(r.notReviewed).toEqual(["pay"]);
});

test("a file without projects routes everything to main", () => {
  const r = route(parseReviewFile(GOOD), ["anything/at/all.py", "README.md"], 4);
  expect(names(r)).toEqual([["main", ["anything/at/all.py", "README.md"], []]]);
  expect(r.uncovered).toEqual([]);
});

test("max_projects round-trips in config.toml", () => {
  const s = { ...defaultSettings(), maxProjects: 2 };
  writeSettings(tmp(), s);
  expect(loadSettings(tmp()).maxProjects).toBe(2);
  expect(defaultSettings().maxProjects).toBe(4);
});

// A repository of several projects whose top-level project uses the folder holding the others (a common shape), in any
// repository: only the paths and the projects' roots decide, never a name.
const mono = (rootUses: string[], extraProjects = "", rootOwns = ["scripts/", "/tsconfig.json"]) => parseReviewFile([
  "version: 1",
  "projects:",
  "  top:",
  "    root: .",
  "    language: typescript",
  "    runner: bun",
  "    image: i",
  "    test_command: bun test {targets}",
  "    typecheck: tsc --noEmit",
  `    owns: [${rootOwns.map((x) => JSON.stringify(x)).join(", ")}]`,
  `    uses: [${rootUses.map((x) => JSON.stringify(x)).join(", ")}]`,
  "  api:",
  "    root: packages/api",
  "    language: typescript",
  "    runner: bun",
  "    image: i",
  "    test_command: bun test {targets}",
  "    owns: [packages/api/]",
  "    uses: [packages/shared/]",
  "  shared:",
  "    root: packages/shared",
  "    language: typescript",
  "    runner: bun",
  "    image: i",
  "    test_command: bun test {targets}",
  "    owns: [packages/shared/]",
  "  brain:",
  "    root: packages/brain",
  "    language: typescript",
  "    runner: bun",
  "    image: i",
  "    test_command: bun test {targets}",
  "    owns: [packages/brain/]",
  extraProjects,
].filter(Boolean).join("\n") + "\n");
const PROJECTS_TWO = [
  "version: 1", "projects:",
  "  api:", "    root: packages/api", "    language: typescript", "    runner: bun", "    image: i",
  "    test_command: bun test {targets}", "    owns: [packages/api/]",
  "  shared:", "    root: packages/shared", "    language: typescript", "    runner: bun", "    image: i",
  "    test_command: bun test {targets}", "    owns: [packages/shared/]", "    uses: [api/]",
].join("\n") + "\n";
const routed = (r: ReturnType<typeof route>) => r.routed.map((x) => x.project.name);
const checks = (r: ReturnType<typeof route>) => r.checkOnly.map((c) => [c.project.name, c.used, c.by]);

test("a project reached only through an entry holding other projects gets its type check; the owner reviews", () => {
  const r = route(mono(["packages/"]), ["packages/api/src/billing.ts"], 4);
  expect(routed(r)).toEqual(["api"]);
  expect(checks(r)).toEqual([["top", ["packages/api/src/billing.ts"], ["api"]]]);
  expect(r.notReviewed).toEqual([]);
});

test("a real dependency still reviews: api uses shared, so a shared change goes to shared and api", () => {
  const r = route(mono(["packages/"]), ["packages/shared/src/billing.ts"], 4);
  expect(routed(r)).toEqual(["shared", "api"]);
  expect(checks(r)).toEqual([["top", ["packages/shared/src/billing.ts"], ["shared"]]]);
});

test("a changed file no project owns keeps the containing project's round: nothing leaves the review", () => {
  const r = route(mono(["packages/"]), ["packages/api/src/a.ts", "packages/worker/run.ts"], 4);
  expect(routed(r)).toEqual(["api", "top"]);
  expect(r.checkOnly).toEqual([]);
});

test("an owner over max_projects: the containing project keeps its round, or is listed as not reviewed", () => {
  const change = ["packages/api/a.ts", "packages/api/b.ts", "packages/brain/c.ts"];
  // Two rounds allowed: both owners review, top only type checks.
  expect(routed(route(mono(["packages/"]), change, 2))).toEqual(["api", "brain"]);
  expect(checks(route(mono(["packages/"]), change, 2))).toEqual([["top", change, ["api", "brain"]]]);
  // One round: brain is over the limit, so top cannot leave brain's file to it; no room either: not reviewed.
  const one = route(mono(["packages/"]), change, 1);
  expect(routed(one)).toEqual(["api"]);
  expect(one.notReviewed).toEqual(["brain", "top"]);
  expect(one.checkOnly).toEqual([]);
});

test("a project that owns a changed file is routed as before, whatever else it uses", () => {
  const r = route(mono(["packages/"]), ["tsconfig.json", "packages/api/a.ts"], 4);
  expect(routed(r)).toEqual(["api", "top"]);
  expect(r.checkOnly).toEqual([]);
});

test("a file reached through a real dependency entry as well keeps the round", () => {
  // top also depends on shared directly: a shared change is behaviour top gets, not a second look at shared's code.
  const r = route(mono(["packages/", "packages/shared/"]), ["packages/shared/x.ts"], 4);
  expect(routed(r)).toEqual(["shared", "api", "top"]);
  expect(r.checkOnly).toEqual([]);
});

test("glob and anchored entries that hold projects count too; one naming a project's own root does not", () => {
  expect(checks(route(mono(["packages/*/"]), ["packages/api/a.ts"], 4))).toEqual([["top", ["packages/api/a.ts"], ["api"]]]);
  expect(checks(route(mono(["/packages/"]), ["packages/api/a.ts"], 4))).toEqual([["top", ["packages/api/a.ts"], ["api"]]]);
  // `packages/api/` is api's root itself: a dependency on api, so top reviews it from its side.
  const own = route(mono(["packages/api/"]), ["packages/api/a.ts"], 4);
  expect(routed(own)).toEqual(["api", "top"]);
  expect(own.checkOnly).toEqual([]);
});

test("repositories without such entries route exactly as before", () => {
  const f = parseReviewFile(PROJECTS);
  for (const change of [["services/shared/db.py"], ["services/pay/x.py", "services/feed/a.py"], ["infra/main.tf"]]) {
    expect(route(f, change, 4).checkOnly).toEqual([]);
  }
});

test("an unanchored entry such as api/ matches any folder of that name: one holding a project counts as holding it", () => {
  // `shared` uses api/ (meant: the repository's /api/ contract). Unanchored, it also matches packages/api/.
  const f = parseReviewFile(PROJECTS_TWO);
  expect(checks(route(f, ["packages/api/src/a.ts"], 4))).toEqual([["shared", ["packages/api/src/a.ts"], ["api"]]]);
  // The contract itself, which no project owns, still gives shared its round.
  const r = route(f, ["api/openapi.yaml"], 4);
  expect(routed(r)).toEqual(["shared"]);
  expect(r.checkOnly).toEqual([]);
});

test("an entry naming a project's root stays a dependency even when that root holds a nested project", () => {
  const f = parseReviewFile([
    "version: 1", "projects:",
    "  top:", "    root: .", "    language: typescript", "    runner: bun", "    image: i",
    "    test_command: bun test {targets}", "    owns: [scripts/]", "    uses: [packages/api/]",
    "  api:", "    root: packages/api", "    language: typescript", "    runner: bun", "    image: i",
    "    test_command: bun test {targets}", "    owns: [packages/api/]",
    "  client:", "    root: packages/api/client", "    language: typescript", "    runner: bun", "    image: i",
    "    test_command: bun test {targets}", "    owns: [packages/api/client/]",
  ].join("\n") + "\n");
  const r = route(f, ["packages/api/src/a.ts"], 4);
  expect(routed(r)).toEqual(["api", "top"]);
  expect(r.checkOnly).toEqual([]);
});
