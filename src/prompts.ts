// The prompts. Their default text is src/prompts.toml, grouped by step and imported as text, so the binary, the Node
// bundle and a checkout loaded at run time all carry it; any edit there changes PROMPT_VERSION, which is recorded with
// every review. A repository may replace single keys (.arnx/prompts.toml, see userprompts.ts). Templates use $name
// placeholders, filled in one pass, so code, diffs and braces in repository content need no escaping. Words that
// depend on the reviewed repository's language come from its adapter.
import { createHash } from "node:crypto";
import { posix } from "node:path";
import { parse as parseToml } from "smol-toml";
import DEFAULT_TOML from "./prompts.toml" with { type: "text" };
import { adapterFor } from "./adapters";
import type { Words } from "./adapters/types";
import type { ReviewConfig } from "./config";

// The reviewer sees its project's whole part of the change: arnx refuses changes over MAX_DIFF_BYTES instead of
// cutting them (a cut diff once hid two thirds of a branch while the review said "Complete").
export const DIFF_LIMIT = 200_000;

/** Every prompt key (`step.name`, in the order of src/prompts.toml) and the placeholders the code fills in it. A key
 * with none is sent as written. */
export const PLACEHOLDERS = {
  "review.system": ["runner", "services", "workdir", "notes"],
  "review.env_hint": ["names", "tests"],
  "review.task": ["diff", "scope", "property", "tests_dir", "runner", "test_files", "max_questions"],
  "review.coverage": ["files"],
  "review.coverage_db": ["files", "names"],
  "hunt.system": [],
  "hunt.opening": ["diff", "scope", "context"],
  "hunt.task": ["no_tests", "max_suspects"],
  "hunt.no_tests": [],
  "hunt.second_files": ["files"],
  "prove.task": ["suspects", "property", "tests_dir", "runner", "test_files", "max_questions"],
  "prove.untested": ["list"],
  "rank.system": [],
  "rank.task": ["list"],
  "questions.asked": ["list"],
  "questions.system": [],
  "questions.task": ["list"],
  "challenge.system": [],
  "challenge.task": ["diff", "test_file", "test_source", "test_id", "failure", "explanation"],
  "challenge.depends": ["questions"],
  "answer.task": ["question", "answer", "diff", "runner", "tests_dir"],
  "explain.system": [],
  "setup.system": [],
  "setup.task": ["hints"],
} as const satisfies Record<string, readonly string[]>;

export type PromptKey = keyof typeof PLACEHOLDERS;
export const PROMPT_KEYS = Object.keys(PLACEHOLDERS) as PromptKey[];
export type Templates = Readonly<Record<PromptKey, string>>;

/** The placeholders that carry what the step is about (the change, the suspects, the failure): doctor warns about an
 * override that drops one. */
export const NEEDED: Partial<Record<PromptKey, readonly string[]>> = {
  "review.env_hint": ["names"], "review.task": ["diff"], "review.coverage": ["files"],
  "review.coverage_db": ["files"], "hunt.opening": ["diff"], "hunt.second_files": ["files"],
  "prove.task": ["suspects"], "prove.untested": ["list"], "rank.task": ["list"], "questions.asked": ["list"],
  "questions.task": ["list"], "challenge.task": ["diff", "test_source", "failure"], "challenge.depends": ["questions"],
  "answer.task": ["question", "answer"], "setup.task": ["hints"],
};

const PLACEHOLDER = /\$([_a-z][_a-z0-9]*)/gi;

/** The placeholders a template uses, each once, in order. */
export const placeholdersIn = (text: string) => [...new Set([...text.matchAll(PLACEHOLDER)].map((m) => m[1]!))];

/** A text's short hash: an override's `<name>_base`. */
export const textHash = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 12);

/** src/prompts.toml read: every key there, as text. */
function readDefaults(text: string): Templates {
  const doc = parseToml(text) as Record<string, Record<string, unknown>>;
  return Object.fromEntries(PROMPT_KEYS.map((key) => {
    const [step, name] = key.split(".") as [string, string];
    const value = doc[step]?.[name];
    if (typeof value !== "string") throw new Error(`src/prompts.toml: no ${key}`);
    return [key, value];
  })) as Record<PromptKey, string>;
}

export const DEFAULTS: Templates = readDefaults(DEFAULT_TOML);

/** string.Template.substitute: one pass, inserted text is never re-scanned. */
function substitute(template: string, values: Record<string, string | number>): string {
  return template.replace(PLACEHOLDER, (_m, name: string) => {
    if (!(name in values)) throw new Error(`prompt template: no value for $${name}`);
    return String(values[name]);
  });
}

