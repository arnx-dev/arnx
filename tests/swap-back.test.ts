// A model works among stand-ins, and its tests and tool inputs must act as if they held the real values: each stand-in of
// a value real where tests run comes back when text from a model meets real files, and nothing real is kept or recorded.
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Workspace } from "../src/agent";
import { Boundary, type Swap } from "../src/boundary";
import { takeSnapshot } from "../src/change";
import { check } from "../src/check";
import { ArnxError } from "../src/errors";
import { parseReviewConfig, reviewConfigPath, stamp, stampFile, parseReviewFile } from "../src/config";
import type { AgentModel, Block, JsonModel, Reply } from "../src/llm";
import { recheckReview } from "../src/recheck";
import { BASELINE_FILE } from "../src/baseline";
import { runReview } from "../src/reviewer";
import { DEFAULT_LIMITS, dockerfile, dockerSteps, type ExecFactory, type Runner, sandboxOptions, Session,
  type SessionFactory } from "../src/sandbox";
import { fake } from "../src/secrets";
import { defaultSettings, type Settings, writeSettings } from "../src/settings";
import { approveFile, runSetup } from "../src/setup";
import { SetupExec } from "../src/setupexec";
import { dockerSession, testRound, typecheckRound } from "../src/testround";
import { Cli } from "./helpers/cli";
import { FakeSession, ScriptedAgent, text, tool } from "./helpers/fakes";
import { commit, gitRepo } from "./helpers/gitutil";
import { junitXml } from "./helpers/junit";
import { useTmp } from "./helpers/tmp";
import { spawnSync } from "node:child_process";
import { blankMarks } from "./helpers/review";
import { accept } from "../src/accept";

const tmp = useTmp();
/** A guess: real in the snapshot, a stand-in to every model. */
const GUESS = "Zq7xK2mP9vR4tY1w";
/** Key-shaped: a stand-in in the snapshot too. */
const KEY = ["sk", "ant", "api03", "Wm4Tz8Qn2Xv6Bc9Lk3Jh7Pd1Rf5Sg0Yt"].join("-");
const SHOWN = fake(GUESS, new Map());
const SHOWN_KEY = fake(KEY, new Map());
const YAML = "version: 1\nimage: python:3.12-slim\ntest_command: python -m pytest -q {targets}\n";
const GEN = "tests/arnx_generated/test_v.py";
const SETTINGS: Settings = { ...defaultSettings(), beforeCheck: false, consentAt: "2026-11-04T00:00:00Z" };

const write = (dir: string, files: Record<string, string>) => {
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
};

/** The code holds a guess and a key, and the change touches neither. */
let repos = 0;
function valueRepo(yaml = YAML): string {
  const at = join(tmp(), `r${++repos}`);
  mkdirSync(at);
  const repo = gitRepo(at);
  mkdirSync(dirname(reviewConfigPath(repo)));
  writeFileSync(reviewConfigPath(repo), yaml.includes("projects:") ? stampFile(parseReviewFile(yaml), "Dev", "2026-11-04")
    : stamp(parseReviewConfig(yaml), "Dev", "2026-11-04"));
  writeSettings(repo, SETTINGS);
  write(repo, { "settings.py": `db_password = "${GUESS}"\nAPI_KEY = "${KEY}"\n`, "app.py": "def add(a, b):\n    return a + b\n" });
  commit(repo, "the code");
  writeFileSync(join(repo, "app.py"), "def add(a, b):\n    return a + b + 0\n");
  return repo;
}

/** Holds everything a model was asked. */
class Recording implements AgentModel {
  model = "claude-sonnet-5-5";
  notice?: (message: string) => void;
  bodies: string[] = [];
  constructor(private steps: Block[][], private last: string) {}
  async create(a: Parameters<AgentModel["create"]>[0]): Promise<Reply> {
    this.bodies.push(JSON.stringify(a));
    const blocks = this.steps.shift() ?? [text(this.last)];
    return { content: blocks, usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0 }, raw: blocks,
      stopReason: blocks.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn" };
  }
}
const judge = { ref: "openai:x", completeJson: async () => [{ verdict: "confirmed", reason: "wrong", groups: [] }, 0.01] } as
  unknown as JsonModel;
const reportOf = (names: string[], defects: string[] = []) => JSON.stringify({
  tests: names.map((n) => ({ test: `${GEN}::${n}`, expects: n })),
  suspected_defects: defects.map((n) => ({ test: `${GEN}::${n}`, explanation: `${n} is wrong.` })), questions: [] });

/** Every file under `dir`, and its text. */
function allUnder(dir: string): [string, string][] {
  if (!existsSync(dir)) return [];
  return (readdirSync(dir, { recursive: true }) as string[]).map((p) => p.split("\\").join("/"))
    .filter((p) => statSync(join(dir, p)).isFile()).map((p) => [p, readFileSync(join(dir, p), "utf8")]);
}
function expectNoReal(what: string, text: string): void {
  for (const form of [GUESS, GUESS.toUpperCase(), GUESS.toLowerCase(), Buffer.from(GUESS).toString("hex"),
    Buffer.from(GUESS).toString("base64").replace(/=+$/, "")]) {
    if (text.includes(form)) throw new Error(`${what} holds a real value: ${form}`);
  }
}

/** A fake session on `snap` that keeps its session's swap, and reads the test as a run would. */
function runningFactory(script: (snap: string, command: string) => [string | null, string, boolean],
  o: { baked?: boolean; seen?: { snap: string; swap?: Swap; swapped?: string; cfgEnv: Record<string, string> }[] } = {}): SessionFactory {
  return (async <T>(cfg: { env: Record<string, string> }, snap: string, _log: string, body: (r: Runner) => Promise<T>,
                    _from?: string, _key?: string, swap?: Swap) => {
    o.seen?.push({ snap, swap, cfgEnv: cfg.env, ...(swap ? { swapped: swap.text(SHOWN) } : {}) });
    const s = new FakeSession(snap, (c) => script(snap, c));
    const runner: Runner = o.baked ? { run: (c) => s.run(c), copies: () => ({ roots: [], text: "" }) as never } : s;
    return body(runner);
  }) as unknown as SessionFactory;
}
const testPasses = (expected: string) => (snap: string) => {
  const held = readFileSync(join(snap, GEN), "utf8").includes(expected);
  return [junitXml([[GEN, "test_v", held ? "passed" : "failed", held ? "" : `no ${expected}`]]), held ? "1 passed" : "1 failed",
    false] as [string | null, string, boolean];
};

// --- the filter ------------------------------------------------------------------------------------------------------

