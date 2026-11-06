// Routing: which projects review a change. A changed file goes to every project that owns or uses it; a file no
// project covers is reported as not tested, with the reason recorded at setup, never guessed.
//
// A `uses` entry that holds another project's root (a top-level project using `packages/`, which holds
// `packages/api`) contains projects rather than depending on one. A project the change reaches only through such
// entries, whose changed files are all owned by projects reviewed in this run, would review the same files a second
// time: it gets its type check alone (`checkOnly`), no agent round. When any of those files has no owner under review
// (no project owns it, or its owner is over max_projects), it is routed as before, so no changed file leaves the review.
import { posix } from "node:path";
import { BROWSER_TESTS, WEB_UI } from "./browser";
import type { ReviewConfig, ReviewFile } from "./config";
import { MANY_SERVICES_SAID } from "./facts";
import { matcher } from "./ignore";
import { otherLanguageOf, sourceLanguageOf } from "./languages";
import { SOURCE } from "./untested";

export interface Routed { project: ReviewConfig; owned: string[]; used: string[] }
/** A project reached only through entries that hold other projects, its changed files reviewed by their owners. */
export interface CheckOnly { project: ReviewConfig; used: string[]; by: string[] }
export interface Routing { routed: Routed[]; notReviewed: string[]; uncovered: { path: string; reason: string }[];
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

export function route(file: ReviewFile, changed: string[], maxProjects: number): Routing {
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
    if (!covered) uncovered.push({ path, reason: reasons.find((r) => r.test(path))?.reason ?? NO_PROJECT });
    else {
      const listed = reasons.find((r) => r.test(path));
      // A project's own root (owns without `**`) wins over a broad entry.
      if (listed && !projects.some((p) => p.owns(path) && !broad(p))) declared.push({ path, reason: listed.reason });
    }
  }
  const hit = projects.filter((p) => p.owned.length || p.used.length)
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
    uncovered, declared, checkOnly,
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
 * and parts a review's setup already failed on (`failed`). */
export function setupParts(file: ReviewFile, changed: string[], failed: Set<string>,
                           hasTests: (path: string) => boolean): { files: string[]; parts: string[] } {
  const entries = file.uncovered.map((u) => ({ ...u, test: matcher(u.path) }));
  const files: string[] = [];
  const parts: string[] = [];
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
    if (!parts.includes(part)) parts.push(part);
  }
  return { files, parts };
}

/** Why a review of `changed` cannot run: no project covers any of it (each file with the reason it is uncovered).
 * Null when a project reviews it. */
export function uncoveredChange(file: ReviewFile, changed: string[], maxProjects: number): string | null {
  const routing = route(file, changed, maxProjects);
  if (routing.routed.length) return null;
  const paths = routing.uncovered.map((u) => `${u.path} (${u.reason})`).join(", ");
  return `no project covers this change: ${paths}. Run \`arnx setup --add\` to cover these paths`;
}
