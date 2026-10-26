// Tool-use loop. The model sees only the snapshot: it can list, read and search it, write test files under one
// directory, and run the configured test command on those files. No shell. Spend is counted per call and the loop
// stops before a call once the budget is spent (it can overshoot by at most one call).
import { spend } from "./spend";
import { appendFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync,
  writeFileSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve, sep } from "node:path";
import { Worker } from "node:worker_threads";
import { python } from "./adapters/python";
import type { Adapter } from "./adapters/types";
import { ModelError } from "./errors";
import { clip, emitModelCall, emitTurn } from "./events";
import { recordCall } from "./outage";
import { type AgentModel, addUsage, type Block, costUsd, type Message, NO_USAGE, type Tool, type Usage } from "./llm";
import { isSecretPath } from "./secrets";
import type { Prices } from "./settings";
import { splitLines } from "./util";

export const READ_LIMIT = 400;
export const GREP_LIMIT = 100;
export const GREP_PATTERN_LIMIT = 500;
export const GREP_FILE_LIMIT = 2_000_000;
/** Matching time one grep may take; mutable so tests can lower it. */
export const grepLimits = { ms: 2000 };
/** Text sent to grep's worker at once: the files read so far, matched in one message. */
export const GREP_BATCH_BYTES = 1_000_000;
/** Longer lines are left out of a regex grep (minified or generated code, where a slow pattern backtracks longest). */
export const GREP_LINE_LIMIT = 10_000;
/** What a batch may take beyond the matching time left: its transfer and the worker's start. */
const BATCH_SLACK_MS = 1000;
export const WRITE_LIMIT = 200_000;
export const MAX_TOKENS = 16_000;
export const SKIP_DIRS = new Set([".git", "node_modules", "__pycache__", ".venv", "venv", ".arnx-run", ".mypy_cache",
  ".pytest_cache"]);

/** A tool call the model got wrong; the message goes back to the model. */
export class ToolError extends Error {
  override name = "ToolError";
}

const SIMPLER = "simplify it, e.g. no nested or stacked quantifiers like (a+)+ or a*a*a*";
const tooSlow = (after = "") => new ToolError(`pattern too slow${after}: ${SIMPLER}`);

// Characters two atoms are tried on: they overlap when one of these matches both.
const PROBES = [..." \t", ...Array.from({ length: 95 }, (_, i) => String.fromCharCode(32 + i))];

const probe = (atom: string) => {
  try {
    const rx = new RegExp(`^(?:${atom})$`);
    return PROBES.filter((c) => rx.test(c));
  } catch {
    return null;
  }
};

/** Whether two quantified atoms (`a`, `\w`, `.`, `[a-z]`) can match the same character. */
function overlap(a: string, b: string): boolean {
  if (a === b || a === "." || b === ".") return true;
  const [x, y] = [probe(a), probe(b)];
  return !!x && !!y && x.some((c) => y.includes(c));
}

/** Whether atom `b` matches every character `a` does. */
function covers(b: string, a: string): boolean {
  if (a === b || b === ".") return true;
  const [x, y] = [probe(a), probe(b)];
  return !!x && !!y && x.every((c) => y.includes(c));
}

/** The usual shapes of a pattern that backtracks without end, found without running it: a repeated group holding a
 * quantifier ((a+)+, (\w+\s?)*), or unbounded quantifiers in a row on atoms that overlap: three or more (a*a*a*), or
 * two where the second does not take every character the first does (\w+\d*; \w+.* and a*a* are linear in
 * practice). Others are left to the worker's time limit. */