test("a stand-in comes back wherever it stands: twice, inside a longer word, beside another", () => {
  const other = "Hb3nW8sL5cT2jF6g";
  const b = new Boundary([GUESS, other]);
  const shownOther = b.mask(other);
  expect(b.unmask(`${SHOWN} x${SHOWN}y ${shownOther} ${SHOWN}`)).toBe(`${GUESS} x${GUESS}y ${other} ${GUESS}`);
  expect(b.unmask("nothing here")).toBe("nothing here");
});

test("only a value real where tests run comes back: a certain value's stand-in is what the code holds", () => {
  const repo = gitRepo(tmp());
  write(repo, { "settings.py": `db_password = "${GUESS}"\nAPI_KEY = "${KEY}"\n` });
  commit(repo, "x");
  const at = join(tmp(), "snap");
  const taken = takeSnapshot(repo, null, at, []);
  expect(readFileSync(join(at, "settings.py"), "utf8")).toContain(SHOWN_KEY);
  const b = new Boundary();
  b.addScrubbed(taken);
  expect(b.unmask(`${SHOWN} ${SHOWN_KEY}`)).toBe(`${GUESS} ${SHOWN_KEY}`);
  // Told in the other order, or by a later snapshot, it is the same.
  const c = new Boundary([KEY, GUESS]);
  c.addScrubbed(taken);
  expect(c.unmask(SHOWN_KEY)).toBe(SHOWN_KEY);
});

test("with stand-ins off every value is real where tests run, so each comes back", () => {
  const repo = gitRepo(tmp());
  write(repo, { "settings.py": `db_password = "${GUESS}"\n`, ".arnx/config.toml": "" });
  commit(repo, "x");
  const taken = takeSnapshot(repo, null, join(tmp(), "off"), [], { standIns: false });
  const b = new Boundary();
  b.addScrubbed(taken);
  expect(b.unmask(SHOWN)).toBe(GUESS);
});

test("a value told after the first look still comes back", () => {
  const b = new Boundary([GUESS]);
  expect(b.unmask("x")).toBe("x");
  const later = "Hb3nW8sL5cT2jF6g";
  b.add([later]);
  expect(b.unmask(fake(later, new Map()))).toBe(later);
});

test("a certain value on a side of the diff stays a stand-in; a guess there comes back", () => {
  const b = new Boundary();
  b.addDiff(`diff --git a/s.py b/s.py\n--- a/s.py\n+++ b/s.py\n@@ -1,2 +1,1 @@\n-API_KEY = "${KEY}"\n-db_password = "${GUESS}"\n+x = 1\n`);
  expect(b.mask(`${KEY} ${GUESS}`)).toBe(`${SHOWN_KEY} ${SHOWN}`);
  expect(b.unmask(`${SHOWN_KEY} ${SHOWN}`)).toBe(`${SHOWN_KEY} ${GUESS}`);
});

