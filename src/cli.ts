import { spawnSync } from "node:child_process";
import { repoLanguages } from "./detect";
import { unsupportedText } from "./languages";
// arnx command line. Exit codes: 0 no confirmed findings, 1 confirmed findings, 2 incomplete or failed, 3 setup
// required, 4 (check only) accepted tests changed since accept, 130 interrupted.
import BANNER_ANSI from "../assets/banner.ans" with { type: "text" };
import BANNER_TEXT from "../assets/banner.txt" with { type: "text" };
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import { accept, findAccepted, findReview, makeAnswerRunner, recordChosen } from "./accept";
import { ACCEPTED_RECORD, changedAccepted, changedSummary, check, checkJson, checkSummary, failingList, keepEdits,
  legacyAccepted, moveOut,
  localPinsPath, TESTS_CHANGED } from "./check";
import { colorFor, colorLines, paint } from "./color";
import { applyMarks, type Key, markInteractive, terminalKeys } from "./mark";
import { jevKey, jevModel, jevStatus } from "./jev";
import { type Next, whatNext } from "./next";
import { CloudBrain } from "./cloudbrain";
import type { Say } from "./progress";
import { type Account, byokHint, CloudClient, credentialsPath, deleteCredentials, describeAccount, deviceLogin,
  type Fetch, tokenFor, usd } from "./cloud";
import { dockerSession, suffixReviewCopies } from "./testround";
import type { SessionFactory } from "./sandbox";
import { git, repoRoot } from "./change";
import { approvalStamp, isSeedFile, loadReviewFile, parseReviewFile, type ReviewFile, reviewConfigPath, withSecretPins }
  from "./config";
import { getAdapter } from "./adapters";
import { ArnxError, internalError, SetupRequired } from "./errors";
import { FILE as IGNORE_FILE, initialIgnore } from "./ignore";
import { type AgentModel, makeAgentModel, makeChallenger, makeJsonModel, makeSecondHunter } from "./llm";
import { exitCode, failureLine, findingStatus, groupsOf, load, neededQuestions, nextSteps, parseMarks, type Review,
  summary, summaryRows, summaryStatus, wrapMarkdown, yourCall } from "./report";
import { acceptData, checkData, reportTelemetry, reviewData, type Sender, setupData,
  TELEMETRY_OPEN, telemetryLine, telemetryStatus }
  from "./telemetry";
import { Progress, type Live } from "./progress";
import { runReview } from "./reviewer";
import { envOwner, requireDocker } from "./sandbox";
import { ageDays, type EnvImage, pruneEnv, totalSize } from "./envprune";
import { cloudModels, cloudUrl, defaultSettings, type Env, keyNames, loadSettings, missingKeys, modelRefs, type ModelsMode,
  modelsMode,
  modelsSetting, recordCloudModels, recordConsent, type Settings, settingsPath, untrackedSetting, withModels,
  writeSettings }
  from "./settings";
import { providerLines, unusedKeysNote } from "./settings";
import { providerHost, resolveProvider } from "./providers";
import { isSecretPath, secretHits, secretPins } from "./secrets";
import { approveFile, coverageMap, describeCoverage, describeWithheld, type NeededFile, runSetup, type SetupResult,
  stillRed }
  from "./setup";
import { approvalScreen, approvalWarnings, type FilesSummary, filesSummary, nextStep, REVIEW_FILE, setupPreview }
  from "./setupview";
import { isoSeconds } from "./util";
import { spend } from "./spend";
import { installSkills, SKILL_DIRS, skillDirsShown, skillStates, userSkillRoot } from "./skill";
import { DEFAULTS, PLACEHOLDERS, PROMPT_KEYS, type PromptKey, textHash } from "./prompts";
import { CLOUD_PROMPTS, copyDefault, hasOverrides, type Override, overrideWarnings, PROMPTS_FILE, promptsPath,
  readOverrides } from "./userprompts";
import { recheckJson, recheckReview, recheckSummary } from "./recheck";
import { applyRemove, planRemove } from "./remove";
import { versionLine } from "./version";

/** The consent, one question: what goes to `to` (your model provider, or arnx cloud). */
export const sendQuestion = (to: string) => `Send your change and the files arnx reads to ${to}?`;
/** Said once the consent is given: what does not leave the machine. */
export const DOCKER_LINE = "(Tests run in Docker on this machine.)";
/** Where a key for a built-in provider is made. */
const KEY_PAGES: Record<string, string> = {
  ANTHROPIC_API_KEY: "https://console.anthropic.com/settings/keys",
  OPENAI_API_KEY: "https://platform.openai.com/api-keys",
};
/** What to do about missing keys: export them (where to get one), or let arnx cloud run the models. */
const keysHint = (missing: string[], cloud = true) => {
  const pages = missing.flatMap((n) => KEY_PAGES[n] ?? []);
  return `missing ${missing.join(", ")}: export ${missing.length > 1 ? "them" : "it"}` +
    `${pages.length ? ` (${pages.join(", ")})` : ""}${cloud ? ", or `arnx cloud on`" : ""}`;
};
const capital = (t: string) => t[0]!.toUpperCase() + t.slice(1);
/** The steps that call models: with arnx cloud, the login has to come before them (and only before them). */
const callsModels = (command: string) => /^arnx (setup|review|accept)\b/.test(command);
/** Where a command stops for a missing arnx cloud login (exit 3). */
const notLoggedIn = (url: string) => new SetupRequired(`not logged in to arnx cloud (${url}). Next: arnx login`);

