#!/usr/bin/env bun
// Replays the second opinion on findings already graded, so a change to the judge is measured before it ships. Each
// judge input is rebuilt from what a review saved (review.json, each project's round.json, change.diff, the clone's
// .arnx/review.yaml) with the prompt functions a review calls. It reads those files and writes only under --out or
// --dump-prompts, never in the clone. Grades score the replies and are never handed to a prompt builder.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { Boundary, maskedJson } from "../src/boundary";
import { CONCURRENCY, inPool } from "../src/challenge";
import { sliceDiff } from "../src/change";
import { loadReviewFile } from "../src/config";
import { ArnxError, survivable } from "../src/errors";
import { allPrices, costUsd, type JsonModel, makeChallenger, unpricedModels } from "../src/llm";
import { baseName } from "../src/outcomes";
import { CHALLENGE_SCHEMA, DEFAULT_PROMPTS, elsewhereNote } from "../src/prompts";
import { confirmed, type Finding, load, notChecked, parseReports, type Review } from "../src/report";
import { route } from "../src/route";
import { defaultSettings, type Env, KNOWN_PROVIDERS, loadSettings, parseModelRef, settingsPath } from "../src/settings";

/** The known providers' tables, so a ref like kimi:<model> resolves without a config file. */
const KNOWN_TABLES = Object.fromEntries(KNOWN_PROVIDERS.map((k) => [k.name, k.table]));

const USAGE = `usage: bun scripts/replay-judge.ts --grades FILE --root DIR --model REF --out DIR [options]
       bun scripts/replay-judge.ts --grades FILE --root DIR --dump-prompts DIR

  --grades FILE        TSV with the columns repo, commit, review, finding, grade
  --root DIR           holds <repo>/.arnx/reviews/<review>/
  --model REF          provider:model, called through arnx's own factory, with no fallback
  --out DIR            writes <model>-<prompt>-<pass>.jsonl; finished rows are not sent again, errors are
  --prompt NAME        prompt to replay (default current)
  --repeat N           passes (default 1)
  --concurrency N      calls at once (default ${CONCURRENCY})
  --compare NAME       agreement with the stored verdicts file of that name in each review, e.g. verdicts.json
  --max-usd X          stop sending when the spend reaches X, counting rows on disk and an estimate for calls with no
                       usage; a cost that cannot be read also stops it; calls under way still finish
  --dump-prompts DIR   writes each prompt to a file and calls nothing
  --help`;

const REAL = new Set(["real", "real-minor"]);
const AGREEMENT_NEEDED = 85;

/** A grades row: where a finding is, and what the grader called it. Only the scoring reads `grade`. */
export interface Graded { repo: string; commit: string; review: string; finding: string; grade: string }

/** One replayed call, a line of the pass's file. */
export interface Row {
  repo: string; commit: string; review: string; finding: string;
  verdict: "confirmed" | "disputed" | null; reason: string; seconds: number; cost_usd: number;
  error?: string;
  depends_on?: string;
  /** The stored review never sent this finding to a second opinion. */
  never_judged?: true;
  /** Attempts cut off before the provider reported usage: cost_usd is short by those. */
  unknown_calls?: number;
}

/** What a review held when it called the second opinion. */
export interface ReviewContext {
  rdir: string;
  review: Review;
  questions: string[];
  diff: string;
  diffs: Record<string, string>;
  sources: Record<string, string>;
  /** Findings a question of the reviewer already named before any verdict: these wait, whatever the verdict. */
  waiting: Set<string>;
  head: string | null;
}

interface Built { system: string; user: string }

/** The prompts --prompt can replay. A new version is one more entry: it gets the finding and its review, no grade. */
export const PROMPTS: Record<string, (f: Finding, c: ReviewContext) => Built> = {
  // As src/challenge.ts builds it for each finding.
  current: (f, c) => {
    const p = DEFAULT_PROMPTS;
    return { system: p.challengeSystem(), user: p.challengeUser(c.diffs[f.project] ?? c.diff, f.file || "(unknown file)",
      c.sources[f.file ?? ""] ?? "", f.testId, f.message, f.explanation, c.questions) };
  },
};

