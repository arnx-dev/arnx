// `arnx scan`: the hunt of a review alone, on this machine. The change is taken as a review takes it, the hunters read
// the same scrubbed snapshot, and every model goes through the same filter. The reviewer reads with its read tools
// only (list, read, search), and the round ends at its hunt reply: nothing is written into the project, nothing is
// run, and Docker is never asked for. What comes out are suspects: unproven until `arnx review` tests them.
//
// A scan writes only its own folder, .arnx/scans/<id>/, which no other command reads.
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { adapterFor } from "./adapters";
import type { AdapterId } from "./adapters/types";
import { Workspace } from "./agent";
import type { Boundary } from "./boundary";
import type { ReviewInput, RoundHunt } from "./brain";
import { type Change, describe, resolveChange, sliceDiff, takeSnapshot } from "./change";
import { configSuspects, isSeedFile, loadReviewFile, type ReviewConfig, reviewConfigPath, type ReviewFile,
  sandboxOnlyOf, secretPinsOf } from "./config";
import { CONTEXT_LIMIT, contextPack } from "./context";
import { detect, isTestPath, repoLanguages } from "./detect";
import { ArnxError, NoChange, SetupRequired } from "./errors";
import { unsupportedText } from "./languages";
import { allPrices, type AgentModel, FallbackJson, type JsonModel, type ModelUse } from "./llm";
import { LocalBrain } from "./localbrain";
import type { Say } from "./progress";
import type { Suspect } from "./prompts";
import { envTests, newReviewId, sayChange } from "./reviewer";
import { docsFilter, route } from "./route";
import { refString, type Settings } from "./settings";
import { swapIn } from "./testround";
import { changedSources, databaseEnv, untestedFiles } from "./untested";
import { promptsFor } from "./userprompts";

/** The models a scan uses: the reviewer reads, the tool-less hunters and the ranker as in a review. */
export interface ScanModels {
  agentModel: AgentModel;
  /** The second opinion: a review's second hunter when it is another vendor's model and none is configured. */
  challenger?: JsonModel;
  hunter?: JsonModel;
  ranker?: JsonModel;
  secondHunter?: JsonModel | null;
}

/** One suspect as a scan reports it: the hunt's suspect, with its project and whether any of the project's own test
 * files names its file (false is certain; true only means a test file mentions the name). */
export interface ScanSuspect extends Suspect { project: string; testNamesFile: boolean | null }

export interface ScanProject { name: string; language: AdapterId; root: string; files: string[];
  /** Why the project gave no list: the reviewer stopped before its hunt reply (the budget, an API error). */
  stopped?: string;
  /** Some hunter failed or ran out of time: the list may be short. */
  partial?: true }

export interface ScanResult {
  id: string;
  /** The scan's folder, relative to the repository. */
  dir: string;
  change: string;
  /** Where the projects came from: .arnx/review.yaml, or arnx's reading of the repository (no setup yet). */
  projectsFrom: "review.yaml" | "detected";
  projects: ScanProject[];
  /** Ranked: each project's own order, taken in turn across projects. */
  suspects: ScanSuspect[];
  notScanned: { path: string; reason: string }[];
  costUsd: number;
  /** Some call's cost is unknown (an unpriced model): `costUsd` is a floor. */
  costUnknown: boolean;
  budgetUsd: number;
  /** The budget stopped a round before its hunt reply. */
  capped: boolean;
  seconds: number;
  models: { reviewer: string; hunter: string | null; ranker: string | null; second_hunter: string | null };
}

/** Where scans are kept: their own folder, ignored by git, read by no other command. */
export const SCANS_DIR = posix.join(".arnx", "scans");

/** The most test-file text read to tell which changed files a project's tests name. */
const TEST_TEXT_LIMIT = 4_000_000;
const SKIP_DIRS = new Set([".git", "node_modules", "target", "dist", "build", ".venv", "venv", "__pycache__", "vendor"]);

interface Planned { cfg: ReviewConfig; owned: string[]; used: string[] }

const rootOf = (r: string) => (r === "" || r === "." ? "." : r.replace(/\/+$/, ""));
const inside = (root: string, path: string) => root === "." || path === root || path.startsWith(`${root}/`);

/** A project for a repository with no setup: one detected candidate as a review's project, with the adapter's own
 * defaults. Only what the hunt reads is filled in; nothing here builds or runs anything. */