test("a stand-in keeps its value's shape, so it is looked for only among values of that shape", () => {
  const shape = (s: string) => s.replace(/[0-9]/g, "0").replace(/[A-Z]/g, "A").replace(/[a-z]/g, "a");
  for (const v of [GUESS, KEY, "0xDEADbeef1234", "0b101101010n", "0o17777777", `AKIA${"IOSFODNN7EXAMPLE"}`,
    `ghp_${"16C7e42F292c6912E7710c838347Ae178B4a"}`, "whsec_abcDEF123456", "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    "Pa(ss)w0rd!", "pw3rty@", `xoxb-${"123456-abcdef"}`, "café-Latte99"]) {
    const s = fake(v, new Map());
    expect([v, shape(s)]).toEqual([v, shape(v)]);
    expect(new Boundary([v]).unmask(s)).toBe(s === v ? s : v);
  }
});

test("each form of a value comes back as that form", () => {
  const v = 'Ab"c/d e9Kq2Lm7Xw';
  const b = new Boundary([v]);
  for (const form of [v, JSON.stringify(v).slice(1, -1), encodeURIComponent(v)]) {
    expect(b.unmask(b.mask(form))).toBe(form);
  }
});

test("masking what came back gives what the model wrote: nothing real is kept by the round trip", () => {
  const b = new Boundary([GUESS]);
  const written = `assert x == "${SHOWN}"\nprint("${SHOWN}")\n`;
  expect(b.mask(b.unmask(written))).toBe(written);
});

test("a stand-in that real files hold stays as written, in a file or in a file's name", () => {
  const b = new Boundary([GUESS, "Hb3nW8sL5cT2jF6g"]);
  const other = b.mask("Hb3nW8sL5cT2jF6g");
  // Elsewhere in the code, by chance: it means itself.
  const inFile = write(join(tmp(), "a"), { "lib/data.txt": `id ${SHOWN}\n`, "lib/ok.py": "x = 1\n" });
  const swap = b.swapFor(inFile);
  expect(swap.text(`${SHOWN} ${other}`)).toBe(`${SHOWN} Hb3nW8sL5cT2jF6g`);
  const inName = write(join(tmp(), "b"), { [`lib/${SHOWN}.txt`]: "x\n" });
  expect(b.swapFor(inName).text(SHOWN)).toBe(SHOWN);
  // A file the model wrote is not real text.
  const ours = write(join(tmp(), "c"), { [GEN]: `x = "${SHOWN}"\n` });
  expect(b.swapFor(ours).text(SHOWN)).toBe(SHOWN);
  expect(b.swapFor(ours, (rel) => rel === GEN).text(SHOWN)).toBe(GUESS);
  const clean = write(join(tmp(), "d"), { "lib/ok.py": "x = 1\n" });
  expect(b.swapFor(clean).text(SHOWN)).toBe(GUESS);
});

test("an encoded or re-cased stand-in stays as written: only plain forms come back", () => {
  const b = new Boundary([GUESS]);
  b.mask(GUESS);
  const b64 = Buffer.from(SHOWN).toString("base64");
  const hex = Buffer.from(SHOWN).toString("hex");
  for (const form of [b64, hex, SHOWN.toUpperCase(), SHOWN.toLowerCase()]) expect(b.unmask(form)).toBe(form);
  // Still, what the text encodes when it runs is the plain form.
  expect(b.unmask(`base64.b64encode(b"${SHOWN}")`)).toBe(`base64.b64encode(b"${GUESS}")`);
});

test("a regular expression's stand-in comes back, as its value reads there", () => {
  const v = "Ab.c+d(9)Kq2Lm7Xw";
  const b = new Boundary([v]);
  const s = b.mask(v);
  const swap = b.swapFor(write(join(tmp(), "e"), { "a.txt": "x" }));
  const esc = (t: string) => t.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
  // Written bare, or escaped as a careful model does, it finds the value and nothing else.
  for (const pattern of [s, esc(s), `^x = "${esc(s)}"$`]) {
    const swapped = swap.pattern(pattern);
    expect(swapped).toContain(esc(v));
    expect(new RegExp(swapped).test(pattern.startsWith("^") ? `x = "${v}"` : v)).toBe(true);
  }
  expect(swap.pattern("a+b|c")).toBe("a+b|c");
});

/** How many of a boundary's values have been through the slow hash (2.5 ms each). */
const hashes = (b: Boundary) => (b as unknown as { made: Map<string, string> }).made.size;
const mixedValue = (i: number) => createHash("sha256").update(`${i}`).digest("hex").replace(/[a-f]/g, (c, at) => at % 2 ? c.toUpperCase() : c).slice(0, 24) + "Zq";

test("a text costs no value's hash but those of its shape: none with no stand-in, one for one", () => {
  const values = [...new Set(Array.from({ length: 19_000 }, (_, i) => mixedValue(i)))];
  expect(values.length).toBe(19_000);
  const b = new Boundary(values);
  const body = "def test_add():\n    assert add(2, 3) == 5  # a comment with ordinary words\n".repeat(2000);
  expect(b.unmask(body)).toBe(body);
  expect(hashes(b)).toBe(0);
  const v = values[values.length >> 1]!;
  expect(b.unmask(`x = "${fake(v, new Map())}"`)).toBe(`x = "${v}"`);
  expect(hashes(b)).toBeLessThan(10);
});

test("among many values of one shape, one a model was shown is found with no other's hash", () => {
  const values = Array.from({ length: 3000 }, (_, i) => `${i}`.padStart(16, "7"));
  const b = new Boundary(values);
  const s = b.mask(values[2999]!);
  expect(hashes(b)).toBe(1);
  expect(b.unmask(`n = ${s}`)).toBe(`n = ${values[2999]}`);
  expect(hashes(b)).toBe(1);
});

// --- what a model's tools read and write ----------------------------------------------------------------------------

const swapOn = (dir: string, b = new Boundary([GUESS])) => b.swapFor(dir, (rel) => rel.startsWith("tests/"));

test("grep finds the value by its stand-in, and read_file and list_dir find a path by theirs", async () => {
  const b = new Boundary([GUESS]);
  const root = write(join(tmp(), "w"), { "s.py": `db_password = "${GUESS}"\n`, [`data/${GUESS}/f.txt`]: "held\n" });
  const swap = swapOn(root, b);
  const ws = new Workspace(root, { reads: swap } as never);
  expect(await ws.call("grep", { pattern: SHOWN, path: "." })).toContain(`s.py:1: db_password = "${GUESS}"`);
  expect(await ws.call("read_file", { path: `data/${SHOWN}/f.txt` })).toContain("held");
  expect(await ws.call("list_dir", { path: `data/${SHOWN}` })).toBe("f.txt");
  // What it answers goes through the filter on its way out, the one way a reply holds the value.
  expect(b.mask(await ws.call("grep", { pattern: SHOWN, path: "." }) as string)).not.toContain(GUESS);
  const bare = new Workspace(root);
  expect(await bare.call("grep", { pattern: SHOWN, path: "." })).toBe("(no matches)");
  // An error says what the model sent.
  await expect(ws.call("read_file", { path: `no/${SHOWN}.py` })).rejects.toThrow(`not a file: no/${SHOWN}.py`);
});

test("write_file puts the value in the snapshot, or leaves the stand-in when runs read a copy holding it", async () => {
  const b = new Boundary([GUESS]);
  const root = write(join(tmp(), "w2"), { "s.py": `db_password = "${GUESS}"\n` });
  const swap = swapOn(root, b);
  const plain = new Workspace(root, { writeDir: "tests", reads: swap, writes: swap } as never);
  await plain.call("write_file", { path: "tests/test_a.py", content: `x = "${SHOWN}"\n` });
  expect(readFileSync(join(root, "tests/test_a.py"), "utf8")).toBe(`x = "${GUESS}"\n`);
  const baked = new Workspace(root, { writeDir: "tests", reads: swap } as never);
  await baked.call("write_file", { path: "tests/test_b.py", content: `x = "${SHOWN}"\n` });
  expect(readFileSync(join(root, "tests/test_b.py"), "utf8")).toBe(`x = "${SHOWN}"\n`);
  // A name holding a value would be kept under .arnx with it.
  await expect(plain.call("write_file", { path: `tests/test_${SHOWN}.py`, content: "x = 1\n" })).rejects.toThrow("name");
  expect(existsSync(join(root, `tests/test_${SHOWN}.py`))).toBe(false);
  expect(existsSync(join(root, `tests/test_${GUESS}.py`))).toBe(false);
});

// --- the session: env, test_command and exec come back where they run, and nowhere else ------------------------------

/** A docker that keeps its arguments, runs nothing, and echoes a run's last argument. */
function recordingDocker(): { calls: () => string[] } {
  const dir = tmp();
  writeFileSync(join(dir, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(dir, "calls")}'
case "$1" in
  image) echo '[]';;
  run|exec) for a; do last="$a"; done; printf '%s\\n' "$last";;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  return { calls: () => readFileSync(join(dir, "calls"), "utf8").split("\n") };
}

const ENV_YAML = `version: 1\nallow_env_names: [DB_PASSWORD, POSTGRES_PASSWORD]\nimage: python:3.12-slim\ninstall: ["pip install x --pass ${SHOWN}"]\n` +
  `test_command: DB=${SHOWN} python -m pytest -q {targets}\nservices:\n  db:\n    image: postgres:16-alpine\n` +
  `    env: {POSTGRES_PASSWORD: ${SHOWN}}\n    ready: pg_isready --pass ${SHOWN}\nenv:\n  DB_PASSWORD: ${SHOWN}\n  GEN: x\n`;

test("a session runs on real values inside its network, and what it logs holds the stand-in", async () => {
  const saved = { docker: sandboxOptions.docker, log: dockerSteps.log };
  const steps: string[] = [];
  try {
    const docker = recordingDocker();
    dockerSteps.log = (l) => void steps.push(JSON.stringify(l));
    const cfg = parseReviewConfig(ENV_YAML);
    const swap = new Boundary([GUESS]).swapFor(write(join(tmp(), "s"), { "a.py": "x\n" }));
    const session = await new Session("img", cfg, tmp(), DEFAULT_LIMITS, swap as never).start();
    const r = session.run(`python -m pytest ${SHOWN}`, 10);
    const e = session.exec(`echo ${SHOWN}`, 10);
    session.close();
    const calls = docker.calls().join("\n");
    expect(calls).toContain(`DB_PASSWORD=${GUESS}`);
    expect(calls).toContain(`POSTGRES_PASSWORD=${GUESS}`);
    expect(calls).toContain(`pg_isready --pass ${GUESS}`);
    expect(calls).toContain(`python -m pytest ${GUESS}`);
    expect(calls).toContain(`echo ${GUESS}`);
    expect(calls).not.toContain(SHOWN);
    // The network rules are as they were: no outside network for anything that holds a real value.
    expect(calls).toContain("network create --internal");
    for (const line of docker.calls().filter((l) => l.includes(GUESS) && l.startsWith("run"))) {
      expect(line).toMatch(/--network arnx-/);
    }
    expect(r.output + e.output).toContain(GUESS);
    expect(steps.join("\n")).toContain(SHOWN);
    expectNoReal("docker.jsonl", steps.join("\n"));
  } finally {
    sandboxOptions.docker = saved.docker;
    dockerSteps.log = saved.log;
  }
});

