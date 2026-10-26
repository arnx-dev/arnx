// The version arnx reports, with where the running code came from: a build names the commit it was built from and
// when (set by scripts/build.sh), and source run directly asks git, so a stale copy is told apart from the current one.
import { spawnSync } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const VERSION = "0.1.2";

/** "<commit> <date>[ dirty]", replaced at build time; undefined when running from source. */
declare const ARNX_BUILD: string | undefined;

function git(dir: string, args: string[]): string | null {
  const r = spawnSync("git", ["-C", dir, ...args], { encoding: "utf8", timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Where the code comes from: "built <date> from <commit>" or "source <commit> (<date>)", plus uncommitted changes. */
export function buildInfo(): string {
  if (typeof ARNX_BUILD === "string") {
    const [commit, date, time, dirty] = ARNX_BUILD.split(" ");
    return `built ${date} ${time} from ${commit}${dirty ? ", with uncommitted changes" : ""}`;
  }
  const dir = dirname(fileURLToPath(import.meta.url));
  const head = git(dir, ["log", "-1", "--format=%h %cd", "--date=format:%Y-%m-%d %H:%M"]);
  if (!head) return "source, not in a git checkout";
  const [commit, ...when] = head.split(" ");
  const dirty = git(dir, ["status", "--porcelain", "--", ".."]);
  return `source ${commit} (committed ${when.join(" ")})${dirty ? ", with uncommitted changes" : ""}`;
}

export const versionLine = () => `arnx ${VERSION} (${buildInfo()})`;
