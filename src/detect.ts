// A model-free look at a repository's layout: candidate projects (from manifests), their runners and package
// managers, workspaces, CI and compose files, and the service images they mention. It only gives hints: the setup
// agent decides, and each project still has to prove itself by running its suite.
import { readFileSync } from "node:fs";
import { join, posix } from "node:path";
import type { AdapterId } from "./adapters/types";
import { workingTreeFiles } from "./change";
import { loadIgnore } from "./ignore";

export interface Candidate {
  root: string;
  language: AdapterId | "other";
  manifest: string;
  runner: string | null;
  packageManager: string | null;
  evidence: string[];
}

export interface Detection {
  candidates: Candidate[];
  workspaces: string[];
  ci: string[];
  compose: string[];
  services: string[];
  languages: Record<string, number>;
}

const EXT_LANG: Record<string, string> = { py: "python", js: "typescript", jsx: "typescript", mjs: "typescript",
  cjs: "typescript", ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript", rs: "rust",
  cs: "csharp", go: "go", java: "java", kt: "kotlin", rb: "ruby", php: "php" };
const TEST_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.py|[^/]*\.(test|spec)\.[cm]?[jt]sx?|tests\/[^/]+\.rs)$|(^|\/)(test|tests|__tests__)\/(.+\/)?[^/]+\.[cm]?[jt]sx?$/;
/** Rust unit tests live inside src/ files. */
const RUST_TEST = /#\[(cfg\(test\)|test|tokio::test)\]/;
const LOCKS: [string, string][] = [["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["bun.lock", "bun"],
  ["bun.lockb", "bun"], ["package-lock.json", "npm"], ["npm-shrinkwrap.json", "npm"]];
/** Manifests under these directories are test data (fixtures, sample apps of a test suite), not projects. */
const NOT_PROJECTS = new Set(["fixtures", "__fixtures__", "testdata", "test-data", "test", "tests", "__tests__", "e2e"]);
const MAX_LISTED = 40;
const LANGUAGE_NAMES: Record<string, string> = { python: "Python", typescript: "JavaScript/TypeScript", rust: "Rust" };

const dirOf = (p: string) => posix.dirname(p);
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
  const testsUnder = (root: string) =>
    paths.filter((p) => (root === "." || p.startsWith(root + "/")) &&
      (TEST_FILE.test(p) || (p.endsWith(".rs") && p.includes("src/") && RUST_TEST.test(read(repo, p))))).length;
  const lockIn = (dir: string) => {
    for (const d of ancestors(dir)) {
      for (const [file, manager] of LOCKS) if (set.has(d === "." ? file : `${d}/${file}`)) return manager;
    }
    return null;
  };
  const candidates: Candidate[] = [];
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
    const n = testsUnder(c.root);
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
  return { candidates, workspaces: [...workspaces].sort(), ci, compose, services: [...services].sort(), languages };
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
  if (d.candidates.length > MAX_LISTED) {
    lines.push(`... ${d.candidates.length - MAX_LISTED} more candidates (fewer tests; list directories to see them)`);
  }
  if (d.workspaces.length) lines.push(`Workspaces: ${d.workspaces.join(", ")}`);
  if (d.ci.length) lines.push(`CI files: ${d.ci.join(", ")}`);
  if (d.compose.length) lines.push(`Compose files: ${d.compose.join(", ")}`);
  if (d.services.length) lines.push(`Service images mentioned: ${d.services.join(", ")}`);
  const langs = Object.entries(d.languages).sort((a, b) => b[1] - a[1]).map(([l, n]) => `${l} ${n}`);
  if (langs.length) lines.push(`Source files by language: ${langs.join(", ")}`);
  return lines.join("\n");
}

