// arnx remove: what arnx put in this repository, listed (nothing deleted), then deleted with --yes: .arnx/,
// .arnxignore, the skill in the repository, this repository's environment images and the pins arnx keeps for it
// outside the repository. Files git tracks are never deleted here: arnx prints the `git rm` that removes them, so the
// removal shows in a commit. Accepted tests (.arnx/tests/) are the repository's own tests once committed: kept
// unless --tests.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, relative, sep } from "node:path";
import { git } from "./change";
import { ACCEPTED_RECORD } from "./check";
import { type EnvImage, repoImages } from "./envprune";
import { ArnxError } from "./errors";
import { FILE as IGNORE_FILE } from "./ignore";
import { docker } from "./sandbox";
import { SKILL_DIRS } from "./skill";
import { DOME } from "./testround";

export interface RemovePlan {
  /** What `targets` names, as shown: a folder with a slash. */
  targets: { path: string; files: number }[];
  /** Files git does not track, under the targets: deleted with --yes. Repository-relative. */
  untracked: string[];
  /** Files git tracks, under the targets: left for `git rm`. */
  tracked: string[];
  /** This repository's environment images; null when Docker could not be asked (`docker` says why). */
  images: EnvImage[] | null;
  docker: string | null;
  /** The pin file arnx keeps for this clone outside it (absent: none). */
  pins: string | null;
  /** Accepted test files left in place: all of them without --tests; with it, the uncommitted ones edited since accept
   * (their content no longer matches the record), which deleting would lose. */
  keptTests: string[];
  /** Of keptTests, those kept because they were edited (--tests). */
  editedTests: string[];
}

/** Whether a repository-relative path stays in the repository: relative, no `..`, and no folder on the way to it is a
 * symlink (which would lead outside). The path itself may be a symlink: deleting it removes the link, not its target. */
export function inRepo(repo: string, path: string): boolean {
  const n = normalize(path);
  if (!n || isAbsolute(n) || n === ".." || n.startsWith(`..${sep}`)) return false;
  const parts = n.split(sep);
  for (let i = 1; i < parts.length; i++) {
    if (isLink(join(repo, ...parts.slice(0, i)))) return false;
  }
  return true;
}

/** Every file (and symlink) under `path`, repository-relative; a missing path, or one outside the repository, has none.
 * Symlinks are listed, never followed. */
function filesUnder(repo: string, path: string): string[] {
  if (!inRepo(repo, path)) return [];
  const abs = join(repo, path);
  if (!existsSync(abs) && !isLink(abs)) return [];
  if (!lstatSync(abs).isDirectory()) return [path];
  return readdirSync(abs).flatMap((name) => filesUnder(repo, join(path, name)));
}

function isLink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

/** The files the accepted-tests record names, as recorded (repository-relative, posix), with each one's recorded
 * sha256 (null when the entry has none). Paths that would leave the repository are dropped. */
export function acceptedRecord(repo: string): Map<string, string | null> {
  try {
    const d = JSON.parse(readFileSync(join(repo, ACCEPTED_RECORD), "utf8")) as
      { files?: Record<string, { sha256?: unknown } | null> };
    return new Map(Object.entries(d.files ?? {}).filter(([p]) => inRepo(repo, p)).sort(([a], [b]) => a < b ? -1 : 1)
      .map(([p, e]) => [p, typeof e?.sha256 === "string" ? e.sha256 : null]));
  } catch {
    return new Map();
  }
}

export const acceptedFiles = (repo: string): string[] => [...acceptedRecord(repo).keys()];

const sha256 = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");

const posix = (p: string) => p.split(sep).join("/");

/** What git tracks among `paths`; empty outside a git repository. A repository whose git cannot answer (a damaged
 * index, say) stops the removal: any of the files might be committed, and deleting them is what this must not do. */
function trackedIn(repo: string, paths: string[]): Set<string> {
  if (!paths.length) return new Set();
  try {
    git(repo, ["rev-parse", "--git-dir"]);
  } catch {
    return new Set(); // not a git repository: nothing is tracked
  }
  try {
    return new Set(git(repo, ["--literal-pathspecs", "ls-files", "-z", "--", ...paths]).split("\0").filter(Boolean));
  } catch (e) {
    throw new ArnxError(`git cannot say which of arnx's files are committed (${(e as Error).message}); nothing was ` +
      "deleted. Repair the repository (`git status` shows what is wrong), then run arnx remove again");
  }
}

