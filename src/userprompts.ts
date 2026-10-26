// The repository's own prompts: .arnx/prompts.toml replaces single keys of arnx's defaults (src/prompts.toml), and
// every key it leaves out follows arnx's defaults, also after an upgrade. Each override records the default it was
// copied from (`<name>_base`, a hash), so doctor can say when arnx changed that default since. Commands that run
// models on the user's own keys read it; arnx cloud runs its own prompts and nothing of this file is sent (the fix
// prompt's keys apply either way: accept builds that prompt here). Approval does not cover it (the stamp is
// review.yaml's alone): a review records the keys overridden and the prompts' hash.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseToml } from "smol-toml";
import { git } from "./change";
import { ArnxError } from "./errors";
import { DEFAULT_PROMPTS, DEFAULTS, isModelKey, NEEDED, PLACEHOLDERS, placeholdersIn, PROMPT_KEYS, type PromptKey,
  Prompts, textHash } from "./prompts";

export const PROMPTS_FILE = ".arnx/prompts.toml";
/** Said when arnx cloud runs the models of a repository with overrides. */
export const CLOUD_PROMPTS = "arnx cloud uses its own prompts; yours apply with your own keys";

export const promptsPath = (repo: string) => join(repo, ".arnx", "prompts.toml");

/** One overridden key: the text, and the hash of the default it was copied from (null when not recorded). */
export interface Override { key: PromptKey; text: string; base: string | null }

const STEPS = [...new Set(PROMPT_KEYS.map((k) => k.split(".")[0]!))];
const isKey = (k: string): k is PromptKey => k in PLACEHOLDERS;
const stepKeys = (step: string) => PROMPT_KEYS.filter((k) => k.startsWith(`${step}.`))
  .map((k) => k.slice(step.length + 1));
const isTable = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null &&
  !Array.isArray(v) && !(v instanceof Date);
const bad = (m: string) => new ArnxError(`${PROMPTS_FILE}: ${m}`);
const listed = (xs: readonly string[], prefix = "") => xs.length ? xs.map((x) => `${prefix}${x}`).join(", ") : "none";

/** The error for a key arnx does not have, naming the ones it does. */
export function unknownKey(key: string): ArnxError {
  const step = key.split(".")[0]!;
  return new ArnxError(STEPS.includes(step) ? `unknown key ${key}; ${step} has ${listed(stepKeys(step))}`
    : `unknown key ${key}; the steps are ${listed(STEPS)} (\`arnx prompts\` lists the keys)`);
}

/** The overrides in .arnx/prompts.toml, in key order (none without the file). */
export function readOverrides(repo: string): Override[] {
  const path = promptsPath(repo);
  return existsSync(path) ? parseOverrides(readFileSync(path, "utf8")) : [];
}

/** Refuses what arnx would not use: an unknown step or key, a value that is not text, a $placeholder the key does not
 * offer. A `<name>_base` without its text is ignored. */
export function parseOverrides(text: string): Override[] {
  let doc: Record<string, unknown>;
  try {
    doc = parseToml(text);
  } catch (e) {
    throw bad((e as Error).message.split("\n")[0]!);
  }
  const texts = new Map<PromptKey, string>(), bases = new Map<PromptKey, string>();
  for (const [step, table] of Object.entries(doc)) {
    if (!STEPS.includes(step) || !isTable(table)) throw bad(unknownKey(step).message);
    for (const [name, value] of Object.entries(table)) {
      const base = name.endsWith("_base") && isKey(`${step}.${name.slice(0, -5)}`);
      const key = `${step}.${base ? name.slice(0, -5) : name}`;
      if (!isKey(key)) throw bad(unknownKey(`${step}.${name}`).message);
      if (typeof value !== "string") throw bad(`${step}.${name} must be text`);
      (base ? bases : texts).set(key, value);
    }
  }
  return PROMPT_KEYS.filter((k) => texts.has(k)).map((key) => {
    const t = texts.get(key)!;
    const offered: readonly string[] = PLACEHOLDERS[key];
    const unknown = placeholdersIn(t).filter((p) => !offered.includes(p));
    if (unknown.length) throw bad(`${key} has $${unknown[0]}; it offers ${listed(offered, "$")}`);
    return { key, text: t, base: bases.get(key) ?? null };
  });
}

/** The prompts a brain on the user's own keys runs: arnx's defaults with the repository's overrides. */
export function promptsFor(repo: string): Prompts {
  const overrides = readOverrides(repo);
  if (!overrides.length) return DEFAULT_PROMPTS;
  return new Prompts({ ...DEFAULTS, ...Object.fromEntries(overrides.map((o) => [o.key, o.text])) },
    overrides.map((o) => o.key));
}

