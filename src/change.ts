// What to review: on a branch, everything since it left the default branch (plus uncommitted work); otherwise
// uncommitted work, else the last commit; or an explicit range A..B; with no commits yet, every file. Uncommitted work
// is tracked files only (staged, unstaged, and new files `git add`ed): untracked files go into the change and the
// snapshot only when the owner opts in (--untracked, or [review] untracked), or when there are no commits yet. The
// snapshot is the code at the change's head with secrets left out; tests run against the snapshot, never the user's
// checkout.
import { spawnSync } from "node:child_process";
import {
  copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync,
  symlinkSync, unlinkSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { ArnxError, ChangeTooLarge, NoChange, SetupRequired } from "./errors";
import { isLockfile, loadIgnore } from "./ignore";
import { excludePathspecs, firstUnpinned, isSecretPath, type SecretPin } from "./secrets";
import { splitLines } from "./util";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const MAX_DIFF_BYTES = 200_000;
export const SCAN_LIMIT = 1_000_000;
/** Mutable so tests can lower it. */
export const changeLimits = { maxSnapshotFiles: 20_000 };
const MAX_BUFFER = 1 << 30;

export interface Change {
  kind: "worktree" | "commit" | "range" | "branch" | "no-commits";
  base: string;
  head: string | null;
  diff: string;
  files: string[];
  /** kind "branch": the branch, the default branch it left, and how many commits it has since. */
  branch?: { name: string; onto: string; commits: number };
  /** Untracked tests `arnx accept` wrote, left out of the change (arnx does not review its own tests). */
  leftOut?: string[];
  /** Changed files .arnxignore leaves out: not reviewed, and named so that is not silent. */
  ignored?: string[];
  /** Changed lockfiles: kept in the snapshot (installs need them), their text not sent (it is generated). */
  lockfiles?: string[];
  /** The working-tree snapshot copies untracked files too: opted in, or no commits yet (absent: tracked only). */
  withUntracked?: true;
  /** Opted in (a repository with commits): the untracked files the change holds, sent like the rest. */
  untrackedIncluded?: string[];
  /** Not opted in: untracked files left out of the change and the snapshot (git- and .arnxignore-ignored ones, and
   * arnx's own accepted tests, are not counted here). */
  untrackedLeftOut?: string[];
}

/** A path `arnx accept` writes: an `r<review id>/` folder (Python, TypeScript) or an `arnx_<review id>_` file (Rust). */
export const ACCEPTED_TEST = /(?:^|\/)r\d{8}_[0-9a-f]{6}\/|(?:^|\/)arnx_\d{8}_[0-9a-f]{6}_[^/]*$/;

export const added = (c: Change) =>
  splitLines(c.diff).filter((l) => l.startsWith("+") && !l.startsWith("+++")).length;
export const removed = (c: Change) =>
  splitLines(c.diff).filter((l) => l.startsWith("-") && !l.startsWith("---")).length;

/** The parts of a diff that touch `files` (paths as git prints them), in diff order. */
export function sliceDiff(diff: string, files: Iterable<string>): string {
  const keep = new Set(files);
  const unquote = (p: string) => p.replace(/^"|"$/g, "").replace(/^[ab]\//, "");
  return diff.split(/^(?=diff --git )/m).filter((part) => {
    const plus = /^\+\+\+ (.+)$/m.exec(part)?.[1];
    const minus = /^--- (.+)$/m.exec(part)?.[1];
    const header = /^diff --git a\/(.+?) b\/(.+)$/m.exec(part);
    const paths = [plus, minus].filter((p): p is string => !!p && p !== "/dev/null").map(unquote);
    if (header) paths.push(header[1]!, header[2]!);
    return paths.some((p) => keep.has(p));
  }).join("");
}

export function describe(c: Change): string {
  if (c.kind === "branch" && c.branch) {
    const { name, onto, commits } = c.branch;
    return `branch ${name}: ${commits} commit${commits === 1 ? "" : "s"} since ${onto} (${c.base.slice(0, 7)})` +
      (c.head === null ? " and uncommitted work" : "");
  }
  if (c.kind === "worktree") return `uncommitted (base ${c.base.slice(0, 7)})`;
  if (c.kind === "no-commits") return "all files (no commits yet)";
  if (c.kind === "commit") return `commit ${(c.head ?? "").slice(0, 7)}`;
  return `range ${c.base.slice(0, 7)}..${(c.head ?? "").slice(0, 7)}`;
}

export function git(repo: string, args: string[], ok: number[] = [0]): string {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: MAX_BUFFER });
  if (r.error) throw new SetupRequired(`git could not run: ${r.error.message}`);
  if (!ok.includes(r.status ?? -1)) {
    throw new ArnxError(`git ${args.slice(0, 2).join(" ")} failed: ${r.stderr.trim().slice(0, 300)}`);
  }
  return r.stdout;
}

