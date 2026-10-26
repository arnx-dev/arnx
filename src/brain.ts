// The judgement side of arnx, apart from the evidence. The CLI resolves the change, snapshots it, runs every tool
// call inside the snapshot, runs the tests and writes the report; a Brain decides what the agent does next and how
// it is asked, hunts for suspects and judges what the runs found. It never runs a test or touches the user's files.
// LocalBrain (localbrain.ts) is the open harness used with the user's own keys; a remote brain answers the same
// calls over HTTP.
import type { AgentResult, ToolCall } from "./agent";
import type { Withheld } from "./change";
import type { ReviewConfig } from "./config";
import type { Detection } from "./detect";
import type { ModelUse, Tool, Trace } from "./llm";
import type { Say } from "./progress";
import type { Scope, Suspect } from "./prompts";
import type { Merged } from "./questions";
import type { AgentReport, Finding, Group } from "./report";

/** One tool call the brain asks the CLI to run. */
export type Action = ToolCall;

/** What the CLI found after a final reply, from the snapshot as it now stands. */
export interface Facts {
  /** Changed source files no generated test names (untested.ts untestedFiles). */
  untestedFiles: string[];
  /** Changed files with SQL that no generated test connecting to the database names (untested.ts dbUntested). */
  dbUntested: string[];
  /** The generated test files in the write directory. */
  generatedFiles: string[];
}

/** One step of a round, in the shape of the cloud contract: tool calls for the CLI to run, a final reply (the CLI's
 * facts follow it), the end. */
export type Step =
  | { type: "actions"; turn: number; actions: Action[]; text: string }
  /** `report` for a review or an answer; `suspects`, the ones the hunt passed on, for a review; `hunt`, every
   * hunter's list (hunt.json's content), for a review that hunted. */
  | { type: "final"; turn: number; text: string; report?: AgentReport; suspects?: Suspect[]; hunt?: HuntRecord }
  | { type: "done"; stop: string; turns: number };

/** The CLI's side of one round: the tools it runs for the brain (reads inside the snapshot, writes only to the
 * tests directory, no shell) and what it tells the brain. */
export interface RoundTools {
  tools(): Tool[];
  /** Runs one call; a ToolError's message goes back to the model as an error result. */
  call(name: string, args: Record<string, unknown>): Promise<string>;
  /** Asked after a final reply (and awaited: a remote CLI's facts come with its next step). A round with nothing to
   * cover can leave it out. */
  facts?(): Facts | Promise<Facts>;
  /** Each model turn, before its tools run: the tools it asked for and its text (for progress lines). */
  onTurn?(turn: number, tools: string[], costUsd: number, text: string): void;
  /** Each tool call, before it runs. */
  onTool?(name: string, input: Record<string, unknown>): void;
  /** Each step of the round, in order. */
  onStep?(step: Step): void;
}

/** What every round takes. */
export interface RoundBase {
  /** No model call starts once this is spent (the last one can overshoot it). */
  budgetUsd: number;
  /** Where the round's logs go (transcript.jsonl; for a review also hunt.json and hunt-second.jsonl). Without it
   * nothing is written: a review's hunt record is on the round's result and its final steps. */
  outDir?: string;
  progress?: Say;
}

/** One project's review round. */
export interface ReviewInput extends RoundBase {
  cfg: ReviewConfig;
  /** The project's part of the change. */
  diff: string;
  /** The changed files of this round: `owned`, the ones the project owns (the follow-ups check them; the contract's
   * scope.changed_owned), and `used`, the ones it only uses (scope.changed_used). Both are named in the prompts
   * when `scoped`. */
  scope: Scope;
  /** False for a review.yaml without projects: its prompts name no scope, as in the first version (the contract's
   * scope.scoped). */
  scoped: boolean;
  /** The project's own test files that read one of its environment variables. */
  envTests: string[];
  maxQuestions: number;
  /** The variables that reach the project's database (untested.ts databaseEnv). */
  dbNames: string[];
  /** Look for defects before writing tests: the CLI's context pack, and the snapshot and directories the tool-less
   * hunters read (a part hunter builds its own context pack from them). A brain without the snapshot (a server) is
   * given what the hunters would read from it instead: `changedDefinitions` for the second hunter and `parts` for
   * the part hunters (hunt.ts huntParts builds both); given, they are used and `root` is not read. */
  hunt?: { context: string; root?: string; searchDirs: string[]; changedDefinitions?: string; parts?: HuntPart[] };
}

/** One part of a big change, as a part hunter is asked about it: its files, its context pack and its changed
 * definitions, built on the snapshot (hunt.ts huntParts). */
export interface HuntPart { files: string[]; context: string; changedDefinitions: string }

/** Every hunter's list and the ones tested, as hunt.json holds them. */
export interface HuntRecord {
  reviewer: Suspect[];
  parts: Suspect[][];
  /** null when the second hunter did not reply before the tests started (or there is none). */
  second: Suspect[] | null;
  tested: Suspect[];
  /** The second hunter's list when it replied after the tests started (kept, not tested). */
  second_late?: Suspect[];
}

/** One answered question, turned into tests. */
export interface AnswerInput extends RoundBase { cfg: ReviewConfig; question: string; answer: string; diff: string }