/** True when the repository's prompts file overrides a prompt a model is sent (or does not read: it is the user's
 * still). The fix prompt's keys apply with arnx cloud too: arnx builds that prompt here. */
export function hasOverrides(repo: string): boolean {
  try {
    return readOverrides(repo).some((o) => isModelKey(o.key));
  } catch {
    return true;
  }
}

/** Said at a review's start when its change edits the prompts file: the review reads the working tree's. */
export const PROMPTS_EDITED = "this change edits .arnx/prompts.toml; the review uses its version";

/** Whether the change adds, edits or removes .arnx/prompts.toml: its text at the change's base against its head (the
 * working tree when the change has none). An absent file reads as empty. */
export function changeEditsPrompts(repo: string, change: { base: string; head: string | null }): boolean {
  const at = (rev: string) => git(repo, ["show", `${rev}:${PROMPTS_FILE}`], [0, 128]);
  const path = promptsPath(repo);
  const after = change.head ? at(change.head) : existsSync(path) ? readFileSync(path, "utf8") : "";
  return at(change.base) !== after;
}

/** doctor's notes on the overrides: a default arnx changed since it was copied, a placeholder the step needs
 * dropped. */
export function overrideWarnings(overrides: Override[]): string[] {
  return overrides.flatMap(({ key, text, base }) => {
    const out: string[] = [];
    if (base !== null && base !== textHash(DEFAULTS[key])) {
      out.push(`arnx changed ${key}; compare with \`arnx prompts copy ${key}\``);
    }
    const used = placeholdersIn(text);
    const dropped = (NEEDED[key] ?? []).filter((p) => !used.includes(p));
    if (dropped.length) out.push(`${key} drops ${listed(dropped, "$")}`);
    return out;
  });
}

/** Text as a TOML multi-line string, as src/prompts.toml holds it: lines wrapped at a space with a line-ending
 * backslash (TOML drops the break and the next line's indent, so a wrapped line never starts with a space). */
export function tomlText(text: string, width = 116): string {
  const lines = text.replace(/\\/g, "\\\\").replace(/"""/g, '""\\"').split("\n").map((line) => {
    const out: string[] = [];
    let rest = line;
    while (rest.length > width) {
      // The last single space before the width, followed by a character that is not a space.
      let at = -1;
      for (let i = width - 1; i > 0 && at < 0; i--) if (rest[i] === " " && rest[i + 1] !== " ") at = i;
      if (at < 0) break;
      out.push(rest.slice(0, at + 1) + "\\");
      rest = rest.slice(at + 1);
    }
    out.push(rest);
    return out.join("\n");
  });
  return `"""\n${lines.join("\n")}"""`;
}

const NEW_FILE = `# Your prompts: each key here replaces arnx's default of that key (\`arnx prompts\` lists them);
# every key left out follows arnx's defaults, also after an upgrade. <name>_base is the default you copied: doctor
# says when arnx changes it. Placeholders ($diff) are filled in; a key may use only those its default offers.
`;

/** Writes arnx's default of `key` into .arnx/prompts.toml with the hash it was copied from, keeping everything the file
 * holds. "present" (nothing written) when the file overrides the key already. */
export function copyDefault(repo: string, key: string): "written" | "present" {
  if (!isKey(key)) throw unknownKey(key);
  const path = promptsPath(repo);
  const before = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (parseOverrides(before).some((o) => o.key === key)) return "present";
  const [step, name] = key.split(".") as [string, string];
  const block = `${name}_base = "${textHash(DEFAULTS[key])}"\n${name} = ${tomlText(DEFAULTS[key])}\n`;
  const header = new RegExp(`^\\[\\s*${step}\\s*\\][ \\t]*(#.*)?$`, "m").exec(before);
  // Into the step's table when the file has one (right under its header), else a new table at the end.
  const at = header ? header.index + header[0].length : -1;
  const text = !before ? `${NEW_FILE}\n[${step}]\n${block}`
    : header ? `${before.slice(0, at)}\n${block}${before.slice(at).replace(/^\r?\n/, "")}`
    : `${before}${before.endsWith("\n") ? "" : "\n"}\n[${step}]\n${block}`;
  // A layout this cannot place the key in (a [step] header inside a string, say) is left to the user.
  let ok = false;
  try {
    ok = parseOverrides(text).find((o) => o.key === key)?.text === DEFAULTS[key];
  } catch {
    ok = false;
  }
  if (!ok) throw bad(`could not add ${key}; add it by hand`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return "written";
}
