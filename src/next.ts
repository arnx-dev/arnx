// arnx next: where this repository is in the flow (set up, reviewed, marked, accepted, fixed) and the one command to
// run now, so nobody has to remember the order or a review id.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startedAt } from "./accept";
import { describe, hasCommits, resolveChange, untrackedLine } from "./change";
import { reviewConfigPath, isSeedFile, readSecretPins } from "./config";
import { ChangeTooLarge, NoChange } from "./errors";
import { load, nextSteps } from "./report";
import { settingsPath, untrackedSetting } from "./settings";

/** `note`: a line under Where (what the change leaves out); `then`: the step after `command`. */
export interface Next { phase: string; where: string; command: string; why: string; note?: string; then?: string }

/** The flow's four phases, named after the command that next() returns. */
const PHASES: [string, string][] = [["init", "1. Prepare"], ["setup", "1. Prepare"], ["review", "2. Review"],
  ["triage", "3. Decide"], ["accept", "3. Decide"], ["check", "4. Fix"]];

export function whatNext(repo: string): Next {
  const n = step(repo);
  const verb = n.command.split(" ")[1]!;
  return { ...n, phase: n.phase ?? PHASES.find(([c]) => c === verb)?.[1] ?? "" };
}

function step(repo: string): Omit<Next, "phase"> & { phase?: string } {
  if (!existsSync(settingsPath(repo))) {
    return { where: "not set up", command: "arnx init", why: "writes .arnx/config.toml and .arnxignore" };
  }
  if (!existsSync(reviewConfigPath(repo)) || isSeedFile(repo)) {
    return { where: "no test environment yet", command: "arnx setup",
      why: "finds how your tests run in Docker" };
  }
  // A review.yaml changed since its proof needs no step of its own: the next review proves it again first.
  const base = join(repo, ".arnx", "reviews");
  const reviews = existsSync(base) ? readdirSync(base).map((d) => join(base, d))
    .filter((d) => existsSync(join(d, "state.json")) || existsSync(join(d, "review.json"))) : [];
  // What a plain `arnx review` would send now: untracked files only when [review] untracked opts in.
  const optIn = untrackedSetting(repo);
  const resolve = (untracked: boolean) => {
    const c = resolveChange(repo, null, readSecretPins(repo), { untracked });
    const line = c.kind === "no-commits" ? null : untrackedLine(c);
    return { describe: describe(c), sent: line ?? "",
      sha: createHash("sha256").update(c.diff).digest("hex") };
  };
  let change: { describe: string; sent: string; sha: string } | null = null;
  // Only an empty change is "nothing to review"; any other reason the change cannot be reviewed is the answer while
  // there is no review yet (a later review keeps its own next step, as before).
  let refused: Error | null = null;
  try {
    change = resolve(optIn);
  } catch (e) {
    if (!(e instanceof NoChange)) refused = e instanceof Error ? e : new Error(String(e));
  }
  const latest = reviews.length ? reviews.reduce((a, b) => (startedAt(b) > startedAt(a) ? b : a)) : null;
  if (!latest) {
    // With no commits yet there is no range to name: committing part of the files leaves the rest to review.
    if (refused instanceof ChangeTooLarge && !hasCommits(repo)) {
      return { phase: "2. Review", where: refused.message, command: "git commit",
        why: "commit part of the files; `arnx review` takes the rest" };
    }
    if (refused instanceof ChangeTooLarge && refused.root) {
      return { where: refused.message, command: "git switch -c my-change", why: "make the next change there" };
    }
    if (refused instanceof ChangeTooLarge) {
      return { where: refused.message, command: "arnx review --range A..B",
        why: "a few commits at a time" };
    }
    if (refused) {
      return { phase: "2. Review", where: "the change cannot be reviewed", command: refused.message,
        why: "fix this, then `arnx next` again" };
    }
    return change ? { where: `${change.describe}, not reviewed yet`, command: "arnx review", why: "",
      ...(change.sent ? { note: change.sent } : {}) }
      : { where: "no changes to review", command: "arnx review --range BASE..HEAD", why: "or make a change first" };
  }
  const id = latest.split("/").at(-1)!;
  const state = existsSync(join(latest, "state.json"))
    ? JSON.parse(readFileSync(join(latest, "state.json"), "utf8")) as { diff_sha256?: string; untracked?: boolean }
    : {};
  // A review run with --untracked is compared with the change as it would send it, untracked files included.
  if (state.untracked && !optIn && change) {
    try {
      change = { ...change, sha: resolve(true).sha };
    } catch {
      // the change cannot be resolved that way: it moved
    }
  }
  if (!existsSync(join(latest, "review.json"))) {
    return { where: `review ${id} was interrupted`, command: "arnx review --resume",
      why: "continues it" };
  }
  if (change && state.diff_sha256 && state.diff_sha256 !== change.sha && !existsSync(join(latest, "accepted.json"))) {
    return { where: `the change moved since review ${id}`, command: "arnx review", why: change.describe,
      ...(change.sent ? { note: change.sent } : {}) };
  }
  if (!existsSync(join(latest, "accepted.json"))) {
    // Every issue proven and no question an issue waits on: the marks review.md came with are ready to accept.
    // A review.json that does not read sends the developer to triage, which says what is wrong with it.
    let settled = false, cut = false;
    try {
      const r = load(latest);
      settled = nextSteps(r).length === 1;
      cut = (r.projectStats ?? []).some((p) => p.stop === "budget");
    } catch {
      settled = false;
    }
    // A review its budget cut short: what it proved stands; the rest needs a bigger budget and another review.
    const note = cut ? { note: "it stopped at its budget: what it proved stands; for the rest, raise `review_usd` " +
      "(or top up arnx cloud) and run arnx review again" } : {};
    return settled
      ? { where: `review ${id}: every issue comes marked real`, command: `arnx accept ${id}`,
        why: `\`arnx triage ${id}\` first to change a mark`, ...note }
      : { where: `review ${id} is waiting for your marks`, command: `arnx triage ${id}`, why: "",
        then: `arnx accept ${id}`, ...note };
  }
  // Whether the fix is in already is not tracked: "fix the bugs" holds either way, and check verifies it.
  return { phase: "4. Fix", where: `review ${id} accepted; fixes not verified yet`, command: "fix the bugs",
    why: "arnx prompt prints the fix prompt for your coding agent", then: "arnx check" };
}
