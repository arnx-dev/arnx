// Setup's exec tool: one command in a project's test environment, run as its tests run (the test user, no internet,
// its services reachable, the same limits), so the agent can look around (versions, files, one test) without paying
// for a whole try_project. It runs in the image the project's last try_project built and builds none; nothing it does
// is kept: /src is reset to the snapshot before each command, and the container goes at the end of setup.
import { copyFileSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, type Stats, symlinkSync,
  writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ReviewConfig } from "./config";
import { ArnxError } from "./errors";
import { emit } from "./events";
import type { Tool } from "./llm";
import type { Say } from "./progress";
import { type ExecFactory, type ExecRunner, REPORT_DIR, type RunResult } from "./sandbox";
import { randomHex, shQuote } from "./util";

/** Seconds a command gets unless it asks for more, and the most it may ask for. */
export const EXEC_TIMEOUT = 120;
export const EXEC_MAX_TIMEOUT = 900;
/** Commands per setup, and seconds of them: past either, exec refuses and try_project still works. */
export const EXEC_CALLS = 80;
export const EXEC_SECONDS = 3600;
/** The output the agent gets: its start and its end. */
const HEAD = 2000;
const TAIL = 10_000;

export const EXEC: Tool = {
  name: "exec",
  description: "Run one shell command in a project's test environment, as its tests run: the test user, no " +
    "internet (its services reachable), /src a copy of the repository reset before each command. It uses the image " +
    "the project's last try_project built, and changes neither review.yaml nor the image. Use it to look around: " +
    `versions, files, a single test. At most ${EXEC_MAX_TIMEOUT} s per command (default ${EXEC_TIMEOUT}), ` +
    `${EXEC_CALLS} commands per setup. Returns the exit code, the seconds it took and the output (its start and end).`,
  input_schema: { type: "object", properties: {
    project: { type: "string", description: "a project already tried with try_project" },
    command: { type: "string", description: "one sh -c command line" },
    cwd: { type: "string", description: "where to run it, relative to the project's root (default: its root)" },
    timeout: { type: "number", description: `seconds (default ${EXEC_TIMEOUT}, at most ${EXEC_MAX_TIMEOUT})` },
  }, required: ["project", "command"], additionalProperties: false },
};

/** The environment a project's last try_project ran in: its settings, its image and what tells one environment from
 * another (setup's envDigest). */
export interface TriedEnv { cfg: ReviewConfig; image: string; env: string }

/** `text` as the agent gets it: whole, or its start and its end with what was left out counted. */
export function clipOutput(text: string): string {
  if (text.length <= HEAD + TAIL) return text;
  return `${text.slice(0, HEAD)}\n[… ${text.length - HEAD - TAIL} characters left out …]\n${text.slice(-TAIL)}`;
}

const same = (a: Stats, b: Stats) => a.isDirectory() === b.isDirectory() && a.isFile() === b.isFile() &&
  a.isSymbolicLink() === b.isSymbolicLink();

/** Keeps the folder `to` the same as `from`, for commands that may write into `to`: each sync removes what `to` has
 * and `from` lacks, and copies anew each file that differs. A file left as it was keeps its mtime, so a build kept in
 * the container (Rust) stays valid; one copied anew gets a new mtime, so a build that saw it changed builds again.
 * The reports of earlier runs (REPORT_DIR) are not copied. */
export class Mirror {
  /** Each file's size and mtime as last copied or checked: a file that still has them is unchanged. */
  private seen = new Map<string, string>();

  constructor(readonly from: string, readonly to: string) {}

  sync(rel = ""): void {
    const src = join(this.from, rel);
    const dest = join(this.to, rel);
    mkdirSync(dest, { recursive: true });
    const want = new Map(readdirSync(src).filter((n) => rel || n !== REPORT_DIR).map((n) => [n, lstatSync(join(src, n))]));
    for (const name of readdirSync(dest)) {
      const w = want.get(name);
      if (!w || !same(w, lstatSync(join(dest, name)))) rmSync(join(dest, name), { recursive: true, force: true });
    }
    for (const [name, st] of want) {
      const r = rel ? `${rel}/${name}` : name;
      const s = join(src, name);
      const d = join(dest, name);
      const now = lstatSync(d, { throwIfNoEntry: false });
      if (st.isDirectory()) this.sync(r);
      else if (st.isSymbolicLink()) {
        const target = readlinkSync(s);
        if (now && readlinkSync(d) === target) continue;
        rmSync(d, { force: true });
        symlinkSync(target, d);
      } else if (st.isFile()) {
        const stamp = (x: Stats) => `${x.size}:${x.mtimeMs}`;
        if (now && this.seen.get(r) === stamp(now)) continue;
        // Touched, not changed (a kept run touches what changed since the last one): kept, with its new mtime.
        if (now && now.size === st.size && readFileSync(d).equals(readFileSync(s))) {
          this.seen.set(r, stamp(now));
          continue;
        }
        rmSync(d, { force: true });
        copyFileSync(s, d);
        this.seen.set(r, stamp(lstatSync(d)));
      }
    }
  }
}

