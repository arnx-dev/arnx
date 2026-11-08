// Routing: which projects review a change. A changed file goes to every project that owns or uses it; a file no
// project covers is reported as not tested, with the reason recorded at setup, never guessed.
//
// A `uses` entry that holds another project's root (a top-level project using `packages/`, which holds
// `packages/api`) contains projects rather than depending on one. A project the change reaches only through such
// entries, whose changed files are all owned by projects reviewed in this run, would review the same files a second
// time: it gets its type check alone (`checkOnly`), no agent round. When any of those files has no owner under review
// (no project owns it, or its owner is over max_projects), it is routed as before, so no changed file leaves the review.
import { spawnSync } from "node:child_process";
import { extname, posix } from "node:path";
import { BROWSER_TESTS, WEB_UI } from "./browser";
import type { ReviewConfig, ReviewFile } from "./config";
import { MANY_SERVICES_SAID } from "./facts";
import { matcher } from "./ignore";
import { isTestPath } from "./detect";
import { otherLanguageOf, sourceLanguageOf } from "./languages";
import { SOURCE } from "./untested";

export interface Routed { project: ReviewConfig; owned: string[]; used: string[] }
/** A project reached only through entries that hold other projects, its changed files reviewed by their owners. */
export interface CheckOnly { project: ReviewConfig; used: string[]; by: string[] }
/** A project whose changed files are all documentation: no round, no type check. */
export interface DocsOnly { project: ReviewConfig; files: string[] }
export interface Routing { routed: Routed[]; notReviewed: string[]; docsOnly: DocsOnly[]; uncovered: { path: string; reason: string }[];
  /** Files routed to a project that owns them only by `**` while review.yaml lists them as uncovered: reviewed with
   * the rest, but not tested, and reported so. `uncovered` keeps its meaning (no project covers it). */
  declared: { path: string; reason: string }[];
  checkOnly: CheckOnly[] }

/** Whether a path review.yaml lists as uncovered keeps `project` from reaching it through `uses`: it is a source file in
 * another language than the project's (its tests cannot run it). Shared code in the project's own language stays
 * reviewed through the projects that use it. */
export function usesBlocked(project: ReviewConfig, path: string, listed: boolean): boolean {
  const lang = listed ? sourceLanguageOf(path) : null;
  return !!lang && lang.id !== project.language;
}

const DOC_EXT = new Set([".md", ".mdx", ".rst", ".adoc", ".txt"]);
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico", ".bmp"]);
const TOP_DOC = /^(README|LICENSE|LICENCE|CHANGELOG|CONTRIBUTING|AUTHORS)([-._].*)?$/i;
const DOCS_DIR = /(^|\/)(docs?|documentation)\//;
const DATA_DIR = /(^|\/)(tests?|__tests__|fixtures?|testdata|spec|specs)\//;
const CODE_TXT = /^(requirements|constraints)[^/]*\.txt$|^CMakeLists\.txt$/i;

/** Whether a changed path is documentation by where it sits: in a docs/, doc/ or documentation/ folder at any depth
 * (prose, text or an image), a top-level README, LICENSE, CHANGELOG, CONTRIBUTING or AUTHORS file, markdown under
 * .github/, or a changeset. Every other .md or .rst (a prompt, a template) is reviewed, and code never is
 * documentation, wherever it sits (a docstring lives in a .py file), nor is anything under a tests folder or a
 * dependency list. Whether another file names it is docsFilter's to tell. */
export function isDocFile(path: string): boolean {
  const base = posix.basename(path);
  const ext = extname(base).toLowerCase();
  if (isTestPath(path) || DATA_DIR.test(path) || CODE_TXT.test(base)) return false;
  if (path.startsWith(".changeset/")) return true;
  if (path.startsWith(".github/")) return ext === ".md" || ext === ".mdx";
  if (DOCS_DIR.test(path)) return DOC_EXT.has(ext) || IMAGE_EXT.has(ext);
  return !path.includes("/") && TOP_DOC.test(base) && (ext === "" || DOC_EXT.has(ext));
}

/** Which changed paths count as documentation in one review: isDocFile, except a file some tracked file names (a test,
 * a loader, a Dockerfile COPY, a script, CI) by its path or, unless it is README.md or index.md, its name is data
 * for something and is reviewed as before. `all` (--docs) makes none. `head`: the reviewed commit; null reads the
 * working tree, untracked files too. A search that fails means the file is not documentation. */