test("with no services a run keeps --network none, and without a swap it holds what it was given", async () => {
  const saved = sandboxOptions.docker;
  try {
    const docker = recordingDocker();
    const cfg = parseReviewConfig(`version: 1\nallow_env_names: [DB_PASSWORD]\nimage: i\ntest_command: python -m pytest {targets}\nenv: {DB_PASSWORD: ${SHOWN}}\n`);
    const swap = new Boundary([GUESS]).swapFor(write(join(tmp(), "s2"), { "a.py": "x\n" }));
    const session = await new Session("img", cfg, tmp(), DEFAULT_LIMITS, swap as never).start();
    session.run(`echo ${SHOWN}`, 10);
    session.close();
    const runs = docker.calls().filter((l) => l.includes(`DB_PASSWORD=${GUESS}`));
    expect(runs.length).toBeGreaterThan(0);
    for (const l of runs) expect(l).toContain("--network none");
    const off = await new Session("img", cfg, tmp()).start();
    off.run(`echo ${SHOWN}`, 10);
    off.close();
    expect(docker.calls().some((l) => l.includes(`DB_PASSWORD=${SHOWN}`) && l.includes(`echo ${SHOWN}`))).toBe(true);
  } finally {
    sandboxOptions.docker = saved;
  }
});

test("an image's install keeps the stand-in: a build has network", () => {
  expect(dockerfile(parseReviewConfig(ENV_YAML))).toContain(`pip install x --pass ${SHOWN}`);
  expect(dockerfile(parseReviewConfig(ENV_YAML))).not.toContain(GUESS);
});

const BAKED_YAML = `version: 1\nallow_env_names: [DB_PASSWORD]\nimage: python:3.12-slim\ninstall: ["cp -r . /opt/app"]\n` +
  `test_command: cd /opt/app && python -m pytest {targets}\nenv: {DB_PASSWORD: ${SHOWN}}\n`;