/** The exec tool over one setup: at most one container at a time (a project's environment), started on the first
 * command for it and kept until another environment's command or close. */
export class SetupExec {
  private box: { env: string; runner: ExecRunner; mirror: Mirror } | null = null;
  private calls = 0;
  private seconds = 0;

  /** `tried`: the environment of each project's last try_project. `dir`: where the copies of the repository go. */
  constructor(private o: { snap: string; dir: string; outDir: string; factory: ExecFactory;
    tried: Map<string, TriedEnv>; say: Say }) {}

  async call(input: Record<string, unknown>): Promise<string> {
    const command = typeof input.command === "string" ? input.command : "";
    if (!command.trim()) return "invalid: give a command";
    const named = typeof input.project === "string" ? input.project : "";
    const project = named || (this.o.tried.size === 1 ? [...this.o.tried.keys()][0]! : "");
    const refuse = (why: string, text: string) => {
      emit("setup.exec", { n: null, project, ran: false, refused: why });
      return text;
    };
    if (this.calls >= EXEC_CALLS || this.seconds >= EXEC_SECONDS) {
      return refuse("budget", `exec budget spent (${EXEC_CALLS} commands or ${EXEC_SECONDS / 60} min per setup); ` +
        "use try_project");
    }
    const tried = this.o.tried.get(project);
    if (!tried) {
      return refuse("no-image", `no image for ${project || "that project"} yet: exec runs in the image try_project ` +
        `builds and builds none. Call try_project for it first.`);
    }
    const asked = typeof input.timeout === "number" && input.timeout > 0 ? Math.ceil(input.timeout) : EXEC_TIMEOUT;
    const timeout = Math.min(asked, EXEC_MAX_TIMEOUT);
    if (this.box && this.box.env !== tried.env) this.close();
    if (!this.box) {
      // There before the container starts: Docker would make a missing one, owned by root.
      const src = join(this.o.dir, randomHex(3));
      mkdirSync(src, { recursive: true });
      this.o.say(`${project}: looking around in its test environment`);
      let runner: ExecRunner | null;
      try {
        runner = await this.o.factory(tried.image, tried.cfg, src);
      } catch (e) {
        rmSync(src, { recursive: true, force: true });
        if (!(e instanceof ArnxError)) throw e;
        return refuse("start", `failed: the container did not start: ${e.message}`);
      }
      if (!runner) {
        rmSync(src, { recursive: true, force: true });
        return refuse("no-image", `the image of ${project}'s last try_project is not there (its build failed): fix ` +
          "install and call try_project again.");
      }
      this.box = { env: tried.env, runner, mirror: new Mirror(this.o.snap, src) };
    }
    const box = this.box;
    try {
      box.mirror.sync();
    } catch (e) {
      this.close();
      return refuse("reset", `failed: /src could not be reset (${e instanceof Error ? e.message : String(e)}); the ` +
        "container was removed, run the command again");
    }
    const n = ++this.calls;
    const cwd = typeof input.cwd === "string" && input.cwd.trim() ? input.cwd.trim() : "";
    const r: RunResult = box.runner.exec(cwd ? `cd -- ${shQuote(cwd)} || exit 1; ${command}` : command, timeout);
    this.seconds += r.seconds;
    const secs = Math.round(r.seconds * 10) / 10;
    try {
      mkdirSync(this.o.outDir, { recursive: true });
      writeFileSync(join(this.o.outDir, `exec-${n}.log`), `$ ${command}\n${r.output}`);
    } catch {
      // the log is for the person; the agent has its answer
    }
    emit("setup.exec", { n, project, ran: true, secs, exit: r.exitCode, timed_out: r.timedOut,
      bytes: Buffer.byteLength(r.output) });
    const head = r.timedOut ? `timed out after ${timeout} s; its processes were killed`
      : `exit ${r.exitCode ?? "unknown"} after ${secs} s`;
    const left = EXEC_CALLS - this.calls;
    return `${head}${asked > timeout ? ` (timeout capped at ${EXEC_MAX_TIMEOUT} s)` : ""}\n` +
      `${clipOutput(r.output.trimEnd()) || "(no output)"}${left <= 10 ? `\n(${left} exec commands left)` : ""}`;
  }

  /** Removes the container, its services and its copy of the repository. */
  close(): void {
    const box = this.box;
    this.box = null;
    if (!box) return;
    box.runner.close();
    try {
      rmSync(box.mirror.to, { recursive: true, force: true });
    } catch {
      // setup's temporary folder goes at its end
    }
  }
}
