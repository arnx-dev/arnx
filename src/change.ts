// What to review: on a branch, everything since it left the default branch (plus uncommitted work); otherwise
// uncommitted work, else the last commit; or an explicit range A..B; with no commits yet, every file. Uncommitted work
// is tracked files only (staged, unstaged, and new files `git add`ed): untracked files go into the change and the
// snapshot only when the owner opts in (--untracked, or [review] untracked), or when there are no commits yet. The
// snapshot is the code at the change's head with secrets left out; tests run against the snapshot, never the user's
// checkout.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync,
  rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";
import { ArnxError, ChangeTooLarge, NoChange, SetupRequired } from "./errors";
import { isLockfile, loadIgnore } from "./ignore";
import { excludePathspecs, firstUnpinned, hasKeyBody, isSecretPath, privateKeyBody, scanKeys, type SecretPin,
  standInsFor, suspects } from "./secrets";
import { REPORT_DIR, type Runner } from "./sandbox";
import { standInsSetting } from "./settings";
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
  /** Source files whose diff lines held key-shaped text in comments only: those lines are blanked in `diff`. */
  blanked?: Blanked[];
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
  // Key-shaped text in comments is blanked, as in snapshots: each side of a file is read where the diff took it.
  const show = (rev: string, path: string) => {
    const text = git(repo, ["show", `${rev}:${path}`], [0, 128]);
    return text.length > SCAN_LIMIT ? null : text;
  };
  const blanked = blankDiff(diff, allow, (path) => base === EMPTY_TREE ? null : show(base, path),
    (path) => head === null ? readText(join(repo, path)) : show(head, path));
  diff = blanked.diff;
  const secret = secretInDiff(diff, allow) ?? blanked.secret;
  if (secret) {
    throw new ArnxError(`the change contains text that looks like a secret (a key or token) in ${secret.path} ` +
      `(${secret.label}); arnx will not send it to a model. If it is a test fixture, not a secret, allow the file: ` +
      `\`arnx allow-secret ${secret.path}\`, then \`arnx review\` again`);
  }
  return { kind, base, head, diff, files: [...new Set(files)].sort(), ...(branch ? { branch } : {}),
    ...(leftOut.length ? { leftOut } : {}), ...(ignoredOut.size ? { ignored: [...ignoredOut].sort() } : {}),
    ...(lockOut.size ? { lockfiles: [...lockOut].sort() } : {}),
    ...(withUntracked && head === null ? { withUntracked: true as const } : {}),
    ...(born && included.length ? { untrackedIncluded: included.sort() } : {}),
    ...(notSent.length ? { untrackedLeftOut: notSent.sort() } : {}),
    ...(blanked.files.length ? { blanked: blanked.files } : {}) };
}

/** A file's text, or null when it is missing or too large to scan. */
function readText(p: string): string | null {
  try {
    return statSync(p).size > SCAN_LIMIT ? null : readFileSync(p, "utf8");
  } catch {
    return null;
  }
}

/** `diff` with its lines blanked where each side's file (`before`, `after`: its text by path, null when absent)
 * blanks them (scanKeys): key-shaped text in comments of source files. A file whose key is in code is left as it
 * is, for secretInDiff to refuse. A section of a file with blanked lines loses its hunk headers' function context,
 * which git may take from a key's body. `files`: the lines blanked, numbered in the side each diff line comes from.
 * `secret`: a section showing a key body of a file withheld for a key in code, though no header is in the hunk. */