/** Where code goes with the user's own keys: the model they set in .arnx/config.toml, whichever vendor it is. */
const YOUR_PROVIDER = "your model provider";
/** A path as one shell word: as is when it is plain, else single-quoted. */
const shellWord = (p: string) => /^[\w@%+=:,./-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`;
export const GITIGNORE = "reviews/\nrun/\nsetup/\nusage.jsonl\nprecision.jsonl\n";
export const USAGE = `usage: arnx <command> [options]

Tests every change your coding agent makes.

  next                                  the command to run now

Prepare, once per repository
  init [--cloud] [--force]              write .arnx/config.toml and .arnxignore
  setup [--untracked] [--yes] [--force] find how your tests run in Docker, then approve it
        [--project NAME | --add]        prove one project again, or cover what no project covers
  approve [--project NAME] [--yes]      run the suites in .arnx/review.yaml and approve it
  doctor                                check config, keys, Docker and the environment
  cloud on|off [--yes]                  arnx cloud's models instead of your keys, or back
  login | logout | credits              arnx cloud: sign this machine in or out; the balance
  consent [--cloud] [--yes]             agree now to send code (otherwise asked on the first send)
  allow-secret PATH...                  send files whose key-like text is a test fixture
  skill install [--user] [--force]      the arnx skill for coding agents
  prompts [copy KEY]                    the prompts; copy one to .arnx/prompts.toml to edit it
  env prune [--keep-days N] [--all-repos] [--dry-run]
                                        remove old test images
  remove [--yes] [--tests]              what arnx put in this repository: listed, deleted with --yes

Review, after each change
  review [--range A..B] [--untracked] [--no-hunt] [--resume]
                                        test the change: branch commits, uncommitted work, or the last commit

Decide
  triage [id]                           mark findings and answer questions
  accept [id] [--again] [--no-answers] [--no-check] [--copy] [--keep-edits]
                                        keep the tests behind real findings (in .arnx/tests/)
  accept --move                         move tests an older arnx kept in your test folders to .arnx/tests/

Fix
  prompt [id]                           the fix prompt for your coding agent
  check                                 run the accepted tests: what still fails
  check --review [id]                   run a review's confirmed tests before accepting

--quiet hides progress. --local or --cloud picks the models for one run. --json prints one JSON object.`;

export interface CliDeps {
  cwd: string;
  env: Env;
  ask(prompt: string): Promise<string | null>;
  out(line: string): void;
  err(line: string): void;
  /** A live progress line on a terminal's stderr (absent elsewhere: one line per event). */
  live?: Live;
  /** False skips the check that ends accept; checkSessions replaces its Docker sandbox (tests). */
  check?: boolean;
  checkSessions?: SessionFactory;
  /** approve's suites run here instead of Docker (tests). */
  approveSessions?: SessionFactory;
  /** setup's agent and its suites (tests): a scripted model, and suites outside Docker. */
  setupModel?: AgentModel;
  setupSessions?: SessionFactory;
  /** Interactive marking: keys from the terminal and a full-screen draw (absent when not a terminal). */
  keys?: () => AsyncIterator<Key> & { close?(): void };
  draw?: (lines: string[]) => void;
  width?: number;
  /** Colour stdout / stderr (a terminal, unless NO_COLOR); off when not given, so tests see plain text. */
  color?: boolean;
  colorErr?: boolean;
  dockerOk(): [boolean, string];
  /** stdout is a terminal a person reads (not a pipe, a log or --json): init's first run shows the banner there. */
  banner?: boolean;
  /** A person at a terminal can answer (stdin and stdout are terminals). */
  interactive?: boolean;
  /** Posts telemetry (default: fetch); tests replace it or point ARNX_TELEMETRY_URL at a local server. */
  telemetrySender?: Sender;
  /** Whether telemetry is collected at all (default: TELEMETRY_OPEN); tests turn it on to test asking and sending. */
  telemetryOpen?: boolean;
  /** arnx cloud's HTTP calls (default: fetch), and the waits and clock of a device login (tests make them short). */
  fetch?: Fetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type Options = Record<string, { type: "boolean" | "string" }>;
/** On the commands that call models (and on doctor and next, for their checks): this run's models, whatever the file
 * says. init's --cloud is another option: it writes the file for arnx cloud. */
const MODELS: Options = { local: { type: "boolean" }, cloud: { type: "boolean" } };
/** Every command takes --json: one JSON object on stdout, the human text on stderr, nothing asked (see JsonOut). */
const JSON_OPTION: Options = { json: { type: "boolean" } };
const COMMANDS: Record<string, { options: Options; positionals: number }> = Object.fromEntries(Object.entries({
  init: { options: { force: { type: "boolean" }, cloud: { type: "boolean" } }, positionals: 0 },
  consent: { options: { yes: { type: "boolean" }, cloud: { type: "boolean" } }, positionals: 0 },
  cloud: { options: { yes: { type: "boolean" } }, positionals: 1 },
  login: { options: {}, positionals: 0 },
  logout: { options: {}, positionals: 0 },
  credits: { options: {}, positionals: 0 },
  doctor: { options: { ...MODELS }, positionals: 0 },
  setup: { options: { yes: { type: "boolean" }, force: { type: "boolean" }, project: { type: "string" },
    add: { type: "boolean" }, quiet: { type: "boolean" }, untracked: { type: "boolean" },
    "no-untracked": { type: "boolean" }, ...MODELS }, positionals: 0 },
  approve: { options: { yes: { type: "boolean" }, project: { type: "string" }, quiet: { type: "boolean" } },
    positionals: 0 },
  review: { options: { range: { type: "string" }, quiet: { type: "boolean" }, "no-hunt": { type: "boolean" },
    resume: { type: "boolean" }, untracked: { type: "boolean" }, "no-untracked": { type: "boolean" }, ...MODELS },
    positionals: 0 },
  accept: { options: { again: { type: "boolean" }, "no-answers": { type: "boolean" }, quiet: { type: "boolean" },
    "no-check": { type: "boolean" }, copy: { type: "boolean" }, "keep-edits": { type: "boolean" }, move: { type: "boolean" }, ...MODELS },
    positionals: 1 },
  check: { options: { quiet: { type: "boolean" }, review: { type: "boolean" } },
    positionals: 1 },
  prompt: { options: {}, positionals: 1 },
  triage: { options: {}, positionals: 1 },
  next: { options: { ...MODELS }, positionals: 0 },
  "allow-secret": { options: {}, positionals: 1000 },
  skill: { options: { user: { type: "boolean" }, force: { type: "boolean" } }, positionals: 1 },
  prompts: { options: {}, positionals: 2 },
  env: { options: { "keep-days": { type: "string" }, "all-repos": { type: "boolean" }, "dry-run": { type: "boolean" } },
    positionals: 1 },
  remove: { options: { yes: { type: "boolean" }, tests: { type: "boolean" } }, positionals: 0 },
} as Record<string, { options: Options; positionals: number }>)
  .map(([name, spec]) => [name, { ...spec, options: { ...spec.options, ...JSON_OPTION } }]));

interface Args { values: Record<string, string | boolean | undefined>; positionals: string[] }
/** One of doctor's lines: ✓ (true), ✗ (false), or · (null: not done yet, the flow does it next; not a problem); then
 * the exit code a ✗ stops a command with (default 3, setup required). */
type Check = [boolean | null, string, string, number?];

/** --untracked / --no-untracked: the flag wins over `[review] untracked`; undefined when neither is given. */
function untrackedFlag(a: Args): boolean | undefined {
  if (a.values.untracked && a.values["no-untracked"]) {
    throw new ArnxError("--untracked and --no-untracked cannot be used together");
  }
  return a.values.untracked ? true : a.values["no-untracked"] ? false : undefined;
}

async function ask(prompt: string): Promise<string | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<string | null>((resolve) => {
      rl.once("close", () => resolve(null));
      rl.question(prompt).then(resolve, () => resolve(null));
    });
  } finally {
    rl.close();
  }
}

export function dockerOk(): [boolean, string] {
  try {
    requireDocker();
    return [true, "running"];
  } catch (e) {
    if (e instanceof SetupRequired) return [false, e.message];
    throw e;
  }
}

/** --json: stdout carries exactly one JSON object, written once through `write`; every human line goes to stderr and
 * nothing is asked (a question needs --yes). `done` says whether the command wrote its object. */
export interface JsonOut { command: string; write(text: string): void; done: boolean }

/** One command's JSON object: the shared fields first. Commands with their own schema (check) write it as it is. */
export function jsonObject(command: string, result: string, exitCode: number, fields: Record<string, unknown> = {})
  : string {
  return JSON.stringify({ schema_version: 1, command, result, exit_code: exitCode, ...fields }, null, 2);
}

class Commands {
  constructor(private d: CliDeps, private j: JsonOut | null = null) {}

  /** With --json, the command's JSON object (once); without it, nothing. `result` is a short word ("ok", "fail", or
   * the command's own, such as "findings"); `fields` are the command's data, snake_case. */
  private emit(result: string, exitCode: number, fields: Record<string, unknown> = {}): void {
    if (!this.j || this.j.done) return;
    this.j.write(jsonObject(this.j.command, result, exitCode, fields));
    this.j.done = true;
  }

  /** With --json, the error that stopped the command: result "error", its message and exit code. */
  fail(message: string, exitCode: number): void {
    this.emit("error", exitCode, { error: message });
  }

  /** With --json, an object written whole (a command with its own schema); without it, nothing. */
  private emitRaw(text: string): void {
    if (!this.j || this.j.done) return;
    this.j.write(text);
    this.j.done = true;
  }

  /** A progress line on stderr: the clock dimmed, stalls and retries in yellow, failures in red. */
  private progressLine = (line: string) => {
    const p = paint(!!this.d.colorErr);
    if (!p.on) return this.d.err(line);
    const m = /^(\[\d+:\d\d\]) (.*)$/.exec(line);
    if (!m) return this.d.err(line);
    const body = /retrying|trying again|network|still waiting|no reply|failed|gave no verdict|still out/.test(m[2]!) ? p.yellow(m[2]!)
      : /✗|does not do what you answered/.test(m[2]!) ? p.red(m[2]!) : m[2]!;
    this.d.err(`${p.dim(m[1]!)} ${body}`);
  };

  private async confirm(prompt: string, yes: boolean | undefined): Promise<boolean> {
    if (yes) return true;
    const answer = await this.d.ask(`${prompt} [y/N] `);
    return ["y", "yes"].includes((answer ?? "").trim().toLowerCase());
  }

  /** The consent to send code to `to`: asked (or given by --yes, and said so), then where the tests run. */
  private async agreeToSend(to: string, yes: boolean | undefined): Promise<boolean> {
    if (yes) this.d.out(`${sendQuestion(to)} yes (--yes)`);
    else if (!await this.confirm(sendQuestion(to), false)) return false;
    this.d.out(DOCKER_LINE);
    return true;
  }

  private get telemetryOpen(): boolean {
    return this.d.telemetryOpen ?? TELEMETRY_OPEN;
  }

  private repo(): string {
    const repo = repoRoot(this.d.cwd);
    envOwner.repo = repo; // images built from here on are labelled as this repository's
    return repo;
  }

  /** This run's models: --local / --cloud, else ARNX_MODELS, else the file's `[cloud] models`. */
  private mode(s: Settings, a: Args): ModelsMode {
    if (a.values.local && a.values.cloud) throw new ArnxError("--local and --cloud cannot be used together");
    return modelsMode(s, this.d.env, a.values.cloud ? "cloud" : a.values.local ? "local" : undefined);
  }

  /** This repository's settings with this run's models in them (the file stays as it is). */
  private settings(repo: string, a: Args): { s: Settings; mode: ModelsMode } {
    const file = loadSettings(repo);
    const mode = this.mode(file, a);
    return { s: withModels(file, mode), mode };
  }

  /** init creates: the config and .arnxignore, nothing else, and running it again changes nothing that is there.
   * --force rewrites the config from the defaults, keeping the consents, the telemetry choice, `[cloud]` and the
   * user's provider tables. Keys, Docker and the rest are doctor's (setup runs the same checks); the consent is asked
   * on the first send. */
  async init(a: Args): Promise<number> {
    const repo = this.repo();
    const existed = existsSync(settingsPath(repo));
    const force = !!a.values.force;
    let before: Settings | null = null; // the file as it was, when it reads
    try {
      if (existed) before = loadSettings(repo);
    } catch (e) {
      if (!(e instanceof ArnxError)) throw e;
    }
    const write = !existed || force;
    if (write) {
      const cloud = a.values.cloud ? { models: true, tests: false, effort: "medium" as const } : before?.cloud;
      const s: Settings = { ...defaultSettings(this.d.env), ...(cloud ? { cloud } : {}),
        ...(before ? { consentAt: before.consentAt, telemetry: before.telemetry } : {}),
        ...(before?.cloudConsentAt ? { cloudConsentAt: before.cloudConsentAt } : {}) };
      writeSettings(repo, s, { known: !cloudModels(s) });
    }
    const gitignore = join(repo, ".arnx", ".gitignore");
    if (write || !existsSync(gitignore)) writeFileSync(gitignore, GITIGNORE);
    const ignore = this.writeIgnore(repo);
    // A file that does not read is kept as it is: doctor says what is wrong with it.
    const now = write ? loadSettings(repo) : before;
    const cloud = !!now && cloudModels(now);
    const config = ".arnx/config.toml";
    const hint = " (models, budgets: edit to change)";
    // The banner once, on a repository's first init, and only where a person reads it: coloured when colour is on.
    if (!existed && this.d.banner) this.d.out((this.d.color ? BANNER_ANSI : BANNER_TEXT).replace(/\n+$/, "") + "\n");
    this.d.out(!existed ? `✓ arnx initialized${cloud ? " for arnx cloud" : ""}`
      : force ? "✓ arnx configuration replaced" : "✓ arnx is already initialized");
    this.d.out(`  ${config}  ${!existed ? `created${hint}` : force ? `replaced${hint}` : "kept"}`);
    this.d.out(`  ${IGNORE_FILE.padEnd(config.length)}  ${ignore ? "created" : "kept"}`);
    if (!write && a.values.cloud && now && !cloud) {
      this.d.out("It uses your own keys; `arnx cloud on` switches it to arnx cloud.");
    }
    const langs = repoLanguages(repo);
    if (langs?.onlyOthers) this.d.out(`Note: ${unsupportedText(langs.survey)}`);
    this.d.out("");
    // The flow's next step; with arnx cloud and no login, the login first.
    const then = whatNext(repo).command;
    // Nothing to set up in a repository arnx cannot review: the note above says so instead.
    const next = langs?.onlyOthers ? []
      : cloud && !tokenFor(this.d.env, cloudUrl(now, this.d.env)) && callsModels(then) ? ["arnx login", then] : [then];
    if (next[0]) this.d.out(`Next: ${next[0]}`);
    if (next[1]) this.d.out(`Then: ${next[1]}`);
    const skill = skillStates(repo).every((st) => st.state === "same");
    if (!skill) this.d.out("Optional: arnx skill install (coding agents)");
    const action = !existed ? "created" : force ? "replaced" : "kept";
    this.emit("ok", 0, { state: !existed ? "created" : force ? "replaced" : "already-initialized",
      files: [{ path: config, action }, { path: IGNORE_FILE, action: ignore ? "created" : "kept" }], cloud, next,
      skill_installed: skill, ...langs?.onlyOthers ? { unsupported: unsupportedText(langs.survey) } : {} });
    return 0;
  }

  /** `arnx cloud on|off`: this repository's models from arnx cloud (its consent asked once, and recorded), or from the
   * user's own keys again. Only `[cloud] models` changes in the file. */
  async cloud(a: Args): Promise<number> {
    const sub = a.positionals[0];
    if (sub !== "on" && sub !== "off") throw new ArnxError("usage: arnx cloud on|off [--yes]");
    const repo = this.repo();
    const s = loadSettings(repo);
    const flow = whatNext(repo);
    const steps = [flow.command, ...flow.then ? [flow.then] : []];
    if (sub === "on") {
      const already = cloudModels(s);
      if (!s.cloudConsentAt) {
        if (!await this.agreeToSend("arnx cloud", a.values.yes as boolean)) {
          throw new SetupRequired("cloud consent declined; nothing changed");
        }
        recordConsent(repo, "cloud_consent_at", isoSeconds(new Date()));
      }
      if (!already) recordCloudModels(repo, true);
      this.d.out(already ? "arnx cloud is already on." : "✓ arnx cloud on: its models run the reviews, not your keys");
      // The login comes first only when the next step calls models; otherwise it is said for later.
      const loggedIn = !!tokenFor(this.d.env, cloudUrl(s, this.d.env));
      const next = !loggedIn && callsModels(flow.command) ? ["arnx login", flow.command] : steps;
      this.d.out(`Next: ${next[0]}`);
      if (next[1]) this.d.out(`Then: ${next[1]}`);
      if (!loggedIn && next[0] !== "arnx login") this.d.out("arnx login is needed before the next review.");
      this.emit("ok", 0, { models: true, already_on: already, logged_in: loggedIn, next });
      return 0;
    }
    recordCloudModels(repo, false);
    this.d.out("✓ arnx cloud off: your own model providers run the reviews");
    const missing = missingKeys(s, this.d.env);
    if (missing.length) this.d.out(`${capital(keysHint(missing, false))}.`);
    const next = missing.length ? ["arnx doctor"] : steps;
    this.d.out(`Next: ${next[0]}`);
    if (next[1]) this.d.out(`Then: ${next[1]}`);
    this.emit("ok", 0, { models: false, next, missing_keys: missing });
    return 0;
  }

  async consent(a: Args): Promise<number> {
    const repo = this.repo();
    const file = loadSettings(repo); // a file to record it in, and one that reads
    const cloud = !!a.values.cloud;
    const to = cloud ? "arnx cloud" : YOUR_PROVIDER;
    if (!await this.agreeToSend(to, a.values.yes as boolean)) {
      throw new SetupRequired("consent declined; nothing written");
    }
    const key = cloud ? "cloud_consent_at" : "consent_at";
    const at = isoSeconds(new Date());
    recordConsent(repo, key, at);
    this.d.out(`✓ Consent recorded: code may go to ${to}`);
    this.emit("ok", 0, { recorded: key, at, to });
    return 0;
  }

  /** Before code first goes to a model: the consent for where it goes (your model provider, or arnx cloud), asked at a
   * terminal or given by --yes, and recorded once. Without either, or when it is declined, nothing is sent (exit 3).
   * The settings come back with it recorded. */
  private async agreed(repo: string, s: Settings, mode: ModelsMode, yes?: boolean): Promise<Settings> {
    const cloud = cloudModels(s);
    if (cloud ? s.cloudConsentAt : s.consentAt) return s;
    const to = cloud ? "arnx cloud" : YOUR_PROVIDER;
    if (!yes && !this.d.interactive) {
      throw new SetupRequired(`${cloud ? `arnx models is on (${modelsSetting(mode)}), and ` : ""}sending code to ${to} ` +
        `has not been agreed to; nothing sent: run \`arnx consent${cloud ? " --cloud" : ""}\``);
    }
    if (!await this.agreeToSend(to, yes)) throw new SetupRequired("consent declined; nothing sent");
    const at = isoSeconds(new Date());
    recordConsent(repo, cloud ? "cloud_consent_at" : "consent_at", at);
    return cloud ? { ...s, cloudConsentAt: at } : { ...s, consentAt: at };
  }

  async skill(a: Args): Promise<number> {
    if (a.positionals[0] !== "install") throw new ArnxError("usage: arnx skill install [--user] [--force]");
    const user = !!a.values.user;
    const root = user ? userSkillRoot(this.d.env) : this.repo();
    const shown = skillDirsShown(user ? "~/" : "");
    const r = installSkills(root, !!a.values.force);
    this.emit("ok", 0, { state: r.state, dirs: [...SKILL_DIRS].map((d) => user ? `~/${d}` : d), user });
    if (r.state === "unchanged") {
      this.d.out(`${shown} already hold this arnx's skill; nothing written.`);
      return 0;
    }
    this.d.out(`${r.state === "replaced" ? "Replaced" : "Wrote"} the arnx skill in ${shown}${user ? "" : "; commit them"}.`);
    return 0;
  }

  /** The prompt keys, the ones .arnx/prompts.toml overrides marked; `copy KEY` writes arnx's default of KEY there. */
  async prompts(a: Args): Promise<number> {
    const [sub, key] = a.positionals;
    if (sub !== undefined && !(sub === "copy" && key)) throw new ArnxError("usage: arnx prompts [copy KEY]");
    const repo = this.repo();
    if (key) return this.copyPrompt(repo, key);
    const mine = new Map(readOverrides(repo).map((o) => [o.key, o]));
    const changed = (o: Override | undefined) => !!o && o.base !== null && o.base !== textHash(DEFAULTS[o.key]);
    const width = Math.max(...PROMPT_KEYS.map((k) => k.length));
    for (const k of PROMPT_KEYS) {
      const o = mine.get(k);
      this.d.out(o ? `${k.padEnd(width)}  yours${changed(o) ? "; arnx changed its default since" : ""}` : k);
    }
    this.d.out("");
    this.d.out(mine.size ? `${mine.size} yours, in ${PROMPTS_FILE}.` : "To change one: arnx prompts copy KEY");
    const cloud = mine.size > 0 && this.cloudOn(repo, a);
    if (cloud) this.d.out(CLOUD_PROMPTS);
    this.emit("ok", 0, { file: PROMPTS_FILE, cloud, prompts: PROMPT_KEYS.map((k) => ({ key: k, overridden: mine.has(k),
      default_changed: changed(mine.get(k)), placeholders: [...PLACEHOLDERS[k]] })) });
    return 0;
  }

  /** arnx's default of `key` into .arnx/prompts.toml; when the file has the key already, the default is printed. */
  private copyPrompt(repo: string, key: string): number {
    const written = copyDefault(repo, key) === "written";
    const k = key as PromptKey; // copyDefault refused any other
    const base = textHash(DEFAULTS[k]);
    if (written) {
      this.d.out(`Wrote arnx's ${key} to ${PROMPTS_FILE}; edit it there.`);
    } else {
      this.d.out(DEFAULTS[k]);
      this.d.err(`${key} is in ${PROMPTS_FILE} already; nothing written. Above: arnx's default ` +
        `(${key.split(".")[1]}_base = "${base}").`);
    }
    this.emit("ok", 0, { key, written, file: PROMPTS_FILE, base });
    return 0;
  }

  /** Whether arnx cloud runs this repository's models (false when the config does not read). */
  private cloudOn(repo: string, a: Args): boolean {
    try {
      return cloudModels(this.settings(repo, a).s);
    } catch (e) {
      if (e instanceof ArnxError) return false;
      throw e;
    }
  }

  /** With arnx cloud, the one line about the repository's own prompts (they are not used, nothing of them is sent). */
  private cloudPrompts(repo: string): void {
    if (hasOverrides(repo)) this.d.out(CLOUD_PROMPTS);
  }

  /** `~/…` for a path under the home directory. */
  private shown(path: string): string {
    const home = this.d.env.HOME;
    return home && path.startsWith(home + "/") ? `~${path.slice(home.length)}` : path;
  }

  /** This repository's `telemetry` setting (off when there is no config that reads). */
  private telemetrySetting(): boolean {
    try {
      return loadSettings(this.repo()).telemetry;
    } catch {
      return false;
    }
  }

  /** Telemetry after a command, when this person turned it on: at most 2 s, errors swallowed, the code unchanged. */
  private async sendTelemetry(event: "setup" | "review" | "accept" | "check", data: () => Record<string, unknown>)
    : Promise<void> {
    await reportTelemetry(this.d.env, event, data, { open: this.telemetryOpen, configured: this.telemetrySetting(),
      ...(this.d.telemetrySender ? { sender: this.d.telemetrySender } : {}) });
  }

  /** init writes .arnxignore when the repository has none (data, dumps and images; test fixtures kept); false when
   * one was there. */
  private writeIgnore(repo: string): boolean {
    const path = join(repo, IGNORE_FILE);
    if (existsSync(path)) return false;
    writeFileSync(path, initialIgnore(repo, untrackedSetting(repo)));
    return true;
  }


  /** What a command that sends code needs, checked as doctor shows it: a config that reads, the models it names and
   * their keys (or arnx cloud's login, and with `balance` its balance), and Docker. */
  private async prerequisites(repo: string, a: Args, { balance = true }: { balance?: boolean } = {})
    : Promise<{ checks: Check[]; file: Settings | null; s: Settings | null; mode: ModelsMode | null }> {
    const checks: Check[] = [];
    let file: Settings | null = null, mode: ModelsMode | null = null, s: Settings | null = null;
    try {
      file = loadSettings(repo);
      checks.push([true, "Configuration", "valid"]);
      try {
        mode = this.mode(file, a);
        // BYOM: bring your own models (your keys). An override of the file says what chose it.
        checks.push([true, "Models", `${mode.cloud ? "arnx cloud" : "BYOM"}` +
          `${mode.from === "file" ? "" : ` (from ${modelsSetting(mode)})`}`]);
      } catch (e) {
        if (!(e instanceof ArnxError)) throw e;
        checks.push([false, "Models", e.message, e.exitCode]);
      }
      // With the models unknown (a bad ARNX_MODELS), there are neither keys nor a login to check.
      s = mode && withModels(file, mode);
      if (s && mode?.cloud) checks.push(...await this.cloudChecks(s, mode, balance));
      else if (s) {
        const missing = missingKeys(s, this.d.env);
        const n = keyNames(s).length;
        checks.push([!missing.length, "Keys", missing.length ? keysHint(missing)
          : n ? `${n} required key${n === 1 ? "" : "s"} present` : "none needed"]);
      }
    } catch (e) {
      if (!(e instanceof ArnxError)) throw e;
      checks.push([false, "Configuration", e.message, e.exitCode]);
    }
    const [ok, detail] = this.d.dockerOk();
    // The label says Docker: "not running", not "Docker is not running".
    checks.push([ok, "Docker", detail.replace(/^Docker is /, "")]);
    // Shown only when it fails: a repository written only in languages arnx does not review stops here, before any
    // model is called.
    const langs = repoLanguages(repo);
    if (langs?.onlyOthers) checks.push([false, "Languages", unsupportedText(langs.survey)]);
    return { checks, file, mode, s };
  }

  /** doctor's checks before a command sends code: on a ✗, its line on stderr (as doctor shows it) and the exit code.
   * The balance is not asked here: arnx cloud refuses the first call when it is out. */
  private async ready(repo: string, a: Args): Promise<{ s: Settings; mode: ModelsMode } | number> {
    const r = await this.prerequisites(repo, a, { balance: false });
    const bad = r.checks.filter(([ok]) => ok === false);
    for (const [, name, text] of bad) this.d.err(`✗ ${name}: ${text}`);
    if (!bad.length && r.s && r.mode) return { s: r.s, mode: r.mode };
    const code = bad.some((c) => c[3] === 2) ? 2 : 3;
    this.emit("not-ready", code, { checks: bad.map(([, name, text]) => ({ name: name.toLowerCase(), ok: false,
      detail: text })) });
    return code;
  }

  /** The checks (✓ ✗ ·), then what is there (coverage, JEV, telemetry), then whether a review can run and the next
   * step. Exit 0 when a review can run; 3 while a check fails or a step is not done yet (consent, environment). */
  async doctor(a: Args): Promise<number> {
    const repo = this.repo();
    const { checks, file: settings, s, mode } = await this.prerequisites(repo, a);
    if (s) {
      const cloud = cloudModels(s);
      const at = cloud ? s.cloudConsentAt : s.consentAt;
      checks.push([at ? true : null, "Consent", `${at ? `given ${at.slice(0, 10)}` : "pending"}` +
        `${cloud ? " (arnx cloud)" : ""}`]);
    }
    let file: ReviewFile | null = null;
    if (!existsSync(reviewConfigPath(repo)) || isSeedFile(repo)) {
      checks.push([null, "Environment", "not configured"]);
    } else {
      try {
        file = loadReviewFile(repo);
        const names = file.projects.map((p) => p.name);
        checks.push([true, "Environment", file.legacy ? "approved" : `approved (${names.length} project` +
          `${names.length === 1 ? "" : "s"}: ${names.join(", ")})`]);
      } catch (e) {
        if (!(e instanceof ArnxError)) throw e;
        checks.push([false, "Environment", e.message]);
      }
    }
    // The repository's own prompts: with the user's keys, a file that does not read stops a review (a ✗); arnx cloud
    // runs its own prompts and only says so.
    const cloudOn = !!s && cloudModels(s);
    let overrides: Override[] = [];
    if (!cloudOn && existsSync(promptsPath(repo))) {
      try {
        overrides = readOverrides(repo);
      } catch (e) {
        if (!(e instanceof ArnxError)) throw e;
        checks.push([false, "Prompts", e.message]);
      }
    }
    const promptNotes = overrideWarnings(overrides);
    // The provider tables a role uses, under Models (a table no role names is not shown).
    const used = new Set(s ? modelRefs(s).map((r) => r.provider) : []);
    const unused = settings && !cloudModels(settings) ? unusedKeysNote(repo, this.d.env) : null;
    const providers = settings ? providerLines(settings, this.d.env).filter((l) => used.has(l.split(/[ :]/)[1]!)) : [];
    for (const [good, name, text] of checks) {
      this.d.out(`${good ? "✓" : good === null ? "·" : "✗"} ${name}: ${text}`);
      if (name === "Models") for (const line of providers) this.d.out(`  ${line}`);
      if (name === "Keys" && unused) this.d.out(`  ${unused}`);
    }
    this.d.out("");
    const coverage = file && !file.legacy ? coverageMap(repo, file, untrackedSetting(repo)) : null;
    if (coverage) this.d.out(`Coverage:\n${describeCoverage(coverage)}`);
    // Experimental and optional: never a check, never the exit code.
    const jev = s && jevStatus(s, this.d.env);
    if (jev) this.d.out(`JEV (experimental): ${jev}`);
    const telemetry = telemetryLine(telemetryStatus(this.d.env, this.telemetrySetting()), this.telemetryOpen);
    this.d.out(telemetry);
    if (overrides.length) this.d.out(`Prompts: yours for ${overrides.map((o) => o.key).join(", ")}`);
    else if (cloudOn && hasOverrides(repo)) this.d.out(`Prompts: ${CLOUD_PROMPTS}`);
    for (const note of promptNotes) this.d.out(`  ${note}`);
    this.d.out("");
    const issues = checks.filter(([ok]) => ok === false).length;
    const ready = checks.every(([ok]) => ok);
    this.d.out(ready ? "Ready for review." : "Not ready for review.");
    const next = issues ? null : whatNext(repo).command;
    this.d.out(next === null ? `Next: fix ${issues === 1 ? "the ✗ line" : `the ${issues} ✗ lines`} above`
      : `Next: ${next}`);
    this.emit(ready ? "ready" : "not-ready", ready ? 0 : 3, { ready,
      checks: checks.map(([ok, name, detail]) => ({ name: name.toLowerCase(), ok, detail })), next,
      ...(mode ? { models: mode.cloud ? "cloud" : "byom" } : {}),
      providers: Object.keys(settings?.providers ?? {}).filter((n) => used.has(n)).map((name) => {
        const p = resolveProvider(name, settings!.providers)!;
        return { name, api: p.api, host: providerHost(p, this.d.env), key_env: p.key_env, key_set: !!this.d.env[p.key_env] };
      }),
      ...(coverage ? { coverage: {
        projects: coverage.projects.map((p) => ({ name: p.name, owned: p.owned, used: p.used,
          untracked: p.untracked ?? { owned: 0, used: 0 } })),
        uncovered: coverage.uncovered.map((u) => ({ path: u.path, reason: u.reason, files: u.files,
          untracked: u.untracked ?? 0 })),
        unexplained: coverage.unexplained } } : {}),
      ...(jev && s ? { jev: { on: !!s.jev, key_set: !!this.d.env.JEV_API_KEY, detail: jev } } : {}),
      ...(overrides.length ? { prompts: { overridden: overrides.map((o) => o.key), notes: promptNotes } } : {}),
      telemetry: { enabled: telemetry.startsWith("Telemetry: on"),
        reason: telemetry.startsWith("Telemetry: on") ? null
          : telemetry.replace(/^Telemetry: (?:disabled|off) ?/, "").replace(/^\((.*)\)$/, "$1") } });
    return ready ? 0 : 3;
  }

  /** With arnx models on: the login for this repository's arnx cloud, and (`balance`) the balance a review starts from. */
  private async cloudChecks(s: Settings, mode: ModelsMode, balance: boolean): Promise<Check[]> {
    const url = cloudUrl(s, this.d.env);
    const token = tokenFor(this.d.env, url);
    if (!token) return [[false, "Login", `not logged in to ${url}; run \`arnx login\``]];
    const out: Check[] = [[true, "Login", `logged in to ${url}`]];
    if (!balance) return out;
    try {
      const acct = await this.cloudClient(url, token, s, mode).call<Account>("GET", "/v1/account");
      out.push([acct.balance_micro_usd > 0, "Credits", `${usd(acct.balance_micro_usd)} available` +
        (acct.balance_micro_usd > 0 ? "" : `; top up at ${acct.topup_url}`)]);
    } catch (e) {
      if (!(e instanceof ArnxError)) throw e;
      out.push([false, "Credits", oneLine(e.message)]);
    }
    return out;
  }

  /** With arnx models in effect, the brain that speaks to arnx cloud (it needs this machine's login); null for the
   * local brain on the user's own keys. */
  private async cloudBrain(repo: string, s: Settings, mode: ModelsMode): Promise<((say: Say) => CloudBrain) | null> {
    if (!cloudModels(s)) return null;
    const url = cloudUrl(s, this.d.env);
    const token = tokenFor(this.d.env, url);
    if (!token) throw notLoggedIn(url);
    const client = this.cloudClient(url, token, s, mode);
    return (say) => new CloudBrain({ client, tier: s.cloud!.effort, progress: say });
  }

  /** A client for `url`; with the repository's settings and models, an outage says how to use the user's own keys. */
  private cloudClient(url: string, token: string | null, s: Settings | null, mode?: ModelsMode | null): CloudClient {
    return new CloudClient(url, { token, ...(this.d.fetch ? { fetch: this.d.fetch } : {}),
      ...(this.d.sleep ? { sleep: this.d.sleep } : {}),
      ...(s && mode ? { hint: () => byokHint(s, this.d.env, mode) } : {}) });
  }

  /** This repository's settings when there are some (login and credits also work outside a repository). */
  private settingsHere(): Settings | null {
    try {
      return loadSettings(repoRoot(this.d.cwd));
    } catch (e) {
      if (e instanceof ArnxError) return null;
      throw e;
    }
  }

  async login(): Promise<number> {
    const url = cloudUrl(this.settingsHere(), this.d.env);
    const r = await deviceLogin(url, this.d.env, { say: (l) => this.d.out(l), ...(this.d.fetch ? { fetch: this.d.fetch }
      : {}), ...(this.d.sleep ? { sleep: this.d.sleep } : {}), ...(this.d.now ? { now: this.d.now } : {}) });
    this.d.out(r.email ? `✓ Logged in as ${r.email}` : "✓ Logged in to arnx cloud");
    this.emit("ok", 0, { email: r.email, url });
    return 0;
  }

  async logout(): Promise<number> {
    const deleted = deleteCredentials(this.d.env);
    const path = credentialsPath(this.d.env);
    this.d.out(deleted ? "✓ Logged out of arnx cloud" : "Not logged in to arnx cloud; nothing to do.");
    this.emit("ok", 0, { deleted, path: path ? this.shown(path) : null });
    return 0;
  }

  async credits(): Promise<number> {
    const s = this.settingsHere();
    const url = cloudUrl(s, this.d.env);
    const token = tokenFor(this.d.env, url);
    if (!token) throw notLoggedIn(url);
    let mode: ModelsMode | null = null;
    try {
      mode = s && modelsMode(s, this.d.env);
    } catch (e) {
      if (!(e instanceof ArnxError)) throw e; // a bad ARNX_MODELS: no hint, the balance all the same
    }
    const acct = await this.cloudClient(url, token, s, mode).call<Account>("GET", "/v1/account");
    for (const line of describeAccount(acct)) this.d.out(line);
    const held = acct.held_micro_usd / 1_000_000;
    this.emit("ok", 0, { balance_usd: acct.balance_micro_usd / 1_000_000, held_usd: held, reserved_usd: held,
      email: acct.email ?? null, account_id: acct.account_id, topup_url: acct.topup_url });
    return 0;
  }

  /** This run's clock in ms (deps.now in tests): setup's progress and its approval count from one start. */
  private clock(): number {
    return this.d.now?.() ?? performance.now();
  }

  async setup(a: Args): Promise<number> {
    const project = a.values.project as string | undefined;
    const add = Boolean(a.values.add);
    if (project && add) throw new ArnxError("--add and --project cannot be used together");
    const repo = this.repo();
    const path = reviewConfigPath(repo);
    if (project || add) {
      if (!existsSync(path)) throw new SetupRequired("no .arnx/review.yaml yet; run `arnx setup` first");
    } else if (!a.values.force) {
      // Only a file approved once is kept: a seed, or a failed setup's attempt (never approved), is set up again.
      const stamp = approvalStamp(repo);
      if (stamp?.current) {
        throw new ArnxError(`${REVIEW_FILE} is already set up (approved ${stamp.at} by ${stamp.by}). Next: arnx review ` +
          "— or arnx setup --force to start over (--project NAME redoes one project, --add covers more).");
      }
      if (stamp) {
        throw new ArnxError(`${REVIEW_FILE} changed since it was approved (${stamp.at} by ${stamp.by}). Next: arnx ` +
          "approve — or arnx setup --force to start over.");
      }
    }
    // doctor's checks first: a missing key or a stopped Docker ends setup here, before it reads or spends anything.
    const ready = await this.ready(repo, a);
    if (typeof ready === "number") return ready;
    const { mode } = ready;
    const s = await this.agreed(repo, ready.s, mode, a.values.yes as boolean);
    const untracked = untrackedFlag(a) ?? s.untracked;
    this.d.out(setupPreview(repo, s, untracked));
    const outDir = join(repo, ".arnx", "setup");
    // JEV is asked only when the config turns it on and its key is set (the key alone does nothing).
    const jev = jevKey(s, this.d.env);
    if (jev) {
      this.d.out("Experimental: JEV is on and JEV_API_KEY is set, so failure messages no signature explains go to JEV " +
        "(typesafe.ai) for a hint; its answers are logged in .arnx/setup/jev.jsonl.");
    } else if (s.jev) {
      this.d.out("Experimental: JEV is on in .arnx/config.toml, but JEV_API_KEY is not set; setup runs without it.");
    }
    const failureModel = jev ? jevModel(jev, join(outDir, "jev.jsonl")) : undefined;
    const started = this.clock();
    const cloud = await this.cloudBrain(repo, s, mode);
    if (cloud) this.cloudPrompts(repo);
    const result = await this.withProgress(a, (progress) => runSetup(repo, s,
      cloud ? null : this.d.setupModel ?? makeAgentModel(s, this.d.env), { outDir, project, add, progress, failureModel,
        untracked, localPins: localPinsPath(this.d.env, repo),
        ...(this.d.setupSessions ? { sessionFactory: this.d.setupSessions } : {}),
        ...(cloud ? { brain: cloud(progress) } : {}) }), { cost: true, since: started });
    if (result.withheld.length) {
      this.d.out(`Left out as secret-looking (not sent, not in the sandbox): ${describeWithheld(result.withheld)}. ` +
        "If one is a test fixture, not a secret: `arnx allow-secret PATH`, then run setup again.");
    }
    const seconds = () => Math.round((this.clock() - started) / 1000);
    const finish = async (code: number, approved: boolean): Promise<number> => {
      await this.sendTelemetry("setup", () => setupData({ languages: projectLanguages(result.yamlText), approved,
        costUsd: result.costUsd, seconds: (this.clock() - started) / 1000 }));
      return code;
    };
    // With arnx cloud the figure is what it billed (its price), not the models' cost.
    const cost = cloud ? `Billed $${result.costUsd.toFixed(2)} by arnx cloud` : `Cost $${result.costUsd.toFixed(2)}`;
    const auto = Boolean(a.values.yes);
    if (!result.ok) {
      const saved = result.yamlText ? this.saveAttempt(repo, result.yamlText) : null;
      const failure = setupFailure(result, s.setupBudgetUsd);
      this.d.out(failure.text);
      this.d.out(`${cost} · last attempt: ${saved ? `${saved} (not approved)` : "none"} · logs: .arnx/setup/`);
      // Files the tests need and the snapshot left out: only letting them in helps, then the same setup again.
      const again = `arnx setup${project ? ` --project ${project}` : add ? " --add" : ""}`;
      const letIn = neededSteps(result.needed ?? []);
      const next = letIn.length ? `${letIn.join("; ")}, then ${again}` : !saved ? "arnx setup --force"
        : saved === REVIEW_FILE ? `fix ${REVIEW_FILE}, then arnx approve`
        : `fix ${saved}, copy it to ${REVIEW_FILE}, then arnx approve`;
      this.d.out(`Next: ${next}`);
      this.emit("fail", 2, setupJson({ file: tryParse(result.yamlText), result, approved: false, auto: false,
        files: null, warnings: [], reviewYaml: saved, record: null, seconds: seconds(), failure: failure.json,
        next: letIn.length ? [...letIn, again] : [saved ? "arnx approve" : "arnx setup --force"] }));
      return finish(2, false);
    }
    this.replaceFile(repo, result.yamlText!);
    const notes = result.notes?.trim() ? join(outDir, "notes.md") : null;
    if (notes) writeFileSync(notes, result.notes!.trim() + "\n");
    const proposed = parseReviewFile(result.yamlText!);
    const files = filesSummary(proposed, repo, untracked);
    const warnings = approvalWarnings(proposed, result.projects);
    const json = (o: { approved: boolean; record?: string | null; approval?: ApprovedProject[];
      failure?: Record<string, unknown> | null; next: string[] }) => setupJson({ file: proposed, result,
      approved: o.approved, auto: o.approved && auto, files, warnings, reviewYaml: REVIEW_FILE, record: o.record ?? null,
      seconds: seconds(), failure: o.failure ?? null, next: o.next, approval: o.approval ?? [] });
    this.d.out("");
    this.d.out(approvalScreen(proposed, repo, { proofs: result.projects, untracked }));
    this.d.out("");
    this.d.out(`Wrote ${REVIEW_FILE} (${minutes(this.clock() - started)}, $${result.costUsd.toFixed(2)})` +
      `${notes ? `; notes in ${relative(repo, notes)}` : ""}.`);
    if (!await this.confirm("Approve this environment?", auto)) {
      this.d.out(`Environment not approved; ${REVIEW_FILE} is saved.`);
      this.d.out("Next: arnx approve");
      this.emit("not-approved", 3, json({ approved: false, next: ["arnx approve"] }));
      return finish(3, false);
    }
    const r = await this.approveRun(repo, a, project, untracked, { auto, warnings, since: started });
    if (r.code !== 0) {
      this.d.out(`${cost} · last attempt: ${REVIEW_FILE} (not approved) · logs: .arnx/run/`);
      this.d.out(`Next: fix ${REVIEW_FILE}, then arnx approve`);
      const failing = r.projects.flatMap((p) => p.unexpected);
      this.emit("fail", 2, json({ approved: false, approval: r.projects, next: ["arnx approve"],
        failure: { kind: failing.length ? "tests" : "environment", reason: r.detail, failing } }));
      return finish(r.code, false);
    }
    this.emit("ok", 0, json({ approved: true, record: r.record, approval: r.projects, next: ["arnx review"] }));
    return finish(0, true);
  }

  /** A failed setup's last attempt: `.arnx/review.yaml`, unapproved, unless that file is approved (a failed attempt
   * never replaces a working environment): then `.arnx/setup/review.yaml`. The path shown. */
  private saveAttempt(repo: string, text: string): string {
    if (approvalStamp(repo)?.current) {
      const aside = join(repo, ".arnx", "setup", "review.yaml");
      mkdirSync(dirname(aside), { recursive: true });
      writeFileSync(aside, text);
      return relative(repo, aside);
    }
    this.replaceFile(repo, text);
    return REVIEW_FILE;
  }

  /** Writes `.arnx/review.yaml`; an unapproved file it replaces (not a seed, not the same text) is copied to
   * `.arnx/setup/previous-review.yaml` first, so a hand-edited one is never lost. */
  private replaceFile(repo: string, text: string): void {
    const path = reviewConfigPath(repo);
    let keep = false;
    try {
      keep = existsSync(path) && !approvalStamp(repo)?.current && !isSeedFile(repo) && readFileSync(path, "utf8") !== text;
    } catch (e) {
      if (!(e instanceof ArnxError)) throw e;
      keep = true; // a file that does not read is the user's to fix: kept
    }
    if (keep) {
      mkdirSync(join(repo, ".arnx", "setup"), { recursive: true });
      copyFileSync(path, join(repo, ".arnx", "setup", "previous-review.yaml"));
    }
    writeFileSync(path, text);
  }

  /** Progress on stderr while `body` runs, with a "still waiting" line when nothing happens for a minute. `since`: an
   * earlier clock reading the elapsed time counts from (setup's approval continues setup's clock). */
  private async withProgress<T>(a: Args, body: (say: (m: string) => void) => Promise<T>,
                                { cost = false, since }: { cost?: boolean; since?: number } = {}): Promise<T> {
    const progress = new Progress(this.progressLine, { quiet: a.values.quiet as boolean | undefined,
      live: this.d.live ?? null, ...(cost ? { cost: costSince() } : {}),
      ...(this.d.now ? { clock: this.d.now } : {}), ...(since !== undefined ? { since } : {}) });
    progress.start();
    try {
      return await body(progress.say);
    } finally {
      progress.stop();
    }
  }

  /** Runs the suites and stamps the file. `untracked`: the suites run with untracked files too, as setup proved them
   * (default: `[review] untracked`). `auto`: approved by --yes; `warnings`: the screen's `!` lines, recorded with the
   * approval in .arnx/setup/approval.md (a local file; review.yaml stays as it is). */
  private async approveRun(repo: string, a: Args, project: string | undefined, untracked: boolean | undefined,
                           o: { auto: boolean; warnings: string[]; since?: number })
    : Promise<{ code: number; projects: ApprovedProject[]; detail: string; record: string | null }> {
    const by = git(repo, ["config", "user.name"], [0, 1]).trim() || "unknown";
    const at = isoSeconds(new Date());
    const [ok, detail, suites] = await this.withProgress(a, (progress) =>
      approveFile(repo, { by, at, project, untracked, progress,
        localPins: localPinsPath(this.d.env, repo),
        ...(this.d.approveSessions ? { sessionFactory: this.d.approveSessions } : {}) }),
    o.since !== undefined ? { since: o.since } : {});
    const projects = suites.map((s) => ({ name: s.name, ok: s.ok, summary: s.summary,
      accepted_failing: s.acceptedFailing, unexpected: s.unexpected }));
    if (!ok) {
      this.d.out(`Not approved:\n${detail}`);
      return { code: 2, projects, detail, record: null };
    }
    const record = APPROVAL_RECORD;
    const sha = createHash("sha256").update(readFileSync(reviewConfigPath(repo))).digest("hex").slice(0, 12);
    mkdirSync(dirname(join(repo, record)), { recursive: true });
    writeFileSync(join(repo, record), [`# Environment ${o.auto ? "auto-approved (--yes)" : "approved"}`, "",
      `${at} · by ${by} · ${REVIEW_FILE} sha256 ${sha}`, "",
      ...(o.warnings.length ? ["Warnings:", ...o.warnings.map((w) => `- ${w}`)] : ["Warnings: none"]), ""].join("\n"));
    const n = o.warnings.length;
    this.d.out(!o.auto ? "✓ Environment approved" : `✓ Environment auto-approved (--yes)` +
      (n ? `, with ${n} warning${n === 1 ? "" : "s"}` : ""));
    const red = suites.reduce((k, s) => k + s.acceptedFailing, 0);
    if (red) this.d.out(stillRed(red));
    this.d.out(nextStep(repo));
    return { code: 0, projects, detail, record };
  }

  /** Pin the key-shaped strings of each file in review.yaml, so snapshots keep it while it holds no others. */
  async allowSecret(a: Args): Promise<number> {
    const repo = this.repo();
    if (!a.positionals.length) throw new ArnxError("name the files to allow: arnx allow-secret PATH...");
    const pins = a.positionals.map((p) => {
      if (!existsSync(resolve(this.d.cwd, p))) throw new ArnxError(`${p}: no such file`);
      const full = realpathSync(resolve(this.d.cwd, p));
      if (!full.startsWith(repo + sep)) throw new ArnxError(`${p} is outside the repository`);
      const rel = relative(repo, full).split(sep).join("/");
      if (isSecretPath(rel)) throw new ArnxError(`${rel}: files named like this are never sent, allowed or not`);
      const text = readFileSync(full, "utf8");
      const hits = secretHits(text);
      if (!hits.length) throw new ArnxError(`${rel} holds nothing that looks like a key; nothing to allow`);
      const shown = hits.slice(0, 5).map((h) => `${h.label} line ${h.line}`).join(", ") + (hits.length > 5 ? ", …" : "");
      this.d.out(`! ${rel}: ${hits.length} key-like string${hits.length === 1 ? "" : "s"} (${shown})`);
      return { path: rel, matches: secretPins(text), hits };
    });
    const path = reviewConfigPath(repo);
    const seed = !existsSync(path) || isSeedFile(repo);
    mkdirSync(join(repo, ".arnx"), { recursive: true });
    writeFileSync(path, withSecretPins(existsSync(path) ? readFileSync(path, "utf8") : null,
      pins.map(({ path: p, matches }) => ({ path: p, matches }))));
    // Allowing is not sending: the file goes out with the next command that calls a model or runs the sandbox.
    this.d.out(`✓ Allowed in ${REVIEW_FILE}: from now on, model calls and the sandbox may include ` +
      `${pins.length === 1 ? "this file" : "these files"}.`);
    this.d.out("  A new key-like string in it withholds the file again.");
    this.d.out(`Next: ${seed ? "arnx setup" : "arnx approve"}`);
    // Never the matched text, nor its pins: where each key-like string is, and what kind it looks like.
    this.emit("ok", 0, { files: pins.map((p) => ({ path: p.path, matches: p.hits.length,
      labels: p.hits.map((h) => ({ label: h.label, line: h.line })) })), review_yaml: REVIEW_FILE,
      next: [seed ? "arnx setup" : "arnx approve"] });
    return 0;
  }

  /** remove: lists what arnx put in this repository; --yes deletes it. Tracked files are left for `git rm`, accepted
   * tests are kept unless --tests, and nothing outside the repository but its images and pins is touched. */
  async remove(a: Args): Promise<number> {
    const repo = this.repo();
    const yes = !!a.values.yes;
    const tests = !!a.values.tests;
    const plan = planRemove(repo, { tests, pins: localPinsPath(this.d.env, repo) });
    const images = plan.images ?? [];
    const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
    // The git rm line: a target all committed by its own name, else its committed files. A folder target ends in "/".
    const tracked = new Set(plan.tracked);
    const within = (t: { path: string }) => (p: string) => p === t.path || (t.path.endsWith("/") && p.startsWith(t.path));
    const gitRm = plan.targets.flatMap((t) => {
      const under = plan.tracked.filter(within(t));
      return under.length && under.length === t.files ? [t.path.replace(/\/$/, "")] : under.sort();
    });
    const gitLine = gitRm.length ? `git rm -r --quiet ${gitRm.map(shellWord).join(" ")}` : null;
    const json = (failed: [string, string][]) => ({ dry_run: !yes,
      deleted: plan.untracked.filter((p) => !failed.some(([f]) => f === p)), tracked: plan.tracked, git_rm: gitLine,
      images: images.map((i) => ({ tag: i.tag, size: i.size })), docker_checked: plan.images !== null,
      pins: plan.pins ? this.shown(plan.pins) : null, kept_tests: plan.keptTests,
      failed: failed.map(([path, error]) => ({ path, error })) });
    if (!plan.targets.length && !images.length && !plan.pins) {
      this.d.out("Nothing of arnx's in this repository.");
      this.emit("ok", 0, { ...json([]), state: "nothing" });
      return 0;
    }
    const rows: [string, string][] = plan.targets.map((t) => {
      const committed = plan.tracked.filter(within(t)).length;
      const count = t.files > 1 || t.path.endsWith("/") ? n(t.files, "file") : "";
      return [t.path, [count, committed ? `${committed === t.files ? "all" : committed} committed` : ""]
        .filter(Boolean).join(", ")];
    });
    if (images.length) rows.push([n(images.length, "environment image"), totalSize(images)]);
    if (plan.pins) rows.push(["accepted-test pins", this.shown(plan.pins)]);
    const width = Math.max(...rows.map(([what]) => what.length));
    const list = rows.map(([what, detail]) => `  ${what.padEnd(width)}  ${detail}`.trimEnd());
    const kept = [plan.editedTests.length ? `${n(plan.editedTests.length, "accepted test file")} edited since accept and ` +
      `not committed (${plan.editedTests.join(", ")}): delete by hand if you mean it`
      : plan.keptTests.length ? `${n(plan.keptTests.length, "accepted test file")} (your tests now; ` +
      "--tests removes them too)" : "", "your arnx cloud login (arnx logout)", "the arnx program"].filter(Boolean);
    const say = (...lines: string[]) => lines.forEach((l) => this.d.out(l));
    if (!yes) {
      say("arnx remove would delete:", ...list);
      if (gitLine) say("Committed files are left for git, so the removal shows in a commit:", `  ${gitLine}`);
      if (plan.images === null) say(`Docker could not be asked (${plan.docker}): arnx's images, if any, were not looked for.`);
      say(`Kept: ${kept.join("; ")}.`, "", "Next: arnx remove --yes");
      this.emit("ok", 0, { ...json([]), state: "listed", next: ["arnx remove --yes"] });
      return 0;
    }
    const failed = applyRemove(repo, plan);
    const done = plan.untracked.length + images.length + (plan.pins ? 1 : 0) - failed.length;
    this.d.out(failed.length ? `Removed ${n(done, "item")}; ${failed.length} could not be removed:`
      : `✓ Removed arnx from this repository${tracked.size ? ", except committed files" : ""}.`);
    for (const [what, why] of failed) this.d.out(`  ${what}: ${why}`);
    if (gitLine) say("Remove the committed files in a commit:", `  ${gitLine}`);
    this.d.out(`Kept: ${kept.join("; ")}.`);
    this.emit(failed.length ? "fail" : "ok", failed.length ? 2 : 0, { ...json(failed), state: "removed" });
    return failed.length ? 2 : 0;
  }

  async env(a: Args): Promise<number> {
    if (a.positionals[0] !== "prune") throw new ArnxError("usage: arnx env prune [--keep-days N] [--all-repos] [--dry-run]");
    const days = (a.values["keep-days"] as string | undefined) ?? "7";
    if (!/^\d+$/.test(days)) throw new ArnxError("--keep-days takes a whole number of days");
    const repo = this.repo();
    const now = Date.now();
    const dryRun = Boolean(a.values["dry-run"]);
    const r = pruneEnv(repo, { keepDays: Number(days), now, dryRun, allRepos: Boolean(a.values["all-repos"]) });
    const n = (k: number, what: string) => `${k} ${what}${k === 1 ? "" : "s"}`;
    if (r.removed.length) {
      this.d.out(`${dryRun ? "Would remove" : "Removed"} ${n(r.removed.length, "image")} (${totalSize(r.removed)}):`);
      for (const i of r.removed) {
        const age = Math.floor(ageDays(i, now));
        this.d.out(`  ${i.tag} (${i.project}, ${age} day${age === 1 ? "" : "s"} old, ${i.size})`);
      }
    } else {
      this.d.out("No environment image to remove.");
    }
    this.d.out(`Kept: the images of approved environments, and images under ${days} days old.`);
    for (const [i, why] of r.failed) this.d.out(`Could not remove ${i.tag}: ${why}`);
    // An image without arnx's labels cannot be told apart from another repository's: never touched, never advised on.
    if (r.unlabelled) {
      this.d.out(`${n(r.unlabelled, "older image")} ${r.unlabelled === 1 ? "has" : "have"} no arnx labels: arnx cannot ` +
        `tell whose ${r.unlabelled === 1 ? "it is" : "they are"}, so it leaves ${r.unlabelled === 1 ? "it" : "them"}.`);
    }
    if (dryRun) this.d.out("Nothing removed (dry run).");
    const image = (i: EnvImage) => ({ tag: i.tag, project: i.project, age_days: Math.floor(ageDays(i, now)),
      size: i.size });
    this.emit(r.failed.length ? "fail" : "ok", r.failed.length ? 2 : 0, { dry_run: dryRun, keep_days: Number(days),
      removed: r.removed.map(image), failed: r.failed.map(([i, why]) => ({ ...image(i), error: why })),
      unlabelled: r.unlabelled });
    return r.failed.length ? 2 : 0;
  }

  async approve(a: Args): Promise<number> {
    const repo = this.repo();
    const file = loadReviewFile(repo, { requireApproved: false }); // validates the file before showing it
    const n = file.projects.length;
    this.d.out(approvalScreen(file, repo, { header: `${REVIEW_FILE} holds ${n} project${n === 1 ? "" : "s"}.`,
      untracked: untrackedSetting(repo) }));
    this.d.out("");
    if (!await this.confirm("Run every suite and approve this environment?", a.values.yes as boolean)) {
      // With --json nothing is asked: approving is the person's, at a terminal or with --yes.
      this.emit("not-approved", 3, { approved: false, projects: [], next: ["arnx approve"] });
      return 3;
    }
    requireDocker();
    const r = await this.approveRun(repo, a, a.values.project as string | undefined, undefined,
      { auto: Boolean(a.values.yes), warnings: approvalWarnings(file) });
    this.emit(r.code === 0 ? "ok" : "fail", r.code, { approved: r.code === 0, projects: r.projects,
      ...(r.code === 0 ? {} : { detail: r.detail }), next: [r.code === 0 ? "arnx review" : "arnx approve"] });
    return r.code;
  }

  async review(a: Args): Promise<number> {
    const untracked = untrackedFlag(a);
    const repo = this.repo();
    suffixReviewCopies(repo);
    const ready = await this.ready(repo, a);
    if (typeof ready === "number") return ready;
    const { mode } = ready;
    const s = await this.agreed(repo, ready.s, mode);
    const cloud = await this.cloudBrain(repo, s, mode);
    if (cloud) {
      this.cloudPrompts(repo);
      return this.reviewWith(repo, s, a, cloud, untracked);
    }
    const agentModel = makeAgentModel(s, this.d.env);
    // Verdict calls give up on a stalled attempt sooner than hunt calls (see makeChallenger).
    const challenger = makeChallenger(s, this.d.env);
    const progress = new Progress(this.progressLine, { quiet: a.values.quiet as boolean | undefined,
      live: this.d.live ?? null, cost: costSince() });
    const hunter = makeJsonModel(s.hunter ?? s.reviewer, s, this.d.env);
    const ranker = makeJsonModel(s.reviewer, s, this.d.env);
    const secondHunter = makeSecondHunter(s, this.d.env);
    // Stalls, lost connections and fallbacks show in the progress, so a slow model can be told from a dead line.
    for (const m of [agentModel, challenger, hunter, ranker, secondHunter]) if (m) m.notice = progress.say;
    progress.start();
    let result;
    try {
      result = await runReview(repo, { settings: s, agentModel, challenger,
        range: (a.values.range as string | undefined) ?? null, progress: progress.say, hunt: !a.values["no-hunt"],
        hunter, ranker, ...(secondHunter ? { secondHunter } : {}), resume: !!a.values.resume, untracked });
    } finally {
      progress.stop();
    }
    return this.reviewed(repo, s, result);
  }

  /** A review whose judgement is arnx cloud's: no model is made here, no key is needed. */
  private async reviewWith(repo: string, s: Settings, a: Args, cloud: (say: Say) => CloudBrain,
                           untracked: boolean | undefined): Promise<number> {
    const progress = new Progress(this.progressLine, { quiet: a.values.quiet as boolean | undefined,
      live: this.d.live ?? null, cost: costSince() });
    progress.start();
    let result;
    try {
      result = await runReview(repo, { settings: s, brain: cloud(progress.say),
        range: (a.values.range as string | undefined) ?? null, progress: progress.say, hunt: !a.values["no-hunt"],
        resume: !!a.values.resume, untracked });
    } finally {
      progress.stop();
    }
    return this.reviewed(repo, s, result);
  }

  private async reviewed(repo: string, s: Settings, result: { review: Review; rdir: string }): Promise<number> {
    const { review, rdir } = result;
    const md = relative(repo, join(rdir, "review.md"));
    this.d.out(colorLines(summary(review, md), paint(!!this.d.color)));
    this.emit(...reviewJson(review, md, relative(repo, join(rdir, "review.json"))));
    await this.sendTelemetry("review", () => {
      const file = loadReviewFile(repo, { requireApproved: false });
      const languages = review.projects.map((n) => file.projects.find((p) => p.name === n)?.language ?? "other");
      return reviewData(review, { settings: s, languages, diffBytes: statSync(join(rdir, "change.diff")).size });
    });
    return exitCode(review);
  }

  async accept(a: Args): Promise<number> {
    if (a.values["keep-edits"]) return this.keepEdits(a);
    if (a.values.move) return this.moveOut(a);
    const repo = this.repo();
    const { s: file, mode } = this.settings(repo, a);
    let s = file;
    const rdir = findReview(repo, a.positionals[0] ?? null);
    const progress = new Progress(this.progressLine, { quiet: a.values.quiet as boolean | undefined,
      live: this.d.live ?? null, cost: costSince() });
    let runner = null;
    let billed = false; // arnx cloud turns the answers into tests: their cost is what it billed
    if (!a.values["no-answers"]) {
      s = await this.agreed(repo, s, mode); // answers are turned into tests by a model
      const cloud = await this.cloudBrain(repo, s, mode);
      billed = !!cloud;
      if (cloud) {
        runner = makeAnswerRunner(repo, loadReviewFile(repo), s, null, dockerSession, progress.say, cloud(progress.say));
      } else {
        // Answer rounds use answer_model when set (a cheap model writes a test for a stated behaviour well).
        const agent = makeAgentModel(s.answerModel ? { ...s, reviewer: s.answerModel } : s, this.d.env);
        agent.notice = progress.say;
        runner = makeAnswerRunner(repo, loadReviewFile(repo), s, agent, dockerSession, progress.say);
      }
    }
    progress.start();
    let result;
    try {
      result = await accept(repo, rdir, s, { again: a.values.again as boolean, answerRunner: runner,
        progress: progress.say, pins: localPinsPath(this.d.env, repo) });
    } finally {
      progress.stop();
    }
    const adapter = getAdapter(result.review.language);
    const tests = result.kept.filter((p) => !adapter.isSupportFile(basename(p)));
    const n = (k: number, one: string, many = `${one}s`) => `${k} ${k === 1 ? one : many}`;
    // Marked real and kept: a finding whose test was set aside has another test standing in for it.
    const real = result.review.findings.filter((f) => result.marks.findings[f.id] === "real" && !result.setAside[f.id]);
    const realTests = new Set(real.filter((f) => f.file).map((f) => f.testId)).size;
    const issues = groupsOf(result.review, real).length;
    const marked = Object.entries(result.marks.findings).filter(([, m]) => m);
    // A pre-filled mark nobody changed is not the owner's verdict: say how many there were.
    const left = marked.filter(([id]) => result.sources[id] === "default").length;
    const aside = Object.keys(result.setAside).length;
    this.d.out(real.length ? `✓ Accepted ${n(realTests, "test")} from ${n(issues, "issue")} ` +
      `(${n(real.length, "finding")})` : aside ? "No test of a finding kept: their tests were set aside."
      : tests.length ? "No findings marked real." : "No findings marked real; nothing kept.");
    if (left) this.d.out(`  ${left} mark${left === 1 ? " was" : "s were"} pre-filled (not reviewed in triage)`);
    const questions = result.review.questions.length;
    const unanswered = a.values["no-answers"] ? questions
      : result.review.questions.filter((_q, i) => !(`Q${i + 1}` in result.marks.answers)).length;
    if (unanswered) this.d.out(`  ${n(unanswered, "question")} not answered${a.values["no-answers"] ? " (--no-answers)" : ""}`);
    if (a.values["no-answers"] && result.rewrites.length) {
      this.d.out(`  ${n(result.rewrites.length, "rewrite")} not written (--no-answers): the findings keep their own ` +
        "tests until accept writes them");
    }
    // One line per question whose answer's test replaced the tests of findings that assumed another answer.
    const byAnswer = new Map<string, string[]>();
    for (const [id, by] of Object.entries(result.setAside)) {
      if (by.startsWith("Q")) byAnswer.set(by, [...byAnswer.get(by) ?? [], id]);
    }
    for (const [qid, ids] of byAnswer) this.d.out(`${ids.join(", ")} set aside: your answer to ${qid} has its own test`);
    for (const p of tests) this.d.out(`  kept: ${relative(repo, p)}`);
    const answers: { question: string; result: string; tests: string[]; cost_usd: number; rewrite_of: string[] | null }[]
      = [];
    for (const ans of result.answers) {
      const keptCount = Object.values(ans.keep).reduce((n, v) => n + v.size, 0);
      const cost = `$${ans.costUsd.toFixed(2)}${billed ? " billed" : ""}`;
      const failing = ans.disagree.map((t) => t.split("::").at(-1)!);
      const rewrite = result.rewrites.find((w) => w.id === ans.qid);
      const label = rewrite ? `${ans.qid} (rewrite of ${rewrite.findings.join(", ")})` : ans.qid;
      if (ans.disagree.length) {
        this.d.out(`${label}: the code does not do what ${rewrite ? "your reason says" : "you answered"}; kept failing: ` +
          `${failing.join(", ")} · ${cost}`);
      } else if (keptCount) {
        this.d.out(`${label}: the code already does it; ${keptCount} test(s) kept to lock it · ${cost}`);
      } else {
        this.d.out(`${label}: no test (${rewrite ? "your reason" : "the answer"} does not settle it) · ${cost}`);
      }
      answers.push({ question: ans.qid, result: ans.disagree.length ? "disagree" : keptCount ? "locked" : "no-test",
        tests: ans.disagree.length ? failing : Object.values(ans.keep).flatMap((v) => [...v]), cost_usd: ans.costUsd,
        rewrite_of: rewrite?.findings ?? null });
    }
    const markCount = (m: string) => marked.filter(([, x]) => x === m).length;
    const marks = { real: markCount("real"), intended: markCount("intended"), noise: markCount("noise"),
      rewrite: markCount("rewrite"),
      unmarked: Object.keys(result.marks.findings).length - marked.length, left_as_prefilled: left };
    let checked: { failing: { project: string; test_id: string; message: string }[]; passing: number } | null = null;
    const c = paint(!!this.d.color);
    if (!a.values["no-check"] && this.d.check !== false) {
      // The accepted tests are run, not assumed: the list below is what fails on the code as it is now.
      const cp = new Progress(this.progressLine, { quiet: a.values.quiet as boolean | undefined,
        live: this.d.live ?? null });
      cp.start();
      let results;
      try {
        results = await check(repo, s, { progress: cp.say, what: "the accepted tests",
          pins: localPinsPath(this.d.env, repo),
          ...(this.d.checkSessions ? { sessionFactory: this.d.checkSessions } : {}) });
      } finally {
        cp.stop();
      }
      const failing = results.flatMap((r) => r.failed.map((t) => ({ project: r.project, t })));
      const passing = results.reduce((n, r) => n + r.passed.length, 0);
      checked = { failing: failing.map(({ project, t }) => ({ project, test_id: t.testId, message: t.message })),
        passing };
      if (failing.length || passing) this.d.out("");
      if (failing.length) {
        this.d.out(`${c.red(`${failing.length} fail${failing.length === 1 ? "s" : ""}`)}, as expected until the bugs ` +
          `are fixed; ${c.green(`${passing} pass`)}:`);
        // One file: the test names alone; several: each file once, its failing tests under it.
        for (const l of failingList(failing, results.length > 1, { mark: c.red("✗"),
          why: (m) => c.dim(`  ${m.slice(0, 90)}`) })) this.d.out(l);
      } else if (real.length) {
        this.d.out(c.green(passing === 1 ? "The accepted test passes: the bug it proves looks fixed already."
          : `All ${passing} accepted tests pass: the bugs they prove look fixed already.`));
      } else if (passing) {
        this.d.out(c.green(passing === 1 ? "The accepted test passes." : `All ${passing} accepted tests pass.`));
      }
    } else if (realTests) {
      this.d.out("");
      this.d.out(`${n(realTests, "accepted test")} fail${realTests === 1 ? "s" : ""} until the fix (not run: --no-check).`);
    }
    const promptPath = join(rdir, "fix-prompt.md");
    const toFix = real.length + result.rewrites.length + result.answers.filter((x) => x.disagree.length).length > 0;
    if (toFix && checked?.failing.length !== 0) {
      this.d.out("");
      this.d.out(`${c.bold("Fix prompt:")} ${relative(repo, promptPath)}`);
      if (a.values.copy) this.d.out(copyToClipboard(readFileSync(promptPath, "utf8")) ?? "Could not copy: no clipboard tool found " +
        "(wl-copy, xclip, xsel or pbcopy).");
      this.d.out(c.bold("Next: give the fix prompt to your coding agent (arnx prompt prints it)"));
      this.d.out(c.bold("Then: arnx check"));
      this.d.out("Commit the fix and the accepted tests together.");
    } else if (tests.length) {
      this.d.out("");
      this.d.out(c.bold(real.length ? "Next: commit the fix and the accepted tests together"
        : "Next: commit the accepted tests"));
    }
    const rel = (p: string) => relative(repo, p).split(sep).join("/");
    // The same next steps as the text above.
    const next = toFix && checked?.failing.length !== 0 ? ["give the fix prompt to your coding agent", "arnx check"]
      : tests.length ? [real.length ? "commit the fix and the accepted tests together" : "commit the accepted tests"] : [];
    this.emit("ok", 0, { review_id: result.review.id, kept: tests.map(rel),
      dest: tests.length ? rel(result.dest) || "." : null, issues, marks, answers, check: checked,
      fix_prompt: rel(promptPath), next });
    await this.sendTelemetry("accept", () => acceptData(result, tests.length));
    return 0;
  }

  /** The owner changed accepted tests on purpose: record them as they are, so check runs them again. */
  private keepEdits(a: Args): number {
    if (a.positionals.length || a.values.again) throw new ArnxError("--keep-edits takes no review id and no --again");
    const repo = this.repo();
    const { changed, restoredTests } = keepEdits(repo, localPinsPath(this.d.env, repo));
    this.emit("ok", 0, { changed: changed.map((c) => ({ path: c.path, change: c.change })),
      restored_tests: restoredTests, recorded: ACCEPTED_RECORD });
    if (!changed.length) {
      this.d.out(`No accepted test changed since \`arnx accept\` recorded it; ${ACCEPTED_RECORD} is unchanged.`);
      return 0;
    }
    this.d.out(`Recorded ${changed.length} accepted test file${changed.length === 1 ? "" : "s"} as now in ` +
      `${ACCEPTED_RECORD}:`);
    for (const c of changed) this.d.out(`  ${c.change === "deleted" ? "deleted " : c.change} ${c.path}`);
    for (const p of restoredTests) {
      this.d.out(`  kept the accepted test list arnx wrote for ${p} (its edit in ${ACCEPTED_RECORD} is not trusted)`);
    }
    this.d.out(`Commit ${ACCEPTED_RECORD} with the tests.`);
    return 0;
  }

  /** Tests an older arnx kept in the projects' own test folders, moved to .arnx/tests/. */
  private moveOut(a: Args): number {
    if (a.positionals.length || a.values.again) throw new ArnxError("--move takes no review id and no --again");
    const repo = this.repo();
    const moved = moveOut(repo, loadSettings(repo), localPinsPath(this.d.env, repo));
    this.emit("ok", 0, { moved });
    const n = Object.keys(moved).length;
    if (!n) {
      this.d.out("No accepted tests in your test folders; nothing to move.");
      return 0;
    }
    this.d.out(`Moved ${n} accepted file${n === 1 ? "" : "s"} to .arnx/tests/, out of your own test run:`);
    for (const [from, to] of Object.entries(moved)) this.d.out(`  ${from} → ${to}`);
    this.d.out(`Commit the move with ${ACCEPTED_RECORD}.`);
    return 0;
  }

  /** check --review: the review's confirmed tests on the working tree, nothing accepted, copied or recorded. */
  private async recheck(a: Args, repo: string, s: Settings, json: boolean): Promise<number> {
    let rdir: string;
    try {
      rdir = findReview(repo, a.positionals[0] ?? null);
    } catch (e) {
      if (e instanceof ArnxError) throw new SetupRequired(e.message);
      throw e;
    }
    const progress = new Progress(this.progressLine, { quiet: a.values.quiet as boolean | undefined,
      live: this.d.live ?? null });
    progress.start();
    let r;
    try {
      r = await recheckReview(repo, rdir, s, { progress: progress.say,
        ...(this.d.checkSessions ? { sessionFactory: this.d.checkSessions } : {}) });
    } finally {
      progress.stop();
    }
    const [text, code] = recheckSummary(r);
    if (json) this.emitRaw(recheckJson(r));
    else this.d.out(colorLines(text, paint(!!this.d.color)));
    return code;
  }

  async next(a: Args): Promise<number> {
    const repo = this.repo();
    const n = await this.cloudNext(whatNext(repo), a);
    const c = paint(!!this.d.color);
    this.d.out(`${c.dim("Where:")} ${n.where}`);
    if (n.note) this.d.out(`${c.dim("Note:")}  ${n.note}`);
    this.d.out(`${c.bold("Next:")}  ${c.cyan(n.command)}${n.why ? c.dim(`  (${n.why})`) : ""}`);
    if (n.then) this.d.out(`${c.bold("Then:")}  ${c.cyan(n.then)}`);
    this.emit("ok", 0, { where: n.where, next: n.command, why: n.why || null, then: n.then ?? null,
      note: n.note ?? null, phase: n.phase });
    return 0;
  }

  /** With arnx models on, a step that calls models first needs a login and a balance to start from. */
  private async cloudNext(n: Next, a: Args): Promise<Next> {
    const file = this.settingsHere();
    const mode = file && this.mode(file, a);
    const s = file && mode && withModels(file, mode);
    // No consent step: the step that first sends code asks it.
    if (!s || !cloudModels(s) || !callsModels(n.command)) return n;
    const url = cloudUrl(s, this.d.env);
    const token = tokenFor(this.d.env, url);
    if (!token) {
      return { phase: "1. Prepare", where: "arnx models is on, and this machine is not logged in", command: "arnx login",
        why: "", then: n.command };
    }
    try {
      const acct = await this.cloudClient(url, token, s, mode).call<Account>("GET", "/v1/account");
      if (acct.balance_micro_usd > 0) return n;
      return { phase: n.phase, where: `${n.where}; the arnx cloud balance is ${usd(acct.balance_micro_usd)}`,
        command: "arnx credits", why: `top up at ${acct.topup_url}`, then: n.command };
    } catch (e) {
      if (!(e instanceof ArnxError)) throw e;
      return { ...n, why: `${n.why} (arnx cloud could not be asked for the balance: ${oneLine(e.message)})` };
    }
  }

  async mark(a: Args): Promise<number> {
    const repo = this.repo();
    const rdir = findReview(repo, a.positionals[0] ?? null);
    const review = load(rdir);
    const mdPath = join(rdir, "review.md");
    const md = readFileSync(mdPath, "utf8");
    // --json: no terminal, nothing drawn or changed; the marks and answers as review.md holds them now.
    if (this.j) {
      this.emit("ok", 0, triageJson(review, md, relative(repo, mdPath)));
      return 0;
    }
    if (!this.d.keys || !this.d.draw) {
      throw new ArnxError(`arnx triage needs a terminal; mark ${relative(repo, mdPath)} in an editor instead`);
    }
    const keys = this.d.keys();
    let result;
    try {
      result = await markInteractive(review, md, { keys, draw: this.d.draw, paint: paint(!!this.d.color),
        width: this.d.width ?? 100 });
    } finally {
      keys.close?.();
    }
    this.d.draw([]);
    if (!result) {
      this.d.out("Not saved; review.md is unchanged.");
      return 0;
    }
    writeFileSync(mdPath, wrapMarkdown(applyMarks(md, result)));
    recordChosen(rdir, result.chosen);
    const n = (m: string) => Object.values(result.findings).filter((x) => x === m).length;
    this.d.out(`Saved to ${relative(repo, mdPath)}: ${n("real")} real, ${n("intended")} intended, ${n("noise")} noise` +
      `${n("rewrite") ? `, ${n("rewrite")} rewrite` : ""}; ` +
      `${Object.keys(result.answers).length} question(s) answered.`);
    this.d.out(`Next: arnx accept ${review.id}`);
    return 0;
  }

  async prompt(a: Args): Promise<number> {
    const repo = this.repo();
    const rdir = a.positionals[0] ? findReview(repo, a.positionals[0]) : findAccepted(repo);
    const file = join(rdir, "fix-prompt.md");
    if (!existsSync(file)) {
      throw new ArnxError(`review ${basename(rdir)} has no fix prompt yet: mark it and run \`arnx accept ${basename(rdir)}\``);
    }
    const text = readFileSync(file, "utf8");
    this.d.out(text.trimEnd());
    this.emit("ok", 0, { review_id: basename(rdir), path: relative(repo, file).split(sep).join("/"), text });
    return 0;
  }

  async check(a: Args): Promise<number> {
    if (a.positionals.length && !a.values.review) throw new ArnxError("a review id goes with --review: " +
      `arnx check --review ${a.positionals[0]}`);
    const repo = this.repo();
    suffixReviewCopies(repo);
    const s = loadSettings(repo);
    const json = !!a.values.json;
    if (a.values.review) return this.recheck(a, repo, s, json);
    // Accepted tests edited or deleted since accept are not run: passing them would prove nothing. Nor are they when
    // their pins were changed or removed by anything but arnx.
    const changed = changedAccepted(repo, localPinsPath(this.d.env, repo));
    if (changed.length) {
      if (json) this.emitRaw(checkJson([], TESTS_CHANGED, changed));
      else this.d.out(colorLines(changedSummary(changed, repo), paint(!!this.d.color)));
      return TESTS_CHANGED;
    }
    // Accepted tests an older arnx kept in the projects' own test folders: their runs collect them.
    const legacy = [...legacyAccepted(repo, s).keys()];
    if (legacy.length) {
      throw new ArnxError(`${legacy.length} accepted file${legacy.length === 1 ? " is" : "s are"} in your own test ` +
        `folders, where your test run picks ${legacy.length === 1 ? "it" : "them"} up:\n` +
        legacy.slice(0, 5).map((p) => `  ${p}`).join("\n") + (legacy.length > 5 ? `\n  … and ${legacy.length - 5} more` : "") +
        "\nMove them to .arnx/tests/: arnx accept --move");
    }
    const progress = new Progress(this.progressLine, { quiet: a.values.quiet as boolean | undefined,
      live: this.d.live ?? null });
    const started = performance.now();
    progress.start();
    let results;
    try {
      results = await check(repo, s, { progress: progress.say, pins: localPinsPath(this.d.env, repo),
        ...(this.d.checkSessions ? { sessionFactory: this.d.checkSessions } : {}) });
    } finally {
      progress.stop();
    }
    const [text, code] = checkSummary(results);
    if (json) this.emitRaw(checkJson(results, code));
    else this.d.out(colorLines(text, paint(!!this.d.color)));
    await this.sendTelemetry("check", () => checkData(results, code, (performance.now() - started) / 1000));
    return code;
  }
}