export function detectedProject(c: { root: string; language: AdapterId; runner: string | null }): ReviewConfig {
  const root = rootOf(c.root);
  const adapter = adapterFor({ language: c.language });
  return { raw: {}, language: c.language, runner: c.runner ?? adapter.defaultRunner, image: "", workdir: root,
    install: [], testCommand: "", services: [], env: {}, notes: [], knownFailing: [], testsDir: adapter.defaultTestsDir,
    name: root === "." ? "main" : root, owns: [root === "." ? "**" : `${root}/`], uses: [], installRoot: root };
}

/** The change's files routed to detected projects: each to the deepest candidate holding it, one of the file's own
 * language first. Files no candidate holds, and projects past `maxProjects` (the ones with fewest files), are named. */
export function planDetected(repo: string, files: string[], maxProjects: number)
  : { planned: Planned[]; notScanned: { path: string; reason: string }[] } {
  const candidates = detect(repo).candidates.filter((c) => c.language !== "other") as
    { root: string; language: AdapterId; runner: string | null }[];
  const byExt: Record<string, AdapterId> = { py: "python", ts: "typescript", tsx: "typescript", js: "typescript",
    jsx: "typescript", mjs: "typescript", cjs: "typescript", mts: "typescript", cts: "typescript", rs: "rust", go: "go",
    cs: "csharp" };
  const groups = new Map<string, { c: (typeof candidates)[number]; files: string[] }>();
  const notScanned: { path: string; reason: string }[] = [];
  for (const f of files) {
    const lang = byExt[posix.extname(f).slice(1)];
    const holding = candidates.filter((c) => inside(rootOf(c.root), f))
      .sort((a, b) => rootOf(b.root).length - rootOf(a.root).length);
    // No manifest holds it (a bare script, a small repository): the repository's root, in the file's own language.
    const pick = holding.find((c) => c.language === lang) ?? holding[0] ??
      (lang ? { root: ".", language: lang, runner: null } : undefined);
    if (!pick) {
      notScanned.push({ path: f, reason: "no project arnx reviews holds it" });
      continue;
    }
    const key = `${rootOf(pick.root)}\0${pick.language}`;
    const g = groups.get(key) ?? { c: pick, files: [] };
    g.files.push(f);
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => b.files.length - a.files.length);
  for (const g of ordered.slice(maxProjects)) {
    for (const f of g.files) notScanned.push({ path: f, reason: `more than max_projects (${maxProjects}) projects changed` });
  }
  return { planned: ordered.slice(0, maxProjects).map((g) => ({ cfg: detectedProject(g.c), owned: g.files, used: [] })),
    notScanned };
}

/** The change's files routed to the projects of .arnx/review.yaml, as a review routes them. A file no project
 * covers is named with review.yaml's reason, not scanned. */
export function planConfigured(file: ReviewFile, files: string[], maxProjects: number, isDoc: (p: string) => boolean)
  : { planned: Planned[]; notScanned: { path: string; reason: string }[] } {
  const routing = route(file, files, maxProjects, isDoc);
  const seen = new Set(routing.routed.flatMap((r) => [...r.owned, ...r.used]));
  const reasons = new Map(routing.uncovered.map((u) => [u.path, u.reason]));
  const notReviewed = new Set(routing.notReviewed);
  const notScanned = files.filter((f) => !seen.has(f) && !isDoc(f)).map((path) => ({ path,
    reason: reasons.get(path) ?? (notReviewed.has(path) ? `more than max_projects (${maxProjects}) projects changed`
      : "no project in .arnx/review.yaml covers it") }));
  return { planned: routing.routed.map((r) => ({ cfg: r.project, owned: r.owned, used: r.used })), notScanned };
}

/** The project's own test files in the snapshot, as text (up to about TEST_TEXT_LIMIT characters in all; `whole` is
 * false when the limit cut the reading short, or a test file was too large to read). */
function projectTests(snap: string, cfg: ReviewConfig): { tests: Record<string, string>; whole: boolean } {
  const adapter = adapterFor(cfg);
  const out: Record<string, string> = {};
  let size = 0;
  const walk = (rel: string) => {
    let names: string[];
    try {
      names = readdirSync(join(snap, rel)).sort();
    } catch {
      return;
    }
    for (const name of names) {
      if (size > TEST_TEXT_LIMIT) return;
      const path = rel === "." ? name : `${rel}/${name}`;
      let st;
      try {
        st = statSync(join(snap, path));
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (!SKIP_DIRS.has(name)) walk(path);
      } else if (st.isFile() && (adapter.isTestFile(name) || isTestPath(path))) {
        if (st.size >= 1_000_000) {
          size = TEST_TEXT_LIMIT + 1;
          return;
        }
        try {
          const body = readFileSync(join(snap, path), "utf8");
          out[path] = body;
          size += body.length;
        } catch {
          // unreadable: not counted
        }
      }
    }
  };
  walk(cfg.workdir === "." ? "." : cfg.workdir);
  return { tests: out, whole: size <= TEST_TEXT_LIMIT };
}