function blankDiff(diff: string, allow: readonly SecretPin[], before: (path: string) => string | null,
                   after: (path: string) => string | null)
  : { diff: string; files: Blanked[]; secret?: { path: string; label: string } } {
  const files: Blanked[] = [];
  let secret: { path: string; label: string } | undefined;
  const pins = (path: string) => allow.find((a) => a.path === path)?.matches ?? [];
  const sections = diff.split(/^(?=diff --git )/m).map((section) => {
    const oldPath = /^--- a\/(.*)$/m.exec(section)?.[1] ?? null;
    const newPath = /^\+\+\+ b\/(.*)$/m.exec(section)?.[1] ?? null;
    const path = newPath ?? oldPath ?? "";
    // A key-shaped string, or a body line of one (in a line or a hunk header) whose header is outside the hunk.
    if (!firstUnpinned(section, [...new Set([...pins(oldPath ?? ""), ...pins(newPath ?? "")])]) &&
      !hasKeyBody(section)) return section;
    // Each side's blanked lines by number; a side whose key is in code leaves the section as it is.
    const side = (p: string | null, text: (p: string) => string | null): Map<number, string> | null => {
      const t = p === null ? null : text(p);
      const scan = t === null ? null : scanKeys(p!, t, pins(p!));
      if (scan && "withhold" in scan) return null;
      const lines = scan ? scan.text.split("\n") : [];
      return new Map((scan?.blank ?? []).map((n) => [n, lines[n - 1]!]));
    };
    const old = side(oldPath, before), now = side(newPath, after);
    if ((!old || !now) && hasKeyBody(section)) secret ??= { path, label: "a private key" };
    if (!old || !now || (!old.size && !now.size)) return section;
    const done = new Set<number>();
    let a = 0, b = 0, inHunk = false;
    const out = section.split("\n").map((line) => {
      const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (hunk) {
        [a, b, inHunk] = [Number(hunk[1]), Number(hunk[2]), true];
        return hunk[0];
      }
      if (!inHunk || line.startsWith("\\")) return line;
      const mark = line[0];
      let to: string | undefined;
      if (mark === "-") to = old.get(a);
      else if (mark === "+" || mark === " ") to = now.get(b);
      const n = mark === "-" ? a : b;
      if (mark !== "+") a++;
      if (mark !== "-") b++;
      if (to === undefined) return line;
      done.add(n);
      return mark + to;
    });
    if (done.size) files.push({ path, lines: [...done].sort((x, y) => x - y) });
    return out.join("\n");
  });
  return { diff: sections.join(""), files, ...(secret ? { secret } : {}) };
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

/** A source file a snapshot keeps with comment lines blanked: every unallowed key-shaped string in it was inside a
 * comment (scanKeys). */
export interface Blanked { path: string; lines: number[] }

/** Blanked files for a person: path and the lines blanked, runs as ranges ("src/a.ts (lines 3-5, 9)"). */
export function describeBlanked(b: Blanked[]): string {
  return b.map(({ path, lines }) => {
    const runs: string[] = [];
    for (let i = 0; i < lines.length;) {
      let j = i;
      while (j + 1 < lines.length && lines[j + 1] === lines[j]! + 1) j++;
      runs.push(i === j ? `${lines[i]}` : `${lines[i]}-${lines[j]}`);
      i = j + 1;
    }
    return `${path} (line${lines.length === 1 ? "" : "s"} ${runs.join(", ")})`;
  }).join(", ");
}

/** How a snapshot treats what it may not hold as it is. `standIns` (default on: `[review] stand_ins`): a file holding
 * key-shaped text in code is kept with a stand-in for each such string (secrets.ts standIn) instead of left out.
 * `sandbox`: files .arnxignore leaves out that the tests need (review.yaml sandbox_only): kept beside the snapshot
 * (sandboxDir), never in it, and placed in it only while a test runs (withSandboxFiles). */
export interface SnapshotOptions { untracked?: boolean; standIns?: boolean; sandbox?: readonly string[] }

/** What a snapshot left out or changed: files left out for their content, files kept with comment lines blanked,
 * files kept with stand-ins, and the sandbox-only files it holds beside it. */
export interface Scrubbed { withheld: Withheld[]; blanked: Blanked[]; standIns: string[]; sandboxed: string[];
  /** The values given stand-ins: kept in memory for a later copy into the sandbox (addToSandbox), never logged. */
  secrets: ReadonlySet<string> }

/** Where a snapshot's sandbox-only files are kept: beside it, so nothing that reads the snapshot sees them. */
export const sandboxDir = (snap: string) => `${snap}.sandbox`;

/** Copy the code at `head` (or the working tree when null) to `dest`, then scrub it. Returns the files removed for
 * their content; `allow` keeps files the user allowed while every key-shaped string in them is pinned. A working-tree
 * snapshot holds tracked files only unless `untracked` (or the repository has no commits yet): whatever reads it (an
 * agent, or tests whose output goes to a model) never sees untracked files the owner did not opt in to. */
export function snapshot(repo: string, head: string | null, dest: string, allow: readonly SecretPin[] = [],
                         o: SnapshotOptions = {}): Withheld[] {
  return takeSnapshot(repo, head, dest, allow, o).withheld;
}

/** snapshot, also naming the files kept with comment lines blanked or with stand-ins, and the sandbox-only files. */
export function takeSnapshot(repo: string, head: string | null, dest: string, allow: readonly SecretPin[] = [],
                             o: SnapshotOptions = {}): Scrubbed {
  mkdirSync(dest, { recursive: true });
  const ignored = loadIgnore(repo);
  const limit = changeLimits.maxSnapshotFiles;
  const sandbox = new Set(o.sandbox ?? []);
  if (head === null) {
    const paths = workingTreeFiles(repo, !!o.untracked).files.filter((p) => !ignored(p) || sandbox.has(p));
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
  return scrub(dest, ignored, allow, { standIns: o.standIns ?? standInsSetting(repo), sandbox });
}

/** A digest of what a snapshot holds: each path, a link's target, a file's executable bit and content. Two snapshots
 * of an unchanged working tree agree; a file edited, added, removed or let in (a secret pin, untracked files) between
 * them shows. Taken before any run writes into the snapshot. */
export function snapshotDigest(dest: string): string {
  const h = createHash("sha256");
  const walk = (dir: string, relDir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p, rel);
      else if (st.isSymbolicLink()) h.update(`l\0${rel}\0${readlinkSync(p)}\0`);
      else h.update(`${st.mode & 0o111 ? "x" : "f"}\0${rel}\0${st.size}\0`).update(readFileSync(p)).update("\0");
    }
  };
  walk(dest, "");
  return h.digest("hex");
}