function clip(diff: string): string {
  if (diff.length <= DIFF_LIMIT) return diff;
  return diff.slice(0, DIFF_LIMIT) + "\n[diff truncated; read the changed files with the tools]\n";
}

const wordsOf = (cfg: ReviewConfig) => adapterFor(cfg).words(cfg.runner);
const join = (...parts: string[]) => posix.normalize(posix.join(...parts)).replace(/\/$/, "");

function property(words: Words): string {
  const lib = words.propertyLib;
  return lib ? `, and property-based tests (${lib}) where they fit and ${lib} is installed` : "";
}

const ticks = (xs: string[]) => xs.map((f) => `\`${f}\``).join(", ");

export const MAX_SUSPECTS = 8;

export interface Suspect { id: string; file: string; line: number; claim: string; why: string; input: string;
  expected: string; actual: string; by: string }

/** What a project's round covers: the changed files it owns and the ones it only uses. */
export interface Scope { owned: string[]; used: string[] }

function scopeText(cfg: ReviewConfig, scope: Scope | undefined): string {
  if (!scope) return "";
  const list = (xs: string[]) => xs.length ? xs.map((x) => `\`${x}\``).join(", ") : "none";
  return `\nThis review covers the project \`${cfg.name}\` (root \`${cfg.workdir}\`). Files of this change it owns: ` +
    `${list(scope.owned)}. Files it only uses: ${list(scope.used)}. Test the behaviour this project gets from the ` +
    "change.\n";
}

/** The prompts built from one set of templates: arnx's defaults, or with a repository's overrides (`overridden`). */
export class Prompts {
  constructor(readonly t: Templates = DEFAULTS, readonly overridden: readonly PromptKey[] = []) {}

  /** The hash of every template in use, in key order: recorded with the keys overridden. */
  get hash(): string {
    return textHash(PROMPT_KEYS.map((k) => this.t[k]).join("\0"));
  }

  /** `envTests`: the project's own test files that read one of its environment variables. */
  reviewSystem(cfg: ReviewConfig, envTests: string[] = []): string {
    const services = cfg.services.map((s) => s.name).join(", ") || "none";
    const notes = cfg.notes.map((n) => `- ${n}`).join("\n") || "- (none)";
    const base = substitute(this.t["review.system"], { runner: wordsOf(cfg).runner, services, workdir: cfg.workdir,
      notes });
    const names = Object.keys(cfg.env);
    if (!names.length) return base;
    return base + substitute(this.t["review.env_hint"], { names: names.map((n) => `\`${n}\``).join(", "),
      tests: envTests.length ? envTests.map((t) => `\`${t}\``).join(", ") : "none found" });
  }

  /** `db`: changed files with database code no test ran against the database, and the variables that reach it. */
  coverageTask(files: string[], db?: { files: string[]; names: string[] }): string {
    const base = files.length ? substitute(this.t["review.coverage"], { files: ticks(files) }) : "";
    if (!db?.files.length) return base;
    const extra = substitute(this.t["review.coverage_db"], { files: ticks(db.files), names: ticks(db.names) });
    return base ? base + extra : extra.trimStart() + " Then reply with the JSON again, listing every test.";
  }

  huntSystem(): string {
    return this.t["hunt.system"];
  }

  /** The first message of a hunted review: the change, then the hunt. */
  huntTask(cfg: ReviewConfig, diff: string, context: string, scope?: Scope): string {
    return substitute(this.t["hunt.opening"], { diff: clip(diff), scope: scopeText(cfg, scope),
      context: context || "(none found)" }) +
      substitute(this.t["hunt.task"], { no_tests: this.t["hunt.no_tests"], max_suspects: MAX_SUSPECTS });
  }

  /** The second hunter's task: the same opening and hunt, without tools, with the changed definitions whole. */
  secondHuntTask(cfg: ReviewConfig, diff: string, context: string, definitions: string, scope?: Scope): string {
    return substitute(this.t["hunt.opening"], { diff: clip(diff), scope: scopeText(cfg, scope),
      context: context || "(none found)" }) +
      substitute(this.t["hunt.task"], { no_tests: "", max_suspects: MAX_SUSPECTS }) +
      (definitions ? substitute(this.t["hunt.second_files"], { files: definitions }) : "");
  }

  /** The note added to a follow-up: the questions already asked, not to be asked again. */
  askedTask(questions: string[]): string {
    return questions.length ? substitute(this.t["questions.asked"], { list: questions.map((q) => `- ${q}`).join("\n") })
      : "";
  }

  mergeSystem(): string {
    return this.t["questions.system"];
  }

