// Hints for the setup agent about why a suite's tests fail, read from the failures themselves: a module that is not
// installed or not importable, a system library or a program missing from the image, an environment variable read
// without a default, a variable env sets that the error names or whose value it quotes, a host that does not resolve, a
// connection refused, a test file that does not load, and tests that pass once the rest of the suite is left out. Each
// hint quotes the line it comes from and is only a hint: the agent still reads the output and decides, and arnx
// changes nothing in the file.
// A failure that matches no signature gets no hint, so the agent sees it as it did before; a wrong hint is worse than
// none, which is why every signature here is narrow.
import { existsSync } from "node:fs";
import { join, posix } from "node:path";
import type { TestResult } from "./adapters/types";
import type { ReviewConfig } from "./config";
import { envValue } from "./secrets";

export type HintKind = "missing-package" | "import-path" | "missing-library" | "missing-program" |
  "missing-variable" | "env-value" | "unresolved-host" | "connection-refused" | "does-not-load" | "order-dependent" |
  "genuine-failure";

/** source: who judged it when it is not a signature (the experimental JEV, with its confidence). */
export interface Hint { kind: HintKind; detail: string; files: string[]; evidence: string; source?: string }

const LOCAL = /^(?:localhost|127\.\d+\.\d+\.\d+|::1|\[::1\]|0\.0\.0\.0)$/;

// A name that reads as an environment variable, so a short or lowercase key in env is never looked for in errors.
const ENV_NAME = /^[A-Z][A-Z0-9_]{3,}$/;

const failed = (t: TestResult) => t.outcome === "failed" || t.outcome === "error";

// pytest's "E   " and ">" line marks and the indent before them; an "E" that starts a word ("Error:") stays.
const MARKS = /^(?:\s|E(?=\s)|>)+/;

/** The line of the message a signature matched, trimmed, as the hint's evidence. */
function lineOf(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end).replace(MARKS, "").trim().slice(0, 200);
}

/** Whether a failing result stands for a whole test file that did not load, so none of its tests ran: pytest's
 * collection error, or a vitest or node file that failed before its tests (one result named after the file). */
export function loadFailure(t: TestResult): boolean {
  if (!failed(t) || !t.fileAttr) return false;
  if (/^collection failure\b/.test(t.message)) return true;
  return t.name === t.fileAttr || t.name.endsWith(`/${t.fileAttr}`) || t.fileAttr.endsWith(`/${t.name}`);
}

/** The line of a failure that says what went wrong: its first line that says something, except under pytest's
 * "collection failure" header, where it is the traceback's last "E" line (the exception the import raised). */
export function errorLine(message: string): string {
  const lines = message.split("\n");
  if (/^collection failure\b/.test(lines[0] ?? "")) {
    const rest = lines.slice(1);
    const line = rest.filter((l) => /^E\s/.test(l)).at(-1) ?? rest.find((l) => l.trim());
    if (line) return line.replace(MARKS, "").trim().slice(0, 200);
  }
  return firstLine(message);
}

/** Whether a Python top-level module name is a file or folder of the repository, at its root or on the way to the
 * project's workdir: then it exists and only the import path is wrong. */
function inRepository(snap: string, workdir: string, top: string): boolean {
  const dirs = [""];
  for (const part of posix.normalize(workdir).split("/").filter((p) => p && p !== ".")) {
    dirs.push(posix.join(dirs.at(-1)!, part));
  }
  return dirs.some((d) => existsSync(join(snap, d, top)) || existsSync(join(snap, d, `${top}.py`)));
}