/** A docker whose image holds /opt/app/{a,b,c}.py, or nothing to find. */
function imageDocker(copy: boolean, hash: string): { calls: () => string[] } {
  const dir = tmp();
  const list = copy ? "printf '/opt/app/a.py\\n/opt/app/b.py\\n/opt/app/c.py\\n'" : "true";
  writeFileSync(join(dir, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(dir, "calls")}'
case "$1" in
  image) echo '[]';;
  run) case "$*" in
    *sha256sum*) cat > /dev/null; for f in a b c; do echo "${hash}  /opt/app/$f.py"; done;;
    *find\\ /*) ${list};;
    *) ;;
  esac;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  return { calls: () => readFileSync(join(dir, "calls"), "utf8").split("\n") };
}

test("a project whose tests run on a baked copy keeps stand-ins, as the copy does; one on the mounted code does not", async () => {
  const saved = { docker: sandboxOptions.docker, buildkit: sandboxOptions.buildkit };
  try {
    sandboxOptions.buildkit = false;
    const sha = "b".repeat(64);
    const cfg = parseReviewConfig(BAKED_YAML);
    const code = { "requirements.txt": `# ${Math.random()}\n`, "a.py": "1\n", "b.py": "2\n", "c.py": "3\n" };
    const b = new Boundary([GUESS]);
    const open = async (root: string) => {
      const snap = write(join(tmp(), root), code);
      let copies = false;
      const swap = b.swapFor(snap);
      await dockerSession(cfg, snap, join(tmp(), "b.log"), async (s) => {
        copies = !!s.copies;
        s.run(`echo ${SHOWN}`, 10);
        return null;
      }, undefined, `key-${root}`, swap);
      return copies;
    };
    const baked = imageDocker(true, sha);
    expect(await open("baked")).toBe(true);
    const inBaked = baked.calls().join("\n");
    expect(inBaked).toContain(`DB_PASSWORD=${SHOWN}`);
    expect(inBaked).toContain(`echo ${SHOWN}`);
    expect(inBaked).not.toContain(GUESS);
    const plain = imageDocker(false, sha);
    expect(await open("plain")).toBe(false);
    const inPlain = plain.calls().join("\n");
    expect(inPlain).toContain(`DB_PASSWORD=${GUESS}`);
    expect(inPlain).toContain(`echo ${GUESS}`);
  } finally {
    Object.assign(sandboxOptions, saved);
  }
});

// --- a round ---------------------------------------------------------------------------------------------------------

const round = async (repo: string, agent: AgentModel, factory: SessionFactory, boundary = new Boundary()) => {
  const cfg = parseReviewConfig(YAML);
  const { LocalBrain } = await import("../src/localbrain");
  const { PRICES } = await import("../src/llm");
  const brain = new LocalBrain({ agentModel: agent, prices: PRICES, boundary });
  return testRound(repo, null, cfg, { brain, ask: () => ({ kind: "answer" as const, input: { cfg, question: "q", answer: "a", diff: "" } }),
    writeDir: "tests/arnx_generated", budgetUsd: 5, runs: 1, outDir: join(tmp(), "out"), sessionFactory: factory });
};
const WROTE = (held: string): Block[][] => [[tool("write_file", { path: GEN, content: `x = "${held}"\n` }), tool("run_tests", {})]];

test("a round's test holds the real value where it runs, and its reply, record and saved copy hold the stand-in", async () => {
  const repo = valueRepo();
  const agent = new Recording(WROTE(SHOWN), reportOf(["test_v"]));
  const seen: { snap: string; swap?: Swap; swapped?: string; cfgEnv: Record<string, string> }[] = [];
  const r = await round(repo, agent, runningFactory(testPasses(GUESS), { seen }));
  expect(r.classified.passed.map((t) => t.testId)).toEqual([`${GEN}::test_v`]);
  expect(r.files[GEN]).toBe(`x = "${SHOWN}"\n`);
  expectNoReal("round", JSON.stringify(r));
  expect(seen[0]!.swap).toBeDefined();
});

test("a round on a baked copy leaves the test as written, so it passes against the copy's stand-in", async () => {
  const repo = valueRepo();
  const agent = new Recording(WROTE(SHOWN), reportOf(["test_v"]));
  const r = await round(repo, agent, runningFactory(testPasses(SHOWN), { baked: true }));
  expect(r.classified.passed.map((t) => t.testId)).toEqual([`${GEN}::test_v`]);
  expect(r.files[GEN]).toBe(`x = "${SHOWN}"\n`);
});

test("on a baked copy a test written with the stand-in does not stop a search finding the value", async () => {
  const repo = valueRepo();
  const agent = new Recording([...WROTE(SHOWN), [tool("grep", { pattern: SHOWN, path: "settings.py" })]], reportOf(["test_v"]));
  await round(repo, agent, runningFactory(testPasses(SHOWN), { baked: true }));
  expect(agent.bodies.join("\n")).toContain(`1: db_password = \\"${SHOWN}`);
});

test("a certain value's stand-in stays in a test: the code holds the stand-in", async () => {
  const repo = valueRepo();
  const agent = new Recording(WROTE(SHOWN_KEY), reportOf(["test_v"]));
  const r = await round(repo, agent, runningFactory(testPasses(SHOWN_KEY)));
  expect(r.classified.passed.length).toBe(1);
});

test("a run's parametrized id holding the value is the stand-in's in what the round says", async () => {
  const repo = valueRepo();
  const agent = new Recording(WROTE(SHOWN), reportOf(["test_v"]));
  const r = await round(repo, agent, runningFactory(() =>
    [junitXml([[GEN, `test_v[${GUESS}]`, "failed", `assert "${GUESS}"`]]), "1 failed", false]));
  expect(r.classified.findings.map((t) => t.testId)).toEqual([`${GEN}::test_v[${SHOWN}]`]);
});

test("the before/after check runs what the round ran, on the session's terms: a baked copy's stay among stand-ins", async () => {
  for (const baked of [false, true]) {
    const repo = valueRepo();
    commit(repo, "the change");
    const agent = new Recording(WROTE(SHOWN), reportOf(["test_v"], ["test_v"]));
    const seen: { snap: string; swap?: Swap; swapped?: string; cfgEnv: Record<string, string> }[] = [];
    const ran: string[] = [];
    const factory = runningFactory((snap) => {
      ran.push(readFileSync(join(snap, GEN), "utf8"));
      return [junitXml([[GEN, "test_v", "failed", "boom"]]), "1 failed", false];
    }, { baked, seen });
    await runReview(repo, { settings: { ...SETTINGS, beforeCheck: true }, agentModel: agent, challenger: judge, sessionFactory: factory });
    expect(seen.length).toBe(2);
    expect(ran.length).toBeGreaterThan(1);
    expect(ran.every((t) => t.includes(baked ? SHOWN : GUESS))).toBe(true);
    // The factory is told what it reads; a real session drops it for a baked copy (dockerSession).
    expect(seen[0]!.swap).toBeDefined();
    expect(!!seen[1]!.swap).toBe(!baked);
  }
});

test("the type check alone is told what its command means", async () => {
  const repo = valueRepo();
  const cfg = parseReviewConfig(`version: 1\nlanguage: typescript\nimage: node:22\ntest_command: npx vitest run {targets}\ntypecheck: tsc --noEmit\n`);
  const seen: { snap: string; swap?: Swap; swapped?: string; cfgEnv: Record<string, string> }[] = [];
  await typecheckRound(repo, null, cfg, { changed: [], outDir: join(tmp(), "tc"), boundary: new Boundary(),
    sessionFactory: runningFactory(() => [null, "", false], { seen }) });
  expect(seen[0]!.swapped).toBe(GUESS);
});

// --- what is kept, run again ------------------------------------------------------------------------------------------

/** A review with one failing test holding a stand-in, accepted; returns where it is. */
async function acceptedReview(failing = `test_v`) {
  const repo = valueRepo();
  const written = `x = "${SHOWN}"\n`;
  const agent = new Recording([[tool("write_file", { path: GEN, content: written }), tool("run_tests", {})]],
    reportOf([failing], [failing]));
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge,
    sessionFactory: runningFactory(() => [junitXml([[GEN, `${failing}`, "failed", "boom"]]), "1 failed", false]) });
  expect(review.findings.length).toBe(1);
  const md = blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replaceAll("Mark: [ ] real", "Mark: [x] real");
  writeFileSync(join(rdir, "review.md"), md);
  await accept(repo, rdir, SETTINGS, { answerRunner: null });
  return { repo, rdir };
}

/** The accepted test where a check put it. */
const placedTest = (snap: string) => allUnder(snap).find(([p]) => /test_v[^/]*\.py$/.test(p) && !p.startsWith(".arnx-run"));

test("an accepted test runs on the real value, and its kept file keeps the stand-in", async () => {
  const { repo } = await acceptedReview();
  const kept = allUnder(join(repo, ".arnx/tests"));
  expect(kept.length).toBeGreaterThan(0);
  expect(kept.some(([, t]) => t.includes(SHOWN))).toBe(true);
  expectNoReal(".arnx/tests", kept.map(([, t]) => t).join("\n"));
  const ran: string[] = [];
  const results = await check(repo, SETTINGS, { sessionFactory: runningFactory((snap) => {
    const [p, held] = placedTest(snap)!;
    ran.push(held);
    return [junitXml([[p, "test_v", held.includes(GUESS) ? "passed" : "failed", ""]]), "1 passed", false];
  }) });
  expect(ran.length).toBeGreaterThan(0);
  expect(ran.every((t) => t.includes(GUESS))).toBe(true);
  expect(results[0]!.failed).toEqual([]);
  expectNoReal(".arnx/tests after", allUnder(join(repo, ".arnx/tests")).map(([, t]) => t).join("\n"));
});

test("an accepted test on a baked copy keeps the stand-in where it runs", async () => {
  const { repo } = await acceptedReview();
  const ran: string[] = [];
  await check(repo, SETTINGS, { sessionFactory: runningFactory((snap) => {
    const [p, held] = placedTest(snap)!;
    ran.push(held);
    return [junitXml([[p, "test_v", "passed", ""]]), "1 passed", false];
  }, { baked: true }) });
  expect(ran.length).toBeGreaterThan(0);
  expect(ran.every((t) => t.includes(SHOWN) && !t.includes(GUESS))).toBe(true);
});

test("check --review runs a kept test on the real value", async () => {
  const { repo, rdir } = await acceptedReview();
  const ran: string[] = [];
  const r = await recheckReview(repo, rdir, SETTINGS, { sessionFactory: runningFactory((snap) => {
    ran.push(readFileSync(join(snap, GEN), "utf8"));
    return [junitXml([[GEN, "test_v", "passed", ""]]), "1 passed", false];
  }) });
  expect(ran.every((t) => t.includes(GUESS))).toBe(true);
  expect(r.findings[0]!.status).toBe("fixed");
});