export function docsFilter(repo: string, head: string | null, all: boolean): (path: string) => boolean {
  if (all) return () => false;
  const memo = new Map<string, boolean>();
  const isRead = (path: string): boolean => {
    const base = posix.basename(path);
    const needles = [path, ...(base === "README.md" || base === "index.md" ? [] : [base])];
    const args = ["-C", repo, "grep", "-I", "-l", "-F", ...(head ? [] : ["--untracked"]),
      ...needles.flatMap((n) => ["-e", n]), ...(head ? [head] : [])];
    const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    if (r.error || (r.status !== 0 && r.status !== 1)) return true; // unknown: reviewed
    return r.stdout.split("\n").map((l) => (head && l.startsWith(`${head}:`) ? l.slice(head.length + 1) : l))
      .some((p) => p && p !== path && !isDocFile(p));
  };
  return (path) => {
    if (!isDocFile(path)) return false;
    if (!memo.has(path)) memo.set(path, !isRead(path));
    return memo.get(path)!;
  };
}

export const NO_PROJECT = "no project covers it";

const bare = (p: string) => p.replace(/^\/+/, "").replace(/\/+$/, "");

/** Whether a `uses` entry holds another project's root: it matches inside that root and is not that root itself. */
export function holdsProject(entry: string, self: ReviewConfig, all: readonly ReviewConfig[]): boolean {
  // An entry naming a project's root is a dependency on that project, even when its folder holds a nested project.
  if (all.some((p) => p !== self && bare(entry) === bare(p.workdir))) return false;
  const m = matcher(entry);
  return all.some((p) => p !== self && !["", "."].includes(bare(p.workdir)) && bare(entry) !== bare(p.workdir) &&
    m(`${bare(p.workdir)}/arnx-probe`));
}

export function route(file: ReviewFile, changed: string[], maxProjects: number,
                      isDoc: (path: string) => boolean = isDocFile): Routing {
  const projects = file.projects.map((project) => {
    const deps = project.uses.filter((u) => !holdsProject(u, project, file.projects));
    return { project, owns: matcher(project.owns.join("\n")), uses: matcher(project.uses.join("\n")),
      depends: matcher(deps.join("\n")), owned: [] as string[], used: [] as string[], throughDeps: false };
  });
  const reasons = file.uncovered.map((u) => ({ test: matcher(u.path), reason: u.reason }));
  const uncovered: Routing["uncovered"] = [];
  const declared: Routing["declared"] = [];
  // A project that owns all by `**` does not own a path in particular: the entry under uncovered says what it is.
  const broad = (p: { project: ReviewConfig }) => p.project.owns.some((o) => bare(o) === "**");
  for (const path of changed) {
    let covered = false;
    // A path review.yaml lists as uncovered, in another language than a project's, is not reached through its `uses`.
    const isListed = reasons.some((r) => r.test(path));
    for (const p of projects) {
      if (p.owns(path)) {
        p.owned.push(path);
        covered = true;
      } else if (!usesBlocked(p.project, path, isListed) && p.uses(path)) {
        p.used.push(path);
        if (p.depends(path)) p.throughDeps = true;
        covered = true;
      }
    }
    // A doc no project covers is nothing to cover.
    if (!covered) {
      if (!isDoc(path)) uncovered.push({ path, reason: reasons.find((r) => r.test(path))?.reason ?? NO_PROJECT });
    } else {
      const listed = reasons.find((r) => r.test(path));
      // A project's own root (owns without `**`) wins over a broad entry.
      if (listed && !projects.some((p) => p.owns(path) && !broad(p))) declared.push({ path, reason: listed.reason });
    }
  }
  const reached = projects.filter((p) => p.owned.length || p.used.length);
  // A project reached by documentation alone gets no round and no type check.
  const docsOnly = reached.filter((p) => [...p.owned, ...p.used].every(isDoc))
    .map((p) => ({ project: p.project, files: [...p.owned, ...p.used] }));
  const hit = reached.filter((p) => ![...p.owned, ...p.used].every(isDoc))
    .sort((a, b) => b.owned.length - a.owned.length || (a.project.name < b.project.name ? -1 : 1));
  const ownersOf = (path: string, among: typeof hit) => among.filter((q) => q.owned.includes(path));
  // Reached only through entries holding other projects, every changed file it reaches owned by another project here.
  const containers = new Set(hit.filter((p) => !p.owned.length && !p.throughDeps &&
    p.used.every((f) => ownersOf(f, hit).some((q) => q !== p))));
  const agents = hit.filter((p) => !containers.has(p));
  const routed = agents.slice(0, maxProjects);
  const notReviewed = agents.slice(maxProjects);
  const checkOnly: CheckOnly[] = [];
  for (const c of hit.filter((p) => containers.has(p))) {
    // Its files must be reviewed by an owner that got a round; else it reviews them itself, as before.
    if (c.used.every((f) => ownersOf(f, routed).length)) {
      checkOnly.push({ project: c.project, used: c.used,
        by: [...new Set(c.used.flatMap((f) => ownersOf(f, routed).map((q) => q.project.name)))].sort() });
    } else if (routed.length < maxProjects) routed.push(c);
    else notReviewed.push(c);
  }
  return {
    routed: routed.map(({ project, owned, used }) => ({ project, owned, used })),
    notReviewed: notReviewed.map((p) => p.project.name),
    docsOnly, uncovered, declared, checkOnly,
  };
}