export function repoRoot(cwd: string): string {
  const r = spawnSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8" });
  if (r.status !== 0) throw new SetupRequired("not inside a git repository");
  return realpathSync(r.stdout.trim());
}

const names = (out: string) => out.split("\0").filter(Boolean);

function commitOf(repo: string, rev: string): string {
  const sha = git(repo, ["rev-parse", "--verify", "-q", rev + "^{commit}"], [0, 1]).trim();
  if (!sha) throw new ArnxError(`unknown revision '${rev}'`);
  return sha;
}

/** Where the current branch left the default branch: the remote's default (origin/HEAD), main or master, local or on
 * origin; the closest fork point wins. Null on the default branch itself, detached, or with no commits of its own. */
export function branchBase(repo: string): Change["branch"] & { base: string } | null {
  const name = git(repo, ["symbolic-ref", "--short", "-q", "HEAD"], [0, 1]).trim();
  if (!name) return null;
  const remoteDefault = git(repo, ["symbolic-ref", "--short", "-q", "refs/remotes/origin/HEAD"], [0, 1, 128]).trim();
  const candidates = [...new Set([remoteDefault.replace(/^origin\//, ""), "main", "master"].filter(Boolean))]
    .flatMap((b) => [b, `origin/${b}`]);
  let best: { name: string; onto: string; commits: number; base: string } | null = null;
  for (const onto of candidates) {
    if (onto === name || !git(repo, ["rev-parse", "--verify", "-q", `${onto}^{commit}`], [0, 1]).trim()) continue;
    const base = git(repo, ["merge-base", "HEAD", onto], [0, 1]).trim();
    if (!base) continue;
    const commits = Number(git(repo, ["rev-list", "--count", `${base}..HEAD`]).trim());
    // A ref at or ahead of HEAD (main itself, or origin/HEAD naming this branch) is not where the branch left.
    if (commits > 0 && (!best || commits < best.commits)) best = { name, onto, commits, base };
  }
  return best;
}

export const hasCommits = (repo: string) => !!git(repo, ["rev-parse", "--verify", "-q", "HEAD"], [0, 1]).trim();

/** Untracked files are sent: the owner opted in, or the repository has no commits yet (then every file is new, and a
 * review of tracked files alone would review nothing). */
export const sendsUntracked = (repo: string, optIn: boolean) => optIn || !hasCommits(repo);

/** `allow`: files the user allowed although they hold key-shaped text (review.yaml allow_secret_looking).
 * `untracked`: the owner opted in to untracked files (ignored with no commits yet, when every file is sent). */
export function resolveChange(repo: string, range: string | null = null, allow: readonly SecretPin[] = [],
                              o: { untracked?: boolean } = {}): Change {
  const born = hasCommits(repo);
  const withUntracked = !born || !!o.untracked;
  if (!born && range) {
    throw new ArnxError("the repository has no commits yet, so --range has nothing to name; commit first");
  }
  const ex = excludePathspecs();
  const ignored = loadIgnore(repo);
  const ignoredOut = new Set<string>(), lockOut = new Set<string>();
  const trackedDiff = (...revs: string[]): [string, string[]] => {
    const changed = names(git(repo, ["diff", "-z", "--name-only", ...revs, "--", ".", ...ex]));
    changed.filter(ignored).forEach((p) => ignoredOut.add(p));
    changed.filter((p) => !ignored(p) && isLockfile(p)).forEach((p) => lockOut.add(p));
    const out = (p: string) => ignored(p) || isLockfile(p);
    const skip = changed.filter(out).map((p) => `:(exclude,literal)${p}`);
    return [git(repo, ["diff", "--no-color", ...revs, "--", ".", ...ex, ...skip]), changed.filter((p) => !out(p))];
  };
  let kind: Change["kind"], base: string, head: string | null, diff: string, files: string[];
  let branch: Change["branch"];
  // Accepted tests not committed yet are arnx's own output, not the developer's change: they neither make the tree
  // dirty nor go into the diff.
  const leftOut: string[] = [];
  // A status line's path (the new one of a rename); files .arnxignore leaves out do not make the tree dirty either.
  const pathOf = (l: string) => (l.slice(3).split(" -> ").at(-1) ?? "").replace(/^"|"$/g, "");
  // Untracked files make the tree dirty only when they are sent.
  const dirty = () => git(repo, ["status", "--porcelain", "--untracked-files=all", "--", ".", ...ex]).split("\n")
    .some((l) => l.trim() && !ignored(pathOf(l)) && !(l.startsWith("?? ") && (!withUntracked ||
      ACCEPTED_TEST.test(pathOf(l)))));
  const others = () => names(git(repo, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", ...ex]));
  const included: string[] = [], notSent: string[] = [];
  const untracked = () => {
    for (const path of others()) {
      if (ignored(path)) {
        if (withUntracked) ignoredOut.add(path);
        continue;
      }
      if (ACCEPTED_TEST.test(path)) {
        leftOut.push(path);
        continue;
      }
      if (withUntracked && isLockfile(path)) {
        lockOut.add(path);
        continue;
      }
      if (!withUntracked) {
        notSent.push(path);
        continue;
      }
      diff += git(repo, ["diff", "--no-color", "--no-index", "--", "/dev/null", path], [0, 1]);
      files.push(path);
      included.push(path);
    }
  };
  const fork = range || !born ? null : branchBase(repo);
  if (!born) {
    // No commits yet: every file a working-tree snapshot holds is new, staged (in the index) or not.
    [kind, base, head] = ["no-commits", EMPTY_TREE, null];
    [diff, files] = trackedDiff(EMPTY_TREE);
    untracked();
  } else if (fork) {
    const { base: at, ...info } = fork;
    [kind, base, branch] = ["branch", at, info];
    if (dirty()) {
      head = null;
      [diff, files] = trackedDiff(base);
      untracked();
    } else {
      head = commitOf(repo, "HEAD");
      [diff, files] = trackedDiff(base, head);
    }
  } else if (range) {
    const at = range.indexOf("..");
    const [a, b] = at < 0 ? ["", ""] : [range.slice(0, at), range.slice(at + 2)];
    if (!a || !b) throw new ArnxError("--range must look like A..B");
    [kind, base, head] = ["range", commitOf(repo, a), commitOf(repo, b)];
    [diff, files] = trackedDiff(base, head);
  } else if (dirty()) {
    [kind, base, head] = ["worktree", commitOf(repo, "HEAD"), null];
    [diff, files] = trackedDiff("HEAD");
    untracked();
  } else {
    head = commitOf(repo, "HEAD");
    base = git(repo, ["rev-parse", "--verify", "-q", "HEAD^"], [0, 1]).trim() || EMPTY_TREE;
    kind = "commit";
    [diff, files] = trackedDiff(base, head);
  }
  // A commit (or a branch's commits) reviewed while untracked files are left out: they are named all the same.
  if (!withUntracked && kind !== "range" && head !== null) {
    notSent.push(...leftOutUntracked(repo));
  }
  if (!diff.trim()) {
    throw new NoChange("nothing to review: the change is empty" +
      (lockOut.size ? ` (only lockfiles changed: ${someNames([...lockOut].sort(), 3)})` : "") +
      (notSent.length ? `; ${leftOutText(notSent.length)}` : ""));
  }
  const size = Buffer.byteLength(diff);
  if (size > MAX_DIFF_BYTES) {
    // The first commit holds every file, and --range cannot split one commit.
    const root = kind === "commit" && base === EMPTY_TREE;
    throw new ChangeTooLarge(`the change is ${Math.floor(size / 1000)} KB; arnx reviews up to ${MAX_DIFF_BYTES / 1000} KB ` +
      `(largest: ${largestFiles(diff)}). ` +
      (root ? "This is the repository's first commit, so it holds every file. Make your next change on a branch: " +
          "`arnx review` reviews that"
        : kind === "branch" ? "Review it in parts with --range A..B (for example a few commits at a time)"
        : kind === "no-commits" ? "With no commits yet --range has nothing to name: commit part of the files first " +
          "(data, vendored or generated code), and `arnx review` then reviews the rest; or leave data files out with " +
          ".arnxignore"
        : "Narrow it with --range"), root);
  }
  const secret = secretInDiff(diff, allow);
  if (secret) {
    throw new ArnxError(`the change contains text that looks like a secret (a key or token) in ${secret.path} ` +
      `(${secret.label}); arnx will not send it to a model. If it is a test fixture, not a secret, allow the file: ` +
      `\`arnx allow-secret ${secret.path}\`, then \`arnx approve\``);
  }
  return { kind, base, head, diff, files: [...new Set(files)].sort(), ...(branch ? { branch } : {}),
    ...(leftOut.length ? { leftOut } : {}), ...(ignoredOut.size ? { ignored: [...ignoredOut].sort() } : {}),
    ...(lockOut.size ? { lockfiles: [...lockOut].sort() } : {}),
    ...(withUntracked && head === null ? { withUntracked: true as const } : {}),
    ...(born && included.length ? { untrackedIncluded: included.sort() } : {}),
    ...(notSent.length ? { untrackedLeftOut: notSent.sort() } : {}) };
}

/** The three files taking most of a diff, with their sizes ("package-lock.json 173 KB, README.md 25 KB, …"). */
function largestFiles(diff: string): string {
  const parts = diff.split(/^(?=diff --git )/m).map((part) => {
    const path = /^\+\+\+ b\/(.+)$/m.exec(part)?.[1] ?? /^--- a\/(.+)$/m.exec(part)?.[1] ?? "?";
    return { path, kb: Math.max(1, Math.floor(Buffer.byteLength(part) / 1000)) };
  }).sort((a, b) => b.kb - a.kb);
  return parts.slice(0, 3).map((p) => `${p.path} ${p.kb} KB`).join(", ");
}

const fileCount = (n: number) => `${n} file${n === 1 ? "" : "s"}`;
/** Up to `max` names, then how many more. */
export const someNames = (xs: readonly string[], max = 10) =>
  xs.slice(0, max).join(", ") + (xs.length > max ? ` (+${xs.length - max} more)` : "");
const leftOutText = (n: number) =>
  `${n} untracked ${n === 1 ? "file" : "files"} left out (\`--untracked\` includes them)`;

/** What the change sends beyond tracked files, or leaves out of them, in one line; null when there is nothing to say
 * (no untracked files, or a range). The review's start line and `arnx next` show it. */
export function untrackedLine(c: Change): string | null {
  if (c.kind === "no-commits") {
    return `no commits yet: every file is sent (${fileCount(c.files.length)})`;
  }
  if (c.untrackedIncluded?.length) {
    return `including ${c.untrackedIncluded.length} untracked ${c.untrackedIncluded.length === 1 ? "file" : "files"} ` +
      `(--untracked): ${someNames(c.untrackedIncluded)}`;
  }
  if (c.untrackedLeftOut?.length) return `${leftOutText(c.untrackedLeftOut.length)}: ${someNames(c.untrackedLeftOut)}`;
  return null;
}

/** The first file of `diff` holding key-shaped text that `allow` does not pin for it. */
function secretInDiff(diff: string, allow: readonly SecretPin[]): { path: string; label: string } | null {
  for (const section of diff.split(/^(?=diff --git )/m)) {
    const path = /^\+\+\+ b\/(.*)$/m.exec(section)?.[1] ?? /^--- a\/(.*)$/m.exec(section)?.[1] ?? "";
    const hit = firstUnpinned(section, allow.find((a) => a.path === path)?.matches ?? []);
    if (hit) return { path: path || "the change", label: hit.label };
  }
  return null;
}

/** The files a working-tree snapshot copies before scrubbing: tracked (in the index), and with `untracked` (or no
 * commits yet) untracked ones git does not ignore (`untracked` names the latter). Counts shown to the owner use this
 * list, so they agree with what arnx reads. */
export function workingTreeFiles(repo: string, untracked = true): { files: string[]; untracked: Set<string> } {
  // Accepted tests not committed yet are arnx's own output, not the owner's files: kept either way, so a review
  // after accept still runs them (they never go into the diff: resolveChange leaves them out).
  const all = names(git(repo, ["ls-files", "-z", "--others", "--exclude-standard"]));
  const others = new Set(sendsUntracked(repo, untracked) ? all : all.filter((p) => ACCEPTED_TEST.test(p)));
  return { files: [...new Set([...names(git(repo, ["ls-files", "-z"])), ...others])], untracked: others };
}

/** Untracked files a review leaves out unless the owner opts in: git does not ignore them, nor .arnxignore, and they
 * are not arnx's own accepted tests or secret files. None with no commits yet, when every file is sent. */
export function leftOutUntracked(repo: string): string[] {
  if (!hasCommits(repo)) return [];
  const ignored = loadIgnore(repo);
  return names(git(repo, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", ...excludePathspecs()]))
    .filter((p) => !ignored(p) && !ACCEPTED_TEST.test(p)).sort();
}

/** The files a snapshot of `head` (the working tree when null; untracked files only with `untracked`, or no commits
 * yet) copies before scrubbing, .arnxignore applied. */
export function filesAt(repo: string, head: string | null, untracked = false): string[] {
  const ignored = loadIgnore(repo);
  return (head === null ? workingTreeFiles(repo, untracked).files
    : names(git(repo, ["ls-tree", "-r", "-z", "--name-only", head]))).filter((p) => !ignored(p));
}

/** A file left out of a snapshot for its content: where its first unallowed key-shaped string is. */
export interface Withheld { path: string; line: number; label: string }

/** Copy the code at `head` (or the working tree when null) to `dest`, then scrub it. Returns the files removed for
 * their content; `allow` keeps files the user allowed while every key-shaped string in them is pinned. A working-tree
 * snapshot holds tracked files only unless `untracked` (or the repository has no commits yet): whatever reads it (an
 * agent, or tests whose output goes to a model) never sees untracked files the owner did not opt in to. */
export function snapshot(repo: string, head: string | null, dest: string, allow: readonly SecretPin[] = [],
                         o: { untracked?: boolean } = {}): Withheld[] {
  mkdirSync(dest, { recursive: true });
  const ignored = loadIgnore(repo);
  const limit = changeLimits.maxSnapshotFiles;
  if (head === null) {
    const paths = workingTreeFiles(repo, !!o.untracked).files.filter((p) => !ignored(p));
    if (paths.length > limit) {
      throw new ArnxError(`the working tree has ${paths.length} files; arnx copies up to ${limit}. ` +
        "Add large generated directories to .gitignore");
    }
    for (const rel of paths) {
      const src = join(repo, rel);
      let st;
      try {
        st = lstatSync(src);
      } catch {
        continue; // deleted in the working tree
      }
      if (!st.isSymbolicLink() && st.isDirectory()) continue; // a submodule
      const out = join(dest, rel);
      mkdirSync(dirname(out), { recursive: true });
      if (st.isSymbolicLink()) symlinkSync(readlinkSync(src), out);
      else copyFileSync(src, out);
    }
  } else {
    const count = names(git(repo, ["ls-tree", "-r", "-z", "--name-only", head])).length;
    if (count > limit) throw new ArnxError(`the commit has more than ${limit} files`);
    const archive = spawnSync("git", ["-C", repo, "archive", "--format=tar", head], { maxBuffer: MAX_BUFFER });
    if (archive.status !== 0) throw new ArnxError(`git archive failed: ${String(archive.stderr).trim().slice(0, 300)}`);
    // -m: files get the extraction time, not the commit time. An environment image can carry a build made after the
    // commit (the Rust target dir), and cargo would otherwise treat the older sources as fresh and run that build.
    const tar = spawnSync("tar", ["-x", "-m", "--no-same-owner", "-C", dest], { input: archive.stdout, encoding: "utf8" });
    if (tar.error || tar.status !== 0) {
      throw new ArnxError(`unpacking the snapshot failed: ${(tar.stderr || tar.error?.message || "").trim().slice(0, 300)}`);
    }
  }
  return scrub(dest, ignored, allow);
}

/** Remove .git, .arnx, paths matched by .arnxignore, secret files, files with secret content and symlinks leaving
 * the tree. Returns the files removed for their content (the others are never expected in a snapshot). */
function scrub(root: string, ignored: (rel: string) => boolean, allow: readonly SecretPin[]): Withheld[] {
  const realRoot = realpathSync(root);
  const removedFiles: Withheld[] = [];
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  const walk = (dir: string, relDir: string) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        if (name === ".git" || name === ".arnx" || ignored(rel + "/")) rmSync(p, { recursive: true, force: true });
        else walk(p, rel);
        continue;
      }
      if (ignored(rel) || (st.isSymbolicLink() && ignored(rel + "/"))) {
        unlinkSync(p);
        continue;
      }
      if (st.isSymbolicLink()) {
        let target: string;
        try {
          target = realpathSync(p);
        } catch {
          target = resolve(dirname(p), readlinkSync(p));
        }
        if (!inside(target) || isSecretPath(name)) unlinkSync(p);
        continue;
      }
      if (isSecretPath(name)) {
        unlinkSync(p);
        continue;
      }
      const hit = secretContent(p, st.size, allow.find((a) => a.path === rel)?.matches ?? []);
      if (hit) {
        unlinkSync(p);
        removedFiles.push({ path: rel, ...hit });
      }
    }
  };
  walk(root, "");
  return removedFiles.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
}

function secretContent(p: string, size: number, pins: readonly string[]): { line: number; label: string } | null {
  if (size > SCAN_LIMIT) return null;
  try {
    return firstUnpinned(readFileSync(p, "utf8"), pins);
  } catch {
    return null;
  }
}