export function backtracks(pattern: string): boolean {
  // Per open group: whether it holds a quantifier, the last atom quantified without bound (null after any other) and
  // how many such atoms in a row ending there overlap.
  const frames: { quantified: boolean; prev: string | null; run: number }[] = [{ quantified: false, prev: null, run: 0 }];
  let atom: { text: string; group: boolean; quantified: boolean } | null = null;
  for (let i = 0; i < pattern.length; i++) {
    const frame = frames.at(-1)!;
    const c = pattern[i]!;
    const q = /^(?:[*+?]|\{(\d+)(,(\d*))?\})/.exec(pattern.slice(i));
    if (q && atom) {
      i += q[0].length - 1;
      if (pattern[i + 1] === "?") i++; // lazy
      const unbounded = q[0] === "*" || q[0] === "+" || (q[2] !== undefined && q[3] === "");
      const repeats = q[0] !== "?" && !(q[1] !== undefined && q[2] === undefined) && q[3] !== "1" && q[3] !== "0";
      if (repeats && atom.group && atom.quantified) return true;
      const next = unbounded && !atom.group ? atom.text : null;
      if (next !== null && frame.prev !== null && overlap(frame.prev, next)) {
        if (++frame.run >= 3 || !covers(next, frame.prev)) return true;
      } else {
        frame.run = next === null ? 0 : 1;
      }
      if (q[1] === undefined || q[2] !== undefined) frame.quantified = true;
      frame.prev = next;
      atom = null;
      continue;
    }
    if (atom) frame.prev = null; // the last atom went unquantified
    atom = null;
    if (c === "\\") {
      const text = pattern.slice(i, i + 2);
      i++;
      // \b and \B match no character; a back reference is no atom to compare
      if (!/^\\[bB1-9]$/.test(text)) atom = { text, group: false, quantified: false };
    } else if (c === "[") {
      let j = i + 1;
      if (pattern[j] === "^") j++;
      if (pattern[j] === "]") j++;
      while (j < pattern.length && pattern[j] !== "]") j += pattern[j] === "\\" ? 2 : 1;
      atom = { text: pattern.slice(i, j + 1), group: false, quantified: false };
      i = j;
    } else if (c === "(") {
      const prefix = /^\((?:\?(?:[:=!]|<[=!]|<[A-Za-z_$][\w$]*>))?/.exec(pattern.slice(i))![0];
      i += prefix.length - 1;
      frames.push({ quantified: false, prev: null, run: 0 });
    } else if (c === ")" && frames.length > 1) {
      const inner = frames.pop()!;
      frames.at(-1)!.quantified ||= inner.quantified;
      atom = { text: "", group: true, quantified: inner.quantified };
    } else if (c === "|") {
      frame.prev = null;
    } else if (c !== "^" && c !== "$") {
      atom = { text: c === "." ? "." : c.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&"), group: false, quantified: false };
    }
  }
  return false;
}

// The model's pattern runs in a worker thread: a pattern that backtracks without end (a*a*a*b on a long line) would
// otherwise hang arnx, and a match cannot be stopped from inside the thread running it. The limit counts only the
// worker's matching time (walking and reading the files never count); a batch that runs past what is left is stopped
// and the worker terminated (Bun may leave it running until arnx exits; it no longer blocks anything).
const MATCH_WORKER = `const { parentPort } = require("node:worker_threads");
let rx = null;
parentPort.on("message", (m) => {
  if (m.pattern !== undefined) { rx = new RegExp(m.pattern); return; }
  const started = Date.now();
  const found = [];
  let skipped = 0;
  for (let f = 0; f < m.files.length && found.length < m.max; f++) {
    const lines = m.files[f];
    for (let i = 0; i < lines.length && found.length < m.max; i++) {
      if (lines[i].length > m.lineLimit) skipped++;
      else if (rx.test(lines[i])) found.push([f, i]);
    }
  }
  parentPort.postMessage({ found, skipped, ms: Date.now() - started });
});`;

/** Matches batches of files against one grep's pattern until its matching time runs out. A plain literal is searched
 * here with indexOf (linear, every line); a regex in the worker, lines over GREP_LINE_LIMIT left out. */
class Matcher {
  private worker: Worker | null = null;
  private used = 0;
  /** Lines left out as too long. */
  skipped = 0;
  private readonly literal: boolean;

  constructor(private readonly pattern: string) {
    this.literal = !/[\\^$.|?*+()[\]{}]/.test(pattern);
  }

  /** Up to `max` matching lines as [file, line] indexes into `files`; a ToolError once the matching time runs out. */
  match(files: string[][], max: number): Promise<[number, number][]> {
    if (this.literal) {
      const found: [number, number][] = [];
      for (let f = 0; f < files.length && found.length < max; f++) {
        const lines = files[f]!;
        for (let i = 0; i < lines.length && found.length < max; i++) if (lines[i]!.includes(this.pattern)) found.push([f, i]);
      }
      return Promise.resolve(found);
    }
    const left = grepLimits.ms - this.used;
    if (left <= 0) return Promise.reject(this.slow());
    if (!this.worker) {
      this.worker = new Worker(MATCH_WORKER, { eval: true });
      this.worker.unref();
      this.worker.postMessage({ pattern: this.pattern });
    }
    const worker = this.worker;
    return new Promise((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
      };
      const onMessage = (m: { found: [number, number][]; skipped: number; ms: number }) => {
        done();
        this.used += m.ms;
        this.skipped += m.skipped;
        if (this.used > grepLimits.ms) {
          this.close();
          reject(this.slow());
        } else {
          resolve(m.found);
        }
      };
      const onError = (e: Error) => { done(); this.close(); reject(e); };
      const timer = setTimeout(() => { done(); this.close(); reject(this.slow()); }, left + BATCH_SLACK_MS);
      worker.on("message", onMessage);
      worker.on("error", onError);
      worker.postMessage({ files, max, lineLimit: GREP_LINE_LIMIT });
    });
  }

  close(): void {
    const worker = this.worker;
    this.worker = null;
    worker?.terminate().catch(() => {});
  }

  private slow(): ToolError {
    return tooSlow(` (over ${grepLimits.ms / 1000} s)`);
  }
}

/** An error result already worded where the tool ran (a remote CLI's `ToolError: ...`): the model gets its message
 * exactly as given, with no name put in front, so it reads what it would have read had the tool run here. */
export class RawToolError extends ToolError {
  override name = "RawToolError";
}

/** A tool's answer that ends the round where it is (stop "stopped", the message as the final text): nothing the model
 * could do next would help. A brain that runs the tools from afar gets the message as the tool's error. */
export class StopRound extends RawToolError {
  override name = "StopRound";
}

/** The text an error result shows the model: `Name: message`, or a RawToolError's message as it is. */
export function toolErrorText(e: unknown): string {
  if (e instanceof RawToolError) return e.message;
  const err = e instanceof Error ? e : new Error(String(e));
  return `${err.name}: ${err.message}`;
}

/** usage and calls: the tokens of every reply the model sent (each one billed), for the cost breakdown. unknownCalls:
 * attempts cut off before a reply and a failed call's billed attempts, whose usage never came (absent when none). */
export interface AgentResult { finalText: string; costUsd: number; turns: number; stop: string; usage: Usage;
  calls: number; unknownCalls?: number;
  /** Final replies before a follow-up message continued the conversation, oldest first. */
  earlierTexts?: string[] }
export type ToolFn = (args: Record<string, unknown>) => string | Promise<string>;

const schema = (props: Record<string, unknown>, required: string[]) =>
  ({ type: "object", properties: props, required, additionalProperties: false });

const READ_TOOLS: Tool[] = [
  { name: "list_dir", description: "List a directory (path relative to the repository root).",
    input_schema: schema({ path: { type: "string" } }, ["path"]) },
  { name: "read_file", description: `Read a text file with line numbers, up to ${READ_LIMIT} lines per call; use ` +
      "start_line to page.",
    input_schema: schema({ path: { type: "string" }, start_line: { type: "integer" } }, ["path"]) },
  { name: "grep", description: "Search files under a directory for a regular expression (JavaScript syntax). " +
      `Returns up to ${GREP_LIMIT} matches as path:line: text.`,
    input_schema: schema({ pattern: { type: "string" }, path: { type: "string" } }, ["pattern"]) },
];

function str(args: Record<string, unknown>, key: string, fallback?: string): string {
  const v = args[key] ?? fallback;
  if (typeof v !== "string") throw new ToolError(`${key}: a string is required`);
  return v;
}

/** Path.resolve(strict=False): resolve symlinks as far as the path exists, then append the rest. */
function resolveLoose(p: string): string {
  let existing = resolve(p);
  const rest: string[] = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  return join(realpathSync(existing), ...rest);
}

const isBinary = (data: Buffer) => data.subarray(0, 8000).includes(0);
const compareParts = (a: string, b: string) => {
  const pa = a.split("/"), pb = b.split("/");
  for (let i = 0; i < Math.min(pa.length, pb.length); i++) if (pa[i] !== pb[i]) return pa[i]! < pb[i]! ? -1 : 1;
  return pa.length - pb.length;
};

export class Workspace {
  readonly root: string;
  readonly writeDir: string | null;
  private runTestsFn?: (targets: string[]) => string | Promise<string>;
  private extra: Record<string, [Tool, ToolFn]>;
  private adapter: Adapter;
  private runner: string;

  constructor(root: string, opts: { writeDir?: string | null; runTests?: (targets: string[]) => string | Promise<string>;
                                    extra?: Record<string, [Tool, ToolFn]>; adapter?: Adapter; runner?: string } = {}) {
    this.root = realpathSync(root);
    this.writeDir = opts.writeDir ? opts.writeDir.replace(/^\/+|\/+$/g, "") : null;
    this.runTestsFn = opts.runTests;
    this.extra = opts.extra ?? {};
    this.adapter = opts.adapter ?? python;
    this.runner = opts.runner ?? this.adapter.defaultRunner;
  }

  tools(): Tool[] {
    const tools = [...READ_TOOLS];
    const { runner, writableFiles } = this.adapter.words(this.runner);
    if (this.writeDir) {
      tools.push({ name: "write_file",
        description: `Create or overwrite a ${runner} file under ${this.writeDir}/ (${writableFiles}).`,
        input_schema: schema({ path: { type: "string" }, content: { type: "string" } }, ["path", "content"]) });
    }
    if (this.writeDir && this.runTestsFn) {
      tools.push({ name: "run_tests",
        description: `Run the tests under ${this.writeDir}/ (or the given files) in the sandbox. Returns the end of ` +
          "the output.",
        input_schema: schema({ targets: { type: "array", items: { type: "string" } } }, []) });
    }
    return [...tools, ...Object.values(this.extra).map(([t]) => t)];
  }

  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const extra = this.extra[name];
    if (extra) return extra[1](args);
    if (!this.tools().some((t) => t.name === name)) throw new ToolError(`unknown tool ${name}`);
    switch (name) {
      case "list_dir": return this.listDir(str(args, "path"));
      case "read_file": return this.readFile(str(args, "path"), args.start_line);
      case "grep": return this.grep(str(args, "pattern"), str(args, "path", "."));
      case "write_file": return this.writeFile(str(args, "path"), str(args, "content"));
      default: return this.runTests(args.targets);
    }
  }

  private resolvePath(path: string): string {
    const rel = path.trim().replace(/^\/+/, "") || ".";
    const full = resolveLoose(join(this.root, rel));
    if (full !== this.root && !full.startsWith(this.root + sep)) throw new ToolError(`path outside the repository: ${path}`);
    if (relative(this.root, full).split(sep).includes(".git") || isSecretPath(basename(full))) {
      throw new ToolError(`not available: ${path}`);
    }
    return full;
  }

  private rel(full: string): string {
    return relative(this.root, full).split(sep).join("/");
  }

  private listDir(path: string): string {
    const full = this.resolvePath(path);
    if (!existsSync(full) || !statSync(full).isDirectory()) throw new ToolError(`not a directory: ${path}`);
    const entries = readdirSync(full).filter((n) => !SKIP_DIRS.has(n) && !isSecretPath(n)).sort();
    return entries.map((n) => {
      let dir = false;
      try {
        dir = statSync(join(full, n)).isDirectory();
      } catch {
        // a dangling link lists as a file
      }
      return n + (dir ? "/" : "");
    }).join("\n") || "(empty)";
  }

  private readFile(path: string, startLine: unknown): string {
    const full = this.resolvePath(path);
    if (!existsSync(full) || !statSync(full).isFile()) throw new ToolError(`not a file: ${path}`);
    const data = readFileSync(full);
    if (isBinary(data)) return `(binary file, ${data.length} bytes)`;
    const lines = splitLines(data.toString("utf8"));
    const n = startLine === undefined || startLine === null || startLine === 0 ? 1 : Number(startLine);
    if (!Number.isFinite(n)) throw new ToolError("start_line: a number is required");
    const start = Math.max(1, Math.trunc(n));
    const chunk = lines.slice(start - 1, start - 1 + READ_LIMIT);
    const body = chunk.map((line, i) => `${start + i}\t${line}`).join("\n");
    const more = lines.length - (start - 1 + chunk.length);
    return body + (more > 0 ? `\n... ${more} more lines (start_line=${start + chunk.length})` : "");
  }

  private async grep(pattern: string, path: string): Promise<string> {
    if (pattern.length > GREP_PATTERN_LIMIT) {
      throw new ToolError(`pattern too long (over ${GREP_PATTERN_LIMIT} characters)`);
    }
    try {
      new RegExp(pattern);
    } catch (e) {
      throw new ToolError(`invalid pattern: ${(e as Error).message}`);
    }
    // Refused before any worker starts: under Bun a terminated worker keeps its core busy until arnx exits.
    if (backtracks(pattern)) throw tooSlow();
    const matcher = new Matcher(pattern);
    try {
      return await this.grepFiles(matcher, path);
    } finally {
      matcher.close();
    }
  }

  private async grepFiles(matcher: Matcher, path: string): Promise<string> {
    const hits: string[] = [];
    // Files go to the worker in batches, in walk order; true once the hits are full.
    let batch: { fp: string; lines: string[] }[] = [];
    let size = 0;
    const flush = async () => {
      const found = batch.length ? await matcher.match(batch.map((b) => b.lines), GREP_LIMIT - hits.length) : [];
      for (const [f, i] of found) {
        const { fp, lines } = batch[f]!;
        hits.push(`${this.rel(fp)}:${i + 1}: ${lines[i]!.trimEnd().slice(0, 200)}`);
      }
      batch = [];
      size = 0;
      return hits.length >= GREP_LIMIT;
    };
    // A grep stopped by its time limit keeps what it found, then says why it stopped.
    const send = async () => {
      try {
        return await flush();
      } catch (e) {
        if (!(e instanceof ToolError) || !hits.length) throw e;
        stopped = e.message;
        return true;
      }
    };
    let stopped = "";
    const skipped = () => matcher.skipped ? [`${matcher.skipped} line${matcher.skipped === 1 ? "" : "s"} over ` +
      `${String(GREP_LINE_LIMIT).replace(/\B(?=(\d{3})+$)/g, ",")} characters skipped (minified or generated)`] : [];
    const end = () => [hits.join("\n") || "(no matches)",
      ...stopped ? [`... stopped: ${stopped}`] : hits.length >= GREP_LIMIT ? [`... (truncated at ${GREP_LIMIT} matches)`] : [],
      ...skipped()].join("\n");
    for (const fp of this.walk(this.resolvePath(path))) {
      let data: Buffer;
      try {
        if (statSync(fp).size > GREP_FILE_LIMIT) continue;
        data = readFileSync(fp);
      } catch {
        continue;
      }
      if (isBinary(data)) continue;
      batch.push({ fp, lines: splitLines(data.toString("utf8")) });
      size += data.length;
      if (size >= GREP_BATCH_BYTES && await send()) return end();
    }
    await send();
    return end();
  }

  private walk(base: string): string[] {
    if (existsSync(base) && statSync(base).isFile()) return [base];
    const out: string[] = [];
    const visit = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = lstatSync(p);
        if (SKIP_DIRS.has(name)) continue;
        if (st.isDirectory()) visit(p);
        else if (!isSecretPath(name) && (st.isFile() || (st.isSymbolicLink() && existsSync(p) && statSync(p).isFile()))) {
          out.push(p);
        }
      }
    };
    if (existsSync(base)) visit(base);
    return out.sort((a, b) => compareParts(this.rel(a), this.rel(b)));
  }

  private inWriteDir(full: string): boolean {
    const base = resolveLoose(join(this.root, this.writeDir!));
    return full === base || full.startsWith(base + sep);
  }

  private writeFile(path: string, content: string): string {
    const full = this.resolvePath(path);
    if (!this.inWriteDir(full) || !this.adapter.writable.test(basename(full))) {
      throw new ToolError(`writes are allowed only for ${this.adapter.words(this.runner).writableFiles} under ` +
        `${this.writeDir}/`);
    }
    if (content.length > WRITE_LIMIT) throw new ToolError("file too large");
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
    return `wrote ${this.rel(full)} (${content.length} bytes)`;
  }

  private async runTests(targets: unknown): Promise<string> {
    // Models sometimes send the list as a JSON string, or one path as a plain string.
    if (typeof targets === "string") {
      try {
        targets = targets.trim().startsWith("[") ? JSON.parse(targets) : [targets];
      } catch {
        targets = [targets];
      }
    }
    if (targets !== undefined && targets !== null &&
        (!Array.isArray(targets) || !targets.every((t) => typeof t === "string"))) {
      throw new ToolError("targets: a list of paths is required");
    }
    const paths = (targets as string[] | undefined)?.length ? targets as string[] : [this.writeDir!];
    for (const t of paths) {
      if (!this.inWriteDir(this.resolvePath(t))) throw new ToolError(`run_tests runs only files under ${this.writeDir}/`);
    }
    return this.runTestsFn!(paths.map((t) => posix.normalize(t.trim().replace(/^\/+/, "")).replace(/\/+$/, "")));
  }
}