/** The hint one failure supports, or null when no signature matches. */
export function classify(message: string, cfg: ReviewConfig, snap: string): Omit<Hint, "files"> | null {
  let m: RegExpExecArray | null;
  if ((m = /ModuleNotFoundError: No module named '([\w.]+)'/.exec(message))) {
    const top = m[1]!.split(".")[0]!;
    return { kind: inRepository(snap, cfg.workdir, top) ? "import-path" : "missing-package", detail: m[1]!,
      evidence: lineOf(message, m.index) };
  }
  if ((m = /Cannot find (?:package|module) '([^']+)'|Failed to resolve import "([^"]+)"/.exec(message))) {
    const spec = (m[1] ?? m[2])!;
    if (spec.startsWith(".") || spec.startsWith("/")) return { kind: "import-path", detail: spec, evidence: lineOf(message, m.index) };
    const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
    if (name.startsWith("node:")) return null;
    return { kind: "missing-package", detail: name, evidence: lineOf(message, m.index) };
  }
  if ((m = /(lib[\w+.-]*?\.so(?:\.[\w.]+)?): cannot open shared object file/.exec(message))) {
    return { kind: "missing-library", detail: m[1]!, evidence: lineOf(message, m.index) };
  }
  if ((m = /spawn (\S+) ENOENT|\bsh: \d+: (\S+): not found|(?:^|\s)(?:ba)?sh: ([\w./-]+): command not found/.exec(message))) {
    return { kind: "missing-program", detail: (m[1] ?? m[2] ?? m[3])!, evidence: lineOf(message, m.index) };
  }
  // os.environ["X"] raises from os.py; a KeyError on any other mapping is not about the environment.
  if ((m = /KeyError: '([A-Za-z_][A-Za-z0-9_]*)'/.exec(message)) && /raise KeyError\(key\) from None/.test(message)) {
    return { kind: "missing-variable", detail: m[1]!, evidence: lineOf(message, m.index) };
  }
  if (/'NoneType'/.test(message) &&
      (m = /os\.(?:getenv|environ\.get)\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*\)/.exec(message))) {
    return { kind: "missing-variable", detail: m[1]!, evidence: lineOf(message, m.index) };
  }
  if ((m = /getaddrinfo (?:ENOTFOUND|EAI_AGAIN) ([^\s:'"]+)|Failed to resolve '([^']+)'|host='([^']+)'[^\n]*(?:NameResolutionError|Failed to resolve|Name or service not known|Temporary failure in name resolution)|Temporary failure in name resolution|Name or service not known|No address associated with hostname|nodename nor servname provided|DNS operation timed out|All nameservers failed to answer|The DNS query name does not exist/.exec(message))) {
    const host = m[1] ?? m[2] ?? m[3] ?? "";
    if (host && (LOCAL.test(host) || cfg.services.some((s) => s.name === host))) return null;
    return { kind: "unresolved-host", detail: host, evidence: lineOf(message, m.index) };
  }
  if ((m = /ECONNREFUSED ([\w.:[\]-]+)|connection to server at "([^"]+)"[^\n]*(?:\n[^\n]*)?refused|Connection refused|\[Errno 111\]/.exec(message))) {
    return { kind: "connection-refused", detail: m[1] ?? m[2] ?? "", evidence: lineOf(message, m.index) };
  }
  // A variable env sets, named or quoted by its value on the line that says what went wrong (not the source lines a
  // traceback prints): the value env gives is wrong, or it overrides a default the tests set themselves. A KeyError
  // names a key of some mapping; os.environ cannot raise one for a variable env sets.
  const line = errorLine(message);
  if (/^KeyError\b/.test(line)) return null;
  const keys = Object.keys(cfg.env);
  const name = keys.find((k) => ENV_NAME.test(k) && word(k).test(line)) ??
    keys.find((k) => [cfg.env[k]!, envValue(cfg.env[k]!)].some((v) => ENV_VALUE.test(v) && word(v).test(line)));
  if (name) return { kind: "env-value", detail: name, evidence: line };
  return null;
}

// A value worth looking for in an error line: 4+ characters, not a number, not a word any line may hold.
const ENV_VALUE = /^(?![\d.]+$)(?!(?:true|false|none|null|test|yes)$).{4,}$/i;

/** `s` as a whole token: no letter, digit, `_` or `$` right before or after it. */
const word = (s: string) => new RegExp(`(?<![\\w$])${escaped(s)}(?![\\w$])`);

// A line saying a module or a file is not there, in the words of pytest, node, vitest and the OS.
const MISSING = /Cannot find (?:module|package)|Failed to (?:resolve import|load url)|Could not resolve|No module named|ModuleNotFoundError|ENOENT|FileNotFoundError|No such file or directory|does not exist/;
const CODE = /\.(?:py|[cm]?[jt]sx?)$/;
const escaped = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The files of `leftOut` (repository paths the snapshot left out) a missing-module or missing-file line names: a
 * code file by its module name (`creds`, `creds.js`, `core.auth.creds`), any other file by its whole name. A name
 * that another file of `all` (the repository's files) shares counts only with its folder in front. */
export function missingLeftOut(texts: string[], leftOut: string[], all: string[]): string[] {
  const lines = texts.flatMap((t) => t.split("\n")).filter((l) => MISSING.test(l));
  if (!lines.length) return [];
  const nameOf = (p: string) => posix.basename(p).replace(CODE, "");
  const count = new Map<string, number>();
  for (const p of all) count.set(nameOf(p), (count.get(nameOf(p)) ?? 0) + 1);
  return leftOut.filter((p) => {
    const name = nameOf(p);
    const ext = CODE.test(p) ? String.raw`(?:\.(?:py|[cm]?[jt]sx?))?` : "";
    const dir = posix.basename(posix.dirname(p));
    const before = (count.get(name) ?? 0) > 1 && dir !== "." ? String.raw`${escaped(dir)}[/.\\]`
      : String.raw`(?:^|[\s'"\x60/.\\(])`;
    const rx = new RegExp(`${before}${escaped(name)}${ext}(?=$|[\\s'"\\x60):,])`);
    return lines.some((l) => rx.test(l));
  });
}

/** The package npx tried to download because it is not installed where the command ran ("@scope/name" decoded), or
 * null. The sandbox has no network, so npx gives up after a while and the run writes no report. */
export function npxDownload(output: string): string | null {
  const m = /request to https?:\/\/registry\.[^/\s]+\/((?:@[^/\s]+(?:\/|%2[fF]))?[^/\s]+) failed/.exec(output);
  return m ? decodeURIComponent(m[1]!) : null;
}

/** Why a run gave no report when npx went to the network for `pkg`. */
export const npxText = (pkg: string) => `\`${pkg}\` is not installed where test_command runs it, so npx tried to ` +
  "download it (the sandbox has no network). Install it in install, or link install's node_modules into the " +
  "repository, which is mounted over /src";

/** The first line of a failure message that says something, as evidence for a hint no signature produced. */
export function firstLine(message: string): string {
  return message.split("\n").map((l) => l.replace(MARKS, "").trim()).find(Boolean)?.slice(0, 200) ?? "";
}

/** Most failing files whose first error the setup agent is shown. */
const FIRST_ERRORS_MAX = 10;

/** The first error of each failing file outside known_failing, one line each, for the setup agent: a runner that writes
 * its results only to arnx's report (vitest, bun) leaves the console without them. "" when there is none. */
export function firstErrors(results: TestResult[] | null, cfg: ReviewConfig): string {
  const first = new Map<string, string>();
  for (const t of results ?? []) {
    if (!failed(t) || !t.fileAttr || first.has(t.fileAttr) || cfg.knownFailing.some((k) => t.fileAttr.startsWith(k))) {
      continue;
    }
    const line = errorLine(t.message);
    if (line) first.set(t.fileAttr, line);
  }
  const files = [...first.keys()].sort();
  if (!files.length) return "";
  const more = files.length > FIRST_ERRORS_MAX ? ` (${FIRST_ERRORS_MAX} of ${files.length})` : "";
  return `First error in each failing file${more}:\n` +
    files.slice(0, FIRST_ERRORS_MAX).map((f) => `- ${f}: ${first.get(f)}`).join("\n");
}

/** Hints for the failures outside known_failing, one per kind and detail, with the files they come from. A file that
 * does not load and matches no signature gets a hint of its own, named by its error: it hides every test in it. */
export function diagnose(results: TestResult[] | null, cfg: ReviewConfig, snap: string): Hint[] {
  const hints = new Map<string, Hint>();
  for (const t of results ?? []) {
    if (!failed(t) || cfg.knownFailing.some((k) => t.fileAttr.startsWith(k))) continue;
    const h = classify(t.message, cfg, snap) ??
      (loadFailure(t) ? { kind: "does-not-load" as const, detail: errorLine(t.message), evidence: "" } : null);
    if (!h) continue;
    const key = `${h.kind}\0${h.detail}`;
    const seen = hints.get(key) ?? { ...h, files: [] };
    if (t.fileAttr && !seen.files.includes(t.fileAttr)) seen.files.push(t.fileAttr);
    hints.set(key, seen);
  }
  return [...hints.values()];
}

/** Failing files (outside known_failing) none of whose failures has a hint: the ones worth running apart from the
 * rest of the suite to see whether they depend on it. */
export function unexplainedFiles(results: TestResult[] | null, cfg: ReviewConfig, hints: Hint[]): string[] {
  const hinted = new Set(hints.filter((h) => h.kind !== "order-dependent").flatMap((h) => h.files));
  return [...new Set((results ?? []).filter((t) => failed(t) && t.fileAttr && !hinted.has(t.fileAttr) &&
    !cfg.knownFailing.some((k) => t.fileAttr.startsWith(k))).map((t) => t.fileAttr))].sort();
}

/** Files whose tests all pass when run apart from the rest of the suite. */
export function passingApart(files: string[], apart: TestResult[] | null): string[] {
  if (!apart?.length) return [];
  return files.filter((f) => {
    const own = apart.filter((t) => t.fileAttr === f);
    return own.length > 0 && own.every((t) => t.outcome === "passed" || t.outcome === "skipped");
  });
}

const listed = (files: string[]) =>
  files.slice(0, 5).join(", ") + (files.length > 5 ? `, and ${files.length - 5} more` : "");

function sentence(h: Hint, cfg: ReviewConfig): string {
  const service = cfg.services.find((s) => h.detail.split(":")[0] === s.name);
  switch (h.kind) {
    case "missing-package":
      return cfg.language === "python"
        ? `module \`${h.detail}\` is not installed: add the package that provides it to install`
        : `package \`${h.detail}\` cannot be found: not installed, or installed where the tests do not see it ` +
          "(the repository is mounted over /src, which hides anything install put there)";
    case "import-path":
      return cfg.language === "python"
        ? `\`${h.detail}\` is in the repository but cannot be imported: an import path problem (working directory, ` +
          "rootdir or PYTHONPATH), not a missing package"
        : `the tests import \`${h.detail}\`, which is not there: a file a build step generates, or a wrong path`;
    case "missing-library":
      return `system library \`${h.detail}\` is not in the image: install the system package that provides it ` +
        "(apt-get on Debian images, apk on Alpine) in install, or use an image that has it";
    case "missing-program":
      return `program \`${h.detail}\` is not installed where the tests run: install it in install. A server the ` +
        "test starts itself (redis-server, postgres) must be in the image too: a declared service runs in its own " +
        "container";
    case "does-not-load":
      return `test files do not load (\`${h.detail}\`), so none of their tests run; recorded, each would hide every ` +
        "test in it. Make them load: install what they import (a package, a system library, a program), set what " +
        "they read when imported, or fix the import path";
    case "missing-variable":
      return `variable \`${h.detail}\` is read without a default and is not set: give it a test value in env, ` +
        "unless the code needs a real one from outside";
    case "env-value":
      return `the tests fail on variable \`${h.detail}\`, which env sets: env's value is not one the code accepts ` +
        "(its format or length), or it overrides a default the tests set themselves (conftest, a setup file). Give " +
        "it a valid test value, or take it out of env";
    case "unresolved-host":
      return `a host name does not resolve${h.detail ? ` (${h.detail})` : ""}. Declared services resolve in the ` +
        "sandbox, so this host is not one: the test needs the internet (then try the project again unchanged and it " +
        "is recorded as failing today) or a service the file does not declare";
    case "connection-refused":
      if (service) return `service \`${service.name}\` refuses connections: not ready yet (give it a ready check) or another port`;
      if (LOCAL.test(h.detail.replace(/:\d+$/, "").replace(/^\[|\]$/g, ""))) {
        return `nothing listens on ${h.detail}: the test expects a server on localhost, but in the sandbox services ` +
          "are reached by their name";
      }
      return `a connection was refused${h.detail ? ` (${h.detail})` : ""}: a service the test expects is not running`;
    case "genuine-failure":
      return "the code runs and fails on its own result or data, not on the environment";
    case "order-dependent":
      return "these pass when run without the rest of the suite: another test file changes state they depend on " +
        "(imports, environment, globals), or they are flaky";
  }
}

/** The hints as lines for the agent, each with its files and the line it comes from. */
export function describeHints(hints: Hint[], cfg: ReviewConfig): string {
  if (!hints.length) return "";
  const lines = hints.map((h) => `- ${sentence(h, cfg)}${h.source ? ` (${h.source})` : ""}. Files: ` +
    `${listed(h.files)}.` + (h.evidence ? ` From: "${h.evidence}"` : ""));
  return "Hints from the failures (each names the line it comes from; check it before acting on it):\n" +
    lines.join("\n");
}