export function planRemove(repo: string, o: { tests: boolean; pins: string | null }): RemovePlan {
  const record = acceptedRecord(repo);
  const accepted = [...record.keys()].filter((p) => existsSync(join(repo, p)));
  // Accepted tests in .arnx/tests/ are under .arnx already; an older arnx's are in the project.
  const roots = [".arnx", IGNORE_FILE, ...SKILL_DIRS, ...(o.tests ? accepted.filter((p) => !p.startsWith(".arnx/")) : [])];
  let targets = roots.map((path) => ({ path, files: filesUnder(repo, path).map(posix) })).filter((t) => t.files.length);
  let tracked = trackedIn(repo, targets.map((t) => t.path));
  // --tests: an uncommitted accepted test whose content changed since accept holds the user's edits: kept.
  const edited = o.tests ? accepted.filter((p) => !tracked.has(p) && record.get(p) !== sha256(join(repo, p))) : [];
  // The accepted tests in .arnx/tests/ stay with .arnx/ going, unless --tests (and then the edited ones still stay).
  const stays = (p: string) => p.startsWith(`${DOME}/`) && (!o.tests || edited.includes(p));
  targets = targets.map((t) => ({ ...t, files: t.files.filter((p) => !stays(p)) })).filter((t) => t.files.length);
  if (edited.length) {
    targets = targets.filter((t) => !edited.includes(t.path));
    tracked = new Set([...tracked].filter((p) => !edited.includes(p)));
  }
  tracked = new Set([...tracked].filter((p) => !stays(p)));
  const all = [...new Set(targets.flatMap((t) => t.files))];
  let images: EnvImage[] | null = null;
  let docker: string | null = null;
  try {
    images = repoImages(repo);
  } catch (e) {
    docker = (e as Error).message; // Docker missing or not answering: the files are still removed
  }
  return {
    targets: targets.map((t) => ({ path: t.path + (lstatSync(join(repo, t.path)).isDirectory() ? "/" : ""),
      files: t.files.length })),
    untracked: all.filter((p) => !tracked.has(p)), tracked: all.filter((p) => tracked.has(p)), images, docker,
    pins: o.pins && existsSync(o.pins) ? o.pins : null, keptTests: o.tests ? edited : accepted, editedTests: edited,
  };
}

/** Deletes what the plan lists that may be deleted here: untracked files (then the folders they leave empty), the
 * images and the pin file. Returns what could not be deleted, and why. */
export function applyRemove(repo: string, plan: RemovePlan): [string, string][] {
  const failed: [string, string][] = [];
  const dirs = new Set<string>();
  for (const p of plan.untracked) {
    if (!inRepo(repo, p)) continue; // never reached: the plan holds only paths in the repository
    try {
      rmSync(join(repo, p), { force: true });
      dirs.add(dirname(join(repo, p)));
    } catch (e) {
      failed.push([p, (e as Error).message]);
    }
  }
  // Folders emptied by the removal, deepest first, up to (not including) the repository.
  const emptied = [...dirs].flatMap((d) => {
    const up: string[] = [];
    for (let at = d; relative(repo, at) && !relative(repo, at).startsWith(".."); at = dirname(at)) up.push(at);
    return up;
  });
  for (const d of [...new Set(emptied)].sort((a, b) => b.length - a.length)) {
    try {
      if (existsSync(d) && !readdirSync(d).length) rmdirSync(d);
    } catch {
      // still in use or not ours to remove: left
    }
  }
  for (const img of plan.images ?? []) {
    const r = docker(["image", "rm", img.tag]);
    if (r.status !== 0) failed.push([img.tag, (r.stderr || r.stdout).trim().split("\n")[0] ?? ""]);
  }
  if (plan.pins) {
    try {
      rmSync(plan.pins, { force: true });
    } catch (e) {
      failed.push([plan.pins, (e as Error).message]);
    }
  }
  return failed;
}
