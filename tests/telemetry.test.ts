// Opt-in telemetry: off unless the repository's config says true, counts only, never blocking a command.
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseReviewFile, reviewConfigPath, stampFile } from "../src/config";
import type { SessionFactory } from "../src/sandbox";
import { save } from "../src/report";
import { defaultSettings, loadSettings, parseModelRef } from "../src/settings";
import { acceptData, checkData, installId, reportTelemetry, reviewData, type Sender, setupData, TELEMETRY_OPEN,
  telemetryPath, telemetryStatus } from "../src/telemetry";
import { VERSION } from "../src/version";
import { Cli } from "./helpers/cli";
import { FakeSession } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { blankMarks, finding, sampleReview } from "./helpers/review";
import { useTmp } from "./helpers/tmp";

const tmp = useTmp();
/** Telemetry as it will be once its endpoint is live (TELEMETRY_OPEN): the tests of asking and sending. */
const OPEN = { telemetryOpen: true };
const UUID4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z$/;

/** A config directory of this test's own (telemetry on by default), or with ARNX_TELEMETRY=0 for `false`. */
let homes = 0;
function home(on = true): Record<string, string> {
  const env = { XDG_CONFIG_HOME: join(tmp(), `cfg${++homes}`) };
  return on ? env : { ...env, ARNX_TELEMETRY: "0" };
}

// --- on by default, set per repository --------------------------------------------------------------------------

/** What a person does to turn telemetry on: edit init's line to true. */
function turnOn(repo: string): void {
  const path = join(repo, ".arnx", "config.toml");
  writeFileSync(path, readFileSync(path, "utf8").replace(/^telemetry = false/m, "telemetry = true"));
}

test("the install id lives in the user's config dir: XDG_CONFIG_HOME, else ~/.config; none without either", () => {
  expect(telemetryPath({ XDG_CONFIG_HOME: "/x" })).toBe("/x/arnx/telemetry.json");
  expect(telemetryPath({ HOME: "/h" })).toBe("/h/.config/arnx/telemetry.json");
  expect(telemetryPath({})).toBeNull();
  const env = home();
  const id = installId(env);
  expect(id).toMatch(UUID4);
  expect(installId(env)).toBe(id); // kept
  expect(JSON.parse(readFileSync(telemetryPath(env)!, "utf8"))).toEqual({ install_id: id });
});

test("off by default; telemetry = true in the config turns it on, ARNX_TELEMETRY=0 or DO_NOT_TRACK=1 off anyway", () => {
  expect(telemetryStatus(home())).toMatchObject({ on: false, configured: false });
  expect(telemetryStatus(home(), true).on).toBe(true);
  expect(telemetryStatus({ ...home(), ARNX_TELEMETRY: "0" }, true)).toMatchObject({ on: false, forced: "ARNX_TELEMETRY" });
  expect(telemetryStatus({ ...home(), DO_NOT_TRACK: "1" }, true)).toMatchObject({ on: false, forced: "DO_NOT_TRACK" });
  expect(telemetryStatus({ ...home(), DO_NOT_TRACK: "0" }, true).on).toBe(true);
  expect(telemetryStatus({}, true).on).toBe(false); // nowhere to keep the install id
  expect(TELEMETRY_OPEN).toBe(true);
});