test("check --review finds a parametrized test whose id holds a value: the run's id holds the real one", async () => {
  const repo = valueRepo();
  const param = `test_v[${SHOWN}]`;
  const agent = new Recording([[tool("write_file", { path: GEN, content: `x = "${SHOWN}"\n` }), tool("run_tests", {})]],
    reportOf([param], [param]));
  const failing = (): [string | null, string, boolean] => [junitXml([[GEN, `test_v[${GUESS}]`, "failed", "boom"]]), "1 failed", false];
  const { review, rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge,
    sessionFactory: runningFactory(failing) });
  expect(review.findings.map((f) => f.testId)).toEqual([`${GEN}::${param}`]);
  const r = await recheckReview(repo, rdir, SETTINGS, { sessionFactory: runningFactory(failing) });
  expect(r.findings.map((f) => f.status)).toEqual(["still-failing"]);
  const fixed = await recheckReview(repo, rdir, SETTINGS, { sessionFactory: runningFactory(() =>
    [junitXml([[GEN, `test_v[${GUESS}]`, "passed", ""]]), "1 passed", false]) });
  expect(fixed.findings.map((f) => f.status)).toEqual(["fixed"]);
});

test("check counts a parametrized accepted test whose run's id holds the value", async () => {
  const param = `test_v[${SHOWN}]`;
  const repo = valueRepo();
  const agent = new Recording([[tool("write_file", { path: GEN, content: `x = "${SHOWN}"\n` }), tool("run_tests", {})]],
    reportOf([param], [param]));
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge, sessionFactory: runningFactory(() =>
    [junitXml([[GEN, `test_v[${GUESS}]`, "failed", "boom"]]), "1 failed", false]) });
  const md = blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replaceAll("Mark: [ ] real", "Mark: [x] real");
  writeFileSync(join(rdir, "review.md"), md);
  await accept(repo, rdir, SETTINGS, { answerRunner: null });
  const results = await check(repo, SETTINGS, { sessionFactory: runningFactory((snap) => {
    const [p] = placedTest(snap)!;
    return [junitXml([[p, `test_v[${GUESS}]`, "failed", "boom"], [p, "test_helper", "passed", ""]]), "1 failed", false];
  }) });
  expect(results[0]!.failed.map((t) => t.testId.split("::")[1])).toEqual([param]);
  expect(results[0]!.accepted!.map((t) => t.split("::")[1])).toEqual([param]);
  expect(Object.keys(results[0]!.reviews ?? {}).length).toBe(1);
});

// --- setup -----------------------------------------------------------------------------------------------------------

const passing = (): [string | null, string, boolean] => [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), "1 passed", false];
const APP = (extra = "") => `version: 1\nallow_env_names: [DB_PASSWORD]\nprojects:\n  app:\n    root: .\n    image: python:3.12-slim\n` +
  `    test_command: python -m pytest -q {targets}\n${extra}`;

/** A container that runs each command on this machine, in `src`, as Session.exec does: swapped, output as it came. */
const hostBox = (asked: string[]): ExecFactory => (async (_image: string, _cfg: unknown, src: string, swap?: Swap) => ({
  exec: (command: string) => {
    asked.push(command);
    const r = spawnSync("sh", ["-c", swap ? swap.text(command) : command], { cwd: src, encoding: "utf8" });
    return { exitCode: r.status, output: r.stdout + r.stderr, timedOut: false, seconds: 0.1 };
  },
  close: () => {},
})) as unknown as ExecFactory;

function setupRepo(): string {
  const repo = gitRepo(tmp());
  write(repo, { "settings.py": `db_password = "${GUESS}"\nAPI_KEY = "${KEY}"\n`, "tests/test_a.py": "def test_a():\n    pass\n" });
  commit(repo, "the code");
  return repo;
}

test("exec: a stand-in in a command runs as the value, and an echo of it comes back masked", async () => {
  const repo = setupRepo();
  const out = join(tmp(), "setup");
  const asked: string[] = [];
  const agent = new Recording([[tool("try_project", { yaml: APP(), project: "app" })],
    [tool("exec", { project: "app", command: `echo ${SHOWN}; grep -c ${SHOWN} settings.py; printf %s ${SHOWN} | base64`, })],
    [tool("exec", { project: "app", command: `cat ${SHOWN}.txt`, cwd: "." })]], "done");
  await runSetup(repo, SETTINGS, agent, { outDir: out, sessionFactory: runningFactory(passing), execFactory: hostBox(asked) });
  // The command the tool got is what the model wrote; the run found the value.
  expect(asked[0]).toContain(SHOWN);
  const sent = agent.bodies.join("\n");
  expect(sent).toContain(`exit 0 after`);
  expectNoReal("setup's requests", sent);
  // grep -c found the one line that holds the real value.
  expect(sent).toMatch(new RegExp(`${SHOWN}\\\\n1\\\\n`));
  const files = allUnder(out);
  expect(files.some(([p]) => /exec-1\.log$/.test(p))).toBe(true);
  for (const [p, t] of files) expectNoReal(p, t);
  expect(files.find(([p]) => /exec-1\.log$/.test(p))![1]).toContain(SHOWN);
});

test("setup's search finds a value by its stand-in", async () => {
  const repo = setupRepo();
  const agent = new Recording([[tool("grep", { pattern: SHOWN, path: "." })]], "done");
  await runSetup(repo, SETTINGS, agent, { outDir: join(tmp(), "s"), sessionFactory: runningFactory(passing) });
  const sent = agent.bodies.join("\n");
  expect(sent).toContain(`settings.py:1: db_password = \\"${SHOWN}`);
  expectNoReal("setup's requests", sent);
});

test("exec on a baked copy keeps the stand-in, as its tests do", async () => {
  const repo = setupRepo();
  const asked: string[] = [];
  const agent = new Recording([[tool("try_project", { yaml: APP(), project: "app" })],
    [tool("exec", { project: "app", command: `echo ${SHOWN}` })]], "done");
  let swapped: unknown = "unset";
  const box: ExecFactory = (async (image: string, cfg: never, src: string, swap?: Swap) => {
    swapped = swap;
    return hostBox(asked)(image, cfg, src, swap as never);
  }) as never;
  await runSetup(repo, SETTINGS, agent, { outDir: join(tmp(), "s"), sessionFactory: runningFactory(passing, { baked: true }), execFactory: box });
  expect(swapped).toBeUndefined();
});