export function readGrades(path: string): Graded[] {
  const [header, ...lines] = readFileSync(path, "utf8").split("\n").filter((l) => l.trim());
  const names = (header ?? "").split("\t");
  const at = (name: string) => {
    const i = names.indexOf(name);
    if (i < 0) throw new ArnxError(`${path}: no column named ${name}`);
    return i;
  };
  const [repo, commit, review, finding, grade] = ["repo", "commit", "review", "finding", "grade"].map(at) as
    [number, number, number, number, number];
  return lines.map((l) => {
    const c = l.split("\t");
    return { repo: c[repo]!, commit: c[commit]!, review: c[review]!, finding: c[finding]!, grade: c[grade]! };
  });
}

/** The change's files, as its diff names them: a rename by its new path, a deletion by its old one. */
function changedFiles(diff: string): string[] {
  const path = (line: string | undefined) => line && line !== "/dev/null" ? line.replace(/\t$/, "").replace(/^[ab]\//, "") : null;
  const files = diff.split(/^(?=diff --git )/m).filter((part) => part.startsWith("diff --git ")).map((part) =>
    path(/^\+\+\+ (.+)$/m.exec(part)?.[1]) ?? path(/^--- (.+)$/m.exec(part)?.[1]) ??
      /^diff --git a\/.+? b\/(.+)$/m.exec(part)![1]!);
  return [...new Set(files)].sort();
}

const text = (v: unknown) => typeof v === "string" ? v : JSON.stringify(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const funcOfId = (test: string) => baseName(test.split("::").at(-1) ?? "").trim();

/** Which findings a reviewer's question names before any verdict, as src/reviewer.ts links them. */
function linked(reports: { project: string; questions: unknown[] }[], findings: Finding[], maxQuestions: number): Set<string> {
  const out = new Set<string>();
  let asked = 0;
  for (const { project, questions } of reports) {
    for (const q of questions) {
      if (++asked > maxQuestions) continue;
      const tests = new Set(isObject(q) && Array.isArray(q.tests) ? q.tests.map((t) => funcOfId(text(t))) : []);
      const named = new Set((isObject(q) && typeof q.question === "string" ? q.question : text(q)).match(/\bS\d+\b/g) ?? []);
      for (const f of findings) {
        if (f.project === project && (tests.has(f.func) || (f.suspect && named.has(f.suspect)))) out.add(f.id);
      }
    }
  }
  return out;
}

/** The review's second-opinion input, sliced per project as src/reviewer.ts does it. */
export function loadContext(clone: string, reviewId: string): ReviewContext {
  const rdir = join(clone, ".arnx", "reviews", reviewId);
  const review = load(rdir);
  const diff = readFileSync(join(rdir, "change.diff"), "utf8");
  const files = changedFiles(diff);
  if (files.length !== review.filesChanged) {
    throw new ArnxError(`change.diff names ${files.length} files, the review says ${review.filesChanged}`);
  }
  const file = loadReviewFile(clone, { requireApproved: false });
  const s = existsSync(settingsPath(clone)) ? loadSettings(clone) : defaultSettings();
  // review.yaml may have gained a project since: only those the review ran had a round or a second opinion.
  const gone = review.projects.filter((name) => !file.projects.some((p) => p.name === name));
  if (gone.length) throw new ArnxError(`review.yaml no longer has ${gone.join(", ")}`);
  const ran = file.legacy ? file : { ...file, projects: file.projects.filter((p) => review.projects.includes(p.name)) };
  const routed = route(ran, files, s.maxProjects).routed;
  const diffs: Record<string, string> = {}, sources: Record<string, string> = {};
  const reports: { project: string; questions: unknown[] }[] = [];
  for (const { project: cfg, owned, used } of routed) {
    const part = file.legacy ? diff : sliceDiff(diff, [...owned, ...used]) || diff;
    const seen = new Set([...owned, ...used]);
    const others = elsewhereNote(file.legacy || part === diff ? [] : files.filter((f) => !seen.has(f)));
    diffs[cfg.name] = others ? `${part}\n\n${others}\n` : part;
    const roundFile = file.legacy ? join(rdir, "round.json") : join(rdir, "projects", cfg.name, "round.json");
    if (!existsSync(roundFile)) continue;
    const { round } = JSON.parse(readFileSync(roundFile, "utf8")) as { round: { files: Record<string, string>;
      agent: { finalText: string; earlierTexts?: string[] } } };
    Object.assign(sources, round.files);
    reports.push({ project: cfg.name, questions: parseReports([...round.agent.earlierTexts ?? [], round.agent.finalText]).questions });
  }
  return { rdir, review, questions: review.questions, diff, diffs, sources, head: headOf(rdir),
    waiting: linked(reports, review.findings, s.maxQuestions) };
}

/** The commit the review looked at, when its event log says. */
function headOf(rdir: string): string | null {
  const path = join(rdir, "events.jsonl");
  if (!existsSync(path)) return null;
  try {
    const first = JSON.parse(readFileSync(path, "utf8").split("\n", 1)[0]!) as { type?: string; data?: { head?: string } };
    return first.type === "review.started" ? first.data?.head ?? null : null;
  } catch {
    return null;
  }
}

const storedKey = (f: Finding) => `${f.project}::${f.testId}`;

function storedVerdicts(rdir: string, name: string): Record<string, { verdict?: string }> {
  const path = join(rdir, name);
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, { verdict?: string }> : {};
}

interface Ready { g: Graded; f: Finding; c: ReviewContext; prompt: Built; neverJudged: boolean }
const place = (g: Graded) => `${g.repo} ${g.commit} ${g.review} ${g.finding}`;
const rowKey = (x: { repo: string; review: string; finding: string }) => `${x.repo}/${x.review}/${x.finding}`;

/** Builds every prompt, before anything is sent. A finding that cannot be built is named, with why. */
function gather(grades: Graded[], root: string, prompt: string): { ready: Ready[]; failed: string[] } {
  const contexts = new Map<string, ReviewContext | Error>();
  const contextOf = (g: Graded) => {
    const key = `${g.repo}/${g.review}`;
    if (!contexts.has(key)) {
      try {
        contexts.set(key, loadContext(join(root, g.repo), g.review));
      } catch (e) {
        contexts.set(key, e as Error);
      }
    }
    return contexts.get(key)!;
  };
  const ready: Ready[] = [], failed: string[] = [];
  for (const g of grades) {
    const c = contextOf(g);
    const fail = (why: string) => failed.push(`cannot build ${place(g)}: ${why}`);
    if (c instanceof Error) {
      fail(c.message);
      continue;
    }
    const f = c.review.findings.find((x) => x.id === g.finding);
    if (!f) fail("the review has no such finding");
    else if (c.head && !c.head.startsWith(g.commit)) fail(`the review looked at ${c.head}`);
    else if (f.file && !(f.file in c.sources)) fail(`no test source for ${f.file}`);
    else {
      ready.push({ g, f, c, prompt: PROMPTS[prompt]!(f, c),
        neverJudged: !storedVerdicts(c.rdir, "verdicts.json")[storedKey(f)] });
    }
  }
  return { ready, failed };
}

function dump(ready: Ready[], total: number, failed: string[], dir: string, log: (l: string) => void): number {
  mkdirSync(dir, { recursive: true });
  const index = ["file\tfinding\ttest\tprompt_chars\tdiff_chars\tsource_chars\tnever_judged"];
  for (const { g, f, c, prompt, neverJudged } of ready) {
    const file = `${g.repo}-${g.commit}-${g.review}-${g.finding}.txt`;
    writeFileSync(join(dir, file), `=== system ===\n${prompt.system}\n\n=== user ===\n${prompt.user}\n`);
    index.push([file, g.finding, f.testId, prompt.user.length, (c.diffs[f.project] ?? c.diff).length,
      (c.sources[f.file ?? ""] ?? "").length, neverJudged ? "yes" : "no"].join("\t"));
  }
  writeFileSync(join(dir, "index.tsv"), index.join("\n") + "\n");
  log(`built ${ready.length} of ${total}, in ${dir}`);
  failed.forEach(log);
  return failed.length ? 2 : 0;
}

function readRows(path: string): Map<string, Row> {
  const rows = new Map<string, Row>();
  if (!existsSync(path)) return rows;
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Row;
      rows.set(rowKey(row), row); // A retry follows its error: the last line of a finding counts.
    } catch {
      // A line a stopped run left half written: that finding counts as not sent.
    }
  }
  return rows;
}