/** Where every approval is recorded, with its warnings (a local file, under .arnx/setup/). */
export const APPROVAL_RECORD = ".arnx/setup/approval.md";

/** The ids shown of a failed suite's tests; the rest are counted. */
const SHOWN_FAILING = 5;

/** Why a setup failed, told apart: the environment never ran, or it runs and the current code fails tests. */
/** What lets in the files a stopped setup needs: secret-looking ones are allowed, .arnxignore'd ones excepted. */
export function neededSteps(needed: NeededFile[]): string[] {
  const secret = needed.filter((f) => f.secret).map((f) => f.path);
  const ignored = needed.filter((f) => !f.secret).map((f) => `!${f.path}`);
  return [...secret.length ? [`arnx allow-secret ${secret.join(" ")}`] : [],
    ...ignored.length ? [`add ${ignored.join(" ")} to .arnxignore`] : []];
}

export function setupFailure(r: SetupResult, budgetUsd: number)
  : { text: string; json: { kind: "environment" | "tests"; reason: string; failing: string[] } } {
  if (r.failing.length) {
    const n = r.failing.length;
    const more = n - SHOWN_FAILING;
    const ids = r.failing.slice(0, SHOWN_FAILING).join(", ") + (more > 0 ? ` (+${more} more)` : "");
    return { text: `Setup got your suite running, but ${n} test${n === 1 ? " fails" : "s fail"} on the current code: ` +
      `${ids}.`, json: { kind: "tests", reason: `${r.failingProject}: ${n} failing outside known_failing`,
      failing: r.failing } };
  }
  if (r.needed?.length) {
    return { text: `Setup stopped: ${r.problem}.`, json: { kind: "environment", reason: r.problem, failing: [] } };
  }
  const stop = r.stop === "budget" ? `the $${budgetUsd.toFixed(2)} budget ran out`
    : r.stop === "max_turns" ? "the agent ran out of turns" : r.stop === "refusal" ? "the model refused" : "";
  const last = r.problem || (r.yamlText ? r.summary : "no proposal");
  const reason = stop ? `${stop} (last: ${last})` : last;
  return { text: `Setup could not build a working environment: ${reason}.`,
    json: { kind: "environment", reason, failing: [] } };
}

