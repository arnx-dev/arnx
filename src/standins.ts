// Telling the setup agent and the developer which values arnx replaced with stand-ins. Nothing here holds, or is
// derived from, a value: files, lines and rules only.
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { someNames } from "./change";

/** One place a stand-in stands: line 0 when the line is not known. `rule` is the secrets.ts rule, or "private key". */
export interface StandInRow { path: string; line: number; rule: string }

export const STAND_INS_FILE = "stand-ins.md";

/** What the setup agent reads about the files holding stand-ins (built here, not in prompts.toml). */
export const standInsText = (files: readonly string[]): string =>
  `These files hold arnx's stand-ins for key-shaped text: ${someNames(files, 30)}. Odd values there are arnx's, not ` +
  "the project's: never undo them, never rewrite code to match them, and never call the repository corrupt because of " +
  "them. Lockfiles and manifests keep the real values, so a mismatch between them and the files above is arnx's too.";

/** The list a developer reads. File, line and rule only. */
export function standInsMd(rows: readonly StandInRow[]): string {
  const lines = rows.map((r) => `| ${r.path} | ${r.line > 0 ? r.line : "?"} | ${r.rule} |`);
  return ["# Stand-ins", "",
    "arnx replaced the text at these places with a stand-in where tests run and models read. The real values stay in " +
    "your files; this list holds none of them, nor any part of one.", "",
    "| File | Line | Rule |", "| --- | --- | --- |", ...lines, "",
    "To keep a file as it is, run `arnx allow-secret PATH`.", ""].join("\n");
}

/** Writes the list into `dir`; returns its path, or null when there is nothing to list. */
export function writeStandIns(dir: string, rows: readonly StandInRow[]): string | null {
  if (!rows.length) return null;
  mkdirSync(dir, { recursive: true });
  const at = join(dir, STAND_INS_FILE);
  writeFileSync(at, standInsMd(rows));
  return at;
}

/** The one terminal line. */
export const standInsLine = (files: readonly string[], list: string): string =>
  `stand-ins in ${files.length} ${files.length === 1 ? "file" : "files"}, real values kept here; list: ${list}`;

/** Whether `text` holds any of `values` (stand-ins). Nothing is logged. */
export const namesStandIn = (text: string, values: Iterable<string>): boolean => {
  for (const v of values) if (v && text.includes(v)) return true;
  return false;
};

/** The literal search texts of `sed s` commands in install lines that no file holds. */
export function staleRewrites(install: readonly string[], holds: (text: string) => boolean): string[] {
  const out: string[] = [];
  for (const line of install) {
    for (const m of line.matchAll(/\bsed\b[^|;&\n]*?(['"])s([/|#,:@])((?:\\.|(?!\2)[^\\])+?)\2/g)) {
      const delim = m[2]!;
      const text = m[3]!.replace(/\\(.)/g, (_all, c: string) => (c === delim || c === "." || c === "/" ? c : `\\${c}`));
      // A pattern, not a literal: it may match without the text being there.
      if (/[*[\]^$+?(){}|\\]/.test(text) || !text) continue;
      if (!holds(text) && !out.includes(text)) out.push(text);
    }
  }
  return out;
}

const HOLDS_LIMIT = 2_000_000;

/** `holds` for the files under `dir` (the build context): does any text file hold the text. */
export function holdsIn(dir: string): (text: string) => boolean {
  let files: string[] | null = null;
  const list: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile()) list.push(p);
    }
  };
  return (text) => (files ??= (existsSync(dir) ? (walk(dir), list) : [])).some((p) => {
    try {
      return statSync(p).size <= HOLDS_LIMIT && readFileSync(p, "utf8").includes(text);
    } catch {
      return false;
    }
  });
}

/** The one line a review or setup shows for a stale rewrite. */
export const staleLine = (project: string, texts: readonly string[]): string =>
  `install rewrites ${texts.map((t) => `"${t}"`).join(", ")}, which no file holds now; run ` +
  `\`arnx setup --project ${project}\``;