const short = (value: unknown) => {
  const s = typeof value === "string" ? value : JSON.stringify(value);
  return s.length < 2000 ? s : s.slice(0, 2000) + "...";
};
const tried = (n: number | undefined) => n === undefined ? {} : { attempts: n };
// Where the model looked, for evaluations' localization checks: the path argument of each read tool call, never contents.
const READ_PATH_TOOLS = new Set(["read_file", "list_dir", "grep"]);
const pathsOf = (uses: Block[]) => uses.filter((b) => READ_PATH_TOOLS.has(b.name ?? "")).flatMap((b) => {
  const p = b.input?.path;
  return typeof p === "string" ? [clip(p, 300)] : p === undefined && b.name === "grep" ? ["."] : [];
});
const round4 = (x: number) => Math.round(x * 10_000) / 10_000;

/** A tool call as the model asked for it. */
export interface ToolCall { id: string; name: string; input: Record<string, unknown> }

/** `ws`: the tools on offer and how one call runs (a Workspace, or a brain's view of the CLI's). `transcript`: the
 * file each turn is logged to; without it nothing is written. */
export async function runAgent(model: AgentModel, ws: Pick<Workspace, "tools" | "call">, o: { system: string;
  user: string; budgetUsd: number; prices: Prices; transcript?: string; maxTurns?: number;
  onTurn?: (turn: number, tools: string[], costUsd: number, text: string, calls: ToolCall[]) => void;
  onTool?: (name: string, input: Record<string, unknown>) => void;
  /** Called when the model ends its turn: a message continues the conversation (within budget), null ends it. */
  followUp?: (finalText: string) => string | null | Promise<string | null>;
  /** Each reply that ends a turn, before followUp is asked (it is not asked once the budget is spent). */
  onFinal?: (finalText: string, turn: number) => void }): Promise<AgentResult> {
  const tools = ws.tools();
  const messages: Message[] = [{ role: "user", content: o.user }];
  let cost = 0, stop = "max_turns", final = "", turn = 0, usage = NO_USAGE, calls = 0, unknown = 0;
  const earlier: string[] = [];
  const transcript = o.transcript;
  const log = (line: Record<string, unknown>) => {
    if (transcript) appendFileSync(transcript, JSON.stringify(line) + "\n");
  };
  if (transcript) mkdirSync(dirname(transcript), { recursive: true });
  for (turn = 1; turn <= (o.maxTurns ?? 60); turn++) {
    if (cost >= o.budgetUsd) {
      stop = "budget";
      break;
    }
    const started = performance.now();
    let reply, latency = 0;
    try {
      reply = await model.create({ system: o.system, tools, messages, maxTokens: MAX_TOKENS });
      latency = Math.round(performance.now() - started);
    } catch (e) {
      if (!(e instanceof ModelError)) throw e;
      stop = `api_error: ${e.message}`;
      unknown += e.unknownCalls;
      // What the failed call was billed (a reply cut short, a retry after a partial one) is spent all the same.
      cost += e.costUsd || 0;
      spend.add(e.costUsd || 0);
      if (e.usage) usage = addUsage(usage, e.usage);
      recordCall({ provider: model.provider ?? "unknown", ok: false, ...(e.fault ? { fault: e.fault } : {}),
        ...(tried(e.attempts?.length ?? e.tries)) });
      emitModelCall({ provider: model.provider ?? "unknown", model: model.model, ok: false, error: clip(e.message, 300),
        ...(e.fault ? { fault: e.fault.kind } : {}), input: 0, output: 0, cache_read: 0, cache_write: 0, cost_usd: e.costUsd || 0,
        latency_ms: Math.round(performance.now() - started), ...(tried(e.attempts?.length ?? e.tries)),
        unknown_usage: e.unknownCalls, timed_out: e.timedOut, turn });
      log({ turn, stop_reason: "api_error", error: e.message, timed_out: e.timedOut, attempts: e.attempts,
        secs: Math.round((performance.now() - started) / 100) / 10 });
      break;
    }
    const replyCost = costUsd(model.model, reply.usage, o.prices);
    cost += replyCost;
    spend.add(replyCost);
    usage = addUsage(usage, reply.usage);
    calls += 1;
    unknown += reply.unknownCalls ?? 0;
    recordCall({ provider: model.provider ?? "unknown", ok: true });
    emitModelCall({ provider: model.provider ?? "unknown", model: model.model, ok: true, input: reply.usage.input,
      output: reply.usage.output, cache_read: reply.usage.cacheRead, cache_write: reply.usage.cacheWrite,
      cost_usd: replyCost, latency_ms: latency, ...(tried(reply.attempts?.length ?? reply.tries)),
      unknown_usage: reply.unknownCalls ?? 0, timed_out: false, turn });
    const text = reply.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
    const uses = reply.content.filter((b) => b.type === "tool_use");
    // secs is the model's reply alone (all its attempts); the tools it asked for are timed on the line after.
    const attempts = reply.attempts && (reply.attempts.length > 1 || reply.attempts[0]?.outcome !== "ok")
      ? { attempts: reply.attempts.map((a) => ({ secs: a.secs, first_event_secs: a.firstEventSecs,
        longest_gap_secs: a.longestGapSecs, events: a.events, outcome: a.outcome, chunks: a.chunks,
        first_byte_secs: a.firstByteSecs, timeout: a.timeout, error: a.error })) }
      : reply.attempts?.length ? { first_event_secs: reply.attempts[0]!.firstEventSecs,
        longest_gap_secs: reply.attempts[0]!.longestGapSecs } : {};
    log({ turn, stop_reason: reply.stopReason, secs: Math.round((performance.now() - started) / 100) / 10, ...attempts,
      cost_usd: round4(cost), text, tools: uses.map((b) => ({ name: b.name,
        input: Object.fromEntries(Object.entries(b.input ?? {}).map(([k, v]) => [k, short(v)])) })) });
    o.onTurn?.(turn, [...new Set(uses.map((b) => b.name ?? ""))], cost, text,
      uses.map((b) => ({ id: b.id ?? "", name: b.name ?? "", input: { ...(b.input ?? {}) } })));
    // No tools run on a refusal, whatever the reply asked for.
    if (reply.stopReason === "refusal" || !uses.length) {
      emitTurn({ turn, stop_reason: reply.stopReason, tools: [], paths: [], tool_errors: 0, writes: 0, test_runs: 0 });
    }
    if (reply.stopReason === "refusal") {
      stop = "refusal";
      break;
    }
    messages.push({ role: "assistant", content: reply.raw });
    if (!uses.length) {
      if (reply.stopReason === "max_tokens") {
        messages.push({ role: "user", content: "Your reply was cut off. Continue." });
        continue;
      }
      [final, stop] = [text, "end_turn"];
      o.onFinal?.(text, turn);
      const next = cost < o.budgetUsd ? await o.followUp?.(text) ?? null : null;
      if (next === null) break;
      earlier.push(text);
      messages.push({ role: "user", content: next });
      stop = "max_turns";
      continue;
    }
    const results: Record<string, unknown>[] = [];
    // How long each tool took and how much it returned (never what), so tool time is told apart from model time.
    const timed: Record<string, unknown>[] = [];
    let halted: string | null = null;
    for (const b of uses) {
      const t0 = performance.now();
      let content: string, error = false;
      try {
        o.onTool?.(b.name ?? "", { ...(b.input ?? {}) });
        content = (await ws.call(b.name ?? "", { ...(b.input ?? {}) })) || "(empty)";
        results.push({ type: "tool_result", tool_use_id: b.id, content });
      } catch (e) { // a tool error goes back to the model; it never ends the run, unless the tool stops the round
        content = toolErrorText(e);
        error = true;
        results.push({ type: "tool_result", tool_use_id: b.id, is_error: true, content });
        if (e instanceof StopRound) halted = e.message;
      }
      timed.push({ name: b.name, ms: Math.round(performance.now() - t0), bytes: Buffer.byteLength(content),
        ...(error ? { error: true } : {}) });
      if (halted !== null) break;
    }
    log({ turn, tools_ran: timed });
    emitTurn({ turn, stop_reason: reply.stopReason, tools: uses.map((b) => b.name ?? ""), paths: pathsOf(uses),
      tool_errors: timed.filter((t) => t.error).length, writes: uses.filter((b) => b.name === "write_file").length,
      test_runs: uses.filter((b) => b.name === "run_tests").length });
    if (halted !== null) {
      [final, stop] = [halted, "stopped"];
      break;
    }
    messages.push({ role: "user", content: results });
  }
  // A follow-up is extra work after a finished round: when it is cut short (budget, turns, an API error), the round
  // still ended normally, with the reply it ended on.
  if (stop !== "end_turn" && stop !== "stopped" && earlier.length) {
    final = earlier.pop()!;
    stop = "end_turn";
  }
  return { finalText: final, costUsd: round4(cost), turns: Math.min(turn, o.maxTurns ?? 60), stop, usage, calls,
    ...(unknown ? { unknownCalls: unknown } : {}), ...(earlier.length ? { earlierTexts: earlier } : {}) };
}