  mergeTask(questions: string[]): string {
    return substitute(this.t["questions.task"], { list: questions.map((q, i) => `Q${i + 1}: ${q}`).join("\n") });
  }

  untestedSuspectsTask(items: { id: string; reason?: string }[]): string {
    return substitute(this.t["prove.untested"], { list: items.map((x) => x.reason ? `${x.id} (you said: ${x.reason})`
      : x.id).join(", ") });
  }

  rankSystem(): string {
    return this.t["rank.system"];
  }

  rankTask(suspects: Suspect[]): string {
    return substitute(this.t["rank.task"], { list: suspects.map((s) => `${s.id} \`${s.file}:${s.line}\`: ${s.claim}` +
      (s.why ? ` (${s.why.slice(0, 300)})` : "")).join("\n") });
  }

  proveTask(cfg: ReviewConfig, suspects: Suspect[], maxQuestions: number): string {
    const w = wordsOf(cfg);
    const list = suspects.map((s) => {
      const parts = [`${s.id} \`${s.file}:${s.line}\`: ${s.claim}`];
      if (s.why) parts.push(`  Why: ${s.why}`);
      const shown = [s.input && `Shown by: ${s.input}.`, s.expected && `Expected: ${s.expected}.`,
        s.actual && `Actual: ${s.actual}.`].filter(Boolean);
      if (shown.length) parts.push(`  ${shown.join(" ")}`);
      return parts.join("\n");
    }).join("\n") || "(none)";
    return substitute(this.t["prove.task"], { suspects: list, property: property(w),
      tests_dir: join(cfg.workdir, cfg.testsDir), runner: w.runner, test_files: w.testFiles,
      max_questions: maxQuestions });
  }

  reviewTask(cfg: ReviewConfig, diff: string, maxQuestions: number, scope?: Scope): string {
    const w = wordsOf(cfg);
    return substitute(this.t["review.task"], { diff: clip(diff), scope: scopeText(cfg, scope), property: property(w),
      tests_dir: join(cfg.workdir, cfg.testsDir), runner: w.runner, test_files: w.testFiles,
      max_questions: maxQuestions });
  }

  setupSystem(): string {
    return this.t["setup.system"];
  }

  /** The setup task, with hints: what the detector found and the language-specific advice of each adapter present. */
  setupTask(hints: string): string {
    return substitute(this.t["setup.task"], { hints });
  }

  challengeSystem(): string {
    return this.t["challenge.system"];
  }

  challengeUser(diff: string, testFile: string, testSource: string, testId: string, failure: string,
                explanation: string, questions: string[] = []): string {
    const body = substitute(this.t["challenge.task"], { diff: clip(diff).slice(0, 30_000), test_file: testFile,
      test_source: testSource.slice(0, 40_000), test_id: testId, failure: failure.slice(0, 4000),
      explanation: explanation || "(none given)" });
    if (!questions.length) return body;
    // The reviewer asks the owner what it cannot decide; a test may assume one answer. Such a finding waits.
    return `${body}\n\n` + substitute(this.t["challenge.depends"],
      { questions: questions.map((q, i) => `Q${i + 1}: ${q}`).join("\n") });
  }

  answerTask(cfg: ReviewConfig, question: string, answer: string, diff: string): string {
    return substitute(this.t["answer.task"], { question, answer, diff: clip(diff), runner: wordsOf(cfg).runner,
      tests_dir: join(cfg.workdir, cfg.testsDir, "answers") });
  }

  explainSystem(): string {
    return this.t["explain.system"];
  }
}

/** arnx's own prompts, unchanged: every review without overrides runs these. */
export const DEFAULT_PROMPTS = new Prompts();

export const reviewSystem: Prompts["reviewSystem"] = (...a) => DEFAULT_PROMPTS.reviewSystem(...a);
export const coverageTask: Prompts["coverageTask"] = (...a) => DEFAULT_PROMPTS.coverageTask(...a);
export const huntSystem: Prompts["huntSystem"] = () => DEFAULT_PROMPTS.huntSystem();
export const huntTask: Prompts["huntTask"] = (...a) => DEFAULT_PROMPTS.huntTask(...a);
export const secondHuntTask: Prompts["secondHuntTask"] = (...a) => DEFAULT_PROMPTS.secondHuntTask(...a);
export const askedTask: Prompts["askedTask"] = (...a) => DEFAULT_PROMPTS.askedTask(...a);
export const mergeSystem: Prompts["mergeSystem"] = () => DEFAULT_PROMPTS.mergeSystem();
export const mergeTask: Prompts["mergeTask"] = (...a) => DEFAULT_PROMPTS.mergeTask(...a);
export const untestedSuspectsTask: Prompts["untestedSuspectsTask"] = (...a) =>
  DEFAULT_PROMPTS.untestedSuspectsTask(...a);