test("init writes telemetry = false, asking nothing and saying nothing; the user edits the line", async () => {
  const env = { ...home(), ANTHROPIC_API_KEY: "a" };
  const repo = gitRepo(tmp());
  const asked: string[] = [];
  const cli = new Cli({ ...OPEN, cwd: repo, env, interactive: true, ask: async (q) => (asked.push(q), "y") });
  expect(await cli.run("init")).toBe(0);
  expect(asked.filter((q) => /usage counts|telemetry/i.test(q))).toEqual([]);
  expect(cli.stdout).not.toMatch(/usage counts|telemetry/i);
  const path = join(repo, ".arnx", "config.toml");
  expect(readFileSync(path, "utf8")).toMatch(/^telemetry = false +# true: send anonymous usage counts/m);
  expect(loadSettings(repo).telemetry).toBe(false);
  turnOn(repo);
  expect(loadSettings(repo).telemetry).toBe(true);
  cli.out.length = 0;
  await cli.run("doctor");
  expect(cli.stdout).toContain("Telemetry: on (telemetry = false in .arnx/config.toml turns it off)");
  expect(await cli.run("telemetry")).toBe(2); // no command: the line is the user's to edit
});

test("a config without the line is off; a line that is not true or false is refused", () => {
  const repo = tmp();
  mkdirSync(join(repo, ".arnx"), { recursive: true });
  writeFileSync(join(repo, ".arnx", "config.toml"), "[models]\n");
  expect(loadSettings(repo).telemetry).toBe(false);
  writeFileSync(join(repo, ".arnx", "config.toml"), 'telemetry = "no"\n');
  expect(() => loadSettings(repo)).toThrow("telemetry: write true or false");
});

test("doctor shows telemetry in one line, never as a failed check", async () => {
  const repo = gitRepo(tmp());
  const env = { ...home(), ANTHROPIC_API_KEY: "a" };
  const cli = new Cli({ ...OPEN, cwd: repo, env });
  await cli.run("init");
  cli.out.length = 0;
  await cli.run("doctor");
  expect(cli.stdout).toContain("\nTelemetry: off (telemetry = true in .arnx/config.toml turns it on)\n");
  expect(cli.stdout).not.toMatch(/✗ telemetry/);
});

const TOP = ["arch", "arnx_version", "at", "data", "event", "install_id", "os", "schema"];
const DATA: Record<string, string[]> = {
  setup: ["approved", "cost_micro_usd", "languages", "projects", "seconds"],
  review: ["before", "confirmed", "cost_micro_usd", "diff_kb", "disputed", "effort", "errors", "exit_code",
    "files_changed", "findings", "flaky", "languages", "passed", "projects", "providers", "questions", "seconds",
    "suspects", "tests_written", "unjudged", "unknown_calls"],
  accept: ["answers", "chosen", "defaulted", "intended", "kept_tests", "noise", "real", "unmarked"],
  check: ["exit_code", "failed", "passed", "seconds", "skipped", "tests"],
};
const ENUMS = new Set(["python", "typescript", "javascript", "rust", "csharp", "other", "low", "medium", "high",
  "anthropic", "openai", "arnx", "setup", "review", "accept", "check"]);

/** Every string in the payload is an enumerated value or one of the top-level identity fields; every number a whole
 * number ≥ 0. */
function assertClean(body: Record<string, unknown>): void {
  expect(Object.keys(body).sort()).toEqual(TOP);
  expect(body.schema).toBe(1);
  expect(body.install_id).toMatch(UUID4);
  expect(body.arnx_version).toBe(VERSION);
  expect(body.os).toBe(process.platform);
  expect(body.arch).toBe(process.arch);
  expect(body.at).toMatch(ISO);
  const event = body.event as string;
  const data = body.data as Record<string, unknown>;
  expect(Object.keys(data).sort()).toEqual(DATA[event]!);
  const walk = (v: unknown, path: string): void => {
    if (typeof v === "string") expect(ENUMS.has(v) ? v : `${path}=${v}`).toBe(v);
    else if (typeof v === "number") expect(Number.isSafeInteger(v) && v >= 0 ? v : `${path}=${v}`).toBe(v);
    else if (typeof v === "boolean") return;
    else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
    else throw new Error(`${path}: ${String(v)}`);
  };
  walk(data, "data");
}

async function sendOne(event: "setup" | "review" | "accept" | "check", data: () => Record<string, unknown>) {
  const sent: { url: string; body: Record<string, unknown> }[] = [];
  const sender: Sender = async (url, body) => { sent.push({ url, body: JSON.parse(body) }); };
  await reportTelemetry(home(true), event, data, { open: true, configured: true, sender });
  expect(sent).toHaveLength(1);
  expect(sent[0]!.url).toBe("https://api.arnx.dev/v1/telemetry");
  assertClean(sent[0]!.body);
  return sent[0]!.body.data as Record<string, unknown>;
}

test("setup payload: projects, languages, approved, cost in micro-dollars, whole seconds", async () => {
  const data = await sendOne("setup", () => setupData({ languages: ["rust", "python", "python", "csharp"],
    approved: true, costUsd: 0.4567891, seconds: 61.6 }));
  expect(data).toEqual({ projects: 4, languages: ["python", "rust", "csharp"], approved: true,
    cost_micro_usd: 456789, seconds: 62 });
});

test("review payload: counts only, providers not models, before/after counts", async () => {
  const review = sampleReview({
    findings: [
      { ...finding("F1", "t::a", "a", "f.py", "m", "e", "confirmed"), before: { status: "regression", detail: "d", runs: [] } },
      { ...finding("F2", "t::b", "b", "f.py", "m", "e", "disputed"), before: { status: "new-code", detail: "d", runs: [] } },
      { ...finding("F3", "t::c", "c", "f.py", "m", "e", null), before: { status: "pre-existing", detail: "d", runs: [] } },
      finding("F4", "t::d", "d", "f.py", "m", "e", "confirmed"),
    ],
    usage: [{ model: "anthropic:x", calls: 3, unknownCalls: 1, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.3 },
      { model: "openai:y", calls: 2, unknownCalls: 2, input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 0.04 }],
    suspects: [{ project: "main", id: "S1", file: "f.py", line: 1, claim: "c", by: "r", outcome: "failed", tests: [] }],
    projects: ["api", "web"],
  });
  const providers = { myprovider: { api: "responses" as const, url: "https://llm.example.com/v1", key_env: "MY_KEY" } };
  const s = { ...defaultSettings(), effort: "high", providers, secondHunter: parseModelRef("openai:gpt-6.1-sol"),
    challenger: parseModelRef("myprovider:some-model", providers) };
  const data = await sendOne("review", () => reviewData(review, { settings: s, languages: ["typescript", "python"],
    diffBytes: 5000 }));
  expect(data).toEqual({ languages: ["python", "typescript"], projects: 2, files_changed: 4, diff_kb: 5,
    effort: "high", providers: ["anthropic", "openai", "other"], findings: 4, confirmed: 2, disputed: 1, unjudged: 1,
    questions: 1, tests_written: 6, passed: 3, flaky: 1, errors: 0, suspects: 1, cost_micro_usd: 340000,
    unknown_calls: 3, seconds: 171, exit_code: 1,
    before: { regression: 1, pre_existing: 1, new_code: 1, changed: 0, unknown: 0 } });
});

test("review payload: an effort or provider outside the schema is folded into it, never sent as text", () => {
  const providers = { myprovider: { api: "messages" as const, url: "https://llm.example.com", key_env: "MY_KEY" } };
  const s = { ...defaultSettings(), effort: "xhigh", providers,
    challenger: parseModelRef("myprovider:some-model", providers) };
  const data = reviewData(sampleReview({ findings: [], flaky: [] }), { settings: s, languages: ["csharp"], diffBytes: 1 });
  expect(data.effort).toBe("high");
  expect(data.diff_kb).toBe(1);
  expect(data.providers).toEqual(["anthropic", "other"]);
  expect(reviewData(sampleReview(), { settings: { ...s, effort: "none" }, languages: [], diffBytes: 0 }).effort)
    .toBe("low");
  expect(reviewData(sampleReview(), { settings: { ...s, effort: "odd" }, languages: [], diffBytes: 0 }).effort)
    .toBe("medium");
});

test("accept payload: marks and how they were made, answers, kept tests", async () => {
  const review = sampleReview({ findings: ["F1", "F2", "F3", "F4", "F5"].map((id) => finding(id, `t::${id}`, id, "f.py",
    "m", "e", "confirmed")), questions: ["q1", "q2", "q3"] });
  const data = await sendOne("accept", () => acceptData({ review,
    marks: { findings: { F1: "real", F2: "real", F3: "intended", F4: "noise" }, answers: { Q1: "yes", Q3: "no" },
      severity: {} },
    sources: { F1: "default", F2: "chosen", F3: "chosen", F4: "chosen", F5: "chosen" } }, 2));
  expect(data).toEqual({ real: 2, intended: 1, noise: 1, unmarked: 1, chosen: 4, defaulted: 1, answers: 2,
    kept_tests: 2 });
});

test("check payload: test counts, whole seconds, exit code", async () => {
  const data = await sendOne("check", () => checkData([
    { project: "a", files: ["x"], passed: ["t1", "t2"], failed: [{ testId: "t3", outcome: "failed", message: "m",
      fileAttr: "" } as never], skipped: 1, noReport: false },
    { project: "b", files: ["y"], passed: [], failed: [], skipped: 0, noReport: true }], 2, 4.4));
  expect(data).toEqual({ tests: 4, passed: 2, failed: 1, skipped: 1, seconds: 4, exit_code: 2 });
});

test("a payload outside the schema is not sent at all", async () => {
  const sent: string[] = [];
  const sender: Sender = async (_u, b) => { sent.push(b); };
  const env = home(true);
  await reportTelemetry(env, "check", () => ({ ...checkData([], 3, 1), repo: "secret-name" }), { open: true, configured: true, sender });
  await reportTelemetry(env, "check", () => ({ ...checkData([], 3, 1), seconds: -1 }), { open: true, configured: true, sender });
  await reportTelemetry(env, "check", () => ({ ...checkData([], 3, 1), seconds: 1.5 }), { open: true, configured: true, sender });
  await reportTelemetry(env, "setup", () => ({ ...setupData({ languages: ["path/to/x"], approved: false, costUsd: 0,
    seconds: 0 }), languages: ["path/to/x"] }), { open: true, configured: true, sender });
  const { seconds: _drop, ...missing } = checkData([], 3, 1);
  await reportTelemetry(env, "check", () => missing, { open: true, configured: true, sender });
  await reportTelemetry(env, "check", () => { throw new Error("boom"); }, { open: true, configured: true, sender });
  expect(sent).toEqual([]);
});

// --- the commands send, never block, never change the exit code -----------------------------------------------------

const servers: { stop(force?: boolean): void }[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

/** A local endpoint that records each request; `delayMs` holds the answer back, `status` is what it answers. */
function endpoint(o: { delayMs?: number; status?: number } = {}) {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    bodies.push(await req.json() as Record<string, unknown>);
    if (o.delayMs) await new Promise((r) => setTimeout(r, o.delayMs));
    return new Response(null, { status: o.status ?? 204 });
  } });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}/v1/telemetry`, bodies };
}

/** A repository with config, an approved environment and one accepted test file. */
let repos = 0;
function readyRepo(): string {
  const repo = gitRepo(join(tmp(), `r${++repos}`));
  mkdirSync(join(repo, "svc/tests/arnx/r1"), { recursive: true });
  writeFileSync(join(repo, "svc/calc.py"), "X = 1\n");
  writeFileSync(join(repo, "svc/tests/arnx/r1/test_r1_calc.py"), "def test_ok(): pass\ndef test_bug(): assert 0\n");
  mkdirSync(join(repo, ".arnx"));
  writeFileSync(reviewConfigPath(repo), stampFile(parseReviewFile(`version: 1