/** Copy `paths` (files .arnxignore leaves out that the tests need) from the working tree to the snapshot's sandbox-only
 * files, scrubbed as a snapshot's files are; `known`: the values the snapshot replaced, replaced here too. Returns
 * those copied, and those left out for their content. */
export function addToSandbox(repo: string, snap: string, paths: readonly string[], allow: readonly SecretPin[] = [],
                             o: { standIns?: boolean; known?: ReadonlySet<string> } = {}): Scrubbed {
  const out = sandboxDir(snap);
  const at = join(out, ".arnx-add");
  rmSync(at, { recursive: true, force: true });
  for (const rel of paths) {
    let st;
    try {
      st = lstatSync(join(repo, rel));
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    mkdirSync(dirname(join(at, rel)), { recursive: true });
    copyFileSync(join(repo, rel), join(at, rel));
  }
  mkdirSync(at, { recursive: true });
  const r = scrub(at, () => false, allow, { standIns: o.standIns ?? standInsSetting(repo), sandbox: new Set(),
    known: o.known });
  const sandboxed: string[] = [];
  const move = (dir: string, prefix: string) => {
    for (const name of readdirSync(dir)) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(join(dir, name)).isDirectory()) move(join(dir, name), rel);
      else {
        mkdirSync(dirname(join(out, rel)), { recursive: true });
        renameSync(join(dir, name), join(out, rel));
        sandboxed.push(rel);
      }
    }
  };
  move(at, "");
  rmSync(at, { recursive: true, force: true });
  return { ...r, sandboxed: sandboxed.sort() };
}

/** What a run's output says in place of text from a sandbox-only file. */
export const SANDBOX_MARK = "[sandbox-only file content]";
/** The shortest text taken for a quote of a sandbox-only file: shorter lines (`{`, `"a": 1,`) say nothing. */
const PRINT_MIN = 10;

/** What a quote of the sandbox-only files `files` (under `from`) looks like: each line, trimmed, with a trailing comma
 * off, and each quoted string, of PRINT_MIN characters or more; with `xml`, each also as an XML report escapes it. */
function sandboxPrints(from: string, files: readonly string[], xml = false): string[] {
  const out = new Set<string>();
  for (const rel of files) {
    const text = scrubText(join(from, rel));
    if (text === null) continue;
    for (const line of text.split(/\r?\n/)) {
      const bare = line.trim().replace(/,$/, "");
      if (bare.length >= PRINT_MIN) out.add(bare);
      for (const m of line.matchAll(/"((?:[^"\\]|\\.){10,})"|'([^'\\]{10,})'/g)) out.add(m[1] ?? m[2]!);
    }
  }
  if (xml) {
    const escape = (t: string) => t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&apos;");
    for (const p of [...out]) out.add(escape(p));
  }
  return [...out];
}

/** `text` with every quote of `prints` (sandboxPrints) replaced by SANDBOX_MARK, runs of them as one. A line that only
 * names a sandbox-only file (a path in an error) is not a quote of it and stays. */