const tryParse = (text: string | null): ReviewFile | null => {
  if (!text) return null;
  try {
    return parseReviewFile(text);
  } catch (e) {
    if (e instanceof ArnxError) return null;
    throw e;
  }
};

/** `arnx setup --json` (skills/arnx/references/json.md): each project as setup proved it and approval ran it. */
function setupJson(o: { file: ReviewFile | null; result: SetupResult; approved: boolean; auto: boolean;
  files: FilesSummary | null; warnings: string[]; reviewYaml: string | null; record: string | null; seconds: number;
  failure: Record<string, unknown> | null; next: string[]; approval?: ApprovedProject[] }): Record<string, unknown> {
  const r = o.result;
  return { approved: o.approved, auto_approved: o.auto,
    projects: (o.file?.projects ?? []).map((p) => {
      const proof = r.projects.find((x) => x.name === p.name);
      const ran = o.approval?.find((x) => x.name === p.name);
      return { name: p.name, runs_in: p.workdir || ".", image: p.image, runner: p.runner,
        // A failed setup's last try names its project ("shop: 1 failed, 1 passed; …").
        suite: ran?.summary ?? proof?.summary ?? (r.summary.startsWith(`${p.name}: `)
          ? r.summary.slice(p.name.length + 2) : null), ok: ran ? ran.ok : r.ok && !!proof,
        accepted_failing: ran?.accepted_failing ?? 0,
        unexpected: ran?.unexpected ?? (r.failingProject === p.name ? r.failing : []) };
    }),
    files: o.files && { projects: o.files.projects, not_tested: o.files.notTested,
      untracked_left_out: o.files.untrackedLeftOut },
    warnings: o.warnings, review_yaml: o.reviewYaml, approval_record: o.record, cost_usd: r.costUsd,
    seconds: o.seconds, failure: o.failure, next: o.next };
}