/** One line per finding. Replaced whole, so a stop in the middle leaves the old file. */
function writeRows(path: string, rows: Map<string, Row>): void {
  writeFileSync(`${path}.tmp`, [...rows.values()].map((r) => JSON.stringify(r) + "\n").join(""));
  renameSync(`${path}.tmp`, path);
}

/** What --max-usd checks. `spent` is what the rows say. A call no usage came back for reports nothing, so `estimated`
 * stands in for it; a cost that cannot be read or estimated is `unreadable`, and ends the sending under a limit. */
interface Spend { spent: number; knownCost: number; knownCalls: number; estimated: number; estimatedCalls: number;
  unreadable: number; max: number | null; notSent: number; promptCost: (chars: number) => number | null }

function addCost(spend: Spend, cost: number, unknown: number, chars: number): void {
  if (!Number.isFinite(cost)) {
    spend.unreadable++;
    return;
  }
  spend.spent += cost;
  if (!unknown) {
    if (cost > 0) [spend.knownCost, spend.knownCalls] = [spend.knownCost + cost, spend.knownCalls + 1];
    return;
  }
  const each = spend.knownCalls ? spend.knownCost / spend.knownCalls : spend.promptCost(chars);
  if (each === null) {
    spend.unreadable++;
    return;
  }
  [spend.estimated, spend.estimatedCalls] = [spend.estimated + each * unknown, spend.estimatedCalls + unknown];
}