/** Reasons arnx states itself for a group of source files no project owns or uses. */
export const NO_TESTS = "no tests";
export const SCRIPTS = "scripts";

/** Whether an entry under uncovered is left out for a reason of arnx's own that a review's setup cannot change: browser
 * tests, a web UI app, scripts, no tests, a project needing many services, a language arnx does not review. */
export function keptOut(reason: string): boolean {
  const r = reason.trim().toLowerCase();
  return r.startsWith(BROWSER_TESTS) || r.startsWith(WEB_UI.toLowerCase()) || r === SCRIPTS || r === NO_TESTS ||
    reason.includes(MANY_SERVICES_SAID) || /arnx does not review it yet$/.test(reason);
}

/** What a review sets up before it runs: the changed source files no project covers (`files`), and the parts they are
 * in (`parts`: their entry under uncovered, or the folder of a file no entry lists). Left out: files in a language arnx
 * does not review, entries kept out for arnx's own reason (keptOut; a "no tests" entry that holds tests counts),
 * and parts a review's setup already failed on (`failed`). `why`: each part's reason, short (the entry's up to its colon; "not set up yet" for a file no entry lists). */
export function setupParts(file: ReviewFile, changed: string[], failed: Set<string>,
                           hasTests: (path: string) => boolean): { files: string[]; parts: string[]; why: string[] } {
  const entries = file.uncovered.map((u) => ({ ...u, test: matcher(u.path) }));
  const files: string[] = [];
  const parts: string[] = [];
  const why: string[] = [];
  for (const u of route(file, changed.filter((f) => SOURCE.test(f)), Number.MAX_SAFE_INTEGER).uncovered) {
    if (otherLanguageOf(u.path)) continue;
    const entry = entries.find((e) => e.test(u.path));
    if (entry && keptOut(entry.reason) && !(entry.reason.trim().toLowerCase() === NO_TESTS && hasTests(entry.path))) {
      continue;
    }
    const dir = posix.dirname(u.path);
    const part = entry?.path ?? (dir === "." ? `/${u.path}` : `/${dir}/`);
    if (failed.has(part)) continue;
    files.push(u.path);
    if (!parts.includes(part)) {
      parts.push(part);
      why.push(entry ? (entry.reason.split(":")[0] ?? "").trim() : "not set up yet");
    }
  }
  return { files, parts, why };
}

/** Why a review of `changed` cannot run: no project covers any of it (each file with the reason it is uncovered).
 * Null when a project reviews it. */
export function uncoveredChange(file: ReviewFile, changed: string[], maxProjects: number,
                                isDoc: (path: string) => boolean = isDocFile): string | null {
  const routing = route(file, changed, maxProjects, isDoc);
  // Nothing covers it and nothing is left but documentation: the review says it has nothing to test.
  if (routing.routed.length || !routing.uncovered.length) return null;
  const paths = routing.uncovered.map((u) => `${u.path} (${u.reason})`).join(", ");
  return `no project covers this change: ${paths}. Run \`arnx setup --add\` to cover these paths. arnx works best on single-package Python and TypeScript repos; browser-only tests aren't run.`;
}