test("try_project and propose: the file keeps the stand-in, and a run gets the value", async () => {
  const repo = setupRepo();
  const out = join(tmp(), "setup");
  const yaml = APP(`    env: {DB_PASSWORD: ${SHOWN}}\n`);
  const agent = new Recording([[tool("try_project", { yaml, project: "app" })], [tool("propose", { yaml })]], "done");
  const seen: { snap: string; swap?: Swap; swapped?: string; cfgEnv: Record<string, string> }[] = [];
  const r = await runSetup(repo, SETTINGS, agent, { outDir: out, sessionFactory: runningFactory(passing, { seen }) });
  expect(r.ok).toBe(true);
  expect(r.yamlText).toContain(`DB_PASSWORD: ${SHOWN}`);
  expectNoReal("review.yaml", r.yamlText!);
  expect(seen[0]!.cfgEnv.DB_PASSWORD).toBe(SHOWN);
  expect(seen[0]!.swapped).toBe(GUESS);
  for (const [p, t] of allUnder(out)) expectNoReal(p, t);
});

test("approve runs a review.yaml holding a stand-in on the value, and writes no real value down", async () => {
  const repo = setupRepo();
  write(repo, { ".arnx/review.yaml": APP(`    env: {DB_PASSWORD: ${SHOWN}}\n`) });
  const seen: { snap: string; swap?: Swap; swapped?: string; cfgEnv: Record<string, string> }[] = [];
  const saved = sandboxOptions.docker;
  try {
    const [ok] = await approveFile(repo, { by: "Dev", at: "2026-11-04", sessionFactory: runningFactory(() =>
      [junitXml([["tests/test_a.py", "test_a", "passed", ""]]), `printed ${GUESS}`, false], { seen }) });
    expect(ok).toBe(true);
  } finally {
    sandboxOptions.docker = saved;
  }
  expect(seen[0]!.swapped).toBe(GUESS);
  for (const [p, t] of allUnder(join(repo, ".arnx"))) expectNoReal(p, t);
});

test("a suite's summary names no real value: a project's own failing test can hold one in its id", async () => {
  const repo = setupRepo();
  write(repo, { ".arnx/review.yaml": APP() });
  const [ok, said, suites] = await approveFile(repo, { by: "Dev", at: "2026-11-04", sessionFactory: runningFactory(() =>
    [junitXml([["tests/test_a.py", "test_a", "passed", ""], ["tests/test_a.py", `test_b[${GUESS}]`, "failed", ""]]), "1 failed", false]) });
  expect(ok).toBe(false);
  expect(said).toContain("test_b");
  expectNoReal("what approve says", said + suites.map((x) => x.summary).join("\n"));
});

test("SetupExec masks what a command prints in its log and its answer, the value's forms too", async () => {
  const snap = write(join(tmp(), "snap"), { "a.py": "x\n" });
  const b = new Boundary([GUESS]);
  const out = join(tmp(), "log");
  const tried = new Map([["app", { cfg: parseReviewConfig(YAML), image: "i", env: "e" }]]);
  const exec = new SetupExec({ snap, dir: join(tmp(), "ex"), outDir: out, tried, say: () => {},
    factory: hostBox([]), boundary: b, swapOf: () => b.swapFor(snap) } as never);
  const said = await exec.call({ project: "app", command: `echo ${SHOWN}; printf %s ${SHOWN} | base64; ` +
    `printf %s ${SHOWN} | tr a-z A-Z; echo; printf %s ${SHOWN} | tr A-Z a-z; echo; printf %s ${SHOWN} | od -An -tx1 | tr -d ' \\n'` });
  exec.close();
  expectNoReal("the answer", said);
  expect(said).toContain(SHOWN);
  expectNoReal("the log", readFileSync(join(out, "exec-1.log"), "utf8"));
});

// --- the canary, at the outermost layer that records ---------------------------------------------------------------

test("canary: a whole review with stand-ins in every tool input leaves no real value in a request or under .arnx", async () => {
  const repo = valueRepo();
  const steps: Block[][] = [
    [tool("grep", { pattern: SHOWN, path: "." }), tool("read_file", { path: "settings.py" })],
    [tool("write_file", { path: GEN, content: `x = "${SHOWN}"\n` }), tool("run_tests", { targets: [GEN] })],
  ];
  const agent = new Recording(steps, reportOf(["test_v"], ["test_v"]));
  const bodies: string[] = [];
  const recordingJudge = { ref: "openai:x", completeJson: async (system: string, user: string) => {
    bodies.push(system, user);
    return [{ verdict: "confirmed", reason: "wrong", groups: [] }, 0.01];
  } } as unknown as JsonModel;
  let ranReal = false;
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: recordingJudge,
    sessionFactory: runningFactory((snap) => {
      ranReal ||= readFileSync(join(snap, GEN), "utf8").includes(GUESS);
      // A run prints the value it was given, and its report quotes it.
      return [junitXml([[GEN, `test_v`, "failed", `assert "${GUESS}" == 1`]]), `E  ${GUESS}\n1 failed`, false];
    }) });
  expect(ranReal).toBe(true);
  const sent = [...agent.bodies, ...bodies].join("\n");
  expect(sent).toContain(SHOWN);
  expectNoReal("the requests", sent);
  // The grep did find the value: its line came back with the stand-in.
  expect(sent).toContain(`settings.py:1: db_password = \\"${SHOWN}\\"`);
  const kept = allUnder(join(repo, ".arnx"));
  expect(kept.some(([p]) => p.endsWith("events.jsonl"))).toBe(true);
  expect(kept.some(([p]) => p.endsWith("transcript.jsonl"))).toBe(true);
  for (const [p, t] of kept) expectNoReal(p, t);
  void rdir;
});


// --- an image made while a test holds a real value ----------------------------------------------------------------------