/** One project's suite in `approve --json` (skills/arnx/references/json.md). */
export interface ApprovedProject { name: string; ok: boolean; summary: string; accepted_failing: number;
  unexpected: string[] }

/** `arnx review --json`: the result, the exit code and a summary of the review, as the terminal summary shows it
 * (review.json holds the whole review). */
export function reviewJson(r: Review, reviewMd: string, reviewJsonPath: string)
  : [string, number, Record<string, unknown>] {
  const code = exitCode(r);
  const st = summaryStatus(r);
  const rows = summaryRows(r);
  const needed = neededQuestions(r);
  const problems = st.problems.length ? st.problems : st.untested ? [`no test refers to ${st.untested} of ${st.of} ` +
    "changed source files, so finding nothing there says nothing about them"] : [];
  return [code === 1 ? "findings" : code === 2 ? "incomplete" : "clean", code, {
    review_id: r.id, review_md: reviewMd, review_json: reviewJsonPath, change: r.change, files_changed: r.filesChanged,
    added: r.added, removed: r.removed,
    status: st.problems.length ? "incomplete" : st.untested ? "partly-covered" : "complete",
    issues: rows.length, findings: rows.map((row) => ({ ids: row.ids, state: row.state, confirmed: row.mark === "✗",
      regression: row.regression, projects: row.projects, title: row.title, severity: row.severity ?? null })),
    pre_existing: r.findings.filter((f) => findingStatus(f) === "pre-existing").map((f) => f.id),
    questions: r.questions.map((q, i) => ({ id: `Q${i + 1}`, question: q,
      project: r.questionProjects[i] ?? r.projects[0] ?? "main", optional: !needed.has(`Q${i + 1}`) })),
    tests_written: r.testsWritten, cost_usd: r.costUsd, seconds: r.seconds, untracked_left_out: r.untrackedLeftOut ?? 0,
    problems, provider_failures: (r.providerFailures ?? []).map(failureLine),
    not_tested: [...(r.untested ?? []).flatMap((u) => u.files), ...r.uncovered.map((u) => u.path)],
    your_call: yourCall(r, rows) || null, next: nextSteps(r, rows),
  }];
}

