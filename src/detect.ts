// A model-free look at a repository's layout: candidate projects (from manifests), their runners and package
// managers, workspaces, CI and compose files, and the service images they mention. It only gives hints: the setup
// agent decides, and each project still has to prove itself by running its suite.
import { existsSync, readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { AdapterId } from "./adapters/types";
import { workingTreeFiles } from "./change";
import { loadReviewFile, reviewConfigPath } from "./config";
import { type Facts, readFacts } from "./facts";
import { loadIgnore } from "./ignore";
import { notableOthers, onlyOtherLanguages, type OtherLanguage, surveyLanguages, type LanguageSurvey } from "./languages";

export interface Candidate {
  root: string;
  language: AdapterId | "other";
  manifest: string;
  runner: string | null;
  packageManager: string | null;
  evidence: string[];
  /** Test files under root that no deeper candidate of the same language holds. */
  ownTests?: number;
}

export interface Detection {
  candidates: Candidate[];
  workspaces: string[];
  ci: string[];
  compose: string[];
  services: string[];
  languages: Record<string, number>;
  /** Languages arnx does not review that the repository has enough of to name (languages.ts). */
  others?: OtherLanguage[];
  /** What the files settle about each candidate (versions, managers, CI, services), for the draft. */
  facts?: Facts;
}

const EXT_LANG: Record<string, string> = { py: "python", js: "typescript", jsx: "typescript", mjs: "typescript",
  cjs: "typescript", ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", rs: "rust",
  cs: "csharp", go: "go", java: "java", kt: "kotlin", rb: "ruby", php: "php" };
const TEST_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|[^/]*\.(test|spec)\.[cm]?[jt]sx?|tests\/[^/]+\.rs)$|(^|\/)(test|tests|__tests__)\/(.+\/)?[^/]+\.[cm]?[jt]sx?$/;
/** Rust unit tests live inside src/ files. */
const RUST_TEST = /#\[(cfg\(test\)|test|tokio::test)\]/;

/** Whether a path (relative to anywhere) names a Python or JavaScript/TypeScript test file by the usual conventions. */
export const isTestPath = (p: string) => TEST_FILE.test(p) && !p.endsWith(".rs");
const LOCKS: [string, string][] = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"],
  ["bun.lockb", "bun"], ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"]];
/** Manifests under these directories are test data (fixtures, sample apps of a test suite), not projects. */
const NOT_PROJECTS = new Set(["fixtures", "__fixtures__", "testdata", "test-data", "test", "tests", "__tests__", "e2e"]);
const MAX_LISTED = 40;
const LANGUAGE_NAMES: Record<string, string> = { python: "Python", typescript: "JavaScript/TypeScript", rust: "Rust" };

const dirOf = (p: string) => posix.dirname(p);
const list = (xs: string[], max = 10) =>
  xs.slice(0, max).join(", ") + (xs.length > max ? `, … (${xs.length} in all)` : "");
const ancestors = (dir: string): string[] => {
  const out = [dir];
  while (dir !== ".") {
    dir = dirOf(dir);
    out.push(dir);
  }
  return out;
};

function read(repo: string, rel: string): string {
  try {
    return readFileSync(join(repo, rel), "utf8");
  } catch {
    return "";
  }
}

function jsRunner(pkg: Record<string, unknown>): string | null {
  const deps = { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) };
  const scripts = Object.entries((pkg.scripts as Record<string, string>) ?? {})
    .filter(([k]) => k.startsWith("test")).map(([, v]) => String(v)).join("\n");
  if ("vitest" in deps || /\bvitest\b/.test(scripts)) return "vitest";
  if ("jest" in deps || /\bjest\b/.test(scripts)) return "jest";
  if (/\bnode\b[^\n]*--test\b/.test(scripts)) return "node";
  if (/\bbun\s+test\b/.test(scripts)) return "bun";
  if ("mocha" in deps || /\bmocha\b/.test(scripts)) return "mocha";
  return null;
}

/** The runner most of these test files import (node:test, bun:test, vitest), when one is imported by at least half
 * of them; jest's globals need no import, so jest is never told this way. */
