// arnx triage: mark a review's findings and answer its questions in the terminal, one at a time, with tick-boxes moved
// by the arrow keys. It reads and writes the same review.md, so marking by hand in an editor still works; the
// findings marked here are noted in triage.json, for the precision log (accept.ts: markSource).
import type { Paint } from "./color";
import { isPreExisting } from "./before";
import { active, type Finding, groupsOf, isIssue, ISSUE_HEADING, type Marks, marksIssues, neededQuestions, parseMarks,
  proven, REWRITE, type Review } from "./report";

export type Key = "up" | "down" | "left" | "right" | "enter" | "space" | "backspace" | "escape" | "quit" |
  { char: string };

/** Keys from raw terminal input. */
export function parseKeys(data: string): Key[] {
  const out: Key[] = [];
  for (let i = 0; i < data.length; i++) {
    const rest = data.slice(i);
    const seq = (s: string, k: Key) => (rest.startsWith(s) ? (out.push(k), (i += s.length - 1), true) : false);
    if (seq("\x1b[A", "up") || seq("\x1b[B", "down") || seq("\x1b[C", "right") || seq("\x1b[D", "left")) continue;
    const c = data[i]!;
    if (c === "\r" || c === "\n") out.push("enter");
    else if (c === " ") out.push("space");
    else if (c === "\x7f" || c === "\b") out.push("backspace");
    else if (c === "\x03") out.push("quit");
    else if (c === "\x1b") out.push("escape");
    else if (c >= " ") out.push({ char: c });
  }
  return out;
}

/** review.md with these marks, severities and answers written into it (the rest left as it is). */
export function applyMarks(md: string, m: Marks): string {
  const lines = md.split("\n");
  let current: string | null = null;
  const out: string[] = [];
  let skippingAnswer = false;
  let skippingReason = false;
  // Findings with a Mark line of their own (one changed by hand inside an issue): that line keeps their mark, and the
  // issue's Mark line shows the mark of a member without one, so a save never turns their marks into one value.
  const own = new Set<string>();
  let under: string | null = null;
  for (const line of lines) {
    const h = /^###\s+([FQ]\d+)\b/.exec(line) ?? ISSUE_HEADING.exec(line);
    if (h || line.startsWith("## ")) under = h ? h[1]! : null;
    if (under?.startsWith("F") && line.startsWith("Mark:")) own.add(under);
  }
  // Under an issue's heading, its findings: the issue's Mark line shows the first one without its own Mark line.
  let members: string[] = [];
  for (const line of lines) {
    const heading = /^###\s+([FQ]\d+)\b/.exec(line) ?? ISSUE_HEADING.exec(line);
    if (heading || line.startsWith("## ")) {
      current = heading ? heading[1]! : null;
      members = [];
      skippingAnswer = skippingReason = false;
    }
    if (isIssue(current) && line.startsWith("- Failing tests:")) members = line.match(/\bF\d+\b/g) ?? [];
    const id = isIssue(current) ? members.find((f) => !own.has(f)) ?? members[0] ?? null : current;
    const all = isIssue(current) ? / {2}\((?:both|all \d+) tests\)$/.exec(line)?.[0] ?? "" : "";
    if (skippingAnswer) {
      // The old answer runs until the next heading; it is replaced as a whole.
      if (heading || line.startsWith("## ")) skippingAnswer = false;
      else continue;
    }
    if (skippingReason) {
      // The old Rewrite line (wrapped or not) is replaced by the one written after the Mark line.
      if (heading || !line.trim() || line.startsWith("Mark:") || line.startsWith("Severity")) skippingReason = false;
      else continue;
    }
    if (id?.startsWith("F") && line.startsWith(REWRITE)) {
      skippingReason = true;
    } else if (id?.startsWith("F") && line.startsWith("Mark:")) {
      const mark = m.findings[id] ?? null;
      const box = (x: string) => `[${mark === x ? "x" : " "}] ${x}`;
      out.push(`Mark: ${["real", "intended", "noise", "rewrite"].map(box).join("  ")}${all}`);
      const reason = m.rewrites?.[id]?.trim();
      if (mark === "rewrite" && reason) out.push(`${REWRITE} ${reason.replace(/\s+/g, " ")}`);
    } else if (id?.startsWith("F") && line.startsWith("Severity")) {
      const sev = m.severity[id] ?? null;
      out.push(`Severity, if real: [${sev === "high" ? "x" : " "}] high  [${sev === "medium" ? "x" : " "}] medium  ` +
        `[${sev === "low" ? "x" : " "}] low`);
    } else if (current?.startsWith("Q") && line.startsWith("Answer:")) {
      const a = m.answers[current]?.trim();
      out.push(a ? `Answer: ${a}` : "Answer:", "");
      skippingAnswer = true;
    } else {
      out.push(line);
    }
  }
  return out.join("\n");
}