/** `arnx triage --json`: each finding with its mark and severity, each question with its answer, as review.md holds
 * them. */
export function triageJson(r: Review, md: string, reviewMd: string): Record<string, unknown> {
  const m = parseMarks(md, r.findings.map((f) => f.id));
  return { review_id: r.id, review_md: reviewMd,
    findings: r.findings.map((f) => ({ id: f.id, status: findingStatus(f), mark: m.findings[f.id] ?? null,
      severity: m.severity[f.id] ?? null, rewrite: m.rewrites?.[f.id] ?? null, project: f.project, test_id: f.testId,
      title: f.explanation.split("\n")[0] || f.message.split("\n")[0] || "" })),
    questions: r.questions.map((q, i) => ({ id: `Q${i + 1}`, question: q, answer: m.answers[`Q${i + 1}`] ?? null })) };
}

/** The language of each project a review.yaml text holds (none when it does not parse). */
function projectLanguages(yamlText: string | null): string[] {
  try {
    return yamlText ? parseReviewFile(yamlText).projects.map((p) => p.language) : [];
  } catch {
    return [];
  }
}

const minutes = (ms: number) => {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, "0")}s`;
};

/** `arnx <command> --help`: that command's lines from USAGE, written as commands, and what --quiet, --local and
 * --cloud do when it takes them. */
export function commandHelp(command: string): string {
  // USAGE's descriptions start at column 40; a line whose options run past it has its description on the next line.
  const split = (l: string): [string, string] => l.length > 40 && l[39] === " " ? [l.slice(0, 40).trim(), l.slice(40).trim()]
    : [l.trim(), ""];
  const rows: [string, string][] = [];
  let inside = false;
  for (const l of USAGE.split("\n")) {
    if (/^  \S/.test(l)) {
      const [head, text] = split(l);
      inside = head.split(" | ").some((x) => x.split(" ")[0] === command);
      if (inside) rows.push([`arnx ${head.replace(/ \| /g, " | arnx ")}`, text]);
    } else if (inside && /^ {8}/.test(l)) {
      const [head, text] = split(l);
      rows.push([head ? `     ${head}` : "", text]);
    } else {
      inside = false;
    }
  }
  // One column for the descriptions beside their options; a description on its own line goes under the command.
  const width = Math.max(0, ...rows.filter(([h, text]) => h && text).map(([h]) => h.length));
  const out = rows.map(([h, text]) => !h ? `     ${text}` : text ? `${h.padEnd(width)}  ${text}` : h);
  const options = COMMANDS[command]?.options ?? {};
  const notes = [..."quiet" in options ? ["--quiet hides progress."] : [],
    ..."local" in options ? ["--local or --cloud picks the models for one run."] : [], "--json prints one JSON object."];
  return [...out, "", notes.join(" ")].join("\n");
}

/** A usage error in arnx's words (Node's parser explains how to pass a positional argument that starts with '-'). */
function usageError(e: unknown): string {
  const message = e instanceof Error ? e.message : String(e);
  const option = /'([^']+)'/.exec(message)?.[1]?.split(" ")[0];
  const code = (e as { code?: string }).code;
  if (code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && option) return `unknown option '${option}'`;
  if (/argument missing/.test(message) && option) return `option '${option}' needs a value`;
  if (/does not take an argument/.test(message) && option) return `option '${option}' takes no value`;
  return message.charAt(0).toLowerCase() + message.slice(1);
}

type Parsed = { command: string; args: Args } | { exit: number; out?: string; err?: string[]; usage?: string };

function parse(argv: string[]): Parsed {
  const [command, ...rest] = argv;
  if (command === "--version") return { exit: 0, out: versionLine() };
  if (command === "-h" || command === "--help") return { exit: 0, out: USAGE };
  if (!command) return { exit: 2, err: ["arnx: a command is required", USAGE] };
  const spec = COMMANDS[command];
  if (!spec) {
    return { exit: 2, usage: `unknown command '${command}'`,
      err: [`arnx: unknown command '${command}'`, "Run `arnx --help` for the commands."] };
  }
  const wrong = (what: string): Parsed => ({ exit: 2, usage: what,
    err: [`arnx ${command}: ${what}`, `Run \`arnx ${command} --help\` for its options.`] });
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { ...spec.options, help: { type: "boolean", short: "h" } },
      allowPositionals: true, strict: true });
  } catch (e) {
    return wrong(usageError(e));
  }
  if (parsed.values.help) return { exit: 0, out: commandHelp(command) };
  if (parsed.positionals.length > spec.positionals) {
    return wrong(`unexpected argument '${parsed.positionals[spec.positionals]}'`);
  }
  return { command, args: { values: parsed.values, positionals: parsed.positionals } };
}