export function testImports(texts: string[]): string | null {
  const counts: Record<string, number> = {};
  for (const t of texts) {
    const m = /\bfrom\s+["'](node:test|bun:test|vitest)["']|require\(\s*["'](node:test|bun:test|vitest)["']\s*\)/.exec(t);
    const runner = { "node:test": "node", "bun:test": "bun", vitest: "vitest" }[m?.[1] ?? m?.[2] ?? ""];
    if (runner) counts[runner] = (counts[runner] ?? 0) + 1;
  }
  const [best, n] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
  return best && n * 2 >= texts.length ? best : null;
}

/** Whether a JavaScript/TypeScript project at `root` can be type checked: it has a tsconfig.json, and typescript is
 * among the dependencies of its package.json or of one above it (a workspace root). `read` gives a file's text
 * (relative to the repository root), "" when there is none. */
export function typeCheckable(read: (rel: string) => string, root: string): boolean {
  const at = (dir: string, name: string) => (dir === "." ? name : `${dir}/${name}`);
  if (!read(at(root, "tsconfig.json"))) return false;
  return ancestors(root).some((dir) => {
    try {
      const pkg = JSON.parse(read(at(dir, "package.json")) || "{}") as Record<string, unknown>;
      return "typescript" in { ...(pkg.dependencies as object ?? {}), ...(pkg.devDependencies as object ?? {}) };
    } catch {
      return false;
    }
  });
}

/** The type check setup proposes for a project typeCheckable finds. */
export const TYPECHECK_EXAMPLE = "npx tsc --noEmit -p tsconfig.json";

/** The files a snapshot holds (tracked, and untracked unless git ignores them) minus .arnxignore, by default; the
 * survey passes its own list. */
export function detect(repo: string, files?: string[]): Detection {
  let all = files;
  if (!all) {
    const ignored = loadIgnore(repo);
    all = workingTreeFiles(repo).files.filter((p) => !ignored(p));
  }
  const paths = all.filter((p) => !p.split("/").includes("node_modules"));
  const set = new Set(paths);
  const languages: Record<string, number> = {};
  for (const p of paths) {
    const lang = EXT_LANG[posix.extname(p).slice(1)];
    if (lang) languages[lang] = (languages[lang] ?? 0) + 1;
  }
  const testFiles = (root: string) =>
    paths.filter((p) => (root === "." || p.startsWith(root + "/")) &&
      (TEST_FILE.test(p) || (p.endsWith(".rs") && p.includes("src/") && RUST_TEST.test(read(repo, p)))));
  const testsUnder = (root: string) => testFiles(root).length;
  const lockIn = (dir: string) => {
    for (const d of ancestors(dir)) {
      for (const [file, manager] of LOCKS) if (set.has(d === "." ? file : `${d}/${file}`)) return manager;
    }
    return null;
  };
  const candidates: Candidate[] = [];
  const ownFiles = new Map<Candidate, string[]>();
  const workspaces = new Set<string>();
  for (const p of paths) {
    const name = posix.basename(p);
    const root = dirOf(p);
    if (root.split("/").some((s) => NOT_PROJECTS.has(s))) continue;
    if (name === "package.json") {
      let pkg: Record<string, unknown> = {};
      try {
        pkg = JSON.parse(read(repo, p)) as Record<string, unknown>;
      } catch {
        // an unreadable package.json is still a candidate
      }
      if (pkg.workspaces || set.has(root === "." ? "pnpm-workspace.yaml" : `${root}/pnpm-workspace.yaml`)) {
        workspaces.add(root);
      }
      candidates.push({ root, language: "typescript", manifest: p, runner: jsRunner(pkg), packageManager: lockIn(root),
        evidence: [] });
    } else if (name === "Cargo.toml") {
      const text = read(repo, p);
      if (/^\s*\[workspace\]/m.test(text)) workspaces.add(root);
      if (/^\s*\[package\]/m.test(text)) {
        candidates.push({ root, language: "rust", manifest: p, runner: "nextest", packageManager: "cargo", evidence: [] });
      }
    } else if (/^(pyproject\.toml|setup\.py|setup\.cfg|requirements[^/]*\.txt)$/.test(name)) {
      if (candidates.some((c) => c.root === root && c.language === "python")) continue;
      const pytest = [p, `${root}/pytest.ini`, `${root}/conftest.py`].some((f) => /pytest/.test(read(repo, f))) ||
        set.has(root === "." ? "pytest.ini" : `${root}/pytest.ini`) || testsUnder(root) > 0;
      candidates.push({ root, language: "python", manifest: p, runner: pytest ? "pytest" : null, packageManager: null,
        evidence: [] });
    }
  }
  for (const c of candidates) {
    const files = testFiles(c.root);
    const deeper = candidates.filter((o) => o.language === c.language && o.root !== c.root &&
      (c.root === "." || o.root.startsWith(c.root + "/")));
    const ext = c.language === "rust" ? /\.rs$/ : c.language === "python" ? /\.py$/ : /\.[cm]?[jt]sx?$/;
    const own = files.filter((p) => ext.test(p) && !deeper.some((o) => p.startsWith(o.root + "/")));
    c.ownTests = own.length;
    ownFiles.set(c, own);
    if (c.language === "typescript") c.runner = testImports(own.slice(0, 30).map((p) => read(repo, p))) ?? c.runner;
    const n = files.length;
    c.evidence.push(`${n} test file${n === 1 ? "" : "s"}`);
    if (workspaces.has(c.root)) c.evidence.push("workspace root");
    if (c.language === "typescript" && typeCheckable((rel) => (set.has(rel) ? read(repo, rel) : ""), c.root)) {
      c.evidence.push("tsconfig.json and typescript: give it a typecheck");
    }
  }
  candidates.sort((a, b) => (a.root < b.root ? -1 : a.root > b.root ? 1 : a.language < b.language ? -1 : 1));
  const ci = paths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$|^\.gitlab-ci\.yml$|^\.circleci\/config\.yml$/.test(p));
  const compose = paths.filter((p) => /(^|\/)(docker-)?compose[^/]*\.ya?ml$/.test(p));
  const services = new Set<string>();
  for (const f of [...compose, ...ci]) {
    for (const m of read(repo, f).matchAll(/^[ \t]*image:[ \t]*["']?([^\s"'#]+)/gm)) {
      const image = m[1]!.replace(/\$\{[A-Za-z_][A-Za-z0-9_]*:-([^}$]*)\}/g, "$1");
      if (!image.endsWith(":") && !image.includes("$")) services.add(image);
    }
  }
  return { candidates, workspaces: [...workspaces].sort(), ci, compose, services: [...services].sort(), languages,
    others: notableOthers(surveyLanguages(paths)), facts: readFacts(repo, paths, candidates, ownFiles) };
}

/** The detection as hints for the setup agent. */
export function describeDetection(d: Detection): string {
  const lines = ["Layout found without a model (hints only; prove each project by running its suite):"];
  // Long lists (big workspaces) show the candidates with the most tests; the rest is counted.
  const tests = (c: Candidate) => Number(/^(\d+)/.exec(c.evidence[0] ?? "")?.[1] ?? 0);
  const listed = new Set([...d.candidates].sort((a, b) => tests(b) - tests(a)).slice(0, MAX_LISTED));
  for (const c of d.candidates.filter((x) => listed.has(x))) {
    const lang = LANGUAGE_NAMES[c.language] ?? c.language;
    const parts = [lang, c.runner ? `runner ${c.runner}` : "runner unknown", c.packageManager ?? ""].filter(Boolean);
    lines.push(`- ${c.root}: ${parts.join(", ")} (${c.evidence.join("; ")})`);
  }
  if (!d.candidates.length) lines.push("- no manifests found");
  const bare = d.candidates.filter((c) => c.language !== "rust" && c.language !== "other" &&
    /^0 test files/.test(c.evidence[0] ?? "")).map((c) => c.root);
  if (bare.length) {
    lines.push(`No test files of their own: ${list(bare)}. That is fine: try_project proves such a project with ` +
      "arnx's one-line test instead of a suite. Install its runner in install when the project does not list it, " +
      "and never write tests in test_command.");
  }
  if (d.candidates.length > MAX_LISTED) {
    lines.push(`... ${d.candidates.length - MAX_LISTED} more candidates (fewer tests; list directories to see them)`);
  }
  if (d.workspaces.length) lines.push(`Workspaces: ${d.workspaces.join(", ")}`);
  if (d.ci.length) lines.push(`CI files: ${d.ci.join(", ")}`);
  if (d.compose.length) lines.push(`Compose files: ${d.compose.join(", ")}`);
  if (d.services.length) lines.push(`Service images mentioned: ${d.services.join(", ")}`);
  const facts = d.facts;
  if (facts) {
    const clip = (t: string) => (t.length > 120 ? `${t.slice(0, 119)}…` : t);
    const tests = [...new Set(facts.jobs.flatMap((j) => j.test.map((t) => `${clip(t)} (${j.id})`)))];
    if (tests.length) lines.push(`CI test commands: ${list(tests, 6)}`);
    const maybe = facts.projects.filter((p) => p.maybeServices.length)
      .map((p) => `${p.root}: ${p.maybeServices.map((s) => `${s.value} (${s.from})`).join(", ")}`);
    if (maybe.length) lines.push(`Services the code may use, left out of the draft: ${list(maybe, 6)}`);
    const env = facts.projects.filter((p) => p.envNames.length).map((p) => `${p.root}: ${list(p.envNames, 12)}`);
    if (env.length) lines.push(`Example env files name: ${list(env, 6)}`);
  }
  const langs = Object.entries(d.languages).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`);
  if (langs.length) lines.push(`Source files by language: ${langs.join(", ")}`);
  if (d.others?.length) {
    lines.push(`Not reviewed by arnx (counted as uncovered without listing them): ${d.others.map((o) =>
      `${o.name} ${o.files} files (${o.roots.join(", ")})`).join("; ")}`);
  }
  return lines.join("\n");
}

/** The repository's languages, from the files a snapshot holds (minus .arnxignore), and whether arnx has nothing
 * here it can review: only languages it does not review yet. Null when the files cannot be listed. */
export function repoLanguages(repo: string): { survey: LanguageSurvey; onlyOthers: boolean } | null {
  try {
    const ignored = loadIgnore(repo);
    const files = workingTreeFiles(repo).files.filter((p) => !ignored(p));
    const survey = surveyLanguages(files);
    // Projects in .arnx/review.yaml (approved or not) are what arnx reviews, whatever the files look like.
    const configured = existsSync(reviewConfigPath(repo))
      ? loadReviewFile(repo, { requireApproved: false }).projects.length : 0;
    return { survey, onlyOthers: onlyOtherLanguages(survey, configured || detect(repo, files).candidates.length) };
  } catch {
    return null;
  }
}