export function stripSandbox(text: string, prints: readonly string[]): string {
  if (!prints.length || !text) return text;
  const byStart = new Map<string, string[]>();
  for (const p of prints) {
    const key = p.slice(0, 8);
    byStart.set(key, [...byStart.get(key) ?? [], p]);
  }
  for (const list of byStart.values()) list.sort((a, b) => b.length - a.length);
  const spans: [number, number][] = [];
  for (let i = 0; i + PRINT_MIN <= text.length; i++) {
    const hit = byStart.get(text.slice(i, i + 8))?.find((p) => text.startsWith(p, i));
    if (!hit) continue;
    const end = i + hit.length;
    const last = spans.at(-1);
    // Quotes next to each other (blanks between) are one.
    if (last && /^\s*$/.test(text.slice(last[1], i))) last[1] = Math.max(last[1], end);
    else spans.push([i, end]);
    i = end - 1;
  }
  if (!spans.length) return text;
  let out = "", at = 0;
  for (const [a, b] of spans) {
    out += text.slice(at, a) + SANDBOX_MARK;
    at = b;
  }
  return out + text.slice(at);
}

/** `runner` with the snapshot's sandbox-only files placed in it for each run, and taken out after: the tests read them,
 * and nothing that reads the snapshot between runs (an agent's tools, the text sent to a model) sees them. A file the
 * snapshot already holds is left as it is. What a run's output and its reports quote of them is taken out
 * (stripSandbox) before anything reads them. */
export function withSandboxFiles(runner: Runner, snap: string): Runner {
  const from = sandboxDir(snap);
  if (!existsSync(from)) return runner;
  const files: string[] = [];
  const walk = (prefix: string) => {
    for (const name of readdirSync(join(from, prefix))) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(join(from, rel)).isDirectory()) walk(rel);
      else files.push(rel);
    }
  };
  walk("");
  if (!files.length) return runner;
  const prints = sandboxPrints(from, files);
  const xmlPrints = sandboxPrints(from, files, true);
  const reports = join(snap, REPORT_DIR);
  const copies = runner.copies ? { copies: (output: string) => runner.copies!(output) } : {};
  return { ...copies, run: (command, timeout) => {
    const placed: string[] = [], made: string[] = [];
    let result;
    try {
      for (const rel of files) {
        const to = join(snap, rel);
        if (existsSync(to)) continue;
        // Folders made for a file go again after the run, deepest first.
        for (let d = dirname(rel); d !== "." && !existsSync(join(snap, d)); d = dirname(d)) made.unshift(join(snap, d));
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(from, rel), to);
        // Its time as the copy beside the snapshot has it: a run never sees it as changed since the last one.
        const st = statSync(join(from, rel));
        utimesSync(to, st.atime, st.mtime);
        placed.push(to);
      }
      result = runner.run(command, timeout);
    } finally {
      for (const p of placed) rmSync(p, { force: true });
      for (const d of made.reverse()) {
        try {
          rmdirSync(d);
        } catch {
          // a run wrote into it
        }
      }
    }
    if (existsSync(reports)) {
      for (const name of readdirSync(reports, { recursive: true }).map(String)) {
        const p = join(reports, name);
        const text = statSync(p).isFile() ? scrubText(p) : null;
        if (text === null) continue;
        const clean = stripSandbox(text, xmlPrints);
        if (clean !== text) writeFileSync(p, clean);
      }
    }
    return { ...result, output: stripSandbox(result.output, prints) };
  } };
}

/** Remove .git, .arnx, paths matched by .arnxignore, secret files and symlinks leaving the tree; then scrub every text
 * file kept (in the tree, or beside it: files .arnxignore matches that `sandbox` names move beside the tree,
 * sandboxDir). A file whose key-shaped text is all in comments gets those lines blanked. With `standIns`, every
 * suspect (secrets.ts suspects) of every file, and of `known` (another scrub's), is collected first, and then each
 * whole occurrence of one, in any file but a lockfile, gets its stand-in: a value is replaced wherever it appears, so
 * no file keeps it and the files agree. A file is left out only when no stand-in keeps a key out (a private key with
 * its body), or, without `standIns`, when it holds key-shaped text in code. Returns those files, the files blanked,
 * given stand-ins and moved beside the tree, and the values replaced (in memory only: never logged or sent). */