/** Each project's suspects, taken in turn (the first of each, then the second of each, …), numbered S1, S2, … */
function inTurn(lists: ScanSuspect[][]): ScanSuspect[] {
  const out: ScanSuspect[] = [];
  for (let i = 0; lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length) out.push(l[i]!);
  return out.map((s, k) => ({ ...s, id: `S${k + 1}` }));
}

const cost = (uses: (ModelUse | null | undefined)[]) => uses.reduce((n, u) => n + (u?.costUsd ?? 0), 0);
const unknown = (uses: (ModelUse | null | undefined)[]) => uses.some((u) => !!u && (u.unknownCalls > 0 || !!u.unpriced));

/** The hunt of a change, with nothing proven: see the file's head. */
export async function runScan(repo: string, o: { settings: Settings; models: ScanModels; boundary: Boundary;
  range?: string | null; untracked?: boolean; docs?: boolean; progress?: Say; now?: Date;
  /** How long the reviewer's hunt reply waits for the second hunter (default: as a review). */
  secondHuntWaitMs?: number; lateHuntWaitMs?: number }): Promise<ScanResult> {
  const s = o.settings;
  const started = performance.now();
  // The projects come from review.yaml once there is one (approved or not); before setup, from the files themselves.
  const configured = existsSync(reviewConfigPath(repo)) && !isSeedFile(repo);
  const file = configured ? loadReviewFile(repo, { requireApproved: false }) : null;
  const pins = file ? secretPinsOf(file.raw) : [];
  const change: Change = resolveChange(repo, o.range ?? null, pins, { untracked: o.untracked ?? s.untracked });
  sayChange(change, o.progress);
  const isDoc = docsFilter(repo, change.withUntracked ? null : change.head, !!o.docs);
  const files = change.files.filter((f) => !isDoc(f));
  if (change.files.length && !files.length) {
    const shown = change.files.slice(0, 3).join(", ") + (change.files.length > 3 ? `, +${change.files.length - 3} more` : "");
    throw new NoChange(`nothing to scan: only documentation changed (${shown}). \`arnx scan --docs\` scans it anyway.`);
  }
  if (!file) {
    const langs = repoLanguages(repo);
    if (langs?.onlyOthers) throw new SetupRequired(unsupportedText(langs.survey));
  }
  const plan = file ? planConfigured(file, change.files, s.maxProjects, isDoc) : planDetected(repo, files, s.maxProjects);
  if (!plan.planned.length) {
    throw new SetupRequired(`nothing in this change can be scanned: ${plan.notScanned.slice(0, 3)
      .map((n) => `${n.path} (${n.reason})`).join(", ")}${plan.notScanned.length > 3 ? ", …" : ""}`);
  }
  const id = newReviewId(o.now ?? new Date());
  const dir = join(repo, SCANS_DIR, id);
  mkdirSync(dir, { recursive: true });
  // The scans folder ignores itself: nothing a scan keeps shows in git status or reaches a commit.
  writeFileSync(join(repo, SCANS_DIR, ".gitignore"), "*\n");
  const tmp = mkdtempSync(join(tmpdir(), "arnx-scan-"));
  const b = o.boundary;
  const m = o.models;
  // The second hunter a review would use: the configured one, else the second opinion when it is another vendor's.
  const vendor = (ref: string) => ref.split(":")[0];
  const secondHunter = m.secondHunter ?? (m.challenger && vendor(m.challenger.ref) !== vendor(refString(s.reviewer)) &&
    !(m.challenger instanceof FallbackJson) ? m.challenger : null);
  const brain = new LocalBrain({ agentModel: m.agentModel, prices: allPrices(s), boundary: b, prompts: promptsFor(repo),
    ...(m.hunter ? { hunter: m.hunter } : {}), ...(m.ranker ? { ranker: m.ranker } : {}), secondHunter,
    ...(o.secondHuntWaitMs === undefined ? {} : { secondHuntWaitMs: o.secondHuntWaitMs }),
    ...(o.lateHuntWaitMs === undefined ? {} : { lateHuntWaitMs: o.lateHuntWaitMs }) });
  const uses: (ModelUse | null)[] = [];
  let spent = 0, capped = false;
  const projects: ScanProject[] = [];
  const lists: ScanSuspect[][] = [];
  try {
    // Nothing has left yet: the filter knows the diff before the first request, and the tree before the first round.
    b.addDiff(change.diff, pins);
    b.add(configSuspects(repo));
    const snap = join(tmp, "repo");
    const taken = takeSnapshot(repo, change.head, snap, pins,
      { sandbox: file ? sandboxOnlyOf(file.raw) : [], untracked: !!change.withUntracked });
    b.addScrubbed(taken);
    const reads = swapIn(b, snap);
    const n = plan.planned.length;
    for (const [i, { cfg, owned, used }] of plan.planned.entries()) {
      const say = (msg: string) => o.progress?.(`${cfg.name}${n > 1 ? ` (${i + 1}/${n})` : ""}: ${msg}`);
      const project: ScanProject = { name: cfg.name, language: cfg.language, root: cfg.workdir, files: [...owned, ...used] };
      projects.push(project);
      const left = s.scanBudgetUsd - spent;
      if (left <= 0) {
        project.stopped = "the scan budget was spent";
        capped = true;
        lists.push([]);
        continue;
      }
      const legacy = !!file?.legacy;
      const diff = legacy ? change.diff : sliceDiff(change.diff, [...owned, ...used]) || change.diff;
      const seen = new Set([...owned, ...used]);
      const elsewhere = legacy || diff === change.diff ? [] : change.files.filter((f) => !seen.has(f));
      const leftOut = change.withheld ? { leftOut: change.withheld } : {};
      const scope = legacy ? { owned: change.files, used: [], ...leftOut } : { owned, used, elsewhere, ...leftOut };
      const searchDirs = [cfg.workdir, ...new Set(used.map((u) => posix.dirname(u)))];
      const outDir = join(dir, "projects", cfg.name.replace(/[^\w.-]+/g, "_"));
      mkdirSync(outDir, { recursive: true });
      const input: ReviewInput = { cfg, diff, scope, scoped: file ? !legacy : n > 1, envTests: envTests(snap, cfg),
        maxQuestions: s.maxQuestions, dbNames: databaseEnv(cfg.env, cfg.services), budgetUsd: left / (n - i), outDir,
        progress: o.progress, huntOnly: true,
        hunt: { context: contextPack(snap, diff, owned, searchDirs, CONTEXT_LIMIT, null), root: snap, searchDirs } };
      // The reviewer's tools are the read tools alone: no folder to write in, no runner.
      const ws = new Workspace(snap, { adapter: adapterFor(cfg), runner: cfg.runner, reads });
      say("reading the change");
      const r = await brain.agentRound("review", input, Promise.resolve({ tools: () => ws.tools(),
        call: (name: string, args: Record<string, unknown>) => ws.call(name, args) }));
      const h: RoundHunt | undefined = r.hunt;
      // A hunter still out when the reviewer replied: waited for here, so its cost is counted.
      const late = h?.late ? await h.late() : null;
      const reviewerUse: ModelUse = { ...r.agent.usage, model: m.agentModel.model, calls: r.agent.calls,
        unknownCalls: r.agent.unknownCalls ?? 0, costUsd: r.agent.costUsd };
      const roundUses = [reviewerUse, h?.second ?? null, ...h?.extras ?? [], late];
      uses.push(...roundUses);
      spent += cost(roundUses);
      if (!h?.suspects) {
        project.stopped = r.agent.stop === "budget" ? "the scan budget was spent" : `the reviewer stopped (${r.agent.stop})`;
        if (r.agent.stop === "budget") capped = true;
        lists.push([]);
        continue;
      }
      const record = h.record;
      if (record && (record.second === null && secondHunter)) project.partial = true;
      const named = testNames(snap, cfg, owned);
      lists.push(h.suspects.map((x) => ({ ...x, project: cfg.name, testNamesFile: named(x.file) })));
      say(`${h.suspects.length} suspect${h.suspects.length === 1 ? "" : "s"}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  // No project gave a list: the scan did not run, whatever stopped it (exit 2), never a scan with no suspects.
  if (projects.every((p) => p.stopped)) {
    throw new ArnxError(`the scan could not run: ${projects.map((p) => `${p.name}: ${p.stopped}`).join("; ")}` +
      (capped ? `. Raise [budget] scan_usd in .arnx/config.toml (now ${money(s.scanBudgetUsd)})` : ""));
  }
  const result: ScanResult = { id, dir: posix.join(SCANS_DIR, id), change: describe(change),
    projectsFrom: file ? "review.yaml" : "detected", projects, suspects: inTurn(lists), notScanned: plan.notScanned,
    costUsd: Math.round(spent * 1e6) / 1e6, costUnknown: unknown(uses), budgetUsd: s.scanBudgetUsd, capped,
    seconds: Math.round((performance.now() - started) / 100) / 10,
    models: { reviewer: refString(s.reviewer), hunter: m.hunter?.ref ?? null, ranker: m.ranker?.ref ?? null,
      second_hunter: secondHunter?.ref ?? null } };
  writeFileSync(join(dir, "scan.json"), JSON.stringify(scanJson(result), null, 2) + "\n");
  return result;
}

/** Whether the project's own test files name a changed source file (untested.ts: by its module or file name, not
 * measured coverage). False is certain: no test file mentions it. True only means one does, not that it is tested.
 * Null for a file that is not a changed source file, and, when the test files were too many to read, for every file
 * no test read so far names. */
export function testNames(snap: string, cfg: ReviewConfig, owned: string[]): (file: string) => boolean | null {
  const { tests, whole } = projectTests(snap, cfg);
  const adapter = adapterFor(cfg);
  const sources = new Set(changedSources(owned, adapter));
  const unnamed = new Set(untestedFiles(owned, tests, adapter, cfg.workdir));
  return (file) => !sources.has(file) ? null : !unnamed.has(file) ? true : whole ? false : null;
}

/** scan.json, and the fields of `arnx scan --json`: suspects only, every one unproven. */
export function scanJson(r: ScanResult): Record<string, unknown> {
  return { scan_id: r.id, unproven: true, change: r.change, projects_from: r.projectsFrom,
    projects: r.projects.map((p) => ({ name: p.name, language: p.language, root: p.root, files: p.files,
      ...(p.stopped ? { stopped: p.stopped } : {}), ...(p.partial ? { partial: true } : {}) })),
    suspects: r.suspects.map((x) => ({ id: x.id, project: x.project, file: x.file, line: x.line, claim: x.claim, why: x.why,
      input: x.input, expected: x.expected, actual: x.actual, by: x.by, test_names_file: x.testNamesFile })),
    not_scanned: r.notScanned, cost_usd: r.costUsd, cost_unknown: r.costUnknown, budget_usd: r.budgetUsd,
    capped: r.capped, seconds: r.seconds, models: r.models, next: ["arnx review"] };
}

/** What `arnx scan` prints: the suspects, ranked, each where, what could break and why; then the one next step. */
export function scanSummary(r: ScanResult): string[] {
  const n = r.suspects.length;
  const several = r.projects.length > 1;
  const spent = `${money(r.costUsd)}${r.costUnknown ? "+" : ""}`;
  const out = [`Scanned ${r.change}: ${n ? `${n} suspect${n === 1 ? "" : "s"}` : "no suspects"} (${spent}, ${r.seconds} s).`];
  if (n) out.push("Unproven: nothing was run. Each is a guess until a test fails.");
  for (const x of r.suspects) {
    out.push("", `${x.id}  ${x.file}${x.line ? `:${x.line}` : ""}${several ? `  (${x.project})` : ""}`, `    ${x.claim}`);
    if (x.why) out.push(`    Why: ${x.why}`);
    if (x.input) out.push(`    Try: ${x.input}`);
    if (x.input && x.expected) out.push(`    Expected: ${x.expected}`);
    if (x.input && x.actual) out.push(`    May get: ${x.actual}`);
    if (x.testNamesFile === false) out.push(`    No test file names ${posix.basename(x.file)}.`);
  }
  const notes: string[] = [];
  for (const p of r.projects) {
    if (p.stopped) notes.push(`${p.name}: not scanned (${p.stopped})`);
    else if (p.partial) notes.push(`${p.name}: the second hunter did not answer in time; the list may be short`);
  }
  const byReason = new Map<string, string[]>();
  for (const x of r.notScanned) byReason.set(x.reason, [...byReason.get(x.reason) ?? [], x.path]);
  for (const [reason, paths] of byReason) {
    notes.push(`Not scanned: ${paths.slice(0, 5).join(", ")}${paths.length > 5 ? `, +${paths.length - 5} more` : ""} (${reason})`);
  }
  if (r.capped) notes.push(`Stopped at the scan budget (${money(r.budgetUsd)}; [budget] scan_usd in .arnx/config.toml)`);
  if (notes.length) out.push("", ...notes);
  out.push("", `Saved: ${r.dir}/scan.json`);
  out.push(n ? "Next: arnx review proves or rules them out with tests."
    : "Next: arnx review tests the change; a scan proves nothing either way.");
  return out;
}

const money = (n: number) => `$${n.toFixed(2)}`;