const overLimit = (s: Spend) => s.max !== null && (s.unreadable > 0 || s.spent + s.estimated >= s.max);
const promptChars = (r: Ready) => r.prompt.system.length + r.prompt.user.length;

/** Sends what is not finished. Rows go to disk as they arrive, so a stopped run loses no paid call. */
async function runPass(ready: Ready[], model: JsonModel, path: string, concurrency: number, spend: Spend): Promise<Map<string, Row>> {
  const rows = readRows(path);
  if (existsSync(path)) writeRows(path, rows); // Drops a half-written last line before anything is added after it.
  const pending = ready.filter((r) => !rows.has(rowKey(r.g)) || rows.get(rowKey(r.g))!.error);
  const record = (r: Ready, seconds: number, cost: number, fields: Pick<Row, "verdict" | "reason" | "error" | "depends_on">, unknown = 0) => {
    const { repo, commit, review, finding } = r.g;
    const before = rows.get(rowKey(r.g));
    const unknowns = (before?.unknown_calls ?? 0) + unknown;
    const row: Row = { repo, commit, review, finding, ...fields, seconds,
      cost_usd: (Number.isFinite(before?.cost_usd) ? before!.cost_usd : 0) + cost,
      ...(r.neverJudged ? { never_judged: true as const } : {}), ...(unknowns ? { unknown_calls: unknowns } : {}) };
    rows.set(rowKey(r.g), row);
    addCost(spend, cost, unknown, promptChars(r));
    appendFileSync(path, JSON.stringify(row) + "\n");
  };
  if (pending.length) mkdirSync(dirname(path), { recursive: true });
  await inPool(pending, concurrency, async (r) => {
    if (overLimit(spend)) {
      spend.notSent++;
      return;
    }
    const t0 = performance.now();
    const secs = () => Math.round((performance.now() - t0) / 100) / 10;
    try {
      const [data, cost, , unknown] = await model.completeJson(r.prompt.system, r.prompt.user, CHALLENGE_SCHEMA);
      const { verdict } = data;
      const dep = String(data.depends_on ?? "").trim();
      const valid = /^Q\d+$/.test(dep) && Number(dep.slice(1)) <= r.c.questions.length;
      if (verdict === "confirmed" || verdict === "disputed") {
        record(r, secs(), cost, { verdict, reason: String(data.reason ?? "").trim(), ...(valid ? { depends_on: dep } : {}) }, unknown);
      } else {
        record(r, secs(), cost, { verdict: null, reason: "", error: `unexpected verdict ${JSON.stringify(verdict ?? null)}` }, unknown);
      }
    } catch (e) {
      if (!survivable(e)) throw e;
      record(r, secs(), e.costUsd, { verdict: null, reason: "", error: e.message }, e.unknownCalls);
    }
  });
  if (rows.size) writeRows(path, rows);
  return rows;
}