function scrub(root: string, ignored: (rel: string) => boolean, allow: readonly SecretPin[],
               o: { standIns: boolean; sandbox: ReadonlySet<string>; known?: ReadonlySet<string> }): Scrubbed {
  const realRoot = realpathSync(root);
  const removedFiles: Withheld[] = [];
  const blanked: Blanked[] = [];
  const standIns: string[] = [];
  const sandboxed = new Set<string>();
  const beside = sandboxDir(root);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  const holds = (dir: string) => [...o.sandbox].some((p) => p.startsWith(`${dir}/`));
  /** Regular files kept: where they are now, and their path in the repository. */
  const kept: { p: string; rel: string }[] = [];
  const walk = (dir: string, relDir: string, out: boolean) => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const rel = relDir ? `${relDir}/${name}` : name;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        const left = out || ignored(rel + "/");
        if (name === ".git" || name === ".arnx" || (left && !holds(rel))) rmSync(p, { recursive: true, force: true });
        else walk(p, rel, left);
        continue;
      }
      if (out || ignored(rel) || (st.isSymbolicLink() && ignored(rel + "/"))) {
        // A file the tests need goes beside the tree, unless it is a secret file or a link.
        if (o.sandbox.has(rel) && st.isFile() && !isSecretPath(name)) {
          const to = join(beside, rel);
          mkdirSync(dirname(to), { recursive: true });
          renameSync(p, to);
          sandboxed.add(rel);
          kept.push({ p: to, rel });
        } else rmSync(p, { force: true });
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
      kept.push({ p, rel });
    }
  };
  walk(root, "", false);
  const pinsOf = (rel: string) => allow.find((a) => a.path === rel)?.matches ?? [];
  const fakes = (rel: string) => o.standIns && !isLockfile(rel);
  // First every file's suspects, and what each file needs: left out, or blanked lines.
  const values = new Set<string>(o.known ?? []);
  const blanks = new Map<string, number[]>();
  const scanned: { p: string; rel: string }[] = [];
  for (const f of kept) {
    const text = scrubText(f.p);
    if (text === null) continue;
    const pins = pinsOf(f.rel);
    const scan = scanKeys(f.rel, text, pins);
    if (scan && "withhold" in scan && (!o.standIns || privateKeyBody(text, pins))) {
      unlinkSync(f.p);
      sandboxed.delete(f.rel);
      removedFiles.push({ path: f.rel, ...scan.withhold });
      continue;
    }
    const blank = scan && "blank" in scan ? scan : null;
    if (blank) blanks.set(f.rel, blank.blank);
    if (fakes(f.rel)) for (const v of suspects(f.rel, blank ? blank.text : text, pins)) values.add(v);
    scanned.push(f);
  }
  // Then each value's stand-in, wherever it is.
  const made = new Map<string, string>();
  const replace = values.size ? standInsFor(values, made) : null;
  for (const f of scanned) {
    const lines = blanks.get(f.rel);
    let text = scrubText(f.p)!;
    if (lines) text = (scanKeys(f.rel, text, pinsOf(f.rel)) as { text: string }).text;
    const r = replace && fakes(f.rel) ? replace(text, pinsOf(f.rel)) : { text, count: 0 };
    if (!lines && !r.count) continue;
    writeFileSync(f.p, r.text);
    if (lines) blanked.push({ path: f.rel, lines });
    if (r.count) standIns.push(f.rel);
  }
  // Folders the moves left empty go.
  for (const rel of sandboxed) {
    for (let d = posix.dirname(rel); d !== "."; d = posix.dirname(d)) {
      const at = join(root, d);
      if (!existsSync(at) || readdirSync(at).length) break;
      rmdirSync(at);
    }
  }
  const byPath = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  return { withheld: removedFiles.sort(byPath), blanked: blanked.sort(byPath), standIns: standIns.sort(),
    sandboxed: [...sandboxed].sort(), secrets: values };
}

/** A file's text when it is text (no NUL in its first 8000 bytes) and no larger than SCAN_LIMIT; null otherwise. */
function scrubText(p: string): string | null {
  try {
    if (statSync(p).size > SCAN_LIMIT) return null;
    const bytes = readFileSync(p);
    return bytes.subarray(0, 8000).includes(0) ? null : bytes.toString("utf8");
  } catch {
    return null;
  }
}
