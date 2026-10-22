// Routing: which projects review a change. A changed file goes to every project that owns or uses it; a file no
// project covers is reported as not tested, with the reason recorded at setup, never guessed.
//
// A `uses` entry that holds another project's root (a top-level project using `packages/`, which holds
// `packages/api`) contains projects rather than depending on one. A project the change reaches only through such
// entries, whose changed files are all owned by projects reviewed in this run, would review the same files a second
// time: it gets its type check alone (`checkOnly`), no agent round. When any of those files has no owner under review
// (no project owns it, or its owner is over max_projects), it is routed as before, so no changed file leaves the review.
import type { ReviewConfig, ReviewFile } from "./config";
import { matcher } from "./ignore";

export interface Routed { project: ReviewConfig; owned: string[]; used: string[] }
/** A project reached only through entries that hold other projects, its changed files reviewed by their owners. */
export interface CheckOnly { project: ReviewConfig; used: string[]; by: string[] }
export interface Routing { routed: Routed[]; notReviewed: string[]; uncovered: { path: string; reason: string }[];
  checkOnly: CheckOnly[] }

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
  for (const path of changed) {
    let covered = false;
    for (const p of projects) {
      if (p.owns(path)) {
        p.owned.push(path);
        covered = true;
      } else if (p.uses(path)) {
        p.used.push(path);
        if (p.depends(path)) p.throughDeps = true;
        covered = true;
      }
    }
    if (!covered) uncovered.push({ path, reason: reasons.find((r) => r.test(path))?.reason ?? NO_PROJECT });
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
    uncovered, checkOnly,
  };
}