/** A docker with no image at all, which keeps its calls. */
function noImageDocker(): { calls: () => string[] } {
  const dir = tmp();
  writeFileSync(join(dir, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> '${join(dir, "calls")}'
case "$1" in
  info) echo 29;;
  image) exit 1;;
esac
exit 0
`);
  chmodSync(join(dir, "docker"), 0o755);
  sandboxOptions.docker = join(dir, "docker");
  return { calls: () => readFileSync(join(dir, "calls"), "utf8").split("\n") };
}

test("a session on another snapshot's image never builds one: the snapshot it names may hold a real value in a test", async () => {
  const saved = { docker: sandboxOptions.docker, buildkit: sandboxOptions.buildkit };
  try {
    sandboxOptions.buildkit = false;
    const docker = noImageDocker();
    const cfg = parseReviewConfig(YAML);
    const head = write(join(tmp(), "head"), { "requirements.txt": "x\n", [GEN]: `x = "${GUESS}"\n` });
    await expect(dockerSession(cfg, join(tmp(), "base"), join(tmp(), "b.log"), async () => null, head, "somekey"))
      .rejects.toThrow("its test image is gone");
    expect(docker.calls().some((c) => c.startsWith("build"))).toBe(false);
    // Its own snapshot is still what an image is built from.
    await dockerSession(cfg, head, join(tmp(), "b.log"), async () => null);
    expect(docker.calls().some((c) => c.startsWith("build"))).toBe(true);
  } finally {
    Object.assign(sandboxOptions, saved);
  }
});

test("when the image is gone the failing tests are not checked before the change, and the review goes on", async () => {
  const repo = valueRepo();
  commit(repo, "the change");
  const agent = new Recording(WROTE(SHOWN), reportOf(["test_v"], ["test_v"]));
  let sessions = 0;
  const failing = runningFactory(() => [junitXml([[GEN, "test_v", "failed", "boom"]]), "1 failed", false]);
  const factory = (async (...a: Parameters<SessionFactory>) => {
    if (++sessions > 1) throw new ArnxError("app: its test image is gone");
    return failing(...a);
  }) as unknown as SessionFactory;
  const { review } = await runReview(repo, { settings: { ...SETTINGS, beforeCheck: true }, agentModel: agent, challenger: judge,
    sessionFactory: factory });
  expect(sessions).toBe(2);
  expect(review.findings.length).toBe(1);
  expect(review.findings[0]!.before).toMatchObject({ status: "unknown" });
  expect(review.findings[0]!.before!.detail).toContain("not checked");
  expect(review.findings[0]!.before!.detail).toContain("its test image is gone");
});

// --- what setup records from a project's own tests ------------------------------------------------------------------------

const QUOTING: [string, string, string, string][] = [["tests/test_a.py", "test_a", "passed", ""],
  ["tests/test_a.py", "test_d", "passed", ""], ["tests/test_a.py", "test_e", "passed", ""],
  ["tests/test_a.py", `test_b[${GUESS}]`, "failed", `assert "${GUESS}" == "x"`],
  ["tests/test_a.py", "test_c", "failed", `Error: password ${GUESS} refused`]];
const quotingSuite = () => runningFactory(() => [junitXml(QUOTING), `E  ${GUESS}\n`, false]);
const ENV = { ANTHROPIC_API_KEY: "a" };

/** Every file under .arnx, the ones git would commit named. */
function committable(repo: string): string[] {
  const all = allUnder(join(repo, ".arnx")).map(([p]) => `.arnx/${p}`);
  const ignored = spawnSync("git", ["-C", repo, "check-ignore", "--stdin"], { input: all.join("\n"), encoding: "utf8" }).stdout;
  return all.filter((p) => !ignored.split("\n").includes(p));
}

function expectBaselineClean(repo: string): void {
  const text = readFileSync(join(repo, BASELINE_FILE), "utf8");
  expect(text).toContain(`test_b[${SHOWN}]`);
  expect(text).toContain(`assert \\"${SHOWN}\\"`);
  expect(text).toContain(`password ${SHOWN} refused`);
  for (const [p, t] of allUnder(join(repo, ".arnx"))) expectNoReal(p, t);
}

test("setup --baseline records no real value, and the next proof matches a run's real id to it", async () => {
  const repo = setupRepo();
  write(repo, { ".arnx/review.yaml": APP() });
  const cli = new Cli({ cwd: repo, env: ENV, approveSessions: quotingSuite() });
  expect(await cli.run("setup", "--baseline")).toBe(0);
  expectBaselineClean(repo);
  expect(committable(repo)).toContain(BASELINE_FILE);
  expectNoReal("what it says", cli.stdout + cli.stderr);
  // The same failures are the baseline's, not new ones: nothing is added, and a proof passes.
  const again = new Cli({ cwd: repo, env: ENV, approveSessions: quotingSuite() });
  expect(await again.run("setup", "--baseline", "--json")).toBe(0);
  expect(JSON.parse(again.stdout)).toMatchObject({ result: "ok", changes: [] });
  const [ok, said, suites] = await approveFile(repo, { by: "Dev", at: "2026-11-04", sessionFactory: quotingSuite() });
  expect(ok).toBe(true);
  expect(suites[0]!.baselineFailing).toBe(2);
  expectNoReal("what the proof says", said);
  expectBaselineClean(repo);
});

test("arnx setup records no real value from a suite's failures, under .arnx or in what it says", async () => {
  const repo = setupRepo();
  expect(await new Cli({ cwd: repo, env: ENV }).run("init")).toBe(0);
  const yaml = APP();
  const model = new ScriptedAgent([[tool("try_project", { yaml, project: "app" })], [tool("propose", { yaml })], [text("Done.")]]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: quotingSuite(), approveSessions: quotingSuite() });
  expect(await cli.run("setup", "--yes")).toBe(0);
  expectBaselineClean(repo);
  expectNoReal("what it says", cli.stdout + cli.stderr);
});

test("canary: from setup to check, on a project whose own tests quote the value, no committable file holds it", async () => {
  const repo = setupRepo();
  expect(await new Cli({ cwd: repo, env: ENV }).run("init")).toBe(0);
  const yaml = APP(`    tests_dir: tests/arnx_generated\n`);
  const model = new ScriptedAgent([[tool("try_project", { yaml, project: "app" })], [tool("propose", { yaml })], [text("Done.")]]);
  const cli = new Cli({ cwd: repo, env: ENV, setupModel: model, setupSessions: quotingSuite(), approveSessions: quotingSuite() });
  expect(await cli.run("setup", "--yes")).toBe(0);
  writeFileSync(join(repo, "app.py"), "x = 1\n");
  commit(repo, "a change");
  const agent = new Recording([[tool("write_file", { path: GEN, content: `x = "${SHOWN}"\n` }), tool("run_tests", {})]],
    reportOf(["test_v"], ["test_v"]));
  const quoting = runningFactory(() => [junitXml([[GEN, "test_v", "failed", `assert "${GUESS}" == 1`]]), `E  ${GUESS}\n`, false]);
  const { rdir } = await runReview(repo, { settings: SETTINGS, agentModel: agent, challenger: judge, sessionFactory: quoting });
  const md = blankMarks(readFileSync(join(rdir, "review.md"), "utf8")).replaceAll("Mark: [ ] real", "Mark: [x] real");
  writeFileSync(join(rdir, "review.md"), md);
  await accept(repo, rdir, SETTINGS, { answerRunner: null });
  await check(repo, SETTINGS, { sessionFactory: runningFactory((snap) => {
    const [p] = placedTest(snap)!;
    return [junitXml([[p, "test_v", "failed", `assert "${GUESS}" == 1`]]), `E  ${GUESS}\n`, false];
  }) });
  const kept = committable(repo);
  // What a commit of .arnx/ takes.
  for (const f of [BASELINE_FILE, ".arnx/review.yaml", ".arnx/.gitignore"]) expect(kept).toContain(f);
  expect(kept.some((f) => f.startsWith(".arnx/tests/"))).toBe(true);
  for (const [p, t] of allUnder(join(repo, ".arnx"))) expectNoReal(p, t);
});