interface Score { answered: number; errors: number; confirmed: number; falseConfirms: number; realConfirmed: number;
  gradedRealConfirmed: number; runsFailingNoDefect: number; unjudgedWouldExit: number }

/** What a pass's verdicts come to. A run fails with no defect when arnx would exit 1 on its confirmed findings (by the
 * report's own rule, so waiting and pre-existing ones do not count) and none of them holds. A review with nothing
 * confirmed that still exits 1, because a verdict is missing, is counted apart: a failed call says nothing of the judge. */
export function scorePass(rows: Map<string, Row>, ready: Ready[]): Score {
  const score: Score = { answered: 0, errors: 0, confirmed: 0, falseConfirms: 0, realConfirmed: 0, gradedRealConfirmed: 0,
    runsFailingNoDefect: 0, unjudgedWouldExit: 0 };
  for (const { g } of ready) {
    const row = rows.get(rowKey(g));
    if (row?.error) score.errors++;
    if (row?.verdict) score.answered++;
    if (row?.verdict !== "confirmed") continue;
    score.confirmed++;
    if (!REAL.has(g.grade)) score.falseConfirms++;
    else {
      score.realConfirmed++;
      if (g.grade === "real") score.gradedRealConfirmed++;
    }
  }
  for (const c of new Set(ready.map((r) => r.c))) {
    const mine = new Map(ready.filter((r) => r.c === c).map((r) => [r.f.id, r]));
    const replayed: Review = { ...c.review, findings: c.review.findings.map((f) => {
      const r = mine.get(f.id), row = r ? rows.get(rowKey(r.g)) : undefined;
      return { ...f, verdict: row?.verdict ?? null, dependsOn: c.waiting.has(f.id) ? "linked" : row?.depends_on };
    }) as Finding[] };
    const firing = confirmed(replayed);
    if (firing.length && firing.every((f) => !REAL.has(mine.get(f.id)?.g.grade ?? ""))) score.runsFailingNoDefect++;
    if (!firing.length && notChecked(replayed).length) score.unjudgedWouldExit++;
  }
  return score;
}

/** Findings with a verdict in at least two passes, and those whose verdict was not the same in all of them. */
function changedBetween(ready: Ready[], rows: Map<string, Row>[]): { seen: Ready[]; changed: Ready[] } {
  const given = (r: Ready) => rows.flatMap((p) => p.get(rowKey(r.g))?.verdict ?? []);
  const seen = ready.filter((r) => given(r).length >= 2);
  return { seen, changed: seen.filter((r) => new Set(given(r)).size > 1) };
}

