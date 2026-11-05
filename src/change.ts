// What to review: on a branch, everything since it left the default branch (plus uncommitted work); otherwise
// uncommitted work, else the last commit; or an explicit range A..B; with no commits yet, every file. Uncommitted work
// is tracked files only (staged, unstaged, and new files `git add`ed): untracked files go into the change and the
// snapshot only when the owner opts in (--untracked, or [review] untracked), or when there are no commits yet. The
// snapshot is the code at the change's head with secrets left out; tests run against the snapshot, never the user's
// checkout.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync,
  readlinkSync,
  readSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, posix, resolve, sep } from "node:path";
import { configSuspects, loadReviewFile, sandboxOnlyOf, secretPinsOf } from "./config";
import { ArnxError, ChangeTooLarge, NoChange, SetupRequired } from "./errors";
import { isLockfile, loadIgnore } from "./ignore";
import { BIG_KEYS_MOST, excludePathspecs, fakeKeys, filePin, holdsOnlyPublicPem, holdsPrivateKey, isCertainRule, isCodePath, isKeyFileName, isSecretPath,
  type KeyScan, keyTokens, MAY_HOLD_KEY, mayShowPrivateKey, privateKeyIn, scanKeys, type SecretPin, standInsFor, suspects, usedAsName,
  WORD_RULE } from "./secrets";
import { buildContextDir, manifestRule, REPORT_DIR, type Runner } from "./sandbox";
import { standInsSetting } from "./settings";
import { DIFF_SECTION, splitLines } from "./util";

export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
export const MAX_DIFF_BYTES = 200_000;
export const SCAN_LIMIT = 1_000_000;
/** The largest text file a snapshot keeps. read_file has no size limit, so one it cannot scan may not stay. Measured on
 * the slowest shapes (one long line, a name or a key on every line): up to 0.2 s per MB, and up to 1 GB of memory at this
 * size, on every snapshot of a review. */
export const BIG_SCAN_LIMIT = 32_000_000;
/** The most key-shaped strings a file over SCAN_LIMIT may hold and stay: about 5 s of stand-ins on each snapshot. */
export { BIG_KEYS_MOST };
/** Mutable so tests can lower it. */
export const changeLimits = { maxSnapshotFiles: 20_000, maxScanBytes: BIG_SCAN_LIMIT };
const MAX_BUFFER = 1 << 30;
/** A diff arnx can read, of what git holds, whatever the owner's git settings: no outside tool or text conversion (a
 * decrypting driver), none of a submodule's files. */