/** Marks saved from triage, and the findings whose mark the owner chose there (in review order), pre-filled or not. */
export interface Triaged extends Marks { chosen: string[] }

export interface MarkIO {
  keys: AsyncIterator<Key>;
  draw(lines: string[]): void;
  paint: Paint;
  width: number;
}

const MARKS = ["real", "intended", "noise", "rewrite", null] as const;
const MARK_LABEL: Record<string, string> = { real: "real: a defect, keep its test (it fails until fixed)",
  intended: "intended: the code is meant to do this", noise: "noise: no bug here, the test is wrong",
  rewrite: "rewrite: the bug is real, the test is wrong", null: "leave unmarked" };
const SEVERITIES = ["high", "medium", "low", null] as const;

function wrapTo(text: string, width: number, indent = ""): string[] {
  const out: string[] = [];
  for (const para of text.split("\n")) {
    let cur = indent;
    for (const w of para.split(" ")) {
      if (cur.trim() && cur.length + 1 + w.length > width) {
        out.push(cur);
        cur = indent + w;
      } else {
        cur += (cur.trim() ? " " : "") + w;
      }
    }
    out.push(cur);
  }
  return out;
}

function boxes(options: readonly (string | null)[], labels: (o: string | null) => string, chosen: string | null,
               cursor: number, p: Paint): string[] {
  return options.map((o, i) => {
    const tick = o === chosen ? p.green("[x]") : "[ ]";
    const line = `${tick} ${labels(o)}`;
    return i === cursor ? `${p.cyan("❯")} ${p.bold(line)}` : `  ${line}`;
  });
}