const percent = (part: number, whole: number) => `${Math.round(100 * part / whole)}%`;
const precisionOf = (s: Score) => s.confirmed ? s.realConfirmed / s.confirmed : null;

function printScores(scores: Score[], ready: Ready[], rows: Map<string, Row>[], o: { compare?: string; spend: Spend; log: (l: string) => void }) {
  const { log } = o;
  const realAll = ready.filter((r) => REAL.has(r.g.grade)).length;
  const gradedAll = ready.filter((r) => r.g.grade === "real").length;
  const runs = new Set(ready.map((r) => r.c)).size;
  scores.forEach((s, i) => {
    const precision = precisionOf(s);
    log(`pass ${i + 1}  answered ${s.answered}/${ready.length}  false_confirms ${s.falseConfirms}  ` +
      `real_confirmed ${s.realConfirmed}/${realAll}  graded_real_confirmed ${s.gradedRealConfirmed}/${gradedAll}  ` +
      `precision ${precision === null ? "-" : percent(precision, 1)}  runs_failing_no_defect ${s.runsFailingNoDefect}/${runs}  ` +
      `unjudged_would_exit ${s.unjudgedWouldExit}`);
  });
  if (!scores.length) log("no verdicts yet");
  else {
    const mean = (of: (s: Score) => number) => (scores.reduce((n, s) => n + of(s), 0) / scores.length).toFixed(1);
    const precisions = scores.map(precisionOf).filter((p) => p !== null);
    log(`mean    false_confirms ${mean((s) => s.falseConfirms)}  real_confirmed ${mean((s) => s.realConfirmed)}/${realAll}  ` +
      `graded_real_confirmed ${mean((s) => s.gradedRealConfirmed)}/${gradedAll}  precision ` +
      `${precisions.length ? percent(precisions.reduce((a, b) => a + b, 0) / precisions.length, 1) : "-"}  ` +
      `runs_failing_no_defect ${mean((s) => s.runsFailingNoDefect)}/${runs}  unjudged_would_exit ${mean((s) => s.unjudgedWouldExit)}`);
  }
  if (rows.length > 1) {
    const both = ready.filter((r) => rows.every((p) => p.get(rowKey(r.g))?.verdict));
    const same = both.filter((r) => new Set(rows.map((p) => p.get(rowKey(r.g))!.verdict)).size === 1);
    if (both.length) log(`stability ${same.length}/${both.length} (${percent(same.length, both.length)})`);
    const { seen, changed } = changedBetween(ready, rows);
    log(`changed between passes ${changed.length}/${seen.length}`);
    for (const r of changed) log(`  ${place(r.g)}: ${rows.map((p) => p.get(rowKey(r.g))?.verdict ?? "-").join(" ")}`);
  }
  const all = rows.flatMap((p) => [...p.values()]);
  if (all.length) log(`mean seconds per call ${(all.reduce((n, r) => n + r.seconds, 0) / all.length).toFixed(1)}`);
  log(`total cost $${all.reduce((n, r) => n + (Number.isFinite(r.cost_usd) ? r.cost_usd : 0), 0).toFixed(2)}`);
  const unknown = all.reduce((n, r) => n + (r.unknown_calls ?? 0), 0);
  if (unknown) log(`calls with no usage reported ${unknown}: the cost is short by those`);
  if (o.spend.unreadable) log(`calls whose cost could not be read ${o.spend.unreadable}`);
  log(`never judged ${ready.filter((r) => r.neverJudged).length} (sent and scored)`);
  const errors = all.filter((r) => r.error).length;
  if (errors) log(`errors ${errors}: run again to retry them`);
  if (o.compare) printAgreement(o.compare, ready, rows, log);
  const { spent, estimated, estimatedCalls, max, notSent, unreadable } = o.spend;
  const money = (n: number) => `$${n.toFixed(2)}`;
  if (notSent && unreadable) log(`stopped: a call's cost could not be read (--max-usd ${max}): ${notSent} not sent`);
  else if (notSent) {
    log(`stopped at ${money(spent + estimated)} (--max-usd ${max})${estimated ? `, ${money(estimated)} of it estimated` : ""}: ${notSent} not sent`);
  } else if (max !== null && estimated) {
    log(`spend for --max-usd ${money(spent + estimated)} includes ${money(estimated)} estimated for ${estimatedCalls} calls with no usage`);
  }
}