export async function main(argv: string[], deps: Partial<CliDeps> = {}): Promise<number> {
  const d: CliDeps = { cwd: process.cwd(), env: process.env, ask, dockerOk,
    interactive: !!(process.stdin.isTTY && process.stdout.isTTY),
    banner: !!process.stdout.isTTY,
    out: (line) => process.stdout.write(line + "\n"), err: (line) => process.stderr.write(line + "\n"),
    color: colorFor(process.stdout, process.env), colorErr: colorFor(process.stderr, process.env),
    ...(process.stderr.isTTY && process.env.TERM !== "dumb" ? { live: {
      raw: (t: string) => process.stderr.write(t), width: (process.stderr.columns ?? 100) - 1,
      dim: paint(colorFor(process.stderr, process.env)).dim, yellow: paint(colorFor(process.stderr, process.env)).yellow,
    } } : {}),
    ...(process.stdin.isTTY && process.stdout.isTTY ? {
      keys: () => terminalKeys(process.stdin),
      draw: (lines: string[]) => process.stdout.write(`\x1b[2J\x1b[H${lines.join("\n")}\n`),
      width: Math.min(100, (process.stdout.columns ?? 100) - 2),
    } : {}), ...deps };
  const p = parse(argv);
  if ("exit" in p) {
    if (p.out) d.out(p.out);
    for (const line of p.err ?? []) d.err(line);
    if (p.usage && argv.includes("--json")) {
      d.out(jsonObject(argv[0] ?? "", "usage-error", p.exit, { error: p.usage }));
    }
    return p.exit;
  }
  // --json: the object on stdout, everything else on stderr, and no questions (no terminal to answer them).
  const j: JsonOut | null = p.args.values.json ? { command: p.command, write: d.out, done: false } : null;
  const human: CliDeps = j ? { ...d, out: d.err, interactive: false, banner: false, ask: async () => null, keys: undefined,
    draw: undefined, color: d.colorErr } : d;
  const code = await run(p.command, p.args, new Commands(human, j), human);
  // A command that wrote no object of its own still answers in JSON: its result and exit code.
  if (j && !j.done) j.write(jsonObject(p.command, code === 0 ? "ok" : "fail", code));
  return code;
}