/** Marks and answers chosen in the terminal, or null when the person quits without saving. */
export async function markInteractive(review: Review, md: string, io: MarkIO): Promise<Triaged | null> {
  const p = io.paint;
  const marks = parseMarks(md, review.findings.map((f) => f.id));
  const chosen = new Set<string>();
  // One item per issue when review.md marks issues (its findings take one mark); else one per finding.
  const parts: Finding[][] = marksIssues(review)
    ? [...groupsOf(review, active(review)).map((g) => g.findings), ...review.findings.filter(isPreExisting).map((f) => [f])]
    : review.findings.map((f) => [f]);
  const titles = new Map(groupsOf(review).filter((g) => g.group).map((g) => [g.findings[0]!.id, g.group!]));
  const needed = neededQuestions(review);
  const items: ({ kind: "finding"; f: Finding; all: Finding[] } | { kind: "question"; qid: string; q: string })[] = [
    ...parts.map((all) => ({ kind: "finding" as const, f: all[0]!, all })),
    ...review.questions.map((q, i) => ({ kind: "question" as const, qid: `Q${i + 1}`, q }))];
  const setAll = (all: Finding[], key: "findings" | "severity", v: string | null) => {
    for (const x of all) marks[key][x.id] = v;
  };
  marks.rewrites ??= {};
  /** A finding marked rewrite with no reason yet; the first item holding one (or -1). */
  const needsReason = (id: string) => marks.findings[id] === "rewrite" && !marks.rewrites?.[id]?.trim();
  const unreasoned = () => items.findIndex((x) => x.kind === "finding" && x.all.some((y) => needsReason(y.id)));
  let idx = 0, cursor = 0, step: "mark" | "reason" | "severity" = "mark";
  let buffer = "";
  const enter = () => {
    const it = items[idx];
    step = "mark";
    if (!it) return;
    if (it.kind === "finding") cursor = Math.max(0, MARKS.indexOf((marks.findings[it.f.id] ?? null) as never));
    else buffer = marks.answers[it.qid] ?? "";
  };
  enter();
  const next = async (): Promise<Key> => {
    const r = await io.keys.next();
    return r.done ? "quit" : r.value;
  };
  for (;;) {
    const it = items[idx];
    const head = (s: string) => p.bold(s);
    const lines: string[] = [];
    if (!it) {
      const n = (m: string | null) => Object.values(marks.findings).filter((x) => x === m).length;
      lines.push(head(`arnx triage · review ${review.id}`), "",
        `${p.red(String(n("real")))} real · ${n("intended")} intended · ${n("noise")} noise · ` +
        (n("rewrite") ? `${n("rewrite")} rewrite · ` : "") +
        `${n(null)} unmarked · ${Object.keys(marks.answers).length} of ${review.questions.length} questions answered`, "",
        `${p.cyan("❯")} ${p.bold("enter")} save to review.md   ${p.bold("←")} back   ${p.bold("q")} quit without saving`);
      io.draw(lines);
      const k = await next();
      if (k === "enter" || (typeof k === "object" && k.char === "y")) {
        // A rewrite needs its reason before anything is saved: back to the first one without it.
        const w = unreasoned();
        if (w >= 0) {
          idx = w;
          step = "reason";
          buffer = "";
          continue;
        }
        return { ...marks, chosen: review.findings.map((f) => f.id).filter((id) => chosen.has(id)) };
      }
      if (k === "left" || k === "up") {
        idx = items.length - 1;
        enter();
      } else if (k === "quit" || k === "escape" || (typeof k === "object" && (k.char === "q" || k.char === "n"))) {
        return null;
      }
      continue;
    }
    const pos = p.dim(`(${idx + 1}/${items.length})`);
    if (it.kind === "finding" && it.all.length > 1 || it.kind === "finding" && titles.has(it.f.id)) {
      const g = titles.get(it.f.id);
      const sure = proven(it.all);
      const state = sure ? "proven" : it.all.some((x) => x.dependsOn) ? `waits on ${it.all.find((x) => x.dependsOn)!
        .dependsOn}` : "disputed";
      const color = sure ? p.red : state === "disputed" ? p.dim : p.yellow;
      const tests = it.all.length === 1 ? it.f.id : `${it.all.length} tests: ${it.all.map((x) => x.id).join(", ")}`;
      lines.push(`${head(g?.title || it.f.explanation.split("\n")[0] || it.f.id)}  ${pos}`,
        `${color(state)}${g?.severity ? ` · severity ${g.severity} (estimate)` : ""} · ${p.dim(tests)}`, "");
      for (const [label, value] of [["Actual", g?.actual], ["Expected", g?.expected], ["Why it matters",
        g?.consequence]] as const) if (value?.trim()) lines.push(...wrapTo(`${label}: ${value.trim()}`, io.width));
      if (!g) lines.push(...wrapTo(it.f.explanation || it.f.message.split("\n")[0]!, io.width));
      lines.push("");
    } else if (it.kind === "finding") {
      const f = it.f;
      const state = f.dependsOn ? `waits on ${f.dependsOn}` : f.verdict ?? "unchecked";
      const color = f.verdict === "confirmed" && !f.dependsOn ? p.red : f.verdict === "disputed" ? p.dim : p.yellow;
      lines.push(`${head(`${f.id}`)} · ${color(state)}${f.project !== "main" ? p.dim(` · ${f.project}`) : ""}  ${pos}`, "");
      lines.push(...wrapTo(f.explanation || f.message.split("\n")[0]!, io.width));
      lines.push("", p.dim(`Test: ${f.testId}`), p.dim(`Failure: ${f.message.split("\n")[0]!.slice(0, io.width - 9)}`));
      if (f.reason) lines.push(...wrapTo(`Second opinion: ${f.reason}`, io.width).map((l) => p.dim(l)));
      lines.push("");
    }
    if (it.kind === "finding" && step === "reason") {
      // A rewrite mark asks why the test is wrong, typed like an answer; empty goes back to the marks.
      lines.push(head("Why is the test wrong? What should it check?"), `${p.bold("Rewrite:")} ${buffer}${p.cyan("▏")}`, "",
        p.dim("type the reason · enter save and go on (empty: back to the marks) · ↑ back"));
      io.draw(lines);
      const k = await next();
      if (typeof k === "object") buffer += k.char;
      else if (k === "space") buffer += " ";
      else if (k === "backspace") buffer = buffer.slice(0, -1);
      else if (k === "enter" && buffer.trim()) {
        for (const x of it.all) marks.rewrites![x.id] = buffer.trim();
        step = "severity";
        const sev = marks.severity[it.f.id] ?? titles.get(it.f.id)?.severity ?? null;
        cursor = sev ? SEVERITIES.indexOf(sev as never) : SEVERITIES.length - 1;
      } else if (k === "enter" || k === "up" || k === "left" || k === "escape") {
        step = "mark";
        cursor = MARKS.indexOf("rewrite");
      } else if (k === "quit") {
        idx = items.length;
      }
      continue;
    }
    if (it.kind === "finding") {
      const f = it.f;
      if (step === "mark") {
        lines.push(head("Is this a real problem?"), ...boxes(MARKS, (o) => MARK_LABEL[String(o)]!,
          (marks.findings[f.id] ?? null) as string | null, cursor, p));
      } else {
        const est = titles.get(f.id)?.severity;
        lines.push(head("How severe?"), ...boxes(SEVERITIES, (o) => o === null ? "skip"
          : o === est ? `${o} (estimate)` : o,
          (marks.severity[f.id] ?? null) as string | null, cursor, p));
      }
      lines.push("", p.dim("↑↓ move · space select · enter next · ← back · q finish"));
      io.draw(lines);
      const k = await next();
      const options = step === "mark" ? MARKS : SEVERITIES;
      if (k === "up") cursor = (cursor + options.length - 1) % options.length;
      else if (k === "down") cursor = (cursor + 1) % options.length;
      else if (k === "space") {
        // Space ticks the box under the cursor; it does not move on.
        if (step === "mark") {
          setAll(it.all, "findings", MARKS[cursor]!);
          if (MARKS[cursor] !== "real" && MARKS[cursor] !== "rewrite") setAll(it.all, "severity", null);
        } else {
          setAll(it.all, "severity", SEVERITIES[cursor]!);
        }
        it.all.forEach((x) => chosen.add(x.id));
      } else if (k === "enter") {
        // Enter keeps what is ticked and goes on: a real mark asks its severity first.
        it.all.forEach((x) => chosen.add(x.id));
        if (step === "mark" && marks.findings[f.id] === "rewrite") {
          step = "reason";
          buffer = marks.rewrites![f.id] ?? "";
        } else if (step === "mark" && marks.findings[f.id] === "real") {
          step = "severity";
          // The cursor starts on the owner's severity, else the grouping model's estimate, else "skip"; nothing is
          // ticked until space (starting on a ticked "high" made every issue high for whoever pressed enter twice).
          const sev = marks.severity[f.id] ?? titles.get(f.id)?.severity ?? null;
          cursor = sev ? SEVERITIES.indexOf(sev as never) : SEVERITIES.length - 1;
        } else {
          idx++;
          enter();
        }
      } else if ((k === "right" || k === "left") && step === "mark" && needsReason(f.id)) {
        // Ticked rewrite and moving on: its reason first.
        step = "reason";
        buffer = "";
      } else if (k === "right") {
        idx++;
        enter();
      } else if (k === "left") {
        idx = Math.max(0, idx - 1);
        enter();
      } else if (k === "quit" || k === "escape" || (typeof k === "object" && k.char === "q")) {
        idx = items.length;
      }
    } else {
      const kind = needed.has(it.qid) ? p.yellow("question") : p.dim("optional question: no issue waits on it");
      lines.push(`${head(it.qid)} · ${kind}  ${pos}`, "", ...wrapTo(it.q, io.width), "",
        `${p.bold("Answer:")} ${buffer}${p.cyan("▏")}`, "",
        p.dim("type your answer · enter save and go on (empty: no answer) · ↑ back · ↓ skip"));
      io.draw(lines);
      const k = await next();
      if (typeof k === "object") buffer += k.char;
      else if (k === "space") buffer += " ";
      else if (k === "backspace") buffer = buffer.slice(0, -1);
      else if (k === "enter") {
        if (buffer.trim()) marks.answers[it.qid] = buffer.trim();
        else delete marks.answers[it.qid];
        idx++;
        enter();
      } else if (k === "up" || k === "left") {
        idx = Math.max(0, idx - 1);
        enter();
      } else if (k === "down" || k === "right") {
        idx++;
        enter();
      } else if (k === "quit" || k === "escape") {
        idx = items.length;
      }
    }
  }
}

/** Keys from the real terminal (raw mode, restored when the iterator is closed or the process exits). The cursor is
 * hidden meanwhile: the screen draws its own marks, and a blinking cursor under them looks like a place to type. */
export function terminalKeys(stdin: NodeJS.ReadStream, stdout: { write(s: string): unknown } = process.stdout):
  AsyncIterator<Key> & { close(): void } {
  const queue: Key[] = [];
  let wake: (() => void) | null = null;
  const onData = (d: Buffer) => {
    queue.push(...parseKeys(d.toString("utf8")));
    wake?.();
  };
  stdin.setRawMode?.(true);
  stdin.resume();
  stdin.on("data", onData);
  stdout.write("\x1b[?25l");
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    stdin.off("data", onData);
    stdin.setRawMode?.(false);
    stdin.pause();
    stdout.write("\x1b[?25h");
  };
  process.once("exit", close);
  return {
    close,
    async next() {
      while (!queue.length) await new Promise<void>((r) => (wake = r));
      wake = null;
      return { value: queue.shift()!, done: false };
    },
  };
}