const DIFF_FORM = ["--no-color", "--no-ext-diff", "--no-textconv", "--submodule=short", "--src-prefix=a/", "--dst-prefix=b/"];
/** What a search of file contents needs, whatever the owner's git settings: bytes, plain output. */
const SEARCH = (repo: string) => ["--literal-pathspecs", "-C", repo, "grep", "--no-color", "-a", "-E"];
const searchEnv = () => ({ ...process.env, LC_ALL: "C" });

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
  /** Changed files a snapshot leaves out for what they hold, on either side: not in `files`, no section in `diff`. */
  withheld?: Withheld[];
  /** Changed files left out by their name. */
  namedOut?: string[];
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
  return diff.split(DIFF_SECTION).filter((part) => {
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
  const ours = [":(exclude).arnx", ":(exclude).arnxignore"];
  const ignored = loadIgnore(repo);
  const ignoredOut = new Set<string>(), lockOut = new Set<string>(), namedOut = new Set<string>();
  const standIns = standInsSetting(repo);
  /** Whether a snapshot keeps this side of a file named like a secret (scrub). */
  const namedSideStays = (path: string, side: FileSide) => !!side && !("label" in side) && (
    (allow.find((a) => a.path === path)?.matches ?? []).includes(filePin(side.text)) || (!side.binary && (
      holdsOnlyPublicPem(path, side.text) || (standIns && isKeyFileName(path) && holdsPrivateKey(side.text, [])))));
  /** The section of a changed file named like a secret, when a snapshot keeps it on each side it has. */
  const namedSection = (path: string, revs: string[]): string | null => {
    const section = git(repo, ["diff", ...DIFF_FORM, ...revs, "--", `:(literal)${path}`]);
    const { old, now } = sectionPaths(section);
    if (old === null && now === null) return null;
    const stays = (old === null || namedSideStays(old, blobSide(repo, revs[0]!, old))) &&
      (now === null || namedSideStays(now, revs[1] ? blobSide(repo, revs[1], now) : fileSide(repo, now)));
    return stays ? section : null;
  };
  const trackedDiff = (...revs: string[]): [string, string[]] => {
    const changed = names(git(repo, ["diff", "-z", "--name-only", ...revs, "--", ".", ...ex]));
    changed.filter(ignored).forEach((p) => ignoredOut.add(p));
    changed.filter((p) => !ignored(p) && isLockfile(p)).forEach((p) => lockOut.add(p));
    const out = (p: string) => ignored(p) || isLockfile(p);
    const skip = changed.filter(out).map((p) => `:(exclude,literal)${p}`);
    const named = names(git(repo, ["diff", "-z", "--name-only", ...revs, "--", ".", ...ours]))
      .filter((p) => isSecretPath(p) && !out(p)).flatMap((p) => {
        const section = namedSection(p, revs);
        if (!section) namedOut.add(p);
        return section ? [[p, section] as const] : [];
      });
    return [git(repo, ["diff", ...DIFF_FORM, ...revs, "--", ".", ...ex, ...skip]) + named.map(([, section]) => section).join(""),
      [...changed.filter((p) => !out(p)), ...named.map(([p]) => p)]];
  };
  let kind: Change["kind"], base: string, head: string | null, diff: string, files: string[];
  let branch: Change["branch"];
  // Accepted tests not committed yet are arnx's own output, not the developer's change: they neither make the tree
  // dirty nor go into the diff.
  const leftOut: string[] = [];
  // A status line's path (the new one of a rename); files .arnxignore leaves out do not make the tree dirty either.
  const pathOf = (l: string) => (l.slice(3).split(" -> ").at(-1) ?? "").replace(/^"|"$/g, "");
  // Untracked files make the tree dirty only when they are sent.
  const dirty = () => git(repo, ["status", "--porcelain", "--untracked-files=all", "--", ".", ...ours]).split("\n")
    .some((l) => l.trim() && !ignored(pathOf(l)) && !(l.startsWith("?? ") && (!withUntracked ||
      ACCEPTED_TEST.test(pathOf(l)))) && (!isSecretPath(pathOf(l)) ||
      (l.startsWith("?? ") ? namedSideStays(pathOf(l), fileSide(repo, pathOf(l))) : namedSection(pathOf(l), ["HEAD"]) !== null)));
  const others = () => names(git(repo, ["ls-files", "-z", "--others", "--exclude-standard", "--", ".", ...ours]))
    .filter((p) => !isSecretPath(p) || (withUntracked && namedSideStays(p, fileSide(repo, p))));
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
      diff += git(repo, ["diff", ...DIFF_FORM, "--no-index", "--", "/dev/null", path], [0, 1]);
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
  const notTooLarge = (text: string) => {
    const size = Buffer.byteLength(text);
    if (size > MAX_DIFF_BYTES) {
      // The first commit holds every file, and --range cannot split one commit.
      const root = kind === "commit" && base === EMPTY_TREE;
      throw new ChangeTooLarge(`the change is ${Math.floor(size / 1000)} KB; arnx reviews up to ${MAX_DIFF_BYTES / 1000} KB ` +
        `(largest: ${largestFiles(text)}). ` +
        (root ? "This is the repository's first commit, so it holds every file. Make your next change on a branch: " +
            "`arnx review` reviews that"
          : kind === "branch" ? "Review it in parts with --range A..B (for example a few commits at a time)"
          : kind === "no-commits" ? "With no commits yet --range has nothing to name: commit part of the files first " +
            "(data, vendored or generated code), and `arnx review` then reviews the rest; or leave data files out with " +
            ".arnxignore"
          : "Narrow it with --range"), root);
    }
  };
  // What is left out does not count, but reading every file of a huge change only to refuse it would take minutes.
  if (standIns && !mayShowPrivateKey(diff)) notTooLarge(diff);
  const atRev = blobSides(repo, diff);
  const sealed = sealDiff(diff, allow, (path) => base === EMPTY_TREE ? null : atRev(base, path),
    (path) => head === null ? fileSide(repo, path, allow.find((a) => a.path === path)?.matches) : atRev(head, path), standIns);
  if (!sealed.diff.trim()) {
    // A range is within reach only from HEAD to the commit before it, or to where its branch left.
    const allowable = kind !== "range" || (head === commitOf(repo, "HEAD") &&
      [git(repo, ["rev-parse", "--verify", "-q", "HEAD^"], [0, 1]).trim(), branchBase(repo)?.base].includes(base));
    const allowedAlready = (p: string) => !!allow.find((a) => a.path === p)?.matches.length;
    throw new ArnxError(secretStop(sealed.withheld, sealed.beforeOnly, allowable, allowedAlready));
  }
  notTooLarge(sealed.diff);
  diff = sealed.diff;
  const left = new Set(sealed.withheld.map((w) => w.path));
  return { kind, base, head, diff, files: [...new Set(files)].filter((f) => !left.has(f)).sort(), ...(branch ? { branch } : {}),
    ...(leftOut.length ? { leftOut } : {}), ...(ignoredOut.size ? { ignored: [...ignoredOut].sort() } : {}),
    ...(lockOut.size ? { lockfiles: [...lockOut].sort() } : {}),
    ...(withUntracked && head === null ? { withUntracked: true as const } : {}),
    ...(born && included.length ? { untrackedIncluded: included.sort() } : {}),
    ...(notSent.length ? { untrackedLeftOut: notSent.sort() } : {}),
    ...(sealed.files.length ? { blanked: sealed.files } : {}),
    ...(sealed.withheld.length ? { withheld: sealed.withheld } : {}), ...(namedOut.size ? { namedOut: [...namedOut].sort() } : {}) };
}

/** What a change refuses to send, and the way out. `allow-secret` takes a file as it stands, at HEAD, before the last commit
 * and where its branch left, so a range may hold a copy it cannot reach (`allowable`), and a file gone has no way but another
 * range (`beforeOnly`: a key only the code before the change holds). */
function secretStop(files: readonly { path: string; label: string }[], beforeOnly: ReadonlySet<string> = new Set(),
                    allowable = true, allowed: (path: string) => boolean = () => false): string {
  const one = files.length === 1;
  const named = someNames(files.map((f) => `${f.path} (${f.label})`), 5);
  const start = `the change contains text that looks like a secret (a key or token) in ${named}`;
  // Allowing frees neither a file no scan can read for its diff, nor one that cannot be read.
  if (files.every((f) => allowed(f.path) || f.label === UNREADABLE.label)) {
    return `${start}; arnx will not send it to a model. It is too large to read for a diff, or could not be read, so allowing it does not ` +
      "help: review another with `--range A..B`";
  }
  const command = `\`arnx allow-secret ${one ? files[0]!.path : "PATH"}\``;
  if (!allowable) return `${start}; arnx will not send it to a model. It cannot be allowed in this range, only as it stands at HEAD: review another with \`--range A..B\``;
  if (files.every((f) => beforeOnly.has(f.path))) {
    return `${start}, on the side it removes; arnx will not send it to a model. If the file is still here and a test fixture: ` +
      `${command}, then \`arnx review\` again. If not, review what comes after it: \`arnx review --range A..B\``;
  }
  return `${start}; arnx will not send it to a model. If ${one ? "it is" : "one is"} a test fixture, not a secret, allow the file: ` +
    `${command}, then \`arnx review\` again`;
}

/** Why a snapshot leaves out `rel` holding `scan`'s key-shaped strings; null when it stays. `fakes`: it may get stand-ins, and a
 * private key its fake. Text with a NUL is scanned without them (UTF-16), and any key leaves it out: it is never edited.
 * sealDiff and scrub both decide here, so a diff and a snapshot agree. */
function leftOutReason(rel: string, read: { text: string; binary: boolean }, scan: KeyScan | null, pins: readonly string[],
                       fakes: boolean): { line: number; label: string } | null {
  const nul = read.binary || read.text.includes("\0");
  const plain = nul ? read.text.replaceAll("\0", "") : read.text;
  // A pin is of the file as it stands.
  const held = nul ? scanKeys(rel, plain, pins.includes(filePin(read.text)) ? [...pins, filePin(plain)] : pins) : scan;
  if (!held) return null;
  if (nul) return "withhold" in held ? held.withhold : { line: held.blank[0]!, label: "key-shaped text" };
  if ("blank" in held) return null;
  // A file that gets no stand-ins (a lockfile, or stand-ins off) is left out.
  if (!fakes) return held.withhold;
  return holdsPrivateKey(read.text, pins) && keyTokens(read.text).size > BIG_KEYS_MOST
    ? { line: 1, label: `over ${BIG_KEYS_MOST} key tokens` } : null;
}

/** One side of a changed file, for sealDiff: its content; why it counts as holding a key (a file no scan reads whole, or one
 * that cannot be read); or null, with nothing to read (not a file, or no key found). */
export type FileSide = { text: string; binary: boolean } | { line: number; label: string } | null;

/** The working tree's side, what a snapshot of it copies. A link is its target's path: nothing here follows it. */
export function fileSide(repo: string, path: string, pins: readonly string[] = []): FileSide {
  const p = join(repo, path);
  try {
    if (!lstatSync(p).isFile()) return null;
  } catch {
    return UNREADABLE;
  }
  const big = overScanLimit(p);
  if (big === "binary" && pins.includes(pinOfFile(p) ?? "")) return null; // allowed, and no diff shows a binary's bytes
  return big === "binary" || big === "too large" ? keyInStream(p) : scrubText(p, changeLimits.maxScanBytes);
}

/** A commit's side, read no further than the largest file a scan takes; past that, onto disk and a piece at a time. A read
 * that fails on a path the diff names counts as a hit. */
function blobSide(repo: string, rev: string, path: string): FileSide {
  const r = spawnSync("git", ["-C", repo, "show", `${rev}:${path}`], { maxBuffer: changeLimits.maxScanBytes, env: searchEnv() });
  const bytes = r.stdout as unknown as Buffer;
  if ((r.error as NodeJS.ErrnoException | undefined)?.code === "ENOBUFS" || bytes?.length > changeLimits.maxScanBytes) {
    return keyInBlob(repo, rev, path);
  }
  if (r.error) throw new SetupRequired(`git could not run: ${r.error.message}`);
  if (r.status !== 0) return UNREADABLE;
  return { text: bytes.toString("utf8"), binary: bytes.subarray(0, 8000).includes(0) };
}

/** Each commit's side of the files of `diff`. One search first says which files may hold a key at all: a read per file
 * takes seconds on a big change. A search that fails leaves every file to read. */
function blobSides(repo: string, diff: string) {
  /** A section holding a NUL (UTF-16 shown as text): the search cannot see a key in it, so its file is read. */
  const always = new Set<string>();
  const paths = [...new Set(diff.split(DIFF_SECTION).flatMap((section) => {
    const { old, now } = sectionPaths(section);
    const named = [old, now].filter((p): p is string => p !== null);
    if (section.includes("\0")) named.forEach((p) => always.add(p));
    return named;
  }))];
  const searched = new Map<string, Set<string> | null>();
  const search = (rev: string): Set<string> | null => {
    const out = new Set<string>();
    for (let i = 0; i < paths.length; i += 500) {
      const r = spawnSync("git", [...SEARCH(repo), "-l", "-z", "-e", MAY_HOLD_KEY, rev, "--", ...paths.slice(i, i + 500)],
        { encoding: "utf8", maxBuffer: MAX_BUFFER, env: searchEnv() });
      if (r.error || (r.status !== 0 && r.status !== 1)) return null;
      for (const hit of r.stdout.split("\0")) if (hit) out.add(hit.slice(rev.length + 1));
    }
    return out;
  };
  return (rev: string, path: string): FileSide => {
    if (!searched.has(rev)) searched.set(rev, search(rev));
    const found = searched.get(rev);
    return found && !found.has(path) && !always.has(path) ? null : blobSide(repo, rev, path);
  };
}

/** What a side says when a path the diff names cannot be read. */
const UNREADABLE = { line: 1, label: "could not be read" };

/** A private key in a commit's file over every scan's limit: the file goes to disk for keyInStream. A read that fails counts
 * as a hit. */
function keyInBlob(repo: string, rev: string, path: string): { line: number; label: string } | null {
  const dir = mkdtempSync(join(tmpdir(), "arnx-"));
  try {
    const p = join(dir, "blob");
    const fd = openSync(p, "w", 0o600);
    let r;
    try {
      r = spawnSync("git", ["-C", repo, "show", `${rev}:${path}`], { stdio: ["ignore", fd, "ignore"], env: searchEnv() });
    } finally {
      closeSync(fd);
    }
    return r.error || r.status !== 0 ? UNREADABLE : keyInStream(p);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Where a file on disk over a whole scan's limit holds a private key, read a piece at a time, without its NULs (UTF-16). A
 * pin cannot vouch for what no scan reads. A file that cannot be read counts as a hit. */
export function keyInStream(p: string): { line: number; label: string } | null {
  const piece = Buffer.alloc(1 << 20);
  let fd: number | null = null;
  try {
    fd = openSync(p, "r");
    let held = "", line = 1;
    for (let n = readSync(fd, piece, 0, piece.length, null); n > 0; n = readSync(fd, piece, 0, piece.length, null)) {
      const text = held + piece.toString("latin1", 0, n).replaceAll("\0", "");
      const at = privateKeyIn(text);
      if (at >= 0) return { line: line + newlines(text.slice(0, at)), label: "a private key" };
      // Enough to hold a key's start and what must follow it.
      held = text.slice(-512);
      line += newlines(text.slice(0, -512));
    }
    return null;
  } catch {
    return UNREADABLE;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}
const newlines = (text: string) => text.split("\n").length - 1;

/** A path as a diff's header writes it: git quotes odd ones, C-style, and ends one holding a space with a tab. */
function diffPath(raw: string): string {
  if (!raw.startsWith('"')) return raw.replace(/\t$/, "");
  const parts = [...raw.replace(/\t$/, "").slice(1, -1).matchAll(/\\([0-7]{3}|.)|[^\\]+/gs)].map(([piece, esc]) => {
    if (esc === undefined) return Buffer.from(piece);
    const named = "abtnvfr".indexOf(esc);
    return Buffer.from([/^[0-7]{3}$/.test(esc) ? parseInt(esc, 8) : named >= 0 ? [7, 8, 9, 10, 11, 12, 13][named]! : esc.charCodeAt(0)]);
  });
  return Buffer.concat(parts).toString("utf8");
}

/** The paths a diff section reads from and writes to, null where it has no such side. No line of a hunk counts; a section
 * with no name lines (a mode change, a binary file) has them in its first line. */
function sectionPaths(section: string): { old: string | null; now: string | null; link?: true } {
  let old: string | null | undefined, now: string | null | undefined, added = false, gone = false, link = false;
  const lines = section.split("\n", 12);
  for (const line of lines) {
    if (line.startsWith("@@ ")) break;
    if (line.startsWith("new file mode ")) added = true;
    if (line.startsWith("deleted file mode ")) gone = true;
    // A submodule's commit: nothing here to read.
    if (/^(?:index \S+ |(?:new file|deleted file|old|new) mode )160000$/.test(line)) link = true;
    const moved = /^(?:rename|copy) (from|to) (.*)$/.exec(line);
    if (moved?.[1] === "from") old = diffPath(moved[2]!);
    else if (moved) now = diffPath(moved[2]!);
    else if (line.startsWith("--- ")) old = line === "--- /dev/null" ? null : diffPath(line.slice(4)).replace(/^a\//, "");
    else if (line.startsWith("+++ ")) now = line === "+++ /dev/null" ? null : diffPath(line.slice(4)).replace(/^b\//, "");
  }
  if (link) return { old: null, now: null, link: true };
  if (old !== undefined || now !== undefined) return { old: old ?? null, now: now ?? null };
  const head = lines[0]!.startsWith("diff --git ") ? lines[0]!.slice(11) : "";
  const quoted = /^("(?:[^"\\]|\\.)*") "/.exec(head)?.[1];
  const path = quoted ? diffPath(quoted).replace(/^a\//, "") : head.slice(2, (head.length - 1) / 2);
  return head === (quoted ? `${quoted} ${quoted.replace('"a/', '"b/')}` : `a/${path} b/${path}`)
    ? { old: added ? null : path, now: gone ? null : path } : { old: null, now: null };
}

/** `diff` as it may leave arnx. A section goes whole when a snapshot of either side would leave its file out (rule of
 * leftOutReason), or when a side cannot be read: `withheld`. A private key's tokens read as its fake, the same one a snapshot
 * holds, pinned or not, by line, so a hunk with no header is safe too; the filter hides the rest on the way out. Lines each
 * side blanks (scanKeys, key-shaped text in comments of source files) are blanked. A section with either loses its hunk
 * headers' function context, which git may take from a key's body. `files`: the lines blanked, numbered in the side each diff
 * line comes from. Everything else may be a secret too, and is the outbound filter's (boundary.ts). `before` and `after` read
 * each side of a file by path. `beforeOnly`: files left out for what only their removed side holds. */
export function sealDiff(diff: string, allow: readonly SecretPin[], before: (path: string) => FileSide,
                         after: (path: string) => FileSide, standIns: boolean)
  : { diff: string; files: Blanked[]; withheld: Withheld[]; beforeOnly: Set<string> } {
  const files: Blanked[] = [], withheld: Withheld[] = [];
  const beforeOnly = new Set<string>();
  const pins = (path: string) => allow.find((a) => a.path === path)?.matches ?? [];
  const kept = diff.split(DIFF_SECTION).flatMap((section) => {
    const { old: oldPath, now: newPath, link } = sectionPaths(section);
    const path = newPath ?? oldPath ?? "";
    /** Why this side leaves the file out; otherwise its lines to replace by number, and which of them are a key's. */
    const side = (p: string | null, read: (p: string) => FileSide)
      : { out?: { line: number; label: string }; blank: Map<number, string>; keys: Set<number> } => {
      const blank = new Map<number, string>(), keys = new Set<number>();
      // A name that is not text cannot be asked for by name.
      if (p?.includes("\uFFFD")) return { out: UNREADABLE, blank, keys };
      const got = p === null ? null : read(p);
      if (!got) return { blank, keys };
      if ("label" in got) return { out: got, blank, keys };
      const scan = scanKeys(p!, got.text, pins(p!));
      const out = leftOutReason(p!, got, scan, pins(p!), standIns && !isLockfile(p!));
      if (out) return { out, blank, keys };
      if (scan && "blank" in scan) {
        const lines = scan.text.split("\n");
        for (const n of scan.blank) blank.set(n, lines[n - 1]!);
      }
      const plain = got.text.replaceAll("\0", "");
      // What is only read: a page of the diff shows no key, whatever its wrap.
      const faked = fakeKeys(plain, { view: true });
      if (faked.count) {
        const real = plain.split("\n");
        faked.text.split("\n").forEach((line, i) => {
          if (line === real[i]) return;
          blank.set(i + 1, line);
          keys.add(i + 1);
        });
      }
      return { blank, keys };
    };
    if (!path && !link) throw new ArnxError("the change holds a part arnx cannot place; arnx will not send it to a model");
    const oldSide = side(oldPath, before), newSide = side(newPath, after);
    const out = newSide.out ?? oldSide.out;
    if (out) {
      withheld.push({ path, ...out });
      if (!newSide.out) beforeOnly.add(path);
      return [];
    }
    const old = oldSide.blank, now = newSide.blank;
    let done = section;
    if (old.size || now.size) {
      const blanked = new Set<number>();
      let a = 0, b = 0, inHunk = false;
      done = section.split("\n").map((line) => {
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
        if (!(mark === "-" ? oldSide : newSide).keys.has(n)) blanked.add(n);
        return mark + to;
      }).join("\n");
      if (blanked.size) files.push({ path, lines: [...blanked].sort((x, y) => x - y) });
    }
    return [done];
  });
  return { diff: kept.join(""), files, withheld: withheld.sort((x, y) => x.path < y.path ? -1 : x.path > y.path ? 1 : 0),
    beforeOnly };
}

/** The three files taking most of a diff, with their sizes ("package-lock.json 173 KB, README.md 25 KB, …"). */
function largestFiles(diff: string): string {
  const parts = diff.split(DIFF_SECTION).map((part) => {
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

/** What a file left out holds and where, for a person. Never the text. Line 0: the whole file counts (its name, its size). */
export const withheldWhat = (w: Withheld) => w.line ? `${w.label}, line ${w.line}` : w.label;
/** Files left out, for a person: those left out by their name go last, with the label once. */
export function namesLeftOut(paths: readonly string[], files: readonly Withheld[] = [], name: (p: string) => string): string {
  const of = (p: string) => files.find((x) => x.path === p);
  const byName = paths.filter((p) => of(p)?.label === NAMED_OUT).map(name);
  return [...paths.filter((p) => of(p)?.label !== NAMED_OUT).map((p) => `${name(p)}${of(p) ? ` (${withheldWhat(of(p)!)})` : ""}`),
    ...byName.length ? [`${byName.join(", ")} (${NAMED_OUT})`] : []].join(", ");
}
/** Files left out, for a person. */
export const describeWithheld = (w: readonly Withheld[]) => namesLeftOut(w.map((x) => x.path), w, (p) => p);
/** The same at setup, with no change to go by: what files hold is named, and files left out by their name are a count. */
export function leftOutBrief(w: readonly Withheld[]): string {
  const held = w.filter((x) => x.label !== NAMED_OUT), byName = w.length - held.length;
  return [...held.length ? [describeWithheld(held)] : [], ...byName ? [`${byName} file${byName === 1 ? "" : "s"} by name`] : []].join("; ");
}
/** What setup says of files holding a key's fake. */
export const fakedKeysText = (paths: readonly string[]) =>
  `private keys faked in the sandbox: ${someNames(paths, 5)}; a test that parses one needs \`arnx allow-secret PATH\``;
/** The label of a file left out for its name, holding no private key. */
export const NAMED_OUT = "named like a secret";
/** The label of a file no scan reads whole. */
export const TOO_LARGE = "too large to scan";

/** The pin of a file as it stands, read a piece at a time: for valid text it is `filePin` of that text. */
export function pinOfFile(p: string): string | null {
  const hash = createHash("sha256"), piece = Buffer.alloc(1 << 20);
  let fd: number | null = null;
  try {
    fd = openSync(p, "r");
    for (let n = readSync(fd, piece, 0, piece.length, null); n > 0; n = readSync(fd, piece, 0, piece.length, null)) hash.update(piece.subarray(0, n));
    return hash.digest("hex").slice(0, 16);
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

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
export interface SnapshotOptions { untracked?: boolean; standIns?: boolean; sandbox?: readonly string[];
  /** Only its values are wanted: no build context is made. */
  valuesOnly?: boolean }

/** What a snapshot left out or changed: files left out for their content, files kept with comment lines blanked,
 * files kept with stand-ins (for the certain values), and the sandbox-only files it holds beside it. */
export interface Scrubbed { withheld: Withheld[]; blanked: Blanked[]; standIns: string[]; sandboxed: string[];
  /** Files kept with a fake for their private key's tokens (secrets.ts fakeKeys). */
  fakedKeys: string[];
  /** Where the stand-ins stand: file, line and rule, never a value (standins.ts). A faked private key counts, with the rule "private key". */
  standInList: { path: string; line: number; rule: string }[];
  /** The stand-ins themselves of the certain values (never the guesses' and never an original), in memory only: what a setup
   * file may not name. */
  standInValues: ReadonlySet<string>;
  /** The values given stand-ins where tests run, the certain ones (secrets.ts isCertainRule): kept in memory for a later
   * copy into the sandbox (addToSandbox), never logged. */
  secrets: ReadonlySet<string>;
  /** The values real where tests run and stand-ins only in the build context (sandbox.ts buildContextOf): the guesses. A
   * project's manifest and a lockfile keep theirs in both trees. */
  guesses: ReadonlySet<string>;
  /** Every value that looks like a secret, in memory only: all of `secrets` and `guesses`, and those of files that get no
   * stand-ins, of secret files and of files left out, none of them changed. What leaves arnx is masked for each
   * (boundary.ts). */
  suspects: ReadonlySet<string> }

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
  rmSync(buildContextDir(dest), { recursive: true, force: true });
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
  return scrub(dest, ignored, allow, { standIns: o.standIns ?? standInsSetting(repo), sandbox, build: !o.valuesOnly,
    manifest: manifestRule(repo), rootEnv: rootEnvValues(repo, allow) });
}

/** The values of the `.env*` files at the top of `repo`, tracked or not, with their rules: they are read for this and
 * copied nowhere, so a value hard-coded from one into tracked code is known for what it is. */
function rootEnvValues(repo: string, allow: readonly SecretPin[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const name of readdirSync(repo)) {
    if (!name.startsWith(".env")) continue;
    const p = join(repo, name);
    if (!lstatSync(p).isFile()) continue;
    const read = scrubText(p);
    if (!read || read.binary) continue;
    const why = new Map<string, string>();
    suspects(name, read.text, allow.find((a) => a.path === name)?.matches ?? [], why);
    for (const [v, rule] of why) if (!out.has(v)) out.set(v, rule);
  }
  return out;
}

/** What a text from this repository's working tree may hold: every suspect of the tree, untracked files too, and of
 * review.yaml. For what arnx writes or prints that a coding agent reads. */
export function treeValues(repo: string): Set<string> {
  let allow: readonly SecretPin[] = [];
  let raw: string[] = [];
  try {
    const file = loadReviewFile(repo, { requireApproved: false });
    allow = secretPinsOf(file.raw);
    raw = sandboxOnlyOf(file.raw);
  } catch {
    // no review.yaml that reads: no pins
  }
  return new Set([...treeSuspects(repo, null, allow, { untracked: true, sandbox: raw }), ...configSuspects(repo)]);
}

/** The suspects of the code at `head` (the working tree when null), from a snapshot taken only for them. */
export function treeSuspects(repo: string, head: string | null, allow: readonly SecretPin[] = [],
                             o: SnapshotOptions = {}): ReadonlySet<string> {
  const dir = mkdtempSync(join(tmpdir(), "arnx-"));
  try {
    return takeSnapshot(repo, head, join(dir, "repo"), allow, { ...o, valuesOnly: true }).suspects;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
    known: o.known, aside: true });
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
    const text = textOf(join(from, rel));
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

/** The snapshot's sandbox-only files: where they are, each path (relative to the snapshot) and what a quote of them
 * looks like (stripSandbox); null when there are none. */
export function sandboxOnly(snap: string): { from: string; files: string[]; prints: string[] } | null {
  const from = sandboxDir(snap);
  if (!existsSync(from)) return null;
  const files: string[] = [];
  const walk = (prefix: string) => {
    for (const name of readdirSync(join(from, prefix))) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (lstatSync(join(from, rel)).isDirectory()) walk(rel);
      else files.push(rel);
    }
  };
  walk("");
  return files.length ? { from, files, prints: sandboxPrints(from, files) } : null;
}

/** `runner` with the snapshot's sandbox-only files placed in it for each run, and taken out after: the tests read them,
 * and nothing that reads the snapshot between runs (an agent's tools, the text sent to a model) sees them. A file the
 * snapshot already holds is left as it is. What a run's output and its reports quote of them is taken out
 * (stripSandbox) before anything reads them. */
export function withSandboxFiles(runner: Runner, snap: string): Runner {
  const only = sandboxOnly(snap);
  if (!only) return runner;
  const { from, files, prints } = only;
  const xmlPrints = sandboxPrints(from, files, true);
  const reports = join(snap, REPORT_DIR);
  const copies = runner.copies ? { copies: (output: string) => runner.copies!(output) } : {};
  return { ...copies, clean: (report) => stripSandbox(report, xmlPrints), run: (command, timeout) => {
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
        const text = statSync(p).isFile() ? textOf(p) : null;
        if (text === null) continue;
        const clean = stripSandbox(text, xmlPrints);
        if (clean !== text) writeFileSync(p, clean);
      }
    }
    return { ...result, output: stripSandbox(result.output, prints) };
  } };
}

/** The tree at `from`, in `to`: each file a hard link, so a second tree costs no second copy, unless `to` holds it already
 * or `skip` names it. A file a run later changes in place changes in both; what it writes new stays out. */
function linkTree(from: string, to: string, skip: ReadonlySet<string>, rel = ""): void {
  mkdirSync(join(to, rel), { recursive: true });
  for (const e of readdirSync(join(from, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) linkTree(from, to, skip, r);
    else if (e.isSymbolicLink()) symlinkSync(readlinkSync(join(from, r)), join(to, r));
    else if (!skip.has(r) && !existsSync(join(to, r))) linkSync(join(from, r), join(to, r));
  }
}

/** Remove .git, .arnx, paths matched by .arnxignore, secret files and symlinks leaving the tree; then scrub every text
 * file kept (in the tree, or beside it: files .arnxignore matches that `sandbox` names move beside the tree,
 * sandboxDir). A file whose key-shaped text is all in comments gets those lines blanked. With `standIns`, every
 * suspect (secrets.ts suspects) of every file, and of `known` (another scrub's), is collected first. Then each whole
 * occurrence of a certain one (isCertainRule), in any file but a lockfile, gets its stand-in: a value is replaced wherever
 * it appears, so no file keeps it and the files agree. The guesses stay real here, since a wrong one must not change code
 * that runs, and a model reads them only through the filter (boundary.ts). A build has network, so with `build` the image
 * gets its own tree beside this one (buildContextOf), with a stand-in for each guess too, in every file but a project's
 * manifest and a lockfile: a stand-in there can break an install. Each token of a private key gets its fake (secrets.ts
 * fakeKeys), unless the file is pinned, in both trees. A file is left out for its name unless `namedStays`, for its size, when
 * binary and holding a key, or, without `standIns`, when it holds key-shaped text in code. Returns those files, the files
 * blanked, given stand-ins or a key's fake and moved beside the tree, and the values (in memory only: never logged or sent). */
function scrub(root: string, ignored: (rel: string) => boolean, allow: readonly SecretPin[],
               o: { standIns: boolean; sandbox: ReadonlySet<string>; known?: ReadonlySet<string>;
                 /** All of `root` goes beside a snapshot, where no model reads. */
                 aside?: boolean;
                 /** Make the build context. */
                 build?: boolean;
                 /** A file an install reads for what to install (sandbox.ts manifestRule). */
                 manifest?: (rel: string) => boolean;
                 /** Values of files no snapshot holds, with their rules (rootEnvValues). */
                 rootEnv?: ReadonlyMap<string, string> }): Scrubbed {
  const realRoot = realpathSync(root);
  const removedFiles: Withheld[] = [];
  const blanked: Blanked[] = [];
  const standIns: string[] = [];
  const fakedKeys: string[] = [];
  const standInList: { path: string; line: number; rule: string }[] = [];
  const ruleOf = new Map<string, string>();
  const sandboxed = new Set<string>();
  const beside = sandboxDir(root);
  const inside = (p: string) => p === realRoot || p.startsWith(realRoot + sep);
  const holds = (dir: string) => [...o.sandbox].some((p) => p.startsWith(`${dir}/`));
  /** Regular files kept: where they are now, and their path in the repository. */
  const kept: { p: string; rel: string }[] = [];
  const pinsOf = (rel: string) => allow.find((a) => a.path === rel)?.matches ?? [];
  /** A pin of the whole file, read a piece at a time: only for a file a pin may keep although no scan reads it. */
  const pinnedWhole = (p: string, rel: string) => !!pinsOf(rel).length && pinsOf(rel).includes(pinOfFile(p) ?? "");
  /** A file named like a secret stays only when allowed, when it is a key file holding a key, which gets its fake, or when it
   * is a `.pem` of what is no secret. */
  const namedStays = (p: string, rel: string) => {
    if (pinnedWhole(p, rel)) return true;
    if (!isKeyFileName(rel)) return false;
    const read = scrubText(p, changeLimits.maxScanBytes);
    if (!read || read.binary) return false;
    return holdsOnlyPublicPem(rel, read.text) || (o.standIns && holdsPrivateKey(read.text, []));
  };
  const seen = new Set<string>(o.known ?? []);
  const guesses = new Set<string>();
  /** A file about to be left out: its value may stand elsewhere with no name beside it. */
  const leaving = (p: string, rel: string) => {
    const read = scrubText(p, changeLimits.maxScanBytes);
    if (!read || read.binary) return;
    for (const v of suspects(rel, read.text, pinsOf(rel))) {
      seen.add(v);
      if (o.standIns) guesses.add(v);
    }
  };
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
      if (isSecretPath(name) && !(st.isFile() && namedStays(p, rel))) {
        if (st.isFile()) {
          leaving(p, rel);
          removedFiles.push({ path: rel, line: 0, label: NAMED_OUT });
        }
        unlinkSync(p);
        continue;
      }
      kept.push({ p, rel });
    }
  };
  walk(root, "", false);
  const fakes = (rel: string) => o.standIns && !isLockfile(rel);
  // First every file's suspects, and what each file needs: left out, or blanked lines.
  const values = new Set<string>(o.known ?? []);
  /** Guesses that are ordinary words: out again if code anywhere uses them as names. */
  const words = new Set<string>();
  /** Big files with too many guesses for their stand-ins: in the snapshot, never in the build. */
  const notBuilt = new Set<string>();
  for (const [v, rule] of o.rootEnv ?? []) {
    seen.add(v);
    if (o.standIns) guesses.add(v);
    if (rule === WORD_RULE) words.add(v);
  }
  const blanks = new Map<string, number[]>();
  const scanned: { p: string; rel: string }[] = [];
  for (const f of kept) {
    const big = overScanLimit(f.p);
    // A file no scan reads whole stays only when allowed as it stands.
    if ((big === "binary" || big === "too large") && pinnedWhole(f.p, f.rel)) continue;
    // Else it is still looked through for a key: tests may print any file the sandbox holds.
    const key = big === "binary" || big === "too large" ? keyInStream(f.p) : null;
    if (key) {
      unlinkSync(f.p);
      sandboxed.delete(f.rel);
      removedFiles.push({ path: f.rel, ...key });
      continue;
    }
    // No model reads a binary file: read_file says only its size, grep skips it.
    if (big === "binary") continue;
    if (big === "too large") {
      // Beside the tree no model reads it either.
      if (!sandboxed.has(f.rel) && !o.aside) {
        unlinkSync(f.p);
        removedFiles.push({ path: f.rel, line: 0, label: TOO_LARGE });
      }
      continue;
    }
    const read = scrubText(f.p, changeLimits.maxScanBytes);
    if (read === null) continue;
    const { binary } = read;
    let { text } = read;
    const pins = pinsOf(f.rel);
    const scan = scanKeys(f.rel, text, pins);
    const out = leftOutReason(f.rel, read, scan, pins, fakes(f.rel));
    if (out) {
      if (!binary) leaving(f.p, f.rel);
      unlinkSync(f.p);
      sandboxed.delete(f.rel);
      removedFiles.push({ path: f.rel, ...out });
      continue;
    }
    if (binary) continue;
    // Each token of a private key gets its fake here, before anything reads the file on; a pinned file keeps its key.
    if (scan && "withhold" in scan && holdsPrivateKey(text, pins)) {
      const faked = fakeKeys(text);
      if (faked.count) {
        writeFileSync(f.p, faked.text);
        fakedKeys.push(f.rel);
        standInList.push(...changedRuns(text, faked.text).map((line) => ({ path: f.rel, line, rule: "private key" })));
        ({ text } = faked);
      }
    }
    const blank = scan && "blank" in scan ? scan : null;
    if (blank) blanks.set(f.rel, blank.blank);
    const why = new Map<string, string>();
    const found = suspects(f.rel, blank ? blank.text : text, pins, why);
    for (const v of found) {
      seen.add(v);
      if (why.get(v) === WORD_RULE) words.add(v);
    }
    const isCertain = (v: string) => isCertainRule(why.get(v) ?? "");
    const certain = fakes(f.rel) ? found.filter(isCertain) : [];
    // Each stand-in takes a slow hash: a big file full of keys would hold a run for minutes, and is no one's code.
    if (big !== null && certain.length > BIG_KEYS_MOST) {
      unlinkSync(f.p);
      sandboxed.delete(f.rel);
      removedFiles.push({ path: f.rel, line: 1, label: `over ${BIG_KEYS_MOST} key-shaped strings` });
      continue;
    }
    for (const v of certain) {
      values.add(v);
      ruleOf.set(v, why.get(v)!);
    }
    const guessed = fakes(f.rel) ? found.filter((v) => !isCertain(v)) : [];
    if (big !== null && guessed.length > BIG_KEYS_MOST) notBuilt.add(f.rel);
    else for (const v of guessed) guesses.add(v);
    scanned.push(f);
  }
  const textOfScanned = (f: { p: string }) => scrubText(f.p, changeLimits.maxScanBytes)?.text ?? "";
  // A word code uses as a name is a name, wherever that code is.
  for (const f of words.size ? scanned : []) {
    if (!isCodePath(f.rel)) continue;
    const text = textOfScanned(f);
    for (const v of words) {
      if (!values.has(v) && usedAsName(v, text, f.rel)) {
        words.delete(v);
        seen.delete(v);
        guesses.delete(v);
      }
    }
  }
  // A certain value is certain everywhere.
  for (const v of values) guesses.delete(v);
  // Then each value's stand-in, wherever it is: for the build each guess too, into a file of its own.
  const made = new Map<string, string>();
  const replace = values.size ? standInsFor(values, made) : null;
  const context = buildContextDir(root);
  const toBuild = o.build && guesses.size ? standInsFor([...values, ...guesses], made) : null;
  for (const f of scanned) {
    const lines = blanks.get(f.rel);
    let text = scrubText(f.p, changeLimits.maxScanBytes)!.text;
    if (lines) text = (scanKeys(f.rel, text, pinsOf(f.rel)) as { text: string }).text;
    const r = replace && fakes(f.rel) ? replace(text, pinsOf(f.rel)) : { text, count: 0 };
    // A manifest keeps its guesses, as a stand-in there can break an install; every other file gets them.
    const built = toBuild && fakes(f.rel) && !o.manifest?.(f.rel) && !sandboxed.has(f.rel) && !notBuilt.has(f.rel)
      ? toBuild(text, pinsOf(f.rel)) : null;
    if (built && built.text !== r.text) {
      const at = join(context, f.rel);
      mkdirSync(dirname(at), { recursive: true });
      writeFileSync(at, built.text, { mode: lstatSync(f.p).mode & 0o777 });
    }
    if (!lines && !r.count) continue;
    writeFileSync(f.p, r.text);
    if (lines) blanked.push({ path: f.rel, lines });
    if (r.count) {
      standIns.push(f.rel);
      standInList.push(...placesOf(f.rel, text, values, ruleOf));
    }
  }
  // Folders the moves left empty go.
  for (const rel of sandboxed) {
    for (let d = posix.dirname(rel); d !== "."; d = posix.dirname(d)) {
      const at = join(root, d);
      if (!existsSync(at) || readdirSync(at).length) break;
      rmdirSync(at);
    }
  }
  // Last: a hard link must not see the writes above.
  if (toBuild) linkTree(root, context, notBuilt);
  const byPath = (a: { path: string }, b: { path: string }) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  return { withheld: removedFiles.sort(byPath), blanked: blanked.sort(byPath), standIns: standIns.sort(), fakedKeys: fakedKeys.sort(),
    standInList: standInList.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line),
    standInValues: new Set([...values].map((v) => made.get(v)).filter((v): v is string => !!v)),
    sandboxed: [...sandboxed].sort(), secrets: values, guesses, suspects: seen };
}

/** The first line of each run of lines that differ between two texts of the same lines. */
function changedRuns(before: string, after: string): number[] {
  const a = before.split("\n"), b = after.split("\n"), out: number[] = [];
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i] && (i === 0 || a[i - 1] === b[i - 1])) out.push(i + 1);
  return out;
}

/** Where `values` stand in `text`, with the rule of each: path, line and rule only. A file whose lines are not found
 * (an encoded form) is listed at line 0. */
function placesOf(path: string, text: string, values: ReadonlySet<string>, ruleOf: ReadonlyMap<string, string>)
  : { path: string; line: number; rule: string }[] {
  const here = [...values].filter((v) => text.includes(v));
  const seen = new Set<string>(), out: { path: string; line: number; rule: string }[] = [];
  text.split("\n").forEach((l, i) => {
    for (const v of here) {
      const rule = ruleOf.get(v) ?? "key-shaped";
      if (l.includes(v) && !seen.has(`${i}\0${rule}`)) {
        seen.add(`${i}\0${rule}`);
        out.push({ path, line: i + 1, rule });
      }
    }
  });
  return out.length ? out : [{ path, line: 0, rule: "key-shaped" }];
}

/** A text file's content (scrubText); null for a binary file. */
function textOf(p: string): string | null {
  const read = scrubText(p);
  return read && !read.binary ? read.text : null;
}

/** How a snapshot treats a file over SCAN_LIMIT (null: it is not): text within the cap is scanned, text past it is left
 * out, and a binary file is only looked through for a key (keyInStream). */
function overScanLimit(p: string): "scan" | "binary" | "too large" | null {
  try {
    const { size } = statSync(p);
    if (size <= Math.min(SCAN_LIMIT, changeLimits.maxScanBytes)) return null;
    const head = Buffer.alloc(8000);
    const fd = openSync(p, "r");
    try {
      const n = readSync(fd, head, 0, head.length, 0);
      if (head.subarray(0, n).includes(0)) return "binary";
    } finally {
      closeSync(fd);
    }
    return size > changeLimits.maxScanBytes ? "too large" : "scan";
  } catch {
    return null;
  }
}

/** A file's content as UTF-8, and whether it is binary (a NUL in its first 8000 bytes); null when larger than `limit`. */
function scrubText(p: string, limit = SCAN_LIMIT): { text: string; binary: boolean } | null {
  try {
    if (statSync(p).size > limit) return null;
    const bytes = readFileSync(p);
    return { text: bytes.toString("utf8"), binary: bytes.subarray(0, 8000).includes(0) };
  } catch {
    return null;
  }
}