projects:
  svc:
    root: svc
    image: python:3.12-slim
    test_command: python -m pytest {targets}
`), "Dev", "2026-10-12"));
  commit(repo, "layout");
  return repo;
}

const fakeCheck: SessionFactory = async (_c, snap, _l, body) => body(new FakeSession(snap, () => [junitXml([
  ["tests/arnx/r1/test_r1_calc.py", "test_ok", "passed", ""],
  ["tests/arnx/r1/test_r1_calc.py", "test_bug", "failed", "assert 0"]]), "1 failed", false]));

async function runCheck(env: Record<string, string>): Promise<{ code: number; ms: number }> {
  const repo = readyRepo();
  await new Cli({ ...OPEN, cwd: repo, env }).run("init");
  turnOn(repo);
  const started = performance.now();
  const code = await new Cli({ ...OPEN, cwd: repo, env, checkSessions: fakeCheck }).run("check");
  return { code, ms: performance.now() - started };
}

test("check sends one check event to ARNX_TELEMETRY_URL when on", async () => {
  const ep = endpoint();
  const { code } = await runCheck({ ...home(true), ARNX_TELEMETRY_URL: ep.url });
  expect(code).toBe(1);
  expect(ep.bodies).toHaveLength(1);
  assertClean(ep.bodies[0]!);
  expect(ep.bodies[0]!.event).toBe("check");
  expect(ep.bodies[0]!.data).toMatchObject({ tests: 2, passed: 1, failed: 1, skipped: 0, exit_code: 1 });
});

test("off (telemetry = false, the default, or forced off): no request at all", async () => {
  const ep = endpoint();
  for (const env of [{ ...home(), DO_NOT_TRACK: "1" }, { ...home(), ARNX_TELEMETRY: "0" }]) {
    expect((await runCheck({ ...env, ARNX_TELEMETRY_URL: ep.url })).code).toBe(1);
  }
  const repo = readyRepo();
  const env = { ...home(), ARNX_TELEMETRY_URL: ep.url };
  await new Cli({ ...OPEN, cwd: repo, env }).run("init");
  expect(await new Cli({ ...OPEN, cwd: repo, env, checkSessions: fakeCheck }).run("check")).toBe(1);
  expect(ep.bodies).toEqual([]);
});

test("a slow endpoint delays a command by at most ~2 s and never changes its exit code", async () => {
  const ep = endpoint({ delayMs: 8000 });
  const { code, ms } = await runCheck({ ...home(true), ARNX_TELEMETRY_URL: ep.url });
  expect(code).toBe(1);
  expect(ep.bodies).toHaveLength(1);
  expect(ms).toBeLessThan(3500);
  expect(ms).toBeGreaterThan(1500); // the send is awaited (main exits right after), only for its time limit
}, 15_000);

test("a failing or absent endpoint changes nothing", async () => {
  const failing = endpoint({ status: 500 });
  expect((await runCheck({ ...home(true), ARNX_TELEMETRY_URL: failing.url })).code).toBe(1);
  expect(failing.bodies).toHaveLength(1);
  // Nothing listens on port 9 (discard) here; the connection is refused or times out within the limit.
  const { code, ms } = await runCheck({ ...home(true), ARNX_TELEMETRY_URL: "http://127.0.0.1:9/v1/telemetry" });
  expect(code).toBe(1);
  expect(ms).toBeLessThan(3500);
  expect((await runCheck({ ...home(true), ARNX_TELEMETRY_URL: "not a url" })).code).toBe(1);
}, 15_000);

test("a sender that throws at once or never settles is swallowed within the limit", async () => {
  const env = home(true);
  await reportTelemetry(env, "check", () => checkData([], 3, 1), { open: true,
    sender: () => { throw new Error("x"); } });
  const started = performance.now();
  await reportTelemetry(env, "check", () => checkData([], 3, 1), { open: true, configured: true, sender: () => new Promise(() => {}),
    timeoutMs: 200 });
  expect(performance.now() - started).toBeLessThan(1000);
});

test("accept sends one accept event with the marks as counts", async () => {
  const ep = endpoint();
  const repo = gitRepo(tmp());
  const env = { ...home(true), ARNX_TELEMETRY_URL: ep.url };
  const cli = new Cli({ ...OPEN, cwd: repo, env });
  await cli.run("init");
  turnOn(repo);
  const rdir = join(repo, ".arnx", "reviews", "20261011-a1b2c3");
  save(sampleReview({ change: "commit abc", findings: [
    finding("F1", "tests/g/test_a.py::test_a", "test_a", "tests/g/test_a.py", "x", "y", "confirmed"),
    finding("F2", "tests/g/test_a.py::test_b", "test_b", "tests/g/test_a.py", "x", "z", "disputed")],
  questions: [], flaky: [], writeDir: "tests/g" }), rdir, "d");
  mkdirSync(join(rdir, "tests", "tests", "g"), { recursive: true });
  writeFileSync(join(rdir, "tests", "tests", "g", "test_a.py"), "def test_a():\n    assert False\n\ndef test_b():\n    assert False\n");
  writeFileSync(join(rdir, "review.md"), blankMarks(readFileSync(join(rdir, "review.md"), "utf8"))
    .replace("Mark: [ ] real", "Mark: [x] real"));
  expect(await cli.run("accept", "--no-answers")).toBe(0);
  expect(ep.bodies).toHaveLength(1);
  assertClean(ep.bodies[0]!);
  expect(ep.bodies[0]!.data).toEqual({ real: 1, intended: 0, noise: 0, unmarked: 1, chosen: 0, defaulted: 2,
    answers: 0, kept_tests: 1 });
});

test("the tests' default (no config dir in the environment) sends nothing and asks nothing", async () => {
  const asked: string[] = [];
  const sent: string[] = [];
  const repo = readyRepo();
  const cli = new Cli({ cwd: repo, env: {}, interactive: true, ask: async (q) => (asked.push(q), "y"),
    checkSessions: fakeCheck, telemetrySender: async (_u, b) => { sent.push(b); } });
  await cli.run("init");
  await cli.run("check");
  expect(asked.filter((q) => /usage counts/.test(q))).toEqual([]);
  expect(sent).toEqual([]);
});