/** Runs one command; arnx's own errors are one line (and, with --json, the object says it). */
async function run(command: string, args: Args, commands: Commands, d: CliDeps): Promise<number> {
  try {
    switch (command) {
      case "init": return await commands.init(args);
      case "doctor": return await commands.doctor(args);
      case "setup": return await commands.setup(args);
      case "approve": return await commands.approve(args);
      case "review": return await commands.review(args);
      case "check": return await commands.check(args);
      case "prompt": return await commands.prompt(args);
      case "triage": return await commands.mark(args);
      case "next": return await commands.next(args);
      case "allow-secret": return await commands.allowSecret(args);
      case "env": return await commands.env(args);
      case "consent": return await commands.consent(args);
      case "cloud": return await commands.cloud(args);
      case "login": return await commands.login();
      case "logout": return await commands.logout();
      case "credits": return await commands.credits();
      case "skill": return await commands.skill(args);
      case "prompts": return await commands.prompts(args);
      case "remove": return await commands.remove(args);
      default: return await commands.accept(args);
    }
  } catch (e) {
    const lines = e instanceof ArnxError ? [`arnx: ${e.message}`] : internalError(e, d.env);
    for (const line of lines) d.err(line);
    const code = e instanceof ArnxError ? e.exitCode : 2;
    commands.fail(e instanceof ArnxError ? e.message : lines[0]!.replace(/^arnx: /, ""), code);
    return code;
  }
}

/** A message of several lines (an error and its hint) on one, for a check's or a note's detail. */
const oneLine = (m: string) => m.replace(/\n/g, " ");

/** Model spend from now on, for a progress display's cost column. */
function costSince(): () => number {
  const base = spend.total;
  return () => spend.total - base;
}

/** Copies text to the clipboard with whatever tool the system has; says what it did, or null when none was found. */
export function copyToClipboard(text: string): string | null {
  const tools: [string, string[]][] = [["wl-copy", []], ["xclip", ["-selection", "clipboard"]],
    ["xsel", ["--clipboard", "--input"]], ["pbcopy", []]];
  for (const [cmd, args] of tools) {
    const r = spawnSync(cmd, args, { input: text });
    if (!r.error && r.status === 0) return `Copied the fix prompt to the clipboard (${cmd}).`;
  }
  return null;
}