function printAgreement(name: string, ready: Ready[], rows: Map<string, Row>[], log: (l: string) => void): void {
  const stored = new Map<ReviewContext, Record<string, { verdict?: string }>>();
  const storedOf = (c: ReviewContext) => stored.get(c) ?? stored.set(c, storedVerdicts(c.rdir, name)).get(c)!;
  const judged = ready.filter((r) => storedOf(r.c)[storedKey(r.f)]?.verdict);
  let missing = 0;
  const shares: number[] = [];
  const passes = rows.map((pass, i) => {
    const compared = judged.filter((r) => pass.get(rowKey(r.g))?.verdict);
    missing += judged.length - compared.length;
    const same = compared.filter((r) => pass.get(rowKey(r.g))!.verdict === storedOf(r.c)[storedKey(r.f)]!.verdict);
    if (compared.length) shares.push(same.length / compared.length);
    return `pass ${i + 1} ${same.length}/${compared.length} (${compared.length ? percent(same.length, compared.length) : "-"})`;
  });
  if (!shares.length) {
    log(`agreement: no verdict to compare with ${name}`);
    return;
  }
  const mean = shares.reduce((a, b) => a + b, 0) / shares.length;
  log(`agreement ${passes.join(", ")}, mean ${percent(mean, 1)}` +
    `${mean * 100 < AGREEMENT_NEEDED ? `, below ${AGREEMENT_NEEDED}%` : ""}${missing ? `, ${missing} without a verdict` : ""}`);
  if (rows.length > 1) {
    const { seen, changed } = changedBetween(judged, rows);
    log(`of the judged, changed between passes ${changed.length}/${seen.length}`);
  }
}

/** A prompt's cost at the model's price, from its size (about 4 characters to the token), the reply left out. Null when
 * the model has no price. */
function promptCostOf(ref: string, env: Env): (chars: number) => number | null {
  try {
    const { model } = parseModelRef(ref, KNOWN_TABLES);
    const s = defaultSettings(env), prices = allPrices(s);
    const tiered = `${model}@${s.openaiTier}`;
    const name = s.openaiTier && prices[tiered] ? tiered : model;
    return (chars) => costUsd(name, { input: chars / 4, output: 0, cacheRead: 0, cacheWrite: 0 }, prices);
  } catch {
    return () => null;
  }
}

/** The model, through arnx's own factory: shipped timeouts and prices, the named model alone. */
export function defaultModel(ref: string, env: Env): JsonModel {
  const { challengerFallback: _none, ...s } = defaultSettings(env);
  const settings = { ...s, providers: KNOWN_TABLES, challenger: parseModelRef(ref, KNOWN_TABLES) };
  const unpriced = unpricedModels(settings, [settings.challenger]);
  if (unpriced.length) throw new ArnxError(`no price for ${unpriced[0]!.name}: its cost and --max-usd would be wrong`);
  return makeChallenger(settings, env, new Boundary());
}

const positive = (name: string, v: string | undefined, fallback: number): number => {
  const n = v === undefined ? fallback : Number(v);
  if (!Number.isInteger(n) || n < 1) throw new ArnxError(`${name} needs a whole number from 1 up`);
  return n;
};

