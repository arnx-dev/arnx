// .arnxignore: paths the owner keeps out of everything arnx copies into a sandbox or sends to a model, such as data
// dumps, or the other projects in a repository that holds several. Gitignore-like: one pattern per line, # starts a
// comment; a pattern ending in / names a directory; a leading or inner / anchors it to the repository root,
// otherwise it matches a name at any depth; * stays within one path segment and ** crosses segments. A line starting
// with ! keeps what it matches again; the last line that matches a path decides.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, posix } from "node:path";
import { splitLines } from "./util";

export const FILE = ".arnxignore";

function regex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length;) {
    if (glob.startsWith("**", i)) {
      out += ".*";
      i += 2;
    } else if (glob[i] === "*") {
      out += "[^/]*";
      i += 1;
    } else if (glob[i] === "?") {
      out += "[^/]";
      i += 1;
    } else {
      out += glob[i]!.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
      i += 1;
    }
  }
  return out;
}

export function matcher(text: string): (rel: string) => boolean {
  const rules: { re: RegExp; keep: boolean }[] = [];
  for (const raw of splitLines(text)) {
    let line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const keep = line.startsWith("!");
    if (keep) line = line.slice(1).trim();
    if (!line) continue;
    const directory = line.endsWith("/");
    line = line.replace(/\/+$/, "");
    const unanchored = line.replace(/^\/+/, "");
    const anchored = line.startsWith("/") || unanchored.includes("/");
    const prefix = anchored ? "" : "(?:.*/)?";
    const suffix = directory ? "/.*" : "(?:/.*)?";
    rules.push({ re: new RegExp(`^${prefix}${regex(unanchored)}${suffix}$`, "s"), keep });
  }
  return (rel) => {
    for (let i = rules.length - 1; i >= 0; i--) if (rules[i]!.re.test(rel)) return !rules[i]!.keep;
    return false;
  };
}

export function loadIgnore(repo: string): (rel: string) => boolean {
  const path = join(repo, FILE);
  return existsSync(path) ? matcher(readFileSync(path, "utf8")) : () => false;
}

/** Extensions that hold data rather than code. json, ndjson and jsonl count only above JSON_LIMIT bytes. */
export const DATA_EXTENSIONS = new Set(["csv", "tsv", "sqlite", "sqlite3", "db", "parquet", "xlsx", "xls", "pkl",
  "pickle", "session"]);
const JSON_EXTENSIONS = new Set(["json", "ndjson", "jsonl"]);
const JSON_LIMIT = 100_000;
/** Names with these words are data-like unless they are code or configuration. */
const DATA_WORDS = /dump|export|backup/;
/** Lockfiles are large JSON or YAML but are what installs need: never data. */
const LOCKFILES = /^(package-lock\.json|npm-shrinkwrap\.json|composer\.lock|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|[^/]*\.lock)$/;
/** A lockfile (by its name, any folder): installs need it, so the snapshot keeps it; a review does not send its text. */
export const isLockfile = (path: string) => LOCKFILES.test(posix.basename(path).toLowerCase());
const CODE_EXTENSIONS = new Set(["py", "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "cs", "go", "java", "kt", "rb",
  "php", "swift", "c", "h", "cpp", "hpp", "md", "toml", "yaml", "yml", "lock", "cfg", "ini"]);

const lsFiles = (repo: string, ...args: string[]) => (spawnSync("git", ["-C", repo, "ls-files", "-z", ...args],
  { encoding: "utf8", maxBuffer: 1 << 30 }).stdout ?? "").split("\0").filter(Boolean);

/** What `arnx init` always writes: data files, dumps and images by pattern, with the folders tests read their
 * fixtures from kept, since the sandbox copy leaves out what this file names. */
export const DEFAULT_IGNORE = `# Data, dumps and images: kept out of everything arnx sends to a model or copies into a sandbox.
*.csv
*.tsv
*.parquet
*.xlsx
*.xls
*.sqlite
*.sqlite3
*.db
*.pkl
*.pickle
*.dump
*.bak
*.sql.gz
*dump*.sql
*dump*.json
*export*.json
*.png
*.jpg
*.jpeg
*.gif
*.webp
*.bmp
*.tiff
# Test fixtures stay: tests read them.
!test/
!tests/
!__tests__/
!spec/
!fixtures/
!__fixtures__/
!testdata/
`;

/** DEFAULT_IGNORE, then the other data-like files this repository has (large JSON, names with dump, export or
 * backup) that its patterns do not cover. */
export function initialIgnore(repo: string, untracked = false): string {
  const covered = matcher(DEFAULT_IGNORE);
  const more = proposeIgnore(repo, untracked).files.filter((f) => !covered(f));
  return DEFAULT_IGNORE + (more.length ? `# Other data-like files here:\n${more.map((f) => `/${f}\n`).join("")}` : "");
}

/** Files that look like data (exports, dumps, databases), and an .arnxignore that keeps them out. The files are those
 * a review sends: tracked, and untracked ones git does not ignore only with `untracked` or with no commits yet
 * (`untracked` in the result names those). Untracked data-like files a review leaves out are not proposed (their names
 * would go into a file the owner commits); `leftOut` names them. */
export function proposeIgnore(repo: string, untracked = false): { files: string[]; untracked: string[];
  leftOut: string[]; text: string } {
  const others = new Set(lsFiles(repo, "--others", "--exclude-standard"));
  const sent = untracked || !(spawnSync("git", ["-C", repo, "rev-parse", "--verify", "-q", "HEAD"],
    { encoding: "utf8" }).stdout ?? "").trim();
  const ignored = loadIgnore(repo);
  const files: string[] = [], leftOut: string[] = [];
  for (const rel of new Set([...lsFiles(repo), ...others])) {
    // .arnx/ is arnx's own state; no snapshot keeps it.
    if (ignored(rel) || rel.startsWith(".arnx/")) continue;
    const name = posix.basename(rel).toLowerCase();
    if (LOCKFILES.test(name)) continue;
    // Files under test directories are fixtures the tests read, not data to hide.
    if (/(^|\/)(test|tests|__tests__|spec|fixtures|__fixtures__|testdata)\//.test(rel)) continue;
    // SQL under a migrations or schema directory is code, whatever its name says (V42__add_data_export.sql).
    if (name.endsWith(".sql") && /(^|\/)(migrations?|migrate|schemas?)\//i.test(rel)) continue;
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 ? name.slice(dot + 1) : "";
    let size = 0;
    try {
      size = statSync(join(repo, rel)).size;
    } catch {
      continue; // deleted in the working tree
    }
    if (DATA_EXTENSIONS.has(ext) || (JSON_EXTENSIONS.has(ext) && size > JSON_LIMIT) ||
        (DATA_WORDS.test(name) && !CODE_EXTENSIONS.has(ext))) {
      (others.has(rel) && !sent ? leftOut : files).push(rel);
    }
  }
  files.sort();
  leftOut.sort();
  const text = "# Proposed by `arnx init`: data-like files, kept out of everything arnx sends to a model or copies\n" +
    "# into a sandbox. Edit freely; patterns work like .gitignore.\n" + files.map((f) => `/${f}\n`).join("");
  return { files, untracked: files.filter((f) => others.has(f)), leftOut, text };
}