export const rankSystem: Prompts["rankSystem"] = () => DEFAULT_PROMPTS.rankSystem();
export const rankTask: Prompts["rankTask"] = (...a) => DEFAULT_PROMPTS.rankTask(...a);
export const proveTask: Prompts["proveTask"] = (...a) => DEFAULT_PROMPTS.proveTask(...a);
export const reviewTask: Prompts["reviewTask"] = (...a) => DEFAULT_PROMPTS.reviewTask(...a);
export const setupSystem: Prompts["setupSystem"] = () => DEFAULT_PROMPTS.setupSystem();
export const setupTask: Prompts["setupTask"] = (...a) => DEFAULT_PROMPTS.setupTask(...a);
export const challengeUser: Prompts["challengeUser"] = (...a) => DEFAULT_PROMPTS.challengeUser(...a);
export const answerTask: Prompts["answerTask"] = (...a) => DEFAULT_PROMPTS.answerTask(...a);
export const CHALLENGE_SYSTEM = DEFAULTS["challenge.system"];
export const EXPLAIN_SYSTEM = DEFAULTS["explain.system"];

export const CHALLENGE_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["verdict", "reason", "depends_on"],
  properties: { verdict: { type: "string", enum: ["confirmed", "disputed"] }, reason: { type: "string" },
    depends_on: { type: "string" } },
};

export const MERGE_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["same"],
  properties: { same: { type: "array", items: { type: "array", items: { type: "string" } } } },
};

export const RANK_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["order"],
  properties: { order: { type: "array", items: { type: "string" } } },
};

export const HUNT_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["suspects", "questions"],
  properties: {
    suspects: { type: "array", items: { type: "object", additionalProperties: false,
      required: ["file", "line", "claim", "why", "input", "expected", "actual"],
      properties: { file: { type: "string" }, line: { type: "integer" }, claim: { type: "string" },
        why: { type: "string" }, input: { type: "string" }, expected: { type: "string" },
        actual: { type: "string" } } } },
    questions: { type: "array", items: { type: "string" } },
  },
};

export const EXPLAIN_SCHEMA: Record<string, unknown> = {
  type: "object", additionalProperties: false, required: ["groups"],
  properties: { groups: { type: "array", items: { type: "object", additionalProperties: false,
    required: ["findings", "title", "input", "actual", "expected", "consequence", "severity"],
    properties: { findings: { type: "array", items: { type: "string" } }, title: { type: "string" },
      severity: { type: "string", enum: ["high", "medium", "low"] },
      input: { type: "string" }, actual: { type: "string" }, expected: { type: "string" },
      consequence: { type: "string" } } } } },
};

export function explainUser(diff: string, findings: { id: string; testId: string; message: string;
  explanation: string; reason: string; verdict: string | null; file: string | null }[],
                            sources: Record<string, string>): string {
  const files = [...new Set(findings.map((f) => f.file).filter((x): x is string => !!x))];
  const tests = files.map((p) => `<test file="${p}">\n${(sources[p] ?? "").slice(0, 20_000)}\n</test>`).join("\n");
  const list = findings.map((f) => `<finding id="${f.id}">\nTest: ${f.testId}\nFailure:\n${f.message.slice(0, 2000)}\n` +
    `Reviewer's explanation: ${f.explanation || "(none given)"}\n` +
    `Second opinion: ${f.verdict ?? "not given"}${f.reason ? `: ${f.reason}` : ""}\n</finding>`).join("\n");
  return `The change:\n<diff>\n${clip(diff).slice(0, 30_000)}\n</diff>\n\nThe test files:\n${tests}\n\n` +
    `The findings:\n${list}\n\nPut every finding id in exactly one group.`;
}

// The prompts that decide what is found, in 0.1.2's order: the same text gives the same version. explain.system
// words the report only and is left out.
const VERSIONED: PromptKey[] = ["review.system", "review.task", "setup.system", "setup.task", "challenge.system",
  "challenge.task", "answer.task", "review.env_hint", "review.coverage", "hunt.system", "hunt.opening", "hunt.task",
  "hunt.no_tests", "hunt.second_files", "prove.task", "review.coverage_db", "prove.untested", "rank.system",
  "rank.task", "challenge.depends", "questions.asked", "questions.system", "questions.task"];

export const PROMPT_VERSION = createHash("sha256").update(VERSIONED.map((k) => DEFAULTS[k]).join("\0"))
  .digest("hex").slice(0, 12);