export interface Deps { env: Env; makeModel: (ref: string, env: Env) => JsonModel; log: (line: string) => void }

export async function main(argv: string[], deps: Deps = { env: process.env, makeModel: defaultModel, log: console.log }): Promise<number> {
  const { log } = deps;
  try {
    let values;
    try {
      ({ values } = parseArgs({ args: argv, strict: true, options: {
        grades: { type: "string" }, root: { type: "string" }, model: { type: "string" }, out: { type: "string" },
        prompt: { type: "string" }, repeat: { type: "string" }, concurrency: { type: "string" },
        compare: { type: "string" }, "max-usd": { type: "string" }, "dump-prompts": { type: "string" },
        help: { type: "boolean" } } }));
    } catch (e) {
      throw new ArnxError(`${(e as Error).message}\n${USAGE}`);
    }
    if (values.help) {
      log(USAGE);
      return 0;
    }
    const prompt = values.prompt ?? "current";
    if (!Object.hasOwn(PROMPTS, prompt)) throw new ArnxError(`unknown prompt: ${prompt} (have: ${Object.keys(PROMPTS).join(", ")})`);
    if (!values.grades || !values.root) throw new ArnxError(`--grades and --root are needed\n${USAGE}`);
    const dumpDir = values["dump-prompts"];
    if (!dumpDir && (!values.model || !values.out)) throw new ArnxError(`--model and --out are needed\n${USAGE}`);
    const repeat = positive("--repeat", values.repeat, 1);
    const concurrency = positive("--concurrency", values.concurrency, CONCURRENCY);
    const max = values["max-usd"] === undefined ? null : Number(values["max-usd"]);
    if (max !== null && !(max >= 0)) throw new ArnxError("--max-usd needs a number from 0 up");

    const grades = readGrades(values.grades);
    const { ready, failed } = gather(grades, values.root, prompt);
    if (dumpDir) return dump(ready, grades.length, failed, dumpDir, log);
    if (failed.length) {
      failed.forEach(log);
      log(`nothing sent: built ${ready.length} of ${grades.length}`);
      return 2;
    }
    // What a prompt holds of the change's values, each review's own, never leaves; main does not read the clones' trees.
    const boundary = new Boundary();
    for (const c of new Set(ready.map((r) => r.c))) boundary.addDiff(c.diff);
    const model = maskedJson(deps.makeModel(values.model!, deps.env), boundary);
    const label = values.model!.replace(/[^\w.-]+/g, "_");
    const paths = Array.from({ length: repeat }, (_, i) => join(values.out!, `${label}-${prompt}-${i + 1}.jsonl`));
    const spend: Spend = { spent: 0, knownCost: 0, knownCalls: 0, estimated: 0, estimatedCalls: 0, unreadable: 0, max, notSent: 0,
      promptCost: promptCostOf(model.ref, deps.env) };
    const onDisk = paths.flatMap((p) => [...readRows(p).values()]);
    const byKey = new Map(ready.map((r) => [rowKey(r.g), r]));
    // Known costs first: they give the mean an estimate needs.
    for (const r of onDisk.filter((x) => !x.unknown_calls)) addCost(spend, r.cost_usd, 0, 0);
    for (const r of onDisk.filter((x) => x.unknown_calls)) {
      const from = byKey.get(rowKey(r));
      addCost(spend, r.cost_usd, r.unknown_calls!, from ? promptChars(from) : 0);
    }
    const rows: Map<string, Row>[] = [];
    for (const path of paths) {
      const pass = await runPass(ready, model, path, concurrency, spend);
      if (pass.size) rows.push(pass);
    }
    printScores(rows.map((r) => scorePass(r, ready)), ready, rows, { ...(values.compare ? { compare: values.compare } : {}), spend, log });
    return 0;
  } catch (e) {
    if (!(e instanceof ArnxError)) throw e;
    log(e.message);
    return e.exitCode;
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