/** The setup agent's round: its tools are try_project and propose besides the read tools. */
export interface SetupInput extends RoundBase {
  /** What detect.ts found, as text. */
  hints: string;
  /** Files left out of the snapshot as secret-looking, described ("" when none). */
  withheld: string;
  /** Re-prove only this project of the current review.yaml. */
  project?: string;
  /** Cover what the current review.yaml lists as uncovered. */
  add?: boolean;
  /** The current review.yaml ("" when there is none). */
  current: string;
  /** What `hints` was made from, the repository's file listing (secret and .arnxignore'd files left out) and the
   * withheld files (path, label and line, never their content), for a brain that takes them as data. */
  detection?: Detection;
  tree?: string;
  withheldFiles?: Withheld[];
}

export interface RoundInputs { review: ReviewInput; answer: AnswerInput; setup: SetupInput }
export type RoundKind = keyof RoundInputs;

/** What a review round's hunt left. */
export interface RoundHunt {
  /** The suspects passed to the reviewer (S1, S2, …); null when the reviewer never replied to the hunt. */
  suspects: Suspect[] | null;
  /** The second hunter's use, when it replied before the tests started. */
  second: ModelUse | null;
  /** The part hunters' and the ranker's uses. */
  extras: ModelUse[];
  /** A hunter still out when the tests started: wait for it once the round is over. Its suspects are recorded, not
   * tested; its use is returned. */
  late: (() => Promise<ModelUse>) | null;
  /** Every hunter's list, once the reviewer replied to the hunt (`second_late` added when a late hunter returns). */
  record?: HuntRecord;
}

export interface RoundResult { agent: AgentResult; hunt?: RoundHunt }

/** What judging needs besides the findings, and what the CLI does along the way. */
export interface JudgeOptions {
  /** The whole change (a finding's project diff is in `diffs`). */
  diff: string;
  /** Generated test files by path. */
  sources: Record<string, string>;
  /** The project each question came from, in the order of `questions`. */
  questionProjects?: string[];
  maxQuestions: number;
  /** The review budget left for judging, asked before and after the questions are merged. */
  budgetLeft(): number;
  /** After questions are merged, with what the merge cost: the CLI renumbers what refers to them. */
  merged?(m: Merged, use: ModelUse): void;
  /** Before the second opinions: the CLI puts back verdicts given before an interruption and returns those
   * findings' ids (not judged again). */
  resumed?(): Set<string>;
  /** After each second opinion, with what its call cost. */
  judged?(f: Finding, costUsd: number): void;
  /** Every second-model attempt and call. */
  trace: Trace;
  progress?: Say;
}

/** Verdicts are written onto the findings (verdict, reason, dependsOn, judge). */
export interface Judged {
  /** The merged questions and where each question went; null when no merge was asked for. */
  questions: Merged | null;
  groups: Group[];
  /** The second model's uses (one per model when it has a fallback). */
  uses: ModelUse[];
}

/** A review's totals, no code. */
export interface Totals { stop: string; projectsReviewed: number; testsWritten: number; passed: number;
  findings: number; flaky: number; seconds: number }

/** A review as it opens: the change as metadata, no code. */
export interface ReviewStart { files: string[]; added: number; removed: number; diffSha256: string;
  projects: { name: string; language: string; runner: string }[];
  /** The review's budget cap. */
  budgetUsd: number;
  /** For `--resume`: the id a remote brain gave the review being resumed (state.json's cloud_review_id). */
  resumeOf?: string | null }

/** What a remote brain answered when the review opened: its id there (kept in state.json as cloud_review_id). */
export interface ReviewOpened { reviewId: string }

/** What a brain billed for a review; null when nothing is billed here (the user's keys pay the providers). */
export interface Billed { costUsd: number; byRole: Record<string, number> }

export interface Brain {
  /** What decides what is found, recorded with each review: PROMPT_VERSION for the local brain. */
  readonly version: string;
  /** The name a remote brain's work goes by in usage lines and the report: its tier and harness, never a model name
   * (absent for the local brain, whose models are named). */
  readonly label?: string;
  /** The repository's own prompts this brain runs (.arnx/prompts.toml): the keys and the hash of every template in
   * use, recorded with the review. Absent when it runs arnx's defaults, or its own (arnx cloud). */
  readonly overrides?: { keys: string[]; hash: string };
  /** The review opens, before any round: a remote brain takes its budget hold here (and can refuse to start). */
  start?(x: ReviewStart): Promise<ReviewOpened | void>;
  /** One agent round. The CLI starts a review or answer round only once the sandbox has run a test, so a round the
   * environment cannot run costs nothing; `tools` may still arrive later. */
  agentRound<K extends RoundKind>(kind: K, input: RoundInputs[K], tools: Promise<RoundTools>): Promise<RoundResult>;
  /** Questions merged, a second opinion on each finding, findings grouped by cause. Findings that fail the same way
   * before the change are not sent. */
  judge(findings: Finding[], questions: string[], diffs: Record<string, string>, o: JudgeOptions): Promise<Judged>;
  /** The review is over. */
  finish(totals: Totals): Promise<Billed | null>;
}
