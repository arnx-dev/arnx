// Which languages a repository is written in, found without a model: source files counted by extension and
// manifests that name a language, vendored and build folders left out. arnx reviews Python, JavaScript/TypeScript
// and Rust; a repository written only in other languages is told so before any model is called, and in a mixed one
// the other languages' files count as uncovered on their own, so the setup agent never has to explain them.
import { posix } from "node:path";

/** Display names of the languages arnx reviews. */
export const SUPPORTED_NAMES = "Python, JavaScript/TypeScript and Rust";
export const ISSUES_URL = "https://github.com/arnx-dev/arnx/issues";

const SUPPORTED_EXT: Record<string, string> = { py: "python", pyi: "python", js: "typescript", jsx: "typescript",
  mjs: "typescript", cjs: "typescript", ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  rs: "rust" };
/** Languages arnx does not review, by extension, as their display names. */
const OTHER_EXT: Record<string, string> = { go: "Go", c: "C/C++", h: "C/C++", cc: "C/C++", cpp: "C/C++",
  cxx: "C/C++", hpp: "C/C++", hh: "C/C++", hxx: "C/C++", cs: "C#", fs: "F#", fsx: "F#", java: "Java", kt: "Kotlin",
  kts: "Kotlin", scala: "Scala", swift: "Swift", rb: "Ruby", php: "PHP", hs: "Haskell", lhs: "Haskell",
  ex: "Elixir", exs: "Elixir", erl: "Erlang", hrl: "Erlang", clj: "Clojure", cljs: "Clojure", cljc: "Clojure",
  dart: "Dart", lua: "Lua", zig: "Zig", nim: "Nim", jl: "Julia", ml: "OCaml", mli: "OCaml", pl: "Perl", pm: "Perl",
  groovy: "Groovy" };
/** Manifests that name a language arnx does not review (exact file names, then extensions). */
const OTHER_MANIFEST: Record<string, string> = { "go.mod": "Go", "CMakeLists.txt": "C/C++", "meson.build": "C/C++",
  "pom.xml": "Java", "build.gradle": "Java", "build.gradle.kts": "Kotlin", "build.sbt": "Scala",
  "Package.swift": "Swift", Gemfile: "Ruby", "composer.json": "PHP", "stack.yaml": "Haskell",
  "cabal.project": "Haskell", "mix.exs": "Elixir", "rebar.config": "Erlang", "deps.edn": "Clojure",
  "project.clj": "Clojure", "pubspec.yaml": "Dart", "build.zig": "Zig", "dune-project": "OCaml", cpanfile: "Perl" };
const OTHER_MANIFEST_EXT: Record<string, string> = { csproj: "C#", sln: "C#", fsproj: "F#", cabal: "Haskell" };
/** Folders that hold other people's code or build output, not the repository's own source. */
const SKIP = new Set(["node_modules", "vendor", "third_party", "third-party", "dist", "build", "target", ".venv",
  "venv", "__pycache__", "Pods", "deps", "_build", ".git"]);
/** Fewer files than this of a language in a repository that also has supported code is noise (a helper script). */
const MIXED_MIN_FILES = 3;
const MAX_ROOTS = 5;

export interface OtherLanguage { name: string; files: number; manifests: number; roots: string[] }
export interface LanguageSurvey {
  /** Source files per supported language (python, typescript, rust). */
  supported: Record<string, number>;
  /** Languages arnx does not review, most files first. */
  others: OtherLanguage[];
}

const skipped = (p: string) => p.split("/").slice(0, -1).some((s) => SKIP.has(s));
const extOf = (p: string) => posix.extname(p).slice(1);

/** The language arnx does not review that a source file is written in, or null. */
export function otherLanguageOf(path: string): string | null {
  if (skipped(path)) return null;
  return OTHER_EXT[extOf(path)] ?? null;
}

/** `files`: paths relative to the repository (tracked, and untracked ones git does not ignore, minus .arnxignore). */
export function surveyLanguages(files: string[]): LanguageSurvey {
  const supported: Record<string, number> = {};
  const others = new Map<string, { files: number; manifests: string[]; dirs: Map<string, number> }>();
  const other = (name: string) => {
    let o = others.get(name);
    if (!o) others.set(name, o = { files: 0, manifests: [], dirs: new Map() });
    return o;
  };
  for (const p of files) {
    if (skipped(p)) continue;
    const base = posix.basename(p);
    const manifest = OTHER_MANIFEST[base] ?? OTHER_MANIFEST_EXT[extOf(p)];
    if (manifest) other(manifest).manifests.push(posix.dirname(p));
    const lang = SUPPORTED_EXT[extOf(p)];
    if (lang) {
      supported[lang] = (supported[lang] ?? 0) + 1;
      continue;
    }
    const name = OTHER_EXT[extOf(p)];
    if (!name) continue;
    const o = other(name);
    o.files += 1;
    const top = p.includes("/") ? p.split("/")[0]! : ".";
    o.dirs.set(top, (o.dirs.get(top) ?? 0) + 1);
  }
  const list = [...others].map(([name, o]) => {
    // Where it lives: the folders of its manifests, else the top-level folders holding most of its files.
    const roots = o.manifests.length ? [...new Set(o.manifests)].sort()
      : [...o.dirs].sort((a, b) => b[1] - a[1]).map(([d]) => d);
    return { name, files: o.files, manifests: o.manifests.length, roots: roots.slice(0, MAX_ROOTS) };
  });
  return { supported, others: list.sort((a, b) => b.files - a.files || (a.name < b.name ? -1 : 1)) };
}

const total = (r: Record<string, number>) => Object.values(r).reduce((a, b) => a + b, 0);

/** Whether arnx has nothing to review here: other languages' source files or manifests and, of the supported files,
 * at most a few (config scripts beside a Go module), with no supported project (`supportedProjects` = 0). */
export function onlyOtherLanguages(s: LanguageSurvey, supportedProjects: number): boolean {
  const others = s.others.reduce((a, o) => a + o.files, 0);
  return s.others.length > 0 && supportedProjects === 0 && total(s.supported) <= others * 0.05;
}

/** The other languages worth naming in a repository that also has supported code. */
export function notableOthers(s: LanguageSurvey): OtherLanguage[] {
  return s.others.filter((o) => o.files >= MIXED_MIN_FILES || o.manifests > 0);
}

/** "Go (11 files)", "Go (11 files) and C/C++ (2 files)", or "Go (a manifest, no source files)". */
export function nameLanguages(list: OtherLanguage[]): string {
  const parts = list.slice(0, 3).map((o) => `${o.name} (${o.files ? `${o.files} file${o.files === 1 ? "" : "s"}`
    : "a manifest, no source files"})`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "";
}

/** The line doctor, setup and init show for a repository written only in other languages. */
export function unsupportedText(s: LanguageSurvey): string {
  return `this repository looks like ${nameLanguages(s.others)}; arnx reviews ${SUPPORTED_NAMES} for now. ` +
    `Tell us which language you need: ${ISSUES_URL}`;
}
