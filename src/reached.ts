// What a test run executed, as arnx's Python hook notes it (adapters/python.ts): one reached-<pid>.txt per process in
// the report folder, each line "ran <path>" (a function's code ran) or "loaded <path>" (only a module's or class's
// body did). File paths only, never values or source. A runner without the hook leaves no notes: no data, never "not
// reached".
import { existsSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { REPORT_DIR } from "./sandbox";

export type Reach = Map<string, "ran" | "loaded">;

const NOTES = /^reached-\d+\.txt$/;
const LINE = /^(ran|loaded) \/src\/(.+)$/;

/** The hook's notes in a snapshot, by repository path ("ran" over "loaded"): only the code's own files, none from a
 * site-packages folder or arnx's report folder. */
export function readReach(snap: string): Reach {
  const dir = join(snap, REPORT_DIR);
  const out: Reach = new Map();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).filter((n) => NOTES.test(n)).sort()) {
    for (const line of readFileSync(join(dir, name), "utf8").split("\n")) {
      const m = LINE.exec(line);
      if (!m || m[2]!.startsWith(`${REPORT_DIR}/`) || /(^|\/)site-packages\//.test(m[2]!)) continue;
      if (m[1] === "ran" || !out.has(m[2]!)) out.set(m[2]!, m[1] as "ran" | "loaded");
    }
  }
  return out;
}

/** Removes the notes, so the next runs' are their own. */
export function clearReach(snap: string): void {
  const dir = join(snap, REPORT_DIR);
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).filter((n) => NOTES.test(n))) rmSync(join(dir, name), { force: true });
}

/** The files `now` shows that `probe` (the run of arnx's one-line test, which loads what any test of the folder
 * loads: conftest and what it imports) does not explain: ran now and not ran by the probe, or loaded now and not seen
 * by the probe at all. */
export function reachedSince(now: ReadonlyMap<string, "ran" | "loaded">, probe: ReadonlyMap<string, "ran" | "loaded">)
  : string[] {
  return [...now].filter(([p, kind]) => kind === "ran" ? probe.get(p) !== "ran" : !probe.has(p)).map(([p]) => p).sort();
}
