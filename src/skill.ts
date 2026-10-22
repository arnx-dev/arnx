// The arnx skill for coding agents (skills/arnx/ in this repository): SKILL.md and its references, imported as text
// so every build carries them. `arnx skill install` writes them to .agents/skills/arnx/ (Codex and the other agents
// of the open Agent Skills standard) and .claude/skills/arnx/ (Claude Code) in the repository, or under ~ with --user;
// `arnx init` offers the first at a terminal.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import SKILL from "../skills/arnx/SKILL.md" with { type: "text" };
import CHECK_JSON from "../skills/arnx/references/check-json.md" with { type: "text" };
import INSTALL from "../skills/arnx/references/install.md" with { type: "text" };
import JSON_REF from "../skills/arnx/references/json.md" with { type: "text" };
import REVIEW_JSON from "../skills/arnx/references/review-json.md" with { type: "text" };
import UNCOVERED from "../skills/arnx/references/uncovered.md" with { type: "text" };
import { ArnxError } from "./errors";
import type { Env } from "./settings";

/** The skill's files, by path inside its folder. */
export const SKILL_FILES: Readonly<Record<string, string>> = {
  "SKILL.md": SKILL,
  "references/check-json.md": CHECK_JSON,
  "references/install.md": INSTALL,
  "references/json.md": JSON_REF,
  "references/review-json.md": REVIEW_JSON,
  "references/uncovered.md": UNCOVERED,
};

/** Where the skill goes, relative to a repository's root or the user's home: one copy per folder agents read. */
export const SKILL_DIRS = [".agents/skills/arnx", ".claude/skills/arnx"] as const;

/** The folders as messages name them ("a/ and b/"). */
export const skillDirsShown = (prefix = "") => SKILL_DIRS.map((d) => `${prefix}${d}/`).join(" and ");

export function userSkillRoot(env: Env): string {
  if (!env.HOME) throw new ArnxError("no home directory to install the skill in: set HOME");
  return env.HOME;
}

/** The state of the skill across its folders under `root`: same only when every copy is this arnx's. */
export function skillStates(root: string): { dir: string; state: "absent" | "same" | "different" }[] {
  return SKILL_DIRS.map((d) => ({ dir: d, state: skillState(join(root, d)) }));
}

function walk(dir: string, root = dir): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p, root) : [relative(root, p).split(sep).join("/")];
  });
}

/** absent: no folder; same: exactly this arnx's skill; different: another version, an edited copy or another skill. */
export function skillState(dir: string): "absent" | "same" | "different" {
  if (!existsSync(dir)) return "absent";
  if (!statSync(dir).isDirectory()) return "different";
  const files = walk(dir).sort();
  const want = Object.keys(SKILL_FILES).sort();
  if (files.join("\n") !== want.join("\n")) return "different";
  return want.every((f) => readFileSync(join(dir, f), "utf8") === SKILL_FILES[f]) ? "same" : "different";
}

/** Write the skill to `dir`. A folder holding something else is replaced only with `force`. */
export function installSkill(dir: string, force = false): { state: "written" | "replaced" | "unchanged";
  files: string[] } {
  const files = Object.keys(SKILL_FILES);
  const state = skillState(dir);
  if (state === "same") return { state: "unchanged", files };
  if (state === "different") {
    if (!force) {
      throw new ArnxError(`${dir} already holds a different skill (another arnx version, or edited); pass --force ` +
        "to replace it");
    }
    rmSync(dir, { recursive: true, force: true });
  }
  for (const f of files) {
    mkdirSync(dirname(join(dir, f)), { recursive: true });
    writeFileSync(join(dir, f), SKILL_FILES[f]!);
  }
  return { state: state === "different" ? "replaced" : "written", files };
}

/** Write the skill to every folder under `root`. Nothing is written while one of them holds something else, unless
 * `force`. */
export function installSkills(root: string, force = false): { state: "written" | "replaced" | "unchanged";
  files: string[] } {
  const states = skillStates(root);
  const other = states.find((s) => s.state === "different");
  if (other && !force) {
    throw new ArnxError(`${join(root, other.dir)} already holds a different skill (another arnx version, or edited); ` +
      "pass --force to replace it");
  }
  if (states.every((s) => s.state === "same")) return { state: "unchanged", files: Object.keys(SKILL_FILES) };
  for (const s of states) installSkill(join(root, s.dir), force);
  return { state: other ? "replaced" : "written", files: Object.keys(SKILL_FILES) };
}
